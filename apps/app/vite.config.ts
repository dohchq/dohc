import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Plugin order matters: tanstackStart() MUST come before viteReact().
const nitroPreset =
  process.env.NITRO_PRESET ?? (process.env.VERCEL ? 'vercel' : undefined)

export default defineConfig({
  server: {
    port: 3000,
    allowedHosts: ['localhost'],
  },
  // Internal workspace packages ship raw TS/TSX source (no build step),
  // so they must be transpiled rather than externalized for SSR.
  ssr: {
    noExternal: ['@dohc/brand'],
  },
  resolve: {
    tsconfigPaths: true,
  },
  optimizeDeps: {
    include: [
      '@tanstack/router-core',
      '@tanstack/router-core/ssr/client',
      'seroval',
      '@tanstack/react-router',
      'convex/browser',
      'convex/react',
      'convex/server',
      'convex/values',
      '@workos/authkit-session',
    ],
    exclude: ['@workos/authkit-tanstack-react-start'],
  },
  plugins: [
    tanstackStart(),
    nitro(nitroPreset ? { preset: nitroPreset } : {}),
    viteReact(),
    tailwindcss(),
  ],
})
