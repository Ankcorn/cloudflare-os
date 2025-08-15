import { RpcStub, RpcTarget, newWorkersRpcResponse } from "@cloudflare/jsrpc";
import { PublicApi, AuthenticatedApi, Overseer, MinionMetadata, UiBundle, GatekeeperMetadata, GatekeeperClient, CodeFile } from '@minions/workshop-shared/api';
import { DurableObject } from "cloudflare:workers";

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
  getDurableObjectClass(name?: string | null, options?: {props: any}): DurableObjectClass;
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

export class OverseerDurableObject extends DurableObject<Env> {
  private sql: SqlStorage;

  // If not set, this minion doesn't exist yet.
  private ownerId?: string;

  private users: DurableObjectNamespace<UserDurableObject>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.users = this.ctx.exports.UserDurableObject;

    ctx.blockConcurrencyWhile(async () => {
      this.ownerId = await ctx.storage.get("ownerId");
    });
  }

  async open(ownerId: string): Promise<Overseer> {
    if (!this.ownerId) {
      // This Overseer hasn't been initialized yet.
      await this.ctx.blockConcurrencyWhile(async () => {
        // Verify that the owner believes it exists. The owner account must be initialized with
        // any new minions first before the minion is actually opened.
        let owner = this.users.get(this.users.idFromString(ownerId));
        let meta = await owner.getMinion(this.ctx.id.toString());
        if (!meta) {
          throw new Error("Not Found");
        }

        // Owner says we exist, so let's initialize ourselves.
        this.ownerId = ownerId;

        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.put("ownerId", ownerId);
          this.ctx.storage.put("title", meta.title);
          this.ctx.storage.put("version", 1);

          this.sql.exec(`
            CREATE TABLE files (
              name TEXT PRIMARY KEY,
              content TEXT
            )
          `);

          this.sql.exec(`
            INSERT INTO files(name, content) VALUES (?, ?)
          `, "server.js", DEFAULT_SERVER_CODE);
          this.sql.exec(`
            INSERT INTO files(name, content) VALUES (?, ?)
          `, "client.js", DEFAULT_CLIENT_CODE);
        });
      });
    }

    if (ownerId != this.ownerId) {
      throw new Error("Unauthorized");
    }

    let notifyDeleted = () => {
      this.ownerId = undefined;
    };

    let owner = this.users.get(this.users.idFromString(this.ownerId));
    return new OverseerImpl(this.ctx, this.env, owner, notifyDeleted);
  }
}

class OverseerImpl extends RpcTarget implements Overseer {
  private sql: SqlStorage;

  constructor(private ctx: DurableObjectState,
              private env: Env,
              private owner: DurableObjectStub<UserDurableObject>,
              private notifyDeleted: () => void) {
    super();
    this.sql = ctx.storage.sql;
  }

  async getMetadata(): Promise<MinionMetadata> {
    let title: string = (await this.ctx.storage.get("title"))!;

    return { id: this.ctx.id.toString(), title };
  }

  async setTitle(title: string): Promise<void> {
    await this.ctx.storage.put("title", title);
    await this.owner.updateTitle(this.ctx.id.toString(), title);
  }

  async deleteSelf(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.owner.deleteMinion(this.ctx.id.toString());
      await this.ctx.storage.deleteAll();
      this.notifyDeleted();
    });
  }

  async getCode(): Promise<CodeFile[]> {
    return <CodeFile[]>this.sql.exec(`
      SELECT name, content FROM files
    `).toArray();
  }
  async setCodeFile(name: string, content: string): Promise<void> {
    this.sql.exec(`
      INSERT INTO files(name, content) VALUES (?, ?)
        ON CONFLICT DO UPDATE SET content = excluded.content
    `, name, content);

    let codeVersion: number = await this.ctx.storage.get("codeVersion") || 0;
    await this.ctx.storage.put("codeVersion", codeVersion + 1);
  }
  async deleteCodeFile(name: string): Promise<void> {
    this.sql.exec(`
      DELETE FROM files WHERE name = ?
    `, name);
  }

  async getUiBundle(): Promise<UiBundle | null> {
    // TODO: Bundle the UI? For now we just return client.js.
    let {value} = this.sql.exec(`
      SELECT content FROM files WHERE name = ?
    `, "client.js").next();

    if (value) {
      return { jsCode: <string>value.content };
    } else {
      return null;
    }
  }

  async connectToMinion(): Promise<RpcStub<any>> {
    let codeVersion: number = await this.ctx.storage.get("codeVersion") || 0;

    let facet = this.ctx.facets.get("minion", () => {
      let stub = this.env.LOADER.get(`${this.ctx.id}.${codeVersion}`, async () => {
        let modules: Record<string, string> = {};
        for (let row of this.sql.exec(`SELECT name, content FROM files`)) {
          let file = <CodeFile>row;
          // TODO: Better separation of client/server, etc.
          if (file.name != "client.js") {
            modules[file.name] = file.content;
          }
        }

        return {
          // TODO: compatibility date configuration
          compatibilityDate: "2025-08-01",
          mainModule: "server.js",
          modules,
          env: {},  // TODO: connections
          globalOutbound: null,
        };
      });

      return {
        class: stub.getDurableObjectClass("Minion"),
        id: "minion"
      };
    });

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
    return [];
  }

  async getGatekeeper(bindingName: string): Promise<GatekeeperClient<any> | null> {
    return null;
  }

  async newGatekeeper(resourceUrl: string): Promise<GatekeeperClient<any> | null> {
    throw new Error("unimplemented: newGatekeeper()");
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
    } else {
      return new Response("Not Found", {status: 404});
    }
  }
}
