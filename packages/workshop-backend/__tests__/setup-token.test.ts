import { describe, expect, it } from "vitest";
import { checkAdminSetup, getAdminUsernames } from "../src/auth/setup-token.js";

function env(overrides: Partial<Cloudflare.Env>): Cloudflare.Env {
  return overrides as Cloudflare.Env;
}

describe("getAdminUsernames", () => {
  it("returns [] when ADMINS is unset", () => {
    expect(getAdminUsernames(env({}))).toEqual([]);
  });

  it("parses an array binding", () => {
    expect(getAdminUsernames(env({ ADMINS: ["alice", "bob"] }))).toEqual(["alice", "bob"]);
  });

  it("parses a JSON-string binding", () => {
    expect(getAdminUsernames(env({ ADMINS: '["alice","bob"]' as unknown as string[] })))
        .toEqual(["alice", "bob"]);
  });

  it("normalizes un-normalized entries", () => {
    expect(getAdminUsernames(env({ ADMINS: ["Admin"] }))).toEqual(["admin"]);
  });

  it("skips entries that fail normalization", () => {
    expect(getAdminUsernames(env({ ADMINS: ["my-admin", "9lives", "valid_1"] })))
        .toEqual(["valid_1"]);
  });

  it("throws when ADMINS is not an array", () => {
    expect(() => getAdminUsernames(env({ ADMINS: '"alice"' as unknown as string[] })))
        .toThrow(TypeError);
  });
});

describe("checkAdminSetup", () => {
  const base = { ADMINS: ["admin"], SETUP_TOKEN: "s3cret" };

  it("never reserves when no SETUP_TOKEN is configured", () => {
    expect(checkAdminSetup(env({ ADMINS: ["admin"] }), "admin", "anything"))
        .toEqual({ reservedAdmin: false, tokenOk: false });
  });

  it("reserves admin usernames and accepts the matching token", () => {
    expect(checkAdminSetup(env(base), "admin", "s3cret"))
        .toEqual({ reservedAdmin: true, tokenOk: true });
  });

  it("rejects a wrong token", () => {
    expect(checkAdminSetup(env(base), "admin", "wrong"))
        .toEqual({ reservedAdmin: true, tokenOk: false });
  });

  it("rejects a missing token", () => {
    expect(checkAdminSetup(env(base), "admin"))
        .toEqual({ reservedAdmin: true, tokenOk: false });
  });

  it("does not reserve non-admin usernames", () => {
    expect(checkAdminSetup(env(base), "somebody", "s3cret").reservedAdmin).toBe(false);
  });

  it("matches against the normalized admin list", () => {
    expect(checkAdminSetup(env({ ADMINS: ["Admin"], SETUP_TOKEN: "s3cret" }), "admin", "s3cret"))
        .toEqual({ reservedAdmin: true, tokenOk: true });
  });
});
