import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { GatekeeperUser, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription, ApprovalQueue, VendorDescription, GatekeeperConnectCallback, AccountDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper';
import { exchangeAuthCode, getAccessToken, getGoogleAccountDescription, GmailApi, GoogleAccessToken, revokeGoogleToken } from "./google-api";
import { GmailSession, GmailThreadContent, GmailThreadSummary } from "./types";
import { GoogleDocSession, DocMetadata } from "./docs-types";
import { GoogleDocsApi } from "./docs-api";
import { docToMarkdown, markdownToDocRequests, computeReplaceOperations, DocSnapshot } from "./markdown-converter";
import TYPES_CODE from "./types.txt";
import DOCS_TYPES_CODE from "./docs-types.txt";

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
];

const GMAIL_RESOURCE: SupportedResource = {
  urlPattern: "https://mail.google.com/*",
  title: "Gmail Mailbox",
  description: "Read and send emails.",
};

const GOOGLE_DOC_RESOURCE: SupportedResource = {
  urlPattern: "https://docs.google.com/document/d/*",
  title: "Google Doc",
  description: "Read and edit a Google Doc.",
};

const SUPPORTED_RESOURCES: SupportedResource[] = [GMAIL_RESOURCE, GOOGLE_DOC_RESOURCE];

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

    if (path.length === 1 && path[0].length == 64) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          }
        });
      }

      let newUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      newUrl.searchParams.set("client_id", env.CLIENT_ID);
      newUrl.searchParams.set("redirect_uri", getBaseUrl(env) + "/oauth");
      newUrl.searchParams.set("response_type", "code");
      newUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
      newUrl.searchParams.set("access_type", "offline");
      newUrl.searchParams.set("prompt", "consent");

      // TODO: SECURITY: This is not secure enough! We need a new nonce every time. In fact
      // we should include a nonce in the URL that initiated this request, too, so people can't
      // just visit the same URL again later.
      newUrl.searchParams.set("state", path[0]);

      return Response.redirect(newUrl.toString(), 302);
    } else if (relPath === "/oauth") {
      // Completion redirect.

      let error = url.searchParams.get("error");
      if (error) {
        return new Response(`${error}: ${url.searchParams.get("error_description")}`);
      }

      let state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      let code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      // TODO: check actual scopes granted, update our "scope" list accordingly

      let userObjectId = ctx.exports.UserAccount.idFromString(state);
      let stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(userObjectId);
      await stub.acceptAuthCode(code);
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

    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}`
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
    return [TYPES_CODE, DOCS_TYPES_CODE].join("\n");
  }
}

// TODO: More security on UserAccount. The object ID is unguessable, but it would be bad if it
// leaked.
export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>) {
    // If we have no API key in 1 hour, delete this object.
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }

    this.ctx.storage.kv.put("callback", callback);
  }

  // Prepare this account for a reconnect flow. The next acceptAuthCode() call will replace the
  // existing refresh token and notify via credentialsRestored() instead of complete().
  async prepareReconnect() {
    this.ctx.storage.kv.put<boolean>("reconnecting", true);
  }

  async acceptAuthCode(code: string) {
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
    await obj.prepareReconnect();
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}` };
  }
}

class GmailSessionImpl extends RpcTarget implements GmailSession {
  #gmailApi: GmailApi;
  #approvalQueue: ApprovalQueue<GmailAction>;
  #searchQuery: string | undefined;

  // Callback to record/check thread IDs for search-filtered gatekeepers. When a search query is
  // active, listThreads() stores each returned thread ID via recordAllowedThread(), and
  // readThread() verifies the ID via isThreadAllowed() before proceeding. Each thread ID is stored
  // as its own key in DO storage for O(1) lookups that don't degrade as the set grows.
  #recordAllowedThread: (threadId: string) => void;
  #isThreadAllowed: (threadId: string) => boolean;

  constructor(
    gmailApi: GmailApi,
    approvalQueue: ApprovalQueue<GmailAction>,
    searchQuery: string | undefined,
    recordAllowedThread: (threadId: string) => void,
    isThreadAllowed: (threadId: string) => boolean,
  ) {
    super();
    this.#gmailApi = gmailApi;
    this.#approvalQueue = approvalQueue;
    this.#searchQuery = searchQuery;
    this.#recordAllowedThread = recordAllowedThread;
    this.#isThreadAllowed = isThreadAllowed;
  }

