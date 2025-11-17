import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { AdapterSchema, GatekeeperUser, GatekeeperVendor as GatekeeperVendorIface, UserId, Gatekeeper, ResourceDescription, PermissionSet, ApprovalQueue, ResourceSchema } from '@minions/workshop-shared/gatekeeper';
import { getAccessToken, GmailApi, GmailThreadContent, GmailThreadSummary, GoogleAccessToken } from "./google-api";

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

const GMAIL_RESOURCE_SCHEMA: ResourceSchema = {
  name: "gmail",
  title: {text: "Gmail Inbox"},

  summary: {text: "Provides access to your Gmail inbox."},

  urlPatterns: [
    "https://mail.google.com/mail/*"
  ],

  children: [],

  permissions: [
    {
      name: "listThreads",
      title: {text: "List email"},
      description: {
        text: "Permission to list all threads in the inbox, including reading metadata " +
              "like sender name, subject line, and date"
      },
      type: "property"
    },
    {
      name: "readThread",
      title: {text: "Read threads"},
      description: {
        text: "Permission to fetch and read whole email threads."
      },
      type: "property"
    },
    {
      name: "applyLabel",
      title: {text: "Apply label"},
      description: {
        text: "Permission to apply labels to threads."
      },
      type: "action"
    }
  ],

  apiType: "GmailInbox",
  apiTsUrl: "TODO"
}

// Top-level API exposed to the Workshop.
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  status() {
    return "Google Gatekeeper";
  }

  async describe(): Promise<AdapterSchema> {
    return {
      title: {text: "Google APIs"},
      summary: {text: "Provides access to various Google APIs."},

      resources: [GMAIL_RESOURCE_SCHEMA],
    };
  }

  async newUser(id: UserId): Promise<Fetcher<GatekeeperUser>> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(userObjectId);
    await stub.init(id);
    let props: GatekeeperUserImplProps = { userObjectId: userObjectId.toString(), userId: id };
    return this.ctx.exports.GatekeeperUserImpl({props});
  }
}

// TODO: More security on UserAccount. The object ID is unguessable, but it would be bad if it
// leaked.
export class UserAccount extends DurableObject<Env> {
  async init(id: UserId): Promise<void> {
    if (await this.ctx.storage.get("userId")) {
      throw new Error("already intialized");
    }

    await this.ctx.storage.put("userId", id);
  }

  async getUserId(): Promise<UserId> {
    let result = await this.ctx.storage.get<UserId>("userId");
    if (!result) throw new Error("not initialized");
    return result;
  }

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
  userId: UserId;
}

export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  async getGatekeeperClassFor(url: string): Promise<DurableObjectClass<Gatekeeper<any>>> {
    let props: GmailGatekeeperImplProps = this.ctx.props;

    return this.ctx.exports.GmailGatekeeperImpl({props});
  }
}

class GmailSession extends RpcTarget {
  // Google API access token.
  #userId: UserId;
  #gmailApi: GmailApi;
  #permissions: string[];
  #approvalQueue: ApprovalQueue<GmailAction>;

  constructor(userId: UserId, gmailApi: GmailApi,
      permissions: string[], approvalQueue: ApprovalQueue<GmailAction>) {
    super();
    this.#userId = userId;
    this.#gmailApi = gmailApi;
    this.#permissions = permissions;
    this.#approvalQueue = approvalQueue;
  }

  async listThreads(count: number): Promise<GmailThreadSummary[]> {
    if (!this.#permissions.includes("listThreads")) {
      throw new Error("Minion needs the 'listThreads' permission to call 'listThreads'.");
    }

    return await this.#gmailApi.listThreads(count);
  }

  async readThread(threadId: string): Promise<GmailThreadContent> {
    if (!this.#permissions.includes("readThread")) {
      throw new Error("Minion needs the 'readThread' permission to call 'readThread'.");
    }

    return await this.#gmailApi.readThread(threadId);
  }

  async applyLabel(threadId: string, label: string): Promise<void> {
    if (!this.#permissions.includes("applyLabel")) {
      throw new Error("Minion needs the 'applyLabel' permission to call 'applyLabel'.");
    }

    // TODO: We should probably show the thread subject line?

    let action: GmailAction = {type: "applyLabel", threadId, label};

    await this.#approvalQueue.submit(action, {
      title: `Apply the label ${label} to thread ${threadId}`,
      description: `Apply the label ${label} to thread ${threadId}`,

      // TODO: Think more about this metadata. Is it right?
      observers: [this.#userId],
      affectedProperties: [],
      hasArbitraryContent: false,
      isAppendOnly: true,

      // TODO: Implement revert.
      isReversible: true,
      implementsRevert: false,
      isRevertUsuallyAutomatic: false,
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
  userId: UserId;
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
      exists: true,
      title: {text: "Gmail Inbox"},
      snippet: {text: "Your personal Gmail inbox"},
      schema: GMAIL_RESOURCE_SCHEMA,
      userPermissions: {permissions: ALL_GMAIL_PERMISSIONS},
      adapterPermissions: {permissions: ALL_GMAIL_PERMISSIONS},

      // TODO: Give authRedirect if there's no API key yet.
    };
  }

  async startSession(permissions: PermissionSet,
      approvalQueue: RpcStub<ApprovalQueue<GmailAction>>)
      : Promise<GmailSession> {
    let gmailApi = new GmailApi(() => this.#getAccessToken());
    return new GmailSession(
        this.ctx.props.userId, gmailApi, permissions.permissions, approvalQueue.dup());
  }

  checkUserPermissions(user: UserId): Promise<PermissionSet> {
    throw "TODO";
  }

  getInfluencers(): Promise<UserId[]> {
    throw "TODO";
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
