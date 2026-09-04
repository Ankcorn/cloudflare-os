import type {
  CloudflareEvent,
  CloudflareEventSubscriptionSpec,
} from "./types.js";

const EVENT_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{0,127}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isJson(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 10) return false;
  if (Array.isArray(value)) return value.length <= 100 && value.every(item => isJson(item, depth + 1));
  const record = asRecord(value);
  return record !== null && Object.keys(record).length <= 100 &&
    Object.values(record).every(item => isJson(item, depth + 1));
}

/** Validate and canonicalize the source and events requested by Gadget code. */
export function parseEventSubscriptionSpec(value: unknown): CloudflareEventSubscriptionSpec {
  const spec = asRecord(value);
  const source = asRecord(spec?.source);
  const events = spec?.events;
  if (!spec || Object.keys(spec).length !== 2 || !source || !isJson(source) ||
      typeof source.service !== "string" || !EVENT_NAME_PATTERN.test(source.service) ||
      !Array.isArray(events) || events.length === 0 || events.length > 20 ||
      events.some(event => typeof event !== "string" || !EVENT_NAME_PATTERN.test(event)) ||
      new Set(events).size !== events.length || JSON.stringify(source).length > 4_096) {
    throw new Error("Invalid Cloudflare Event Subscription source or events.");
  }
  return {
    source: structuredClone(source) as CloudflareEventSubscriptionSpec["source"],
    events: [...events] as string[],
  };
}

/** Validate the Event Hub envelope before it crosses into Gadget code. */
export function parseCloudflareEvent(
  value: unknown,
  expectedAccountId: string,
  expectedSubscriptionId: string,
  subscription: CloudflareEventSubscriptionSpec,
): CloudflareEvent {
  const event = asRecord(value);
  const source = asRecord(event?.source);
  const metadata = asRecord(event?.metadata);
  const expectedTypes = new Set(
    subscription.events.map(name => `cf.${subscription.source.service}.${name}`),
  );
  if (!event || typeof event.type !== "string" || !expectedTypes.has(event.type) ||
      typeof event.id !== "string" || !event.id || event.id.length > 256 || !source || !metadata ||
      metadata.accountId !== expectedAccountId ||
      metadata.eventSubscriptionId !== expectedSubscriptionId ||
      typeof metadata.eventSchemaVersion !== "number" ||
      !Number.isSafeInteger(metadata.eventSchemaVersion) ||
      typeof metadata.eventTimestamp !== "string" || event.payload === undefined) {
    throw new Error("Queue message is not a valid event for this Cloudflare Event Subscription.");
  }
  return {
    id: event.id,
    type: event.type,
    source: source as CloudflareEvent["source"],
    metadata: {
      accountId: expectedAccountId,
      eventSubscriptionId: expectedSubscriptionId,
      eventSchemaVersion: metadata.eventSchemaVersion,
      eventTimestamp: metadata.eventTimestamp,
    },
    payload: event.payload as CloudflareEvent["payload"],
  };
}
