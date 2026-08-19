import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpAccountBase,
  type ConnectedServer,
  type ConnectOutcome,
} from "@gadgets/mcp-shared/account";
import { McpAccount } from "../src/portal.js";

afterEach(() => vi.restoreAllMocks());

describe("McpAccount configuration revision", () => {
  it("records the current revision before handing an OAuth attempt to its callback", async () => {
    const values = new Map<string, unknown>([["portalConfigRevision", "old"]]);
    const ctx = {
      id: { toString: () => "account" },
      storage: {
        kv: {
          get: (key: string) => values.get(key),
          put: (key: string, value: unknown) => values.set(key, value),
          delete: (key: string) => values.delete(key),
        },
      },
      exports: {},
    };
    const env = {
      MCP_PORTAL_URL: "https://portal.example.com/mcp",
      MCP_PORTAL_AUTH: "oauth",
    };
    const server: ConnectedServer = {
      endpoint: env.MCP_PORTAL_URL,
      serverId: "portal",
      serverName: "Portal",
      provenance: "deployment",
      auth: "oauth",
    };
    const base = McpAccountBase.prototype as unknown as {
      beginConnect(nonce: string, target: ConnectedServer | null): Promise<ConnectOutcome>;
    };
    vi.spyOn(base, "beginConnect")
      .mockResolvedValue({ kind: "redirect", url: "https://login.example.com" });
    const account = new McpAccount(ctx as never, env as never);
    const internals = account as unknown as {
      awaitingSelection(nonce: string): boolean;
      server(): ConnectedServer | undefined;
    };
    vi.spyOn(internals, "awaitingSelection").mockReturnValue(true);
    vi.spyOn(internals, "server").mockReturnValue(server);

    await expect(account.beginConnect("nonce", server)).resolves.toMatchObject({ kind: "redirect" });

    expect(values.get("portalConfigRevision")).not.toBe("old");
  });

  it("establishes the current token revision and invalidates a legacy transport session once", async () => {
    const values = new Map<string, unknown>([
      ["server", {
        endpoint: "https://portal.example.com/mcp",
        serverId: "portal",
        serverName: "Portal",
        provenance: "deployment",
        auth: "token",
      } satisfies ConnectedServer],
      ["connectionGeneration", 2],
      ["mcpSessionId", "legacy-session"],
    ]);
    const ctx = {
      id: { toString: () => "account" },
      storage: {
        kv: {
          get: (key: string) => values.get(key),
          put: (key: string, value: unknown) => values.set(key, value),
          delete: (key: string) => values.delete(key),
        },
      },
      exports: {},
    };
    const account = new McpAccount(ctx as never, {
      MCP_PORTAL_URL: "https://portal.example.com/mcp",
      MCP_PORTAL_AUTH: "token",
      MCP_PORTAL_TOKEN: "configured-token",
    } as never);

    await expect(account.getConnection("https://portal.example.com/mcp")).resolves.toMatchObject({
      authorization: "configured-token",
      generation: 3,
      sessionId: null,
    });
    await expect(account.getConnection("https://portal.example.com/mcp")).resolves.toMatchObject({
      generation: 3,
    });
    expect(values.get("portalConfigRevision")).toEqual(expect.any(String));
  });

  it("allows only OAuth callbacks and fallbacks still permitted by live portal configuration", () => {
    const values = new Map<string, unknown>();
    const env = {
      MCP_PORTAL_URL: "https://portal.example.com/mcp",
      MCP_PORTAL_AUTH: "oauth",
    };
    const account = new McpAccount({
      id: { toString: () => "account" },
      storage: {
        kv: {
          get: (key: string) => values.get(key),
          put: (key: string, value: unknown) => values.set(key, value),
          delete: (key: string) => values.delete(key),
        },
      },
      exports: {},
    } as never, env as never) as unknown as {
      allowsOAuthCallback(server: ConnectedServer): boolean;
      allowsOAuthFallback(server: ConnectedServer): boolean;
    };
    const oauthServer: ConnectedServer = {
      endpoint: env.MCP_PORTAL_URL,
      serverId: "portal",
      serverName: "Portal",
      provenance: "deployment",
      auth: "oauth",
    };

    expect(account.allowsOAuthCallback(oauthServer)).toBe(true);
    expect(account.allowsOAuthFallback(oauthServer)).toBe(true);
    expect(account.allowsOAuthFallback({ ...oauthServer, auth: "none" })).toBe(false);
    env.MCP_PORTAL_AUTH = "none";
    expect(account.allowsOAuthCallback(oauthServer)).toBe(false);
    env.MCP_PORTAL_AUTH = "oauth";
    env.MCP_PORTAL_URL = "https://replacement.example.com/mcp";
    expect(account.allowsOAuthCallback(oauthServer)).toBe(false);
  });
});
