// Per-session revocation (trackSession/revokeSessions in overseer.ts) exists only when the
// runtime provides the experimental RpcStub.revocable() -- a patched workerd. This whole file is
// skipped on stock workerd (including CI); the rest of the suite pins the fallback restart
// behavior there. To run it:
//
//   cd ~/Desktop/Github/workerd && bazel build //src/workerd/server:workerd
//   MINIFLARE_WORKERD_PATH=$HOME/Desktop/Github/workerd/bazel-bin/src/workerd/server/workerd \
//       pnpm --filter workshop-backend exec vitest run __tests__/revocable-sessions.test.ts
//
// (See docs/revocable-sessions-dev.md.)
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-scope-restart.test.ts), stubbing only open()'s cross-DO edges, so the session
// interfaces, revocable stubs, and revocation paths are the real ones. scheduleAccessRestart is
// replaced with a recorder -- partly because a real ctx.abort() would kill the test DO, but
// mostly because the point of these tests is that it is NOT reached.

import { describe, expect, it } from "vitest";
import { env, RpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Overseer } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const revocable = (RpcStub as unknown as { revocable?: unknown }).revocable;

const OWNER_USER = "owner-user";

// revoke() severs the membrane (and disposes the session interface) one event-loop turn later,
// and #restartIfShared is fire-and-forget, so let continuations run before asserting.
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

// The rejection a promise settles with, with handlers attached in the same turn (see the comment
// at the first use).
const rejectionOf = (p: Promise<unknown>): Promise<Error | undefined> =>
    p.then(() => undefined, (e: Error) => e);

let doCounter = 0;

// One opened session and what the worker side would see of its teardown: `disposed` flips when
// the session interface's [Symbol.dispose] runs (observed via its leave-fanout hook), and
// `notifyClosedCalls` counts what AuthenticatedApiImpl distinguishes a clean close by.
interface Session {
  stub: Overseer;
  notifyClosedCalls: number;
  disposed: boolean;
}

interface Harness {
  impl: any;
  restarts: string[];
  open: (userId: string, profileId: string) => Promise<Session>;
}

async function withOverseer(fn: (harness: Harness) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`revocable-sessions-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    // Pre-initialized owner (skips first-open bootstrap) with the cached profile id the sharing
    // manager consults, plus stubs for the cross-DO work open() does that these tests don't
    // exercise.
    impl.ownerId = OWNER_USER;
    impl.ownerProfileId = "owner-profile";
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.syncOutputsTo = async () => {};
    impl.authorizeCollaborator = async () => "build";
    impl.joinPresence = () => () => {};
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({
        whoami: async () => ({ type: "user", id: "someone", name: "Someone" }),
        recordSharedGadgetOpen: async () => {},
      }),
    };
    let restarts: string[] = [];
    impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };

    async function open(userId: string, profileId: string): Promise<Session> {
      let session: Session = { stub: undefined!, notifyClosedCalls: 0, disposed: false };
      impl.joinOutputsFanout = () => () => { session.disposed = true; };
      session.stub = await instance.open(userId, profileId,
          new RpcStub<() => void>(() => { session.notifyClosedCalls++; }));
      return session;
    }

    await fn({ impl, restarts, open });
  });
}

describe.skipIf(!revocable)("per-session revocation (patched workerd only)", () => {
  it("revoking severs the session, presenting as a lost connection",
      () => withOverseer(async ({ impl, open }) => {
    let alice = await open("alice-user", "alice-profile");
    expect(alice.disposed).toBe(false);

    expect(impl.revokeSessions(["alice-profile"], "no longer welcome")).toBe(true);
    await settle();

    // The session interface was torn down, but notifyClosed was disposed *without being called*:
    // the worker reads that as a lost DO connection and kills the client's WebSocket, whose
    // reconnect re-runs open()'s access checks.
    expect(alice.disposed).toBe(true);
    expect(alice.notifyClosedCalls).toBe(0);

    // The revocation reason is what the revoked holder's in-flight and later calls reject with.
    // (Handlers attached directly: an RPC promise is a pipelining proxy, and vitest's `.rejects`
    // touching it spawns extra doomed pipelined calls that surface as unhandled rejections.)
    expect((await rejectionOf(alice.stub.getMetadata()))?.message).toBe("no longer welcome");
  }));

  it("a clean close still calls notifyClosed", () => withOverseer(async ({ open }) => {
    let alice = await open("alice-user", "alice-profile");

    alice.stub[Symbol.dispose]();
    await settle();

    expect(alice.disposed).toBe(true);
    expect(alice.notifyClosedCalls).toBe(1);
  }));

  it("revocation reaches only the named collaborator",
      () => withOverseer(async ({ impl, open }) => {
    let alice = await open("alice-user", "alice-profile");
    let bob = await open("bob-user", "bob-profile");

    impl.revokeSessions(["alice-profile"], "no longer welcome");
    await settle();

    expect(alice.disposed).toBe(true);
    expect(bob.disposed).toBe(false);
    expect(bob.notifyClosedCalls).toBe(0);
  }));

  it("revokeCollaboratorSessions spares the owner", () => withOverseer(async ({ impl, open }) => {
    let owner = await open(OWNER_USER, "owner-profile");
    let alice = await open("alice-user", "alice-profile");

    expect(impl.revokeCollaboratorSessions("scope widened")).toBe(true);
    await settle();

    expect(alice.disposed).toBe(true);
    expect(owner.disposed).toBe(false);
    expect(owner.notifyClosedCalls).toBe(0);
  }));

  it("removing access revokes instead of aborting the DO",
      () => withOverseer(async ({ impl, restarts, open }) => {
    let alice = await open("alice-user", "alice-profile");

    // What removeCollaborator/revokeShareLink call after a removal that affected alice.
    impl.severRevokedAccess(
        [{ profile: { type: "user", id: "alice-profile", name: "Alice" } }],
        "Gadget restarted to revoke access for a removed collaborator.");
    await settle();

    expect(restarts).toEqual([]);
    expect(alice.disposed).toBe(true);
    expect(alice.notifyClosedCalls).toBe(0);
    expect((await rejectionOf(alice.stub.getMetadata()))?.message)
        .toContain("removed or changed");
  }));

  it("scope widening revokes collaborator sessions instead of aborting the DO",
      () => withOverseer(async ({ impl, restarts, open }) => {
    let alice = await open("alice-user", "alice-profile");
    impl.storage.collaborators.put({
      profile: { type: "user", id: "alice-profile", name: "Alice" },
      addedBy: [{ type: "user", sharer: "owner-profile", created: new Date(), role: "build" }],
    });
    impl.getGatekeeperFacet = () => ({
      describe: async () => ({ title: "Test", url: "https://example.com/new" }),
    });

    // A new account-requiring connection widens every collaborator's verification scope
    // (see observer-scope-restart.test.ts, which pins the fallback restart for this trigger).
    await impl.addGatekeeper({} as any, {
      type: "gatekeeper",
      vendorId: "testvendor",
      resourceUrl: "https://example.com/new",
      typeUrlPattern: "https://*",
    });
    await settle();

    expect(restarts).toEqual([]);
    expect(alice.disposed).toBe(true);
    expect(alice.notifyClosedCalls).toBe(0);
  }));
});
