# Local development

## Prerequisites

- Node `24.14.0` recommended via `.node-version` / `.nvmrc` and pnpm
  `10.24.0` (`packageManager` is pinned in the root `package.json`).
  The sanitizer stack depends on packages that require Node `^20.19.0`,
  `^22.13.0`, or `>=24.0.0`; Node 18 is not supported.
- Docker only if you run the opt-in cloud stack (Postgres, MinIO,
  Hocuspocus).

## Desktop (the product)

```bash
pnpm install
pnpm dev:desktop
```

No backend, no env file: workspaces are folders on disk and the workspace
engine stores per-workspace state under `.dohc/engine/`. Useful loops:

```bash
pnpm --filter @dohc/desktop test   # desktop unit suite
pnpm test:desktop:e2e              # Playwright E2E (builds first)
pnpm typecheck                     # repo-wide tsc --noEmit
```

## Cloud stack (opt-in, retiring per audit Phase D)

Only needed for cloud sync/shares/collab development:

```bash
docker compose -f docker-compose.dev.yml up -d postgres minio hocuspocus
pnpm dev:workspace-api
pnpm dev            # apps/web dev server
```

Environment variables for the stack live in `.env.self-host.example` and
`docker-compose.dev.yml` (Postgres, MinIO, `HOCUSPOCUS_*`, WorkOS for cloud
auth, `SQLITE_WORKER_TOKEN`, `APP_TESTER_TOKEN`). See
[`docs/self-hosting.md`](../self-hosting.md).

## Monorepo layout

```text
apps/desktop          Electron desktop app (local-first product)
apps/web              web client for the opt-in cloud stack
packages              workspace engine, contracts, core/fs/history/sync,
                      MCP server, SDK, brand, performance
services              Hocuspocus, workspace API, SQLite worker, agent sandbox
crates                Rust workspace kernel
```

Internal workspace packages ship raw TS source; consumers transpile them
(electron-vite for the desktop, Vite `ssr.noExternal` for the web app).
