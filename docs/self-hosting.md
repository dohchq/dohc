# Self-Hosting

Self-hosting runs the opt-in, reduced Postgres cloud stack: **live
collaboration** (Hocuspocus + the workspace-api collab-token route) and the
**sync relay**, both authenticated by Better Auth over Postgres. The desktop
product itself is local-first and needs none of this. The former sharing/
members/invites/files/sync web surface and the `apps/web` client have been
retired; engine-native sync (Arc 0P) is the ongoing replacement. This is still
an MVP mode, not the final production runbook.

Service matrix (see `docker-compose.self-host.yml`): `postgres`,
`object-storage` (MinIO), `hocuspocus`, `workspace-api` (collab + auth),
`sync-relay`, `sqlite-worker`, `agent-sandbox`. There is no `web` service.

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

- `POSTGRES_*` for the SQL core (Better Auth's user table + collab membership).
- `MINIO_*` for S3-compatible object storage.
- `HOCUSPOCUS_*` for collaborative document sync. `HOCUSPOCUS_JWT_SECRET` is
  shared with `workspace-api` so its collab-token route mints tokens hocuspocus
  can verify.
- `BETTER_AUTH_SECRET` — shared by `workspace-api` AND `sync-relay` so a bearer
  token minted by the workspace-api device flow validates at the relay
  (>=32 chars; `openssl rand -base64 32`).
- `WORKSPACE_API_*` for the collab + auth service.
- `SYNC_RELAY_PORT` for the sync relay.
- `SQLITE_WORKER_*` for SQLite import/query/materialization.

Replace every `change-me` value before starting the stack. Compose refuses to
start without explicit Postgres and object-storage passwords.

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
4. run `pnpm check:self-host` to validate the compose/service matrix.
5. smoke-test the surviving surface: Better Auth sign-in, a collab token, and a
   sync-relay round-trip.
6. re-enable writes.

## Security Notes

- Browser callers are not trusted for identity.
- Every file, folder, atom, app, asset, database, and capture is workspace
  scoped.
- HTML atoms are sandboxed and sanitized.
- App writes require manifest scope and per-user trust.
- Shell writes are captured as diffs and applied through dohc policy.
- Keep service tokens private and rotate them if they are exposed.
