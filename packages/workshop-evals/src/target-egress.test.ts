import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalModelAccess } from "./target.js";

const fakes = vi.hoisted(() => ({
  requestUrls: [] as string[],
  responseStatuses: [] as number[],
  session: { [Symbol.dispose]: vi.fn() },
  server: { close: vi.fn(() => Promise.resolve()) },
}));

vi.mock("@gadgets/integration-tests/agent-session", () => ({
  AgentSession: { create: vi.fn(() => Promise.resolve(fakes.session)) },
}));

vi.mock("@gadgets/integration-tests/harness", () => ({
  startHarness: vi.fn(async () => {
    for (const url of fakes.requestUrls) fakes.responseStatuses.push((await fetch(url)).status);
    return {
      url: new URL("http://127.0.0.1:8787"),
      server: fakes.server,
    };
  }),
}));

import { openWorkshopTarget } from "./target.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
  fakes.requestUrls = [];
  fakes.responseStatuses = [];
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

async function run(access: LocalModelAccess): Promise<void> {
  const opened = await openWorkshopTarget(access, "@cf/model", 25);
  await opened[Symbol.asyncDispose]();
}

it("allows the direct Workers AI route", async () => {
  fakes.requestUrls = [
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1/chat/completions",
  ];

  await run({ kind: "direct", accountId: "account-id", apiToken: "token" });

  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(fakes.responseStatuses).toEqual([204]);
});

it("allows AI Gateway inference and cost-log routes", async () => {
  fakes.requestUrls = [
    "https://gateway.ai.cloudflare.com/v1/account-id/gateway/workers-ai/@cf/model",
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai-gateway/gateways/gateway/logs/log-id",
  ];

  await run({
    kind: "gateway",
    gateway: "gateway",
    accountId: "account-id",
    apiToken: "token",
  });

  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(fakes.responseStatuses).toEqual([204, 204]);
});

it("returns a deterministic denial for every other route", async () => {
  fakes.requestUrls = ["https://example.com/collect"];

  await run({ kind: "direct", accountId: "account-id", apiToken: "token" });

  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(fakes.responseStatuses).toEqual([403]);
});
