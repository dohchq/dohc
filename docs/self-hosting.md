# Self-Hosting

Self-hosting runs the opt-in, reduced Postgres cloud stack: the **sync relay**
(engine-native co-editing + blob transport) and an **auth** server, both
authenticated by Better Auth over Postgres. Co-editing is engine-native — a
shared workspace co-edits through the engine Y.Doc driver's `ydoc.update`
replication over the relay, so there is no separate collaboration server
(Hocuspocus was retired at a clean cutover, G2-C-3). The desktop product itself
is local-first and needs none of this. The former sharing/members/invites/
files/sync web surface and the `apps/web` client have been retired. This is
still an MVP mode, not the final production runbook.

Service matrix (see `docker-compose.self-host.yml`): `postgres`,
`workspace-api` (auth only), `sync-relay`, `sqlite-worker`, `agent-sandbox`.
There is no `web` and no `hocuspocus` service.

## Prerequisites

- Node matching `package.json` engines.
- pnpm 10.24.0.
- Docker with Docker Compose.
- Enough disk for Postgres, browser test artifacts, and agent sandbox
  projections.

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

- `POSTGRES_*` for the SQL core (Better Auth's `user`/`session` tables).
- `BETTER_AUTH_SECRET` — shared by `workspace-api` AND `sync-relay` so a bearer
  token minted by the workspace-api device flow validates at the relay
  (>=32 chars; `openssl rand -base64 32`).
- `WORKSPACE_API_*` for the auth service.
- `SYNC_RELAY_PORT` for the sync relay.
- `SQLITE_WORKER_*` for SQLite import/query/materialization.

Replace every `change-me` value before starting the stack. Compose refuses to
start without the explicit Postgres password and the required auth secret.

## First Boot

1. Copy `.env.self-host.example` to `.env.self-host`.
2. Replace secrets.
3. Run `pnpm check:self-host`.
4. Run `pnpm check:self-host -- --start`.

The compose stack bootstraps the database itself: a one-shot `postgres-migrate`
init container applies every Postgres migration — including
`0002_better_auth.sql`, the Better Auth `user`/`session`/`deviceCode` schema
that `workspace-api` and `sync-relay` query — before either auth service
starts. Both services `depend_on` the migration completing successfully, so a
fresh Postgres is never served against an absent schema. The container runs the
same idempotent `pnpm migrate` documented below, so re-running the stack is a
no-op once the schema is current.

## Migrations

`pnpm migrate` is the dedicated, idempotent Postgres schema command. It applies
every file under `packages/workspace-postgres/src/db/migrations` in order
(`0001_initial`, `0002_better_auth`, `0003_partial_path_unique`, …), tracking
applied ids in a `dohc_migrations` ledger, and is non-destructive — it never
truncates data:

```bash
POSTGRES_URL=postgres://user:pass@host:5432/dohc pnpm migrate
```

- Self-host compose runs it automatically via the `postgres-migrate` init
  container (above).
- For local development against `pnpm dev:postgres`, `pnpm migrate` applies the
  schema and `pnpm reset:postgres` applies the schema then truncates dev data.
  Do not run reset commands against production data.
- Production upgrades run `pnpm migrate` after backups and before re-enabling
  agent writes.

## Reset Dev Data

For local Postgres development:

```bash
pnpm reset:postgres
```

Do not use reset commands against production data.

## Backup And Restore

Back up:

- Postgres database volumes.
- the sync-relay's SQLite volume (engine-journal + blob storage).
- environment and secret material through the deployment secret manager.

Restore by bringing up a compatible dohc version, restoring Postgres first,
then running readiness checks before allowing agent writes.

## Upgrades

Upgrade order:

1. stop agent writes or put the workspace in review-only mode.
2. back up Postgres.
3. run migrations with `pnpm migrate` (idempotent; the compose
   `postgres-migrate` init container runs the same command on stack start).
4. run `pnpm check:self-host` to validate the compose/service matrix.
5. smoke-test the surviving surface: Better Auth sign-in and a sync-relay
   round-trip (engine-native co-editing rides the relay).
6. re-enable writes.

## Security Notes

- Browser callers are not trusted for identity.
- Every file, folder, atom, app, asset, database, and capture is workspace
  scoped.
- HTML atoms are sandboxed and sanitized.
- App writes require manifest scope and per-user trust.
- Shell writes are captured as diffs and applied through dohc policy.
- Keep service tokens private and rotate them if they are exposed.
