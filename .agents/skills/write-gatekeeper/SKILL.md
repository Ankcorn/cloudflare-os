---
name: write-gatekeeper
description: Guides implementation of Gatekeeper Workers that bridge Gadgets to external services. Covers auth, capability-based API design, approval queue integration, caching, and action simulation. Load when creating, modifying, or reviewing the implementation of a gatekeeper.
---

# Writing a Gatekeeper

A Gatekeeper is a Cloudflare Worker that mediates all access between a Gadget and an external service. It implements a three-tier hierarchy:

- **Vendor** (`GatekeeperVendor`, a `WorkerEntrypoint`) — top-level entry for the service. One per service.
- **User** (`GatekeeperUser`, a `WorkerEntrypoint` with `ctx.props`) — a human user's authenticated connection.
- **Instance** (`Gatekeeper<Session, Hook>`, a DO facet of the Overseer) — per-resource, per-Gadget binding that provides the Session API.

Read `packages/workshop-shared/src/gatekeeper.ts` for the canonical interfaces and detailed JSDoc.

## Six responsibilities

1. **Auth management** — Manage authorization to the external service via OAuth (or similar), on behalf of the human end user. This means managing "connected accounts" — token storage, refresh, and revocation in a `UserAccount` Durable Object.

2. **API design** — Provide a TypeScript API wrapper around the service's API, compatible with Cap'n Web RPC. The interface should be designed around capability-based security: object-oriented, with separate interfaces representing logical resources. For example, the Google Docs gatekeeper provides an interface to a *specific* document, rather than a coarse-grained interface where you pass the doc ID to every method. **IMPORTANT:** When writing a new gatekeeper, design a proposed API and then STOP to let the operator review and make changes before proceeding with the rest of the implementation. Getting the API right is the most important and delicate part of creating a new gatekeeper.

3. **Fine-grained resource granting** — Enable the end user to grant access to agents at fine granularities, in addition to coarse-grained access. For example, a user may want to give an agent access to a specific Google Doc or GitHub repo, rather than granting broad access to everything they can do. This should be straightforward given a capability-based API. That said, broad access should also be allowed when it makes sense. Consider carefully which granularities are meaningful — a Jira gatekeeper might support "whole service", "project", and "issue" granularities, but it would be silly to support granting access to a single field of an issue separately.

4. **Logging & approvals** — Every action the agent or gadget performs must be logged via the `ApprovalQueue` API. Every action with an externally-visible side effect must be submitted via `submitAction()`, and must not actually be performed until `applyAction()` has been called. Read-only observations must call `authorizeObservation()` before returning data to the caller.

5. **Caching** — When it makes sense, cache remote content in the gatekeeper's DO storage to improve performance when agents or gadgets repeatedly read the same data. Caching also enables a better TypeScript API when the service's underlying API has an inconvenient data shape. For example, Gmail's API for listing threads returns only thread IDs without metadata, requiring a callback for each thread; with caching, the gatekeeper can provide an API that returns rich thread summaries directly, reading from local content synchronized with Gmail as needed. See Phase 2 for implementation guidance.

6. **Simulation** — Actions submitted but not yet applied should be simulated as if they already occurred, to the maximum extent reasonable. If the caller reads back data, it should observe the data as if pending actions had been applied, even though they haven't yet. This allows the agent to continue working without waiting for each approval, and allows the end user to batch-approve a lot of work at once. Simulation may leverage caching (updating the cache on submit, clearing or repopulating it on reject), or it may work by storing pending actions separately and adjusting read results at query time — the latter is arguably cleaner but trickier to implement correctly. See Phase 2 for implementation guidance.

## Phase 1: Core implementation

In the first phase, focus only on responsibilities 1 - 3, though keeping in mind that 4 - 6 will need to be implemented later.

### Step 1: Understand the external service

Study the service's API docs. Identify:
- Auth model (OAuth 2.0, API keys, etc.)
- Resources to expose and what access granularities make sense
- Which operations are observations (read-only) vs. actions (side effects)

### Step 2: Design the Session types

Create `src/types.d.ts` defining the Session interface (and Hook interface if the service pushes events).

