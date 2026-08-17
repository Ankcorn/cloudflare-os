// Shared helpers for gatekeepers implementing the `Gatekeeper` action contract.

/** Runs asynchronous operations sequentially in submission order. */
export class SerialTaskQueue {
  #tail: Promise<void> = Promise.resolve();

  /** Enqueues an operation without allowing a rejection to block later operations. */
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
