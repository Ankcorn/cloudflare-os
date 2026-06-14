// Helpers for resolving authentication-gatekeeper service bindings.
//
// The backend discovers gatekeepers from `GATEKEEPER_<NAME>` env bindings, where the vendor id is
// the suffix lowercased (e.g. GATEKEEPER_GOOGLE -> "google"). These helpers map between the two.

import { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";

export function gatekeeperBindingName(vendorId: string): string {
  return "GATEKEEPER_" + vendorId.toUpperCase();
}

// Return the gatekeeper vendor service binding for `vendorId`, or null if not bound.
export function getAuthVendorBinding(
  env: Cloudflare.Env, vendorId: string,
): Service<GatekeeperVendor> | null {
  const binding = (env as unknown as Record<string, unknown>)[gatekeeperBindingName(vendorId)];
  return (binding as Service<GatekeeperVendor>) ?? null;
}
