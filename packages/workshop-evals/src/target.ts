import { AgentSession, type AgentSessionOptions } from "@gadgets/integration-tests/agent-session";
import {
  startHarness, type WorkerConfig,
} from "@gadgets/integration-tests/harness";
import { NetworkInterceptor } from "@gadgets/integration-tests/network-interceptor";

export type LocalModelAccess = {
  kind: "gateway";
  gateway: string;
  accountId: string;
  apiToken: string;
} | {
  kind: "direct";
  accountId: string;
  apiToken: string;
};

function value(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const candidate = environment[key]?.trim();
  return candidate ? candidate : undefined;
}

/** Resolve the credentials used by the local workerd Workshop for model inference. */
export function resolveModelAccess(
    environment: NodeJS.ProcessEnv = process.env): LocalModelAccess {
  const gateway = value(environment, "CF_AI_GATEWAY");
  const gatewayAccountId = value(environment, "CF_AI_GATEWAY_ACCOUNT_ID");
  const gatewayApiToken = value(environment, "CF_AI_GATEWAY_API_TOKEN");
  if ([gateway, gatewayAccountId, gatewayApiToken].some(Boolean)) {
    if (!gateway || !gatewayAccountId || !gatewayApiToken) {
      throw new Error(
        "Local AI Gateway evals require CF_AI_GATEWAY, CF_AI_GATEWAY_ACCOUNT_ID, and " +
        "CF_AI_GATEWAY_API_TOKEN together",
      );
    }
    return {
      kind: "gateway",
      gateway,
      accountId: gatewayAccountId,
      apiToken: gatewayApiToken,
    };
  }

  const accountId = value(environment, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = value(environment, "CLOUDFLARE_API_TOKEN");
  if (accountId && apiToken) return { kind: "direct", accountId, apiToken };
  throw new Error(
    "Local Workshop evals need model credentials: configure the CF_AI_GATEWAY trio or " +
    "CLOUDFLARE_ACCOUNT_ID with CLOUDFLARE_API_TOKEN",
  );
}

function configureGateway(config: WorkerConfig, access: Extract<LocalModelAccess, {kind: "gateway"}>) {
  config.vars = {
    ...config.vars,
    CF_AI_GATEWAY: access.gateway,
    CF_AI_GATEWAY_ACCOUNT_ID: access.accountId,
    CF_AI_GATEWAY_API_TOKEN: access.apiToken,
    CF_AI_GATEWAY_PROVIDERS: "cloudflare",
  };
}

function allowsModelEgress(access: LocalModelAccess, url: URL): boolean {
  const account = encodeURIComponent(access.accountId);
  if (access.kind === "gateway") {
    const gateway = encodeURIComponent(access.gateway);
    return (url.origin === "https://gateway.ai.cloudflare.com" &&
            url.pathname.startsWith(`/v1/${account}/${gateway}/`)) ||
      (url.origin === "https://api.cloudflare.com" &&
       url.pathname.startsWith(
           `/client/v4/accounts/${account}/ai-gateway/gateways/${gateway}/logs/`));
  }
  return url.origin === "https://api.cloudflare.com" &&
    url.pathname.startsWith(`/client/v4/accounts/${account}/ai/v1`);
}

function denyUnexpectedEgress(): Response {
  return new Response("External network access is disabled during this eval.", { status: 403 });
}

/** Start one isolated local workerd Workshop and agent session. */
export async function openWorkshopTarget(
    access: LocalModelAccess, model: string, turnTimeoutMs: number) {
  const interceptor = new NetworkInterceptor(
      [denyUnexpectedEgress], url => allowsModelEgress(access, url));
  interceptor.install();
  try {
    const harness = await startHarness({
      gatekeepers: [],
      enableGadgetExecution: true,
      ...(access.kind === "gateway"
        ? { patchWorkshop: (config: WorkerConfig) => configureGateway(config, access) }
        : {}),
    });
    const options: AgentSessionOptions = { modelId: model, timeoutMs: turnTimeoutMs };
    if (access.kind === "direct") {
      options.userModel = {
        profile: { type: "agent", id: model, name: model },
        config: {
          provider: "cloudflare",
          model,
          accountId: access.accountId,
          apiToken: access.apiToken,
        },
      };
    }
    try {
      const session = await AgentSession.create(harness.url, options);
      return {
        session,
        [Symbol.asyncDispose]: async () => {
          session[Symbol.dispose]();
          try {
            await harness.server.close();
          } finally {
            interceptor.uninstall();
          }
        },
      };
    } catch (error) {
      await harness.server.close();
      throw error;
    }
  } catch (error) {
    interceptor.uninstall();
    throw error;
  }
}
