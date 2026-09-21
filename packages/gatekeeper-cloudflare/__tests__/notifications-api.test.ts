import { afterEach, expect, it, vi } from "vitest";
import { provisionNotificationInstallation } from "../src/notifications-api.js";

const account = "a".repeat(32);
const webhookId = "b".repeat(32);
const url = "https://webhook.example/hooks/endpoint";

afterEach(() => vi.unstubAllGlobals());

function mock(results: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      calls.push({ url: input, init });
      const result = results.shift();
      if (result instanceof Response) return result;
      return Response.json({ success: true, result });
    }),
  );
  return calls;
}

it("creates a generic webhook destination", async () => {
  const calls = mock([[], { id: webhookId }]);
  await expect(provisionNotificationInstallation("token", account, url, "secret")).resolves.toEqual(
    { webhookId },
  );
  expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
    name: "Cloudflare OS",
    type: "generic",
    url,
    secret: "secret",
  });
  expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);
});

it("reconciles the exact URL and replaces its secret", async () => {
  const calls = mock([[{ id: webhookId, url }], { id: webhookId }]);
  await provisionNotificationInstallation("token", account, url, "new-secret", "Investigator");
  expect(calls.map((call) => call.init.method)).toEqual(["GET", "PUT"]);
  expect(JSON.parse(calls[1]!.init.body as string)).toMatchObject({
    name: "Investigator",
    url,
    secret: "new-secret",
  });
});

it("refuses ambiguous destinations", async () => {
  mock([
    [
      { id: webhookId, url },
      { id: "c".repeat(32), url },
    ],
  ]);
  await expect(provisionNotificationInstallation("token", account, url, "secret")).rejects.toThrow(
    "Multiple",
  );
});

it("never follows redirects with the account token", async () => {
  const calls = mock([
    new Response(null, { status: 302, headers: { Location: "https://evil.test" } }),
  ]);
  await expect(provisionNotificationInstallation("token", account, url, "secret")).rejects.toThrow(
    "302",
  );
  expect(calls[0]!.init.redirect).toBe("manual");
});
