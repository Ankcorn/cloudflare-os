// When Wrangler runs multiple workers at once, it only arranges for the "main" one to export an
// HTTP interface.
//
// But we actually need the Workshop and each gatekeeper to host web interfaces. So, we have the
// "main" Worker be this little router that routes to the others based on path prefix.

export default {
  async fetch(req, env, ctx) {
    let url = new URL(req.url);

    for (let key of Object.keys(env)) {
      if (!key.startsWith("GATEKEEPER_")) continue;
      let suffix = key.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
      let prefix = `/gatekeeper/${suffix}`;
      if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
        return env[key].fetch(req);
      }
    }

    // Note: gatekeeper OAuth redirects land on the gatekeeper Workers themselves, at
    // `/gatekeeper/<name>/oauth` (handled by the loop above) — there are no backend /auth callbacks.

    // Everything else goes to the backend. This includes the API routes (`/api`,
    // `/blueprint-screenshot`) as well as all frontend requests.
    //
    // In `run-local` mode the backend has a static `assets` binding configured (with
    // `run_worker_first` for the API routes), so it serves the pre-built single-page app for these
    // frontend requests. In normal dev mode the backend has no assets and frontend requests aren't
    // expected here -- run the Vite dev server with `pnpm dev-client` and open localhost:3000
    // directly instead. (We don't try to forward to localhost:3000 becaues it doesn't work well:
    // Vite's HMR socket gets disconnected every time wrangler restarts workerd.)
    return env.WORKSHOP_BACKEND.fetch(req);
  },

  async email(message, env, ctx) {
    await env.GATEKEEPER_EMAIL.email(message);
  }
}
