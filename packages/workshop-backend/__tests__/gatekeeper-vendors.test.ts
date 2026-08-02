import { describe, expect, it } from "vitest";
import type { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import {
  gatekeeperVendorEntries,
  getGatekeeperVendorBinding,
} from "../src/auth/auth-vendors.js";
import { UserDurableObject } from "../src/user.js";

// Minimal fake vendor stub: just the methods the code under test awaits. Returning one supported
// resource keeps the vendor from being hidden by the "no enabled resources" filter.
function fakeVendor(displayName: string) {
  return {
    async describe() {
      return { displayName, url: `https://${displayName}.example.com`, tagline: "", description: "" };
    },
    async getSupportedResources() {
      return [{ urlPattern: `https://${displayName}.example.com/*`, title: displayName, description: "" }];
    },
    async connectAccount() {
      return { url: `https://${displayName}.example.com/connect` };
    },
  } as unknown as Service<GatekeeperVendor>;
}

// Env stub: BLUEPRINTS backs readAdminConfig (null -> all-default config).
function fakeEnv(extra: Record<string, unknown> = {}): Cloudflare.Env {
  return {
    BLUEPRINTS: { get: async () => null },
    ...extra,
  } as unknown as Cloudflare.Env;
}

// Build a UserDurableObject without running its constructor (same pattern as
// user-verifier.test.ts), with just enough state for the vendor-listing/connect paths.
function makeUser(snapshot: Map<string, Service<GatekeeperVendor>>) {
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  let nextAccountId = 0;
  Object.assign(user, {
    env: fakeEnv(),
    ctx: {
      id: { toString: () => "test-user-id" },
      exports: { GatekeeperConnectCallbackImpl: () => ({}) },
    },
    vendors: snapshot,
    storage: {
      profile: { get: () => ({ type: "user", name: "Test", id: "test@example.com" }) },
      nextAccountId: {
        get: () => nextAccountId,
        put: (value: number) => { nextAccountId = value; },
      },
    },
  });
  return user;
}

describe("gatekeeper vendor env helpers", () => {
  const google = fakeVendor("google");
  const slack = fakeVendor("slack");
  const env = fakeEnv({
    GATEKEEPER_GOOGLE: google,
    GATEKEEPER_SLACK: slack,
    AVATARS: {},
    DEV: true,
  });

  it("gatekeeperVendorEntries scans GATEKEEPER_* bindings and ignores the rest", () => {
    const entries = gatekeeperVendorEntries(env);
    expect(entries.map((e) => e.vendorId).toSorted()).toEqual(["google", "slack"]);
    expect(entries.find((e) => e.vendorId === "google")!.vendor).toBe(google);
  });

  it("getGatekeeperVendorBinding resolves a single binding, null when unbound", () => {
    expect(getGatekeeperVendorBinding(env, "slack")).toBe(slack);
    expect(getGatekeeperVendorBinding(env, "notion")).toBeNull();
  });
});

describe("UserDurableObject.listGatekeeperVendors", () => {
  it("uses passed fresh entries over the constructor snapshot", async () => {
    // The snapshot predates the deploy that added "newbie" — the fresh entries must win.
    const user = makeUser(new Map([["stale", fakeVendor("stale")]]));

    const result = await user.listGatekeeperVendors(
        {}, [{ vendorId: "newbie", vendor: fakeVendor("newbie") }]);
    expect(result.map((v) => v.id)).toEqual(["newbie"]);
  });

  it("falls back to the snapshot when no fresh entries are passed", async () => {
    const user = makeUser(new Map([["old", fakeVendor("old")]]));

    const result = await user.listGatekeeperVendors();
    expect(result.map((v) => v.id)).toEqual(["old"]);
  });
});

describe("UserDurableObject.connectAccount", () => {
  it("connects via a passed stub for a vendor missing from the snapshot", async () => {
    const user = makeUser(new Map());

    const { url } = await user.connectAccount("newbie", undefined, fakeVendor("newbie"));
    expect(url).toBe("https://newbie.example.com/connect");
  });

  it("still throws when the vendor is in neither the passed stub nor the snapshot", async () => {
    const user = makeUser(new Map());

    await expect(user.connectAccount("ghost", undefined, null))
        .rejects.toThrow("No such service: ghost");
  });
});
