import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const PROPS = { userObjectId: "user-1", accountId: ACCOUNT_ID };
const hooks = env.TEST_HOOKS.getByName("event-subscriptions");

const subscription = {
  source: { service: "observability" },
  events: ["issue.automation-triggered"],
};

describe("Cloudflare Event Subscriptions gatekeeper", () => {
  it("describes an account-scoped Event Subscriptions resource", async () => {
    const description = await hooks.describeEventSubscription("description", PROPS);

    expect(description).toEqual({
      url: `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/queues/event-subscriptions`,
      title: "Cloudflare Event Subscriptions",
      suggestedBindingName: "CLOUDFLARE_EVENTS",
    });
  });

  it("records the requested source and events for hook approval", async () => {
    const description = await hooks.subscribeToEvents("subscription", PROPS, subscription);

    expect(description).toMatchObject({ title: "Subscribe to observability events" });
    expect(description).toMatchObject({
      description: expect.stringContaining("Receive issue.automation-triggered"),
    });
    expect(description).toMatchObject({
      description: expect.stringContaining('from {"service":"observability"}'),
    });
  });

});
