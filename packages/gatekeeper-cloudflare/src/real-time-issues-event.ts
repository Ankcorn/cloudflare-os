import type { CloudflareRealTimeIssueEvent } from "./types.js";

const EVENT_TYPE = "cf.observability.issue.automation-triggered";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Validate the Event Hub envelope before it crosses into Gadget code. */
export function parseRealTimeIssueEvent(
  value: unknown,
  expectedAccountId: string,
  expectedSubscriptionId: string,
): CloudflareRealTimeIssueEvent {
  const event = asRecord(value);
  const source = asRecord(event?.source);
  const metadata = asRecord(event?.metadata);
  if (!event || event.type !== EVENT_TYPE || typeof event.id !== "string" || !event.id ||
      !source || !metadata || metadata.accountId !== expectedAccountId ||
      metadata.eventSubscriptionId !== expectedSubscriptionId ||
      typeof metadata.eventSchemaVersion !== "number" ||
      !Number.isSafeInteger(metadata.eventSchemaVersion) ||
      typeof metadata.eventTimestamp !== "string" || event.payload === undefined) {
    throw new Error("Queue message is not a valid Real-Time Issues automation event.");
  }
  return {
    id: event.id,
    type: EVENT_TYPE,
    source: source as CloudflareRealTimeIssueEvent["source"],
    metadata: {
      accountId: expectedAccountId,
      eventSubscriptionId: expectedSubscriptionId,
      eventSchemaVersion: metadata.eventSchemaVersion,
      eventTimestamp: metadata.eventTimestamp,
    },
    payload: event.payload as CloudflareRealTimeIssueEvent["payload"],
  };
}
