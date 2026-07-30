# Backend modes

dohc has one local product mode and one opt-in sync stack.

## Local desktop

The desktop app owns ordinary workspace folders. It launches the Rust workspace
engine as a child process and communicates over authenticated stdio. Each open
workspace receives a daemon handle.

The engine stores workspace state in `.dohc/engine/engine.db`. Files remain
readable without dohc. No server, account, or environment file is required.

## Opt-in sync stack

The sync stack has three running services:

- Postgres stores Better Auth data.
- `services/workspace-api` serves Better Auth and the desktop device flow.
- `services/sync-relay` serves operations, blobs, shares, presence, and
  engine-native Y.Doc replication.

The workspace API owns no file, workspace, sharing, or collaboration routes.
The relay stores application relay data in its own SQLite database.

Both services use the same `BETTER_AUTH_SECRET` and Postgres database. The
relay validates the session and derives the caller’s user ID server-side.

```bash
POSTGRES_URL=postgres://...
BETTER_AUTH_SECRET=...
WORKSPACE_API_BASE_URL=http://127.0.0.1:1786
SYNC_RELAY_PORT=1788
```

See [authorization boundaries](../security/authz-boundaries.md) and
[self-hosting](../self-hosting.md).
