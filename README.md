# dohc

The quiet AI workspace for documents and real work — where work becomes
clear, traceable, and ready. Spoken "dock"; always written lowercase.

## Layout

```text
apps/desktop          Electron desktop app (the product; local-first)
apps/web              web client for the opt-in cloud stack
packages              workspace engine, contracts, core/fs/history/sync,
                      MCP server, SDK, brand, performance
services              Hocuspocus, workspace API, SQLite worker, agent sandbox
crates                Rust workspace kernel (supervised sidecar)
docs                  product, brand, development, qa, security
```

## Quick start

```bash
pnpm install
pnpm dev:desktop     # run the desktop app
```

The desktop app is local-first: workspaces are folders on disk, and the
workspace engine (per-workspace SQLite under `.dohc/engine/`) records
history, versions, chats, and search with no backend.

## Cloud stack (opt-in)

The Postgres-backed cloud stack serves opt-in sync/shares and is retiring in
favor of engine-native sync (see
[`docs/architecture/backend-modes.md`](docs/architecture/backend-modes.md)
and [`docs/self-hosting.md`](docs/self-hosting.md)):

```bash
pnpm dev:postgres        # local Postgres + MinIO
pnpm dev:workspace-api   # workspace API
pnpm check:self-host     # validate the self-host compose/service matrix
pnpm reset:postgres      # reset local Postgres dev data
```

## Commands

```bash
pnpm typecheck          # tsc --noEmit across workspaces
pnpm test               # vitest across workspaces
pnpm build              # build all packages/apps
pnpm test:desktop:e2e   # desktop Playwright suite (builds first)
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

Electron, React 19, Vite, Tailwind CSS v4, Tiptap, SQLite (`node:sqlite`),
Rust (workspace kernel), Yjs + Hocuspocus (cloud collab), WorkOS AuthKit
(cloud auth), Vitest, Playwright.
