// Per-credential bearer-token cache.
//
// Marketo issues one token per LaunchPoint custom service, valid ~1 hour, and re-issuing costs a
// call against the instance's shared REST quota. Each set of credentials therefore gets its own
// Durable Object, so every session and gadget belonging to that account reuses one token instead
// of minting its own.

import { DurableObject } from "cloudflare:workers";
import {
  fetchAccessToken,
  MarketoClient,
  type MarketoCredentials,
  type TokenProvider,
} from "./marketo-api";
import type { Env } from "./config";

/** Refresh this far ahead of expiry so a token never lapses mid-request. */
const REFRESH_MARGIN_MS = 120_000;

type CachedToken = {
  accessToken: string;
  /** Epoch millis at which Marketo says the token stops working. */
  expiresAt: number;
  /** Owning API-only user of the custom service, as reported by Marketo. */
  scope?: string;
};

export class MarketoTokenCache extends DurableObject<Env> {
  /** De-duplicates concurrent refreshes within one instance. */
  #inflight: Promise<CachedToken> | undefined;

  /** Return a usable bearer token, refreshing when stale or when `forceRefresh` is set. */
  async getToken(creds: MarketoCredentials, forceRefresh = false): Promise<string> {
    return (await this.#current(creds, forceRefresh)).accessToken;
  }

  /**
   * The API-only user owning the custom service (Marketo's `scope`).
   *
   * Used to label the connection in the UI so it is obvious which Marketo identity the account's
   * actions are attributed to.
   */
  async getScope(creds: MarketoCredentials): Promise<string | undefined> {
    return (await this.#current(creds, false)).scope;
  }

  async #current(creds: MarketoCredentials, forceRefresh: boolean): Promise<CachedToken> {
    let cached = this.ctx.storage.kv.get<CachedToken>("token");
    if (!forceRefresh && cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return cached;
    }
    // Collapse concurrent refreshes: the first caller fetches, the rest await the same promise.
    this.#inflight ??= this.#refresh(creds).finally(() => {
      this.#inflight = undefined;
    });
    return await this.#inflight;
  }

  async #refresh(creds: MarketoCredentials): Promise<CachedToken> {
    let { accessToken, expiresInSeconds, scope } = await fetchAccessToken(creds);
    let token: CachedToken = {
      accessToken,
      expiresAt: Date.now() + expiresInSeconds * 1000,
      scope,
    };
    this.ctx.storage.kv.put<CachedToken>("token", token);
    return token;
  }
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
  credentialsExpired?: () => Promise<void>,
): Promise<MarketoClient> {
  let cache = await tokenCacheStub(exports, creds);
  let provider: TokenProvider = {
    getToken: (forceRefresh?: boolean) => cache.getToken(creds, forceRefresh ?? false),
    credentialsExpired,
  };
  return new MarketoClient(creds.endpoint, provider);
}
