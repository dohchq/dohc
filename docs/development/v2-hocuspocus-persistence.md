# v2 Hocuspocus Persistence Boundary

**Status:** Phase 1.4 bootstrap/editor note. This describes the durability contract used by `services/hocuspocus`.

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

Update appends and first-load bootstrap snapshots both take a per-document
Postgres advisory transaction lock. Bootstrap uses "insert snapshot if no state
exists" under that lock. If a real update wins the race after the initial
missing-state check, the bootstrap snapshot is skipped and Hocuspocus loads the
already-persisted state instead of writing a stale sequence-zero snapshot.

## Snapshot Sequence Rule

Snapshots must not claim a `last_seq` for an update that is logged but not yet represented in the encoded document. This can happen because dohc writes the update before Hocuspocus applies it.

The hook layer tracks the highest contiguous update sequence that has actually reached `onChange` for each document. `onStoreDocument` stores snapshots with that contiguous applied sequence, not the latest counter value. If update `2` is logged before update `1` is applied, a snapshot can still be written with `last_seq = 0` or `1`; replay remains safe because Yjs updates are idempotent.

## Load And Replay

On load:

1. Check whether any persisted document state exists. This is not the same as
   `latestSequence > 0`, because a first-load bootstrap snapshot intentionally
   has `last_seq = 0`.
2. If persisted state exists, load the latest snapshot, if any.
3. Apply its snapshot bytes to a fresh `Y.Doc`.
4. Replay update-log rows where `seq > snapshot.last_seq`, ordered by `seq`.
5. Track the latest loaded sequence as the applied base for future snapshots.

This gives crash recovery from the eager log and keeps snapshots an optimization, not the source of truth.

## First-Load Bootstrap

Phase 1.4 adds lazy migration from existing `atoms.body` markdown into Y.Doc:

1. `onLoadDocument` rechecks read ACL through Convex.
2. If Postgres already has a snapshot or update row for the document, Hocuspocus
   never reads `atoms.body` again.
3. If Postgres has no document state, Hocuspocus calls the server-token-gated
   Convex query `api.hocuspocusAuth.loadAtomBootstrap`.
4. Convex rechecks the requesting actor's read ACL inside that same bootstrap
   query, then resolves the atom by owner workspace + rename-proof `fileId` and
   returns `{ markdown }` or `null`.
5. Hocuspocus converts that markdown to the Phase 1.2 Tiptap/Yjs shape and
   conditionally stores the initialized document as a compact snapshot with
   `lastSeq: 0`.

The sequence-zero snapshot is deliberate: bootstrap is migration state, not a
user edit. Future accepted edits start in the append-only update log at seq 1.

The HTTP `GET /capabilities` endpoint advertises whether the running
Hocuspocus service has Convex bootstrap wired (`capabilities.atomBootstrap`).
The browser editor only enters collaborative Y.Doc mode when that capability is
true. If a local/dev Hocuspocus process is running with `HOCUSPOCUS_ALLOW_DEV_ACL`
and no Convex bridge, existing atoms stay in local markdown fallback instead of
opening as empty collaborative documents.

## Auth And Revocation

The Hocuspocus service accepts only short-lived collab JWTs:

- HS256 signed.
- 5 minute TTL.
- Claims: `sub`, `ws`, `actorKind`, `authzVersion`, `iat`, `exp`.

The hook layer checks:

- JWT workspace matches the encoded document name.
- Workspace `authzVersion` is current. Phase 1.4 uses constant version `1`
  plus live ACL rechecks; a real bumped workspace version is a later cache
  optimization, not the current revocation boundary.
- User can read on auth, token refresh, load, and every sync message before the
  server replies with document state.
- User can write before each persisted sync payload.
- Refreshed tokens cannot change the live socket identity. They may only renew
  the same user/workspace/atom/actor connection, and can downgrade a socket to
  read-only if the ACL changed.
- Live sockets store the refreshed token expiry and reject later sync messages
  once that expiry passes, so token refresh is required for long sessions.
- Revoked workspace users are disconnected from currently live sockets; reconnect
  authorization is decided by Convex's current ACL state.

Convex mints user collab JWTs with `api.auth.getCollabToken`. The optional
`workspaceId` arg scopes the token to an owner workspace for shared documents;
the `sub` claim always remains the authenticated caller. Hocuspocus verifies
the JWT locally, then asks Convex for per-document access through
`api.hocuspocusAuth.checkAtomAccess`, including `actorKind` so user locks can
block agent writes without blocking the human owner.

Production/self-host Hocuspocus deployments need:

- `HOCUSPOCUS_CONVEX_URL`: Convex deployment URL used by `ConvexHttpClient`.
- `HOCUSPOCUS_CONVEX_SERVER_TOKEN`: shared server secret sent from Hocuspocus
  to the Convex ACL query.
- `HOCUSPOCUS_JWT_SECRET`: HS256 secret shared by Convex token minting and
  Hocuspocus token verification.
