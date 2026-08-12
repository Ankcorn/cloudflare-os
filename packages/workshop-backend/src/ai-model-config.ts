import type { AiModelConfig } from "@gadgets/workshop-shared/api";

const CHAT_COMPLETIONS_PATH = "/chat/completions";

// Validate and normalize fields owned by the OpenAI-compatible provider.
export function normalizeAiModelConfig(config: AiModelConfig): AiModelConfig {
  if (config.provider !== "openai-compatible") return config;

  const model = config.model.trim();
  if (!model) throw new Error("OpenAI-compatible model ID is required.");

  const apiToken = config.apiToken.trim();
  if (!apiToken) throw new Error("OpenAI-compatible API token is required.");
  if (!config.apiUrl) throw new Error("OpenAI-compatible base URL is required.");

  let apiUrl: URL;
  try {
    apiUrl = new URL(config.apiUrl);
  } catch {
    throw new Error("OpenAI-compatible base URL must be a valid HTTPS URL.");
  }
  if (apiUrl.protocol !== "https:") {
    throw new Error("OpenAI-compatible base URL must be a valid HTTPS URL.");
  }
  if (apiUrl.username || apiUrl.password) {
    throw new Error("OpenAI-compatible base URL must not contain credentials.");
  }
  if (apiUrl.search) throw new Error("OpenAI-compatible base URL must not contain a query string.");
  if (apiUrl.hash) throw new Error("OpenAI-compatible base URL must not contain a fragment.");

  const pathname = apiUrl.pathname.replace(/\/+$/, "");
  apiUrl.pathname = pathname.endsWith(CHAT_COMPLETIONS_PATH)
    ? pathname.slice(0, -CHAT_COMPLETIONS_PATH.length) || "/"
    : pathname || "/";

  if (!Number.isSafeInteger(config.contextWindow) || config.contextWindow! <= 0) {
    throw new Error("OpenAI-compatible context window must be a positive integer.");
  }
  if (!Number.isSafeInteger(config.outputLimit) || config.outputLimit! <= 0) {
    throw new Error("OpenAI-compatible output limit must be a positive integer.");
  }
  if (config.outputLimit! >= config.contextWindow!) {
    throw new Error("OpenAI-compatible output limit must be less than the context window.");
  }

  const compatibilityProfile = config.compatibilityProfile ?? "conservative";
  if (compatibilityProfile !== "conservative") {
    throw new Error(`Unknown OpenAI-compatible compatibility profile "${compatibilityProfile}".`);
  }

  return {
    ...config,
    model,
    apiToken,
    apiUrl: apiUrl.toString().replace(/\/$/, ""),
    compatibilityProfile,
  };
}
