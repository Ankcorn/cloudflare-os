import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { generateText, LanguageModel, wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic as aigCreateAnthropic } from "ai-gateway-provider/providers/anthropic";
import { createOpenAI as aigCreateOpenAI } from "ai-gateway-provider/providers/openai";
import { createGoogleGenerativeAI as aigCreateGoogleGenerativeAI } from "ai-gateway-provider/providers/google";
import { createWorkersAI } from "workers-ai-provider";
import { createOllama } from 'ollama-ai-provider-v2';
import { ApprovalQueue, Gatekeeper, ResourceDescription } from '@gadgets/workshop-shared/gatekeeper';
import { LanguageModelBinding } from "./ai-model-binding";
import AI_MODEL_BINDING_TYPES from "./ai-model-binding.txt";
import { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import { AiGatewayConfig, getAiGatewayConfig, type AiGatewayLogRoute } from "./ai-gateway.js";
import { AiGateway, createAiGateway } from 'ai-gateway-provider';
import { createUnified } from "ai-gateway-provider/providers/unified";

 // Routing to bill a user's own Cloudflare account for inference (BYOK path once the free tier is
 // exhausted). Defined here to avoid a backend->ai-gateway-billing type import cycle at runtime.
 // Inference is routed through the account's "default" AI Gateway.
 export interface UserGatewayRouting {
   accountId: string;
   apiKey: string;
 }

// Maps our internal provider id to the prefix used by the AI Gateway unified-billing (OpenAI-compat)
// model ids (e.g. "google" -> "google-ai-studio/gemini-...", "cloudflare" -> "workers-ai/@cf/...").
const UNIFIED_BILLING_PROVIDER_PATH: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google-ai-studio",
  cloudflare: "workers-ai",
};

// Gadgets-owned attribution schema attached to AI Gateway requests.
type GatewayMetadata = {
  // Stable Gadgets user identifier for attribution.
  user: string;
  // Gadgets execution context, present when the call is associated with a gadget operation.
  source?: GatewayMetadataContext["source"];
  gadgetId?: string;
  chatId?: number;
  // Distinguishes gadget-initiated model calls from interactive user calls.
  automated?: true;
};

type GatewayMetadataContext = {
  source: "chat" | "thread-title" | "gadget-title" | "model-binding";
  gadgetId?: string;
  chatId?: number;
};

type ModelRoutingOptions = {
  sessionAffinity?: string;
  userGateway?: UserGatewayRouting;
  metadata?: GatewayMetadataContext;
};

type ModelWithLogRoute = {
  model: LanguageModel;
  aiGatewayLogRoute?: AiGatewayLogRoute;
};

function buildMetadata(initiator: AiChatAuthorInfo, context?: GatewayMetadataContext): GatewayMetadata {
  const metadata: GatewayMetadata = { user: initiator.id };
  if (context) {
    metadata.source = context.source;
    if (context.gadgetId) metadata.gadgetId = context.gadgetId;
    if (context.chatId !== undefined) metadata.chatId = context.chatId;
  }
  if (initiator.type === "gadget") metadata.automated = true;
  return metadata;
}

export function getModel(env: Cloudflare.Env, config: AiModelConfig,
                         initiator: AiChatAuthorInfo,
                         options: ModelRoutingOptions = {}): LanguageModel {
  return getModelWithLogRoute(env, config, initiator, options).model;
}

/** Resolve a model and the matching route for retrieving its AI Gateway log. */
export function getModelWithLogRoute(env: Cloudflare.Env, config: AiModelConfig,
                                    initiator: AiChatAuthorInfo,
                                    options: ModelRoutingOptions = {}): ModelWithLogRoute {
  // BYOK: a connected user's own Cloudflare account pays for everything (all providers, including
  // Workers AI), routed through the AI Gateway unified-billing endpoint. Honored regardless of
  // whether a platform AI Gateway is configured, so connected users are always billed correctly.
  if (options.userGateway) {
    return {
      model: getModelViaUserGateway(
          config, buildMetadata(initiator, options.metadata), options.userGateway),
      aiGatewayLogRoute: {
        gateway: "default",
        accountId: options.userGateway.accountId,
        apiToken: options.userGateway.apiKey,
      },
    };
  }

  // Otherwise: when a platform AI Gateway is configured, route through it (platform-funded free
  // tier). The config's apiToken/apiUrl are ignored in that mode.
  let gwConfig = getAiGatewayConfig(env);
  if (gwConfig) {
    return getModelViaGateway(env, gwConfig, config, initiator, options);
  }

  return { model: getModelDirect(env, config, options.sessionAffinity) };
}

