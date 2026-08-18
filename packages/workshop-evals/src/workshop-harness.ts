import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentSession, type AgentSourceSnapshot,
} from "@gadgets/integration-tests/agent-session";
import { startHarness, type WorkerConfig } from "@gadgets/integration-tests/harness";
import type {
  AiChatMessage, AiToolCall, GadgetBindingInfo, WorkpieceId, WorkpieceSummary,
} from "@gadgets/workshop-shared/api";
import { JsonObjectSchema, type TranscriptEvent } from "@vitest-evals/core";
import { createHarness, toJsonValue } from "vitest-evals";
import {
  collectAgentGatewayUsage, incompleteGatewayUsage, parseGatewayEnvironment, usesDirectWorkersAi,
} from "./gateway-logs.js";
import type {
  WorkshopArtifact, WorkshopCheckResult, WorkshopEvalTask, WorkshopGadgetArtifact,
  WorkshopRunInput, WorkshopRunOutput, WorkshopTurnResult,
} from "./task.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(PACKAGE_DIR, ".wrangler", "evals");

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe === "" ? "artifact" : safe.slice(0, 80);
}

function runKey(task: WorkshopEvalTask, input: WorkshopRunInput): string {
  const digest = createHash("sha256").update(JSON.stringify({
    task: task.id, model: input.model, trial: input.trial, runId: input.runId,
  })).digest("hex").slice(0, 12);
  return `${safeName(task.id)}-${safeName(input.model)}-${input.trial}-${digest}`;
}

