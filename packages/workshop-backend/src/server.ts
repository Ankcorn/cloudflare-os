import { RpcTarget, newWorkersRpcResponse } from "@cloudflare/jsrpc";
import { PublicApi, AuthenticatedApi, Overseer, MinionMetadata } from '@minions/workshop-shared/api';
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Workers environment (bindings).
interface Env {}

// Durable Object that stores information about a user.
export class UserAccount extends DurableObject<Env> {
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
            title TEXT,
          )
        `);

        await ctx.storage.put("version", 1);
      }
    });
  }

  async listMinions(): Promise<MinionMetadata[]> {
    // TODO: Returning fake data for now while iterating on UI. Replace with real data later.
    return [
      {id: "fake1", title: "Fake Minion 1"},
      {id: "fake2", title: "Fake Minion 2"},
    ];
  }
}

class AuthenticatedApiImpl extends RpcTarget implements AuthenticatedApi {
  constructor(private ctx: ExecutionContext, private user: DurableObjectStub<UserAccount>) {
    super();
  }

  async openMinion(id: string): Promise<Overseer | null> {
    throw new Error("unimplemented");
  }

  async newMinion(): Promise<Overseer> {
    throw new Error("unimplemented");
  }

  async listMinions(): Promise<MinionMetadata[]> {
    return this.user.listMinions();
  }
}

class PublicApiImpl extends RpcTarget implements PublicApi {
  users: DurableObjectNamespace<UserAccount>;

  constructor(private ctx: ExecutionContext) {
    super();
    this.users = this.ctx.exports.UserAccount;
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
