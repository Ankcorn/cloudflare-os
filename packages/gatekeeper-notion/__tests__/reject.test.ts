import { describe, expect, it } from "vitest";
import {
  NotionStore,
  rejectStoredAction,
  type NotionAction,
} from "../src/notion-actions";
import type { NotionApi } from "../src/notion-api";

type Kv = ConstructorParameters<typeof NotionStore>[0];

// Minimal in-memory KV matching the slice of the DO storage API the store uses.
function makeKv(): Kv {
  const map = new Map<string, unknown>();
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    put: (k: string, v: unknown) => void map.set(k, v),
    delete: (k: string) => void map.delete(k),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([k]) => k.startsWith(prefix)) as [string, T][],
  } as unknown as Kv;
}

// rejectStoredAction never touches the API, so a bare stub suffices.
function makeStore(): NotionStore {
  return new NotionStore(makeKv(), {} as NotionApi);
}

function stage(store: NotionStore, action: NotionAction): number {
  const id = store.nextActionId();
  store.putAction({ id, action, state: "pending", submittedAt: id });
  return id;
}

describe("rejectStoredAction", () => {
  it("deletes a pending action", () => {
    const store = makeStore();
    const id = stage(store, { type: "setTitle", pageId: "p1", title: "New", previousTitle: "Old" });

    const result = rejectStoredAction(store, id);

    expect(result).toBeUndefined();
    expect(store.getAction(id)).toBeUndefined();
  });

  it("cascade-deletes pending actions on a rejected creation and reports them", () => {
    const store = makeStore();
    const creation = stage(store, { type: "createPage", provisionalId: "~1", parent: { kind: "workspace" }, title: "New Page" });
    const child = stage(store, { type: "appendContent", pageId: "~1", markdown: "body" });

    const result = rejectStoredAction(store, creation);

    expect(result).toEqual({ restart: true, rejectActions: [child] });
    expect(store.getAction(child)).toBeUndefined();
  });

  it("no-ops on an applied action, preserving it for revert", () => {
    const store = makeStore();
    const id = stage(store, { type: "setTitle", pageId: "p1", title: "New", previousTitle: "Old" });
    store.putAction({ ...store.getAction(id)!, state: "applied" });

    // A reject that lost a race against a concurrent apply: the side effect already happened, so
    // the applied record must stay intact.
    const result = rejectStoredAction(store, id);

    expect(result).toBeUndefined();
    expect(store.getAction(id)?.state).toBe("applied");
  });

  it("does not cascade an applied creation's pending children", () => {
    const store = makeStore();
    const creation = stage(store, { type: "createPage", provisionalId: "~1", parent: { kind: "workspace" }, title: "New Page" });
    const child = stage(store, { type: "appendContent", pageId: "~1", markdown: "body" });
    store.putAction({ ...store.getAction(creation)!, state: "applied" });

    const result = rejectStoredAction(store, creation);

    expect(result).toBeUndefined();
    expect(store.getAction(creation)?.state).toBe("applied");
    expect(store.getAction(child)?.state).toBe("pending");
  });
});
