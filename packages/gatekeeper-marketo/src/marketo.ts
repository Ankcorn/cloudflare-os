// Marketo gatekeeper.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  checkMutation,
  connectPageHtml,
  expiredLinkHtml,
  htmlResponse,
  jsonResponse,
} from "./connect-ui";
import {
  buildInstanceUrl,
  buildListUrl,
  buildProgramUrl,
  buildDesignStudioUrl,
  getBasePath,
  getBaseUrl,
  getDefaults,
  parseCredentials,
  DESIGN_STUDIO_RESOURCE,
  INSTANCE_RESOURCE,
  MARKETO_HOME_URL,
  MARKETO_ICON,
  parseResourceUrl,
  PROGRAM_RESOURCE,
  STATIC_LIST_RESOURCE,
  SUPPORTED_RESOURCES,
  type Env,
  type MarketoResourceKind,
} from "./config";
import {
  makeClient,
  tokenCacheStub,
  unwrapTokenCacheResult,
  type TokenCacheError,
} from "./token-cache";
import { logger } from "./logger";
import {
  assertActionResults,
  assertActionResultIdentity,
  assertApplied,
  describeActionForSubmission,
  expectedActionResults,
  executeAction,
  MarketoActionResultError,
  validateActionForDispatch,
  type MarketoAction,
  type MarketoActionInput,
} from "./actions";
import {
  executeDesignStudioAction,
  isDesignStudioAction,
  type DesignStudioAction,
  type DesignStudioAssetKind,
} from "./design-studio-actions";
import {
  executeCampaignAction,
  isCampaignAction,
  type CampaignAction,
} from "./campaign-actions";
import {
  executeProgramAction,
  isProgramAction,
  matchesProgramApprovalDates,
  type ProgramAction,
} from "./program-actions";
import { MarketoDesignStudioImpl } from "./design-studio";
import type { EmailDesignerContext } from "./email-designer";
import {
  DesignerPreDispatchError,
  executeEmailDesignerAction,
  isEmailDesignerAction,
  matchesDesignerCloneConfiguration,
  matchesDesignerCloneSnapshot,
  resolveDesignerCloneSnapshot,
  type EmailDesignerAction,
  type EmailDesignerKind,
} from "./email-designer-actions";
import {
  executeBusinessObjectAction,
  isBusinessObjectAction,
  type BusinessObjectAction,
} from "./business-object-actions";
import { BUSINESS_OBJECTS, type BusinessObjectContext } from "./business-objects";
import type { MarketoBusinessObjectAccess, MarketoBusinessObjectKind } from "./types";
import {
  makeSessionContext,
  type CampaignContext,
  MarketoProgramImpl,
  MarketoSessionImpl,
  MarketoStaticListImpl,
} from "./session";
import {
  fetchAccessToken,
  MarketoError,
  type MarketoClient,
  type MarketoCredentials,
  type DesignerAssetKind,
  type RawDesignerAsset,
  type RawList,
} from "./marketo-api";
import type { MarketoConfiguratorOption } from "./configurator/configurator-types";
import { CONFIGURATOR_LIMIT, resolveProgramOptions } from "./program-options";
import INSTANCE_CONFIGURATOR_HTML from "./generated/instance-configurator-ui.txt";
import PROGRAM_CONFIGURATOR_HTML from "./generated/program-configurator-ui.txt";
import LIST_CONFIGURATOR_HTML from "./generated/list-configurator-ui.txt";
import DESIGN_STUDIO_CONFIGURATOR_HTML from "./generated/design-studio-configurator-ui.txt";
import TYPES_CODE from "./types.txt";

export { MarketoTokenCache } from "./token-cache";

const NONCE_BYTES = 32;
/**
 * How long a connect link stays usable.
 *
 * The link is a bearer capability — whoever holds it within this window can bind credentials to
 * the account — so the window is only as long as filling in three fields plausibly takes.
 */
const NONCE_LIFETIME_MS = 5 * 60 * 1000;
/** Discard an unfinished connection after an hour. */
const ABANDONED_CONNECT_MS = 60 * 60 * 1000;

function generateNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(NONCE_BYTES))]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  let encoder = new TextEncoder();
  let bufA = encoder.encode(a);
  let bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

/** Length of a Durable Object id in hex. */
const DO_ID_LENGTH = 64;

const EXPIRED_LINK_MESSAGE =
  "This connection link is invalid or has expired. Return to the Workshop and try again.";
const MAX_CONNECT_BODY_BYTES = 16 * 1024;
const CONNECT_BODY_TIMEOUT_MS = 10_000;

