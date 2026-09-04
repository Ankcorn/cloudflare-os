import { VENDOR_ID } from "./vendor.js";
import { obsContext } from "./observability.js";
import type { CloudflareEventSubscriptionSpec } from "./types.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare.events-api", vendorId: VENDOR_ID,
});

interface CloudflareEnvelope {
  success?: unknown;
  result?: unknown;
}

export interface QueueInstallation {
  queueId: string;
  queueName: string;
  consumerId: string;
  subscriptionId: string;
}

export interface PulledQueueMessage {
  id: string;
  leaseId: string;
  body: unknown;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Cloudflare API response while ${context}.`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, context: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Cloudflare API response omitted ${key} while ${context}.`);
  }
  return field;
}

async function request(
  token: string,
  path: string,
  context: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    response.body?.cancel();
    logger.error("Cloudflare Events API request failed", {
      event: "real_time_issues.api.failed",
      path,
      status: response.status,
      statusText: response.statusText,
    });
    throw new Error(`Cloudflare API request failed while ${context} (HTTP ${response.status}).`);
  }
  const envelope = record(await response.json(), context) as CloudflareEnvelope;
  if (envelope.success !== true || envelope.result === undefined) {
    throw new Error(`Cloudflare API returned an unsuccessful response while ${context}.`);
  }
  return envelope.result;
}

function decodeBody(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const candidates = [value];
  try {
    candidates.push(atob(value));
  } catch {
    // The body may already be plain JSON rather than base64-encoded JSON.
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next supported Queue body representation.
    }
  }
  throw new Error("Queue message body is not valid JSON.");
}

/** Provision the dedicated Queue, HTTP pull consumer, and Event Subscription for one hook. */
export async function provisionRealTimeIssuesQueue(
  token: string,
  accountId: string,
  installationId: string,
  requestedSubscription: CloudflareEventSubscriptionSpec,
): Promise<QueueInstallation> {
  const queueName = `cloudflare-os-events-${installationId}`;
  const queue = record(await request(token, `/accounts/${accountId}/queues`, "creating Queue", {
    method: "POST",
    body: JSON.stringify({ queue_name: queueName }),
  }), "creating Queue");
  const queueId = stringField(queue, "queue_id", "creating Queue");

  try {
    const consumer = record(await request(
      token,
      `/accounts/${accountId}/queues/${queueId}/consumers`,
      "enabling Queue HTTP pull",
      { method: "POST", body: JSON.stringify({ type: "http_pull", settings: {} }) },
    ), "enabling Queue HTTP pull");
    const consumerId = stringField(consumer, "consumer_id", "enabling Queue HTTP pull");

    const subscription = record(await request(
      token,
      `/accounts/${accountId}/event_subscriptions/subscriptions`,
      "creating Event Subscription",
      {
        method: "POST",
        body: JSON.stringify({
          name: `Cloudflare OS Events ${installationId}`,
          source: requestedSubscription.source,
          destination: { service: "queues", queue_id: queueId },
          events: requestedSubscription.events,
        }),
      },
    ), "creating Event Subscription");
    return {
      queueId,
      queueName,
      consumerId,
      subscriptionId: stringField(subscription, "id", "creating Event Subscription"),
    };
  } catch (error) {
    await deleteQueue(token, accountId, queueId).catch(cleanupError =>
      logger.warn("failed to clean up Queue after provisioning failure", {
        event: "real_time_issues.provision.cleanup.failed",
        accountId,
        queueId,
        error: cleanupError,
      }));
    throw error;
  }
}

/** Remove only the exact Event Subscription and Queue recorded for this hook installation. */
export async function removeRealTimeIssuesQueue(
  token: string,
  accountId: string,
  installation: QueueInstallation,
): Promise<void> {
  await request(
    token,
    `/accounts/${accountId}/event_subscriptions/subscriptions/${installation.subscriptionId}`,
    "deleting Event Subscription",
    { method: "DELETE" },
  );
  await deleteQueue(token, accountId, installation.queueId);
}

async function deleteQueue(token: string, accountId: string, queueId: string): Promise<void> {
  await request(token, `/accounts/${accountId}/queues/${queueId}`, "deleting Queue", {
    method: "DELETE",
  });
}

/** Pull a bounded batch from the installation's dedicated Queue. */
export async function pullRealTimeIssueMessages(
  token: string,
  accountId: string,
  queueId: string,
): Promise<{ messages: PulledQueueMessage[]; backlog: number }> {
  const result = record(await request(
    token,
    `/accounts/${accountId}/queues/${queueId}/messages/pull`,
    "pulling Queue messages",
    {
      method: "POST",
      body: JSON.stringify({ batch_size: 10, visibility_timeout_ms: 60_000 }),
    },
  ), "pulling Queue messages");
  const rawMessages = result.messages;
  if (!Array.isArray(rawMessages)) {
    throw new Error("Cloudflare API response omitted messages while pulling Queue messages.");
  }
  const messages = rawMessages.map((value, index) => {
    const message = record(value, `parsing Queue message ${index}`);
    return {
      id: stringField(message, "id", `parsing Queue message ${index}`),
      leaseId: stringField(message, "lease_id", `parsing Queue message ${index}`),
      body: decodeBody(message.body),
    };
  });
  const rawBacklog = result.message_backlog_count;
  const backlog = typeof rawBacklog === "number" && Number.isSafeInteger(rawBacklog) && rawBacklog >= 0
    ? rawBacklog
    : 0;
  return { messages, backlog };
}

/** Acknowledge messages only after their Gadget hook delivery completed. */
export async function acknowledgeRealTimeIssueMessages(
  token: string,
  accountId: string,
  queueId: string,
  leaseIds: string[],
): Promise<void> {
  if (leaseIds.length === 0) return;
  await request(token, `/accounts/${accountId}/queues/${queueId}/messages/ack`,
    "acknowledging Queue messages", {
      method: "POST",
      body: JSON.stringify({
        acks: leaseIds.map(lease_id => ({ lease_id })),
        retries: [],
      }),
    });
}
