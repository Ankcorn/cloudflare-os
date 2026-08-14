// Action-rejection core: notify the gatekeeper, mark the record rejected, apply any cascade the
// gatekeeper reports, and finally restart the gadget if requested. The gatekeeper call and the
// restart are injected, keeping this constructible over a mock storage in tests (same pattern as
// auto-approval.ts). Unlike the drainer this has no cross-call state, so it is a plain function.

import type { Collection } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord } from "./overseer.js";

const logger = createWorkshopLogger("workshop.action.rejection");

export interface ActionRejectionStorage {
  actions: Collection<ActionRecord, number>;
}

/**
 * What the gatekeeper's `rejectAction()` returned: optionally a request to restart the gadget,
 * and/or a list of its own action keys that became impossible and should be cascade-rejected.
 * Mirrors `Gatekeeper.rejectAction()` in workshop-shared/src/gatekeeper.ts.
 */
export type GatekeeperRejectResult = void | { restart?: boolean; rejectActions?: number[] };

/**
 * Notifies the gatekeeper that the given action (the gatekeeper's own action key) was rejected.
 */
export type RejectWithGatekeeperFn = (action: number) => Promise<GatekeeperRejectResult>;

/**
 * Restarts the gadget that submitted the rejected action. Only invoked after all record writes
 * have been persisted.
 */
export type RestartGadgetFn = () => void;

/**
 * Rejects a single pending action: notify the gatekeeper, mark the record rejected, cascade the
 * rejection onto any records the gatekeeper reported as collaterally impossible, then restart the
 * gadget if the gatekeeper asked for it. Puts auto-notify subscribeToActions, so chat cards and
 * activity views repaint without further plumbing.
 *
 * The caller validates that `record` is pending before calling, and is responsible for resolving
 * the restart target (this core never sees callers or facet naming) -- pass `restartGadget` only
 * when the primary action's caller is a gadget. Note the restart targets only the PRIMARY
 * action's calling gadget: cascaded records submitted by a different gadget on the same
 * gatekeeper are not restarted (rare; such a gadget re-observes real state on its next run).
 *
 * Cascaded records do NOT resume suspended agent turns: a rejected awaited record leaves the
 * turn ended, same as a direct rejection.
 *
 * Returns the gatekeeper's result so the caller can gate follow-up work on it -- in particular,
 * a requested restart signals that remaining pending actions may have been staged on top of
 * now-invalid simulated state, so the caller should NOT immediately auto-apply them.
 *
 * Concurrency notes:
 * - A concurrent double-reject is benign: the second gatekeeper call no-ops on the
 *   already-deleted action and returns an empty cascade, and the re-get below skips the
 *   already-rejected record. No single-flight guard is needed.
 * - Cascade vs. a concurrent auto-approval drain is sound in either order: the gatekeeper DO's
 *   input gate serializes its apply/reject handlers, the drainer catches "Unknown action" and
 *   stops, and both sides re-get records before mutating.
 */
export async function rejectPendingAction(
    storage: ActionRejectionStorage,
    record: ActionRecord & { type: "action" },
    resolvedBy: AiChatAuthorInfo,
    rejectWithGatekeeper: RejectWithGatekeeperFn,
    restartGadget?: RestartGadgetFn): Promise<GatekeeperRejectResult> {
  // Notify the gatekeeper before any record write, so a throw leaves everything pending and
  // retryable.
  let result = await rejectWithGatekeeper(record.action);

  // Everything from here on is synchronous -- no interleaving until the writes are committed.

  // Re-gets the record and marks it rejected iff it is still pending, returning false if it
  // raced away. The re-get is load-bearing for the primary (`record` was read before the
  // gatekeeper await and may be stale; the gatekeeper side has already cleaned up
  // unconditionally) and keeps the cascade mutation uniform.
  let markRejected = (id: number, cascadedFrom?: number): boolean => {
    let fresh = storage.actions.get(id);
    if (!fresh || fresh.type !== "action" || fresh.state !== "pending") return false;
    fresh.state = "rejected";
    fresh.appliedAt = new Date();  // existing convention: doubles as "resolvedAt" for rejections
    fresh.resolvedBy = resolvedBy;
    if (cascadedFrom !== undefined) fresh.cascadedFrom = cascadedFrom;
    storage.actions.put(fresh);
    return true;
  };

  if (!markRejected(record.id)) {
    logger.warn("rejected action was no longer pending when marking it", {
      event: "action.rejection.primary.raced", actionId: record.id,
    });
  }

  let rejectKeys = (result && result.rejectActions) || [];
  if (rejectKeys.length > 0) {
    let keys = new Set(rejectKeys);

    // Materialize a snapshot: list() is a lazy generator over storage, and we mutate the actions
    // collection as we go. Taken AFTER the primary write, so the pending filter naturally
    // excludes the primary even if the gatekeeper echoed its own key; the explicit id check is
    // defense in depth.
    //
    // Cascade candidates match on `rec.action` -- the gatekeeper's own action key, which is what
    // `rejectActions` contains -- NOT on `rec.id` (the overseer log id). The two coincide in
    // many fixtures but diverge in real workspaces. Restricted to the same gatekeeper: action
    // keys are only unique per gatekeeper.
    let cascade = [...storage.actions.list()].filter(
        (rec): rec is ActionRecord & { type: "action" } =>
            rec.gatekeeperId === record.gatekeeperId && rec.type === "action" &&
            rec.state === "pending" && rec.id !== record.id && keys.has(rec.action));

    for (let candidate of cascade) {
      markRejected(candidate.id, record.id);
    }

    // The primary's own key is already handled, so it doesn't count as "unmatched".
    let matched = new Set(cascade.map((rec) => rec.action));
    let unmatched = rejectKeys.filter((key) => !matched.has(key) && key !== record.action);
    if (unmatched.length > 0) {
      logger.warn(
          `gatekeeper cascade-rejected actions with no matching pending record: ${unmatched.join(", ")}`,
          { event: "action.rejection.cascade.unmatched", actionId: record.id });
    }
  }

  // Restart strictly last: all writes are committed, so a restart failure can't lose them.
  if (result && result.restart) {
    if (restartGadget) {
      try {
        restartGadget();
      } catch (err) {
        // Aborting a not-running facet is a no-op, so a throw here is unexpected; the rejection
        // itself already succeeded, so log and move on rather than failing the whole call.
        logger.warn("failed to restart gadget after rejection", {
          event: "action.rejection.restart.failed", actionId: record.id, error: err,
        });
      }
    } else {
      // Agent/user/hook callers have nothing to restart (agent turns end on rejection by
      // design), and pre-multi-gadget records may lack a resolvable gadget.
      logger.info("gatekeeper requested restart but the action has no restartable gadget", {
        event: "action.rejection.restart.skipped", actionId: record.id,
      });
    }
  }

  return result;
}
