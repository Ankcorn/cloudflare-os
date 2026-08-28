# Revocable sessions — dev workflow

The `revocable-session-stubs` branch makes the overseer sever individual collaborator sessions
when access is revoked or the verification scope widens, instead of aborting the whole Durable
Object (see "Per-session revocation (experimental)" in `docs/observers.md`). It is built on
`RpcStub.revocable(target)` → `{stub, revoker}`, which is **experimental**: it only exists in a
patched workerd (branch `revocable-rpc-stubs` on
[Maximo-Guk/workerd](https://github.com/Maximo-Guk/workerd)) and requires the `experimental`
compatibility flag, which `packages/workshop-backend/wrangler.jsonc` declares on this branch.
That flag would be rejected by a production deploy — do not deploy this branch.

Everything is feature-detected at runtime (`revocableStub` in
`packages/workshop-backend/src/overseer.ts`): on a stock runtime the API is missing and every
revocation falls back to the whole-DO restart production has today. That's why the existing test
suite (vitest-pool-workers runs stock workerd) passes unchanged; the revocation path itself can
only be exercised against the patched binary.

## Running with the patched runtime

```bash
# Build the patched workerd once (or after pulling changes to it):
cd ~/Desktop/Github/workerd && bazel build //src/workerd/server:workerd

# Point miniflare at it and start the dev server:
cd ~/Desktop/Github/cloudflare-os
MINIFLARE_WORKERD_PATH=$HOME/Desktop/Github/workerd/bazel-bin/src/workerd/server/workerd pnpm dev-server
```

Miniflare always passes workerd's `--experimental` CLI flag, but that only *permits* the
`experimental` compat flag — the worker must also declare it in `wrangler.jsonc` (this branch
does; the generated `wrangler.dev.jsonc` copies flags through).

## Manual verification

Two browsers, two accounts:

1. Owner shares a workspace with a collaborator; both open it.
2. Owner removes the collaborator (or revokes the share link they redeemed).
3. Only the collaborator's WebSocket drops; their automatic reconnect re-runs `open()` and is
   denied. The owner (and any other collaborator) stays connected — no DO restart.

Without `MINIFLARE_WORKERD_PATH` the same steps still work, but via the fallback: everyone is
disconnected and reconnects, exactly as on `main`.
