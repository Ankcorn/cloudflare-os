import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { generateText, LanguageModel } from "ai";
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
import { AiGatewayConfig, getAiGatewayConfig } from "./ai-gateway.js";
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

type GatewayMetadata = Record<string, string | number | bigint | boolean | null>;

function buildMetadata(initiator: AiChatAuthorInfo): GatewayMetadata {
  const metadata: GatewayMetadata = { user: initiator.id };
  if (initiator.type === "gadget") metadata.automated = true;
  return metadata;
}

export function getModel(env: Cloudflare.Env, config: AiModelConfig,
                         initiator: AiChatAuthorInfo,
                         sessionAffinity?: string,
                         userGateway?: UserGatewayRouting): LanguageModel {
  // BYOK: a connected user's own Cloudflare account pays for everything (all providers, including
  // Workers AI), routed through the AI Gateway unified-billing endpoint. Honored regardless of
  // whether a platform AI Gateway is configured, so connected users are always billed correctly.
  if (userGateway) {
    return getModelViaUserGateway(config, buildMetadata(initiator), userGateway);
  }

  // Otherwise: when a platform AI Gateway is configured, route through it (platform-funded free
  // tier). The config's apiToken/apiUrl are ignored in that mode.
  let gwConfig = getAiGatewayConfig(env);
  if (gwConfig) {
    return getModelViaGateway(env, gwConfig, config, initiator, sessionAffinity);
  }

  return getModelDirect(env, config, sessionAffinity);
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

// Platform free-tier path: route through the deployment's configured AI Gateway (platform-funded).
// Used only for requests that are NOT billed to a connected user's account.
function getModelViaGateway(
  env: Cloudflare.Env,
  gwConfig: AiGatewayConfig,
  config: AiModelConfig,
  initiator: AiChatAuthorInfo,
  sessionAffinity?: string,
): LanguageModel {
  const metadata = buildMetadata(initiator);

  if (config.provider === "cloudflare") {
    return createWorkersAI({
      binding: env.WORKERS_AI,
      gateway: { id: gwConfig.workersAiGateway, metadata },
    })(config.model as any, { sessionAffinity });
  }

  let gatewayWrapper: AiGateway;

  if (gwConfig.accountId) {
    // Cross-account AI Gateway request, use token from env vars.
    gatewayWrapper = createAiGateway({
      accountId: gwConfig.accountId,
      gateway: gwConfig.gateway,
      apiKey: gwConfig.apiToken,
      options: { metadata },
    });
  } else {
    // We can just use our binding.
    gatewayWrapper = createAiGateway({
      // @ts-expect-error The {beta: false} options object is undocumented. We need it for now to
      // tell the binding not to use the new RPC implementation, which doesn't yet work with
      // AbortSignal.
      binding: env.WORKERS_AI.gateway(gwConfig.gateway, {beta: false}),
      options: { metadata },
    });
  }

  switch (config.provider) {
    case "anthropic":
      return gatewayWrapper(aigCreateAnthropic()(config.model));
    case "google":
      return gatewayWrapper(aigCreateGoogleGenerativeAI()(config.model));
    case "openai":
      return gatewayWrapper(aigCreateOpenAI()(config.model));
    default:
      throw new Error(
        `Provider "${config.provider}" is not supported through AI Gateway. ` +
        `Configured providers: ${[...gwConfig.providers].join(", ")}`
      );
  }
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

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<LanguageModelBinding> {
    let model = getModel(this.env, this.ctx.props.config, this.ctx.props.initiator);
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

  async setHook(_hook: Fetcher | null): Promise<void> {
    // Safe to ignore since we don't have a hook!
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
