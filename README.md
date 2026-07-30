# dohc

The quiet AI workspace for documents and real work. Spoken “dock”; always
written lowercase.

dohc is a local-first desktop app. A workspace is an ordinary folder. The Rust
workspace engine records versions, moments, chats, search state, and sync data
in `.dohc/engine/engine.db`.

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

Install the JavaScript dependencies and build the development engine once:

```bash
pnpm install
cargo build -p dohc-workspace-engine --bin dohc-workspace-engine
pnpm dev:desktop
```

The desktop app does not need a server or environment file.

## Opt-in sync services

Multi-device sync, sharing, presence, and co-editing use two services:

- `services/workspace-api` provides Better Auth.
- `services/sync-relay` carries engine operations, blobs, shares, and presence.

Postgres stores Better Auth data. The relay stores its own data in SQLite.

```bash
pnpm dev:postgres
pnpm migrate
pnpm dev:workspace-api
pnpm --filter @dohc/sync-relay dev
```

See [backend modes](docs/architecture/backend-modes.md) and
[self-hosting](docs/self-hosting.md).

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

Start with [the docs index](docs/README.md). Product direction lives in
[the manifesto](docs/product/manifesto.md), and current behavior lives in
[the product spec](docs/product/spec.md).

## Stack

Electron, React, Vite, Tailwind CSS, Tiptap, Yjs, Rust, SQLite, Better Auth,
Postgres, Vitest, and Playwright.
