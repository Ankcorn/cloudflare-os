import { RpcStub, RpcTarget, newWorkersRpcResponse } from "capnweb";
import { PublicApi, AuthenticatedApi, Overseer, MinionMetadata, UiBundle, GatekeeperMetadata, GatekeeperClient, CodeFile, ActionState, ActionLogEntry } from '@minions/workshop-shared/api';
import { Gatekeeper, GatekeeperUser, GatekeeperVendor, UserId, ResourceDescription, ApprovalQueue, ActionDescription } from "@minions/workshop-shared/gatekeeper";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createTypedStorage, collection } from "@minions/typed-storage";

// TODO: Don't use this, use real user IDs.
const FAKE_USER_ID: UserId = {email: "fake@example.com"}

// TODO: Figure out why this isn't present in workers-types/experimental
interface WorkerCode {
  compatibilityDate: string,
  compatibilityFlags?: string[],
  allowExperimental?: boolean,
  mainModule: string,
  modules: Record<string, string>,
  env?: Object,
  globalOutbound?: Fetcher | null,
}
interface WorkerStub {
  getEntrypoint(name?: string | null, options?: {props: any}): Fetcher;
  getDurableObjectClass(name?: string | null, options?: {props: any}): DurableObjectClass<any>;
}

// Workers environment (bindings).
export interface Env {
  LOADER: WorkerLoader,
}

type UserGatekeeperRecord = {
  name: string;
  vendor: Fetcher<GatekeeperUser>;
};

function makeUserStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      minions: collection<MinionMetadata>()({
        primaryKey: "id"
      }),
      gatekeepers: collection<UserGatekeeperRecord>()({
        primaryKey: "name"
      }),
    }
  });
}

type UserStorage = ReturnType<typeof makeUserStorage>;

// Durable Object that stores information about a user.
export class UserDurableObject extends DurableObject<Env> {
  private storage: UserStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = makeUserStorage(ctx.storage);
  }

  async listMinions(): Promise<MinionMetadata[]> {
    return [...this.storage.minions.list()];
  }

  async updateTitle(minionId: string, title: string) {
    let record = this.storage.minions.get(minionId);
    if (!record) {
      throw new Error("No such minion belonging to user.");
    }
    record.title = title;
    this.storage.minions.put(record);
  }

  async getMinion(id: string): Promise<MinionMetadata | null> {
    return this.storage.minions.get(id) || null;
  }

  async newMinion(id: string, title: string): Promise<void> {
    this.storage.minions.put({id, title});
  }

  async deleteMinion(id: string): Promise<void> {
    this.storage.minions.delete(id);
  }

  async getGatekeeperClassFor(url: string): Promise<DurableObjectClass<Gatekeeper<any>>> {
    // TODO: Actually choose based on url.
    let name: string = "google";

    let result = this.storage.gatekeepers.get(name)?.vendor;
    if (!result) {
      // TODO: Registry of gatekeepers that isn't just bindings.
      let vendor: GatekeeperVendor | undefined =
          (<any>this.env)["GATEKEEPER_" + name.toUpperCase()];
      if (!vendor) {
        throw new Error(`No such gatekeeper installed: ${name}`);
      }
      result = await vendor.newUser(FAKE_USER_ID);

      this.storage.gatekeepers.put({name, vendor: result});
    }

    return await result.getGatekeeperClassFor(url);
  }
}

// =======================================================================================

let DEFAULT_SERVER_CODE = `
import { DurableObject } from "cloudflare:workers";

export class Minion extends DurableObject {
  greet(name) {
    return \`Hello, \${name}!\`;
  }
}
`.trim();

let DEFAULT_CLIENT_CODE = `
let greeting = await minion.greet("World");
document.body.appendChild(document.createTextNode(greeting));
`.trim();

// =======================================================================================

type GatekeeperClass = DurableObjectClass<Gatekeeper<any>>;

