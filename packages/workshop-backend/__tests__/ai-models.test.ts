import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";

const gatewayCalls: Array<{ options: unknown; modelId: string }> = [];
const workersAiCalls: Array<{ options: unknown; modelId: string; settings?: unknown }> = [];
const bindingGatewayCalls: Array<{ gateway: string; options: unknown }> = [];
const workersAiBinding = {
  gateway: (gateway: string, options: unknown) => {
    bindingGatewayCalls.push({ gateway, options });
    return { gateway };
  },
} as unknown as Ai;

vi.mock("ai-gateway-provider", () => ({
  createAiGateway: (options: unknown) => (providerModel: { modelId: string }) => {
    gatewayCalls.push({ options, modelId: providerModel.modelId });
    return { provider: "gateway", modelId: providerModel.modelId };
  },
}));

vi.mock("ai-gateway-provider/providers/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));

vi.mock("workers-ai-provider", () => ({
  createWorkersAI: (options: unknown) => (modelId: string, settings?: unknown) => {
    workersAiCalls.push({ options, modelId, settings });
    return { provider: "workers-ai", modelId };
  },
}));

vi.mock("capnweb-validate", () => ({
  validateRpc: () => () => undefined,
}));

const INITIATOR: AiChatAuthorInfo = {
  type: "user",
  id: "user-123",
  name: "User",
};

const GADGET_INITIATOR: AiChatAuthorInfo = {
  type: "gadget",
  id: "owner-456",
  name: "Report Gadget",
};

const ANTHROPIC_CONFIG: AiModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  apiToken: "ignored-in-gateway-mode",
};

const WORKERS_AI_CONFIG: AiModelConfig = {
  provider: "cloudflare",
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  apiToken: "ignored-in-gateway-mode",
};

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google",
    WORKERS_AI: workersAiBinding,
    ...overrides,
  } as Cloudflare.Env;
}

