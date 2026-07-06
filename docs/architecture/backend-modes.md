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

## Postgres cloud stack (opt-in, retiring)

The Postgres-backed cloud stack (`services/workspace-api`,
`services/hocuspocus`, `packages/workspace-postgres`, the `apps/web` client)
serves opt-in cloud sync, shares, and live co-editing for cloud-connected
shared workspaces. It is fully decoupled from the local default path and
retires as a coupled unit per the
[legacy salvage audit](../superpowers/plans/2026-07-06-think-bigger-0n3-legacy-salvage-audit.md)
Phase D; engine-native sync (Arc 0P) replaces it.

Environment variables for running that stack (self-host/dev only):

```bash
POSTGRES_URL=postgres://...
WORKSPACE_API_BASE_URL=http://127.0.0.1:1786
HOCUSPOCUS_ADMIN_TOKEN=...
HOCUSPOCUS_JWT_SECRET=...
SQLITE_WORKER_TOKEN=...
APP_TESTER_TOKEN=...
```

Security rule: client callers never provide user identity or workspace
authorization. Backend services derive actor identity server-side and scope
every operation to a workspace. The local trust boundary is documented in
[docs/security/authz-boundaries.md](../security/authz-boundaries.md).
