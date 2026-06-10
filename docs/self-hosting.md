# Self-Hosting

Self-hosting is the Postgres-backed path for running dohc outside the Convex
hosted baseline. This is still an MVP migration mode, not the final production
runbook.

## Prerequisites

- Node matching `package.json` engines.
- pnpm 10.24.0.
- Docker with Docker Compose.
- Enough disk for Postgres, object storage, browser test artifacts, and agent
  sandbox projections.

Verify the packaging preflight:

```bash
pnpm check:self-host
```

Start the compose stack explicitly:

```bash
cp .env.self-host.example .env.self-host
# edit secrets first
pnpm check:self-host -- --start
```

## Environment

Important variables live in `.env.self-host.example`:

- `DOHC_BACKEND=postgres`
- `POSTGRES_*` for the SQL core.
- `BETTER_AUTH_SECRET` — auth lives inside workspace-api (Better Auth on the
  same Postgres; no auth vendor). Generate with `openssl rand -base64 32`.
  The desktop signs in with the device flow: it shows a short code, you
  approve it in a browser against your server, and the session token stays
  encrypted on the device.
- `MINIO_*` for S3-compatible object storage.
- `HOCUSPOCUS_*` for collaborative document sync.
- `WORKSPACE_API_*` for the backend-neutral workspace API.
- `SQLITE_WORKER_*` for SQLite import/query/materialization.
- `APP_TESTER_*` for app validation.
- `WEB_PORT` and `VITE_DOHC_BACKEND` for the frontend.
- `VITE_CONVEX_URL` is intentionally blank for the Postgres self-host stack;
  set it only when intentionally running the web app against Convex.

Replace every `change-me` value before starting the stack. Compose refuses to
start without explicit Postgres and object-storage passwords or without
`BETTER_AUTH_SECRET`.

## First Boot

1. Copy `.env.self-host.example` to `.env.self-host`.
2. Replace secrets.
3. Run `pnpm check:self-host`.
4. Run `pnpm check:self-host -- --start`.
5. For local development only, apply Postgres migrations with
   `pnpm reset:postgres`. Production deployments must run the dedicated
   migration command from the release runbook, after backups and before
   re-enabling agent writes; do not run reset commands against production data.

## Reset Dev Data

For local Postgres development:

```bash
pnpm reset:postgres
```

For Convex development:

```bash
pnpm reset:dev --confirm WIPE_DEV_DATA --email you@example.com --delete-workos-orgs
```

Do not use reset commands against production data.

## Backup And Restore

Back up:

- Postgres database volumes.
- object storage buckets.
- Hocuspocus/Yjs persistence data if separated from Postgres.
- environment and secret material through the deployment secret manager.

Restore by bringing up a compatible dohc version, restoring Postgres first,
restoring object storage second, then running readiness checks before allowing
agent writes.

## Upgrades

Upgrade order:

1. stop agent writes or put the workspace in review-only mode.
2. back up Postgres and object storage.
3. run migrations.
4. run backend conformance tests.
5. run app tester and backend matrix checks.
6. re-enable writes.

## Security Notes

- Browser callers are not trusted for identity.
- Every file, folder, atom, app, asset, database, and capture is workspace
  scoped.
- HTML atoms are sandboxed and sanitized.
- App writes require manifest scope and per-user trust.
- Shell writes are captured as diffs and applied through dohc policy.
- Keep service tokens private and rotate them if they are exposed.
