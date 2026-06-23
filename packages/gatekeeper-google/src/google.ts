import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { GatekeeperUser, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription, ApprovalQueue, VendorDescription, VendorScope, GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription, SupportedResource, ResourceConfiguratorFrame, Cursor } from '@gadgets/workshop-shared/gatekeeper';
import { exchangeAuthCode, getAccessToken, getGoogleAccountDescription, getGoogleVerifiedEmail, GmailApi, GmailMessageRaw, GmailOutboundMessage, GoogleAccessToken, normalizeEmailRecipients, revokeGoogleToken } from "./google-api";
import {
  GmailSession, GmailThread, GmailMessage,
  GmailThreadInfo, GmailThreadEntry, GmailMessageInfo, GmailLabel, GmailSystemLabel, EmailContent
} from "./types";
import { GoogleDocSession, DocMetadata } from "./docs-types";
import { GoogleDocsApi } from "./docs-api";
import { docToMarkdown, markdownToDocRequests, computeReplaceOperations, DocSnapshot } from "./markdown-converter";
import { BigQueryApi, DEFAULT_MAX_BYTES_BILLED } from "./bigquery-api";
import {
  BigQueryDataset, BigQueryDryRunResult, BigQueryField, BigQueryProject,
  BigQueryQueryOptions, BigQueryQueryResult, BigQuerySession, BigQueryTable,
} from "./bigquery-types";
import TYPES_CODE from "./types.txt";
import DOCS_TYPES_CODE from "./docs-types.txt";
import BIGQUERY_TYPES_CODE from "./bigquery-types.txt";
import {
  BigQueryConfiguratorUI,
  GmailConfiguratorUI,
  GoogleDocConfiguratorUI,
} from "./google-configurators";
import BIGQUERY_CONFIGURATOR_HTML from "./generated/bigquery-configurator-ui.txt";
import GMAIL_CONFIGURATOR_HTML from "./generated/gmail-configurator-ui.txt";
import GOOGLE_DOC_CONFIGURATOR_HTML from "./generated/google-doc-configurator-ui.txt";
import GOOGLE_LOGO_SVG from "./google-logo.svg";

// A nonce stored in UserAccount KV to protect the OAuth flow. Only one nonce is active at a time;
// the `stage` field tracks where we are in the flow.
type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;  // 10 minutes
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;    // 10 minutes
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  let encoder = new TextEncoder();
  let bufA = encoder.encode(a);
  let bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & {
  // Base URL (protocol+host+optional path) at which the default fetch handler is served. Should
  // NOT include a trailing slash. Omit for localhost dev server.
  BASE_URL?: string,
}

// Well-known Gmail system label IDs — derived from GmailSystemLabel so the
// type and runtime set can't drift apart.
const SYSTEM_LABEL_IDS: GmailSystemLabel[] = [
  "INBOX", "TRASH", "SPAM", "UNREAD", "STARRED",
  "IMPORTANT", "SENT", "DRAFT", "CHAT",
  "CATEGORY_PRIMARY", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
];
const SYSTEM_LABELS: Set<string> = new Set(SYSTEM_LABEL_IDS);

// Resolve raw Gmail label IDs into GmailLabel objects with human-readable names.
// System labels use their well-known name; custom labels are resolved via the
// labelMap (fetched from Gmail's labels.list API).
function toLabelObjects(labelIds: string[], labelMap: Map<string, string>): GmailLabel[] {
  return labelIds.map(id => {
    if (SYSTEM_LABELS.has(id)) {
      return { id, name: id as GmailSystemLabel, type: "system" as const };
    }
    let name = labelMap.get(id) || id;
    return { id, name, type: "custom" as const };
  });
}

function validateGmailQueryForGrouping(query: string): void {
  if (new TextEncoder().encode(query).byteLength > MAX_GMAIL_QUERY_BYTES) {
    throw new Error(`Gmail search query must be at most ${MAX_GMAIL_QUERY_BYTES} bytes.`);
  }
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (const char of query) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '{') {
      stack.push(char);
    } else if (char === ')' || char === '}') {
      const expected = char === ')' ? '(' : '{';
      if (stack.pop() !== expected) throw new Error("Gmail query has mismatched grouping delimiters.");
    }
  }
  if (quote || stack.length > 0) throw new Error("Gmail query has unterminated grouping or quotes.");
}

function getBaseUrl(env: Env) {
  return env.BASE_URL || "http://localhost:8787/gatekeeper/google";
}

function getBasePath(env: Env) {
  return new URL(getBaseUrl(env)).pathname;
}

// =======================================================================================

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to the Gadgets Workshop.
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authorization Link Expired</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to the Gadgets Workshop and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #d97706; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configuration Required</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Google Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please see the README.md for instructions on configuring an OAuth client ID and secret so that this Gadgets instance can access Google APIs.</p>
    </div>
  </body>
</html>`;

const SCOPE_CATALOG: VendorScope[] = [
  {
    displayName: "Know who you are",
    rationale:
        "Read your name, email, and profile picture so this account can be labeled in Gadgets.",
  },
  {
    displayName: "Read, organize, and send Gmail",
    rationale:
        "Lets Gadgets triage your inbox, archive/trash threads, mark read/unread, and " +
        "compose, reply to, and forward email. Outgoing messages are sent only after you " +
        "approve them.",
  },
  {
    displayName: "Read and edit Google Docs",
    rationale:
        "Lets Gadgets open documents you choose, summarize them, and make edits.",
  },
  {
    displayName: "List your Google documents",
    rationale:
        "Lets Gadgets show a doc picker when you connect a Google Doc to a Gadget. Read-only " +
        "file metadata; contents are not accessed through this permission.",
  },
  {
    displayName: "Run BigQuery queries",
    rationale:
        "Lets Gadgets run analytics queries against datasets you choose. Google grants the " +
        "BigQuery scope; Gatekeeper restricts use to read-only query flows at the API layer.",
  },
];

const OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  // `bigquery` (not `bigquery.readonly`): dry-runs go through `jobs.insert` for scope
  // enforcement, which `readonly` doesn't permit. Read-only is enforced at the API layer.
  "https://www.googleapis.com/auth/bigquery",
];

// Minimal scopes for sign-in only (verify the user's email). Used when connecting in "auth" mode;
// the resulting grant is transient.
const AUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const GMAIL_RESOURCE: SupportedResource = {
  urlPattern: "https://mail.google.com/*",
  title: "Gmail Mailbox",
  description: "Read emails and apply labels.",
};

const GOOGLE_DOC_RESOURCE: SupportedResource = {
  urlPattern: "https://docs.google.com/document/d/:docId/*",
  title: "Google Doc",
  description: "Read and edit a Google Doc.",
};

const BIGQUERY_HOST = "bigquery.googleapis.com";

const BIGQUERY_RESOURCE: SupportedResource = {
  urlPattern: `https://${BIGQUERY_HOST}/:projectId/*`,
  title: "BigQuery",
  description: "Choose a Google Cloud project, then optionally narrow access to a dataset or table.",
};

const SUPPORTED_RESOURCES: SupportedResource[] =
    [GMAIL_RESOURCE, GOOGLE_DOC_RESOURCE, BIGQUERY_RESOURCE];

