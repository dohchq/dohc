# dohc

The quiet AI workspace for documents and real work — where work becomes
clear, traceable, and ready. Spoken "dock"; always written lowercase.

## Layout

```text
apps/app              TanStack Start + Convex product app
packages/brand        dohc mark, lockups, CSS tokens, brand constants
packages/config       shared TypeScript config
services              Hocuspocus, workspace API, SQLite worker, app tester
docs                  product, brand, development, qa, security
```

## Quick start

```bash
pnpm install
cp apps/app/.env.example apps/app/.env.local   # fill in real values
pnpm dev        # local Postgres + Hocuspocus sync, vite (:3000), Convex dev
```

## Backend modes

Convex remains the default backend during the migration. Postgres is the
self-host/cloud candidate backend:

```bash
DOHC_BACKEND=postgres VITE_DOHC_BACKEND=postgres pnpm dev:app
pnpm check:self-host
```

See [`docs/architecture/backend-modes.md`](docs/architecture/backend-modes.md)
and [`docs/self-hosting.md`](docs/self-hosting.md).

## Reset dev data

pnpm reset:dev --confirm WIPE_DEV_DATA --email you@example.com --delete-workos-orgs

## Commands

```bash
pnpm typecheck   # tsc --noEmit across workspaces
pnpm test        # vitest (incl. the brand no-legacy guard)
pnpm build       # vite build (TanStack Start + Nitro)
pnpm dev:sync    # start only local Postgres + Hocuspocus
pnpm dev:app     # start only Vite + Convex dev
pnpm check:self-host # validate the self-host compose/service matrix
```

## Docs

- Product: [`docs/product/manifesto.md`](docs/product/manifesto.md),
  [`docs/product/spec.md`](docs/product/spec.md),
  [`docs/product/ai-native-positioning.md`](docs/product/ai-native-positioning.md)
- Brand: [`docs/brand/design-system.md`](docs/brand/design-system.md)
- Development: [`docs/development/local-dev.md`](docs/development/local-dev.md),
  [`testing.md`](docs/development/testing.md)
- QA: [`docs/qa/playwright-checklist.md`](docs/qa/playwright-checklist.md)
- Security: [`docs/security/authz-boundaries.md`](docs/security/authz-boundaries.md)
- Architecture: [`docs/architecture/backend-modes.md`](docs/architecture/backend-modes.md),
  [`docs/architecture/local-files-and-cloud-sandbox.md`](docs/architecture/local-files-and-cloud-sandbox.md)

## Stack

TanStack Start + Router, React 19, Vite, Tailwind CSS v4, Convex, WorkOS
AuthKit, Tiptap, Yjs, Hocuspocus, Vitest, Nitro.

## Deployment

The app targets `dohc.ai` (app at `app.dohc.ai`). Configure Convex and
WorkOS AuthKit redirect URLs for the target host; keep `localhost`
redirects for local dev. See `docs/development/local-dev.md` for the env
contract.
