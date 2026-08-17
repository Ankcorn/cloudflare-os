import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "../src/gatekeeper-action";

// This package deliberately avoids the full Node type environment (see node-async-hooks.d.ts).
// Tests run under vitest on Node, so type the small `process` surface used here locally.
const nodeProcess = (globalThis as Record<string, unknown>)["process"] as {
  on(event: "unhandledRejection", handler: (reason: unknown) => void): void;
  off(event: "unhandledRejection", handler: (reason: unknown) => void): void;
};

describe("SerialTaskQueue", () => {
  it("runs operations one at a time in submission order", async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });

    const first = queue.run(async () => {
      events.push("first:start");
      await blocked;
      events.push("first:end");
      return 1;
    });
    const second = queue.run(() => {
      events.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues after an operation rejects", async () => {
    const queue = new SerialTaskQueue();
    const failed = queue.run(() => { throw new Error("failed"); });
    const recovered = queue.run(() => "recovered");

    await expect(failed).rejects.toThrow("failed");
    await expect(recovered).resolves.toBe("recovered");
  });

  it("preserves order across an asynchronous rejection", async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];

    const failed = queue.run(async () => {
      events.push("first");
      await Promise.resolve();
      throw new Error("async failure");
    });
    const second = queue.run(() => {
      events.push("second");
      return "ok";
    });

    await expect(failed).rejects.toThrow("async failure");
    await expect(second).resolves.toBe("ok");
    expect(events).toEqual(["first", "second"]);
  });

  it("does not leak an unhandled rejection from its internal chain", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    nodeProcess.on("unhandledRejection", onUnhandled);
    try {
      const queue = new SerialTaskQueue();
      // A synchronous throw rejects the queue's chained promises directly, so a missing rejection
      // handler on the internal tail promise would surface here as an unhandled rejection.
      await expect(queue.run(() => { throw new Error("boom"); })).rejects.toThrow("boom");
      // Unhandled rejections are reported asynchronously, after the microtask queue drains.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      nodeProcess.off("unhandledRejection", onUnhandled);
    }
  });
});