const GOOGLE_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(GOOGLE_LOGO_SVG)}`;

// Main HTTP UI entrypoint. We only use this to initiate and complete OAuth requests to Google.
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    let relPath = url.pathname.slice(basePath.length);
    let path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          }
        });
      }

      let doId = path[0];
      let initiationNonce = path[1];
      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      let begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      let oauthNonce = begun.oauthNonce;

      let newUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      newUrl.searchParams.set("client_id", env.CLIENT_ID);
      newUrl.searchParams.set("redirect_uri", getBaseUrl(env) + "/oauth");
      newUrl.searchParams.set("response_type", "code");
      newUrl.searchParams.set("scope", begun.scopes.join(" "));
      newUrl.searchParams.set("access_type", "offline");
      newUrl.searchParams.set("prompt", "consent");
      newUrl.searchParams.set("state", `${doId}:${oauthNonce}`);

      return Response.redirect(newUrl.toString(), 302);
    } else if (relPath === "/oauth") {
      // Completion redirect.

      let error = url.searchParams.get("error");
      if (error) {
        return new Response(`${error}: ${url.searchParams.get("error_description")}`);
      }

      let state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      let colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("Error: malformed state");
      let doId = state.slice(0, colonIdx);
      let oauthNonce = state.slice(colonIdx + 1);

      let code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      // TODO: check actual scopes granted, update our "scope" list accordingly

      let userObjectId = ctx.exports.UserAccount.idFromString(doId);
      let stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(userObjectId);
      if (!await stub.acceptAuthCode(code, oauthNonce)) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return new Response(SELF_CLOSING_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8"
        }
      });
    } else {
      return new Response("Not Found", {status: 404});
    }
  }
}

// =======================================================================================

// Top-level API exposed to the Workshop.
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  status() {
    return "Google Gatekeeper";
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Google",
      url: "https://google.com",
      logo: { url: GOOGLE_LOGO_URL },
      color: "#e8f0fe",
      tagline: "Draft replies, edit docs, and analyze data",
      description:
          "Connect your Google account to give Gadgets access to Gmail, Google Docs, and " +
          "BigQuery. Build agents that triage email, draft and edit documents, or run analytics " +
          "queries on your data.",
      providesAuth: true,
    };
  }

  async getScopeCatalog(): Promise<VendorScope[]> {
    return SCOPE_CATALOG;
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{url: string}> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let initiationNonce = generateNonce();

    let authOnly = options?.scopes === "auth";
    let scopes = authOnly ? AUTH_SCOPES : OAUTH_SCOPES;
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, scopes, authOnly);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}`
    };
  }

  async newUser(): Promise<Fetcher<GatekeeperUser>> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let props: GatekeeperUserImplProps = { userObjectId: userObjectId.toString() };
    return this.ctx.exports.GatekeeperUserImpl({props});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return [TYPES_CODE, DOCS_TYPES_CODE, BIGQUERY_TYPES_CODE].join("\n");
  }
}

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
                    scopes?: string[], ephemeral?: boolean) {
    // If we have no API key in 1 hour, delete this object.
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }

    this.ctx.storage.kv.put("callback", callback);
    // The scopes to request (auth-only for sign-in, or the full capability set). Reused on reconnect.
    if (scopes) this.ctx.storage.kv.put<string[]>("scopes", scopes);
    // Auth-only sign-in grants are transient: dropped shortly after the email is read.
    this.ctx.storage.kv.put<boolean>("ephemeral", ephemeral ?? false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // Prepare this account for a reconnect flow. The next acceptAuthCode() call will replace the
  // existing refresh token and notify via credentialsRestored() instead of complete().
  async prepareReconnect(initiationNonce: string) {
    this.ctx.storage.kv.put<boolean>("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // Called by the fetch handler when the user visits the initiation URL. Verifies the initiation
  // nonce, consumes it, and returns a fresh OAuth nonce plus the scopes to request. Returns null if
  // the nonce is invalid or expired.
  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string; scopes: string[] } | null> {
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }

    // Replace the consumed initiation nonce with a fresh OAuth nonce.
    let oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    let scopes = this.ctx.storage.kv.get<string[]>("scopes") ?? OAUTH_SCOPES;
    return { oauthNonce, scopes };
  }

  // Returns false if the OAuth nonce is invalid or expired.
  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    // Verify and consume the OAuth nonce.
    let stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("The Google Gatekeeper is not configured.");
    }

    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      // Must have timed out.
      throw new Error("Took too long to complete the authorization. Please try again.");
    }

    let response = await exchangeAuthCode(
        code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, getBaseUrl(this.env) + "/oauth");

    if (!response.refreshToken) {
      throw new Error("OAuth exchange didn't return refresh token?");
    }

    this.ctx.storage.kv.put<string>("refreshToken", response.refreshToken);
    this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", response.accessToken);

    let reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      // Reconnect flow: replace credentials and notify restoration.
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      // Initial connect flow: create the user entrypoint and notify completion.
      try {
        let props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({props}));
      } catch (err) {
        this.ctx.storage.kv.delete("refreshToken");
        throw err;
      }
      // Auth-only sign-in grants are transient: the caller has read the email via complete(), so
      // schedule a prompt self-destruct. We do NOT call the provider's revoke endpoint (that could
      // invalidate the user's other grants for this OAuth client); we just drop our local copy.
      if (this.ctx.storage.kv.get<boolean>("ephemeral")) {
        this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 1000);
      }
    }

    return true;
  }

  hasRefreshToken() {
    return this.ctx.storage.kv.get<string>("refreshToken") !== undefined;
  }

  async getAccessToken(): Promise<GoogleAccessToken> {
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("The Google Gatekeeper is not configured.");
    }

    let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) {
      throw new Error("no refresh token set");
    }

    // TODO: If new refresh token returned, use it.
    let cached = this.ctx.storage.kv.get<GoogleAccessToken>("accessToken");
    if (cached && cached.expires.valueOf() > Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) {
      return cached;
    }

    let result = await getAccessToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
    if (result === null) {
      // Credentials expired or revoked. Notify the workshop.
      let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (callback) {
        // Fire and forget — don't let notification failure block the error propagation.
        callback.credentialsExpired().catch(notifyErr => {
          console.error("Failed to notify credential expiry:", notifyErr);
        });
      }
      throw new Error("Google credentials have expired or been revoked. Please re-authenticate.");
    }
    this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", result);
    return result;
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // Drop the account if the flow never completed, or if this was a transient auth-only sign-in
    // grant (used once to read the email for login).
    if (!this.hasRefreshToken() || this.ctx.storage.kv.get<boolean>("ephemeral")) {
      this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (refreshToken) {
      await revokeGoogleToken(refreshToken);
    }
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }
}

type GatekeeperUserImplProps = {
  userObjectId: string;
}

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let token = await obj.getAccessToken();
    return getGoogleAccountDescription(token.token);
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // Contract is Promise<string | null>: never throw. The access token fetch can throw if the
    // (possibly transient sign-in) grant has been cleaned up, and the userinfo call can throw on a
    // non-2xx response — treat any failure as "no email available".
    try {
      let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
      let obj = this.ctx.exports.UserAccount.get(id);
      let token = await obj.getAccessToken();
      if (!token) return null;
      return await getGoogleVerifiedEmail(token.token);
    } catch {
      return null;
    }
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let parsed = new URL(url);

    if (parsed.hostname === "docs.google.com" &&
        parsed.pathname.startsWith("/document/d/")) {
      // Extract document ID from URL path: /document/d/{documentId}/...
      let documentId = parsed.pathname.split("/")[3];
      if (!documentId) {
        throw new Error("Invalid Google Docs URL: no document ID found");
      }
      let props: GoogleDocGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        documentId,
      };
      return {class: this.ctx.exports.GoogleDocGatekeeperImpl({props}), resource: GOOGLE_DOC_RESOURCE};
    }

    if (parsed.hostname === BIGQUERY_HOST) {
      if (parsed.protocol !== "https:") {
        throw new Error(`BigQuery resource URLs must use https: ${url}`);
      }
      if (parsed.search || parsed.hash) {
        throw new Error("BigQuery resource URLs must not include query strings or fragments.");
      }

      // Synthetic path: /<projectId>/<datasetId>/<tableId> (each segment optional after the first).
      let segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean)
          .map(segment => decodeURIComponent(segment));
      if (segments.length > 3) {
        throw new Error(
            "BigQuery resource URLs must be /<projectId>, /<projectId>/<datasetId>, " +
            "or /<projectId>/<datasetId>/<tableId>.");
      }
      let projectId = segments[0] || undefined;
      let datasetId = segments[1] || undefined;
      let tableId = segments[2] || undefined;
      if (!projectId) {
        throw new Error("BigQuery resource URLs must include a project ID.");
      }
      if (tableId && !datasetId) {
        throw new Error("Cannot scope to a table without specifying a dataset.");
      }

      let props: BigQueryGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        scopedProjectId: projectId,
        scopedDatasetId: datasetId,
        scopedTableId: tableId,
      };
      return {
        class: this.ctx.exports.BigQueryGatekeeperImpl({props}),
        resource: BIGQUERY_RESOURCE,
      };
    }

    // Default: Gmail
    let props: GmailGatekeeperImplProps = {...this.ctx.props};

    // Parse the URL hash to extract a search or label scope. Keep labels as
    // opaque names; startSession resolves them to Gmail label IDs so label text
    // can never be interpreted as search syntax.
    let hash = parsed.hash;
    if (hash.startsWith("#search/")) {
      // Gmail's own UI encodes spaces in hash searches as `+`, while
      // decodeURIComponent() only decodes `%20`. Normalize both forms.
      const encodedQuery = hash.slice("#search/".length).replace(/\+/g, " ");
      const query = decodeURIComponent(encodedQuery);
      validateGmailQueryForGrouping(query);
      props.searchQuery = query;
    } else if (hash.startsWith("#label/")) {
      const labelName = decodeURIComponent(hash.slice("#label/".length));
      if (!labelName || new TextEncoder().encode(labelName).byteLength > 320) {
        throw new Error("Gmail label name must be between 1 and 320 bytes.");
      }
      props.labelName = labelName;
    } else if (hash && hash !== "#inbox") {
      throw new Error(
        "Unsupported Gmail view. Connect the inbox, an explicit search, or an explicit label.");
    }

    return {class: this.ctx.exports.GmailGatekeeperImpl({props}), resource: GMAIL_RESOURCE};
  }

  async startResourceConfigurator(
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let getToken = async () => {
      let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
      let obj = this.ctx.exports.UserAccount.get(id);
      return await obj.getAccessToken();
    };

    if (resourceUrlPattern === BIGQUERY_RESOURCE.urlPattern) {
      return {
        iframeHtml: BIGQUERY_CONFIGURATOR_HTML,
        ui: new RpcStub(new BigQueryConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GMAIL_RESOURCE.urlPattern) {
      return {
        iframeHtml: GMAIL_CONFIGURATOR_HTML,
        ui: new RpcStub(new GmailConfiguratorUI()),
      };
    }

    if (resourceUrlPattern === GOOGLE_DOC_RESOURCE.urlPattern) {
      return {
        iframeHtml: GOOGLE_DOC_CONFIGURATOR_HTML,
        ui: new RpcStub(new GoogleDocConfiguratorUI(getToken)),
      };
    }

    throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    await obj.revoke();
  }

  async reconnect(): Promise<{url: string}> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let initiationNonce = generateNonce();
    await obj.prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }
}

