import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
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

export function getModel(env: Cloudflare.Env, config: AiModelConfig,
                         initiator: AiChatAuthorInfo): LanguageModel {
  // When AI Gateway mode is active, all models are routed through the gateway.
  // The config's apiToken and apiUrl are ignored; we use the gateway URL and CF API token instead.
  let gwConfig = getAiGatewayConfig(env);
  if (gwConfig) {
    return getModelViaGateway(env, gwConfig, config, initiator);
  }

  return getModelDirect(env, config);
}

function getModelViaGateway(
  env: Cloudflare.Env,
  gwConfig: AiGatewayConfig,
  config: AiModelConfig,
  initiator: AiChatAuthorInfo,
): LanguageModel {
  let metadata: any = {
    user: initiator.id,
  };
  if (initiator.type === "gadget") {
    metadata.automated = true;
  }

  if (config.provider === "cloudflare") {
    return createWorkersAI({
      binding: env.WORKERS_AI,
      gateway: { id: gwConfig.workersAiGateway, metadata },
    })(config.model as any);
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

function getModelDirect(env: Cloudflare.Env, config: AiModelConfig): LanguageModel {
  switch (config.provider) {
    case "anthropic":
      return createAnthropic({
        apiKey: config.apiToken,
        baseURL: config.apiUrl,
      })(config.model);
    case "cloudflare":
      return createWorkersAI({
        binding: env.WORKERS_AI,
      })(config.model as any);
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
    implements Gatekeeper<LanguageModelBinding, number, undefined> {
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

  async startSession(approvalQueue: RpcStub<ApprovalQueue<number>>)
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
  revertAction(action: number, revertInfo: undefined):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }

  async setHook(_hook: Fetcher | null): Promise<void> {
    // Safe to ignore since we don't have a hook!
  }
}

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