// Route inference through the user's own account (unified billing) via their account's default AI
// Gateway. Supports every provider, including Workers AI (`workers-ai/@cf/...`). Billed to the
// user's Cloudflare credits; no provider API key required.
function getModelViaUserGateway(
  config: AiModelConfig,
  metadata: GatewayMetadata,
  userGateway: UserGatewayRouting,
): LanguageModel {
  const providerPath = UNIFIED_BILLING_PROVIDER_PATH[config.provider];
  if (!providerPath) {
    throw new Error(`Provider "${config.provider}" is not supported via unified billing.`);
  }
  // Route through the user's AI Gateway data plane (universal endpoint). Auth is the connected
  // user's Cloudflare token via `cf-aig-authorization` (authorized by its `aig.run` scope); the
  // account-level `/ai/v1` REST endpoint rejects that token. We always use the account's
  // auto-created "default" gateway. Unified billing draws down the user's credits across every
  // provider, including Workers AI (`workers-ai/@cf/...`).
  const gateway = createAiGateway({
    accountId: userGateway.accountId,
    gateway: "default",
    apiKey: userGateway.apiKey,
    options: { metadata },
  });
  return gateway(createUnified()(`${providerPath}/${config.model}`));
}

// The Workers AI binding, unlike the REST providers, doesn't surface the AI Gateway log id through
// the AI SDK, so republish `env.WORKERS_AI.aiGatewayLogId` into the `cf-aig-log-id` response header
// that `onStepFinish` already consumes to attribute inference cost.
function captureAiGatewayLogId(env: Cloudflare.Env): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    // Only the streaming path is wrapped: the binding sets the log id and returns the stream in the same tick,
    // so the id is read before any concurrent run() can clobber it. Non-streaming awaits the body first (unsafe).
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      const logId = env.WORKERS_AI.aiGatewayLogId;
      if (!logId) return result;
      const headers = { ...result.response?.headers, "cf-aig-log-id": logId };
      return { ...result, response: { ...result.response, headers } };
    },
  };
}

// Platform free-tier path: route through the deployment's configured AI Gateway (platform-funded).
// Used only for requests that are NOT billed to a connected user's account.
function getModelViaGateway(
  env: Cloudflare.Env,
  gwConfig: AiGatewayConfig,
  config: AiModelConfig,
  initiator: AiChatAuthorInfo,
  options: ModelRoutingOptions,
): ModelWithLogRoute {
  const metadata = buildMetadata(initiator, options.metadata);

  if (config.provider === "cloudflare") {
    const model = createWorkersAI({
      binding: env.WORKERS_AI,
      ...(gwConfig.workersAiGateway && { gateway: { id: gwConfig.workersAiGateway, metadata } }),
    })(config.model as any, { sessionAffinity: options.sessionAffinity });
    if (!gwConfig.workersAiGateway) return { model };
    return {
      model: wrapLanguageModel({
        model,
        middleware: captureAiGatewayLogId(env),
      }),
      aiGatewayLogRoute: { gateway: gwConfig.workersAiGateway },
    };
  }

  let gatewayWrapper: AiGateway;
  let aiGatewayLogRoute: AiGatewayLogRoute;

  if (gwConfig.accountId && gwConfig.apiToken) {
    // Cross-account AI Gateway request, use token from env vars.
    gatewayWrapper = createAiGateway({
      accountId: gwConfig.accountId,
      gateway: gwConfig.gateway,
      apiKey: gwConfig.apiToken,
      options: { metadata },
    });
    aiGatewayLogRoute = {
      gateway: gwConfig.gateway,
      accountId: gwConfig.accountId,
      apiToken: gwConfig.apiToken,
    };
  } else {
    // We can just use our binding.
    gatewayWrapper = createAiGateway({
      // @ts-expect-error The {beta: false} options object is undocumented. We need it for now to
      // tell the binding not to use the new RPC implementation, which doesn't yet work with
      // AbortSignal.
      binding: env.WORKERS_AI.gateway(gwConfig.gateway, {beta: false}),
      options: { metadata },
    });
    aiGatewayLogRoute = { gateway: gwConfig.gateway };
  }

  let model: LanguageModel;
  switch (config.provider) {
    case "anthropic":
      model = gatewayWrapper(aigCreateAnthropic()(config.model));
      break;
    case "google":
      model = gatewayWrapper(aigCreateGoogleGenerativeAI()(config.model));
      break;
    case "openai":
      model = gatewayWrapper(aigCreateOpenAI()(config.model));
      break;
    default:
      throw new Error(
        `Provider "${config.provider}" is not supported through AI Gateway. ` +
        `Configured providers: ${[...gwConfig.providers].join(", ")}`
      );
  }
  return { model, aiGatewayLogRoute };
}