  async listThreads(count: number): Promise<GmailThreadSummary[]> {
    let queryDesc = this.#searchQuery
        ? ` matching "${this.#searchQuery}"` : "";

    this.#approvalQueue.authorizeObservation({
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

    this.#approvalQueue.authorizeObservation({
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

    await this.#approvalQueue.submitAction(action, {
      title: `Apply the label ${label} to thread ${threadId}`,
      description: `Apply the label ${label} to thread ${threadId}`,

      // TODO: Implement revert.
      implementsRevert: false,
    });
  }
}

type GmailAction = {
  type: "applyLabel",
  threadId: string,
  label: string
}

type GmailRevertInfo = {}

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
    implements Gatekeeper<GmailSession, GmailAction, GmailRevertInfo> {
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

  async startSession(approvalQueue: RpcStub<ApprovalQueue<GmailAction>>)
      : Promise<GmailSession> {
    let gmailApi = new GmailApi(() => this.#getAccessToken());
    let searchQuery = this.ctx.props.searchQuery;

    // Key prefix for storing allowed thread IDs in DO storage. When a search query is active,
    // each thread ID returned by listThreads() is stored as a separate key for O(1) lookups.
    let THREAD_KEY_PREFIX = "allowedThread:";

    return new GmailSessionImpl(
      gmailApi,
      approvalQueue.dup(),
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
  async applyAction(action: GmailAction): Promise<void | {revertInfo?: GmailRevertInfo}> {
    switch (action.type) {
      case "applyLabel": {
        let gmailApi = new GmailApi(() => this.#getAccessToken());
        await gmailApi.applyLabel(action.threadId, action.label);
        break;
      }

      default:
        action.type satisfies never;
        throw new Error(`unknown action type: ${action.type}`);
    }
  }

  async rejectAction(action: GmailAction): Promise<void | {restart?: boolean}> {
    // Nothing to do, since we don't maintain a simulation.
  }

  revertAction(action: GmailAction, revertInfo: GmailRevertInfo):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("revert is not implemented");
  }

  async setHook(hook: Fetcher<WorkerEntrypoint> | null): Promise<void> {
    // Safe to ignore since we don't have a hook!
  }
}

// =======================================================================================
// Google Docs Gatekeeper
// =======================================================================================

type GoogleDocAction = {
  type: "batchUpdate";
  documentId: string;
  revisionId: string;
  requests: any[];
}

type GoogleDocRevertInfo = {}

type GoogleDocGatekeeperImplProps = {
  userObjectId: string;
  documentId: string;
}

export class GoogleDocGatekeeperImpl
    extends DurableObject<Env, GoogleDocGatekeeperImplProps>
    implements Gatekeeper<GoogleDocSession, GoogleDocAction, GoogleDocRevertInfo> {
  #accessToken: GoogleAccessToken | undefined;

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

  async startSession(approvalQueue: RpcStub<ApprovalQueue<GoogleDocAction>>)
      : Promise<GoogleDocSession> {
    let api = new GoogleDocsApi(() => this.#getAccessToken());
    return new GoogleDocSessionImpl(
        api, this.ctx.props.documentId, approvalQueue.dup(), this.ctx.storage);
  }

  async applyAction(action: GoogleDocAction): Promise<void | {revertInfo?: GoogleDocRevertInfo}> {
    let api = new GoogleDocsApi(() => this.#getAccessToken());
    switch (action.type) {
      case "batchUpdate": {
        await api.batchUpdate(action.documentId, action.requests, action.revisionId);
        break;
      }
      default:
        throw new Error(`unknown action type: ${(action as any).type}`);
    }
  }

  async rejectAction(action: GoogleDocAction): Promise<void | {restart?: boolean}> {
    // No simulation state to roll back.
  }

  revertAction(action: GoogleDocAction, revertInfo: GoogleDocRevertInfo):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("revert is not implemented");
  }

  async setHook(hook: Fetcher<WorkerEntrypoint> | null): Promise<void> {
    // No hooks for Google Docs.
  }
}

class GoogleDocSessionImpl extends RpcTarget implements GoogleDocSession {
  #docsApi: GoogleDocsApi;
  #documentId: string;
  #approvalQueue: ApprovalQueue<GoogleDocAction>;
  #storage: DurableObjectStorage;

  constructor(
    docsApi: GoogleDocsApi,
    documentId: string,
    approvalQueue: ApprovalQueue<GoogleDocAction>,
    storage: DurableObjectStorage,
  ) {
    super();
    this.#docsApi = docsApi;
    this.#documentId = documentId;
    this.#approvalQueue = approvalQueue;
    this.#storage = storage;
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

  async getMetadata(): Promise<DocMetadata> {
    let snapshot = await this.#getSnapshot();

    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Doc metadata",
      description: "Read the title and modification time of the document.",
    });

    // The Docs API doesn't return lastModified directly (that's a Drive API field).
    // For now, use the fetch timestamp as an approximation.
    // TODO: Use Drive API files.get for actual modifiedTime.
    return {
      title: snapshot.title ?? "Untitled document",
      lastModified: new Date(snapshot.fetchedAt),
    };
  }

  async getContent(): Promise<string> {
    let snapshot = await this.#getSnapshot();

    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Doc content",
      description: "Read the full content of the document as Markdown.",
    });

    return snapshot.markdown;
  }

  async replaceText(oldMarkdown: string, newMarkdown: string): Promise<void> {
    let snapshot = await this.#storage.get<DocSnapshot>("docSnapshot");
    if (!snapshot) {
      throw new Error("No document snapshot cached. Call getContent() first.");
    }

    // Find the match in the cached Markdown.
    let index = snapshot.markdown.indexOf(oldMarkdown);
    if (index === -1) {
      throw new Error(
        "replaceText: oldMarkdown not found in the document snapshot. " +
        "Make sure the text exactly matches content returned by getContent().");
    }
    let secondIndex = snapshot.markdown.indexOf(oldMarkdown, index + 1);
    if (secondIndex !== -1) {
      throw new Error(
        "replaceText: oldMarkdown matches multiple locations in the document. " +
        "Include more surrounding context to make the match unique.");
    }

    let matchStart = index;
    let matchEnd = index + oldMarkdown.length;

    let result = computeReplaceOperations(
        snapshot.sourceMap, snapshot.markdown, matchStart, matchEnd, newMarkdown);

    if (result.requests.length === 0) {
      return;
    }

    let action: GoogleDocAction = {
      type: "batchUpdate",
      documentId: this.#documentId,
      revisionId: snapshot.revisionId,
      requests: result.requests,
    };

    let oldPreview = result.trimmedOld.length > 80
        ? result.trimmedOld.slice(0, 80) + "..."
        : result.trimmedOld;
    let newPreview = result.trimmedNew.length > 80
        ? result.trimmedNew.slice(0, 80) + "..."
        : result.trimmedNew;

    await this.#approvalQueue.submitAction(action, {
      title: "Edit Google Doc",
      description:
        `Replace text in the document.\n\n` +
        `**Old:** ${oldPreview}\n\n` +
        `**New:** ${newPreview}`,
      implementsRevert: false,
    });
  }

  async appendText(markdown: string): Promise<void> {
    let snapshot = await this.#getSnapshot();

    // Insert before the final newline (bodyEndIndex - 1) since Google Docs
    // always has a trailing newline that can't be deleted.
    let insertAt = snapshot.bodyEndIndex - 1;

    // Prepend \n so that the appended content starts a new paragraph rather
    // than concatenating onto the last existing paragraph.
    let requests = markdownToDocRequests("\n" + markdown, insertAt);

    let action: GoogleDocAction = {
      type: "batchUpdate",
      documentId: this.#documentId,
      revisionId: snapshot.revisionId,
      requests,
    };

    let preview = markdown.length > 100
        ? markdown.slice(0, 100) + "..."
        : markdown;

    await this.#approvalQueue.submitAction(action, {
      title: "Append to Google Doc",
      description: `Append content to the end of the document:\n\n${preview}`,
      implementsRevert: false,
    });
  }
}
