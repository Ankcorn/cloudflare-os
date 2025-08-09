import { RpcSession, RpcTarget, WebSocketTransport } from "@cloudflare/jsrpc";
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
      if (req.method !== "GET") {
        return new Response("Method Not Allowed", {status: 405});
      }

      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket request", {status: 400});
      }

      let pair = new WebSocketPair();
      pair[0].accept();
      let transport = new WebSocketTransport(pair[0]);
      new RpcSession(transport, new PublicApiImpl());

      return new Response(null, {
        status: 101,
        webSocket: pair[1],
      });
    } else {
      return new Response("Not Found", {status: 404});
    }
  }
}