class PendingActionStore<Action> {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #actionKey(id: number): string {
    return `pending:action:${id}`;
  }

  submit(action: Action): number {
    let id = this.#kv.get<number>("pending:nextActionId") ?? 1;
    this.#kv.put("pending:nextActionId", id + 1);
    this.#kv.put(this.#actionKey(id), action);
    return id;
  }

  get(id: number): Action | undefined {
    return this.#kv.get<Action>(this.#actionKey(id));
  }

  put(id: number, action: Action): void {
    this.#kv.put(this.#actionKey(id), action);
  }

  list(): {id: number, action: Action}[] {
    return [...this.#kv.list<Action>({prefix: "pending:action:"})]
        .map(([key, action]) => ({id: Number(key.slice("pending:action:".length)), action}))
        .filter(({id}) => Number.isFinite(id))
        .toSorted((a, b) => a.id - b.id);
  }

  remove(id: number): void {
    this.#kv.delete(this.#actionKey(id));
  }
}

// =======================================================================================
// Gmail capability stubs
//
// Capability-based API: GmailSession returns GmailThread[] stubs, which return
// GmailMessage[] stubs, etc. Each stub is an RpcTarget that can be passed across
// Worker boundaries. Actions go through the approval queue; reads go through
// authorizeObservation for audit logging.
//
// Approval model:
//   submitAction (requires approval): all side-effecting actions — archive, trash,
//                                     markRead, markUnread, send (reply / replyAll /
//                                     forward all share the `send` action type)
//   authorizeObservation (audit-only): all reads
//
// All side-effecting actions go through the approval queue. Policy configuration
// determines which actions are auto-approved vs. requiring human review — it is
// not up to the gatekeeper to make that decision.
//
// Outbound-email semantics: send(), reply(), replyAll(), and forward() submit
// compact semantic actions (recipients/body/source message ID). Nothing is
// written to the user's mailbox before approval. applyAction() refetches any
// immutable source message, builds the raw RFC 5322/MIME payload, and delivers
// it via messages.send. There is therefore no pre-approval side effect, no
// large MIME blob in action storage, and no draft to clean up on rejection.

// ── Action types ────────────────────────────────────────────────────

type GmailAction =
  | { type: "archive" | "trash" | "markRead" | "markUnread"; threadId: string }
  | { type: "send"; to: string[]; subject: string; body: string }
  | {
      type: "reply";
      sourceMessageId: string;
      threadId: string;
      body: string;
      replyAll: boolean;
      sourceWasSent: boolean;
    }
  | { type: "forward"; sourceMessageId: string; to: string[]; body?: string };

// ── Session context ─────────────────────────────────────────────────
// Shared context passed to all stubs created within a session.

type GmailSessionContext = {
  gmailApi: GmailApi;
  approvalQueue: RpcStub<ApprovalQueue>;
  pendingActions: PendingActionStore<GmailAction>;
  // SESSION PATH: the raw search query passed to the Gmail API for listThreads/search.
  // This handles historical + new messages. See GmailGatekeeperImplProps.searchQuery.
  searchQuery: string | undefined;
  labelId: string | undefined;
  labelName: string | undefined;
  resolveLabels: (labelIds: string[]) => Promise<GmailLabel[]>;
};

// ── GmailSessionImpl ────────────────────────────────────────────────

const MAX_GMAIL_RECIPIENTS = 100;
const MAX_GMAIL_SUBJECT_BYTES = 998;
const MAX_GMAIL_BODY_BYTES = 64 * 1024;
const MAX_GMAIL_QUERY_BYTES = 4096;
const MAX_GMAIL_ADDRESS_BYTES = 320;
const MAX_GMAIL_VISIBLE_THREAD_MESSAGES = 100;

function validateOutboundInput(to: string[], subject: string, body: string): void {
  if (to.length === 0 || to.length > MAX_GMAIL_RECIPIENTS) {
    throw new Error(`Email must have between 1 and ${MAX_GMAIL_RECIPIENTS} recipients.`);
  }
  if (to.some(address => address.length === 0 ||
      new TextEncoder().encode(address).byteLength > MAX_GMAIL_ADDRESS_BYTES)) {
    throw new Error("Invalid recipient address length.");
  }
  if (new TextEncoder().encode(subject).byteLength > MAX_GMAIL_SUBJECT_BYTES) {
    throw new Error(`Email subject must be at most ${MAX_GMAIL_SUBJECT_BYTES} UTF-8 bytes.`);
  }
  if (new TextEncoder().encode(body).byteLength > MAX_GMAIL_BODY_BYTES) {
    throw new Error(`Email body must be at most ${MAX_GMAIL_BODY_BYTES} bytes.`);
  }
}

@validateRpc()
class GmailSessionImpl extends RpcTarget implements GmailSession {
  #ctx: GmailSessionContext;

  constructor(ctx: GmailSessionContext) {
    super();
    this.#ctx = ctx;
  }

  // TODO: The dup'd approvalQueue RPC stub should be disposed when the session
  // ends. Symbol.dispose requires esnext lib; revisit when the tsconfig target
  // is upgraded.

  async listThreads(): Promise<Cursor<GmailThreadEntry>> {
    const scopeDescription = this.#ctx.searchQuery
      ? "the connected Gmail search scope"
      : this.#ctx.labelId
        ? "the connected Gmail label scope"
        : "the Gmail inbox";

    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Gmail threads",
      description:
        `Create a cursor for the most recent threads in ${scopeDescription}.` +
        (this.#ctx.searchQuery
          ? `\n\n${formatApprovalField("Search restriction", this.#ctx.searchQuery)}`
          : "") +
        (this.#ctx.labelName
          ? `\n\n${formatApprovalField("Required label", this.#ctx.labelName)}`
          : ""),
    });

    const labelIds = this.#ctx.labelId
      ? [this.#ctx.labelId]
      : (!this.#ctx.searchQuery ? ["INBOX"] : undefined);
    return new GmailThreadCursorImpl(this.#ctx, this.#ctx.searchQuery, labelIds);
  }

  async search(query: string): Promise<Cursor<GmailThreadEntry>> {
    validateGmailQueryForGrouping(query);
    // A leading boolean operator could bind outside the appended group.
    if (this.#ctx.searchQuery && /^(OR|AND)\b/i.test(query.trim())) {
      throw new Error("Query cannot start with OR/AND.");
    }

    const effectiveQuery = this.#ctx.searchQuery
      ? `(${this.#ctx.searchQuery}) (${query})`
      : query;

    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Search Gmail",
      description:
        "Create a cursor for Gmail threads matching this effective query.\n\n" +
        formatApprovalField("Query", effectiveQuery) +
        (this.#ctx.labelName
          ? `\n\n${formatApprovalField("Required label", this.#ctx.labelName)}`
          : ""),
    });

    // A full-mailbox binding may search all mail. Only an explicit label scope
    // attenuates search results; listThreads() separately defaults to INBOX.
    const labelIds = this.#ctx.labelId ? [this.#ctx.labelId] : undefined;
    return new GmailThreadCursorImpl(this.#ctx, effectiveQuery, labelIds);
  }

  async send(to: string[], subject: string, body: string): Promise<void> {
    // send() composes a brand-new outbound message, which isn't tied to any
    // particular thread. For search/label-scoped bindings the user only
    // granted access to a subset of their mail, so composing arbitrary new
    // outbound mail is out of scope — reject it. (reply/forward remain
    // available, since those act on a specific message capability that the
    // caller already obtained through the scoped session.)
    if (this.#ctx.searchQuery || this.#ctx.labelId) {
      throw new Error(
        "send() is not available on a search- or label-scoped Gmail binding. " +
        "Use reply()/forward() on a specific message, or connect the full mailbox.");
    }

    validateOutboundInput(to, subject, body);
    const message = this.#ctx.gmailApi.buildSendRaw(to, subject, body);
    await submitGmailAction(
      this.#ctx,
      { type: "send", to: message.to, subject: message.subject, body: message.body },
      {
        title: sanitizeApprovalTitle(`Send email: ${message.subject}`),
        description: describeOutboundMessage("Send a new email.", message),
      });
  }
}

function sanitizeApprovalTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}

function formatApprovalField(label: string, value: string): string {
  // Use a fence longer than any backtick run in the value, so untrusted email
  // fields render verbatim and cannot forge surrounding approval Markdown.
  let fence = "```";
  while (value.includes(fence)) fence += "`";
  return `**${label}:**\n\n${fence}\n${value}\n${fence}`;
}

function describeOutboundMessage(intro: string, message: GmailOutboundMessage): string {
  let fields = [
    formatApprovalField("From", message.from),
    formatApprovalField("To", message.to.join(", ")),
    ...(message.cc.length > 0 ? [formatApprovalField("Cc", message.cc.join(", "))] : []),
    formatApprovalField("Subject", message.subject),
    formatApprovalField("Body", message.body),
    ...message.attachments.map(attachment => formatApprovalField(
      "Attachment",
      `${attachment.filename} (${attachment.contentType})\n${attachment.description}`)),
  ];
  return `${intro}\n\n${fields.join("\n\n")}`;
}

async function submitGmailAction(
    ctx: GmailSessionContext,
    action: GmailAction,
    desc: { title: string; description: string }): Promise<void> {
  if (ctx.pendingActions.list().length >= 100) {
    throw new Error("Too many pending Gmail actions. Resolve existing actions before adding more.");
  }
  let actionId = ctx.pendingActions.submit(action);
  try {
    await ctx.approvalQueue.submitAction(actionId, { ...desc, implementsRevert: false });
  } catch (err) {
    ctx.pendingActions.remove(actionId);
    throw err;
  }
}

// ── GmailThreadCursorImpl ───────────────────────────────────────────
// Lazily fetches pages from the Gmail API as the gadget calls next().
// Each next() returns a batch of GmailThreadEntry objects (thread info +
// capability), or null when exhausted. Pages are fetched in batches of 20.
//
// The cursor itself is a capability. The initial listThreads()/search() call
// authorizes creation; each next() separately authorizes the page it returns.

