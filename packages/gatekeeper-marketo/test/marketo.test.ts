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
  describeAction,
  executeAction,
  type MarketoAction,
  type MarketoActionInput,
} from "../src/actions";
import type { DesignStudioAction, DesignStudioActionInput } from "../src/design-studio-actions";
import {
  emailDesignerActionReferences,
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
  type CampaignAction,
  type CampaignActionInput,
} from "../src/campaign-actions";
import {
  executeProgramAction,
  type ProgramAction,
  type ProgramActionInput,
} from "../src/program-actions";
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
  MAX_FILTER_VALUES,
  parseMarketoDate,
  qualifyTokenName,
  type MarketoCredentials,
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
import { MarketoGatekeeperImpl, MarketoUserImpl, UserAccount } from "../src/marketo";
import { MarketoBusinessObjectImpl, type BusinessObjectContext } from "../src/business-objects";
import type { BusinessObjectAction } from "../src/business-object-actions";

const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://123-abc-456.mktorest.com";

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
});

describe("account description", () => {
  it("logs a sanitized classification when scope lookup fails", async () => {
    let credentials = { endpoint: ORIGIN, clientId: "client", clientSecret: "secret-marker" };
    let account = {
      getCredentials: async () => credentials,
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
        MarketoTokenCache: {
          idFromName: () => "cache-id",
          get: () => ({ getScope: async () => { throw scopeError; } }),
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
      { id: 3, type: "campaignTrigger", campaignId: 9, campaignName: "C", personIds: [1] },
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
      { id: 4, type: "campaignTrigger", campaignId: 1, campaignName: "C", personIds: [1] },
    ];
    for (let action of actions) expect(describeAction(action).implementsRevert).toBe(false);
  });

  it("warns that running a campaign sends real messages", () => {
    let description = describeAction({
      id: 1,
      type: "campaignTrigger",
      campaignId: 7,
      campaignName: "Welcome Blast",
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
  return {
    client: async () => client as MarketoClient,
    observe: async (summary: string, detail: string) => { notes?.push(summary, detail); },
    submit: async () => {},
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
      templateId: "template-A",
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
        templateId: "template-A",
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
        pageDetails: { totalItems: 1, currentPage: 0, pageSize: 20 },
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

  it("preserves server pagination and forwards filters while pending changes stay handle-scoped", async () => {
    let requests: { kind: string; options: Record<string, unknown> }[] = [];
    let { ctx } = emailDesignerContext({
      filterDesignerAssets: async (kind, options) => {
        requests.push({ kind, options });
        let page = options.pageIndex ?? 0;
        return {
          items: [{ id: `${kind}-${page}-1`, name: "First" }, { id: `${kind}-${page}-2`, name: "Second" }],
          totalItems: 4,
          currentPage: page,
          pageSize: options.pageSize,
        };
      },
      getDesignerAsset: async (_path, assetId) => ({ id: assetId, name: "Server name" }),
    }, [
      {
        id: 1, type: "designerCreate", asset: "designerEmail", provisionalId: "~1",
        body: { name: "Local create", appData: { workspaceId: "1", folderId: "10" } },
      },
      { id: 2, type: "designerClone", asset: "designerEmail", provisionalId: "~2", sourceId: "email-0-1", name: "Clone" },
      { id: 3, type: "designerUpdate", asset: "designerEmail", targetId: "email-0-1", patch: { name: "Updated" } },
      { id: 4, type: "designerDelete", asset: "designerEmail", targetId: "email-0-2" },
    ]);
    let designer = new MarketoEmailDesignerImpl(ctx);

    let first = await designer.listEmails("1", {
      folderId: "10", folderType: "Folder", name: "First", status: ["draft"], pageSize: 2,
      sortKey: "name", sortOrder: "ASC", includeArchived: true, isCreatedByMe: true,
      isModifiedByMe: false, templateId: "template-1",
    });
    let second = await designer.listEmails("1", { pageIndex: 1, pageSize: 2 });
    await designer.listFragments("1", { fragmentType: "email" });

    expect(first).toMatchObject({
      items: [{ id: "email-0-1", name: "First" }, { id: "email-0-2", name: "Second" }],
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
    expect(await designer.getEmail("~1").describe()).toMatchObject({ id: "~1", name: "Local create" });
  });

  it("exposes the designer from a Design Studio-scoped handle", () => {
    let { ctx } = emailDesignerContext({});
    expect(new MarketoDesignStudioImpl(ctx).getEmailDesigner()).toBeInstanceOf(MarketoEmailDesignerImpl);
    expect(new MarketoSessionImpl({ ...campaignContext({}).ctx, ...ctx }).getDesignStudio().getEmailDesigner())
      .toBeInstanceOf(MarketoEmailDesignerImpl);
  });

  it("describes publication, discard, and deletion risks and tracks dependencies", () => {
    let approve = describeAction({ id: 1, type: "designerLifecycle", asset: "designerFragment", targetId: "f", operation: "approve" });
    let discard = describeAction({ id: 2, type: "designerLifecycle", asset: "designerEmail", targetId: "e", operation: "discard" });
    let remove = describeAction({ id: 3, type: "designerDelete", asset: "designerTemplate", targetId: "t" });
    expect(approve.description).toMatch(/every inheriting/);
    expect(discard).toMatchObject({ awaitDecision: true });
    expect(discard.description).toMatch(/cannot be recovered/);
    expect(remove.description).toMatch(/irreversible.*depend/i);
    expect(emailDesignerActionReferences({ id: 4, type: "designerCreate", asset: "designerEmail", provisionalId: "~2", body: { templateId: "~1" } }, "~1")).toBe(true);
    expect(emailDesignerActionReferences({ id: 5, type: "designerClone", asset: "designerEmail", provisionalId: "~3", sourceId: "~2", name: "Copy" }, "~2")).toBe(true);
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
      active: false,
      folder: { id: "20", type: "program" },
    });
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
    expect(actions[1]).toMatchObject({ type: "campaignLifecycle", operation: "activate" });
  });

  it("snapshots clone simulation before later source mutations", async () => {
    let { ctx } = campaignContext({
      getSmartCampaign: async () => ({ id: 7, name: "Source", description: "Original", type: "batch" }),
    });
    let session = new MarketoSessionImpl(ctx);
    let source = session.getSmartCampaign("7");
    let clone = await session.cloneSmartCampaign("7", { id: "10", type: "folder" }, { name: "Clone" });
    await source.updateMetadata({ description: "Later source change" });

    expect(await clone.describe()).toMatchObject({ name: "Clone", description: "Original" });
    expect(await source.describe()).toMatchObject({ description: "Later source change" });
  });

  it("follows nested provisional clones to read source rules", async () => {
    let { ctx } = campaignContext({
      getSmartCampaign: async () => ({ id: 7, name: "Source", type: "trigger" }),
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
      getSmartCampaign: async () => ({ id: 7, name: "Inactive trigger", type: "trigger", isActive: false }),
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
      operation: "activate",
    });
    let deletion = describeAction({
      id: 2,
      type: "campaignLifecycle",
      targetId: "7",
      campaignName: "Campaign",
      operation: "delete",
    });

    expect(activation.awaitDecision).toBe(true);
    expect(activation.description).toMatch(/send messages or change data/);
    expect(deletion.description).toMatch(/Permanently delete.*cannot be undone/);
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
    applicableProgramType: "Email",
    progressionStatuses: [{ name: "Member" }, { name: "Success" }],
  }];
  const tagTypes = [{
    id: 2,
    name: "Region",
    requiredFor: ["Email"],
    allowableValues: ["EMEA", "AMER"],
  }];

  it("discovers channels and tag definitions through observations", async () => {
    let notes: string[] = [];
    let { ctx } = programContext({ getChannels: async () => channels, getTagTypes: async () => tagTypes });
    ctx.observe = async (title, description) => { notes.push(title, description); };
    let session = new MarketoSessionImpl(ctx);

    expect(await session.getChannels()).toEqual([{
      name: "Email Send", programType: "Email", statuses: ["Member", "Success"],
    }]);
    expect(await session.getTagTypes()).toEqual([{
      name: "Region", requiredFor: ["Email"], values: ["EMEA", "AMER"],
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

  it("clones into ordinary folders and snapshots the source before later mutations", async () => {
    let { ctx } = programContext({
      getProgram: async () => ({
        id: 7, name: "Template", description: "Original", type: "Default", channel: "Web",
      }),
      getChannels: async () => [{ name: "Web", applicableProgramType: "Default" }],
    });
    let session = new MarketoSessionImpl(ctx);
    let clone = await session.cloneProgram("7", { id: "10", type: "folder" }, { name: "Copy" });
    await session.getProgram("7").updateMetadata({ description: "Later" });

    expect(await clone.describe()).toMatchObject({ id: "~1", name: "Copy", description: "Original" });
    await expect(session.cloneProgram("7", { id: "20", type: "program" }, { name: "Bad" }))
      .rejects.toThrow(/ordinary folder/);
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
      subject: { value: "Old subject" },
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

  it("clones the overlaid content of a real source with a pending update", async () => {
    let getEmailTemplateContent = vi.fn(async () => ({ id: 31, content: "<html>old</html>" }));
    let { ctx } = designContext({ getEmailTemplateContent }, [{
      id: 1,
      type: "designContent",
      asset: "emailTemplate",
      targetId: "31",
      content: "<html>pending</html>",
    }]);
    let clone = await new MarketoDesignStudioImpl(ctx).cloneEmailTemplate(
      "31",
      "Clone",
      { id: "10", type: "folder" },
    );

    expect(await clone.getContent()).toBe("<html>pending</html>");
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
    )).toMatchObject([
      { sourceId: "~1", templateId: "20" },
      { sourceId: "~2", templateId: "20" },
    ]);
    expect(getLandingPageContent).not.toHaveBeenCalled();
    expect(getFormFields).not.toHaveBeenCalled();
  });

  it("captures a physical landing page's template before queuing its clone", async () => {
    let getLandingPage = vi.fn(async () => ({ id: 31, name: "Source", template: 20 }));
    let { ctx, actions } = designContext({ getLandingPage });
    let observe = vi.fn();
    ctx.observe = observe;

    await new MarketoDesignStudioImpl(ctx).cloneLandingPage(
      "31",
      "Clone",
      { id: "10", type: "folder" },
    );

    expect(getLandingPage).toHaveBeenCalledWith(31);
    expect(observe).toHaveBeenCalledWith(
      "Read Marketo landing page template",
      "Read the template used by landing page `31` before cloning it.",
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "designClone",
      asset: "landingPage",
      sourceId: "31",
      templateId: "20",
    });
  });

  it("rejects invalid physical landing-page clone sources before queueing", async () => {
    for (let source of [undefined, { id: 32, template: 20 }, { id: 31, template: 0 }]) {
      let { ctx, actions } = designContext({ getLandingPage: async () => source });
      await expect(new MarketoDesignStudioImpl(ctx).cloneLandingPage(
        "31",
        "Clone",
        { id: "10", type: "folder" },
      )).rejects.toThrow(/wrong landing page|no valid template/);
      expect(actions).toEqual([]);
    }
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
      { id: 2, type: "designLifecycle", asset: "email", targetId: "21", operation: "approve" },
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
    }, [{ id: 1, type: "designLifecycle", asset: "email", targetId: "1", operation: "delete" }]);
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

  it("pages by raw rows when a folder filter is applied locally", async () => {
    let records = [
      { id: 1, name: "Same", folder: { id: 11 } },
      { id: 2, name: "Same", folder: { id: 10 } },
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
        mimeType: "text/plain",
        data: new TextEncoder().encode("first"),
      },
    );

    let action = actions[0]!;
    expect(action).toMatchObject({
      type: "designCreate",
      input: {
        sha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
      },
    });
    let description = describeAction(action);
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

  it("blocks deleted content reads without fetching the source", async () => {
    let getEmailContent = vi.fn();
    let { ctx } = designContext({ getEmailContent }, [{
      id: 1,
      type: "designLifecycle",
      asset: "email",
      targetId: "21",
      operation: "delete",
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
    expect(getFoldersByName).toHaveBeenCalledTimes(3);
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
    let getFoldersByName = vi.fn(async () => []);
    let { ctx, actions } = designContext({ getFolder, getFoldersByName });
    let studio = new MarketoDesignStudioImpl(ctx);

    let program = studio.getFolder("10", "folder");
    expect((await program.describe()).type).toBe("program");
    await expect(program.updateMetadata({ name: "Renamed" })).rejects.toThrow(/Program folders cannot be edited/);
    await expect(program.delete()).rejects.toThrow(/Program folders cannot be deleted/);
    expect(actions).toEqual([]);
    await studio.listFolders({ name: "Child", root: { id: "10", type: "program" } });
    expect(getFoldersByName).toHaveBeenCalledWith("Child", {
      type: "Program",
      root: { id: 10, type: "Program" },
      workspace: undefined,
    });
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
    dedupeFields: ["marketoGUID"],
    searchableFields: [["sourceID"], ["marketoGUID"], ["leadID"]],
    fields: [
      { name: "createdAt", displayName: "Created At", dataType: "datetime", updateable: false },
      { name: "sourceID", displayName: "Source ID", dataType: "string", updateable: true },
    ],
  };

  it("keeps the API name, so fields can actually be requested", async () => {
    let object = new MarketoCustomObjectImpl(
      stubContext({ describeCustomObject: async () => SCHEMA }), "orderStatus");
    let schema = await object.describe();
    expect(schema.fields.map(f => f.name)).toEqual(["createdAt", "sourceID"]);
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
    expect(byName.get("createdAt")?.searchable).toBe(false);
    expect(schema.searchableFields).toEqual(["sourceID", "marketoGUID", "leadID"]);
  });

  it("deletes GUID-only records explicitly by marketoGUID", async () => {
    let submitted: MarketoActionInput[] = [];
    let ctx = makeSessionContext({
      client: async () => ({}) as MarketoClient,
      approvalQueue: {} as never,
      submit: async action => void submitted.push(action),
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

  it("sends GUID deletion using Marketo's idField mode", async () => {
    let body: unknown;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ success: true, result: [{ marketoGUID: "guid-1", status: "deleted" }] });
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
  it("uses valid Marketo GUID identity and falls back safely", async () => {
    let session = new MarketoSessionImpl(stubContext({
      getPagingToken: async () => "page",
      getActivities: async () => ({
        result: [
          { id: 1, marketoGUID: "activity-guid" },
          { id: 2 },
          { id: 3, marketoGUID: "" },
          { marketoGUID: "   " },
          { id: 4, marketoGUID: 4 } as never,
          { id: "malformed", marketoGUID: 4 } as never,
          { id: -5 },
          { id: 1.5 },
          {},
        ],
        moreResult: false,
      }),
    }));

    let page = await session.getActivities({ sinceDate: new Date("2026-08-31T00:00:00Z"), activityTypeIds: [1] });

    expect(page.activities.map(activity => activity.id)).toEqual([
      "activity-guid", 2, 3, -1, 4, -1, -1, -1, -1,
    ]);
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
  it("returns one page and passes the continuation token through", async () => {
    let seen: (string | undefined)[] = [];
    let session = new MarketoSessionImpl(stubContext({
      getLists: async (filter?: { pageToken?: string }) => {
        seen.push(filter?.pageToken);
        return { result: [{ id: 1, name: "L" }], moreResult: true, nextPageToken: "tok2" };
      },
    }));
    let page = await session.listStaticLists({ pageToken: "tok1" });
    expect(seen).toEqual(["tok1"]);
    expect(page.lists.map(l => l.id)).toEqual([1]);
    expect(page.moreResult).toBe(true);
    expect(page.nextPageToken).toBe("tok2");
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
  let remaining = [...envelopes];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    return Response.json(remaining.shift() ?? {});
  });
  return { client: new MarketoClient(ORIGIN, { getToken: async () => "t" }), calls };
}

function businessContext(client: Partial<MarketoClient>, submitted: MarketoActionInput[] = [], notes: string[] = []) {
  let access = new Map<string, "read-write" | "read-only" | "unavailable">();
  let ctx: BusinessObjectContext = {
    client: async () => client as MarketoClient,
    observe: async (title, description) => { notes.push(title, description); },
    submitBusinessObject: async action => void submitted.push(action),
    getBusinessObjectAccess: kind => access.get(kind) ?? "read-write",
    setBusinessObjectAccess: (kind, value) => void access.set(kind, value),
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
});

describe("standard CRM business objects", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses each object-specific endpoint path", async () => {
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      paths.push(new URL(url).pathname);
      return Response.json({ success: true, result: [{ idField: "id", fields: [] }] });
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

  it("uses each object-specific sync and delete path", async () => {
    let calls: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ success: true, result: [{ id: 1, status: "updated" }] });
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
    expect(request.url).toContain("/rest/v1/opportunities/roles.json?_method=GET&batchSize=10&nextPageToken=p");
    expect(request.init?.method).toBe("POST");
    expect(JSON.parse(String(request.init?.body))).toEqual({
      filterType: "dedupeFields", fields: ["role"], input: [key],
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

  it("submits data-minimizing, decision-gated upserts and deletes", async () => {
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
    expect(description.description).not.toContain("Secret Corp");
    expect(description.description).toContain('externalCompanyId = "secret\\-id"');
    let deletion = describeAction({ ...submitted[1]!, id: 2 } as MarketoAction);
    expect(deletion.description).toContain("id = 9");
    let bounded = describeAction({
      id: 3, type: "businessObjectDelete", kind: "company", matchBy: "idField",
      records: Array.from({ length: 20 }, (_, id) => ({ id: id + 1 })), changedFields: ["id"],
    });
    expect(bounded.description).toContain("and 10 more record(s)");
    expect(bounded.description).not.toContain("id = 11");
    let privateFields = describeAction({
      id: 4, type: "businessObjectUpsert", kind: "company", matchBy: "dedupeFields",
      records: [{ externalCompanyId: "<target>*".repeat(20), company: "Never display this" }],
      action: "createOrUpdate", changedFields: ["company"],
    });
    expect(privateFields.description).toContain("&lt;target&gt;\\*");
    expect(privateFields.description).toContain("\\.\\.\\.");
    expect(privateFields.description).not.toContain("Never display this");
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
      { success: true, result: [{ marketoGUID: "g1" }], moreResult: true, nextPageToken: "objects-2" },
      { success: true, result: [{ marketoGUID: "g2" }], moreResult: false },
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

  it("rejects missing and repeated filter continuation tokens", async () => {
    let missing = clientReturning({
      success: true, result: [{ id: 1 }], moreResult: true,
    }).client;
    await expect(missing.getLeads("email", ["a@example.com"]))
      .rejects.toThrow("invalid filter paging state");

    let repeated = clientReturning(
      { success: true, result: [{ id: 1 }], moreResult: true, nextPageToken: "same" },
      { success: true, result: [{ id: 2 }], moreResult: true, nextPageToken: "same" },
    ).client;
    await expect(repeated.queryCustomObject("orderStatus", "sourceID", ["1"]))
      .rejects.toThrow("invalid filter paging state");
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
          getCampaign: async () => ({
            id: 7800,
            name: "Quarterly Batch",
            type,
            isTriggerable: type === "trigger",
          }),
        }) as never,
        observe: async () => {},
        submit: async action => void submitted.push(action),
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
          getCampaign: async () => ({ id: 7800, name: "Trigger", type: "trigger" }),
        }) as never,
        observe: async () => {},
        submit: async action => void submitted.push(action),
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

  it("still submits each operation for the kind that supports it", async () => {
    let requested: MarketoActionInput[] = [];
    await campaign("trigger", requested).requestCampaign([1]);
    expect(requested.map(a => a.type)).toEqual(["campaignTrigger"]);

    let scheduled: MarketoActionInput[] = [];
    await campaign("batch", scheduled).schedule(new Date(Date.now() + 10 * 60 * 1000));
    expect(scheduled.map(a => a.type)).toEqual(["campaignSchedule"]);
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
        getCampaign: async () => {
          entered.resolve();
          await new Promise<void>(resolve => void (release = resolve));
          return { id: 7800, name: "Deleting", type, isTriggerable: true };
        },
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
          kind: "instance" | "design-studio" | "program" | "list";
          resourceId?: number;
        };
      };
    }).ctx;
    ctx.props = { userObjectId, kind, resourceId };
  });
  return stub;
}

class TestApprovalQueue extends RpcTarget {
  constructor(private readonly submit: (id: number, description: ActionDescription) => Promise<void> = async () => {}) {
    super();
  }

  async authorizeObservation(_description: ObservationDescription): Promise<void> {}

  async submitAction(id: number, description: ActionDescription): Promise<void> {
    await this.submit(id, description);
  }
}

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

  it("rolls back durable pending state when queue submission fails", async () => {
    let accountId = await accountWithCredentials({
      endpoint: ORIGIN,
      clientId: "client",
      clientSecret: crypto.randomUUID(),
    });
    let gatekeeper = await gatekeeperForAccount(accountId.toString(), "design-studio");

    await runInDurableObject(gatekeeper, async (instance, state) => {
      let queue = {
        dup() { return this; },
        async authorizeObservation() {},
        async submitAction() { throw new Error("approval queue unavailable"); },
        [Symbol.dispose]() {},
      } as unknown as RpcStub<ApprovalQueue>;
      let session = await instance.startSession(queue);
      let studio = session as MarketoDesignStudioImpl;
      await expect(studio.getEmail("20").approve()).rejects.toThrow("approval queue unavailable");
      expect(state.storage.kv.get("pending:1")).toBeUndefined();
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([]);
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

      await studio.getEmail("20").approve();
      expect(state.storage.kv.get<number[]>("pending:index")).toHaveLength(200);
      await expect(studio.getEmail("21").approve()).rejects.toThrow(/more than 200 pending actions/);

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
      state.storage.kv.put("pending:1", { action: creation });
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

  it("surfaces transient Identity failures without expiring the credential", async () => {
    let ownerId = await accountWithCredentials(OWNER);
    let gatekeeper = await gatekeeperForAccount(ownerId.toString());
    let observerId = await accountWithCredentials(OWNER);
    let expiryNotification = vi.spyOn(UserAccount.prototype, "credentialsExpired");
    vi.stubGlobal("fetch", async () => {
      throw new Error("temporary outage");
    });

    await expect(addObserverFromAccount(gatekeeper, observerId.toString())).rejects.toThrow(
      /Could not reach the Marketo Identity endpoint/,
    );
    expect(expiryNotification).not.toHaveBeenCalled();
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
      ctx: { props: { userObjectId: string; kind: "instance" } };
    }).ctx;
    ctx.props = { userObjectId: userId.toString(), kind: "instance" };
    state.storage.kv.put(`pending:${action.id}`, { action });
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
      ctx: { props: { userObjectId: string; kind: "design-studio" } };
    }).ctx;
    ctx.props = { userObjectId: userId.toString(), kind: "design-studio" };
    state.storage.kv.put("pending:index", actions.map(action => action.id));
    for (let action of actions) state.storage.kv.put(`pending:${action.id}`, { action });
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
      ctx: { props: { userObjectId: string; kind: "instance" } };
    }).ctx;
    ctx.props = { userObjectId: userId.toString(), kind: "instance" };
    state.storage.kv.put("pending:index", actions.map(action => action.id));
    for (let action of actions) state.storage.kv.put(`pending:${action.id}`, { action });
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

describe("Email Designer action lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

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
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([5, 6, 7]);
      for (let id of [1, 2, 3, 4]) expect(state.storage.kv.get(`pending:${id}`)).toBeUndefined();
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
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([6]);
      for (let id of [1, 2, 3, 4, 5]) expect(state.storage.kv.get(`pending:${id}`)).toBeUndefined();
      expect(state.storage.kv.get("pending:6")).toBeDefined();
    });
  });

  it("requires same-asset updates and clones to apply in submission order", async () => {
    let actions: EmailDesignerAction[] = [
      { id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "email-A", patch: { name: "First" } },
      { id: 2, type: "designerClone", asset: "designerEmail", provisionalId: "~1", sourceId: "email-A", name: "Copy" },
    ];
    let requests: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      requests.push({ path, body: JSON.parse(String(init?.body)) });
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
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([]);
      expect(state.storage.kv.get("pending:2")).toBeUndefined();
      expect(state.storage.kv.get("pending:3")).toBeUndefined();
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
    let action: EmailDesignerAction = {
      id: 1,
      type: "designerDelete",
      asset: "designerEmail",
      targetId: "email-1",
    };
    let requests: { path: string; method: string; body: BodyInit | null | undefined }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      requests.push({ path: new URL(url).pathname, method: init?.method ?? "GET", body: init?.body });
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
      };
      vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : Response.json(response));
      let stub = await emailDesignerActionGatekeeper([action]);

      await runInDurableObject(stub, async (instance, state) => {
        await expect(instance.applyAction(1)).rejects.toThrow(/without confirming success/);
        expect(state.storage.kv.get("applying:1")).toBe("uncertain");
        expect(state.storage.kv.get("pending:1")).toBeDefined();
      });
      vi.unstubAllGlobals();
    }
  });

  it("keeps empty, malformed, wrong-id, and wrong-status mutation results uncertain", async () => {
    let cases: { action: EmailDesignerAction; result: unknown[] }[] = [
      { action: { id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "e", patch: { name: "New" } }, result: [] },
      { action: { id: 1, type: "designerDelete", asset: "designerEmail", targetId: "e" }, result: [{}] },
      { action: { id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "e", patch: { name: "New" } }, result: [{ id: "other" }] },
      { action: { id: 1, type: "designerLifecycle", asset: "designerEmail", targetId: "e", operation: "approve" }, result: [{ id: "e", status: "draft" }] },
    ];
    for (let { action, result } of cases) {
      vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : Response.json({ success: true, result }));
      let stub = await emailDesignerActionGatekeeper([action]);
      await runInDurableObject(stub, async (instance, state) => {
        await expect(instance.applyAction(1)).rejects.toThrow(/invalid/);
        expect(state.storage.kv.get("applying:1")).toBe("uncertain");
        expect(state.storage.kv.get("pending:1")).toBeDefined();
      });
      vi.unstubAllGlobals();
    }
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
      return Response.json({ success: true, result: [null] });
    });
    let stub = await emailDesignerActionGatekeeper([action]);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/unexpected shape/);
      expect(state.storage.kv.get("applying:1")).toBe("uncertain");
      expect(state.storage.kv.get("pending:1")).toBeDefined();
      await expect(instance.applyAction(1)).rejects.toThrow(/already dispatched/);
    });
    expect(mutationCalls).toBe(1);
  });
});

describe("smart campaign action lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

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
      return Response.json({ success: true, result: [{ id: path.includes("/clone.json") ? 32 : 31 }] });
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
    });
    expect(paths).toEqual([
      "/rest/asset/v1/smartCampaign/31.json",
      "/rest/asset/v1/smartCampaign/31/clone.json",
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
        operation: "activate",
      },
    ];
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([]);
      expect(state.storage.kv.get("pending:2")).toBeUndefined();
    });
  });

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
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([]);
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
        operation: "delete",
      },
    ];
    let stub = await campaignActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([]);
      for (let id of [1, 2, 3, 4]) expect(state.storage.kv.get(`pending:${id}`)).toBeUndefined();
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
      return Response.json({ success: true, result: [{ id: path.includes("/clone.json") ? 32 : 31 }] });
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
      "/rest/asset/v1/program/31/clone.json",
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
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([]);
      for (let id of [1, 2, 3, 4]) expect(state.storage.kv.get(`pending:${id}`)).toBeUndefined();
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
      if (path.endsWith("/programs.json")) return Response.json({ success: true, result: [{ id: 100 }] });
      if (path.includes("/asset/v2/email")) {
        designerBody = JSON.parse(String(init?.body));
        return Response.json({ success: true, result: [{ id: "email-1" }] });
      }
      return Response.json({ success: true, result: [{ id: path.endsWith("/snippets.json") ? 102 : 101 }] });
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
    expect(mutationCalls).toBe(4);
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
      { id: 6, type: "designerDelete", asset: "designerEmail", targetId: "~3" },
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

  it("sends the captured source template when cloning a landing page", async () => {
    let action: DesignStudioAction = {
      id: 1,
      type: "designClone",
      asset: "landingPage",
      provisionalId: "~1",
      sourceId: "31",
      parent: { id: "10", type: "Folder" },
      name: "Clone",
      templateId: "20",
    };
    let submitted: URLSearchParams | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      submitted = new URLSearchParams(String(init?.body));
      return Response.json({ success: true, result: [{ id: 88 }] });
    });
    let stub = await designActionGatekeeper([action]);

    await runInDurableObject(stub, instance => instance.applyAction(1));

    expect(submitted?.get("template")).toBe("20");
    expect(submitted?.get("name")).toBe("Clone");
    expect(submitted?.get("folder")).toBe(JSON.stringify({ id: 10, type: "Folder" }));
  });

  it("rejects malformed landing-page clone actions before dispatch", async () => {
    let actions = [
      {
        id: 1,
        type: "designClone",
        asset: "landingPage",
        provisionalId: "~1",
        sourceId: "31",
        parent: { id: "10", type: "Folder" },
        name: "Missing template",
      },
      {
        id: 2,
        type: "designClone",
        asset: "email",
        provisionalId: "~2",
        sourceId: "32",
        parent: { id: "10", type: "Folder" },
        name: "Wrong template kind",
        templateId: "20",
      },
    ] as unknown as DesignStudioAction[];
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      writes++;
      return Response.json({ success: true, result: [{ id: 88 }] });
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(1)).rejects.toThrow(/missing its source template/);
      await expect(instance.applyAction(2)).rejects.toThrow(/Only a Marketo landing-page clone/);
      expect(state.storage.kv.get("applying:1")).toBeUndefined();
      expect(state.storage.kv.get("applying:2")).toBeUndefined();
    });
    expect(writes).toBe(0);
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
      submitted = init?.body as FormData;
      return Response.json({ success: true, result: [{ id: 88 }] });
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
      return Response.json({ success: true, result: [{ id: path.endsWith("/folders.json") ? 101 : 101 }] });
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
      return Response.json({ success: true, result: [{ id: path.includes("/clone.json") ? 32 : 31 }] });
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
      "/rest/asset/v1/emailTemplate/31/clone.json",
    ]);
  });

  it("applies classic asset and folder mutations in submission order", async () => {
    let actions: DesignStudioAction[] = [
      { id: 1, type: "designMetadata", asset: "emailTemplate", targetId: "31", patch: { name: "First" } },
      { id: 2, type: "designContent", asset: "emailTemplate", targetId: "31", content: "second" },
      { id: 3, type: "designLifecycle", asset: "emailTemplate", targetId: "31", operation: "approve" },
      { id: 4, type: "designMetadata", asset: "folder", targetId: "40", patch: { name: "Folder" } },
      { id: 5, type: "designDeleteFolder", targetId: "40" },
    ];
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      paths.push(path);
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
      { id: 3, type: "designLifecycle", asset: "emailTemplate", targetId: "31", operation: "delete" },
    ];
    let paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      let path = new URL(url).pathname;
      paths.push(path);
      return Response.json({ success: true, result: [{ id: path.includes("clone") ? 32 : 31 }] });
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async instance => {
      await expect(instance.applyAction(2)).rejects.toThrow(/emailTemplate 31 has an earlier pending mutation/);
      await expect(instance.applyAction(3)).rejects.toThrow(/emailTemplate 31 has an earlier pending mutation/);
      expect(paths).toEqual([]);
      for (let id of [1, 2, 3]) await instance.applyAction(id);
    });
    expect(paths).toEqual([
      "/rest/asset/v1/emailTemplate/31/clone.json",
      "/rest/asset/v1/emailTemplate/31.json",
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
      let id = path.endsWith("/snippets.json") ? 101 : path.endsWith("/emails.json") ? 102
        : path.includes("folder/10") ? 10 : 20;
      return Response.json({ success: true, result: [{ id }] });
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
      "/rest/asset/v1/folder/10/delete.json",
      "/rest/asset/v1/emails.json",
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
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([4]);
      for (let id of [1, 2, 3]) expect(state.storage.kv.get(`pending:${id}`)).toBeUndefined();
      expect(state.storage.kv.get("pending:4")).toBeDefined();
    });
  });

  it("orders and rejects landing-page clones with provisional templates", async () => {
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
        templateId: "~1",
      },
    ];
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      writes++;
      return Response.json({ success: true, result: [{ id: 88 }] });
    });
    let stub = await designActionGatekeeper(actions);

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.applyAction(2)).rejects.toThrow(/still pending creation/);
      expect(state.storage.kv.get("applying:2")).toBeUndefined();
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([]);
    });
    expect(writes).toBe(0);
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
      expect(state.storage.kv.get("provisional:~1")).toBe(88);
      expect(state.storage.kv.get("applying:1")).toBe("uncertain");
      expect(state.storage.kv.get("pending:1")).toBeDefined();
      await expect(instance.applyAction(2)).rejects.toThrow(/~1 is still pending creation/);
      await expect(instance.applyAction(3)).rejects.toThrow(/~1 is still pending creation/);
      expect(state.storage.kv.get("applying:2")).toBeUndefined();
      expect(state.storage.kv.get("applying:3")).toBeUndefined();
      await expect(instance.applyAction(1)).rejects.toThrow(/already dispatched/);
      await expect(instance.rejectAction(1)).resolves.toEqual({ restart: true });
      expect(state.storage.kv.get("applying:1")).toBe("uncertain");
      expect(state.storage.kv.get<number[]>("pending:index")).toEqual([]);
      for (let id of [1, 2, 3]) expect(state.storage.kv.get(`pending:${id}`)).toBeUndefined();
      expect(state.storage.kv.get("provisional:~1")).toBeUndefined();
      expect(state.storage.kv.get("provisionalKind:~1")).toBeUndefined();
      await expect(instance.applyAction(1)).rejects.toThrow(/already dispatched/);
    });
    expect(mutationCalls).toBe(1);
  });

  it("keeps a two-rendition snippet update uncertain when either dispatched step fails", async () => {
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
        expect(state.storage.kv.get("applying:1")).toBe("uncertain");
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
  afterEach(() => vi.unstubAllGlobals());

  const ACTION: MarketoAction = {
    id: 17,
    type: "listAdd",
    listId: 5,
    listName: "Customers",
    personIds: [7],
  };

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
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow(/already dispatched/);
      await expect(instance.rejectAction(ACTION.id)).rejects.toThrow(/already dispatched/);
      release?.();
      await first;
      await expect(instance.rejectAction(ACTION.id)).rejects.toThrow(/already dispatched/);
      await instance.applyAction(ACTION.id);
    });
    expect(calls).toBe(1);
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
      expect(state.storage.kv.get(`applying:${ACTION.id}`)).toBe("uncertain");
      await expect(instance.applyAction(ACTION.id)).rejects.toThrow(/already dispatched/);
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
      await expect(instance.rejectAction(action.id)).resolves.toBeUndefined();
      expect(state.storage.kv.get(`applying:${action.id}`)).toBe("partial");
    });
  });

  it("makes Adobe 1018 terminal, caches native CRM read-only, and blocks later approvals", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
      return Response.json({ success: false, errors: [{ code: "1018", message: "CRM Enabled" }] });
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
      expect(state.storage.kv.get("businessObjects:nativeCrmReadOnly")).toBe(true);
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
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    });
  });

  it("also makes success-envelope per-record 1018 skips terminal", async () => {
    vi.stubGlobal("fetch", async (url: string) => url.includes("/identity/")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : Response.json({
          success: true,
          result: [{ status: "skipped", reasons: [{ code: "1018", message: "CRM Enabled" }] }],
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
      expect(state.storage.kv.get("businessObjects:nativeCrmReadOnly")).toBe(true);
      await expect(instance.applyAction(action.id)).rejects.toThrow(/nothing was changed/);
    });
  });

  it("does not treat Named Account 1018 as native CRM evidence", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/identity/")) return Response.json({ access_token: "token", expires_in: 3600 });
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
    await client.getCampaignSmartList(77);

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
});

describe("program Asset API encoding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses official form fields, JSON tag encoding, and lifecycle paths", async () => {
    let calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
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
    let create = Object.fromEntries(new URLSearchParams(String(calls[1]!.init.body)));
    expect(create).toMatchObject({
      name: "Program",
      folder: JSON.stringify({ id: 10, type: "Folder" }),
      type: "Email",
      channel: "Email Send",
      tags: JSON.stringify(tags),
      startDate: "2026-09-01T10:00:00.000Z",
      endDate: "2026-09-01T11:00:00.000Z",
    });
    expect(new URL(calls[2]!.url).pathname).toBe("/rest/asset/v1/program/7/clone.json");
    expect(new URL(calls[3]!.url).pathname).toBe("/rest/asset/v1/program/77.json");
    expect(calls.slice(4).map(call => new URL(call.url).pathname)).toEqual([
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
});
