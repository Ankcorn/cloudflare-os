import { defineConfig } from 'vite-plus'
import { vitestTask } from '../../scripts/vitest-task-vite-config.js'

export default defineConfig({
  run: {
    tasks: {
      test: vitestTask('vitest run'),
      'build:bin': {
        command: 'vite build --config vite.bin.config.ts --logLevel error',
        input: [
          { auto: true },
          { pattern: '!dist/**', base: 'package' },
        ],
        output: ['dist/**'],
      },
    },
  },
})
