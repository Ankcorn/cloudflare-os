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

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return env.WORKSHOP_BACKEND.fetch(req);
    }

    // Redirect to Vite dev server for frontend.
    //
    // Note that unfortunately when viewing this way, the frontend will refresh whenever
    // wrangler restarts workerd. You may wish to open localhost:3000 directly in your
    // browser to avoid that.
    url.host = "localhost:3000";
    try {
      return await fetch(url, req);
    } catch (err) {
      return new Response(
          "Couldn't reach frontend dev server. Please run it with `pnpm run dev-client`.",
          {status: 500});
    }
  },

  async email(message, env, ctx) {
    await env.GATEKEEPER_EMAIL.email(message);
  }
}
