import { describe, expect, it } from "vitest";
import { normalizeAiModelConfig } from "../src/ai-model-config.js";

const config = {
  provider: "openai-compatible" as const,
  model: "  provider/model  ",
  apiToken: "  secret  ",
  apiUrl: "https://example.com/api/v1/",
  contextWindow: 128_000,
  outputLimit: 8_192,
};

describe("normalizeAiModelConfig", () => {
  it("normalizes an OpenAI-compatible model configuration", () => {
    expect(normalizeAiModelConfig(config)).toEqual({
      ...config,
      model: "provider/model",
      apiToken: "secret",
      apiUrl: "https://example.com/api/v1",
      compatibilityProfile: "conservative",
    });
  });

  it("normalizes a pasted Chat Completions endpoint to its base URL", () => {
    expect(normalizeAiModelConfig({
      ...config,
      apiUrl: "https://example.com/v1/chat/completions///",
    }).apiUrl).toBe("https://example.com/v1");
  });

  it.each([
    { name: "model ID", overrides: { model: " " }, error: "model ID" },
    { name: "API token", overrides: { apiToken: " " }, error: "API token" },
    { name: "base URL", overrides: { apiUrl: undefined }, error: "base URL" },
    { name: "invalid URL", overrides: { apiUrl: "not a URL" }, error: "valid HTTPS" },
    { name: "HTTP URL", overrides: { apiUrl: "http://example.com/v1" }, error: "valid HTTPS" },
    { name: "URL credentials", overrides: { apiUrl: "https://user:pass@example.com/v1" }, error: "credentials" },
    { name: "URL query", overrides: { apiUrl: "https://example.com/v1?route=chat" }, error: "query" },
    { name: "URL fragment", overrides: { apiUrl: "https://example.com/v1#chat" }, error: "fragment" },
    { name: "zero context window", overrides: { contextWindow: 0 }, error: "context window" },
    {
      name: "excessive context window",
      overrides: { contextWindow: 2_000_001 },
      error: "at most 2000000",
    },
    { name: "fractional output limit", overrides: { outputLimit: 1.5 }, error: "output limit" },
    {
      name: "output equal to context",
      overrides: { outputLimit: 128_000 },
      error: "less than",
    },
    {
      name: "unknown compatibility profile",
      overrides: { compatibilityProfile: "experimental" },
      error: "compatibility profile",
    },
  ])("rejects an invalid $name", ({ overrides, error }) => {
    expect(() => normalizeAiModelConfig({ ...config, ...overrides })).toThrow(error);
  });

  it("leaves other providers unchanged", () => {
    const existing = { provider: "openai" as const, model: "gpt", apiToken: " token " };
    expect(normalizeAiModelConfig(existing)).toBe(existing);
  });
});
