import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { GatekeeperUser, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription, ApprovalQueue, VendorDescription, GatekeeperConnectCallback, AccountDescription } from '@minions/workshop-shared/gatekeeper';
import { exchangeAuthCode, getAccessToken, getGoogleAccountDescription, GmailApi, GoogleAccessToken, revokeGoogleToken } from "./google-api";
import { GmailSession, GmailThreadContent, GmailThreadSummary } from "./types";
import TYPES_CODE from "./types.txt";

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
    <p>Authorization complete. You may close this tab and return to the Minions Workshop.
  </body>
</html>`;

const OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.modify"
];

const REDIRECT_URI = "http://localhost:8787/oauth/google";

// Main HTTP UI entrypoint. We only use this to initiate OAuth requests to Google.
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let path = url.pathname.slice(1).split("/");

    if (path.length === 1 && path[0].length == 64) {
      let newUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      newUrl.searchParams.set("client_id", env.CLIENT_ID);
      newUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      newUrl.searchParams.set("response_type", "code");
      newUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
      newUrl.searchParams.set("access_type", "offline");
      newUrl.searchParams.set("prompt", "consent");

      // TODO: SECURITY: This is not secure enough! We need a new nonce every time. In fact
      // we should include a nonce in the URL that initiated this request, too, so people can't
      // just visit the same URL again later.
      newUrl.searchParams.set("state", path[0]);

      return Response.redirect(newUrl.toString(), 302);
    } else if (url.pathname === "/oauth/google") {
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
      url: `http://google.localhost:8787/${userObjectId.toString()}`
    };
  }

  async newUser(): Promise<Fetcher<GatekeeperUser>> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let props: GatekeeperUserImplProps = { userObjectId: userObjectId.toString() };
    return this.ctx.exports.GatekeeperUserImpl({props});
  }

  async getSupportedUrls(): Promise<string[]> {
    return ["https://mail.google.com/mail/*"];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
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

  async acceptAuthCode(code: string) {
    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      // Must have timed out.
      throw new Error("Took too long to complete the authorization. Please try again.");
    }

    let response = await exchangeAuthCode(
        code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, REDIRECT_URI);

    if (!response.refreshToken) {
      throw new Error("OAuth exchange didn't return refresh token?");
    }

    this.ctx.storage.kv.put<string>("refreshToken", response.refreshToken);

    // TODO: Cache the access token.

    try {
      let props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
      await callback.complete(this.ctx.exports.GatekeeperUserImpl({props}));
    } catch (err) {
      this.ctx.storage.kv.delete("refreshToken");
      throw err;
    }
  }

  hasRefreshToken() {
    return this.ctx.storage.kv.get<string>("refreshToken") !== undefined;
  }

  async getAccessToken(): Promise<GoogleAccessToken> {
    let refreshToken = await this.ctx.storage.get<string>("refreshToken");
    if (!refreshToken) {
      throw new Error("no refresh token set");
    }

    // TODO: Cache the access token.
    // TODO: If new refresh token returned, use it.

    return await getAccessToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
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

  async getGatekeeperClassFor(url: string): Promise<DurableObjectClass<Gatekeeper<any>>> {
    let props: GmailGatekeeperImplProps = this.ctx.props;

    return this.ctx.exports.GmailGatekeeperImpl({props});
  }

  async revoke(): Promise<void> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    await obj.revoke();
  }
}

class GmailSessionImpl extends RpcTarget implements GmailSession {
  // Google API access token.
  #gmailApi: GmailApi;
  #approvalQueue: ApprovalQueue<GmailAction>;

  constructor(gmailApi: GmailApi, approvalQueue: ApprovalQueue<GmailAction>) {
    super();
    this.#gmailApi = gmailApi;
    this.#approvalQueue = approvalQueue;
  }

  async listThreads(count: number): Promise<GmailThreadSummary[]> {
    this.#approvalQueue.authorizeObservation({
      title: "List Gmail threads",
      description: `List the top ${count} threads in the Gmail inbox, including IDs and snippets.`
    });

    return await this.#gmailApi.listThreads(count);
  }

  async readThread(threadId: string): Promise<GmailThreadContent> {
    let result = await this.#gmailApi.readThread(threadId);

    this.#approvalQueue.authorizeObservation({
      title: `Read thread: ${result.messages[0].subject}`,
      description: "Fetch the full content of thread ${threadId}, including all messages."
    });

    return result;
  }

  async applyLabel(threadId: string, label: string): Promise<void> {
    // TODO: We should probably show the thread subject line?

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
    return new GmailSessionImpl(gmailApi, approvalQueue.dup());
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
}