Before designing, read `packages/workshop-shared/node_modules/capnweb/README.md` to understand what Cap'n Web RPC supports — this determines what types and patterns are expressible in the Session interface.

Design principles:
- One interface per logical resource type, not a god-object
- Methods return structured data, not raw API responses
- Use capability-based design principles: make it easy to limit authority in useful ways by simply limiting access to specific objects or allowing/blocking specific methods
- Simplify API complexities that are not likely to matter to agents and gadgets; design for a more novice user and common use cases
- Consider what URL patterns `getGatekeeperClassFor()` should match — each pattern maps to a resource granularity
- Include JSDoc comments; these types serve as the agent's API documentation

### Step 3: STOP — Present API for review

**Do not proceed without operator approval.**

Present the proposed `types.d.ts` and explain the design: what resource granularities are supported, what Session methods do, and what trade-offs were made. The API is the most important and delicate part of a gatekeeper — getting it wrong means rebuilding. Wait for the operator to review and approve (or request changes) before continuing.

### Step 4: Implement

See [SKELETON.md](SKELETON.md) for a complete implementation template.

Package structure:
```
packages/gatekeeper-<name>/
├── src/
│   ├── configurator/         # Optional resource-picker UI modules and UI-facing types
│   ├── <name>.ts              # Vendor, UserAccount, UserImpl, GatekeeperImpl, SessionImpl
│   ├── types.d.ts             # Session/Hook types (compile-time)
│   ├── types.txt -> types.d.ts  # Symlink (runtime, for getTypeScriptTypes())
│   └── <name>-api.ts          # (optional) Helper wrapping the service's HTTP API
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

### Step 5: Configure and register

Add a service binding to `packages/workshop-backend/wrangler.jsonc`:
```jsonc
{
  "binding": "GATEKEEPER_<NAME>",
  "service": "gatekeeper-<name>",
  "entrypoint": "GatekeeperVendor"
}
```

The backend auto-discovers vendors from `GATEKEEPER_`-prefixed bindings (see `packages/workshop-backend/src/user.ts`).

### Step 6: Add resource selection UI

Add a resource selection UI for each resource type returned in `getSupportedResources()`. This will be used by users to select the specific resource.

- Workshop calls `GatekeeperUser.startResourceConfigurator(resourceUrlPattern)` with the selected resource's `urlPattern`.
- Return `iframeHtml` of the selection UI and `ui` for any RPCs that UI needs.
- When the user selects "Add connection", Workshop asks the iframe for the selected resource URL.

Keep the iframe-facing capability narrow, only what's necessary to provide desired interface to help user find and select the resource.

#### Optional helper: `@gadgets/configurator-ui`

For simple configuration UIs, consider using `@gadgets/configurator-ui`. It provides the basic form components that look consistent to the Gadget Workshop and a build script that turns `src/configurator/*-ui.tsx` into `iframeHtml`. Gatekeepers with more specialized UI needs can produce their own `iframeHtml`.

If you use this:

- UI modules live in `src/configurator/*-ui.tsx`.
- `resourceUrl()` returns the selected resource URL.
- `src/configurator/*-types.d.ts` describes the iframe-facing `ui` API.
- `scripts/build-gatekeeper-configurator.mjs` generates `src/generated/*.txt`.
- Package `build` / `deploy` scripts should run `pnpm run build:configurator`.

### Step 7: STOP — Ask operator whether to proceed to phase 2

The operator may prefer to implement phase 2 later, perhaps in a new context. Stop here and ask the operator whether to proceed.

## Phase 2: Logging, approvals, caching, and simulation

In this phase, we focus on responsibilities 4-6. These are typically added as a second pass, after the core gatekeeper works. They may be implemented in a separate session.

### Logging and approvals

Go through all the API methods and decide where to insert calls to the `ApprovalQueue`.

- Any operation which reads external data (but with no side effects) must call authorizeObservation().
- Any operation which has visible side effects on the world must call submitAction(), and must not actually apply the action until approved.

Study the `ApprovalQueue` API in `gatekeeper.ts` for details.

It's critically important that you add `ApprovalQueue` to all API operations that interact with the outside world, otherwise the gatekeeper security model is broken.

### Caching

Store fetched data in the gatekeeper's DO storage (`this.ctx.storage`) to avoid redundant API calls. The cache also enables a better API shape when the service's native data model is awkward — e.g., Gmail's list API returns thread IDs without metadata, but with caching the Session can return richer summaries directly.

- Use TTLs or revision IDs to keep the cache fresh.
- Cache transformed data (e.g., Markdown) rather than raw API responses when the transformation is expensive.

PROTIP: The relatively new API `this.ctx.storage.kv` provides synchronous versions of the traditional Durable Object storage API, e.g. `get` and `put`. Use these instead of the old asynchronous methods. (Note that the synchronous API does not provide "batch" versions of `get()` and `put()`, but you don't really need them since simply making multiple calls is efficient.)

PROTIP: `this.ctx.storage.sql` gives you access to a full, private SQLite database. Use this when the full power of SQL is useful, but prefer KV for simple things.

The full Durable Objects storage API (including synchronous KV and SQLite) is documented at: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

### Simulation

When `submitAction()` has been called but `applyAction()` hasn't, reads should reflect the pending action. This allows the calling agent or gadget to be unaware of the approvals mechanism, and proceed with follow-on work immediately. The end user is able to approve a whole batch of changes at once, later on.

Two possible implementation approaches include:

1. **Mutate the cache** — Apply the action's effects to cached data on submit. On `rejectAction()`, invalidate or rebuild the cache. Simple; works well when the cache is already a transformed view. Don't forget to re-apply any queued actions when updating the cache.

2. **Overlay at read time** — Store pending actions separately; merge them into read results on demand. Cleaner separation; better when the overlay logic is straightforward.

Choose based on the service's data model and the complexity of simulating each action type.

Keep in mind that the agent calling the API (or the agent writing a gadget to call it) is generally not aware that actions do not take place immediately. If the simulation is correct, the agent doesn't need to be aware. If the simulation has gaps, you may want to mention it in your API's doc comments, so that the calling agent knows to work around them — but ideally there are no gaps and the calling agent does not need to think about it.

For concrete examples, see the Google gatekeeper's Google Docs simulation/cache handling and BigQuery dry-run scope enforcement.

## Tips

- `types.txt` must be a **symlink** to `types.d.ts`, never a copy.
- Call `.dup()` on `approvalQueue` stubs before storing in a session, since Cap'n Web automatically disposes all stubs in parameters to an RPC call when the call returns.
- `suggestedBindingName` in `describe()` reflects the resource **type** (e.g. `"GMAIL_INBOX"`), not the specific instance.
- For read-only or push-only gatekeepers, `applyAction()` / `rejectAction()` / `revertAction()` can simply throw (they'll never be called since the gatekeeper never submits actions).
- For `WorkerEntrypoint` and `DurableObject` subclasses, pass credentials and resource IDs via `ctx.props`, not constructor arguments. RPC stubs pointing to these types can be stored in long-term storage and restored later, creating a new instance based on the same `props`.
- If the gatekeeper implements multiple unrelated resource types with disjoint APIs, each may have its own `.d.ts` file, so that the `getTypeScriptTypes()` method of the specific `Gatekeeper` implementation only returns the types that matter for it. The `getTypeScriptTypes()` method on the top-level `GatekeeperVendor` should return the concatenation of all of these.
- All DO classes must appear in `wrangler.jsonc` under `migrations[].new_sqlite_classes`.
- Set a self-destruct alarm in `UserAccount.setCallback()` in case the OAuth flow is never completed.
- `authorizeObservation()` may be called *after* fetching data (so the description can include details about what was fetched) but must be awaited *before* returning anything to the caller.

## Reference implementations

- `packages/gatekeeper-google/` — OAuth, multiple resource types (Gmail, Google Docs, BigQuery), actions, caching/simulation examples, multiple Session types.
- `packages/gatekeeper-email/` — Hook-based push notifications, no actions, email address claiming.
- `packages/workshop-shared/src/gatekeeper.ts` — Canonical interfaces with detailed JSDoc.
