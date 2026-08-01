// The public origin of a gadgets instance. Routes by path prefix to the workshop backend and
// whichever gatekeepers are bound, and serves the workshop frontend for everything else.
//
// Routing config IS the binding set: gatekeepers are discovered by scanning `GATEKEEPER_*` env
// keys, so installing a gatekeeper only requires re-deploying this worker with one more service
// binding — no code or config changes here.
//
// The same worker doubles as the dev router (`pnpm dev-server` at the repo root): dev has no
// `ASSETS` binding, so frontend requests proxy to the Vite dev server instead.

export interface Env {
  WORKSHOP_BACKEND: Fetcher;
  // Present in production (wrangler.jsonc assets stanza); absent in dev.
  ASSETS?: Fetcher;
  // Dormant until custom domains + Email Routing exist; the handler ships anyway.
  GATEKEEPER_EMAIL?: Service;
  [key: string]: unknown;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    for (const key of Object.keys(env)) {
      if (!key.startsWith("GATEKEEPER_")) continue;
      const suffix = key.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
      const prefix = `/gatekeeper/${suffix}`;
      if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
        return (env[key] as Fetcher).fetch(req);
      }
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
        url.pathname === "/blueprint-screenshot" ||
        url.pathname.startsWith("/blueprint-screenshot/")) {
      return env.WORKSHOP_BACKEND.fetch(req);
    }

    // Note: gatekeeper OAuth redirects land on the gatekeeper Workers themselves, at
    // `/gatekeeper/<name>/oauth` (handled by the loop above) — there are no backend /auth
    // callbacks.

    if (env.ASSETS) {
      return env.ASSETS.fetch(req);
    }

    // Dev only: proxy to the Vite dev server.
    //
    // Note that unfortunately when viewing this way, the frontend will refresh whenever
    // wrangler restarts workerd. You may wish to open localhost:3000 directly in your
    // browser to avoid that.
    url.host = "localhost:3000";
    try {
      return await fetch(url, req);
    } catch {
      return new Response(
          "Couldn't reach frontend dev server. Please run it with `pnpm run dev-client`.",
          {status: 500});
    }
  },

  async email(message, env) {
    if (!env.GATEKEEPER_EMAIL) {
      message.setReject("No email gatekeeper is installed on this instance.");
      return;
    }
    await (env.GATEKEEPER_EMAIL as unknown as { email(m: ForwardableEmailMessage): Promise<void> })
        .email(message);
  },
} satisfies ExportedHandler<Env>;
