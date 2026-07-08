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

The opt-in cloud stack has been reduced to two surviving pieces, both decoupled
from the local default path:

- **Sync relay** — `services/sync-relay`, engine-journal + blob transport,
  authenticated by a Better Auth session (bearer tokens minted by the
  workspace-api device flow). **Co-editing is now engine-native**: a shared
  workspace co-edits through the engine Y.Doc driver's `ydoc.update`
  replication carried over this relay — there is no separate collaboration
  server.
- **Auth** — `services/workspace-api` is now AUTH ONLY. Better Auth mounts on
  `/api/auth/*` (the auth surface itself lives in `packages/workspace-auth`);
  it owns no application routes and 404s everything else. It is the server the
  desktop device sign-in flow mints tokens against, which the relay validates.

Hocuspocus was retired at a clean cutover (G2-C-3): `services/hocuspocus` and
the workspace-api collab-token route are gone. `packages/workspace-postgres` is
trimmed to its schema migrations — notably `0002_better_auth.sql`, the Better
Auth `user`/`session` schema the relay reads directly. The former
sharing/members/invites/files/sync web surface and the `apps/web` client were
retired per the
[legacy salvage audit](../superpowers/plans/2026-07-06-think-bigger-0n3-legacy-salvage-audit.md)
Phase D; full Postgres-for-auth retirement remains deferred.

Environment variables for running that stack (self-host/dev only):

```bash
POSTGRES_URL=postgres://...
BETTER_AUTH_SECRET=...            # shared by workspace-api AND sync-relay
WORKSPACE_API_BASE_URL=http://127.0.0.1:1786
SYNC_RELAY_PORT=1788
SQLITE_WORKER_TOKEN=...
```

Security rule: client callers never provide user identity or workspace
authorization. Backend services derive actor identity server-side and scope
every operation to a workspace. The local trust boundary is documented in
[docs/security/authz-boundaries.md](../security/authz-boundaries.md).
