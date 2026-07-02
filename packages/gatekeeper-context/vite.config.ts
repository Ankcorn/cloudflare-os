import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Build the library iframe as one inlined HTML file. No router; selection is component state.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    tsconfigPaths(),
    viteSingleFile(),
  ],
  build: {
    outDir: 'dist-app',
    emptyOutDir: true,
    // Network-isolated iframe: no separate asset files.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'app/index.html',
    },
  },
})
