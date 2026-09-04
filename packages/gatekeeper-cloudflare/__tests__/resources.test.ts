import { describe, expect, it } from "vitest";
import {
  ACCOUNT_OBSERVABILITY_RESOURCE,
  WORKER_OBSERVABILITY_RESOURCE,
  REAL_TIME_ISSUES_RESOURCE,
  accountObservabilityUrl,
  cloudflareScopesForResources,
  grantedCloudflareResourcePatterns,
  grantedObservabilityResourcePatterns,
  observabilityScopesForResources,
  parseObservabilityResourceUrl,
  parseRealTimeIssuesAutomationUrl,
  realTimeIssuesAutomationUrl,
  workerObservabilityUrl,
} from "../src/resources";
import { BILLING_SCOPES, persistentScopesForResources } from "../src/oauth";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

describe("Cloudflare observability resources", () => {
  it("round-trips account observability URLs", () => {
    const url = accountObservabilityUrl(ACCOUNT_ID);

    expect(url).toBe(`https://dash.cloudflare.com/${ACCOUNT_ID}/workers-and-pages/observability`);
    expect(parseObservabilityResourceUrl(url)).toEqual({ accountId: ACCOUNT_ID });
  });

  it("round-trips Worker observability URLs", () => {
    const url = workerObservabilityUrl(ACCOUNT_ID, "api/production");

    expect(url).toBe(
      `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/services/view/api%2Fproduction/production/observability`,
    );
    expect(parseObservabilityResourceUrl(url)).toEqual({
      accountId: ACCOUNT_ID,
      workerName: "api/production",
    });
  });

  it("round-trips Real-Time Issues automation URLs", () => {
    const url = realTimeIssuesAutomationUrl(ACCOUNT_ID);

    expect(url).toBe(
      `https://dash.cloudflare.com/${ACCOUNT_ID}/workers-and-pages/observability/issues/automation`,
    );
    expect(parseRealTimeIssuesAutomationUrl(url)).toEqual({ accountId: ACCOUNT_ID });
  });

  it("accepts harmless dashboard state and a trailing slash", () => {
    expect(parseObservabilityResourceUrl(
      `${accountObservabilityUrl(ACCOUNT_ID)}/?time-window=1h#logs`,
    )).toEqual({ accountId: ACCOUNT_ID });
  });

  it("rejects lookalike dashboard URLs", () => {
    expect(() => parseObservabilityResourceUrl(
      "https://example.com/account-id/workers-and-pages/observability",
    )).toThrow("Unsupported Cloudflare observability URL");
    expect(() => parseObservabilityResourceUrl(
      "https://dash.cloudflare.com/account-id/workers/services/view/api/production/metrics",
    )).toThrow("Unsupported Cloudflare observability URL");
  });

  it("rejects malformed account IDs and URL encoding", () => {
    expect(() => accountObservabilityUrl("account-id")).toThrow("account ID");
    expect(() => parseObservabilityResourceUrl(
      "https://dash.cloudflare.com/%EA/workers-and-pages/observability",
    )).toThrow("Unsupported Cloudflare observability URL");
  });
});

describe("Cloudflare observability OAuth scopes", () => {
  it("keeps billing-only connections free of observability access", () => {
    expect(persistentScopesForResources([])).toEqual(BILLING_SCOPES);
    expect(persistentScopesForResources()).toContain("workers-observability.read");
  });

  it("does not request observability for an explicit empty resource list", () => {
    expect(observabilityScopesForResources([])).not.toContain("workers-observability.read");
  });

  it("requests observability for either binding granularity", () => {
    expect(observabilityScopesForResources([ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern]))
      .toContain("workers-observability.read");
    expect(observabilityScopesForResources([WORKER_OBSERVABILITY_RESOURCE.urlPattern]))
      .toContain("workers-observability.read");
  });

  it("treats an omitted resource list as all supported resources", () => {
    expect(observabilityScopesForResources()).toContain("workers-observability.read");
  });

  it("rejects unknown resource patterns", () => {
    expect(() => observabilityScopesForResources(["https://example.com/*"]))
      .toThrow("Unsupported Cloudflare resource type");
  });

  it("requests Queue authority only for the automation resource", () => {
    expect(cloudflareScopesForResources([ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern]))
      .toEqual(["workers-observability.read"]);
    expect(cloudflareScopesForResources([REAL_TIME_ISSUES_RESOURCE.urlPattern]))
      .toEqual(["queues:write"]);
    expect(cloudflareScopesForResources()).toEqual([
      "workers-observability.read",
      "queues:write",
    ]);
  });

  it("maps granted Queue authority back to only the automation resource", () => {
    expect(grantedCloudflareResourcePatterns(["queues:write"]))
      .toEqual([REAL_TIME_ISSUES_RESOURCE.urlPattern]);
  });

  it("maps the shared OAuth permission back to both resource types", () => {
    expect(grantedObservabilityResourcePatterns(["workers-observability.read"]))
      .toEqual([
        ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern,
        WORKER_OBSERVABILITY_RESOURCE.urlPattern,
      ]);
    expect(grantedObservabilityResourcePatterns([])).toEqual([]);
  });
});