@validateRpc()
class GmailThreadCursorImpl extends RpcTarget implements Cursor<GmailThreadEntry> {
  #ctx: GmailSessionContext;
  #query: string | undefined;
  #labelIds: string[] | undefined;
  #pageToken: string | undefined;
  #exhausted = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(ctx: GmailSessionContext, query: string | undefined, labelIds?: string[]) {
    super();
    this.#ctx = ctx;
    this.#query = query;
    this.#labelIds = labelIds;
  }

  next(): Promise<GmailThreadEntry[] | null> {
    const result = this.#tail.then(() => this.#nextPage());
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #nextPage(): Promise<GmailThreadEntry[] | null> {
    if (this.#exhausted) return null;

    let result: {threads: Array<{id: string; snippet?: string}>; nextPageToken?: string};
    let pageToken = this.#pageToken;
    let exhausted = false;
    let skippedPages = 0;
    do {
      const previousToken = pageToken;
      result = await this.#ctx.gmailApi.listThreads(
        20, this.#query, pageToken, this.#labelIds);
      pageToken = result.nextPageToken;
      exhausted = !result.nextPageToken;
      if (result.nextPageToken && result.nextPageToken === previousToken) {
        throw new Error("Gmail returned a repeated thread page token.");
      }
      skippedPages++;
    } while (result.threads.length === 0 && !exhausted && skippedPages < 20);

    if (result.threads.length === 0) {
      if (!exhausted) throw new Error("Gmail returned too many empty thread pages.");
      this.#pageToken = pageToken;
      this.#exhausted = true;
      return null;
    }

    // Stay below the Workers six-outgoing-connection limit while enriching the
    // page with metadata.
    const entries: GmailThreadEntry[] = [];
    for (let i = 0; i < result.threads.length; i += 5) {
      const batch = await Promise.all(result.threads.slice(i, i + 5).map(async thread => {
        const metadata = await this.#ctx.gmailApi.getThreadInfo(thread.id);
        const info: GmailThreadInfo = {
          ...metadata,
          ...(thread.snippet !== undefined ? {snippet: thread.snippet} : {}),
        };
        const stub = new GmailThreadStub(this.#ctx, thread.id, info);
        return { info, thread: stub };
      }));
      entries.push(...batch);
    }

    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read ${entries.length} Gmail threads`,
      description:
        `Fetch the next page of Gmail threads.\n\n` +
        formatApprovalField("Subjects", entries.map(entry => entry.info.subject).join("\n")),
    });

    this.#pageToken = pageToken;
    this.#exhausted = exhausted;
    return entries;
  }
}

// ── GmailThreadStub ─────────────────────────────────────────────────

@validateRpc()
class GmailThreadStub extends RpcTarget implements GmailThread {
  #ctx: GmailSessionContext;
  #threadId: string;
  #cachedInfo: GmailThreadInfo | undefined;

  constructor(ctx: GmailSessionContext, threadId: string, cachedInfo?: GmailThreadInfo) {
    super();
    this.#ctx = ctx;
    this.#threadId = threadId;
    this.#cachedInfo = cachedInfo;
  }

  async #ensureInfo(): Promise<GmailThreadInfo> {
    if (!this.#cachedInfo) {
      this.#cachedInfo = await this.#ctx.gmailApi.getThreadInfo(this.#threadId);
    }
    return this.#cachedInfo;
  }

  async getMetadata(): Promise<GmailThreadInfo> {
    const info = await this.#ensureInfo();

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Thread info: ${info.subject}`),
      description: `Get metadata for thread ${this.#threadId}.`,
    });

    return info;
  }

  async messages(): Promise<GmailMessage[]> {
    const thread = await this.#ctx.gmailApi.getThread(this.#threadId);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Get messages: ${thread.snippet || "(no snippet)"}`),
      description: `Get all messages in thread ${this.#threadId}.`,
    });

    return thread.messages.map(message =>
      new GmailMessageStub(this.#ctx, message.id, this.#threadId)
    );
  }

  async messagesVisibleTo(address: string): Promise<GmailMessage[]> {
    if (new TextEncoder().encode(address).byteLength > MAX_GMAIL_ADDRESS_BYTES) {
      throw new Error(`Email address must be at most ${MAX_GMAIL_ADDRESS_BYTES} bytes.`);
    }
    const [normalizedAddress] = normalizeEmailRecipients([address]);
    const thread = await this.#ctx.gmailApi.getThread(this.#threadId);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Messages involving ${normalizedAddress}`),
      description:
        "List messages in this thread involving the requested address.\n\n" +
        formatApprovalField("Address", normalizedAddress) + "\n\n" +
        formatApprovalField("Thread snippet", thread.snippet || "(no snippet)"),
    });

    if (thread.messages.length > MAX_GMAIL_VISIBLE_THREAD_MESSAGES) {
      throw new Error(
        `Thread has ${thread.messages.length} messages; messagesVisibleTo() supports at most ` +
        `${MAX_GMAIL_VISIBLE_THREAD_MESSAGES}.`);
    }

    const target = normalizedAddress.toLowerCase();
    const visible: GmailMessage[] = [];
    // Fetch only participant metadata, at most five messages at once.
    for (let i = 0; i < thread.messages.length; i += 5) {
      const batch = thread.messages.slice(i, i + 5);
      const participantSets = await Promise.all(batch.map(message =>
        this.#ctx.gmailApi.getMessageParticipants(message.id).catch(err => {
          console.warn(`getMessageParticipants failed for ${message.id}:`, err);
          return null;
        })));
      for (let j = 0; j < batch.length; j++) {
        if (participantSets[j]?.has(target)) {
          visible.push(new GmailMessageStub(this.#ctx, batch[j].id, this.#threadId));
        }
      }
    }
    return visible;
  }

  async #submitThreadAction(
      type: "archive" | "trash" | "markRead" | "markUnread",
      titlePrefix: string,
      intro: string): Promise<void> {
    const info = await this.#ensureInfo();
    const subject = info.subject || "(no subject)";
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Read thread before ${titlePrefix.toLowerCase()}: ${subject}`),
      description: "Read the current Gmail thread metadata needed to prepare this action.",
    });
    await submitGmailAction(
      this.#ctx,
      { type, threadId: this.#threadId },
      {
        title: sanitizeApprovalTitle(`${titlePrefix}: ${subject}`),
        description:
          `${intro}\n\n` +
          formatApprovalField("Subject", subject) +
          (info.snippet !== undefined
            ? `\n\n${formatApprovalField("Snippet", info.snippet)}`
            : ""),
      });
  }

  async archive(): Promise<void> {
    await this.#submitThreadAction("archive", "Archive", "Remove this thread from the inbox.");
  }

  async trash(): Promise<void> {
    await this.#submitThreadAction("trash", "Trash", "Move this thread to trash.");
  }

  async markRead(): Promise<void> {
    await this.#submitThreadAction("markRead", "Mark read", "Mark every message in this thread as read.");
  }

  async markUnread(): Promise<void> {
    await this.#submitThreadAction("markUnread", "Mark unread", "Mark every message in this thread as unread.");
  }
}

// ── GmailMessageStub ────────────────────────────────────────────────

@validateRpc()
class GmailMessageStub extends RpcTarget implements GmailMessage {
  #ctx: GmailSessionContext;
  #messageId: string;
  #threadId: string;
  #cachedRaw: GmailMessageRaw | undefined;

  constructor(ctx: GmailSessionContext, messageId: string, threadId: string, cachedRaw?: GmailMessageRaw) {
    super();
    this.#ctx = ctx;
    this.#messageId = messageId;
    this.#threadId = threadId;
    this.#cachedRaw = cachedRaw;
  }

  async #getRaw(): Promise<GmailMessageRaw> {
    if (!this.#cachedRaw) {
      this.#cachedRaw = await this.#ctx.gmailApi.getMessage(this.#messageId);
    }
    return this.#cachedRaw;
  }

  async getMetadata(): Promise<GmailMessageInfo> {
    const raw = await this.#getRaw();
    const rawInfo = await this.#ctx.gmailApi.parseMessageInfo(raw);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Message info: ${rawInfo.subject}`),
      description: `Get metadata for message ${this.#messageId}.`,
    });

    // Resolve raw label IDs to GmailLabel objects.
    const labels = await this.#ctx.resolveLabels(rawInfo.labelIds);
    return {
      id: this.#messageId,
      from: rawInfo.from,
      to: rawInfo.to,
      cc: rawInfo.cc,
      subject: rawInfo.subject,
      timestamp: rawInfo.timestamp,
      labels,
    };
  }

  async thread(): Promise<GmailThread> {
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Get thread for message`,
      description: `Navigate from message ${this.#messageId} to its parent thread.`,
    });
    return new GmailThreadStub(this.#ctx, this.#threadId);
  }

  async getContent(): Promise<EmailContent> {
    const raw = await this.#getRaw();
    const { info, content } = await this.#ctx.gmailApi.parseMessage(raw);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Read message: ${info.subject}`),
      description: `Get body content of message ${this.#messageId}.`,
    });

    return content;
  }

  async reply(body: string): Promise<void> {
    if (new TextEncoder().encode(body).byteLength > MAX_GMAIL_BODY_BYTES) {
      throw new Error(`Email body must be at most ${MAX_GMAIL_BODY_BYTES} bytes.`);
    }
    const original = await this.#getRaw();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read message headers to prepare reply",
      description: "Read the source message headers needed to calculate reply recipients and threading.",
    });
    const message = await this.#ctx.gmailApi.buildReplyRaw(original, body, false);
    validateOutboundInput([...message.to, ...message.cc], message.subject, message.body);
    await submitGmailAction(
      this.#ctx,
      {
        type: "reply",
        sourceMessageId: this.#messageId,
        threadId: this.#threadId,
        body,
        replyAll: false,
        sourceWasSent: message.sourceWasSent,
      },
      {
        title: sanitizeApprovalTitle(`Reply: ${message.subject}`),
        description: describeOutboundMessage("Send a reply.", message),
      });
  }

  async replyAll(body: string): Promise<void> {
    if (new TextEncoder().encode(body).byteLength > MAX_GMAIL_BODY_BYTES) {
      throw new Error(`Email body must be at most ${MAX_GMAIL_BODY_BYTES} bytes.`);
    }
    const original = await this.#getRaw();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read message headers to prepare reply-all",
      description: "Read the source message headers needed to calculate reply-all recipients and threading.",
    });
    const message = await this.#ctx.gmailApi.buildReplyRaw(original, body, true);
    validateOutboundInput([...message.to, ...message.cc], message.subject, message.body);
    await submitGmailAction(
      this.#ctx,
      {
        type: "reply",
        sourceMessageId: this.#messageId,
        threadId: this.#threadId,
        body,
        replyAll: true,
        sourceWasSent: message.sourceWasSent,
      },
      {
        title: sanitizeApprovalTitle(`Reply all: ${message.subject}`),
        description: describeOutboundMessage("Send a reply to all recipients.", message),
      });
  }

  async forward(to: string[], body?: string): Promise<void> {
    const normalizedTo = normalizeEmailRecipients(to);
    if (normalizedTo.length === 0 || normalizedTo.length > MAX_GMAIL_RECIPIENTS) {
      throw new Error(`Email must have between 1 and ${MAX_GMAIL_RECIPIENTS} recipients.`);
    }
    if (new TextEncoder().encode(body ?? '').byteLength > MAX_GMAIL_BODY_BYTES) {
      throw new Error(`Email body must be at most ${MAX_GMAIL_BODY_BYTES} bytes.`);
    }
    const original = await this.#getRaw();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read message to prepare forward",
      description: "Read the complete source message and attachment metadata needed to prepare a forward.",
    });
    const message = await this.#ctx.gmailApi.buildForwardRaw(original, normalizedTo, body);
    validateOutboundInput(message.to, message.subject, message.body);
    await submitGmailAction(
      this.#ctx,
      { type: "forward", sourceMessageId: this.#messageId, to: normalizedTo, body },
      {
        title: sanitizeApprovalTitle(`Forward: ${message.subject}`),
        description: describeOutboundMessage(
          "Forward an existing message. The complete original email is attached losslessly.",
          message),
      });
  }
}

