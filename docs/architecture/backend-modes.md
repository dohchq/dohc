# Backend Modes

dohc is local-first: the desktop app and the workspace engine
(per-workspace SQLite under `.dohc/engine/`) are the product default and
need no backend at all. The Convex-era dual-backend migration this document
used to describe is finished — Convex is retired (Think Bigger User
Decision 6), and there is no `DOHC_BACKEND` switch anymore.

## Local (default)

Every workspace works fully offline: files on disk, engine history/versions/
chats/search in `.dohc/engine/`, MCP agents scoped to the workspace root.
Nothing here talks to a server.

## Postgres cloud stack (opt-in, reduced)

The opt-in cloud stack has been reduced to its two surviving pieces, both
decoupled from the local default path:

- **Live collaboration** — `services/hocuspocus` (Yjs co-editing over Postgres)
  plus the single collab-token route in `services/workspace-api`
  (`POST /workspaces/:id/collab/token`), which mints a hocuspocus-verifiable
  token after a Better Auth session and a workspace-membership check.
- **Sync relay** — `services/sync-relay`, engine-journal + blob transport,
  authenticated by the SAME Better Auth session (bearer tokens minted by the
  workspace-api device flow).

`services/workspace-api` is now collab + auth only: Better Auth mounts on
`/api/auth/*` (the auth surface itself lives in `packages/workspace-auth`), and
`packages/workspace-postgres` is trimmed to the collab membership slice.
Postgres survives for Better Auth's `user` table and that membership check. The
former sharing/members/invites/files/sync web surface and the `apps/web` client
were retired per the
[legacy salvage audit](../superpowers/plans/2026-07-06-think-bigger-0n3-legacy-salvage-audit.md)
Phase D; engine-native sync (Arc 0P) is the ongoing replacement, and the
history/sync salvage plus full Postgres-for-auth retirement remain deferred.

Environment variables for running that stack (self-host/dev only):

```bash
POSTGRES_URL=postgres://...
BETTER_AUTH_SECRET=...            # shared by workspace-api AND sync-relay
WORKSPACE_API_BASE_URL=http://127.0.0.1:1786
HOCUSPOCUS_ADMIN_TOKEN=...
HOCUSPOCUS_JWT_SECRET=...          # shared by workspace-api (collab route) and hocuspocus
SYNC_RELAY_PORT=1788
SQLITE_WORKER_TOKEN=...
```

Security rule: client callers never provide user identity or workspace
authorization. Backend services derive actor identity server-side and scope
every operation to a workspace. The local trust boundary is documented in
[docs/security/authz-boundaries.md](../security/authz-boundaries.md).
