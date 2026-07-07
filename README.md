# dohc

The quiet AI workspace for documents and real work — where work becomes
clear, traceable, and ready. Spoken "dock"; always written lowercase.

## Layout

```text
apps/desktop          Electron desktop app (the product; local-first)
packages              workspace engine, contracts, core/fs/history/sync,
                      workspace-auth, workspace-postgres (schema migrations),
                      ydoc-projection, MCP server, SDK, brand, performance
services              workspace API (auth), sync relay (engine-native
                      co-editing), SQLite worker, agent sandbox
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

The engine is the default: the desktop app needs no backend. The opt-in cloud
stack is now a reduced surface — the **sync relay** (engine-native co-editing +
blob transport) and an **auth** server, both authenticated by Better Auth over
Postgres (Postgres survives for the auth user/session tables). Co-editing is
engine-native over the relay — Hocuspocus was retired at a clean cutover
(G2-C-3). The former sharing/members/invites/files/sync web surface has been
retired. See
[`docs/architecture/backend-modes.md`](docs/architecture/backend-modes.md) and
[`docs/self-hosting.md`](docs/self-hosting.md).

```bash
pnpm dev:postgres        # local Postgres + MinIO
pnpm dev:workspace-api   # workspace API (auth)
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
Rust (workspace kernel), Yjs (engine-native co-editing), Better Auth on
Postgres (cloud auth), Vitest, Playwright.
