import { defineConfig } from 'vitest/config'

// Standalone unit-test config. Deliberately does NOT load the app's
// vite.config (TanStack Start / Nitro plugin is incompatible with
// vitest's config-resolution hook).
//
// Two test surfaces:
//  - src/**      — pure-logic units (parser, scorer, resolveWindow…)
//                  run in `node`.
//  - convex/**   — Convex functions tested with `convex-test`, which
//                  REQUIRES the `edge-runtime` environment (Convex
//                  guidelines). This is the SAFE backend test path:
//                  mocked identity, no auth hole, no live deployment.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'convex/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'convex/_generated/**'],
    environment: 'node',
    environmentMatchGlobs: [['convex/**', 'edge-runtime']],
    server: { deps: { inline: ['convex-test'] } },
  },
})
