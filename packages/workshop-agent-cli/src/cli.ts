import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  AgentSession, finalAssistantText,
  type AgentSourceSnapshot, type AgentTurnResult,
} from "@gadgets/integration-tests/agent-session";
import {
  startHarness, type WorkerConfig,
} from "@gadgets/integration-tests/harness";

export const USAGE = "Usage: workshop-agent --model <workers-ai-model> [--output <directory>]";

export class CliUsageError extends Error {}

export type CliOptions = {
  model: string;
  output?: string;
};

export type GatewayConfig = {
  gateway: string;
  accountId: string;
  apiToken: string;
  workersAiDirect: boolean;
};

export type AgentCliGadget = {
  id: number;
  title: string;
  files: Record<string, string>;
};

export type AgentCliResult = {
  assistantText: string;
  agentErrors: string[];
  workspaceId: string;
  chatId: number;
  model: string;
  wallDurationMs: number;
  gadgets: AgentCliGadget[];
  resultPath?: string;
};

export type WorkshopRun = {
  workspaceId: string;
  turn: AgentTurnResult & { source: AgentSourceSnapshot };
};

export type CliBoundaries = {
  execute: (
    options: CliOptions,
    gateway: GatewayConfig,
    prompt: string,
    signal: AbortSignal,
    progress: (message: string) => void,
  ) => Promise<WorkshopRun>;
  now: () => number;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/** Abort the CLI and unblock a pending stdin read after SIGINT. */
export function interrupt(controller: AbortController, stdin: { destroy(): void }): void {
  controller.abort();
  stdin.destroy();
}

export function parseArgv(argv: readonly string[]): CliOptions {
  let model: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag !== "--model" && flag !== "--output") {
      throw new CliUsageError(`Unknown argument: ${flag ?? ""}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new CliUsageError(`${flag} requires a value`);
    }
    if (flag === "--model") {
      if (model !== undefined) throw new CliUsageError("--model may only be specified once");
      model = value;
    } else {
      if (output !== undefined) throw new CliUsageError("--output may only be specified once");
      output = value;
    }
    index++;
  }
  if (model === undefined) throw new CliUsageError("--model is required");
  return { model, ...(output === undefined ? {} : { output }) };
}

export function parseGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const gateway = requiredEnvironmentValue(env, "CF_AI_GATEWAY");
  const accountId = requiredEnvironmentValue(env, "CF_AI_GATEWAY_ACCOUNT_ID");
  const apiToken = requiredEnvironmentValue(env, "CF_AI_GATEWAY_API_TOKEN");
  const direct = env.CF_AI_GATEWAY_WAI_DIRECT;
  if (direct !== undefined && direct !== "true" && direct !== "false") {
    throw new CliUsageError("CF_AI_GATEWAY_WAI_DIRECT must be true or false when set");
  }
  return { gateway, accountId, apiToken, workersAiDirect: direct === "true" };
}

function requiredEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError(`${name} is required`);
  }
  return value;
}

function patchWorkshop(config: WorkerConfig, gateway: GatewayConfig): void {
  config.vars = {
    ...config.vars,
    CF_AI_GATEWAY: gateway.gateway,
    CF_AI_GATEWAY_ACCOUNT_ID: gateway.accountId,
    CF_AI_GATEWAY_API_TOKEN: gateway.apiToken,
    CF_AI_GATEWAY_PROVIDERS: "cloudflare",
    ...(gateway.workersAiDirect ? { CF_AI_GATEWAY_WAI_DIRECT: "true" } : {}),
  };
}

export async function executeWorkshop(
    options: CliOptions,
    gateway: GatewayConfig,
    prompt: string,
    signal: AbortSignal,
    progress: (message: string) => void): Promise<WorkshopRun> {
  progress("Starting ephemeral Workshop");
  const harness = await startHarness({
    gatekeepers: [],
    enableGadgetExecution: true,
    patchWorkshop: config => patchWorkshop(config, gateway),
  });
  let session: AgentSession | undefined;
  let closing: Promise<void> | undefined;
  const closeHarness = (): Promise<void> => closing ??= harness.server.close();
  const cancel = (): void => {
    session?.cancel();
    void closeHarness();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new Error("Agent turn was cancelled");
    progress(`Creating agent session for ${options.model}`);
    session = await AgentSession.create(harness.url, {
      modelId: options.model,
      usernamePrefix: "cli",
      timeoutMs: 10 * 60_000,
    });
    if (signal.aborted) {
      session.cancel();
      throw new Error("Agent turn was cancelled");
    }
    progress("Running agent");
    const turn = await session.run(prompt, { acceptChanges: true, signal });
    if (turn.source === undefined) throw new Error("Accepted agent turn returned no source snapshot");
    return { workspaceId: session.workspaceId, turn: { ...turn, source: turn.source } };
  } finally {
    signal.removeEventListener("abort", cancel);
    session?.[Symbol.dispose]();
    await closeHarness();
  }
}

export function formatResult(
    run: WorkshopRun, model: string, wallDurationMs: number): AgentCliResult {
  const gadgets = run.turn.workpieces
    .filter(workpiece => workpiece.type === "gadget")
    .map(workpiece => {
      const files = workpiece.filesRoot === undefined
        ? new Map<string, string>()
        : run.turn.source.workpieces.get(workpiece.filesRoot)?.files ?? new Map<string, string>();
      return { id: workpiece.id, title: workpiece.title, files: Object.fromEntries(files) };
    });
  return {
    assistantText: finalAssistantText(run.turn.history),
    agentErrors: run.turn.agentErrors,
    workspaceId: run.workspaceId,
    chatId: run.turn.chatId,
    model,
    wallDurationMs,
    gadgets,
  };
}

function safeGadgetDirectory(title: string, id: number): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "gadget";
  return `${base}-${id}`;
}

export function confinedSourcePath(gadgetRoot: string, logicalName: string): string {
  if (logicalName === "" || logicalName.includes("\\") || isAbsolute(logicalName) ||
      /^[a-zA-Z]:/.test(logicalName)) {
    throw new Error(`Unsafe Gadget source file name: ${JSON.stringify(logicalName)}`);
  }
  const parts = logicalName.split("/");
  if (parts.some(part => part === "" || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error(`Unsafe Gadget source file name: ${JSON.stringify(logicalName)}`);
  }
  const root = resolve(gadgetRoot);
  const path = resolve(root, ...parts);
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Gadget source file escapes its output directory: ${JSON.stringify(logicalName)}`);
  }
  return path;
}

