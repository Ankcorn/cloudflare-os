import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The suite that has to run in workerd, because what it covers -- the session-side git-cache
 * wiring, where every commit id a read returns must be advertised -- is built on `RpcTarget` and
 * `RpcStub`. The sibling `vitest.config.ts` keeps the pure-logic tests in Node, where they are far
 * cheaper.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      miniflare: {
        // Kept in step with wrangler.jsonc; a drift here tests a runtime we do not deploy.
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        // wrangler.jsonc's Text-module rules, which github.ts's .txt/.svg imports rely on.
        modulesRules: [
          { type: "Text", include: ["**/*.txt", "**/*.svg"] },
        ],
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
