import { RpcStub, RpcTarget, newWorkersRpcResponse } from "@cloudflare/jsrpc";
import { PublicApi, AuthenticatedApi, Overseer, MinionMetadata, UiCode, GatekeeperMetadata, GatekeeperClient } from '@minions/workshop-shared/api';
import { DurableObject } from "cloudflare:workers";

// Workers environment (bindings).
export interface Env {}

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
}

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
        await this.ctx.storage.put("ownerId", ownerId);
        await this.ctx.storage.put("title", meta.title);
        await this.ctx.storage.put("version", 1);
      });
    }

    if (ownerId != this.ownerId) {
      throw new Error("Unauthorized");
    }

    let owner = this.users.get(this.users.idFromString(this.ownerId));
    return new OverseerImpl(this.ctx, owner);
  }
}

class OverseerImpl extends RpcTarget implements Overseer {
  constructor(private ctx: DurableObjectState,
              private owner: DurableObjectStub<UserDurableObject>) {
    super();
  }

  async getMetadata(): Promise<MinionMetadata> {
    let title: string = (await this.ctx.storage.get("title"))!;

    return { id: this.ctx.id.toString(), title };
  }

  async setTitle(title: string): Promise<void> {
    await this.ctx.storage.put("title", title);
    await this.owner.updateTitle(this.ctx.id.toString(), title);
  }

  async getUiCode(): Promise<UiCode | null> {
    return null;
  }

  async connectToMinion(): Promise<RpcStub<any>> {
    throw new Error("unimplemented: connectToMinion()");
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
