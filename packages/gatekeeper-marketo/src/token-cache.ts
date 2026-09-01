// Per-credential bearer-token cache.
//
// Marketo issues one token per LaunchPoint custom service, valid ~1 hour, and re-issuing costs a
// call against the instance's shared REST quota. Each set of credentials therefore gets its own
// Durable Object, so every session and gadget belonging to that account reuses one token instead
// of minting its own.

import { DurableObject } from "cloudflare:workers";
import {
  MarketoClient,
  MarketoDispatchAbortedError,
  MarketoError,
  type MarketoCredentials,
  type TokenProvider,
} from "./marketo-api";
import type { Env } from "./config";

/** Refresh this far ahead of expiry so a token never lapses mid-request. */
const REFRESH_MARGIN_MS = 120_000;
/** Back off repeated Identity failures, including unusable token lifetimes. */
const REFRESH_FAILURE_BACKOFF_MS = 30_000;

/** Sanitized error data that can cross the Durable Object RPC boundary without Error prototypes. */
export type TokenCacheError = {
  kind: "auth" | "network" | "provider";
  code?: string;
  status?: number;
};

/** Explicit RPC result from the token cache. */
export type TokenCacheResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TokenCacheError };

/** Credentials and account lifecycle generation authorizing one token refresh. */
export type TokenCredentialState = {
  credentials: MarketoCredentials;
  generation: number;
};

/** Data returned by Marketo's Identity endpoint and retained in the token cache. */
export type IdentityToken = {
  accessToken: string;
  expiresInSeconds: number;
  scope?: string;
};

/** Account capability that authoritatively initiates Identity requests. */
export interface IdentityTokenAuthority {
  fetchIdentityToken(expected: TokenCredentialState): Promise<
    TokenCacheResult<IdentityToken> | { ok: false; credentialChanged: true }
  >;
}

type SerializedFormDataEntry =
  | { name: string; text: string }
  | { name: string; bytes: Uint8Array; type: string; fileName: string };

/** Signal-free HTTP request data that can cross the Durable Object RPC boundary. */
export type MarketoDispatchRequest = {
  method?: string;
  redirect?: "follow" | "error" | "manual";
  headers?: HeadersInit;
  body?: string | { formData: SerializedFormDataEntry[] };
};

type CachedToken = {
  accessToken: string;
  /** Epoch millis at which Marketo says the token stops working. */
  expiresAt: number;
  /** Do not retry before expiry when Identity returned the same nearly-expired token. */
  refreshAfter?: number;
  /** Owning API-only user of the custom service, as reported by Marketo. */
  scope?: string;
};

type CachedFailure = { retryAfter: number; error: TokenCacheError };
class CredentialChangedError extends Error {}

export class MarketoTokenCache extends DurableObject<Env> {
  /** De-duplicates concurrent refreshes within one instance. */
  #inflight: Promise<CachedToken> | undefined;

  /** Return a usable bearer token, refreshing when stale or when `forceRefresh` is set. */
  async getToken(
    creds: MarketoCredentials,
    forceRefresh: boolean,
    authority: IdentityTokenAuthority,
    expected: TokenCredentialState,
  ): Promise<TokenCacheResult<string> | { ok: false; credentialChanged: true }> {
    return await this.#result(async () =>
      (await this.#current(creds, forceRefresh, authority, expected)).accessToken);
  }

  /**
   * The API-only user owning the custom service (Marketo's `scope`).
   *
   * Used to label the connection in the UI so it is obvious which Marketo identity the account's
   * actions are attributed to.
   */
  async getScope(
    creds: MarketoCredentials,
    authority: IdentityTokenAuthority,
    expected: TokenCredentialState,
  ): Promise<TokenCacheResult<string | undefined> | { ok: false; credentialChanged: true }> {
    return await this.#result(async () => (await this.#current(creds, false, authority, expected)).scope);
  }

  /** Force a provider round trip and distinguish rejected credentials from operational failures. */
  async verifyCredentials(
    creds: MarketoCredentials,
    authority: IdentityTokenAuthority,
    expected: TokenCredentialState,
  ): Promise<TokenCacheResult<boolean> | { ok: false; credentialChanged: true }> {
    try {
      await this.#current(creds, true, authority, expected);
      return { ok: true, value: true };
    } catch (error) {
      if (error instanceof CredentialChangedError) return { ok: false, credentialChanged: true };
      if (error instanceof MarketoError && error.isAuthError) return { ok: true, value: false };
      return { ok: false, error: serializeTokenError(error) };
    }
  }

  async #result<T>(operation: () => Promise<T>): Promise<
    TokenCacheResult<T> | { ok: false; credentialChanged: true }
  > {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      if (error instanceof CredentialChangedError) return { ok: false, credentialChanged: true };
      return { ok: false, error: serializeTokenError(error) };
    }
  }

