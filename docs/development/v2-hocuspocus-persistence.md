# v2 Hocuspocus Persistence Boundary

**Status:** Phase 1.3 foundation note. This describes the durability contract used by `services/hocuspocus`.

## Sources Checked

- Hocuspocus hooks docs: https://tiptap.dev/docs/hocuspocus/server/hooks
- Hocuspocus persistence docs: https://tiptap.dev/docs/hocuspocus/guides/persistence
- Hocuspocus configuration docs: https://tiptap.dev/docs/hocuspocus/server/configuration
- Local package source: `node_modules/@hocuspocus/server/src/Connection.ts`, `MessageReceiver.ts`, `types.ts`, and `Hocuspocus.ts`

Context7 was requested for this phase, but no callable Context7 MCP tool is exposed in this session. The local installed Hocuspocus v4 package source and official docs are the reference of record for this implementation.

## The Important Boundary

`beforeHandleMessage` runs before Hocuspocus handles an inbound message, but its `update` argument is the raw Hocuspocus transport frame. That frame includes the document address and message envelope. It is useful for coarse rejection, but it is not the replayable Yjs document update we want in the append-only log.

`beforeSync` is the durable write boundary for dohc. Hocuspocus calls it after decoding the outer Hocuspocus frame and before applying the y-protocols sync message. The hook exposes:

- `type`: y-protocols sync type
- `payload`: the sync payload bytes
- `connection`: the live connection

Only sync type `1` (`SyncStep2`) and type `2` (`YjsUpdate`) contain Yjs update payloads that dohc can replay into a `Y.Doc`. Type `0` (`SyncStep1`) is a state-vector request and is not persisted.

Before appending either persisted sync type, dohc validates the payload by applying it to a disposable `Y.Doc`. Malformed authenticated client payloads fail before they can poison the append-only log.

## Ack Meaning

For write messages, Hocuspocus applies the sync payload and then sends sync status `true` to the client. dohc persists the Yjs payload in `beforeSync` before Hocuspocus applies it. If the append fails, `beforeSync` throws, Hocuspocus closes the connection, and the write is not accepted as an acked durable edit.

Read-only connections are handled by Hocuspocus's read-only sync branch. dohc does not append payloads from read-only connections.

## Why `onStoreDocument` Is Not Enough

Hocuspocus calls `onStoreDocument` after a document changes, but the call is debounced by default. The default configuration uses a 2 second debounce and 10 second max debounce. That is good for compact snapshots, but it is not enough for ack-safe durability by itself: a process crash between an acked edit and the next debounced store could lose that edit.

dohc therefore uses two layers:

- `beforeSync`: eager append-only update log, one row per accepted Yjs update payload.
- `onStoreDocument`: compact snapshot of the current `Y.Doc`, used only to shorten replay time.

## Postgres Model

The persistence tables are:

- `hocuspocus_ydoc_counters`: per-document monotonic sequence counter.
- `hocuspocus_ydoc_updates`: append-only update log with `doc_name`, `seq`, `update_bytes`, `actor_id`, `socket_id`, and `received_at`.
- `hocuspocus_ydoc_snapshots`: compact Y.Doc snapshots with `last_seq`.

When backed by a `pg.Pool`, update appends acquire one `PoolClient` and run `BEGIN`, counter increment, update insert, and `COMMIT` on that same client. Pool-level `query()` is not used inside a transaction.

## Snapshot Sequence Rule

Snapshots must not claim a `last_seq` for an update that is logged but not yet represented in the encoded document. This can happen because dohc writes the update before Hocuspocus applies it.

The hook layer tracks the highest contiguous update sequence that has actually reached `onChange` for each document. `onStoreDocument` stores snapshots with that contiguous applied sequence, not the latest counter value. If update `2` is logged before update `1` is applied, a snapshot can still be written with `last_seq = 0` or `1`; replay remains safe because Yjs updates are idempotent.

## Load And Replay

On load:

1. Load the latest snapshot, if any.
2. Apply its snapshot bytes to a fresh `Y.Doc`.
3. Replay update-log rows where `seq > snapshot.last_seq`, ordered by `seq`.
4. Track the latest loaded sequence as the applied base for future snapshots.

This gives crash recovery from the eager log and keeps snapshots an optimization, not the source of truth.

## Auth And Revocation

The Hocuspocus service accepts only short-lived collab JWTs:

- HS256 signed.
- 5 minute TTL.
- Claims: `sub`, `ws`, `actorKind`, `authzVersion`, `iat`, `exp`.

The hook layer checks:

- JWT workspace matches the encoded document name.
- Workspace `authzVersion` is current.
- User can read on auth and load.
- User can write before each persisted sync payload.
- Revoked workspace users are rejected on auth/load/write.

The admin endpoint `POST /admin/disconnect-by-workspace-user` records the revocation and closes registered live sockets for that workspace/user pair.

## Current Limits Before Phase 1.4

This phase is a service foundation, not full client integration:

- The Convex ACL adapter is not wired yet. The server entrypoint requires explicit `HOCUSPOCUS_ALLOW_DEV_ACL=true` for the temporary allow-all development adapter.
- A live raw `@hocuspocus/provider` crash test with real Postgres still needs to pass before the Tiptap client uses this service.
- `@hocuspocus/extension-database` is installed for API reference only. dohc uses custom persistence because the default debounced store path is not the ack-safe update-log boundary this plan requires.
- `@hocuspocus/provider` is installed for the upcoming raw provider smoke/crash scripts.

## Live Crash Gate

The live crash harness is intentionally outside the default unit suite. It requires a real Postgres URL and refuses to run without one:

```bash
pnpm --filter @dohc/hocuspocus run test:integration
```

Local Docker path:

```bash
docker compose -f docker-compose.dev.yml up -d postgres
HOCUSPOCUS_TEST_DATABASE_URL=postgres://dohc:dohc@127.0.0.1:54329/dohc_v2 pnpm test:hocuspocus:integration
```

The integration file `services/hocuspocus/src/integration/live-provider-crash.integration.ts` covers:

- raw provider write through Hocuspocus into Postgres
- server destroy/restart and replay from the update log
- fail-loud write refusal when the updates table is unavailable

Current local run status: blocked in this WSL distro because Docker is unavailable and the local Postgres server requires credentials for user `ice`. Use Docker Desktop WSL integration or provide `HOCUSPOCUS_TEST_DATABASE_URL`.