type GatekeeperRecord = {
  id: number,
  bindingName: string,
  class: GatekeeperClass,
};

type ActionRecord = {
  id: number,
  gatekeeperId: number;
  action: any;
  createdAt: Date;
  appliedAt?: Date;
  state: ActionState;
  description: ActionDescription;
};

function makeOverseerStorage(storage: DurableObjectStorage) {
  // TODO(cleanup): Remove <any> once workers-types are updated with sync KV interface.
  return createTypedStorage(<any>storage, {
    singletons: {
      // Initialized on first startup.
      ownerId: <string | undefined>undefined,

      title: "Untitled Minion",

      codeVersion: 0,

      nextGatekeeperId: 0,
      nextActionId: 0,
    },

    collections: {
      codeFiles: collection<CodeFile>()({
        primaryKey: "name"
      }),

      gatekeepers: collection<GatekeeperRecord>()({
        primaryKey: "id",
        uniqueIndexes: {
          byBindingName(gatekeeper: GatekeeperRecord) { return gatekeeper.bindingName; }
        }
      }),

      actions: collection<ActionRecord>()({
        primaryKey: "id"
      })
    }
  });
}

type OverseerStorage = ReturnType<typeof makeOverseerStorage>;

// Common internals that several interfaces implemented by the Overseer need to use. Can't just
// declare private methods because some of the methods are needed by multiple classes.
class OverseerImpl {
  public storage: OverseerStorage;

  // If not set, this minion doesn't exist yet.
  ownerId?: string;

  users: DurableObjectNamespace<UserDurableObject>;

  constructor(public ctx: DurableObjectState, public env: Env) {
    this.storage = makeOverseerStorage(ctx.storage);
    this.users = this.ctx.exports.UserDurableObject;
    this.ownerId = this.storage.ownerId.get();
  }

  async getMinionFacet(): Promise<Fetcher<DurableObject>> {
    let codeVersion = this.storage.codeVersion.get();

    return this.ctx.facets.get<DurableObject>("minion", () => {
      let stub = this.env.LOADER.get(`${this.ctx.id}.${codeVersion}`, async () => {
        let modules: Record<string, string> = {};

        for (let file of this.storage.codeFiles.list()) {
          // TODO: Better separation of client/server, etc.
          if (file.name != "client.js") {
            modules[file.name] = file.content;
          }
        }

        let env: Record<string, Fetcher> = {}
        for (let {id, bindingName} of this.storage.gatekeepers.list()) {
          let props = {
            overseerId: this.ctx.id.toString(),
            gatekeeperId: id,
          };
          env[bindingName] = this.ctx.exports.GatekeeperLoopback({props});
        }

        return {
          // TODO: compatibility date configuration
          compatibilityDate: "2025-08-01",
          mainModule: "server.js",
          modules,
          env,
          globalOutbound: null,
        };
      });

      return {
        class: stub.getDurableObjectClass<any>("Minion"),
        id: "minion"
      };
    });
  }

  getGatekeeperFacet(id: number): Fetcher<Gatekeeper<any>> {
    return this.ctx.facets.get(`gatekeeper${id}`, async () => {
      let cls = this.storage.gatekeepers.get(id)?.class;
      if (!cls) {
        throw new Error("no such gatekeeper?");
      }
      return {class: cls};
    });
  }

  removeGatekeeper(id: number) {
    this.ctx.facets.delete(`gatekeeper${id}`);
    this.storage.gatekeepers.delete(id);
  }

  startGatekeeperSession(id: number): Promise<any> {
    let client = new GatekeeperClientImpl(this, id, this.getGatekeeperFacet(id));
    return client.openSession();
  }

  async submitAction(gatekeeperId: number, action: any, description: ActionDescription)
      : Promise<void> {
    let actionId = this.storage.nextActionId.get();
    this.storage.nextActionId.put(actionId + 1);

    let record: ActionRecord = {
      id: actionId,
      gatekeeperId,
      action,
      createdAt: new Date(),
      state: "pending",
      description
    };
    this.storage.actions.put(record);
  }

