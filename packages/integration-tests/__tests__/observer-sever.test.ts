// Per-session sever on verification-scope widening.
//
// When the owner widens what a collaborator role must be verified against -- adding a connection
// ("build" scope) or binding one into a gadget ("use" scope) -- sessions verified against the old
// scope must die before the widened capability is reachable. These tests pin down the shape of
// that enforcement: exactly the affected collaborators' sessions are severed (the owner, whose own
// action did the widening, stays connected -- the differentiator against restarting the whole DO),
// a rebind or an unbound connection severs nobody, the severed collaborator's re-open re-prompts
// for the new connection, and an open still parked in verification when the widening lands is
// re-verified against the wider scope rather than admitted stale.
//
// Nothing is stubbed but the network. Every user drives the Workshop over their own WebSocket --
// severing a session closes its socket, so sharing one would let Bob's death take Alice with him
// in the test harness only.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import {
  connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

let harness: Harness;
let interceptor: NetworkInterceptor;

beforeAll(async () => {
  // No handlers: nothing here should make an outbound request at all.
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
});

function thingUrl(name: string): string {
  return `https://gadgets-test.example/things/${name}`;
}

/** One user driving the Workshop over their own WebSocket connection. */
type UserSession = {
  username: string;
  api: RpcStub<AuthenticatedApi>;
  /** The user's own test-gatekeeper account (minted with no auth flow). */
  account: ConnectedAccount;
  close(): void;
};

function closerFor(publicApi: RpcStub<PublicApi>): () => void {
  // The socket may already be dead (that's what severing does), which is fine.
  return () => {
    try { publicApi[Symbol.dispose](); } catch { /* already broken */ }
  };
}

/** Sign `username` up on a fresh WebSocket and mint their test-gatekeeper account. */
async function openUserSession(username: string): Promise<UserSession> {
  const publicApi = connect(harness.url);
  const api = await signUp(publicApi, username);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
  return { username, api, account, close: closerFor(publicApi) };
}

/**
 * Log an existing user back in on a fresh WebSocket -- how a real client reconnects after its
 * session is severed (the sever closed the old socket, taking the old stubs with it).
 */
async function reconnectUserSession(user: UserSession): Promise<UserSession> {
  const publicApi = connect(harness.url);
  const api = await logIn(publicApi, user.username);
  return { ...user, api, close: closerFor(publicApi) };
}

/**
 * Wait until the stub's session is dead. A severed session's WebSocket is closed out from under
 * it by the server, which surfaces client-side as every call rejecting.
 */
async function waitForSever(overseer: RpcStub<Overseer>): Promise<void> {
  await waitFor("the severed session to drop", async () => {
    try {
      await overseer.getMetadata();
      return null;
    } catch {
      return true;
    }
  });
}

/** Open the gadget as `user`, answering observer prompts from `recorder`. */
async function openAs(
    user: UserSession, gadgetId: string,
    recorder: ObserverConfigRecorder): Promise<RpcStub<Overseer>> {
  const callback = stubFor(recorder);
  try {
    return await user.api.openGadget(gadgetId, undefined, callback);
  } finally {
    callback[Symbol.dispose]();
  }
}

