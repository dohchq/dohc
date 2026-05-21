# dohc

Monorepo for dohc.

## Layout

```text
apps/app              TanStack Start and Convex product app
packages/brand        Shared dohc brand assets and tokens
packages/plugin-sdk   Shared window.dohc SDK types and protocol constants
packages/config       Shared TypeScript and future tool config
docs                  Product, brand, development, QA, and security docs
```

## Commands

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
```

The app migration will populate `apps/app`.
