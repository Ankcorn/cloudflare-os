import { RpcTarget, newWorkersRpcResponse } from "@cloudflare/jsrpc";
import { PublicApi, AuthenticatedApi } from '@minions/workshop-shared/api';

interface Env {}

class PublicApiImpl extends RpcTarget implements PublicApi {
  authenticate(token: string): Promise<AuthenticatedApi> {
    throw new Error("unimplemented");
  }

  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);

    if (url.pathname === "/api") {
      return newWorkersRpcResponse(req, new PublicApiImpl());
    } else {
      return new Response("Not Found", {status: 404});
    }
  }
}
