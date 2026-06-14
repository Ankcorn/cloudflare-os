// Builds the public ServerConfig the client fetches at boot. Aggregates the two optional,
// independent features: sign-in via authentication gatekeepers (auth/) and AI Gateway billing
// (ai-gateway-billing/). Contains no secrets.

import { AuthVendorInfo, ServerConfig } from "@gadgets/workshop-shared/api";
import { getAuthGatekeeperAllowlist, isPasswordAuthEnabled } from "./auth/config.js";
import { isCloudflareLimitsEnabled } from "./ai-gateway-billing/config.js";
import { getAuthVendorBinding } from "./auth/auth-vendors.js";

// Resolve the auth-capable, allowlisted gatekeeper vendors offered as sign-in methods, querying
// each gatekeeper's describe() for display info. Skips vendors with no binding, that don't advertise
// providesAuth, or that error.
export async function getAuthVendors(env: Cloudflare.Env): Promise<AuthVendorInfo[]> {
  // describe() is a cross-Worker RPC and getServerConfig() runs on every (re)connect, so query the
  // allowlisted vendors in parallel rather than serially. Order is preserved (Promise.all), so the
  // sign-in button order still follows the allowlist.
  const results = await Promise.all(getAuthGatekeeperAllowlist(env).map(
      async (vendorId): Promise<AuthVendorInfo | null> => {
    const binding = getAuthVendorBinding(env, vendorId);
    if (!binding) return null;
    try {
      const desc = await binding.describe();
      if (!desc.providesAuth) return null;
      return { vendorId, displayName: desc.displayName, logo: desc.logo, color: desc.color };
    } catch (err) {
      console.error(`[auth] failed to describe gatekeeper "${vendorId}":`, err);
      return null;
    }
  }));
  return results.filter((v): v is AuthVendorInfo => v !== null);
}

export async function getServerConfig(env: Cloudflare.Env): Promise<ServerConfig> {
  return {
    authVendors: await getAuthVendors(env),
    passwordAuthEnabled: isPasswordAuthEnabled(env),
    cloudflareLimitsEnabled: isCloudflareLimitsEnabled(env),
  };
}
