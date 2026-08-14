import { describe, it, expect, vi } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  rejectPendingAction, ActionRejectionStorage, GatekeeperRejectResult, RejectWithGatekeeperFn,
} from "../src/action-rejection.js";
import type { ActionRecord } from "../src/overseer.js";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { makeMockStorage } from "./mock-storage.js";

function makeStorage(): ActionRejectionStorage {
  return createTypedStorage(makeMockStorage(), {
    collections: {
      actions: collection<ActionRecord>()({ primaryKey: "id" }),
    },
  });
}

const GK = 1;
const REJECTER: AiChatAuthorInfo = { type: "user", id: "rejecter@example.com", name: "Rejecter" };

// Unlike auto-approval.test.ts's helper, `action` (the gatekeeper's own action key) is allowed to
// differ from `id` (the overseer log id) -- setting them equal masks key-confusion bugs.
function putAction(
    storage: ActionRejectionStorage, id: number,
    opts: { action?: number; gatekeeperId?: number;
            state?: ActionRecord["state"] } = {}): ActionRecord & { type: "action" } {
  let record: ActionRecord = {
    id,
    gatekeeperId: opts.gatekeeperId ?? GK,
    caller: { from: "agent", chatId: 1 },
    createdAt: new Date(),
    state: opts.state ?? "pending",
    type: "action",
    action: opts.action ?? id,
    description: {
      title: `Action ${id}`,
      description: `Action ${id} description`,
      implementsRevert: true,
    },
  };
  storage.actions.put(record);
  return record as ActionRecord & { type: "action" };
}

function getAction(storage: ActionRejectionStorage, id: number): ActionRecord & { type: "action" } {
  let record = storage.actions.get(id);
  if (!record || record.type !== "action") throw new Error(`No action ${id}`);
  return record;
}

function gatekeeperReturning(result: GatekeeperRejectResult): RejectWithGatekeeperFn {
  return async () => result;
}

