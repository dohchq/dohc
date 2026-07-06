# Think Bigger 0P: Engine-Native Sync Design

Status: design accepted for lane cutting (no product code in this doc's PR)
Date: 2026-07-06
Arc: 0P (engine-native sync), lane WS-B
Basis: the cloud-on-engine decision in the
[Plan Completion Map](./2026-06-23-think-bigger-dohc-workspace-engine.md#plan-completion-map-2026-07-06),
[Refined Implementation Default 1](./2026-06-23-think-bigger-dohc-workspace-engine.md#refined-implementation-defaults)
(local engine is the source of truth; cloud never authoritative), the
[PR 21R milestone structure](./2026-06-23-think-bigger-dohc-workspace-engine.md#pr-21r---sync-replication-and-offline-rejoin),
and the
[0N-3 legacy salvage audit](./2026-07-06-think-bigger-0n3-legacy-salvage-audit.md).
All claims about current code are verified against this worktree
(branch base main `f62b6ed0`).

## Why this document

PR 21R was written before the engine's storage landed and before User
Decision 6 (replacement, not migration) retired the legacy cloud stack.
This note redesigns 21R against the engine that actually shipped —
`.dohc/engine/engine.db`, SQLite WAL, content-addressed blobs,
append-only moments — and re-cuts its milestones into bounded lanes.
The spec's multi-machine open questions
([open questions 3 and 8](../specs/2026-06-22-dohc-versioned-workspace-design.md#open-questions))
are treated as a north star, not a contract.

## Goals

- The same workspace on N machines, where N is one human's small fleet
  (laptop, desktop, maybe a third). Agents are local processes writing
  through their machine's engine; they are not additional sync parties.
- The local engine stays authoritative on each machine: object IDs,
  versions, history, conflicts, and policy are decided locally. dohc
  Cloud is a replication relay and at-rest store. It never becomes
  authoritative over identity, history, or policy.
- Offline-first: every machine works fully offline; rejoin replays
  queued local writes and ingests remote ones without data loss.
- Secrets replicate encrypted only. The workspace data key never leaves
  the user's machines unwrapped (key exchange design below).
- Derived state never replicates: the WS-D FTS index, the P0F search
  visibility layer, and any projection are rebuilt locally from
  replicated canonical state.

## Non-goals

- Multi-user shares, members, invites, and external channels. Those
  rebuild later (PR 18 scope) on top of this foundation, per Phase D of
  the salvage audit.
- Live CRDT co-editing. Y.Doc collab stays on the legacy Hocuspocus
  path until the collab arc re-homes it (audit gate list).
- Server-side merge, diff, or any content intelligence. The server is a
  dumb relay plus storage, by design and by test.
- Compatibility with the legacy atoms API
  (`services/workspace-api/src/routes/sync.ts`, `files.ts`) or the
  legacy merge-sync client (`packages/workspace-sync/src/`,
  `apps/desktop/src/workspaces/cloudSyncEngine.ts`). Those are
  KEEP-UNTIL/SALVAGE-REIMPLEMENT in the audit; this design is the
  reimplementation, and they retire when it lands.
- Partial/lazy hydration and relay-side garbage collection (append-only
  at alpha; see Risks).

## What replicates (data model)

The engine database (`packages/workspace-engine/src/engineDbSchema.ts`)
splits cleanly into three classes:

1. **Replicated canonical state** — travels between machines:
   - `blobs`: content-addressed bodies keyed by `sha256`
     (engineDbSchema.ts:147). Content addressing makes blob replication
     idempotent and dedupe-free by construction: a hash either exists
     on the other side or it does not.
   - `moments`: the append-only per-workspace history log
     (engineDbSchema.ts:216). This is the heart of replication.
   - `versions` (create + rename), `versioned_workspaces`,
     `file_objects`, `conflicts` (open + resolve), `chat_threads`,
     `chat_messages`.
   - WS-C's encrypted secret blobs (ciphertext only; see Secrets).
2. **Locally maintained, derived from applied ops** — never shipped as
   rows, always recomputed by applying the log: `snapshots`,
   `fork_base_snapshots`, `path_aliases`. Each is a deterministic
   function of the moments and version ops applied so far, and the
   import path updates them exactly the way local writes do.
3. **Local-only state** — never replicates: `active_versions` (which
   version a machine is working in is per-machine working state,
   engineDbSchema.ts:50), the WS-D FTS index, watcher/capture state,
   and `moment_order` values (below).

### Log identity: per-origin sequences, not a writer lease

Two candidate schemes were on the table:

- **(a) Multi-origin log**: each machine gets a stable `originId`; every
  replicated op carries `(originId, originSeq)` where `originSeq` is a
  per-origin monotone counter. Peers track a high-water mark per origin
  (a vector clock whose width is the number of machines).
- **(b) Single-writer lease**: one machine at a time holds a
  per-workspace write lease from the relay; the log is a single
  sequence.

**Chosen: (a), the multi-origin log.** Rationale, grounded in the
actual product:

- Offline writes cannot be refused. Refined Default 1 makes the local
  engine authoritative; a laptop without the lease and without a
  network still must accept writes. So a lease cannot prevent
  divergence — it can only hide it until rejoin, at which point the
  full multi-origin merge machinery is needed anyway. The lease adds
  acquisition, expiry, and split-brain handling while removing no
  obligations.
- The merge machinery already exists. P0D shipped conflict preservation
  (base/current/incoming rows, engineDbSchema.ts:251) for concurrent
  version merges; offline rejoin (21R-D) reuses it rather than
  inventing a second model.
- The vector clock is tiny. One human, two to five machines: per-origin
  cursors are a handful of integers, not a distributed-systems problem.
- Agents do not widen it. Agents write through their machine's engine,
  so machine count — not actor count — bounds the origin set.

`originId` is generated once per engine store (per machine per
workspace), stored in a new local `sync_identity` table, and is a
`randomUUID`-based id like every other engine id
(versionedTextStore.ts:1610).

### momentOrder stays local; (originId, originSeq) is the wire identity

`moment_order` is allocated locally as `MAX + 1` per workspace
(`nextMomentOrder`, versionedTextStore.ts:2191) and is UNIQUE per
workspace (engineDbSchema.ts:244). It is a per-store total order used
for timeline pagination and replay windows — two stores that ingested
the same moments in different interleavings will legitimately hold
different `moment_order` values. Therefore:

- `moment_order` **never replicates**. It is class-3 local state.
- The replicated identity of every op is `(originId, originSeq)`;
  the stable cross-machine reference for a moment remains its
  globally unique `moment_id`.
- **Deterministic re-ordering rule:** an importer applies a fetched
  batch per origin in `originSeq` order (per-origin FIFO preserves each
  machine's causality), and interleaves across origins by
  `(recordedAtMs, originId, originSeq)`. Imported ops get freshly
  allocated local `moment_order` values in that order. Convergence of
  workspace *state* never depends on the interleave — it depends on
  per-object head checks and conflict rows (next section) — but the
  deterministic rule keeps timelines stable across re-imports and makes
  import idempotent: an op whose `(originId, originSeq)` is at or below
  the local high-water mark for that origin is skipped.

### Applying a remote moment

A `moment.append` op carries the full moment record: operation
(`write`/`rename`/`delete`), path, blob hashes, and the before-state
including `before_latest_moment_id` (engineDbSchema.ts:238) — the same
causal guard local writes already persist. The importer checks the
local head for `(versionId, objectId)` against
`snapshots.latest_moment_id` (engineDbSchema.ts:191):

- **Fast-forward** (local head equals the op's before head): apply the
  moment through the same transactional write path local writes use —
  snapshot, alias, and moment rows update together, invariant
  assertions included.
- **Divergence** (heads differ because both machines extended the same
  object): preserve both sides. The remote chain is recorded into
  history, the local materialized file stays as-is (local engine
  authoritative on its own disk), and a conflict row opens with base =
  the shared ancestor state the two chains fork from, current = local
  head, incoming = remote head — exactly the P0D shape. No silent loss,
  ever; this is 21R-D's acceptance restated on engine storage.
- Blob dependencies are fetched before apply; an op is never applied
  with dangling hashes (the `blobs` foreign keys enforce this locally).

### The replication journal

A new `replication_log` table journals every replicated op **in the
same transaction** as the mutation it describes, so the journal can
never disagree with the store:

- `replication_log(origin_id, origin_seq, op_kind, payload_json,
  recorded_at_ms)`, primary key `(origin_id, origin_seq)`. Local writes
  append with the local origin; imports append with the remote origin
  (making re-export transitive: machine C can catch up from B without
  ever seeing A).
- `replication_peers(origin_id, acked_seq)` holds the per-origin
  high-water marks, plus one opaque relay cursor for fetch pagination.
- Op kinds: `workspace.init`, `moment.append`, `version.create`,
  `version.rename`, `conflict.open`, `conflict.resolve`,
  `chat.thread.create`, `chat.thread.update`, `chat.message.append`,
  and (0P-D) `secret.blob.put`. Path-alias changes are consequences of
  write/rename/delete moments, not separate ops.

## Conflict story

- **Concurrent edits, same path/version:** the P0D conflict model, as
  described above. Resolution is itself a normal engine op
  (`conflict.resolve` plus the resolving write moment) and replicates
  like any other; the other machine sees the conflict close.
- **Concurrent conflict resolutions:** both resolutions exist in
  history (they are moments); the conflict row's terminal state is
  decided deterministically by `(recordedAtMs, originId)`. Nothing is
  lost — the "losing" resolution's content remains one restore away.
- **Concurrent version creation:** `version_id` is a UUID, so there is
  no identity collision; both versions simply exist everywhere after
  sync. Duplicate display names are representable today —
  `idx_versions_workspace_name` is a non-unique index
  (engineDbSchema.ts:323) — so the engine keeps both and the UI
  disambiguates by creation time. No merge needed.
- **Concurrent rename of the same version:** names are labels, not
  identity. Deterministic last-writer-wins by
  `(recordedAtMs, originId)`; the losing name is display metadata, not
  data loss.
- **Chats:** append-only merge, conflict-free by construction. Message
  identity is `(workspace_id, message_id)`; `message_order` is a
  per-store local counter (UNIQUE per thread, engineDbSchema.ts:319)
  and follows the same rule as `moment_order`: never replicated,
  locally reallocated in deterministic `(createdAtMs, originId,
  originSeq)` order. Concurrent thread-title updates are deterministic
  LWW like version renames.
- **Active version:** per-machine local state, never replicated.
  Switching versions on the laptop must not yank the desktop's working
  files out from under a running agent.

## Secrets: encrypted replication and key exchange

WS-C is adding encrypted secret blobs to the engine (secret-backed
`.env` driver, PR 08 scope). Replication treats them as opaque:

- Secret blobs replicate as **ciphertext blobs**, content-addressed by
  the sha256 of the ciphertext. The relay stores them exactly like any
  other blob and cannot distinguish them beyond a type tag.
- The workspace **data key never replicates**. Redaction and
  materialization policy stay engine-side per machine (21R-E).

**Key exchange at alpha: passphrase-wrapped workspace key.** The first
machine generates a random 256-bit data key, wraps it with a KEK
derived from a user-chosen sync passphrase (Argon2id or scrypt), and
uploads only the wrapped-key envelope to the relay bucket. Enrolling a
new machine = device-flow login + entering the passphrase; the unwrap
happens locally. The relay holds ciphertext plus a wrapped key it
cannot open.

Why passphrase-wrapping over manual key transfer:

- Enrollment works without both machines being online at once, which is
  the realistic single-human flow ("set up the laptop on the train").
- The threat model is one user's own machines, not inter-user sharing;
  a passphrase the user chooses once is proportionate at alpha.
- Manual export/import of the raw key file stays as the documented
  fallback and disaster-recovery path (lost passphrase with one machine
  still alive). Key rotation is explicitly deferred past alpha.

Local at-rest storage of the unwrapped key reuses the desktop
credential-store pattern
(`apps/desktop/src/workspaces/cloudCredentialStore.ts`), which the
salvage audit already flags as reusable for secrets.

## Transport and server

A thin relay: authenticated per-user workspace buckets, a blob store,
and an append-only op log. **No server-side merge logic** — the server
never interprets op payloads beyond schema shape and size caps, and it
holds no authority over ordering beyond pagination.

Protocol over HTTPS (JSON for ops, raw bodies for blobs):

- `POST /sync/workspaces` — create or attach a workspace bucket.
- `PUT /sync/:ws/blobs/:sha256` / `GET ...` — idempotent
  content-addressed blob put/get; the server verifies the hash on PUT.
- `POST /sync/:ws/blobs/have` — hash-set diff so pushes skip blobs the
  relay already has (dedupe across machines for free).
- `POST /sync/:ws/log` — append a batch of ops for the caller's
  `originId`. The server enforces contiguous `origin_seq` per origin
  (rejecting gaps makes retries idempotent and forgeries detectable)
  but assigns no ordering across origins.
- `GET /sync/:ws/log?since=<cursor>` — fetch ops from all origins after
  an opaque relay cursor. The relay's internal sequence exists purely
  for pagination and carries no merge authority.
- `PUT /sync/:ws/keys` / `GET ...` — the wrapped-key envelope.

Machine auth **salvages the existing better-auth device flow**: dohc
Cloud auth already mounts better-auth with the `deviceAuthorization`
and `bearer` plugins — the desktop shows a code, the browser approves,
the desktop polls, and the resulting access token authenticates Bearer
API calls (`services/workspace-api/src/auth/betterAuth.ts`, plugins at
lines 77-79). That auth subsystem is kept even as the atoms routes
retire; the relay mounts the same auth, whether it lives as a fresh
service or a fresh module beside it. Per the audit,
`packages/workspace-postgres` retires and "sync/0P re-establishes a
server store fresh if needed" — the relay's storage is a plain op table
plus a blob store, deliberately boring, and explicitly **not** the
legacy atoms API.

The desktop push loop keeps the shape the legacy
`cloudSyncEngine.ts` proved (debounced pushes behind settled capture
batches, pull on app open, one serialized work chain, auth-expiry
pauses sync without touching local data) with the payload replaced by
replication-log ops. This is the sync-flood/backpressure answer from
21R-A: capture already coalesces watcher bursts into moments (Refined
Default 5), and the loop batches moments into pushes.

## Milestones (re-cut of 21R-A..E)

Ordered so replication *semantics* are proven before any server exists.

### 0P-A — Sync over a folder (log export/import, no server)

Adds `sync_identity`, `replication_log`, `replication_peers`, the
journal writes, and bundle export/import against a plain directory
(e.g. a USB stick or Syncthing folder): `export --since` writes op
batches plus referenced blobs; `import` applies with the deterministic
re-ordering rule and head checks. Maps the semantics half of 21R-A plus
all of 21R-B's state coverage that exists in the engine today.

Test gate: A→B→A round trip converges (identical canonical state,
different `moment_order` allowed); divergent same-path edits produce
mirrored P0D conflict rows on both machines; re-import is a no-op;
version/chat/conflict rows survive the trip; the FTS index and
`active_versions` are provably absent from bundles and rebuilt locally.
Property/fuzz tests over random op interleavings assert convergence.

### 0P-B — Thin relay and machine auth

The relay service (buckets, blob put/get/have, log append/fetch), the
device-flow machine enrollment, and the desktop sync loop. Maps the
transport half of 21R-A. Depends on 0P-A.

Test gate: two engines syncing through a live relay; a stale replica
cannot overwrite newer state (head checks degrade to conflicts, never
clobber); watcher bursts arrive as batched pushes; server rejects
cross-user bucket access and `origin_seq` gaps; kill-the-network
mid-push retries idempotently.

### 0P-C — Offline rejoin and conflict E2E

The full 21R product proof: laptop edits offline, desktop edits online,
laptop rejoins. Maps 21R-C and 21R-D (projection rebuild collapses to
"derived state never replicated, rebuilt locally" — simpler than 21R-C
assumed, because the engine already rebuilds projections from canonical
rows). Depends on 0P-B; lands with WS-D so search rebuild is testable.

Test gate: the 21R E2E — offline/online divergence with file history,
conflict handling and resolution round trip, linked-chat rail, and
search verified on both machines after rejoin.

### 0P-D — Encrypted secret replication

Ciphertext-only secret blob replication, the passphrase-wrapped key
envelope, and new-machine enrollment. Maps 21R-E. Depends on WS-C
(the secret driver) and 0P-B.

Test gate: plaintext never appears in bundles, relay storage, transport
captures, or logs; a machine without the passphrase syncs everything
except secret materialization and fails closed; wrong passphrase fails
without corrupting state; the manual key-file fallback round-trips.

## Risks

1. **The import path is new writer surface.** The store guards its
   invariants aggressively (persisted-shape assertions throughout
   `versionedTextStore.ts`); an import path that bypassed them could
   corrupt a good database. Mitigation: imports go through the same
   transactional apply path as local writes, plus the 0P-A
   convergence fuzz gate before any server exists.
2. **Append-only relay grows without bound.** Every blob and op is kept
   forever at alpha. Acceptable for one user's text-first workspaces
   under quotas and size caps, but GC needs a reachability design
   before general availability.
3. **Wall-clock skew shapes display interleave.** Identity and
   causality never depend on clocks — only the deterministic display
   interleave uses `recordedAtMs` — but a machine with a badly wrong
   clock will produce oddly-ordered (never lost) timelines.

## Open questions for the user

1. **Encrypt everything, or only secrets, at the relay?** Encrypting
   all blobs under the workspace key maximizes the "cloud is dumb"
   promise, but it forecloses future server-rendered features (web
   viewing, the PR 18 shares rebuild) unless those re-encrypt or hold
   keys. Recommendation: secrets-only ciphertext at alpha, revisit
   before shares.
2. **Is bootstrap-from-relay in 0P-B scope?** Enrolling a fresh machine
   into an empty folder and materializing the workspace from the relay
   is the best onboarding, but it is extra scope (full materialization
   from log replay). Alternative: alpha assumes the folder is first
   copied conventionally and sync takes over.
3. **Relay hosting at alpha:** dohc-hosted only, or docker-compose
   self-host from day one (the `workspace-api` precedent suggests
   self-host matters to you)?
