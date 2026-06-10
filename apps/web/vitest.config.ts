import { defineConfig } from 'vitest/config'

// Standalone unit-test config. Deliberately does NOT load the app's
// vite.config (TanStack Start / Nitro plugin is incompatible with
// vitest's config-resolution hook).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
  },
})
