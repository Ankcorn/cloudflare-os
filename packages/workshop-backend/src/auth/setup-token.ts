// Setup-token gating for admin account creation (env-driven auth config, like config.ts).
//
// The deploy service bakes an unguessable SETUP_TOKEN into each instance it creates and hands the
// token to the deployment's creator via a setup link on the wizard's success page. While the token
// is configured, usernames listed in ADMINS are reserved: creating one through signup requires
// presenting the matching token, which also permits creating the admin account while signups are
// disabled. Deployments without a SETUP_TOKEN (e.g. self-hosted) are unaffected.

import { bytesEqual, normalizeUsername } from "../user.js";

// Parse the ADMINS binding (an array, or a string that parses as a JSON array — see #isAdmin in
// server.ts) into a list of normalized usernames. Entries that fail normalization (e.g. contain
// characters normalizeUsername rejects) are skipped rather than failing the whole list.
export function getAdminUsernames(env: Cloudflare.Env): string[] {
  let admins = env.ADMINS;
  if (!admins) return [];

  if (typeof admins === "string") {
    // ADMINS should be a JSON binding of array type, but `.env` doesn't actually let you specify
    // JSON bindings, so we also support a string that parses as JSON array.
    admins = JSON.parse(admins);
  }

  if (!Array.isArray(admins)) {
    throw new TypeError("ADMINS must be configured as an array of usernames.");
  }

  const result: string[] = [];
  for (const entry of admins) {
    try {
      result.push(normalizeUsername(entry));
    } catch {
      // Skip malformed entries; a bad ADMINS entry shouldn't break signup for everyone.
    }
  }
  return result;
}

// Result of checkAdminSetup(): whether the username is a reserved admin name, and whether the
// presented setup token authorizes claiming it.
export interface AdminSetupCheck {
  // True when a SETUP_TOKEN is configured and `username` is in the (normalized) ADMINS list —
  // i.e. creating this account requires the matching token.
  reservedAdmin: boolean;
  // True when the presented token matches the configured SETUP_TOKEN (timing-safe comparison).
  // Always false when no token is configured or none was presented.
  tokenOk: boolean;
}

// Check whether creating an account for `normalizedUsername` is gated by the deployment's setup
// token, and whether `setupToken` (if presented) unlocks it. `normalizedUsername` must already be
// normalized via normalizeUsername().
export function checkAdminSetup(env: Cloudflare.Env, normalizedUsername: string,
    setupToken?: string): AdminSetupCheck {
  const configured = env.SETUP_TOKEN;
  if (!configured) {
    return { reservedAdmin: false, tokenOk: false };
  }

  const reservedAdmin = getAdminUsernames(env).includes(normalizedUsername);

  let tokenOk = false;
  if (setupToken) {
    const encoder = new TextEncoder();
    tokenOk = bytesEqual(encoder.encode(setupToken), encoder.encode(configured));
  }

  return { reservedAdmin, tokenOk };
}