describe("per-session sever on scope widening", () => {
  it.concurrent("adding a connection severs build collaborators; the owner survives", async () => {
    const [aliceName, bobName] = nextUsernames("sevaddalice", "sevaddbob");
    const alice = await openUserSession(aliceName);
    const bob = await openUserSession(bobName);
    const sessions = [alice, bob];
    try {
      const aliceOverseer = await alice.api.newGadget();
      const { id: gadgetId } = await aliceOverseer.getMetadata();
      expect(await aliceOverseer.addCollaborator(bobName, "build")).toBeTruthy();

      // Bob opens. The only in-scope connection is the ambient capsule, auto-covered by his own
      // account, so this must not prompt (an unexpected prompt throws: no responses are queued).
      const bobOverseer = await openAs(bob, gadgetId, new ObserverConfigRecorder());
      await expect(bobOverseer.getMetadata()).resolves.toMatchObject({ id: gadgetId });

      // The owner adds a connection: "build" scope widens, so Bob's stale session must die...
      using created = await aliceOverseer.newGatekeeper(
        alice.account.id, thingUrl("sever-add"));
      expect(created).not.toBeNull();
      await waitForSever(bobOverseer);

      // ...while the owner's session survives their own action -- the point of severing
      // per-session instead of aborting the whole DO.
      await expect(aliceOverseer.getMetadata()).resolves.toMatchObject({ id: gadgetId });

      // Bob's re-open is prompted for exactly the new connection, and admits him once answered.
      const bobAgain = await reconnectUserSession(bob);
      sessions.push(bobAgain);
      const recorder =
          new ObserverConfigRecorder().alwaysChoose(bob.account.id, MAX_OBSERVER_PROMPTS);
      using reopened = await openAs(bobAgain, gadgetId, recorder);
      expect(recorder.callCount).toBe(1);
      expect(recorder.calls[0].map(n => n.resourceUrl)).toEqual([thingUrl("sever-add")]);
      await expect(reopened.getMetadata()).resolves.toMatchObject({ id: gadgetId });
      aliceOverseer[Symbol.dispose]();
    } finally {
      for (const session of sessions) session.close();
    }
  });

  it.concurrent("binding a connection severs use collaborators; the owner survives", async () => {
    const [aliceName, bobName] = nextUsernames("sevbindalice", "sevbindbob");
    const alice = await openUserSession(aliceName);
    const bob = await openUserSession(bobName);
    const sessions = [alice, bob];
    try {
      const aliceOverseer = await alice.api.newGadget();
      const { id: gadgetId } = await aliceOverseer.getMetadata();
      using conn = await aliceOverseer.newGatekeeper(alice.account.id, thingUrl("sever-bind"));
      if (!conn) throw new Error("Failed to create the test connection");
      const connId = await conn.getId();
      using gadget = await aliceOverseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
      expect(await aliceOverseer.addCollaborator(bobName, "use")).toBeTruthy();

      // Bob opens as "use". Nothing is bound, so his scope is empty: no prompt.
      const bobOverseer = await openAs(bob, gadgetId, new ObserverConfigRecorder());
      await expect(bobOverseer.getMetadata()).resolves.toMatchObject({ id: gadgetId });

      // The owner binds the connection into the gadget: it enters "use" scope, so Bob dies...
      await gadget.bind("TEST_THING", connId);
      await waitForSever(bobOverseer);

      // ...and the owner survives.
      await expect(aliceOverseer.getMetadata()).resolves.toMatchObject({ id: gadgetId });

      // Bob's re-open is prompted for the newly bound connection.
      const bobAgain = await reconnectUserSession(bob);
      sessions.push(bobAgain);
      const recorder =
          new ObserverConfigRecorder().alwaysChoose(bob.account.id, MAX_OBSERVER_PROMPTS);
      using reopened = await openAs(bobAgain, gadgetId, recorder);
      expect(recorder.callCount).toBe(1);
      expect(recorder.calls[0].map(n => n.resourceUrl)).toEqual([thingUrl("sever-bind")]);
      await expect(reopened.getMetadata()).resolves.toMatchObject({ id: gadgetId });
      aliceOverseer[Symbol.dispose]();
    } finally {
      for (const session of sessions) session.close();
    }
  });

  it.concurrent("an unbound connection or a rebind severs no use session", async () => {
    const [aliceName, bobName] = nextUsernames("sevnoopalice", "sevnoopbob");
    const alice = await openUserSession(aliceName);
    const bob = await openUserSession(bobName);
    try {
      const aliceOverseer = await alice.api.newGadget();
      const { id: gadgetId } = await aliceOverseer.getMetadata();
      using connA = await aliceOverseer.newGatekeeper(alice.account.id, thingUrl("noop-a"));
      if (!connA) throw new Error("Failed to create the test connection");
      const connAId = await connA.getId();
      using gadget = await aliceOverseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
      await gadget.bind("TEST_THING", connAId);
      expect(await aliceOverseer.addCollaborator(bobName, "use")).toBeTruthy();

      // Bob opens as "use", verified against the bound connection A.
      const recorder =
          new ObserverConfigRecorder().alwaysChoose(bob.account.id, MAX_OBSERVER_PROMPTS);
      const bobOverseer = await openAs(bob, gadgetId, recorder);
      expect(recorder.callCount).toBe(1);

      // Adding a connection that no gadget binds widens nothing for "use"; neither does binding
      // an already-in-scope connection under a second name. Bob must survive both.
      using connB = await aliceOverseer.newGatekeeper(alice.account.id, thingUrl("noop-b"));
      if (!connB) throw new Error("Failed to create the second test connection");
      await gadget.bind("TEST_THING_AGAIN", connAId);

      // The sever's drain completes before the widening call returns, so if Bob had been severed
      // his socket close would already be in flight; give it a moment to be sure it isn't.
      await new Promise(resolve => setTimeout(resolve, 300));
      await expect(bobOverseer.getMetadata()).resolves.toMatchObject({ id: gadgetId });

      // Control: the same session dies from a genuine widening, so the survival above was the
      // enforcement declining to fire, not this test failing to notice a sever.
      await gadget.bind("TEST_THING_B", await connB.getId());
      await waitForSever(bobOverseer);
      aliceOverseer[Symbol.dispose]();
    } finally {
      alice.close();
      bob.close();
    }
  });

  it.concurrent("an open parked in verification re-verifies after a widening", async () => {
    const [aliceName, bobName] = nextUsernames("sevracealice", "sevracebob");
    const alice = await openUserSession(aliceName);
    const bob = await openUserSession(bobName);
    try {
      const aliceOverseer = await alice.api.newGadget();
      const { id: gadgetId } = await aliceOverseer.getMetadata();
      using connA = await aliceOverseer.newGatekeeper(alice.account.id, thingUrl("race-a"));
      if (!connA) throw new Error("Failed to create the test connection");
      expect(await aliceOverseer.addCollaborator(bobName, "build")).toBeTruthy();

      // Bob's open parks inside the observer config prompt -- verification has snapshotted its
      // scope (connection A) but not finished. He has no session object yet, so a sever can't
      // reach him; the scope epoch is what must catch this.
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      let parked!: () => void;
      const parkedAt = new Promise<void>(resolve => { parked = resolve; });
      const recorder = new ObserverConfigRecorder()
          .respondWith(async needs => {
            parked();
            await released;
            return needs.map(n => ({ gatekeeperId: n.gatekeeperId, accountId: bob.account.id }));
          })
          .alwaysChoose(bob.account.id, 1);
      const callback = stubFor(recorder);
      const opening = bob.api.openGadget(gadgetId, undefined, callback);

      // Mid-park, the owner adds connection B: the scope Bob is being verified against is stale.
      await parkedAt;
      using connB = await aliceOverseer.newGatekeeper(alice.account.id, thingUrl("race-b"));
      expect(connB).not.toBeNull();

      // Released, Bob's verification completes against the old scope -- and must then be re-run
      // against the widened one, prompting for exactly the connection it missed, rather than
      // admitting him at the stale scope.
      release();
      using bobOverseer = await opening;
      callback[Symbol.dispose]();
      expect(recorder.callCount).toBe(2);
      expect(recorder.calls[1].map(n => n.resourceUrl)).toEqual([thingUrl("race-b")]);
      await expect(bobOverseer.getMetadata()).resolves.toMatchObject({ id: gadgetId });
      aliceOverseer[Symbol.dispose]();
    } finally {
      alice.close();
      bob.close();
    }
  });
});