  async #current(
    creds: MarketoCredentials,
    forceRefresh: boolean,
    authority: IdentityTokenAuthority,
    expected: TokenCredentialState,
  ): Promise<CachedToken> {
    let cached = this.ctx.storage.kv.get<CachedToken>("token");
    let now = Date.now();
    let failure = this.ctx.storage.kv.get<CachedFailure>("refreshFailure");
    if (!forceRefresh && failure && failure.retryAfter > now) {
      if (cached && cached.expiresAt > now && isTransientTokenError(failure.error)) return cached;
      throw unwrapTokenCacheResult<never>({ ok: false, error: failure.error });
    }
    if (!forceRefresh && cached && cached.expiresAt > now &&
        (cached.expiresAt - REFRESH_MARGIN_MS > now || (cached.refreshAfter ?? 0) > now)) {
      return cached;
    }
    // Collapse concurrent refreshes: the first caller fetches, the rest await the same promise.
    this.#inflight ??= this.#refresh(authority, expected, cached)
      .catch(error => {
        if (!(error instanceof CredentialChangedError)) {
          this.ctx.storage.kv.put<CachedFailure>("refreshFailure", {
            retryAfter: Date.now() + REFRESH_FAILURE_BACKOFF_MS,
            error: serializeTokenError(error),
          });
        }
        throw error;
      })
      .finally(() => {
        this.#inflight = undefined;
      });
    try {
      return await this.#inflight;
    } catch (error) {
      if (!forceRefresh && cached && cached.expiresAt > Date.now() &&
          isTransientTokenError(serializeTokenError(error))) {
        return cached;
      }
      throw error;
    }
  }

  async #refresh(
    authority: IdentityTokenAuthority,
    expected: TokenCredentialState,
    previous?: CachedToken,
  ): Promise<CachedToken> {
    let result = await authority.fetchIdentityToken(expected);
    if (!result.ok) {
      if ("credentialChanged" in result) {
        throw new CredentialChangedError();
      }
      throw unwrapTokenCacheResult<never>(result);
    }
    let { accessToken, expiresInSeconds, scope } = result.value;
    let now = Date.now();
    let expiresAt = now + Math.max(0, expiresInSeconds) * 1000;
    let sameNearlyExpiredToken = previous?.accessToken === accessToken &&
      expiresAt - REFRESH_MARGIN_MS <= now;
    let token: CachedToken = {
      accessToken,
      expiresAt,
      ...(sameNearlyExpiredToken && expiresAt > now ? {
        refreshAfter: expiresAt,
      } : {}),
      scope,
    };
    this.ctx.storage.kv.put<CachedToken>("token", token);
    this.ctx.storage.kv.delete("refreshFailure");
    return token;
  }
}

function isTransientTokenError(error: TokenCacheError): boolean {
  return error.kind === "network" ||
    (error.kind === "provider" && (error.status === 429 || (error.status ?? 0) >= 500));
}

