# Self-Hosting

Self-hosted dohc runs the same cloud/sync/collaboration server stack as dohc
Cloud, from `docker-compose.self-host.yml`. The desktop stays fully usable
with no server at all — self-hosting is for when you want sync, sharing, and
live co-editing on infrastructure you control.

Architecture background: `docs/architecture/dohc-cloud.md` and
`docs/architecture/workspace-sync.md`.

## What you get

| Service | Port (default) | Role |
| --- | --- | --- |
| `postgres` | 54329 | The one database: workspace data, auth, Yjs persistence. |
| `workspace-api` | 1786 | Better Auth (`/api/auth/*`), workspace + sync API, collab-token minting. The endpoint the desktop connects to. |
| `hocuspocus` | 1234 | Live co-editing (Yjs), Postgres-backed ACL and persistence. |
| `object-storage` (MinIO) | 9000/9001 | Provisioned for future S3-backed blobs; the current workspace-api stores blobs on a local volume (`DOHC_BLOB_DIR`). |
| `web` | 3000 | The web app (sharing/marketing surface; the desktop is the primary client). |
| `sqlite-worker` / `app-tester` / `agent-sandbox` | 1787 / 1788 / — | Supporting services for data import, app validation, and sandboxed agent runs. |

All ports bind `127.0.0.1` by default; put a reverse proxy with TLS in front
before exposing anything.

## Prerequisites

- Node matching `package.json` engines, pnpm 10.24.0.
- Docker with Docker Compose.
- The default host ports are the same as the dev stack's
  (`docker-compose.dev.yml`). On a machine that also runs it, stop the dev
  stack first or override `POSTGRES_PORT` / `OBJECT_STORAGE_PORT` /
  `HOCUSPOCUS_PORT` / `WORKSPACE_API_PORT` in `.env.self-host`.

## Environment

Copy `.env.self-host.example` to `.env.self-host` and replace every
`change-me`. Compose refuses to start without:

- `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`.
- `BETTER_AUTH_SECRET` — auth lives inside workspace-api (Better Auth on the
  same Postgres; no auth vendor). Generate with `openssl rand -base64 32`.
- `HOCUSPOCUS_JWT_SECRET` — set the SAME value for workspace-api and
  hocuspocus: workspace-api mints 5-minute collab JWTs that hocuspocus
  verifies. If only workspace-api lacks it, the collab-token route fails
  closed (`collab-disabled`) and sync still works.

Also set `HOCUSPOCUS_ADMIN_TOKEN` (admin/semantic API of the collab server)
and the worker tokens (`SQLITE_WORKER_TOKEN`, `APP_TESTER_TOKEN`).

`NODE_ENV=production` in the compose file is load-bearing: the
`DOHC_TEST_AUTH` device-approval seam in
`services/workspace-api/src/main.ts` is fail-closed and crashes the server
at boot if a dev `.env` leaks it into a real deployment.

## First run

1. Preflight and start:

   ```bash
   pnpm check:self-host            # validates compose config + services
   pnpm check:self-host -- --start # docker compose up
   ```

2. Apply the Postgres migrations (idempotent SQL, in order). Build the
   host-side URL from your `.env.self-host` values
   (`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_PORT`/`POSTGRES_DB`):

   ```bash
   export POSTGRES_URL=postgres://dohc:<POSTGRES_PASSWORD>@127.0.0.1:54329/dohc
   for f in packages/workspace-postgres/src/db/migrations/000{1,2,3}_*.sql; do
     psql "$POSTGRES_URL" -f "$f"
   done
   ```

   `0001` is the workspace schema, `0002` the Better Auth tables (required
   for login), `0003` the partial path-uniqueness indexes (required —
   without it delete-then-recreate wedges). There is no packaged migration
   runner yet; this is the honest current path.

3. Create the first user and connect the desktop. Launch dohc Desktop with
   your server as the cloud endpoint:

   ```bash
   DOHC_CLOUD_URL=http://127.0.0.1:1786 dohc-desktop
   ```

   "Connect dohc Cloud" starts the device flow: the desktop shows a short
   code and polls `POST /api/auth/device/token`. Approval needs a signed-in
   browser session against your server. A hosted sign-in/approval page is
   not shipped yet, so for now seed and approve via the Better Auth API:

   ```bash
   # one-time sign-up
   curl -X POST $URL/api/auth/sign-up/email -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"...","name":"You"}'
   # sign in, keep the session cookie
   curl -c /tmp/dohc.cookies -X POST $URL/api/auth/sign-in/email \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"..."}'
   # claim the code for this session (required — approve rejects unclaimed codes)
   curl -b /tmp/dohc.cookies "$URL/api/auth/device?user_code=<CODE>"
   # approve the code the desktop shows
   curl -b /tmp/dohc.cookies -X POST $URL/api/auth/device/approve \
     -H 'content-type: application/json' -d '{"userCode":"<CODE>"}'
   ```

   The desktop finishes the poll, stores the session encrypted on the
   device, and the workspace can enable cloud sync.

4. Prove the desktop-facing path end to end:

   ```bash
   node scripts/check-self-host-desktop-path.mjs
   ```

   It checks `/health` and exercises the same `POST /api/auth/device/code`
   route the desktop uses, failing with a precise blocker if either is down.

## Not in self-host scope yet

Stated plainly so nobody plans around it:

- **No hosted sign-in / device-approval UI** — first-user setup is the curl
  flow above.
- **No packaged migration runner** — migrations are applied with psql.
- **No S3/MinIO blob wiring** — workspace-api uses the local
  `DOHC_BLOB_DIR` volume; MinIO runs but is not yet consumed.
- **No email delivery** — password reset and email invitations are not
  functional; nothing is wired to send (or even log) them. The `sendEmail`
  option on `WorkspaceAuthOptions` in
  `services/workspace-api/src/auth/betterAuth.ts` is the intended future
  seam.
- **No federation between servers** (deferred) and no multi-node HA story.
- Production images: the compose services run from the repo checkout via
  `pnpm install` at container start, not prebuilt images.

## Reset dev data (development only)

```bash
pnpm reset:postgres
```

Never run reset commands against production data.

## Backup and restore

Back up the Postgres volume (`dohc_self_host_postgres`), the blob volume
(`dohc_self_host_blobs`), the object-storage volume if you start using it,
and secrets via your deployment's secret manager. Restore Postgres first,
then blobs, then run `node scripts/check-self-host-desktop-path.mjs` before
letting agents write again.

## Upgrades

1. Stop agent writes (or put workspaces in review-only mode).
2. Back up Postgres and blob volumes.
3. Apply new migrations from
   `packages/workspace-postgres/src/db/migrations/` in order.
4. Restart services; run the checks above.

## Security notes

- Identity is derived server-side from Better Auth sessions; client-supplied
  ids are never trusted.
- Every atom, asset, database, and app is workspace-scoped; live co-editing
  is gated by the Postgres ACL over `workspace_members`/`shares`/`locks`.
- Collab JWTs expire after 5 minutes; the workspace API is their only
  minter.
- Keep `BETTER_AUTH_SECRET`, `HOCUSPOCUS_JWT_SECRET`, and the admin/worker
  tokens private; rotate on exposure.
