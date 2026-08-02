// Helpers for resolving authentication-gatekeeper service bindings.
//
// The backend discovers gatekeepers from `GATEKEEPER_<NAME>` env bindings, where the vendor id is
// the suffix lowercased (e.g. GATEKEEPER_GOOGLE -> "google"). These helpers map between the two.

import { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";

export function gatekeeperBindingName(vendorId: string): string {
  return "GATEKEEPER_" + vendorId.toUpperCase();
}

// Return the gatekeeper vendor service binding for `vendorId`, or null if not bound.
//
// Callers should look this up from a *fresh* env (the current request/connection's) rather than
// one snapshotted at construction: a Durable Object's env is frozen per instance, so a snapshot
// misses gatekeepers added by a worker deploy until the DO happens to restart.
export function getGatekeeperVendorBinding(
  env: Cloudflare.Env, vendorId: string,
): Service<GatekeeperVendor> | null {
  const binding = (env as unknown as Record<string, unknown>)[gatekeeperBindingName(vendorId)];
  return (binding as Service<GatekeeperVendor>) ?? null;
}

// Return the gatekeeper vendor service binding for `vendorId`, or null if not bound. Same lookup
// as getGatekeeperVendorBinding, kept as a separate name for the sign-in call sites.
export function getAuthVendorBinding(
  env: Cloudflare.Env, vendorId: string,
): Service<GatekeeperVendor> | null {
  return getGatekeeperVendorBinding(env, vendorId);
}

// One bound gatekeeper vendor and its id (the GATEKEEPER_<NAME> suffix, lowercased).
export type GatekeeperVendorEntry = {
  vendorId: string;
  vendor: Service<GatekeeperVendor>;
};

// List every bound gatekeeper as {vendorId, vendor} entries — the array form of
// buildGatekeeperVendorMap. Workers compute this from their per-request env and pass it into
// Durable Object calls so the DO sees the current gatekeeper set rather than its constructor
// snapshot (see getGatekeeperVendorBinding for why the snapshot goes stale).
export function gatekeeperVendorEntries(env: Cloudflare.Env): GatekeeperVendorEntry[] {
  return [...buildGatekeeperVendorMap(env)].map(([vendorId, vendor]) => ({ vendorId, vendor }));
}

// The vendor map a Durable Object call should use: the fresh entries the calling worker computed
// from its own env when present, otherwise the DO's constructor snapshot (internal callers, e.g.
// the overseer, have no fresh env to pass and get the snapshot).
export function resolveVendorMap(
  snapshot: Map<string, Service<GatekeeperVendor>>,
  freshVendors?: GatekeeperVendorEntry[],
): Map<string, Service<GatekeeperVendor>> {
  if (!freshVendors) return snapshot;
  return new Map(freshVendors.map(({ vendorId, vendor }) => [vendorId, vendor]));
}

// Build a map of every bound gatekeeper, keyed by vendor id (the GATEKEEPER_<NAME> suffix,
// lowercased). The set of gatekeepers is deployment-global (env bindings), so this is independent of
// any particular user.
export function buildGatekeeperVendorMap(
  env: Cloudflare.Env,
): Map<string, Service<GatekeeperVendor>> {
  const vendors = new Map<string, Service<GatekeeperVendor>>();
  for (const bindingName in env) {
    if (bindingName.startsWith("GATEKEEPER_")) {
      const vendorId = bindingName.slice("GATEKEEPER_".length).toLowerCase();
      vendors.set(vendorId, (env as unknown as Record<string, Service<GatekeeperVendor>>)[bindingName]);
    }
  }
  return vendors;
}