/** Reduce an Identity failure to credential-free data safe for an RPC result. */
export function serializeTokenError(error: unknown): TokenCacheError {
  if (!(error instanceof MarketoError)) return { kind: "network" };
  return {
    kind: error.isAuthError ? "auth" : error.status === undefined ? "network" : "provider",
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.status === undefined ? {} : { status: error.status }),
  };
}

/** Restore a sanitized local error from an explicit token-cache RPC result. */
export function unwrapTokenCacheResult<T>(result: TokenCacheResult<T>): T {
  if (result.ok) return result.value;
  let label = result.error.kind === "auth"
    ? "Marketo authentication failed"
    : result.error.kind === "network"
      ? "Could not reach the Marketo Identity endpoint"
      : "Marketo Identity request failed";
  throw new MarketoError(`${label}.`, {
    code: result.error.code,
    status: result.error.status,
    providerRejection: result.error.kind !== "network",
  });
}

/**
 * Stable, opaque cache key for a credential.
 *
 * Derived from the complete credential. Only its hash appears in the Durable Object name, and a
 * secret rotation selects a fresh cache immediately.
 */
async function cacheKey(creds: MarketoCredentials): Promise<string> {
  let data = new TextEncoder().encode(
    `${creds.endpoint}\u0000${creds.clientId}\u0000${creds.clientSecret}`,
  );
  let digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Get the token-cache stub for one set of credentials. */
export async function tokenCacheStub(
  exports: Cloudflare.Exports,
  creds: MarketoCredentials,
): Promise<DurableObjectStub<MarketoTokenCache>> {
  return exports.MarketoTokenCache.get(
    exports.MarketoTokenCache.idFromName(await cacheKey(creds)),
  );
}

/** Build a Marketo client for one account, backed by that account's token cache. */
export async function makeClient(
  exports: Cloudflare.Exports,
  creds: MarketoCredentials,
  authority: IdentityTokenAuthority,
  expected: TokenCredentialState,
  credentialsExpired?: () => Promise<void>,
  dispatch?: (
    url: string,
    init: MarketoDispatchRequest,
    forceRefresh: boolean,
    timeoutMs: number,
  ) => Promise<Response>,
): Promise<MarketoClient> {
  let cache = await tokenCacheStub(exports, creds);
  let provider: TokenProvider = {
    getToken: async (forceRefresh?: boolean) => {
      let result = await cache.getToken(creds, forceRefresh ?? false, authority, expected);
      if ("credentialChanged" in result) {
        throw new MarketoDispatchAbortedError("The Marketo account changed before token refresh.");
      }
      return unwrapTokenCacheResult(result);
    },
    ...(dispatch ? { fetch: async (
      url: string,
      init: RequestInit,
      forceRefresh = false,
      timeoutMs = 60_000,
    ) => await dispatch(url, await serializeRequest(init), forceRefresh, timeoutMs) } : {}),
    credentialsExpired,
  };
  return new MarketoClient(creds.endpoint, provider);
}

async function serializeRequest(init: RequestInit): Promise<MarketoDispatchRequest> {
  let body: MarketoDispatchRequest["body"];
  if (init.body instanceof FormData) {
    let entries: SerializedFormDataEntry[] = [];
    for (let [name, value] of init.body) {
      entries.push(typeof value === "string"
        ? { name, text: value }
        : {
            name,
            bytes: new Uint8Array(await value.arrayBuffer()),
            type: value.type,
            fileName: value.name,
          });
    }
    body = { formData: entries };
  } else if (typeof init.body === "string") {
    body = init.body;
  } else if (init.body !== undefined && init.body !== null) {
    throw new Error("Unsupported Marketo request body.");
  }
  return {
    method: init.method,
    ...(init.redirect === "follow" || init.redirect === "error" || init.redirect === "manual"
      ? { redirect: init.redirect }
      : {}),
    headers: init.headers,
    ...(body === undefined ? {} : { body }),
  };
}
