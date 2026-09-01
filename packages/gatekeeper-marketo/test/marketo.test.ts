import { env, runInDurableObject, SELF } from "cloudflare:test";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  ActionDescription,
  ApprovalQueue,
  GatekeeperUserVerifier,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  buildDesignStudioUrl,
  buildInstanceUrl,
  buildListUrl,
  buildProgramUrl,
  normalizeEndpoint,
  getDefaults,
  parseCredentials,
  parseResourceUrl,
  SUPPORTED_RESOURCES,
  type Env,
} from "../src/config";
import { connectPageHtml } from "../src/connect-ui";
import {
  assertApplied,
  assertActionResultIdentity,
  assertActionResults,
  assertCampaignRequestResults,
  describeAction,
  executeAction,
  validateActionForDispatch,
  type MarketoAction,
  type MarketoActionInput,
} from "../src/actions";
import {
  executeDesignStudioAction,
  isDesignStudioAction,
  type DesignStudioAction,
  type DesignStudioActionInput,
} from "../src/design-studio-actions";
import {
  designerCloneSnapshot,
  designerDeleteSnapshot,
  emailDesignerActionReferences,
  executeEmailDesignerAction,
  isEmailDesignerAction,
  resolveDesignerCloneSnapshot,
  type EmailDesignerAction,
  type EmailDesignerActionInput,
} from "../src/email-designer-actions";
import {
  MarketoDesignerEmailImpl,
  MarketoDesignerFragmentImpl,
  MarketoEmailDesignerImpl,
  type EmailDesignerContext,
} from "../src/email-designer";
import {
  executeCampaignAction,
  isCampaignAction,
  type CampaignAction,
  type CampaignActionInput,
} from "../src/campaign-actions";
import {
  executeProgramAction,
  isProgramAction,
  type ProgramAction,
  type ProgramActionInput,
} from "../src/program-actions";
import {
  executeBusinessObjectAction,
  isBusinessObjectAction,
  type BusinessObjectAction,
} from "../src/business-object-actions";
import {
  MarketoDesignStudioImpl,
  MarketoEmailTemplateImpl,
  MarketoLandingPageTemplateImpl,
  type DesignStudioContext,
} from "../src/design-studio";
import {
  ASSET_PAGE_MAX,
  fetchAccessToken,
  MarketoClient,
  MarketoError,
  MarketoResponseValidationError,
  MAX_FILTER_VALUES,
  parseMarketoDate,
  qualifyTokenName,
  type MarketoCredentials,
  type RawActivity,
} from "../src/marketo-api";
import { resolveProgramOptions } from "../src/program-options";
import {
  makeSessionContext,
  MarketoCustomObjectImpl,
  MarketoPersonImpl,
  MarketoProgramImpl,
  MarketoSessionImpl,
  MarketoSmartCampaignImpl,
  MarketoStaticListImpl,
  type CampaignContext,
  type SessionContext,
} from "../src/session";
import {
  BUSINESS_OBJECT_RESTRICTION_TTL_MS,
  MarketoGatekeeperImpl,
  MarketoUserImpl,
  MarketoUserVerifier,
  readConnectBody,
  UserAccount,
} from "../src/marketo";
import {
  MarketoTokenCache,
  serializeTokenError,
  unwrapTokenCacheResult,
  type IdentityTokenAuthority,
  type TokenCredentialState,
} from "../src/token-cache";
import { MarketoBusinessObjectImpl, type BusinessObjectContext } from "../src/business-objects";
import type { MarketoBusinessObjectQuery } from "../src/types";

const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://123-abc-456.mktorest.com";
const EMPTY_CLASSIC_LIFECYCLE_SNAPSHOT = { metadata: {}, content: [], affectedDependents: [] };
const EMPTY_DESIGNER_LIFECYCLE_SNAPSHOT = designerCloneSnapshot({});
const EMPTY_DESIGNER_DELETE_REVIEW = {
  targetSnapshot: designerDeleteSnapshot({ name: "Target" }),
  affectedDependents: [],
};

describe("endpoint normalization", () => {
  it("accepts what people actually paste", () => {
    for (let input of [
      "https://123-ABC-456.mktorest.com",
      "123-ABC-456.mktorest.com",
      "  https://123-ABC-456.mktorest.com/  ",
      "https://123-ABC-456.mktorest.com/rest",
    ]) {
      expect(normalizeEndpoint(input)).toBe(ORIGIN);
    }
  });

  it("rejects hosts that are not Marketo REST endpoints", () => {
    // The endpoint decides where credentials get sent, so a typo must not silently exfiltrate them.
    expect(() => normalizeEndpoint("https://evil.example.com")).toThrow(/not a Marketo REST host/);
    expect(() => normalizeEndpoint("https://mktorest.com.evil.example")).toThrow(
      /not a Marketo REST host/,
    );
    expect(() => normalizeEndpoint("http://123-ABC-456.mktorest.com")).toThrow(/must use https/);
    expect(() => normalizeEndpoint("   ")).toThrow(/required/);
  });

});

describe("resource URLs", () => {
  it("round-trips each granularity", () => {
    expect(parseResourceUrl(ORIGIN, buildProgramUrl(ORIGIN, 42))).toEqual({
      kind: "program",
      id: 42,
    });
    expect(parseResourceUrl(ORIGIN, buildListUrl(ORIGIN, 7))).toEqual({ kind: "list", id: 7 });
    expect(parseResourceUrl(ORIGIN, buildDesignStudioUrl(ORIGIN))).toEqual({
      kind: "design-studio",
    });
    expect(parseResourceUrl(ORIGIN, buildInstanceUrl(ORIGIN))).toEqual({ kind: "instance" });
  });

  it("refuses URLs belonging to a different Marketo instance", () => {
    // Two users can be on different subscriptions, so a URL is only valid against its own origin.
    let other = "https://999-zzz-999.mktorest.com";
    expect(() => parseResourceUrl(ORIGIN, buildProgramUrl(other, 42))).toThrow(
      /does not belong to this Marketo instance/,
    );
  });

  it("refuses malformed and unknown resource URLs", () => {
    expect(() => parseResourceUrl(ORIGIN, `${ORIGIN}/_resource/program/abc`)).toThrow(
      /Invalid Marketo program id/,
    );
    expect(() => parseResourceUrl(ORIGIN, `${ORIGIN}/other`)).toThrow(
      /Unrecognized Marketo resource URL/,
    );
    expect(() => parseResourceUrl(ORIGIN, `${ORIGIN}/_resource/list/0`)).toThrow(
      /Invalid Marketo list id/,
    );
    expect(() => parseResourceUrl(ORIGIN, `${ORIGIN}/_resource/program/42/extra`)).toThrow(
      /Invalid Marketo program id/,
    );
    expect(() => parseResourceUrl(ORIGIN, `${ORIGIN}/_resource/instance?other=1`)).toThrow(
      /Unrecognized Marketo resource URL/,
    );
  });

  it("requires canonical positive decimal ids in scoped resource URLs", () => {
    for (let kind of ["program", "list"]) {
      for (let id of ["0", "00", "01", "+1", "1e2", "0x10", "1.0", "-1", " 1"]) {
        expect(() => parseResourceUrl(ORIGIN, `${ORIGIN}/_resource/${kind}/${id}`)).toThrow(
          new RegExp(`Invalid Marketo ${kind} id`),
        );
      }
      expect(() => parseResourceUrl(
        ORIGIN,
        `${ORIGIN}/_resource/${kind}/${Number.MAX_SAFE_INTEGER + 1}`,
      )).toThrow(new RegExp(`Invalid Marketo ${kind} id`));
    }
  });

  it("exposes exactly the four supported granularities", () => {
    expect(SUPPORTED_RESOURCES.map(r => r.title)).toEqual([
      "Marketo Instance",
      "Marketo Design Studio",
      "Marketo Program",
      "Marketo Static List",
    ]);
  });

  it("advertises one pattern set that every subscription's URLs match", () => {
    // The Workshop identifies a resource by comparing pattern *strings*: the picker only offers an
    // account whose getSupportedResources() contains the vendor's exact pattern, and the admin's
    // disabled-resource list is keyed by it too. So the patterns must stay instance-independent
    // while concrete URLs stay instance-rooted.
    expect(SUPPORTED_RESOURCES.map(r => r.urlPattern)).toEqual([
      "https://*.mktorest.com/_resource/instance",
      "https://*.mktorest.com/_resource/design-studio",
      "https://*.mktorest.com/_resource/program/:programId",
      "https://*.mktorest.com/_resource/list/:listId",
    ]);
    let [instance, designStudio, program, list] = SUPPORTED_RESOURCES.map(
      r => new URLPattern(r.urlPattern),
    );
    for (let origin of [ORIGIN, "https://999-zzz-000.mktorest.com"]) {
      expect(instance.test(buildInstanceUrl(origin))).toBe(true);
      expect(designStudio.test(buildDesignStudioUrl(origin))).toBe(true);
      expect(program.test(buildProgramUrl(origin, 42))).toBe(true);
      expect(list.test(buildListUrl(origin, 7))).toBe(true);
    }
  });
});

const BASE = "https://example.com/gatekeeper/marketo";

/** A connect URL backed by an account whose nonce expires at `expiresAt`. */
async function mintConnectUrl(expiresAt = Date.now() + 600_000): Promise<string> {
  let namespace = (env as unknown as { UserAccount: DurableObjectNamespace }).UserAccount;
  let id = namespace.newUniqueId();
  let nonce = "b".repeat(64);
  await runInDurableObject(namespace.get(id), (_instance, state) => {
    state.storage.kv.put("nonce", { value: nonce, expiresAt });
  });
  return `${id.toString()}/${nonce}`;
}

describe("connect endpoint", () => {

  it("serves the credential form at a valid connect URL", async () => {
    let res = await SELF.fetch(`${BASE}/${await mintConnectUrl()}`);
    expect(res.status).toBe(200);
    let html = await res.text();
    expect(html).toContain("Connect Marketo");
    // The deployment default is offered, but the field stays editable.
    expect(html).toContain(TEST_ENV.MARKETO_ENDPOINT!);
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("rejects oversized declared and streamed bodies", async () => {
    for (let request of [
      new Request(`${BASE}/${await mintConnectUrl()}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
          "Content-Length": String(16 * 1024 + 1),
        },
        body: "{}",
      }),
      new Request(`${BASE}/${await mintConnectUrl()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.com" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(9_000));
            controller.enqueue(new Uint8Array(9_000));
            controller.close();
          },
        }),
      }),
    ]) {
      let res = await SELF.fetch(request);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid connection details." });
    }
  });

  it("cancels a stalled connect body at its read deadline", async () => {
    let deadline = new AbortController();
    let canceled = false;
    let timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let request = new Request(BASE, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull() {},
        cancel() { canceled = true; },
      }),
    });

    let read = readConnectBody(request);
    expect(timeout).toHaveBeenCalledWith(10_000);
    deadline.abort();
    await expect(read).rejects.toThrow(/timed out/);
    expect(canceled).toBe(true);
    timeout.mockRestore();
  });

  it("404s anything that is not a connect URL", async () => {
    for (let path of ["", "/admin", "/nope", `/${"a".repeat(64)}`]) {
      let res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status).toBe(404);
    }
  });

  it("refuses cross-origin submissions", async () => {
    let res = await SELF.fetch(`${BASE}/${await mintConnectUrl()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ endpoint: ORIGIN, clientId: "a", clientSecret: "b" }),
    });
    expect(res.status).toBe(403);
  });

  it("requires a JSON content type", async () => {
    let res = await SELF.fetch(`${BASE}/${await mintConnectUrl()}`, {
      method: "POST",
      headers: { Origin: "https://example.com" },
      body: "endpoint=x",
    });
    expect(res.status).toBe(415);
  });

  it("validates the submitted fields before contacting Marketo", async () => {
    let connectUrl = await mintConnectUrl();
    let post = async (body: unknown) => {
      let res = await SELF.fetch(`${BASE}/${connectUrl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.com" },
        body: JSON.stringify(body),
      });
      return { status: res.status, error: ((await res.json()) as { error?: string }).error ?? "" };
    };

    expect(await post({ endpoint: ORIGIN, clientSecret: "s" })).toMatchObject({
      status: 400,
      error: "Invalid connection details.",
    });
    expect(await post({ endpoint: ORIGIN, clientId: "i" })).toMatchObject({
      status: 400,
      error: "Invalid connection details.",
    });
    expect(await post({ endpoint: "https://evil.example", clientId: "i", clientSecret: "s" })).toMatchObject({
      status: 400,
      error: "Invalid connection details.",
    });
  });
});

describe("connect link validity", () => {
  const EXPIRED = /invalid or has expired/;

  it("refuses an id that was never issued", async () => {
    // Durable Object ids are HMAC-verified, so a fabricated one cannot even name an account.
    let accountId = "a".repeat(64);
    let nonce = "b".repeat(64);
    let credentials = {
      endpoint: "https://request-data.example",
      clientId: "client-id-marker",
      clientSecret: "client-secret-marker",
    };
    let log = vi.spyOn(console, "debug").mockImplementation(() => {});
    let res = await SELF.fetch(`${BASE}/${accountId}/${nonce}`, {
      method: "POST",
      body: JSON.stringify(credentials),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(EXPIRED);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      component: "gatekeeper.marketo",
      vendorId: "marketo",
      event: "invalid_connect_account_id",
      error: expect.any(String),
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(accountId);
    expect(JSON.stringify(log.mock.calls)).not.toContain(nonce);
    expect(JSON.stringify(log.mock.calls)).not.toContain(credentials.endpoint);
    expect(JSON.stringify(log.mock.calls)).not.toContain(credentials.clientId);
    expect(JSON.stringify(log.mock.calls)).not.toContain(credentials.clientSecret);
    log.mockRestore();
  });

  it("refuses the wrong nonce on an existing account, for both methods", async () => {
    // The account exists and has a valid nonce; only the value presented is wrong. This is the
    // check the whole connect route rests on, so it is asserted directly rather than via a
    // fabricated id, which never reaches the comparison at all.
    let [doId] = (await mintConnectUrl()).split("/");
    let wrong = `${BASE}/${doId}/${"f".repeat(64)}`;

    let get = await SELF.fetch(wrong);
    expect(get.status).toBe(400);
    expect(await get.text()).toMatch(EXPIRED);

    let post = await SELF.fetch(wrong, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: JSON.stringify({ endpoint: ORIGIN, clientId: "i", clientSecret: "s" }),
    });
    expect(post.status).toBe(400);
    expect(((await post.json()) as { error: string }).error).toMatch(EXPIRED);
  });

  it("still honours the valid nonce after a wrong one was tried", async () => {
    // A failed guess must not consume the link, or one bad request would lock the user out.
    let connectUrl = await mintConnectUrl();
    let [doId] = connectUrl.split("/");
    expect((await SELF.fetch(`${BASE}/${doId}/${"f".repeat(64)}`)).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/${connectUrl}`)).status).toBe(200);
  });

  it("refuses an expired nonce, and says so in the form's own JSON", async () => {
    let res = await SELF.fetch(`${BASE}/${await mintConnectUrl(Date.now() - 1)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: JSON.stringify({ endpoint: ORIGIN, clientId: "i", clientSecret: "s" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(EXPIRED);
  });
});

describe("optional deployment defaults", () => {
  const FULL = {
    MARKETO_ENDPOINT: ORIGIN,
    MARKETO_CLIENT_ID: "default-id",
    MARKETO_CLIENT_SECRET: "default-secret",
  } as Env;

  it("requires every field when nothing is configured", () => {
    expect(getDefaults({} as Env)).toEqual({
      endpoint: "",
      clientId: "",
    });
    expect(() => parseCredentials({ endpoint: ORIGIN, clientSecret: "s" }, {} as Env))
      .toThrow(/Client ID is required/);
    expect(() => parseCredentials({ endpoint: ORIGIN, clientId: "i" }, {} as Env))
      .toThrow(/Client Secret is required/);
  });

  it("bounds credential fields", () => {
    expect(() => parseCredentials({
      endpoint: ORIGIN,
      clientId: "i".repeat(513),
      clientSecret: "secret",
    }, {} as Env)).toThrow(/Client ID is too long/);
    expect(() => parseCredentials({
      endpoint: ORIGIN,
      clientId: "client",
      clientSecret: "s".repeat(4097),
    }, {} as Env)).toThrow(/Client Secret is too long/);
  });

  it("schema-validates credential fields", () => {
    expect(() => parseCredentials({ endpoint: 42 }, {} as Env)).toThrow(/string/);
    expect(() => parseCredentials([], {} as Env)).toThrow(/object/);
  });

  it("fills in every blank field when the whole default service is configured", () => {
    expect(parseCredentials({}, FULL)).toEqual({
      endpoint: ORIGIN,
      clientId: "default-id",
      clientSecret: "default-secret",
    });
  });

  it("lets submitted credentials beat the defaults, so nobody is pinned to one subscription", () => {
    // Host case is normalized away, which is why this asserts the lowercased origin.
    expect(parseCredentials(
      { endpoint: "999-ZZZ-000.mktorest.com", clientId: "typed-id", clientSecret: "typed-secret" },
      FULL,
    )).toEqual({
      endpoint: "https://999-zzz-000.mktorest.com",
      clientId: "typed-id",
      clientSecret: "typed-secret",
    });
  });

  it("never sends the deployment's secret to a service it does not belong to", () => {
    // The three defaults are one credential. Were they mixed field-by-field, a blank secret plus a
    // foreign endpoint would ship the deployment's own secret to somebody else's subscription.
    expect(() => parseCredentials({ endpoint: "https://999-zzz-000.mktorest.com" }, FULL))
      .toThrow(/other than this deployment's default/);
    expect(() => parseCredentials({ clientId: "someone-elses-id" }, FULL))
      .toThrow(/other than this deployment's default/);
    // Same service, spelled differently: still the default, so the fallback still applies.
    expect(parseCredentials({ endpoint: "456-def-789.mktorest.com" }, {
      ...FULL,
      MARKETO_ENDPOINT: "https://456-DEF-789.mktorest.com",
    } as Env).clientSecret).toBe("default-secret");
  });

  it("withholds the secret fallback unless the endpoint is pinned too", () => {
    // A secret with no endpoint to pair it with would otherwise follow any endpoint submitted.
    let noEndpoint = { MARKETO_CLIENT_ID: "default-id", MARKETO_CLIENT_SECRET: "s3cret" } as Env;
    expect(getDefaults(noEndpoint).secretSource).toBeUndefined();
    expect(() => parseCredentials({ endpoint: ORIGIN }, noEndpoint)).toThrow(/Client Secret/);
  });

  it("ignores a malformed default endpoint rather than failing the page", () => {
    let endpoint = "not a url";
    let log = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getDefaults({ MARKETO_ENDPOINT: endpoint } as Env).endpoint).toBe("");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      component: "gatekeeper.marketo",
      vendorId: "marketo",
      event: "invalid_default_endpoint",
      error: expect.any(String),
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(endpoint);
    log.mockRestore();
  });

  it("reports that a default service exists without exposing its secret", () => {
    let defaults = getDefaults(FULL);
    expect(defaults.secretSource).toBe("deployment");
    expect(JSON.stringify(defaults)).not.toContain("default-secret");
  });

  it("never renders the secret into the form, but does pre-fill the other two", () => {
    let html = connectPageHtml({ defaults: getDefaults(FULL) });
    expect(html).toContain('<form id="form" method="post">');
    expect(html).toContain(ORIGIN);
    expect(html).toContain("default-id");
    expect(html).not.toContain("default-secret");
    // The shared-service caveat is stated where the choice is actually made.
    expect(html).toMatch(/shared service/);
    expect(html).toMatch(/API-only user rather than to you/);
  });

  it("shows the current Marketo setup steps", () => {
    let html = connectPageHtml({ defaults: getDefaults({} as Env) });
    expect(html).toContain("Admin &rarr; Security &rarr; Users &amp; Roles");
    expect(html).toContain("Create API Only User");
    expect(html).toContain("Enter a display name and description.");
    expect(html).toContain("Under <strong>REST API</strong>, copy the <strong>Endpoint</strong>.");
    expect(html).not.toContain("Invite New User");
  });

  it("reuses only the existing credential during reconnect", () => {
    let existing = { endpoint: ORIGIN, clientId: "saved-id", clientSecret: "saved-secret" };
    expect(getDefaults(FULL, existing)).toEqual({
      endpoint: ORIGIN,
      clientId: "saved-id",
      secretSource: "account",
    });
    expect(parseCredentials({}, FULL, existing)).toEqual(existing);
    expect(parseCredentials({ clientSecret: "rotated-secret" }, FULL, existing)).toEqual({
      ...existing,
      clientSecret: "rotated-secret",
    });
    expect(() => parseCredentials({ clientId: "other-id", clientSecret: "secret" }, FULL, existing))
      .toThrow(/Disconnect this account/);
    expect(() => parseCredentials({ endpoint: "999-ZZZ-000.mktorest.com", clientSecret: "secret" }, FULL, existing))
      .toThrow(/Disconnect this account/);
    let html = connectPageHtml({ defaults: getDefaults(FULL, existing) });
    expect(html.match(/readonly/g)).toHaveLength(2);
  });

  it("restores credentials and the nonce when reconnect notification fails", async () => {
    let namespace = (env as unknown as {
      UserAccount: DurableObjectNamespace<UserAccount>;
    }).UserAccount;
    let account = namespace.get(namespace.newUniqueId());
    let initial = { endpoint: ORIGIN, clientId: "saved-id", clientSecret: "saved-secret" };
    let nonce = crypto.randomUUID();

    await runInDurableObject(account, (_instance, state) => {
      state.storage.kv.put("credentials", initial);
    });
    await account.prepareReconnect(nonce);

    let result = await account.completeConnection(nonce, {
      ...initial,
      clientSecret: "replacement-secret",
    });

    expect(result.kind).toBe("error");
    expect(await account.getCredentials()).toEqual(initial);
    await runInDurableObject(account, (_instance, state) => {
      expect(state.storage.kv.get<{ value: string }>("nonce")?.value).toBe(nonce);
    });
  });

  it("does not restore credentials when revoke races a failed reconnect callback", async () => {
    let namespace = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount;
    let account = namespace.get(namespace.newUniqueId());
    let initial = { endpoint: ORIGIN, clientId: "saved-id", clientSecret: "saved-secret" };
    let nonce = crypto.randomUUID();
    let rejectCallback!: (error: Error) => void;
    let callback = {
      credentialsRestored: () => new Promise<void>((_resolve, reject) => { rejectCallback = reject; }),
    };

    await runInDurableObject(account, async (instance, state) => {
      state.storage.kv.put("credentials", initial);
      state.storage.kv.put("reconnecting", true);
      state.storage.kv.put("nonce", { value: nonce, expiresAt: Date.now() + 60_000 });
      let get = state.storage.kv.get.bind(state.storage.kv);
      vi.spyOn(state.storage.kv, "get").mockImplementation((key: string) =>
        key === "callback" ? callback : get(key));
      let completion = instance.completeConnection(nonce, { ...initial, clientSecret: "new" });
      await vi.waitFor(() => expect(rejectCallback).toBeTypeOf("function"));
      await instance.revoke();
      rejectCallback(new Error("Workshop unavailable"));
      await expect(completion).resolves.toMatchObject({ kind: "error" });
      expect(instance.getCredentials()).toBeUndefined();
    });
  });

  it("does not clean up a newer reconnect after an older callback succeeds", async () => {
    let namespace = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount;
    let account = namespace.get(namespace.newUniqueId());
    let initial = { endpoint: ORIGIN, clientId: "saved-id", clientSecret: "saved-secret" };
    let oldNonce = crypto.randomUUID();
    let newNonce = crypto.randomUUID();
    let releaseCallback!: () => void;
    let callbackStarted!: () => void;
    let started = new Promise<void>(resolve => { callbackStarted = resolve; });
    let callback = {
      credentialsRestored: () => {
        callbackStarted();
        return new Promise<void>(resolve => { releaseCallback = resolve; });
      },
    };

    await runInDurableObject(account, async (instance, state) => {
      state.storage.kv.put("credentials", initial);
      state.storage.kv.put("reconnecting", true);
      state.storage.kv.put("nonce", { value: oldNonce, expiresAt: Date.now() + 60_000 });
      let get = state.storage.kv.get.bind(state.storage.kv);
      vi.spyOn(state.storage.kv, "get").mockImplementation((key: string) =>
        key === "callback" ? callback : get(key));

      let older = instance.completeConnection(oldNonce, { ...initial, clientSecret: "replacement" });
      await started;
      await instance.prepareReconnect(newNonce);
      releaseCallback();

      await expect(older).resolves.toMatchObject({ kind: "error" });
      expect(state.storage.kv.get("reconnecting")).toBeTruthy();
      expect(state.storage.kv.get<{ value: string }>("nonce")?.value).toBe(newNonce);
    });
  });

  it("expires an abandoned reconnect without reviving old credential authority", async () => {
    let namespace = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount;
    let account = namespace.get(namespace.newUniqueId());
    let credentials = { endpoint: ORIGIN, clientId: "saved-id", clientSecret: "saved-secret" };

    await runInDurableObject(account, async (instance, state) => {
      state.storage.kv.put("credentials", credentials);
      let oldState = instance.getCredentialState();
      state.storage.kv.put("observer:binding:observer", {
        admissionId: "old-admission",
        observerId: "observer",
        accountId: state.id.toString(),
        ownerGeneration: oldState.generation,
        collaboratorGeneration: oldState.generation,
      });
      await instance.prepareReconnect("old-nonce");
      let reconnectState = instance.getCredentialState();
      let reconnect = state.storage.kv.get<{
        value: string; expiresAt: number; generation: number;
      }>("reconnecting")!;
      expect(await state.storage.getAlarm()).toBe(reconnect.expiresAt);

      let expired = { ...reconnect, expiresAt: Date.now() - 1 };
      state.storage.kv.put("reconnecting", expired);
      state.storage.kv.put("nonce", expired);
      await instance.alarm();

      expect(state.storage.kv.get("reconnecting")).toBeUndefined();
      expect(state.storage.kv.get("nonce")).toBeUndefined();
      expect(instance.getCredentials()).toEqual(credentials);
      expect(instance.isCredentialStateCurrent({ ...oldState, credentials })).toBe(false);
      expect(instance.isCredentialStateCurrent({ ...reconnectState, credentials })).toBe(true);
      expect(await instance.getExcludedObservers("binding")).toEqual(["observer"]);
    });
  });

  it("reschedules a stale alarm for a newer reconnect", async () => {
    let namespace = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount;
    let account = namespace.get(namespace.newUniqueId());

    await runInDurableObject(account, async (instance, state) => {
      state.storage.kv.put("credentials", {
        endpoint: ORIGIN, clientId: "saved-id", clientSecret: "saved-secret",
      });
      await instance.prepareReconnect("old-nonce");
      await instance.prepareReconnect("new-nonce");
      let newerExpiry = state.storage.kv.get<{ expiresAt: number }>("reconnecting")!.expiresAt;

      await instance.alarm();

      expect(state.storage.kv.get<{ value: string }>("reconnecting")?.value).toBe("new-nonce");
      expect(state.storage.kv.get<{ value: string }>("nonce")?.value).toBe("new-nonce");
      expect(await state.storage.getAlarm()).toBe(newerExpiry);
    });
  });

  it("does not let a stale reconnect alarm overwrite completion", async () => {
    let namespace = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount;
    let account = namespace.get(namespace.newUniqueId());
    let initial = { endpoint: ORIGIN, clientId: "saved-id", clientSecret: "saved-secret" };
    let replacement = { ...initial, clientSecret: "replacement-secret" };

    await runInDurableObject(account, async (instance, state) => {
      state.storage.kv.put("credentials", initial);
      await instance.prepareReconnect("nonce");
      let get = state.storage.kv.get.bind(state.storage.kv);
      vi.spyOn(state.storage.kv, "get").mockImplementation((key: string) =>
        key === "callback" ? { credentialsRestored: async () => {} } : get(key));
      await expect(instance.completeConnection("nonce", replacement)).resolves.toEqual({ kind: "ok" });

      await instance.alarm();

      expect(instance.getCredentials()).toEqual(replacement);
      expect(state.storage.kv.get("reconnecting")).toBeUndefined();
      expect(state.storage.kv.get("nonce")).toBeUndefined();
    });
  });

  it("does not let a stale reconnect alarm erase revoke generation", async () => {
    let namespace = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount;
    let account = namespace.get(namespace.newUniqueId());

    await runInDurableObject(account, async (instance, state) => {
      state.storage.kv.put("credentials", {
        endpoint: ORIGIN, clientId: "saved-id", clientSecret: "saved-secret",
      });
      await instance.prepareReconnect("nonce");
      await instance.revoke();
      let revokedGeneration = instance.getCredentialState().generation;

      await instance.alarm();

      expect(instance.getCredentialState()).toEqual({ generation: revokedGeneration });
      expect(state.storage.kv.get("reconnecting")).toBeUndefined();
      expect(state.storage.kv.get("nonce")).toBeUndefined();
    });
  });
});

describe("account description", () => {
  it("distinguishes API users on one instance without exposing client credentials", async () => {
    let describeAccount = async (clientId: string, clientSecret: string, scope = "api-user@example.com") => {
      let credentials = { endpoint: ORIGIN, clientId, clientSecret };
      let account = {
        getCredentialState: async () => ({ credentials, generation: 1 }),
        getScope: async () => ({ ok: true, value: scope }),
      };
      let ctx = {
        props: { userObjectId: `account-${clientId}` },
        exports: {
          UserAccount: { idFromString: () => "account-id", get: () => account },
        },
      } as unknown as ExecutionContext;
      return await new MarketoUserImpl(ctx, {} as Env).describe();
    };

    let first = await describeAccount("client-one", "secret-one");
    let repeated = await describeAccount("client-one", "different-secret");
    let renamed = await describeAccount("client-one", "secret-one", "renamed@example.com");
    let second = await describeAccount("client-two", "secret-two");

    expect(first.uniqueName).toBe(repeated.uniqueName);
    expect(first.uniqueName).toBe(renamed.uniqueName);
    expect(first.uniqueName).not.toBe(second.uniqueName);
    expect(first.displayName).toContain("api-user@example.com");
    expect(first.uniqueName).not.toContain("api-user@example.com");
    expect(first.uniqueName).not.toContain("client-one");
    expect(first.uniqueName).not.toContain("secret-one");
  });

  it("logs a sanitized classification when scope lookup fails", async () => {
    let credentials = { endpoint: ORIGIN, clientId: "client", clientSecret: "secret-marker" };
    let account = {
      getCredentialState: async () => ({ credentials, generation: 1 }),
      getScope: async () => ({
        ok: false,
        error: { kind: "provider", status: scopeError.status },
      }),
      credentialsExpired: async () => {},
    };
    let scopeError = new MarketoError(`provider echoed ${credentials.clientSecret}`, {
      code: credentials.clientSecret,
      status: 500,
    });
    let ctx = {
      props: { userObjectId: "account-id" },
      exports: {
        UserAccount: {
          idFromString: () => "account-id",
          get: () => account,
        },
      },
    } as unknown as ExecutionContext;
    let user = new MarketoUserImpl(ctx, {} as Env);
    let log = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await user.describe()).toMatchObject({ displayName: "Marketo" });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      component: "gatekeeper.marketo",
      vendorId: "marketo",
      event: "marketo_scope_lookup_failed",
      error: "MarketoError",
      status: 500,
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(credentials.clientSecret);
    log.mockRestore();
  });

  it("routes the Design Studio configurator to its instance-scoped URL", async () => {
    let account = { getCredentials: async () => ({
      endpoint: ORIGIN,
      clientId: "client",
      clientSecret: "secret",
    }) };
    let ctx = {
      props: { userObjectId: "account-id" },
      exports: {
        UserAccount: {
          idFromString: () => "account-id",
          get: () => account,
        },
      },
    } as unknown as ExecutionContext;
    let user = new MarketoUserImpl(ctx, {} as Env);
    let pattern = SUPPORTED_RESOURCES.find(resource => resource.title === "Marketo Design Studio")!
      .urlPattern;

    let frame = await user.startResourceConfigurator(pattern);

    expect(frame.iframeHtml).toContain("<!DOCTYPE html>");
    expect(await (frame.ui as unknown as { resourceUrl(): Promise<string> }).resourceUrl())
      .toBe(buildDesignStudioUrl(ORIGIN));
    frame.ui[Symbol.dispose]();
  });
});

describe("action descriptions", () => {
  it("marks every action as needing a decision, since none are simulated", () => {
    let actions: MarketoAction[] = [
      { id: 1, type: "listAdd", listId: 1, listName: "L", personIds: [1] },
      { id: 2, type: "deletePerson", personId: 5 },
      { id: 3, type: "campaignTrigger", campaignId: 9, campaignName: "C", programId: null, personIds: [1] },
    ];
    for (let action of actions) {
      expect(describeAction(action).awaitDecision).toBe(true);
    }
  });

  it("does not advertise automatic reverts", () => {
    let actions: MarketoAction[] = [
      { id: 1, type: "listAdd", listId: 1, listName: "L", personIds: [1] },
      { id: 2, type: "updatePerson", personId: 1, fields: { firstName: "A" } },
      { id: 3, type: "deletePerson", personId: 1 },
      { id: 4, type: "campaignTrigger", campaignId: 1, campaignName: "C", programId: null, personIds: [1] },
    ];
    for (let action of actions) expect(describeAction(action).implementsRevert).toBe(false);
  });

  it("warns that running a campaign sends real messages", () => {
    let description = describeAction({
      id: 1,
      type: "campaignTrigger",
      campaignId: 7,
      campaignName: "Welcome Blast",
      programId: null,
      personIds: [1, 2],
    });
    expect(description.title).toContain("7");
    expect(description.description).toContain("Welcome Blast");
    expect(description.description).toMatch(/send email or SMS to real/);
  });

  it("shows every heterogeneous bulk record", () => {
    let description = describeAction({
      id: 1,
      type: "upsertPeople",
      records: [{ email: "a@example.com" }, { phone: "123" }],
      upsertAction: "createOrUpdate",
      lookupField: "email",
    });
    expect(description.description).toContain("email");
    expect(description.description).toContain("phone");
    expect(description.description).toContain("Record 2");
  });

  it("escapes Markdown in values shown to an approver", () => {
    let description = describeAction({
      id: 1,
      type: "listAdd",
      listId: 1,
      listName: "safe **forged warning**",
      personIds: [1],
    });
    expect(description.description).toContain("\\*\\*forged warning\\*\\*");
  });

  it("never auto-approves anything", () => {
    let description = describeAction({
      id: 1,
      type: "listAdd",
      listId: 1,
      listName: "L",
      personIds: [1],
    });
    expect(description.autoApprovable).toBeUndefined();
  });

  it("waits only when a new asset's server-generated shape is needed", () => {
    let expected = new Map<string, boolean>([
      ["folder", false],
      ["email", true],
      ["emailTemplate", false],
      ["landingPage", true],
      ["landingPageTemplate", false],
      ["form", true],
      ["snippet", false],
      ["file", false],
    ]);
    for (let [asset, awaitDecision] of expected) {
      let action = {
        id: 1,
        type: "designCreate",
        asset,
        provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        input: { name: "Asset" },
      } as DesignStudioAction;
      expect(describeAction(action).awaitDecision, asset).toBe(awaitDecision);
    }

    expect(describeAction({
      id: 2,
      type: "designClone",
      asset: "email",
      provisionalId: "~2",
      sourceId: "20",
      parent: { id: "10", type: "Folder" },
      name: "Copy",
    }).awaitDecision).toBe(false);
    expect(describeAction({
      id: 3,
      type: "designLifecycle",
      asset: "emailTemplate",
      targetId: "21",
      operation: "discardDraft",
      snapshot: EMPTY_CLASSIC_LIFECYCLE_SNAPSHOT,
    }).awaitDecision).toBe(true);
  });

  it("keeps hostile multiline values inside indented code and preserves exact details", () => {
    let malicious = "safe\n```\n# forged approval\n`still data`";
    let description = describeAction({
      id: 1,
      type: "designCreate",
      asset: "emailTemplate",
      provisionalId: "~1",
      parent: { id: malicious, type: "Folder" },
      input: { name: malicious, content: "<html>exact</html>", description: "literal **text**" },
    });

    expect(description).toEqual({
      implementsRevert: false,
      awaitDecision: false,
      title: "Create Marketo email template",
      description: [
        "Create a Marketo email template in folder:",
        "",
        "    safe",
        "    ```",
        "    # forged approval",
        "    `still data`",
        "",
        "with these values:",
        "",
        "name:",
        "",
        "    safe",
        "    ```",
        "    # forged approval",
        "    `still data`",
        "",
        "content:",
        "",
        "    <html>exact</html>",
        "",
        "description:",
        "",
        "    literal **text**",
      ].join("\n"),
    });
    expect(description.description).not.toMatch(/(?:^|\n)(?:```|# forged approval|`still data`)/);
  });

  it("shows a file's exact byte count and SHA-256 without exposing its bytes", () => {
    let description = describeAction({
      id: 1,
      type: "designCreate",
      asset: "file",
      provisionalId: "~1",
      parent: { id: "10", type: "Folder" },
      input: {
        name: "logo.svg",
        mimeType: "image/svg+xml",
        data: new Uint8Array([1, 2, 3]),
        sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      },
    });
    expect(description.description).toContain("byteCount:\n\n    3");
    expect(description.description).toContain(
      "sha256:\n\n    039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
    expect(description.description).not.toContain("1,2,3");
  });
});

describe("observation descriptions", () => {
  it("neutralizes Markdown and line breaks at the queue boundary", async () => {
    let observed: { title: string; description: string } | undefined;
    let ctx = makeSessionContext({
      client: async () => ({}) as MarketoClient,
      approvalQueue: {
        authorizeObservation: async (value: { title: string; description: string }) =>
          void (observed = value),
        [Symbol.dispose]: () => {},
      } as never,
      submit: async () => {},
    });

    await ctx.observe("Read **admin**", "value\n# forged");

    expect(observed).toEqual({
      title: "Read \\*\\*admin\\*\\*",
      description: "value \\# forged",
    });
  });
});

// ---------------------------------------------------------------------------
// Response normalization
//
// These drive the capability objects with a stub client to cover response normalization.

/**
 * Build a SessionContext whose client returns canned responses and whose submit no-ops. Pass
 * `notes` to capture what the session would have written to the observation log.
 */
function stubContext(client: Partial<MarketoClient>, notes?: string[]): SessionContext {
  let cursors = new Map<string, { state: unknown; scope: string }>();
  return {
    client: async () => client as MarketoClient,
    observe: async (summary: string, detail: string) => { notes?.push(summary, detail); },
    submit: async () => {},
    issuePageCursor: async (state, scope) => {
      let token = crypto.randomUUID();
      cursors.set(token, { state, scope });
      return token;
    },
    consumePageCursor: async (pageToken, scope) => {
      let cursor = cursors.get(pageToken);
      cursors.delete(pageToken);
      if (!cursor || cursor.scope !== scope) {
        throw new Error("Invalid Marketo page token for this query.");
      }
      return cursor.state;
    },
    retain: () => {},
    dispose: () => {},
  };
}

function designContext(client: Partial<MarketoClient>, initial: DesignStudioAction[] = []) {
  let actions = [...initial];
  let resolved = new Map<string, number>();
  let nextProvisional = 0;
  let ctx: DesignStudioContext = {
    ...stubContext(client),
    allocateProvisional: () => `~${++nextProvisional}`,
    logicalKind: id => {
      let creation = actions.find((action): action is Extract<DesignStudioAction, { type: "designCreate" | "designClone" }> =>
        (action.type === "designCreate" || action.type === "designClone") && action.provisionalId === id
      );
      return creation?.asset;
    },
    pending: () => actions,
    resolveId: id => /^\d+$/.test(id) ? Number(id) : resolved.get(id),
    submitDesign: async (input: DesignStudioActionInput) => {
      actions.push({ ...input, id: actions.length + 1 } as DesignStudioAction);
    },
  };
  return { ctx, actions, resolved };
}

function campaignContext(client: Partial<MarketoClient>, initial: CampaignAction[] = []) {
  let actions = [...initial];
  let resolved = new Map<string, number>();
  let nextProvisional = 0;
  let design = designContext(client);
  let ctx: CampaignContext = {
    ...design.ctx,
    allocateProvisional: () => `~${++nextProvisional}`,
    resolveId: id => /^\d+$/.test(id) ? Number(id) : resolved.get(id),
    logicalKind: id => actions.some(action =>
      (action.type === "campaignCreate" || action.type === "campaignClone") && action.provisionalId === id
    ) ? "campaign" : design.ctx.logicalKind(id),
    pendingCampaign: () => actions,
    submitCampaign: async (input: CampaignActionInput) => {
      actions.push({ ...input, id: actions.length + 1 } as CampaignAction);
    },
    pendingProgram: () => [],
    submitProgram: async () => { throw new Error("Unexpected program action."); },
  };
  return { ctx, actions, resolved };
}

function programContext(client: Partial<MarketoClient>, initial: ProgramAction[] = []) {
  let actions = [...initial];
  let resolved = new Map<string, number>();
  let nextProvisional = 0;
  let design = designContext(client);
  let ctx: CampaignContext = {
    ...design.ctx,
    allocateProvisional: () => `~${++nextProvisional}`,
    resolveId: id => /^\d+$/.test(id) ? Number(id) : resolved.get(id),
    logicalKind: id => actions.some(action =>
      (action.type === "programCreate" || action.type === "programClone") && action.provisionalId === id
    ) ? "program" : design.ctx.logicalKind(id),
    pendingCampaign: () => [],
    submitCampaign: async () => { throw new Error("Unexpected campaign action."); },
    pendingProgram: () => actions,
    submitProgram: async (input: ProgramActionInput) => {
      actions.push({ ...input, id: actions.length + 1 } as ProgramAction);
    },
  };
  return { ctx, actions, resolved };
}

function emailDesignerContext(client: Partial<MarketoClient>, initial: EmailDesignerAction[] = []) {
  let actions = [...initial];
  let resolved = new Map<string, string>();
  let nextProvisional = 0;
  let design = designContext(client);
  let ctx: EmailDesignerContext & DesignStudioContext = {
    ...design.ctx,
    allocateProvisional: () => `~${++nextProvisional}`,
    logicalKind: assetId => actions.find(action =>
      (action.type === "designerCreate" || action.type === "designerClone") && action.provisionalId === assetId
    )?.asset ?? design.ctx.logicalKind(assetId),
    pendingDesigner: () => actions,
    resolveDesignerId: assetId => assetId.startsWith("~") ? resolved.get(assetId) : assetId,
    submitDesigner: async (input: EmailDesignerActionInput) => {
      actions.push({ ...input, id: actions.length + 1 } as EmailDesignerAction);
    },
  };
  return { ctx, actions, resolved };
}

describe("new Email Designer", () => {
  it("ignores request-only settings during postflight verification but keeps them in approval", async () => {
    let action: EmailDesignerAction = {
      id: 1,
      type: "designerCreate",
      asset: "designerEmail",
      provisionalId: "~1",
      body: {
        name: "Email",
        settings: {
          brandedDomain: "click.example.com",
          dedicatedIp: "192.0.2.1",
        },
      },
    };
    let sent: Record<string, unknown> | undefined;
    let recorded: string | undefined;

    await executeEmailDesignerAction(action, {
      createDesignerAsset: async (_kind: unknown, body: Record<string, unknown>) => {
        sent = body;
        return [{ id: "email-1" }];
      },
      getDesignerAsset: async () => ({
        id: "email-1",
        name: "Email",
      }),
    } as unknown as MarketoClient, String, Number, (_provisionalId, realId) => { recorded = realId; });

    expect(sent).toEqual(action.body);
    expect(describeAction(action).description).toContain("click.example.com");
    expect(describeAction(action).description).toContain("192.0.2.1");
    expect(recorded).toBe("email-1");
  });

  it("snapshots the operation-specific associated content id for lifecycle approvals", async () => {
    for (let [operation, contentId, sourceState] of [
      ["approve", "draft-1", "draft"],
      ["discardDraft", "draft-1", "draft"],
      ["unapprove", "approved-1", "approved"],
      ["createDraft", "approved-1", "approved"],
    ] as const) {
      let { ctx, actions } = emailDesignerContext({
        getDesignerAsset: async () => ({
          id: "email-1",
          associatedStates: [
            { contentId: "draft-1", state: "draft" },
            { contentId: "approved-1", state: "approved" },
          ],
        }),
        getDesignerAssetUsedBy: async () => ({
          result: [], pageDetails: { totalItems: 0, currentPage: 1, pageSize: 50 },
        }),
      });
      await new MarketoDesignerEmailImpl(ctx, "email-1")[operation]();
      expect(actions).toMatchObject([{ contentId, sourceState }]);
    }
  });

  it("creates a fully-specified email provisionally and simulates follow-up updates", async () => {
    let { ctx, actions } = emailDesignerContext({});
    let designer = new MarketoEmailDesignerImpl(ctx);
    let email = await designer.createEmail({
      location: { workspaceId: "1001", programId: "55" },
      name: "Launch email",
      description: "Initial",
      headers: {
        subject: "Hello",
        fromName: "Team",
        fromEmail: "team@example.com",
        replyEmail: "reply@example.com",
      },
      content: { html: "<p>Hello</p>", text: "Hello" },
      settings: { isOperational: true, enableUrlTracking: true },
    });
    await email.update({ description: "Updated", headers: { subject: "New subject" } });
    await expect(email.update({})).rejects.toThrow(/non-empty update/);

    expect(actions[0]).toMatchObject({
      type: "designerCreate",
      asset: "designerEmail",
      provisionalId: "~1",
      body: {
        name: "Launch email",
        appData: { workspaceId: "1001", programId: "55", editorType: "email" },
        headers: { subject: "Hello", fromEmail: "team@example.com" },
        data: { html: { body: "<p>Hello</p>" }, text: { body: "Hello" } },
        settings: { isOperational: true, enableUrlTracking: true },
      },
    });
    expect(await email.describe()).toMatchObject({
      id: "~1",
      name: "Launch email",
      description: "Updated",
      status: "draft",
      workspaceId: "1001",
      programId: "55",
      headers: { subject: "New subject", fromEmail: "team@example.com" },
      content: { html: "<p>Hello</p>", text: "Hello" },
    });
  });

  it("binds designer clone approval to the complete simulated source snapshot", async () => {
    let raw = {
      id: "email-1",
      name: "Source",
      status: "draft",
      appType: "marketo",
      appData: { editorType: "email", workspaceId: 1, folderId: 10 },
      data: { html: { body: "<p>Old</p>" }, text: { body: "Old", syncFromHtml: false } },
      headers: { subject: "Old", fromEmail: "team@example.com" },
      settings: { enableUrlTracking: true, isOperational: false },
      templateId: 20,
      metadata: { modifiedAt: "2026-01-01T00:00:00Z" },
      contentId: "draft-1",
      associatedStates: [{ state: "draft", contentId: "draft-1" }],
      state: "draft",
    };
    let { ctx, actions } = emailDesignerContext({ getDesignerAsset: async () => raw });
    let email = new MarketoDesignerEmailImpl(ctx, "email-1");
    await email.update({
      content: { html: "<p>New</p>" },
      headers: { subject: "New" },
      settings: { isOperational: true },
    });
    await email.clone("Copy", "Approved description");

    expect(actions[1]).toMatchObject({ type: "designerClone", name: "Copy", description: "Approved description" });
    expect((actions[1] as Extract<EmailDesignerAction, { type: "designerClone" }>).sourceSnapshot)
      .toEqual(designerCloneSnapshot({
        appType: "marketo",
        appData: { editorType: "email", workspaceId: 1, folderId: 10 },
        data: {
          html: { body: "<p>New</p>" },
          text: { body: "Old", syncFromHtml: false },
        },
        headers: { subject: "New", fromEmail: "team@example.com" },
        settings: { enableUrlTracking: true, isOperational: true },
        templateId: 20,
        contentId: "draft-1",
        associatedStates: [{ state: "draft", contentId: "draft-1" }],
        state: "draft",
        status: "draft",
      }));
  });

  it("resolves every provisional location reference in a designer clone snapshot", () => {
    let resolved = resolveDesignerCloneSnapshot(designerCloneSnapshot({
      templateId: "~1",
      appData: { folderId: "~2", programId: "~3", workspaceId: "4" },
    }), id => id === "~1" ? "template-A" : id, id => id === "~2" ? 22 : id === "~3" ? 33 : Number(id));

    expect(resolved).toEqual(designerCloneSnapshot({
      templateId: "template-A",
      appData: { folderId: "22", programId: "33", workspaceId: "4" },
    }));
  });

  it("omits raw editor context and refuses arbitrary context and fragment-type writes", async () => {
    let { ctx } = emailDesignerContext({
      getDesignerAsset: async () => ({
        id: "fragment-x", name: "Hero", editorContext: { futureField: { exact: true } },
        settings: { fragmentType: "email", supportedChannels: ["email"] },
      }),
    });
    let fragment = new MarketoDesignerFragmentImpl(ctx, "fragment-x");
    expect(await fragment.describe()).not.toHaveProperty("editorContext");
    await expect(fragment.update({ fragmentType: "web" } as never)).rejects.toThrow(/unsupported field/);
    await expect(fragment.update({ editorContext: {} } as never)).rejects.toThrow(/unsupported field/);
  });

  it("rejects a mismatched id on an exact designer read", async () => {
    let { ctx } = emailDesignerContext({
      getDesignerAsset: async () => ({ id: "email-B", name: "Wrong" }),
    });
    await expect(new MarketoDesignerEmailImpl(ctx, "email-A").describe())
      .rejects.toThrow(/email-B when email-A was requested/);
  });

  it("bounds aggregate action payloads and repeated email fields", async () => {
    let { ctx, actions } = emailDesignerContext({});
    let designer = new MarketoEmailDesignerImpl(ctx);
    let tooMany = Array.from({ length: 101 }, (_, index) => `a${index}@example.com`);
    await expect(designer.createEmail({
      location: { workspaceId: "1", folderId: "2" }, name: "Email",
      headers: { subject: "Subject", ccEmails: tooMany },
    })).rejects.toThrow(/ccEmails must not contain more than 100 items/);
    await expect(designer.createFragment({
      location: { workspaceId: "1", folderId: "2" }, name: "Fragment",
      fragmentType: "email", supportedChannels: Array.from({ length: 101 }, () => "email"),
    })).rejects.toThrow(/supportedChannels must not contain more than 100 items/);
    await expect(designer.createEmail({
      location: { workspaceId: "1", folderId: "2" }, name: "Large",
      description: "d".repeat(400_000), headers: { subject: "Subject" },
      content: { html: "h".repeat(500_000), text: "t".repeat(500_000) },
    })).rejects.toThrow(/complete action payload must not exceed 1310720 bytes/);
    expect(actions).toEqual([]);
  });

  it("rejects malformed nested designer records and pagination at the client boundary", async () => {
    for (let result of [
      { items: [{ id: "e", headers: { ccEmails: "not-an-array" } }] },
      { items: [], currentPage: "zero" },
    ]) {
      let { client } = clientReturning({ success: true, result });
      await expect(client.filterDesignerAssets("email", { workspaceId: "1" })).rejects.toThrow(/unexpected shape/);
    }
    let { client } = clientReturning({
      success: true, result: [{ id: "e", appData: [] }], pageDetails: { currentPage: 0 },
    });
    await expect(client.getDesignerAssetUsedBy("email", { assetId: "e" }))
      .rejects.toThrow(/unexpected shape/);
  });

  it("normalizes used-by results and authorizes the observation", async () => {
    let notes: string[] = [];
    let base = emailDesignerContext({
      getDesignerAssetUsedBy: async () => ({
        result: [{ id: 9, name: "Newsletter", contentType: "email", appData: { workspaceId: 1001 } }],
        pageDetails: { totalItems: 1, currentPage: 1, pageSize: 20 },
      }),
    });
    base.ctx.observe = async (title, description) => { notes.push(title, description); };
    expect(await new MarketoDesignerFragmentImpl(base.ctx, "fragment-x").getUsedBy()).toEqual({
      items: [{ id: "9", name: "Newsletter", channel: undefined, contentType: "email", workspaceId: "1001", folderId: undefined }],
      totalItems: 1,
      pageIndex: 0,
      pageSize: 20,
    });
    expect(notes.join(" ")).toMatch(/dependency/);
  });

  it("correlates one-based used-by provider pages before observing", async () => {
    for (let pageDetails of [
      { totalItems: 1, currentPage: 2, pageSize: 10 },
      { totalItems: 1, currentPage: 3, pageSize: 20 },
      undefined,
    ]) {
      let notes: string[] = [];
      let base = emailDesignerContext({
        getDesignerAssetUsedBy: async () => ({ result: [], pageDetails }),
      });
      base.ctx.observe = async (title, description) => { notes.push(title, description); };
      await expect(new MarketoDesignerFragmentImpl(base.ctx, "fragment-x").getUsedBy(2, 10))
        .rejects.toThrow(/when page 2 with page size 10 was requested/);
      expect(notes).toEqual([]);
    }

    let { ctx } = emailDesignerContext({
      getDesignerAssetUsedBy: async () => ({
        result: [], pageDetails: { totalItems: 0, currentPage: 3, pageSize: 10 },
      }),
    });
    await expect(new MarketoDesignerFragmentImpl(ctx, "fragment-x").getUsedBy(2, 10))
      .resolves.toMatchObject({ pageIndex: 2, pageSize: 10 });
  });

  it("preserves server pagination and forwards filters without pending actions", async () => {
    let requests: { kind: string; options: Record<string, unknown> }[] = [];
    let { ctx } = emailDesignerContext({
      filterDesignerAssets: async (kind, options) => {
        requests.push({ kind, options });
        let page = options.pageIndex ?? 0;
        return {
          items: [1, 2].map(index => ({
            id: `${kind}-${page}-${index}`,
            name: options.name ?? (index === 1 ? "First" : "Second"),
            status: options.status?.[0] ?? "draft",
            appData: { workspaceId: options.workspaceId, folderId: options.folderId },
            templateId: options.templateId,
            settings: { fragmentType: options.fragmentType },
          })),
          totalItems: 4,
          currentPage: page,
          pageSize: options.pageSize,
        };
      },
      getDesignerAsset: async (_path, assetId) => ({ id: assetId, name: "Server name" }),
    });
    let designer = new MarketoEmailDesignerImpl(ctx);

    let first = await designer.listEmails("1", {
      folderId: "10", folderType: "Folder", name: "First", status: ["draft"], pageSize: 2,
      sortKey: "name", sortOrder: "ASC", includeArchived: true, isCreatedByMe: true,
      isModifiedByMe: false, templateId: "template-1",
    });
    let second = await designer.listEmails("1", { pageIndex: 1, pageSize: 2 });
    await designer.listFragments("1", { fragmentType: "email" });

    expect(first).toMatchObject({
      items: [{ id: "email-0-1", name: "First" }, { id: "email-0-2", name: "First" }],
      totalItems: 4, pageIndex: 0, pageSize: 2,
    });
    expect(second.items.map(item => item.id)).toEqual(["email-1-1", "email-1-2"]);
    expect(requests[0]).toEqual({
      kind: "email",
      options: {
        workspaceId: "1", folderId: "10", folderType: "Folder", name: "First", status: ["draft"],
        pageIndex: 0, pageSize: 2, sortKey: "name", sortOrder: "ASC", includeArchived: true,
        isCreatedByMe: true, isModifiedByMe: false, templateId: "template-1", fragmentType: undefined,
      },
    });
    expect(requests[2]?.options.fragmentType).toBe("email");
  });

  it("exposes the designer from a Design Studio-scoped handle", () => {
    let { ctx } = emailDesignerContext({});
    expect(new MarketoDesignStudioImpl(ctx).getEmailDesigner()).toBeInstanceOf(MarketoEmailDesignerImpl);
    expect(new MarketoSessionImpl({ ...campaignContext({}).ctx, ...ctx }).getDesignStudio().getEmailDesigner())
      .toBeInstanceOf(MarketoEmailDesignerImpl);
  });

  it("describes publication, discard, and deletion risks and tracks dependencies", () => {
    let approve = describeAction({ id: 1, type: "designerLifecycle", asset: "designerFragment", targetId: "f", operation: "approve", contentId: "f-draft", sourceState: "draft", sourceSnapshot: EMPTY_DESIGNER_LIFECYCLE_SNAPSHOT, affectedDependents: [] });
    let discard = describeAction({ id: 2, type: "designerLifecycle", asset: "designerEmail", targetId: "e", operation: "discard", contentId: "e-draft", sourceState: "draft", sourceSnapshot: EMPTY_DESIGNER_LIFECYCLE_SNAPSHOT, affectedDependents: [] });
    let remove = describeAction({ id: 3, type: "designerDelete", asset: "designerTemplate", targetId: "t", ...EMPTY_DESIGNER_DELETE_REVIEW });
    expect(approve.description).toMatch(/every inheriting/);
    expect(discard).toMatchObject({ awaitDecision: true });
    expect(discard.description).toMatch(/cannot be recovered/);
    expect(remove.description).toMatch(/irreversible.*depend/i);
    expect(emailDesignerActionReferences({ id: 4, type: "designerCreate", asset: "designerEmail", provisionalId: "~2", body: { templateId: "~1" } }, "~1")).toBe(true);
    expect(emailDesignerActionReferences({ id: 5, type: "designerClone", asset: "designerEmail", provisionalId: "~3", sourceId: "~2", name: "Copy", sourceSnapshot: designerCloneSnapshot({}) }, "~2")).toBe(true);
    expect(emailDesignerActionReferences({ id: 6, type: "designerCreate", asset: "designerEmail", provisionalId: "~4", body: { appData: { workspaceId: "1", programId: "~3" } } }, "~3")).toBe(true);
    expect(emailDesignerActionReferences({ id: 7, type: "designerUpdate", asset: "designerEmail", targetId: "email", patch: { appData: { folderId: "~4" } } }, "~4")).toBe(true);
  });
});

describe("smart campaign management", () => {
  it("returns a provisional empty campaign and simulates metadata mutations", async () => {
    let { ctx, actions } = campaignContext({});
    let session = new MarketoSessionImpl(ctx);

    let campaign = await session.createSmartCampaign(
      { id: "10", type: "folder" },
      { name: "API campaign", description: "Configure in Marketo" },
    );
    await campaign.updateMetadata({ name: "Renamed campaign" });

    expect(await campaign.describe()).toMatchObject({
      id: "~1",
      name: "Renamed campaign",
      description: "Configure in Marketo",
      type: "batch",
      active: false,
      folder: { id: "10", type: "folder" },
    });
    expect(await campaign.readSmartListRules()).toEqual({ triggers: [], filters: [] });
    expect(actions).toMatchObject([
      { type: "campaignCreate", provisionalId: "~1", parent: { id: "10", type: "Folder" } },
      { type: "campaignMetadata", targetId: "~1", patch: { name: "Renamed campaign" } },
    ]);
    await expect(campaign.activate()).rejects.toThrow(/not a trigger campaign/);
  });

  it("clones campaign metadata and exposes the source smart-list rules", async () => {
    let { ctx, actions } = campaignContext({
      getSmartCampaign: async () => ({
        id: 7,
        name: "Template campaign",
        description: "Source",
        type: "trigger",
        status: "Active",
        isActive: true,
        folder: { id: 20, type: "Program" },
        smartListId: 8,
      }),
      getCampaignSmartList: async () => ({
        id: 8,
        rules: {
          filterMatchType: "all",
          triggers: [{ id: 1, name: "Fills Out Form", ruleType: "Activity" }],
          filters: [{
            id: 2,
            name: "Country",
            ruleType: "Field",
            operator: "is",
            conditions: [{ fieldName: "Country", operator: "is", values: ["SE"] }],
          }],
        },
      }),
    });
    let session = new MarketoSessionImpl(ctx);

    let clone = await session.cloneSmartCampaign(
      "7",
      { id: "20", type: "program" },
      { name: "Sweden campaign" },
    );
    await clone.activate();

    expect(await clone.describe()).toMatchObject({
      id: "~1",
      name: "Sweden campaign",
      type: "trigger",
      active: true,
      folder: { id: "20", type: "program" },
    });
    await expect(clone.activate()).rejects.toThrow(/already active/);
    await clone.deactivate();
    expect(await clone.describe()).toMatchObject({ active: false, status: "Inactive" });
    expect(await clone.readSmartListRules()).toEqual({
      filterMatchType: "all",
      triggers: [{ id: 1, name: "Fills Out Form", type: "Activity" }],
      filters: [{
        id: 2,
        name: "Country",
        type: "Field",
        operator: "is",
        conditions: [{ name: "Country", operator: "is", values: ["SE"] }],
      }],
    });
    expect(actions[0]).toMatchObject({
      type: "campaignClone",
      provisionalId: "~1",
      sourceId: "7",
      parent: { id: "20", type: "Program" },
    });
    expect(actions[1]).toMatchObject({
      type: "campaignLifecycle", operation: "activate", programId: "20",
    });
    expect(actions[2]).toMatchObject({
      type: "campaignLifecycle", operation: "deactivate", programId: "20",
    });
  });

  it("includes source changes submitted before campaign cloning", async () => {
    let { ctx } = campaignContext({
      getSmartCampaign: async () => ({ id: 7, name: "Source", description: "Original", type: "batch" }),
    });
    let session = new MarketoSessionImpl(ctx);
    let source = session.getSmartCampaign("7");
    await source.updateMetadata({ description: "Later source change" });
    let clone = await session.cloneSmartCampaign("7", { id: "10", type: "folder" }, { name: "Clone" });

    expect(await clone.describe()).toMatchObject({ name: "Clone", description: "Later source change" });
    expect(await source.describe()).toMatchObject({ description: "Later source change" });
  });

  it("follows nested provisional clones to read source rules", async () => {
    let { ctx } = campaignContext({
      getSmartCampaign: async () => ({ id: 7, name: "Source", type: "trigger", smartListId: 8 }),
      getCampaignSmartList: async () => ({
        id: 8,
        rules: { triggers: [{ id: 1, name: "Data Value Changes" }], filters: [] },
      }),
    });
    let session = new MarketoSessionImpl(ctx);
    let first = await session.cloneSmartCampaign(
      "7",
      { id: "10", type: "folder" },
      { name: "First clone" },
    );
    let second = await session.cloneSmartCampaign(
      (await first.describe()).id,
      { id: "10", type: "folder" },
      { name: "Second clone" },
    );

    expect(await second.readSmartListRules()).toMatchObject({
      triggers: [{ id: 1, name: "Data Value Changes" }],
      filters: [],
    });
  });

  it("rejects lifecycle operations Marketo cannot apply", async () => {
    let { ctx } = campaignContext({
      getSmartCampaign: async () => ({
        id: 7, name: "Inactive trigger", type: "trigger", isActive: false, smartListId: 8,
      }),
      getCampaignSmartList: async () => ({ id: 8, rules: { triggers: [], filters: [] } }),
    });
    let campaign = new MarketoSessionImpl(ctx).getSmartCampaign("7");

    await expect(campaign.activate()).rejects.toThrow(/has no trigger/);
    await expect(campaign.deactivate()).rejects.toThrow(/already inactive/);
  });

  it("does not accept a provisional campaign id as a Design Studio folder", async () => {
    let { ctx } = campaignContext({});
    let session = new MarketoSessionImpl(ctx);
    let campaign = await session.createSmartCampaign(
      { id: "10", type: "folder" },
      { name: "Not a folder" },
    );
    let campaignId = (await campaign.describe()).id;
    if (typeof campaignId !== "string") throw new Error("Expected a provisional campaign id.");

    await expect(session.getDesignStudio().createFolder(
      { id: campaignId, type: "folder" },
      "Child",
    )).rejects.toThrow(/not an ordinary folder/);
  });

  it("describes activation and deletion risks to the approver", () => {
    let activation = describeAction({
      id: 1,
      type: "campaignLifecycle",
      targetId: "7",
      campaignName: "Campaign",
      programId: null,
      operation: "activate",
    });
    let deletion = describeAction({
      id: 2,
      type: "campaignLifecycle",
      targetId: "7",
      campaignName: "Campaign",
      programId: null,
      operation: "delete",
    });

    expect(activation.awaitDecision).toBe(true);
    expect(activation.description).toMatch(/send messages or change data/);
    expect(deletion.description).toMatch(/Permanently delete.*cannot be undone/);
  });

  it("distinguishes inherited descriptions from explicit clears", () => {
    let clone = (description?: string) => describeAction({
      id: 1,
      type: "campaignClone",
      provisionalId: "~1",
      sourceId: "7",
      parent: { id: "10", type: "Folder" },
      name: "Clone",
      description,
    });

    expect(clone().description).not.toContain("Description:");
    expect(clone("").description).toMatch(/Description: clear the existing description/);
    expect(describeAction({
      id: 2,
      type: "campaignMetadata",
      targetId: "7",
      campaignName: "Campaign",
      patch: { description: "" },
    }).description).toMatch(/Description: clear the existing description/);
  });

  it("executes creates and dependent metadata updates through resolved logical ids", async () => {
    let calls: unknown[] = [];
    let client = {
      createSmartCampaign: async (input: unknown) => {
        calls.push(["create", input]);
        return [{ id: 77 }];
      },
      updateSmartCampaign: async (id: number, patch: unknown) => {
        calls.push(["update", id, patch]);
        return [{ id }];
      },
      getSmartCampaign: async (id: number) => ({ id, name: "Campaign", folder: { id: 10, type: "Folder" } }),
    } as never;
    let resolved = new Map<string, number>([["10", 10]]);
    await executeCampaignAction(
      {
        id: 1,
        type: "campaignCreate",
        provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        name: "Campaign",
      },
      client,
      id => resolved.get(id) ?? Number(id),
      (logical, physical) => resolved.set(logical, physical),
    );
    await executeCampaignAction(
      {
        id: 2,
        type: "campaignMetadata",
        targetId: "~1",
        campaignName: "Campaign",
        patch: { description: "Ready" },
      },
      client,
      id => resolved.get(id) ?? Number(id),
      (logical, physical) => resolved.set(logical, physical),
    );

    expect(resolved.get("~1")).toBe(77);
    expect(calls).toEqual([
      ["create", { name: "Campaign", description: undefined, folder: { id: 10, type: "Folder" } }],
      ["update", 77, { description: "Ready" }],
    ]);
  });
});

describe("program management", () => {
  const channels = [{
    id: 1,
    name: "Email Send",
    applicableProgramType: "email_batch",
    progressionStatuses: [{ name: "Member" }, { name: "Success" }],
  }];
  const tagTypes = [{
    tagType: "Region",
    applicableProgramTypes: "[email_batch]",
    required: true,
    allowableValues: "[EMEA, AMER]",
  }];

  it("discovers channels and tag definitions through observations", async () => {
    let notes: string[] = [];
    let { ctx } = programContext({
      getChannels: async () => [
        ...channels,
        { name: "Default", applicableProgramType: "program" },
        { name: "Engagement", applicableProgramType: "nurture" },
        { name: "Event", applicableProgramType: "event" },
        { name: "Webinar", applicableProgramType: "webinar" },
        { name: "Future", applicableProgramType: "future_type" },
      ],
      getTagTypes: async () => tagTypes,
    });
    ctx.observe = async (title, description) => { notes.push(title, description); };
    let session = new MarketoSessionImpl(ctx);

    expect(await session.getChannels()).toEqual([
      { name: "Email Send", programType: "Email", statuses: ["Member", "Success"] },
      { name: "Default", programType: "Default", statuses: [] },
      { name: "Engagement", programType: "Engagement", statuses: [] },
      { name: "Event", programType: "Event", statuses: [] },
      { name: "Webinar", programType: "EventWithWebinar", statuses: [] },
      { name: "Future", programType: "future_type", statuses: [] },
    ]);
    expect(await session.getTagTypes()).toEqual([{
      name: "Region", applicableProgramTypes: ["Email"], required: true, values: ["EMEA", "AMER"],
    }]);
    expect(notes.join(" ")).toMatch(/program channels.*program tag types/i);
  });

  it("returns a provisional program and simulates mutable state except approval", async () => {
    let { ctx, actions } = programContext({
      getChannels: async () => channels,
      getTagTypes: async () => tagTypes,
    });
    let program = await new MarketoSessionImpl(ctx).createProgram(
      { id: "10", type: "folder" },
      {
        name: "Newsletter",
        type: "Email",
        channel: "Email Send",
        tags: [{ type: "Region", value: "EMEA" }],
        startDate: new Date("2026-09-01T10:00:00Z"),
        endDate: new Date("2026-09-01T11:00:00Z"),
      },
    );
    await program.updateMetadata({ description: "September issue" });
    await program.updateTags([{ type: "Region", value: "AMER" }]);
    await program.updateDates(
      new Date("2026-09-02T10:00:00Z"),
      new Date("2026-09-02T11:00:00Z"),
    );
    await program.approve();

    expect(await program.describe()).toMatchObject({
      id: "~1",
      name: "Newsletter",
      description: "September issue",
      type: "Email",
      channel: "Email Send",
      status: "unlocked",
      tags: [{ type: "Region", value: "AMER" }],
      startDate: new Date("2026-09-02T10:00:00Z"),
      endDate: new Date("2026-09-02T11:00:00Z"),
    });
    expect(actions.map(action => action.type)).toEqual([
      "programCreate", "programUpdate", "programUpdate", "programUpdate", "programLifecycle",
    ]);
    expect(describeAction(actions.at(-1)!).awaitDecision).toBe(true);
    expect(describeAction(actions.at(-1)!).description).toMatch(/send.*real people/i);

    await program.unapprove();
    expect((await program.describe()).status).toBe("unlocked");
    await program.delete();
    await expect(program.describe()).rejects.toThrow(/was not found/);
  });

  it("queues campaigns and both designer families into a provisional program", async () => {
    let base = programContext({
      getChannels: async () => [{ name: "Web", applicableProgramType: "Default" }],
      getTagTypes: async () => [],
    });
    let campaignActions: CampaignAction[] = [];
    let designActions: DesignStudioAction[] = [];
    let designerActions: EmailDesignerAction[] = [];
    let ctx: CampaignContext & EmailDesignerContext = {
      ...base.ctx,
      pending: () => designActions,
      submitDesign: async input => { designActions.push({ ...input, id: 100 + designActions.length } as DesignStudioAction); },
      pendingCampaign: () => campaignActions,
      submitCampaign: async input => { campaignActions.push({ ...input, id: 200 + campaignActions.length } as CampaignAction); },
      pendingDesigner: () => designerActions,
      resolveDesignerId: id => id.startsWith("~") ? undefined : id,
      submitDesigner: async input => { designerActions.push({ ...input, id: 300 + designerActions.length } as EmailDesignerAction); },
    };
    let session = new MarketoSessionImpl(ctx);
    let program = await session.createProgram(
      { id: "10", type: "folder" },
      { name: "Program", type: "Default", channel: "Web" },
    );
    let programId = String((await program.describe()).id);
    await session.createSmartCampaign({ id: programId, type: "program" }, { name: "Campaign" });
    await session.getDesignStudio().createSnippet({ id: programId, type: "program" }, { name: "Snippet" });
    await session.getDesignStudio().getEmailDesigner().createEmail({
      location: { workspaceId: "1", programId }, name: "Email", headers: { subject: "Subject" },
    });
    expect(campaignActions[0]).toMatchObject({ parent: { id: programId, type: "Program" } });
    expect(designActions[0]).toMatchObject({ parent: { id: programId, type: "Program" } });
    expect(designerActions[0]).toMatchObject({ body: { appData: { programId } } });
  });

  it("clones into ordinary folders and includes prior source changes", async () => {
    let { ctx } = programContext({
      getProgram: async () => ({
        id: 7, name: "Template", description: "Original", type: "Default", channel: "Web",
        workspace: "Default",
      }),
      getFolder: async () => ({
        id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Default",
      }),
      getChannels: async () => [{ name: "Web", applicableProgramType: "Default" }],
    });
    let session = new MarketoSessionImpl(ctx);
    await session.getProgram("7").updateMetadata({ description: "Later" });
    let clone = await session.cloneProgram("7", { id: "10", type: "folder" }, { name: "Copy" });

    expect(await clone.describe()).toMatchObject({ id: "~1", name: "Copy", description: "Later" });
    await expect(session.cloneProgram("7", { id: "20", type: "program" }, { name: "Bad" }))
      .rejects.toThrow(/ordinary folder/);
  });

  it("rejects a program clone across workspaces before submission", async () => {
    let { ctx, actions } = programContext({
      getProgram: async () => ({ id: 7, name: "Source", workspace: "Source" }),
      getFolder: async () => ({
        id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Other",
      }),
    });

    await expect(new MarketoSessionImpl(ctx).cloneProgram(
      "7", { id: "10", type: "folder" }, { name: "Clone" },
    )).rejects.toThrow(/destination folder must be in the source program's workspace/);
    expect(actions).toEqual([]);
  });

  it("validates channel applicability, tags, dates, and immutable fields before submission", async () => {
    let { ctx, actions } = programContext({
      getChannels: async () => channels,
      getTagTypes: async () => tagTypes,
      getProgram: async () => ({ id: 7, name: "Existing", type: "Email", channel: "Email Send" }),
    });
    let session = new MarketoSessionImpl(ctx);
    let destination = { id: "10", type: "folder" } as const;
    await expect(session.createProgram(destination, {
      name: "Wrong type", type: "Default", channel: "Email Send", tags: [],
    })).rejects.toThrow(/applies to Email programs/);
    await expect(session.createProgram(destination, {
      name: "Missing tag", type: "Email", channel: "Email Send", tags: [],
    })).rejects.toThrow(/Required program tag is missing/);
    await expect(session.createProgram(destination, {
      name: "Bad tag", type: "Email", channel: "Email Send",
      tags: [{ type: "Region", value: "APAC" }],
    })).rejects.toThrow(/not allowed/);
    await expect(session.createProgram(destination, {
      name: "One date", type: "Email", channel: "Email Send",
      tags: [{ type: "Region", value: "EMEA" }], startDate: new Date(),
    })).rejects.toThrow(/both be valid Dates/);
    await expect(session.getProgram(7).updateMetadata({ type: "Default" } as never))
      .rejects.toThrow(/type is immutable/);
    expect(actions).toEqual([]);
  });

  it("keeps create and clone authority off a program-scoped handle", () => {
    let program = new MarketoProgramImpl(stubContext({}), 7);
    expectTypeOf(program).not.toHaveProperty("createProgram");
    expectTypeOf(program).not.toHaveProperty("cloneProgram");
    expect(program).not.toHaveProperty("createProgram");
    expect(program).not.toHaveProperty("cloneProgram");
  });

  it("executes provisional creation followed by an update through the resolved id", async () => {
    let calls: unknown[] = [];
    let client = {
      createProgram: async (input: unknown) => { calls.push(["create", input]); return [{ id: 77 }]; },
      updateProgram: async (id: number, patch: unknown) => { calls.push(["update", id, patch]); return [{ id }]; },
      getProgram: async (id: number) => ({
        id, name: "Program", type: "Default", channel: "Web", folder: { value: 10, type: "Folder" },
      }),
    } as never;
    let resolved = new Map<string, number>([["10", 10]]);
    await executeProgramAction({
      id: 1, type: "programCreate", provisionalId: "~1", parentId: "10",
      input: { name: "Program", type: "Default", channel: "Web" },
    }, client, id => resolved.get(id) ?? Number(id), (id, real) => resolved.set(id, real));
    await executeProgramAction({
      id: 2, type: "programUpdate", targetId: "~1", programName: "Program",
      patch: { description: "Ready" },
    }, client, id => resolved.get(id) ?? Number(id), (id, real) => resolved.set(id, real));

    expect(calls).toEqual([
      ["create", { name: "Program", type: "Default", channel: "Web", folder: { id: 10, type: "Folder" } }],
      ["update", 77, { description: "Ready" }],
    ]);
  });

  it("normalizes equivalent timestamps and empty tags without hiding differences", async () => {
    let action: ProgramAction = {
      id: 1, type: "programCreate", provisionalId: "~1", parentId: "10",
      input: {
        name: "Program", type: "Email", channel: "Email Send", tags: [],
        startDate: "2026-09-01T10:00:00.000Z", endDate: "2026-09-01T10:00:00.000Z",
      },
    };
    let verify = (created: Record<string, unknown>) => executeProgramAction(action, {
      createProgram: async () => [{ id: 77 }],
      getProgram: async () => created,
    } as never, Number, () => {});
    let base = {
      id: 77, name: "Program", type: "Email", channel: "Email Send",
      folder: { value: 10, type: "Folder" },
    };
    for (let [startDate, tags] of [
      ["2026-09-01T10:00:00Z", undefined],
      ["2026-09-01T10:00:00.000Z", null],
      ["2026-09-01T10:00:00Z+0000", []],
    ] as const) {
      await expect(verify({
        ...base, startDate, endDate: startDate, ...(tags === undefined ? {} : { tags }),
      })).resolves.toBeUndefined();
    }
    await expect(verify({ ...base, startDate: "2026-09-01T10:00:01Z" }))
      .rejects.toThrow(/could not verify created program/);
    await expect(verify({ ...base, startDate: action.input.startDate, endDate: action.input.endDate,
      tags: [{ tagType: "Region", tagValue: "EMEA" }] }))
      .rejects.toThrow(/could not verify created program/);
  });

  it("verifies program tags by unique tag type rather than response order", async () => {
    let action: ProgramAction = {
      id: 1, type: "programCreate", provisionalId: "~1", parentId: "10",
      input: {
        name: "Program", type: "Default", channel: "Web",
        tags: [
          { tagType: "Region", tagValue: "EMEA" },
          { tagType: "Department", tagValue: "Sales" },
        ],
      },
    };
    let verify = (tags: { tagType: string; tagValue: string }[]) => executeProgramAction(action, {
      createProgram: async () => [{ id: 77 }],
      getProgram: async () => ({
        id: 77, name: "Program", type: "Default", channel: "Web",
        folder: { value: 10, type: "Folder" }, tags,
      }),
    } as never, Number, () => {});

    await expect(verify([
      { tagType: "Department", tagValue: "Sales" },
      { tagType: "Region", tagValue: "EMEA" },
    ])).resolves.toBeUndefined();
    await expect(verify([
      { tagType: "Department", tagValue: "Marketing" },
      { tagType: "Region", tagValue: "EMEA" },
    ])).rejects.toThrow(/could not verify created program/);
    await expect(verify([
      { tagType: "Region", tagValue: "EMEA" },
      { tagType: "Region", tagValue: "EMEA" },
    ])).rejects.toThrow(/could not verify created program/);
  });

  it("still rejects a meaningful clone verification difference", async () => {
    let cloneClient = {
      cloneProgram: async () => [{ id: 77 }],
      getProgram: async () => ({
        id: 77,
        name: "Clone",
        folder: { value: 10, type: "Folder" },
        description: "Different",
      }),
    } as never;
    await expect(executeProgramAction({
      id: 1,
      type: "programClone",
      provisionalId: "~1",
      sourceId: "7",
      parentId: "10",
      name: "Clone",
      description: "Approved",
    }, cloneClient, Number, () => {})).rejects.toThrow(/could not verify created program/);
  });
});

describe("Design Studio simulation", () => {
  it("parses Marketo's documented redundant UTC timestamp suffix", () => {
    expect(parseMarketoDate("2026-04-30T21:59:16Z+0000")).toEqual(
      new Date("2026-04-30T21:59:16Z"),
    );
    expect(parseMarketoDate("2026-04-30T21:59:16+0000")).toEqual(
      new Date("2026-04-30T21:59:16Z"),
    );
  });

  it("returns a provisional handle and injects it into reads before approval", async () => {
    let { ctx, actions } = designContext({
      getEmailTemplates: async () => [],
    });
    let studio = new MarketoDesignStudioImpl(ctx);

    let created = await studio.createEmailTemplate(
      { id: "10", type: "folder" },
      {
        name: "Welcome template",
        description: "Pending",
        content: "<html>hello</html>",
      },
    ) as unknown as MarketoEmailTemplateImpl;

    expect(await created.describe()).toMatchObject({
      id: "~1",
      name: "Welcome template",
      description: "Pending",
      status: "draft",
    });
    expect((await studio.listEmailTemplates()).items).toEqual([
      expect.objectContaining({ id: "~1", name: "Welcome template" }),
    ]);
    expect(await created.getContent()).toBe("<html>hello</html>");
    expect(actions[0]).toMatchObject({
      type: "designCreate",
      asset: "emailTemplate",
      provisionalId: "~1",
      parent: { id: "10", type: "Folder" },
    });
  });

  it("overlays metadata, lifecycle, content, and deletion on remote email reads", async () => {
    let raw = {
      id: 21,
      name: "Old name",
      status: "draft",
      subject: { type: "Text", value: "Old subject" },
    };
    let { ctx, actions } = designContext({
      getEmail: async () => raw,
      getEmails: async () => [raw],
      getEmailContent: async () => [
        { htmlId: "hero", contentType: "Text", value: "Old content" },
      ],
    });
    let studio = new MarketoDesignStudioImpl(ctx);
    let email = studio.getEmail("21");

    await email.updateMetadata({ name: "New name", subject: "New subject" });
    await email.updateContent("hero", { html: "<p>New content</p>", text: "New content" });
    await email.approve();

    expect(await email.describe()).toMatchObject({
      id: "21",
      name: "New name",
      subject: "New subject",
      status: "approved",
    });
    expect(await email.getContent()).toEqual([
      { id: "hero", html: "<p>New content</p>", text: "New content" },
    ]);
    expect(actions).toContainEqual(expect.objectContaining({
      type: "designContent",
      asset: "email",
      sectionId: "hero",
      html: "<p>New content</p>",
      text: "New content",
    }));
    expect((await studio.listEmails()).items).toEqual([
      expect.objectContaining({ id: "21", name: "New name", status: "approved" }),
    ]);

    await email.delete();
    expect((await studio.listEmails()).items).toEqual([]);
    await expect(email.describe()).rejects.toThrow(/was deleted/);
  });

  it("projects form summaries without weakening internal lifecycle snapshots", async () => {
    let raw = {
      id: 51,
      name: "Signup",
      description: "Public description",
      status: "draft",
      workspace: "Default",
      locale: "en_US",
      language: "English",
      progressiveProfiling: true,
      knownVisitor: { type: "custom", template: "secret" },
      thankYouList: [{ followupType: "url", followupValue: "https://private.example" }],
      theme: "simple",
      providerExtension: "private",
    };
    let { ctx, actions } = designContext({
      getForm: async () => raw,
      getForms: async () => [raw],
      getFormFields: async () => [],
      getFormUsedBy: async () => [],
    });
    let studio = new MarketoDesignStudioImpl(ctx);
    let form = studio.getForm("51");
    let publicSummary = {
      id: "51",
      name: "Signup",
      description: "Public description",
      status: "draft",
      workspaceName: "Default",
      locale: "en_US",
      language: "English",
    };

    await expect(form.describe()).resolves.toEqual(publicSummary);
    await expect(studio.listForms()).resolves.toEqual({ items: [publicSummary] });

    await form.approve();
    expect(actions[0]).toMatchObject({
      snapshot: {
        metadata: {
          settings: {
            progressiveProfiling: true,
            knownVisitor: raw.knownVisitor,
            thankYouList: raw.thankYouList,
            theme: "simple",
          },
        },
      },
    });
    expect(JSON.stringify(actions[0])).not.toContain("providerExtension");
  });

  it("simulates snippet content without replacing an untouched rendition", async () => {
    let { ctx } = designContext({
      getSnippetContent: async () => [
        { type: "HTML", content: "<p>old</p>" },
        { type: "Text", content: "old" },
      ],
    });
    let snippet = new MarketoDesignStudioImpl(ctx).getSnippet("40");

    await snippet.updateContent({ html: "<p>new</p>" });

    expect(await snippet.getContent()).toEqual({ html: "<p>new</p>", text: "old" });
  });

  it("recursively simulates content cloned from pending templates and snippets", async () => {
    let getEmailTemplateContent = vi.fn();
    let getSnippetContent = vi.fn();
    let { ctx } = designContext({ getEmailTemplateContent, getSnippetContent });
    let studio = new MarketoDesignStudioImpl(ctx);
    let template = await studio.createEmailTemplate(
      { id: "10", type: "folder" },
      { name: "Source", content: "<html>source</html>" },
    );
    let templateClone = await studio.cloneEmailTemplate(
      (await template.describe()).id,
      "Clone",
      { id: "10", type: "folder" },
    );
    let snippet = await studio.createSnippet(
      { id: "10", type: "folder" },
      { name: "Source snippet", html: "<p>source</p>", text: "source" },
    );
    let snippetClone = await studio.cloneSnippet(
      (await snippet.describe()).id,
      "Snippet clone",
      { id: "10", type: "folder" },
    );

    expect(await templateClone.getContent()).toBe("<html>source</html>");
    expect(await snippetClone.getContent()).toEqual({ html: "<p>source</p>", text: "source" });
    expect(getEmailTemplateContent).not.toHaveBeenCalled();
    expect(getSnippetContent).not.toHaveBeenCalled();
  });

  it("resolves cloned content from the source's state at submission", async () => {
    let getEmailTemplateContent = vi.fn(async () => ({ id: 31, content: "<html>old</html>" }));
    let { ctx } = designContext({ getEmailTemplateContent }, [{
      id: 1,
      type: "designContent",
      asset: "emailTemplate",
      targetId: "31",
      content: "<html>pending</html>",
    }]);
    let studio = new MarketoDesignStudioImpl(ctx);
    await studio.getEmailTemplate("31").updateContent("<html>before</html>");
    let clone = await studio.cloneEmailTemplate(
      "31",
      "Clone",
      { id: "10", type: "folder" },
    );
    await studio.getEmailTemplate("31").updateContent("<html>later</html>");

    expect(await clone.getContent()).toBe("<html>before</html>");
    expect(getEmailTemplateContent).toHaveBeenCalledWith(31);
  });

  it("recursively simulates pending landing-page and form clone chains", async () => {
    let getLandingPageContent = vi.fn();
    let getFormFields = vi.fn();
    let { ctx, actions } = designContext({ getLandingPageContent, getFormFields });
    let studio = new MarketoDesignStudioImpl(ctx);
    let page = await studio.createLandingPage(
      { id: "10", type: "folder" },
      { name: "Page", templateId: "20" },
    );
    let pageClone = await studio.cloneLandingPage(
      (await page.describe()).id,
      "Page clone",
      { id: "10", type: "folder" },
    );
    await studio.cloneLandingPage(
      (await pageClone.describe()).id,
      "Second page clone",
      { id: "10", type: "folder" },
    );
    let form = await studio.createForm({ id: "10", type: "folder" }, { name: "Form" });
    let formClone = await studio.cloneForm(
      (await form.describe()).id,
      "Form clone",
      { id: "10", type: "folder" },
    );

    expect(await pageClone.getContent()).toEqual([]);
    expect(await formClone.getFields()).toEqual([]);
    expect(actions.filter(action =>
      action.type === "designClone" && action.asset === "landingPage"
    )).toMatchObject([{ sourceId: "~1" }, { sourceId: "~2" }]);
    expect(getLandingPageContent).not.toHaveBeenCalled();
    expect(getFormFields).not.toHaveBeenCalled();
  });

  it("queues a physical landing-page clone without snapshotting its template", async () => {
    let getLandingPage = vi.fn(async () => ({ id: 31, name: "Source", template: 20 }));
    let { ctx, actions } = designContext({ getLandingPage });
    await new MarketoDesignStudioImpl(ctx).cloneLandingPage(
      "31",
      "Clone",
      { id: "10", type: "folder" },
    );

    expect(getLandingPage).not.toHaveBeenCalled();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "designClone",
      asset: "landingPage",
      sourceId: "31",
    });
  });

  it("rejects unknown and incorrectly typed Design Studio create and metadata fields", async () => {
    let mutations = {
      createEmail: vi.fn(),
      createLandingPage: vi.fn(),
      createForm: vi.fn(),
      updateEmail: vi.fn(),
      updateLandingPage: vi.fn(),
      updateForm: vi.fn(),
    };
    let { ctx, actions } = designContext(mutations);
    let studio = new MarketoDesignStudioImpl(ctx);
    let destination = { id: "10", type: "folder" } as const;
    let emailInput = {
      name: "Email",
      templateId: "20",
      subject: "Subject",
      fromName: "Team",
      fromEmail: "team@example.com",
      replyEmail: "reply@example.com",
    };

    await expect(studio.createEmail(destination, { ...emailInput, operational: true } as never))
      .rejects.toThrow(/unsupported field: operational/);
    expect(() => studio.getEmail("21").updateMetadata({ name: "Email", published: true } as never))
      .toThrow(/unsupported field: published/);
    await expect(studio.createLandingPage(destination, {
      name: "Page", templateId: "20", customHeadHTML: "<script>x</script>",
    } as never)).rejects.toThrow(/unsupported field: customHeadHTML/);
    await expect(studio.createLandingPage(destination, {
      name: "Page", templateId: "20", enableMunchkin: true,
    } as never)).rejects.toThrow(/unsupported field: enableMunchkin/);
    expect(() => studio.getLandingPage("22").updateMetadata({ customHeadHTML: "x" } as never))
      .toThrow(/unsupported field: customHeadHTML/);
    await expect(studio.createForm(destination, {
      name: "Form", progressiveProfiling: true,
    } as never)).rejects.toThrow(/unsupported field: progressiveProfiling/);
    expect(() => studio.getForm("23").updateMetadata({ followupType: "url" } as never))
      .toThrow(/unsupported field: followupType/);
    expect(() => studio.getEmail("21").updateMetadata({ subject: false } as never))
      .toThrow(/subject.*expected union|subject must be a string/);
    expect(() => studio.createForm(destination, { name: "Form", locale: false } as never))
      .toThrow(/locale.*expected union|locale must be a string/);
    expect(() => studio.createLandingPageTemplate(destination, {
      name: "Template", enableMunchkin: "yes",
    } as never)).toThrow(/enableMunchkin.*expected union|enableMunchkin must be a boolean/);

    expect(actions).toEqual([]);
    for (let mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
  });

  it("includes pending-touched assets that upstream name and status filters exclude", async () => {
    let getEmailsByName = vi.fn(async () => []);
    let getEmail = vi.fn(async () => ({ id: 21, name: "Old", status: "draft" }));
    let { ctx } = designContext({ getEmailsByName, getEmail }, [
      { id: 1, type: "designMetadata", asset: "email", targetId: "21", patch: { name: "New" } },
      { id: 2, type: "designLifecycle", asset: "email", targetId: "21", operation: "approve", snapshot: EMPTY_CLASSIC_LIFECYCLE_SNAPSHOT },
    ]);

    expect(await new MarketoDesignStudioImpl(ctx).listEmails({ name: "New", status: "approved" }))
      .toEqual({
        items: [expect.objectContaining({ id: "21", name: "New", status: "approved" })],
        nextPageToken: undefined,
      });
    expect(getEmailsByName).toHaveBeenCalledWith("New", {
      status: "approved",
      folder: undefined,
    });
    expect(getEmail).toHaveBeenCalledWith(21);
  });

  it("does not leak a pending creation into another folder through a pending edit", async () => {
    let { ctx } = designContext({ getEmailTemplates: async () => [] }, [
      {
        id: 1,
        type: "designCreate",
        asset: "emailTemplate",
        provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        input: { name: "Pending", content: "<html>pending</html>" },
      },
      { id: 2, type: "designMetadata", asset: "emailTemplate", targetId: "~1", patch: { name: "Edited" } },
    ]);

    expect((await new MarketoDesignStudioImpl(ctx).listEmailTemplates({
      folder: { id: "11", type: "folder" },
    })).items).toEqual([]);
  });

  it("does not leak touched existing assets into an unresolved provisional folder", async () => {
    let getEmail = vi.fn();
    let { ctx } = designContext({ getEmails: async () => [], getEmail }, [
      { id: 1, type: "designMetadata", asset: "email", targetId: "21", patch: { name: "Edited" } },
    ]);

    let result = await new MarketoDesignStudioImpl(ctx).listEmails({
      folder: { id: "~1", type: "folder" },
    });

    expect(result.items).toEqual([]);
    expect(getEmail).not.toHaveBeenCalled();
  });

  it("keeps every page bounded without skipping upstream rows after provisional inserts", async () => {
    let getEmailTemplates = vi.fn(async ({ offset = 0 }: { offset?: number }) =>
      offset === 0 ? [{ id: 1, name: "One" }, { id: 2, name: "Two" }] : []);
    let { ctx } = designContext({ getEmailTemplates }, [{
      id: 1,
      type: "designCreate",
      asset: "emailTemplate",
      provisionalId: "~1",
      parent: { id: "10", type: "Folder" },
      input: { name: "Pending", content: "<html></html>" },
    }]);
    let studio = new MarketoDesignStudioImpl(ctx);
    let seen: string[] = [];
    let token: string | undefined;
    do {
      let page = await studio.listEmailTemplates({ maxResults: 2, pageToken: token });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map(item => item.id));
      token = page.nextPageToken;
    } while (token);

    expect(seen).toEqual(["~1", "1", "2"]);
    expect(getEmailTemplates.mock.calls.map(([options]) => options.offset)).toEqual([0, 0, 2]);
  });

  it("bounds pending candidate reads to the requested page size", async () => {
    let getEmail = vi.fn(async (id: number) => ({ id, name: `Email ${id}` }));
    let { ctx } = designContext({ getEmails: async () => [], getEmail }, [
      { id: 1, type: "designMetadata", asset: "email", targetId: "21", patch: { name: "One" } },
      { id: 2, type: "designMetadata", asset: "email", targetId: "22", patch: { name: "Two" } },
      { id: 3, type: "designMetadata", asset: "email", targetId: "23", patch: { name: "Three" } },
    ]);
    let studio = new MarketoDesignStudioImpl(ctx);

    let first = await studio.listEmails({ maxResults: 1 });
    expect(first.items).toEqual([expect.objectContaining({ id: "21", name: "One" })]);
    expect(getEmail).toHaveBeenCalledTimes(1);

    await studio.listEmails({ maxResults: 1, pageToken: first.nextPageToken });
    expect(getEmail).toHaveBeenCalledTimes(2);
  });

  it("keeps upstream pagination stable when maxResults changes", async () => {
    let records = Array.from({ length: 4 }, (_, index) => ({ id: index + 1, name: `Template ${index + 1}` }));
    let getEmailTemplates = vi.fn(async ({ offset = 0, maxReturn = 20 }: {
      offset?: number;
      maxReturn?: number;
    }) => records.slice(offset, offset + maxReturn));
    let { ctx } = designContext({ getEmailTemplates }, [{
      id: 1,
      type: "designCreate",
      asset: "emailTemplate",
      provisionalId: "~1",
      parent: { id: "10", type: "Folder" },
      input: { name: "Pending", content: "<html></html>" },
    }]);
    let studio = new MarketoDesignStudioImpl(ctx);

    let first = await studio.listEmailTemplates({ maxResults: 3 });
    let second = await studio.listEmailTemplates({ maxResults: 1, pageToken: first.nextPageToken });
    let third = await studio.listEmailTemplates({ maxResults: 2, pageToken: second.nextPageToken });

    expect([...first.items, ...second.items, ...third.items].map(item => item.id))
      .toEqual(["~1", "1", "2", "3", "4"]);
    expect(getEmailTemplates.mock.calls.map(([options]) => [options.offset, options.maxReturn]))
      .toEqual([[0, 3], [0, 3], [3, 3]]);
  });

  it("advances by raw upstream rows when pending overlays remove results", async () => {
    let records = Array.from({ length: 3 }, (_, index) => ({ id: index + 1, name: `Email ${index + 1}` }));
    let getEmails = vi.fn(async ({ offset = 0, maxReturn = 20 }: {
      offset?: number;
      maxReturn?: number;
    }) => records.slice(offset, offset + maxReturn));
    let { ctx } = designContext({
      getEmails,
      getEmail: async () => records[0],
    }, [{ id: 1, type: "designLifecycle", asset: "email", targetId: "1", operation: "delete", snapshot: EMPTY_CLASSIC_LIFECYCLE_SNAPSHOT }]);
    let studio = new MarketoDesignStudioImpl(ctx);

    let first = await studio.listEmails({ maxResults: 2 });
    let second = await studio.listEmails({ maxResults: 2, pageToken: first.nextPageToken });

    expect([...first.items, ...second.items].map(item => item.id)).toEqual(["2", "3"]);
    expect(getEmails.mock.calls.map(([options]) => options.offset)).toEqual([0, 2]);
  });

  it("keeps a provisional asset masked if it resolves between pages", async () => {
    let records = Array.from({ length: 3 }, (_, index) => ({ id: index + 1, name: `Email ${index + 1}` }));
    let getEmails = vi.fn(async ({ offset = 0, maxReturn = 20 }: {
      offset?: number;
      maxReturn?: number;
    }) => records.slice(offset, offset + maxReturn));
    let { ctx, resolved } = designContext({ getEmails }, [{
      id: 1,
      type: "designMetadata",
      asset: "email",
      targetId: "~1",
      patch: { name: "Pending" },
    }]);
    let studio = new MarketoDesignStudioImpl(ctx);

    let first = await studio.listEmails({ maxResults: 1 });
    resolved.set("~1", 2);
    let second = await studio.listEmails({ maxResults: 1, pageToken: first.nextPageToken });
    let third = await studio.listEmails({ maxResults: 1, pageToken: second.nextPageToken });

    expect([...first.items, ...second.items, ...third.items].map(item => item.id)).toEqual(["1", "3"]);
  });

  it("deduplicates provisional and resolved ids in pending list overlays", async () => {
    let getEmail = vi.fn(async () => ({ id: 21, name: "Original" }));
    let { ctx, resolved } = designContext({ getEmails: async () => [], getEmail }, [
      { id: 1, type: "designMetadata", asset: "email", targetId: "~1", patch: { name: "First" } },
      { id: 2, type: "designMetadata", asset: "email", targetId: "21", patch: { name: "Second" } },
    ]);
    resolved.set("~1", 21);

    let result = await new MarketoDesignStudioImpl(ctx).listEmails();

    expect(result.items).toEqual([expect.objectContaining({ id: "~1", name: "Second" })]);
    expect(getEmail).toHaveBeenCalledTimes(1);
  });

  it("resolves at most one pending folder candidate per page", async () => {
    let getFolder = vi.fn(async (id: number) => ({
      id, name: `Folder ${id}`, folderId: { id, type: "Folder" }, parent: { id: 10 },
    }));
    let { ctx } = designContext({ getFolders: async () => [], getFolder }, [
      { id: 1, type: "designMetadata", asset: "folder", targetId: "21", patch: { name: "One" } },
      { id: 2, type: "designMetadata", asset: "folder", targetId: "22", patch: { name: "Two" } },
      { id: 3, type: "designMetadata", asset: "folder", targetId: "23", patch: { name: "Three" } },
    ]);

    let first = await new MarketoDesignStudioImpl(ctx).listFolders({
      root: { id: "10", type: "folder" },
      maxResults: 200,
    });

    expect(first.items).toEqual([expect.objectContaining({ id: "21", name: "One" })]);
    expect(first.nextPageToken).toEqual(expect.any(String));
    expect(getFolder).toHaveBeenCalledTimes(1);
  });

  it("binds page tokens to their list query", async () => {
    let { ctx } = designContext({
      getEmails: async () => [{ id: 1, name: "One" }, { id: 2, name: "Two" }],
      getFiles: async () => [],
    });
    let studio = new MarketoDesignStudioImpl(ctx);
    let first = await studio.listEmails({ maxResults: 1 });

    await expect(studio.listFiles({ maxResults: 1, pageToken: first.nextPageToken }))
      .rejects.toThrow(/Invalid Design Studio page token/);
  });

  it("keeps Design Studio offsets and masked IDs opaque and rejects replay", async () => {
    let { ctx } = designContext({
      getEmails: async ({ offset = 0 }: { offset?: number }) => offset === 0
        ? [{ id: 1, name: "One" }, { id: 2, name: "Two" }]
        : [],
    });
    let studio = new MarketoDesignStudioImpl(ctx);
    let first = await studio.listEmails({ maxResults: 1 });
    let token = first.nextPageToken!;

    expect(token).not.toContain("offset");
    expect(token).not.toContain("masked");
    let tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    await expect(studio.listEmails({ maxResults: 1, pageToken: tampered }))
      .rejects.toThrow(/Invalid Design Studio page token/);
    await expect(studio.listEmails({ maxResults: 1, pageToken: token }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ id: "2" })] });
    await expect(studio.listEmails({ maxResults: 1, pageToken: token }))
      .rejects.toThrow(/Invalid Design Studio page token/);
  });

  it("pages by raw rows when a folder filter is applied locally", async () => {
    let records = [
      { id: 1, name: "Same", folder: { id: 11, type: "Folder" } },
      { id: 2, name: "Same", folder: { id: 10, type: "Folder" } },
    ];
    let getLandingPagesByName = vi.fn(async (_name: string, { offset = 0, maxReturn = 20 }: {
      offset?: number;
      maxReturn?: number;
    }) => records.slice(offset, offset + maxReturn));
    let { ctx } = designContext({ getLandingPagesByName });
    let studio = new MarketoDesignStudioImpl(ctx);

    let first = await studio.listLandingPages({
      name: "Same",
      folder: { id: "10", type: "folder" },
      maxResults: 1,
    });
    let second = await studio.listLandingPages({
      name: "Same",
      folder: { id: "10", type: "folder" },
      maxResults: 1,
      pageToken: first.nextPageToken,
    });

    expect(first.items).toEqual([]);
    expect(second.items).toEqual([expect.objectContaining({ id: "2" })]);
    expect(getLandingPagesByName.mock.calls.map(([, options]) => options.offset)).toEqual([0, 1]);
  });

  it("loads pending actions once while overlaying a list page", async () => {
    let { ctx } = designContext({
      getEmails: async () => Array.from({ length: 20 }, (_, index) => ({
        id: index + 1,
        name: `Email ${index + 1}`,
      })),
      getEmail: async (id: number) => ({ id, name: `Email ${id}` }),
    }, [{ id: 1, type: "designMetadata", asset: "email", targetId: "1", patch: { name: "Edited" } }]);
    let pending = vi.fn(ctx.pending);
    ctx.pending = pending;

    let result = await new MarketoDesignStudioImpl(ctx).listEmails({ maxResults: 20 });

    expect(result.items).toHaveLength(20);
    expect(result.items[0]).toMatchObject({ id: "1", name: "Edited" });
    expect(pending).toHaveBeenCalledTimes(1);
  });

  it("does not read or mutate Marketo before create and clone approval", async () => {
    let createEmail = vi.fn();
    let cloneEmail = vi.fn();
    let getEmail = vi.fn();
    let { ctx, actions } = designContext({ createEmail, cloneEmail, getEmail });
    let studio = new MarketoDesignStudioImpl(ctx);

    await studio.createEmail(
      { id: "10", type: "program" },
      {
        name: "Welcome",
        templateId: "20",
        subject: "Hello",
        fromName: "Team",
        fromEmail: "team@example.com",
        replyEmail: "reply@example.com",
      },
    );
    await studio.cloneEmail("30", "Welcome copy", { id: "10", type: "program" });

    expect(createEmail).not.toHaveBeenCalled();
    expect(cloneEmail).not.toHaveBeenCalled();
    expect(getEmail).not.toHaveBeenCalled();
    expect(actions.map(action => action.type)).toEqual(["designCreate", "designClone"]);
  });

  it("rejects payload limits before submission or provisional injection", async () => {
    let { ctx, actions } = designContext({
      getEmailTemplates: async () => [],
      getFiles: async () => [],
    });
    let studio = new MarketoDesignStudioImpl(ctx);
    let destination = { id: "10", type: "folder" } as const;

    await expect(studio.createEmailTemplate(destination, {
      name: "Too large",
      content: "x".repeat(512 * 1024 + 1),
    })).rejects.toThrow(/must not exceed 524288 UTF-8 bytes/);
    await expect(studio.createFile(destination, {
      name: "large.bin",
      mimeType: "application/octet-stream",
      data: new Uint8Array(1024 * 1024),
      description: "d".repeat(300 * 1024),
    })).rejects.toThrow(/complete action payload must not exceed 1310720 bytes/);

    expect(actions).toEqual([]);
    expect((await studio.listEmailTemplates()).items).toEqual([]);
    expect((await studio.listFiles()).items).toEqual([]);
  });

  it("computes file approval details from the submitted bytes", async () => {
    let { ctx, actions } = designContext({});
    await new MarketoDesignStudioImpl(ctx).createFile(
      { id: "10", type: "folder" },
      {
        name: "note.txt",
        mimeType: "TEXT/PLAIN",
        data: new TextEncoder().encode("first"),
      },
    );

    let action = actions[0]!;
    expect(action).toMatchObject({
      type: "designCreate",
      input: {
        mimeType: "text/plain",
        sha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
      },
    });
    let description = describeAction(action);
    expect(description.description).toContain("mimeType:\n\n    text/plain");
    expect(description.description).toContain("byteCount:\n\n    5");
    expect(description.description).toContain(
      "sha256:\n\n    a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
    );
  });

  it("normalizes documented nested email renditions and landing-page content", async () => {
    let { ctx } = designContext({
      getEmailContent: async () => [{
        htmlId: "hero",
        value: [
          { type: "HTML", value: { value: "<p>Hero</p>" } },
          { contentType: "Text", content: "Hero" },
        ],
      }],
      getLandingPageContent: async () => [
        { id: 1, type: "text", content: { value: "Hello" } },
        { id: "2", type: "html", content: [{ value: "<p>A</p>" }, { value: "<p>B</p>" }] },
      ],
    });
    let studio = new MarketoDesignStudioImpl(ctx);

    expect(await studio.getEmail("21").getContent()).toEqual([
      { id: "hero", html: "<p>Hero</p>", text: "Hero" },
    ]);
    expect(await studio.getLandingPage("22").getContent()).toEqual([
      { id: "1", type: "text", content: "Hello" },
      { id: "2", type: "html", content: "<p>A</p><p>B</p>" },
    ]);
  });

  it("normalizes Marketo's combined email HTML and text section shape", async () => {
    let { ctx } = designContext({
      getEmailContent: async () => [{
        htmlId: "hero",
        value: [{ type: "Text", value: "<p>Hero</p>", textValue: "Hero" }],
      }],
    });
    expect(await new MarketoDesignStudioImpl(ctx).getEmail("21").getContent()).toEqual([
      { id: "hero", html: "<p>Hero</p>", text: "Hero" },
    ]);
  });

  it("rejects malformed list ids and mismatched single-asset ids", async () => {
    let malformed = new MarketoDesignStudioImpl(designContext({
      getEmails: async () => [{ id: 0, name: "Bad" }],
    }).ctx);
    await expect(malformed.listEmails()).rejects.toThrow(/invalid id/);

    let mismatched = new MarketoDesignStudioImpl(designContext({
      getEmail: async () => ({ id: 22, name: "Wrong" }),
    }).ctx);
    await expect(mismatched.getEmail("21").describe()).rejects.toThrow(/22 when 21 was requested/);
  });

  it("rejects mismatched template-content ids", async () => {
    let { ctx } = designContext({
      getEmailTemplateContent: async () => ({ id: 32, content: "wrong" }),
      getLandingPageTemplateContent: async () => ({ id: 42, content: "wrong" }),
    });
    let studio = new MarketoDesignStudioImpl(ctx);

    await expect(studio.getEmailTemplate("31").getContent()).rejects.toThrow(/32 when 31 was requested/);
    await expect(studio.getLandingPageTemplate("41").getContent()).rejects.toThrow(/42 when 41 was requested/);
  });

  it("requires exact template reads to contain string content before observing", async () => {
    for (let response of [undefined, { id: 31 }, { id: 31, content: null }]) {
      let notes: string[] = [];
      let { ctx } = designContext({ getEmailTemplateContent: async () => response as never });
      ctx.observe = async (title, description) => { notes.push(title, description); };
      await expect(new MarketoDesignStudioImpl(ctx).getEmailTemplate("31").getContent())
        .rejects.toThrow(/template content|content field/);
      expect(notes).toEqual([]);
    }

    let notes: string[] = [];
    let { ctx } = designContext({ getLandingPageTemplateContent: async () => ({ id: 41, content: "" }) });
    ctx.observe = async (title, description) => { notes.push(title, description); };
    await expect(new MarketoDesignStudioImpl(ctx).getLandingPageTemplate("41").getContent()).resolves.toBe("");
    expect(notes.join(" ")).toMatch(/template content/);
  });

  it("blocks deleted content reads without fetching the source", async () => {
    let getEmailContent = vi.fn();
    let { ctx } = designContext({ getEmailContent }, [{
      id: 1,
      type: "designLifecycle",
      asset: "email",
      targetId: "21",
      operation: "delete",
      snapshot: EMPTY_CLASSIC_LIFECYCLE_SNAPSHOT,
    }]);

    await expect(new MarketoDesignStudioImpl(ctx).getEmail("21").getContent())
      .rejects.toThrow(/was deleted/);
    expect(getEmailContent).not.toHaveBeenCalled();
  });

  it("returns empty content for a pending new landing-page template", async () => {
    let getLandingPageTemplateContent = vi.fn();
    let { ctx } = designContext({ getLandingPageTemplateContent });
    let template = await new MarketoDesignStudioImpl(ctx).createLandingPageTemplate(
      { id: "10", type: "folder" },
      { name: "Blank" },
    ) as unknown as MarketoLandingPageTemplateImpl;

    expect(await template.getContent()).toBe("");
    expect(getLandingPageTemplateContent).not.toHaveBeenCalled();
  });

  it("locally pages complete unpaged exact-name asset responses", async () => {
    let getEmailsByName = vi.fn(async () => [
      { id: 1, name: "Same" },
      { id: 2, name: "Same" },
      { id: 3, name: "Same" },
    ]);
    let { ctx } = designContext({ getEmailsByName });
    let studio = new MarketoDesignStudioImpl(ctx);

    let first = await studio.listEmails({ name: "Same", maxResults: 2 });
    expect(first).toEqual({
      items: [expect.objectContaining({ id: "1" }), expect.objectContaining({ id: "2" })],
      nextPageToken: expect.any(String),
    });
    expect(await studio.listEmails({ name: "Same", maxResults: 2, pageToken: first.nextPageToken }))
      .toEqual({ items: [expect.objectContaining({ id: "3" })], nextPageToken: undefined });
    expect(getEmailsByName).toHaveBeenCalledTimes(2);
  });

  it("locally pages complete unpaged exact-name folder responses", async () => {
    let getFoldersByName = vi.fn(async () => [
      { id: 1, name: "Same", folderId: { id: 1, type: "Folder" } },
      { id: 2, name: "Same", folderId: { id: 2, type: "Folder" } },
      { id: 3, name: "Same", folderId: { id: 3, type: "Folder" } },
    ]);
    let studio = new MarketoDesignStudioImpl(designContext({ getFoldersByName }).ctx);
    let ids: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      let page = await studio.listFolders({ name: "Same", maxResults: 1, pageToken: token });
      ids.push(...page.items.map(item => item.id));
      token = page.nextPageToken;
      pages++;
    } while (token && pages < 10);

    expect(ids).toEqual(["1", "2", "3"]);
    expect(pages).toBe(3);
    expect(getFoldersByName).toHaveBeenCalledTimes(6);
  });

  it("overlays pending folder renames and deletions in rooted exact-name lists", async () => {
    let getFoldersByName = vi.fn(async () => [{
      id: 22, name: "New", folderId: { id: 22, type: "Folder" }, parent: { id: 10 },
    }]);
    let getFolder = vi.fn(async (id: number) => ({
      id, name: "Old", folderId: { id, type: "Folder" }, parent: { id: 10 },
    }));
    let { ctx } = designContext({ getFoldersByName, getFolder }, [
      { id: 1, type: "designMetadata", asset: "folder", targetId: "21", patch: { name: "New" } },
      { id: 2, type: "designDeleteFolder", targetId: "22" },
    ]);

    expect(await new MarketoDesignStudioImpl(ctx).listFolders({
      name: "New", root: { id: "10", type: "folder" },
    })).toEqual({
      items: [expect.objectContaining({ id: "21", name: "New" })],
      nextPageToken: undefined,
    });
    expect(getFolder).toHaveBeenCalledWith(21, "Folder");
  });

  it("includes pending folder descendants to the requested rooted depth", async () => {
    let { ctx, resolved } = designContext({
      getFolders: async () => [],
      getFoldersByName: async () => [],
    }, [
      {
        id: 1,
        type: "designCreate",
        asset: "folder",
        provisionalId: "~1",
        parent: { id: "~9", type: "Folder" },
        input: { name: "Child" },
      },
      {
        id: 2,
        type: "designCreate",
        asset: "folder",
        provisionalId: "~2",
        parent: { id: "~1", type: "Folder" },
        input: { name: "Grandchild" },
      },
      {
        id: 3,
        type: "designCreate",
        asset: "folder",
        provisionalId: "~3",
        parent: { id: "~2", type: "Folder" },
        input: { name: "Great-grandchild" },
      },
    ]);
    resolved.set("~9", 10);
    let studio = new MarketoDesignStudioImpl(ctx);
    let root = { id: "10", type: "folder" } as const;

    expect((await studio.listFolders({ root, maxDepth: 1 })).items.map(folder => folder.id))
      .toEqual(["~1"]);
    expect((await studio.listFolders({ root, maxDepth: 2 })).items.map(folder => folder.id))
      .toEqual(["~1", "~2"]);
    expect((await studio.listFolders({ root })).items.map(folder => folder.id))
      .toEqual(["~1", "~2"]);
    expect((await studio.listFolders({ root, maxDepth: 3 })).items.map(folder => folder.id))
      .toEqual(["~1", "~2", "~3"]);
    expect((await studio.listFolders({ root, maxDepth: 2, name: "Grandchild" })).items.map(folder => folder.id))
      .toEqual(["~2"]);
  });

  it("validates pending folder response ids and root membership", async () => {
    let outside = new MarketoDesignStudioImpl(designContext({
      getFoldersByName: async () => [],
      getFolder: async (id: number) => id === 21
        ? { id, name: "Old", folderId: { id, type: "Folder" }, parent: { id: 11 } }
        : { id, name: "Outside root", folderId: { id, type: "Folder" } },
    }, [{ id: 1, type: "designMetadata", asset: "folder", targetId: "21", patch: { name: "New" } }]).ctx);
    expect((await outside.listFolders({ name: "New", root: { id: "10", type: "folder" } })).items)
      .toEqual([]);

    let mismatched = new MarketoDesignStudioImpl(designContext({
      getFoldersByName: async () => [],
      getFolder: async () => ({
        id: 99, name: "Wrong", folderId: { id: 99, type: "Folder" }, parent: { id: 10 },
      }),
    }, [{ id: 1, type: "designMetadata", asset: "folder", targetId: "21", patch: { name: "New" } }]).ctx);
    await expect(mismatched.listFolders({ name: "New" })).rejects.toThrow(/99 when 21 was requested/);
  });

  it("validates folder depth and workspace before calling Marketo", async () => {
    let getFolders = vi.fn();
    let getFoldersByName = vi.fn();
    let studio = new MarketoDesignStudioImpl(designContext({ getFolders, getFoldersByName }).ctx);
    for (let maxDepth of [0, 21, 1.5, NaN]) {
      await expect(studio.listFolders({ maxDepth })).rejects.toThrow(/maxDepth must be an integer between 1 and 20/);
    }
    for (let workspace of ["", "   ", "x".repeat(101)]) {
      await expect(studio.listFolders({ workspace })).rejects.toThrow(/workspace must be a non-empty string/);
    }
    expect(() => studio.listFolders({ workspace: 12 as never })).toThrow(/expected union/);
    expect(getFolders).not.toHaveBeenCalled();
    expect(getFoldersByName).not.toHaveBeenCalled();
  });

  it("preserves Program type for handles and rooted by-name folder lookups", async () => {
    let getFolder = vi.fn(async (id: number) => ({
      id,
      name: "Program",
      folderId: { id, type: "Program" },
      folderType: "Folder",
    }));
    let getFoldersByName = vi.fn(async (_name: string, _options: { type?: "Folder" | "Program" }) => []);
    let { ctx, actions } = designContext({ getFolder, getFoldersByName });
    let studio = new MarketoDesignStudioImpl(ctx);

    let program = studio.getFolder("10", "folder");
    expect((await program.describe()).type).toBe("program");
    await expect(program.updateMetadata({ name: "Renamed" })).rejects.toThrow(/Program folders cannot be edited/);
    await expect(program.delete()).rejects.toThrow(/Program folders cannot be deleted/);
    expect(actions).toEqual([]);
    await studio.listFolders({ name: "Child", root: { id: "10", type: "program" } });
    expect(getFoldersByName.mock.calls.map(([, options]) => options)).toEqual([
      { type: "Folder", root: { id: 10, type: "Program" }, workspace: undefined },
      { type: "Program", root: { id: 10, type: "Program" }, workspace: undefined },
    ]);
  });

  it("accepts only explicit folder discriminators and gives nested types precedence", async () => {
    let fallback = new MarketoDesignStudioImpl(designContext({
      getFolder: async id => ({ id, name: "Program", folderType: "Program" }),
    }).ctx).getFolder("10", "folder");
    expect((await fallback.describe()).type).toBe("program");
    await expect(fallback.delete()).rejects.toThrow(/Program folders cannot be deleted/);

    let nested = new MarketoDesignStudioImpl(designContext({
      getFolder: async id => ({ id, name: "Folder", folderId: { id, type: "Folder" }, folderType: "Program" }),
    }).ctx).getFolder("10", "program");
    expect((await nested.describe()).type).toBe("folder");

    for (let response of [
      { id: 10, name: "Missing" },
      { id: 10, name: "Unknown", folderId: { id: 10, type: "Unknown" } },
      { id: 10, name: "Invalid nested", folderId: {}, folderType: "Program" },
      { id: 10, name: "Empty", folderType: "" },
    ]) {
      let { ctx, actions } = designContext({ getFolder: async () => response });
      let folder = new MarketoDesignStudioImpl(ctx).getFolder("10", "folder");
      await expect(folder.updateMetadata({ name: "Unsafe" })).rejects.toThrow(/invalid type/);
      await expect(folder.delete()).rejects.toThrow(/invalid type/);
      expect(actions).toEqual([]);
    }
  });

  it("omits preHeader from create but carries it on update", async () => {
    let { ctx, actions } = designContext({});
    let studio = new MarketoDesignStudioImpl(ctx);
    type CreateEmailInput = Parameters<MarketoDesignStudioImpl["createEmail"]>[1];
    expectTypeOf<CreateEmailInput>().not.toHaveProperty("preHeader");

    await studio.createEmail(
      { id: "10", type: "folder" },
      {
        name: "Welcome",
        templateId: "20",
        subject: "Hello",
        fromName: "Team",
        fromEmail: "team@example.com",
        replyEmail: "reply@example.com",
      },
    );
    await studio.getEmail("21").updateMetadata({ preHeader: "Preview" });
    expect(actions[0]).toMatchObject({ type: "designCreate", input: { name: "Welcome" } });
    expect((actions[0] as Extract<DesignStudioAction, { type: "designCreate" }>).input)
      .not.toHaveProperty("preHeader");
    expect(actions[1]).toMatchObject({
      type: "designMetadata",
      asset: "email",
      patch: { preHeader: "Preview" },
    });
  });

  it("does not expose broad create or clone authority on forgeable folder handles", () => {
    let folder = new MarketoDesignStudioImpl(designContext({}).ctx).getFolder("10", "folder");
    expectTypeOf(folder).not.toHaveProperty("createEmail");
    expectTypeOf(folder).not.toHaveProperty("cloneEmail");
    expect(folder).not.toHaveProperty("createEmail");
    expect(folder).not.toHaveProperty("cloneEmail");
  });
});

describe("custom object normalization", () => {
  afterEach(() => vi.unstubAllGlobals());

  // A custom object field names itself at the top level, unlike a person field, which nests the
  // API name under `rest`/`soap`. Reading it as a person field yields a field with no name.
  const SCHEMA = {
    name: "orderStatus",
    displayName: "Order Status",
    dedupeFields: ["sourceID", "leadID"],
    searchableFields: [["sourceID"], ["sourceID", "leadID"], ["marketoGUID"]],
    fields: [
      { name: "createdAt", displayName: "Created At", dataType: "datetime", updateable: false },
      { name: "sourceID", displayName: "Source ID", dataType: "string", updateable: true },
      { name: "leadID", displayName: "Lead ID", dataType: "integer", updateable: true },
    ],
  };

  it("keeps the API name, so fields can actually be requested", async () => {
    let object = new MarketoCustomObjectImpl(
      stubContext({ describeCustomObject: async () => SCHEMA }), "orderStatus");
    let schema = await object.describe();
    expect(schema.fields.map(f => f.name)).toEqual(["createdAt", "sourceID", "leadID"]);
    expect(schema.fields.every(f => f.name !== "")).toBe(true);
  });

  it("derives readOnly from `updateable` and flags searchable fields", async () => {
    let object = new MarketoCustomObjectImpl(
      stubContext({ describeCustomObject: async () => SCHEMA }), "orderStatus");
    let schema = await object.describe();
    let byName = new Map(schema.fields.map(f => [f.name, f]));
    expect(byName.get("createdAt")?.readOnly).toBe(true);
    expect(byName.get("sourceID")?.readOnly).toBe(false);
    expect(byName.get("sourceID")?.searchable).toBe(true);
    expect(byName.get("leadID")?.searchable).toBe(false);
    expect(byName.get("createdAt")?.searchable).toBe(false);
    expect(schema.searchableFields).toEqual(["sourceID", "marketoGUID"]);
    expect(schema.searchableFieldGroups).toEqual([
      ["sourceID"], ["sourceID", "leadID"], ["marketoGUID"],
    ]);
  });

  it("queries custom objects by complete compound dedupe keys", async () => {
    let requests: { apiName: string; input: Record<string, unknown>[]; fields?: string[] }[] = [];
    let object = new MarketoCustomObjectImpl(stubContext({
      describeCustomObject: async () => SCHEMA,
      queryCustomObjectByDedupeKeys: async (apiName, input, fields) => {
        requests.push({ apiName, input, fields });
        return [{
          marketoGUID: "g1",
          sourceID: "source-1",
          leadID: 7,
          status: "paid",
          contactEmail: "private@example.com",
          unsolicited: "hidden",
        }];
      },
    }), "orderStatus");

    await expect(object.queryByDedupeKeys([
      { sourceID: "source-1", leadID: 7, ignored: "not sent" },
    ], ["status"])).resolves.toEqual([{ marketoGUID: "g1", status: "paid" }]);
    expect(requests).toEqual([{
      apiName: "orderStatus",
      input: [{ sourceID: "source-1", leadID: 7 }],
      fields: ["status", "sourceID", "leadID"],
    }]);
    await expect(object.queryByDedupeKeys([{ sourceID: "source-1" }]))
      .rejects.toThrow(/leadID/);
  });

  it("rejects custom-object rows outside scalar and compound filter keys before observation", async () => {
    let notes: string[] = [];
    let scalar = new MarketoCustomObjectImpl(stubContext({
      queryCustomObject: async () => [{ marketoGUID: "g1", sourceID: "other" }],
    }, notes), "orderStatus");
    await expect(scalar.query("sourceID", ["requested"], ["status"]))
      .rejects.toThrow(/outside the requested filter/);
    expect(notes).toEqual([]);

    let compound = new MarketoCustomObjectImpl(stubContext({
      describeCustomObject: async () => SCHEMA,
      queryCustomObjectByDedupeKeys: async () => [
        { marketoGUID: "g1", sourceID: "source-1", leadID: 8 },
      ],
    }, notes), "orderStatus");
    await expect(compound.queryByDedupeKeys([{ sourceID: "source-1", leadID: 7 }], ["status"]))
      .rejects.toThrow(/outside the requested dedupe keys/);
    expect(notes).toEqual([]);
  });

  it.each([
    ["missing", [{ sourceID: "source-1" }]],
    ["empty", [{ marketoGUID: "   ", sourceID: "source-1" }]],
    ["duplicate", [
      { marketoGUID: "g1", sourceID: "source-1" },
      { marketoGUID: "g1", sourceID: "source-1" },
    ]],
  ])("rejects %s custom-object GUIDs before observation", async (_label, rows) => {
    let notes: string[] = [];
    let scalar = new MarketoCustomObjectImpl(stubContext({
      queryCustomObject: async () => rows,
    }, notes), "orderStatus");
    await expect(scalar.query("sourceID", ["source-1"])).rejects.toThrow(/marketoGUID/);

    let compound = new MarketoCustomObjectImpl(stubContext({
      describeCustomObject: async () => SCHEMA,
      queryCustomObjectByDedupeKeys: async () => rows,
    }, notes), "orderStatus");
    await expect(compound.queryByDedupeKeys([{ sourceID: "source-1", leadID: 7 }]))
      .rejects.toThrow(/marketoGUID/);
    expect(notes).toEqual([]);
  });

  it("uses omitted scalar filter fields internally without widening the public projection", async () => {
    let requestedFields: string[] | undefined;
    let object = new MarketoCustomObjectImpl(stubContext({
      queryCustomObject: async (_apiName, _field, _values, fields) => {
        requestedFields = fields;
        return [{
          marketoGUID: "g1",
          sourceID: "source-1",
          status: "paid",
          contactEmail: "private@example.com",
          unsolicited: "hidden",
        }];
      },
    }), "orderStatus");

    await expect(object.query("sourceID", ["source-1"], ["status"]))
      .resolves.toEqual([{ marketoGUID: "g1", status: "paid" }]);
    expect(requestedFields).toEqual(["status", "sourceID"]);
  });

  it("deletes GUID-only records explicitly by marketoGUID", async () => {
    let submitted: MarketoActionInput[] = [];
    let ctx = makeSessionContext({
      client: async () => ({}) as MarketoClient,
      approvalQueue: {} as never,
      submit: async (action: MarketoActionInput) => void submitted.push(action),
    });
    let object = new MarketoCustomObjectImpl(ctx, "orderStatus");

    await object.delete([{ marketoGUID: "guid-1", ignored: "secret" }]);
    expect(submitted).toEqual([{
      type: "customObjectDelete",
      apiName: "orderStatus",
      deleteBy: "idField",
      records: [{ marketoGUID: "guid-1" }],
    }]);
    await expect(object.delete([{ marketoGUID: "guid-2" }, { sourceID: "source" }]))
      .rejects.toThrow(/entirely by marketoGUID/);
    await expect(object.delete([{ marketoGUID: "" }])).rejects.toThrow(/non-empty string/);
    expect(submitted).toHaveLength(1);
  });

  it("requires every schema dedupe field before submitting a custom-object delete", async () => {
    let submitted: MarketoActionInput[] = [];
    let object = new MarketoCustomObjectImpl(makeSessionContext({
      client: async () => ({ describeCustomObject: async () => SCHEMA }) as unknown as MarketoClient,
      approvalQueue: {} as never,
      submit: async action => void submitted.push(action),
    }), "orderStatus");

    await expect(object.delete([{ sourceID: "source-1" }])).rejects.toThrow(/leadID/);
    await expect(object.delete([{ sourceID: "source-1", leadID: null }])).rejects.toThrow(/leadID/);
    expect(submitted).toEqual([]);

    await object.delete([{ sourceID: "source-1", leadID: 7, ignored: "preserved" }]);
    expect(submitted).toEqual([{
      type: "customObjectDelete",
      apiName: "orderStatus",
      deleteBy: "dedupeFields",
      records: [{ sourceID: "source-1", leadID: 7, ignored: "preserved" }],
    }]);
  });

  it("sends GUID deletion using Marketo's idField mode", async () => {
    let body: unknown;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ success: true, result: [{ seq: 0, marketoGUID: "guid-1", status: "deleted" }] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });

    await client.deleteCustomObject("orderStatus", [{ marketoGUID: "guid-1" }], "idField");

    expect(body).toEqual({ deleteBy: "idField", input: [{ marketoGUID: "guid-1" }] });
  });

  it("describes legacy queued custom-object deletes as dedupe-field actions", () => {
    let description = describeAction({
      id: 1,
      type: "customObjectDelete",
      apiName: "orderStatus",
      records: [{ sourceID: "source-1" }],
    } as unknown as MarketoAction);
    expect(description.description).toContain("by dedupeFields");
    expect(description.description).not.toContain("undefined");
  });

  it("executes new and legacy custom-object deletes with the correct mode", async () => {
    let modes: string[] = [];
    let client = {
      deleteCustomObject: async (_apiName: string, _records: Record<string, unknown>[], mode: string) => {
        modes.push(mode);
        return [];
      },
    } as unknown as MarketoClient;
    await executeAction({
      id: 1,
      type: "customObjectDelete",
      apiName: "orderStatus",
      records: [{ marketoGUID: "guid-1" }],
      deleteBy: "idField",
    }, client);
    await executeAction({
      id: 2,
      type: "customObjectDelete",
      apiName: "orderStatus",
      records: [{ sourceID: "source-1" }],
    } as unknown as Parameters<typeof executeAction>[0], client);

    expect(modes).toEqual(["idField", "dedupeFields"]);
  });
});

describe("activity normalization", () => {
  it("uses valid Marketo GUID identity or a positive numeric id", async () => {
    let session = new MarketoSessionImpl(stubContext({
      getPagingToken: async () => "page",
      getActivities: async () => ({
        result: [
          { id: 1, marketoGUID: "activity-guid", activityTypeId: 1, leadId: 7, activityDate: "2026-08-31T01:00:00Z" },
          { id: 2, activityTypeId: 1, leadId: 7, activityDate: "2026-08-31T02:00:00Z" },
          { id: 3, marketoGUID: "", activityTypeId: 1, leadId: 7, activityDate: "2026-08-31T03:00:00Z" },
        ],
        moreResult: false,
      }),
    }));

    let page = await session.getActivities({ sinceDate: new Date("2026-08-31T00:00:00Z"), activityTypeIds: [1] });

    expect(page.activities.map(activity => activity.id)).toEqual(["activity-guid", 2, 3]);
  });

  it("rejects malformed activity fields before observing them", async () => {
    let malformed: RawActivity[] = [
      { id: 0, activityTypeId: 1, leadId: 7, activityDate: "2026-08-31T01:00:00Z" },
      { id: "bad" as never, activityTypeId: 1, leadId: 7, activityDate: "2026-08-31T01:00:00Z" },
      { marketoGUID: "activity-guid", activityTypeId: 0, leadId: 7, activityDate: "2026-08-31T01:00:00Z" },
      { marketoGUID: "activity-guid", activityTypeId: 1.5, leadId: 7, activityDate: "2026-08-31T01:00:00Z" },
      { marketoGUID: "activity-guid", activityTypeId: 2, leadId: 7, activityDate: "2026-08-31T01:00:00Z" },
      { marketoGUID: "activity-guid", activityTypeId: 1, leadId: 0, activityDate: "2026-08-31T01:00:00Z" },
      { marketoGUID: "activity-guid", activityTypeId: 1, activityDate: "2026-08-31T01:00:00Z" },
      { marketoGUID: "activity-guid", activityTypeId: 1, leadId: 7, activityDate: "not-a-date" },
    ];
    for (let activity of malformed) {
      let notes: string[] = [];
      let session = new MarketoSessionImpl(stubContext({
        getPagingToken: async () => "page",
        getActivities: async () => ({ result: [activity], moreResult: false }),
      }, notes));
      await expect(session.getActivities({
        sinceDate: new Date("2026-08-31T00:00:00Z"),
        activityTypeIds: [1],
      })).rejects.toThrow();
      expect(notes).toEqual([]);
    }
  });

  it("rejects invalid activity queries before reading or observing", async () => {
    let calls = 0;
    let notes: string[] = [];
    let session = new MarketoSessionImpl(stubContext({
      getPagingToken: async () => { calls++; return "page"; },
    }, notes));
    for (let query of [
      { sinceDate: new Date("invalid"), activityTypeIds: [1] },
      { sinceDate: new Date(), activityTypeIds: [0] },
      { sinceDate: new Date(), activityTypeIds: [1.5] },
      { sinceDate: new Date(), activityTypeIds: ["1" as never] },
      { sinceDate: new Date(), activityTypeIds: [1], maxResults: 0 },
      { sinceDate: new Date(), activityTypeIds: [1], maxResults: -1 },
      { sinceDate: new Date(), activityTypeIds: [1], maxResults: 1.5 },
      { sinceDate: new Date(), activityTypeIds: [1], maxResults: 301 },
    ]) await expect(Promise.resolve().then(() => session.getActivities(query))).rejects.toThrow();
    expect(calls).toBe(0);
    expect(notes).toEqual([]);
  });

  it("rejects activities outside an explicitly requested person scope before observing", async () => {
    let notes: string[] = [];
    let person = new MarketoPersonImpl(stubContext({
      getPagingToken: async () => "page",
      getActivities: async () => ({
        result: [{
          id: 1,
          activityTypeId: 1,
          leadId: 8,
          activityDate: "2026-08-31T01:00:00Z",
        }],
        moreResult: false,
      }),
    }, notes), { field: "id", value: "7" });

    await expect(person.getActivities({
      sinceDate: new Date("2026-08-31T00:00:00Z"),
      activityTypeIds: [1],
    })).rejects.toThrow(/outside the requested person scope/);
    expect(notes).toEqual([]);
  });

  it("rejects activity pages larger than maxResults before observing", async () => {
    let notes: string[] = [];
    let session = new MarketoSessionImpl(stubContext({
      getPagingToken: async () => "page",
      getActivities: async () => ({
        result: [1, 2].map(id => ({
          id, activityTypeId: 1, leadId: 7, activityDate: "2026-08-31T01:00:00Z",
        })),
        moreResult: false,
      }),
    }, notes));

    await expect(session.getActivities({
      sinceDate: new Date("2026-08-31T00:00:00Z"),
      activityTypeIds: [1],
      maxResults: 1,
    })).rejects.toThrow(/more than the requested 1 activities/);
    expect(notes).toEqual([]);
  });

  it("binds continuation tokens to the originating activity query", async () => {
    let session = new MarketoSessionImpl(stubContext({
      getPagingToken: async () => "provider-1",
      getActivities: async () => ({ result: [], moreResult: true, nextPageToken: "provider-2" }),
    }));
    let firstQuery = { sinceDate: new Date("2026-08-31T00:00:00Z"), activityTypeIds: [1] };
    let first = await session.getActivities(firstQuery);

    await expect(session.getActivities({
      sinceDate: new Date("2026-08-30T00:00:00Z"),
      activityTypeIds: [1],
    }, first.nextPageToken)).rejects.toThrow(/page token for this query/);
  });

  it("does not allow an instance activity cursor to cross into a person stream", async () => {
    let ctx = stubContext({
      getPagingToken: async () => "provider-1",
      getActivities: async () => ({ result: [], moreResult: true, nextPageToken: "provider-2" }),
    });
    let query = { sinceDate: new Date("2026-08-31T00:00:00Z"), activityTypeIds: [1] };
    let token = (await new MarketoSessionImpl(ctx).getActivities(query)).nextPageToken;

    await expect(new MarketoPersonImpl(ctx, { field: "id", value: "7" }).getActivities(query, token))
      .rejects.toThrow(/page token for this query/);
  });

  it("rejects malformed activity continuation tokens before calling Marketo", async () => {
    let calls = 0;
    let session = new MarketoSessionImpl(stubContext({
      getPagingToken: async () => { calls++; return "provider-1"; },
      getActivities: async () => { calls++; return { result: [], moreResult: false }; },
    }));
    let query = { sinceDate: new Date("2026-08-31T00:00:00Z"), activityTypeIds: [1] };

    for (let token of ["provider-token", "gk-activity:not-base64", "gk-activity:e30"]) {
      await expect(session.getActivities(query, token)).rejects.toThrow(/Invalid Marketo activities page token/);
    }
    expect(calls).toBe(0);
  });

  it("rejects provider activities older than sinceDate before observing", async () => {
    let notes: string[] = [];
    let session = new MarketoSessionImpl(stubContext({
      getPagingToken: async () => "provider-1",
      getActivities: async () => ({
        result: [{ id: 1, activityTypeId: 1, leadId: 7, activityDate: "2026-08-30T23:59:59Z" }],
        moreResult: false,
      }),
    }, notes));

    await expect(session.getActivities({
      sinceDate: new Date("2026-08-31T00:00:00Z"),
      activityTypeIds: [1],
    })).rejects.toThrow(/older than the requested sinceDate/);
    expect(notes).toEqual([]);
  });

  it("continues activities with the wrapped provider token", async () => {
    let pagingDates: Date[] = [];
    let providerTokens: string[] = [];
    let session = new MarketoSessionImpl(stubContext({
      getPagingToken: async sinceDate => { pagingDates.push(sinceDate); return "provider-1"; },
      getActivities: async ({ nextPageToken }) => {
        providerTokens.push(nextPageToken);
        return nextPageToken === "provider-1"
          ? { result: [], moreResult: true, nextPageToken: "provider-2" }
          : { result: [], moreResult: false };
      },
    }));
    let query = { sinceDate: new Date("2026-08-31T00:00:00Z"), activityTypeIds: [2, 1], maxResults: 25 };

    let first = await session.getActivities(query);
    expect(first.nextPageToken).toEqual(expect.any(String));
    expect(first.nextPageToken).not.toContain("provider-2");
    let second = await session.getActivities({ ...query, activityTypeIds: [1, 2] }, first.nextPageToken);

    expect(second).toEqual({ activities: [], moreResult: false, nextPageToken: undefined });
    expect(providerTokens).toEqual(["provider-1", "provider-2"]);
    expect(pagingDates).toEqual([query.sinceDate]);
  });
});

describe("person field normalization", () => {
  it("marks searchable from describe2, since describe.json never reports it", async () => {
    let session = new MarketoSessionImpl(stubContext({
      describeLeadFields: async () => [
        { id: 4, displayName: "Company Name", dataType: "string",
          rest: { name: "company", readOnly: false }, soap: { name: "Company" } },
        { id: 6, displayName: "Email Address", dataType: "email",
          rest: { name: "email", readOnly: false }, soap: { name: "Email" } },
      ],
      getSearchablePersonFields: async () => new Set(["id", "email"]),
    }));
    let fields = await session.describePersonFields();
    let byName = new Map(fields.map(f => [f.name, f]));
    expect(byName.get("email")?.searchable).toBe(true);
    expect(byName.get("company")?.searchable).toBe(false);
  });

  it("drops fields with no addressable API name", async () => {
    let session = new MarketoSessionImpl(stubContext({
      describeLeadFields: async () => [
        { id: 1, displayName: "Nameless", dataType: "string" },
        { id: 2, displayName: "Email", dataType: "email", rest: { name: "email" } },
      ],
      getSearchablePersonFields: async () => new Set(["email"]),
    }));
    expect((await session.describePersonFields()).map(f => f.name)).toEqual(["email"]);
  });

  it("requires canonical positive decimal id lookups", async () => {
    for (let value of ["0", "-1", "01", "+1", " 1", "1 ", "0x10", "1e2", "9007199254740992"]) {
      let person = new MarketoPersonImpl(stubContext({}), { field: "id", value });
      await expect(person.read()).rejects.toThrow(/canonical positive base-10 safe integer/);
    }
  });

  it("correlates exact lookup rows and returns only requested fields plus id", async () => {
    let requested: string[] | undefined;
    let person = new MarketoPersonImpl(stubContext({
      getLeads: async (_field, _values, fields) => {
        requested = fields;
        return [
          { id: 1, email: "other@example.com", firstName: "Wrong" },
          { id: 2, email: "right@example.com", firstName: "Right", secret: "hidden" },
        ];
      },
    }), { field: "email", value: "right@example.com" });

    await expect(person.read(["firstName"])).resolves.toEqual({ id: 2, firstName: "Right" });
    expect(requested).toEqual(["id", "firstName", "email"]);
  });

  it("rejects invalid provider person ids", async () => {
    for (let id of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      let person = new MarketoPersonImpl(stubContext({
        getLeads: async () => [{ id, email: "right@example.com" }],
      }), { field: "email", value: "right@example.com" });
      await expect(person.read()).rejects.toThrow(/person with an invalid id/);
    }
  });

  it("resolves writes from an exact lookup row rather than row zero", async () => {
    let submitted: MarketoActionInput[] = [];
    let ctx = stubContext({
      getLeads: async () => [
        { id: 1, email: "other@example.com" },
        { id: 2, email: "right@example.com" },
      ],
    });
    ctx.submit = async action => void submitted.push(action);
    let person = new MarketoPersonImpl(ctx, { field: "email", value: "right@example.com" });

    await person.update({ firstName: "Updated" });
    expect(submitted).toEqual([{ type: "updatePerson", personId: 2, fields: { firstName: "Updated" } }]);
  });

  it("projects person search and list members to requested fields", async () => {
    let raw = { id: 7, email: "person@example.com", firstName: "Person", secret: "hidden" };
    let session = new MarketoSessionImpl(stubContext({ getLeads: async () => [raw] }));
    let list = new MarketoStaticListImpl(stubContext({
      getListMembers: async () => ({ result: [raw], moreResult: false }),
    }), 55);

    await expect(session.findPeople("email", [raw.email], ["email"]))
      .resolves.toEqual([{ id: 7, email: raw.email }]);
    await expect(list.getMembers(["firstName"]))
      .resolves.toMatchObject({ members: [{ id: 7, firstName: "Person" }] });
  });

  it("scopes static-list member continuations to the list and field projection", async () => {
    let providerTokens: (string | undefined)[] = [];
    let ctx = stubContext({
      getListMembers: async (_listId, _fields, pageToken) => {
        providerTokens.push(pageToken);
        return pageToken === undefined
          ? { result: [{ id: 7 }], moreResult: true, nextPageToken: "provider-next" }
          : { result: [], moreResult: false };
      },
    });
    let list = new MarketoStaticListImpl(ctx, 55);
    let first = await list.getMembers(["email", "firstName"]);

    expect(first.nextPageToken).not.toBe("provider-next");
    await list.getMembers(["firstName", "email"], first.nextPageToken);
    expect(providerTokens).toEqual([undefined, "provider-next"]);
    let listToken = (await list.getMembers(["email", "firstName"])).nextPageToken;
    await expect(new MarketoStaticListImpl(ctx, 56).getMembers(
      ["email", "firstName"], listToken,
    )).rejects.toThrow(/for this list and field projection/);
    let projectionToken = (await list.getMembers(["email", "firstName"])).nextPageToken;
    await expect(list.getMembers(["email"], projectionToken))
      .rejects.toThrow(/for this list and field projection/);
    let tamperToken = (await list.getMembers(["email", "firstName"])).nextPageToken!;
    let tampered = tamperToken.slice(0, -1) + (tamperToken.endsWith("0") ? "1" : "0");
    await expect(list.getMembers(["email", "firstName"], tampered))
      .rejects.toThrow(/for this list and field projection/);
    await expect(list.getMembers(["email", "firstName"], tamperToken))
      .resolves.toMatchObject({ moreResult: false });
    await expect(list.getMembers(["email", "firstName"], tamperToken))
      .rejects.toThrow(/for this list and field projection/);
  });

  it("scopes program-member continuations and consumes them once", async () => {
    let providerTokens: (string | undefined)[] = [];
    let ctx = stubContext({
      getProgramMembers: async (programId, _fields, pageToken) => {
        providerTokens.push(pageToken);
        return pageToken === undefined
          ? {
              result: [{ id: 7, membership: { id: programId } }],
              moreResult: true,
              nextPageToken: "private-program-token",
            }
          : { result: [], moreResult: false };
      },
    });
    let program = new MarketoProgramImpl(ctx, 99);
    let first = await program.getMembers(["email"]);

    expect(first.nextPageToken).not.toContain("private-program-token");
    await expect(program.getMembers(["firstName"], first.nextPageToken))
      .rejects.toThrow(/program and field projection/);

    let replay = (await program.getMembers(["email"])).nextPageToken!;
    await expect(program.getMembers(["email"], replay)).resolves.toMatchObject({ moreResult: false });
    await expect(program.getMembers(["email"], replay)).rejects.toThrow(/program and field projection/);
    expect(providerTokens).toEqual([undefined, undefined, "private-program-token"]);
  });

  it("treats empty person projections as id-only without exposing default PII", async () => {
    let raw = {
      id: 7,
      email: "private@example.com",
      firstName: "Private",
      phone: "+1-555-0100",
      unsolicited: "hidden",
    };
    let person = new MarketoPersonImpl(stubContext({ getLeads: async () => [raw] }), {
      field: "email",
      value: raw.email,
    });
    let session = new MarketoSessionImpl(stubContext({ getLeads: async () => [raw] }));
    let list = new MarketoStaticListImpl(stubContext({
      getListMembers: async () => ({ result: [raw], moreResult: false }),
    }), 55);
    let program = new MarketoProgramImpl(stubContext({
      getProgramMembers: async () => ({
        result: [{ ...raw, membership: { id: 99, progressionStatus: "Member" } }],
        moreResult: false,
      }) as never,
    }), 99);

    await expect(person.read([])).resolves.toEqual({ id: 7 });
    await expect(session.findPeople("email", [raw.email], [])).resolves.toEqual([{ id: 7 }]);
    await expect(list.getMembers([])).resolves.toMatchObject({ members: [{ id: 7 }] });
    await expect(program.getMembers([])).resolves.toMatchObject({
      members: [{ id: 7, membership: expect.objectContaining({ status: "Member" }) }],
    });
    expect((await list.getMembers([])).members[0]).toEqual({ id: 7 });
    expect(Object.keys((await program.getMembers([])).members[0]!).toSorted()).toEqual([
      "id",
      "membership",
    ]);
  });

  it("correlates projected person searches without exposing an internal filter field", async () => {
    let requestedFields: string[] | undefined;
    let notes: string[] = [];
    let session = new MarketoSessionImpl(stubContext({
      getLeads: async (_field, _values, fields) => {
        requestedFields = fields;
        return [{ id: 7, email: "person@example.com", firstName: "Person" }];
      },
    }, notes));

    await expect(session.findPeople("email", ["person@example.com"], ["firstName"]))
      .resolves.toEqual([{ id: 7, firstName: "Person" }]);
    expect(requestedFields).toEqual(["id", "firstName", "email"]);

    await expect(new MarketoSessionImpl(stubContext({
      getLeads: async () => [{ id: 8, email: "other@example.com" }],
    }, notes)).findPeople("email", ["person@example.com"], ["firstName"]))
      .rejects.toThrow(/outside the requested filter/);
    expect(notes).toHaveLength(2);
  });
});

describe("exact static list reads", () => {
  it("accepts only the requested well-formed list record", async () => {
    let matching = clientReturning({ success: true, result: [{ id: 55, name: "List" }] }).client;
    await expect(matching.getList(55)).resolves.toMatchObject({ id: 55, name: "List" });

    let missing = clientReturning({ success: true, result: [] }).client;
    await expect(missing.getList(55)).resolves.toBeUndefined();

    for (let result of [
      [null],
      ["list"],
      [{ id: "55" }],
      [{ name: "Missing id" }],
      [{ id: 56, name: "Foreign" }],
      [{ id: 55 }, { id: 55 }],
      [{ id: 55, name: { text: "List" } }],
    ]) {
      let notes: string[] = [];
      let list = new MarketoStaticListImpl(
        stubContext(clientReturning({ success: true, result }).client, notes),
        55,
      );
      let error = await list.describe().catch(error => error);
      expect(error).toBeInstanceOf(MarketoError);
      expect(error.operation).toBe("/v1/lists/55.json");
      expect(notes).toEqual([]);
    }
  });

  it("uses singular reads and Adobe's plural mutation endpoint with the correct methods", async () => {
    let { client, calls, methods } = clientReturning(
      { success: true, result: [] },
      { success: true, result: [] },
      { success: true, result: [] },
    );
    await client.getListMembers(55);
    await client.addLeadsToList(55, [7]);
    await client.removeLeadsFromList(55, [7]);
    expect(calls.map(url => new URL(url).pathname)).toEqual([
      "/rest/v1/list/55/leads.json",
      "/rest/v1/lists/55/leads.json",
      "/rest/v1/lists/55/leads.json",
    ]);
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
  });
});

describe("exact program reads", () => {
  it("accepts only the requested program record", async () => {
    let matching = clientReturning({ success: true, result: [{ id: 9900, name: "Program" }] }).client;
    await expect(matching.getProgram(9900)).resolves.toMatchObject({ id: 9900, name: "Program" });

    let missing = clientReturning({ success: true, result: [] }).client;
    await expect(missing.getProgram(9900)).resolves.toBeUndefined();

    for (let result of [
      [null],
      ["program"],
      [{ id: "9900" }],
      [{ name: "Missing id" }],
      [{ id: 9901, name: "Foreign" }],
      [{ id: 9900 }, { id: 9900 }],
    ]) {
      let notes: string[] = [];
      let program = new MarketoProgramImpl(
        stubContext(clientReturning({ success: true, result }).client, notes),
        9900,
      );
      let error = await program.describe().catch(error => error);
      expect(error).toBeInstanceOf(MarketoError);
      expect(error.message).toMatch(/wrong program for exact read 9900/);
      expect(error.operation).toBe("/asset/v1/program/9900.json");
      expect(notes).toEqual([]);
    }
  });

  it("rejects malformed exact program metadata", async () => {
    for (let program of [
      { id: 9900, name: { text: "Program" } },
      { id: 9900, headStart: "yes" },
      { id: 9900, folder: { value: "10" } },
      { id: 9900, tags: {} },
      { id: 9900, tags: [{ tagType: { text: "Region" } }] },
    ]) {
      let error = await clientReturning({ success: true, result: [program] }).client
        .getProgram(9900).catch(error => error);
      expect(error).toBeInstanceOf(MarketoError);
      expect(error.message).toMatch(/program with an unexpected shape/);
      expect(error.operation).toBe("/asset/v1/program/9900.json");
    }
  });
});

describe("program tokens", () => {
  it("accepts tokens only from the requested program envelope", async () => {
    let matching = clientReturning({
      success: true,
      result: [{
        folder: { type: "Program", value: 9900 },
        tokens: [{ name: "discount", value: "x" }],
      }],
    });
    await expect(matching.client.getProgramTokens(9900)).resolves.toEqual([
      { name: "discount", value: "x" },
    ]);
    expect(new URL(matching.calls[0]!).searchParams.get("folderType")).toBe("Program");

    for (let result of [
      [{ folder: { type: "Program", value: 9901 }, tokens: [{ name: "secret" }] }],
      [{ folder: { type: "Folder", value: 9900 }, tokens: [{ name: "secret" }] }],
      [
        { folder: { type: "Program", value: 9900 }, tokens: [] },
        { folder: { type: "Program", value: 9900 }, tokens: [] },
      ],
    ]) {
      let client = clientReturning({ success: true, result }).client;
      let error = await client.getProgramTokens(9900).catch(error => error);
      expect(error).toBeInstanceOf(MarketoError);
      expect(error.message).toMatch(/wrong program 9900/);
      expect(error.operation).toBe("/asset/v1/folder/9900/tokens.json");
    }
  });

  it("rejects malformed program token envelopes and values", async () => {
    for (let result of [
      [null],
      [{ folder: null, tokens: [] }],
      [{ folder: { type: "Program", value: 9900 } }],
      [{ folder: { type: "Program", value: 9900 }, tokens: {} }],
      [{ folder: { type: "Program", value: 9900 }, tokens: [null] }],
      [{ folder: { type: "Program", value: 9900 }, tokens: [{ value: { secret: true } }] }],
    ]) {
      let client = clientReturning({ success: true, result }).client;
      let error = await client.getProgramTokens(9900).catch(error => error);
      expect(error).toBeInstanceOf(MarketoError);
      expect(error.operation).toBe("/asset/v1/folder/9900/tokens.json");
    }
  });

  it("unwraps the folder envelope instead of reporting a blank token", async () => {
    // The endpoint answers [{ folder, tokens: [...] }]; treating that entry as a token itself
    // produces one phantom { name: "", type: "", value: "" }.
    let program = new MarketoProgramImpl(stubContext({
      getProgramTokens: async () => [{ name: "discount", type: "script block", value: "x" }],
    }), 9900);
    expect(await program.getTokens()).toEqual([
      { name: "{{my.discount}}", type: "script block", value: "x" },
    ]);
  });

  it("returns an empty list for a program with no tokens", async () => {
    let program = new MarketoProgramImpl(stubContext({ getProgramTokens: async () => [] }), 1);
    expect(await program.getTokens()).toEqual([]);
  });

  it("drops nameless tokens, which cannot be referenced as {{my.*}}", async () => {
    let program = new MarketoProgramImpl(stubContext({
      getProgramTokens: async () => [{ name: "", type: "", value: "" }, { name: "ok", value: "v" }],
    }), 1);
    expect((await program.getTokens()).map(t => t.name)).toEqual(["{{my.ok}}"]);
  });
});

describe("whole-instance listings", () => {
  it("merges pending program creates, renames, and deletes into exact-name lookup", async () => {
    let actions: ProgramAction[] = [
      {
        id: 1, type: "programCreate", provisionalId: "~1", parentId: "10",
        input: { name: "Match", type: "Default", channel: "Default" },
      },
      { id: 2, type: "programUpdate", targetId: "1", programName: "Old", patch: { name: "Match" } },
      { id: 3, type: "programUpdate", targetId: "2", programName: "Match", patch: { name: "Other" } },
      { id: 4, type: "programLifecycle", targetId: "3", programName: "Match", operation: "delete" },
    ];
    let { ctx } = programContext({
      getProgramsByName: async () => [
        { id: 1, name: "Old" },
        { id: 2, name: "Match" },
        { id: 3, name: "Match" },
        { id: 4, name: "Match" },
      ],
      getProgram: async id => ({ id, name: id === 1 ? "Old" : "Match" }),
      getChannels: async () => [{ name: "Default", progressionStatuses: [] }],
    }, actions);

    let programs = await new MarketoSessionImpl(ctx).findProgramsByName("match");
    expect(programs.map(program => program.id)).toEqual(["~1", 1, 4]);
    expect(new Set(programs.map(program => String(program.id))).size).toBe(programs.length);
  });

  it("paginates pending campaign overlays without duplicates", async () => {
    let actions: CampaignAction[] = [
      {
        id: 1, type: "campaignCreate", provisionalId: "~1",
        parent: { id: "10", type: "Folder" }, name: "Pending",
      },
      { id: 2, type: "campaignMetadata", targetId: "1", campaignName: "One", patch: { name: "Updated" } },
      { id: 3, type: "campaignLifecycle", targetId: "2", campaignName: "Two", programId: null, operation: "delete" },
    ];
    let calls: (string | undefined)[] = [];
    let firstPage = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, name: `C${index + 1}` }));
    let { ctx } = campaignContext({
      getCampaigns: async filter => {
        calls.push(filter?.pageToken);
        return filter?.pageToken === "upstream-2"
          ? { result: [{ id: 301, name: "C301" }], moreResult: false }
          : { result: firstPage, moreResult: true, nextPageToken: "upstream-2" };
      },
      getSmartCampaign: async id => ({ id, name: `C${id}` }),
    }, actions);
    let session = new MarketoSessionImpl(ctx);

    let first = await session.listSmartCampaigns();
    let second = await session.listSmartCampaigns({ pageToken: first.nextPageToken });
    let ids = [...first.campaigns, ...second.campaigns].map(campaign => String(campaign.id));

    expect(first.campaigns).toHaveLength(300);
    expect(first.campaigns.slice(0, 2).map(campaign => campaign.id)).toEqual(["~1", 1]);
    expect(first.campaigns[1]?.name).toBe("Updated");
    expect(ids).not.toContain("2");
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.campaigns.map(campaign => campaign.id)).toEqual([301]);
    expect(second.moreResult).toBe(false);
    expect(calls).toEqual([undefined, "upstream-2"]);
  });

  it("keeps campaign continuation state opaque, scoped, and single-use", async () => {
    let upstream = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, name: `C${index}` }));
    let { ctx } = campaignContext({
      getCampaigns: async filter => filter?.pageToken === "private-campaign-token"
        ? { result: [], moreResult: false }
        : { result: upstream, moreResult: true, nextPageToken: "private-campaign-token" },
    });
    let session = new MarketoSessionImpl(ctx);
    let issue = async () => (await session.listSmartCampaigns({ nameContains: "C" })).nextPageToken!;

    let crossScope = await issue();
    expect(crossScope).not.toContain("private-campaign-token");
    await expect(session.listSmartCampaigns({ nameContains: "other", pageToken: crossScope }))
      .rejects.toThrow(/smart campaign page token/);

    let token = await issue();
    let tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    await expect(session.listSmartCampaigns({ nameContains: "C", pageToken: tampered }))
      .rejects.toThrow(/smart campaign page token/);
    await expect(session.listSmartCampaigns({ nameContains: "C", pageToken: token }))
      .resolves.toMatchObject({ moreResult: false });
    await expect(session.listSmartCampaigns({ nameContains: "C", pageToken: token }))
      .rejects.toThrow(/smart campaign page token/);
  });

  it("accepts its continuation token with more than 100 pending campaign changes", async () => {
    let actions: CampaignAction[] = Array.from({ length: 150 }, (_, index) => ({
      id: index + 1,
      type: "campaignCreate",
      provisionalId: `~${index + 1}`,
      parent: { id: "10", type: "Folder" },
      name: `Pending ${index + 1}`,
    }));
    let upstream = Array.from({ length: 300 }, (_, index) => ({
      id: index + 1,
      name: `Existing ${index + 1}`,
    }));
    let { ctx } = campaignContext({
      getCampaigns: async () => ({ result: upstream, moreResult: false }),
    }, actions);
    let session = new MarketoSessionImpl(ctx);

    let first = await session.listSmartCampaigns();
    expect(first.nextPageToken?.length).toBeLessThanOrEqual(16_384);
    let second = await session.listSmartCampaigns({ pageToken: first.nextPageToken });
    let ids = [...first.campaigns, ...second.campaigns].map(campaign => String(campaign.id));

    expect(first.campaigns).toHaveLength(300);
    expect(second.campaigns).toHaveLength(150);
    expect(second.moreResult).toBe(false);
    expect(ids).toHaveLength(450);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      ...Array.from({ length: 150 }, (_, index) => `~${index + 1}`),
      ...upstream.map(campaign => String(campaign.id)),
    ]);
  });

  it("preserves program-name substring matches through campaign overlays", async () => {
    let actions: CampaignAction[] = [
      { id: 1, type: "campaignMetadata", targetId: "1", campaignName: "Old", patch: { name: "Renamed" } },
      {
        id: 2, type: "campaignLifecycle", targetId: "2", campaignName: "Activate me",
        campaignType: "trigger", programId: "10", operation: "activate",
      },
    ];
    let { ctx } = campaignContext({
      getCampaigns: async () => ({
        result: [{ id: 3, name: "Unrelated", programName: "Weekly Digest" }],
        moreResult: false,
      }),
      getSmartCampaign: async id => ({
        id,
        name: id === 1 ? "Old" : "Activate me",
        folder: { type: "Program", value: 10, folderName: "Weekly Digest" },
        type: id === 2 ? "trigger" : "batch",
        isActive: false,
      }),
    }, actions);

    let page = await new MarketoSessionImpl(ctx).listSmartCampaigns({ nameContains: "Digest" });

    expect(page.campaigns).toEqual([
      expect.objectContaining({ id: 1, name: "Renamed", programName: "Weekly Digest" }),
      expect.objectContaining({ id: 2, active: true, status: "Active", programName: "Weekly Digest" }),
      expect.objectContaining({ id: 3, name: "Unrelated", programName: "Weekly Digest" }),
    ]);
  });

  it("returns opaque static-list continuations and consumes them once", async () => {
    let seen: (string | undefined)[] = [];
    let session = new MarketoSessionImpl(stubContext({
      getLists: async (filter?: { pageToken?: string }) => {
        seen.push(filter?.pageToken);
        return filter?.pageToken === "tok2"
          ? { result: [], moreResult: false }
          : { result: [{ id: 1, name: "L" }], moreResult: true, nextPageToken: "tok2" };
      },
    }));
    let page = await session.listStaticLists();
    expect(seen).toEqual([undefined]);
    expect(page.lists.map(l => l.id)).toEqual([1]);
    expect(page.moreResult).toBe(true);
    expect(page.nextPageToken).not.toContain("tok2");
    await expect(session.listStaticLists({ pageToken: page.nextPageToken }))
      .resolves.toMatchObject({ moreResult: false });
    await expect(session.listStaticLists({ pageToken: page.nextPageToken }))
      .rejects.toThrow(/static-list page token/);
    expect(seen).toEqual([undefined, "tok2"]);
  });

  it.each([
    [{ name: "Wanted" }, "Other"],
    [{ nameContains: "ant" }, "Other"],
  ])("rejects static lists outside a requested name filter before observation", async (filter, name) => {
    let notes: string[] = [];
    let session = new MarketoSessionImpl(stubContext({
      getLists: async () => ({ result: [{ id: 1, name }], moreResult: false }),
    }, notes));

    await expect(session.listStaticLists(filter)).rejects.toThrow(/outside the requested name filter/);
    expect(notes).toEqual([]);
  });

  it("reports the end of the list", async () => {
    let session = new MarketoSessionImpl(stubContext({
      getCampaigns: async () => ({ result: [{ id: 7, name: "C" }], moreResult: false }),
    }));
    let page = await session.listSmartCampaigns();
    expect(page.campaigns.map(c => c.id)).toEqual([7]);
    expect(page.moreResult).toBe(false);
  });

  it("resolves a fresh client for every operation", async () => {
    let calls = 0;
    let ctx: SessionContext = {
      client: async () => ({
        getLists: async () => ({
          result: [{ id: ++calls, name: "L" }],
          moreResult: false,
        }),
      }) as never,
      observe: async () => {},
      submit: async () => {},
      retain: () => {},
      dispose: () => {},
    };
    let session = new MarketoSessionImpl(ctx);
    expect((await session.listStaticLists()).lists[0]?.id).toBe(1);
    expect((await session.listStaticLists()).lists[0]?.id).toBe(2);
  });
});

describe("MarketoError", () => {
  // Cap'n Web serializes an Error's own enumerable properties but not its prototype, so anything
  // exposed through a getter would vanish on the way to a gadget.
  it("exposes classification as own enumerable properties", () => {
    let error = new MarketoError("Custom objects not specified", {
      code: "1003", status: 200, operation: "/v1/customobjects/x.json",
    });
    let keys = Object.keys(error);
    for (let key of ["code", "status", "operation", "isAuthError", "isRateLimited"]) {
      expect(keys).toContain(key);
    }
  });

  it("classifies auth and rate-limit failures", () => {
    expect(new MarketoError("expired", { code: "602" }).isAuthError).toBe(true);
    expect(new MarketoError("rate", { code: "606" }).isRateLimited).toBe(true);
  });
});

describe("program lookup by name", () => {
  // Marketo has no name search, so there is no list-all; and a name can legitimately match
  // several programs, so the lookup must not collapse to one.
  const MATCHES = [
    { id: 4100, name: "Weekly Digest", workspace: "Default" },
    { id: 4200, name: "Weekly Digest", workspace: "Default" },
    { id: 4300, name: "Weekly Digest", workspace: "Default" },
  ];

  it("returns every program sharing the name", async () => {
    let session = new MarketoSessionImpl(stubContext({
      getProgramsByName: async () => MATCHES,
    }));
    expect((await session.findProgramsByName("Weekly Digest")).map(p => p.id))
      .toEqual([4100, 4200, 4300]);
  });

  it("returns an empty array for an unknown name", async () => {
    let session = new MarketoSessionImpl(stubContext({ getProgramsByName: async () => [] }));
    expect(await session.findProgramsByName("nope")).toEqual([]);
  });

  it("trims the name and rejects a blank one", async () => {
    let seen: string[] = [];
    let session = new MarketoSessionImpl(stubContext({
      getProgramsByName: async (name: string) => { seen.push(name); return []; },
    }));
    await session.findProgramsByName("  spaced  ");
    expect(seen).toEqual(["spaced"]);
    await expect(session.findProgramsByName("   ")).rejects.toThrow("A program name is required.");
  });
});

function countingClient(overrides: Partial<MarketoClient> = {}) {
  let calls: string[] = [];
  let client = {
    getProgramPage: async (limit: number) => {
      calls.push(`getProgramPage(${limit})`);
      return [{ id: 1, name: "First" }];
    },
    getProgram: async (id: number) => {
      calls.push(`getProgram(${id})`);
      return id === 9900 ? { id: 9900, name: "By Id" } : undefined;
    },
    getProgramsByName: async (name: string) => {
      calls.push(`getProgramsByName(${name})`);
      return [{ id: 4100, name, folder: { folderName: "Assets" } }];
    },
    ...overrides,
  };
  return { client: client as unknown as MarketoClient, calls };
}

describe("program picker", () => {
  it("shows one page when the query is empty", async () => {
    let { client, calls } = countingClient();
    expect(await resolveProgramOptions(client, "  ")).toHaveLength(1);
    expect(calls).toEqual(["getProgramPage(200)"]);
  });

  it("treats a numeric query as a program id", async () => {
    let { client, calls } = countingClient();
    let options = await resolveProgramOptions(client, "9900");
    expect(options.map(o => o.value)).toEqual(["9900"]);
    expect(calls).toEqual(["getProgram(9900)"]);
  });

  it("returns nothing for an unknown id, without falling back to a scan", async () => {
    let { client, calls } = countingClient();
    expect(await resolveProgramOptions(client, "404")).toEqual([]);
    expect(calls).toEqual(["getProgram(404)"]);
  });

  it("treats a text query as an exact name and shows the folder", async () => {
    let { client, calls } = countingClient();
    let options = await resolveProgramOptions(client, "  Weekly Digest  ");
    expect(calls).toEqual(["getProgramsByName(Weekly Digest)"]);
    expect(options[0]?.meta).toBe("Assets");
  });

  it("never makes more than one API call", async () => {
    for (let query of ["", "9900", "some name"]) {
      let { client, calls } = countingClient();
      await resolveProgramOptions(client, query);
      expect(calls).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Paging and envelope handling
//
// These tests drive MarketoClient directly so its fetch can be stubbed.

/** A MarketoClient whose every request resolves to `envelopes` in order. */
function clientReturning(...envelopes: unknown[]) {
  let calls: string[] = [];
  let methods: string[] = [];
  let remaining = [...envelopes];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    methods.push(init?.method ?? "GET");
    return Response.json(remaining.shift() ?? {});
  });
  return { client: new MarketoClient(ORIGIN, { getToken: async () => "t" }), calls, methods };
}

describe("provider result identities", () => {
  afterEach(() => vi.unstubAllGlobals());

  let listingReads: [string, (client: MarketoClient) => Promise<unknown>][] = [
    ["static lists", client => client.getLists()],
    ["program browse", client => client.getProgramPage(200)],
    ["program name lookup", client => client.getProgramsByName("Program")],
    ["smart campaigns", client => client.getCampaigns()],
    ["activity types", client => client.getActivityTypes()],
  ];

  it.each(listingReads)("rejects malformed and duplicate ids from %s", async (_label, read) => {
    for (let result of [
      [{ name: "Missing" }],
      [{ id: 0, name: "Zero" }],
      [{ id: -1, name: "Negative" }],
      [{ id: 1.5, name: "Fractional" }],
      [{ id: Number.MAX_SAFE_INTEGER + 1, name: "Unsafe" }],
      [{ id: 7, name: "First" }, { id: 7, name: "Duplicate" }],
    ]) {
      let error = await read(clientReturning({ success: true, result }).client).catch(value => value);
      expect(error).toBeInstanceOf(MarketoError);
    }
  });

  it.each([
    ["static list", (client: MarketoClient) => client.getList(7)],
    ["program", (client: MarketoClient) => client.getProgram(7)],
    ["campaign", (client: MarketoClient) => client.getCampaign(7)],
    ["smart campaign", (client: MarketoClient) => client.getSmartCampaign(7)],
  ])("rejects malformed ids from exact %s reads", async (_label, read) => {
    for (let id of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      let error = await read(clientReturning({ success: true, result: [{ id }] }).client)
        .catch(value => value);
      expect(error).toBeInstanceOf(MarketoError);
    }
  });
});

describe("classic used-by pages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the documented asset paths and correlates offset pages", async () => {
    let dependency = {
      id: 9, name: "Dependent", type: "Email", status: "approved", updatedAt: "2026-01-01T00:00:00Z",
    };
    let { client, calls } = clientReturning(
      { success: true, result: [dependency] },
      { success: true, result: [{ ...dependency, type: "Landing Page" }] },
    );

    await client.getEmailTemplateUsedBy(31, { offset: 200, maxReturn: 200 });
    await client.getFormUsedBy(51, { offset: 400, maxReturn: 200 });

    expect(calls.map(call => {
      let url = new URL(call);
      return [url.pathname, url.searchParams.get("offset"), url.searchParams.get("maxReturn")];
    })).toEqual([
      ["/rest/asset/v1/emailTemplates/31/usedBy.json", "200", "200"],
      ["/rest/asset/v1/form/51/usedBy.json", "400", "200"],
    ]);
  });

  it("strictly validates dependency records and page size", async () => {
    let valid = {
      id: 9, name: "Dependent", type: "Email", status: "approved", updatedAt: "2026-01-01T00:00:00Z",
    };
    for (let item of [
      { ...valid, id: "9" },
      { ...valid, name: undefined },
      { ...valid, type: "" },
      { ...valid, status: null },
      { ...valid, updatedAt: 7 },
      { ...valid, updatedAt: "not-a-date" },
    ]) {
      await expect(clientReturning({ success: true, result: [item] }).client.getFormUsedBy(51))
        .rejects.toBeInstanceOf(MarketoResponseValidationError);
    }
    await expect(clientReturning({ success: true, result: [valid, valid] }).client
      .getFormUsedBy(51, { maxReturn: 1 })).rejects.toBeInstanceOf(MarketoResponseValidationError);
  });
});

function businessContext(client: Partial<MarketoClient>, submitted: MarketoActionInput[] = [], notes: string[] = []) {
  let access = new Map<string, "read-write" | "read-only" | "unavailable">();
  let cursors = new Map<string, { state: unknown; scope: string }>();
  let ctx: BusinessObjectContext = {
    client: async () => client as MarketoClient,
    observe: async (title, description) => { notes.push(title, description); },
    submitBusinessObject: async action => void submitted.push(action),
    getBusinessObjectAccess: kind => access.get(kind) ?? "read-write",
    setBusinessObjectAccess: (kind, value) => void access.set(kind, value),
    issuePageCursor: async (state, scope) => {
      let token = crypto.randomUUID();
      cursors.set(token, { state, scope });
      return token;
    },
    consumePageCursor: async (token, scope) => {
      let cursor = cursors.get(token);
      cursors.delete(token);
      if (!cursor || cursor.scope !== scope) throw new Error("Invalid page token.");
      return cursor.state;
    },
    dispose: () => {},
  };
  return { ctx, access };
}

// Exact and substring queries have different completeness guarantees, so pin their wire forms.
describe("name filtering", () => {
  afterEach(() => vi.unstubAllGlobals());

  let ok = { success: true, result: [] };

  it("sends an exact name as-is", async () => {
    let { client, calls } = clientReturning(ok);
    await client.getCampaigns({ name: "Weekly Digest" });
    expect(calls[0]).toContain("name=Weekly+Digest");
    expect(calls[0]).not.toContain("%25");
  });

  it("wraps a substring in Marketo's LIKE wildcards", async () => {
    let { client, calls } = clientReturning(ok);
    await client.getCampaigns({ nameContains: "Digest" });
    // %25 is an encoded '%'. Both ends, so it is a "contains" rather than a prefix match.
    expect(calls[0]).toContain("name=%25Digest%25");
  });

  it("trims the caller's whitespace on both forms", async () => {
    let { client, calls } = clientReturning(ok, ok);
    await client.getCampaigns({ name: "  Weekly Digest  " });
    await client.getCampaigns({ nameContains: "  Digest  " });
    expect(calls[0]).toContain("name=Weekly+Digest");
    expect(calls[1]).toContain("name=%25Digest%25");
  });

  it("refuses both forms at once, since they mean different completeness guarantees", async () => {
    let { client } = clientReturning(ok);
    await expect(client.getCampaigns({ name: "A", nameContains: "B" }))
      .rejects.toThrow(/either `name` \(exact\) or `nameContains` \(substring\)/);
  });

  // `nameContains: ""` would become `%%`, which matches every record that has a program while
  // silently omitting the program-less ones -- an "everything" query that is not everything.
  it("refuses an empty filter rather than answering misleadingly", async () => {
    let { client } = clientReturning(ok, ok);
    await expect(client.getCampaigns({ nameContains: "   " })).rejects.toThrow(/cannot be empty/);
    await expect(client.getCampaigns({ name: "" })).rejects.toThrow(/cannot be empty/);
  });

  it("refuses caller-supplied wildcard characters", async () => {
    let { client } = clientReturning(ok, ok);
    await expect(client.getCampaigns({ name: "Digest%" })).rejects.toThrow(/wildcard/);
    await expect(client.getLists({ nameContains: "team_list" })).rejects.toThrow(/wildcard/);
  });

  it("asks Marketo for requestable campaigns only via isTriggerable", async () => {
    let { client, calls } = clientReturning(ok);
    await client.getCampaigns({ requestableOnly: true });
    expect(calls[0]).toContain("isTriggerable=true");
  });

  it("omits the filter entirely when none is given", async () => {
    let { client, calls } = clientReturning(ok);
    await client.getCampaigns();
    expect(calls[0]).not.toContain("name=");
    expect(calls[0]).not.toContain("isTriggerable");
    expect(calls[0]).toContain("batchSize=300");
  });

  it("filters static lists the same way", async () => {
    let { client, calls } = clientReturning(ok, ok);
    await client.getLists({ name: "Regional Opt In" });
    await client.getLists({ nameContains: "Opt In" });
    expect(calls[0]).toContain("name=Regional+Opt+In");
    expect(calls[1]).toContain("name=%25Opt+In%25");
  });

  it("carries the filter and the page token together", async () => {
    let { client, calls } = clientReturning(ok);
    await client.getCampaigns({ nameContains: "Digest", pageToken: "tok" });
    expect(calls[0]).toContain("name=%25Digest%25");
    expect(calls[0]).toContain("nextPageToken=tok");
  });

  it("passes the session's filter through to the client", async () => {
    let seen: unknown[] = [];
    let session = new MarketoSessionImpl(stubContext({
      getCampaigns: async (filter?: unknown) => {
        seen.push(filter);
        return { result: [], moreResult: false };
      },
    }));
    await session.listSmartCampaigns({ nameContains: "Digest", requestableOnly: true });
    expect(seen).toEqual([{ nameContains: "Digest", requestableOnly: true }]);
  });

  // The user reads the observation log to see what an agent did; "listed 4 campaigns" hides
  // whether the answer could have been incomplete.
  it("records what was searched for, not just how many came back", async () => {
    let notes: string[] = [];
    let session = new MarketoSessionImpl(stubContext({
      getCampaigns: async () => ({ result: [], moreResult: false }),
    }, notes));
    await session.listSmartCampaigns({ nameContains: "Digest", requestableOnly: true });
    expect(notes.join(" ")).toContain('whose name contains "Digest"');
    expect(notes.join(" ")).toContain("requestable only");
  });
});

describe("page normalization", () => {
  afterEach(() => vi.unstubAllGlobals());

  // The lead-database endpoints omit `moreResult` entirely and return a nextPageToken on every
  // page, including the last, so neither raw signal can be trusted.
  it("derives moreResult when Marketo omits it", async () => {
    let { client } = clientReturning({
      requestId: "1", success: true, result: [{ id: 1 }], nextPageToken: "next",
    });
    let page = await client.getLists();
    expect(page.moreResult).toBe(true);
    expect(page.nextPageToken).toBe("next");
  });

  it("fails closed when a successful pageable response omits result", async () => {
    let { client } = clientReturning({ requestId: "1", success: true, nextPageToken: "next" });
    let error = await client.getLists().catch(value => value);
    expect(error).toBeInstanceOf(MarketoResponseValidationError);
    expect(error.message).toMatch(/missing result array/);
  });

  it("treats an empty page as the end, even though a token is still offered", async () => {
    let { client } = clientReturning({
      requestId: "1", success: true, result: [], nextPageToken: "next",
    });
    let page = await client.getCampaigns();
    expect(page.moreResult).toBe(false);
    expect(page.nextPageToken).toBeUndefined();
  });

  it("keeps Marketo's own moreResult where it reports one", async () => {
    // The activity stream pages a window of the log, so an empty page can still have more to scan.
    let { client } = clientReturning({
      success: true, result: [], moreResult: true, nextPageToken: "next",
    });
    let page = await client.getActivities({ nextPageToken: "t", activityTypeIds: [1] });
    expect(page.moreResult).toBe(true);
    expect(page.nextPageToken).toBe("next");
  });

  it("withholds the token once there is no more, so the two always agree", async () => {
    let { client } = clientReturning({
      success: true, result: [{ id: 9 }], moreResult: false, nextPageToken: "stale",
    });
    let page = await client.getActivities({ nextPageToken: "t", activityTypeIds: [1] });
    expect(page.moreResult).toBe(false);
    expect(page.nextPageToken).toBeUndefined();
  });

  it("rejects moreResult true without a non-empty nextPageToken", async () => {
    for (let nextPageToken of [undefined, ""]) {
      let { client } = clientReturning({ success: true, result: [], moreResult: true, nextPageToken });
      await expect(client.getActivities({ nextPageToken: "t", activityTypeIds: [1] }))
        .rejects.toThrow(/moreResult without a valid nextPageToken/);
    }
  });

  it("rejects malformed nextPageToken types", async () => {
    for (let nextPageToken of [7, null, {}, []]) {
      let { client } = clientReturning({ success: true, result: [{ id: 1 }], nextPageToken });
      await expect(client.getLists()).rejects.toThrow(/nextPageToken with an unexpected shape/);
    }
  });

  it("rejects a continuation token equal to the requested query token", async () => {
    let { client } = clientReturning({
      success: true, result: [{ id: 1 }], nextPageToken: "same",
    });
    await expect(client.getLists({ pageToken: "same" }))
      .rejects.toThrow(/repeated the requested nextPageToken/);
  });

  it("rejects a continuation token equal to the requested form token", async () => {
    let { client } = clientReturning({
      success: true, result: [{ id: 1 }], moreResult: true, nextPageToken: "same",
    });
    await expect(client.queryBusinessObject("company", {
      filter: { field: "name", values: ["Acme"] },
      pageToken: "same",
    })).rejects.toThrow(/repeated the requested nextPageToken/);
  });
});

describe("standard response envelopes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires an explicit boolean success field", async () => {
    for (let success of [undefined, "true", 1, null]) {
      let { client } = clientReturning({ success, result: [] });
      await expect(client.getCampaigns()).rejects.toThrow(/unreadable response/);
    }
  });

  it("preserves provider errors from success false envelopes", async () => {
    let { client } = clientReturning({
      success: false,
      errors: [{ code: "1003", message: "Invalid value" }],
    });
    let error = await client.getCampaigns().catch(value => value);
    expect(error).toBeInstanceOf(MarketoError);
    expect(error).toMatchObject({ code: "1003", isProviderRejection: true });
  });
});

describe("custom object query envelopes", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Marketo can hide a rejected filter value in a successful result envelope.
  it("raises a rejected filter value instead of returning it as a record", async () => {
    let { client } = clientReturning({
      requestId: "9ab#1a0",
      success: true,
      result: [{ reasons: [{ code: "1003", message: "Invalid value for field 'sourceID'" }] }],
    });
    let error = await client.queryCustomObject("orderStatus", "sourceID", ["bad"]).catch(value => value);
    expect(error.message).toMatch(/code 1003/);
    expect(error.message).not.toContain("sourceID");
  });

  it("carries the upstream code on the raised error", async () => {
    let { client } = clientReturning({
      success: true, result: [{ reasons: [{ code: "1003", message: "Invalid value" }] }],
    });
    let error = await client.queryCustomObject("o", "f", ["bad"]).catch(e => e);
    expect(error).toBeInstanceOf(MarketoError);
    expect(error.code).toBe("1003");
  });

  it("passes real records through, including one that has its own reasons field", async () => {
    let { client } = clientReturning({
      success: true,
      result: [{ marketoGUID: "g1", sourceID: 5 }, { marketoGUID: "g2", reasons: ["late"] }],
    });
    let records = await client.queryCustomObject("o", "sourceID", ["5"]);
    expect(records.map(r => r.marketoGUID)).toEqual(["g1", "g2"]);
  });

  it("correlates an exact custom-object describe response to its API name", async () => {
    for (let result of [
      [{ name: "other", fields: [] }],
      [{ name: "orderStatus", fields: [] }, { name: "orderStatus", fields: [] }],
    ]) {
      let { client } = clientReturning({ success: true, result });
      await expect(client.describeCustomObject("orderStatus"))
        .rejects.toThrow(/wrong custom object for exact read orderStatus/);
    }
  });

  it("preserves an empty custom-object describe response as not found", async () => {
    let { client } = clientReturning({ success: true, result: [] });
    await expect(client.describeCustomObject("orderStatus")).resolves.toBeUndefined();
  });
});

describe("standard CRM business objects", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses each object-specific endpoint path", async () => {
    let paths: string[] = [];
    let names = ["Company", "Opportunity", "Opportunity Role", "SalesPerson", "Named Account"];
    vi.stubGlobal("fetch", async (url: string) => {
      paths.push(new URL(url).pathname);
      return Response.json({ success: true, result: [{ name: names.shift(), idField: "id", fields: [] }] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    for (let kind of ["company", "opportunity", "opportunityRole", "salesPerson", "namedAccount"] as const) {
      await client.describeBusinessObject(kind);
    }
    expect(paths).toEqual([
      "/rest/v1/companies/describe.json",
      "/rest/v1/opportunities/describe.json",
      "/rest/v1/opportunities/roles/describe.json",
      "/rest/v1/salespersons/describe.json",
      "/rest/v1/namedaccounts/describe.json",
    ]);
  });

  it("requires exactly one schema matching the requested normalized object name", async () => {
    for (let result of [
      [],
      [{ name: "Opportunity", fields: [] }],
      [{ name: "Company", fields: [] }, { name: "Company", fields: [] }],
      [{ fields: [{ name: "secret" }], crmManaged: true }],
    ]) {
      let { client } = clientReturning({ success: true, result });
      await expect(client.describeBusinessObject("company"))
        .rejects.toThrow(/wrong schema for exact company describe/);
    }

    let { client } = clientReturning({
      success: true,
      result: [{ name: "  COMPANY  ", fields: [] }],
    });
    await expect(client.describeBusinessObject("company"))
      .resolves.toMatchObject({ name: "  COMPANY  " });
  });

  it("uses each object-specific sync and delete path", async () => {
    let calls: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ success: true, result: [{ seq: 0, id: 1, status: "updated" }] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    for (let kind of ["company", "opportunity", "opportunityRole", "salesPerson", "namedAccount"] as const) {
      await client.syncBusinessObject(kind, [{ key: kind }], "updateOnly", "idField");
      await client.deleteBusinessObject(kind, [{ key: kind }], "idField");
    }
    expect(calls.map(call => call.path)).toEqual([
      "/rest/v1/companies.json", "/rest/v1/companies/delete.json",
      "/rest/v1/opportunities.json", "/rest/v1/opportunities/delete.json",
      "/rest/v1/opportunities/roles.json", "/rest/v1/opportunities/roles/delete.json",
      "/rest/v1/salespersons.json", "/rest/v1/salespersons/delete.json",
      "/rest/v1/namedaccounts.json", "/rest/v1/namedaccounts/delete.json",
    ]);
    expect(calls[0]?.body).toEqual({ action: "updateOnly", dedupeBy: "idField", input: [{ key: "company" }] });
    expect(calls[1]?.body).toEqual({ deleteBy: "idField", input: [{ key: "company" }] });
  });

  it("uses Marketo's 120-second timeout only for named-account sync", async () => {
    let genericDeadline = new AbortController();
    let namedAccountDeadline = new AbortController();
    let timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds =>
      milliseconds === 120_000 ? namedAccountDeadline.signal : genericDeadline.signal);
    let signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return Response.json({ success: true, result: [] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });

    await client.syncBusinessObject("namedAccount", [{}], "updateOnly", "idField");
    await client.syncBusinessObject("company", [{}], "updateOnly", "idField");
    await client.deleteBusinessObject("namedAccount", [{}], "idField");

    expect(timeout.mock.calls).toEqual([[120_000], [60_000], [60_000]]);
    expect(signals).toEqual([
      namedAccountDeadline.signal,
      genericDeadline.signal,
      genericDeadline.signal,
    ]);
  });

  it("maps schema fields and preserves compound searchable groups", async () => {
    let { ctx } = businessContext({
      describeBusinessObject: async () => ({
        name: "OpportunityRole",
        idField: "marketoGUID",
        dedupeFields: ["externalOpportunityId", "leadId", "role"],
        searchableFields: [["externalOpportunityId", "leadId", "role"], ["marketoGUID"]],
        fields: [
          { name: "marketoGUID", displayName: "GUID", dataType: "string", updateable: false },
          { name: "role", displayName: "Role", dataType: "string", updateable: true },
        ],
      }),
    });
    let schema = await new MarketoBusinessObjectImpl(ctx, "opportunityRole").describe();
    expect(schema.searchableFieldGroups).toEqual([
      ["externalOpportunityId", "leadId", "role"], ["marketoGUID"],
    ]);
    expect(schema.fields).toEqual([
      expect.objectContaining({ name: "marketoGUID", readOnly: true, searchable: true }),
      expect.objectContaining({ name: "role", readOnly: false, searchable: true }),
    ]);
  });

  it("sends simple filters as a bounded paged method-override read", async () => {
    let request: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      request = { url, init };
      return Response.json({ success: true, result: [{ id: 7 }], moreResult: true, nextPageToken: "next" });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    let page = await client.queryBusinessObject("company", {
      filter: { field: "id", values: [7, 8] }, fields: ["company"], pageToken: "old", maxResults: 25,
    });
    expect(request.url).toContain("/rest/v1/companies.json?_method=GET");
    expect(request.init?.method).toBe("POST");
    expect(new URLSearchParams(String(request.init?.body))).toEqual(new URLSearchParams({
      filterType: "id", filterValues: "7,8", fields: "company", nextPageToken: "old", batchSize: "25",
    }));
    expect(page).toMatchObject({ result: [{ id: 7 }], moreResult: true, nextPageToken: "next" });
  });

  it("sends compound opportunity-role keys as JSON", async () => {
    let request: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      request = { url, init };
      return Response.json({ success: true, result: [] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    let key = { externalOpportunityId: "o-1", leadId: 7, role: "Decision Maker" };
    await client.queryBusinessObject("opportunityRole", {
      filter: { dedupeKeys: [key] }, fields: ["role"], pageToken: "p", maxResults: 10,
    });
    let url = new URL(request.url!);
    expect(`${url.pathname}?${url.searchParams}`).toBe("/rest/v1/opportunities/roles.json?_method=GET");
    expect(request.init?.method).toBe("POST");
    expect(JSON.parse(String(request.init?.body))).toEqual({
      filterType: "dedupeFields", fields: ["role"], input: [key], batchSize: 10, nextPageToken: "p",
    });
  });

  it("rejects business-object pages larger than maxResults before observation", async () => {
    let notes: string[] = [];
    let { ctx } = businessContext({
      queryBusinessObject: async () => ({
        result: [{ id: 7 }, { id: 8 }],
        moreResult: false,
      }),
    }, [], notes);
    await expect(new MarketoBusinessObjectImpl(ctx, "company").query({
      filter: { field: "id", values: [7, 8] },
      maxResults: 1,
    })).rejects.toThrow(/more than the requested 1 company records/);
    expect(notes).toEqual([]);
  });

  it("binds business-object cursors to kind, filter, projection, and page size", async () => {
    let providerTokens: (string | undefined)[] = [];
    let { ctx } = businessContext({
      queryBusinessObject: async (_kind, query) => {
        providerTokens.push(query.pageToken);
        return query.pageToken === undefined
          ? { result: [{ id: 7, company: "Acme" }], moreResult: true, nextPageToken: "private-object-token" }
          : { result: [], moreResult: false };
      },
    });
    let companies = new MarketoBusinessObjectImpl(ctx, "company");
    let query = { filter: { field: "id", values: [7] }, fields: ["company"], maxResults: 25 };
    let issue = async () => (await companies.query(query)).nextPageToken!;

    let projectionToken = await issue();
    expect(projectionToken).not.toContain("private-object-token");
    await expect(companies.query({
      ...query,
      fields: ["company", "externalCompanyId"],
      pageToken: projectionToken,
    })).rejects.toThrow(/business-object page token/);

    let token = await issue();
    let tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    await expect(companies.query({ ...query, pageToken: tampered }))
      .rejects.toThrow(/business-object page token/);
    await expect(companies.query({ ...query, pageToken: token }))
      .resolves.toMatchObject({ moreResult: false });
    await expect(companies.query({ ...query, pageToken: token }))
      .rejects.toThrow(/business-object page token/);
    expect(providerTokens).toEqual([undefined, undefined, "private-object-token"]);
  });

  it("sends compound custom-object keys as JSON", async () => {
    let request: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      request = { url, init };
      return Response.json({ success: true, result: [] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    let key = { sourceID: "source-1", leadID: 7 };
    await client.queryCustomObjectByDedupeKeys("orderStatus", [key], ["status"]);
    expect(request.url).toContain("/rest/v1/customobjects/orderStatus.json?_method=GET");
    expect(request.init?.method).toBe("POST");
    expect(JSON.parse(String(request.init?.body))).toEqual({
      filterType: "dedupeFields", fields: ["status"], input: [key], batchSize: MAX_FILTER_VALUES,
    });
  });

  it("validates required and duplicate object keys before approval", async () => {
    let submitted: MarketoActionInput[] = [];
    let { ctx } = businessContext({}, submitted);
    let cases = [
      ["company", { company: "No external id" }, "externalCompanyId"],
      ["opportunity", { externalOpportunityId: "o" }, "name"],
      ["opportunityRole", { externalOpportunityId: "o", leadId: 7 }, "role"],
      ["salesPerson", { email: "a@example.com" }, "externalSalesPersonId"],
      ["namedAccount", { domainName: "example.com" }, "name"],
    ] as const;
    for (let [kind, record, missing] of cases) {
      await expect(new MarketoBusinessObjectImpl(ctx, kind).upsert([record]))
        .rejects.toThrow(new RegExp(missing));
    }
    let companies = new MarketoBusinessObjectImpl(ctx, "company");
    await expect(companies.upsert([
      { externalCompanyId: "same" }, { externalCompanyId: "same" },
    ])).rejects.toThrow(/Duplicate externalCompanyId key/);
    await expect(companies.query({ filter: { field: "id", values: [7, 7] } }))
      .rejects.toThrow(/must not contain duplicates/);
    await expect(companies.query({ filter: { dedupeKeys: [{ externalCompanyId: "x" }] } }))
      .rejects.toThrow(/only for objects with compound dedupe fields/);
    await expect(companies.delete(Array.from({ length: 301 }, (_, id) => ({ id })), { matchBy: "idField" }))
      .rejects.toThrow(/at most 300/);
    expect(submitted).toEqual([]);
  });

  it("rejects standard-object rows outside scalar and compound filter keys before observation", async () => {
    let notes: string[] = [];
    let { ctx } = businessContext({
      queryBusinessObject: async () => ({ result: [{ id: 9 }], moreResult: false }),
    }, [], notes);
    await expect(new MarketoBusinessObjectImpl(ctx, "company").query({
      filter: { field: "id", values: [7] },
      fields: ["company"],
    })).rejects.toThrow(/outside the requested filter/);
    expect(notes).toEqual([]);

    let compound = businessContext({
      queryBusinessObject: async () => ({
        result: [{ externalOpportunityId: "o-1", leadId: 7, role: "Influencer" }],
        moreResult: false,
      }),
    }, [], notes);
    await expect(new MarketoBusinessObjectImpl(compound.ctx, "opportunityRole").query({
      filter: { dedupeKeys: [{ externalOpportunityId: "o-1", leadId: 7, role: "Decision Maker" }] },
      fields: ["description"],
    })).rejects.toThrow(/outside the requested filter/);
    expect(notes).toEqual([]);
  });

  it("correlates projected standard-object rows without exposing internal non-ID keys", async () => {
    let requests: MarketoBusinessObjectQuery[] = [];
    let { ctx } = businessContext({
      queryBusinessObject: async (_kind, request) => {
        requests.push(request);
        return "dedupeKeys" in request.filter
          ? {
              result: [{ marketoGUID: "g1", externalOpportunityId: "o-1", leadId: 7,
                role: "Decision Maker", description: "Buyer" }],
              moreResult: false,
            }
          : { result: [{ id: 7, externalCompanyId: "acme", company: "Acme" }], moreResult: false };
      },
    });

    await expect(new MarketoBusinessObjectImpl(ctx, "company").query({
      filter: { field: "externalCompanyId", values: ["acme"] }, fields: ["company"],
    })).resolves.toMatchObject({ records: [{ id: 7, company: "Acme" }] });
    await expect(new MarketoBusinessObjectImpl(ctx, "opportunityRole").query({
      filter: { dedupeKeys: [{ externalOpportunityId: "o-1", leadId: 7, role: "Decision Maker" }] },
      fields: ["description"],
    })).resolves.toMatchObject({ records: [{ marketoGUID: "g1", description: "Buyer" }] });
    expect(requests.map(request => request.fields)).toEqual([
      ["company", "externalCompanyId"],
      ["description", "externalOpportunityId", "leadId", "role"],
    ]);
  });

  it("strips every unsolicited standard-object field from narrow projections", async () => {
    let { ctx } = businessContext({
      queryBusinessObject: async () => ({
        result: [{
          id: 7,
          externalCompanyId: "acme",
          company: "Acme",
          billingEmail: "private@example.com",
          unsolicited: "hidden",
        }],
        moreResult: false,
      }),
    });
    let companies = new MarketoBusinessObjectImpl(ctx, "company");

    expect((await companies.query({
      filter: { field: "externalCompanyId", values: ["acme"] },
      fields: ["company"],
    })).records).toEqual([{ id: 7, company: "Acme" }]);
    expect((await companies.query({
      filter: { field: "externalCompanyId", values: ["acme"] },
      fields: [],
    })).records).toEqual([{ id: 7 }]);
  });

  it("submits complete, decision-gated upserts and deletes", async () => {
    let submitted: MarketoActionInput[] = [];
    let { ctx } = businessContext({}, submitted);
    let object = new MarketoBusinessObjectImpl(ctx, "company");
    await object.upsert([{ externalCompanyId: "secret-id", company: "Secret Corp", industry: "Tech" }]);
    await object.delete([{ id: 9 }], { matchBy: "idField" });
    expect(submitted.map(action => action.type)).toEqual(["businessObjectUpsert", "businessObjectDelete"]);
    let description = describeAction({ ...submitted[0]!, id: 1 } as MarketoAction);
    expect(description).toMatchObject({ awaitDecision: true, implementsRevert: false });
    expect(description.description).toContain("company");
    expect(description.description).toContain("dedupeFields");
    expect(description.description).toContain("`company`, `industry`");
    expect(description.description).toContain("Secret Corp");
    expect(description.description).toContain('"externalCompanyId": "secret-id"');
    let deletion = describeAction({ ...submitted[1]!, id: 2 } as MarketoAction);
    expect(deletion.description).toContain('"id": 9');
    let bounded = describeAction({
      id: 3, type: "businessObjectDelete", kind: "company", matchBy: "idField",
      records: Array.from({ length: 20 }, (_, id) => ({ id: id + 1 })), changedFields: ["id"],
    });
    expect(bounded.description).toContain("Record 20");
    expect(bounded.description).toContain('"id": 20');
    let privateFields = describeAction({
      id: 4, type: "businessObjectUpsert", kind: "company", matchBy: "dedupeFields",
      records: [{ externalCompanyId: "<target>*".repeat(20), company: "Never display this" }],
      action: "createOrUpdate", changedFields: ["company"],
    });
    expect(privateFields.description).toContain("<target>*".repeat(20));
    expect(privateFields.description).toContain("Never display this");
  });

  it("caches native CRM read-only and exempts named accounts", async () => {
    let submitted: MarketoActionInput[] = [];
    let { ctx, access } = businessContext({
      describeBusinessObject: async () => ({ crmManaged: true, fields: [] }),
    }, submitted);
    let company = new MarketoBusinessObjectImpl(ctx, "company");
    expect((await company.describe()).access).toBe("read-only");
    await expect(company.upsert([{ externalCompanyId: "x" }])).rejects.toThrow(/read-only/);
    expect(access.get("company")).toBe("read-only");
    await new MarketoBusinessObjectImpl(ctx, "namedAccount").upsert([{ name: "Allowed" }]);
    expect(submitted).toHaveLength(1);
  });

  it("reports permission-blocked opportunity roles unavailable without affecting companies", async () => {
    let { ctx, access } = businessContext({
      describeBusinessObject: async kind => {
        if (kind === "opportunityRole") throw new MarketoError("Access denied", { code: "603" });
        return { name: "Company", fields: [] };
      },
    });
    expect((await new MarketoBusinessObjectImpl(ctx, "opportunityRole").describe()).access)
      .toBe("unavailable");
    expect(access.get("opportunityRole")).toBe("unavailable");
    expect((await new MarketoBusinessObjectImpl(ctx, "company").describe()).access)
      .toBe("read-write");
  });

  it("is reachable only from the whole-instance session", () => {
    let session = new MarketoSessionImpl(stubContext({}));
    expect(session.getBusinessObject("company")).toBeInstanceOf(MarketoBusinessObjectImpl);
    expect("getBusinessObject" in new MarketoStaticListImpl(stubContext({}), 1)).toBe(false);
    expect("getBusinessObject" in new MarketoProgramImpl(stubContext({}), 1)).toBe(false);
    expect(() => session.getBusinessObject("lead" as never)).toThrow(/expected union/);
  });
});

describe("program token names", () => {
  it("qualifies the bare names Marketo reports, so they round-trip into a campaign", () => {
    expect(qualifyTokenName("discount")).toBe("{{my.discount}}");
    expect(qualifyTokenName("my.CurrentYear")).toBe("{{my.CurrentYear}}");
    expect(qualifyTokenName("{{my.Event Date}}")).toBe("{{my.Event Date}}");
    expect(qualifyTokenName("  spaced  ")).toBe("{{my.spaced}}");
  });

  it("returns qualified names from getTokens", async () => {
    let program = new MarketoProgramImpl(stubContext({
      getProgramTokens: async () => [
        { name: "discount", type: "text", value: "v" },
        { name: "CurrentYear", type: "number", value: "2026" },
      ],
    }), 4400);
    expect((await program.getTokens()).map(t => t.name))
      .toEqual(["{{my.discount}}", "{{my.CurrentYear}}"]);
  });

  it("accepts documented bare token names for campaign requests and schedules", async () => {
    let submitted: MarketoActionInput[] = [];
    let ctx = stubContext({
      getCampaign: async () => ({ id: 7, name: "Campaign", type: "batch", isTriggerable: true }),
      getSmartCampaign: async () => ({
        id: 7,
        name: "Campaign",
        type: "batch",
        isTriggerable: true,
        folder: { id: 44, type: "Program" },
      }),
    });
    ctx.submit = async action => void submitted.push(action);
    let campaign = new MarketoSmartCampaignImpl(ctx, 7);

    await campaign.requestCampaign([1], [{ name: "Discount", value: "10%" }]);
    await campaign.schedule(new Date(Date.now() + 10 * 60 * 1000), [
      { name: "CurrentYear", value: "2026" },
    ]);

    expect(submitted.map(action => action.type)).toEqual(["campaignTrigger", "campaignSchedule"]);
  });
});

describe("program channel metadata", () => {
  it("reuses one channel lookup across concurrent and later summaries", async () => {
    let channelCalls = 0;
    let program = new MarketoProgramImpl(stubContext({
      getProgram: async () => ({ id: 4400, name: "Newsletter", channel: "Email" }),
      getChannels: async () => {
        channelCalls++;
        return [{
          name: "Email",
          progressionStatuses: [{ name: "Member" }, { name: "Success" }],
        }];
      },
    }), 4400);

    let [first, second] = await Promise.all([program.describe(), program.describe()]);
    expect(first.statuses).toEqual(["Member", "Success"]);
    expect(second.statuses).toEqual(first.statuses);
    expect((await program.describe()).statuses).toEqual(first.statuses);
    expect(channelCalls).toBe(1);
  });
});

describe("missing handles", () => {
  // Token lookup reports a missing folder even though the caller holds a program handle.
  it("reports a program's folder-not-found as the program being missing", async () => {
    let program = new MarketoProgramImpl(stubContext({
      getProgramTokens: async () => {
        throw new MarketoError("Folder not found", { code: "702" });
      },
    }), 999);
    await expect(program.getTokens()).rejects.toThrow("Marketo program 999 was not found.");
  });

  it("classifies the normalized error as not-found, so callers need not read the text", async () => {
    let program = new MarketoProgramImpl(stubContext({
      getProgramMembers: async () => {
        throw new MarketoError("Program '999' not found", { code: "1013" });
      },
    }), 999);
    let error = await program.getMembers().catch(e => e);
    expect(error.isNotFound).toBe(true);
    expect(Object.keys(error)).toContain("isNotFound");
  });

  it("leaves unrelated failures alone", async () => {
    let program = new MarketoProgramImpl(stubContext({
      getProgramTokens: async () => {
        throw new MarketoError("Access token expired", { code: "602" });
      },
    }), 1);
    await expect(program.getTokens()).rejects.toThrow("Access token expired");
  });
});

describe("filter value limits", () => {
  it("refuses more values than Marketo's GET can carry, rather than emitting HTTP 414", async () => {
    let session = new MarketoSessionImpl(stubContext({}));
    let values = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => `v${i}`);
    await expect(session.findPeople("email", values)).rejects.toThrow(/at most 300 search values/);
  });

  it("allows exactly the limit", async () => {
    let session = new MarketoSessionImpl(stubContext({ getLeads: async () => [] }));
    let values = Array.from({ length: MAX_FILTER_VALUES }, (_, i) => `v${i}`);
    await expect(session.findPeople("email", values)).resolves.toEqual([]);
  });
});

describe("program name lookup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for the asset API's full page instead of its silent default of 20", async () => {
    let { client, calls } = clientReturning({ success: true, result: [] });
    await client.getProgramsByName("Regional Opt In");
    expect(calls[0]).toContain(`maxReturn=${ASSET_PAGE_MAX}`);
  });

  it("refuses to present a truncated list as every match", async () => {
    let session = new MarketoSessionImpl(stubContext({
      getProgramsByName: async () =>
        Array.from({ length: ASSET_PAGE_MAX }, (_, i) => ({ id: i, name: "dup" })),
    }));
    await expect(session.findProgramsByName("dup")).rejects.toThrow(/at least 200 Marketo programs/);
  });

  it("returns a partial page as the complete answer it is", async () => {
    let session = new MarketoSessionImpl(stubContext({
      getProgramsByName: async () => [{ id: 4100, name: "Regional Opt In" }],
    }));
    expect((await session.findProgramsByName("Regional Opt In")).map(p => p.id)).toEqual([4100]);
  });
});

describe("filter reads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns every person page through findPeople", async () => {
    let requests: { url: string; init: RequestInit }[] = [];
    let envelopes = [
      { success: true, result: [{ id: 1, email: "a@example.com" }], moreResult: true, nextPageToken: "people-2" },
      { success: true, result: [{ id: 2, email: "a@example.com" }], moreResult: false },
    ];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Response.json(envelopes.shift());
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });

    let people = await new MarketoSessionImpl(stubContext(client)).findPeople("email", ["a@example.com"]);

    expect(people.map(person => person.id)).toEqual([1, 2]);
    expect(requests[1]?.init.method).toBe("POST");
    expect(new URL(requests[1]!.url).searchParams.get("_method")).toBe("GET");
    expect(new URLSearchParams(String(requests[1]?.init.body)).get("nextPageToken")).toBe("people-2");
  });

  it("returns every custom-object page through query", async () => {
    let bodies: string[] = [];
    let envelopes = [
      { success: true, result: [{ marketoGUID: "g1", sourceID: "1" }], moreResult: true, nextPageToken: "objects-2" },
      { success: true, result: [{ marketoGUID: "g2", sourceID: "1" }], moreResult: false },
    ];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Response.json(envelopes.shift());
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });

    let records = await new MarketoCustomObjectImpl(stubContext(client), "orderStatus")
      .query("sourceID", ["1"]);

    expect(records.map(record => record.marketoGUID)).toEqual(["g1", "g2"]);
    expect(new URLSearchParams(bodies[1]).get("nextPageToken")).toBe("objects-2");
  });

  it("returns every compound custom-object page with paging in the JSON body", async () => {
    let requests: { url: string; body: Record<string, unknown> }[] = [];
    let envelopes = [
      { success: true, result: [{ marketoGUID: "g1" }], moreResult: true, nextPageToken: "compound-2" },
      { success: true, result: [{ marketoGUID: "g2" }], moreResult: false },
    ];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json(envelopes.shift());
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    let key = { sourceID: "source-1", leadID: 7 };

    let records = await client.queryCustomObjectByDedupeKeys("orderStatus", [key], ["status"]);

    expect(records.map(record => record.marketoGUID)).toEqual(["g1", "g2"]);
    expect(requests.map(request => [...new URL(request.url).searchParams])).toEqual([
      [["_method", "GET"]], [["_method", "GET"]],
    ]);
    expect(requests.map(request => request.body)).toEqual([
      { filterType: "dedupeFields", fields: ["status"], input: [key], batchSize: MAX_FILTER_VALUES },
      {
        filterType: "dedupeFields",
        fields: ["status"],
        input: [key],
        batchSize: MAX_FILTER_VALUES,
        nextPageToken: "compound-2",
      },
    ]);
  });

  it("rejects missing and repeated filter continuation tokens", async () => {
    let missing = clientReturning({
      success: true, result: [{ id: 1 }], moreResult: true,
    }).client;
    await expect(missing.getLeads("email", ["a@example.com"]))
      .rejects.toThrow("moreResult without a valid nextPageToken");

    let repeated = clientReturning(
      { success: true, result: [{ id: 1 }], moreResult: true, nextPageToken: "same" },
      { success: true, result: [{ id: 2 }], moreResult: true, nextPageToken: "same" },
    ).client;
    await expect(repeated.queryCustomObject("orderStatus", "sourceID", ["1"]))
      .rejects.toThrow("repeated the requested nextPageToken");
  });

  it("bounds complete filter result materialization without authorizing a partial read", async () => {
    let page = (start: number, length: number, moreResult: boolean) => ({
      success: true,
      result: Array.from({ length }, (_, offset) => ({ id: start + offset })),
      moreResult,
      ...(moreResult ? { nextPageToken: `after-${start + length}` } : {}),
    });
    let complete = clientReturning(
      page(0, 300, true),
      page(300, 300, true),
      page(600, 300, true),
      page(900, 100, false),
    ).client;
    await expect(complete.getLeads("email", ["a@example.com"]))
      .resolves.toHaveLength(1_000);

    let overflow = clientReturning(
      page(0, 300, true),
      page(300, 300, true),
      page(600, 300, true),
      page(900, 101, false),
    ).client;
    let notes: string[] = [];
    let error = await new MarketoCustomObjectImpl(stubContext(overflow, notes), "orderStatus")
      .query("sourceID", ["1"])
      .catch(error => error);
    expect(error).toBeInstanceOf(MarketoError);
    expect(error.message).toMatch(/more than 1000 filtered records; narrow the filter/);
    expect(error.operation).toBe("/v1/customobjects/orderStatus.json");
    expect(notes).toEqual([]);
  });

  it("rejects empty filter continuation pages", async () => {
    let empty = clientReturning({
      success: true,
      result: [],
      moreResult: true,
      nextPageToken: "next",
    }).client;
    await expect(empty.getLeads("email", ["a@example.com"]))
      .rejects.toThrow(/invalid filter paging state/);
  });

  it("continues filter reads beyond 100 pages rather than discarding valid results", async () => {
    let paged = clientReturning(...Array.from({ length: 101 }, (_, index) => ({
      success: true,
      result: [{ id: index }],
      moreResult: index < 100,
      nextPageToken: index < 100 ? `page-${index + 1}` : undefined,
    })));
    await expect(paged.client.getLeads("email", ["a@example.com"]))
      .resolves.toHaveLength(101);
    expect(paged.calls).toHaveLength(101);
  });

  // Large filters use Marketo's POST-with-method-override read form to avoid oversized URLs.
  it("sends person filters as a form body Marketo routes as a read", async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen = init;
      return Response.json({ success: true, result: [] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    await client.getLeads("email", ["a@example.com", "b@example.com"], ["id"]);
    expect(seen?.method).toBe("POST");
    expect(String(seen?.body)).toContain("filterValues=a%40example.com%2Cb%40example.com");
  });

  it("marks the request as a read so it cannot land on the upsert endpoint", async () => {
    let { client, calls } = clientReturning({ success: true, result: [] });
    await client.queryCustomObject("orderStatus", "sourceID", ["1"]);
    expect(calls[0]).toContain("_method=GET");
  });

  it("rejects literal commas in every comma-delimited filter API", async () => {
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches++;
      return Response.json({ success: true, result: [] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    let requests = [
      () => client.getLeads("company", ["Acme, Inc."]),
      () => client.queryCustomObject("orderStatus", "sourceID", ["north,west"]),
      () => client.queryBusinessObject("company", {
        filter: { field: "name", values: ["Acme, Inc."] },
      }),
    ];

    for (let request of requests) await expect(request()).rejects.toThrow(/cannot contain commas/);
    expect(fetches).toBe(0);
  });
});

describe("Marketo request encoding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends static-list removals as the DELETE body Marketo expects", async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen = init;
      return Response.json({ success: true, result: [{ id: 7, status: "removed" }] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });

    await client.removeLeadsFromList(5, [7, 8]);

    expect(seen?.method).toBe("DELETE");
    expect(JSON.parse(String(seen?.body))).toEqual({ input: [{ id: 7 }, { id: 8 }] });
  });

  it("comma-separates activity type and lead ids", async () => {
    let url = "";
    vi.stubGlobal("fetch", async (requestUrl: string) => {
      url = requestUrl;
      return Response.json({ success: true, result: [], moreResult: false });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });

    await client.getActivities({
      nextPageToken: "page",
      activityTypeIds: [1, 2],
      leadIds: [7, 8],
    });

    let query = new URL(url).searchParams;
    expect(query.getAll("activityTypeIds")).toEqual(["1,2"]);
    expect(query.getAll("leadIds")).toEqual(["7,8"]);
  });

  it("rejects a non-array result before normalization", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ success: true, result: {} }));
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    await expect(client.getLeads("email", ["a@example.com"])).rejects.toThrow(
      /unexpected shape/,
    );
  });

  it("notifies the account after refreshed credentials are rejected", async () => {
    let notifications = 0;
    vi.stubGlobal("fetch", async () => Response.json(
      { success: false, errors: [{ code: "601", message: "Access token invalid" }] },
      { status: 401 },
    ));
    let client = new MarketoClient(ORIGIN, {
      getToken: async forceRefresh => {
        if (forceRefresh) {
          throw new MarketoError("Bad credentials", { code: "invalid_client", status: 400 });
        }
        return "stale-token";
      },
      credentialsExpired: async () => void notifications++,
    });

    await expect(client.getLeads("email", ["a@example.com"])).rejects.toThrow("Bad credentials");
    expect(notifications).toBe(1);
  });

  it("preserves the provider auth rejection when expiry notification fails", async () => {
    vi.stubGlobal("fetch", async () => Response.json(
      { success: false, errors: [{ code: "601", message: "invalid" }] },
      { status: 401 },
    ));
    let log = vi.spyOn(console, "warn").mockImplementation(() => {});
    let client = new MarketoClient(ORIGIN, {
      getToken: async force => force ? "refreshed" : "stale",
      credentialsExpired: async () => { throw new Error("callback marker"); },
    });

    let error = await client.getLeads("email", ["a@example.com"]).catch(value => value);
    expect(error).toBeInstanceOf(MarketoError);
    expect(error.code).toBe("601");
    expect(error.isAuthError).toBe(true);
    expect(error.message).not.toContain("callback marker");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "marketo_credentials_expired_callback_failed",
      error: "Error",
    }));
    log.mockRestore();
  });

  it("uses documented deadlines for asset, paging-token, and sync endpoints", async () => {
    let deadlines: number[] = [];
    let timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      deadlines.push(ms);
      return new AbortController().signal;
    });
    vi.stubGlobal("fetch", async (url: string) => Response.json(
      url.includes("/activities/pagingtoken.json")
        ? { success: true, nextPageToken: "activities" }
        : { success: true, result: [] },
    ));
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });

    await client.getLeads("email", ["a@example.com"]);
    await client.getFolders();
    await client.createDesignerAsset("email", {});
    await client.getPagingToken(new Date("2026-01-01T00:00:00Z"));
    await client.syncLeads([{ email: "a@example.com" }], "createOnly", "email");
    await client.syncCustomObject("orders", [{ sourceId: "1" }]);
    expect(deadlines).toEqual([60_000, 300_000, 300_000, 300_000, 90_000, 120_000]);
    timeout.mockRestore();
  });

  it("reserves a prepared token for exactly the next request", async () => {
    let now = Date.now();
    let lookups = 0;
    let lookupCountsAtFetch: number[] = [];
    vi.stubGlobal("fetch", async () => {
      lookupCountsAtFetch.push(lookups);
      return Response.json({ success: true, result: [{ status: "scheduled" }] });
    });
    let client = new MarketoClient(ORIGIN, {
      getToken: async () => {
        lookups++;
        if (lookups > 1) now += 2 * 60 * 1000;
        return `token-${lookups}`;
      },
    });
    let action: MarketoAction = {
      id: 1, type: "campaignSchedule", campaignId: 7, campaignName: "Campaign",
      programId: null,
      runAt: new Date(now + 5 * 60 * 1000 + 1).toISOString(),
    };

    await client.prepare();
    validateActionForDispatch(action, now);
    await client.scheduleCampaign(7, new Date(action.runAt));
    expect(lookupCountsAtFetch).toEqual([1]);

    await client.getLeads("email", ["person@example.com"]);
    expect(lookupCountsAtFetch).toEqual([1, 2]);
  });

  it("refreshes once when a prepared token is rejected", async () => {
    let refreshes: (boolean | undefined)[] = [];
    let requests = 0;
    vi.stubGlobal("fetch", async () => ++requests === 1
      ? Response.json({ success: false, errors: [{ code: "601" }] }, { status: 401 })
      : Response.json({ success: true, result: [{ id: 7, status: "updated" }] }));
    let client = new MarketoClient(ORIGIN, {
      getToken: async force => {
        refreshes.push(force);
        return force ? "fresh" : "prepared";
      },
    });

    await client.prepare();
    await expect(client.syncLeads([{ id: 7 }], "updateOnly", "id"))
      .resolves.toEqual([{ id: 7, status: "updated" }]);
    expect(refreshes).toEqual([undefined, true]);
    expect(requests).toBe(2);
  });

  it("does not retain an older reservation when prepare fails", async () => {
    let lookups = 0;
    let authorization: string | null = null;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return Response.json({ success: true, result: [] });
    });
    let client = new MarketoClient(ORIGIN, {
      getToken: async () => {
        lookups++;
        if (lookups === 2) throw new Error("lookup failed");
        return lookups === 1 ? "old" : "fresh";
      },
    });

    await client.prepare();
    await expect(client.prepare()).rejects.toThrow("lookup failed");
    await client.getLeads("email", ["person@example.com"]);
    expect(authorization).toBe("Bearer fresh");
    expect(lookups).toBe(3);
  });

  it("classifies Identity endpoint invalid_client responses as credential failures", async () => {
    let marker = "secret-credential-marker";
    vi.stubGlobal("fetch", async () => Response.json(
      { error: "invalid_client", error_description: `Bad client credentials: ${marker}` },
      { status: 400 },
    ));
    let error = await fetchAccessToken({
      endpoint: ORIGIN,
      clientId: "client",
      clientSecret: "secret",
    }).catch(value => value);
    expect(error).toBeInstanceOf(MarketoError);
    expect(error.isAuthError).toBe(true);
    expect(error.code).toBe("invalid_client");
    expect(error.status).toBe(400);
    expect(error.message).toBe("Marketo authentication failed (code invalid_client; HTTP 400).");
    expect(`${error.message}\n${error.stack}`).not.toContain(marker);
  });

  it("withholds arbitrary Identity error values", async () => {
    let marker = "secretcredentialmarker";
    vi.stubGlobal("fetch", async () => Response.json({ error: marker }, { status: 400 }));
    let error = await fetchAccessToken({
      endpoint: ORIGIN,
      clientId: "client",
      clientSecret: "secret",
    }).catch(value => value);
    expect(error).toBeInstanceOf(MarketoError);
    expect(error.code).toBeUndefined();
    expect(`${error.message}\n${error.stack}`).not.toContain(marker);
  });

  it("rejects redirects for Identity credentials and API bearer tokens", async () => {
    let requests: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      requests.push(init ?? {});
      return requests.length === 1
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : Response.json({ success: true, result: [] });
    });

    await fetchAccessToken({ endpoint: ORIGIN, clientId: "client", clientSecret: "secret" });
    await new MarketoClient(ORIGIN, { getToken: async () => "token" })
      .getLeads("email", ["a@example.com"]);

    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.redirect === "error")).toBe(true);
  });

  it("sanitizes redirect failures without retrying writes", async () => {
    let calls = 0;
    let marker = "redirected-to-attacker";
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw new Error(marker);
    });

    let identityError = await fetchAccessToken({
      endpoint: ORIGIN, clientId: "client", clientSecret: "secret",
    }).catch(error => error);
    expect(identityError.message).toBe("Could not reach the Marketo Identity endpoint.");
    expect(`${identityError.message}\n${identityError.stack}`).not.toContain(marker);

    let client = new MarketoClient(ORIGIN, { getToken: async () => "token" });
    let apiError = await client.syncLeads([{ email: "a@example.com" }], "createOnly", "email")
      .catch(error => error);
    expect(apiError.message).toBe("Could not reach the Marketo API.");
    expect(`${apiError.message}\n${apiError.stack}`).not.toContain(marker);
    expect(calls).toBe(2);
  });

  it("withholds provider-controlled API error text", async () => {
    let marker = "customer-data-marker";
    let { client } = clientReturning({
      success: false,
      errors: [{ code: "1003", message: `Rejected value ${marker}` }],
    });
    let error = await client.getLeads("email", ["a@example.com"]).catch(value => value);
    expect(error).toBeInstanceOf(MarketoError);
    expect(error.code).toBe("1003");
    expect(error.isProviderRejection).toBe(true);
    expect(error.operation).toBe("/v1/leads.json");
    expect(error.message).toBe("Marketo request failed (code 1003; HTTP 200).");
    expect(`${error.message}\n${error.stack}`).not.toContain(marker);
  });
});

describe("token cache RPC protocol", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  class TestIdentityTokenAuthority extends RpcTarget implements IdentityTokenAuthority {
    async fetchIdentityToken(expected: TokenCredentialState) {
      try {
        return { ok: true as const, value: await fetchAccessToken(expected.credentials) };
      } catch (error) {
        return { ok: false as const, error: serializeTokenError(error) };
      }
    }
  }

  function cache() {
    let namespace = (env as unknown as {
      MarketoTokenCache: DurableObjectNamespace<MarketoTokenCache>;
    }).MarketoTokenCache;
    let raw = namespace.get(namespace.newUniqueId());
    return {
      raw,
      async getToken(creds: MarketoCredentials, forceRefresh = false) {
        let authority = new RpcStub(new TestIdentityTokenAuthority());
        try {
          let result = await raw.getToken(
            creds,
            forceRefresh,
            authority,
            { credentials: creds, generation: 1 },
          );
          try {
            if ("credentialChanged" in result) throw new Error("Unexpected credential change.");
            return result.ok
              ? { ok: true as const, value: result.value }
              : { ok: false as const, error: { ...result.error } };
          } finally {
            result[Symbol.dispose]();
          }
        } finally {
          authority[Symbol.dispose]();
        }
      },
    };
  }

  it("serializes auth and network failures as sanitized tagged results", async () => {
    let marker = "provider-secret-marker";
    let creds = { endpoint: ORIGIN, clientId: crypto.randomUUID(), clientSecret: marker };
    vi.stubGlobal("fetch", async () => Response.json(
      { error: "invalid_client", error_description: marker },
      { status: 401 },
    ));
    let auth = await cache().getToken(creds);
    expect(auth).toEqual({
      ok: false,
      error: { kind: "auth", code: "invalid_client", status: 401 },
    });
    expect(JSON.stringify(auth)).not.toContain(marker);
    expect(() => unwrapTokenCacheResult(auth)).toThrow(/authentication failed/);

    vi.stubGlobal("fetch", async () => { throw new Error(marker); });
    let network = await cache().getToken({ ...creds, clientId: crypto.randomUUID() });
    expect(network).toEqual({ ok: false, error: { kind: "network" } });
    expect(JSON.stringify(network)).not.toContain(marker);
  });

  it("serves a repeated nearly-expired token until expiry and then refreshes", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return Response.json({
        access_token: calls < 3 ? "same-token" : "replacement-token",
        expires_in: 60,
      });
    });
    let stub = cache();
    let creds = { endpoint: ORIGIN, clientId: crypto.randomUUID(), clientSecret: "secret" };

    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("same-token");
    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("same-token");
    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("same-token");
    expect(calls).toBe(2);

    now += 61_000;
    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("replacement-token");
    expect(calls).toBe(3);
  });

  it("accepts a repeated token with a fractional positive lifetime without caching an outage", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    vi.stubGlobal("fetch", async () => Response.json({
      access_token: ++calls < 3 ? "expiring-token" : "replacement-token",
      expires_in: calls === 2 ? 0.25 : 60,
    }));
    let stub = cache();
    let creds = { endpoint: ORIGIN, clientId: crypto.randomUUID(), clientSecret: "secret" };

    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("expiring-token");
    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("expiring-token");
    now += 249;
    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("expiring-token");
    expect(calls).toBe(2);
    now++;
    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("replacement-token");
    expect(calls).toBe(3);
  });

  it("serves an unexpired cached token when proactive refresh fails transiently", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      if (++calls > 1) throw new Error("Identity unavailable");
      return Response.json({ access_token: "cached-token", expires_in: 300 });
    });
    let stub = cache();
    let creds = { endpoint: ORIGIN, clientId: crypto.randomUUID(), clientSecret: "secret" };

    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("cached-token");
    now += 181_000;
    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("cached-token");
    now += 29_999;
    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("cached-token");
    expect(calls).toBe(2);
    now++;
    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("cached-token");
    expect(calls).toBe(3);
  });

  it("stops serving a fallback token at its actual expiry", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      if (++calls > 1) throw new Error("Identity unavailable");
      return Response.json({ access_token: "cached-token", expires_in: 300 });
    });
    let stub = cache();
    let creds = { endpoint: ORIGIN, clientId: crypto.randomUUID(), clientSecret: "secret" };

    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("cached-token");
    now += 291_000;
    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("cached-token");
    now += 9_000;
    await expect(stub.getToken(creds)).resolves.toEqual({
      ok: false,
      error: { kind: "network" },
    });
    expect(calls).toBe(2);
  });

  it("does not fall back to a cached token for a forced refresh", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      if (++calls > 1) throw new Error("Identity unavailable");
      return Response.json({ access_token: "cached-token", expires_in: 300 });
    });
    let stub = cache();
    let creds = { endpoint: ORIGIN, clientId: crypto.randomUUID(), clientSecret: "secret" };

    expect(unwrapTokenCacheResult(await stub.getToken(creds))).toBe("cached-token");
    await expect(stub.getToken(creds, true)).resolves.toEqual({
      ok: false,
      error: { kind: "network" },
    });
    expect(calls).toBe(2);
  });

  it.each([0, -1])("rejects an access token with an unusable %s-second lifetime", async expiresIn => {
    vi.stubGlobal("fetch", async () => Response.json({
      access_token: "already-expired-token",
      expires_in: expiresIn,
    }));
    await expect(fetchAccessToken({
      endpoint: ORIGIN,
      clientId: crypto.randomUUID(),
      clientSecret: "secret",
    })).rejects.toThrow(/unusable lifetime/);
  });

  it("does not return or repeatedly refresh the same expired token", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return Response.json({ access_token: "expired-token", expires_in: 0 });
    });
    let stub = cache();
    let creds = { endpoint: ORIGIN, clientId: crypto.randomUUID(), clientSecret: "secret" };
    await runInDurableObject(stub.raw, (_instance, state) => {
      state.storage.kv.put("token", { accessToken: "expired-token", expiresAt: now - 1 });
    });

    let first = await stub.getToken(creds);
    let second = await stub.getToken(creds);
    expect(first).toMatchObject({ ok: false, error: { kind: "provider" } });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("expired-token");
    expect(calls).toBe(1);
  });
});

// The lead-database status endpoint requires `status`; Marketo's other status endpoint uses
// `statusName`.
describe("program member status payload", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names the status field the way Marketo actually reads it", async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen = init;
      return Response.json({ success: true, result: [] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    await client.setProgramMemberStatus(3300, [8080], "Member");

    let body = JSON.parse(String(seen?.body)) as Record<string, unknown>;
    expect(body.status).toBe("Member");
    expect(body).not.toHaveProperty("statusName");
    expect(body.input).toEqual([{ id: 8080 }]);
  });
});

// A batch campaign cannot be requested and a trigger campaign cannot be scheduled. Marketo only
// says so on apply, which would waste a human's approval on a doomed action, so both are checked
// before anything is submitted.
describe("campaign kind pre-validation", () => {
  function campaign(type: string, submitted: MarketoActionInput[]) {
    return new MarketoSmartCampaignImpl(
      {
        client: async () => ({
          getSmartCampaign: async () => ({
            id: 7800,
            name: "Quarterly Batch",
            type,
            folder: { id: 42, type: "Program" },
          }),
          getCampaign: async () => ({
            id: 7800,
            name: "Quarterly Batch",
            type,
            isTriggerable: type === "trigger",
          }),
        }) as never,
        observe: async () => {},
        submit: async action => void submitted.push(action),
        pendingCampaign: () => [],
        resolveId: (id: string) => Number(id),
        retain: () => {},
        dispose: () => {},
      },
      7800,
    );
  }

  it("refuses to request a batch campaign, without submitting anything", async () => {
    let submitted: MarketoActionInput[] = [];
    await expect(campaign("batch", submitted).requestCampaign([1])).rejects.toThrow(
      /not configured.*Campaign is Requested/,
    );
    expect(submitted).toEqual([]);
  });

  it("refuses to schedule a trigger campaign, without submitting anything", async () => {
    let submitted: MarketoActionInput[] = [];
    await expect(
      campaign("trigger", submitted).schedule(new Date(Date.now() + 10 * 60 * 1000)),
    ).rejects.toThrow(
      /not a batch campaign/,
    );
    expect(submitted).toEqual([]);
  });

  it("refuses a trigger campaign without the Web Service API trigger", async () => {
    let submitted: MarketoActionInput[] = [];
    let notRequestable = new MarketoSmartCampaignImpl(
      {
        client: async () => ({
          getSmartCampaign: async () => ({ id: 7800, name: "Trigger", type: "trigger" }),
          getCampaign: async () => ({ id: 7800, name: "Trigger", type: "trigger" }),
        }) as never,
        observe: async () => {},
        submit: async action => void submitted.push(action),
        pendingCampaign: () => [],
        resolveId: (id: string) => Number(id),
        retain: () => {},
        dispose: () => {},
      },
      7800,
    );
    await expect(notRequestable.requestCampaign([1])).rejects.toThrow(/Web Service API trigger/);
    expect(submitted).toEqual([]);
  });

  it("enforces campaign input and schedule limits before approval", async () => {
    let submitted: MarketoActionInput[] = [];
    await expect(
      campaign("trigger", submitted).requestCampaign(Array.from({ length: 101 }, (_, i) => i + 1)),
    ).rejects.toThrow(/at most 100 people/);
    await expect(
      campaign("batch", submitted).schedule(new Date(Date.now() + 60_000)),
    ).rejects.toThrow(/between 5 minutes and 2 years/);
    expect(submitted).toEqual([]);
  });

  it("accepts bare or fully-qualified My Token override names", async () => {
    let submitted: MarketoActionInput[] = [];
    for (let name of ["{{lead.Email}}", "{{anything}}", "{{my.bad}}suffix"]) {
      await expect(campaign("trigger", submitted).requestCampaign([1], [{ name, value: "x" }]))
        .rejects.toThrow(/\{\{my\.\*\}\}/);
    }
    for (let name of [
      "{{my.   }}",
      "{{my.Bad\nName}}",
      "{{my.Bad\rName}}",
      "{{my.Bad\u0000Name}}",
      "{{my.Bad\u0085Name}}",
      "{{my.Bad\u2028Name}}",
      "{{my. Leading}}",
      "{{my.Trailing }}",
    ]) {
      await expect(campaign("trigger", submitted).requestCampaign([1], [{ name, value: "x" }]))
        .rejects.toThrow(/non-whitespace single-line/);
    }
    await campaign("trigger", submitted).requestCampaign([1], [{ name: "Year", value: "x" }]);
    await campaign("trigger", submitted).requestCampaign([1], [{ name: "{{my.Year}}", value: "x" }]);
    await campaign("trigger", submitted).requestCampaign([1], [{ name: "{{my.Event Date}}", value: "x" }]);
    expect(submitted).toHaveLength(3);
  });

  it("still submits each operation for the kind that supports it", async () => {
    let requested: MarketoActionInput[] = [];
    await campaign("trigger", requested).requestCampaign([1]);
    expect(requested.map(a => a.type)).toEqual(["campaignTrigger"]);
    expect(requested[0]).toMatchObject({ programId: "42" });

    let scheduled: MarketoActionInput[] = [];
    await campaign("batch", scheduled).schedule(new Date(Date.now() + 10 * 60 * 1000));
    expect(scheduled.map(a => a.type)).toEqual(["campaignSchedule"]);
    expect(scheduled[0]).toMatchObject({ programId: "42" });
  });

  it("rejects invalid owning Program identity before submission", async () => {
    let submitted: MarketoActionInput[] = [];
    let campaign = new MarketoSmartCampaignImpl({
      client: async () => ({
        getSmartCampaign: async () => ({
          id: 7800, name: "Campaign", type: "trigger", folder: { id: 0, type: "Program" },
        }),
      }) as never,
      observe: async () => {},
      submit: async (action: MarketoActionInput) => void submitted.push(action),
      pendingCampaign: () => [],
      resolveId: (id: string) => Number(id),
      dispose: () => {},
    } as never, 7800);

    await expect(campaign.delete()).rejects.toThrow(/invalid owning Program identity/);
    expect(submitted).toEqual([]);
  });

  it.each([
    ["request", "trigger"],
    ["schedule", "batch"],
  ] as const)("refuses to %s a campaign with a pending deletion", async (operation, type) => {
    let reads = 0;
    let submitted: MarketoActionInput[] = [];
    let campaign = new MarketoSmartCampaignImpl({
      client: async () => ({
        getCampaign: async () => {
          reads++;
          return { id: 7800, name: "Deleted", type, isTriggerable: true };
        },
      }) as never,
      observe: async () => {},
      submit: async (action: MarketoActionInput) => void submitted.push(action),
      submitCampaign: async (action: MarketoActionInput) => void submitted.push(action),
      pendingCampaign: () => [{
        id: 1,
        type: "campaignLifecycle",
        targetId: "~1",
        campaignName: "Deleted",
        campaignType: type,
        programId: null,
        operation: "delete",
      }],
      resolveId: (id: string) => id === "~1" ? 7800 : Number(id),
      dispose: () => {},
    } as never, 7800);

    let result = operation === "request"
      ? campaign.requestCampaign([1])
      : campaign.schedule(new Date(Date.now() + 10 * 60 * 1000));
    await expect(result).rejects.toThrow(/pending deletion/);
    expect(reads).toBe(0);
    expect(submitted).toEqual([]);
  });

  it.each([
    ["request", "trigger"],
    ["schedule", "batch"],
  ] as const)("refuses to %s when deletion becomes pending during the read", async (operation, type) => {
    let release: (() => void) | undefined;
    let entered = Promise.withResolvers<void>();
    let pending: CampaignAction[] = [];
    let submitted: MarketoActionInput[] = [];
    let campaign = new MarketoSmartCampaignImpl({
      client: async () => ({
        getSmartCampaign: async () => {
          entered.resolve();
          await new Promise<void>(resolve => void (release = resolve));
          return { id: 7800, name: "Deleting", type };
        },
        getCampaign: async () => ({ id: 7800, name: "Deleting", type, isTriggerable: true }),
      }) as never,
      observe: async () => {},
      submit: async (action: MarketoActionInput) => void submitted.push(action),
      submitCampaign: async (action: MarketoActionInput) => void submitted.push(action),
      pendingCampaign: () => pending,
      resolveId: (id: string) => Number(id),
      dispose: () => {},
    } as never, 7800);

    let result = operation === "request"
      ? campaign.requestCampaign([1])
      : campaign.schedule(new Date(Date.now() + 10 * 60 * 1000));
    await entered.promise;
    pending.push({
      id: 1,
      type: "campaignLifecycle",
      targetId: "7800",
      campaignName: "Deleting",
      campaignType: type,
      programId: null,
      operation: "delete",
    });
    release?.();

    await expect(result).rejects.toThrow(/pending deletion/);
    expect(submitted).toEqual([]);
  });
});

// Nothing has happened when an ACTION returns, so there is no outcome to report.
describe("actions report no outcome at submission time", () => {
  it("does not let update fields override the approved person id", async () => {
    let person = new MarketoPersonImpl(stubContext({}), { field: "id", value: "7" });
    await expect(person.update({ id: 8, firstName: "A" })).rejects.toThrow(
      /id cannot be changed/,
    );
  });

  it("returns nothing from every write", async () => {
    let ctx = stubContext({
      getCampaign: async () => ({ id: 1, name: "c", type: "trigger", isTriggerable: true }),
      getList: async () => ({ id: 5500, name: "list" }),
      getProgram: async () => ({ id: 3300, name: "prog" }),
      getChannels: async () => [],
      getLeads: async () => ({ result: [{ id: 7 }], moreResult: false }) as never,
      describeCustomObject: async () => ({ dedupeFields: ["sourceID"] }) as never,
    });

    expect(await new MarketoStaticListImpl(ctx, 5500).addMembers([7])).toBeUndefined();
    expect(await new MarketoStaticListImpl(ctx, 5500).removeMembers([7])).toBeUndefined();
    expect(
      await new MarketoCustomObjectImpl(ctx, "orderStatus").createOrUpdate([{ sourceID: "1" }]),
    ).toBeUndefined();
    expect(
      await new MarketoCustomObjectImpl(ctx, "orderStatus").delete([{ sourceID: "1" }]),
    ).toBeUndefined();
    expect(
      await new MarketoSessionImpl(ctx).createOrUpdatePeople([{ email: "a@example.com" }]),
    ).toBeUndefined();
  });

  it.each(["addMembers", "removeMembers"] as const)(
    "rejects %s when the exact static list does not exist before submission",
    async operation => {
      let submitted: MarketoActionInput[] = [];
      let ctx = stubContext({ getList: async () => undefined });
      ctx.submit = async action => void submitted.push(action);

      await expect(new MarketoStaticListImpl(ctx, 5500)[operation]([7]))
        .rejects.toThrow(/static list 5500 was not found/);
      expect(submitted).toEqual([]);
    },
  );

  it("rejects invalid person id upserts without submitting an approval", async () => {
    let submitted: MarketoActionInput[] = [];
    let ctx = stubContext({});
    ctx.submit = async action => void submitted.push(action);
    let session = new MarketoSessionImpl(ctx);

    for (let action of ["createOnly", "createOrUpdate"] as const) {
      await expect(session.createOrUpdatePeople([{ id: 7 }], { action, lookupField: "id" }))
        .rejects.toThrow(/only for updateOnly/);
    }
    for (let id of [undefined, "7", 1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      await expect(session.createOrUpdatePeople(
        [{ id }],
        { action: "updateOnly", lookupField: "id" },
      )).rejects.toThrow(/positive safe integer id/);
    }

    expect(submitted).toEqual([]);
  });

  it("preserves non-id person lookup fields", async () => {
    let submitted: MarketoActionInput[] = [];
    let ctx = stubContext({});
    ctx.submit = async action => void submitted.push(action);
    let session = new MarketoSessionImpl(ctx);

    await session.createOrUpdatePeople(
      [{ externalPersonKey: "person-1" }],
      { action: "createOrUpdate", lookupField: "externalPersonKey" },
    );

    expect(submitted).toEqual([{
      type: "upsertPeople",
      records: [{ externalPersonKey: "person-1" }],
      upsertAction: "createOrUpdate",
      lookupField: "externalPersonKey",
    }]);
  });

  it("requires every person record to contain the selected lookup field", async () => {
    let submitted: MarketoActionInput[] = [];
    let ctx = stubContext({});
    ctx.submit = async action => void submitted.push(action);
    let session = new MarketoSessionImpl(ctx);

    await expect(session.createOrUpdatePeople([{ firstName: "No email" }]))
      .rejects.toThrow(/`email` lookup field/);
    await expect(session.createOrUpdatePeople(
      [{ externalKey: "one" }, { firstName: "Missing key" }],
      { lookupField: "externalKey" },
    )).rejects.toThrow(/`externalKey` lookup field/);
    expect(submitted).toEqual([]);
  });

  it("permits canonical person ids with updateOnly", async () => {
    let submitted: MarketoActionInput[] = [];
    let ctx = stubContext({});
    ctx.submit = async action => void submitted.push(action);

    await new MarketoSessionImpl(ctx).createOrUpdatePeople(
      [{ id: 7, firstName: "Updated" }],
      { action: "updateOnly", lookupField: "id" },
    );

    expect(submitted).toHaveLength(1);
  });
});

// Per-record failures can appear inside a successful response envelope.
describe("fully declined actions do not count as applied", () => {
  it("fails when Marketo skipped every record", () => {
    expect(() =>
      assertApplied([
        { id: 999999999, status: "skipped", reasons: [{ code: "1004", message: "Lead not found" }] },
      ]),
    ).toThrow(/declined all 1 record\(s\).*Marketo code: 1004/);
  });

  it("reports each distinct provider code once without provider text", () => {
    expect(() =>
      assertApplied([
        { status: "skipped", reasons: [{ code: "1013", message: "Record not found" }] },
        { status: "skipped", reasons: [{ code: "1013", message: "Record not found" }] },
      ]),
    ).toThrow(/declined all 2 record\(s\), so nothing was changed \(Marketo code: 1013\)\.$/);
  });

  it("reports partial success so it is not presented as fully applied", () => {
    expect(() =>
      assertApplied([
        { id: 1, status: "updated" },
        { status: "skipped", reasons: [{ code: "1004", message: "Lead not found" }] },
      ]),
    ).toThrow(/applied 1 of 2 record\(s\) and declined 1/);
  });

  it("treats an empty result as uncertain", () => {
    expect(() => assertApplied([])).toThrow(/outcome is uncertain/);
    expect(() => assertApplied([{ id: 7, status: "created" }])).not.toThrow();
  });

  it("treats incomplete and malformed result arrays as uncertain", () => {
    expect(() => assertApplied([{ id: 7, status: "created" }], 2)).toThrow(/1 of 2 expected/);
    expect(() => assertApplied([{}], 1)).toThrow(/outcome is uncertain/);
    expect(() => assertApplied([{ id: "garbage" } as never], 1)).toThrow(/outcome is uncertain/);
    expect(() => assertApplied([null as never], 1)).toThrow(/outcome is uncertain/);
    expect(() => assertApplied([1 as never], 1)).toThrow(/outcome is uncertain/);
    expect(() => assertApplied([{ status: "skipped", reasons: [null] } as never], 1))
      .toThrow(/outcome is uncertain/);
    expect(() => assertApplied([{ status: "skipped", reasons: [{ code: 1018 }] } as never], 1))
      .toThrow(/outcome is uncertain/);
    expect(() => assertApplied([{ id: 7, status: 42 } as never], 1)).toThrow(/outcome is uncertain/);
    expect(() => assertApplied([{ id: 7, marketoGUID: "" } as never], 1)).toThrow(/outcome is uncertain/);
  });
});

async function accountWithCredentials(credentials: MarketoCredentials): Promise<DurableObjectId> {
  let namespace = (env as unknown as { UserAccount: DurableObjectNamespace }).UserAccount;
  let id = namespace.newUniqueId();
  await runInDurableObject(namespace.get(id), (_instance, state) => {
    state.storage.kv.put("credentials", credentials);
  });
  return id;
}

async function gatekeeperForAccount(
  userObjectId: string,
  kind: "instance" | "design-studio" | "program" | "list" = "instance",
  resourceId?: number,
  bindingId = crypto.randomUUID(),
) {
  let namespace = (env as unknown as {
    MarketoGatekeeperImpl: DurableObjectNamespace<MarketoGatekeeperImpl>;
  }).MarketoGatekeeperImpl;
  let stub = namespace.get(namespace.newUniqueId());
  await runInDurableObject(stub, instance => {
    let ctx = (instance as unknown as {
      ctx: {
        props: {
          userObjectId: string;
          bindingId: string;
          kind: "instance" | "design-studio" | "program" | "list";
          resourceId?: number;
        };
      };
    }).ctx;
    ctx.props = { userObjectId, bindingId, kind, resourceId };
  });
  return stub;
}

async function gatekeeperBindingId(
  gatekeeper: DurableObjectStub<MarketoGatekeeperImpl>,
): Promise<string> {
  return await runInDurableObject(gatekeeper, instance =>
    (instance as unknown as { ctx: { props: { bindingId: string } } }).ctx.props.bindingId);
}

class TestApprovalQueue extends RpcTarget {
  constructor(
    private readonly submit: (id: number, description: ActionDescription) => Promise<void> = async () => {},
    private readonly authorize: (description: ObservationDescription) => Promise<void> = async () => {},
  ) {
    super();
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    await this.authorize(description);
  }

  async submitAction(id: number, description: ActionDescription): Promise<void> {
    await this.submit(id, description);
  }
}

describe("binding page cursor storage", () => {
  it("stores provider state server-side and rejects expired or replayed cursors", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "cursor-client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString());
    vi.stubGlobal("fetch", async (urlText: string) => {
      let url = new URL(urlText);
      if (url.pathname === "/identity/oauth/token") {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.pathname === "/rest/v1/lists.json" && url.searchParams.get("nextPageToken")) {
        return Response.json({ success: true, result: [] });
      }
      return Response.json({
        success: true,
        result: [{ id: 1, name: "List" }],
        nextPageToken: "private-provider-token",
      });
    });

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let queue = new RpcStub(new TestApprovalQueue()) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoSessionImpl;
      let expired = (await session.listStaticLists()).nextPageToken!;
      expect(expired).not.toContain("private-provider-token");
      let stored = [...state.storage.kv.list<{ state: unknown; expiresAt: number }>({
        prefix: "pageCursor:",
      })];
      expect(stored).toHaveLength(1);
      expect(stored[0]?.[1].state).toBe("private-provider-token");
      state.storage.kv.put(stored[0]![0], { ...stored[0]![1], expiresAt: Date.now() - 1 });
      await expect(session.listStaticLists({ pageToken: expired }))
        .rejects.toThrow(/static-list page token/);

      let token = (await session.listStaticLists()).nextPageToken!;
      await expect(session.listStaticLists({ pageToken: token }))
        .resolves.toMatchObject({ moreResult: false });
      await expect(session.listStaticLists({ pageToken: token }))
        .rejects.toThrow(/static-list page token/);
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });
});

async function testCredentialFingerprint(credentials: MarketoCredentials): Promise<string> {
  let bytes = new TextEncoder().encode(
    `${credentials.endpoint}\u0000${credentials.clientId}\u0000${credentials.clientSecret}`,
  );
  let digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("read authorization lifetime", () => {
  it.each([
    ["session", "instance", (session: MarketoSessionImpl | MarketoDesignStudioImpl) =>
      (session as MarketoSessionImpl).getChannels()],
    ["Design Studio", "design-studio", (session: MarketoSessionImpl | MarketoDesignStudioImpl) => {
      let email = (session as MarketoDesignStudioImpl).getEmail("20");
      return email.describe().finally(() => email[Symbol.dispose]());
    }],
    ["Email Designer", "design-studio", (session: MarketoSessionImpl | MarketoDesignStudioImpl) => {
      let designer = (session as MarketoDesignStudioImpl).getEmailDesigner();
      let email = designer.getEmail("email-1");
      return email.describe().finally(() => {
        email[Symbol.dispose]();
        designer[Symbol.dispose]();
      });
    }],
    ["business object", "instance", (session: MarketoSessionImpl | MarketoDesignStudioImpl) => {
      let object = (session as MarketoSessionImpl).getBusinessObject("company");
      return object.describe().finally(() => object[Symbol.dispose]());
    }],
  ] as const)("blocks a %s read prepared before revoke", async (_label, kind, read) => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), kind);
    let identityStarted!: () => void;
    let started = new Promise<void>(resolve => { identityStarted = resolve; });
    let releaseIdentity!: () => void;
    let released = new Promise<void>(resolve => { releaseIdentity = resolve; });
    let apiFetches = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        identityStarted();
        await released;
        return Response.json({ access_token: "prepared-token", expires_in: 3600 });
      }
      apiFetches++;
      return Response.json({ success: true, result: [] });
    });

    await runInDurableObject(gatekeeper, async instance => {
      let queue = new RpcStub(new TestApprovalQueue()) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue);
      let pending = read(session as MarketoSessionImpl | MarketoDesignStudioImpl);
      await started;
      await (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
        .UserAccount.get(accountId).revoke();
      releaseIdentity();

      await expect(pending).rejects.toThrow(/account changed/);
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
    expect(apiFetches).toBe(0);
  });

  it("blocks a resource description prepared before revoke", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "program", 7);
    let dispatchStarted!: () => void;
    let started = new Promise<void>(resolve => { dispatchStarted = resolve; });
    let releaseDispatch!: () => void;
    let released = new Promise<void>(resolve => { releaseDispatch = resolve; });
    let originalDispatch = UserAccount.prototype.dispatch;
    let dispatchSpy = vi.spyOn(UserAccount.prototype, "dispatch").mockImplementation(async function(
      this: UserAccount,
      ...args: Parameters<UserAccount["dispatch"]>
    ) {
      dispatchStarted();
      await released;
      return await originalDispatch.apply(this, args);
    });
    let apiFetches = 0;
    vi.stubGlobal("fetch", async () => {
      apiFetches++;
      return Response.json({ success: true, result: [] });
    });

    await runInDurableObject(gatekeeper, async instance => {
      let description = instance.describe();
      await started;
      await (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
        .UserAccount.get(accountId).revoke();
      releaseDispatch();
      await expect(description).resolves.toMatchObject({ title: "Program: Program 7" });
    });
    expect(apiFetches).toBe(0);
    dispatchSpy.mockRestore();
  });

  it("routes configurator reads through the captured account generation", async () => {
    let credentials = { endpoint: ORIGIN, clientId: "client", clientSecret: "secret" };
    let generation = 1;
    let tokenStarted!: () => void;
    let started = new Promise<void>(resolve => { tokenStarted = resolve; });
    let releaseToken!: () => void;
    let released = new Promise<void>(resolve => { releaseToken = resolve; });
    let generationMatched: boolean | undefined;
    let apiFetches = 0;
    vi.stubGlobal("fetch", async () => {
      apiFetches++;
      return Response.json({ success: true, result: [] });
    });
    let account = {
      getCredentials: async () => credentials,
      getCredentialState: async () => ({ credentials, generation }),
      credentialsExpired: async () => {},
      dispatch: async (expected: { generation: number }) => {
        tokenStarted();
        await released;
        generationMatched = expected.generation === generation;
        return { ok: true, response: Response.json({ success: true, result: [] }) };
      },
    };
    let ctx = {
      props: { userObjectId: "account-id" },
      exports: {
        UserAccount: { idFromString: () => "account-id", get: () => account },
        MarketoTokenCache: {
          idFromName: () => "cache-id",
          get: () => ({ getToken: async () => ({ ok: true, value: "token" }) }),
        },
      },
    } as unknown as ExecutionContext;
    let user = new MarketoUserImpl(ctx, TEST_ENV);
    let pattern = SUPPORTED_RESOURCES.find(resource => resource.title === "Marketo Program")!.urlPattern;
    let frame = await user.startResourceConfigurator(pattern);
    let pending = (frame.ui as unknown as { listPrograms(query: string): Promise<unknown> })
      .listPrograms("");
    await started;
    generation++;
    releaseToken();

    await expect(pending).resolves.toEqual([]);
    expect(generationMatched).toBe(false);
    expect(apiFetches).toBe(0);
    frame.ui[Symbol.dispose]();
  });

  it.each(["description", "verifier"] as const)(
    "does not start an Identity fetch for a stale account %s read",
    async operation => {
      let credentials = {
        endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
      };
      let generation = 1;
      let refreshEntered!: () => void;
      let entered = new Promise<void>(resolve => { refreshEntered = resolve; });
      let releaseRefresh!: () => void;
      let released = new Promise<void>(resolve => { releaseRefresh = resolve; });
      let fetches = 0;
      let authorize = async (expected: { generation: number }) => {
        refreshEntered();
        await released;
        if (expected.generation !== generation) {
          return { ok: false as const, credentialChanged: true as const };
        }
        fetches++;
        return { ok: true as const, value: operation === "description" ? "api-user" : true };
      };
      let account = {
        getCredentialState: async () => ({ credentials, generation }),
        getScope: authorize,
        verifyCredentials: authorize,
        credentialsExpired: async () => {},
      };
      let ctx = {
        props: { userObjectId: "account-id" },
        exports: {
          UserAccount: { idFromString: () => "account-id", get: () => account },
        },
      } as unknown as ExecutionContext;

      let pending = operation === "description"
        ? new MarketoUserImpl(ctx, TEST_ENV).describe()
        : new MarketoUserVerifier(ctx, TEST_ENV).hasLiveCredential(
            credentials.endpoint,
            credentials.clientId,
            await testCredentialFingerprint(credentials),
          );
      await entered;
      generation++;
      releaseRefresh();

      if (operation === "description") {
        await expect(pending).resolves.toMatchObject({ displayName: "Marketo" });
      } else {
        await expect(pending).resolves.toEqual({ valid: false, generation: 1 });
      }
      expect(fetches).toBe(0);
    },
  );

  it.each(["revoke", "prepareReconnect"] as const)(
    "invalidates entirely simulated and cached reads after %s",
    async transition => {
      let accountId = await accountWithCredentials({
        endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
      });
      let gatekeeper = await gatekeeperForAccount(accountId.toString());
      let providerFetches = 0;
      vi.stubGlobal("fetch", async () => {
        providerFetches++;
        throw new Error("No provider request expected.");
      });

      await runInDurableObject(gatekeeper, async (instance, state) => {
        state.storage.kv.put("pending:index", [1, 2, 3]);
        state.storage.kv.put("pending:1", {
          ownerGeneration: 0,
          action: {
            id: 1, type: "designerCreate", asset: "designerEmail", provisionalId: "~1",
            body: { name: "Designer", appData: { workspaceId: "1" } },
          } satisfies EmailDesignerAction,
        });
        state.storage.kv.put("pending:2", {
          ownerGeneration: 0,
          action: {
            id: 2, type: "designCreate", asset: "emailTemplate", provisionalId: "~2",
            parent: { id: "10", type: "Folder" }, input: { name: "Classic", content: "cached" },
          } satisfies DesignStudioAction,
        });
        state.storage.kv.put("pending:3", {
          ownerGeneration: 0,
          action: {
            id: 3, type: "programCreate", provisionalId: "~3", parentId: "10",
            input: { name: "Program", type: "Default", channel: "Default" },
          } satisfies ProgramAction,
        });
        state.storage.kv.put("businessObjects:opportunityRoleUnavailable", {
          version: 1, expiresAt: Date.now() + 60_000,
        });
        let observations = 0;
        let queue = new RpcStub(new TestApprovalQueue(
          undefined,
          async () => { observations++; },
        )) as unknown as RpcStub<ApprovalQueue>;
        let session = await instance.startSession(queue) as MarketoSessionImpl;
        let studio = session.getDesignStudio();
        let designer = studio.getEmailDesigner();
        let designerEmail = designer.getEmail("~1");
        let classicTemplate = studio.getEmailTemplate("~2");
        let program = session.getProgram("~3");
        let custom = session.getBusinessObject("opportunityRole");
        let account = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
          .UserAccount.get(accountId);
        if (transition === "revoke") await account.revoke();
        else await account.prepareReconnect(crypto.randomUUID());

        let reads: (() => Promise<unknown>)[] = [
          () => designerEmail.describe(),
          () => classicTemplate.getContent(),
          () => program.getTokens(),
          () => custom.describe(),
        ];
        for (let read of reads) {
          await expect(Promise.resolve().then(read)).rejects.toThrow(/older account credential/);
        }
        expect(observations).toBe(0);
        for (let handle of [designerEmail, designer, classicTemplate, studio, program, custom, session]) {
          handle[Symbol.dispose]();
        }
        queue[Symbol.dispose]();
      });
      expect(providerFetches).toBe(0);
    },
  );

  it("hides old-generation provisional assets and refuses new dependencies after reconnect", async () => {
    let credentials = { endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID() };
    let accountId = await accountWithCredentials(credentials);
    let gatekeeper = await gatekeeperForAccount(accountId.toString());
    await runInDurableObject(gatekeeper, (_instance, state) => {
      state.storage.kv.put("pending:index", [1, 2, 3]);
      state.storage.kv.put("pending:1", {
        ownerGeneration: 0,
        action: {
          id: 1, type: "designerCreate", asset: "designerTemplate", provisionalId: "~1",
          body: { name: "Old designer template", appData: { workspaceId: "1" } },
        } satisfies EmailDesignerAction,
      });
      state.storage.kv.put("pending:2", {
        ownerGeneration: 0,
        action: {
          id: 2, type: "designCreate", asset: "emailTemplate", provisionalId: "~2",
          parent: { id: "10", type: "Folder" }, input: { name: "Old classic template", content: "old" },
        } satisfies DesignStudioAction,
      });
      state.storage.kv.put("pending:3", {
        ownerGeneration: 0,
        action: {
          id: 3, type: "programCreate", provisionalId: "~3", parentId: "10",
          input: { name: "Old program", type: "Default", channel: "Default" },
        } satisfies ProgramAction,
      });
    });
    let accountStub = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
      .UserAccount.get(accountId);
    let nonce = crypto.randomUUID();
    await runInDurableObject(accountStub, async (account, state) => {
      await account.prepareReconnect(nonce);
      let get = state.storage.kv.get.bind(state.storage.kv);
      vi.spyOn(state.storage.kv, "get").mockImplementation((key: string) =>
        key === "callback" ? { credentialsRestored: async () => {} } : get(key));
      await expect(account.completeConnection(nonce, {
        ...credentials, clientSecret: "replacement-secret",
      })).resolves.toEqual({ kind: "ok" });
    });
    let providerFetches = 0;
    vi.stubGlobal("fetch", async () => {
      providerFetches++;
      throw new Error("No provider request expected.");
    });

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let approvals = 0;
      let queue = new RpcStub(new TestApprovalQueue(async () => { approvals++; })) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoSessionImpl;
      let studio = session.getDesignStudio();
      let designer = studio.getEmailDesigner();
      let staleClassic = studio.getEmailTemplate("~2");
      let staleProgram = session.getProgram("~3");
      expect(() => designer.getEmailTemplate("~1")).toThrow(/not a designerTemplate/);
      let staleReads: (() => Promise<unknown>)[] = [
        () => staleClassic.getContent(),
        () => staleProgram.getTokens(),
      ];
      for (let read of staleReads) {
        await expect(Promise.resolve().then(read)).rejects.toThrow(/still pending creation/);
      }

      await expect(designer.createEmail({
        location: { workspaceId: "1", folderId: "10" }, name: "Fresh", headers: { subject: "Subject" },
        templateId: "~1",
      })).rejects.toThrow(/not a designerTemplate/);
      await expect(studio.createEmail(
        { id: "10", type: "folder" },
        {
          name: "Fresh classic email", templateId: "~2", subject: "Subject", fromName: "Sender",
          fromEmail: "sender@example.com", replyEmail: "reply@example.com",
        },
      )).rejects.toThrow(/not a emailTemplate/);
      await expect(session.createSmartCampaign(
        { id: "~3", type: "program" },
        { name: "Fresh campaign" },
      )).rejects.toThrow(/not a program/);
      expect(approvals).toBe(0);
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([1, 2, 3]);
      staleClassic[Symbol.dispose]();
      staleProgram[Symbol.dispose]();
      designer[Symbol.dispose]();
      studio[Symbol.dispose]();
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
    expect(providerFetches).toBe(0);
  });
});

describe("Design Studio scoped binding", () => {
  it("describes and starts the narrow Design Studio session type", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN,
      clientId: "client",
      clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");

    await runInDurableObject(gatekeeper, async instance => {
      expect(await instance.describe()).toMatchObject({
        url: buildDesignStudioUrl(ORIGIN),
        suggestedBindingName: "MARKETO_DESIGN_STUDIO",
        tsType: "MarketoDesignStudio",
      });
      let queue = new RpcStub(new TestApprovalQueue()) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue);
      expect(session).toBeInstanceOf(MarketoDesignStudioImpl);
      (session as MarketoDesignStudioImpl)[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("removes only an untouched staged row when queue submission fails", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN,
      clientId: "client",
      clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      return Response.json({ success: true, result: path.endsWith("/content.json")
        ? [{ htmlId: "main", contentType: "HTML", value: "<p>Draft</p>" }]
        : [{ id: 20, name: "Email", status: "draft" }] });
    });

    await runInDurableObject(gatekeeper, async (instance, state) => {
      state.storage.kv.put("pending:index", Array.from({ length: 199 }, (_, index) => index + 1));
      state.storage.kv.put("counter:nextActionId", 199);
      let failSubmission = true;
      let queue = {
        dup() { return this; },
        async authorizeObservation() {},
        async submitAction() {
          if (failSubmission) throw new Error("approval queue unavailable");
        },
        [Symbol.dispose]() {},
      } as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue);
      let studio = session as MarketoDesignStudioImpl;
      await expect(studio.getEmail("20").approve()).rejects.toThrow("approval queue unavailable");
      expect(state.storage.kv.get("pending:200")).toBeUndefined();
      expect(state.storage.kv.get("staged:200")).toBeUndefined();
      expect(state.storage.kv.get("staged:index")).toBeUndefined();
      expect(state.storage.kv.get("applying:200")).toBeUndefined();

      failSubmission = false;
      await studio.getEmail("21").updateMetadata({ description: "Uses released capacity" });
      expect(state.storage.kv.get<number[]>("pending:index")).toHaveLength(200);
      expect(state.storage.kv.get("pending:201")).toBeDefined();
      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("stages an action without exposing its simulation, then promotes it on success", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");
    let submissionStarted!: () => void;
    let started = new Promise<void>(resolve => { submissionStarted = resolve; });
    let releaseSubmission!: () => void;
    let released = new Promise<void>(resolve => { releaseSubmission = resolve; });
    vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : Response.json({ success: true, result: [] }));

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let queue = new RpcStub(new TestApprovalQueue(async () => {
        submissionStarted();
        await released;
      })) as unknown as RpcStub<ApprovalQueue>;
      let studio = await instance.startSession(queue) as MarketoDesignStudioImpl;
      let creation = studio.createEmailTemplate(
        { id: "10", type: "folder" },
        { name: "Preparing", content: "<p>Preparing</p>" },
      );
      await started;

      expect((await studio.listEmailTemplates()).items).toEqual([]);
      await expect(studio.createEmail({ id: "10", type: "folder" }, {
        name: "Dependent", templateId: "~1", subject: "Subject", fromName: "Sender",
        fromEmail: "sender@example.com", replyEmail: "reply@example.com",
      })).rejects.toThrow(/~1 is not a emailTemplate/);
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      expect(state.storage.kv.get<number[]>("pending:index") ?? []).toEqual([]);
      expect(state.storage.kv.get("staged:1")).toBeDefined();
      expect(state.storage.kv.get<number[]>("staged:index")).toEqual([1]);

      releaseSubmission();
      let created = await creation;
      expect(state.storage.kv.get("pending:1")).toBeDefined();
      expect(state.storage.kv.get("staged:1")).toBeUndefined();
      expect(state.storage.kv.get<number[]>("staged:index") ?? []).toEqual([]);
      (created as MarketoEmailTemplateImpl)[Symbol.dispose]();
      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("retains payload while a callback prepares after queue submission fails", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");
    let preparationStarted!: () => void;
    let started = new Promise<void>(resolve => { preparationStarted = resolve; });
    let releasePreparation!: () => void;
    let released = new Promise<void>(resolve => { releasePreparation = resolve; });
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        preparationStarted();
        await released;
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      writes++;
      return Response.json({ success: true, result: [{ id: 20 }] });
    });

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let callback: Promise<void> | undefined;
      let queue = {
        dup() { return this; },
        async authorizeObservation() {},
        async submitAction(id: number) {
          callback = instance.applyAction(id);
          await started;
          throw new Error("approval queue response failed");
        },
        [Symbol.dispose]() {},
      } as unknown as RpcStub<ApprovalQueue>;
      let studio = await instance.startSession(queue) as MarketoDesignStudioImpl;
      let submission = studio.getEmail("20").updateMetadata({ description: "Concurrent apply" });

      await expect(submission).rejects.toThrow("approval queue response failed");
      expect(state.storage.kv.get("staged:1")).toMatchObject({
        state: "preflight",
      });
      releasePreparation();
      await callback;
      expect(writes).toBe(1);
      expect(state.storage.kv.get("staged:1")).toBeUndefined();
      expect(state.storage.kv.get("applying:1")).toBe("applied");

      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("keeps an uncertain tombstone when queue and provider outcomes race", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");
    let writeStarted!: () => void;
    let started = new Promise<void>(resolve => { writeStarted = resolve; });
    let releaseWrite!: () => void;
    let released = new Promise<void>(resolve => { releaseWrite = resolve; });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      writeStarted();
      await released;
      throw new Error("provider response lost");
    });

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let callback: Promise<unknown> | undefined;
      let queue = {
        dup() { return this; },
        async authorizeObservation() {},
        async submitAction(id: number) {
          callback = instance.applyAction(id).catch(error => error);
          await started;
          throw new Error("approval queue response failed");
        },
        [Symbol.dispose]() {},
      } as unknown as RpcStub<ApprovalQueue>;
      let studio = await instance.startSession(queue) as MarketoDesignStudioImpl;
      let submission = studio.getEmail("20").updateMetadata({ description: "Uncertain apply" });

      await expect(submission).rejects.toThrow("approval queue response failed");
      releaseWrite();
      expect(await callback).toBeInstanceOf(Error);
      expect(state.storage.kv.get("staged:1")).toMatchObject({
        state: "dispatching",
      });
      expect(state.storage.kv.get("applying:1")).toBe("uncertain");
      await expect(instance.applyAction(1)).rejects.toThrow(/already dispatched/);
      await expect(instance.rejectAction(1)).resolves.toBeUndefined();
      expect(state.storage.kv.get("staged:1")).toBeUndefined();
      expect(state.storage.kv.get("applying:1")).toBe("uncertain-discarded");
      expect(state.storage.kv.get("audit:1")).toMatchObject({
        outcome: "uncertain-discarded",
        action: { id: 1, type: "designMetadata" },
      });

      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("cascades staged rejection, requests restart, and fails the submitting caller", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");
    vi.stubGlobal("fetch", async () => Response.json({ success: true, result: [] }));

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let restart: void | { restart: true } = undefined;
      let queue = new RpcStub(new TestApprovalQueue(async id => {
        restart = await instance.rejectAction(id);
        expect(state.storage.kv.get("pending:1")).toBeUndefined();
        expect(state.storage.kv.get("staged:1")).toBeUndefined();
        expect(state.storage.kv.get("applying:1")).toBe("rejected");
      })) as unknown as RpcStub<ApprovalQueue>;
      let studio = await instance.startSession(queue) as MarketoDesignStudioImpl;
      let creation = studio.createEmailTemplate(
        { id: "10", type: "folder" },
        { name: "Rejected", content: "<p>Rejected</p>" },
      );

      await expect(creation).rejects.toThrow(/rejected while its approval was being submitted/);
      expect(restart).toEqual({ restart: true });
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      expect(state.storage.kv.get("staged:1")).toBeUndefined();
      expect(state.storage.kv.get<number[]>("pending:index") ?? []).toEqual([]);
      expect(state.storage.kv.get<number[]>("staged:index") ?? []).toEqual([]);
      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("dispatches before a reentrant apply callback returns and is idempotent on re-entry", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (new URL(url).pathname.endsWith("/email/20.json")) writes++;
      return Response.json({ success: true, result: [{ id: 20 }] });
    });

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let queue = {
        dup() { return this; },
        async authorizeObservation() {},
        async submitAction(id: number) {
          await instance.applyAction(id);
          expect(writes).toBe(1);
          expect(state.storage.kv.get("pending:1")).toBeUndefined();
          expect(state.storage.kv.get("staged:1")).toBeUndefined();
        },
        [Symbol.dispose]() {},
      } as unknown as RpcStub<ApprovalQueue>;
      let studio = await instance.startSession(queue) as MarketoDesignStudioImpl;
      await studio.getEmail("20").updateMetadata({ description: "Apply immediately" });

      expect(writes).toBe(1);
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      expect(state.storage.kv.get("staged:1")).toBeUndefined();
      expect(state.storage.kv.get("applying:1")).toBe("applied");
      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
    await expect(gatekeeper.applyAction(1)).resolves.toBeUndefined();
    expect(writes).toBe(1);
  });

  it("propagates a staged apply dispatch failure without promoting the action", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      writes++;
      return Response.json({
        success: false,
        errors: [{ code: "1003", message: "Metadata rejected" }],
      });
    });

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let queue = {
        dup() { return this; },
        async authorizeObservation() {},
        async submitAction(id: number) { await instance.applyAction(id); },
        [Symbol.dispose]() {},
      } as unknown as RpcStub<ApprovalQueue>;
      let studio = await instance.startSession(queue) as MarketoDesignStudioImpl;

      await expect(studio.getEmail("20").updateMetadata({ description: "Rejected" }))
        .rejects.toThrow(/code 1003/);
      expect(writes).toBe(1);
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      expect(state.storage.kv.get("staged:1")).toMatchObject({
        state: "blocked",
      });
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
      await expect(instance.applyAction(1)).rejects.toThrow(/approval callback failed/);
      await instance.rejectAction(1);
      expect(state.storage.kv.get("staged:1")).toBeUndefined();
      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("retains a blocked staged dependent when its pending parent is rejected", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");
    let dependentStarted!: () => void;
    let started = new Promise<void>(resolve => { dependentStarted = resolve; });
    let releaseDependent!: () => void;
    let released = new Promise<void>(resolve => { releaseDependent = resolve; });
    let dependentRestart: void | { restart: true } = undefined;
    vi.stubGlobal("fetch", async () => Response.json({ success: true, result: [] }));

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let queue = new RpcStub(new TestApprovalQueue(async id => {
        if (id === 2) {
          dependentStarted();
          await released;
          dependentRestart = await instance.rejectAction(id);
        }
      })) as unknown as RpcStub<ApprovalQueue>;
      let studio = await instance.startSession(queue) as MarketoDesignStudioImpl;
      let parent = await studio.createEmailTemplate(
        { id: "10", type: "folder" },
        { name: "Parent", content: "<p>Parent</p>" },
      );
      let dependent = studio.createEmail({ id: "10", type: "folder" }, {
        name: "Dependent", templateId: "~1", subject: "Subject", fromName: "Sender",
        fromEmail: "sender@example.com", replyEmail: "reply@example.com",
      });
      await started;

      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      expect(state.storage.kv.get("staged:2")).toMatchObject({
        state: "blocked", blockedBy: 1,
      });
      releaseDependent();
      await expect(dependent).rejects.toThrow(/rejected while its approval was being submitted/);
      expect(dependentRestart).toEqual({ restart: true });
      expect(state.storage.kv.get("pending:2")).toBeUndefined();
      expect(state.storage.kv.get("staged:2")).toBeUndefined();
      expect(state.storage.kv.get<number[]>("pending:index") ?? []).toEqual([]);
      expect(state.storage.kv.get<number[]>("staged:index") ?? []).toEqual([]);

      (parent as MarketoEmailTemplateImpl)[Symbol.dispose]();
      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("revalidates staged dependencies before promotion", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");
    let dependentStarted!: () => void;
    let started = new Promise<void>(resolve => { dependentStarted = resolve; });
    let releaseDependent!: () => void;
    let released = new Promise<void>(resolve => { releaseDependent = resolve; });
    vi.stubGlobal("fetch", async () => Response.json({ success: true, result: [] }));

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let queue = new RpcStub(new TestApprovalQueue(async id => {
        if (id === 2) {
          dependentStarted();
          await released;
        }
      })) as unknown as RpcStub<ApprovalQueue>;
      let studio = await instance.startSession(queue) as MarketoDesignStudioImpl;
      let parent = await studio.createEmailTemplate(
        { id: "10", type: "folder" },
        { name: "Parent", content: "<p>Parent</p>" },
      );
      let dependent = studio.createEmail({ id: "10", type: "folder" }, {
        name: "Dependent", templateId: "~1", subject: "Subject", fromName: "Sender",
        fromEmail: "sender@example.com", replyEmail: "reply@example.com",
      });
      await started;

      state.storage.kv.delete("pending:1");
      state.storage.kv.put("pending:index", []);
      releaseDependent();
      await expect(dependent).rejects.toThrow(/became blocked while approval was being registered/);
      expect(state.storage.kv.get("pending:2")).toBeUndefined();
      expect(state.storage.kv.get("staged:2")).toMatchObject({
        state: "blocked",
      });
      await expect(instance.applyAction(2)).rejects.toThrow(/referenced Marketo resource changed/);
      await instance.rejectAction(2);
      expect(state.storage.kv.get("staged:2")).toBeUndefined();

      (parent as MarketoEmailTemplateImpl)[Symbol.dispose]();
      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("accepts 200 pending actions and rejects the next submission", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN,
      clientId: "client",
      clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");

    await runInDurableObject(gatekeeper, async (instance, state) => {
      state.storage.kv.put("pending:index", Array.from({ length: 199 }, (_, index) => index + 1));
      state.storage.kv.put("counter:nextActionId", 199);
      let queue = new RpcStub(new TestApprovalQueue()) as unknown as RpcStub<ApprovalQueue>;
      let studio = await instance.startSession(queue) as MarketoDesignStudioImpl;

      await studio.getEmail("20").updateMetadata({ description: "200th" });
      expect(state.storage.kv.get<number[]>("pending:index")).toHaveLength(200);
      await expect(studio.getEmail("21").updateMetadata({ description: "Too many" }))
        .rejects.toThrow(/more than 200 pending actions/);

      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("rejects a cross-kind provisional mutation before submitting approval", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");
    await runInDurableObject(gatekeeper, async (instance, state) => {
      let creation: DesignStudioAction = {
        id: 1, type: "designCreate", asset: "emailTemplate", provisionalId: "~1",
        parent: { id: "10", type: "Folder" }, input: { name: "Template", content: "x" },
      };
      state.storage.kv.put("pending:index", [1]);
      state.storage.kv.put("pending:1", { action: creation, ownerGeneration: 0 });
      let approvals = 0;
      let queue = new RpcStub(new TestApprovalQueue(async () => void approvals++)) as unknown as RpcStub<ApprovalQueue>;
      let studio = await instance.startSession(queue) as MarketoDesignStudioImpl;
      await expect(studio.getEmail("~1").approve()).rejects.toThrow(/~1 is not a email/);
      expect(approvals).toBe(0);
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([1]);
      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("handles pending Email Designer lifecycle dependencies through the session and action queue", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");
    let descriptions: ActionDescription[] = [];
    let assetRequests: { path: string; body?: unknown }[] = [];
    let state = "draft";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      let body = init?.body ? JSON.parse(String(init.body)) : undefined;
      assetRequests.push({ path, ...(body === undefined ? {} : { body }) });
      if (path.endsWith("/usedby")) {
        return Response.json({
          success: true,
          result: [],
          pageDetails: { totalItems: 0, currentPage: 1, pageSize: 50 },
        });
      }
      if (body) {
        state = body.action === "approve" ? "approved" : "draft";
        return Response.json({ success: true, result: [{
          id: "email-1", contentId: "content-1", status: state,
        }] });
      }
      return Response.json({ success: true, result: [{
        id: "email-1", status: state, state,
        associatedStates: [{ contentId: "content-1", state }],
      }] });
    });

    await runInDurableObject(gatekeeper, async (instance, storage) => {
      let queue = new RpcStub(new TestApprovalQueue(async (_id, description) => {
        descriptions.push(description);
      })) as unknown as RpcStub<ApprovalQueue>;
      let studio = await instance.startSession(queue) as MarketoDesignStudioImpl;
      let designer = studio.getEmailDesigner();
      let created = await designer.createEmail({
        location: { workspaceId: "1", folderId: "10" },
        name: "Pending", headers: { subject: "Pending" },
      });
      expect(descriptions[0]?.awaitDecision).toBe(true);
      await expect(created.approve()).rejects.toThrow(/still pending creation/);

      let email = designer.getEmail("email-1");
      await email.approve();
      await email.unapprove();
      expect(storage.storage.kv.get<{ action: EmailDesignerAction }>("pending:2")?.action).toMatchObject({
        operation: "approve", contentId: "content-1", sourceState: "draft",
      });
      expect(storage.storage.kv.get<{ action: EmailDesignerAction }>("pending:3")?.action).toMatchObject({
        operation: "unapprove", contentId: "content-1", sourceState: "approved",
      });
      await expect(instance.applyAction(3)).rejects.toThrow(/earlier pending mutation/);
      await instance.applyAction(2);
      await instance.applyAction(3);

      expect(assetRequests).toEqual([
        { path: "/rest/asset/v2/email/email-1" },
        { path: "/rest/asset/v2/email/usedby", body: {
          assetId: "email-1", pageIndex: 0, pageSize: 50, type: "all",
        } },
        { path: "/rest/asset/v2/email/email-1" },
        { path: "/rest/asset/v2/email/usedby", body: {
          assetId: "email-1", pageIndex: 0, pageSize: 50, type: "all",
        } },
        { path: "/rest/asset/v2/email/email-1" },
        { path: "/rest/asset/v2/email/usedby", body: {
          assetId: "email-1", pageIndex: 0, pageSize: 50, type: "all",
        } },
        { path: "/rest/asset/v2/email/state/transition", body: { contentId: "content-1", action: "approve" } },
        { path: "/rest/asset/v2/email/email-1" },
        { path: "/rest/asset/v2/email/usedby", body: {
          assetId: "email-1", pageIndex: 0, pageSize: 50, type: "all",
        } },
        { path: "/rest/asset/v2/email/state/transition", body: { contentId: "content-1", action: "unapprove" } },
      ]);
      created[Symbol.dispose]();
      email[Symbol.dispose]();
      designer[Symbol.dispose]();
      studio[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });
});

async function addObserverFromAccount(
  gatekeeper: DurableObjectStub<MarketoGatekeeperImpl>,
  userObjectId: string,
): Promise<void> {
  await runInDurableObject(gatekeeper, async instance => {
    let exports = (instance as unknown as { ctx: { exports: Cloudflare.Exports } }).ctx.exports;
    let verifier = (exports as unknown as {
      TestMarketoUserVerifier(options: { props: { userObjectId: string } }): Fetcher;
    }).TestMarketoUserVerifier({ props: { userObjectId } });
    await instance.addObserver(
      "observer",
      verifier as unknown as Fetcher<GatekeeperUserVerifier>,
    );
  });
}

describe("collaborator credentials", () => {
  const OWNER = { endpoint: ORIGIN, clientId: "client", clientSecret: "secret" };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", async (requestUrl: string) => {
      let url = new URL(requestUrl);
      if (url.pathname === "/identity/oauth/token") {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
  });

  it("accepts only the same complete LaunchPoint credential", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let matchingId = await accountWithCredentials(OWNER);
    await expect(addObserverFromAccount(gatekeeper, matchingId.toString())).resolves.toBeUndefined();
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
      (_instance, state) => expect([...state.storage.kv.list({ prefix: "observer:" })]).toHaveLength(1),
    );

    for (let credentials of [
      { ...OWNER, endpoint: "https://999-zzz-000.mktorest.com" },
      { ...OWNER, clientId: "other-client" },
      { ...OWNER, clientSecret: "other-secret" },
    ]) {
      let observerId = await accountWithCredentials(credentials);
      await expect(addObserverFromAccount(gatekeeper, observerId.toString())).rejects.toThrow(
        /not connected with the same Marketo LaunchPoint service/,
      );
    }
  });

  it("tracks sibling bindings with the same observer independently", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let collaboratorId = await accountWithCredentials(OWNER);
    let first = await gatekeeperForAccount(ownerId.toString(), "instance", undefined, "binding-first");
    let second = await gatekeeperForAccount(ownerId.toString(), "instance", undefined, "binding-second");

    await addObserverFromAccount(first, collaboratorId.toString());
    await addObserverFromAccount(second, collaboratorId.toString());

    let owner = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
      .UserAccount.get(ownerId);
    let collaborator = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
      .UserAccount.get(collaboratorId);
    await runInDurableObject(owner, (_instance, state) => {
      let admissions = [...state.storage.kv.list<{ admissionId: string }>({ prefix: "observer:" })];
      expect(admissions).toHaveLength(2);
      expect(new Set(admissions.map(([, admission]) => admission.admissionId)).size).toBe(2);
    });
    await runInDurableObject(collaborator, (_instance, state) => {
      expect([...state.storage.kv.list({ prefix: "observerAuthority:" })]).toHaveLength(2);
    });

    await first.removeObserver("observer");
    await runInDurableObject(owner, (_instance, state) => {
      expect([...state.storage.kv.list({ prefix: "observer:" })]).toHaveLength(1);
    });
    await runInDurableObject(collaborator, (_instance, state) => {
      expect([...state.storage.kv.list({ prefix: "observerAuthority:" })]).toHaveLength(1);
    });

    await collaborator.revoke();
    await runInDurableObject(owner, async instance => {
      expect(await instance.getExcludedObservers("binding-first")).toEqual([]);
      expect(await instance.getExcludedObservers("binding-second")).toEqual(["observer"]);
    });
  });

  it("live-checks the shared service credential for every resource kind", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let observerId = await accountWithCredentials(OWNER);
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (requestUrl: string) => {
      let url = new URL(requestUrl);
      if (url.pathname === "/identity/oauth/token") {
        paths.push(url.pathname);
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    for (let [kind, resourceId] of [
      ["instance", undefined],
      ["design-studio", undefined],
      ["program", 41],
      ["list", 42],
    ] as const) {
      let gatekeeper = await gatekeeperForAccount(ownerId.toString(), kind, resourceId);
      await expect(addObserverFromAccount(gatekeeper, observerId.toString())).resolves.toBeUndefined();
    }

    expect(paths).toEqual([
      "/identity/oauth/token",
      "/identity/oauth/token",
      "/identity/oauth/token",
      "/identity/oauth/token",
    ]);
  });

  it("re-verifies a previously admitted observer against live credentials", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    await runInDurableObject(gatekeeper, async instance => {
      let exports = (instance as unknown as { ctx: { exports: Cloudflare.Exports } }).ctx.exports;
      let verifier = (exports as unknown as {
        TestMarketoUserVerifier(options: { props: { userObjectId: string } }): Fetcher;
      }).TestMarketoUserVerifier({ props: { userObjectId: observerId.toString() } });
      await expect(instance.addObserver(
        "observer",
        verifier as unknown as Fetcher<GatekeeperUserVerifier>,
      )).resolves.toBeUndefined();

      let namespace = (env as unknown as { UserAccount: DurableObjectNamespace }).UserAccount;
      await runInDurableObject(namespace.get(observerId), (_instance, state) => {
        state.storage.kv.put("credentials", { ...OWNER, clientSecret: "reconnected-secret" });
      });

      await expect(instance.addObserver(
        "observer",
        verifier as unknown as Fetcher<GatekeeperUserVerifier>,
      )).rejects.toThrow(/not connected with the same Marketo LaunchPoint service/);
    });
  });

  it("does not let a stalled collaborator verifier block owner revoke", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    let verificationStarted!: () => void;
    let started = new Promise<void>(resolve => { verificationStarted = resolve; });
    let releaseVerification!: () => void;
    let released = new Promise<void>(resolve => { releaseVerification = resolve; });
    let originalVerification = MarketoUserVerifier.prototype.hasLiveCredential;
    vi.spyOn(MarketoUserVerifier.prototype, "hasLiveCredential").mockImplementation(async function(
      this: MarketoUserVerifier,
      ...args: Parameters<MarketoUserVerifier["hasLiveCredential"]>
    ) {
      verificationStarted();
      await released;
      return await originalVerification.apply(this, args);
    });
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches++;
      return Response.json({ access_token: "token", expires_in: 3600 });
    });

    await runInDurableObject(gatekeeper, async instance => {
      let exports = (instance as unknown as { ctx: { exports: Cloudflare.Exports } }).ctx.exports;
      let verifier = (exports as unknown as {
        TestMarketoUserVerifier(options: { props: { userObjectId: string } }): Fetcher;
      }).TestMarketoUserVerifier({ props: { userObjectId: observerId.toString() } });
      let admission = instance.addObserver(
        "observer",
        verifier as unknown as Fetcher<GatekeeperUserVerifier>,
      );
      await started;
      await (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
        .UserAccount.get(ownerId).revoke();
      releaseVerification();

      await expect(admission).rejects.toThrow(/account changed/);
    });
    expect(fetches).toBe(1);
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
      (_instance, state) => expect([...state.storage.kv.list({ prefix: "observer:" })]).toHaveLength(0),
    );
  });

  it("rejects admission when revoke wins between verification and observer persistence", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    let commitStarted!: () => void;
    let started = new Promise<void>(resolve => { commitStarted = resolve; });
    let releaseCommit!: () => void;
    let released = new Promise<void>(resolve => { releaseCommit = resolve; });
    let originalCommit = UserAccount.prototype.commitCollaborator;
    vi.spyOn(UserAccount.prototype, "commitCollaborator").mockImplementation((async function(
      this: UserAccount,
      ...args: Parameters<UserAccount["commitCollaborator"]>
    ) {
      commitStarted();
      await released;
      return originalCommit.apply(this, args);
    }) as unknown as UserAccount["commitCollaborator"]);

    await runInDurableObject(gatekeeper, async instance => {
      let exports = (instance as unknown as { ctx: { exports: Cloudflare.Exports } }).ctx.exports;
      let verifier = (exports as unknown as {
        TestMarketoUserVerifier(options: { props: { userObjectId: string } }): Fetcher;
      }).TestMarketoUserVerifier({ props: { userObjectId: observerId.toString() } });
      let admission = instance.addObserver(
        "observer",
        verifier as unknown as Fetcher<GatekeeperUserVerifier>,
      );
      await started;
      await (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
        .UserAccount.get(ownerId).revoke();
      releaseCommit();

      await expect(admission).rejects.toThrow(/account changed/);
    });
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
      (_instance, state) => expect([...state.storage.kv.list({ prefix: "observer:" })]).toHaveLength(0),
    );
  });

  it("rejects admission when the collaborator revokes between verification and commit", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    let commitStarted!: () => void;
    let started = new Promise<void>(resolve => { commitStarted = resolve; });
    let releaseCommit!: () => void;
    let released = new Promise<void>(resolve => { releaseCommit = resolve; });
    let originalCommit = MarketoUserVerifier.prototype.commitObserverAdmission;
    vi.spyOn(MarketoUserVerifier.prototype, "commitObserverAdmission").mockImplementation(async function(
      this: MarketoUserVerifier,
      ...args: Parameters<MarketoUserVerifier["commitObserverAdmission"]>
    ) {
      commitStarted();
      await released;
      return originalCommit.apply(this, args);
    });

    await runInDurableObject(gatekeeper, async instance => {
      let exports = (instance as unknown as { ctx: { exports: Cloudflare.Exports } }).ctx.exports;
      let verifier = (exports as unknown as {
        TestMarketoUserVerifier(options: { props: { userObjectId: string } }): Fetcher;
      }).TestMarketoUserVerifier({ props: { userObjectId: observerId.toString() } });
      let admission = instance.addObserver(
        "observer",
        verifier as unknown as Fetcher<GatekeeperUserVerifier>,
      );
      await started;
      await (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
        .UserAccount.get(observerId).revoke();
      releaseCommit();

      await expect(admission).rejects.toThrow(/account changed/);
    });
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
      (_instance, state) => expect([...state.storage.kv.list({ prefix: "observer:" })]).toHaveLength(0),
    );
  });

  it("does not recreate an observer removed between verification and commit", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    let commitStarted!: () => void;
    let started = new Promise<void>(resolve => { commitStarted = resolve; });
    let releaseCommit!: () => void;
    let released = new Promise<void>(resolve => { releaseCommit = resolve; });
    let originalCommit = UserAccount.prototype.commitCollaborator;
    vi.spyOn(UserAccount.prototype, "commitCollaborator").mockImplementation((async function(
      this: UserAccount,
      ...args: Parameters<UserAccount["commitCollaborator"]>
    ) {
      commitStarted();
      await released;
      return originalCommit.apply(this, args);
    }) as unknown as UserAccount["commitCollaborator"]);

    await runInDurableObject(gatekeeper, async instance => {
      let exports = (instance as unknown as { ctx: { exports: Cloudflare.Exports } }).ctx.exports;
      let verifier = (exports as unknown as {
        TestMarketoUserVerifier(options: { props: { userObjectId: string } }): Fetcher;
      }).TestMarketoUserVerifier({ props: { userObjectId: observerId.toString() } });
      let admission = instance.addObserver(
        "observer",
        verifier as unknown as Fetcher<GatekeeperUserVerifier>,
      );
      await started;
      await instance.removeObserver("observer");
      releaseCommit();

      await expect(admission).rejects.toThrow(/account changed/);
    });
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
      (_instance, state) => expect([...state.storage.kv.list({ prefix: "observer:" })]).toHaveLength(0),
    );
  });

  it("orders collaborator revoke after an in-progress atomic admission", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    let commitStarted!: () => void;
    let started = new Promise<void>(resolve => { commitStarted = resolve; });
    let releaseCommit!: () => void;
    let released = new Promise<void>(resolve => { releaseCommit = resolve; });
    let originalCommit = UserAccount.prototype.commitCollaborator;
    vi.spyOn(UserAccount.prototype, "commitCollaborator").mockImplementation((async function(
      this: UserAccount,
      ...args: Parameters<UserAccount["commitCollaborator"]>
    ) {
      commitStarted();
      await released;
      return originalCommit.apply(this, args);
    }) as unknown as UserAccount["commitCollaborator"]);
    let providerFetches = 0;
    vi.stubGlobal("fetch", async (requestUrl: string) => {
      let url = new URL(requestUrl);
      if (url.pathname === "/identity/oauth/token") {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      providerFetches++;
      return Response.json({ success: true, result: [] });
    });

    await runInDurableObject(gatekeeper, async instance => {
      let exports = (instance as unknown as { ctx: { exports: Cloudflare.Exports } }).ctx.exports;
      let verifier = (exports as unknown as {
        TestMarketoUserVerifier(options: { props: { userObjectId: string } }): Fetcher;
      }).TestMarketoUserVerifier({ props: { userObjectId: observerId.toString() } });
      let admission = instance.addObserver(
        "observer",
        verifier as unknown as Fetcher<GatekeeperUserVerifier>,
      );
      await started;
      let revokeSettled = false;
      let revoke = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
        .UserAccount.get(observerId).revoke().then(() => { revokeSettled = true; });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(revokeSettled).toBe(false);
      releaseCommit();
      await expect(admission).resolves.toBeUndefined();
      await revoke;

      let queue = new RpcStub(new TestApprovalQueue()) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoSessionImpl;
      await expect(session.getChannels()).rejects.toThrow(/observer's credentials were revoked/);
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
    expect(providerFetches).toBe(0);
    let bindingId = await gatekeeperBindingId(gatekeeper);
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
      async (instance, state) => {
        expect([...state.storage.kv.list({ prefix: "observer:" })]).toHaveLength(0);
        expect([...state.storage.kv.list({ prefix: "revokedObserver:" })]).toHaveLength(1);
        expect(await instance.getExcludedObservers(bindingId)).toEqual(["observer"]);
      },
    );
  });

  it("blocks provider reads after an admitted observer revokes", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    await addObserverFromAccount(gatekeeper, observerId.toString());
    await (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
      .UserAccount.get(observerId).revoke();
    let providerFetches = 0;
    vi.stubGlobal("fetch", async () => {
      providerFetches++;
      return Response.json({ success: true, result: [] });
    });

    await runInDurableObject(gatekeeper, async instance => {
      let queue = new RpcStub(new TestApprovalQueue()) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoSessionImpl;
      await expect(session.getChannels()).rejects.toThrow(/observer's credentials were revoked/);
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
    expect(providerFetches).toBe(0);
  });

  it("excludes an observer revoked after provider dispatch begins", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    await addObserverFromAccount(gatekeeper, observerId.toString());
    let providerStarted!: () => void;
    let started = new Promise<void>(resolve => { providerStarted = resolve; });
    let releaseProvider!: () => void;
    let released = new Promise<void>(resolve => { releaseProvider = resolve; });
    vi.stubGlobal("fetch", async () => {
      providerStarted();
      await released;
      return Response.json({ success: true, result: [] });
    });
    let observations: ObservationDescription[] = [];

    await runInDurableObject(gatekeeper, async instance => {
      let queue = new RpcStub(new TestApprovalQueue(
        undefined,
        async description => { observations.push(description); },
      )) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoSessionImpl;
      let read = session.getChannels();
      await started;
      await (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
        .UserAccount.get(observerId).revoke();
      releaseProvider();
      await expect(read).resolves.toEqual([]);
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
    expect(observations).toHaveLength(1);
    expect(observations[0].excludeObservers).toEqual(["observer"]);
  });

  it("allows provider reads and observations for a live observer", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    await addObserverFromAccount(gatekeeper, observerId.toString());
    let providerFetches = 0;
    vi.stubGlobal("fetch", async () => {
      providerFetches++;
      return Response.json({ success: true, result: [] });
    });
    let observations: ObservationDescription[] = [];

    await runInDurableObject(gatekeeper, async instance => {
      let queue = new RpcStub(new TestApprovalQueue(
        undefined,
        async description => { observations.push(description); },
      )) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoSessionImpl;
      await expect(session.getChannels()).resolves.toEqual([]);
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
    expect(providerFetches).toBe(1);
    expect(observations).toHaveLength(1);
    expect(observations[0].excludeObservers).toBeUndefined();
  });

  it("does not transfer observer authority across an owner reconnect", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let oldObserverId = await accountWithCredentials(OWNER);
    await addObserverFromAccount(gatekeeper, oldObserverId.toString());
    let replacement = { ...OWNER, clientSecret: "replacement-secret" };
    let nonce = crypto.randomUUID();
    let bindingId = await gatekeeperBindingId(gatekeeper);
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
      async (instance, state) => {
        await instance.prepareReconnect(nonce);
        let get = state.storage.kv.get.bind(state.storage.kv);
        vi.spyOn(state.storage.kv, "get").mockImplementation((key: string) =>
          key === "callback" ? { credentialsRestored: async () => {} } : get(key));
        await expect(instance.completeConnection(nonce, replacement)).resolves.toEqual({ kind: "ok" });
      },
    );
    let providerFetches = 0;
    vi.stubGlobal("fetch", async (requestUrl: string) => {
      let url = new URL(requestUrl);
      if (url.pathname === "/identity/oauth/token") {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      providerFetches++;
      return Response.json({ success: true, result: [] });
    });

    await runInDurableObject(gatekeeper, async instance => {
      let queue = new RpcStub(new TestApprovalQueue()) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoSessionImpl;
      await expect(session.getChannels()).rejects.toThrow(/observer's credentials were revoked/);
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
    expect(providerFetches).toBe(0);
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
      async instance => expect(await instance.getExcludedObservers(bindingId)).toEqual(["observer"]),
    );

    let freshObserverId = await accountWithCredentials(replacement);
    await expect(addObserverFromAccount(gatekeeper, freshObserverId.toString())).resolves.toBeUndefined();
    providerFetches = 0;
    let observations: ObservationDescription[] = [];
    await runInDurableObject(gatekeeper, async instance => {
      let queue = new RpcStub(new TestApprovalQueue(
        undefined,
        async description => { observations.push(description); },
      )) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoSessionImpl;
      await expect(session.getChannels()).resolves.toEqual([]);
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
    expect(providerFetches).toBe(1);
    expect(observations).toHaveLength(1);
    expect(observations[0].excludeObservers).toBeUndefined();
  });

  it("rejects observer admission while the owner reconnect is pending", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    await (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> })
      .UserAccount.get(ownerId).prepareReconnect(crypto.randomUUID());

    await expect(addObserverFromAccount(gatekeeper, observerId.toString()))
      .rejects.toThrow(/reconnecting/);
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
      (_instance, state) => expect([...state.storage.kv.list({ prefix: "observer:" })]).toHaveLength(0),
    );
  });

  it("does not transfer an existing session or action across credential replacement", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString(), "design-studio");
    let providerFetches = 0;
    vi.stubGlobal("fetch", async () => {
      providerFetches++;
      return Response.json({ success: true, result: [] });
    });

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let queue = new RpcStub(new TestApprovalQueue()) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoDesignStudioImpl;
      let nonce = crypto.randomUUID();
      await runInDurableObject(
        (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
        async (account, accountState) => {
          await account.prepareReconnect(nonce);
          let get = accountState.storage.kv.get.bind(accountState.storage.kv);
          vi.spyOn(accountState.storage.kv, "get").mockImplementation((key: string) =>
            key === "callback" ? { credentialsRestored: async () => {} } : get(key));
          await expect(account.completeConnection(nonce, {
            ...OWNER,
            clientSecret: "replacement-secret",
          })).resolves.toEqual({ kind: "ok" });
        },
      );

      let email = session.getEmail("20");
      await expect(email.approve()).rejects.toThrow(/older account credential/);
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      await expect(email.describe()).rejects.toThrow(/account changed/);
      email[Symbol.dispose]();
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
    expect(providerFetches).toBe(0);
  });

  it("rejects a previously admitted observer when Marketo revokes the credential", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    await expect(addObserverFromAccount(gatekeeper, observerId.toString())).resolves.toBeUndefined();
    let expiryNotification = vi.spyOn(UserAccount.prototype, "credentialsExpired");

    vi.stubGlobal("fetch", async (requestUrl: string) => {
      let url = new URL(requestUrl);
      if (url.pathname === "/identity/oauth/token") {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    await expect(addObserverFromAccount(gatekeeper, observerId.toString())).rejects.toThrow(
      /not connected with the same Marketo LaunchPoint service/,
    );
    expect(expiryNotification).toHaveBeenCalledOnce();
  });

  it("invalidates an open session when live re-verification rejects its observer", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    await addObserverFromAccount(gatekeeper, observerId.toString());
    let providerStarted!: () => void;
    let started = new Promise<void>(resolve => { providerStarted = resolve; });
    let releaseProvider!: () => void;
    let released = new Promise<void>(resolve => { releaseProvider = resolve; });
    let providerFetches = 0;
    vi.stubGlobal("fetch", async (requestUrl: string) => {
      let url = new URL(requestUrl);
      if (url.pathname === "/identity/oauth/token") {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      providerFetches++;
      providerStarted();
      await released;
      return Response.json({ success: true, result: [] });
    });
    let observations: ObservationDescription[] = [];

    await runInDurableObject(gatekeeper, async instance => {
      let queue = new RpcStub(new TestApprovalQueue(
        undefined,
        async description => { observations.push(description); },
      )) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoSessionImpl;
      let read = session.getChannels();
      await started;

      let exports = (instance as unknown as { ctx: { exports: Cloudflare.Exports } }).ctx.exports;
      let verifier = (exports as unknown as {
        TestMarketoUserVerifier(options: { props: { userObjectId: string } }): Fetcher;
      }).TestMarketoUserVerifier({ props: { userObjectId: observerId.toString() } });
      await expect(instance.addObserver(
        "observer",
        verifier as unknown as Fetcher<GatekeeperUserVerifier>,
      )).rejects.toThrow(/not connected with the same Marketo LaunchPoint service/);

      await expect(session.getChannels()).rejects.toThrow(/observer's credentials were revoked/);
      expect(providerFetches).toBe(1);
      releaseProvider();
      await expect(read).resolves.toEqual([]);
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });

    expect(observations).toHaveLength(1);
    expect(observations[0].excludeObservers).toEqual(["observer"]);
    let bindingId = await gatekeeperBindingId(gatekeeper);
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
      async (instance, state) => {
        expect([...state.storage.kv.list({ prefix: "observer:" })]).toHaveLength(0);
        expect([...state.storage.kv.list({ prefix: "revokedObserver:" })]).toHaveLength(1);
        expect(await instance.getExcludedObservers(bindingId)).toEqual(["observer"]);
      },
    );
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(observerId),
      (_instance, state) => {
        expect([...state.storage.kv.list({ prefix: "observerAuthority:" })]).toHaveLength(0);
      },
    );
  });

  it("surfaces transient Identity failures without expiring the credential", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    await addObserverFromAccount(gatekeeper, observerId.toString());
    let expiryNotification = vi.spyOn(UserAccount.prototype, "credentialsExpired");
    vi.stubGlobal("fetch", async () => {
      throw new Error("temporary outage");
    });

    await expect(addObserverFromAccount(gatekeeper, observerId.toString())).rejects.toThrow(
      /Could not reach the Marketo Identity endpoint/,
    );
    expect(expiryNotification).not.toHaveBeenCalled();
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(ownerId),
      (_instance, state) => {
        expect([...state.storage.kv.list({ prefix: "observer:" })]).toHaveLength(1);
        expect([...state.storage.kv.list({ prefix: "revokedObserver:" })]).toHaveLength(0);
      },
    );
    await runInDurableObject(
      (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount.get(observerId),
      (_instance, state) => {
        expect([...state.storage.kv.list({ prefix: "observerAuthority:" })]).toHaveLength(1);
      },
    );
  });
});

async function actionGatekeeper(action: MarketoAction) {
  let credentials = { endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID() };
  let userNamespace = (env as unknown as { UserAccount: DurableObjectNamespace }).UserAccount;
  let userId = userNamespace.newUniqueId();
  await runInDurableObject(userNamespace.get(userId), (_instance, state) => {
    state.storage.kv.put("credentials", credentials);
  });

  let gatekeeperNamespace = (env as unknown as {
    MarketoGatekeeperImpl: DurableObjectNamespace<MarketoGatekeeperImpl>;
  }).MarketoGatekeeperImpl;
  let stub = gatekeeperNamespace.get(gatekeeperNamespace.newUniqueId());
  await runInDurableObject(stub, (instance, state) => {
    let ctx = (instance as unknown as {
      ctx: { props: { userObjectId: string; bindingId: string; kind: "instance" } };
    }).ctx;
    ctx.props = { userObjectId: userId.toString(), bindingId: crypto.randomUUID(), kind: "instance" };
    state.storage.kv.put(`pending:${action.id}`, { action, ownerGeneration: 0 });
  });
  return stub;
}

async function designActionGatekeeper(
  actions: DesignStudioAction[],
  resolutions: Record<string, number> = {},
) {
  let credentials = { endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID() };
  let userNamespace = (env as unknown as { UserAccount: DurableObjectNamespace }).UserAccount;
  let userId = userNamespace.newUniqueId();
  await runInDurableObject(userNamespace.get(userId), (_instance, state) => {
    state.storage.kv.put("credentials", credentials);
  });

  let namespace = (env as unknown as {
    MarketoGatekeeperImpl: DurableObjectNamespace<MarketoGatekeeperImpl>;
  }).MarketoGatekeeperImpl;
  let stub = namespace.get(namespace.newUniqueId());
  await runInDurableObject(stub, (instance, state) => {
    let ctx = (instance as unknown as {
      ctx: { props: { userObjectId: string; bindingId: string; kind: "design-studio" } };
    }).ctx;
    ctx.props = {
      userObjectId: userId.toString(), bindingId: crypto.randomUUID(), kind: "design-studio",
    };
    state.storage.kv.put("pending:index", actions.map(action => action.id));
    for (let action of actions) {
      state.storage.kv.put(`pending:${action.id}`, { action, ownerGeneration: 0 });
    }
    for (let [id, realId] of Object.entries(resolutions)) {
      state.storage.kv.put(`provisional:${id}`, realId);
      let reference = actions.find(action =>
        (action.type === "designCreate" || action.type === "designClone") && action.provisionalId === id ||
        "targetId" in action && action.targetId === id ||
        action.type === "designClone" && action.sourceId === id
      );
      if (reference) state.storage.kv.put(`provisionalKind:${id}`, reference.type === "designDeleteFolder" ? "folder" : reference.asset);
    }
  });
  return stub;
}

async function campaignActionGatekeeper(
  actions: MarketoAction[],
  resolutions: Record<string, number> = {},
) {
  let credentials = { endpoint: ORIGIN, clientId: "client", clientSecret: crypto.randomUUID() };
  let userNamespace = (env as unknown as { UserAccount: DurableObjectNamespace }).UserAccount;
  let userId = userNamespace.newUniqueId();
  await runInDurableObject(userNamespace.get(userId), (_instance, state) => {
    state.storage.kv.put("credentials", credentials);
  });

  let namespace = (env as unknown as {
    MarketoGatekeeperImpl: DurableObjectNamespace<MarketoGatekeeperImpl>;
  }).MarketoGatekeeperImpl;
  let stub = namespace.get(namespace.newUniqueId());
  await runInDurableObject(stub, (instance, state) => {
    let ctx = (instance as unknown as {
      ctx: { props: { userObjectId: string; bindingId: string; kind: "instance" } };
    }).ctx;
    ctx.props = { userObjectId: userId.toString(), bindingId: crypto.randomUUID(), kind: "instance" };
    state.storage.kv.put("pending:index", actions.map(action => action.id));
    for (let action of actions) {
      state.storage.kv.put(`pending:${action.id}`, { action, ownerGeneration: 0 });
    }
    for (let [id, realId] of Object.entries(resolutions)) {
      state.storage.kv.put(`provisional:${id}`, realId);
      state.storage.kv.put(`provisionalKind:${id}`, "campaign");
    }
  });
  return stub;
}

async function emailDesignerActionGatekeeper(
  actions: MarketoAction[],
  resolutions: Record<string, { id: string; kind: "designerEmail" | "designerTemplate" | "designerFragment" }> = {},
) {
  let stub = await campaignActionGatekeeper(actions);
  await runInDurableObject(stub, (_instance, state) => {
    for (let [provisionalId, resolution] of Object.entries(resolutions)) {
      state.storage.kv.put(`designerProvisional:${provisionalId}`, resolution.id);
      state.storage.kv.put(`provisionalKind:${provisionalId}`, resolution.kind);
    }
  });
  return stub;
}

describe("persisted action type validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    "designFuture",
    "designerFuture",
    "campaignFuture",
    "programFuture",
    "businessObjectFuture",
    "personFuture",
  ])("rejects unknown %s actions before any provider request", async type => {
    let fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let stub = await actionGatekeeper({ id: 1, type } as unknown as MarketoAction);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/Unknown persisted Marketo action type/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      id: 1, type: "designLifecycle", asset: "email", targetId: "31",
      operation: "future", snapshot: EMPTY_CLASSIC_LIFECYCLE_SNAPSHOT,
    },
    {
      id: 1, type: "campaignLifecycle", targetId: "31", campaignName: "Campaign",
      programId: null, operation: "future",
    },
    {
      id: 1, type: "programLifecycle", targetId: "31", programName: "Program",
      operation: "future",
    },
    {
      id: 1, type: "designerLifecycle", asset: "designerEmail", targetId: "email-31",
      operation: "future", contentId: "content-31", sourceState: "draft",
      sourceSnapshot: EMPTY_DESIGNER_LIFECYCLE_SNAPSHOT, affectedDependents: [],
    },
  ])("rejects malformed recognized $type operations before any provider request", async malformed => {
    let fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let stub = await actionGatekeeper(malformed as unknown as MarketoAction);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/Unknown persisted Marketo .* lifecycle operation/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { id: 1, type: "designCreate", asset: "future", provisionalId: "~1", parent: { id: "10", type: "Folder" }, input: { name: "Asset" } },
    { id: 1, type: "designLifecycle", asset: "file", targetId: "31", operation: "delete", snapshot: EMPTY_CLASSIC_LIFECYCLE_SNAPSHOT },
    { id: 1, type: "designContent", asset: "folder", targetId: "31" },
    { id: 1, type: "designCreate", asset: "landingPageTemplate", provisionalId: "~1", parent: { id: "10", type: "Folder" }, input: { name: "Template", templateType: "future" } },
    { id: 1, type: "campaignCreate", provisionalId: "~1", parent: { id: "10", type: "Future" }, name: "Campaign" },
    { id: 1, type: "designerCreate", asset: "future", provisionalId: "~1", body: { name: "Email" } },
    { id: 1, type: "designerLifecycle", asset: "designerEmail", targetId: "email-31", operation: "approve", contentId: "content-31", sourceState: "future", sourceSnapshot: EMPTY_DESIGNER_LIFECYCLE_SNAPSHOT, affectedDependents: [] },
    { id: 1, type: "upsertPeople", records: [{ email: "person@example.com" }], upsertAction: "future", lookupField: "email" },
    { id: 1, type: "customObjectDelete", apiName: "items", records: [{ key: "one" }], deleteBy: "future" },
    { id: 1, type: "businessObjectUpsert", kind: "company", records: [{ externalCompanyId: "one" }], matchBy: "dedupeFields", action: "future", changedFields: [] },
    { id: 1, type: "businessObjectDelete", kind: "company", records: [{ externalCompanyId: "one" }], matchBy: "future", changedFields: [] },
    { id: 1, type: "businessObjectDelete", kind: "future", records: [{ id: 1 }], matchBy: "idField", changedFields: [] },
  ])("rejects malformed nested discriminants in $type before any provider request", async malformed => {
    let fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let stub = await actionGatekeeper(malformed as unknown as MarketoAction);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/(?:Unknown|Invalid) persisted Marketo/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses exact family guards and fail-closed executor defaults", async () => {
    expect(isDesignStudioAction({ type: "designFuture" })).toBe(false);
    expect(isEmailDesignerAction({ type: "designerFuture" })).toBe(false);
    expect(isCampaignAction({ type: "campaignFuture" })).toBe(false);
    expect(isProgramAction({ type: "programFuture" })).toBe(false);
    expect(isBusinessObjectAction({ type: "businessObjectFuture" })).toBe(false);

    let clientAccesses = 0;
    let client = new Proxy({}, { get: () => { clientAccesses++; } }) as MarketoClient;
    let resolve = vi.fn(() => 1);
    let malformed = { id: 1, type: "future" };
    await expect(executeDesignStudioAction(
      malformed as unknown as DesignStudioAction, client, resolve, () => {},
    )).rejects.toThrow(/Unknown persisted Marketo Design Studio action type/);
    await expect(executeEmailDesignerAction(
      malformed as unknown as EmailDesignerAction, client, String, resolve, () => {},
    )).rejects.toThrow(/Unknown persisted Marketo Email Designer action type/);
    await expect(executeCampaignAction(
      malformed as unknown as CampaignAction, client, resolve, () => {},
    )).rejects.toThrow(/Unknown persisted Marketo campaign action type/);
    await expect(executeProgramAction(
      malformed as unknown as ProgramAction, client, resolve, () => {},
    )).rejects.toThrow(/Unknown persisted Marketo program action type/);
    await expect(executeBusinessObjectAction(
      malformed as unknown as BusinessObjectAction, client,
    )).rejects.toThrow(/Unknown persisted Marketo business-object action type/);
    await expect(executeAction(malformed as unknown as Parameters<typeof executeAction>[0], client))
      .rejects.toThrow(/Unknown persisted Marketo action type/);
    expect(resolve).not.toHaveBeenCalled();
    expect(clientAccesses).toBe(0);
  });
});

describe("post-dispatch creation response validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  let designerSource = { id: "designer-source", name: "Source" };
  let cases: {
    label: string;
    action: MarketoAction;
    source?: Record<string, unknown>;
    invalidId: unknown;
    gatekeeper: (action: MarketoAction) => ReturnType<typeof actionGatekeeper>;
  }[] = [
    {
      label: "classic Design Studio create",
      action: {
        id: 1, type: "designCreate", asset: "folder", provisionalId: "~1",
        parent: { id: "10", type: "Folder" }, input: { name: "Created folder" },
      },
      invalidId: 0,
      gatekeeper: action => designActionGatekeeper([action as DesignStudioAction]),
    },
    {
      label: "classic Design Studio clone",
      action: {
        id: 1, type: "designClone", asset: "email", provisionalId: "~1", sourceId: "31",
        parent: { id: "10", type: "Folder" }, name: "Cloned email",
      },
      source: { id: 31, name: "Source" },
      invalidId: 0,
      gatekeeper: action => designActionGatekeeper([action as DesignStudioAction]),
    },
    {
      label: "campaign create",
      action: {
        id: 1, type: "campaignCreate", provisionalId: "~1",
        parent: { id: "10", type: "Folder" }, name: "Created campaign",
      },
      invalidId: 0,
      gatekeeper: action => campaignActionGatekeeper([action]),
    },
    {
      label: "campaign clone",
      action: {
        id: 1, type: "campaignClone", provisionalId: "~1", sourceId: "31",
        parent: { id: "10", type: "Folder" }, name: "Cloned campaign",
      },
      source: { id: 31, name: "Source" },
      invalidId: 0,
      gatekeeper: action => campaignActionGatekeeper([action]),
    },
    {
      label: "program create",
      action: {
        id: 1, type: "programCreate", provisionalId: "~1", parentId: "10",
        input: { name: "Created program", type: "Default", channel: "Email" },
      },
      invalidId: 0,
      gatekeeper: action => campaignActionGatekeeper([action]),
    },
    {
      label: "program clone",
      action: {
        id: 1, type: "programClone", provisionalId: "~1", sourceId: "31",
        parentId: "10", name: "Cloned program",
      },
      source: { id: 31, name: "Source", workspace: "Default" },
      invalidId: 0,
      gatekeeper: action => campaignActionGatekeeper([action]),
    },
    {
      label: "Email Designer create",
      action: {
        id: 1, type: "designerCreate", asset: "designerEmail", provisionalId: "~1",
        body: { name: "Created email" },
      },
      invalidId: "",
      gatekeeper: action => emailDesignerActionGatekeeper([action]),
    },
    {
      label: "Email Designer clone",
      action: {
        id: 1, type: "designerClone", asset: "designerEmail", provisionalId: "~1",
        sourceId: "designer-source", name: "Cloned email",
        sourceSnapshot: designerCloneSnapshot(designerSource),
      },
      source: designerSource,
      invalidId: "",
      gatekeeper: action => emailDesignerActionGatekeeper([action]),
    },
  ];

  for (let creation of cases) {
    for (let response of [
      { label: "empty", body: { success: true, result: [] } },
      { label: "malformed", body: { success: true, result: {} } },
      { label: "invalid ID", body: { success: true, result: [{ id: creation.invalidId }] } },
    ]) {
      it(`keeps a ${creation.label} with a ${response.label} successful result uncertain`, async () => {
        let writes = 0;
        vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
          if (url.includes("/identity/")) {
            return Response.json({ access_token: "token", expires_in: 3600 });
          }
          if ((init?.method ?? "GET") !== "POST") {
            if (new URL(url).pathname.endsWith("/folder/10.json")) {
              return Response.json({ success: true, result: [{
                id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Default",
              }] });
            }
            return Response.json({ success: true, result: creation.source ? [creation.source] : [] });
          }
          writes++;
          return Response.json(response.body);
        });
        let stub = await creation.gatekeeper(creation.action);

        await runInDurableObject(stub, async (instance, state) => {
          let error = await instance.applyAction(creation.action.id).catch(value => value);
          expect(error).toBeInstanceOf(MarketoResponseValidationError);
          expect(error.disposition).toBe("uncertain");
          expect(state.storage.kv.get(`applying:${creation.action.id}`)).toBe("uncertain");
          expect(state.storage.kv.get(`pending:${creation.action.id}`)).toBeDefined();
          await expect(instance.applyAction(creation.action.id)).rejects.toThrow(/already dispatched/);
          await expect(instance.rejectAction(creation.action.id)).resolves.toEqual({ restart: true });
          expect(state.storage.kv.get(`pending:${creation.action.id}`)).toBeUndefined();
          expect(state.storage.kv.get(`applying:${creation.action.id}`)).toBe("uncertain-discarded");
          expect(state.storage.kv.get(`audit:${creation.action.id}`)).toMatchObject({
            outcome: "uncertain-discarded",
          });
        });
        expect(writes).toBe(1);
      });
    }
  }
});

describe("Email Designer action lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects added or removed Designer lifecycle dependents before dispatch", async () => {
    let source = {
      id: "email-1", name: "Launch",
      data: { html: { body: "<h1>Approved</h1>" } },
      headers: { subject: "Approved" },
      settings: { isOperational: false },
      associatedStates: [{ contentId: "draft-1", state: "draft" }],
    };
    let approvedDependent = {
      id: "campaign-1", name: "Campaign", channel: "Email", contentType: "Smart Campaign",
      workspaceId: "1", folderId: "2",
    };
    let otherApprovedDependent = { id: "campaign-2", name: "Other campaign" };
    for (let change of ["added", "removed", "unchanged"] as const) {
      let action: EmailDesignerAction = {
        id: 1, type: "designerLifecycle", asset: "designerEmail", targetId: "email-1",
        operation: "approve", contentId: "draft-1", sourceState: "draft",
        sourceSnapshot: designerCloneSnapshot(source),
        affectedDependents: [approvedDependent, otherApprovedDependent],
      };
      let transitions = 0;
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.includes("/identity/")) {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        let path = new URL(url).pathname;
        if (path.endsWith("/email/email-1")) {
          return Response.json({ success: true, result: [source] });
        }
        if (path.endsWith("/email/usedby")) {
          let result = [
            ...(change === "removed" ? [] : [otherApprovedDependent]),
            { ...approvedDependent, appData: { workspaceId: 1, folderId: 2 } },
            ...(change === "added" ? [{ id: "campaign-3", name: "New campaign" }] : []),
          ];
          return Response.json({
            success: true,
            result,
            pageDetails: { currentPage: 1, pageSize: 50, totalItems: result.length },
          });
        }
        transitions++;
        return Response.json({
          success: true, result: [{ contentId: "draft-1", status: "approved" }],
        });
      });
      let stub = await emailDesignerActionGatekeeper([action]);

      await runInDurableObject(stub, async (instance, state) => {
        if (change === "unchanged") {
          await expect(instance.applyAction(1)).resolves.toBeUndefined();
          expect(state.storage.kv.get("pending:1")).toBeUndefined();
        } else {
          await expect(instance.applyAction(1)).rejects.toThrow(/affected dependencies changed/);
          expect(state.storage.kv.get("applying:1")).toBeUndefined();
          expect(state.storage.kv.get("pending:1")).toBeDefined();
        }
      });
      expect(transitions).toBe(change === "unchanged" ? 1 : 0);
      vi.unstubAllGlobals();
    }
  });

  it("purges every asset family that depends on a rejected provisional program", async () => {
    let actions: MarketoAction[] = [
      {
        id: 1, type: "programCreate", provisionalId: "~1", parentId: "10",
        input: { name: "Program", type: "Default", channel: "Email" },
      },
      {
        id: 2, type: "campaignCreate", provisionalId: "~2",
        parent: { id: "77", type: "Program" }, name: "Campaign",
      },
      {
        id: 3, type: "designCreate", asset: "snippet", provisionalId: "~3",
        parent: { id: "~1", type: "Program" }, input: { name: "Snippet" },
      },
      {
        id: 4, type: "designerCreate", asset: "designerEmail", provisionalId: "~4",
        body: { name: "Designer email", appData: { workspaceId: "1", programId: "~1" } },
      },
      {
        id: 5, type: "campaignCreate", provisionalId: "~5",
        parent: { id: "77", type: "Folder" }, name: "Unrelated campaign",
      },
      { id: 6, type: "designMetadata", asset: "email", targetId: "77", patch: { name: "Unrelated classic email" } },
      { id: 7, type: "designerUpdate", asset: "designerEmail", targetId: "77", patch: { name: "Unrelated designer email" } },
    ];
    let stub = await campaignActionGatekeeper(actions, { "~1": 77 });
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.kv.put("provisionalKind:~1", "program");
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([2, 3, 4, 5, 6, 7]);
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      for (let id of [2, 3, 4]) {
        expect(state.storage.kv.get(`pending:${id}`)).toBeDefined();
        expect(state.storage.kv.get(`dependencyBlocked:${id}`)).toBe(1);
      }
      for (let id of [5, 6, 7]) expect(state.storage.kv.get(`pending:${id}`)).toBeDefined();
    });
  });

  it("purges cross-family descendants of a clone that depends on a rejected update", async () => {
    let actions: MarketoAction[] = [
      { id: 1, type: "programUpdate", targetId: "31", programName: "Source", patch: { name: "Renamed" } },
      { id: 2, type: "programClone", provisionalId: "~1", sourceId: "31", parentId: "10", name: "Clone" },
      {
        id: 3, type: "campaignCreate", provisionalId: "~2",
        parent: { id: "~1", type: "Program" }, name: "Campaign",
      },
      {
        id: 4, type: "designCreate", asset: "snippet", provisionalId: "~3",
        parent: { id: "~1", type: "Program" }, input: { name: "Snippet" },
      },
      {
        id: 5, type: "designerCreate", asset: "designerEmail", provisionalId: "~4",
        body: { name: "Designer email", appData: { workspaceId: "1", programId: "~1" } },
      },
      { id: 6, type: "campaignCreate", provisionalId: "~5", parent: { id: "10", type: "Folder" }, name: "Unrelated" },
    ];
    let stub = await campaignActionGatekeeper(actions);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([2, 3, 4, 5, 6]);
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      for (let id of [2, 3, 4, 5]) expect(state.storage.kv.get(`dependencyBlocked:${id}`)).toBe(1);
      expect(state.storage.kv.get("pending:6")).toBeDefined();
    });
  });

  it("requires same-asset updates and clones to apply in submission order", async () => {
    let actions: EmailDesignerAction[] = [
      { id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "email-A", patch: { name: "First" } },
      { id: 2, type: "designerClone", asset: "designerEmail", provisionalId: "~1", sourceId: "email-A", name: "Copy", sourceSnapshot: designerCloneSnapshot({}) },
    ];
    let requests: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      if (!init?.body) {
        let id = path.endsWith("/email-A") ? "email-A" : "email-B";
        return Response.json({ success: true, result: [{ id, name: id === "email-A" ? "First" : "Copy" }] });
      }
      requests.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ success: true, result: [{ id: path.endsWith("/clone") ? "email-B" : "email-A" }] });
    });
    let stub = await emailDesignerActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(2)).rejects.toThrow(/earlier pending mutation/);
      expect(requests).toEqual([]);
      await instance.applyAction(1);
      await instance.applyAction(2);
      expect(state.storage.kv.get("designerProvisional:~1")).toBe("email-B");
      expect(state.storage.kv.get("provisionalKind:~1")).toBe("designerEmail");
    });
    expect(requests).toEqual([
      { path: "/rest/asset/v2/email/email-A/update", body: { name: "First" } },
      { path: "/rest/asset/v2/email/clone", body: { assetId: "email-A", newAsset: { name: "Copy" } } },
    ]);
  });

  it("cascades rejection through template, email, and follow-up dependencies", async () => {
    let actions: EmailDesignerAction[] = [
      { id: 1, type: "designerCreate", asset: "designerTemplate", provisionalId: "~1", body: { name: "Template" } },
      { id: 2, type: "designerCreate", asset: "designerEmail", provisionalId: "~2", body: { name: "Email", templateId: "~1" } },
      { id: 3, type: "designerUpdate", asset: "designerEmail", targetId: "~2", patch: { description: "Later" } },
    ];
    let stub = await emailDesignerActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([2, 3]);
      for (let id of [2, 3]) expect(state.storage.kv.get(`dependencyBlocked:${id}`)).toBe(1);
    });
  });

  it("does not confuse designer and classic assets that share an opaque-looking id", async () => {
    let actions: MarketoAction[] = [
      { id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "31", patch: { name: "Designer" } },
      { id: 2, type: "designMetadata", asset: "email", targetId: "31", patch: { name: "Classic" } },
    ];
    let stub = await emailDesignerActionGatekeeper(actions);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([2]);
    });
  });

  it("accepts a successful resultless Email Designer delete", async () => {
    let target = { id: "email-1", name: "Target" };
    let action: EmailDesignerAction = {
      id: 1,
      type: "designerDelete",
      asset: "designerEmail",
      targetId: "email-1",
      targetSnapshot: designerDeleteSnapshot(target),
      affectedDependents: [],
    };
    let requests: { path: string; method: string; body: BodyInit | null | undefined }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      let path = new URL(url).pathname;
      if (path.endsWith("/email/email-1")) {
        return Response.json({ success: true, result: [target] });
      }
      if (path.endsWith("/email/usedby")) {
        return Response.json({
          success: true, result: [],
          pageDetails: { currentPage: 1, pageSize: 50, totalItems: 0 },
        });
      }
      requests.push({ path, method: init?.method ?? "GET", body: init?.body });
      return Response.json({ success: true });
    });
    let stub = await emailDesignerActionGatekeeper([action]);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).resolves.toBeUndefined();
      expect(state.storage.kv.get("applying:1")).toBe("applied");
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
    });
    expect(requests).toEqual([{
      path: "/rest/asset/v2/email/email-1/delete",
      method: "POST",
      body: "{}",
    }]);
  });

  it("keeps resultless Email Designer deletes without explicit success uncertain", async () => {
    for (let response of [{}, { result: [] }]) {
      let action: EmailDesignerAction = {
        id: 1,
        type: "designerDelete",
        asset: "designerEmail",
        targetId: "email-1",
        ...EMPTY_DESIGNER_DELETE_REVIEW,
      };
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
        let path = new URL(url).pathname;
        if (path.endsWith("/email/email-1")) {
          return Response.json({ success: true, result: [{ id: "email-1", name: "Target" }] });
        }
        if (path.endsWith("/email/usedby")) {
          return Response.json({
            success: true, result: [],
            pageDetails: { currentPage: 1, pageSize: 50, totalItems: 0 },
          });
        }
        return Response.json(response);
      });
      let stub = await emailDesignerActionGatekeeper([action]);

      await runInDurableObject(stub, async (instance, state) => {
        await expect(instance.applyAction(1)).rejects.toThrow(/unreadable response/);
        expect(state.storage.kv.get("applying:1")).toBe("uncertain");
        expect(state.storage.kv.get("pending:1")).toBeDefined();
      });
      vi.unstubAllGlobals();
    }
  });

  it("rejects Email Designer delete target drift immediately before dispatch", async () => {
    let approved = {
      id: "email-1",
      name: "Production renewal",
      appData: { workspaceId: "production", programId: "renewal" },
      status: "approved",
      data: { html: { body: "<h1>Approved</h1>" } },
      headers: { subject: "Approved subject" },
      settings: { isOperational: true },
    };
    let action: EmailDesignerAction = {
      id: 1, type: "designerDelete", asset: "designerEmail", targetId: "email-1",
      targetSnapshot: designerDeleteSnapshot(approved),
      affectedDependents: [{ id: "campaign-1", name: "Renewal campaign" }],
    };
    let deletes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      if (path.endsWith("/email/email-1")) {
        return Response.json({ success: true, result: [{
          ...approved,
          data: { html: { body: "<h1>Changed externally</h1>" } },
        }] });
      }
      deletes++;
      return Response.json({ success: true });
    });
    let stub = await emailDesignerActionGatekeeper([action]);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/delete target changed after approval/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
      expect(state.storage.kv.get("pending:1")).toBeDefined();
    });
    expect(deletes).toBe(0);
  });

  it("rejects a Designer delete without a complete snapshot before provider access", async () => {
    let fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let action = {
      id: 1, type: "designerDelete", asset: "designerEmail", targetId: "email-1",
      affectedDependents: [],
    } as unknown as EmailDesignerAction;
    let stub = await emailDesignerActionGatekeeper([action]);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/missing its complete review state/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps empty, malformed, wrong-id, and wrong-status mutation results uncertain", async () => {
    let cases: { action: EmailDesignerAction; result: unknown[] }[] = [
      { action: { id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "e", patch: { name: "New" } }, result: [] },
      { action: { id: 1, type: "designerDelete", asset: "designerEmail", targetId: "e", ...EMPTY_DESIGNER_DELETE_REVIEW }, result: [{}] },
      { action: { id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "e", patch: { name: "New" } }, result: [{ id: "other" }] },
      { action: { id: 1, type: "designerLifecycle", asset: "designerEmail", targetId: "e", operation: "approve", contentId: "e-draft", sourceState: "draft", sourceSnapshot: designerCloneSnapshot({ associatedStates: [{ contentId: "e-draft", state: "draft" }] }), affectedDependents: [] }, result: [{ contentId: "e-draft", status: "draft" }] },
    ];
    for (let { action, result } of cases) {
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
        let path = new URL(url).pathname;
        if (action.type === "designerDelete" && path.endsWith("/email/e")) {
          return Response.json({ success: true, result: [{ id: "e", name: "Target" }] });
        }
        if (action.type === "designerDelete" && path.endsWith("/email/usedby")) {
          return Response.json({
            success: true, result: [],
            pageDetails: { currentPage: 1, pageSize: 50, totalItems: 0 },
          });
        }
        if (action.type === "designerLifecycle" && !init?.body) {
          return Response.json({ success: true, result: [{
            id: "e", associatedStates: [{ contentId: "e-draft", state: "draft" }],
          }] });
        }
        if (action.type === "designerLifecycle" && url.endsWith("/usedby")) {
          return Response.json({
            success: true, result: [],
            pageDetails: { currentPage: 1, pageSize: 50, totalItems: 0 },
          });
        }
        return Response.json({ success: true, result });
      });
      let stub = await emailDesignerActionGatekeeper([action]);
      await runInDurableObject(stub, async (instance, state) => {
        await expect(instance.applyAction(1)).rejects.toThrow(/invalid|wrong designer asset/);
        expect(state.storage.kv.get("applying:1")).toBe("uncertain");
        expect(state.storage.kv.get("pending:1")).toBeDefined();
      });
      vi.unstubAllGlobals();
    }
  });

  it("accepts a clone with new lifecycle identities and draft state", async () => {
    let inherited = {
      appType: "marketo",
      appData: { workspaceId: "1" },
      data: { html: { body: "<p>Approved</p>" } },
      headers: { subject: "Approved" },
      settings: { isOperational: false },
    };
    let source = {
      id: "email-A",
      name: "Source",
      ...inherited,
      contentId: "source-approved",
      associatedStates: [{ contentId: "source-approved", state: "approved" }],
      state: "approved",
      status: "approved",
    };
    let action: EmailDesignerAction = {
      id: 1, type: "designerClone", asset: "designerEmail", provisionalId: "~1",
      sourceId: "email-A", name: "Copy", sourceSnapshot: designerCloneSnapshot(source),
    };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      if (init?.body) return Response.json({ success: true, result: [{ id: "email-B" }] });
      return Response.json({ success: true, result: [path.endsWith("/email-A") ? source : {
        id: "email-B",
        name: "Copy",
        ...inherited,
        contentId: "clone-draft",
        associatedStates: [{ contentId: "clone-draft", state: "draft" }],
        state: "draft",
        status: "draft",
      }] });
    });
    let stub = await emailDesignerActionGatekeeper([action]);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).resolves.toBeUndefined();
      expect(state.storage.kv.get("designerProvisional:~1")).toBe("email-B");
      expect(state.storage.kv.get("applying:1")).toBe("applied");
    });
  });

  it.each([
    ["approve", "draft", "approved"],
    ["unapprove", "approved", "draft"],
  ] as const)("preflights a clone after its pending source %s dispatches", async (operation, sourceState, targetState) => {
    let configuration = {
      appType: "marketo",
      data: { html: { body: "<p>Source</p>" } },
      headers: { subject: "Source" },
      settings: { isOperational: false },
      contentId: "content-1",
    };
    let actions: EmailDesignerAction[] = [
      {
        id: 1, type: "designerLifecycle", asset: "designerEmail", targetId: "email-A",
        operation, contentId: "content-1", sourceState,
        sourceSnapshot: designerCloneSnapshot({
          ...configuration, status: sourceState, state: sourceState,
          associatedStates: [{ contentId: "content-1", state: sourceState }],
        }),
        affectedDependents: [],
      },
      {
        id: 2, type: "designerClone", asset: "designerEmail", provisionalId: "~1",
        sourceId: "email-A", name: "Copy", sourceSnapshot: designerCloneSnapshot({
          ...configuration,
          status: targetState,
          state: targetState,
          associatedStates: [{ contentId: "content-1", state: targetState }],
        }),
      },
    ];
    let state = sourceState;
    let writes: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      if (init?.body) {
        if (path.endsWith("/usedby")) {
          return Response.json({
            success: true, result: [],
            pageDetails: { currentPage: 1, pageSize: 50, totalItems: 0 },
          });
        }
        writes.push(path);
        if (path.endsWith("/state/transition")) {
          state = targetState;
          return Response.json({ success: true, result: [{ contentId: "content-1", status: state }] });
        }
        return Response.json({ success: true, result: [{ id: "email-B" }] });
      }
      let result = path.endsWith("/email-B") ? {
        id: "email-B", name: "Copy",
        appType: configuration.appType,
        data: configuration.data,
        headers: configuration.headers,
        settings: configuration.settings,
      } : {
        id: "email-A", name: "Source", ...configuration,
        status: state,
        state,
        associatedStates: [{ contentId: "content-1", state }],
      };
      return Response.json({ success: true, result: [result] });
    });
    let stub = await emailDesignerActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, storage) => {
      await expect(instance.applyAction(2)).rejects.toThrow(/earlier pending mutation/);
      expect(writes).toEqual([]);
      await instance.applyAction(1);
      await expect(instance.applyAction(2)).resolves.toBeUndefined();
      expect(storage.storage.kv.get("designerProvisional:~1")).toBe("email-B");
    });
    expect(writes).toEqual([
      "/rest/asset/v2/email/state/transition",
      "/rest/asset/v2/email/clone",
    ]);
  });

  it("resolves provisional folder and template references through a dependent designer clone", async () => {
    let logicalConfiguration = {
      appType: "marketo",
      appData: { workspaceId: "1", folderId: "~1" },
      data: { html: { body: "<p>Source</p>" } },
      headers: { subject: "Source" },
      settings: { isOperational: false },
      templateId: "~2",
    };
    let resolvedConfiguration = {
      ...logicalConfiguration,
      appData: { workspaceId: "1", folderId: "11" },
      templateId: "template-A",
    };
    let actions: MarketoAction[] = [
      {
        id: 1, type: "designCreate", asset: "folder", provisionalId: "~1",
        parent: { id: "10", type: "Folder" }, input: { name: "Folder" },
      },
      {
        id: 2, type: "designerCreate", asset: "designerTemplate", provisionalId: "~2",
        body: { name: "Template", appType: "marketo", appData: { workspaceId: "1", folderId: "~1" } },
      },
      {
        id: 3, type: "designerCreate", asset: "designerEmail", provisionalId: "~3",
        body: { name: "Source", ...logicalConfiguration },
      },
      {
        id: 4, type: "designerClone", asset: "designerEmail", provisionalId: "~4",
        sourceId: "~3", name: "Copy",
        sourceSnapshot: designerCloneSnapshot({ ...logicalConfiguration, status: "draft" }),
      },
    ];
    let template = {
      id: "template-A", name: "Template", appType: "marketo",
      appData: { workspaceId: "1", folderId: "11" },
      contentId: "template-draft", state: "draft", status: "draft",
    };
    let source = {
      id: "email-A", name: "Source", ...resolvedConfiguration,
      contentId: "source-draft",
      associatedStates: [{ contentId: "source-draft", state: "draft" }],
      state: "draft", status: "draft",
    };
    let writes: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      if (init?.body) {
        writes.push({
          path,
          body: path.includes("/asset/v2/") ? JSON.parse(String(init.body)) : new URLSearchParams(String(init.body)),
        });
        let id = path.endsWith("/folders.json") ? 11
          : path.endsWith("/emailtemplate") ? "template-A"
            : path.endsWith("/clone") ? "email-B" : "email-A";
        return Response.json({ success: true, result: [{ id }] });
      }
      let result = path.endsWith("/folder/11.json")
        ? { id: 11, name: "Folder", parent: { id: 10, type: "Folder" } }
        : path.endsWith("/emailtemplate/template-A") ? template
          : path.endsWith("/email/email-A") ? source : {
        id: "email-B", name: "Copy", ...resolvedConfiguration,
        contentId: "clone-draft",
        associatedStates: [{ contentId: "clone-draft", state: "draft" }],
        state: "draft", status: "draft",
      };
      return Response.json({ success: true, result: [result] });
    });
    let stub = await emailDesignerActionGatekeeper(actions);
    await runInDurableObject(stub, async (instance, state) => {
      for (let id of [2, 3, 4]) {
        await expect(instance.applyAction(id)).rejects.toThrow(/still pending creation|earlier pending mutation/);
      }
      expect(writes).toEqual([]);
      for (let id of [1, 2, 3, 4]) await instance.applyAction(id);
      expect(state.storage.kv.get("provisional:~1")).toBe(11);
      expect(state.storage.kv.get("designerProvisional:~2")).toBe("template-A");
      expect(state.storage.kv.get("designerProvisional:~3")).toBe("email-A");
      expect(state.storage.kv.get("designerProvisional:~4")).toBe("email-B");
      expect(state.storage.kv.get("applying:4")).toBe("applied");
    });
    expect(writes.map(write => write.path)).toEqual([
      "/rest/asset/v1/folders.json",
      "/rest/asset/v2/emailtemplate",
      "/rest/asset/v2/email",
      "/rest/asset/v2/email/clone",
    ]);
    expect(writes[2]?.body).toMatchObject({ templateId: "template-A", appData: { folderId: "11" } });
    expect(writes[3]?.body).toEqual({ assetId: "email-A", newAsset: { name: "Copy" } });
  });

  it("does not map a designer clone when its exact read has the wrong template", async () => {
    let action: EmailDesignerAction = {
      id: 1, type: "designerClone", asset: "designerEmail", provisionalId: "~1",
      sourceId: "email-A", name: "Copy", sourceSnapshot: designerCloneSnapshot({ templateId: "template-A" }),
    };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      if (!init?.body) {
        if (path.endsWith("/emailtemplate/template-A")) {
          return Response.json({ success: true, result: [{ id: "template-A" }] });
        }
        return Response.json({ success: true, result: [{
          id: path.endsWith("/email-A") ? "email-A" : "email-B",
          name: path.endsWith("/email-A") ? "Source" : "Copy",
          templateId: path.endsWith("/email-A") ? "template-A" : "template-B",
        }] });
      }
      return Response.json({ success: true, result: [{ id: "email-B" }] });
    });
    let stub = await emailDesignerActionGatekeeper([action]);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/could not verify the created designer asset/);
      expect(state.storage.kv.get("designerProvisional:~1")).toBeUndefined();
      expect(state.storage.kv.get("applying:1")).toBe("uncertain");
    });
  });

  it.each([
    ["content", { data: { html: { body: "<p>Changed</p>" } } }],
    ["content id", { contentId: "changed-content" }],
    ["associated states", { associatedStates: [{ contentId: "changed-content", state: "draft" }] }],
    ["state", { state: "draft" }],
    ["status", { status: "draft" }],
  ])("rejects a designer clone before dispatch when snapshotted source %s changed", async (_label, changed) => {
    let approved = {
      appType: "marketo",
      appData: { workspaceId: "1", folderId: "10" },
      data: { html: { body: "<p>Approved</p>" } },
      headers: { subject: "Approved" },
      settings: { isOperational: false },
      contentId: "approved-content",
      associatedStates: [{ contentId: "approved-content", state: "approved" }],
      state: "approved",
      status: "approved",
    };
    let action: EmailDesignerAction = {
      id: 1, type: "designerClone", asset: "designerEmail", provisionalId: "~1",
      sourceId: "email-A", name: "Copy",
      sourceSnapshot: designerCloneSnapshot(approved),
    };
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (init?.body) writes++;
      return Response.json({ success: true, result: [{ id: "email-A", ...approved, ...changed }] });
    });
    let stub = await emailDesignerActionGatekeeper([action]);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/clone source changed after approval/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
      expect(state.storage.kv.get("pending:1")).toBeDefined();
    });
    expect(writes).toBe(0);
  });

  it("does not map a designer create whose exact read omits an approved location", async () => {
    let action: EmailDesignerAction = {
      id: 1, type: "designerCreate", asset: "designerEmail", provisionalId: "~1",
      body: { name: "Email", templateId: "template-A", appData: { workspaceId: "1", folderId: "10" } },
    };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      if (!init?.body && path.endsWith("/emailtemplate/template-A")) {
        return Response.json({ success: true, result: [{ id: "template-A" }] });
      }
      if (!init?.body && path.endsWith("/folder/10.json")) {
        return Response.json({ success: true, result: [{ id: 10, name: "Folder" }] });
      }
      return init?.body
        ? Response.json({ success: true, result: [{ id: "email-A" }] })
        : Response.json({ success: true, result: [{
            id: "email-A", name: "Email", templateId: "template-A", appData: { workspaceId: "1" },
          }] });
    });
    let stub = await emailDesignerActionGatekeeper([action]);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/could not verify the created designer asset/);
      expect(state.storage.kv.get("designerProvisional:~1")).toBeUndefined();
    });
  });

  it("keeps a successful create with a malformed response uncertain", async () => {
    let action: EmailDesignerAction = {
      id: 1,
      type: "designerCreate",
      asset: "designerEmail",
      provisionalId: "~1",
      body: { name: "Created email", appData: { workspaceId: "1", folderId: "10" } },
    };
    let mutationCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      mutationCalls++;
      if (new URL(url).pathname.endsWith("/folder/10.json")) {
        return Response.json({ success: true, result: [{ id: 10, name: "Folder" }] });
      }
      return Response.json({ success: true, result: [null] });
    });
    let stub = await emailDesignerActionGatekeeper([action]);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/unexpected shape/);
      expect(state.storage.kv.get("applying:1")).toBe("uncertain");
      expect(state.storage.kv.get("pending:1")).toBeDefined();
      await expect(instance.applyAction(1)).rejects.toThrow(/already dispatched/);
    });
    expect(mutationCalls).toBe(2);
  });
});

describe("smart campaign action lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects exact create reads with missing approved fields or the wrong parent type", async () => {
    let action: CampaignAction = {
      id: 1, type: "campaignCreate", provisionalId: "~1",
      parent: { id: "10", type: "Folder" }, name: "Campaign", description: "Approved",
    };
    for (let created of [
      { id: 31, name: "Campaign", description: "Approved" },
      { id: 31, name: "Campaign", description: "Approved", folder: { id: 10, type: "Program" } },
      { id: 31, name: "Campaign", folder: { id: 10, type: "Folder" } },
    ]) {
      let client = {
        createSmartCampaign: async () => [{ id: 31 }],
        getSmartCampaign: async () => created,
      } as never;
      await expect(executeCampaignAction(action, client, Number, () => {}))
        .rejects.toThrow(/could not verify created smart campaign/);
    }
  });

  it("requires an earlier source mutation to apply before a campaign clone", async () => {
    let actions: CampaignAction[] = [
      {
        id: 1,
        type: "campaignMetadata",
        targetId: "31",
        campaignName: "Source",
        patch: { description: "Updated" },
      },
      {
        id: 2,
        type: "campaignClone",
        provisionalId: "~1",
        sourceId: "31",
        parent: { id: "10", type: "Folder" },
        name: "Clone",
      },
    ];
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      let path = new URL(url).pathname;
      paths.push(path);
      return Response.json({ success: true, result: [{
        id: path.includes("/clone.json") || path.endsWith("/32.json") ? 32 : 31,
        ...(path.endsWith("/32.json") ? { name: "Clone", folder: { id: 10, type: "Folder" } } : {}),
      }] });
    });
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(2)).rejects.toThrow(/campaign 31 has an earlier pending mutation/);
      expect(state.storage.kv.get("applying:2")).toBeUndefined();
      expect(paths).toEqual([]);

      await instance.applyAction(1);
      await instance.applyAction(2);
      expect(state.storage.kv.get("provisional:~1")).toBe(32);
      expect(state.storage.kv.get("provisionalKind:~1")).toBe("campaign");
      expect(state.storage.kv.get("creationCandidate:2")).toBeUndefined();
    });
    expect(paths).toEqual([
      "/rest/asset/v1/smartCampaign/31.json",
      "/rest/asset/v1/smartCampaign/31.json",
      "/rest/asset/v1/smartCampaign/31/clone.json",
      "/rest/asset/v1/smartCampaign/32.json",
    ]);
  });

  it("applies same-campaign mutations in submission order", async () => {
    let actions: CampaignAction[] = [
      {
        id: 1,
        type: "campaignMetadata",
        targetId: "31",
        campaignName: "Source",
        patch: { name: "First" },
      },
      {
        id: 2,
        type: "campaignMetadata",
        targetId: "31",
        campaignName: "First",
        patch: { name: "Second" },
      },
    ];
    let submittedNames: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      submittedNames.push(new URLSearchParams(String(init?.body)).get("name") ?? "");
      return Response.json({ success: true, result: [{ id: 31 }] });
    });
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async instance => {
      await expect(instance.applyAction(2)).rejects.toThrow(/earlier pending mutation/);
      await instance.applyAction(1);
      await instance.applyAction(2);
    });
    expect(submittedNames).toEqual(["First", "Second"]);
  });

  it("purges later approvals whose descriptions depend on a rejected mutation", async () => {
    let actions: CampaignAction[] = [
      {
        id: 1,
        type: "campaignMetadata",
        targetId: "31",
        campaignName: "Source",
        patch: { name: "Renamed" },
      },
      {
        id: 2,
        type: "campaignLifecycle",
        targetId: "31",
        campaignName: "Renamed",
        campaignType: "trigger",
        programId: null,
        operation: "activate",
      },
    ];
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([2]);
      expect(state.storage.kv.get("dependencyBlocked:2")).toBe(1);
    });
  });

  it.each(["campaignTrigger", "campaignSchedule"] as const)(
    "blocks a later %s approval whose reviewed name came from a rejected rename",
    async type => {
      let actions: MarketoAction[] = [
        {
          id: 1,
          type: "campaignMetadata",
          targetId: "31",
          campaignName: "Source",
          patch: { name: "Renamed" },
        },
        type === "campaignTrigger"
          ? {
              id: 2,
              type,
              campaignId: 31,
              campaignName: "Renamed",
              programId: null,
              personIds: [7],
            }
          : {
              id: 2,
              type,
              campaignId: 31,
              campaignName: "Renamed",
              programId: null,
              runAt: "2027-01-01T00:00:00.000Z",
            },
      ];
      let stub = await campaignActionGatekeeper(actions);

      await runInDurableObject(stub, async (instance, state) => {
        await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
        expect(state.storage.kv.get("dependencyBlocked:2")).toBe(1);
        await expect(instance.applyAction(2)).rejects.toThrow(/depends on an earlier rejected action/);
      });
    },
  );

  it("purges later campaign actions using an equivalent resolved id", async () => {
    let actions: CampaignAction[] = [
      {
        id: 1,
        type: "campaignMetadata",
        targetId: "~1",
        campaignName: "Source",
        patch: { name: "Renamed" },
      },
      {
        id: 2,
        type: "campaignMetadata",
        targetId: "77",
        campaignName: "Renamed",
        patch: { description: "Later" },
      },
    ];
    let stub = await campaignActionGatekeeper(actions, { "~1": 77 });

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([2]);
      expect(state.storage.kv.get("dependencyBlocked:2")).toBe(1);
    });
  });

  it("does not purge a Design Studio asset sharing a numeric campaign id", async () => {
    let actions: MarketoAction[] = [
      {
        id: 1,
        type: "campaignMetadata",
        targetId: "31",
        campaignName: "Campaign",
        patch: { name: "Renamed" },
      },
      {
        id: 2,
        type: "designMetadata",
        asset: "email",
        targetId: "31",
        patch: { name: "Unrelated email" },
      },
    ];
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([2]);
      expect(state.storage.kv.get("pending:2")).toBeDefined();
    });
  });

  it("cascades rejection through provisional campaign dependencies", async () => {
    let actions: CampaignAction[] = [
      {
        id: 1,
        type: "campaignCreate",
        provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        name: "Source",
      },
      {
        id: 2,
        type: "campaignMetadata",
        targetId: "~1",
        campaignName: "Source",
        patch: { description: "Pending" },
      },
      {
        id: 3,
        type: "campaignClone",
        provisionalId: "~2",
        sourceId: "~1",
        parent: { id: "10", type: "Folder" },
        name: "Clone",
      },
      {
        id: 4,
        type: "campaignLifecycle",
        targetId: "~2",
        campaignName: "Clone",
        campaignType: "trigger",
        programId: null,
        operation: "delete",
      },
    ];
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([2, 3, 4]);
      for (let id of [2, 3, 4]) expect(state.storage.kv.get(`dependencyBlocked:${id}`)).toBe(1);
    });
  });
});

describe("program action lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires source mutations and same-program updates to apply in submission order", async () => {
    let actions: ProgramAction[] = [
      {
        id: 1, type: "programUpdate", targetId: "31", programName: "Source",
        patch: { description: "Updated" },
      },
      {
        id: 2, type: "programClone", provisionalId: "~1", sourceId: "31",
        parentId: "10", name: "Clone",
      },
    ];
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/folder/10.json")) return Response.json({ success: true, result: [{
        id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Default",
      }] });
      return Response.json({ success: true, result: [{
        id: path.includes("/clone.json") || path.endsWith("/32.json") ? 32 : 31,
        workspace: "Default",
        ...(path.endsWith("/32.json") ? { name: "Clone", folder: { value: 10, type: "Folder" } } : {}),
      }] });
    });
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(2)).rejects.toThrow(/program 31 has an earlier pending mutation/);
      expect(state.storage.kv.get("applying:2")).toBeUndefined();
      await instance.applyAction(1);
      await instance.applyAction(2);
      expect(state.storage.kv.get("provisional:~1")).toBe(32);
      expect(state.storage.kv.get("provisionalKind:~1")).toBe("program");
    });
    expect(paths).toEqual([
      "/rest/asset/v1/program/31.json",
      "/rest/asset/v1/program/31.json",
      "/rest/asset/v1/folder/10.json",
      "/rest/asset/v1/program/31/clone.json",
      "/rest/asset/v1/program/32.json",
    ]);
  });

  it("cascades rejection through provisional program updates and clones", async () => {
    let actions: ProgramAction[] = [
      {
        id: 1, type: "programCreate", provisionalId: "~1", parentId: "10",
        input: { name: "Program", type: "Default", channel: "Web" },
      },
      {
        id: 2, type: "programUpdate", targetId: "~1", programName: "Program",
        patch: { description: "Pending" },
      },
      {
        id: 3, type: "programClone", provisionalId: "~2", sourceId: "~1",
        parentId: "10", name: "Clone",
      },
      {
        id: 4, type: "programLifecycle", targetId: "~2", programName: "Clone",
        operation: "delete",
      },
    ];
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([2, 3, 4]);
      for (let id of [2, 3, 4]) expect(state.storage.kv.get(`dependencyBlocked:${id}`)).toBe(1);
    });
  });

  it("waits for a provisional program before applying campaign and both designer families", async () => {
    let actions: MarketoAction[] = [
      { id: 1, type: "programCreate", provisionalId: "~1", parentId: "10",
        input: { name: "Program", type: "Default", channel: "Web" } },
      { id: 2, type: "campaignCreate", provisionalId: "~2", parent: { id: "~1", type: "Program" }, name: "Campaign" },
      { id: 3, type: "designCreate", asset: "snippet", provisionalId: "~3",
        parent: { id: "~1", type: "Program" }, input: { name: "Snippet" } },
      { id: 4, type: "designerCreate", asset: "designerEmail", provisionalId: "~4",
        body: { name: "Email", appData: { workspaceId: "1", programId: "~1" } } },
    ];
    let mutationCalls = 0;
    let designerBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      mutationCalls++;
      let path = new URL(url).pathname;
      if (path.endsWith("/programs.json") || path.endsWith("/program/100.json")) return Response.json({ success: true, result: [{
        id: 100, name: "Program", type: "Default", channel: "Web", folder: { value: 10, type: "Folder" },
      }] });
      if (path.endsWith("/smartCampaigns.json") || path.endsWith("/smartCampaign/101.json")) {
        return Response.json({ success: true, result: [{ id: 101, name: "Campaign", folder: { id: 100, type: "Program" } }] });
      }
      if (path.endsWith("/snippets.json") || path.endsWith("/snippet/102.json")) {
        return Response.json({ success: true, result: [{ id: 102, name: "Snippet", folder: { id: 100, type: "Program" } }] });
      }
      if (path.includes("/asset/v2/email")) {
        if (init?.body) designerBody = JSON.parse(String(init.body));
        return Response.json({ success: true, result: [{
          id: "email-1", name: "Email", appData: { workspaceId: "1", programId: "100" },
        }] });
      }
      throw new Error(`Unexpected path ${path}`);
    });
    let stub = await campaignActionGatekeeper(actions);
    await runInDurableObject(stub, async (instance, state) => {
      for (let id of [2, 3, 4]) await expect(instance.applyAction(id)).rejects.toThrow(/~1 is still pending creation/);
      expect(mutationCalls).toBe(0);
      await instance.applyAction(1);
      for (let id of [2, 3, 4]) await instance.applyAction(id);
      expect(state.storage.kv.get("provisionalKind:~1")).toBe("program");
      expect(state.storage.kv.get("provisionalKind:~2")).toBe("campaign");
      expect(state.storage.kv.get("provisionalKind:~3")).toBe("snippet");
      expect(state.storage.kv.get("provisionalKind:~4")).toBe("designerEmail");
    });
    expect(mutationCalls).toBe(9);
    expect(designerBody).toMatchObject({ appData: { programId: "100" } });
  });
});

describe("provisional id kind safety", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects cross-kind targets, sources, templates, and parents before dispatch", async () => {
    let actions: MarketoAction[] = [
      { id: 1, type: "designCreate", asset: "emailTemplate", provisionalId: "~1",
        parent: { id: "10", type: "Folder" }, input: { name: "Template", content: "x" } },
      { id: 2, type: "campaignCreate", provisionalId: "~2", parent: { id: "~1", type: "Program" }, name: "Campaign" },
      { id: 3, type: "designerCreate", asset: "designerTemplate", provisionalId: "~3", body: { name: "Designer template" } },
      { id: 4, type: "designMetadata", asset: "email", targetId: "~1", patch: { name: "Wrong" } },
      { id: 5, type: "programUpdate", targetId: "~2", programName: "Wrong", patch: { name: "Wrong" } },
      { id: 6, type: "designerDelete", asset: "designerEmail", targetId: "~3", ...EMPTY_DESIGNER_DELETE_REVIEW },
      { id: 7, type: "designCreate", asset: "email", provisionalId: "~4",
        parent: { id: "10", type: "Folder" }, input: { name: "Wrong", templateId: "~2" } },
      { id: 8, type: "designerCreate", asset: "designerEmail", provisionalId: "~5",
        body: { name: "Wrong", templateId: "~1" } },
    ];
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      writes++;
      return Response.json({ success: true, result: [] });
    });
    let stub = await campaignActionGatekeeper(actions);
    await runInDurableObject(stub, async instance => {
      for (let id of [2, 4, 5, 6, 7, 8]) await expect(instance.applyAction(id)).rejects.toThrow(/is not a/);
    });
    expect(writes).toBe(0);
  });
});

describe("Design Studio action lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects changed classic dependencies before publishing or deleting", async () => {
    let reviewed = {
      id: 91, name: "Dependent email", type: "Email", status: "approved", updatedAt: "2026-01-01T00:00:00Z",
    };
    for (let operation of ["approve", "delete"] as const) for (let drifted of [false, true]) {
      let action: DesignStudioAction = {
        id: 1,
        type: "designLifecycle",
        asset: "emailTemplate",
        targetId: "31",
        operation,
        snapshot: { metadata: { name: "Template" }, content: "<p>Draft</p>", affectedDependents: [reviewed] },
      };
      let lifecycleWrites = 0;
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.includes("/identity/")) {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        let path = new URL(url).pathname;
        if (path.endsWith("/emailTemplate/31.json")) {
          return Response.json({ success: true, result: [{ id: 31, name: "Template", status: "draft" }] });
        }
        if (path.endsWith("/emailTemplate/31/content.json")) {
          return Response.json({ success: true, result: [{ id: 31, content: "<p>Draft</p>" }] });
        }
        if (path.endsWith("/emailTemplates/31/usedBy.json")) {
          return Response.json({
            success: true,
            result: [{ ...reviewed, updatedAt: drifted ? "2026-01-02T00:00:00Z" : reviewed.updatedAt }],
          });
        }
        lifecycleWrites++;
        return Response.json({ success: true, result: [{ id: 31 }] });
      });
      let stub = await designActionGatekeeper([action]);

      await runInDurableObject(stub, async (instance, state) => {
        if (drifted) {
          await expect(instance.applyAction(1)).rejects.toThrow(/publishable state changed/);
          expect(state.storage.kv.get("pending:1")).toBeDefined();
        } else {
          await expect(instance.applyAction(1)).resolves.toBeUndefined();
        }
      });
      expect(lifecycleWrites).toBe(drifted ? 0 : 1);
      vi.unstubAllGlobals();
    }
  });

  it("rejects changed classic lifecycle content, headers, or settings before dispatch", async () => {
    let snapshot = {
      metadata: {
        name: "Launch", subject: "Approved subject", fromName: "Marketing",
        fromEmail: "marketing@example.com", replyEmail: "reply@example.com",
        settings: { operational: true },
      },
      content: [{
        htmlId: "hero", contentType: "DynamicContent", index: 1,
        value: { type: "DynamicContent", segmentationId: 17, default: "Fallback" },
      }, {
        htmlId: "main",
        index: 2,
        value: [
          { type: "HTML", value: "<h1>Approved</h1>" },
          { type: "Text", value: "Approved" },
        ],
      }],
      affectedDependents: null,
    };
    for (let changed of ["content", "dynamic", "header", "settings", undefined] as const) {
      let action: DesignStudioAction = {
        id: 1, type: "designLifecycle", asset: "email", targetId: "21",
        operation: "approve", snapshot,
      };
      let lifecycleWrites = 0;
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.includes("/identity/")) {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        let path = new URL(url).pathname;
        if (path.endsWith("/email/21.json")) {
          return Response.json({ success: true, result: [{
            id: 21, name: "Launch", status: "draft",
            subject: { type: "Text", value: changed === "header" ? "Externally changed" : "Approved subject" },
            fromName: { type: "Text", value: "Marketing" },
            fromEmail: { type: "Text", value: "marketing@example.com" },
            replyEmail: { type: "Text", value: "reply@example.com" },
            operational: changed !== "settings",
          }] });
        }
        if (path.endsWith("/email/21/content.json")) {
          return Response.json({ success: true, result: [{
            htmlId: "main",
            index: 2,
            value: [
              { type: "HTML", value: changed === "content" ? "<h1>Externally changed</h1>" : "<h1>Approved</h1>" },
              { type: "Text", value: "Approved" },
            ],
          }, {
            htmlId: "hero", contentType: "DynamicContent", index: 1,
            value: {
              type: "DynamicContent", segmentationId: changed === "dynamic" ? 18 : 17,
              default: "Fallback",
            },
          }] });
        }
        lifecycleWrites++;
        return Response.json({ success: true, result: [{ id: 21 }] });
      });
      let stub = await designActionGatekeeper([action]);

      await runInDurableObject(stub, async (instance, state) => {
        if (changed === undefined) {
          await expect(instance.applyAction(1)).resolves.toBeUndefined();
          expect(state.storage.kv.get("pending:1")).toBeUndefined();
        } else {
          await expect(instance.applyAction(1)).rejects.toThrow(/publishable state changed/);
          expect(state.storage.kv.get("applying:1")).toBeUndefined();
          expect(state.storage.kv.get("pending:1")).toBeDefined();
        }
      });
      expect(lifecycleWrites).toBe(changed === undefined ? 1 : 0);
      vi.unstubAllGlobals();
    }
  });

  it("maps a created classic template and applies it to a dependent email", async () => {
    let actions: DesignStudioAction[] = [
      {
        id: 1,
        type: "designCreate",
        asset: "emailTemplate",
        provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        input: { name: "Template", content: "<html>Template</html>" },
      },
      {
        id: 2,
        type: "designCreate",
        asset: "email",
        provisionalId: "~2",
        parent: { id: "10", type: "Folder" },
        input: { name: "Email", templateId: "~1" },
      },
    ];
    let emailRequest: URLSearchParams | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      if (path.endsWith("/folder/10.json")) return Response.json({ success: true, result: [{
        id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Default",
      }] });
      if (path.endsWith("/emailTemplates.json")) {
        return Response.json({ success: true, result: [{ id: 201 }] });
      }
      if (path.endsWith("/emailTemplate/201.json")) {
        return Response.json({ success: true, result: [{
          id: 201, name: "Template", folder: { id: 10, type: "Folder" },
        }] });
      }
      if (path.endsWith("/emails.json")) {
        emailRequest = new URLSearchParams(String(init?.body));
        return Response.json({ success: true, result: [{ id: 202 }] });
      }
      if (path.endsWith("/email/202.json")) {
        return Response.json({ success: true, result: [{
          id: 202, name: "Email", template: 201, folder: { id: 10, type: "Folder" },
        }] });
      }
      throw new Error(`Unexpected path ${path}`);
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await instance.applyAction(1);
      expect(state.storage.kv.get("provisional:~1")).toBe(201);
      await instance.applyAction(2);
      expect(state.storage.kv.get("provisional:~2")).toBe(202);
    });
    expect(emailRequest?.get("template")).toBe("201");
  });

  it("creates then approves a provisional classic template in order", async () => {
    let actions: DesignStudioAction[] = [
      {
        id: 1, type: "designCreate", asset: "emailTemplate", provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        input: { name: "Template", description: "Reviewed", content: "<p>Draft</p>" },
      },
      {
        id: 2, type: "designLifecycle", asset: "emailTemplate", targetId: "~1", operation: "approve",
        snapshot: {
          metadata: { name: "Template", description: "Reviewed" },
          content: "<p>Draft</p>",
          affectedDependents: [],
        },
      },
    ];
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/folder/10.json")) return Response.json({ success: true, result: [{
        id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Default",
      }] });
      if (path.endsWith("/emailTemplates.json")) {
        return Response.json({ success: true, result: [{ id: 201 }] });
      }
      if (path.endsWith("/emailTemplate/201/content.json")) {
        return Response.json({ success: true, result: [{ id: 201, content: "<p>Draft</p>" }] });
      }
      if (path.endsWith("/emailTemplates/201/usedBy.json")) {
        return Response.json({ success: true, result: [] });
      }
      return Response.json({ success: true, result: [{
        id: 201, name: "Template", description: "Reviewed", status: "draft",
        folder: { id: 10, type: "Folder" },
      }] });
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(2)).rejects.toThrow(/~1 is still pending creation/);
      expect(paths).toEqual([]);
      await instance.applyAction(1);
      expect(state.storage.kv.get("provisional:~1")).toBe(201);
      await expect(instance.applyAction(2)).resolves.toBeUndefined();
    });

    expect(paths).toEqual([
      "/rest/asset/v1/folder/10.json",
      "/rest/asset/v1/emailTemplates.json",
      "/rest/asset/v1/emailTemplate/201.json",
      "/rest/asset/v1/emailTemplate/201.json",
      "/rest/asset/v1/emailTemplate/201/content.json",
      "/rest/asset/v1/emailTemplates/201/usedBy.json",
      "/rest/asset/v1/emailTemplate/201/approveDraft.json",
    ]);
  });

  it("reads and sends the landing page's current source template when cloning", async () => {
    let action: DesignStudioAction = {
      id: 1,
      type: "designClone",
      asset: "landingPage",
      provisionalId: "~1",
      sourceId: "31",
      parent: { id: "10", type: "Folder" },
      name: "Clone",
    };
    let submitted: URLSearchParams | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      let path = new URL(url).pathname;
      if (init?.body) {
        submitted = new URLSearchParams(String(init.body));
        return Response.json({ success: true, result: [{ id: 88 }] });
      }
      return Response.json({ success: true, result: [path.endsWith("/31.json")
        ? { id: 31, name: "Source", template: 20 }
        : { id: 88, name: "Clone", template: 20, folder: { id: 10, type: "Folder" } }] });
    });
    let stub = await designActionGatekeeper([action]);

    await runInDurableObject(stub, instance => instance.applyAction(1));

    expect(submitted?.get("template")).toBe("20");
    expect(submitted?.get("name")).toBe("Clone");
    expect(submitted?.get("folder")).toBe(JSON.stringify({ id: 10, type: "Folder" }));
  });

  it("rejects missing, wrong-id, and template-less landing-page sources before cloning", async () => {
    let action: DesignStudioAction = {
      id: 1, type: "designClone", asset: "landingPage", provisionalId: "~1", sourceId: "31",
      parent: { id: "10", type: "Folder" }, name: "Clone",
    };
    for (let source of [undefined, { id: 32, template: 20 }, { id: 31, template: 0 }]) {
      let writes = 0;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
        if (init?.body) writes++;
        return Response.json({ success: true, result: source ? [source] : [] });
      });
      let stub = await designActionGatekeeper([action]);
      await runInDurableObject(stub, async (instance, state) => {
        await expect(instance.applyAction(1)).rejects.toThrow(/not found|no valid source template/);
        expect(state.storage.kv.get("applying:1")).toBeUndefined();
      });
      expect(writes).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it("forces insert-only semantics when an approved file creation reaches Marketo", async () => {
    let action: DesignStudioAction = {
      id: 1,
      type: "designCreate",
      asset: "file",
      provisionalId: "~1",
      parent: { id: "10", type: "Folder" },
      input: {
        name: "note.txt",
        mimeType: "text/plain",
        data: new TextEncoder().encode("first"),
        sha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
      },
    };
    let submitted: FormData | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (new URL(url).pathname.endsWith("/folder/10.json")) return Response.json({ success: true, result: [{
        id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Default",
      }] });
      if (init?.body) submitted = init.body as FormData;
      return Response.json({ success: true, result: [{
        id: 88, name: "note.txt", mimeType: "text/plain", folder: { id: 10, type: "Folder" },
      }] });
    });
    let stub = await designActionGatekeeper([action]);

    await runInDurableObject(stub, instance => instance.applyAction(1));

    expect(submitted).toBeInstanceOf(FormData);
    expect(submitted!.get("insertOnly")).toBe("true");
    expect(await (submitted!.get("file") as Blob).text()).toBe("first");
  });

  it("resolves a provisional id to Marketo's real id for dependent actions", async () => {
    let actions: DesignStudioAction[] = [
      {
        id: 1,
        type: "designCreate",
        asset: "folder",
        provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        input: { name: "Child" },
      },
      { id: 2, type: "designMetadata", asset: "folder", targetId: "~1", patch: { name: "Renamed" } },
    ];
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      let path = new URL(url).pathname;
      paths.push(path);
      return Response.json({ success: true, result: [{
        id: 101, name: "Child", parent: { id: 10, type: "Folder" },
      }] });
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await instance.applyAction(1);
      expect(state.storage.kv.get("provisional:~1")).toBe(101);
      await instance.applyAction(2);
      expect(state.storage.kv.get("pending:2")).toBeUndefined();
    });
    expect(paths).toEqual([
      "/rest/asset/v1/folders.json",
      "/rest/asset/v1/folder/101.json",
      "/rest/asset/v1/folder/101.json",
    ]);
  });

  it("refuses an unresolved dependency before dispatching an Asset API request", async () => {
    let action: DesignStudioAction = {
      id: 1,
      type: "designContent",
      asset: "emailTemplate",
      targetId: "~9",
      content: "<html>new</html>",
    };
    let assetCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      assetCalls++;
      return Response.json({ success: true, result: [{ id: 9 }] });
    });
    let stub = await designActionGatekeeper([action]);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/~9 is not a emailTemplate/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
      expect(state.storage.kv.get("pending:1")).toBeDefined();
    });
    expect(assetCalls).toBe(0);
  });

  it("requires an earlier source mutation to apply before dispatching a clone", async () => {
    let actions: DesignStudioAction[] = [
      {
        id: 1,
        type: "designContent",
        asset: "emailTemplate",
        targetId: "~1",
        content: "<html>updated</html>",
      },
      {
        id: 2,
        type: "designClone",
        asset: "emailTemplate",
        provisionalId: "~2",
        sourceId: "31",
        parent: { id: "10", type: "Folder" },
        name: "Clone",
      },
    ];
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      let path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/folder/10.json")) return Response.json({ success: true, result: [{
        id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Default",
      }] });
      return Response.json({ success: true, result: [{
        id: path.includes("/clone.json") || path.includes("emailTemplate/32.json") ? 32 : 31,
        ...(path.includes("emailTemplate/32.json") ? { name: "Clone", folder: { id: 10, type: "Folder" } } : {}),
      }] });
    });
    let stub = await designActionGatekeeper(actions, { "~1": 31 });

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(2)).rejects.toThrow(/emailTemplate 31 has an earlier pending mutation/);
      expect(state.storage.kv.get("applying:2")).toBeUndefined();
      expect(paths).toEqual([]);

      await instance.applyAction(1);
      await instance.applyAction(2);
      expect(state.storage.kv.get("provisional:~2")).toBe(32);
    });
    expect(paths).toEqual([
      "/rest/asset/v1/emailTemplate/31/content.json",
      "/rest/asset/v1/folder/10.json",
      "/rest/asset/v1/emailTemplate/31.json",
      "/rest/asset/v1/emailTemplate/31/clone.json",
      "/rest/asset/v1/emailTemplate/32.json",
    ]);
  });

  it("applies classic asset and folder mutations in submission order", async () => {
    let actions: DesignStudioAction[] = [
      { id: 1, type: "designMetadata", asset: "emailTemplate", targetId: "31", patch: { name: "First" } },
      { id: 2, type: "designContent", asset: "emailTemplate", targetId: "31", content: "second" },
      { id: 3, type: "designLifecycle", asset: "emailTemplate", targetId: "31", operation: "approve", snapshot: { metadata: { name: "First" }, content: "second", affectedDependents: [] } },
      { id: 4, type: "designMetadata", asset: "folder", targetId: "40", patch: { name: "Folder" } },
      { id: 5, type: "designDeleteFolder", targetId: "40" },
    ];
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/emailTemplate/31/content.json")) {
        return Response.json({ success: true, result: [{ id: 31, content: "second" }] });
      }
      if (path.endsWith("/emailTemplate/31.json")) {
        return Response.json({ success: true, result: [{ id: 31, name: "First" }] });
      }
      if (path.endsWith("/emailTemplates/31/usedBy.json")) {
        return Response.json({ success: true, result: [] });
      }
      return Response.json({ success: true, result: [{ id: path.includes("folder/40") ? 40 : 31 }] });
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(3)).rejects.toThrow(/emailTemplate 31 has an earlier pending mutation/);
      await expect(instance.applyAction(2)).rejects.toThrow(/emailTemplate 31 has an earlier pending mutation/);
      await expect(instance.applyAction(5)).rejects.toThrow(/folder 40 has an earlier pending mutation/);
      expect(paths).toEqual([]);
      for (let id of [1, 2, 3, 4, 5]) await instance.applyAction(id);
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([]);
    });
    expect(paths).toEqual([
      "/rest/asset/v1/emailTemplate/31.json",
      "/rest/asset/v1/emailTemplate/31/content.json",
      "/rest/asset/v1/emailTemplate/31.json",
      "/rest/asset/v1/emailTemplate/31/content.json",
      "/rest/asset/v1/emailTemplates/31/usedBy.json",
      "/rest/asset/v1/emailTemplate/31/approveDraft.json",
      "/rest/asset/v1/folder/40.json",
      "/rest/asset/v1/folder/40/delete.json",
    ]);
  });

  it("applies a clone before later mutations of its source", async () => {
    let actions: DesignStudioAction[] = [
      {
        id: 1,
        type: "designClone",
        asset: "emailTemplate",
        provisionalId: "~1",
        sourceId: "31",
        parent: { id: "10", type: "Folder" },
        name: "Snapshot",
      },
      { id: 2, type: "designMetadata", asset: "emailTemplate", targetId: "31", patch: { name: "Later" } },
      { id: 3, type: "designLifecycle", asset: "emailTemplate", targetId: "31", operation: "delete", snapshot: { metadata: { name: "Later" }, content: "source", affectedDependents: [] } },
    ];
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/folder/10.json")) return Response.json({ success: true, result: [{
        id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Default",
      }] });
      if (path.endsWith("/emailTemplate/31/content.json")) {
        return Response.json({ success: true, result: [{ id: 31, content: "source" }] });
      }
      if (path.endsWith("/emailTemplates/31/usedBy.json")) {
        return Response.json({ success: true, result: [] });
      }
      return Response.json({ success: true, result: [{
        id: path.includes("clone") || path.includes("emailTemplate/32.json") ? 32 : 31,
        ...(path.includes("emailTemplate/32.json")
          ? { name: "Snapshot", folder: { id: 10, type: "Folder" } }
          : { name: "Later" }),
      }] });
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async instance => {
      await expect(instance.applyAction(2)).rejects.toThrow(/emailTemplate 31 has an earlier pending mutation/);
      await expect(instance.applyAction(3)).rejects.toThrow(/emailTemplate 31 has an earlier pending mutation/);
      expect(paths).toEqual([]);
      for (let id of [1, 2, 3]) await instance.applyAction(id);
    });
    expect(paths).toEqual([
      "/rest/asset/v1/folder/10.json",
      "/rest/asset/v1/emailTemplate/31.json",
      "/rest/asset/v1/emailTemplate/31/clone.json",
      "/rest/asset/v1/emailTemplate/32.json",
      "/rest/asset/v1/emailTemplate/31.json",
      "/rest/asset/v1/emailTemplate/31.json",
      "/rest/asset/v1/emailTemplate/31/content.json",
      "/rest/asset/v1/emailTemplates/31/usedBy.json",
      "/rest/asset/v1/emailTemplate/31/delete.json",
    ]);
  });

  it("protects folders and templates referenced by earlier creates", async () => {
    let actions: DesignStudioAction[] = [
      {
        id: 1,
        type: "designCreate",
        asset: "snippet",
        provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        input: { name: "Child" },
      },
      { id: 2, type: "designDeleteFolder", targetId: "10" },
      {
        id: 3,
        type: "designCreate",
        asset: "email",
        provisionalId: "~2",
        parent: { id: "11", type: "Folder" },
        input: { name: "Email", templateId: "20" },
      },
      { id: 4, type: "designContent", asset: "emailTemplate", targetId: "20", content: "Later" },
    ];
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      paths.push(path);
      let id = path.endsWith("/snippets.json") || path.includes("/snippet/101.json") ? 101
        : path.endsWith("/emails.json") || path.includes("/email/102.json") ? 102
        : path.includes("folder/10") ? 10 : 20;
      let exact = path.includes("/snippet/101.json")
        ? { name: "Child", folder: { id: 10, type: "Folder" } }
        : path.includes("/email/102.json")
          ? { name: "Email", template: 20, folder: { id: 11, type: "Folder" } }
          : {};
      return Response.json({ success: true, result: [{ id, ...exact }] });
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async instance => {
      await expect(instance.applyAction(2)).rejects.toThrow(/folder 10 has an earlier pending mutation/);
      await expect(instance.applyAction(4)).rejects.toThrow(/emailTemplate 20 has an earlier pending mutation/);
      expect(paths).toEqual([]);
      for (let id of [1, 2, 3, 4]) await instance.applyAction(id);
    });
    expect(paths).toEqual([
      "/rest/asset/v1/snippets.json",
      "/rest/asset/v1/snippet/101.json",
      "/rest/asset/v1/folder/10/delete.json",
      "/rest/asset/v1/emails.json",
      "/rest/asset/v1/email/102.json",
      "/rest/asset/v1/emailTemplate/20/content.json",
    ]);
  });

  it("cascades rejection through provisional dependencies and requests a restart", async () => {
    let actions: DesignStudioAction[] = [
      {
        id: 1,
        type: "designCreate",
        asset: "folder",
        provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        input: { name: "Parent" },
      },
      {
        id: 2,
        type: "designCreate",
        asset: "snippet",
        provisionalId: "~2",
        parent: { id: "~1", type: "Folder" },
        input: { name: "Child", html: "<p>x</p>" },
      },
      { id: 3, type: "designContent", asset: "snippet", targetId: "~2", text: "updated" },
      { id: 4, type: "designMetadata", asset: "folder", targetId: "77", patch: { name: "Unrelated" } },
    ];
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([2, 3, 4]);
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      for (let id of [2, 3]) expect(state.storage.kv.get(`dependencyBlocked:${id}`)).toBe(1);
      expect(state.storage.kv.get("pending:4")).toBeDefined();
    });
  });

  it.each(["designMetadata", "designContent"] as const)(
    "blocks a clone derived from a rejected %s update",
    async type => {
      let update: DesignStudioAction = type === "designMetadata"
        ? { id: 1, type, asset: "emailTemplate", targetId: "31", patch: { name: "Updated" } }
        : { id: 1, type, asset: "emailTemplate", targetId: "31", content: "Updated content" };
      let clone: DesignStudioAction = {
        id: 2, type: "designClone", asset: "emailTemplate", provisionalId: "~1",
        sourceId: "31", parent: { id: "10", type: "Folder" }, name: "Derived clone",
      };
      let stub = await designActionGatekeeper([update, clone]);

      await runInDurableObject(stub, async (instance, state) => {
        await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
        expect(state.storage.kv.get("pending:1")).toBeUndefined();
        expect(state.storage.kv.get("dependencyBlocked:2")).toBe(1);
        await expect(instance.applyAction(2)).rejects.toThrow(/depends on an earlier rejected action/);
      });
    },
  );

  it("does not persist or order landing-page clones by a snapshotted template", async () => {
    let actions: DesignStudioAction[] = [
      {
        id: 1,
        type: "designCreate",
        asset: "landingPageTemplate",
        provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        input: { name: "Template" },
      },
      {
        id: 2,
        type: "designClone",
        asset: "landingPage",
        provisionalId: "~2",
        sourceId: "31",
        parent: { id: "10", type: "Folder" },
        name: "Page clone",
      },
    ];
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      let path = new URL(url).pathname;
      if (init?.body) writes++;
      if (path.endsWith("/landingPage/31.json")) {
        return Response.json({ success: true, result: [{ id: 31, template: 20 }] });
      }
      return Response.json({ success: true, result: [{
        id: 88, name: "Page clone", template: 20, folder: { id: 10, type: "Folder" },
      }] });
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(2)).resolves.toBeUndefined();
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([]);
    });
    expect(writes).toBe(1);
  });

  it("marks a create ambiguous when a follow-up fails after Marketo assigned its id", async () => {
    let actions: DesignStudioAction[] = [
      {
        id: 1,
        type: "designCreate",
        asset: "snippet",
        provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        input: { name: "Snippet", html: "<p>initial</p>" },
      },
      { id: 2, type: "designMetadata", asset: "snippet", targetId: "~1", patch: { name: "Renamed" } },
      { id: 3, type: "designContent", asset: "snippet", targetId: "~1", text: "Plain" },
    ];
    let mutationCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.endsWith("/rest/asset/v1/snippets.json")) {
        return Response.json({ success: true, result: [{ id: 88 }] });
      }
      mutationCalls++;
      return Response.json({
        success: false,
        errors: [{ code: "1003", message: "Content rejected" }],
      });
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow("Marketo request failed (code 1003; HTTP 200).");
      expect(state.storage.kv.get("provisional:~1")).toBeUndefined();
      expect(state.storage.kv.get("applying:1")).toBe("uncertain");
      expect(state.storage.kv.get("pending:1")).toBeDefined();
      await expect(instance.applyAction(2)).rejects.toThrow(/~1 is still pending creation/);
      await expect(instance.applyAction(3)).rejects.toThrow(/~1 is still pending creation/);
      expect(state.storage.kv.get("applying:2")).toBeUndefined();
      expect(state.storage.kv.get("applying:3")).toBeUndefined();
      await expect(instance.applyAction(1)).rejects.toThrow(/already dispatched/);
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get("applying:1")).toBe("uncertain-discarded");
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([2, 3]);
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      for (let id of [2, 3]) expect(state.storage.kv.get(`dependencyBlocked:${id}`)).toBe(1);
      expect(state.storage.kv.get("provisional:~1")).toBeUndefined();
      expect(state.storage.kv.get("provisionalKind:~1")).toBeUndefined();
      await expect(instance.applyAction(1)).rejects.toThrow(/discarded/);
    });
    expect(mutationCalls).toBe(1);
  });

  it("keeps explicitly rejected first writes retryable for compound classic-email actions", async () => {
    let actions: DesignStudioAction[] = [
      {
        id: 1,
        type: "designMetadata",
        asset: "email",
        targetId: "44",
        patch: { name: "New name", subject: "New subject" },
      },
      {
        id: 2,
        type: "designContent",
        asset: "snippet",
        targetId: "44",
        html: "<p>new</p>",
        text: "new",
      },
    ];
    vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : Response.json({
        success: false,
        errors: [{ code: "1003", message: "Rejected before writing" }],
      }));
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      for (let id of [1, 2]) {
        await expect(instance.applyAction(id)).rejects.toThrow(/code 1003/);
        expect(state.storage.kv.get(`applying:${id}`)).toBeUndefined();
        await instance.rejectAction(id);
        expect(state.storage.kv.get(`pending:${id}`)).toBeUndefined();
      }
    });
  });

  it("keeps a two-rendition snippet update uncertain when a later dispatched step fails", async () => {
    let action: DesignStudioAction = {
      id: 1,
      type: "designContent",
      asset: "snippet",
      targetId: "44",
      html: "<p>new</p>",
      text: "new",
    };
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      writes++;
      if (writes === 1) return Response.json({ success: true, result: [{ id: 44 }] });
      return Response.json({ success: false, errors: [{ code: "1003", message: "Text rejected" }] });
    });
    let stub = await designActionGatekeeper([action]);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow("Marketo request failed (code 1003; HTTP 200).");
      expect(state.storage.kv.get("applying:1")).toBe("uncertain");
      expect(state.storage.kv.get("pending:1")).toBeDefined();
    });
  });

  it("keeps ambiguous multi-row creation results uncertain", async () => {
    let action: DesignStudioAction = {
      id: 1,
      type: "designCreate",
      asset: "folder",
      provisionalId: "~1",
      parent: { id: "10", type: "Folder" },
      input: { name: "Child" },
    };
    vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : Response.json({ success: true, result: [{ id: 12 }, { id: 13 }] }));
    let stub = await designActionGatekeeper([action]);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/exactly one positive numeric id/);
      expect(state.storage.kv.get("applying:1")).toBe("uncertain");
      expect(state.storage.kv.get("pending:1")).toBeDefined();
      expect(state.storage.kv.get("provisional:~1")).toBeUndefined();
    });
  });

  it("keeps empty, malformed, and mismatched mutation results uncertain and pending", async () => {
    let action: DesignStudioAction = {
      id: 1,
      type: "designMetadata",
      asset: "folder",
      targetId: "12",
      patch: { name: "Renamed" },
    };
    for (let result of [[], [{}], [{ id: 13 }], [{ id: 12 }, { id: 12 }]]) {
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.includes("/identity/")) {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        return Response.json({ success: true, result });
      });
      let stub = await designActionGatekeeper([action]);

      await runInDurableObject(stub, async (instance, state) => {
        await expect(instance.applyAction(1)).rejects.toThrow(/invalid result/);
        expect(state.storage.kv.get("applying:1")).toBe("uncertain");
        expect(state.storage.kv.get("pending:1")).toBeDefined();
        expect(state.storage.kv.get<number[]>("pending:index")).toEqual([1]);
        await expect(instance.applyAction(1)).rejects.toThrow(/already dispatched/);
        await expect(instance.rejectAction(1)).resolves.toBeUndefined();
        expect(state.storage.kv.get("applying:1")).toBe("uncertain-discarded");
        expect(state.storage.kv.get("pending:1")).toBeUndefined();
      });
      vi.unstubAllGlobals();
    }
  });

  it("uses the approved filename for a file replacement", async () => {
    let action: DesignStudioAction = {
      id: 1,
      type: "designContent",
      asset: "file",
      targetId: "55",
      data: new TextEncoder().encode("replacement"),
      mimeType: "text/plain",
      sha256: "ignored-in-this-test",
      fileName: "approved-name.txt",
    };
    let uploaded: File | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (!(init?.body instanceof FormData)) throw new Error("Expected multipart file replacement.");
      uploaded = init.body.get("file") as File;
      return Response.json({ success: true, result: [{ id: 55 }] });
    });
    let stub = await designActionGatekeeper([action]);

    await runInDurableObject(stub, instance => instance.applyAction(1));
    expect(uploaded?.name).toBe("approved-name.txt");
  });

  it("executes approved email section replacements with Marketo's Text payload shape", async () => {
    let action: DesignStudioAction = {
      id: 1,
      type: "designContent",
      asset: "email",
      targetId: "31",
      sectionId: "hero/main",
      html: "<p>Replacement</p>",
      text: "Replacement",
    };
    let submitted: URLSearchParams | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (url.endsWith("/rest/asset/v1/email/31/content.json")) {
        return Response.json({
          success: true,
          result: [{ htmlId: "hero/main", contentType: "Text", value: "Current" }],
        });
      }
      if (init?.body instanceof URLSearchParams) submitted = init.body;
      else if (typeof init?.body === "string") submitted = new URLSearchParams(init.body);
      else throw new Error("Expected an email section form body.");
      return Response.json({ success: true, result: [{ id: 31 }] });
    });
    let stub = await designActionGatekeeper([action]);

    await runInDurableObject(stub, instance => instance.applyAction(1));
    expect(Object.fromEntries(submitted!)).toEqual({
      type: "Text",
      value: "<p>Replacement</p>",
      textValue: "Replacement",
    });
  });
});

describe("action dispatch lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const ACTION: MarketoAction = {
    id: 17,
    type: "listAdd",
    listId: 5,
    listName: "Customers",
    personIds: [7],
  };

  it("revalidates person id upserts before dispatch", async () => {
    let invalidActions: Extract<MarketoAction, { type: "upsertPeople" }>[] = [
      { id: 1, type: "upsertPeople", records: [{ id: 7 }], upsertAction: "createOrUpdate", lookupField: "id" },
      { id: 2, type: "upsertPeople", records: [{ id: "7" }], upsertAction: "updateOnly", lookupField: "id" },
    ];
    for (let action of invalidActions) {
      let calls = 0;
      vi.stubGlobal("fetch", async () => { calls++; throw new Error("No provider call expected"); });
      let stub = await actionGatekeeper(action);
      await runInDurableObject(stub, async instance => {
        await expect(instance.applyAction(action.id)).rejects.toThrow(
          action.upsertAction === "updateOnly" ? /positive safe integer id/ : /only for updateOnly/,
        );
      });
      expect(calls).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it("orders conflicts consistently across non-asset action families", async () => {
    let cases: MarketoAction[][] = [
      [
        { id: 1, type: "listAdd", listId: 5, listName: "Customers", personIds: [7] },
        { id: 2, type: "listRemove", listId: 5, listName: "Customers", personIds: [7, 8] },
      ],
      [
        { id: 1, type: "campaignLifecycle", targetId: "31", campaignName: "Campaign", programId: null, operation: "deactivate" },
        { id: 2, type: "campaignTrigger", campaignId: 31, campaignName: "Campaign", programId: null, personIds: [7] },
      ],
      [
        { id: 1, type: "campaignTrigger", campaignId: 31, campaignName: "Campaign", programId: null, personIds: [7] },
        { id: 2, type: "campaignLifecycle", targetId: "31", campaignName: "Campaign", programId: null, operation: "deactivate" },
      ],
      [
        { id: 1, type: "campaignSchedule", campaignId: 31, campaignName: "Campaign", programId: null, runAt: "2027-01-01T00:00:00.000Z" },
        { id: 2, type: "campaignTrigger", campaignId: 31, campaignName: "Campaign", programId: null, personIds: [7] },
      ],
      [
        { id: 1, type: "campaignTrigger", campaignId: 31, campaignName: "First", programId: null, personIds: [7] },
        { id: 2, type: "campaignTrigger", campaignId: 32, campaignName: "Second", programId: null, personIds: [7] },
      ],
      [
        { id: 1, type: "campaignSchedule", campaignId: 31, campaignName: "First", programId: null, runAt: "2027-01-01T00:00:00.000Z" },
        { id: 2, type: "campaignSchedule", campaignId: 32, campaignName: "Second", programId: null, runAt: "2027-01-02T00:00:00.000Z" },
      ],
      [
        { id: 1, type: "businessObjectDelete", kind: "company", records: [{ externalCompanyId: "acme" }], matchBy: "dedupeFields", changedFields: ["externalCompanyId"] },
        { id: 2, type: "businessObjectUpsert", kind: "company", records: [{ externalCompanyId: "acme", name: "Acme" }], matchBy: "dedupeFields", action: "createOrUpdate", changedFields: ["name"] },
      ],
      [
        { id: 1, type: "programStatus", programId: 31, programName: "Program", personIds: [7], status: "Member" },
        { id: 2, type: "programLifecycle", targetId: "31", programName: "Program", operation: "delete" },
      ],
      [
        { id: 1, type: "updatePerson", personId: 7, fields: { subscribed: true } },
        { id: 2, type: "campaignTrigger", campaignId: 41, campaignName: "Campaign", programId: null, personIds: [7] },
      ],
      [
        { id: 1, type: "listAdd", listId: 5, listName: "Customers", personIds: [7] },
        { id: 2, type: "campaignSchedule", campaignId: 41, campaignName: "Campaign", programId: null, runAt: "2027-01-01T00:00:00.000Z" },
      ],
      [
        { id: 1, type: "programStatus", programId: 31, programName: "Program", personIds: [7], status: "Member" },
        { id: 2, type: "campaignTrigger", campaignId: 41, campaignName: "Campaign", programId: null, personIds: [7] },
      ],
      [
        { id: 1, type: "programLifecycle", targetId: "31", programName: "Program", operation: "delete" },
        { id: 2, type: "campaignLifecycle", targetId: "41", campaignName: "Campaign", programId: "31", operation: "deactivate" },
      ],
      [
        { id: 1, type: "programLifecycle", targetId: "31", programName: "Program", operation: "delete" },
        { id: 2, type: "campaignTrigger", campaignId: 41, campaignName: "Campaign", programId: "31", personIds: [7] },
      ],
      [
        { id: 1, type: "programLifecycle", targetId: "31", programName: "Program", operation: "delete" },
        { id: 2, type: "campaignSchedule", campaignId: 41, campaignName: "Campaign", programId: "31", runAt: "2027-01-01T00:00:00.000Z" },
      ],
      [
        { id: 1, type: "customObjectUpsert", apiName: "orders", records: [{ orderId: "one" }] },
        { id: 2, type: "customObjectDelete", apiName: "orders", records: [{ orderId: "two" }], deleteBy: "dedupeFields" },
      ],
      [
        { id: 1, type: "upsertPeople", records: [{ email: "person@example.com" }], upsertAction: "createOrUpdate", lookupField: "email" },
        { id: 2, type: "upsertPeople", records: [{ email: "person@example.com" }], upsertAction: "updateOnly", lookupField: "email" },
      ],
      [
        { id: 1, type: "upsertPeople", records: [{ id: 7, email: "person@example.com" }], upsertAction: "updateOnly", lookupField: "email" },
        { id: 2, type: "deletePerson", personId: 7 },
      ],
      [
        { id: 1, type: "upsertPeople", records: [{ email: "person@example.com" }], upsertAction: "createOrUpdate", lookupField: "email" },
        { id: 2, type: "deletePerson", personId: 7 },
      ],
      [
        { id: 1, type: "updatePerson", personId: 7, fields: { email: "person@example.com" } },
        { id: 2, type: "upsertPeople", records: [{ email: "person@example.com" }], upsertAction: "updateOnly", lookupField: "email" },
      ],
    ];
    for (let actions of cases) {
      let calls = 0;
      vi.stubGlobal("fetch", async () => { calls++; throw new Error("No provider call expected"); });
      let stub = await campaignActionGatekeeper(actions);
      await runInDurableObject(stub, async instance => {
        await expect(instance.applyAction(2)).rejects.toThrow(/earlier pending mutation/);
      });
      expect(calls).toBe(0);
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it("serializes distinct recipient mutations through campaign effects", async () => {
    let actions: MarketoAction[] = [
      { id: 1, type: "deletePerson", personId: 7 },
      { id: 2, type: "deletePerson", personId: 8 },
    ];
    let deleted = 0;
    vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : Response.json({ success: true, result: [{ id: 7 + deleted++, status: "deleted" }] }));
    let stub = await campaignActionGatekeeper(actions);
    await runInDurableObject(stub, async instance => {
      await expect(instance.applyAction(2)).rejects.toThrow(/campaignRecipientEffects.*earlier pending mutation/);
      await instance.applyAction(1);
      await expect(instance.applyAction(2)).resolves.toBeUndefined();
    });
  });

  it("allows a campaign action after its earlier program deletion is rejected", async () => {
    let actions: MarketoAction[] = [
      { id: 1, type: "programLifecycle", targetId: "31", programName: "Program", operation: "delete" },
      { id: 2, type: "campaignTrigger", campaignId: 41, campaignName: "Campaign", programId: "31", personIds: [7] },
    ];
    let campaignWrites = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      let path = new URL(url).pathname;
      if (path.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (path === "/rest/asset/v1/smartCampaign/41.json") {
        return Response.json({ success: true, result: [{ id: 41, folder: { id: 31, type: "Program" } }] });
      }
      campaignWrites++;
      return Response.json({ success: true, result: [{ id: 41 }] });
    });
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async instance => {
      await expect(instance.applyAction(2)).rejects.toThrow(/program 31 has an earlier pending mutation/);
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      await expect(instance.applyAction(2)).resolves.toBeUndefined();
    });
    expect(campaignWrites).toBe(1);
  });

  it("rejects changed campaign Program ownership before dispatch", async () => {
    let action: MarketoAction = {
      id: 1, type: "campaignTrigger", campaignId: 41, campaignName: "Campaign",
      programId: "31", personIds: [7],
    };
    let campaignWrites = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      let path = new URL(url).pathname;
      if (path.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (path === "/rest/asset/v1/smartCampaign/41.json") {
        return Response.json({ success: true, result: [{ id: 41, folder: { id: 32, type: "Program" } }] });
      }
      campaignWrites++;
      return Response.json({ success: true, result: [{ id: 41 }] });
    });
    let stub = await campaignActionGatekeeper([action]);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/owning Program changed.*nothing was dispatched/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
    });
    expect(campaignWrites).toBe(0);
  });

  it("fails closed when persisted actions lack mandatory review state", async () => {
    let actions = [
      { id: 1, type: "designLifecycle", asset: "email", targetId: "21", operation: "approve" },
      {
        id: 2, type: "designerLifecycle", asset: "designerEmail", targetId: "email-1",
        operation: "approve", contentId: "draft-1", sourceState: "draft",
      },
      { id: 3, type: "campaignTrigger", campaignId: 31, campaignName: "Campaign", personIds: [7] },
      { id: 4, type: "campaignLifecycle", targetId: "31", campaignName: "Campaign", operation: "delete" },
    ] as unknown as MarketoAction[];
    let providerCalls = 0;
    vi.stubGlobal("fetch", async () => {
      providerCalls++;
      throw new Error("No provider call expected");
    });
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      for (let action of actions) {
        await expect(instance.applyAction(action.id)).rejects.toThrow(/missing.*review/i);
        expect(state.storage.kv.get(`applying:${action.id}`)).toBeUndefined();
        expect(state.storage.kv.get(`pending:${action.id}`)).toBeDefined();
      }
    });
    expect(providerCalls).toBe(0);
  });

  it("does not expose a rejected simulated program rename in later status approval text", async () => {
    let actions: MarketoAction[] = [
      {
        id: 1,
        type: "programUpdate",
        targetId: "31",
        programName: "Original",
        patch: { name: "Rejected simulated name" },
      },
      {
        id: 2,
        type: "programStatus",
        programId: 31,
        programName: "Rejected simulated name",
        personIds: [7],
        status: "Member",
      },
    ];
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      let row = state.storage.kv.get<{ action: MarketoAction }>("pending:2");
      expect(row).toBeDefined();
      expect(describeAction(row!.action)).toEqual(expect.objectContaining({
        title: 'Set 1 to "Member" in program 31',
        description: expect.not.stringContaining("Rejected simulated name"),
      }));
    });
  });

  it("orders business-object records across id and dedupe strategies without aliasing incomplete identities", async () => {
    let overlapping: BusinessObjectAction[] = [
      { id: 1, type: "businessObjectDelete", kind: "company", records: [{ id: 7, externalCompanyId: "acme" }], matchBy: "idField", changedFields: ["id"] },
      { id: 2, type: "businessObjectUpsert", kind: "company", records: [{ id: 7, externalCompanyId: "acme" }], matchBy: "dedupeFields", action: "createOrUpdate", changedFields: ["externalCompanyId"] },
    ];
    let stub = await campaignActionGatekeeper(overlapping);
    await runInDurableObject(stub, async instance => {
      await expect(instance.applyAction(2)).rejects.toThrow(/earlier pending mutation/);
    });

    let distinct: BusinessObjectAction[] = [
      { id: 1, type: "businessObjectDelete", kind: "opportunity", records: [{ marketoGUID: "g-1" }], matchBy: "idField", changedFields: ["marketoGUID"] },
      { id: 2, type: "businessObjectDelete", kind: "opportunity", records: [{ marketoGUID: "g-2" }], matchBy: "idField", changedFields: ["marketoGUID"] },
    ];
    vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : url.includes("/describe.json")
        ? Response.json({ success: true, result: [{ name: "Opportunity", fields: [] }] })
        : Response.json({ success: true, result: [{ seq: 0, marketoGUID: "g-2", status: "deleted" }] }));
    stub = await campaignActionGatekeeper(distinct);
    await runInDurableObject(stub, async instance => {
      await expect(instance.applyAction(2)).resolves.toBeUndefined();
    });
  });

  it("orders Email Designer template dependencies and classic destination dependencies", async () => {
    let actions: MarketoAction[] = [
      { id: 1, type: "designerUpdate", asset: "designerTemplate", targetId: "template-1", patch: { description: "new" } },
      { id: 2, type: "designerCreate", asset: "designerEmail", provisionalId: "~1", body: { name: "Email", templateId: "template-1" } },
      { id: 3, type: "designMetadata", asset: "folder", targetId: "10", patch: { name: "Renamed" } },
      { id: 4, type: "designCreate", asset: "snippet", provisionalId: "~2", parent: { id: "10", type: "Folder" }, input: { name: "Snippet" } },
      { id: 5, type: "designerClone", asset: "designerEmail", provisionalId: "~3", sourceId: "email-1", name: "Copy", sourceSnapshot: designerCloneSnapshot({ templateId: "template-1" }) },
    ];
    let stub = await campaignActionGatekeeper(actions);
    await runInDurableObject(stub, async instance => {
      await expect(instance.applyAction(2)).rejects.toThrow(/designerTemplate template-1.*earlier pending/);
      await expect(instance.applyAction(4)).rejects.toThrow(/folder 10.*earlier pending/);
      await expect(instance.applyAction(5)).rejects.toThrow(/designerTemplate template-1.*earlier pending/);
    });
  });

  it("orders Designer lifecycle propagation after pending dependent email mutations", async () => {
    let lifecycle = (id: number, dependent: { id: string; name: string; contentType?: string }): EmailDesignerAction => ({
      id,
      type: "designerLifecycle",
      asset: "designerFragment",
      targetId: `fragment-${id}`,
      operation: "approve",
      contentId: `draft-${id}`,
      sourceState: "draft",
      sourceSnapshot: EMPTY_DESIGNER_LIFECYCLE_SNAPSHOT,
      affectedDependents: [dependent],
    });
    let cases: MarketoAction[][] = [
      [
        { id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "email-7", patch: { name: "Pending" } },
        lifecycle(2, { id: "email-7", name: "Known email", contentType: "email" }),
      ],
      [
        { id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "email-8", patch: { name: "Pending" } },
        lifecycle(2, { id: "email-8", name: "Untyped dependent" }),
      ],
    ];

    for (let actions of cases) {
      let stub = await emailDesignerActionGatekeeper(actions);
      await runInDurableObject(stub, async instance => {
        await expect(instance.applyAction(2)).rejects.toThrow(/designerEmail.*earlier pending mutation/);
      });
    }
  });

  it("orders classic lifecycle propagation after pending dependent mutations", async () => {
    let actions: MarketoAction[] = [
      { id: 1, type: "designMetadata", asset: "email", targetId: "91", patch: { name: "Pending email" } },
      {
        id: 2, type: "designLifecycle", asset: "emailTemplate", targetId: "31", operation: "approve",
        snapshot: { metadata: { name: "Template" }, content: "draft", affectedDependents: [
          { id: 91, name: "Dependent email", type: "Email" },
        ] },
      },
      { id: 3, type: "designMetadata", asset: "landingPage", targetId: "92", patch: { name: "Pending page" } },
      {
        id: 4, type: "designLifecycle", asset: "form", targetId: "32", operation: "approve",
        snapshot: { metadata: { name: "Form" }, content: [], affectedDependents: [
          { id: 92, name: "Dependent page", type: "Landing Page" },
        ] },
      },
    ];
    let stub = await campaignActionGatekeeper(actions);
    await runInDurableObject(stub, async instance => {
      await expect(instance.applyAction(2)).rejects.toThrow(/email 91.*earlier pending mutation/);
      await expect(instance.applyAction(4)).rejects.toThrow(/landingPage 92.*earlier pending mutation/);
    });
  });

  it("keeps rejected content dependents rejectable without allowing stale dispatch", async () => {
    let actions: DesignStudioAction[] = [
      { id: 1, type: "designContent", asset: "emailTemplate", targetId: "31", content: "new" },
      { id: 2, type: "designClone", asset: "emailTemplate", provisionalId: "~1", sourceId: "31", parent: { id: "10", type: "Folder" }, name: "Copy" },
    ];
    let stub = await designActionGatekeeper(actions);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get("pending:2")).toBeDefined();
      expect(state.storage.kv.get("dependencyBlocked:2")).toBe(1);
      await expect(instance.applyAction(2)).rejects.toThrow(/depends on an earlier rejected action/);
      await expect(instance.rejectAction(2)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get("pending:2")).toBeUndefined();
    });
  });

  it("rejects an expired campaign schedule before any provider request", async () => {
    let action: MarketoAction = {
      id: 1, type: "campaignSchedule", campaignId: 31, campaignName: "Campaign",
      programId: null,
      runAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
    };
    let calls = 0;
    vi.stubGlobal("fetch", async () => { calls++; throw new Error("No provider call expected"); });
    let stub = await actionGatekeeper(action);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/no longer between 5 minutes and 2 years/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
    });
    expect(calls).toBe(0);
  });

  it("revalidates a campaign schedule after credential preparation", async () => {
    let now = Date.now();
    let clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let action: MarketoAction = {
      id: 1, type: "campaignSchedule", campaignId: 31, campaignName: "Campaign",
      programId: null,
      runAt: new Date(now + 6 * 60 * 1000).toISOString(),
    };
    let campaignCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        now += 2 * 60 * 1000;
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      campaignCalls++;
      return Response.json({ success: true, result: [{ id: 31, name: "Campaign" }] });
    });
    let stub = await actionGatekeeper(action);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/no longer between 5 minutes and 2 years/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
    });
    expect(campaignCalls).toBe(1);
    clock.mockRestore();
  });

  it("validates designer update location and template references before dispatch", async () => {
    for (let [patch, actualKind] of [
      [{ appData: { folderId: "~9" } }, "program"],
      [{ appData: { programId: "~9" } }, "folder"],
      [{ templateId: "~9" }, "designerFragment"],
    ] as const) {
      let action = {
        id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "email-1", patch,
      } as unknown as EmailDesignerAction;
      let calls = 0;
      vi.stubGlobal("fetch", async () => { calls++; throw new Error("No provider call expected"); });
      let stub = await campaignActionGatekeeper([action]);
      await runInDurableObject(stub, async (instance, state) => {
        state.storage.kv.put("provisionalKind:~9", actualKind);
        await expect(instance.applyAction(1)).rejects.toThrow(/is not a/);
        expect(state.storage.kv.get("applying:1")).toBeUndefined();
      });
      expect(calls).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it("remotely preflights physical designer and classic references while the action is retryable", async () => {
    for (let [patch, expectedPath] of [
      [{ templateId: "missing-template" }, "/rest/asset/v2/emailtemplate/missing-template"],
      [{ appData: { folderId: "10" } }, "/rest/asset/v1/folder/10.json"],
      [{ appData: { programId: "11" } }, "/rest/asset/v1/program/11.json"],
    ] as const) {
      let action = {
        id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "email-1", patch,
      } as unknown as EmailDesignerAction;
      let paths: string[] = [];
      let writes = 0;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
        paths.push(new URL(url).pathname);
        if (init?.body) writes++;
        return Response.json({ success: true, result: [] });
      });
      let stub = await campaignActionGatekeeper([action]);
      await runInDurableObject(stub, async (instance, state) => {
        await expect(instance.applyAction(1)).rejects.toThrow(/not found/);
        expect(state.storage.kv.get("applying:1")).toBeUndefined();
        expect(state.storage.kv.get("pending:1")).toBeDefined();
        await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      });
      expect(paths).toEqual([expectedPath]);
      expect(writes).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it("exact-reads classic campaign and program clone sources before dispatch", async () => {
    let cases: [MarketoAction, string][] = [
      [{ id: 1, type: "campaignClone", provisionalId: "~1", sourceId: "31",
        parent: { id: "10", type: "Folder" }, name: "Clone" }, "/rest/asset/v1/smartCampaign/31.json"],
      [{ id: 1, type: "programClone", provisionalId: "~1", sourceId: "31",
        parentId: "10", name: "Clone" }, "/rest/asset/v1/program/31.json"],
    ];
    for (let [action, expectedPath] of cases) {
      let paths: string[] = [];
      let writes = 0;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
        paths.push(new URL(url).pathname);
        if (init?.body) writes++;
        return Response.json({ success: true, result: [] });
      });
      let stub = await campaignActionGatekeeper([action]);
      await runInDurableObject(stub, async (instance, state) => {
        await expect(instance.applyAction(1)).rejects.toThrow(/not found.*nothing was dispatched/);
        expect(state.storage.kv.get("applying:1")).toBeUndefined();
        expect(state.storage.kv.get("pending:1")).toBeDefined();
      });
      expect(paths).toEqual([expectedPath]);
      expect(writes).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it("rejects restricted classic asset destinations that are programs during dispatch preflight", async () => {
    let actions: DesignStudioAction[] = [
      { id: 1, type: "designCreate", asset: "emailTemplate", provisionalId: "~1",
        parent: { id: "10", type: "Folder" }, input: { name: "Template", content: "x" } },
      { id: 2, type: "designClone", asset: "emailTemplate", provisionalId: "~2", sourceId: "20",
        parent: { id: "10", type: "Folder" }, name: "Clone" },
      { id: 3, type: "designCreate", asset: "file", provisionalId: "~3",
        parent: { id: "10", type: "Folder" }, input: { name: "x", mimeType: "text/plain", data: new Uint8Array([1]) } },
    ];
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (init?.body) writes++;
      return Response.json({ success: true, result: [{
        id: 10, name: "Program", folderId: { id: 10, type: "Program" }, workspace: "Default",
      }] });
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      for (let id of [1, 2, 3]) {
        await expect(instance.applyAction(id)).rejects.toThrow(/ordinary folder.*nothing was dispatched/);
        expect(state.storage.kv.get(`applying:${id}`)).toBeUndefined();
      }
    });
    expect(writes).toBe(0);
  });

  it("revalidates program clone workspace equality during dispatch preflight", async () => {
    let action: ProgramAction = {
      id: 1, type: "programClone", provisionalId: "~1", sourceId: "31",
      parentId: "10", name: "Clone",
    };
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (init?.body) writes++;
      let path = new URL(url).pathname;
      return Response.json({ success: true, result: [path.includes("/program/")
        ? { id: 31, name: "Source", workspace: "Source" }
        : { id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Other" }] });
    });
    let stub = await campaignActionGatekeeper([action]);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/destination workspace does not match.*nothing was dispatched/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
      expect(state.storage.kv.get("pending:1")).toBeDefined();
    });
    expect(writes).toBe(0);
  });

  it("uses and revalidates the approved Email Designer content id", async () => {
    let action: EmailDesignerAction = {
      id: 1, type: "designerLifecycle", asset: "designerEmail", targetId: "email-1",
      operation: "approve", contentId: "draft-7", sourceState: "draft",
      sourceSnapshot: designerCloneSnapshot({
        id: "email-1", associatedStates: [{ contentId: "draft-7", state: "draft" }],
      }),
      affectedDependents: [],
    };
    let transitionBody: unknown;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (url.endsWith("/usedby")) return Response.json({
        success: true, result: [], pageDetails: { currentPage: 1, pageSize: 50, totalItems: 0 },
      });
      if (!init?.body) return Response.json({ success: true, result: [{
        id: "email-1", associatedStates: [{ contentId: "draft-7", state: "draft" }],
      }] });
      transitionBody = JSON.parse(String(init.body));
      return Response.json({ success: true, result: [{ id: "email-1", contentId: "draft-7", status: "approved" }] });
    });
    let stub = await emailDesignerActionGatekeeper([action]);
    await runInDurableObject(stub, instance => instance.applyAction(1));
    expect(transitionBody).toEqual({ contentId: "draft-7", action: "approve" });
  });

  it("treats a changed Email Designer content id as definitively undispatched", async () => {
    let action: EmailDesignerAction = {
      id: 1, type: "designerLifecycle", asset: "designerEmail", targetId: "email-1",
      operation: "approve", contentId: "draft-old", sourceState: "draft",
      sourceSnapshot: EMPTY_DESIGNER_LIFECYCLE_SNAPSHOT,
      affectedDependents: [],
    };
    let transitions = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (init?.body) transitions++;
      return Response.json({ success: true, result: [{
        id: "email-1", associatedStates: [{ contentId: "draft-new", state: "draft" }],
      }] });
    });
    let stub = await emailDesignerActionGatekeeper([action]);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/content changed.*nothing was dispatched/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
    });
    expect(transitions).toBe(0);
  });

  it("keeps a known-target mutation with the wrong returned id uncertain", async () => {
    vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : Response.json({ success: true, result: [{ id: 8, status: "added" }] }));
    let stub = await actionGatekeeper(ACTION);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow(/does not identify the approved target/);
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBe("uncertain");
    });
  });

  const SEQUENCED_ACTIONS: MarketoAction[] = [
    {
      id: 1, type: "customObjectUpsert", apiName: "order",
      records: [{ marketoGUID: "g-0" }, { marketoGUID: "g-1" }],
    },
    {
      id: 1, type: "customObjectDelete", apiName: "order",
      records: [{ marketoGUID: "g-0" }, { marketoGUID: "g-1" }], deleteBy: "idField",
    },
    {
      id: 1, type: "businessObjectUpsert", kind: "opportunity",
      records: [{ marketoGUID: "g-0" }, { marketoGUID: "g-1" }],
      matchBy: "idField", action: "updateOnly", changedFields: [],
    },
    {
      id: 1, type: "businessObjectDelete", kind: "opportunity",
      records: [{ marketoGUID: "g-0" }, { marketoGUID: "g-1" }],
      matchBy: "idField", changedFields: ["marketoGUID"],
    },
  ];

  it.each(SEQUENCED_ACTIONS)("correlates reordered $type identities and statuses through seq", action => {
    let success = action.type.endsWith("Upsert") ? "updated" : "deleted";
    let results = [
      { seq: 1, status: "skipped", reasons: [{ code: "1004" }] },
      { seq: 0, marketoGUID: "g-0", status: success },
    ];

    expect(() => {
      assertActionResults(action, results);
      assertActionResultIdentity(action, results);
    }).not.toThrow();
  });

  it.each(SEQUENCED_ACTIONS)("rejects incomplete or invalid $type seq sets", action => {
    let status = action.type.endsWith("Upsert") ? "updated" : "deleted";
    let row = (seq?: unknown) => ({ ...(seq === undefined ? {} : { seq }), status });
    let invalidResults: unknown[][] = [
      [row(0)],
      [row(0), row()],
      [row(0), row(0)],
      [row(-1), row(1)],
      [row(0), row(2)],
      [row(0), row(1.5)],
      [row(0), row("1")],
    ];

    for (let results of invalidResults) {
      expect(() => assertActionResults(action, results)).toThrow(/outcome is uncertain/);
    }
  });

  it("does not require or interpret seq for mutation endpoints that do not document it", () => {
    let action: MarketoAction = { ...ACTION, personIds: [7, 8] };
    let results = [
      { seq: "not-used", id: 7, status: "added" },
      { seq: 99, id: 8, status: "added" },
    ];

    expect(() => {
      assertActionResults(action, results);
      assertActionResultIdentity(action, results);
    }).not.toThrow();
  });

  it("validates endpoint-specific target identities and statuses", () => {
    let cases: [MarketoAction, { seq?: number; id?: number; marketoGUID?: string; status: string }[]][] = [
      [{ id: 1, type: "deletePerson", personId: 7 }, [{ id: 8, status: "deleted" }]],
      [{ id: 1, type: "programStatus", programId: 3, programName: "P", personIds: [7], status: "Member" }, [{ id: 7, status: "added" }]],
      [{ id: 1, type: "businessObjectDelete", kind: "opportunity", records: [{ marketoGUID: "g-1" }], matchBy: "idField", changedFields: ["marketoGUID"] }, [{ seq: 0, marketoGUID: "g-2", status: "deleted" }]],
      [{ id: 1, type: "customObjectDelete", apiName: "order", records: [{ marketoGUID: "g-1" }], deleteBy: "idField" }, [{ seq: 0, marketoGUID: "g-2", status: "deleted" }]],
      [{ id: 1, type: "campaignTrigger", campaignId: 3, campaignName: "C", programId: null, personIds: [7] }, [{ status: "scheduled" }]],
    ];
    for (let [action, results] of cases) {
      expect(() => assertActionResultIdentity(action, results)).toThrow(/does not identify the approved target/);
    }
  });

  it("accepts only the Marketo result statuses permitted by each approved upsert action", () => {
    let cases: { action: MarketoAction; allowed: string[] }[] = [
      ...(["createOnly", "updateOnly", "createOrUpdate"] as const).flatMap(upsertAction => [
        {
          action: {
            id: 1, type: "upsertPeople" as const, records: [{ email: "person@example.com" }],
            upsertAction, lookupField: "email",
          },
          allowed: upsertAction === "createOnly" ? ["created", "skipped"]
            : upsertAction === "updateOnly" ? ["updated", "skipped"]
              : ["created", "updated", "skipped"],
        },
        {
          action: {
            id: 1, type: "businessObjectUpsert" as const, kind: "company" as const,
            records: [{ externalCompanyId: "acme" }], matchBy: "dedupeFields" as const,
            action: upsertAction, changedFields: [],
          },
          allowed: upsertAction === "createOnly" ? ["created", "skipped"]
            : upsertAction === "updateOnly" ? ["updated", "skipped"]
              : ["created", "updated", "skipped"],
        },
      ]),
      {
        action: { id: 1, type: "customObjectUpsert", apiName: "order", records: [{ orderId: "one" }] },
        allowed: ["created", "updated", "skipped"],
      },
    ];

    for (let { action, allowed } of cases) {
      for (let status of ["created", "updated", "skipped"]) {
        let assertion = () => assertActionResultIdentity(action, [{ seq: 0, status }]);
        if (allowed.includes(status)) expect(assertion).not.toThrow();
        else expect(assertion).toThrow(/does not identify the approved target/);
      }
    }
  });

  it("keeps upsert identity checks when the result status is permitted", () => {
    let cases: [MarketoAction, { seq?: number; id?: number; marketoGUID?: string; status: string }[]][] = [
      [{
        id: 1, type: "upsertPeople", records: [{ id: 7 }], upsertAction: "updateOnly", lookupField: "id",
      }, [{ id: 8, status: "updated" }]],
      [{
        id: 1, type: "businessObjectUpsert", kind: "opportunity", records: [{ marketoGUID: "g-1" }],
        matchBy: "idField", action: "updateOnly", changedFields: [],
      }, [{ seq: 0, marketoGUID: "g-2", status: "updated" }]],
      [{
        id: 1, type: "customObjectUpsert", apiName: "order", records: [{ marketoGUID: "g-1" }],
      }, [{ seq: 0, marketoGUID: "g-2", status: "updated" }]],
    ];

    for (let [action, results] of cases) {
      expect(() => assertActionResultIdentity(action, results))
        .toThrow(/does not identify the approved target/);
    }
  });

  it("accepts exact statusless campaign results without weakening other result families", () => {
    let trigger: Extract<MarketoAction, { type: "campaignTrigger" }> = {
      id: 1, type: "campaignTrigger", campaignId: 3, campaignName: "C", programId: null, personIds: [7],
    };
    let schedule: Extract<MarketoAction, { type: "campaignSchedule" }> = {
      id: 2, type: "campaignSchedule", campaignId: 4, campaignName: "D", programId: null, runAt: "2027-01-01T00:00:00.000Z",
    };

    expect(() => assertCampaignRequestResults(trigger, [{ id: 3 }])).not.toThrow();
    expect(() => assertCampaignRequestResults(schedule, [{ id: 4 }])).not.toThrow();
    expect(() => assertApplied([{ id: 3 }])).toThrow(/without a status|expected result/);
  });

  it("applies a statusless campaign response through the dispatch lifecycle", async () => {
    let action: MarketoAction = {
      id: 1, type: "campaignTrigger", campaignId: 3, campaignName: "C", programId: null, personIds: [7],
    };
    vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : Response.json({ success: true, result: [{ id: 3 }] }));
    let stub = await actionGatekeeper(action);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(action.id)).resolves.toBeUndefined();
      expect(state.storage.kv.get(`applying:${action.id}`)).toBe("applied");
    });
  });

  it("fails closed on malformed, mismatched, and declined campaign results", () => {
    let action: Extract<MarketoAction, { type: "campaignTrigger" }> = {
      id: 1, type: "campaignTrigger", campaignId: 3, campaignName: "C", programId: null, personIds: [7],
    };

    expect(() => assertCampaignRequestResults(action, [{ id: 4 }])).toThrow(/approved target/);
    expect(() => assertCampaignRequestResults(action, [{ id: 3, reasons: [{ code: "1004" }] }]))
      .toThrow(/outcome is uncertain/);
    expect(() => assertCampaignRequestResults(action, [{ status: "skipped", reasons: [{ code: "1004" }] }]))
      .toThrow(/declined all 1 record/);
  });

  it("correlates program membership results with the approved progression status", () => {
    let action: MarketoAction = {
      id: 1, type: "programStatus", programId: 3, programName: "P", personIds: [7], status: "Member",
    };

    expect(() => assertActionResultIdentity(action, [{ id: 7, status: "Member" }])).not.toThrow();
    expect(() => assertActionResultIdentity(action, [{ id: 7, status: "updated" }])).not.toThrow();
    expect(() => assertActionResultIdentity(action, [{ status: "skipped" }])).not.toThrow();
    expect(() => assertActionResultIdentity(action, [{ id: 7, status: "added" }]))
      .toThrow(/approved target/);
  });

  it("applies the approved program progression status through the dispatch lifecycle", async () => {
    let action: MarketoAction = {
      id: 1, type: "programStatus", programId: 3, programName: "P", personIds: [7], status: "Member",
    };
    vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : Response.json({ success: true, result: [{ id: 7, status: "updated" }] }));
    let stub = await actionGatekeeper(action);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(action.id)).resolves.toBeUndefined();
      expect(state.storage.kv.get(`applying:${action.id}`)).toBe("applied");
    });
  });

  it("requires statuses and normalizes their case for identity and skipped-result handling", () => {
    expect(() => assertActionResultIdentity(ACTION, [{ id: 7 }])).toThrow(/without a status/);
    expect(() => assertActionResultIdentity(ACTION, [{ id: 7, status: "Added" }])).not.toThrow();
    expect(() => assertActionResultIdentity(ACTION, [{ status: "Skipped" }])).not.toThrow();
    expect(() => assertApplied([{ status: "Skipped", reasons: [{ code: "1004" }] }]))
      .toThrow(/declined all 1 record/);
  });

  it("retains an unverified creation candidate only in the audit after uncertain discard", async () => {
    let action: CampaignAction = {
      id: 1, type: "campaignCreate", provisionalId: "~1",
      parent: { id: "10", type: "Folder" }, name: "Approved name",
    };
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      return Response.json({ success: true, result: [{
        id: 31,
        ...(path.endsWith("/smartCampaign/31.json") ? { name: "Different name" } : {}),
      }] });
    });
    let stub = await campaignActionGatekeeper([action]);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/could not verify created smart campaign/);
      expect(state.storage.kv.get("provisional:~1")).toBeUndefined();
      expect(state.storage.kv.get("applying:1")).toBe("uncertain");
      expect(state.storage.kv.get("creationCandidate:1")).toBe(31);
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      expect(state.storage.kv.get("creationCandidate:1")).toBeUndefined();
      expect(state.storage.kv.get("provisional:~1")).toBeUndefined();
      expect(state.storage.kv.get("applying:1")).toBe("uncertain-discarded");
      expect(state.storage.kv.get("audit:1")).toMatchObject({
        outcome: "uncertain-discarded",
        action,
        creationCandidate: { providerId: 31, authority: "unverified" },
      });
    });
  });

  it("allows only one concurrent dispatch", async () => {
    let release: (() => void) | undefined;
    let dispatched = new Promise<void>(resolve => {
      release = resolve;
    });
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      calls++;
      await dispatched;
      return Response.json({ success: true, result: [{ id: 7, status: "added" }] });
    });
    let stub = await actionGatekeeper(ACTION);

    await runInDurableObject(stub, async instance => {
      let first = instance.applyAction(ACTION.id);
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow(/already (being prepared|dispatched)/);
      await expect(instance.rejectAction(ACTION.id)).rejects.toThrow(/preflight|dispatched/);
      release?.();
      await first;
      await expect(instance.rejectAction(ACTION.id)).rejects.toThrow(/already dispatched/);
      await instance.applyAction(ACTION.id);
    });
    expect(calls).toBe(1);
  });

  it("does not dispatch when the account is revoked during token preparation", async () => {
    let identityStarted!: () => void;
    let started = new Promise<void>(resolve => { identityStarted = resolve; });
    let releaseIdentity!: () => void;
    let released = new Promise<void>(resolve => { releaseIdentity = resolve; });
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        identityStarted();
        await released;
        return Response.json({ access_token: "prepared-token", expires_in: 3600 });
      }
      writes++;
      return Response.json({ success: true, result: [{ id: 7, status: "added" }] });
    });
    let stub = await actionGatekeeper(ACTION);

    await runInDurableObject(stub, async (instance, state) => {
      let applying = instance.applyAction(ACTION.id);
      await started;
      let ctx = (instance as unknown as {
        ctx: { exports: Cloudflare.Exports; props: { userObjectId: string } };
      }).ctx;
      await ctx.exports.UserAccount.get(
        ctx.exports.UserAccount.idFromString(ctx.props.userObjectId),
      ).revoke();
      releaseIdentity();

      await expect(applying).rejects.toThrow(/account changed/);
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBeUndefined();
      expect(state.storage.kv.get(`pending:${ACTION.id}`)).toBeDefined();
    });
    expect(writes).toBe(0);
  });

  it("serializes revoke before the authoritative dispatch check and network use", async () => {
    let dispatchEntered!: () => void;
    let entered = new Promise<void>(resolve => { dispatchEntered = resolve; });
    let releaseDispatch!: () => void;
    let released = new Promise<void>(resolve => { releaseDispatch = resolve; });
    let originalDispatch = UserAccount.prototype.dispatch;
    let dispatchSpy = vi.spyOn(UserAccount.prototype, "dispatch").mockImplementation(async function(
      this: UserAccount,
      ...args: Parameters<UserAccount["dispatch"]>
    ) {
      dispatchEntered();
      await released;
      return await originalDispatch.apply(this, args);
    });
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "prepared-token", expires_in: 3600 });
      }
      writes++;
      return Response.json({ success: true, result: [{ id: 7, status: "added" }] });
    });
    let stub = await actionGatekeeper(ACTION);

    await runInDurableObject(stub, async (instance, state) => {
      let applying = instance.applyAction(ACTION.id);
      await entered;
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBe("dispatching");
      let ctx = (instance as unknown as {
        ctx: { exports: Cloudflare.Exports; props: { userObjectId: string } };
      }).ctx;
      await ctx.exports.UserAccount.get(
        ctx.exports.UserAccount.idFromString(ctx.props.userObjectId),
      ).revoke();
      releaseDispatch();

      await expect(applying).rejects.toThrow(/account changed/);
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBeUndefined();
      expect(state.storage.kv.get(`pending:${ACTION.id}`)).toBeDefined();
    });
    expect(writes).toBe(0);
    dispatchSpy.mockRestore();
  });

  it("allows preflight and uncertain discard but rejects known terminal dispatch states", async () => {
    let preparing = await actionGatekeeper(ACTION);
    await runInDurableObject(preparing, async (instance, state) => {
      state.storage.kv.put(`applying:${ACTION.id}`, "preparing");
      await expect(instance.rejectAction(ACTION.id)).resolves.toBeUndefined();
      expect(state.storage.kv.get(`pending:${ACTION.id}`)).toBeUndefined();
    });

    for (let applying of ["partial", "applied"] as const) {
      let stub = await actionGatekeeper(ACTION);
      await runInDurableObject(stub, async (instance, state) => {
        state.storage.kv.put(`applying:${ACTION.id}`, applying);
        await expect(instance.rejectAction(ACTION.id)).rejects.toThrow(/already dispatched/);
        expect(state.storage.kv.get(`pending:${ACTION.id}`)).toBeDefined();
      });
    }
  });

  it("retries persisted preflight after worker restart", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      calls++;
      return Response.json({ success: true, result: [{ id: 7, status: "added" }] });
    });
    let stub = await actionGatekeeper(ACTION);
    await runInDurableObject(stub, async (instance, state) => {
      let row = state.storage.kv.get<Record<string, unknown>>(`pending:${ACTION.id}`)!;
      state.storage.kv.put(`pending:${ACTION.id}`, { ...row, state: "preflight" });
      state.storage.kv.put(`applying:${ACTION.id}`, "preparing");
      await expect(instance.applyAction(ACTION.id)).resolves.toBeUndefined();
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBe("applied");
    });
    expect(calls).toBe(1);
  });

  it("converts persisted dispatch to uncertain and allows audited discard", async () => {
    let stub = await actionGatekeeper(ACTION);
    await runInDurableObject(stub, async (instance, state) => {
      let row = state.storage.kv.get<Record<string, unknown>>(`pending:${ACTION.id}`)!;
      state.storage.kv.put(`pending:${ACTION.id}`, { ...row, state: "dispatching" });
      state.storage.kv.put(`applying:${ACTION.id}`, "dispatching");

      await expect(instance.applyAction(ACTION.id)).rejects.toThrow(/already dispatched/);
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBe("uncertain");
      await expect(instance.rejectAction(ACTION.id)).resolves.toBeUndefined();
      expect(state.storage.kv.get(`pending:${ACTION.id}`)).toBeUndefined();
      expect(state.storage.kv.get<number[]>("pending:index") ?? []).toEqual([]);
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBe("uncertain-discarded");
      expect(state.storage.kv.get(`audit:${ACTION.id}`)).toMatchObject({
        outcome: "uncertain-discarded",
        action: ACTION,
      });
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow(/discarded/);
    });
  });

  it("deletes stale creation candidates when an action is definitively rejected", async () => {
    let stub = await actionGatekeeper(ACTION);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.kv.put(`creationCandidate:${ACTION.id}`, 99);
      await instance.rejectAction(ACTION.id);
      expect(state.storage.kv.get(`creationCandidate:${ACTION.id}`)).toBeUndefined();
    });
  });

  it("allows retry after a definitive Marketo rejection", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      calls++;
      return Response.json({
        success: false,
        errors: [{ code: "1004", message: "Lead not found" }],
      });
    });
    let stub = await actionGatekeeper(ACTION);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow("Marketo request failed (code 1004; HTTP 200).");
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBeUndefined();
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow("Marketo request failed (code 1004; HTTP 200).");
    });
    expect(calls).toBe(2);
  });

  it("allows retry after an explicit rejection with an unsafe code", async () => {
    let calls = 0;
    let marker = "customersecretmarker";
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      calls++;
      return Response.json({ success: false, errors: [{ code: marker, message: marker }] });
    });
    let stub = await actionGatekeeper(ACTION);

    await runInDurableObject(stub, async (instance, state) => {
      let error = await instance.applyAction(ACTION.id).catch(value => value);
      expect(`${error.message}\n${error.stack}`).not.toContain(marker);
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBeUndefined();
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow("Marketo request failed (HTTP 200).");
    });
    expect(calls).toBe(2);
  });

  it("blocks retry after an ambiguous transport failure", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      calls++;
      throw new Error("connection lost");
    });
    let stub = await actionGatekeeper(ACTION);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow("Could not reach the Marketo API.");
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBe("uncertain");
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow(/already dispatched/);
      await expect(instance.rejectAction(ACTION.id)).resolves.toBeUndefined();
      expect(state.storage.kv.get(`pending:${ACTION.id}`)).toBeUndefined();
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBe("uncertain-discarded");
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow(/discarded/);
    });
    expect(calls).toBe(1);
  });

  it.each([408, 500])("treats HTTP %i responses as ambiguous even with a numeric code", async status => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      return Response.json(
        { success: false, errors: [{ code: "1003", message: "Request timeout" }] },
        { status },
      );
    });
    let stub = await actionGatekeeper(ACTION);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow(`Marketo request failed (code 1003; HTTP ${status}).`);
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBe("uncertain");
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow(/already dispatched/);
    });
  });

  it("reports partial application and removes the unsafe full-batch retry", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      return Response.json({
        success: true,
        result: [
          { id: 7, status: "added" },
          { id: 8, status: "skipped", reasons: [{ message: "Lead not found" }] },
        ],
      });
    });
    let action: MarketoAction = { ...ACTION, personIds: [7, 8] };
    let stub = await actionGatekeeper(action);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(action.id)).rejects.toThrow(/applied 1 of 2/);
      expect(state.storage.kv.get(`pending:${action.id}`)).toBeUndefined();
      await expect(instance.applyAction(action.id)).rejects.toThrow(/already dispatched/);
      await expect(instance.rejectAction(action.id)).rejects.toThrow(/already dispatched/);
      expect(state.storage.kv.get(`applying:${action.id}`)).toBe("partial");
    });
  });

  it("bounds native CRM restrictions and recovers through a safe dispatch probe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = new Date("2026-08-31T12:00:00Z");
    vi.setSystemTime(now);
    let mutationCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (url.includes("/describe.json")) {
        return Response.json({ success: true, result: [{ name: "Company", fields: [] }] });
      }
      mutationCalls++;
      return mutationCalls === 1
        ? Response.json({ success: false, errors: [{ code: "1018", message: "CRM Enabled" }] })
        : Response.json({ success: true, result: [{ seq: 0, id: 7, status: "updated" }] });
    });
    let action: BusinessObjectAction = {
      id: 18,
      type: "businessObjectUpsert",
      kind: "company",
      records: [{ externalCompanyId: "company-1" }],
      action: "createOrUpdate",
      matchBy: "dedupeFields",
      changedFields: [],
    };
    let stub = await actionGatekeeper(action);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(action.id)).rejects.toThrow(/nothing was changed.*cannot be retried/);
      expect(state.storage.kv.get(`pending:${action.id}`)).toBeUndefined();
      expect(state.storage.kv.get(`applying:${action.id}`)).toBe("nothing-changed");
      expect(state.storage.kv.get("businessObjects:nativeCrmReadOnly")).toEqual({
        version: 1,
        expiresAt: now.getTime() + BUSINESS_OBJECT_RESTRICTION_TTL_MS,
      });
      await expect(instance.applyAction(action.id)).rejects.toThrow(/nothing was changed/);
      await expect(instance.rejectAction(action.id)).resolves.toBeUndefined();
      expect(state.storage.kv.get(`applying:${action.id}`)).toBe("nothing-changed");

      let approvals = 0;
      let queue = new RpcStub(new TestApprovalQueue(async () => void approvals++)) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoSessionImpl;
      await expect(session.getBusinessObject("opportunity").upsert([
        { externalOpportunityId: "o-1", name: "Opportunity" },
      ])).rejects.toThrow(/read-only/);
      expect(approvals).toBe(0);
      await session.getBusinessObject("namedAccount").upsert([{ name: "Allowed" }]);
      expect(approvals).toBe(1);

      vi.advanceTimersByTime(BUSINESS_OBJECT_RESTRICTION_TTL_MS + 1);
      await session.getBusinessObject("company").upsert([{ externalCompanyId: "company-2" }]);
      expect(approvals).toBe(2);
      await expect(instance.applyAction(2)).resolves.toBeUndefined();
      expect(state.storage.kv.get("businessObjects:nativeCrmReadOnly")).toBeUndefined();
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
    expect(mutationCalls).toBe(2);
  });

  it("does not use an expired read-only restriction as permission to dispatch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = new Date("2026-08-31T13:00:00Z");
    vi.setSystemTime(now);
    let mutationCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (url.includes("/describe.json")) {
        return Response.json({
          success: true,
          result: [{ name: "Company", crmManaged: true, fields: [] }],
        });
      }
      mutationCalls++;
      return Response.json({ success: true, result: [{ seq: 0, id: 7, status: "updated" }] });
    });
    let action: BusinessObjectAction = {
      id: 22, type: "businessObjectUpsert", kind: "company",
      records: [{ externalCompanyId: "company-1" }], action: "createOrUpdate",
      matchBy: "dedupeFields", changedFields: [],
    };
    let stub = await actionGatekeeper(action);

    await runInDurableObject(stub, async (instance, state) => {
      state.storage.kv.put("businessObjects:nativeCrmReadOnly", {
        version: 1,
        expiresAt: now.getTime() + BUSINESS_OBJECT_RESTRICTION_TTL_MS,
      });
      vi.advanceTimersByTime(BUSINESS_OBJECT_RESTRICTION_TTL_MS + 1);
      await expect(instance.applyAction(action.id)).rejects.toThrow(/nothing was dispatched/);
      expect(state.storage.kv.get(`pending:${action.id}`)).toBeUndefined();
      expect(state.storage.kv.get(`applying:${action.id}`)).toBe("nothing-changed");
      expect(state.storage.kv.get("businessObjects:nativeCrmReadOnly")).toMatchObject({
        version: 1,
        expiresAt: Date.now() + BUSINESS_OBJECT_RESTRICTION_TTL_MS,
      });
    });
    expect(mutationCalls).toBe(0);
  });

  it("does not immediately retry unavailable access and recovers after expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-31T14:00:00Z"));
    let describeCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (!url.includes("/opportunities/roles/describe.json")) {
        throw new Error(`Unexpected Marketo request: ${url}`);
      }
      describeCalls++;
      return describeCalls === 1
        ? Response.json({ success: false, errors: [{ code: "603", message: "Access denied" }] })
        : Response.json({
            success: true,
            result: [{ name: "Opportunity Role", fields: [] }],
          });
    });
    let stub = await actionGatekeeper(ACTION);

    await runInDurableObject(stub, async (instance, state) => {
      let queue = new RpcStub(new TestApprovalQueue(async () => {})) as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue) as MarketoSessionImpl;
      let roles = session.getBusinessObject("opportunityRole");
      expect((await roles.describe()).access).toBe("unavailable");
      expect((await roles.describe()).access).toBe("unavailable");
      expect(describeCalls).toBe(1);

      vi.advanceTimersByTime(BUSINESS_OBJECT_RESTRICTION_TTL_MS + 1);
      expect((await roles.describe()).access).toBe("read-write");
      expect(describeCalls).toBe(2);
      expect(state.storage.kv.get("businessObjects:opportunityRoleUnavailable")).toBeUndefined();
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("also makes case-varied success-envelope per-record 1018 skips terminal", async () => {
    vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : url.includes("/describe.json")
        ? Response.json({ success: true, result: [{ name: "Company", fields: [] }] })
        : Response.json({
          success: true,
          result: [{ seq: 0, status: "Skipped", reasons: [{ code: "1018", message: "CRM Enabled" }] }],
        }));
    let action: BusinessObjectAction = {
      id: 20, type: "businessObjectDelete", kind: "company",
      records: [{ id: 7 }], matchBy: "idField", changedFields: ["id"],
    };
    let stub = await actionGatekeeper(action);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(action.id)).rejects.toThrow(/nothing was changed.*cannot be retried/);
      expect(state.storage.kv.get(`pending:${action.id}`)).toBeUndefined();
      expect(state.storage.kv.get(`applying:${action.id}`)).toBe("nothing-changed");
      expect(state.storage.kv.get("businessObjects:nativeCrmReadOnly")).toMatchObject({ version: 1 });
      await expect(instance.applyAction(action.id)).rejects.toThrow(/nothing was changed/);
    });
  });

  it.each([
    [[null]],
    [[7]],
    [[{ status: "skipped", reasons: [null] }]],
    [[{ status: "skipped", reasons: [{ code: 1018 }] }]],
  ])("keeps malformed business-object results uncertain", async result => {
    vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : url.includes("/describe.json")
        ? Response.json({ success: true, result: [{ name: "Company", fields: [] }] })
        : Response.json({ success: true, result }));
    let action: BusinessObjectAction = {
      id: 21, type: "businessObjectDelete", kind: "company",
      records: [{ id: 7 }], matchBy: "idField", changedFields: ["id"],
    };
    let stub = await actionGatekeeper(action);

    await runInDurableObject(stub, async (instance, state) => {
      let error = await instance.applyAction(action.id).catch(value => value);
      expect(error.name).toBe("MarketoActionResultError");
      expect(error.disposition).toBe("uncertain");
      expect(state.storage.kv.get(`applying:${action.id}`)).toBe("uncertain");
      expect(state.storage.kv.get("businessObjects:nativeCrmReadOnly")).toBeUndefined();
    });
  });

  it("does not treat Named Account 1018 as native CRM evidence", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      if (url.includes("/describe.json")) {
        return Response.json({ success: true, result: [{ name: "Named Account", fields: [] }] });
      }
      return Response.json({ success: false, errors: [{ code: "1018", message: "Rejected" }] });
    });
    let action: BusinessObjectAction = {
      id: 19,
      type: "businessObjectDelete",
      kind: "namedAccount",
      records: [{ name: "Account" }],
      matchBy: "dedupeFields",
      changedFields: ["name"],
    };
    let stub = await actionGatekeeper(action);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(action.id)).rejects.toThrow("Marketo request failed (code 1018; HTTP 200).");
      expect(state.storage.kv.get("businessObjects:nativeCrmReadOnly")).toBeUndefined();
      expect(state.storage.kv.get(`applying:${action.id}`)).toBeUndefined();
      expect(state.storage.kv.get(`pending:${action.id}`)).toBeDefined();
    });
  });

});

// Marketo nests membership inside the person and repeats the program id.
describe("program membership normalization", () => {
  const RAW = {
    id: 4242,
    email: "someone@example.com",
    membership: {
      id: 9900,
      progressionStatus: "Member",
      progressionStatusType: "Member",
      isExhausted: false,
      acquiredBy: false,
      reachedSuccess: false,
      membershipDate: "2026-04-30T21:59:16Z",
      updatedAt: "2026-04-30T21:59:16Z",
    },
  };

  async function members() {
    let program = new MarketoProgramImpl(
      stubContext({
        getProgramMembers: async () => ({ result: [RAW], moreResult: false }) as never,
      }),
      9900,
    );
    return (await program.getMembers()).members;
  }

  it("accepts Adobe's documented membership shape at the client boundary", async () => {
    let response = clientReturning({
      success: true,
      result: [RAW],
      moreResult: true,
      nextPageToken: "next-members",
    });

    await expect(response.client.getProgramMembers(9900, ["id", "email"])).resolves.toMatchObject({
      result: [RAW],
      moreResult: true,
      nextPageToken: "next-members",
    });
    let url = new URL(response.calls[0]!);
    expect(url.pathname).toBe("/rest/v1/leads/programs/9900.json");
    expect(url.searchParams.get("fields")).toBe("id,email");
  });

  it("rejects membership rows not owned by the requested program before observation", async () => {
    for (let membership of [
      undefined,
      { id: 9901 },
      { id: 9900, progressionStatus: { malformed: true } },
      { id: 9900, reachedSuccess: "yes" },
    ]) {
      let client = clientReturning({
        success: true,
        result: [{ id: 4242, membership }],
        moreResult: false,
      }).client;
      let notes: string[] = [];
      let program = new MarketoProgramImpl(stubContext(client, notes), 9900);

      let error = await program.getMembers().catch(error => error);
      expect(error).toBeInstanceOf(MarketoError);
      expect(error.message).toMatch(/membership for the wrong program 9900/);
      expect(error.operation).toBe("/v1/leads/programs/9900.json");
      expect(notes).toEqual([]);
    }
  });

  it("exposes one documented membership object, not Marketo's raw one", async () => {
    let [member] = await members();
    expect(member.membership).toEqual({
      status: "Member",
      statusType: "Member",
      isExhausted: false,
      acquiredBy: false,
      reachedSuccess: false,
      membershipDate: new Date("2026-04-30T21:59:16Z"),
      updatedAt: new Date("2026-04-30T21:59:16Z"),
    });
  });

  it("drops the repeated program id that made the raw shape confusing", async () => {
    let [member] = await members();
    expect(member.membership).not.toHaveProperty("id");
    expect(member.membership).not.toHaveProperty("progressionStatus");
    expect(member.id).toBe(4242);
    expect(member.email).toBe("someone@example.com");
  });
});

describe("campaign request bodies", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function bodyOf(call: (c: MarketoClient) => Promise<unknown>) {
    let seen: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen = init;
      return Response.json({ success: true, result: [] });
    });
    await call(new MarketoClient(ORIGIN, { getToken: async () => "t" }));
    return JSON.parse(String(seen?.body)) as { input: Record<string, unknown> };
  }

  it("nests leads under input, as Marketo requires", async () => {
    let body = await bodyOf(c => c.triggerCampaign(7700, [7, 8]));
    expect(body.input).toEqual({ leads: [{ id: 7 }, { id: 8 }] });
  });

  it("sends runAt as an ISO string Marketo will parse", async () => {
    let runAt = new Date("2026-05-01T10:00:00.000Z");
    let body = await bodyOf(c => c.scheduleCampaign(7700, runAt));
    expect(body.input.runAt).toBe("2026-05-01T10:00:00.000Z");
    expect(body.input).not.toHaveProperty("leads");
  });

  it("qualifies token names on both campaign endpoints", async () => {
    let tokens = [{ name: "Year", value: "2099" }, { name: "{{my.Other}}", value: "x" }];
    let expected = [{ name: "{{my.Year}}", value: "2099" }, { name: "{{my.Other}}", value: "x" }];

    let triggered = await bodyOf(c => c.triggerCampaign(7700, [7], tokens));
    expect(triggered.input.tokens).toEqual(expected);

    let scheduled = await bodyOf(c => c.scheduleCampaign(7700, new Date(), tokens));
    expect(scheduled.input.tokens).toEqual(expected);
  });

  it("omits tokens entirely when there are none, rather than sending an empty array", async () => {
    let body = await bodyOf(c => c.triggerCampaign(7700, [7]));
    expect(body.input).not.toHaveProperty("tokens");
  });
});

describe("smart campaign Asset API encoding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses documented forms and lifecycle paths", async () => {
    let calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({ success: true, result: [{ id: 77 }] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });

    await client.createSmartCampaign({
      name: "Campaign",
      description: "Description",
      folder: { id: 10, type: "Folder" },
    });
    await client.cloneSmartCampaign(7, {
      name: "Clone",
      folder: { id: 20, type: "Program" },
    });
    await client.updateSmartCampaign(77, { name: "Renamed" });
    await client.activateSmartCampaign(77);
    await client.deactivateSmartCampaign(77);
    await client.deleteSmartCampaign(77);
    await client.getCampaignSmartList(77, 77);

    expect(new URL(calls[0]!.url).pathname).toBe("/rest/asset/v1/smartCampaigns.json");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({
      name: "Campaign",
      description: "Description",
      folder: JSON.stringify({ id: 10, type: "Folder" }),
    });
    expect(new URL(calls[1]!.url).pathname).toBe("/rest/asset/v1/smartCampaign/7/clone.json");
    expect(Object.fromEntries(new URLSearchParams(String(calls[1]!.init.body)))).toEqual({
      name: "Clone",
      folder: JSON.stringify({ id: 20, type: "Program" }),
    });
    expect(new URL(calls[2]!.url).pathname).toBe("/rest/asset/v1/smartCampaign/77.json");
    expect(calls.slice(3, 6).map(call => new URL(call.url).pathname)).toEqual([
      "/rest/asset/v1/smartCampaign/77/activate.json",
      "/rest/asset/v1/smartCampaign/77/deactivate.json",
      "/rest/asset/v1/smartCampaign/77/delete.json",
    ]);
    let rules = new URL(calls[6]!.url);
    expect(rules.pathname).toBe("/rest/asset/v1/smartCampaign/77/smartList.json");
    expect(rules.searchParams.get("includeRules")).toBe("true");
  });

  it("rejects wrong identities from both exact campaign APIs", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ success: true, result: [{ id: 78 }] }));
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    await expect(client.getCampaign(77)).rejects.toThrow(/wrong campaign.*77/i);
    await expect(client.getSmartCampaign(77)).rejects.toThrow(/wrong smart campaign.*77/i);
    await expect(client.getCampaignSmartList(77, 77)).rejects.toThrow(/wrong smart list.*77/i);
  });

  it("rejects non-positive expected and returned smart-list ids", async () => {
    let fetches = 0;
    let returnedId = 0;
    vi.stubGlobal("fetch", async () => {
      fetches++;
      return Response.json({ success: true, result: [{ id: returnedId }] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    await expect(client.getCampaignSmartList(77, 0)).rejects.toThrow(/invalid smart-list identity/);
    await expect(client.getCampaignSmartList(77, -1)).rejects.toThrow(/invalid smart-list identity/);
    expect(fetches).toBe(0);
    await expect(client.getCampaignSmartList(77, 8)).rejects.toThrow(/wrong smart list/);
    returnedId = -1;
    await expect(client.getCampaignSmartList(77, 8)).rejects.toThrow(/wrong smart list/);
  });

  it("fails closed on session campaign and smart-list identity mismatches", async () => {
    let notes: string[] = [];
    let wrongCampaign = campaignContext({
      getSmartCampaign: async () => ({ id: 78, name: "Wrong" }),
    });
    wrongCampaign.ctx.observe = async title => { notes.push(title); };
    await expect(new MarketoSessionImpl(wrongCampaign.ctx).getSmartCampaign(77).describe())
      .rejects.toThrow(/wrong smart campaign/i);

    let wrongList = campaignContext({
      getSmartCampaign: async () => ({ id: 77, name: "Campaign", smartListId: 8 }),
      getCampaignSmartList: async () => ({ id: 9, rules: { triggers: [], filters: [] } }),
    });
    wrongList.ctx.observe = async title => { notes.push(title); };
    await expect(new MarketoSessionImpl(wrongList.ctx).getSmartCampaign(77).readSmartListRules())
      .rejects.toThrow(/wrong smart list/i);

    let requestCampaign = campaignContext({
      getSmartCampaign: async () => ({ id: 77, name: "Campaign", type: "trigger" }),
      getCampaign: async () => ({ id: 78, name: "Wrong", type: "trigger", isTriggerable: true }),
    });
    requestCampaign.ctx.observe = async title => { notes.push(title); };
    await expect(new MarketoSessionImpl(requestCampaign.ctx).getSmartCampaign(77).requestCampaign([1]))
      .rejects.toThrow(/wrong campaign/i);

    for (let smartListId of [0, -1]) {
      let nonPositive = campaignContext({
        getSmartCampaign: async () => ({ id: 77, name: "Campaign", smartListId }),
      });
      nonPositive.ctx.observe = async title => { notes.push(title); };
      await expect(new MarketoSessionImpl(nonPositive.ctx).getSmartCampaign(77).readSmartListRules())
        .rejects.toThrow(/invalid smart-list identity/);
    }
    expect(notes).toEqual([]);
  });
});

describe("program Asset API encoding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fully pages channels and tag types and retrieves every tag's allowed values", async () => {
    let tagTypes = Array.from({ length: ASSET_PAGE_MAX + 1 }, (_, index) => ({
      tagType: `Tag ${index}`,
      applicableProgramTypes: "[program]",
      required: false,
    }));
    let calls: URL[] = [];
    vi.stubGlobal("fetch", async (requestUrl: string) => {
      let url = new URL(requestUrl);
      calls.push(url);
      let offset = Number(url.searchParams.get("offset") ?? 0);
      if (url.pathname.endsWith("/tagTypes.json")) {
        return Response.json({ success: true, result: tagTypes.slice(offset, offset + ASSET_PAGE_MAX) });
      }
      if (url.pathname.endsWith("/tagType/byName.json")) {
        let tagType = url.searchParams.get("name")!;
        return Response.json({ success: true, result: [{
          tagType, applicableProgramTypes: "[program]", required: false,
          allowableValues: `[Value for ${tagType}]`,
        }] });
      }
      if (url.pathname.endsWith("/channels.json")) {
        let channels = Array.from({ length: ASSET_PAGE_MAX + 1 }, (_, index) => ({ name: `Channel ${index}` }));
        return Response.json({ success: true, result: channels.slice(offset, offset + ASSET_PAGE_MAX) });
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });

    let tags = await client.getTagTypes();
    expect(tags).toHaveLength(ASSET_PAGE_MAX + 1);
    expect(tags.at(-1)?.allowableValues).toBe(`[Value for Tag ${ASSET_PAGE_MAX}]`);
    expect(await client.getChannels()).toHaveLength(ASSET_PAGE_MAX + 1);
    expect(calls.filter(url => url.pathname.endsWith("/tagTypes.json"))
      .map(url => url.searchParams.get("offset"))).toEqual(["0", String(ASSET_PAGE_MAX)]);
    expect(calls.filter(url => url.pathname.endsWith("/tagType/byName.json"))).toHaveLength(tagTypes.length);
    expect(calls.filter(url => url.pathname.endsWith("/channels.json"))
      .map(url => url.searchParams.get("offset"))).toEqual(["0", String(ASSET_PAGE_MAX)]);
  });

  it("rejects a repeated full metadata page", async () => {
    let page = Array.from({ length: ASSET_PAGE_MAX }, (_, index) => ({ name: `Channel ${index}` }));
    vi.stubGlobal("fetch", async () => Response.json({ success: true, result: page }));
    await expect(new MarketoClient(ORIGIN, { getToken: async () => "t" }).getChannels())
      .rejects.toThrow(/repeated an asset metadata page/);
  });

  it("uses official form fields, JSON tag encoding, and lifecycle paths", async () => {
    let calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      let path = new URL(url).pathname;
      if (path.endsWith("/tagTypes.json")) return Response.json({ success: true, result: [{
        tagType: "Region", applicableProgramTypes: "[email_batch]", required: true,
      }] });
      if (path.endsWith("/tagType/byName.json")) return Response.json({ success: true, result: [{
        tagType: "Region", applicableProgramTypes: "[email_batch]", required: true,
        allowableValues: "[EMEA]",
      }] });
      return Response.json({ success: true, result: [{ id: 77 }] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    let tags = [{ tagType: "Region", tagValue: "EMEA" }];

    await client.getTagTypes();
    await client.createProgram({
      name: "Program", folder: { id: 10, type: "Folder" }, type: "Email",
      channel: "Email Send", description: "Description", tags,
      startDate: "2026-09-01T10:00:00.000Z", endDate: "2026-09-01T11:00:00.000Z",
    });
    await client.cloneProgram(7, { name: "Clone", folder: { id: 10, type: "Folder" } });
    await client.updateProgram(77, { tags, startDate: "2026-09-02T10:00:00.000Z", endDate: "2026-09-02T11:00:00.000Z" });
    await client.approveProgram(77);
    await client.unapproveProgram(77);
    await client.deleteProgram(77);

    expect(new URL(calls[0]!.url).pathname).toBe("/rest/asset/v1/tagTypes.json");
    expect(new URL(calls[0]!.url).searchParams.get("maxReturn")).toBe(String(ASSET_PAGE_MAX));
    expect(new URL(calls[1]!.url).pathname).toBe("/rest/asset/v1/tagType/byName.json");
    let create = Object.fromEntries(new URLSearchParams(String(calls[2]!.init.body)));
    expect(create).toMatchObject({
      name: "Program",
      folder: JSON.stringify({ id: 10, type: "Folder" }),
      type: "Email",
      channel: "Email Send",
      tags: JSON.stringify(tags),
      startDate: "2026-09-01T10:00:00.000Z",
      endDate: "2026-09-01T11:00:00.000Z",
    });
    expect(new URL(calls[3]!.url).pathname).toBe("/rest/asset/v1/program/7/clone.json");
    expect(new URL(calls[4]!.url).pathname).toBe("/rest/asset/v1/program/77.json");
    expect(calls.slice(5).map(call => new URL(call.url).pathname)).toEqual([
      "/rest/asset/v1/program/77/approve.json",
      "/rest/asset/v1/program/77/unapprove.json",
      "/rest/asset/v1/program/77/delete.json",
    ]);
  });
});

describe("Design Studio REST encoding", () => {
  afterEach(() => vi.unstubAllGlobals());

  function recordingClient() {
    let calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({ success: true, result: [{ id: 99 }] });
    });
    return { client: new MarketoClient(ORIGIN, { getToken: async () => "t" }), calls };
  }

  function form(call: { init: RequestInit }): URLSearchParams {
    expect(call.init.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    return new URLSearchParams(String(call.init.body));
  }

  it("uses the .json email-template content path", async () => {
    let { client, calls } = recordingClient();
    await client.getEmailTemplateContent(31, "approved");
    expect(new URL(calls[0]!.url).pathname)
      .toBe("/rest/asset/v1/emailTemplate/31/content.json");
  });

  it("encodes folder browsing in the query and folder creation as a form", async () => {
    let { client, calls } = recordingClient();
    await client.getFolders({
      root: { id: 10, type: "Program" },
      maxDepth: 2,
      workspace: "Default",
      offset: 20,
      maxReturn: 50,
    });
    await client.createFolder({
      name: "Child",
      parent: { id: 11, type: "Folder" },
      description: "A folder",
    });

    let browse = new URL(calls[0]!.url);
    expect(browse.pathname).toBe("/rest/asset/v1/folders.json");
    expect(Object.fromEntries(browse.searchParams)).toEqual({
      root: JSON.stringify({ id: 10, type: "Program" }),
      maxDepth: "2",
      maxReturn: "50",
      offset: "20",
      workSpace: "Default",
    });
    expect(calls[1]!.init.method).toBe("POST");
    expect(Object.fromEntries(form(calls[1]!))).toEqual({
      name: "Child",
      parent: JSON.stringify({ id: 11, type: "Folder" }),
      description: "A folder",
    });
  });

  it("uses the documented email paths and form field names", async () => {
    let { client, calls } = recordingClient();
    await client.createEmail({
      name: "Welcome",
      folder: { id: 10, type: "Folder" },
      template: 22,
      subject: "Hello",
      fromName: "Team",
      fromEmail: "team@example.com",
      replyEmail: "reply@example.com",
    });
    await client.updateEmail(31, { preHeader: "Preview text" });
    await client.updateEmailContentSection(31, "hero/main", {
      type: "Text",
      value: "<p>New</p>",
      textValue: "New",
    });

    expect(new URL(calls[0]!.url).pathname).toBe("/rest/asset/v1/emails.json");
    let create = Object.fromEntries(form(calls[0]!));
    expect(create).toMatchObject({
      folder: JSON.stringify({ id: 10, type: "Folder" }),
      template: "22",
      subject: "Hello",
      replyEmail: "reply@example.com",
    });
    expect(create).not.toHaveProperty("preHeader");
    expect(new URL(calls[1]!.url).pathname).toBe("/rest/asset/v1/email/31.json");
    expect(Object.fromEntries(form(calls[1]!))).toEqual({ preHeader: "Preview text" });
    expect(new URL(calls[2]!.url).pathname)
      .toBe("/rest/asset/v1/email/31/content/hero%2Fmain.json");
    expect(Object.fromEntries(form(calls[2]!))).toEqual({
      type: "Text",
      value: "<p>New</p>",
      textValue: "New",
    });
  });

  it("uploads template HTML as multipart and keeps metadata alongside it", async () => {
    let { client, calls } = recordingClient();
    await client.createEmailTemplate({
      name: "Template",
      folder: { id: 10, type: "Folder" },
      description: "Description",
      content: "<html>template</html>",
    });

    expect(new URL(calls[0]!.url).pathname).toBe("/rest/asset/v1/emailTemplates.json");
    expect(calls[0]!.init.method).toBe("POST");
    let body = calls[0]!.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("name")).toBe("Template");
    expect(body.get("folder")).toBe(JSON.stringify({ id: 10, type: "Folder" }));
    expect(body.get("description")).toBe("Description");
    let content = body.get("content");
    expect(content).toBeInstanceOf(Blob);
    expect(await (content as Blob).text()).toBe("<html>template</html>");
  });

  it("uses form bodies for form and snippet mutations", async () => {
    let { client, calls } = recordingClient();
    await client.createForm({
      name: "Signup",
      folder: { id: 10, type: "Program" },
      language: "English",
      locale: "en_US",
    });
    await client.updateSnippetContent(44, "HTML", "<p>updated</p>");

    expect(new URL(calls[0]!.url).pathname).toBe("/rest/asset/v1/forms.json");
    expect(Object.fromEntries(form(calls[0]!))).toMatchObject({
      name: "Signup",
      folder: JSON.stringify({ id: 10, type: "Program" }),
      language: "English",
      locale: "en_US",
    });
    expect(new URL(calls[1]!.url).pathname).toBe("/rest/asset/v1/snippet/44/content.json");
    expect(Object.fromEntries(form(calls[1]!))).toEqual({
      type: "HTML",
      content: "<p>updated</p>",
    });
  });

  it("uploads files and replacements as multipart with their bytes and MIME type", async () => {
    let { client, calls } = recordingClient();
    await client.createFile({
      name: "logo.svg",
      folder: { id: 10, type: "Folder" },
      description: "Logo",
      file: new Blob(["first"], { type: "image/svg+xml" }),
      insertOnly: true,
    });
    await client.updateFileContent(
      55,
      new Blob(["second"], { type: "text/plain" }),
      "replacement.txt",
    );

    expect(new URL(calls[0]!.url).pathname).toBe("/rest/asset/v1/files.json");
    let create = calls[0]!.init.body as FormData;
    expect(create.get("name")).toBe("logo.svg");
    expect(create.get("folder")).toBe(JSON.stringify({ id: 10, type: "Folder" }));
    expect(create.get("insertOnly")).toBe("true");
    expect(await (create.get("file") as Blob).text()).toBe("first");
    expect((create.get("file") as Blob).type).toBe("image/svg+xml");

    expect(new URL(calls[1]!.url).pathname).toBe("/rest/asset/v1/file/55/content.json");
    let replacement = (calls[1]!.init.body as FormData).get("file") as Blob;
    expect(await replacement.text()).toBe("second");
    expect(replacement.type).toBe("text/plain");
    expect((replacement as File).name).toBe("replacement.txt");
  });
});

describe("Email Designer REST encoding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses bearer auth, x-app-type, required workspace filters, and JSON writes", async () => {
    let calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      let pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/filter")) {
        return Response.json({ success: true, result: { items: [], totalItems: 0, currentPage: 0, pageSize: 25 } });
      }
      return Response.json({ success: true, result: [{ id: "opaque-99" }] });
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "secret-token" });

    await client.filterDesignerAssets("email", {
      workspaceId: "workspace-A", folderId: "folder-B", status: ["draft", "approved"], pageSize: 25,
    });
    await client.createDesignerAsset("email", {
      name: "Welcome", appData: { workspaceId: "workspace-A", folderId: "folder-B" },
      headers: { subject: "Hello" }, data: { html: { body: "<p>Hello</p>" } },
    });

    let listUrl = new URL(calls[0]!.url);
    expect(listUrl.pathname).toBe("/rest/asset/v2/email/filter");
    expect(listUrl.searchParams.get("workspaceId")).toBe("workspace-A");
    expect(listUrl.searchParams.getAll("status")).toEqual(["draft", "approved"]);
    expect(listUrl.searchParams.has("access_token")).toBe(false);
    for (let call of calls) {
      expect(call.init.headers).toMatchObject({ Authorization: "Bearer secret-token", "x-app-type": "marketo" });
      expect(new URL(call.url).searchParams.has("access_token")).toBe(false);
    }
    expect(calls[1]!.init).toMatchObject({ method: "POST" });
    expect(calls[1]!.init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      name: "Welcome", appData: { workspaceId: "workspace-A", folderId: "folder-B" },
      headers: { subject: "Hello" }, data: { html: { body: "<p>Hello</p>" } },
    });
  });

  it("calls workspace discovery without a /rest prefix and normalizes numeric ids", async () => {
    let requested: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      requested = { url: String(url), init };
      return Response.json([{ id: 1001, name: "Default", status: "active" }]);
    });
    let client = new MarketoClient(ORIGIN, { getToken: async () => "t" });
    let notes: string[] = [];
    let { ctx } = emailDesignerContext(client);
    ctx.observe = async (title, description) => { notes.push(title, description); };

    expect(await new MarketoEmailDesignerImpl(ctx).listWorkspaces()).toEqual([
      { id: "1001", name: "Default", description: undefined, status: "active" },
    ]);
    expect(new URL(requested!.url).pathname).toBe("/userservice/management/v1/users/workspaces.json");
    expect(requested!.init.headers).toMatchObject({ Authorization: "Bearer t" });
    expect(new URL(requested!.url).searchParams.has("access_token")).toBe(false);
    expect(notes.join(" ")).toMatch(/User Management/);
  });

  it("allows only the exact same-origin workspace path outside /rest", async () => {
    let credentials = {
      endpoint: ORIGIN,
      clientId: crypto.randomUUID(),
      clientSecret: crypto.randomUUID(),
    };
    let namespace = (env as unknown as { UserAccount: DurableObjectNamespace<UserAccount> }).UserAccount;
    let id = await accountWithCredentials(credentials);
    let tokenNamespace = (env as unknown as {
      MarketoTokenCache: DurableObjectNamespace<MarketoTokenCache>;
    }).MarketoTokenCache;
    let tokenId = tokenNamespace.idFromName(await testCredentialFingerprint(credentials));
    await runInDurableObject(tokenNamespace.get(tokenId), (_instance, state) => {
      state.storage.kv.put("token", {
        accessToken: "token",
        expiresAt: Date.now() + 3_600_000,
      });
    });
    let calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(new URL(url).pathname);
      return Response.json([]);
    });

    await runInDurableObject(namespace.get(id), async instance => {
      let expected = { credentials, generation: 0 };
      let request = { redirect: "error" as const };
      await expect(instance.dispatch(
        expected,
        undefined,
        `${ORIGIN}/userservice/management/v1/users/workspaces.json/extra`,
        request,
        false,
        60_000,
      )).rejects.toThrow(/outside the connected Marketo REST API/);
      await expect(instance.dispatch(
        expected,
        undefined,
        `https://other.example/userservice/management/v1/users/workspaces.json`,
        request,
        false,
        60_000,
      )).rejects.toThrow(/outside the connected Marketo REST API/);
      let result = await instance.dispatch(
        expected,
        undefined,
        `${ORIGIN}/userservice/management/v1/users/workspaces.json`,
        request,
        false,
        60_000,
      );
      expect(result.ok).toBe(true);
    });
    expect(calls).toEqual(["/userservice/management/v1/users/workspaces.json"]);
  });
});
