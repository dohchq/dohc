# Local development

## Prerequisites

- Node 22+ and pnpm 10+ (`packageManager` is pinned in the root
  `package.json`).
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
| `WORKOS_CLIENT_ID`        | WorkOS AuthKit client id                 |
| `WORKOS_API_KEY`          | WorkOS API key                           |
| `WORKOS_REDIRECT_URI`     | e.g. `http://localhost:3000/api/auth/callback` |
| `WORKOS_COOKIE_PASSWORD`  | 32+ char random string                   |
| `ANTHROPIC_API_KEY`       | Only for the agent / live eval           |
| `VITE_DOHC_INLINE_ATOMS`  | Optional feature flag                    |

## Running

```bash
pnpm dev        # vite (port 3000) + convex dev, from the root
```

The app runs at http://localhost:3000.

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
