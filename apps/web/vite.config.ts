import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import tailwindcss from '@tailwindcss/vite'

// Plugin order matters: tanstackStart() before viteReact(), and
// viteReact() before nitro(), so Start can own routing while React transforms
// are available before Nitro's SSR build.
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
    noExternal: ['@dohc/brand', '@dohc/workspace-core'],
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
    ],
  },
  plugins: [
    tanstackStart(),
    viteReact(),
    nitro(nitroPreset ? { preset: nitroPreset } : {}),
    tailwindcss(),
  ],
})