  bumpVersion(): void {
    let codeVersion = this.storage.codeVersion.get();
    this.storage.codeVersion.put(codeVersion + 1);
    this.ctx.facets.abort("minion", new Error("Minion restarted due to code update."));
  }
}

export class OverseerDurableObject extends DurableObject<Env> {
  private impl: OverseerImpl;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.impl = new OverseerImpl(ctx, env);
  }

  async open(ownerId: string): Promise<Overseer> {
    if (!this.impl.ownerId) {
      // This Overseer hasn't been initialized yet.
      await this.ctx.blockConcurrencyWhile(async () => {
        // Verify that the owner believes it exists. The owner account must be initialized with
        // any new minions first before the minion is actually opened.
        let owner = this.impl.users.get(this.impl.users.idFromString(ownerId));
        let meta = await owner.getMinion(this.ctx.id.toString());
        if (!meta) {
          throw new Error("Not Found");
        }

        // Owner says we exist, so let's initialize ourselves.
        this.impl.ownerId = ownerId;

        this.impl.storage.ownerId.put(ownerId);
        this.impl.storage.codeFiles.put({
          name: "server.js",
          content: DEFAULT_SERVER_CODE
        });
        this.impl.storage.codeFiles.put({
          name: "client.js",
          content: DEFAULT_CLIENT_CODE
        });
      });
    }

    if (ownerId != this.impl.ownerId) {
      throw new Error("Unauthorized");
    }

    let notifyDeleted = () => {
      this.impl.ownerId = undefined;
    };

    let owner = this.impl.users.get(this.impl.users.idFromString(this.impl.ownerId));
    return new OverseerClientInterface(this.impl, owner, notifyDeleted);
  }

  async startGatekeeperSession(id: number): Promise<any> {
    return this.impl.startGatekeeperSession(id);
  }
}

type GatekeeperLoopbackProps = {
  overseerId: string;
  gatekeeperId: number;
};

// Horrible hack: At present the `env` of a dynamic isolate can contain ServiceStubs but cannot
// contain RpcStubs. But if we ask the gatekeeper to open a session, we get an RpcStub. So we
// actually initialize each binding to be a `ServiceStub` pointing at a `GatekeeperLoopback` whose
// props identify the overseer ID and gatekeeper ID, so that on each method call, it can open
// a gatekeeper session.
export class GatekeeperLoopback extends WorkerEntrypoint<Env, GatekeeperLoopbackProps> {
  constructor(ctx: ExecutionContext<GatekeeperLoopbackProps>, env: Env) {
    super(ctx, env);

    let ns = ctx.exports.OverseerDurableObject;
    let stub: DurableObjectStub<OverseerDurableObject> =
        ns.get(ns.idFromString(ctx.props.overseerId));
    let gatekeeper = stub.startGatekeeperSession(this.ctx.props.gatekeeperId);

    return new Proxy(gatekeeper, {
      get(target, prop, receiver) {
        // Note: We need `target` to be used as the receiver. If we use `receiver` as the receiver,
        //   we'll get an illegal invocation, as `receiver` points to our Proxy.
        return Reflect.get(target, prop, target);
      },
      getPrototypeOf(target) {
        return WorkerEntrypoint.prototype;
      }
    });
  }
}

class OverseerClientInterface extends RpcTarget implements Overseer {
  constructor(private impl: OverseerImpl,
              private owner: DurableObjectStub<UserDurableObject>,
              private notifyDeleted: () => void) {
    super();
  }

  async getMetadata(): Promise<MinionMetadata> {
    let title: string = this.impl.storage.title.get();

    return { id: this.impl.ctx.id.toString(), title };
  }

  async setTitle(title: string): Promise<void> {
    this.impl.storage.title.put(title);
    await this.owner.updateTitle(this.impl.ctx.id.toString(), title);
  }