// =======================================================================================

type GmailGatekeeperImplProps = {
  userObjectId: string;

  // Optional free-form Gmail search restriction.
  searchQuery?: string;

  // Optional exact Gmail label name. Resolved to a label ID at session start;
  // never interpolated into Gmail search syntax.
  labelName?: string;
}

@validateRpc()
export class GmailGatekeeperImpl extends DurableObject<Env, GmailGatekeeperImplProps>
    implements Gatekeeper<GmailSession> {
  #accessToken: GoogleAccessToken | undefined;

  async #getAccessToken(): Promise<string> {
    if (!this.#accessToken) {
      let stub = this.ctx.exports.UserAccount.get(
          this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
      this.#accessToken = await stub.getAccessToken();

      let ttl = this.#accessToken.expires.valueOf() - Date.now();
      setTimeout(() => { this.#accessToken = undefined; }, ttl / 2);
    }
    return this.#accessToken.token;
  }

  async #getSelfEmail(): Promise<string> {
    let cached = this.ctx.storage.kv.get<string>("selfEmail");
    if (cached) return cached;

    let token = await this.#getAccessToken();
    let desc = await getGoogleAccountDescription(token);
    if (!desc.uniqueName) {
      throw new Error("Google account has no email address");
    }
    this.ctx.storage.kv.put("selfEmail", desc.uniqueName);
    return desc.uniqueName;
  }

  async describe(): Promise<ResourceDescription> {
    const labelName = this.ctx.props.labelName;
    if (labelName) {
      return {
        url: `https://mail.google.com/mail/#label/${encodeURIComponent(labelName)}`,
        title: `Gmail label: ${labelName}`,
        snippet: `Gmail threads with label: ${labelName}`,
        suggestedBindingName: "GMAIL_LABEL",
        tsType: "GmailSession",
      };
    }

    let searchQuery = this.ctx.props.searchQuery;
    if (searchQuery) {
      return {
        url: `https://mail.google.com/mail/#search/${encodeURIComponent(searchQuery)}`,
        title: `Gmail: ${searchQuery}`,
        snippet: `Gmail threads matching: ${searchQuery}`,
        suggestedBindingName: "GMAIL_SEARCH",
        tsType: "GmailSession",
      };
    }

    return {
      url: "https://mail.google.com/mail/",
      title: "Gmail Inbox",
      snippet: "Your personal Gmail inbox",
      suggestedBindingName: "GMAIL_INBOX",
      tsType: "GmailSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GmailSession> {
    let selfEmail = await this.#getSelfEmail();
    let gmailApi = new GmailApi(selfEmail, () => this.#getAccessToken());

    // In-memory label map cache for the session lifetime. Fetched once on
    // first label resolution, shared across all stubs in this session.
    let labelMapCache: Map<string, string> | undefined;
    const getLabelMap = async () => {
      if (!labelMapCache) labelMapCache = await gmailApi.listLabels();
      return labelMapCache;
    };
    let labelId: string | undefined;
    if (this.ctx.props.labelName) {
      const labelMap = await getLabelMap();
      labelId = [...labelMap].find(([, name]) => name === this.ctx.props.labelName)?.[0];
      if (!labelId) {
        throw new Error(`Gmail label not found: ${this.ctx.props.labelName}`);
      }
    }

    const ctx: GmailSessionContext = {
      gmailApi,
      approvalQueue: approvalQueue.dup(),
      pendingActions: new PendingActionStore<GmailAction>(this.ctx.storage.kv),
      searchQuery: this.ctx.props.searchQuery,
      labelId,
      labelName: this.ctx.props.labelName,
      resolveLabels: async (labelIds: string[]): Promise<GmailLabel[]> =>
        toLabelObjects(labelIds, await getLabelMap()),
    };

    return new GmailSessionImpl(ctx);
  }

  // ---------------------------------------------------------------------------
  async applyAction(actionId: number): Promise<void> {
    const pendingActions = new PendingActionStore<GmailAction>(this.ctx.storage.kv);
    const action = pendingActions.get(actionId);
    if (!action) throw new Error(`Unknown pending Gmail action: ${actionId}`);

    const selfEmail = await this.#getSelfEmail();
    const gmailApi = new GmailApi(selfEmail, () => this.#getAccessToken());

    switch (action.type) {
      case "archive":
        await gmailApi.modifyThread(action.threadId, [], ["INBOX"]);
        break;
      case "trash":
        await gmailApi.trashThread(action.threadId);
        break;
      case "markRead":
        await gmailApi.modifyThread(action.threadId, [], ["UNREAD"]);
        break;
      case "markUnread":
        await gmailApi.modifyThread(action.threadId, ["UNREAD"], []);
        break;
      case "send": {
        const message = gmailApi.buildSendRaw(action.to, action.subject, action.body);
        await gmailApi.sendRawMessage(message.raw);
        break;
      }
      case "reply": {
        const original = await gmailApi.getMessage(action.sourceMessageId);
        const message = await gmailApi.buildReplyRaw(
          original, action.body, action.replyAll, action.sourceWasSent);
        await gmailApi.sendRawMessage(message.raw, action.threadId);
        break;
      }
      case "forward": {
        const original = await gmailApi.getMessage(action.sourceMessageId);
        const message = await gmailApi.buildForwardRaw(original, action.to, action.body);
        await gmailApi.sendRawMessage(message.raw);
        break;
      }
      default:
        action satisfies never;
        throw new Error(`unknown action type: ${(action as {type: string}).type}`);
    }

    pendingActions.remove(actionId);
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    const pendingActions = new PendingActionStore<GmailAction>(this.ctx.storage.kv);
    if (!pendingActions.get(actionId)) {
      throw new Error(`Unknown pending Gmail action: ${actionId}`);
    }
    pendingActions.remove(actionId);
  }

  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("revert is not implemented");
  }
}

// =======================================================================================
// Google Docs Gatekeeper
// =======================================================================================

type GoogleDocActionBase = {
  documentId: string;
  submittedAt: number;
  baseRevisionId: string;
  invalidatedReason?: string;
}

type GoogleDocReplaceAction = GoogleDocActionBase & {
  type: "replaceText";
  oldMarkdown: string;
  newMarkdown: string;
}

type GoogleDocAppendAction = GoogleDocActionBase & {
  type: "appendText";
  markdown: string;
}

type GoogleDocAction = GoogleDocReplaceAction | GoogleDocAppendAction;

type GoogleDocPendingAction = {id: number, action: GoogleDocAction};

type GoogleDocSimulatedContentCache = {
  baseRevisionId: string;
  pendingFingerprint: string;
  markdown: string;
  pendingActions: GoogleDocAction[];
  computedAt: number;
}

type GoogleDocSimulationCacheHolder = {
  current?: GoogleDocSimulatedContentCache;
}

function googleDocPendingFingerprint(pending: GoogleDocPendingAction[]): string {
  return JSON.stringify(pending);
}

function previewMarkdown(markdown: string, maxLength: number): string {
  return markdown.length > maxLength ? markdown.slice(0, maxLength) + "..." : markdown;
}

function findUniqueMarkdown(markdown: string, oldMarkdown: string, operation: string): number {
  if (oldMarkdown.length === 0) {
    throw new Error(`${operation}: oldMarkdown must not be empty.`);
  }

  let index = markdown.indexOf(oldMarkdown);
  if (index === -1) {
    throw new Error(
      `${operation}: oldMarkdown was not found in the current simulated document. ` +
      `Make sure the text exactly matches content returned by getContent().`);
  }

  let secondIndex = markdown.indexOf(oldMarkdown, index + 1);
  if (secondIndex !== -1) {
    throw new Error(
      `${operation}: oldMarkdown matches multiple locations in the current simulated document. ` +
      `Include more surrounding context to make the match unique.`);
  }

  return index;
}

function applyMarkdownReplacement(
  markdown: string,
  oldMarkdown: string,
  newMarkdown: string,
  operation: string,
): string {
  if (oldMarkdown === newMarkdown) {
    return markdown;
  }

  let index = findUniqueMarkdown(markdown, oldMarkdown, operation);
  return markdown.slice(0, index) + newMarkdown + markdown.slice(index + oldMarkdown.length);
}

function appendMarkdownForSimulation(markdown: string, appendedMarkdown: string): string {
  let normalizedAppend = appendedMarkdown.endsWith("\n") ? appendedMarkdown : appendedMarkdown + "\n";

  if (markdown.length === 0) {
    return normalizedAppend;
  }

  if (markdown.endsWith("\n\n")) {
    return markdown + normalizedAppend;
  }

  if (markdown.endsWith("\n")) {
    return markdown + "\n" + normalizedAppend;
  }

  return markdown + "\n\n" + normalizedAppend;
}

function applyGoogleDocActionToMarkdown(markdown: string, action: GoogleDocAction): string {
  if (action.invalidatedReason) {
    throw new Error(action.invalidatedReason);
  }

  switch (action.type) {
    case "replaceText":
      return applyMarkdownReplacement(
          markdown, action.oldMarkdown, action.newMarkdown, "replaceText");
    case "appendText":
      return appendMarkdownForSimulation(markdown, action.markdown);
    default:
      action satisfies never;
      throw new Error(`unknown action type: ${(action as any).type}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidateGoogleDocAction(
  pendingActions: PendingActionStore<GoogleDocAction>,
  pending: GoogleDocPendingAction,
  reason: string,
): void {
  if (!pending.action.invalidatedReason) {
    pending.action.invalidatedReason = reason;
    pendingActions.put(pending.id, pending.action);
  }
}

function invalidateUnreplayableGoogleDocActions(
  pendingActions: PendingActionStore<GoogleDocAction>,
  baseMarkdown: string,
  pending: GoogleDocPendingAction[],
  context: string,
): {markdown: string, pendingActions: GoogleDocAction[]} {
  let markdown = baseMarkdown;
  let replayedActions: GoogleDocAction[] = [];
  for (let i = 0; i < pending.length; i++) {
    let action = pending[i].action;
    if (action.invalidatedReason) {
      continue;
    }

    try {
      markdown = applyGoogleDocActionToMarkdown(markdown, action);
    } catch (error) {
      invalidateGoogleDocAction(
          pendingActions,
          pending[i],
          `${context}: ${errorMessage(error)} This edit was dropped from the document. ` +
          `Reject it and retry if it is still needed.`);
      continue;
    }
    replayedActions.push(action);
  }

  return {markdown, pendingActions: replayedActions};
}

function materializeGoogleDocAction(snapshot: DocSnapshot, action: GoogleDocAction): any[] {
  if (action.invalidatedReason) {
    throw new Error(action.invalidatedReason);
  }

  switch (action.type) {
    case "replaceText": {
      let matchStart = findUniqueMarkdown(
          snapshot.markdown, action.oldMarkdown, "applyAction(replaceText)");
      let result = computeReplaceOperations(
          snapshot.sourceMap,
          snapshot.markdown,
          matchStart,
          matchStart + action.oldMarkdown.length,
          action.newMarkdown);
      return result.requests;
    }

    case "appendText": {
      let insertAt = snapshot.bodyEndIndex - 1;
      return markdownToDocRequests("\n" + action.markdown, insertAt);
    }

    default:
      action satisfies never;
      throw new Error(`unknown action type: ${(action as any).type}`);
  }
}

type GoogleDocGatekeeperImplProps = {
  userObjectId: string;
  documentId: string;
}

@validateRpc()
export class GoogleDocGatekeeperImpl
    extends DurableObject<Env, GoogleDocGatekeeperImplProps>
    implements Gatekeeper<GoogleDocSession> {
  #accessToken: GoogleAccessToken | undefined;
  #simulationCache: GoogleDocSimulationCacheHolder = {};

  async #getAccessToken(): Promise<string> {
    if (!this.#accessToken) {
      let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
          this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
      this.#accessToken = await stub.getAccessToken();

      let ttl = this.#accessToken.expires.valueOf() - Date.now();
      setTimeout(() => { this.#accessToken = undefined; }, ttl / 2);
    }
    return this.#accessToken.token;
  }

  async describe(): Promise<ResourceDescription> {
    let api = new GoogleDocsApi(() => this.#getAccessToken());
    let doc = await api.getDocument(this.ctx.props.documentId);
    return {
      url: `https://docs.google.com/document/d/${this.ctx.props.documentId}/edit`,
      title: doc.title,
      snippet: `Google Doc: ${doc.title}`,
      suggestedBindingName: "GOOGLE_DOC",
      tsType: "GoogleDocSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return DOCS_TYPES_CODE;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GoogleDocSession> {
    let api = new GoogleDocsApi(() => this.#getAccessToken());
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    return new GoogleDocSessionImpl(
        api,
        this.ctx.props.documentId,
        approvalQueue.dup(),
        pendingActions,
        this.ctx.storage,
        this.#simulationCache);
  }

  async applyAction(actionId: number): Promise<void> {
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let pendingIndex = pending.findIndex(({id}) => id === actionId);
    if (pendingIndex === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }
    let pendingRecord = pending[pendingIndex];

    let action = pendingRecord.action;
    if (action.invalidatedReason) {
      pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      return;
    }

    let firstPending = pending.find(({action}) => !action.invalidatedReason);
    if (firstPending?.id !== actionId) {
      throw new Error(
        `Google Doc edits must be approved in order. Approve earlier edit ` +
        `${firstPending?.id} before edit ${actionId}.`);
    }

    let api = new GoogleDocsApi(() => this.#getAccessToken());
    let doc = await api.getDocument(action.documentId);
    let snapshot = docToMarkdown(doc);
    let requests: any[];
    try {
      requests = materializeGoogleDocAction(snapshot, action);
    } catch (error) {
      console.error("Dropping stale Google Doc action during apply", error);
      pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      await this.ctx.storage.put("docSnapshot", snapshot);
      invalidateUnreplayableGoogleDocActions(
          pendingActions,
          snapshot.markdown,
          pending.slice(pendingIndex + 1),
          `Pending Google Doc edits could not be replayed after edit ${actionId} was dropped`);
      return;
    }
    if (requests.length > 0) {
      await api.batchUpdate(action.documentId, requests, snapshot.revisionId);
    }
    pendingActions.remove(actionId);
    this.#simulationCache.current = undefined;

    try {
      let refreshedSnapshot = snapshot;
      if (requests.length > 0) {
        refreshedSnapshot = docToMarkdown(await api.getDocument(action.documentId));
      }
      await this.ctx.storage.put("docSnapshot", refreshedSnapshot);
      invalidateUnreplayableGoogleDocActions(
          pendingActions,
          refreshedSnapshot.markdown,
          pending.slice(pendingIndex + 1),
          `Pending Google Doc edits could not be replayed after edit ${actionId} was applied`);
    } catch (error) {
      console.error("Failed to refresh Google Doc simulation after applying action", error);
      await this.ctx.storage.delete("docSnapshot");
    }
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let index = pending.findIndex(({id}) => id === actionId);
    if (index === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }

    let wasActive = !pending[index].action.invalidatedReason;

    pendingActions.remove(actionId);
    this.#simulationCache.current = undefined;
    await this.ctx.storage.delete("docSnapshot");

    if (wasActive && index < pending.length - 1) {
      return {restart: true};
    }
  }

  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("revert is not implemented");
  }
}

@validateRpc()
class GoogleDocSessionImpl extends RpcTarget implements GoogleDocSession {
  #docsApi: GoogleDocsApi;
  #documentId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pendingActions: PendingActionStore<GoogleDocAction>;
  #storage: DurableObjectStorage;
  #simulationCache: GoogleDocSimulationCacheHolder;

  constructor(
    docsApi: GoogleDocsApi,
    documentId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    pendingActions: PendingActionStore<GoogleDocAction>,
    storage: DurableObjectStorage,
    simulationCache: GoogleDocSimulationCacheHolder,
  ) {
    super();
    this.#docsApi = docsApi;
    this.#documentId = documentId;
    this.#approvalQueue = approvalQueue;
    this.#pendingActions = pendingActions;
    this.#storage = storage;
    this.#simulationCache = simulationCache;
  }

  async #getSnapshot(forceRefresh?: boolean): Promise<DocSnapshot> {
    if (!forceRefresh) {
      let cached = await this.#storage.get<DocSnapshot>("docSnapshot");
      if (cached) {
        let age = Date.now() - cached.fetchedAt;
        if (age < 10_000) {
          return cached;
        }
        // TTL expired — check if document has changed.
        let currentRevisionId = await this.#docsApi.getRevisionId(this.#documentId);
        if (currentRevisionId === cached.revisionId) {
          cached.fetchedAt = Date.now();
          await this.#storage.put("docSnapshot", cached);
          return cached;
        }
      }
    }

    // Fetch full document and build snapshot.
    let doc = await this.#docsApi.getDocument(this.#documentId);
    let snapshot = docToMarkdown(doc);
    await this.#storage.put("docSnapshot", snapshot);
    return snapshot;
  }

  async #getSimulatedContent(): Promise<{
    snapshot: DocSnapshot,
    markdown: string,
    pendingActions: GoogleDocAction[],
  }> {
    let snapshot = await this.#getSnapshot();
    let pending = this.#pendingActions.list();
    let pendingFingerprint = googleDocPendingFingerprint(pending);
    let cached = this.#simulationCache.current;
    if (cached && cached.baseRevisionId === snapshot.revisionId &&
        cached.pendingFingerprint === pendingFingerprint) {
      return {
        snapshot,
        markdown: cached.markdown,
        pendingActions: cached.pendingActions,
      };
    }

    let {markdown, pendingActions} = invalidateUnreplayableGoogleDocActions(
        this.#pendingActions,
        snapshot.markdown,
        pending,
        "Pending Google Doc edit could not be replayed against the current document");
    this.#simulationCache.current = {
      baseRevisionId: snapshot.revisionId,
      pendingFingerprint: googleDocPendingFingerprint(this.#pendingActions.list()),
      markdown,
      pendingActions,
      computedAt: Date.now(),
    };
    return {snapshot, markdown, pendingActions};
  }

  async getMetadata(): Promise<DocMetadata> {
    let {snapshot, pendingActions} = await this.#getSimulatedContent();

    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Doc metadata",
      description: "Read the title and modification time of the document.",
    });

    // The Docs API doesn't return lastModified directly (that's a Drive API field).
    // For now, use the fetch timestamp as an approximation.
    // TODO: Use Drive API files.get for actual modifiedTime.
    let lastModified = pendingActions.reduce(
        (latest, action) => Math.max(latest, action.submittedAt), snapshot.fetchedAt);
    return {
      title: snapshot.title ?? "Untitled document",
      lastModified: new Date(lastModified),
    };
  }

  async getContent(): Promise<string> {
    let {markdown} = await this.#getSimulatedContent();

    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Doc content",
      description: "Read the full simulated content of the document as Markdown.",
    });

    return markdown;
  }

  async replaceText(oldMarkdown: string, newMarkdown: string): Promise<void> {
    if (oldMarkdown === newMarkdown) {
      return;
    }

    let {snapshot, markdown} = await this.#getSimulatedContent();
    findUniqueMarkdown(markdown, oldMarkdown, "replaceText");

    let action: GoogleDocAction = {
      type: "replaceText",
      documentId: this.#documentId,
      submittedAt: Date.now(),
      baseRevisionId: snapshot.revisionId,
      oldMarkdown,
      newMarkdown,
    };

    let oldPreview = previewMarkdown(oldMarkdown, 80);
    let newPreview = previewMarkdown(newMarkdown, 80);
    let actionId = this.#pendingActions.submit(action);
    this.#simulationCache.current = undefined;

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "Edit Google Doc",
        description:
          `Replace text in the document.\n\n` +
          `**Old:** ${oldPreview}\n\n` +
          `**New:** ${newPreview}`,
        implementsRevert: false,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      throw error;
    }
  }

  async appendText(markdown: string): Promise<void> {
    let {snapshot} = await this.#getSimulatedContent();

    let action: GoogleDocAction = {
      type: "appendText",
      documentId: this.#documentId,
      submittedAt: Date.now(),
      baseRevisionId: snapshot.revisionId,
      markdown,
    };

    let preview = previewMarkdown(markdown, 100);
    let actionId = this.#pendingActions.submit(action);
    this.#simulationCache.current = undefined;

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "Append to Google Doc",
        description: `Append content to the end of the document:\n\n${preview}`,
        implementsRevert: false,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      throw error;
    }
  }
}

