import { DurableObject, RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  AccountDescription,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorInterface,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
  stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import { CloudflareGatekeeperUser } from "@gadgets/workshop-shared/cloudflare-gatekeeper";
import {
  AUTH_SCOPES,
  BILLING_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  getOAuthConfig,
  persistentScopesForResources,
  refreshTokens,
} from "./oauth.js";
import { fetchIdentity } from "./cloudflare-api.js";
import {
  CLOUDFLARE_RESOURCES,
  EVENT_SUBSCRIPTIONS_RESOURCE,
  eventSubscriptionsUrl,
  grantedCloudflareResourcePatterns,
  parseEventSubscriptionsUrl,
} from "./resources.js";
import { CloudflareAccountConfiguratorUI } from "./cloudflare-configurator.js";
import CONFIGURATOR_HTML from "./generated/cloudflare-event-subscriptions-configurator-ui.txt";
import TYPES_CODE from "./types.txt";
import type { CloudflareEventSubscriptionSession } from "./types.js";
import {
  CloudflareEventHookController,
  CloudflareEventSubscriptionPoller,
  CloudflareEventSubscriptionsGatekeeper,
} from "./event-subscriptions.js";
export {
  CloudflareEventHookController,
  CloudflareEventSubscriptionPoller,
  CloudflareEventSubscriptionsGatekeeper,
};

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
  verifier?: string;
};
type StoredAccessToken = { token: string; expires: number };

