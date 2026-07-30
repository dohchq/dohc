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

Start Postgres. After it is ready, run the migrations:

```bash
pnpm dev:postgres
pnpm migrate
```

Pre-cleanup data remains in the old `dohc_v2_postgres` named volume. Start the
previous Compose definition from Git history if you need to recover it.

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

The development services use the default Postgres URL.
`.env.self-host.example` is for the self-hosted Compose stack, not these
development commands.

## Package layout

Workspace packages expose TypeScript source directly unless a package declares
a build output. Electron Vite compiles the desktop dependencies.