function getModelDirect(env: Cloudflare.Env, config: AiModelConfig,
                        sessionAffinity?: string): LanguageModel {
  switch (config.provider) {
    case "anthropic":
      return createAnthropic({
        apiKey: config.apiToken,
        baseURL: config.apiUrl,
      })(config.model);
    case "cloudflare":
      return createWorkersAI({
        binding: env.WORKERS_AI,
      })(config.model as any, { sessionAffinity });
    case "google":
      return createGoogleGenerativeAI({
        apiKey: config.apiToken,
        baseURL: config.apiUrl,
      })(config.model);
    case "ollama":
      // The ollama provider doesn't currently have an explicit apiKey option, but ollama
      // definitely supports API keys. That said, if the API key was left empty, we'll assume
      // we're using local auth.
      return createOllama({
        headers: config.apiToken === '' ? undefined : {
          "Authorization": `Bearer ${config.apiToken}`
        },
        baseURL: config.apiUrl,
      })(config.model);
    case "openai":
      return createOpenAI({
        apiKey: config.apiToken,
        baseURL: config.apiUrl,
      })(config.model);
  }
}

// =======================================================================================

export type LanguageModelGatekeeperProps = {
  displayName: string,
  config: AiModelConfig,
  initiator: AiChatAuthorInfo,
  metadata?: GatewayMetadataContext,
};

export class LanguageModelGatekeeper
    extends DurableObject<Cloudflare.Env, LanguageModelGatekeeperProps>
    implements Gatekeeper<LanguageModelBinding> {
  async describe(): Promise<ResourceDescription> {
    let modelConfig = this.ctx.props.config;
    let displayName = this.ctx.props.displayName;

    return {
      // TODO: Decide if we need real URLs or if `url` should stop being part of the description.
      url: `http://models.local/${modelConfig.provider}/${modelConfig.model}`,

      title: displayName,
      snippet: "An AI large language model.",

      suggestedBindingName: "LLM",

      tsType: "LanguageModelBinding",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return AI_MODEL_BINDING_TYPES;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<LanguageModelBinding> {
    let model = getModel(this.env, this.ctx.props.config, this.ctx.props.initiator, {
      metadata: this.ctx.props.metadata,
    });
    return new LanguageModelBindingImpl(model);
  }

  applyAction(action: number): Promise<void> {
    throw new Error("This gatekeeper implements no actions.");
  }
  rejectAction(action: number): Promise<void | {restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }
  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }

  async addObserver(_id: string, _user: Fetcher): Promise<void> {
    // An AI model is not a restricted-access resource: nothing read through it identifies the
    // observer or leaks private data, so any observer is permitted. No-op (never throws).
  }

  async removeObserver(_id: string): Promise<void> {
    // No observer state is tracked (see addObserver). Idempotent no-op.
  }
}

@validateRpc()
class LanguageModelBindingImpl extends RpcTarget implements LanguageModelBinding {
  constructor(private model: LanguageModel) {
    super();
  }

  async run(options: {prompt: string, systemPrompt?: string}): Promise<string> {
    // TODO: Should we be calling authorizeObservation() here? It's not really observing anything,
    //   but you might want the audit logs?
    let { text } = await generateText({
      model: this.model,
      prompt: options.prompt,
      system: options.systemPrompt
    });

    // TODO: Account LLM costs back to the calling gadget.

    return text;
  }
}