- `HOCUSPOCUS_ADMIN_TOKEN`: admin endpoint bearer token.
- `HOCUSPOCUS_ADMIN_URL`: Hocuspocus base URL used by Convex to disconnect
  live sockets after share/org revocation.
- `HOCUSPOCUS_DATABASE_URL`: Postgres connection string for Y.Doc persistence.

Local Convex development setup normally looks like:

```bash
pnpm --filter @dohc/app exec convex env set HOCUSPOCUS_JWT_SECRET '<32+ byte shared secret>'
pnpm --filter @dohc/app exec convex env set HOCUSPOCUS_CONVEX_SERVER_TOKEN '<server secret>'
pnpm --filter @dohc/app exec convex env set HOCUSPOCUS_ADMIN_URL 'http://127.0.0.1:1234'
pnpm --filter @dohc/app exec convex env set HOCUSPOCUS_ADMIN_TOKEN '<admin secret>'
```

The Hocuspocus process must receive the matching `HOCUSPOCUS_JWT_SECRET`,
`HOCUSPOCUS_CONVEX_SERVER_TOKEN`, and `HOCUSPOCUS_ADMIN_TOKEN`, plus
`HOCUSPOCUS_CONVEX_URL` for the target Convex deployment.

The development compose file reads these values from your shell when present and
falls back to local-only literals. If you use generated local secrets in Convex,
export the same values before starting compose.

If `HOCUSPOCUS_CONVEX_URL` or `HOCUSPOCUS_CONVEX_SERVER_TOKEN` is present, both
must be present. Without them, the server refuses to boot unless
`HOCUSPOCUS_ALLOW_DEV_ACL=true` is set explicitly.

On the Convex side, `HOCUSPOCUS_ADMIN_URL` and `HOCUSPOCUS_ADMIN_TOKEN` may both
be absent only while collab token minting is not configured. Once
`HOCUSPOCUS_JWT_SECRET` is set, missing admin disconnect env is a hard
configuration error so revocation cannot silently fail open.

The admin endpoint `POST /admin/disconnect-by-workspace-user` closes registered
live sockets for that workspace/user pair.

The admin endpoint `POST /admin/delete-document` deletes all persisted Y.Doc
state for a workspace/atom pair. Convex schedules this when an atom is deleted
so a later file-id reuse cannot resurrect stale CRDT state.

Convex schedules that admin disconnect when:

- a person share is revoked
- an org share is revoked
- an atom delete cascades share deletion
- an org member leaves an org that has shared atoms

The disconnect registry is intentionally non-sticky. It closes currently live
sockets; reconnect authorization is decided by Convex's current ACL state. This
prevents a revoke-then-reshare from being blocked by stale in-memory state.

## Current Limits Before Phase 1.5

Phase 1.4 wires the browser editor to the service, but presence/suggestions and
projection-cache authority are still later phases:

- The browser editor requests `api.auth.getCollabToken`, uses
  `@hocuspocus/provider`, and stores local Y.Doc state in `y-indexeddb`.
- The browser checks Hocuspocus `GET /capabilities` before enabling sync. It
  waits for identity + capability resolution before allowing edits, and starts
  the remote provider only after `y-indexeddb` has hydrated the local Y.Doc.
  First edit is blocked until the remote sync completes unless a pre-existing
  IndexedDB cache is verified for that document. Read-only shared views skip
  local IndexedDB hydration to avoid rendering stale writable state.
- The live raw `@hocuspocus/provider` crash test passes against Docker Postgres.
  The compose stack defaults to explicit `HOCUSPOCUS_ALLOW_DEV_ACL=true`; set
  matching `HOCUSPOCUS_JWT_SECRET`, `HOCUSPOCUS_ADMIN_TOKEN`,
  `HOCUSPOCUS_CONVEX_URL`, and `HOCUSPOCUS_CONVEX_SERVER_TOKEN` to test the
  full Convex bootstrap path locally.
- dohc uses custom persistence because the default debounced store path is not
  the ack-safe update-log boundary this plan requires.
- `atoms.body` is still updated by the legacy autosave path until Phase 1.6 moves markdown projection writes to Hocuspocus `onChange`.
- Y.Awareness presence and cursor rendering are intentionally not enabled until Phase 1.5.

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

Current local run status: passed against Docker Postgres.

## Local Docker Service

The Hocuspocus service has a production Dockerfile at `services/hocuspocus/Dockerfile`. The development compose stack can run Postgres plus Hocuspocus:

```bash
docker compose -f docker-compose.dev.yml up -d postgres hocuspocus
```

The compose stack binds Postgres and Hocuspocus to `127.0.0.1` only. The
Hocuspocus service uses `HOCUSPOCUS_ALLOW_DEV_ACL=true` and development secrets
unless you override them. That is only for local Phase 1.3/1.4 work; production
deployment must wire the real Convex ACL adapter and real secrets before
exposing the service.
