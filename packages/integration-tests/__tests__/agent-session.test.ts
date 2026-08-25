import { afterEach, expect, it, vi } from "vitest";
import type { AiChatHistoryPage, AiChatMessage, AiChatMetadata } from "@gadgets/workshop-shared/api";

const fakes = vi.hoisted(() => {
  const holder: {
    chatSubscriber?: { metadata(chat: AiChatMetadata): void; message(entry: AiChatMessage): void };
  } = {};
  const idle: AiChatMetadata = {
    id: 7,
    title: "Built",
    started: new Date(0),
    lastActive: new Date(1),
    totalTokens: 123,
    totalCost: 0.45,
  };
  const overseer = {
    [Symbol.dispose]: vi.fn(),
    deleteSelf: vi.fn(() => Promise.resolve()),
    getChatHistory: vi.fn(() => Promise.resolve({ messages: [] })),
    listChats: vi.fn(() => Promise.resolve([idle])),
    newChat: vi.fn(async () => {
      holder.chatSubscriber?.metadata({
        ...idle,
        activeAgent: { type: "agent", id: "model", name: "Model" },
      });
      holder.chatSubscriber?.metadata(idle);
      return 7;
    }),
    stopAgent: vi.fn(() => Promise.resolve()),
    subscribeToChat: vi.fn((subscriber: NonNullable<typeof holder.chatSubscriber>) => {
      holder.chatSubscriber = subscriber;
      return Promise.resolve({ [Symbol.dispose]: vi.fn() });
    }),
    subscribeToWorkpieces: vi.fn((subscriber: { ready(): void }) => {
      subscriber.ready();
      return Promise.resolve({ [Symbol.dispose]: vi.fn() });
    }),
  };
  const authenticated = {
    [Symbol.dispose]: vi.fn(),
    completeOnboarding: vi.fn(() => Promise.resolve()),
    isOnboardingCompleted: vi.fn(() => Promise.resolve(true)),
    listModels: vi.fn(() => Promise.resolve([{ type: "agent", id: "model", name: "Model" }])),
    listOutputFormats: vi.fn(() => Promise.resolve([{}])),
    newGadget: vi.fn(() => Promise.resolve(overseer)),
    setPreferredModel: vi.fn(() => Promise.resolve()),
  };
  return {
    authenticated,
    holder,
    idle,
    overseer,
    publicApi: { [Symbol.dispose]: vi.fn() },
  };
});

vi.mock("../src/rpc-client.js", () => ({
  RpcTarget: class { readonly testTarget = true; },
  connect: () => fakes.publicApi,
  nextUsernames: () => ["agent1"],
  signUp: () => Promise.resolve(fakes.authenticated),
  stubFor: <T extends object>(target: T) =>
    Object.assign(target, { [Symbol.dispose]: vi.fn() }),
  waitFor: async <T>(_what: string, attempt: () => Promise<T | null>) => {
    const result = await attempt();
    if (result === null) throw new Error("test wait did not settle");
    return result;
  },
}));

import { AgentSession, loadAllChatHistory } from "../src/agent-session.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("waits for an active-to-idle transition and returns raw usage", async () => {
  vi.useFakeTimers();
  const session = await AgentSession.create(new URL("http://127.0.0.1:8787"));
  const result = session.run("Build it");

  await vi.advanceTimersByTimeAsync(2_000);

  await expect(result).resolves.toMatchObject({
    history: [],
    usage: { lastStepTokens: 123, agentChatCostUsd: 0.45 },
  });
  await session.deleteWorkspace();
});

it("fails immediately when the agent posts an error before becoming active", async () => {
  fakes.overseer.newChat.mockImplementationOnce(async () => {
    fakes.holder.chatSubscriber?.message({
      chatId: 7,
      sequence: 1,
      timestamp: new Date(1),
      author: { type: "agent", id: "model", name: "Model" },
      type: "error",
      message: "provider refused the request",
    });
    return 7;
  });
  const session = await AgentSession.create(new URL("http://127.0.0.1:8787"));

  await expect(session.run("Build it")).rejects.toThrow("provider refused the request");
  await session.deleteWorkspace();
});

it("times out an RPC that never starts the agent and still deletes the workspace", async () => {
  vi.useFakeTimers();
  fakes.overseer.newChat.mockReturnValueOnce(new Promise<number>(() => {}));
  const session = await AgentSession.create(
      new URL("http://127.0.0.1:8787"), { timeoutMs: 25 });
  const result = session.run("Build it");
  const assertion = expect(result).rejects.toThrow("Timed out after 25ms");

  await vi.advanceTimersByTimeAsync(25);

  await assertion;
  await session.deleteWorkspace();
  expect(fakes.overseer.deleteSelf).toHaveBeenCalledOnce();
});

function message(sequence: number): AiChatMessage {
  return {
    chatId: 7,
    sequence,
    timestamp: new Date(sequence),
    author: { type: "user", id: "user", name: "User" },
    type: "message",
    message: String(sequence),
  };
}

it("loads compacted history pages in ascending order", async () => {
  const pages = new Map<number | undefined, AiChatHistoryPage>([
    [undefined, { messages: [message(4), message(5)], compacted: { to: 4, summary: "tail" } }],
    [4, { messages: [message(2), message(3)], compacted: { to: 2, summary: "middle" } }],
    [2, { messages: [message(0), message(1)] }],
  ]);
  const history = await loadAllChatHistory(before => {
    const page = pages.get(before);
    if (!page) throw new Error(`No page for ${before}`);
    return Promise.resolve(page);
  });
  expect(history.map(entry => entry.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
});
