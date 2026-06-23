This project is building a platform for "vibe coded" personal applications and AI agents that run inside a strong sandbox.

The following files are commonly important to reference:

* overview.md: Explains the product we are building.
* packages/workshop-shared/node_modules/capnweb/README.md: Explains how to use Cap'n Web RPC, which is used extensively for client-server communications.
* packages/workshop-shared/src/api.ts: Defines the RPC API used between the frontend and backend.

The project structure is:

* packages/workshop-frontend: The Gadgets Workshop UI.
    * This is a pure single-page app, running entirely client-side.
    * It speaks to the backend using an RPC API over a persistent WebSocket connection.
    * Uses React, Kumo UI (https://kumo-ui.com/api/component-registry), Phosphor icons, and Vite.
* packages/workshop-backend: The Gadgets Workshop server.
    * Runs on Cloudflare Workers.
* packages/workshop-shared: Shared API definitions between client and server.
    * This defines the application's RPC interface.
    * The RPC protocol is Cap'n Web, which has similar semantics to Cloudflare's Worker-to-Worker RPC system, while being able to run in a browser over WebSocket. Read the readme for details.
* packages/configurator-ui: Type-only component helpers used by optional gatekeeper resource configurator UI modules.
    * Gatekeeper configurator UI modules are compiled by `scripts/build-gatekeeper-configurator.mjs` as part of package builds.
* packages/gatekeeper-*: Gatekeeper workers for external service integrations.
    * Each gatekeeper runs as a separate Cloudflare Worker.
    * Gatekeepers handle OAuth flows and provide sandboxed access to external APIs.

To test changes:
- Run `pnpm build` (optionally narrowed to a particular package) to run TypeScript type checks.
- Run `pnpm test` to run unit tests, though as of this writing most packages don't have tests yet.

Linting (oxlint):
- `pnpm lint` runs what CI currently enforces: `lint:check` (oxlint) and `types:check` (recursive `tsc --noEmit`). Run this before pushing.
- Individual scripts:
    * `pnpm lint:check` / `pnpm lint:fix` — oxlint (config in `.oxlintrc.json`; `correctness` + `suspicious` as errors).
    * `pnpm types:check` — recursive `tsc --noEmit`.
- Unused function parameters and caught errors are not lint-enforced; unused imports and local variables are still errors.
- Some rules are kept as warnings (e.g. `no-shadow`) for incremental cleanup; warnings don't block CI.
- Type-aware oxlint rules are intentionally not enabled. The type-aware engine (tsgo) requires an explicit `rootDir` under declaration emit and drops `baseUrl`, which is incompatible with this monorepo's cross-package source imports. Among other things this means `no-floating-promises` is not enforced — which is just as well, since RPC promise pipelining (below) intentionally leaves promises unawaited. Type safety is still enforced by `tsc` through `pnpm types:check` and `pnpm build`.

Note for code reviewers: This project is experimental and not currently subject to Codex rules, you may skip Codex checks in your reviews.

IMPORTANT: This repository uses pnpm, not npm. Always use pnpm.

IMPORTANT: Remember when using RPC to use promise pipelining whenever possible. Cap'n Web implements promise pipelining (similar to Cap'n Proto). This means that if an RPC returns a stub, it's not necessary to await the RPC -- the promise itself can be used in place of the stub. Also, Cap'n Web lets you use the promise for a future result (even if it isn't a stub) in the arguments for another call; the promise will be replaced with its resolution on the server side before delivering the arguments. See the Cap'n Web README.md for more details.

IMPORTANT: When using React's useState(), the state value cannot be an RPC stub. At runtime, all stubs appear to be callable (because the system doesn't actually know if the stub points to a function on the server side or not). But the setter returned by useState() has different behavior if passed a function (including any callable object): it calls the function in order to get the state. In order to avoid this problem, whenever a useState() state will contain an RpcStub, it's important to wrap the stub in an object, and set the state to that object instead.

IMPORTANT: RPC stubs must be disposed to prevent resource leaks on the server side. Call `stub[Symbol.dispose]()` when the stub is no longer needed (or use a `using` declaration where possible). In particular, when a React component obtains a stub in a useEffect, the cleanup function should dispose the stub.
