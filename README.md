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
* [Email Workers](packages/gatekeeper-email/README.md)
* [Home Assistant](packages/gatekeeper-homeassistant/README.md)

