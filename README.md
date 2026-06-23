# WARNING! ALPHA! WARNING!

This is alpha-quality, unreleased software. There's a lot that doesn't yet work the way we want it to. Expect some jank.

# What this is

This is a demonstration of an agent harness and vibe coding environment built entirely on Workers.
* No containers are involved: All agent-written code is sandboxed using Dynamic Workers.
* No external storage: All storage is in SQLite databases attached to Durable Objects.
* Strong isolation: Agents and apps cannot access the internet. They can only access the resources you specifically attach.
* Works 100% on local workerd.
* The only external service dependency is the LLM.

# How to run

1. Install pnpm if you haven't already: `npm install -g pnpm`
2. Run `pnpm install`.
3. Run `pnpm build`.
4. Start the server: `pnpm run dev-server`
    * To enable Workers AI models, use `pnpm run dev-server -- --use-workers-ai-binding`, but this will require Cloudflare login.
5. Start the client: `pnpm run dev-client`
6. Visit `localhost:3000`
7. Create an account and log in.
8. Add one or more AI providers.
9. Make a gadget. Have fun.

# What to try

* "Make a collaborative whiteboard app."
* "Make a tic tac toe game."
* "Make an issue dashboard for this GitHub repo." (Attach a repo; requires GitHub integration is configured.)
* "Fix the typos in this Google Doc." (Attach a doc; requires Google integration is configured.)

# Enabling external APIs

To enable support for external APIs, you must do further configuration to register credentials to access each API. This is described in the README.md files in various gatekeeper packages:

* [GitHub API](packages/gatekeeper-github/README.md)
* [Google API](packages/gatekeeper-google/README.md)
* [Cloudflare API](packages/gatekeeper-cloudflare/README.md)
* [Supabase API](packages/gatekeeper-supabase/README.md)
* [Email Workers](packages/gatekeeper-email/README.md)
* [Home Assistant](packages/gatekeeper-homeassistant/README.md)

# Running as a public, multi-user service

By default the Workshop uses built-in username/password accounts (or Cloudflare Access) and gives
every user unlimited AI usage — ideal for self-hosting. It can optionally run as a public,
multi-user service instead: users sign in with Google, GitHub, or Cloudflare, every account gets a
free daily allowance of AI usage, and once that runs out they connect their own Cloudflare account
and top up credits in the Cloudflare dashboard (their account is then billed for further usage).

Sign-in is provided by **authentication gatekeepers**: each auth-capable gatekeeper (Google, GitHub,
Cloudflare) uses its single OAuth app both to authenticate the user (by verified email) and to
connect the account's capabilities. There's no single switch — the pieces turn on independently:

| Configure | Effect |
| --- | --- |
| `AUTH_GATEKEEPERS=cloudflare,google,github` | Allowlists which connected gatekeepers may be used to sign in. Each shows a "Continue with …" button alongside username/password. |
| Each gatekeeper's OAuth credentials (on the gatekeeper Worker) | Required for that gatekeeper to actually authenticate. In dev, seeded from `GOOGLE_*` / `GITHUB_*` / `CLOUDFLARE_OAUTH_*` shell vars (see `run-dev-server.js`). |
| `ENABLE_CLOUDFLARE_LIMITS=true` | Enables the free daily limit + Cloudflare-credits top-up flow. Billing reads a token from the connected Cloudflare gatekeeper. |
| `DISABLE_PASSWORD_AUTH=true` | Hides username/password, leaving gatekeeper sign-in only (ignored unless `AUTH_GATEKEEPERS` is non-empty, to avoid lockout). |

The primary account key is always the user's **verified email**: signing in with any allowlisted
gatekeeper that yields the same verified email maps to the same account.

For local development, set the required variables in a root `.dev.vars` file (gitignored,
`KEY=VALUE` per line); `pnpm run dev-server` loads it automatically. A minimal example:

```
ENABLE_CLOUDFLARE_LIMITS=true
PUBLIC_BASE_URL=http://localhost:8787
AUTH_GATEKEEPERS=cloudflare,google,github

# Each gatekeeper's OAuth app (client id/secret). In dev these seed the gatekeeper Workers:
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
CLOUDFLARE_OAUTH_CLIENT_ID=...
CLOUDFLARE_OAUTH_CLIENT_SECRET=...

# Platform AI Gateway used for the free tier:
CF_AI_GATEWAY=...
CF_AI_GATEWAY_PROVIDERS=anthropic,openai,google
```

Each gatekeeper's OAuth app must be registered with that gatekeeper's redirect URI (replace the host
with `PUBLIC_BASE_URL`):

- GitHub: `${PUBLIC_BASE_URL}/gatekeeper/github/oauth`
- Google: `${PUBLIC_BASE_URL}/gatekeeper/google/oauth`
- Cloudflare: `${PUBLIC_BASE_URL}/gatekeeper/cloudflare/oauth`

See [docs/oauth-signin.md](docs/oauth-signin.md) and [docs/ai-gateway-billing.md](docs/ai-gateway-billing.md)
for the full list of options, the free-tier / top-up behavior, and the storage bindings involved.

