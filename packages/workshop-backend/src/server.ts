import { RpcStub, RpcTarget, newWorkersRpcResponse } from "@cloudflare/jsrpc";
import { PublicApi, AuthenticatedApi, Overseer, MinionMetadata, UiBundle, GatekeeperMetadata, GatekeeperClient, CodeFile, ActionState, ActionLogEntry } from '@minions/workshop-shared/api';
import { Gatekeeper, GatekeeperUser, GatekeeperVendor, UserId, DurableObjectClass, ResourceDescription, ApprovalQueue, ActionDescription } from "@minions/workshop-shared/gatekeeper";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

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
interface WorkerLoader {
  get(name: string, load: () => Promise<WorkerCode>): WorkerStub;
}

// Workers environment (bindings).
export interface Env {
  LOADER: WorkerLoader,
}

// Durable Object that stores information about a user.
export class UserDurableObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      let version: number = await ctx.storage.get("version") || 0;

      if (version < 1) {
        this.sql.exec(`
          CREATE TABLE IF NOT EXISTS minions (
            id TEXT PRIMARY KEY,
            title TEXT
          )
        `);

        await ctx.storage.put("version", 1);
      }
    });
  }

  async listMinions(): Promise<MinionMetadata[]> {
    return <MinionMetadata[]>this.sql.exec(`
      SELECT id, title FROM minions
    `).toArray();
  }

  async updateTitle(minionId: string, title: string) {
    this.sql.exec(`
      UPDATE minions SET title = ? WHERE id = ?
    `, title, minionId);
  }

  async getMinion(id: string): Promise<MinionMetadata | null> {
    let record = this.sql.exec(`
      SELECT id, title FROM minions WHERE id = ?
    `, id).next().value || null;

    return <MinionMetadata | null>record;
  }

  async newMinion(id: string, title: string): Promise<void> {
    this.sql.exec(`
      INSERT INTO minions(id, title) VALUES (?, ?)
    `, id, title);
  }

  async deleteMinion(id: string): Promise<void> {
    this.sql.exec(`
      DELETE FROM minions WHERE id = ?
    `, id);
  }

  async getGatekeeperClassFor(url: string): Promise<DurableObjectClass<Gatekeeper<any>>> {
    // TODO: Actually choose based on url.
    let name: string = "google";

    let key: string = `gatekeeper:${name}`;
    let result = await this.ctx.storage.get<Fetcher<GatekeeperUser>>(key);

    if (!result) {
      // TODO: Registry of gatekeepers that isn't just bindings.
      let vendor: GatekeeperVendor | undefined =
          (<any>this.env)["GATEKEEPER_" + name.toUpperCase()];
      if (!vendor) {
        throw new Error(`No such gatekeeper installed: ${name}`);
      }
      result = await vendor.newUser(FAKE_USER_ID);

      await this.ctx.storage.put<Fetcher<GatekeeperUser>>(key, vendor);
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

// Common internals that several interfaces implemented by the Overseer need to use. Can't just
// declare private methods because some of the methods are needed by multiple classes.
class OverseerImpl {
  storage: DurableObjectStorage;
  sql: SqlStorage;

  // If not set, this minion doesn't exist yet.
  ownerId?: string;

  users: DurableObjectNamespace<UserDurableObject>;

  constructor(public ctx: DurableObjectState, public env: Env) {
    this.storage = ctx.storage;
    this.sql = this.storage.sql;
    this.users = this.ctx.exports.UserDurableObject;

    ctx.blockConcurrencyWhile(async () => {
      this.ownerId = await ctx.storage.get("ownerId");
    });
  }

  async getMinionFacet(): Promise<DurableObjectStub<any>> {
    let codeVersion: number = await this.storage.get("codeVersion") || 0;

    return this.ctx.facets.get("minion", () => {
      let stub = this.env.LOADER.get(`${this.ctx.id}.${codeVersion}`, async () => {
        let modules: Record<string, string> = {};
        for (let row of this.sql.exec(`SELECT name, content FROM files`)) {
          let file = <CodeFile>row;
          // TODO: Better separation of client/server, etc.
          if (file.name != "client.js") {
            modules[file.name] = file.content;
          }
        }

        let env: Record<string, Fetcher> = {}
        for (let {id, bindingName} of this.sql.exec<{id: number, bindingName: string}>(`
          SELECT id, bindingName FROM gatekeepers
        `)) {
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
        class: stub.getDurableObjectClass("Minion"),
        id: "minion"
      };
    });
  }

  getGatekeeperFacet(id: number): DurableObjectStub<Gatekeeper<any>> {
    return this.ctx.facets.get(`gatekeeper${id}`, async () => {
      let cls = await this.storage.get<GatekeeperClass>(`gatekeeperClass:${id}`);
      if (!cls) {
        throw new Error("no such gatekeeper?");
      }
      return {class: cls};
    });
  }

  removeGatekeeper(id: number) {
    this.ctx.facets.delete(`gatekeeper${id}`);
    this.sql.exec(`
      DELETE FROM gatekeepers WHERE id = ?
    `, id);
  }

  startGatekeeperSession(id: number): Promise<any> {
    let client = new GatekeeperClientImpl(this, id, this.getGatekeeperFacet(id));
    return client.openSession();
  }

  actionKey(actionId: number): string {
    return `action:${actionId.toString(16).padStart(8, '0')}`;
  }

  async submitAction(gatekeeperId: number, action: any, description: ActionDescription)
      : Promise<void> {
    let actionId = (await this.storage.get<number>("nextActionId")) || 0;
    await this.storage.put("nextActionId", actionId + 1);

    let key = this.actionKey(actionId);
    let record: ActionRecord = {
      gatekeeperId,
      action,
      createdAt: new Date(),
      state: "pending",
      description
    };
    await this.storage.put<ActionRecord>(key, record);
  }

  async bumpVersion(): Promise<void> {
    let codeVersion: number = await this.storage.get("codeVersion") || 0;
    await this.storage.put("codeVersion", codeVersion + 1);
    this.ctx.facets.abort("minion", new Error("Minion restarted due to code update."));
  }
}

type ActionRecord = {
  gatekeeperId: number;
  action: any;
  createdAt: Date;
  appliedAt?: Date;
  state: ActionState;
  description: ActionDescription;
};

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

        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.put("ownerId", ownerId);
          this.ctx.storage.put("title", meta.title);
          this.ctx.storage.put("version", 1);

          this.impl.sql.exec(`
            CREATE TABLE files (
              name TEXT PRIMARY KEY,
              content TEXT
            )
          `);

          this.impl.sql.exec(`
            INSERT INTO files(name, content) VALUES (?, ?)
          `, "server.js", DEFAULT_SERVER_CODE);
          this.impl.sql.exec(`
            INSERT INTO files(name, content) VALUES (?, ?)
          `, "client.js", DEFAULT_CLIENT_CODE);

          this.impl.sql.exec(`
            CREATE TABLE gatekeepers (
              id INTEGER PRIMARY KEY,
              bindingName TEXT
            );
            CREATE UNIQUE INDEX gatekeepersByName ON gatekeepers(bindingName)
          `);
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

// Horrible hack: At present the `env` of a dynamic isolate can contain ServiceStubs but cannot
// contain RpcStubs. But if we ask the gatekeeper to open a session, we get an RpcStub. So we
// actually initialize each binding to be a `ServiceStub` pointing at a `GatekeeperLoopback` whose
// props identify the overseer ID and gatekeeper ID, so that on each method call, it can open
// a gatekeeper session.
export class GatekeeperLoopback extends WorkerEntrypoint<Env> {
  constructor(ctx: ExecutionContext, env: Env) {
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
    let title: string = (await this.impl.ctx.storage.get("title"))!;

    return { id: this.impl.ctx.id.toString(), title };
  }

  async setTitle(title: string): Promise<void> {
    await this.impl.storage.put("title", title);
    await this.owner.updateTitle(this.impl.ctx.id.toString(), title);
  }

  async deleteSelf(): Promise<void> {
    await this.impl.ctx.blockConcurrencyWhile(async () => {
      await this.owner.deleteMinion(this.impl.ctx.id.toString());
      await this.impl.storage.deleteAll();
      this.notifyDeleted();
    });
  }

  async getCode(): Promise<CodeFile[]> {
    return <CodeFile[]>this.impl.sql.exec(`
      SELECT name, content FROM files
    `).toArray();
  }
  async setCodeFile(name: string, content: string): Promise<void> {
    this.impl.sql.exec(`
      INSERT INTO files(name, content) VALUES (?, ?)
        ON CONFLICT DO UPDATE SET content = excluded.content
    `, name, content);

    await this.impl.bumpVersion();
  }
  async deleteCodeFile(name: string): Promise<void> {
    this.impl.sql.exec(`
      DELETE FROM files WHERE name = ?
    `, name);
  }

  async getUiBundle(): Promise<UiBundle | null> {
    // TODO: Bundle the UI? For now we just return client.js.
    let {value} = this.impl.sql.exec(`
      SELECT content FROM files WHERE name = ?
    `, "client.js").next();

    if (value) {
      return { jsCode: <string>value.content };
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
    let promises = this.impl.sql.exec<{id: number, bindingName: string}>(`
      SELECT id, bindingName FROM gatekeepers
    `).toArray().map(async ({id, bindingName}) => {
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
    let id = this.impl.sql.exec<{id: number}>(`
      SELECT id FROM gatekeepers WHERE bindingName = ?
    `, bindingName).one().id;

    return new GatekeeperClientImpl(this.impl, id!, this.impl.getGatekeeperFacet(id!));
  }

  async newGatekeeper(resourceUrl: string): Promise<GatekeeperClient<any> | null> {
    let cls: GatekeeperClass = await this.owner.getGatekeeperClassFor(resourceUrl);

    let id: number;
    this.impl.storage.transactionSync(() => {
      let result = this.impl.sql.exec(`
        INSERT INTO gatekeepers DEFAULT VALUES RETURNING id
      `).one();
      id = <number>result.id;

      let bindingName = `NEW_BINDING_${id}`;
      this.impl.sql.exec(`
        UPDATE gatekeepers SET bindingName = ? WHERE id = ?
      `, bindingName, id);

      this.impl.storage.put<GatekeeperClass>(`gatekeeperClass:${id}`, cls )
    });

    await this.impl.bumpVersion();

    return new GatekeeperClientImpl(this.impl, id!, this.impl.getGatekeeperFacet(id!));
  }

  async listActions(): Promise<ActionLogEntry[]> {
    let bindingMap: Record<number, string> = {};
    for (let {id, bindingName} of this.impl.sql.exec<{id: number, bindingName: string}>(`
      SELECT id, bindingName FROM gatekeepers
    `)) {
      bindingMap[id] = bindingName;
    }

    let list = await this.impl.storage.list<ActionRecord>({prefix: "action:"});
    let result: ActionLogEntry[] = [];
    for (let [key, record] of list) {
      let id = parseInt(key.slice("action:".length), 16);
      result.push({
        id,
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
    let key = this.impl.actionKey(id);
    let action = await this.impl.storage.get<ActionRecord>(key);
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
    await this.impl.storage.put<ActionRecord>(key, action);
  }

  async rejectAction(id: number): Promise<void> {
    let key = this.impl.actionKey(id);
    let action = await this.impl.storage.get<ActionRecord>(key);
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
    await this.impl.storage.put<ActionRecord>(key, action);
  }
}

class GatekeeperClientImpl<Session> extends RpcTarget implements GatekeeperClient<Session> {
  constructor(private impl: OverseerImpl, private id: number,
      private facet: DurableObjectStub<Gatekeeper<Session>>) {
    super();
  }

  async remove(): Promise<void> {
    this.impl.removeGatekeeper(this.id);
  }

  async getBindingName(): Promise<string> {
    return this.impl.sql.exec<{bindingName: string}>(`
      SELECT bindingName FROM gatekeepers WHERE id = ?
    `, this.id).one().bindingName;
  }
  async setBindingName(name: string): Promise<void> {
    this.impl.sql.exec(`
      UPDATE gatekeepers SET bindingName = ? WHERE id = ?
    `, name, this.id);

    await this.impl.bumpVersion();
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
}