describe("rejectPendingAction", () => {
  it("marks the primary rejected on a void gatekeeper return, without restart", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);
    let restart = vi.fn();

    let result = await rejectPendingAction(
        storage, primary, REJECTER, gatekeeperReturning(undefined), restart);
    expect(result).toBeUndefined();

    let after = getAction(storage, 1);
    expect(after.state).toBe("rejected");
    expect(after.resolvedBy?.id).toBe(REJECTER.id);
    expect(after.appliedAt).toBeInstanceOf(Date);
    expect(after.cascadedFrom).toBeUndefined();
    expect(restart).not.toHaveBeenCalled();
  });

  it("passes the gatekeeper action key, not the log id, to the gatekeeper", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 10, { action: 3 });
    let seen: number[] = [];

    await rejectPendingAction(storage, primary, REJECTER, async (key) => { seen.push(key); });

    expect(seen).toEqual([3]);
  });

  it("cascades without restart: cascaded records rejected with cascadedFrom", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);
    putAction(storage, 2, { action: 2 });
    putAction(storage, 3, { action: 3 });
    let restart = vi.fn();

    await rejectPendingAction(
        storage, primary, REJECTER, gatekeeperReturning({ rejectActions: [2, 3] }), restart);

    for (let id of [2, 3]) {
      let rec = getAction(storage, id);
      expect(rec.state).toBe("rejected");
      expect(rec.cascadedFrom).toBe(1);
      expect(rec.resolvedBy?.id).toBe(REJECTER.id);
      expect(rec.appliedAt).toBeInstanceOf(Date);
    }
    // The primary is a direct rejection, never a cascade.
    expect(getAction(storage, 1).cascadedFrom).toBeUndefined();
    expect(restart).not.toHaveBeenCalled();
  });

  it("restarts without cascade, exactly once, after the primary write", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);
    let stateAtRestart: string | undefined;
    let restart = vi.fn(() => { stateAtRestart = getAction(storage, 1).state; });

    let result = await rejectPendingAction(
        storage, primary, REJECTER, gatekeeperReturning({ restart: true }), restart);

    // The gatekeeper's result passes through so the caller can gate follow-up work (e.g. the
    // overseer skips the auto-approval drain when a restart was requested).
    expect(result).toEqual({ restart: true });

    expect(restart).toHaveBeenCalledTimes(1);
    expect(stateAtRestart).toBe("rejected");
  });

  it("restarts once after all cascade writes", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3);
    let statesAtRestart: string[] = [];
    let restart = vi.fn(() => {
      statesAtRestart = [1, 2, 3].map((id) => getAction(storage, id).state);
    });

    await rejectPendingAction(
        storage, primary, REJECTER,
        gatekeeperReturning({ restart: true, rejectActions: [2, 3] }), restart);

    expect(restart).toHaveBeenCalledTimes(1);
    expect(statesAtRestart).toEqual(["rejected", "rejected", "rejected"]);
  });

  it("does not throw when restart is requested but no restartGadget was provided", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);

    await rejectPendingAction(
        storage, primary, REJECTER, gatekeeperReturning({ restart: true }));

    expect(getAction(storage, 1).state).toBe("rejected");
  });

  it("survives a restartGadget that throws; writes stay committed", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);
    let restart = vi.fn(() => { throw new Error("facet abort failed"); });

    await rejectPendingAction(
        storage, primary, REJECTER, gatekeeperReturning({ restart: true }), restart);

    expect(getAction(storage, 1).state).toBe("rejected");
  });

  it("never double-processes the primary when its own key is echoed in rejectActions", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1, { action: 7 });
    putAction(storage, 2, { action: 8 });

    await rejectPendingAction(
        storage, primary, REJECTER, gatekeeperReturning({ rejectActions: [7, 8] }));

    let after = getAction(storage, 1);
    expect(after.state).toBe("rejected");
    expect(after.cascadedFrom).toBeUndefined();
    expect(getAction(storage, 2).cascadedFrom).toBe(1);
  });

  it("leaves another gatekeeper's record with the same action key untouched", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);
    putAction(storage, 2, { action: 5, gatekeeperId: GK });
    putAction(storage, 3, { action: 5, gatekeeperId: GK + 1 });

    await rejectPendingAction(
        storage, primary, REJECTER, gatekeeperReturning({ rejectActions: [5] }));

    expect(getAction(storage, 2).state).toBe("rejected");
    expect(getAction(storage, 3).state).toBe("pending");
  });

  it("matches cascade targets on the gatekeeper action key, not the log id", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1, { action: 1 });
    putAction(storage, 10, { action: 3 });  // the intended target
    putAction(storage, 3, { action: 7 });   // decoy: log id collides with the cascade key

    await rejectPendingAction(
        storage, primary, REJECTER, gatekeeperReturning({ rejectActions: [3] }));

    expect(getAction(storage, 10).state).toBe("rejected");
    expect(getAction(storage, 10).cascadedFrom).toBe(1);
    expect(getAction(storage, 3).state).toBe("pending");
  });

  it("skips non-pending cascade targets, preserving their state", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);
    putAction(storage, 2, { state: "approved" });

    await rejectPendingAction(
        storage, primary, REJECTER, gatekeeperReturning({ rejectActions: [2] }));

    let rec = getAction(storage, 2);
    expect(rec.state).toBe("approved");
    expect(rec.cascadedFrom).toBeUndefined();
  });

  it("ignores unknown cascade keys without throwing", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);

    await rejectPendingAction(
        storage, primary, REJECTER, gatekeeperReturning({ rejectActions: [99, 100] }));

    expect(getAction(storage, 1).state).toBe("rejected");
  });

  // The mock storage throws if a kv.list() iterator is advanced after an interleaved mutation,
  // so a multi-record cascade passing proves the snapshot-before-mutate discipline.
  it("safely mutates during a multi-record cascade (iterator snapshot)", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3);
    putAction(storage, 4);

    await rejectPendingAction(
        storage, primary, REJECTER, gatekeeperReturning({ rejectActions: [2, 3, 4] }));

    for (let id of [2, 3, 4]) {
      expect(getAction(storage, id).state).toBe("rejected");
    }
  });

  it("writes nothing and rethrows when the gatekeeper call throws", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);
    putAction(storage, 2);
    let restart = vi.fn();

    await expect(rejectPendingAction(
        storage, primary, REJECTER,
        async () => { throw new Error("gatekeeper unavailable"); }, restart))
        .rejects.toThrow("gatekeeper unavailable");

    expect(getAction(storage, 1).state).toBe("pending");
    expect(getAction(storage, 2).state).toBe("pending");
    expect(restart).not.toHaveBeenCalled();
  });

  it("skips a cascade target that raced to approved during the gatekeeper await", async () => {
    let storage = makeStorage();
    let primary = putAction(storage, 1);
    putAction(storage, 2);

    // Simulate a concurrent approval landing while the gatekeeper call is in flight.
    let reject: RejectWithGatekeeperFn = async () => {
      let racer = getAction(storage, 2);
      racer.state = "approved";
      storage.actions.put(racer);
      return { rejectActions: [2] };
    };

    await rejectPendingAction(storage, primary, REJECTER, reject);

    let rec = getAction(storage, 2);
    expect(rec.state).toBe("approved");
    expect(rec.cascadedFrom).toBeUndefined();
  });
});
