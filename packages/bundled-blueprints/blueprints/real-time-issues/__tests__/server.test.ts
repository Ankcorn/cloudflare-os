// @vitest-environment node
import * as workers from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { Gadget } from "../files/server.ts";

const restore = (workers as unknown as {restore: symbol}).restore;

const notification = {
  id: "10000000-0000-4000-8000-000000000001",
  timestamp: "2026-09-21T12:00:00.000Z",
  payload: { issue: { id: "issue-42" }, symptom: "worker errors" },
};

function fixture() {
  const stored = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => stored.get(key),
    put: async (key: string, value: unknown) => { stored.set(key, value); },
    delete: async (key: string) => stored.delete(key),
  };
  const spawn = vi.fn(async (_title: string, _prompt: string) => {});
  let callback: {onWebhook(value: typeof notification): Promise<void>} | undefined;
  const subscribe = vi.fn(async (value: InstanceType<typeof workers.RpcTarget>) => {
    callback = value as unknown as typeof callback;
  });
  let gadget: Gadget;
  const state = {
    storage,
    restore: async (params: {type?: string}) => gadget[restore](params),
  } as unknown as DurableObjectState;
  gadget = new Gadget(state, {
    INVESTIGATOR: {spawn},
    INCOMING_WEBHOOK: {subscribe},
  });
  return {gadget, stored, spawn, subscribe, get callback() { return callback; }};
}

describe("Real-Time Issues Investigator webhook ingress", () => {
  it("subscribes to issue webhooks and spawns one constrained investigation", async () => {
    const f = fixture();
    await f.gadget.install();
    expect(f.callback).toBeDefined();

    await f.callback!.onWebhook(notification);
    await f.callback!.onWebhook(notification);

    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0]![0]).toContain(notification.payload.issue.id);
    expect(f.spawn.mock.calls[0]![1]).toContain("Do not deploy or make external changes");
    expect(f.spawn.mock.calls[0]![1]).toContain(JSON.stringify(notification.payload));
    expect(f.stored.get(`investigation:${notification.payload.issue.id}`)).toEqual({
      eventId: notification.id,
      state: "spawned",
    });
  });

  it("allows webhook retry when spawning fails", async () => {
    const f = fixture();
    f.spawn.mockRejectedValueOnce(new Error("spawn failed"));
    await f.gadget.install();
    await expect(f.callback!.onWebhook(notification)).rejects.toThrow("spawn failed");
    expect(f.stored.has(`investigation:${notification.payload.issue.id}`)).toBe(false);
  });
});
