import {DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub} from "cloudflare:workers";
import {skipRpcValidation, validateRpc} from "capnweb-validate";
import {connectHandoffPageHtml, htmlResponse} from "@gadgets/gatekeeper-kit/connect-pages";
import type {
  AccountDescription, ActionKind, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback,
  GatekeeperUser, GatekeeperUserVerifier, HookController, HookInitiator, HookTargetMetadata,
  ConnectHandoff, ResourceConfiguratorFrame, ResourceDescription, SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {WebhookEvent, WebhookHook, WebhookJson, WebhookSession} from "./types.js";

const TYPES_CODE = `
type WebhookJson = null | boolean | number | string | WebhookJson[] | {[key: string]: WebhookJson};
interface WebhookEvent { id: string; timestamp: string; payload: WebhookJson; }
interface WebhookHook { onWebhook(event: WebhookEvent): Promise<void>; }
interface WebhookSession {
  subscribe(callback: RpcStub<WebhookHook>): Promise<void>;
  getTriggerUrl(): Promise<string>;
}`;
const ICON = {url: "data:image/svg+xml," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><path fill='%23f48120' d='M88 40h80v48h48v80h-48v48H88v-48H40V88h48zm16 64v48h48v-48z'/></svg>",
)};
type Env = Cloudflare.Env & {BASE_URL?: string};
type HookTarget = RpcTarget & WebhookHook;
const RESOURCE: SupportedResource = {
  urlPattern: "webhook://local/:name",
  title: "Local Webhook",
  description: "A named local-only JSON webhook trigger.",
};

function baseUrl(env: Env): string {
  return (env.BASE_URL ?? "http://localhost:8787/gatekeeper/webhook").replace(/\/$/, "");
}
function dispatcher(exports: Cloudflare.Exports): DurableObjectStub<WebhookDispatcher> {
  return exports.WebhookDispatcher.getByName("local");
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Local Webhook", url: baseUrl(this.env), logo: ICON,
      tagline: "Trigger a Gadget with a plain local HTTP POST",
      description: "A development-only webhook trigger with no external provider setup.",
      autoProvisionsAccount: true, providesAuth: false,
    };
  }
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.WebhookAccount({props: {accountId: crypto.randomUUID()}}) as unknown as
      Fetcher<GatekeeperUser>;
  }
  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>): Promise<{url: string}> {
    const id = this.ctx.exports.WebhookConnect.newUniqueId();
    const nonce = crypto.randomUUID();
    await this.ctx.exports.WebhookConnect.get(id).begin(_callback, nonce);
    return {url: `${baseUrl(this.env)}/connect/${id}/${nonce}`};
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return [RESOURCE]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

type AccountProps = {accountId: string};
@validateRpc()
export class WebhookAccount extends WorkerEntrypoint<Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {displayName: "Local Webhook", avatar: ICON};
  }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<WebhookSession>>> {
    return this.ctx.exports.WebhookGatekeeper({props: this.ctx.props});
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return [RESOURCE]; }
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<WebhookSession>>; resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (parsed.protocol !== "webhook:" || parsed.hostname !== "local" || parsed.pathname.length < 2) {
      throw new Error(`Invalid local webhook resource URL: ${url}`);
    }
    return {class: this.ctx.exports.WebhookGatekeeper({props: this.ctx.props}), resource: RESOURCE};
  }
  startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Local Webhook has no resource configurator.");
  }
  async ensureResources(patterns: string[]): Promise<{url?: string}> {
    return patterns.includes(RESOURCE.urlPattern) ? {url: "webhook://local/investigator"} : {};
  }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  async revoke(): Promise<void> { await dispatcher(this.ctx.exports).setHook(null); }
  reconnect(): Promise<{url: string}> { throw new Error("Local Webhook has no credentials."); }
  commitReconnect(_stageId: string): Promise<void> { throw new Error("No reconnect is pending."); }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.WebhookVerifier({});
  }
}

@validateRpc()
export class WebhookVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

export class WebhookConnect extends DurableObject<Env> {
  async begin(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put("nonce", nonce);
    this.ctx.storage.setAlarm(Date.now() + 10 * 60_000);
  }
  async complete(nonce: string): Promise<ConnectHandoff | null> {
    if (this.ctx.storage.kv.get<string>("nonce") !== nonce) return null;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return null;
    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.delete("callback");
    this.ctx.storage.deleteAlarm();
    return callback.complete(this.ctx.exports.WebhookAccount({props: {accountId: crypto.randomUUID()}}));
  }
  async alarm(): Promise<void> { await this.ctx.storage.deleteAll(); }
}

