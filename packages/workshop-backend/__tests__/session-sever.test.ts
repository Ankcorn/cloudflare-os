import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Exercises the session registry and per-session sever machinery (see joinSession /
// severCollaboratorSessions / severUseScopeWidening / runBuildScopeWidening in overseer.ts)
// against the real OverseerImpl running in workerd. Sessions here are fakes registered straight
// into the registry -- the real end-to-end path (a severed WebSocket, an owner surviving their
// own widening) lives in the integration suite (observer-sever.test.ts).

let doCounter = 0;
async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`session-sever-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

// Give a pending promise every chance to settle without waiting on a timer: the drain path only
// chains promises (no timers shorter than its 2s timeout), so a handful of microtask turns is
// enough for anything that is going to settle synchronously-reachably.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

type FakeSession = { severed: number; leave: () => void };

function join(impl: any, kind: string): FakeSession {
  let session: FakeSession = { severed: 0, leave: () => {} };
  session.leave = impl.joinSession(kind, () => session.severed++);
  return session;
}

describe("severCollaboratorSessions", () => {
  it("severs only the matching role, and drains when the last severed session leaves",
      () => withImpl(async impl => {
    let owner = join(impl, "owner");
    let buildA = join(impl, "build");
    let buildB = join(impl, "build");
    let use = join(impl, "use");

    let drained = false;
    let drain = impl.severCollaboratorSessions("build", "test")
        .then(() => { drained = true; });

    // Severing is synchronous and reaches every matching session, nothing else.
    expect(owner.severed).toBe(0);
    expect(buildA.severed).toBe(1);
    expect(buildB.severed).toBe(1);
    expect(use.severed).toBe(0);

    // The drain waits for each severed session's departure, not merely having asked.
    await flushMicrotasks();
    expect(drained).toBe(false);
    buildA.leave();
    await flushMicrotasks();
    expect(drained).toBe(false);
    buildB.leave();
    await drain;
    expect(drained).toBe(true);

    owner.leave();
    use.leave();
  }));

  it("severs all non-owner sessions when no role is given", () => withImpl(async impl => {
    let owner = join(impl, "owner");
    let build = join(impl, "build");
    let use = join(impl, "use");

    let drain = impl.severCollaboratorSessions(undefined, "test");
    expect(owner.severed).toBe(0);
    expect(build.severed).toBe(1);
    expect(use.severed).toBe(1);
    build.leave();
    use.leave();
    await drain;
    owner.leave();
  }));

  it("resolves immediately when no session matches", () => withImpl(async impl => {
    let owner = join(impl, "owner");
    let use = join(impl, "use");
    await impl.severCollaboratorSessions("build", "test");
    expect(owner.severed).toBe(0);
    expect(use.severed).toBe(0);
    owner.leave();
    use.leave();
  }));

  it("does not sever a session that already left, and leave is idempotent",
      () => withImpl(async impl => {
    let build = join(impl, "build");
    build.leave();
    build.leave();
    await impl.severCollaboratorSessions("build", "test");
    expect(build.severed).toBe(0);
  }));

  it("falls back to scheduleRevocationRestart when the drain times out",
      () => withImpl(async impl => {
    let restart = vi.fn(async () => {});
    impl.scheduleRevocationRestart = restart;

    let wedged = join(impl, "build");
    await impl.severCollaboratorSessions("build", "the reason");
    expect(wedged.severed).toBe(1);
    expect(restart).toHaveBeenCalledWith("the reason");
    wedged.leave();
  }), 10_000);
});

describe("severUseScopeWidening", () => {
  it("bumps the use epoch even when no session is live", () => withImpl(async impl => {
    let before = impl.getScopeEpoch("use");
    await impl.severUseScopeWidening([42], "test");
    expect(impl.getScopeEpoch("use")).toBe(before + 1);
    expect(impl.getScopeEpoch("build")).toBe(0);
  }));

  it("widening nothing severs nobody and leaves the epoch alone", () => withImpl(async impl => {
    let use = join(impl, "use");
    await impl.severUseScopeWidening([], "test");
    expect(use.severed).toBe(0);
    expect(impl.getScopeEpoch("use")).toBe(0);
    use.leave();
  }));

  it("gates startGatekeeperSession on the drain and clears the mark after",
      () => withImpl(async impl => {
    let use = join(impl, "use");
    let widen = impl.severUseScopeWidening([42], "test");
    expect(use.severed).toBe(1);

    // A session opened against the draining gatekeeper must not proceed while the drain is
    // pending -- not even to fail. (Id 42 has no record, so once the gate lifts the open falls
    // through to the facet resolver's "no such gatekeeper?"; what's under test is the ordering.)
    // A real timer, not a microtask flush: the ungated failure path crosses a facet RPC, so it
    // needs wall-clock time to be observable at all.
    let settled: string | null = null;
    let open = impl.startGatekeeperSession({ type: "gatekeeper", id: 42 }, { from: "user" })
        .then(() => { settled = "resolved"; }, () => { settled = "rejected"; });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(settled).toBeNull();

    use.leave();
    await widen;
    await open;
    expect(settled).toBe("rejected");

    // The mark is cleared once the drain settles: a fresh open is not gated.
    settled = null;
    await impl.startGatekeeperSession({ type: "gatekeeper", id: 42 }, { from: "user" })
        .then(() => { settled = "resolved"; }, () => { settled = "rejected"; });
    expect(settled).toBe("rejected");
  }));
});

describe("runBuildScopeWidening", () => {
  it("publishes only after the drain, bumping the build epoch with the publish",
      () => withImpl(async impl => {
    let build = join(impl, "build");
    let published = false;
    let epochBefore = impl.getScopeEpoch("build");

    let widen = impl.runBuildScopeWidening("test", () => { published = true; });
    expect(build.severed).toBe(1);
    expect(impl.hasPendingScopeWidening("build")).toBe(true);

    await flushMicrotasks();
    expect(published).toBe(false);
    expect(impl.getScopeEpoch("build")).toBe(epochBefore);

    build.leave();
    await widen;
    expect(published).toBe(true);
    expect(impl.getScopeEpoch("build")).toBe(epochBefore + 1);
    expect(impl.hasPendingScopeWidening("build")).toBe(false);
  }));

  it("settlePendingScopeWidenings waits out a pending widening", () => withImpl(async impl => {
    let build = join(impl, "build");
    let widen = impl.runBuildScopeWidening("test", () => {});

    let settled = false;
    let settle = impl.settlePendingScopeWidenings("build").then(() => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBe(false);

    build.leave();
    await widen;
    await settle;
    expect(settled).toBe(true);

    // And with nothing pending it resolves immediately.
    await impl.settlePendingScopeWidenings("build");
  }));
});