type EventSubscriptionUserProps = { userObjectId: string };

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;
const LOGO_URL = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 209.51 94.74"><path fill="#f4801f" d="M143.05 93.42l1.27-4.41c1.27-4.41.8-8.48-1.34-11.48-2-2.76-5.26-4.38-9.25-4.57L58 72.7a1.47 1.47 0 01-1.35-2 2 2 0 011.75-1.34l76.26-1c9-.41 18.84-7.75 22.27-16.71l4.34-11.36a2.68 2.68 0 00.18-1 3.31 3.31 0 00-.06-.54 49.67 49.67 0 00-95.49-5.14 22.35 22.35 0 00-35 23.42A31.73 31.73 0 00.34 93.45a1.47 1.47 0 001.45 1.27l139.49 0a1.83 1.83 0 001.77-1.3z"/><path fill="#f9ab41" d="M168.22 41.15q-1 0-2.1.06a.88.88 0 00-.32.07 1.17 1.17 0 00-.76.8l-3 10.26c-1.28 4.41-.81 8.48 1.34 11.48a11.65 11.65 0 009.24 4.57l16.11 1a1.44 1.44 0 011.14.62 1.5 1.5 0 01.17 1.37 2 2 0 01-1.75 1.34l-16.73 1c-9.09.42-18.88 7.75-22.31 16.7l-1.21 3.16a.9.9 0 00.79 1.22h57.63A1.55 1.55 0 00208 93.63a41.34 41.34 0 00-39.78-52.48z"/></svg>`,
);

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}
function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}
function baseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/cloudflare-events");
}
function basePath(env: Env): string {
  const path = new URL(baseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

const COMPLETE_HTML = "<!doctype html><html><body><script>window.close()</script>" +
  "<p>Authorization complete. You may close this tab.</p></body></html>";
const INVALID_HTML = "<!doctype html><html><body><h1>Authorization link expired</h1>" +
  "<p>Return to Cloudflare OS and start again.</p></body></html>";
const CONFIG_HTML = "<!doctype html><html><body><h1>Configuration required</h1>" +
  "<p>Configure the Cloudflare OAuth client.</p></body></html>";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const pathPrefix = basePath(env);
    if (!url.pathname.startsWith(pathPrefix + "/") && url.pathname !== pathPrefix) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${pathPrefix}`);
    }
    const relative = url.pathname.slice(pathPrefix.length);
    const parts = relative.slice(1).split("/");
    if (parts.length === 2 && parts[0]?.length === 64 && parts[1]?.length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) return new Response(CONFIG_HTML, { headers: { "Content-Type": "text/html" } });
      const account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(parts[0]!));
      const begun = await account.beginOAuthFlow(parts[1]!);
      if (!begun) return new Response(INVALID_HTML, { headers: { "Content-Type": "text/html" } });
      const config = getOAuthConfig(env.CLIENT_ID, env.CLIENT_SECRET, baseUrl(env))!;
      return Response.redirect(buildAuthorizeUrl(config, `${parts[0]}:${begun.oauthNonce}`, begun.challenge, begun.scopes), 302);
    }
    if (relative === "/oauth") {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code) return new Response("Error: missing OAuth state or code");
      const separator = state.indexOf(":");
      if (separator < 0) return new Response("Error: malformed OAuth state");
      const userId = state.slice(0, separator);
      const account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(userId));
      if (!await account.acceptAuthCode(code, state.slice(separator + 1))) {
        return new Response(INVALID_HTML, { headers: { "Content-Type": "text/html" } });
      }
      return new Response(COMPLETE_HTML, { headers: { "Content-Type": "text/html" } });
    }
    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorInterface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Cloudflare Event Subscriptions",
      url: "https://cloudflare.com",
      logo: { url: LOGO_URL },
      color: "#fbece0",
      tagline: "Subscribe to Cloudflare account events",
      description: "Connect Cloudflare Event Subscriptions to receive selected account events.",
      providesAuth: true,
    };
  }
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    const scopes = options?.scopes === "auth" ? AUTH_SCOPES : persistentScopesForResources(options?.resourceUrlPatterns);
    await this.ctx.exports.UserAccount.get(id).setCallback(callback, nonce, scopes, options?.scopes === "auth");
    return { url: `${baseUrl(this.env)}/${id.toString()}/${nonce}` };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return CLOUDFLARE_RESOURCES; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

export class UserAccount extends DurableObject<Env> {
  #config() {
    const config = getOAuthConfig(this.env.CLIENT_ID, this.env.CLIENT_SECRET, baseUrl(this.env));
    if (!config) throw new Error("The Cloudflare Event Subscriptions gatekeeper is not configured.");
    return config;
  }
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string, scopes: string[], ephemeral = false) {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put("scopes", scopes);
    this.ctx.storage.kv.put("ephemeral", ephemeral);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS, stage: "initiation" });
  }
  async prepareReconnect(nonce: string, scopes: string[]) {
    this.ctx.storage.kv.put("scopes", scopes);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS, stage: "initiation" });
  }
  async getGrantedScopes(): Promise<string[]> { return this.ctx.storage.kv.get<string[]>("grantedScopes") ?? [...BILLING_SCOPES]; }
  async beginOAuthFlow(nonce: string) {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) return null;
    const oauthNonce = generateNonce();
    const { verifier, challenge } = await generatePkce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: oauthNonce, expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS, stage: "oauth", verifier });
    return { oauthNonce, challenge, scopes: this.ctx.storage.kv.get<string[]>("scopes") ?? [...BILLING_SCOPES] };
  }
  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || !stored.verifier || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) return false;
    this.ctx.storage.kv.delete("nonce");
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Took too long to complete the authorization.");
    const tokens = await exchangeCode(this.#config(), code, stored.verifier);
    if (!tokens?.refreshToken) throw new Error("Cloudflare OAuth exchange failed or returned no refresh token.");
    this.ctx.storage.kv.put("refreshToken", tokens.refreshToken);
    this.ctx.storage.kv.put<StoredAccessToken>("accessToken", { token: tokens.accessToken, expires: Date.now() + tokens.expiresIn * 1000 });
    this.ctx.storage.kv.put("grantedScopes", tokens.scopes ?? this.ctx.storage.kv.get<string[]>("scopes") ?? [...BILLING_SCOPES]);
    if (this.ctx.storage.kv.get<boolean>("reconnecting")) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props: { userObjectId: this.ctx.id.toString() } }));
      if (this.ctx.storage.kv.get<boolean>("ephemeral")) this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 1000);
    }
    return true;
  }
  async getAccessToken(): Promise<string | null> {
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) return null;
    const cached = this.ctx.storage.kv.get<StoredAccessToken>("accessToken");
    if (cached && cached.expires > Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) return cached.token;
    const refreshed = await refreshTokens(this.#config(), refreshToken);
    if (!refreshed) return null;
    if (refreshed.refreshToken) this.ctx.storage.kv.put("refreshToken", refreshed.refreshToken);
    if (refreshed.scopes) this.ctx.storage.kv.put("grantedScopes", refreshed.scopes);
    this.ctx.storage.kv.put("accessToken", { token: refreshed.accessToken, expires: Date.now() + refreshed.expiresIn * 1000 });
    return refreshed.accessToken;
  }
  async alarm() { if (!this.ctx.storage.kv.get<string>("refreshToken") || this.ctx.storage.kv.get<boolean>("ephemeral")) this.ctx.storage.deleteAll(); }
  async revoke() { this.ctx.storage.deleteAlarm(); this.ctx.storage.deleteAll(); }
}

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, EventSubscriptionUserProps> implements CloudflareGatekeeperUser {
  #account() {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }
  async describe(): Promise<AccountDescription> {
    const token = await this.#account().getAccessToken();
    const identity = token ? await fetchIdentity(token) : null;
    return { displayName: identity?.displayName, uniqueName: identity?.email, avatar: { url: LOGO_URL }, grantedResourceUrlPatterns: grantedCloudflareResourcePatterns(await this.#account().getGrantedScopes()) };
  }
  async getAuthenticatedEmail(): Promise<string | null> {
    const token = await this.#account().getAccessToken();
    return token ? (await fetchIdentity(token))?.email ?? null : null;
  }
  async ensureResources(resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    const granted = new Set(grantedCloudflareResourcePatterns(await this.#account().getGrantedScopes()));
    if (resourceUrlPatterns.every(pattern => granted.has(pattern))) return {};
    const nonce = generateNonce();
    await this.#account().prepareReconnect(nonce, persistentScopesForResources([...granted, ...resourceUrlPatterns]));
    return { url: `${baseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }
  async getUsableAccessToken(): Promise<string | null> { return this.#account().getAccessToken(); }
  async getSupportedResources(): Promise<SupportedResource[]> { return CLOUDFLARE_RESOURCES; }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<any>>; resource: SupportedResource }> {
    const parsed = parseEventSubscriptionsUrl(url);
    return {
      class: this.ctx.exports.CloudflareEventSubscriptionsGatekeeper({ props: { userObjectId: this.ctx.props.userObjectId, accountId: parsed.accountId } }),
      resource: EVENT_SUBSCRIPTIONS_RESOURCE,
    };
  }
  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== EVENT_SUBSCRIPTIONS_RESOURCE.urlPattern) throw new Error(`Unsupported Cloudflare resource configurator type: ${resourceUrlPattern}`);
    return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(new CloudflareAccountConfiguratorUI(() => this.#account().getAccessToken())) };
  }
  async revoke() { await this.#account().revoke(); }
  async reconnect(): Promise<{ url: string }> {
    const nonce = generateNonce();
    await this.#account().prepareReconnect(nonce, await this.#account().getGrantedScopes());
    return { url: `${baseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.CloudflareVerifier({ props: { userObjectId: this.ctx.props.userObjectId } }); }
}

@validateRpc()
export class CloudflareVerifier extends WorkerEntrypoint<Env, EventSubscriptionUserProps> implements GatekeeperUserVerifier {}