export async function writeOutput(output: string, result: AgentCliResult): Promise<AgentCliResult> {
  const root = resolve(output);
  try {
    await mkdir(root);
  } catch (error) {
    throw new Error(
        `Cannot create output directory ${JSON.stringify(root)}; it must not exist and its parent ` +
        "directory must already exist",
        { cause: error });
  }
  const gadgets: AgentCliGadget[] = [];
  for (const gadget of result.gadgets) {
    const gadgetRoot = resolve(root, safeGadgetDirectory(gadget.title, gadget.id));
    const fromRoot = relative(root, gadgetRoot);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Gadget output directory escapes ${root}`);
    }
    await mkdir(gadgetRoot);
    const files: Record<string, string> = {};
    for (const [logicalName, source] of Object.entries(gadget.files)) {
      const path = confinedSourcePath(gadgetRoot, logicalName);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source, { encoding: "utf8", flag: "wx" });
      files[logicalName] = path;
    }
    gadgets.push({ ...gadget, files });
  }
  const resultPath = resolve(root, "result.json");
  const stored = { ...result, gadgets, resultPath };
  await writeFile(
      resultPath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return stored;
}

export function classifyExitCode(error: Error, aborted: boolean): 1 | 2 | 130 {
  if (aborted) return 130;
  return error instanceof CliUsageError ? 2 : 1;
}

export async function runCli(
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
    prompt: string,
    signal: AbortSignal,
    boundaries: CliBoundaries): Promise<0 | 1 | 2 | 130> {
  try {
    const options = parseArgv(argv);
    const gateway = parseGatewayConfig(env);
    if (signal.aborted) throw new Error("Agent turn was cancelled");
    if (prompt.trim() === "") throw new CliUsageError("Prompt on stdin must not be empty");
    const startedAt = boundaries.now();
    const run = await boundaries.execute(
        options, gateway, prompt, signal, message => boundaries.stderr(`${message}\n`));
    let result = formatResult(run, options.model, boundaries.now() - startedAt);
    if (options.output !== undefined) result = await writeOutput(options.output, result);
    boundaries.stdout(`${JSON.stringify(result)}\n`);
    return result.agentErrors.length === 0 ? 0 : 1;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    boundaries.stderr(`${failure.message}\n`);
    const code = classifyExitCode(failure, signal.aborted);
    if (code === 2) boundaries.stderr(`${USAGE}\n`);
    return code;
  }
}