  async deleteSelf(): Promise<void> {
    await this.impl.ctx.blockConcurrencyWhile(async () => {
      await this.owner.deleteMinion(this.impl.ctx.id.toString());
      await this.impl.ctx.storage.deleteAll();
      this.notifyDeleted();
    });
  }

  async getCode(): Promise<CodeFile[]> {
    return [...this.impl.storage.codeFiles.list()];
  }
  async setCodeFile(name: string, content: string): Promise<void> {
    this.impl.storage.codeFiles.put({name, content});
    this.impl.bumpVersion();
  }
  async deleteCodeFile(name: string): Promise<void> {
    this.impl.storage.codeFiles.delete(name);
  }

  async getUiBundle(): Promise<UiBundle | null> {
    // TODO: Bundle the UI? For now we just return client.js.
    let file = this.impl.storage.codeFiles.get("client.js");
    if (file) {
      return { jsCode: file.content };
    } else {
      return null;
    }
  }

  async connectToMinion(): Promise<RpcStub<any>> {
    let facet = await this.impl.getMinionFacet();

    // TODO: Make possible to return facet stub over RPC. This Proxy is a hack.
    return new Proxy(facet, {
      get(target, prop, receiver) {
        // Note: We need `target` to be used as the receiver. If we use `receiver` as the receiver,
        //   we'll get an illegal invocation, as `receiver` points to our Proxy.
        return Reflect.get(target, prop, target);
      },
      getPrototypeOf(target) {
        return RpcTarget.prototype;
      }
    });
  }

  async listGatekeepers(): Promise<GatekeeperMetadata[]> {
    let promises = [...this.impl.storage.gatekeepers.list()].map(async ({id, bindingName}) => {
      let description = await this.impl.getGatekeeperFacet(id).describe();

      let result: GatekeeperMetadata = {
        bindingName,
        resourceTitle: description.title?.text || "Unknown Title"
      };

      return result;
    });

    return await Promise.all(promises);
  }

  async getGatekeeper(bindingName: string): Promise<GatekeeperClient<any> | null> {
    let id = this.impl.storage.gatekeepers.byBindingName.get(bindingName)?.id;
    if (id === undefined) {
      throw new Error(`No such binding: ${bindingName}`);
    }
    return new GatekeeperClientImpl(this.impl, id, this.impl.getGatekeeperFacet(id));
  }

  async newGatekeeper(resourceUrl: string): Promise<GatekeeperClient<any> | null> {
    let cls: GatekeeperClass = await this.owner.getGatekeeperClassFor(resourceUrl);

    let id = this.impl.storage.nextGatekeeperId.get();
    this.impl.storage.nextGatekeeperId.put(id + 1);
    this.impl.storage.gatekeepers.put({
      id,
      bindingName: `NEW_BINDING_${id}`,
      class: cls
    });

    this.impl.bumpVersion();

    return new GatekeeperClientImpl(this.impl, id!, this.impl.getGatekeeperFacet(id!));
  }

  async listActions(): Promise<ActionLogEntry[]> {
    let bindingMap: Record<number, string> = {};
    for (let {id, bindingName} of this.impl.storage.gatekeepers.list()) {
      bindingMap[id] = bindingName;
    }

    let result: ActionLogEntry[] = [];
    for (let record of this.impl.storage.actions.list()) {
      result.push({
        id: record.id,
        bindingName: bindingMap[record.gatekeeperId] || "(deleted binding)",
        createdAt: record.createdAt,
        appliedAt: record.appliedAt,
        state: record.state,
        description: record.description,
      });
    }

    return result;
  }

  async approveAction(id: number): Promise<void> {
    let action = this.impl.storage.actions.get(id);
    if (!action) {
      throw new Error(`No such action: ${id}`);
    }

    if (action.state !== "pending") {
      throw new Error(`Action is not pending: ${id}`);
    }

    let gatekeeper = this.impl.getGatekeeperFacet(action.gatekeeperId);

    // TODO: Store `revertInfo`.
    await gatekeeper.applyAction(action.action);

    action.state = "approved";
    action.appliedAt = new Date();
    this.impl.storage.actions.put(action);
  }

