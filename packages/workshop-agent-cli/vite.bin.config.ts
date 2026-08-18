import { chmodSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [{
    name: "executable-bin",
    closeBundle() {
      chmodSync("dist/workshop-agent.js", 0o755);
    },
  }],
  build: {
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    ssr: "src/bin.ts",
    rollupOptions: {
      external: [/^node:/, "wrangler"],
      output: {
        entryFileNames: "workshop-agent.js",
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
