// Server-side classification and retry for Durable Object resets.
//
// workerd tags rejections from a reset or disconnected DO with structured flags (jsg/util.c++):
// `retryable` ⇔ connection lost, `overloaded` ⇔ load shedding, and `durableObjectReset`
// whenever the object's incarnation died — the production storage-timeout reset arrives as
// `{remote, overloaded, durableObjectReset}`. The flags are attached natively in the calling
// Worker, so no message matching is needed. Local vitest-pool-workers aborts reject FLAGLESS
// (pinned by the "user-DO reset flags" integration test), so these paths are unit-tested with
// synthetic errors and integration tests assert recovery behaviorally.

/** True for rejections caused by a DO reset or lost connection — cases where a retry of an
 * IDEMPOTENT call through a fresh stub is expected to succeed against the restarted object.
 * `overloaded` alone is deliberately excluded (the object is alive and shedding load; a retry
 * adds to it — the docs' "never retry .overloaded" case). An overloaded RESET is retried
 * despite that blanket wording: the overloaded queue died with the incarnation, and one
 * jittered attempt is not a retry loop. */
export function isDoResetError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const flags = e as { durableObjectReset?: unknown; retryable?: unknown };
  return flags.durableObjectReset === true || flags.retryable === true;
}

export interface DoRetryInfo {
  /** The initial call's rejection that is about to be retried. */
  error: unknown;
  delayMs: number;
}

/** Runs `fn`, retrying ONCE after a short jittered delay if it rejects with a DO-reset error.
 * `fn` MUST be idempotent and MUST mint a fresh stub per invocation (a stub is permanently
 * broken once its incarnation resets). `onRetry` fires before the delay. A second failure
 * propagates unchanged — the client's socket-level recovery is the backstop, not a retry
 * loop. */
export async function retryOnDoReset<T>(
    fn: () => Promise<T>,
    onRetry?: (info: DoRetryInfo) => void,
    delayRangeMs: readonly [number, number] = [150, 400]): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isDoResetError(e)) throw e;
    const delayMs = delayRangeMs[0] + Math.random() * (delayRangeMs[1] - delayRangeMs[0]);
    onRetry?.({ error: e, delayMs });
    await scheduler.wait(delayMs);
    return await fn();
  }
}