  async rejectAction(id: number): Promise<void> {
    let action = this.impl.storage.actions.get(id);
    if (!action) {
      throw new Error(`No such action: ${id}`);
    }

    if (action.state !== "pending") {
      throw new Error(`Action is not pending: ${id}`);
    }

    let gatekeeper = this.impl.getGatekeeperFacet(action.gatekeeperId);

    // TODO: Store `revertInfo`.
    await gatekeeper.rejectAction(action.action);

    action.state = "rejected";
    this.impl.storage.actions.put(action);
  }
}

class GatekeeperClientImpl<Session> extends RpcTarget implements GatekeeperClient<Session> {
  constructor(private impl: OverseerImpl, private id: number,
      private facet: Fetcher<Gatekeeper<Session>>) {
    super();
  }

  async remove(): Promise<void> {
    this.impl.removeGatekeeper(this.id);
  }

  async getBindingName(): Promise<string> {
    return this.impl.storage.gatekeepers.get(this.id)!.bindingName;
  }
  async setBindingName(name: string): Promise<void> {
    let record = this.impl.storage.gatekeepers.get(this.id)!;
    record.bindingName = name;
    this.impl.storage.gatekeepers.put(record);
    this.impl.bumpVersion();
  }

  async describe(): Promise<ResourceDescription> {
    return this.facet.describe();
  }

  async openSession(): Promise<Session> {
    let description = await this.facet.describe();

    // TODO: Track actual permissions.
    let permissions = description.adapterPermissions;

    return this.facet.startSession(permissions, new ApprovalQueueImpl(this.impl, this.id));
  }
}

class ApprovalQueueImpl<Action> extends RpcTarget implements ApprovalQueue<Action> {
  constructor(private impl: OverseerImpl, private gatekeeperId: number) {
    super();
  }

  submit(action: Action, description: ActionDescription): Promise<void> {
    return this.impl.submitAction(this.gatekeeperId, action, description);
  }
}

// =======================================================================================

class AuthenticatedApiImpl extends RpcTarget implements AuthenticatedApi {
  constructor(private ctx: ExecutionContext, private user: DurableObjectStub<UserDurableObject>) {
    super();

    this.overseers = this.ctx.exports.OverseerDurableObject;
  }

  private overseers: DurableObjectNamespace<OverseerDurableObject>;

  async openMinion(id: string): Promise<Overseer> {
    let userId = this.user.id.toString();

    let overseer = this.overseers.get(this.overseers.idFromString(id));

    return overseer.open(userId);
  }

  async newMinion(): Promise<Overseer> {
    let id = this.overseers.newUniqueId().toString();
    await this.user.newMinion(id, "Untitled Minion");
    let result = await this.openMinion(id);
    if (!result) {
      throw new Error("Open failed despite newly-created minion?");
    }
    return result;
  }

  async listMinions(): Promise<MinionMetadata[]> {
    return this.user.listMinions();
  }
}

class PublicApiImpl extends RpcTarget implements PublicApi {
  users: DurableObjectNamespace<UserDurableObject>;

  constructor(private ctx: ExecutionContext) {
    super();
    this.users = this.ctx.exports.UserDurableObject;
  }

  async authenticate(token: string): Promise<AuthenticatedApi> {
    let userId = this.users.idFromString(token);
    return new AuthenticatedApiImpl(this.ctx, this.users.get(userId));
  }

  async login(username: string, password: string): Promise<string | null> {
    // TODO: Either implement this properly or replace it.
    let id = this.users.idFromName(username);
    if (password == "hunter2") {
      return id.toString();
    } else {
      return null;
    }
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
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
} satisfies ExportedHandler<Env>;
