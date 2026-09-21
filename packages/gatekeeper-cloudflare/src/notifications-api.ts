import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { assertCloudflareAccountId } from "./resources.js";

const API = "https://api.cloudflare.com/client/v4";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed Cloudflare Notifications response.");
  }
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)
  ) {
    throw new Error("Invalid Cloudflare Notifications resource ID.");
  }
  return value;
}

async function request(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Cloudflare Notifications request failed (${response.status}). ` +
        "Check Notifications Write access and webhook eligibility.",
    );
  }
  const envelope = object(JSON.parse(await readTextCapped(response)));
  if (envelope.success !== true || !("result" in envelope)) {
    throw new Error("Cloudflare Notifications rejected the request.");
  }
  return envelope.result;
}

async function list(token: string, path: string): Promise<Record<string, unknown>[]> {
  const result = await request(token, path);
  if (!Array.isArray(result)) throw new Error("Cloudflare Notifications returned an invalid list.");
  return result.map(object);
}

/** Create or reconcile the destination identified by its exact callback URL. */
export async function provisionNotificationInstallation(
  token: string,
  accountId: string,
  webhookUrl: string,
  secret: string,
  name = "Cloudflare OS",
): Promise<{ webhookId: string }> {
  const root = `/accounts/${assertCloudflareAccountId(accountId)}/alerting/v3`;
  const matches = (await list(token, `${root}/destinations/webhooks`)).filter(
    (item) => item.url === webhookUrl,
  );
  if (matches.length > 1) {
    throw new Error("Multiple notification destinations use this webhook URL.");
  }
  const body = { name, type: "generic", url: webhookUrl, secret };
  const webhookId = matches[0]
    ? id(matches[0].id)
    : id(object(await request(token, `${root}/destinations/webhooks`, "POST", body)).id);
  if (matches[0]) await request(token, `${root}/destinations/webhooks/${webhookId}`, "PUT", body);
  return { webhookId };
}
