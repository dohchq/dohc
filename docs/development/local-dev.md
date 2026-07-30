# Local development

## Requirements

- Node `24.14.0` through `.node-version` or `.nvmrc`.
- pnpm `10.24.0`.
- The Rust toolchain in `rust-toolchain.toml`.
- Docker only for the opt-in sync stack.

## Desktop

```bash
pnpm install
cargo build -p dohc-workspace-engine --bin dohc-workspace-engine
pnpm dev:desktop
```

The desktop app uses `target/debug/dohc-workspace-engine` during development.
It does not need a server or environment file.

## Sync stack

```bash
pnpm dev:postgres
pnpm migrate
pnpm dev:workspace-api
pnpm --filter @dohc/sync-relay dev
```

Copy `.env.self-host.example` when you need a complete local environment.
The workspace API and relay must use the same `BETTER_AUTH_SECRET`.

## Package layout

Workspace packages expose TypeScript source directly unless a package declares
a build output. Electron Vite compiles the desktop dependencies.
