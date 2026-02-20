import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { generateText, LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createWorkersAI } from "workers-ai-provider";
import { createOllama } from 'ollama-ai-provider-v2';
import { ApprovalQueue, Gatekeeper, ResourceDescription } from '@gadgets/workshop-shared/gatekeeper';
import { LanguageModelBinding } from "./ai-model-binding";
import AI_MODEL_BINDING_TYPES from "./ai-model-binding.txt";
import { AiModelConfig } from "@gadgets/workshop-shared/api";
import { AiGatewayConfig, getAiGatewayConfig } from "./ai-gateway.js";

export function getModel(env: Cloudflare.Env, config: AiModelConfig): LanguageModel {
  // When AI Gateway mode is active, all models are routed through the gateway.
  // The config's apiToken and apiUrl are ignored; we use the gateway URL and CF API token instead.
  let gwConfig = getAiGatewayConfig(env);
  if (gwConfig) {
    return getModelViaGateway(env, gwConfig, config);
  }

  return getModelDirect(env, config);
}

function getModelViaGateway(
  env: Cloudflare.Env,
  gwConfig: AiGatewayConfig,
  config: AiModelConfig,
): LanguageModel {
  let baseURL = gwConfig.getBaseUrl(config.provider);

  switch (config.provider) {
    case "anthropic":
      return createAnthropic({
        apiKey: gwConfig.apiToken,
        baseURL,
      })(config.model);
    case "cloudflare":
      return createWorkersAI({
        binding: env.WORKERS_AI,
        gateway: { id: gwConfig.workersAiGateway },
      })(config.model as any);
    case "google":
      return createGoogleGenerativeAI({
        apiKey: gwConfig.apiToken,
        baseURL,
      })(config.model);
    case "openai":
      return createOpenAI({
        apiKey: gwConfig.apiToken,
        baseURL,
      })(config.model);
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
};

type LanguageModelAction = {
  // There are no actions yet.
};
type LanguageModelRevertInfo = {
  // There are no actions yet.
};

export class LanguageModelGatekeeper
    extends DurableObject<Cloudflare.Env, LanguageModelGatekeeperProps>
    implements Gatekeeper<LanguageModelBinding, LanguageModelAction, LanguageModelRevertInfo> {
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

  async startSession(approvalQueue: RpcStub<ApprovalQueue<LanguageModelAction>>)
      : Promise<LanguageModelBinding> {
    let model = getModel(this.env, this.ctx.props.config);
    return new LanguageModelBindingImpl(model);
  }

  applyAction(action: LanguageModelAction): Promise<void | {revertInfo?: LanguageModelRevertInfo}> {
    throw new Error("This gatekeeper implements no actions.");
  }
  rejectAction(action: LanguageModelAction): Promise<void | {restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }
  revertAction(action: LanguageModelAction, revertInfo: LanguageModelRevertInfo):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }

  async setHook(hook: Fetcher<WorkerEntrypoint> | null): Promise<void> {
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
    return text;
  }
}
