import { describe, expect, it } from "vitest";
import { parseRealTimeIssueEvent } from "../src/real-time-issues-event";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const SUBSCRIPTION_ID = "subscription-1";

function event() {
  return {
    id: "event-1",
    type: "cf.observability.issue.automation-triggered",
    source: { service: "real-time-issues" },
    metadata: {
      accountId: ACCOUNT_ID,
      eventSubscriptionId: SUBSCRIPTION_ID,
      eventSchemaVersion: 1,
      eventTimestamp: "2026-09-04T10:00:00Z",
    },
    payload: { issue: { id: "issue-1", message: "untrusted" } },
  };
}

describe("Real-Time Issues event validation", () => {
  it("accepts an event bound to the configured account and subscription", () => {
    expect(parseRealTimeIssueEvent(event(), ACCOUNT_ID, SUBSCRIPTION_ID)).toEqual(event());
  });

  it("rejects a message from another account", () => {
    const value = event();
    value.metadata.accountId = "ffffffffffffffffffffffffffffffff";

    expect(() => parseRealTimeIssueEvent(value, ACCOUNT_ID, SUBSCRIPTION_ID))
      .toThrow("not a valid Real-Time Issues automation event");
  });

  it("rejects a message injected through another subscription", () => {
    const value = event();
    value.metadata.eventSubscriptionId = "other-subscription";

    expect(() => parseRealTimeIssueEvent(value, ACCOUNT_ID, SUBSCRIPTION_ID))
      .toThrow("not a valid Real-Time Issues automation event");
  });

  it("rejects malformed or unexpected event types", () => {
    expect(() => parseRealTimeIssueEvent({ ...event(), type: "queue.created" }, ACCOUNT_ID, SUBSCRIPTION_ID))
      .toThrow("not a valid Real-Time Issues automation event");
    expect(() => parseRealTimeIssueEvent(null, ACCOUNT_ID, SUBSCRIPTION_ID))
      .toThrow("not a valid Real-Time Issues automation event");
  });
});
