import { fileURLToPath } from "node:url";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [capnwebValidate()],
  test: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("../mcp-shared/__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
});
