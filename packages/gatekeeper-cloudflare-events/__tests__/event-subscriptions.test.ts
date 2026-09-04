import { describe, expect, it } from "vitest";
import {
  parseCloudflareEvent,
  parseEventSubscriptionSpec,
} from "../src/event-subscriptions-event";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const SUBSCRIPTION_ID = "subscription-1";
const SPEC = {
  source: { service: "observability" },
  events: ["issue.automation-triggered"],
};

function event() {
  return {
    id: "event-1",
    type: "cf.observability.issue.automation-triggered",
    source: { type: "worker", name: "api" },
    metadata: {
      accountId: ACCOUNT_ID,
      eventSubscriptionId: SUBSCRIPTION_ID,
      eventSchemaVersion: 1,
      eventTimestamp: "2026-09-04T10:00:00Z",
    },
    payload: { issue: { id: "issue-1", message: "untrusted" } },
  };
}

describe("Cloudflare Event Subscription validation", () => {
  it("accepts a source and explicit event selection", () => {
    expect(parseEventSubscriptionSpec(SPEC)).toEqual(SPEC);
  });

  it("supports source-specific resource selection", () => {
    const spec = {
      source: { service: "workersAI", model: "@cf/meta/llama" },
      events: ["inference.completed"],
    };
    expect(parseEventSubscriptionSpec(spec)).toEqual(spec);
  });

  it("rejects empty, duplicate, or malformed event selections", () => {
    expect(() => parseEventSubscriptionSpec({ ...SPEC, events: [] })).toThrow("source or events");
    expect(() => parseEventSubscriptionSpec({ ...SPEC, events: ["issue.created", "issue.created"] }))
      .toThrow("source or events");
    expect(() => parseEventSubscriptionSpec({ ...SPEC, unexpected: true }))
      .toThrow("source or events");
  });

  it("accepts an approved event bound to the configured account and subscription", () => {
    expect(parseCloudflareEvent(event(), ACCOUNT_ID, SUBSCRIPTION_ID, SPEC)).toEqual(event());
  });

  it("rejects a message from another account or subscription", () => {
    const wrongAccount = event();
    wrongAccount.metadata.accountId = "ffffffffffffffffffffffffffffffff";
    expect(() => parseCloudflareEvent(wrongAccount, ACCOUNT_ID, SUBSCRIPTION_ID, SPEC))
      .toThrow("not a valid event");

    const wrongSubscription = event();
    wrongSubscription.metadata.eventSubscriptionId = "other-subscription";
    expect(() => parseCloudflareEvent(wrongSubscription, ACCOUNT_ID, SUBSCRIPTION_ID, SPEC))
      .toThrow("not a valid event");
  });

  it("rejects events which were not selected by the Gadget", () => {
    expect(() => parseCloudflareEvent({ ...event(), type: "cf.observability.issue.resolved" },
      ACCOUNT_ID, SUBSCRIPTION_ID, SPEC)).toThrow("not a valid event");
    expect(() => parseCloudflareEvent({ ...event(), id: "x".repeat(257) },
      ACCOUNT_ID, SUBSCRIPTION_ID, SPEC)).toThrow("not a valid event");
  });
});
