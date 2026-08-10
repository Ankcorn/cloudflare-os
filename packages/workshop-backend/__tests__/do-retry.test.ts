import { describe, expect, it, vi } from "vitest";
import {
  DoCallTimeoutError, isDoResetError, retryOnDoReset, withDoCallTimeout,
} from "../src/do-retry";

// Synthetic errors shaped like workerd's tagged rejections (jsg/util.c++). Local aborts reject
// flagless (pinned by the "user-DO reset flags" integration test), so the predicate and retry
// paths are exercised here with the production shapes.
function resetError(flags: Record<string, unknown>): Error {
  return Object.assign(new Error("Durable Object reset."), flags);
}

describe("isDoResetError", () => {
  it("matches the durableObjectReset flag", () => {
    expect(isDoResetError(resetError({ durableObjectReset: true }))).toBe(true);
  });

  it("matches the retryable flag (connection lost)", () => {
    expect(isDoResetError(resetError({ retryable: true }))).toBe(true);
  });

  it("matches the production storage-timeout shape (overloaded reset)", () => {
    expect(isDoResetError(
      resetError({ remote: true, overloaded: true, durableObjectReset: true }))).toBe(true);
  });

  it("rejects overload without a reset — retrying adds load to a live object", () => {
    expect(isDoResetError(resetError({ remote: true, overloaded: true }))).toBe(false);
  });

  it("rejects unflagged and malformed values", () => {
    expect(isDoResetError(new Error("some app error"))).toBe(false);
    expect(isDoResetError(resetError({ durableObjectReset: "yes" }))).toBe(false);
    expect(isDoResetError(resetError({ retryable: 1 }))).toBe(false);
    expect(isDoResetError(null)).toBe(false);
    expect(isDoResetError(undefined)).toBe(false);
    expect(isDoResetError("boom")).toBe(false);
  });
});

describe("withDoCallTimeout", () => {
  it("passes through a completion inside the deadline", async () => {
    await expect(withDoCallTimeout(Promise.resolve("ok"), 1_000)).resolves.toBe("ok");
  });

  it("passes through a rejection inside the deadline unchanged", async () => {
    const failure = new Error("some app error");
    await expect(withDoCallTimeout(Promise.reject(failure), 1_000)).rejects.toBe(failure);
  });

  it("rejects with DoCallTimeoutError once the deadline lapses", async () => {
    const error = await withDoCallTimeout(new Promise<never>(() => {}), 5).then(
      () => { throw new Error("expected a timeout"); },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DoCallTimeoutError);
    expect((error as DoCallTimeoutError).timeoutMs).toBe(5);
  });

  it("swallows the orphaned call's late rejection", async () => {
    let rejectLate!: (e: Error) => void;
    const late = new Promise<never>((_, reject) => { rejectLate = reject; });
    await expect(withDoCallTimeout(late, 1)).rejects.toBeInstanceOf(DoCallTimeoutError);
    rejectLate(new Error("late loser"));
    // An unhandled rejection surfacing here would fail the run (vitest treats it as fatal).
    await scheduler.wait(5);
  });

  it("is not a reset by flag — retryOnDoReset matches it by class instead", () => {
    expect(isDoResetError(new DoCallTimeoutError(5))).toBe(false);
  });
});

describe("retryOnDoReset", () => {
  const immediate: readonly [number, number] = [0, 0];

  it("passes through a first-try success without retrying", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue("ok");
    expect(await retryOnDoReset(fn, onRetry, immediate)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries once after a reset and reports the retry", async () => {
    const failure = resetError({ durableObjectReset: true });
    const onRetry = vi.fn();
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("ok");
    expect(await retryOnDoReset(fn, onRetry, immediate)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledExactlyOnceWith({ error: failure, delayMs: 0 });
  });

  it("gives up after the second failure and propagates it unchanged", async () => {
    const second = resetError({ durableObjectReset: true });
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(resetError({ durableObjectReset: true }))
      .mockRejectedValueOnce(second);
    await expect(retryOnDoReset(fn, undefined, immediate)).rejects.toBe(second);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries once after a deadline timeout (the wedged-object path)", async () => {
    const failure = new DoCallTimeoutError(5);
    const onRetry = vi.fn();
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("ok");
    expect(await retryOnDoReset(fn, onRetry, immediate)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledExactlyOnceWith({ error: failure, delayMs: 0 });
  });

  it("does not retry non-reset failures", async () => {
    const failure = new Error("Workspace not found.");
    const onRetry = vi.fn();
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
    await expect(retryOnDoReset(fn, onRetry, immediate)).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("does not retry overload without a reset", async () => {
    const failure = resetError({ overloaded: true });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
    await expect(retryOnDoReset(fn, undefined, immediate)).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("delays within the configured range", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(resetError({ retryable: true }))
      .mockResolvedValueOnce("ok");
    expect(await retryOnDoReset(fn, onRetry, [1, 3])).toBe("ok");
    const { delayMs } = onRetry.mock.calls[0][0] as { delayMs: number };
    expect(delayMs).toBeGreaterThanOrEqual(1);
    expect(delayMs).toBeLessThanOrEqual(3);
  });
});
