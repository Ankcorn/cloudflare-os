// When Wrangler runs multiple workers at once, it only arranges for the "main" one to export an
// HTTP interface.
//
// But we actually need the Workshop and each gatekeeper to host web interfaces. So, we have the
// "main" Worker be this little router that routes to the others based on hostname.

export default {
  async fetch(req, env, ctx) {
    let url = new URL(req.url);

    switch (url.hostname) {
      case "localhost":
        // Annoyingly, Google refuses to let me use "google.localhost" as a redirect URI, saying
        // it's an invalid hostname.
        if (url.pathname === "/oauth/google") {
          return env.GATEKEEPER_GOOGLE.fetch(req);
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
              "Couldn't reach frontend dev server. Please run it with `pnpn run dev-client`.",
              {status: 500});
        }
      case "api.localhost":
        return env.WORKSHOP_BACKEND.fetch(req);
      case "google.localhost":
        return env.GATEKEEPER_GOOGLE.fetch(req);
      case "email.localhost":
        return env.GATEKEEPER_EMAIL.fetch(req);
      default:
        return new Response(`Hostname not mapped: ${url.hostname}`, {status: 404});
    }
  },

  async email(message, env, ctx) {
    await env.GATEKEEPER_EMAIL.email(message);
  }
}
