import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { GatekeeperUser, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription, ApprovalQueue, VendorDescription, GatekeeperConnectCallback, AccountDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper';
import { exchangeAuthCode, getAccessToken, getGoogleAccountDescription, GmailApi, GoogleAccessToken, revokeGoogleToken } from "./google-api";
import { GmailSession, GmailThreadContent, GmailThreadSummary } from "./types";
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

function getBaseUrl(env: Env) {
  return env.BASE_URL || "http://localhost:8787/gatekeeper/google";
}

function getBasePath(env: Env) {
  return new URL(getBaseUrl(env)).pathname;
}

// =======================================================================================

function apiKeyForm(hasApiKey: boolean) {
  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <title>Gmail gatekeeper</title>
  </head>
  <body>
    <p>Please enter your gmail refresh token:</p>
    <form action="" method="post">
      <input type="text" name="key">
    </form>
    <p>${hasApiKey ? "You have a refresh token set already." : "You do not have a refresh token set."}
  </body>
</html>`;
}

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

const OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/documents",
  // `bigquery` (not `bigquery.readonly`): dry-runs go through `jobs.insert` for scope
  // enforcement, which `readonly` doesn't permit. Read-only is enforced at the API layer.
  "https://www.googleapis.com/auth/bigquery",
];

const GMAIL_RESOURCE: SupportedResource = {
  urlPattern: "https://mail.google.com/*",
  title: "Gmail Mailbox",
  description: "Read and send emails.",
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
  description:
    "Query one Google Cloud project. Use /projectId/datasetId to scope to one dataset, " +
    "or /projectId/datasetId/tableId for one table.",
};

const SUPPORTED_RESOURCES: SupportedResource[] =
    [GMAIL_RESOURCE, GOOGLE_DOC_RESOURCE, BIGQUERY_RESOURCE];

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
      let oauthNonce = await stub.beginOAuthFlow(initiationNonce);
      if (oauthNonce === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      let newUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      newUrl.searchParams.set("client_id", env.CLIENT_ID);
      newUrl.searchParams.set("redirect_uri", getBaseUrl(env) + "/oauth");
      newUrl.searchParams.set("response_type", "code");
      newUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
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
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  status() {
    return "Google Gatekeeper";
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Google",
      url: "https://google.com",
      // TODO: logo
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{url: string}> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let initiationNonce = generateNonce();

    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);

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
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string) {
    // If we have no API key in 1 hour, delete this object.
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }

    this.ctx.storage.kv.put("callback", callback);
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
  // nonce, consumes it, and returns a fresh OAuth nonce to use as the `state` parameter.
  // Returns null if the nonce is invalid or expired.
  async beginOAuthFlow(initiationNonce: string): Promise<string | null> {
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
    return oauthNonce;
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

    // TODO: Cache the access token.

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

    // TODO: Cache the access token.
    // TODO: If new refresh token returned, use it.

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
    return result;
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    if (!this.hasRefreshToken()) {
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

export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let token = await obj.getAccessToken();
    return getGoogleAccountDescription(token.token);
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

    // Parse the URL hash to extract a search or label filter. Gmail URLs encode these in the
    // fragment:
    //   #search/from%3Abob%40example.com  ->  search query "from:bob@example.com"
    //   #label/my-label                   ->  search query "label:my-label"
    let hash = parsed.hash;
    if (hash.startsWith("#search/")) {
      props.searchQuery = decodeURIComponent(hash.slice("#search/".length));
    } else if (hash.startsWith("#label/")) {
      props.searchQuery = "label:" + decodeURIComponent(hash.slice("#label/".length));
    }

    return {class: this.ctx.exports.GmailGatekeeperImpl({props}), resource: GMAIL_RESOURCE};
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
        .sort((a, b) => a.id - b.id);
  }

  remove(id: number): void {
    this.#kv.delete(this.#actionKey(id));
  }
}

class GmailSessionImpl extends RpcTarget implements GmailSession {
  #gmailApi: GmailApi;
  #approvalQueue: ApprovalQueue<number>;
  #pendingActions: PendingActionStore<GmailAction>;
  #searchQuery: string | undefined;

  // Callback to record/check thread IDs for search-filtered gatekeepers. When a search query is
  // active, listThreads() stores each returned thread ID via recordAllowedThread(), and
  // readThread() verifies the ID via isThreadAllowed() before proceeding. Each thread ID is stored
  // as its own key in DO storage for O(1) lookups that don't degrade as the set grows.
  #recordAllowedThread: (threadId: string) => void;
  #isThreadAllowed: (threadId: string) => boolean;

  constructor(
    gmailApi: GmailApi,
    approvalQueue: ApprovalQueue<number>,
    pendingActions: PendingActionStore<GmailAction>,
    searchQuery: string | undefined,
    recordAllowedThread: (threadId: string) => void,
    isThreadAllowed: (threadId: string) => boolean,
  ) {
    super();
    this.#gmailApi = gmailApi;
    this.#approvalQueue = approvalQueue;
    this.#pendingActions = pendingActions;
    this.#searchQuery = searchQuery;
    this.#recordAllowedThread = recordAllowedThread;
    this.#isThreadAllowed = isThreadAllowed;
  }

  async listThreads(count: number): Promise<GmailThreadSummary[]> {
    let queryDesc = this.#searchQuery
        ? ` matching "${this.#searchQuery}"` : "";

    await this.#approvalQueue.authorizeObservation({
      title: "List Gmail threads",
      description:
          `List the top ${count} threads${queryDesc} in the Gmail inbox, including IDs and snippets.`
    });

    let results = await this.#gmailApi.listThreads(count, this.#searchQuery);

    if (this.#searchQuery) {
      for (let thread of results) {
        this.#recordAllowedThread(thread.id);
      }
    }

    return results;
  }

  async readThread(threadId: string): Promise<GmailThreadContent> {
    if (this.#searchQuery && !this.#isThreadAllowed(threadId)) {
      throw new Error(
        `Thread ${threadId} was not found in search results for "${this.#searchQuery}". ` +
        `Only threads returned by listThreads() can be read.`);
    }

    let result = await this.#gmailApi.readThread(threadId);

    await this.#approvalQueue.authorizeObservation({
      title: `Read thread: ${result.messages[0].subject}`,
      description: `Fetch the full content of thread ${threadId}, including all messages.`
    });

    return result;
  }

  async applyLabel(threadId: string, label: string): Promise<void> {
    if (this.#searchQuery && !this.#isThreadAllowed(threadId)) {
      throw new Error(
        `Thread ${threadId} was not found in search results for "${this.#searchQuery}". ` +
        `Only threads returned by listThreads() can have labels applied.`);
    }

    let action: GmailAction = {type: "applyLabel", threadId, label};
    let actionId = this.#pendingActions.submit(action);

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: `Apply the label ${label} to thread ${threadId}`,
        description: `Apply the label ${label} to thread ${threadId}`,

        // TODO: Implement revert.
        implementsRevert: false,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      throw error;
    }
  }
}

type GmailAction = {
  type: "applyLabel",
  threadId: string,
  label: string
}

type GmailGatekeeperImplProps = {
  userObjectId: string;

  // If the user pasted a Gmail URL with a search query (e.g. #search/from%3Abob%40example.com),
  // this is the decoded search query (e.g. "from:bob@example.com"). When set, listThreads()
  // results are restricted to matching threads, and readThread() only allows threads previously
  // returned by listThreads().
  searchQuery?: string;
}

const ALL_GMAIL_PERMISSIONS: string[] = ["listThreads", "readThread", "applyLabel"];

export class GmailGatekeeperImpl extends DurableObject<Env, GmailGatekeeperImplProps>
    implements Gatekeeper<GmailSession, number, undefined> {
  #accessToken: GoogleAccessToken | undefined;

  async #getAccessToken(): Promise<string> {
    if (!this.#accessToken) {
      let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
          this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
      this.#accessToken = await stub.getAccessToken();

      let ttl = this.#accessToken.expires.valueOf() - Date.now();

      // Time out when half-way expired.
      // TODO: Maybe store in persistent storage?
      setTimeout(() => {this.#accessToken = undefined}, ttl / 2);
    }
    return this.#accessToken.token;
  }

  async describe(): Promise<ResourceDescription> {
    let searchQuery = this.ctx.props.searchQuery;
    if (searchQuery) {
      // If the query is a simple "label:X" filter, produce a nicer label-specific description
      // with the native #label/ URL form.
      let labelMatch = searchQuery.match(/^label:(.+)$/);
      if (labelMatch) {
        let label = labelMatch[1];
        return {
          url: `https://mail.google.com/mail/#label/${encodeURIComponent(label)}`,
          title: `Gmail label: ${label}`,
          snippet: `Gmail threads with label: ${label}`,
          suggestedBindingName: "GMAIL_LABEL",
          tsType: "GmailSession",
        };
      }

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

  async startSession(approvalQueue: RpcStub<ApprovalQueue<number>>)
      : Promise<GmailSession> {
    let gmailApi = new GmailApi(() => this.#getAccessToken());
    let pendingActions = new PendingActionStore<GmailAction>(this.ctx.storage.kv);
    let searchQuery = this.ctx.props.searchQuery;

    // Key prefix for storing allowed thread IDs in DO storage. When a search query is active,
    // each thread ID returned by listThreads() is stored as a separate key for O(1) lookups.
    let THREAD_KEY_PREFIX = "allowedThread:";

    return new GmailSessionImpl(
      gmailApi,
      approvalQueue.dup(),
      pendingActions,
      searchQuery,
      (threadId: string) => {
        // Fire-and-forget: store the thread ID in DO storage so it persists across sessions.
        this.ctx.storage.put(THREAD_KEY_PREFIX + threadId, true);
      },
      (threadId: string) => {
        // Synchronous check using the KV cache (which is always in sync with storage).
        return this.ctx.storage.kv.get(THREAD_KEY_PREFIX + threadId) !== undefined;
      },
    );
  }

  // ---------------------------------------------------------------------------
  async applyAction(actionId: number): Promise<void> {
    let pendingActions = new PendingActionStore<GmailAction>(this.ctx.storage.kv);
    let action = pendingActions.get(actionId);
    if (!action) {
      throw new Error(`Unknown pending Gmail action: ${actionId}`);
    }

    switch (action.type) {
      case "applyLabel": {
        let gmailApi = new GmailApi(() => this.#getAccessToken());
        await gmailApi.applyLabel(action.threadId, action.label);
        pendingActions.remove(actionId);
        break;
      }

      default:
        action.type satisfies never;
        throw new Error(`unknown action type: ${action.type}`);
    }
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    // Nothing to do, since we don't maintain a simulation.
    let pendingActions = new PendingActionStore<GmailAction>(this.ctx.storage.kv);
    pendingActions.remove(actionId);
  }

  revertAction(action: number, revertInfo: undefined):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("revert is not implemented");
  }

  async setHook(_hook: Fetcher | null): Promise<void> {
    // No hooks for Gmail.
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

export class GoogleDocGatekeeperImpl
    extends DurableObject<Env, GoogleDocGatekeeperImplProps>
    implements Gatekeeper<GoogleDocSession, number, undefined> {
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

  async startSession(approvalQueue: RpcStub<ApprovalQueue<number>>)
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

  revertAction(action: number, revertInfo: undefined):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("revert is not implemented");
  }

  async setHook(_hook: Fetcher | null): Promise<void> {
    // No hooks for Google Docs.
  }
}

class GoogleDocSessionImpl extends RpcTarget implements GoogleDocSession {
  #docsApi: GoogleDocsApi;
  #documentId: string;
  #approvalQueue: ApprovalQueue<number>;
  #pendingActions: PendingActionStore<GoogleDocAction>;
  #storage: DurableObjectStorage;
  #simulationCache: GoogleDocSimulationCacheHolder;

  constructor(
    docsApi: GoogleDocsApi,
    documentId: string,
    approvalQueue: ApprovalQueue<number>,
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

export class BigQueryGatekeeperImpl
    extends DurableObject<Env, BigQueryGatekeeperImplProps>
    implements Gatekeeper<BigQuerySession, number, undefined> {
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

  async startSession(approvalQueue: RpcStub<ApprovalQueue<number>>): Promise<BigQuerySession> {
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
  revertAction(_action: number, _revertInfo: undefined): Promise<void> {
    throw new Error("BigQuery gatekeeper has no writable actions to revert");
  }

  async setHook(_hook: Fetcher | null): Promise<void> {
    // BigQuery doesn't push events.
  }
}

class BigQuerySessionImpl extends RpcTarget implements BigQuerySession {
  #api: BigQueryApi;
  #approvalQueue: ApprovalQueue<number>;
  #scopedProjectId?: string;
  #scopedDatasetId?: string;
  #scopedTableId?: string;

  constructor(
    api: BigQueryApi,
    approvalQueue: ApprovalQueue<number>,
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

    let result = await this.#api.query(billingProject, sql, {
      ...opts,
      defaultDataset,
      maximumBytesBilled: maxBytes,
    });

    let preview = sql.replace(/\s+/g, " ").trim().slice(0, 200);
    await this.#approvalQueue.authorizeObservation({
      title: `BigQuery query: ${preview}`,
      description:
        `SQL preview: \`${preview}\`${sql.length > preview.length ? "..." : ""}\n` +
        (defaultDataset ? `Default dataset: \`${defaultDataset}\`\n` : "") +
        `Billing project: \`${billingProject}\`\n` +
        `Referenced tables: ${estimate.referencedTables.join(", ")}\n` +
        `Bytes processed: ${result.bytesProcessed.toLocaleString()}\n` +
        `Returned ${result.rows.length} rows (totalRows=${result.totalRows}).`,
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
