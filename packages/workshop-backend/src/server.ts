import { RpcStub, RpcTarget, newWorkersRpcResponse } from "capnweb";
import { jwtVerify, createRemoteJWKSet, JWTPayload } from "jose";
import { PublicApi, AuthenticatedApi, Overseer, GadgetMetadataWithTimestamps, AiChatAuthorInfo, AiModelConfig, AiGatewayInfo, AiModelProvider, ConnenctedAccountsSubscriber, GatekeeperVendorFilter } from '@gadgets/workshop-shared/api';
import { SupportedResource, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { LanguageModelGatekeeper } from "./ai-models";
import { getAiGatewayConfig } from "./ai-gateway.js";
import { GatekeeperConnectCallbackImpl, normalizeUsername, UserDurableObject } from "./user";
import { OverseerDurableObject, GatekeeperLoopback, CodeModeTailLoopback, AgentSpawnerGatekeeper, GatekeeperHookLoopback, GadgetTailLoopback } from "./overseer";

// Re-export entrypoint types from ai-models.ts.
export { LanguageModelGatekeeper };

// Re-export entrypoint types from user.ts.
export { UserDurableObject, GatekeeperConnectCallbackImpl };

// Re-export entrypoint types from overseer.ts.
export { OverseerDurableObject, GatekeeperLoopback, GatekeeperHookLoopback, CodeModeTailLoopback,
    AgentSpawnerGatekeeper, GadgetTailLoopback };

// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & {
  // Set these if using Cloudflare Access for authentication, otherwise username/password is used.
  CF_ACCESS_AUD?: string,  // audience
  CF_ACCESS_ISS?: string,  // team URL, i.e. https://<team>.cloudflareaccess.com
}

// =======================================================================================

class AuthenticatedApiImpl extends RpcTarget implements AuthenticatedApi {
  constructor(private ctx: ExecutionContext, private env: Env,
      private user: DurableObjectStub<UserDurableObject>) {
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

  getAiConfig(): Promise<AiGatewayInfo> {
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig) {
      return Promise.resolve({
        enabled: true,
        enabledProviders: [...gwConfig.providers] as AiModelProvider[],
      });
    } else {
      return Promise.resolve({ enabled: false });
    }
  }

  async openGadget(id: string, shareKey?: string): Promise<Overseer> {
    let userId = this.user.id.toString();
    let profileId = this.user.id.name!;
    let overseer = this.overseers.get(this.overseers.idFromString(id));

    // @ts-ignore -- Cap'n Web RPC types can trigger "excessively deep" errors.
    return overseer.open(userId, profileId, shareKey);
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

  async listGadgets(): Promise<GadgetMetadataWithTimestamps[]> {
    return this.user.listGadgets();
  }

  listGatekeeperVendors(filter?: GatekeeperVendorFilter)
      : Promise<{id: string, description: VendorDescription, supportedResources: SupportedResource[]}[]> {
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

  async dismissSharedGadget(gadgetId: string): Promise<void> {
    return this.user.dismissSharedGadget(gadgetId);
  }
}

class PublicApiImpl extends RpcTarget implements PublicApi {
  users: DurableObjectNamespace<UserDurableObject>;

  constructor(private ctx: ExecutionContext, private env: Env,
      private accessPayload?: JWTPayload) {
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
    return new AuthenticatedApiImpl(this.ctx, this.env, stub);
  }

  async authenticateFromCfAccess(): Promise<AuthenticatedApi> {
    if (!this.accessPayload) {
      throw new Error("Not authenticated with Access.");
    }

    let email = this.accessPayload.email as string;
    let userId = this.users.idFromName(email);
    let stub = this.users.get(userId);
    await stub.authenticateFromCfAccess(email);
    return new AuthenticatedApiImpl(this.ctx, this.env, stub);
  }

  async login(username: string, passwordHash: Uint8Array): Promise<string | null> {
    if (this.env.CF_ACCESS_AUD) {
      throw new Error("This deployment requires Cloudflare Access authentication.");
    }

    username = normalizeUsername(username);

    let id = this.users.idFromName(username);
    let user = this.users.get(id);

    let token = await user.login(passwordHash);
    if (!token) return null;

    return `${username}:${token}`;
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    if (this.env.CF_ACCESS_AUD) {
      throw new Error("This deployment requires Cloudflare Access authentication.");
    }

    username = normalizeUsername(username);

    let id = this.users.idFromName(username);
    let user = this.users.get(id);

    let token = await user.createAccount(username, displayName, passwordHash);
    if (!token) return null;

    return `${username}:${token}`;
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);

    if (url.pathname === "/api") {
      let accessPayload: JWTPayload | undefined;

      if (env.CF_ACCESS_AUD) {
        if (req.headers.get("Origin") !== url.origin) {
          return new Response("Cross-origin API access not allowed.", { status: 403 });
        }

        const token = req.headers.get("cf-access-jwt-assertion");
        if (!token) {
          return new Response("Missing CF access JWT.", { status: 403 });
        }

        const JWKS = createRemoteJWKSet(
          new URL(`${env.CF_ACCESS_ISS}/cdn-cgi/access/certs`)
        );

        // Verify the JWT
        const { payload } = await jwtVerify(token, JWKS, {
          issuer: env.CF_ACCESS_ISS,
          audience: env.CF_ACCESS_AUD,
        });

        if (!payload.email) {
          return new Response("Access JWT didn't specify email address.", { status: 403 });
        }

        accessPayload = payload;
      }

      return newWorkersRpcResponse(req, new PublicApiImpl(ctx, env, accessPayload));
    } else {
      return new Response("Not Found", {status: 404});
    }
  }
} satisfies ExportedHandler<Env>;
