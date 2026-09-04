import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    main: "./__tests__/worker.ts",
    miniflare: {
      compatibilityDate: "2026-02-02",
      compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
      durableObjects: {
        USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
        EVENT_SUBSCRIPTIONS_GATEKEEPER: {
          className: "CloudflareEventSubscriptionsGatekeeper", useSQLite: true,
        },
        EVENT_SUBSCRIPTION_POLLER: {
          className: "CloudflareEventSubscriptionPoller", useSQLite: true,
        },
        TEST_HOOKS: { className: "TestHooks", useSQLite: true },
      },
    },
  })],
  test: { include: ["__tests__/workerd/*.test.ts"], setupFiles: ["@gadgets/scripts/assert-workerd"] },
});
