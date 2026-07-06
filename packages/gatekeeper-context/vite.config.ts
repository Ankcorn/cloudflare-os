import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { viteSingleFile } from 'vite-plugin-singlefile'

const pkgDir = dirname(fileURLToPath(import.meta.url))

// `--watch` drives the `pnpm dev-server` hot loop (via build-app.mjs); one-shot build otherwise.
const isWatch = process.argv.includes('--watch')

// Write the inlined build to src/generated/app.txt for the Worker to import. Skip identical
// rewrites, which would otherwise loop wrangler's watcher.
function emitAppText(): Plugin {
  return {
    name: 'emit-app-text',
    closeBundle() {
      const html = readFileSync(resolve(pkgDir, 'dist-app', 'app', 'index.html'), 'utf8')
      const outFile = resolve(pkgDir, 'src', 'generated', 'app.txt')
      const contents =
        `<!-- Generated from packages/gatekeeper-context/app by build-app.mjs. Do not edit. -->\n` + html
      if (existsSync(outFile) && readFileSync(outFile, 'utf8') === contents) {
        console.log(`app.txt unchanged (${(html.length / 1024).toFixed(0)} KiB), skipping write`)
        return
      }
      mkdirSync(dirname(outFile), { recursive: true })
      writeFileSync(outFile, contents)
      console.log(`wrote ${outFile} (${(html.length / 1024).toFixed(0)} KiB)`)
    },
  }
}

// Build the library iframe as one inlined HTML file. No router; selection is component state.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    tsconfigPaths(),
    viteSingleFile(),
    emitAppText(),
  ],
  build: {
    outDir: 'dist-app',
    emptyOutDir: true,
    // Terser costs ~3s/build; skip it in the dev hot loop where only latency matters.
    minify: isWatch ? false : 'terser',
    terserOptions: {
      compress: {
        passes: 2,
      },
      format: {
        comments: false,
      },
    },
    // Network-isolated iframe: no separate asset files.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'app/index.html',
    },
    // Exclude our own outputs, else emitting them retriggers the watcher.
    watch: isWatch
      ? {
          exclude: [
            '**/node_modules/**',
            '**/dist-app/**',
            '**/.wrangler/**',
            '**/generated/**',
          ],
        }
      : undefined,
  },
})