/** Read a small connect payload without allowing a stalled client to hold the Worker open. */
export async function readConnectBody(req: Request): Promise<string> {
  let declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_CONNECT_BODY_BYTES) {
    throw new Error("Connection details are too large.");
  }
  if (!req.body) return "";
  let reader = req.body.getReader();
  let decoder = new TextDecoder();
  let text = "";
  let size = 0;
  let deadline = AbortSignal.timeout(CONNECT_BODY_TIMEOUT_MS);
  try {
    while (true) {
      let chunk = await readUntilAbort(reader, deadline);
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > MAX_CONNECT_BODY_BYTES) {
        throw new Error("Connection details are too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function readUntilAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new Error("Connection body read timed out."));
  return new Promise((resolve, reject) => {
    let abort = () => reject(new Error("Connection body read timed out."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * The one answer given to any request that does not present a live nonce.
 *
 * Deliberately identical for an unparseable id, an unknown account, and an expired nonce, so it
 * reveals nothing about which accounts exist. Rendered as a page for the browser that followed the
 * link and as JSON for the form's own `fetch`.
 */
function expiredLink(req: Request): Response {
  return req.method === "GET"
    ? htmlResponse(expiredLinkHtml(EXPIRED_LINK_MESSAGE), 400)
    : jsonResponse({ error: EXPIRED_LINK_MESSAGE }, 400);
}

// ---------------------------------------------------------------------------
// HTTP surface: the connect form.
//
// GET  /<userObjectId>/<nonce>  -> the credential form
// POST /<userObjectId>/<nonce>  -> verify the credentials, then finish the connection

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return new Response("Not Found", { status: 404 });
    }
    let relPath = url.pathname.slice(basePath.length);

    let segments = relPath.slice(1).split("/");
    let isConnectUrl =
      segments.length === 2 &&
      segments[0].length === DO_ID_LENGTH &&
      segments[1].length === NONCE_BYTES * 2;
    if (!isConnectUrl) return new Response("Not Found", { status: 404 });

    if (req.method !== "GET" && req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // The path only proves segments[0] is 64 hex-ish characters; idFromString rejects anything
    // that isn't a real id for this namespace, and must not surface as a 500.
    let stub: DurableObjectStub<UserAccount>;
    try {
      stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(segments[0]));
    } catch (error) {
      logger.debug("invalid account id rejected", {
        event: "invalid_connect_account_id",
        error: error instanceof Error ? error.name : typeof error,
      });
      return expiredLink(req);
    }

    // The nonce is a bearer token, not proof of identity: holding this URL within its short window
    // is the whole authority to bind credentials to this account. It is therefore checked before
    // anything else happens — in particular before any credential reaches Marketo, so the route
    // cannot be used as an oracle for testing stolen Client IDs and Secrets. Checking it without
    // consuming it lets a mistyped secret be corrected on the same page; it is spent only once a
    // connection actually succeeds.
    if (!(await stub.verifyNonceWithoutConsuming(segments[1]))) {
      return expiredLink(req);
    }
    let existingCredentials = await stub.getCredentials();

    if (req.method === "GET") {
      return htmlResponse(connectPageHtml({ defaults: getDefaults(env, existingCredentials) }));
    }

    let mutationRejection = checkMutation(req);
    if (mutationRejection) return mutationRejection;

    let creds: MarketoCredentials;
    try {
      let text = await readConnectBody(req);
      let body: unknown = JSON.parse(text);
      creds = parseCredentials(body, env, existingCredentials);
    } catch {
      return jsonResponse({ error: "Invalid connection details." }, 400);
    }

    // Prove the credentials work before storing them, so a typo surfaces here rather than as a
    // broken account the user has to debug from inside a gadget.
    let scope: string | undefined;
    try {
      scope = (await fetchAccessToken(creds)).scope;
    } catch (e) {
      return jsonResponse({ error: describeCredentialFailure(e) }, 400);
    }

    let result = await stub.completeConnection(segments[1], creds);
    if (result.kind === "invalid_nonce") return jsonResponse({ error: EXPIRED_LINK_MESSAGE }, 400);
    if (result.kind === "error") return jsonResponse({ error: result.message }, 500);
    return jsonResponse({ ok: true, scope });
  },
};

/**
 * Turn a failed token fetch into something the person filling in the form can act on.
 *
 * A `status` means Marketo answered and refused, which is a credentials problem. Provider and
 * transport messages are deliberately omitted because they can echo submitted credentials.
 */
function describeCredentialFailure(e: unknown): string {
  if (e instanceof MarketoError && e.status !== undefined) {
    return (
      "Marketo rejected these credentials. Check the Client ID and Client Secret, " +
      "and that they belong to the instance endpoint above."
    );
  }
  return "Could not reach the Marketo Identity endpoint. Check the instance endpoint and retry.";
}

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Marketo",
      url: MARKETO_HOME_URL,
      logo: MARKETO_ICON,
      color: "#f2f0f7",
      tagline: "Read and update people, lists, programs, and campaigns",
      description:
        "Connect your Marketo instance so Gadgets can look up people, read their activity " +
        "history, manage static lists and program membership, and run smart campaigns. You supply " +
        "the credentials of a LaunchPoint custom service you control, and all writes are " +
        "approval-gated.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount
//
// Owns the account's Marketo credentials. Everything downstream — the token cache, the resource
// URLs, the REST client — is derived from what is stored here, so disconnecting really does end
// the account's access.

type StoredNonce = { value: string; expiresAt: number };

type CompleteConnectionResult =
  | { kind: "ok" }
  | { kind: "invalid_nonce" }
  | { kind: "error"; message: string };

export class UserAccount extends DurableObject<Env> {
  #credentialGeneration = 0;

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<MarketoCredentials>("credentials")) {
      await this.ctx.storage.setAlarm(Date.now() + ABANDONED_CONNECT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  /** Whether `nonce` is the live one for this account, in constant time. */
  #nonceIsValid(nonce: string): boolean {
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored) return false;
    return Date.now() < stored.expiresAt && constantTimeEqual(stored.value, nonce);
  }

  /**
   * Check a nonce while leaving it usable, so the connect page can refuse a dead link up front and
   * still let a user who mistyped their secret submit the form again.
   */
  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    return this.#nonceIsValid(nonce);
  }

  async completeConnection(
    nonce: string,
    credentials: MarketoCredentials,
  ): Promise<CompleteConnectionResult> {
    // Re-checked here rather than trusted from the fetch handler: this is the call that stores the
    // credentials, so it is the one that must be safe on its own.
    if (!this.#nonceIsValid(nonce)) return { kind: "invalid_nonce" };
    let generation = this.#credentialGeneration;
    let storedNonce = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (generation !== this.#credentialGeneration) {
      return { kind: "error", message: "Connection state changed. Please retry." };
    }
    this.ctx.storage.kv.delete("nonce");

    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      if (generation === this.#credentialGeneration && storedNonce && storedNonce.expiresAt > Date.now()) {
        this.ctx.storage.kv.put("nonce", storedNonce);
      }
      return { kind: "error", message: "Connection callback expired. Please retry." };
    }

    if (generation !== this.#credentialGeneration) {
      return { kind: "error", message: "Connection state changed. Please retry." };
    }
    let reconnecting = Boolean(this.ctx.storage.kv.get<boolean>("reconnecting"));
    let previousCredentials = this.ctx.storage.kv.get<MarketoCredentials>("credentials");
    if (generation !== this.#credentialGeneration) {
      return { kind: "error", message: "Connection state changed. Please retry." };
    }
    this.ctx.storage.kv.put<MarketoCredentials>("credentials", credentials);

    try {
      if (reconnecting) {
        await callback.credentialsRestored();
        if (generation !== this.#credentialGeneration) {
          return { kind: "error", message: "Connection state changed. Please retry." };
        }
        this.ctx.storage.kv.delete("reconnecting");
      } else {
        let props: MarketoUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.MarketoUserImpl({ props }));
      }
    } catch {
      // A revoke or newer reconnect owns the credential state now. Never roll an older failed
      // callback over that lifecycle change.
      if (generation === this.#credentialGeneration) {
        if (previousCredentials) {
          this.ctx.storage.kv.put("credentials", previousCredentials);
        } else {
          // Initial connection failed before the Workshop received the account capability.
          this.ctx.storage.kv.delete("credentials");
        }
        if (storedNonce && storedNonce.expiresAt > Date.now()) {
          this.ctx.storage.kv.put("nonce", storedNonce);
        }
      }
      return {
        kind: "error",
        message: "Failed to notify the Workshop. Please retry.",
      };
    }

    if (generation !== this.#credentialGeneration) {
      return { kind: "error", message: "Connection state changed. Please retry." };
    }
    await this.ctx.storage.deleteAlarm();
    return { kind: "ok" };
  }

  async prepareReconnect(nonce: string): Promise<void> {
    this.#credentialGeneration++;
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  /** This account's Marketo credentials, or undefined if it was never completed or was revoked. */
  getCredentials(): MarketoCredentials | undefined {
    return this.ctx.storage.kv.get<MarketoCredentials>("credentials");
  }

  async credentialsExpired(): Promise<void> {
    await this.ctx.storage.kv
      .get<Fetcher<GatekeeperConnectCallback>>("callback")
      ?.credentialsExpired();
  }

  async revoke(): Promise<void> {
    this.#credentialGeneration++;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<MarketoCredentials>("credentials")) {
      await this.ctx.storage.deleteAll();
    }
  }
}

function userAccountStub(
  exports: Cloudflare.Exports,
  userObjectId: string,
): DurableObjectStub<UserAccount> {
  return exports.UserAccount.get(exports.UserAccount.idFromString(userObjectId));
}

async function requireAccountCredentials(
  exports: Cloudflare.Exports,
  userObjectId: string,
): Promise<MarketoCredentials> {
  let credentials = await userAccountStub(exports, userObjectId).getCredentials();
  if (!credentials) throw new Error("This Marketo account is no longer connected.");
  return credentials;
}

// ---------------------------------------------------------------------------
// Verifier

type MarketoUserVerifierProps = { userObjectId: string };

interface MarketoUserVerifierApi extends GatekeeperUserVerifier {
  hasLiveCredential(endpoint: string, clientId: string, fingerprint: string): Promise<
    { valid: boolean } | { error: TokenCacheError }
  >;
}

async function credentialFingerprint(credentials: MarketoCredentials): Promise<string> {
  let bytes = new TextEncoder().encode(
    `${credentials.endpoint}\u0000${credentials.clientId}\u0000${credentials.clientSecret}`,
  );
  let digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

@validateRpc()
export class MarketoUserVerifier
  extends WorkerEntrypoint<Env, MarketoUserVerifierProps>
  implements MarketoUserVerifierApi
{
  async hasLiveCredential(
    endpoint: string,
    clientId: string,
    fingerprint: string,
  ): Promise<{ valid: boolean } | { error: TokenCacheError }> {
    let account = userAccountStub(this.ctx.exports, this.ctx.props.userObjectId);
    let credentials = await account.getCredentials();
    if (
      !credentials || credentials.endpoint !== endpoint || credentials.clientId !== clientId ||
      await credentialFingerprint(credentials) !== fingerprint
    ) return { valid: false };

    let result = await (await tokenCacheStub(this.ctx.exports, credentials))
      .verifyCredentials(credentials);
    if (!result.ok) return { error: result.error };
    let valid = result.value;
    if (!valid) await account.credentialsExpired();
    return { valid };
  }
}

// ---------------------------------------------------------------------------
// User

type MarketoUserImplProps = { userObjectId: string };

@validateRpc()
export class MarketoUserImpl
  extends WorkerEntrypoint<Env, MarketoUserImplProps>
  implements GatekeeperUser
{
  #account() {
    return userAccountStub(this.ctx.exports, this.ctx.props.userObjectId);
  }

  /** The account's credentials, or a clear error if it has been disconnected. */
  async #credentials(): Promise<MarketoCredentials> {
    let creds = await this.#account().getCredentials();
    if (!creds) {
      throw new Error("This Marketo account is no longer connected. Reconnect to continue.");
    }
    return creds;
  }

  async describe(): Promise<AccountDescription> {
    let creds = await this.#account().getCredentials();
    if (!creds) return { displayName: "Marketo", uniqueName: "disconnected", avatar: MARKETO_ICON };

    let host = new URL(creds.endpoint).host;
    // Label the connection with the API-only user owning the custom service, since that is the
    // identity Marketo will attribute every action to.
    let scope: string | undefined;
    try {
      scope = unwrapTokenCacheResult(
        await (await tokenCacheStub(this.ctx.exports, creds)).getScope(creds),
      );
    } catch (error) {
      // Credentials may have been revoked in Marketo; fall back to a generic label.
      if (error instanceof MarketoError && error.isAuthError) {
        await this.#account().credentialsExpired();
      } else {
        logger.warn("scope lookup failed", {
          event: "marketo_scope_lookup_failed",
          error: error instanceof Error ? error.name : typeof error,
          ...(error instanceof MarketoError && error.status !== undefined
            ? { status: error.status }
            : {}),
        });
      }
    }
    return {
      displayName: scope ? `Marketo (${scope})` : "Marketo",
      uniqueName: scope ? `${scope} @ ${host}` : host,
      avatar: MARKETO_ICON,
    };
  }

  /** Marketo cannot authenticate a user, so this vendor never provides sign-in. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let creds = await this.#credentials();
    let origin = new URL(creds.endpoint).origin;
    let exports = this.ctx.exports;
    let userObjectId = this.ctx.props.userObjectId;

    switch (resourceUrlPattern) {
      case INSTANCE_RESOURCE.urlPattern:
        return {
          iframeHtml: INSTANCE_CONFIGURATOR_HTML,
          ui: new RpcStub(new InstanceConfiguratorUI(origin)),
        };
      case DESIGN_STUDIO_RESOURCE.urlPattern:
        return {
          iframeHtml: DESIGN_STUDIO_CONFIGURATOR_HTML,
          ui: new RpcStub(new DesignStudioConfiguratorUI(origin)),
        };
      case PROGRAM_RESOURCE.urlPattern:
        return {
          iframeHtml: PROGRAM_CONFIGURATOR_HTML,
          ui: new RpcStub(new ProgramConfiguratorUI(origin, exports, userObjectId)),
        };
      case STATIC_LIST_RESOURCE.urlPattern:
        return {
          iframeHtml: LIST_CONFIGURATOR_HTML,
          ui: new RpcStub(new ListConfiguratorUI(origin, exports, userObjectId)),
        };
      default:
        throw new Error(`Unsupported Marketo resource configurator: ${resourceUrlPattern}`);
    }
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let creds = await this.#credentials();
    let origin = new URL(creds.endpoint).origin;
    let { kind, id } = parseResourceUrl(origin, url);
    let userObjectId = this.ctx.props.userObjectId;
    let make = (props: MarketoGatekeeperImplProps) =>
      this.ctx.exports.MarketoGatekeeperImpl({ props });

    switch (kind) {
      case "instance":
        return {
          class: make({ userObjectId, kind: "instance" }),
          resource: INSTANCE_RESOURCE,
        };
      case "design-studio":
        return {
          class: make({ userObjectId, kind: "design-studio" }),
          resource: DESIGN_STUDIO_RESOURCE,
        };
      case "program":
        return {
          class: make({ userObjectId, kind: "program", resourceId: id }),
          resource: PROGRAM_RESOURCE,
        };
      case "list":
        return {
          class: make({ userObjectId, kind: "list", resourceId: id }),
          resource: STATIC_LIST_RESOURCE,
        };
    }
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    let props: MarketoUserVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.MarketoUserVerifier({ props });
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    let nonce = generateNonce();
    await this.#account().prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  /** All granularities are served by the account's one credential, so nothing extra is needed. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Configurators
//
// These run in a sandboxed iframe and are treated as untrusted, so each exposes only the narrow
// read-only listing it needs to let the user pick a resource.

@validateRpc()
class InstanceConfiguratorUI extends RpcTarget {
  #origin: string;
  constructor(origin: string) {
    super();
    this.#origin = origin;
  }

  async resourceUrl(): Promise<string> {
    return buildInstanceUrl(this.#origin);
  }

}

@validateRpc()
class DesignStudioConfiguratorUI extends RpcTarget {
  #origin: string;
  constructor(origin: string) {
    super();
    this.#origin = origin;
  }

  async resourceUrl(): Promise<string> {
    return buildDesignStudioUrl(this.#origin);
  }
}

@validateRpc()
class ProgramConfiguratorUI extends RpcTarget {
  #origin: string;
  #exports: Cloudflare.Exports;
  #userObjectId: string;
  constructor(origin: string, exports: Cloudflare.Exports, userObjectId: string) {
    super();
    this.#origin = origin;
    this.#exports = exports;
    this.#userObjectId = userObjectId;
  }

  async listPrograms(query: string): Promise<MarketoConfiguratorOption[]> {
    let creds = await requireAccountCredentials(this.#exports, this.#userObjectId);
    let account = userAccountStub(this.#exports, this.#userObjectId);
    return await resolveProgramOptions(
      await makeClient(this.#exports, creds, () => account.credentialsExpired()),
      query,
    );
  }

  async resourceUrl(programId: string | null | undefined): Promise<string> {
    if (!programId) throw new Error("No program selected.");
    return buildProgramUrl(this.#origin, programId);
  }
}

@validateRpc()
class ListConfiguratorUI extends RpcTarget {
  #origin: string;
  #exports: Cloudflare.Exports;
  #userObjectId: string;
  constructor(origin: string, exports: Cloudflare.Exports, userObjectId: string) {
    super();
    this.#origin = origin;
    this.#exports = exports;
    this.#userObjectId = userObjectId;
  }

  async listStaticLists(query: string): Promise<MarketoConfiguratorOption[]> {
    let creds = await requireAccountCredentials(this.#exports, this.#userObjectId);
    let account = userAccountStub(this.#exports, this.#userObjectId);
    let client = await makeClient(this.#exports, creds, () => account.credentialsExpired());
    let search = query.trim();
    let lists: RawList[];
    if (!search) {
      lists = (await client.getLists()).result;
    } else if (/^\d+$/.test(search)) {
      let list = await client.getList(Number(search));
      lists = list ? [list] : [];
    } else {
      let [exact, partial] = await Promise.all([
        client.getLists({ name: search }),
        client.getLists({ nameContains: search }),
      ]);
      lists = [...exact.result, ...partial.result];
    }
    return [...new Map(
      lists
        .filter((list): list is RawList & { id: number } => typeof list.id === "number")
        .map(list => [list.id, list]),
    ).values()]
      .slice(0, CONFIGURATOR_LIMIT)
      .map(l => ({
        value: String(l.id),
        title: l.name ?? String(l.id),
        subtitle: l.programName,
        meta: l.workspaceName,
      }));
  }

  async resourceUrl(listId: string | null | undefined): Promise<string> {
    if (!listId) throw new Error("No list selected.");
    return buildListUrl(this.#origin, listId);
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper (per-binding)

type MarketoGatekeeperImplProps = {
  userObjectId: string;
  kind: MarketoResourceKind;
  resourceId?: number;
};

type PendingRow = { action: MarketoAction };
type ApplyingState = "preparing" | "dispatching" | "uncertain" | "partial" | "nothing-changed" | "applied";
const MAX_PENDING_ACTIONS = 200;
type LogicalKind = DesignStudioAssetKind | "campaign" | "program" | EmailDesignerKind;
type LogicalReference = { id: string; kind: LogicalKind };

function designerAssetKind(kind: EmailDesignerKind): DesignerAssetKind {
  return kind === "designerEmail" ? "email" : kind === "designerTemplate" ? "emailtemplate" : "fragment";
}

@validateRpc()
export class MarketoGatekeeperImpl
  extends DurableObject<Env, MarketoGatekeeperImplProps>
  implements Gatekeeper<
    MarketoSessionImpl | MarketoDesignStudioImpl | MarketoProgramImpl | MarketoStaticListImpl
  >
{
  #preparingActions = new Set<number>();

  /**
   * The account's credentials. Read on every operation rather than cached in props, so
   * disconnecting the account immediately stops existing bindings from working.
   */
  async #credentials(): Promise<MarketoCredentials> {
    let creds = await userAccountStub(
      this.ctx.exports,
      this.ctx.props.userObjectId,
    ).getCredentials();
    if (!creds) {
      throw new Error("The Marketo account behind this binding has been disconnected.");
    }
    return creds;
  }

  async #client(credentials?: MarketoCredentials): Promise<MarketoClient> {
    let account = userAccountStub(this.ctx.exports, this.ctx.props.userObjectId);
    return await makeClient(
      this.ctx.exports,
      credentials ?? await this.#credentials(),
      () => account.credentialsExpired(),
    );
  }

  async describe(): Promise<ResourceDescription> {
    let { kind, resourceId } = this.ctx.props;
    let credentials = await this.#credentials();
    let origin = new URL(credentials.endpoint).origin;
    let client = await this.#client(credentials);

    switch (kind) {
      case "instance": {
        let host = new URL(origin).host;
        return {
          url: buildInstanceUrl(origin),
          title: "Marketo",
          snippet: `Full access to people, programs, campaigns, business objects, and Design Studio at ${host}.`,
          suggestedBindingName: "MARKETO",
          tsType: "MarketoSession",
        };
      }
      case "design-studio": {
        let host = new URL(origin).host;
        return {
          url: buildDesignStudioUrl(origin),
          title: "Marketo Design Studio",
          snippet: `Design Studio assets in the Marketo instance at ${host}.`,
          suggestedBindingName: "MARKETO_DESIGN_STUDIO",
          tsType: "MarketoDesignStudio",
        };
      }
      case "program": {
        let id = requireResourceId("program", resourceId);
        let program = await client.getProgram(id).catch(() => undefined);
        let name = program?.name ?? `Program ${id}`;
        return {
          url: buildProgramUrl(origin, id),
          title: `Program: ${name}`,
          snippet: `Marketo program "${name}" — members, tokens, statuses, metadata, tags, dates, approval, and deletion.`,
          suggestedBindingName: "MARKETO_PROGRAM",
          tsType: "MarketoProgram",
        };
      }
      case "list": {
        let id = requireResourceId("list", resourceId);
        let list = await client.getList(id).catch(() => undefined);
        let name = list?.name ?? `List ${id}`;
        return {
          url: buildListUrl(origin, id),
          title: `List: ${name}`,
          snippet: `Marketo static list "${name}" — read, add, and remove members.`,
          suggestedBindingName: "MARKETO_LIST",
          tsType: "MarketoStaticList",
        };
      }
    }
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Nothing is auto-approvable: every write here touches marketing data or sends messages. */
  async getAutoApprovableActions() {
    return [];
  }

  async startSession(
    approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<
    MarketoSessionImpl | MarketoDesignStudioImpl | MarketoProgramImpl | MarketoStaticListImpl
  > {
    // Stubs passed as RPC arguments are disposed when the call returns, so keep our own handle.
    let queue = approvalQueue.dup();
    let sessionCtx = makeSessionContext({
      client: () => this.#client(),
      approvalQueue: queue,
      submit: async (body: MarketoActionInput) => {
        if ((body.type === "businessObjectUpsert" || body.type === "businessObjectDelete") &&
            this.#businessObjectAccess(body.kind) !== "read-write") {
          throw new Error("This Marketo business object is read-only or unavailable; no approval was submitted.");
        }
        let index = this.#pendingIndexIncludingBlocked();
        if (index.length >= MAX_PENDING_ACTIONS) {
          throw new Error(`A Marketo binding cannot have more than ${MAX_PENDING_ACTIONS} pending actions.`);
        }
        let id = this.#nextActionId();
        let action = { ...body, id } as MarketoAction;
        this.#validateActionReferences(action, false);
        let description = describeActionForSubmission(action);
        this.ctx.storage.kv.put<PendingRow>(`pending:${id}`, { action });
        this.ctx.storage.kv.put("pending:index", [...index, id]);
        try {
          await queue.submitAction(id, description).catch(error => { throw error; });
        } catch (e) {
          this.#removePending(id);
          throw e;
        }
      },
    });
    let ctx: CampaignContext & EmailDesignerContext & BusinessObjectContext = {
      ...sessionCtx,
      allocateProvisional: () => {
        let next = (this.ctx.storage.kv.get<number>("counter:nextProvisionalId") ?? 0) + 1;
        this.ctx.storage.kv.put("counter:nextProvisionalId", next);
        return `~${next}`;
      },
      pending: () => this.#pendingIndex()
        .map(id => this.ctx.storage.kv.get<PendingRow>(`pending:${id}`)?.action)
        .filter((action): action is DesignStudioAction => Boolean(action && isDesignStudioAction(action))),
      resolveId: id => this.#resolveLogicalId(id),
      logicalKind: id => this.#logicalKind(id),
      submitDesign: async body => await sessionCtx.submit(body),
      pendingCampaign: () => this.#pendingIndex()
        .map(id => this.ctx.storage.kv.get<PendingRow>(`pending:${id}`)?.action)
        .filter((action): action is CampaignAction => Boolean(action && isCampaignAction(action))),
      submitCampaign: async body => await sessionCtx.submit(body),
      pendingProgram: () => this.#pendingIndex()
        .map(id => this.ctx.storage.kv.get<PendingRow>(`pending:${id}`)?.action)
        .filter((action): action is ProgramAction => Boolean(action && isProgramAction(action))),
      submitProgram: async body => await sessionCtx.submit(body),
      pendingDesigner: () => this.#pendingIndex()
        .map(id => this.ctx.storage.kv.get<PendingRow>(`pending:${id}`)?.action)
        .filter((action): action is EmailDesignerAction => Boolean(action && isEmailDesignerAction(action))),
      resolveDesignerId: id => this.#resolveDesignerId(id),
      submitDesigner: async body => await sessionCtx.submit(body),
      submitBusinessObject: async body => await sessionCtx.submit(body),
      getBusinessObjectAccess: kind => this.#businessObjectAccess(kind),
      setBusinessObjectAccess: (kind, access) => this.#setBusinessObjectAccess(kind, access),
    };

    let { kind, resourceId } = this.ctx.props;
    try {
      switch (kind) {
        case "instance":
          return new MarketoSessionImpl(ctx);
        case "design-studio":
          return new MarketoDesignStudioImpl(ctx, true);
        case "program":
          return new MarketoProgramImpl(ctx, requireResourceId("program", resourceId), true);
        case "list":
          return new MarketoStaticListImpl(ctx, requireResourceId("list", resourceId), true);
      }
    } catch (error) {
      sessionCtx.dispose();
      throw error;
    }
  }

  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let credentials = await this.#credentials();
    let verifier = user as unknown as Fetcher<MarketoUserVerifierApi>;
    let verification = await verifier.hasLiveCredential(
      credentials.endpoint,
      credentials.clientId,
      await credentialFingerprint(credentials),
    );
    if ("error" in verification) {
      throw unwrapTokenCacheResult<never>({ ok: false, error: verification.error });
    }
    if (!verification.valid) {
      throw new Error(
        "This collaborator is not connected with the same Marketo LaunchPoint service.",
      );
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  async applyAction(actionId: number): Promise<void> {
    let state = this.ctx.storage.kv.get<ApplyingState>(`applying:${actionId}`);
    if (state === "preparing") {
      // Older workers persisted this retryable pre-dispatch state. No request was marked as
      // dispatched, so recover it rather than permanently stranding the approval.
      this.ctx.storage.kv.delete(`applying:${actionId}`);
      state = undefined;
    }
    if (state === "applied") return;
    if (this.#preparingActions.has(actionId)) {
      throw new Error("This Marketo action is already being prepared for dispatch.");
    }
    if (state === "nothing-changed") {
      throw new Error("Marketo's native CRM sync made this action read-only; nothing was changed.");
    }
    if (state) {
      throw new Error(
        "This Marketo action was already dispatched and cannot be repeated. Inspect Marketo to " +
          "confirm its outcome.",
      );
    }
    if (!this.ctx.storage.kv.get<PendingRow>(`pending:${actionId}`)) {
      throw new Error(`No queued Marketo action with id ${actionId}.`);
    }
    if (this.ctx.storage.kv.get(`dependencyBlocked:${actionId}`)) {
      throw new Error("This Marketo action depends on an earlier rejected action and cannot be dispatched; reject it to resolve the approval.");
    }

    let queued = this.ctx.storage.kv.get<PendingRow>(`pending:${actionId}`)?.action;
    if (queued && isBusinessObjectAction(queued) && this.#businessObjectAccess(queued.kind) !== "read-write") {
      this.#removePending(actionId);
      this.ctx.storage.kv.put(`applying:${actionId}`, "nothing-changed");
      throw new Error("This Marketo business object became read-only before dispatch; nothing was changed.");
    }

    let pending = this.ctx.storage.kv.get<PendingRow>(`pending:${actionId}`);
    if (!pending) throw new Error(`No queued Marketo action with id ${actionId}.`);
    if (this.ctx.storage.kv.get(`applying:${actionId}`)) {
      throw new Error("This Marketo action was already dispatched and cannot be repeated.");
    }
    this.#validateActionReferences(pending.action, true);
    this.#validateMutationOrder(pending.action);
    validateActionForDispatch(pending.action);
    // Resolve authentication only after every local dispatch check. Token failures cannot have
    // applied the action and remain safe to retry.
    this.#preparingActions.add(actionId);
    let client: MarketoClient;
    let landingPageTemplateId: number | undefined;
    try {
      client = await this.#client();
      landingPageTemplateId = await this.#preflightClassicAsset(pending.action, client);
      await this.#preflightDesignerReferences(pending.action, client);
      await client.prepare();
      if (!this.ctx.storage.kv.get<PendingRow>(`pending:${actionId}`)) {
        throw new Error("This Marketo action was rejected while dispatch was being prepared.");
      }
      validateActionForDispatch(pending.action);
    } catch (error) {
      this.#preparingActions.delete(actionId);
      throw error;
    }
    // Mark before the side-effecting request. A timeout can happen after Marketo accepted it, so
    // an automatic retry could duplicate writes or campaign sends.
    this.ctx.storage.kv.put(`applying:${actionId}`, "dispatching");
    this.#preparingActions.delete(actionId);

    let results;
    try {
      if (isDesignStudioAction(pending.action)) {
        let asset = pending.action.type === "designDeleteFolder" ? "folder" : pending.action.asset;
        await executeDesignStudioAction(
          pending.action,
          client,
          id => this.#requireLogicalId(id),
          (provisionalId, realId) => {
            this.ctx.storage.kv.put(`provisional:${provisionalId}`, realId);
            this.ctx.storage.kv.put(
              `provisionalKind:${provisionalId}`,
              asset,
            );
          },
          realId => this.ctx.storage.kv.put(`creationCandidate:${actionId}`, realId),
          landingPageTemplateId,
        );
        results = undefined;
      } else if (isCampaignAction(pending.action)) {
        await executeCampaignAction(
          pending.action,
          client,
          id => this.#requireLogicalId(id),
          (provisionalId, realId) => {
            this.ctx.storage.kv.put(`provisional:${provisionalId}`, realId);
            this.ctx.storage.kv.put(`provisionalKind:${provisionalId}`, "campaign");
          },
          realId => this.ctx.storage.kv.put(`creationCandidate:${actionId}`, realId),
        );
        results = undefined;
      } else if (isProgramAction(pending.action)) {
        await executeProgramAction(
          pending.action,
          client,
          id => this.#requireLogicalId(id),
          (provisionalId, realId) => {
            this.ctx.storage.kv.put(`provisional:${provisionalId}`, realId);
            this.ctx.storage.kv.put(`provisionalKind:${provisionalId}`, "program");
          },
          realId => this.ctx.storage.kv.put(`creationCandidate:${actionId}`, realId),
        );
        results = undefined;
      } else if (isEmailDesignerAction(pending.action)) {
        await executeEmailDesignerAction(
          pending.action,
          client,
          id => this.#requireDesignerId(id),
          id => this.#requireLogicalId(id),
          (provisionalId, realId, kind) => {
            this.ctx.storage.kv.put(`designerProvisional:${provisionalId}`, realId);
            this.ctx.storage.kv.put(`provisionalKind:${provisionalId}`, kind);
          },
          realId => this.ctx.storage.kv.put(`creationCandidate:${actionId}`, realId),
        );
        results = undefined;
      } else if (isBusinessObjectAction(pending.action)) {
        results = await executeBusinessObjectAction(pending.action, client);
      } else {
        results = await executeAction(pending.action, client);
      }
    } catch (e) {
      if (isBusinessObjectAction(pending.action) && pending.action.kind !== "namedAccount" &&
          e instanceof MarketoError && e.code === "1018") {
        this.#setBusinessObjectAccess(pending.action.kind, "read-only");
        this.#removePending(actionId);
        this.ctx.storage.kv.put(`applying:${actionId}`, "nothing-changed");
        throw new Error(
          "Marketo's native CRM sync rejected this write; nothing was changed and it cannot be retried.",
          { cause: e },
        );
      }
      // A parsed Marketo rejection is definitive. Transport and server failures are ambiguous:
      // Marketo may have accepted the write before the response was lost.
      let definitive =
        e instanceof DesignerPreDispatchError ||
        e instanceof MarketoError &&
        (e.operation === undefined ||
          (e.status === undefined || e.status < 400) &&
            (e.isProviderRejection || e.code !== undefined) ||
          (e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 408));
      if (isDesignStudioAction(pending.action) && (
        pending.action.type === "designCreate" && this.#resolveLogicalId(pending.action.provisionalId) !== undefined ||
        pending.action.type === "designMetadata" && pending.action.asset === "email" ||
        pending.action.type === "designContent" && pending.action.asset === "snippet" &&
          pending.action.html !== undefined && pending.action.text !== undefined
      )) definitive = false;
      if (isCampaignAction(pending.action) &&
          (pending.action.type === "campaignCreate" || pending.action.type === "campaignClone") &&
           this.#resolveLogicalId(pending.action.provisionalId) !== undefined) definitive = false;
      if (isProgramAction(pending.action) &&
          (pending.action.type === "programCreate" || pending.action.type === "programClone") &&
           this.#resolveLogicalId(pending.action.provisionalId) !== undefined) definitive = false;
      if (isEmailDesignerAction(pending.action) &&
          (pending.action.type === "designerCreate" || pending.action.type === "designerClone") &&
           this.#resolveDesignerId(pending.action.provisionalId) !== undefined) definitive = false;
      if (this.ctx.storage.kv.get(`creationCandidate:${actionId}`) !== undefined) definitive = false;
      if (definitive) {
        this.ctx.storage.kv.delete(`applying:${actionId}`);
      } else {
        this.ctx.storage.kv.put(`applying:${actionId}`, "uncertain");
      }
      throw e;
    }
    try {
      if (results) {
        assertActionResults(results, expectedActionResults(pending.action));
        assertActionResultIdentity(pending.action, results);
      }
      if (results && isBusinessObjectAction(pending.action) && pending.action.kind !== "namedAccount" &&
          results.some(result => result.status?.toLowerCase() === "skipped" && result.reasons?.some(reason => reason.code === "1018"))) {
        this.#setBusinessObjectAccess(pending.action.kind, "read-only");
        if (results.length === expectedActionResults(pending.action) && results.length > 0 &&
            results.every(result => result.status?.toLowerCase() === "skipped")) {
          this.#removePending(actionId);
          this.ctx.storage.kv.put(`applying:${actionId}`, "nothing-changed");
          throw new Error("Marketo's native CRM sync rejected this write; nothing was changed and it cannot be retried.");
        }
      }
      if (results) assertApplied(results, expectedActionResults(pending.action));
    } catch (e) {
      if (e instanceof MarketoActionResultError) {
        if (e.disposition === "uncertain") {
          this.ctx.storage.kv.put(`applying:${actionId}`, "uncertain");
        } else {
          this.ctx.storage.kv.delete(`applying:${actionId}`);
          if (e.disposition === "partial") {
            this.#removePending(actionId);
            this.ctx.storage.kv.put(`applying:${actionId}`, "partial");
          }
        }
      }
      throw e;
    }

    this.#removePending(actionId);
    this.ctx.storage.kv.put(`applying:${actionId}`, "applied");
  }

  async rejectAction(actionId: number): Promise<void | { restart: true }> {
    let applying = this.ctx.storage.kv.get<ApplyingState>(`applying:${actionId}`);
    if (applying === "preparing") {
      this.ctx.storage.kv.delete(`applying:${actionId}`);
      applying = undefined;
    }
    if (this.#preparingActions.has(actionId) || applying === "dispatching" || applying === "applied") {
      throw new Error("This Marketo action was already dispatched and can no longer be rejected.");
    }
    let pending = this.ctx.storage.kv.get<PendingRow>(`pending:${actionId}`)?.action;
    if (pending && (
      isDesignStudioAction(pending) && (
        pending.type === "designCreate" || pending.type === "designClone" || pending.type === "designContent"
      ) ||
      isCampaignAction(pending) ||
      isProgramAction(pending) ||
      isEmailDesignerAction(pending)
    )) {
      let identity = this.#actionIdentity(pending);
      let purge = identity ? [identity] : [];
      let crossFamilyPurge = "provisionalId" in pending && identity ? [identity] : [];
      let provisionalIds: { id: string; designer: boolean }[] = [];
      let blockedDependents = false;
      let recordProvisional = (action: MarketoAction) => {
        if ("provisionalId" in action) {
          provisionalIds.push({ id: action.provisionalId, designer: isEmailDesignerAction(action) });
        }
      };
      recordProvisional(pending);
      let changed = true;
      while (changed) {
        changed = false;
        for (let id of this.#pendingIndexIncludingBlocked()) {
          let row = this.ctx.storage.kv.get<PendingRow>(`pending:${id}`)?.action;
          if (!row || row.id <= pending.id ||
              !isDesignStudioAction(row) && !isCampaignAction(row) && !isProgramAction(row) && !isEmailDesignerAction(row)) continue;
          let sameFamily = this.#sameActionFamily(pending, row);
          let depends = this.#actionReferences(row).some(reference =>
            purge.some(rejected => this.#sameReference(reference, rejected) && (
              sameFamily || crossFamilyPurge.some(crossFamily => this.#sameReference(crossFamily, rejected))
            )));
          if (depends) {
            let created = this.#actionIdentity(row);
            if (created && "provisionalId" in row &&
                !purge.some(reference => this.#sameReference(reference, created))) {
              purge.push(created);
              crossFamilyPurge.push(created);
              changed = true;
            }
            recordProvisional(row);
            this.ctx.storage.kv.put(`dependencyBlocked:${id}`, actionId);
            blockedDependents = true;
          }
        }
      }
      this.#removePending(actionId);
      for (let provisional of provisionalIds) {
        this.ctx.storage.kv.delete(`${provisional.designer ? "designerProvisional" : "provisional"}:${provisional.id}`);
        this.ctx.storage.kv.delete(`provisionalKind:${provisional.id}`);
      }
      if (applying === undefined) this.ctx.storage.kv.delete(`applying:${actionId}`);
      if (blockedDependents || "provisionalId" in pending || !isDesignStudioAction(pending)) return { restart: true };
      return;
    }
    this.#removePending(actionId);
    if (applying === undefined) this.ctx.storage.kv.delete(`applying:${actionId}`);
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: false }> {
    return { message: "Marketo actions are not automatically reversible.", canRetry: false };
  }

  #nextActionId(): number {
    let next = (this.ctx.storage.kv.get<number>("counter:nextActionId") ?? 0) + 1;
    this.ctx.storage.kv.put("counter:nextActionId", next);
    return next;
  }

  #businessObjectAccess(kind: MarketoBusinessObjectKind): MarketoBusinessObjectAccess {
    if (kind === "opportunityRole" && this.ctx.storage.kv.get("businessObjects:opportunityRoleUnavailable")) {
      return "unavailable";
    }
    if (kind !== "namedAccount" && this.ctx.storage.kv.get("businessObjects:nativeCrmReadOnly")) {
      return "read-only";
    }
    return "read-write";
  }

  #setBusinessObjectAccess(kind: MarketoBusinessObjectKind, access: MarketoBusinessObjectAccess): void {
    if (access === "unavailable" && kind === "opportunityRole") {
      this.ctx.storage.kv.put("businessObjects:opportunityRoleUnavailable", true);
    } else if (access === "read-only" && kind !== "namedAccount") {
      this.ctx.storage.kv.put("businessObjects:nativeCrmReadOnly", true);
    }
  }

  #pendingIndex(): number[] {
    return this.#pendingIndexIncludingBlocked().filter(id => !this.ctx.storage.kv.get(`dependencyBlocked:${id}`));
  }

  #pendingIndexIncludingBlocked(): number[] {
    return this.ctx.storage.kv.get<number[]>("pending:index") ?? [];
  }

  #removePending(actionId: number): void {
    this.ctx.storage.kv.delete(`pending:${actionId}`);
    this.ctx.storage.kv.delete(`dependencyBlocked:${actionId}`);
    this.ctx.storage.kv.delete(`creationCandidate:${actionId}`);
    let index = this.#pendingIndexIncludingBlocked();
    if (index.includes(actionId)) this.ctx.storage.kv.put("pending:index", index.filter(id => id !== actionId));
  }

  #resolveLogicalId(id: string): number | undefined {
    if (/^[1-9]\d*$/.test(id)) {
      let parsed = Number(id);
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    return this.ctx.storage.kv.get<number>(`provisional:${id}`);
  }

  #logicalKind(id: string): LogicalKind | undefined {
    let stored = this.ctx.storage.kv.get<LogicalKind>(`provisionalKind:${id}`);
    if (stored) return stored;
    for (let actionId of this.#pendingIndex()) {
      let action = this.ctx.storage.kv.get<PendingRow>(`pending:${actionId}`)?.action;
      if (action && isDesignStudioAction(action) &&
          (action.type === "designCreate" || action.type === "designClone") &&
          action.provisionalId === id) {
        return action.asset;
      }
      if (action && isCampaignAction(action) &&
          (action.type === "campaignCreate" || action.type === "campaignClone") &&
          action.provisionalId === id) return "campaign";
      if (action && isProgramAction(action) &&
          (action.type === "programCreate" || action.type === "programClone") &&
           action.provisionalId === id) return "program";
      if (action && isEmailDesignerAction(action) &&
          (action.type === "designerCreate" || action.type === "designerClone") &&
          action.provisionalId === id) return action.asset;
    }
    return undefined;
  }

  #resolveDesignerId(id: string): string | undefined {
    return id.startsWith("~") ? this.ctx.storage.kv.get<string>(`designerProvisional:${id}`) : id;
  }

  #requireDesignerId(id: string): string {
    let resolved = this.#resolveDesignerId(id);
    if (resolved === undefined) throw new Error(`Marketo designer asset ${id} is still pending creation.`);
    return resolved;
  }

  #requireLogicalId(id: string): number {
    if (id.startsWith("~") && this.#pendingIndex().some(actionId => {
      let action = this.ctx.storage.kv.get<PendingRow>(`pending:${actionId}`)?.action;
      return action && (
        isDesignStudioAction(action) && (action.type === "designCreate" || action.type === "designClone") ||
        isCampaignAction(action) && (action.type === "campaignCreate" || action.type === "campaignClone") ||
        isProgramAction(action) && (action.type === "programCreate" || action.type === "programClone")
      ) &&
        action.provisionalId === id;
    })) {
      throw new Error(`Marketo asset ${id} is still pending creation.`);
    }
    let resolved = this.#resolveLogicalId(id);
    if (resolved === undefined) throw new Error(`Marketo asset ${id} is still pending creation.`);
    return resolved;
  }

  #validateActionReferences(action: MarketoAction, ready: boolean): void {
    if (isDesignStudioAction(action)) this.#validateDesignReferences(action, ready);
    if (isCampaignAction(action)) this.#validateCampaignReferences(action, ready);
    if (isProgramAction(action)) this.#validateProgramReferences(action, ready);
    if (isEmailDesignerAction(action)) this.#validateDesignerReferences(action, ready);
  }

  #validateLogicalReference(id: string, kind: LogicalKind, ready: boolean): void {
    if (id.startsWith("~") && this.#logicalKind(id) !== kind) {
      throw new Error(`Provisional Marketo asset ${id} is not a ${kind}.`);
    }
    if (ready) this.#requireLogicalId(id);
  }

  #validateDesignReferences(action: DesignStudioAction, ready: boolean): void {
    if ("targetId" in action) {
      this.#validateLogicalReference(action.targetId, action.type === "designDeleteFolder" ? "folder" : action.asset, ready);
    }
    if (action.type === "designClone") {
      this.#validateLogicalReference(action.sourceId, action.asset, ready);
      this.#validateLogicalReference(action.parent.id, action.parent.type === "Program" ? "program" : "folder", ready);
    }
    if (action.type === "designCreate") {
      this.#validateLogicalReference(action.parent.id, action.parent.type === "Program" ? "program" : "folder", ready);
      if (action.input.templateId) {
        let templateKind: LogicalKind = action.asset === "email" ? "emailTemplate" : "landingPageTemplate";
        this.#validateLogicalReference(action.input.templateId, templateKind, ready);
      }
    }
  }

  #validateCampaignReferences(action: CampaignAction, ready: boolean): void {
    if ("targetId" in action) this.#validateLogicalReference(action.targetId, "campaign", ready);
    if (action.type === "campaignClone") this.#validateLogicalReference(action.sourceId, "campaign", ready);
    if (action.type === "campaignCreate" || action.type === "campaignClone") {
      this.#validateLogicalReference(action.parent.id, action.parent.type === "Program" ? "program" : "folder", ready);
    }
  }

  #validateProgramReferences(action: ProgramAction, ready: boolean): void {
    if ("targetId" in action) this.#validateLogicalReference(action.targetId, "program", ready);
    if (action.type === "programClone") this.#validateLogicalReference(action.sourceId, "program", ready);
    if (action.type === "programCreate" || action.type === "programClone") {
      this.#validateLogicalReference(action.parentId, "folder", ready);
    }
  }

  #validateDesignerReferences(action: EmailDesignerAction, ready: boolean): void {
    if (action.type === "designerClone" && !this.#validDesignerCloneSnapshot(action.sourceSnapshot)) {
      throw new Error("A persisted Marketo designer clone is missing its complete source snapshot.");
    }
    let references: { id: string; kind: EmailDesignerKind }[] = [];
    if ("targetId" in action) references.push({ id: action.targetId, kind: action.asset });
    if (action.type === "designerClone") references.push({ id: action.sourceId, kind: action.asset });
    let templateId = action.type === "designerCreate" ? action.body.templateId
      : action.type === "designerUpdate" ? action.patch.templateId
        : action.type === "designerClone" ? this.#designerCloneSnapshotValue(action, "templateId") : undefined;
    if (typeof templateId === "string") references.push({ id: templateId, kind: "designerTemplate" });
    let body = action.type === "designerCreate" ? action.body
      : action.type === "designerUpdate" ? action.patch
        : action.type === "designerClone"
          ? { appData: this.#designerCloneSnapshotValue(action, "appData") }
          : undefined;
    let appData = body?.appData && typeof body.appData === "object" && !Array.isArray(body.appData)
      ? Object.fromEntries(Object.entries(body.appData))
      : undefined;
    if (typeof appData?.folderId === "string") this.#validateLogicalReference(appData.folderId, "folder", ready);
    if (typeof appData?.programId === "string") this.#validateLogicalReference(appData.programId, "program", ready);
    for (let reference of references) {
      if (reference.id.startsWith("~") && this.#logicalKind(reference.id) !== reference.kind) {
        throw new Error(`Provisional Marketo asset ${reference.id} is not a ${reference.kind}.`);
      }
      if (ready) this.#requireDesignerId(reference.id);
    }
  }

  async #preflightDesignerReferences(action: MarketoAction, client: MarketoClient): Promise<void> {
    if (!isEmailDesignerAction(action)) return;
    let reads = new Map<string, Promise<RawDesignerAsset | undefined>>();
    let requireDesigner = async (kind: EmailDesignerKind, id: string): Promise<RawDesignerAsset> => {
      let physical = this.#requireDesignerId(id);
      let key = `${kind}:${physical}`;
      let pending = reads.get(key) ?? client.getDesignerAsset(designerAssetKind(kind), physical);
      reads.set(key, pending);
      let asset = await pending;
      if (!asset || String(asset.id) !== physical) {
        throw new DesignerPreDispatchError(`Marketo designer ${kind} ${id} was not found; nothing was dispatched.`);
      }
      return asset;
    };

    if (action.type === "designerClone") {
      let source = await requireDesigner(action.asset, action.sourceId);
      let snapshot = resolveDesignerCloneSnapshot(
        action.sourceSnapshot,
        id => this.#requireDesignerId(id),
        id => this.#requireLogicalId(id),
      );
      let matches = action.sourceId.startsWith("~")
        ? matchesDesignerCloneConfiguration(source as Record<string, unknown>, snapshot)
        : matchesDesignerCloneSnapshot(source as Record<string, unknown>, snapshot);
      if (!matches) {
        throw new DesignerPreDispatchError("The Marketo designer clone source changed after approval; nothing was dispatched.");
      }
    }
    if (action.type === "designerLifecycle") {
      let current = await requireDesigner(action.asset, action.targetId);
      let state = current.associatedStates?.find(item => item.state?.toLowerCase() === action.sourceState);
      if (state?.contentId !== action.contentId) {
        throw new DesignerPreDispatchError(`Marketo designer ${action.sourceState} content changed after approval; nothing was dispatched.`);
      }
    }

    let templateId = action.type === "designerCreate" ? action.body.templateId
      : action.type === "designerUpdate" ? action.patch.templateId
        : action.type === "designerClone" ? this.#designerCloneSnapshotValue(action, "templateId") : undefined;
    if (typeof templateId === "string") await requireDesigner("designerTemplate", templateId);

    let body = action.type === "designerCreate" ? action.body
      : action.type === "designerUpdate" ? action.patch
        : action.type === "designerClone"
          ? { appData: this.#designerCloneSnapshotValue(action, "appData") }
          : undefined;
    let appData = body?.appData && typeof body.appData === "object" && !Array.isArray(body.appData)
      ? body.appData : undefined;
    let folderId = appData && Reflect.get(appData, "folderId");
    if (typeof folderId === "string") {
      let physical = this.#requireLogicalId(folderId);
      let folder = await client.getFolder(physical, "Folder");
      if (!folder || folder.id !== physical) {
        throw new DesignerPreDispatchError(`Marketo folder ${folderId} was not found; nothing was dispatched.`);
      }
    }
    let programId = appData && Reflect.get(appData, "programId");
    if (typeof programId === "string") {
      let physical = this.#requireLogicalId(programId);
      let program = await client.getProgram(physical);
      if (!program || program.id !== physical) {
        throw new DesignerPreDispatchError(`Marketo program ${programId} was not found; nothing was dispatched.`);
      }
    }
  }

  async #preflightClassicAsset(action: MarketoAction, client: MarketoClient): Promise<number | undefined> {
    if (isCampaignAction(action) && action.type === "campaignClone") {
      let id = this.#requireLogicalId(action.sourceId);
      let source = await client.getSmartCampaign(id);
      if (!source || source.id !== id) {
        throw new DesignerPreDispatchError(`Marketo smart campaign ${action.sourceId} was not found; nothing was dispatched.`);
      }
      return;
    }
    if (isProgramAction(action) && action.type === "programLifecycle" && action.operation === "approve") {
      let id = this.#requireLogicalId(action.targetId);
      let program = await client.getProgram(id);
      if (!matchesProgramApprovalDates(action, program, id)) {
        throw new DesignerPreDispatchError(
          "The Marketo Email Program start or end date changed after approval; nothing was dispatched.",
        );
      }
      return;
    }
    if (isProgramAction(action) && action.type === "programClone") {
      let id = this.#requireLogicalId(action.sourceId);
      let source = await client.getProgram(id);
      if (!source || source.id !== id) {
        throw new DesignerPreDispatchError(`Marketo program ${action.sourceId} was not found; nothing was dispatched.`);
      }
      return;
    }
    if (!isDesignStudioAction(action) || action.type !== "designClone") return;

    let id = this.#requireLogicalId(action.sourceId);
    let source = action.asset === "email" ? await client.getEmail(id)
      : action.asset === "emailTemplate" ? await client.getEmailTemplate(id)
        : action.asset === "landingPage" ? await client.getLandingPage(id)
          : action.asset === "landingPageTemplate" ? await client.getLandingPageTemplate(id)
            : action.asset === "form" ? await client.getForm(id)
              : await client.getSnippet(id);
    if (!source || source.id !== id) {
      throw new DesignerPreDispatchError(`Marketo ${action.asset} ${action.sourceId} was not found; nothing was dispatched.`);
    }
    if (action.asset !== "landingPage") return;
    let template = Reflect.get(source, "template");
    if (!Number.isSafeInteger(template) || Number(template) <= 0) {
      throw new DesignerPreDispatchError(`Marketo landing page ${action.sourceId} has no valid source template; nothing was dispatched.`);
    }
    return Number(template);
  }

  #validDesignerCloneSnapshot(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return [
      "templateId", "appType", "appData", "data", "headers", "settings",
      "contentId", "associatedStates", "state", "status",
    ].every(field => {
      let item = Reflect.get(value, field);
      return item && typeof item === "object" && !Array.isArray(item) &&
        typeof Reflect.get(item, "present") === "boolean";
    });
  }

  #designerCloneSnapshotValue(
    action: Extract<EmailDesignerAction, { type: "designerClone" }>,
    field: string,
  ): unknown {
    let item = Reflect.get(action.sourceSnapshot, field);
    return item && typeof item === "object" && Reflect.get(item, "present")
      ? Reflect.get(item, "value") : undefined;
  }

  #validateMutationOrder(action: MarketoAction): void {
    let resources = this.#actionResources(action);
    for (let actionId of this.#pendingIndex()) {
      let pending = this.ctx.storage.kv.get<PendingRow>(`pending:${actionId}`)?.action;
      if (!pending || pending.id >= action.id) continue;
      let earlier = this.#actionResources(pending);
      if (resources.some(resource => earlier.some(candidate =>
        candidate.key === resource.key && (candidate.write || resource.write)))) {
        let conflict = resources.find(resource => earlier.some(candidate =>
          candidate.key === resource.key && (candidate.write || resource.write)))!;
        throw new Error(`Marketo ${conflict.key.replace(":", " ")} has an earlier pending mutation.`);
      }
    }
  }

  #actionResources(action: MarketoAction): { key: string; write: boolean }[] {
    let resources: { key: string; write: boolean }[] = [];
    let add = (key: string, write: boolean) => {
      let existing = resources.find(resource => resource.key === key);
      if (existing) existing.write ||= write;
      else resources.push({ key, write });
    };
    if (isDesignStudioAction(action) || isCampaignAction(action) || isProgramAction(action) || isEmailDesignerAction(action)) {
      let identity = this.#actionIdentity(action);
      if (identity) add(this.#referenceKey(identity), true);
      for (let reference of this.#actionReferences(action)) {
        add(this.#referenceKey(reference), identity !== undefined && this.#sameReference(reference, identity));
      }
      return resources;
    }
    if (action.type === "campaignTrigger" || action.type === "campaignSchedule") {
      add(`campaign:${action.campaignId}`, true);
      if (action.type === "campaignTrigger") {
        for (let personId of action.personIds) add(`person:${personId}`, false);
      }
    } else if (action.type === "programStatus") {
      add(`program:${action.programId}`, false);
      for (let personId of action.personIds) {
        add(`person:${personId}`, false);
        add(`programStatus:${action.programId}:${personId}`, true);
      }
    } else if (action.type === "listAdd" || action.type === "listRemove") {
      for (let personId of action.personIds) {
        add(`person:${personId}`, false);
        add(`list:${action.listId}:${personId}`, true);
      }
    } else if (isBusinessObjectAction(action)) {
      for (let key of this.#businessObjectKeys(action)) add(key, true);
    } else if (action.type === "updatePerson" || action.type === "deletePerson") {
      add(`person:${action.personId}`, true);
    } else if (action.type === "upsertPeople") {
      for (let record of action.records) {
        if (Number.isSafeInteger(record.id) && Number(record.id) > 0) add(`person:${record.id}`, true);
        let lookup = record[action.lookupField];
        if (this.#reliableIdentity(lookup)) {
          add(`personLookup:${action.lookupField}:${JSON.stringify(lookup)}`, true);
        }
      }
    } else if (action.type === "customObjectUpsert" || action.type === "customObjectDelete") {
      add(`customObject:${action.apiName}`, true);
    }
    return resources;
  }

  #referenceKey(reference: LogicalReference): string {
    let resolved = reference.kind.startsWith("designer")
      ? this.#resolveDesignerId(reference.id)
      : this.#resolveLogicalId(reference.id)?.toString();
    return `${reference.kind}:${resolved ?? reference.id}`;
  }

  #businessObjectKeys(action: BusinessObjectAction): string[] {
    let identities = [[BUSINESS_OBJECTS[action.kind].idField], BUSINESS_OBJECTS[action.kind].dedupeFields];
    return action.records.flatMap(record => identities.flatMap(fields => {
      let values = fields.map(field => record[field]);
      if (values.some(value => value === undefined || value === null || value === "")) return [];
      return [`businessObject:${action.kind}:${fields.join("+")}:${JSON.stringify(values)}`];
    }));
  }

  #reliableIdentity(value: unknown): value is string | number | boolean {
    return typeof value === "string" ? value.length > 0
      : typeof value === "number" ? Number.isFinite(value)
        : typeof value === "boolean";
  }

  #sameDesignerIdentity(first: string, second: string): boolean {
    if (first === second) return true;
    let firstId = this.#resolveDesignerId(first);
    return firstId !== undefined && firstId === this.#resolveDesignerId(second);
  }

  #sameLogicalIdentity(first: string, second: string): boolean {
    if (first === second) return true;
    let firstId = this.#resolveLogicalId(first);
    return firstId !== undefined && firstId === this.#resolveLogicalId(second);
  }

  #actionIdentity(action: DesignStudioAction | CampaignAction | ProgramAction | EmailDesignerAction): LogicalReference | undefined {
    if (action.type === "designCreate" || action.type === "designClone" ||
        action.type === "designerCreate" || action.type === "designerClone") {
      return { id: action.provisionalId, kind: action.asset };
    }
    if (action.type === "campaignCreate" || action.type === "campaignClone") {
      return { id: action.provisionalId, kind: "campaign" };
    }
    if (action.type === "programCreate" || action.type === "programClone") {
      return { id: action.provisionalId, kind: "program" };
    }
    if ("targetId" in action) {
      let kind: LogicalKind = isCampaignAction(action) ? "campaign"
        : isProgramAction(action) ? "program"
          : action.type === "designDeleteFolder" ? "folder" : action.asset;
      return { id: action.targetId, kind };
    }
    return undefined;
  }

  #actionReferences(action: DesignStudioAction | CampaignAction | ProgramAction | EmailDesignerAction): LogicalReference[] {
    let references: LogicalReference[] = [];
    let identity = this.#actionIdentity(action);
    if (identity) references.push(identity);
    if ("targetId" in action) {
      references.push({ id: action.targetId, kind: isCampaignAction(action) ? "campaign"
        : isProgramAction(action) ? "program"
          : action.type === "designDeleteFolder" ? "folder" : action.asset });
    }
    if (action.type === "designClone") references.push({ id: action.sourceId, kind: action.asset });
    if (action.type === "designCreate" || action.type === "designClone") {
      references.push({ id: action.parent.id, kind: action.parent.type === "Program" ? "program" : "folder" });
    }
    if (action.type === "designCreate" && action.input.templateId) {
      references.push({
        id: action.input.templateId,
        kind: action.asset === "email" ? "emailTemplate" : "landingPageTemplate",
      });
    }
    if (action.type === "campaignClone") references.push({ id: action.sourceId, kind: "campaign" });
    if (action.type === "campaignCreate" || action.type === "campaignClone") {
      references.push({ id: action.parent.id, kind: action.parent.type === "Program" ? "program" : "folder" });
    }
    if (action.type === "programClone") references.push({ id: action.sourceId, kind: "program" });
    if (action.type === "programCreate" || action.type === "programClone") {
      references.push({ id: action.parentId, kind: "folder" });
    }
    if (action.type === "designerClone") references.push({ id: action.sourceId, kind: action.asset });
    if (action.type === "designerClone") {
      let templateId = this.#designerCloneSnapshotValue(action, "templateId");
      if (typeof templateId === "string") references.push({ id: templateId, kind: "designerTemplate" });
      let appData = this.#designerCloneSnapshotValue(action, "appData");
      if (appData && typeof appData === "object" && !Array.isArray(appData)) {
        let folderId = Reflect.get(appData, "folderId");
        let programId = Reflect.get(appData, "programId");
        if (typeof folderId === "string") references.push({ id: folderId, kind: "folder" });
        if (typeof programId === "string") references.push({ id: programId, kind: "program" });
      }
    }
    if (action.type === "designerCreate" || action.type === "designerUpdate") {
      let body = action.type === "designerCreate" ? action.body : action.patch;
      if (typeof body.templateId === "string") references.push({ id: body.templateId, kind: "designerTemplate" });
      let appData = body.appData;
      if (appData && typeof appData === "object" && !Array.isArray(appData)) {
        let folderId = Reflect.get(appData, "folderId");
        let programId = Reflect.get(appData, "programId");
        if (typeof folderId === "string") references.push({ id: folderId, kind: "folder" });
        if (typeof programId === "string") references.push({ id: programId, kind: "program" });
      }
    }
    return references;
  }

  #sameReference(first: LogicalReference, second: LogicalReference): boolean {
    if (first.kind !== second.kind) return false;
    return first.kind.startsWith("designer")
      ? this.#sameDesignerIdentity(first.id, second.id)
      : this.#sameLogicalIdentity(first.id, second.id);
  }

  #sameActionFamily(
    first: DesignStudioAction | CampaignAction | ProgramAction | EmailDesignerAction,
    second: DesignStudioAction | CampaignAction | ProgramAction | EmailDesignerAction,
  ): boolean {
    return isDesignStudioAction(first) && isDesignStudioAction(second) ||
      isCampaignAction(first) && isCampaignAction(second) ||
      isProgramAction(first) && isProgramAction(second) ||
      isEmailDesignerAction(first) && isEmailDesignerAction(second);
  }
}

function requireResourceId(kind: "program" | "list", id: number | undefined): number {
  if (id === undefined) throw new Error(`Marketo ${kind} binding is missing its resource id.`);
  return id;
}
