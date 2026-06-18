import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

// Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
// production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module. We use
// a minimal inline Miniflare config rather than the full wrangler.jsonc, since these are unit
// tests of imported modules and don't need the worker's bindings (DOs, KV, R2, worker loaders).
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-02-02',
        compatibilityFlags: ['experimental', 'nodejs_compat'],
      },
    }),
  ],
  test: {
    include: ['__tests__/*.test.ts'],
  },
})