@validateRpc()
class WebhookSessionTarget extends RpcTarget implements WebhookSession {
  constructor(
    private readonly ctx: DurableObjectState<AccountProps>,
    private readonly approvalQueue: RpcStub<ApprovalQueue>,
    private readonly url: string,
  ) { super(); }
  async subscribe(callback: RpcStub<HookTarget>): Promise<void> {
    const controller = this.ctx.exports.WebhookHookController({props: {}});
    // @ts-ignore Workers widens the hook type across bindHook RPC.
    await this.approvalQueue.bindHook(controller, callback, {
      title: "Receive local webhook", description: `Receive POST requests sent to ${this.url}`,
    });
  }
  async getTriggerUrl(): Promise<string> { return this.url; }
  [Symbol.dispose](): void { this.approvalQueue[Symbol.dispose]?.(); }
}

@validateRpc()
export class WebhookGatekeeper extends DurableObject<Env, AccountProps>
    implements Gatekeeper<WebhookSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: `${baseUrl(this.env)}/trigger`, title: "Local Webhook",
      snippet: "Trigger this Gadget with a local JSON POST.",
      suggestedBindingName: "WEBHOOK", tsType: "WebhookSession", hookTsType: "WebhookHook",
    };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<WebhookSession> {
    return new WebhookSessionTarget(this.ctx, queue.dup(), `${baseUrl(this.env)}/trigger`);
  }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
  applyAction(_action: number): Promise<void> { throw new Error("Local Webhook has no actions."); }
  async rejectAction(_action: number): Promise<void> {}
  revertAction(_action: number): Promise<void> { throw new Error("Local Webhook has no actions."); }
}

@validateRpc()
export class WebhookHookController extends WorkerEntrypoint<Env>
    implements HookController<HookTarget> {
  async enable(initiator: Fetcher<HookInitiator<HookTarget>>, _target: HookTargetMetadata): Promise<void> {
    await dispatcher(this.ctx.exports).setHook(initiator);
  }
  async disable(): Promise<void> { await dispatcher(this.ctx.exports).setHook(null); }
}

export class WebhookDispatcher extends DurableObject<Env> {
  async setHook(hook: Fetcher<HookInitiator<HookTarget>> | null): Promise<void> {
    if (hook) this.ctx.storage.kv.put("hook", hook);
    else this.ctx.storage.kv.delete("hook");
  }
  async trigger(payload: WebhookJson): Promise<void> {
    const initiator = this.ctx.storage.kv.get<Fetcher<HookInitiator<HookTarget>>>("hook");
    if (!initiator) throw new Error("No Investigator webhook is installed yet.");
    // @ts-expect-error the RPC promise carries disposable pipelined stubs.
    using started = initiator.startHook();
    await started.approvalQueue.authorizeObservation({
      title: "Local webhook received", description: "Received a JSON payload from the local trigger.",
    });
    const event: WebhookEvent = {id: crypto.randomUUID(), timestamp: new Date().toISOString(), payload};
    await started.callback.onWebhook(event);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const root = new URL(baseUrl(env)).pathname;
    const connect = new RegExp(`^${root}/connect/([0-9a-f]{64})/([0-9a-f-]{36})$`, "i").exec(url.pathname);
    if (connect && req.method === "GET") {
      const handoff = await ctx.exports.WebhookConnect
        .get(ctx.exports.WebhookConnect.idFromString(connect[1]!)).complete(connect[2]!);
      return handoff ? htmlResponse(connectHandoffPageHtml(handoff))
        : new Response("Connection link expired", {status: 400});
    }
    if (url.pathname !== `${root}/trigger`) return new Response("Not Found", {status: 404});
    if (req.method !== "POST") return new Response("Method Not Allowed", {status: 405, headers: {Allow: "POST"}});
    let payload: unknown;
    try { payload = await req.json(); } catch { return new Response("Body must be JSON", {status: 400}); }
    if (payload === undefined) return new Response("Body must be JSON", {status: 400});
    try {
      await dispatcher(ctx.exports).trigger(payload as WebhookJson);
      return new Response(null, {status: 204});
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), {status: 409});
    }
  },
};
