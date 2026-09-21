import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WebhookReceiver } from "../../src/webhook.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    WEBHOOK_RECEIVER: DurableObjectNamespace<WebhookReceiver>;
  }
}

const endpointId = "00000000-0000-4000-8000-000000000001";
const receiverName = endpointId;
const accountId = "account-one";

async function issue(
  receiver: DurableObjectStub<WebhookReceiver>,
  headerName = "Authorization",
  valuePrefix = "Bearer ",
): Promise<string> {
  expect(await receiver.claim(accountId)).toBe(true);
  const headerValue = await receiver.issueCredential(accountId, headerName, valuePrefix);
  expect(headerValue).not.toBeNull();
  return headerValue!;
}

describe("WebhookReceiver credentials", () => {
  it("issues each endpoint credential only once", async () => {
    const receiver = env.WEBHOOK_RECEIVER.getByName(receiverName);
    const first = await issue(receiver);
    expect(await receiver.authenticate(first)).toBe(true);
    expect(await receiver.authenticate("0".repeat(64))).toBe(false);
    expect(await receiver.issueCredential(accountId, "Authorization", "Bearer ")).toBeNull();
  });

  it("serializes concurrent credential issuance", async () => {
    const receiver = env.WEBHOOK_RECEIVER.getByName(`${receiverName}:concurrent`);
    await receiver.claim(accountId);
    const results = await Promise.allSettled([
      Promise.resolve(receiver.issueCredential(accountId, "Authorization", "Bearer ")),
      Promise.resolve(receiver.issueCredential(accountId, "Authorization", "Bearer ")),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter(result => result.status === "fulfilled" && result.value !== null))
      .toHaveLength(1);
  });

  it("prevents another account from claiming a copied endpoint ID", async () => {
    const receiver = env.WEBHOOK_RECEIVER.getByName(
      "00000000-0000-4000-8000-000000000007",
    );
    expect(await receiver.claim(accountId)).toBe(true);
    expect(await receiver.claim(accountId)).toBe(true);
    expect(await receiver.claim("account-two")).toBe(false);
    expect(await receiver.issueCredential("account-two", "Authorization", "Bearer ")).toBeNull();
  });

  it("isolates credentials between named endpoints", async () => {
    const first = env.WEBHOOK_RECEIVER.getByName("00000000-0000-4000-8000-000000000002");
    const second = env.WEBHOOK_RECEIVER.getByName("00000000-0000-4000-8000-000000000003");
    const firstKey = await issue(first);
    const secondKey = await issue(second);

    expect(await first.authenticate(firstKey)).toBe(true);
    expect(await first.authenticate(secondKey)).toBe(false);
    expect(await second.authenticate(firstKey)).toBe(false);
    expect(await second.authenticate(secondKey)).toBe(true);
  });

  it("rejects a credential issued for another endpoint over HTTP", async () => {
    const firstId = "00000000-0000-4000-8000-000000000004";
    const secondId = "00000000-0000-4000-8000-000000000005";
    const first = env.WEBHOOK_RECEIVER.getByName(firstId);
    const firstKey = await issue(first);
    const response = await SELF.fetch(
      `http://localhost/gatekeeper/webhook/hooks/${secondId}`,
      {
        method: "POST",
        headers: {
          Authorization: firstKey,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(401);
  });

  it("accepts nested valid JSON without a second validation pass", async () => {
    const nestedEndpointId = "00000000-0000-4000-8000-000000000008";
    const receiver = env.WEBHOOK_RECEIVER.getByName(nestedEndpointId);
    const headerValue = await issue(receiver);
    const body = "[".repeat(100) + "null" + "]".repeat(100);
    const response = await SELF.fetch(
      `http://localhost/gatekeeper/webhook/hooks/${nestedEndpointId}`,
      {
        method: "POST",
        headers: {
          Authorization: headerValue,
          "Content-Type": "application/json",
        },
        body,
      },
    );
    expect(response.status).toBe(409);
  });

  it("accepts a raw secret in a provider-specific header", async () => {
    const providerEndpointId = "00000000-0000-4000-8000-000000000006";
    const receiver = env.WEBHOOK_RECEIVER.getByName(providerEndpointId);
    const headerValue = await issue(receiver, "cf-webhook-auth", "");
    const response = await SELF.fetch(
      `http://localhost/gatekeeper/webhook/hooks/${providerEndpointId}`,
      {
        method: "POST",
        headers: {
          "cf-webhook-auth": headerValue,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(409);
    const wrongHeader = await SELF.fetch(
      `http://localhost/gatekeeper/webhook/hooks/${providerEndpointId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${headerValue}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect(wrongHeader.status).toBe(401);
  });
});
