# Local development

## Prerequisites

- Node `24.14.0` recommended via `.node-version` / `.nvmrc` and pnpm
  `10.24.0` (`packageManager` is pinned in the root `package.json`).
  The sanitizer stack depends on packages that require Node `^20.19.0`,
  `^22.13.0`, or `>=24.0.0`; Node 18 is not supported.
- A Convex deployment and a WorkOS AuthKit app (for auth).

## Setup

```bash
cd /home/ice/dev/dohc
pnpm install
cp apps/app/.env.example apps/app/.env.local   # then fill in real values
```

## Environment variables

Set these in `apps/app/.env.local` (gitignored):

| Variable                  | Purpose                                  |
| ------------------------- | ---------------------------------------- |
| `CONVEX_DEPLOYMENT`       | Convex deployment used by `convex dev`   |
| `VITE_CONVEX_URL`         | Convex client URL                        |
| `VITE_CONVEX_SITE_URL`    | Convex site URL                          |
| `VITE_HOCUSPOCUS_URL`     | Hocuspocus WebSocket URL, usually `ws://127.0.0.1:1234` |
| `WORKOS_CLIENT_ID`        | WorkOS AuthKit client id                 |
| `WORKOS_API_KEY`          | WorkOS API key                           |
| `WORKOS_REDIRECT_URI`     | e.g. `http://localhost:3000/api/auth/callback` |
| `WORKOS_COOKIE_PASSWORD`  | 32+ char random string                   |
| `ANTHROPIC_API_KEY`       | Only for the agent / live eval           |
| `VITE_DOHC_INLINE_ATOMS`  | Optional feature flag                    |

## Running

```bash
docker compose -f docker-compose.dev.yml up -d postgres hocuspocus
pnpm dev        # vite (port 3000) + convex dev, from the root
```

The app runs at http://localhost:3000.

The v2 editor also needs matching Hocuspocus secrets in Convex env. For local
dev using the compose defaults:

```bash
pnpm --filter @dohc/app exec convex env set HOCUSPOCUS_JWT_SECRET 'dev-jwt-secret-change-me-with-at-least-32-bytes'
pnpm --filter @dohc/app exec convex env set HOCUSPOCUS_ADMIN_URL 'http://127.0.0.1:1234'
pnpm --filter @dohc/app exec convex env set HOCUSPOCUS_ADMIN_TOKEN 'dev-admin-token-change-me'
```

To test Convex-backed bootstrap instead of the dev allow-all ACL, also set the
same `HOCUSPOCUS_CONVEX_SERVER_TOKEN` for Convex and the Hocuspocus process, and
set `HOCUSPOCUS_CONVEX_URL` for Hocuspocus.

## Monorepo layout

```text
apps/app              TanStack Start + Convex product app
packages/brand        dohc mark, lockups, tokens, brand constants
packages/plugin-sdk   window.dohc types + postMessage protocol
packages/config       shared TypeScript config
docs                  product, brand, development, qa, security
```

Internal workspace packages ship raw TS source; the app transpiles them
via `ssr.noExternal` in `apps/app/vite.config.ts`.
