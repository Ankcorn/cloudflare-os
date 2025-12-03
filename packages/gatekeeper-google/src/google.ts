import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { GatekeeperUser, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, ResourceDescription, ApprovalQueue } from '@minions/workshop-shared/gatekeeper';
import { getAccessToken, GmailApi, GoogleAccessToken } from "./google-api";
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

// Main HTTP UI entrypoint. We only use this to initiate OAuth requests to Google.
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);

    let path = url.pathname.slice(1).split("/");
    if (path.length === 1 && path[0]) {
      let userObjectId = ctx.exports.UserAccount.idFromString(path[0]);
      let stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(userObjectId);

      switch (req.method) {
        case "GET":
        case "HEAD": {
          let hasApiKey = await stub.hasApiKey();

          return new Response(apiKeyForm(hasApiKey), {
            headers: {
              "Content-Type": "text/html; charset=utf-8"
            }
          });
        }

        case "POST": {
          let form = await req.formData();
          let key = form.get("key");
          if (!key || typeof key !== "string") {
            return new Response("Bad Request", {status: 400});
          }
          await stub.setApiKey(key);
          return new Response("Key Saved");
        }

        default:
          return new Response("Method Now Allowed", {status: 405});
      }
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
  async setApiKey(key: string) {
    await this.ctx.storage.put("apiKey", key);
  }

  async hasApiKey() {
    return !!(await this.ctx.storage.get("apiKey"));
  }

  async getAccessToken(): Promise<GoogleAccessToken> {
    let refreshToken = await this.ctx.storage.get<string>("apiKey");
    if (!refreshToken) {
      throw new Error("no refresh token set");
    }
    return await getAccessToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
  }
}

type GatekeeperUserImplProps = {
  userObjectId: string;
}

export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  async getGatekeeperClassFor(url: string): Promise<DurableObjectClass<Gatekeeper<any>>> {
    let props: GmailGatekeeperImplProps = this.ctx.props;

    return this.ctx.exports.GmailGatekeeperImpl({props});
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
