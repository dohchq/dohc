# dohc

dohc is a local-first file sync and collaboration workspace for humans and agents. It syncs your files and data across your devices and facilitates sharing and collaboration between you, your team and your agents.

## Repository layout

```text
apps/desktop          Electron desktop app
apps/site             marketing site and interactive product demo
crates                Rust workspace engine and supporting crates
packages              shared TypeScript contracts, clients, tools, and UI code
services              opt-in auth, sync relay, and local SQLite tooling
docs                  current product, architecture, security, and development docs
tools                  repository gates and Rust engine evidence tools
```

## Local development

Install the JavaScript dependencies and start the desktop app:

```bash
pnpm install
pnpm dev:desktop
```

The dev command builds the current Rust workspace engine before Electron starts.
The desktop app does not need a server or environment file.

## Opt-in sync services

Multi-device sync, sharing, presence, and co-editing use two services:

- `services/workspace-api` provides Better Auth.
- `services/sync-relay` carries engine operations, blobs, shares, and presence.

Postgres stores Better Auth data. The relay stores its own data in SQLite.

Start Postgres. After it is ready, run the migrations:

```bash
pnpm dev:postgres
pnpm migrate
```

In both service terminals, set `NODE_ENV=development` and the same
`BETTER_AUTH_SECRET` of at least 32 characters. Then start the workspace API in
one terminal:

```bash
pnpm dev:workspace-api
```

Start the sync relay in another terminal:

```bash
pnpm --filter @dohc/sync-relay dev
```



## Checks

```bash
pnpm typecheck
pnpm test
pnpm check:debt
node tools/rust-engine-program/run-rust-checks.mjs
```

The Rust gate prints its own verdict. Read the `== summary ==` block instead
of relying on the process exit code.

## Documentation

Start with [AGENTS.md](AGENTS.md). The code is the reference for how anything behaves.

## Stack

Electron, React, Vite, Tailwind CSS, Tiptap, Yjs, Rust, SQLite, Better Auth,
Postgres, Vitest, and Playwright.
