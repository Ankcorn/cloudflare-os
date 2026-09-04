import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

const QUEUES_SCOPE = "queues:write";
const DASHBOARD_ORIGIN = "https://dash.cloudflare.com";
const ACCOUNT_ID_PATTERN = /^[a-f\d]{32}$/i;

export const EVENT_SUBSCRIPTIONS_RESOURCE: SupportedResource = {
  urlPattern: `${DASHBOARD_ORIGIN}/:accountId/workers/queues/event-subscriptions`,
  title: "Cloudflare Event Subscriptions",
  description: "Deliver selected Cloudflare account events through managed Event Subscriptions.",
  grantable: true,
};

export const CLOUDFLARE_RESOURCES = [EVENT_SUBSCRIPTIONS_RESOURCE];
const RESOURCE_PATTERNS = new Set(CLOUDFLARE_RESOURCES.map(resource => resource.urlPattern));

export function assertCloudflareAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("Invalid Cloudflare account ID.");
  return accountId.toLowerCase();
}

export function eventSubscriptionsUrl(accountId: string): string {
  return `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(accountId)}` +
    "/workers/queues/event-subscriptions";
}

export function parseEventSubscriptionsUrl(url: string): { accountId: string } {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== DASHBOARD_ORIGIN) throw new Error();
    const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const accountId = assertCloudflareAccountId(segments[0] ?? "");
    if (segments.length === 4 && segments[1] === "workers" &&
        segments[2] === "queues" && segments[3] === "event-subscriptions") {
      return { accountId };
    }
  } catch {
    // Normalize all parse failures to the public resource error.
  }
  throw new Error(`Unsupported Cloudflare Event Subscriptions URL: ${url}`);
}

export function cloudflareScopesForResources(resourceUrlPatterns?: string[]): string[] {
  if (resourceUrlPatterns?.some(pattern => !RESOURCE_PATTERNS.has(pattern))) {
    throw new Error("Unsupported Cloudflare resource type.");
  }
  return resourceUrlPatterns === undefined || resourceUrlPatterns.includes(EVENT_SUBSCRIPTIONS_RESOURCE.urlPattern)
    ? [QUEUES_SCOPE]
    : [];
}

export function grantedCloudflareResourcePatterns(scopes: string[]): string[] {
  return scopes.includes(QUEUES_SCOPE) ? [EVENT_SUBSCRIPTIONS_RESOURCE.urlPattern] : [];
}
