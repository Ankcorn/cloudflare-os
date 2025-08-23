import { WorkerEntrypoint } from "cloudflare:workers";

export default {
  async fetch(req, env, ctx) {
    return new Response("TODO: Google Gatekeeper UI");
  }
}

export class GatekeeperVendor extends WorkerEntrypoint {
  status() {
    return "Google Gatekeeper";
  }
}
