import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { WebhookEvent } from "../src/types.js";

export { default } from "../src/webhook.js";
export * from "../src/webhook.js";

type TestMode = "success" | "start-reject" | "authorization-reject" | "callback-reject";
let mode: TestMode = "success";
let events: string[] = [];
let deliveries: WebhookEvent[] = [];
let disposedCallbacks = 0;
let disposedQueues = 0;
let callbackBarrier: Promise<void> | undefined;
let releaseBlockedCallback: (() => void) | undefined;
let markCallbackBlocked: (() => void) | undefined;
let callbackBlocked: Promise<void> = Promise.resolve();

class TestApprovalQueue extends RpcTarget {
  #markDisposed!: () => void;
  readonly disposed = new Promise<void>(resolve => { this.#markDisposed = resolve; });
  async authorizeObservation(): Promise<void> {
    events.push("authorize");
    if (mode === "authorization-reject") throw new Error("authorization rejected");
  }
  [Symbol.dispose](): void { disposedQueues++; this.#markDisposed(); }
}

class TestCallback extends RpcTarget {
  #markDisposed!: () => void;
  readonly disposed = new Promise<void>(resolve => { this.#markDisposed = resolve; });
  async onWebhook(event: WebhookEvent): Promise<void> {
    events.push("callback");
    deliveries.push(event);
    if (callbackBarrier) {
      markCallbackBlocked?.();
      await callbackBarrier;
    }
    if (mode === "callback-reject") throw new Error("callback rejected");
  }
  [Symbol.dispose](): void { disposedCallbacks++; this.#markDisposed(); }
}

/** Real HookInitiator entrypoint used by receiver lifecycle tests. */
export class TestHooks extends WorkerEntrypoint {
  async startHook(): Promise<{ callback: TestCallback; approvalQueue: TestApprovalQueue }> {
    events.push("start");
    if (mode === "start-reject") throw new Error("start rejected");
    const callback = new TestCallback();
    const approvalQueue = new TestApprovalQueue();
    this.ctx.waitUntil(Promise.race([
      Promise.all([callback.disposed, approvalQueue.disposed]),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]).then(() => undefined));
    return { callback, approvalQueue };
  }
  configure(next: TestMode): void { mode = next; }
  blockCallback(): void {
    callbackBlocked = new Promise(resolve => { markCallbackBlocked = resolve; });
    callbackBarrier = new Promise(resolve => {
      releaseBlockedCallback = resolve;
    });
  }
  waitUntilCallbackBlocked(): Promise<void> { return callbackBlocked; }
  releaseCallback(): void {
    releaseBlockedCallback?.();
    callbackBarrier = undefined;
    releaseBlockedCallback = undefined;
    markCallbackBlocked = undefined;
  }
  read() { return { events: [...events], deliveries: [...deliveries], disposedCallbacks, disposedQueues }; }
  reset(): void {
    mode = "success";
    events = [];
    deliveries = [];
    disposedCallbacks = 0;
    disposedQueues = 0;
    releaseBlockedCallback?.();
    callbackBarrier = undefined;
    releaseBlockedCallback = undefined;
    markCallbackBlocked = undefined;
    callbackBlocked = Promise.resolve();
  }
}