describe("getModel AI Gateway routing", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    workersAiCalls.length = 0;
    bindingGatewayCalls.length = 0;
  });

  it("routes non-Workers providers through a configured cross-account gateway", async () => {
    const { getModelWithLogRoute } = await import("../src/ai-models.js");

    const { aiGatewayLogRoute } = getModelWithLogRoute(env(), ANTHROPIC_CONFIG, INITIATOR, {
      metadata: { source: "chat", gadgetId: "gadget-123", chatId: 7 },
    });

    expect(gatewayCalls).toEqual([
      {
        modelId: "claude-sonnet-4-5",
        options: {
          accountId: "gateway-account-id",
          gateway: "platform-gateway",
          apiKey: "gateway-token",
          options: {
            metadata: {
              user: "user-123",
              gadgetId: "gadget-123",
              chatId: 7,
              source: "chat",
            },
          },
        },
      },
    ]);
    expect(workersAiCalls).toEqual([]);
    expect(aiGatewayLogRoute).toEqual({
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "gateway-token",
    });
  }, 15000);

  it("preserves gadget automation metadata within the Gateway metadata limit", async () => {
    const { getModel } = await import("../src/ai-models.js");

    getModel(env(), ANTHROPIC_CONFIG, GADGET_INITIATOR, {
      metadata: { source: "chat", gadgetId: "gadget-456", chatId: 8 },
    });

    expect(gatewayCalls[0].options).toEqual({
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiKey: "gateway-token",
      options: {
        metadata: {
          user: "owner-456",
          source: "chat",
          gadgetId: "gadget-456",
          chatId: 8,
          automated: true,
        },
      },
    });

    getModel(env(), ANTHROPIC_CONFIG, GADGET_INITIATOR, {
      metadata: { source: "thread-title", gadgetId: "gadget-456", chatId: 8 },
    });

    expect(gatewayCalls[1].options).toEqual({
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiKey: "gateway-token",
      options: {
        metadata: {
          user: "owner-456",
          source: "thread-title",
          gadgetId: "gadget-456",
          chatId: 8,
          automated: true,
        },
      },
    });
  }, 15000);

  it("uses the same-account binding without an API token", async () => {
    const { getModelWithLogRoute } = await import("../src/ai-models.js");

    const { aiGatewayLogRoute } = getModelWithLogRoute(env({
      CF_AI_GATEWAY_ACCOUNT_ID: undefined,
      CF_AI_GATEWAY_API_TOKEN: undefined,
    }), ANTHROPIC_CONFIG, INITIATOR);

    expect(bindingGatewayCalls).toEqual([
      { gateway: "platform-gateway", options: { beta: false } },
    ]);
    expect(gatewayCalls).toEqual([
      {
        modelId: "claude-sonnet-4-5",
        options: {
          binding: { gateway: "platform-gateway" },
          options: { metadata: { user: "user-123" } },
        },
      },
    ]);
    expect(aiGatewayLogRoute).toEqual({ gateway: "platform-gateway" });
  }, 15000);

  it.each([
    { CF_AI_GATEWAY_ACCOUNT_ID: undefined },
    { CF_AI_GATEWAY_API_TOKEN: undefined },
  ])("rejects partial cross-account configuration", async (overrides) => {
    const { getModel } = await import("../src/ai-models.js");

    expect(() => getModel(env(overrides), ANTHROPIC_CONFIG, INITIATOR)).toThrow(
        "CF_AI_GATEWAY_ACCOUNT_ID and CF_AI_GATEWAY_API_TOKEN must be configured together.");
  });

  it("rejects conflicting Workers AI routing configuration", async () => {
    const { getModel } = await import("../src/ai-models.js");

    expect(() => getModel(env({
      CF_AI_GATEWAY_WAI: "workers-ai-gateway",
      CF_AI_GATEWAY_WAI_DIRECT: "true",
    }), WORKERS_AI_CONFIG, INITIATOR)).toThrow(
        "CF_AI_GATEWAY_WAI and CF_AI_GATEWAY_WAI_DIRECT cannot be configured together.");
  });

  it("prioritizes a connected user's Gateway over platform routing", async () => {
    const { getModelWithLogRoute } = await import("../src/ai-models.js");

    const { aiGatewayLogRoute } = getModelWithLogRoute(env(), WORKERS_AI_CONFIG, INITIATOR, {
      userGateway: { accountId: "user-account-id", apiKey: "user-token" },
      metadata: { source: "chat", gadgetId: "gadget-789", chatId: 9 },
    });

    expect(gatewayCalls).toEqual([
      {
        modelId: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        options: {
          accountId: "user-account-id",
          gateway: "default",
          apiKey: "user-token",
          options: {
            metadata: {
              user: "user-123",
              source: "chat",
              gadgetId: "gadget-789",
              chatId: 9,
            },
          },
        },
      },
    ]);
    expect(bindingGatewayCalls).toEqual([]);
    expect(workersAiCalls).toEqual([]);
    expect(aiGatewayLogRoute).toEqual({
      accountId: "user-account-id",
      gateway: "default",
      apiToken: "user-token",
    });
  }, 15000);

  it("uses the direct Workers AI binding when explicitly configured", async () => {
    const { getModelWithLogRoute } = await import("../src/ai-models.js");

    const { aiGatewayLogRoute } = getModelWithLogRoute(
        env({ CF_AI_GATEWAY_WAI_DIRECT: "true" }),
        WORKERS_AI_CONFIG,
        INITIATOR,
        { sessionAffinity: "session-a" });

    expect(workersAiCalls).toEqual([
      {
        modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        options: { binding: workersAiBinding },
        settings: { sessionAffinity: "session-a" },
      },
    ]);
    expect(gatewayCalls).toEqual([]);
    expect(aiGatewayLogRoute).toBeUndefined();
  }, 15000);

  it("preserves the platform gateway for same-account Workers AI", async () => {
    const { getModelWithLogRoute } = await import("../src/ai-models.js");

    const { aiGatewayLogRoute } = getModelWithLogRoute(env({
      CF_AI_GATEWAY_ACCOUNT_ID: undefined,
      CF_AI_GATEWAY_API_TOKEN: undefined,
    }), WORKERS_AI_CONFIG, INITIATOR);

    expect(workersAiCalls).toEqual([
      {
        modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        options: {
          binding: workersAiBinding,
          gateway: { id: "platform-gateway", metadata: { user: "user-123" } },
        },
        settings: { sessionAffinity: undefined },
      },
    ]);
    expect(aiGatewayLogRoute).toEqual({ gateway: "platform-gateway" });
  }, 15000);

  it("preserves the platform gateway when cross-account credentials are present", async () => {
    const { getModelWithLogRoute } = await import("../src/ai-models.js");

    const { aiGatewayLogRoute } = getModelWithLogRoute(
        env(), WORKERS_AI_CONFIG, INITIATOR);

    expect(workersAiCalls).toEqual([
      {
        modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        options: {
          binding: workersAiBinding,
          gateway: { id: "platform-gateway", metadata: { user: "user-123" } },
        },
        settings: { sessionAffinity: undefined },
      },
    ]);
    expect(aiGatewayLogRoute).toEqual({ gateway: "platform-gateway" });
  }, 15000);

  it("uses an explicit Workers AI gateway override", async () => {
    const { getModelWithLogRoute } = await import("../src/ai-models.js");

    const { aiGatewayLogRoute } = getModelWithLogRoute(
        env({ CF_AI_GATEWAY_WAI: "workers-ai-gateway" }),
        WORKERS_AI_CONFIG,
        INITIATOR);

    expect(workersAiCalls).toEqual([
      {
        modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        options: {
          binding: workersAiBinding,
          gateway: { id: "workers-ai-gateway", metadata: { user: "user-123" } },
        },
        settings: { sessionAffinity: undefined },
      },
    ]);
    expect(gatewayCalls).toEqual([]);
    expect(aiGatewayLogRoute).toEqual({ gateway: "workers-ai-gateway" });
  }, 15000);
});