async function emitArtifact(
    root: string,
    relativePath: string,
    bytes: Uint8Array,
    options: { mimeType?: string; logicalName?: string } = {}): Promise<WorkshopArtifact> {
  const digest = hash(bytes);
  const slash = relativePath.lastIndexOf("/");
  const directory = slash < 0 ? "" : relativePath.slice(0, slash + 1);
  const name = slash < 0 ? relativePath : relativePath.slice(slash + 1);
  const storedPath = `${directory}${digest}-${name}`;
  const absolutePath = resolve(root, storedPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  const packagePath = `.wrangler/evals/artifacts/${storedPath}`;
  return {
    path: packagePath,
    sha256: digest,
    bytes: bytes.byteLength,
    ...options,
  };
}

function toolArguments(call: AiToolCall) {
  const parsed = JsonObjectSchema.safeParse(toJsonValue(call.input));
  return parsed.success ? parsed.data : undefined;
}

function toolOutput(call: AiToolCall) {
  if (!("output" in call) || call.output === undefined) return undefined;
  return toJsonValue(call.output);
}

/** Maps canonical Workshop history to reporter diagnostics without reasoning or Yjs lifecycle events. */
export function canonicalTranscript(history: readonly AiChatMessage[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const message of history) {
    if (message.type !== "message") continue;
    const role = message.author.type === "user" ? "user" :
      message.author.type === "agent" ? "assistant" : undefined;
    if (role === undefined) continue;
    const metadata = {
      sequence: message.sequence,
      timestamp: message.timestamp.toISOString(),
    };
    if (message.message !== "") {
      events.push({ type: "message", role, content: message.message, metadata });
    }
    if (role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const argumentsValue = toolArguments(call);
      const outputValue = toolOutput(call);
      events.push({
        type: "tool_call",
        id: call.toolCallId,
        name: call.toolName,
        ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
        metadata,
      });
      events.push({
        type: "tool_result",
        toolCallId: call.toolCallId,
        name: call.toolName,
        ...(call.error === undefined
          ? (outputValue === undefined ? {} : { content: outputValue })
          : { error: { name: "Error", message: call.error } }),
        metadata,
      });
    }
  }
  return events;
}

async function consumeStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      length += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class ProvisionalVerificationContext {
  readonly chatId: number;
  readonly workpieces: readonly WorkpieceSummary[];
  readonly connect: AgentSession["connectToProvisionalGadget"];
  #session: AgentSession;

  constructor(session: AgentSession, chatId: number, workpieces: readonly WorkpieceSummary[]) {
    this.#session = session;
    this.chatId = chatId;
    this.workpieces = workpieces;
    this.connect = session.connectToProvisionalGadget.bind(session);
  }

  async listBindings(workpieceId: WorkpieceId): Promise<readonly GadgetBindingInfo[]> {
    using gadget = await this.#session.getGadget(workpieceId);
    return gadget.listBindings(this.chatId);
  }
}

function workshopConfig(config: WorkerConfig, gateway: ReturnType<typeof parseGatewayEnvironment>) {
  const direct = usesDirectWorkersAi();
  config.vars = {
    ...config.vars,
    CF_AI_GATEWAY: gateway.gatewayId,
    CF_AI_GATEWAY_ACCOUNT_ID: gateway.accountId,
    CF_AI_GATEWAY_API_TOKEN: gateway.apiToken,
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google,cloudflare",
    ...(direct ? { CF_AI_GATEWAY_WAI_DIRECT: "true" } : {}),
  };
}

async function captureGadgets(
    session: AgentSession,
    chatId: number,
    workpieces: readonly WorkpieceSummary[],
    artifactRoot: string,
    key: string): Promise<WorkshopGadgetArtifact[]> {
  const gadgets: WorkshopGadgetArtifact[] = [];
  for (const workpiece of workpieces.filter(entry => entry.type === "gadget")) {
    using gadget = await session.getGadget(workpiece.id);
    const prefix = `${key}/gadget-${workpiece.id}`;
    const result: WorkshopGadgetArtifact = {
      id: workpiece.id,
      title: workpiece.title,
      source: [],
      renderErrors: [],
    };
    try {
      const desktop = await gadget.exportScreenshot({ width: 1440, height: 900 }, chatId);
      result.desktop = await emitArtifact(artifactRoot, `${prefix}/desktop.png`, desktop,
          { mimeType: "image/png" });
    } catch (error) {
      if (!(error instanceof Error) || error.message.includes("not configured for this deployment")) {
        throw error;
      }
      result.renderErrors.push(`desktop: ${error.message.slice(0, 1_000)}`);
    }
    try {
      const mobile = await gadget.exportScreenshot({ width: 390, height: 844 }, chatId);
      result.mobile = await emitArtifact(artifactRoot, `${prefix}/mobile.png`, mobile,
          { mimeType: "image/png" });
    } catch (error) {
      if (!(error instanceof Error) || error.message.includes("not configured for this deployment")) {
        throw error;
      }
      result.renderErrors.push(`mobile: ${error.message.slice(0, 1_000)}`);
    }
    try {
      const pdf = await consumeStream(await gadget.exportPdf(chatId));
      result.pdf = await emitArtifact(artifactRoot, `${prefix}/render.pdf`, pdf,
          { mimeType: "application/pdf" });
    } catch (error) {
      if (!(error instanceof Error) || error.message.includes("not configured for this deployment")) {
        throw error;
      }
      result.renderErrors.push(`pdf: ${error.message.slice(0, 1_000)}`);
    }
    gadgets.push(result);
  }
  return gadgets;
}

function finalOutcomeChecks(
    gadgets: readonly WorkshopGadgetArtifact[], agentErrors: readonly string[]): WorkshopCheckResult[] {
  return [
    { id: "workshop.gadget-created", pass: gadgets.length > 0, evidence: gadgets.length },
    { id: "workshop.agent-errors", pass: agentErrors.length === 0, evidence: agentErrors.length },
    ...gadgets.flatMap(gadget => [
      { id: `workshop.${gadget.id}.desktop-render`, pass: gadget.desktop !== undefined },
      { id: `workshop.${gadget.id}.mobile-render`, pass: gadget.mobile !== undefined },
      { id: `workshop.${gadget.id}.pdf-render`, pass: gadget.pdf !== undefined },
    ]),
  ];
}

async function captureSource(
    snapshot: AgentSourceSnapshot,
    gadgets: WorkshopGadgetArtifact[],
    workpieces: readonly WorkpieceSummary[],
    artifactRoot: string,
    key: string): Promise<void> {
  for (const workpiece of workpieces) {
    if (workpiece.filesRoot === undefined) continue;
    const source = snapshot.workpieces.get(workpiece.filesRoot);
    const gadget = gadgets.find(entry => entry.id === workpiece.id);
    if (source === undefined || gadget === undefined) continue;
    for (const [name, content] of source.files) {
      const bytes = new TextEncoder().encode(content);
      gadget.source.push(await emitArtifact(
          artifactRoot, `${key}/gadget-${workpiece.id}/source/${safeName(name)}`, bytes,
          { mimeType: "text/plain; charset=utf-8", logicalName: name }));
    }
  }
}

/** Creates a live vitest-evals harness bound to one authored task, with no global task registry. */
export function createWorkshopHarness(task: WorkshopEvalTask) {
  return createHarness<WorkshopRunInput, WorkshopRunOutput>({
    name: "workshop-agent",
    run: async ({ input, signal, setArtifact }) => {
      const startedAt = Date.now();
      const startedAtIso = new Date(startedAt).toISOString();
      setArtifact("identity", {
        taskId: task.id,
        taskTitle: task.title,
        expectation: task.expectation,
        model: input.model,
        trial: input.trial,
        runId: input.runId,
      });
      const gateway = parseGatewayEnvironment();
      const harness = await startHarness({
        gatekeepers: [],
        enableGadgetExecution: true,
        patchWorkshop: config => workshopConfig(config, gateway),
      });
      let session: AgentSession | undefined;
      try {
        session = await AgentSession.create(harness.url, {
          modelId: input.model,
          usernamePrefix: "eval",
          timeoutMs: 10 * 60_000,
        });
        const turns: WorkshopTurnResult[] = [];
        let finalHistory: AiChatMessage[] = [];
        let finalWorkpieces: WorkpieceSummary[] = [];
        let chatId: number | undefined;
        for (const [index, turn] of task.turns.entries()) {
          const agentStartedAt = Date.now();
          const result = await session.run(turn.prompt, { signal });
          const agentDurationMs = Date.now() - agentStartedAt;
          chatId = result.chatId;
          finalHistory = result.history;
          finalWorkpieces = result.workpieces;
          const verificationStartedAt = Date.now();
          const checks: WorkshopCheckResult[] = [
            ...await turn.verify(new ProvisionalVerificationContext(
                session, result.chatId, result.workpieces)),
          ];
          turns.push({
            index,
            checks,
            agentDurationMs,
            verificationDurationMs: Date.now() - verificationStartedAt,
          });
        }
        if (chatId === undefined) throw new Error("Workshop eval task executed no turns");
        const key = runKey(task, input);
        const artifactRoot = resolve(OUTPUT_DIR, "artifacts");
        const gadgets = await captureGadgets(
            session, chatId, finalWorkpieces, artifactRoot, key);
        const source = await session.acceptChanges();
        await captureSource(source, gadgets, finalWorkpieces, artifactRoot, key);
        const transcript = canonicalTranscript(finalHistory);
        const diagnosticsBytes = new TextEncoder().encode(`${JSON.stringify({ events: transcript }, null, 2)}\n`);
        const diagnostics = await emitArtifact(
            artifactRoot, `${key}/diagnostics.json`, diagnosticsBytes,
            { mimeType: "application/json" });
        const agentUsage = usesDirectWorkersAi()
          ? incompleteGatewayUsage()
          : await collectAgentGatewayUsage(gateway, {
            workspaceId: session.workspaceId,
            chatId,
          }, { startDate: startedAtIso });
        const agentErrors = finalHistory.flatMap(message =>
          message.type === "error" ? [message.message] : []);
        const lastTurn = turns.at(-1);
        if (lastTurn === undefined) throw new Error("Workshop eval task executed no turns");
        lastTurn.checks.push(...finalOutcomeChecks(gadgets, agentErrors));
        const functionalPassed = turns.every(turn => turn.checks.every(check => check.pass));
        const output: WorkshopRunOutput = {
          taskId: task.id,
          taskTitle: task.title,
          expectation: task.expectation,
          model: input.model,
          trial: input.trial,
          runId: input.runId,
          workspaceId: session.workspaceId,
          chatId,
          turns,
          gadgets,
          functionalPassed,
          agentErrors,
          agentUsage,
          wallDurationMs: Date.now() - startedAt,
          diagnostics,
        };
        return {
          output,
          events: transcript,
          usage: {
            provider: "cloudflare-ai-gateway",
            model: input.model,
            inputTokens: agentUsage.inputTokens,
            outputTokens: agentUsage.outputTokens,
            totalTokens: agentUsage.totalTokens,
            metadata: {
              successfulRequests: agentUsage.successfulRequests,
              failedRequests: agentUsage.failedRequests,
              durationMs: agentUsage.durationMs,
              costUsd: agentUsage.costUsd,
            },
          },
          timings: { totalMs: output.wallDurationMs },
          artifacts: { diagnostics, gadgets },
          errors: agentErrors.map(message => ({ name: "AgentError", message })),
          metadata: {
            taskId: task.id,
            expectation: task.expectation,
            workspaceId: session.workspaceId,
            chatId,
          },
        };
      } finally {
        session?.[Symbol.dispose]();
        await harness.server.close();
      }
    },
  });
}