// =======================================================================================
// BigQuery Gatekeeper
// =======================================================================================
//
// Scope enforcement: when a session is scoped to a project/dataset/table, every query is
// dry-run first (via `BigQueryApi.dryRun`) and rejected if it references tables outside the
// scope. The dry-run also gives us the bytesProcessed estimate, which we cross-check against
// `maximumBytesBilled` before actually executing — defense in depth, since BigQuery will also
// enforce maximumBytesBilled server-side.

type BigQueryGatekeeperImplProps = {
  userObjectId: string;
  // When set, narrows the session's authority. Project is required for any narrower scope.
  scopedProjectId?: string;
  scopedDatasetId?: string;
  scopedTableId?: string;
};

@validateRpc()
export class BigQueryGatekeeperImpl
    extends DurableObject<Env, BigQueryGatekeeperImplProps>
    implements Gatekeeper<BigQuerySession> {
  #accessToken: GoogleAccessToken | undefined;

  async #getAccessToken(): Promise<string> {
    if (!this.#accessToken || this.#accessToken.expires.valueOf() <= Date.now() + 30_000) {
      let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
      this.#accessToken = await stub.getAccessToken();
    }
    return this.#accessToken.token;
  }

  async describe(): Promise<ResourceDescription> {
    let { scopedProjectId: p, scopedDatasetId: d, scopedTableId: t } = this.ctx.props;
    let path = p ? (d ? (t ? `/${p}/${d}/${t}` : `/${p}/${d}`) : `/${p}`) : "";
    let label = t ? `${p}.${d}.${t}` : d ? `${p}.${d}` : p ?? null;
    return {
      url: `https://${BIGQUERY_HOST}${path}`,
      title: label ? `BigQuery (${label})` : "BigQuery",
      snippet: t
          ? `Query BigQuery table "${p}.${d}.${t}" (read-only)`
          : d
              ? `Query BigQuery dataset "${p}.${d}" (read-only)`
              : p
                  ? `Query BigQuery datasets in project "${p}" (read-only)`
                  : "Browse BigQuery projects and datasets (read-only)",
      suggestedBindingName: "BIGQUERY",
      tsType: "BigQuerySession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return BIGQUERY_TYPES_CODE;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<BigQuerySession> {
    let api = new BigQueryApi(() => this.#getAccessToken());
    return new BigQuerySessionImpl(
      api,
      approvalQueue.dup(),
      this.ctx.props.scopedProjectId,
      this.ctx.props.scopedDatasetId,
      this.ctx.props.scopedTableId,
    );
  }

  // Read-only — no side-effecting actions.
  async applyAction(_action: number): Promise<void> {}
  async rejectAction(_action: number): Promise<void> {}
  revertAction(_action: number): Promise<void> {
    throw new Error("BigQuery gatekeeper has no writable actions to revert");
  }
}

@validateRpc()
class BigQuerySessionImpl extends RpcTarget implements BigQuerySession {
  #api: BigQueryApi;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #scopedProjectId?: string;
  #scopedDatasetId?: string;
  #scopedTableId?: string;

  constructor(
    api: BigQueryApi,
    approvalQueue: RpcStub<ApprovalQueue>,
    scopedProjectId?: string,
    scopedDatasetId?: string,
    scopedTableId?: string,
  ) {
    super();
    this.#api = api;
    this.#approvalQueue = approvalQueue;
    this.#scopedProjectId = scopedProjectId;
    this.#scopedDatasetId = scopedDatasetId;
    this.#scopedTableId = scopedTableId;
  }

  // --- helpers -----------------------------------------------------------

  // Pick the project to bill the query against. When scoped, the scoped project is used and
  // the caller cannot override. When unscoped, the caller must declare a default project via
  // `defaultDataset.projectId` (BigQuery requires a billing project on every query).
  #billingProject(): string {
    if (this.#scopedProjectId) return this.#scopedProjectId;
    throw new Error(
      "This session is not scoped to a project. Connect to a specific BigQuery project " +
      "(e.g. https://bigquery.googleapis.com/my-project) to run queries.");
  }

  #effectiveDataset(opts: { defaultDataset?: string } | undefined): string | undefined {
    if (this.#scopedDatasetId) {
      if (opts?.defaultDataset && opts.defaultDataset !== this.#scopedDatasetId) {
        throw new Error(
          `Cannot override defaultDataset to "${opts.defaultDataset}" — this connection is ` +
          `scoped to "${this.#scopedDatasetId}".`);
      }
      return this.#scopedDatasetId;
    }
    return opts?.defaultDataset;
  }

  // Note: callers can still probe whether out-of-scope tables exist by attempting queries
  // and observing which error class fires (out-of-scope vs. not-found vs. DML-rejected).
  // The data is protected; the namespace is partly leaky.
  #checkScopedTables(referenced: string[]): void {
    if (!this.#scopedProjectId) throw new Error("BigQuery queries require a project-scoped binding.");
    // Empty referencedTables is fine for project-only scope (e.g. `SELECT 1`,
    // `SELECT CURRENT_TIMESTAMP()`) — there are no tables to scope-check. Only require
    // at least one referenced table when the binding narrows to a specific dataset or
    // table, since otherwise there's nothing to verify the scope against.
    if (referenced.length === 0) {
      if (this.#scopedDatasetId || this.#scopedTableId) {
        throw new Error(
          "BigQuery dry run did not report any referenced tables; refusing to execute because " +
          "resource scope cannot be verified.");
      }
      return;
    }
    for (let ref of referenced) {
      let parts = ref.split(".");
      if (parts.length !== 3) {
        throw new Error(`Could not parse referenced table "${ref}".`);
      }
      let [proj, ds, tbl] = parts;
      if (proj !== this.#scopedProjectId) {
        throw new Error(
          `Query references project "${proj}" but this connection is scoped to ` +
          `"${this.#scopedProjectId}".`);
      }
      if (this.#scopedDatasetId && ds !== this.#scopedDatasetId) {
        throw new Error(
          `Query references dataset "${proj}.${ds}" but this connection is scoped to ` +
          `"${this.#scopedProjectId}.${this.#scopedDatasetId}".`);
      }
      if (this.#scopedTableId && tbl !== this.#scopedTableId) {
        throw new Error(
          `Query references table "${ref}" but this connection is scoped to ` +
          `"${this.#scopedProjectId}.${this.#scopedDatasetId}.${this.#scopedTableId}".`);
      }
    }
  }

  #assertReadOnlyEstimate(estimate: {
    statementType?: string;
    ddlOperationPerformed?: string;
    hasScript: boolean;
    hasDmlStats: boolean;
    referencedRoutines?: string[];
  }): void {
    if (estimate.hasScript || estimate.statementType === "SCRIPT") {
      throw new Error("Only single-statement read-only SELECT queries are allowed.");
    }
    if (estimate.ddlOperationPerformed) {
      throw new Error("DDL statements are not allowed.");
    }
    if (estimate.hasDmlStats) {
      throw new Error("DML statements are not allowed.");
    }
    // Allowlist (fail-closed): require an explicit SELECT statementType. BigQuery's dry-run
    // doesn't always populate statementType for every form, so a missing value should be
    // treated as "unknown" and rejected — not assumed safe just because the explicit DDL/DML
    // guards above didn't trip.
    if (!estimate.statementType) {
      throw new Error(
        "BigQuery dry run did not report a statement type; refusing to execute.");
    }
    if (estimate.statementType !== "SELECT") {
      throw new Error(
        `Only read-only SELECT queries are allowed (got ${estimate.statementType}).`);
    }
    if (estimate.referencedRoutines && estimate.referencedRoutines.length > 0) {
      throw new Error(
        "Queries that reference routines are not allowed because their data access cannot " +
        "be scoped by referencedTables.");
    }
  }

  // --- API ---------------------------------------------------------------

  async query(sql: string, opts?: BigQueryQueryOptions): Promise<BigQueryQueryResult> {
    let billingProject = this.#billingProject();
    let defaultDataset = this.#effectiveDataset(opts);
    let maxBytes = opts?.maximumBytesBilled ?? DEFAULT_MAX_BYTES_BILLED;

    // Always dry-run first to enforce scope and get a cost estimate. Dry-runs are free
    // (BigQuery doesn't bill for them), and the response includes `referencedTables`
    // parsed by Google's own SQL engine — the only reliable way to check scope on
    // arbitrary SQL.
    let estimate = await this.#api.dryRun(billingProject, sql, {
      defaultDataset, params: opts?.params,
    });
    this.#assertReadOnlyEstimate(estimate);
    this.#checkScopedTables(estimate.referencedTables);
    if (estimate.bytesProcessed > maxBytes) {
      throw new Error(
        `Query would process ${(estimate.bytesProcessed / 1e9).toFixed(2)} GB, exceeding the ` +
        `limit of ${(maxBytes / 1e9).toFixed(2)} GB. Pass a higher \`maximumBytesBilled\` to ` +
        `override.`);
    }

    let preview = sql.replace(/\s+/g, " ").trim().slice(0, 200);
    await this.#approvalQueue.authorizeObservation({
      title: `BigQuery query: ${preview}`,
      description:
        `SQL preview: \`${preview}\`${sql.length > preview.length ? "..." : ""}\n` +
        (defaultDataset ? `Default dataset: \`${defaultDataset}\`\n` : "") +
        `Billing project: \`${billingProject}\`\n` +
        `Referenced tables: ${estimate.referencedTables.join(", ")}\n` +
        `Estimated bytes processed: ${estimate.bytesProcessed.toLocaleString()}\n` +
        `Maximum bytes billed: ${maxBytes.toLocaleString()}.`,
    });

    let result = await this.#api.query(billingProject, sql, {
      ...opts,
      defaultDataset,
      maximumBytesBilled: maxBytes,
    });

    return result;
  }

  async dryRun(
    sql: string,
    opts?: Pick<BigQueryQueryOptions, "defaultDataset" | "params">,
  ): Promise<BigQueryDryRunResult> {
    let billingProject = this.#billingProject();
    let defaultDataset = this.#effectiveDataset(opts);

    let estimate = await this.#api.dryRun(billingProject, sql, {
      defaultDataset, params: opts?.params,
    });
    this.#assertReadOnlyEstimate(estimate);
    this.#checkScopedTables(estimate.referencedTables);

    let preview = sql.replace(/\s+/g, " ").trim().slice(0, 100);
    await this.#approvalQueue.authorizeObservation({
      title: `BigQuery dry run: ${preview}`,
      description:
        `Estimated bytes processed: ${estimate.bytesProcessed.toLocaleString()}\n` +
        `Referenced tables: ${estimate.referencedTables.join(", ") || "(none)"}`,
    });

    return estimate;
  }

  async getProject(): Promise<BigQueryProject> {
    let result: BigQueryProject = { projectId: this.#scopedProjectId! };
    await this.#approvalQueue.authorizeObservation({
      title: "Get BigQuery project",
      description: `Returned the scoped project: \`${this.#scopedProjectId}\`.`,
    });
    return result;
  }

  async listDatasets(projectId?: string): Promise<BigQueryDataset[]> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `Cannot list datasets in "${projectId}" — this connection is scoped to ` +
        `"${this.#scopedProjectId}".`);
    }
    let p = this.#scopedProjectId ?? projectId;
    if (!p) {
      throw new Error("listDatasets requires a projectId when the session is unscoped.");
    }

    if (this.#scopedDatasetId) {
      let dataset = await this.#api.getDataset(p, this.#scopedDatasetId);
      await this.#approvalQueue.authorizeObservation({
        title: `List datasets in ${p}`,
        description: `Returned scoped dataset \`${p}.${this.#scopedDatasetId}\` (1 dataset).`,
      });
      return [dataset];
    }

    let result = await this.#api.listDatasets(p);
    await this.#approvalQueue.authorizeObservation({
      title: `List datasets in ${p}`,
      description: `Listed ${result.length} dataset(s) in \`${p}\`.`,
    });
    return result;
  }

  async listTables(datasetId?: string, projectId?: string): Promise<BigQueryTable[]> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `Cannot list tables in project "${projectId}" — this connection is scoped to ` +
        `"${this.#scopedProjectId}".`);
    }
    if (this.#scopedDatasetId && datasetId && datasetId !== this.#scopedDatasetId) {
      throw new Error(
        `Cannot list tables in dataset "${datasetId}" — this connection is scoped to ` +
        `"${this.#scopedDatasetId}".`);
    }
    let p = this.#scopedProjectId ?? projectId;
    let d = this.#scopedDatasetId ?? datasetId;
    if (!p) throw new Error("listTables requires a projectId when the session is unscoped.");
    if (!d) throw new Error("listTables requires a datasetId when the session is unscoped.");

    if (this.#scopedTableId) {
      let { table } = await this.#api.getTable(p, d, this.#scopedTableId);
      await this.#approvalQueue.authorizeObservation({
        title: `List tables in ${p}.${d}`,
        description: `Returned scoped table \`${p}.${d}.${this.#scopedTableId}\` (1 table).`,
      });
      return [table];
    }

    let result = await this.#api.listTables(p, d);
    await this.#approvalQueue.authorizeObservation({
      title: `List tables in ${p}.${d}`,
      description: `Listed ${result.length} table(s) in \`${p}.${d}\`.`,
    });
    return result;
  }

  async describeTable(
    tableId?: string,
    datasetId?: string,
    projectId?: string,
  ): Promise<{ table: BigQueryTable; schema: BigQueryField[] }> {
    if (this.#scopedProjectId && projectId && projectId !== this.#scopedProjectId) {
      throw new Error(
        `Cannot describe table in project "${projectId}" — this connection is scoped to ` +
        `"${this.#scopedProjectId}".`);
    }
    if (this.#scopedDatasetId && datasetId && datasetId !== this.#scopedDatasetId) {
      throw new Error(
        `Cannot describe table in dataset "${datasetId}" — this connection is scoped to ` +
        `"${this.#scopedDatasetId}".`);
    }
    if (this.#scopedTableId && tableId && tableId !== this.#scopedTableId) {
      throw new Error(
        `Cannot describe table "${tableId}" — this connection is scoped to ` +
        `"${this.#scopedTableId}".`);
    }
    let p = this.#scopedProjectId ?? projectId;
    let d = this.#scopedDatasetId ?? datasetId;
    let t = this.#scopedTableId ?? tableId;
    if (!p) throw new Error("describeTable requires a projectId when the session is unscoped.");
    if (!d) throw new Error("describeTable requires a datasetId when the session is unscoped.");
    if (!t) throw new Error("describeTable requires a tableId when the session is unscoped.");

    let result = await this.#api.getTable(p, d, t);
    await this.#approvalQueue.authorizeObservation({
      title: `Describe ${p}.${d}.${t}`,
      description:
        `Described table \`${p}.${d}.${t}\` (${result.schema.length} columns).`,
    });
    return result;
  }
}
