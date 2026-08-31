import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // Transform @validateRpc() decorators in-memory: wrangler.jsonc's `main` points at the
    // capnweb-validate build output, which isn't generated during tests.
    capnwebValidate(),
    cloudflareTest({
      main: "./test/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          BASE_URL: "https://example.com/gatekeeper/marketo",
          MARKETO_ENDPOINT: "https://123-ABC-456.mktorest.com",
        },
        durableObjects: {
          UserAccount: "UserAccount",
          MarketoGatekeeperImpl: "MarketoGatekeeperImpl",
          MarketoTokenCache: "MarketoTokenCache",
        },
      },
    }),
  ],
  test: {
    include: ["test/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd. Lives in
    // beside the shared configurator tasks so every worker-pool suite uses the same assertion.
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
