// @vitest-environment node
import * as workers from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { Gadget } from "../files/server.ts";

const restore = (workers as unknown as {restore: symbol}).restore;

const notification = {
  id: "10000000-0000-4000-8000-000000000001",
  accountId: "account-1",
  alertType: "workers_observability_real_time_issue",
  timestamp: "2026-09-21T12:00:00.000Z",
  data: { issue: { id: "20000000-0000-4000-8000-000000000002" } },
};

function fixture() {
  const stored = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => stored.get(key),
    put: async (key: string, value: unknown) => { stored.set(key, value); },
    delete: async (key: string) => stored.delete(key),
  };
  const spawn = vi.fn(async (_title: string, _prompt: string) => {});
  let callback: {onNotification(value: typeof notification): Promise<void>} | undefined;
  const subscribe = vi.fn(async (
    value: InstanceType<typeof workers.RpcTarget>, filter: {alertTypes: string[]},
  ) => {
    callback = value as unknown as typeof callback;
    expect(filter).toEqual({alertTypes: ["workers_observability_real_time_issue"]});
  });
  let gadget: Gadget;
  const state = {
    storage,
    restore: async (params: {type?: string}) => gadget[restore](params),
  } as unknown as DurableObjectState;
  gadget = new Gadget(state, {
    INVESTIGATOR: {spawn},
    CLOUDFLARE_NOTIFICATIONS: {subscribe},
  });
  return {gadget, stored, spawn, subscribe, get callback() { return callback; }};
}

describe("Real-Time Issues Investigator webhook ingress", () => {
  it("subscribes to issue webhooks and spawns one constrained investigation", async () => {
    const f = fixture();
    await f.gadget.install();
    expect(f.callback).toBeDefined();

    await f.callback!.onNotification(notification);
    await f.callback!.onNotification(notification);

    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0]![0]).toContain(notification.data.issue.id);
    expect(f.spawn.mock.calls[0]![1]).toContain("Do not merge or deploy");
    expect(f.spawn.mock.calls[0]![1]).toContain(JSON.stringify(notification));
    expect(f.stored.get(`investigation:${notification.data.issue.id}`)).toEqual({
      notificationId: notification.id,
      state: "spawned",
    });
  });

  it("allows webhook retry when spawning fails", async () => {
    const f = fixture();
    f.spawn.mockRejectedValueOnce(new Error("spawn failed"));
    await f.gadget.install();
    await expect(f.callback!.onNotification(notification)).rejects.toThrow("spawn failed");
    expect(f.stored.has(`investigation:${notification.data.issue.id}`)).toBe(false);
  });
});
