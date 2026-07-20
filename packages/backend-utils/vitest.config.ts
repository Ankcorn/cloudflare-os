import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["nodejs_als"],
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
  },
});
