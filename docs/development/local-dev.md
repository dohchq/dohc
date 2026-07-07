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

## Cloud stack (opt-in, reduced surface)

Only needed for live-collaboration and sync-relay development (both opt-in;
the desktop default needs none of it):

```bash
docker compose -f docker-compose.dev.yml up -d postgres minio hocuspocus
pnpm dev:workspace-api               # collab + auth (Better Auth on /api/auth)
pnpm --filter @dohc/sync-relay dev   # sync relay
```

Environment variables for the stack live in `.env.self-host.example` and
`docker-compose.dev.yml` (Postgres, MinIO, `HOCUSPOCUS_*`, `BETTER_AUTH_SECRET`
for cloud auth shared by workspace-api and the relay, `SQLITE_WORKER_TOKEN`).
See [`docs/self-hosting.md`](../self-hosting.md).

## Monorepo layout

```text
apps/desktop          Electron desktop app (local-first product)
packages              workspace engine, contracts, core/fs/history/sync,
                      workspace-auth, workspace-postgres (collab membership),
                      MCP server, SDK, brand, performance
services              Hocuspocus (collab), workspace API (collab + auth),
                      sync relay, SQLite worker, agent sandbox
crates                Rust workspace kernel
```

Internal workspace packages ship raw TS source; consumers transpile them
(electron-vite for the desktop).
