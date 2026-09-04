import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

const OBSERVABILITY_SCOPE = "workers-observability.read";
const QUEUES_SCOPE = "queues:write";
const DASHBOARD_ORIGIN = "https://dash.cloudflare.com";
const ACCOUNT_ID_PATTERN = /^[a-f\d]{32}$/i;

export const ACCOUNT_OBSERVABILITY_RESOURCE: SupportedResource = {
  urlPattern: `${DASHBOARD_ORIGIN}/:accountId/workers-and-pages/observability`,
  title: "Cloudflare account observability",
  description: "Query logs, metrics, invocations, and traces across an account's Workers.",
  grantable: true,
};

export const WORKER_OBSERVABILITY_RESOURCE: SupportedResource = {
  urlPattern:
    `${DASHBOARD_ORIGIN}/:accountId/workers/services/view/:workerName/production/observability`,
  title: "Cloudflare Worker observability",
  description: "Query logs, metrics, invocations, and traces for one Worker.",
  grantable: true,
};

export const REAL_TIME_ISSUES_RESOURCE: SupportedResource = {
  urlPattern: `${DASHBOARD_ORIGIN}/:accountId/workers-and-pages/observability/issues/automation`,
  title: "Cloudflare Real-Time Issues automation",
  description: "Receive Real-Time Issues through a managed Queue and Event Subscription.",
  grantable: true,
};

export const OBSERVABILITY_RESOURCES = [
  ACCOUNT_OBSERVABILITY_RESOURCE,
  WORKER_OBSERVABILITY_RESOURCE,
];

export const CLOUDFLARE_RESOURCES = [...OBSERVABILITY_RESOURCES, REAL_TIME_ISSUES_RESOURCE];

const OBSERVABILITY_RESOURCE_PATTERNS = new Set(
  OBSERVABILITY_RESOURCES.map(resource => resource.urlPattern),
);
const RESOURCE_PATTERNS = new Set(CLOUDFLARE_RESOURCES.map(resource => resource.urlPattern));

/** Validate and normalize a Cloudflare account ID at an external input boundary. */
export function assertCloudflareAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("Invalid Cloudflare account ID.");
  return accountId.toLowerCase();
}

export function accountObservabilityUrl(accountId: string): string {
  return `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(accountId)}/workers-and-pages/observability`;
}

export function workerObservabilityUrl(accountId: string, workerName: string): string {
  return `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(accountId)}/workers/services/view/` +
    `${encodeURIComponent(workerName)}/production/observability`;
}

export function realTimeIssuesAutomationUrl(accountId: string): string {
  return `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(accountId)}` +
    "/workers-and-pages/observability/issues/automation";
}

export function parseObservabilityResourceUrl(url: string): {
  accountId: string;
  workerName?: string;
} {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== DASHBOARD_ORIGIN) throw new Error();
    const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const accountId = assertCloudflareAccountId(segments[0] ?? "");
    if (segments.length === 3 && segments[1] === "workers-and-pages" &&
        segments[2] === "observability") {
      return { accountId };
    }
    if (segments.length === 7 && segments[1] === "workers" && segments[2] === "services" &&
        segments[3] === "view" && segments[4] && segments[5] === "production" &&
        segments[6] === "observability") {
      return { accountId, workerName: segments[4] };
    }
  } catch {
    // Normalize URL, percent-decoding, and account-ID failures to the public resource error.
  }
  throw new Error(`Unsupported Cloudflare observability URL: ${url}`);
}

export function parseRealTimeIssuesAutomationUrl(url: string): { accountId: string } {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== DASHBOARD_ORIGIN) throw new Error();
    const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const accountId = assertCloudflareAccountId(segments[0] ?? "");
    if (segments.length === 5 && segments[1] === "workers-and-pages" &&
        segments[2] === "observability" && segments[3] === "issues" &&
        segments[4] === "automation") {
      return { accountId };
    }
  } catch {
    // Normalize all parse failures to the public resource error.
  }
  throw new Error(`Unsupported Cloudflare Real-Time Issues automation URL: ${url}`);
}

export function observabilityScopesForResources(resourceUrlPatterns?: string[]): string[] {
  if (resourceUrlPatterns?.some(pattern => !OBSERVABILITY_RESOURCE_PATTERNS.has(pattern))) {
    throw new Error("Unsupported Cloudflare resource type.");
  }
  return resourceUrlPatterns === undefined || resourceUrlPatterns.length > 0
    ? [OBSERVABILITY_SCOPE]
    : [];
}

/** OAuth scopes needed for exactly the Cloudflare resource types being connected. */
export function cloudflareScopesForResources(resourceUrlPatterns?: string[]): string[] {
  if (resourceUrlPatterns?.some(pattern => !RESOURCE_PATTERNS.has(pattern))) {
    throw new Error("Unsupported Cloudflare resource type.");
  }
  const selected = resourceUrlPatterns ?? [...RESOURCE_PATTERNS];
  const scopes: string[] = [];
  if (selected.some(pattern => OBSERVABILITY_RESOURCE_PATTERNS.has(pattern))) {
    scopes.push(OBSERVABILITY_SCOPE);
  }
  if (selected.includes(REAL_TIME_ISSUES_RESOURCE.urlPattern)) scopes.push(QUEUES_SCOPE);
  return scopes;
}

export function grantedCloudflareResourcePatterns(scopes: string[]): string[] {
  const patterns = grantedObservabilityResourcePatterns(scopes);
  if (scopes.includes(QUEUES_SCOPE)) patterns.push(REAL_TIME_ISSUES_RESOURCE.urlPattern);
  return patterns;
}

export function grantedObservabilityResourcePatterns(scopes: string[]): string[] {
  return scopes.includes(OBSERVABILITY_SCOPE)
    ? OBSERVABILITY_RESOURCES.map(resource => resource.urlPattern)
    : [];
}
