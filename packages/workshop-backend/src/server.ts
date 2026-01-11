import { RpcStub, RpcTarget, newWorkersRpcResponse } from "capnweb";
import { PublicApi, AuthenticatedApi, Overseer, GadgetMetadata, AiChatAuthorInfo, AiModelConfig, ConnenctedAccountsSubscriber, GatekeeperVendorFilter } from '@gadgets/workshop-shared/api';
import { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { LanguageModelGatekeeper } from "./ai-models";
import { GatekeeperConnectCallbackImpl, normalizeUsername, UserDurableObject } from "./user";
import { OverseerDurableObject, GatekeeperLoopback, CodeModeTailLoopback } from "./overseer";

// Re-export entrypoint types from ai-models.ts.
export { LanguageModelGatekeeper };

// Re-export entrypoint types from user.ts.
export { UserDurableObject, GatekeeperConnectCallbackImpl };

// Re-export entrypoint types from overseer.ts.
export { OverseerDurableObject, GatekeeperLoopback, CodeModeTailLoopback };

// =======================================================================================

class AuthenticatedApiImpl extends RpcTarget implements AuthenticatedApi {
  constructor(private ctx: ExecutionContext, private user: DurableObjectStub<UserDurableObject>) {
    super();

    this.overseers = this.ctx.exports.OverseerDurableObject;
  }

  private overseers: DurableObjectNamespace<OverseerDurableObject>;

  whoami(): Promise<AiChatAuthorInfo> {
    return this.user.whoami();
  }
  setOwnDisplayName(name: string): Promise<void> {
    return this.user.setOwnDisplayName(name);
  }
  changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void> {
    return this.user.changePassword(oldHash, newHash);
  }
  listModels(): Promise<AiChatAuthorInfo[]> {
    return this.user.listModels();
  }
  addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void> {
    return this.user.addModel(profile, config);
  }
  deleteModel(id: string): Promise<void> {
    return this.user.deleteModel(id);
  }
  setQuickModel(id: string | null): Promise<void> {
    return this.user.setQuickModel(id);
  }
  getQuickModel(): Promise<null | string> {
    return this.user.getQuickModel();
  }

  async openGadget(id: string): Promise<Overseer> {
    let userId = this.user.id.toString();

    let overseer = this.overseers.get(this.overseers.idFromString(id));

    return overseer.open(userId);
  }

  async newGadget(): Promise<Overseer> {
    let id = this.overseers.newUniqueId().toString();
    await this.user.newGadget(id, "Untitled Gadget");
    let result = await this.openGadget(id);
    if (!result) {
      throw new Error("Open failed despite newly-created gadget?");
    }
    return result;
  }

  async listGadgets(): Promise<GadgetMetadata[]> {
    return this.user.listGadgets();
  }

  listGatekeeperVendors(filter?: GatekeeperVendorFilter)
      : Promise<{id: string, description: VendorDescription}[]> {
    return this.user.listGatekeeperVendors(filter);
  }

  connectAccount(vendorId: string): Promise<{url: string}> {
    return this.user.connectAccount(vendorId);
  }

  subscribeConnectedAccounts(
      subscriber: RpcStub<ConnenctedAccountsSubscriber>, filter?: GatekeeperVendorFilter)
      : Promise<RpcStub<{}>> {
    return this.user.subscribeConnectedAccounts(subscriber, filter);
  }

  disconnectAccount(accountId: number): Promise<void> {
    return this.user.disconnectAccount(accountId);
  }
}

class PublicApiImpl extends RpcTarget implements PublicApi {
  users: DurableObjectNamespace<UserDurableObject>;

  constructor(private ctx: ExecutionContext) {
    super();
    this.users = this.ctx.exports.UserDurableObject;
  }

  async authenticate(token: string): Promise<AuthenticatedApi> {
    let split = token.split(':');
    if (split.length !== 2) {
      throw new Error("Invalid session token.");
    }

    let userId = this.users.idFromName(split[0]);
    let stub = this.users.get(userId);
    await stub.authenticate(split[1]);
    return new AuthenticatedApiImpl(this.ctx, stub);
  }

  async login(username: string, passwordHash: Uint8Array): Promise<string | null> {
    username = normalizeUsername(username);

    let id = this.users.idFromName(username);
    let user = this.users.get(id);

    let token = await user.login(passwordHash);
    if (!token) return null;

    return `${username}:${token}`;
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    username = normalizeUsername(username);

    let id = this.users.idFromName(username);
    let user = this.users.get(id);

    let token = await user.createAccount(username, displayName, passwordHash);
    if (!token) return null;

    return `${username}:${token}`;
  }
}

export default {
  async fetch(req: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    let url = new URL(req.url);

    if (url.pathname === "/api") {
      return newWorkersRpcResponse(req, new PublicApiImpl(ctx));
    } else if (url.pathname === "/status") {
      // A little debug endpoint to check if we can reach our gatekeepers.
      let responses = [];
      for (let name in env) {
        if (name.startsWith("GATEKEEPER_")) {
          responses.push((<any>env)[name].status().then((status: any) => {
            return `${name}: ${status}`;
          }));
        }
      }
      let gatekeepersStatus = (await Promise.all(responses)).join("\n");
      return new Response(`Available gatekeepers:\n\n${gatekeepersStatus}`);
    } else {
      return new Response("Not Found", {status: 404});
    }
  }
} satisfies ExportedHandler<Cloudflare.Env>;
