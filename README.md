# dohc

The quiet AI workspace for documents and real work. Spoken "dock"; always
written lowercase.

dohc brings git-grade building-collaboration — change sets, history,
attribution, AI-assisted merge — to everyday people. Your work is real files
in a real folder you own; dohc makes what changed, who changed it, and what
is ready visible and safe to build on together.

## The shape of the product

- **dohc Desktop** (`apps/desktop`, Electron) is the primary client and is
  **local-first**: a workspace is a folder on your disk, watched into
  change-set history, fully usable with **no account**. Cloud is additive,
  never required. See
  [`docs/architecture/desktop-local-first.md`](docs/architecture/desktop-local-first.md).
- **dohc Cloud** is the managed sync/hosting/collaboration server: device-flow
  login, merge-based workspace sync, live co-editing, sharing. It is the paid
  engine for shared building. See
  [`docs/architecture/dohc-cloud.md`](docs/architecture/dohc-cloud.md) and
  [`docs/architecture/workspace-sync.md`](docs/architecture/workspace-sync.md).
- **Self-hosted dohc** runs the same server stack from
  `docker-compose.self-host.yml`. See
  [`docs/self-hosting.md`](docs/self-hosting.md). Federation is deferred.
- **Local agents**: your AI tool (Claude Code, Codex, …) connects to a
  workspace through the stdio MCP server (`packages/mcp`); agent writes show
  up attributed in history.

## Layout

```text
apps/desktop          Electron desktop app (the primary client)
apps/app              web app (sharing/cloud surface; mid-migration off Convex)
packages              workspace-core/-fs/-sync/-history/-postgres, mcp, brand, config
services              workspace-api (auth + sync), hocuspocus, sqlite-worker, app-tester
docs                  product, architecture, brand, development, qa, security
```

## Quick start (desktop)

```bash
pnpm install
pnpm dev:desktop          # the desktop app, local-only — no server needed
```

With the cloud stack, to exercise sync/collab locally:

```bash
pnpm dev:cloud            # docker postgres + minio, then workspace-api (:1786)
pnpm check:cloud-ready    # verifies the stack is up
DOHC_CLOUD_URL=http://localhost:1786 pnpm dev:desktop
```

## Commands

```bash
pnpm typecheck                 # tsc --noEmit across workspaces
pnpm test                      # vitest across workspaces
pnpm test:desktop:e2e          # Playwright Electron suite
pnpm smoke:desktop             # desktop smoke test
pnpm dev:postgres              # just the docker postgres + minio
pnpm reset:postgres            # reset local Postgres dev data
pnpm check:self-host           # validate the self-host compose/service matrix
node scripts/check-self-host-desktop-path.mjs  # desktop -> self-host connectivity proof
```

## Docs

- Architecture:
  [`desktop-local-first.md`](docs/architecture/desktop-local-first.md),
  [`dohc-cloud.md`](docs/architecture/dohc-cloud.md),
  [`workspace-sync.md`](docs/architecture/workspace-sync.md)
- Product: [`docs/product/manifesto.md`](docs/product/manifesto.md),
  [`docs/product/spec.md`](docs/product/spec.md)
- Self-hosting: [`docs/self-hosting.md`](docs/self-hosting.md)
- Development: [`docs/development/local-dev.md`](docs/development/local-dev.md),
  [`docs/development/testing.md`](docs/development/testing.md)
- Security: [`docs/security/authz-boundaries.md`](docs/security/authz-boundaries.md)

## Stack

Electron + React 19 + Vite on the desktop; Node services (workspace-api with
Better Auth, Hocuspocus/Yjs) on one Postgres; Tiptap, Vitest, Playwright.
The web app's remaining Convex code is being deleted (in flight); do not
build new work on it.

## Deployment

dohc Cloud targets `dohc.ai`. Self-hosters: `docs/self-hosting.md` is the
runbook.
