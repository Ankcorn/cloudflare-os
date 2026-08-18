import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliUsageError,
  classifyExitCode,
  confinedSourcePath,
  formatResult,
  interrupt,
  parseArgv,
  parseGatewayConfig,
  runCli,
  writeOutput,
  type CliBoundaries,
  type WorkshopRun,
} from "../src/cli.js";

const tempDirectories: string[] = [];

function gatewayEnvironment(): NodeJS.ProcessEnv {
  return {
    CF_AI_GATEWAY: "gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "account",
    CF_AI_GATEWAY_API_TOKEN: "secret",
  };
}

function workshopRun(agentErrors: string[] = []): WorkshopRun {
  const summary: WorkshopRun["turn"]["workpieces"][number] = {
    id: 7,
    type: "gadget",
    title: "Weather / Board",
    filesRoot: "7",
  };
  return {
    workspaceId: "workspace-1",
    turn: {
      chatId: 12,
      history: [
        {
          chatId: 12,
          sequence: 1,
          timestamp: new Date(0),
          author: { type: "agent", id: "model", name: "Model" },
          type: "message",
          message: "Built it.",
        },
      ],
      workpieces: [summary],
      agentErrors,
      source: {
        version: 2,
        workpieces: new Map([["7", {
          summary,
          files: new Map([
            ["src/client.ts", "export const client = true;"],
            ["server.ts", "export const server = true;"],
          ]),
        }]]),
      },
    },
  };
}

function boundaries(overrides: Partial<CliBoundaries> = {}): CliBoundaries {
  return {
    execute: () => Promise.resolve(workshopRun()),
    now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(145),
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("parseArgv", () => {
  it("parses the narrow model and output command", () => {
    expect(parseArgv(["--model", "@cf/meta/model", "--output", "artifacts"]))
      .toEqual({ model: "@cf/meta/model", output: "artifacts" });
  });

  it("requires a model", () => {
    expect(() => parseArgv([])).toThrow("--model is required");
  });

  it("rejects tokens and every other argv option", () => {
    expect(() => parseArgv(["--model", "model", "--token", "secret"]))
      .toThrow("Unknown argument: --token");
  });
});

describe("parseGatewayConfig", () => {
  it("reads the standard product environment", () => {
    expect(parseGatewayConfig(gatewayEnvironment())).toEqual({
      gateway: "gateway",
      accountId: "account",
      apiToken: "secret",
      workersAiDirect: false,
    });
  });

  it("fails when a required value is absent", () => {
    expect(() => parseGatewayConfig({ CF_AI_GATEWAY: "gateway" }))
      .toThrow("CF_AI_GATEWAY_ACCOUNT_ID is required");
  });

  it("supports the product's explicit direct Workers AI mode", () => {
    expect(parseGatewayConfig({
      ...gatewayEnvironment(),
      CF_AI_GATEWAY_WAI_DIRECT: "true",
    }).workersAiDirect).toBe(true);
    expect(() => parseGatewayConfig({
      ...gatewayEnvironment(),
      CF_AI_GATEWAY_WAI_DIRECT: "yes",
    })).toThrow("true or false");
  });
});

it("rejects an empty stdin prompt without starting the Workshop", async () => {
  const execute = vi.fn<CliBoundaries["execute"]>();
  const io = boundaries({ execute });

  await expect(runCli(
      ["--model", "model"], gatewayEnvironment(), " \n", new AbortController().signal, io))
    .resolves.toBe(2);
  expect(execute).not.toHaveBeenCalled();
});

it("formats canonical assistant text, identifiers, duration, errors, and Gadget sources", () => {
  const result = formatResult(workshopRun(["agent failed"]), "model", 45);

  expect(result).toEqual({
    assistantText: "Built it.",
    agentErrors: ["agent failed"],
    workspaceId: "workspace-1",
    chatId: 12,
    model: "model",
    wallDurationMs: 45,
    gadgets: [{
      id: 7,
      title: "Weather / Board",
      files: {
        "src/client.ts": "export const client = true;",
        "server.ts": "export const server = true;",
      },
    }],
  });
});

it("confines logical source paths to the Gadget directory", () => {
  const root = resolve("output/gadget");
  expect(confinedSourcePath(root, "src/client.ts")).toBe(join(root, "src/client.ts"));
  for (const unsafe of ["../secret", "/tmp/secret", "src/../../secret", "..\\secret", "C:/secret"]) {
    expect(() => confinedSourcePath(root, unsafe)).toThrow("Unsafe Gadget source file name");
  }
});

it("writes nested sources under a sanitized Gadget directory and emits only paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workshop-agent-cli-"));
  tempDirectories.push(parent);
  const output = join(parent, "output");
  const sourceResult = formatResult(workshopRun(), "model", 45);

  const stored = await writeOutput(output, sourceResult);

  const gadget = stored.gadgets[0];
  expect(gadget?.files["src/client.ts"]).toBe(join(output, "weather-board-7/src/client.ts"));
  expect(await readFile(join(output, "weather-board-7/src/client.ts"), "utf8"))
    .toBe("export const client = true;");
  expect(JSON.parse(await readFile(join(output, "result.json"), "utf8"))).toEqual(stored);
});

it("rejects an output directory that already exists", async () => {
  const output = await mkdtemp(join(tmpdir(), "workshop-agent-cli-"));
  tempDirectories.push(output);

  await expect(writeOutput(output, formatResult(workshopRun(), "model", 45)))
    .rejects.toThrow("it must not exist and its parent directory must already exist");
});

it("classifies usage, runtime, and cancellation exit codes", () => {
  expect(classifyExitCode(new CliUsageError("bad config"), false)).toBe(2);
  expect(classifyExitCode(new Error("agent failed"), false)).toBe(1);
  expect(classifyExitCode(new Error("cancelled"), true)).toBe(130);
});

it("returns one JSON result and exits one when the agent reports errors", async () => {
  const stdout = vi.fn();
  const io = boundaries({
    execute: () => Promise.resolve(workshopRun(["model failed"])),
    stdout,
  });

  await expect(runCli(
      ["--model", "model"], gatewayEnvironment(), "build", new AbortController().signal, io))
    .resolves.toBe(1);
  expect(stdout).toHaveBeenCalledOnce();
  expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? "").agentErrors).toEqual(["model failed"]);
});

it("passes cancellation to the running orchestration and exits 130", async () => {
  const controller = new AbortController();
  let observedAbort = false;
  const io = boundaries({
    execute: (_options, _gateway, _prompt, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(new Error("cancelled"));
      }, { once: true });
    }),
  });
  const running = runCli(
      ["--model", "model"], gatewayEnvironment(), "build", controller.signal, io);

  controller.abort();

  await expect(running).resolves.toBe(130);
  expect(observedAbort).toBe(true);
});

it("aborts and destroys stdin on interrupt, then exits 130 without orchestration", async () => {
  const controller = new AbortController();
  const stdin = { destroy: vi.fn() };
  const execute = vi.fn<CliBoundaries["execute"]>();

  interrupt(controller, stdin);

  expect(controller.signal.aborted).toBe(true);
  expect(stdin.destroy).toHaveBeenCalledOnce();
  await expect(runCli(
      ["--model", "model"], gatewayEnvironment(), "partial", controller.signal,
      boundaries({ execute }))).resolves.toBe(130);
  expect(execute).not.toHaveBeenCalled();
});
