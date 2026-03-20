import { RpcStub, RpcTarget, newWorkersRpcResponse } from "capnweb";
import { jwtVerify, createRemoteJWKSet, JWTPayload } from "jose";
import { PublicApi, AuthenticatedApi, Overseer, GadgetMetadataWithTimestamps, AiChatAuthorInfo, AiModelConfig, AiGatewayInfo, AiModelProvider, ConnenctedAccountsSubscriber, GatekeeperVendorFilter, BlueprintPublicInfo, BlueprintUserSummary, BlueprintBindingAssignment, BlueprintMetadata, AgentSpawnerConfig } from '@gadgets/workshop-shared/api';
import { SupportedResource, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { LanguageModelGatekeeper } from "./ai-models";
import { getAiGatewayConfig } from "./ai-gateway.js";
import { GatekeeperConnectCallbackImpl, normalizeUsername, UserDurableObject } from "./user";
import { OverseerDurableObject, GatekeeperLoopback, CodeModeTailLoopback, AgentSpawnerGatekeeper, GatekeeperHookLoopback, GadgetTailLoopback, AgentSelfLoopback, TransientStubLoopback } from "./overseer";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";

// Re-export entrypoint types from ai-models.ts.
export { LanguageModelGatekeeper };

// Re-export entrypoint types from user.ts.
export { UserDurableObject, GatekeeperConnectCallbackImpl };

// Re-export entrypoint types from overseer.ts.
export { OverseerDurableObject, GatekeeperLoopback, GatekeeperHookLoopback, CodeModeTailLoopback,
    AgentSpawnerGatekeeper, GadgetTailLoopback, AgentSelfLoopback, TransientStubLoopback };

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

  async #openGadgetInternal(id: string, shareKey?: string): Promise<NativeRpcStub<Overseer>> {
    let userId = this.user.id.toString();
    let profileId = this.user.id.name!;
    let overseer = this.overseers.get(this.overseers.idFromString(id));

    // HACK: Detect loss of the connection to the DO by:
    // - Pass a callback to overseer.open() which it should call when the session is disposed.
    // - Detect if the callback itself is disposed before being called, suggesting the connection
    //   was lost.
    // If the connection is lost, we abort this I/O context, which kills the WebSocket from the
    // client, forcing it to engage its reconnect logic, which should recover.
    // TODO: Implement onRpcBroken() in the built-in RPC system, matching Cap'n Web, and use that
    //   instead.
    // TODO: Consider how to reconnect to one DO without resetting the whole WebSocket. Probably
    //   needs new code on the client side. However, typically a client only ever opens one
    //   gadget at a time (since each tab is a separate client), so it's probably fine for now.
    let closed = false;
    let started = false;
    let notifyClosed = () => {
      closed = true;
    };
    (notifyClosed as any)[Symbol.dispose] = () => {
      if (started && !closed) {
        this.ctx.abort(new Error("lost connection to gadget DO"));
      }
    }

    let result = await overseer.open(userId, profileId, notifyClosed, shareKey);
    started = true;
    return result;
  }

  async openGadget(id: string, shareKey?: string): Promise<RpcStub<Overseer>> {
    // @ts-expect-error Cap'n Web RPC stubs and native RPC stubs are compatible but the type
    //     system doesn't know this.
    return this.#openGadgetInternal(id, shareKey);
  }

  async newGadget(): Promise<RpcStub<Overseer>> {
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

  async listOwnBlueprints(): Promise<BlueprintUserSummary[]> {
    return this.user.listBlueprints();
  }

  async newGadgetFromBlueprint(
    blueprintId: string,
    bindings: Record<string, BlueprintBindingAssignment>
  ): Promise<RpcStub<Overseer>> {
    // 1. Read blueprint from KV.
    let raw = await this.env.BLUEPRINTS.get(blueprintId);
    if (!raw) throw new Error("Blueprint not found.");

    let kvRecord = JSON.parse(raw) as {
      metadata: BlueprintMetadata;
      ownerId: string;
      gadgetId: string;
    };

    // Revive dates.
    kvRecord.metadata.created = new Date(kvRecord.metadata.created);
    kvRecord.metadata.lastUpdated = new Date(kvRecord.metadata.lastUpdated);

    // 2. Read gzip-compressed Yjs doc from R2 and decompress.
    let r2Key = `${blueprintId}/${kvRecord.metadata.version}`;
    let r2Object = await this.env.BLUEPRINT_CONTENT.get(r2Key);
    if (!r2Object) throw new Error("Blueprint content not found in R2.");

    let decompressed = r2Object.body.pipeThrough(new DecompressionStream("gzip"));
    let codeBytes = new Uint8Array(await new Response(decompressed).arrayBuffer());

    // 3. Create new Overseer DO (same as newGadget()).
    let id = this.overseers.newUniqueId().toString();
    await this.user.newGadget(id, kvRecord.metadata.title);
    let overseerResult = await this.#openGadgetInternal(id);

    // 4. Initialize from blueprint code.
    let overseerDo = this.overseers.get(this.overseers.idFromString(id));
    await overseerDo.initializeFromBlueprint(codeBytes, kvRecord.metadata.title);

    // 5. Create gatekeepers from assignments.
    let blueprintBindings = kvRecord.metadata.bindings;
    let gkPromises: Promise<void>[] = [];

    for (let [bindingName, assignment] of Object.entries(bindings)) {
      let blueprintBinding = blueprintBindings[bindingName];
      if (!blueprintBinding) {
        throw new Error(`Unknown binding name: ${bindingName}`);
      }

      gkPromises.push((async () => {
        if (assignment.type === "gatekeeper") {
          using gk = await overseerResult.newGatekeeper(assignment.accountId, assignment.resourceUrl);
          if (!gk) {
            throw new Error(`Failed to create gatekeeper for binding "${bindingName}".`);
          }
          await gk.setBindingName(bindingName);
        } else if (assignment.type === "aiModel") {
          using gk = await overseerResult.newAiModelGatekeeper(assignment.modelId);
          await gk.setBindingName(bindingName);
        } else if (assignment.type === "agentSpawner") {
          if (blueprintBinding.type !== "agentSpawner") {
            throw new Error(`Binding "${bindingName}" type mismatch.`);
          }
          let config: AgentSpawnerConfig = {
            ...blueprintBinding.config,
            modelId: assignment.modelId,
          };
          using gk = await overseerResult.newAgentSpawnerGatekeeper(config);
          await gk.setBindingName(bindingName);
        }
      })());
    }

    await Promise.all(gkPromises);

    // @ts-expect-error Cap'n Web RPC stubs and native RPC stubs are compatible but the type
    //     system doesn't know this.
    return overseerResult;
  }

  async deleteOrphanedBlueprint(blueprintId: string): Promise<void> {
    // Read from KV to verify ownership.
    let raw = await this.env.BLUEPRINTS.get(blueprintId);
    if (!raw) throw new Error("Blueprint not found.");

    let kvRecord = JSON.parse(raw) as {
      metadata: BlueprintMetadata;
      ownerId: string;
      gadgetId: string;
    };

    if (kvRecord.ownerId !== this.user.id.toString()) {
      throw new Error("You don't own this blueprint.");
    }

    // Delete from KV.
    await this.env.BLUEPRINTS.delete(blueprintId);

    // Delete all R2 objects with the blueprint ID prefix.
    for (let v = 1; v <= kvRecord.metadata.version; v++) {
      await this.env.BLUEPRINT_CONTENT.delete(`${blueprintId}/${v}`);
    }

    // Delete from User DO.
    await this.user.deleteBlueprint(blueprintId);
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

  async getBlueprint(id: string): Promise<BlueprintPublicInfo | null> {
    let raw = await this.env.BLUEPRINTS.get(id);
    if (!raw) return null;

    let kvRecord = JSON.parse(raw) as {
      metadata: BlueprintMetadata;
      ownerId: string;
      gadgetId: string;
    };

    // Revive Date objects from JSON serialization.
    kvRecord.metadata.created = new Date(kvRecord.metadata.created);
    kvRecord.metadata.lastUpdated = new Date(kvRecord.metadata.lastUpdated);

    return {
      id,
      metadata: kvRecord.metadata,
    };
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
