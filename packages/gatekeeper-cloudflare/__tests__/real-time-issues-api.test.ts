import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeRealTimeIssueMessages,
  provisionRealTimeIssuesQueue,
  pullRealTimeIssueMessages,
  removeRealTimeIssuesQueue,
} from "../src/real-time-issues-api";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const SUBSCRIPTION = {
  source: { service: "observability" },
  events: ["issue.automation-triggered"],
};

afterEach(() => vi.unstubAllGlobals());

function envelope(result: unknown): Response {
  return Response.json({ success: true, errors: [], messages: [], result });
}

describe("Cloudflare Events Queue API", () => {
  it("provisions a dedicated Queue, pull consumer, and Event Subscription", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      envelope({ queue_id: "queue-1", queue_name: "cloudflare-os-events-install-1" }),
      envelope({ consumer_id: "consumer-1" }),
      envelope({ id: "subscription-1" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return responses.shift()!;
    }));

    await expect(provisionRealTimeIssuesQueue("oauth-token", ACCOUNT_ID, "install-1", SUBSCRIPTION))
      .resolves.toEqual({
        queueId: "queue-1",
        queueName: "cloudflare-os-events-install-1",
        consumerId: "consumer-1",
        subscriptionId: "subscription-1",
      });

    expect(calls.map(call => [call.init.method, new URL(call.url).pathname])).toEqual([
      ["POST", `/client/v4/accounts/${ACCOUNT_ID}/queues`],
      ["POST", `/client/v4/accounts/${ACCOUNT_ID}/queues/queue-1/consumers`],
      ["POST", `/client/v4/accounts/${ACCOUNT_ID}/event_subscriptions/subscriptions`],
    ]);
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({
      name: "Cloudflare OS Events install-1",
      source: SUBSCRIPTION.source,
      destination: { service: "queues", queue_id: "queue-1" },
      events: SUBSCRIPTION.events,
    });
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer oauth-token");
    }
  });

  it("removes only the recorded subscription and Queue", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      paths.push(new URL(String(input)).pathname);
      return envelope(null);
    }));

    await removeRealTimeIssuesQueue("token", ACCOUNT_ID, {
      queueId: "queue-1",
      queueName: "managed",
      consumerId: "consumer-1",
      subscriptionId: "subscription-1",
    });

    expect(paths).toEqual([
      `/client/v4/accounts/${ACCOUNT_ID}/event_subscriptions/subscriptions/subscription-1`,
      `/client/v4/accounts/${ACCOUNT_ID}/queues/queue-1`,
    ]);
  });

  it("decodes base64 JSON pull bodies and acknowledges their leases", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (String(input).endsWith("/pull")) {
        return envelope({
          message_backlog_count: 1,
          messages: [{
            id: "message-1",
            lease_id: "lease-1",
            body: btoa(JSON.stringify({ id: "event-1" })),
          }],
        });
      }
      return envelope(null);
    }));

    await expect(pullRealTimeIssueMessages("token", ACCOUNT_ID, "queue-1")).resolves.toEqual({
      backlog: 1,
      messages: [{ id: "message-1", leaseId: "lease-1", body: { id: "event-1" } }],
    });
    await acknowledgeRealTimeIssueMessages("token", ACCOUNT_ID, "queue-1", ["lease-1"]);

    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      acks: [{ lease_id: "lease-1" }],
      retries: [],
    });
  });

  it("cleans up the Queue when later provisioning fails", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      if (calls.length === 1) return envelope({ queue_id: "queue-1" });
      if (calls.length === 2) return new Response("denied", { status: 403 });
      return envelope(null);
    }));

    await expect(provisionRealTimeIssuesQueue("token", ACCOUNT_ID, "install", SUBSCRIPTION))
      .rejects.toThrow("enabling Queue HTTP pull (HTTP 403)");
    expect(calls.at(-1)).toContain(`/accounts/${ACCOUNT_ID}/queues/queue-1`);
  });
});
