import { abortAllDurableObjects, env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import type { WebhookReceiver } from "../../src/webhook.js";
import type { TestGadget, TestWorkshop } from "../worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_GADGET: DurableObjectNamespace<TestGadget>;
    TEST_WORKSHOP: DurableObjectNamespace<TestWorkshop>;
    WEBHOOK_RECEIVER: DurableObjectNamespace<WebhookReceiver>;
  }
}

it("delivers through a restored Gadget callback before and after Durable Object restart", async () => {
  const endpointId = "00000000-0000-4000-8000-000000000099";
  let workshop = env.TEST_WORKSHOP.getByName("integration-workshop");
  const credential = await workshop.configure(endpointId);

  const send = (id: string) => SELF.fetch(credential.url, {
    method: "POST",
    headers: {
      [credential.headerName]: credential.headerValue,
      "Content-Type": "application/json",
      "Idempotency-Key": id,
    },
    body: JSON.stringify({ issue: { id }, symptom: "Worker error rate increased" }),
  });

  expect((await send("before-restart")).status).toBe(204);
  expect(await workshop.read()).toEqual({ startCount: 1, authorizationCount: 2 });
  let gadget = env.TEST_GADGET.getByName("integration-gadget");
  expect(await gadget.readDeliveries()).toMatchObject([
    { payload: { issue: { id: "before-restart" } } },
  ]);

  await abortAllDurableObjects();
  workshop = env.TEST_WORKSHOP.getByName("integration-workshop");
  gadget = env.TEST_GADGET.getByName("integration-gadget");
  // The pool's symbol-method bridge registers the reconstructed Gadget instance on first access.
  expect(await gadget.readDeliveries()).toHaveLength(1);

  expect((await send("after-restart")).status).toBe(204);
  expect(await workshop.read()).toEqual({ startCount: 2, authorizationCount: 3 });
  expect(await gadget.readDeliveries()).toMatchObject([
    { payload: { issue: { id: "before-restart" } } },
    { payload: { issue: { id: "after-restart" } } },
  ]);
});
