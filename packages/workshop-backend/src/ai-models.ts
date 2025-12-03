import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { generateText, LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createWorkersAI } from "workers-ai-provider";
import { createOllama } from 'ollama-ai-provider-v2';
import { ApprovalQueue, Gatekeeper, ResourceDescription } from '@minions/workshop-shared/gatekeeper';
import { LanguageModelBinding } from "./ai-model-binding";
import AI_MODEL_BINDING_TYPES from "./ai-model-binding.txt";

export type ModelOption = {
  displayName: string;
  model: LanguageModel;
  providerOptions?: any;
};

export function getModels(env: Cloudflare.Env): Record<string, ModelOption> {
  // TODO: Allow users to configure models with their own API keys, local ollama, etc.

  let anthropicProvider = createAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL,
  });
  let openAiProvider = createOpenAI({
    apiKey: env.OPENAI_API_KEY,
  });
  let geminiProvider = createGoogleGenerativeAI({
    apiKey: env.GEMINI_API_KEY,
  });
  let workersAiProvider = createWorkersAI({
    binding: env.WORKERS_AI,
  });
  let ollamaProvider = createOllama({
    baseURL: "http://localhost:11434/api"
  });

  return {
    "claude-haiku-4-5": {
      displayName: "Claude Haiku 4.5",
      model: anthropicProvider("claude-haiku-4-5"),
    },
    "claude-sonnet-4-5": {
      displayName: "Claude Sonnet 4.5",
      model: anthropicProvider("claude-sonnet-4-5"),
    },
    "claude-opus-4-5": {
      displayName: "Claude Opus 4.5",
      model: anthropicProvider("claude-opus-4-5"),
    },
    "gpt-5.1-codex": {
      displayName: "ChatGPT 5.1 Codex",
      model: openAiProvider("gpt-5.1-codex"),

      // GPT tends to take a lot of turns where it's not producing any text, and meanwhile
      // it takes FOREVER. It can be useful to see the reasoning, but unfortunately this requires
      // that the API key belongs to a "verified" organization. I guess they are scared of
      // distillers?
      //
      // providerOptions: {
      //   openai: {
      //     reasoningSummary: "auto"
      //   }
      // }
    },
    "gemini-pro": {
      displayName: "Gemini 3",
      model: geminiProvider("gemini-3-pro-preview")
    },
    "qwen-workersai": {
      displayName: "Qwen 3 Coder 480B",
      model: workersAiProvider("@cf/qwen/qwen3-coder-480b-a35b-instruct-fp8"),
    },
    "qwen-ollama": {
      displayName: "Qwen 3 Coder 30B (local)",
      model: ollamaProvider("qwen3-coder:30b"),
    },
    "gemma3-ollama": {
      displayName: "Gemma 3 4B (local)",
      model: ollamaProvider("gemma3:latest"),
    },
  };
}

// =======================================================================================

export type LanguageModelGatekeeperProps = {
  modelId: string
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
    let modelId = this.ctx.props.modelId;
    let model = getModels(this.env)[modelId];
    let displayName = model ? model.displayName : "Error: Unknown Model";

    return {
      // TODO: Decide if we need real URLs or if `url` should stop being part of the description.
      url: `http://models.local/${modelId}`,

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
    let modelId = this.ctx.props.modelId;
    let model = getModels(this.env)[modelId];
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    return new LanguageModelBindingImpl(modelId, model);
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
}

class LanguageModelBindingImpl extends RpcTarget implements LanguageModelBinding {
  constructor(private modelId: string, private model: ModelOption) {
    super();
  }

  async run(options: {prompt: string, systemPrompt?: string}): Promise<string> {
    // TODO: Should we be calling authorizeObservation() here? It's not really observing anything,
    //   but you might want the audit logs?
    let { text } = await generateText({
      model: this.model.model,
      providerOptions: this.model.providerOptions,
      prompt: options.prompt,
      system: options.systemPrompt
    });
    return text;
  }
}
