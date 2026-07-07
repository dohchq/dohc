# Think Bigger WS-G2-B/C: Y.Doc Engine Content Driver (Design)

Status: design accepted for lane cutting (no product code in this doc's PR)
Date: 2026-07-07
Arc: WS-G (content drivers), lanes WS-G2-B and WS-G2-C
Basis: the chosen decision in the
[WS-G2 collab design](./2026-07-06-think-bigger-wsg2-collab-design.md) —
(a) decouple-and-defer now, with (b) Y.Doc-driver-as-engine-content-driver
as the committed re-home shape — plus
[Refined Implementation Default 7](./2026-06-23-think-bigger-dohc-workspace-engine.md#refined-implementation-defaults)
(content drivers own canonical state; rich docs can use Y.Doc), and the
[0P sync design](./2026-07-06-think-bigger-0p-sync-design.md)
(multi-origin op log). All claims about current code are verified against
this worktree (branch base main `865f9d13`).

## Why this document

WS-G2 chose (a) and named (b) as the end state without designing it. This
note designs (b): the Y.Doc engine content driver (G2-B), plus enough of
replicated co-editing (G2-C) to prove the shape is coherent and that
Hocuspocus can retire onto it. It is the implementable spec the WS-G2
milestone sketch (G2-B/G2-C) deferred, grounded in the engine that shipped
(`.dohc/engine/engine.db`, content-addressed blobs, append-only moments)
and the sync substrate that shipped (multi-origin log, relay push/fetch).

The north star from Refined Default 7 (mega plan line 647): "content drivers
own canonical state behind shared engine contracts; rich docs can use Y.Doc."
And Refined Default 1's non-negotiable (line 181): "Canonical Y.Doc state is
the only rich document write source; Markdown/body caches ... are read-
through derived caches and are never patched directly." This driver makes
that literally true on the engine: a rich doc's canonical state is a Y.Doc in
`engine.db`, and the settled markdown file is its projection.

## Goals

- A rich doc gets a canonical Y.Doc persisted in `engine.db`, beside the
  versioned text store, addressed by the same content-addressed-blob
  discipline every other engine artifact uses.
- The settled markdown file on disk is a PROJECTION of the Y.Doc: it is
  read, searched, exported, captured, and version-restored like any other
  file, but the Y.Doc is canonical while a doc is "live".
- One canonical source per doc at any instant — the no-double-canonical
  rule from WS-G2's coexistence contract, extended from "file vs Hocuspocus
  session" to "file vs live engine Y.Doc".
- Solo editing works with zero Hocuspocus: single-writer, local, no network,
  no server, no token.
- Multi-user co-editing arrives via sync (G2-C), not a server: Y.Doc updates
  ride the multi-origin op log as a commutative op kind. Low-latency co-edit
  is the same ops fanned out faster over the 0P-B relay, not a new stack.
- Hocuspocus + its Postgres persistence + the collab-token route retire at a
  closed-session boundary, salvaging the roundtrip and auth surfaces the
  legacy stack proved.

## Non-goals

- No product code in this lane. Design note only.
- No multi-user product design (presence UX, permissions, share flows) — the
  team wave (audit Phase D). G2-C designs the replication mechanism, not the
  product surface.
- No rich-doc semantic merge beyond markdown three-way. Cross-version and
  cross-machine reconciliation that the CRDT cannot auto-merge preserves
  both sides (P0D conflict shape), exactly like text files.
- No migration of legacy Hocuspocus Y.Doc update history. User Decision 6
  (replacement, not migration): the settled file carries content forward.

## What the code proves today (verified)

The legacy stack already runs the exact storage and projection shapes this
driver re-homes; (b) is a re-implementation on engine storage, not an
invention.

1. **Hocuspocus persists Y.Doc as sequential update rows + periodic
   snapshots.** `services/hocuspocus/src/persistence.ts` defines
   `hocuspocus_ydoc_updates` (append-only `(doc_name, seq, update_bytes,
   ...)`, persistence.ts:342-352), `hocuspocus_ydoc_snapshots`
   (`snapshot_bytes` = full `Y.encodeStateAsUpdate`, persistence.ts:354-362),
   and a monotonic `hocuspocus_ydoc_counters` (persistence.ts:336-340).
   `loadDocument` reloads by applying the latest snapshot then replaying
   updates after it (persistence.ts:728-743). Snapshot cadence is
   Hocuspocus's debounced `onStoreDocument` gated on the latest contiguous
   applied seq (`services/hocuspocus/src/hooks.ts:623-633`). NOTE: there is
   no update-log compaction — snapshots accumulate and old update rows are
   never trimmed. The engine driver must add the compaction the legacy stack
   skipped.
2. **The Y.Doc <-> markdown roundtrip already exists and is reusable.**
   `services/hocuspocus/src/import-export.ts` holds `markdownToYDoc`
   (import-export.ts:39, seeds a Y.Doc `body` XmlFragment from parsed Tiptap
   JSON), `yDocToMarkdown` (import-export.ts:67), and `getDohcYDocMeta`
   (import-export.ts:85, frontmatter + `contentKind`), on a `DOHC_V2` schema
   (`DOHC_V2_SCHEMA_VERSION = 1`, import-export.ts:20). The custom markdown
   nodes live in `dohc-markdown-extensions.ts` (dohcMarkdownExtensions,
   line 444). The desktop editor binds the same `body` field.
3. **The projection is already a debounced markdown write.** Hocuspocus's
   `ProjectionWorker` (`services/hocuspocus/src/projection.ts:27-127`)
   debounces (500ms, projection.ts:33), calls `yDocToMarkdown`
   (projection.ts:64), and writes the body cache through the ACL
   (`setAtomBodyCache`). The desktop equivalent already writes the settle to
   disk through the engine bridge (`writeWorkspaceText`,
   `apps/desktop/src/renderer/collab/useCollabDoc.ts:113`, debounced 800ms,
   useCollabDoc.ts:44).
4. **The editor already binds Tiptap Collaboration to a `body` XmlFragment.**
   `MarkdownEditor` loads the Collaboration extension only when
   `props.collab?.ydoc` exists (MarkdownEditor.tsx:1456-1462) and configures
   it against `{ document: collabYDoc, field: "body" }`
   (MarkdownEditor.tsx:1107-1113), swapping `COLLAB_STARTER_KIT` for
   `LOCAL_STARTER_KIT` (MarkdownEditor.tsx:1104). The provider is the only
   Hocuspocus-specific piece (`new HocuspocusProvider({...})`,
   useCollabDoc.ts:196-245). Replacing that provider is the whole editor
   change.
5. **The engine content model already has a driver dimension.** Snapshots and
   moments carry `content_kind` (`text`/`binary`,
   `packages/workspace-engine/src/engineDbSchema.ts:305-317`), added as a
   lazy-additive column; binary bytes live in `binary_blobs`
   (engineDbSchema.ts:62-68) keyed by sha256, addressed exactly like text
   blobs. A Y.Doc update is a `Uint8Array` — it stores as a `binary_blobs`
   row for free, and replicates for free (0P treats content-addressed blobs
   as idempotent, `2026-07-06-think-bigger-0p-sync-design.md`).
6. **The op log already fast-forwards and dedups per origin.** Every op is a
   `SyncReplicationEnvelope` carrying `(workspaceId, originId, originSeq,
   opKind, payload, recordedAtMs)` (engine.ts:386-396); the op-kind union is
   at engine.ts:211-226. Apply is idempotent (`originSeq <= ackedSeq` skipped)
   with a strict per-origin contiguity gate (versionedTextStore.ts:
   4606-4635). `ydoc.update` slots into this union with no new transport.

Consequence: G2-B is mostly a port (storage + projection + provider); G2-C is
one new op kind plus an ephemeral awareness channel over the existing relay.

## Storage model

### The driver's canonical state

A rich doc is a `file_objects` row like any other file. What makes it a rich
doc is a per-object driver marker plus a Y.Doc update log. Three lazy-
additive tables (the `active_versions` / `binary_blobs` upgrade pattern,
engineDbSchema.ts:50-68 — created on open, no schema-version bump, older
readers ignore them), all filed under `(workspace_id, version_id,
object_id)` because versions are independent content lines:

```
ydoc_docs          -- marks an object as Y.Doc-driven, holds head pointers
  workspace_id, version_id, object_id  (PK)
  content_kind       -- 'richdoc' | 'plaintext' (matches source-kind.ts)
  head_update_seq    -- highest applied update seq for this (version,object)
  head_snapshot_seq  -- seq the latest snapshot covers
  updated_at_ms

ydoc_updates       -- append-only per-doc update log (Hocuspocus's shape)
  workspace_id, version_id, object_id, seq  (PK)
  update_blob_sha256 -> binary_blobs(sha256)   -- the Yjs update bytes
  actor_origin_id    -- which origin produced it (local or a peer)
  recorded_at_ms

ydoc_snapshots     -- periodic compacted full state (encodeStateAsUpdate)
  workspace_id, version_id, object_id, up_to_seq  (PK)
  snapshot_blob_sha256 -> binary_blobs(sha256)
  state_vector_blob_sha256 -> binary_blobs(sha256)
  recorded_at_ms
```

Update and snapshot bytes are content-addressed in the existing
`binary_blobs` table (engineDbSchema.ts:62-68). This is the load-bearing
reuse: it makes Y.Doc state replicate through the identical blob-have/blob-
put path the 0P relay already ships (`syncRelay.ts`), with dedupe for free.

### Relationship to the text snapshot / moment model

The Y.Doc log does NOT replace the text store for this object — it sits
beside it. The rich doc still has a `snapshots` row whose `text` is its
**markdown projection**, plus `moments` recording each settle point. So
`engine.db` holds two coherent views of the same object:

- The **Y.Doc** (`ydoc_updates` + `ydoc_snapshots`): canonical while live,
  fine-grained, CRDT-mergeable.
- The **markdown snapshot** (`snapshots.text` + `moments`): the projection;
  canonical while closed; always the searchable/exportable/restorable/
  diffable artifact, and the durable content of record.

`content_kind` on the `snapshots`/`moments` rows stays `text` (the markdown
IS text — it must remain searchable and diffable, unlike `binary`). The
`ydoc_docs.content_kind` marker is the driver dimension: it tells the engine
"this text file's canonical write source is a Y.Doc, project don't patch"
(Refined Default 1, line 181). A file with no `ydoc_docs` row is an ordinary
text file — no behavior change for the 99% case.

### Version switch / restore / merge against a live Y.Doc

The Y.Doc is a CRDT: it converges within one update history but has no
shared ancestry across independent version lines or across a restore that
replaces state. So reconciliation reuses two rules already in the codebase.

- **Version switch.** The active version is per-machine local state, never
  replicated (`0p-sync-design.md`; `active_versions`, engineDbSchema.ts:50).
  A live session binds one `(version, object)` Y.Doc. Switching the active
  version is a **closed-session boundary**: the driver settles the current
  Y.Doc to its markdown (a moment), tears the session down, and — if the
  target version is opened for editing — seeds a fresh Y.Doc from the
  target's markdown snapshot (via `markdownToYDoc`) or resumes the target's
  own `ydoc_updates` if it has a live-cached log. Never two live Y.Docs for
  two versions of one object at once.
- **Restore into a live Y.Doc.** Restore writes a markdown snapshot through
  the normal write path (an engine moment, metadata origin `restore`). To
  the live Y.Doc it is an EXTERNAL edit, handled by the existing reconcile
  logic (`reconcileExternalEdit`, collabSession.ts:126-164): three-way merge
  the restored markdown into the doc against the last-materialized base, or,
  on overlap, preserve both — a `<path>.conflict` projection plus a P0D
  conflict row. The next settle's base is advanced by the merge, so the
  restore is never silently overwritten (WS-G2 coexistence rule 3).
- **Cross-version merge.** Two versions' Y.Docs share no update ancestry, so
  the CRDT cannot auto-merge them. Merge operates on the PROJECTIONS: an
  engine-owned three-way `mergeMarkdown` (a parallel lane is moving this into
  the engine/core; this design assumes engine-owned text merge and does not
  depend on `workspace-history`) produces merged markdown that seeds the
  target's Y.Doc via `markdownToYDoc`. On overlap, preserve base/current/
  incoming — the P0D conflict shape (`conflicts` table, engineDbSchema.ts:
  532-581) unchanged. This is the "reconcile where the CRDT can't auto-merge
  across versions" rule made concrete.

## Projection: Y.Doc <-> markdown, and the handoff rule

### When the file is written

The settled markdown file is written on **quiesce** — the same settle-point
predicate the shipped model uses (`shouldMaterialize`, collabSession.ts:
51-75): the doc has content not yet on disk AND a trigger fired (debounce
elapsed, session closing, or explicit save). The write goes through the
normal engine write path (`writeTextFile`) with metadata origin
`local-file`; capture sees a normal file write and records an engine moment,
exactly as it does for the legacy path today (`writeWorkspaceText`,
useCollabDoc.ts:113; WS-G2 finding 4). Engine history of a live-session doc
is therefore the history of settle points, not keystrokes — accepted and
documented (WS-G2 coexistence rule 2), the coalescing Refined Default 5
wants.

Self-write suppression is unchanged: the settle records the sha it wrote, so
the watcher event for that content is recognized as our own and not folded
back (`isSelfMaterializedWrite`, collabSession.ts:104-109).

### Round-trip fidelity

The projection uses the salvaged `yDocToMarkdown` / `markdownToYDoc`
(import-export.ts:67/39) plus `dohcMarkdownExtensions`. What survives the
round trip: all markdown structure the Tiptap schema serializes — headings,
lists, tables, code, the custom dohc nodes (query fences, wikilinks). What
is LOSSY across the file projection: live suggestion threads (relative-
position anchors from `suggestions.ts`), non-serialized marks, and any Y.Doc
state with no markdown surface. This is acceptable because the file is the
product's durable artifact everywhere else — but fidelity must be measured
early (see Risks and user question 1). The G2-B fidelity harness (below)
round-trips a corpus and asserts a bound.

### The handoff rule (never two canonical at once)

The invariant, extended from WS-G2: at any instant a rich doc has exactly
one canonical source, and every flip is a defined handoff at a session
boundary.

- **Closed (default): the markdown file is canonical.** The Y.Doc log is
  dormant history — a fast-resume cache, not authority. If it were discarded,
  reopening reseeds from the file with zero loss.
- **Live (session open): the Y.Doc is canonical; the file is its
  projection.** Open seeds/resumes the Y.Doc; the engine records settles as
  ordinary moments. It does NOT gain authority — it records materializations
  the way it records agent writes.
- **Flip file -> Y.Doc happens on session OPEN.** Seed from the current
  markdown snapshot (re-project and trust the file, never a stale cache).
- **Flip Y.Doc -> file happens on session CLOSE**, via the `session-close`
  settle trigger (collabSession.ts:49): the file equals the final Y.Doc
  state before teardown, so there is no window where both disagree with
  neither live.
- **Delete/rename with a live doc** reuses the existing rescue path
  (`resolveFileLifecycle`, collabSession.ts:180-200): `.recovered` on delete
  with unmaterialized content; follow-rename otherwise.

## Editor integration

### Solo first (single-writer, local)

The editor keeps its current shape: `MarkdownEditor` binds Collaboration to
`collab.ydoc` on field `body` (MarkdownEditor.tsx:1107-1113). The ONLY change
is the provider. Today `useCollabDoc` constructs a `HocuspocusProvider`
(useCollabDoc.ts:196-245) that syncs the local Yjs doc to a websocket. G2-B
replaces it with an **engine provider**: an in-process object that

- on open, loads `ydoc_snapshots` head + `ydoc_updates` after it from
  `engine.db` (via IPC) and `Y.applyUpdate`s them into the local doc — the
  same reload shape as `persistence.ts:728-743`;
- subscribes to the doc's `update` event and appends each update to
  `ydoc_updates` (content-addressed into `binary_blobs`) via IPC, single-
  writer, no network;
- drives the debounced settle to `writeTextFile` (the projection) exactly as
  the shipped materialization effect does (useCollabDoc.ts:312-334).

No token, no `collabToken` IPC, no server. `enabled: synced && ydoc !== null`
(useCollabDoc.ts:339) becomes `enabled` as soon as the engine load resolves —
solo has no "connecting" latency. Awareness for a solo doc is a no-op (one
local client).

Open question 2 asks whether solo even needs the Y.Doc at all before multi-
user exists (it may stay plain autosave until G2-C). The driver is designed
so solo-on-Y.Doc is a small increment either way.

### Multi-user (single change from solo)

The multi-user editor is the solo editor plus replication: the same local
Yjs doc, the same engine provider, but each local update ALSO journals as a
`ydoc.update` op (below) and remote `ydoc.update` ops are `Y.applyUpdate`d
into the live doc as they arrive. Awareness binds to the ephemeral channel
instead of a no-op. The editor code does not branch on solo-vs-multi; the
provider does.

## Multi-user replication (G2-C)

FLAG: everything in this section is G2-C, gated on G2-B landing plus the
0P-B relay. G2-B ships solo-only.

### The `ydoc.update` op kind

Add `ydoc.update` to `SyncReplicationOpKind` (engine.ts:211-226) with payload

```
YDocUpdatePayload {
  versionId, objectId,
  updateBlobSha256    -> binary_blobs(sha256)   -- the Yjs update bytes
}
```

carried in the standard envelope with `(originId, originSeq, recordedAtMs)`
(engine.ts:386-396) like every op. It journals through
`journalLocalReplicationOp` (syncReplication.ts:92-110) and replicates
through the existing relay push/fetch (`pushWorkspaceToRelay`,
syncRelay.ts:367-438; `pullWorkspaceFromRelay`, syncRelay.ts:552+) with the
update bytes shipped as a content-addressed blob via blob-have/blob-put — no
new transport, no new route.

### Why it needs none of the P0D conflict machinery

`moment.append` carries `before_latest_moment_id` and takes the head-check /
divergence path: fast-forward if heads match, else open a P0D conflict
(0p-sync-design.md, "Applying a remote moment"; versionedTextStore.ts head
logic). `ydoc.update` is different in kind: Yjs updates are **commutative
CRDT deltas**. Applying them in any order converges to the same state, and
applying one twice is a no-op. So the apply dispatch
(syncApply.ts:339-360; per-store switch at versionedTextStore.ts:4639+) gets
a branch that:

1. verifies the update blob is present (hydrated before the write txn like
   every op, syncApply.ts:267-296),
2. `Y.applyUpdate`s it into the doc's accumulated engine state (append to
   `ydoc_updates`, advance `head_update_seq`),
3. re-projects markdown and writes a settle moment so file/search/history
   stay coherent.

No head check, no conflict row, no `before` guard — convergence is
guaranteed by Yjs semantics, not by the log. The op-log's per-origin
contiguity + `acked_seq` dedup (versionedTextStore.ts:4606-4635) still
applies unchanged: a `ydoc.update` at or below the origin's high-water mark
is skipped, so re-import is a no-op at the log level, and CRDT idempotence is
the backstop if it ever isn't.

A live co-edit therefore produces BOTH fine-grained `ydoc.update` ops (the
CRDT truth) AND periodic coarse `moment.append` settle points (the markdown
history) — WS-G2 coexistence rule 2: engine history is settle points, the
CRDT log is the keystroke truth.

### Awareness (ephemeral, never an op)

Presence/cursors/selections are ephemeral and MUST NOT enter
`replication_log` — they are not durable canonical state, and persisting them
would bloat the append-only log forever (0P Risk 2). Awareness rides a
separate non-durable channel over the SAME relay transport (0P-B): a
pub/sub/broadcast endpoint (e.g. `POST/GET /sync/:ws/awareness` or a
websocket upgrade on the relay) that fans out Yjs awareness updates and drops
all state on disconnect. This mirrors the shipped provider's awareness use
(`provider.awareness`, useCollabDoc.ts:255-271) but detached from the durable
op log. If the awareness channel is down, editing continues; only presence
degrades.

### Low-latency co-editing is faster fan-out, not a new model

The polled relay pull (`pullWorkspaceFromRelay`) suits file sync but is too
slow for keystroke-latency co-edit. G2-C's latency path is a relay PUSH of
the same `ydoc.update` ops (fan out to connected origins instead of waiting
for their next poll) — a transport optimization over identical data, the last
G2-C increment. The data model does not change; convergence still rides Yjs.
This is the WS-G2 promise: "low-latency co-editing then needs only a faster
fan-out of the same ops."

## Hocuspocus retirement

### What gets deleted when G2-B/C land

- The whole `services/hocuspocus` service and its Postgres persistence
  (`persistence.ts` tables `hocuspocus_ydoc_updates/_snapshots/_counters/
  _projection_jobs/_semantic_operations`, projection worker, hooks, ACL,
  admin, server entrypoint).
- The collab-token route in the reduced workspace-api
  (`POST /workspaces/:id/collab/token`, `services/workspace-api/src/
  server.ts:29`) and the desktop `collabToken` IPC handler
  (`apps/desktop/src/main.ts:1892`).
- The Hocuspocus provider in the renderer: `useCollabDoc`'s
  `HocuspocusProvider` construction + token refresh + websocket awareness
  (useCollabDoc.ts:181-293), and the `@hocuspocus/provider` dependency. The
  canonical-state logic in `collabSession.ts` STAYS (reused by the engine
  provider); only the transport is deleted.

### What gets salvaged (not deleted)

- `import-export.ts` (`markdownToYDoc`/`yDocToMarkdown`/`getDohcYDocMeta`) and
  `dohc-markdown-extensions.ts` — the projection core, moved to a shared/
  engine-adjacent module both the driver and editor import.
- `doc-name.ts` encoding (doc-name.ts:6-30) if a stable doc identity is still
  wanted for the awareness channel; the engine's `(workspaceId, objectId)`
  can replace it.
- `suggestions.ts` / `semantic-api.ts` — anchored-edit and programmatic-edit
  surfaces; re-home onto the engine Y.Doc if those features survive
  (user question 3).
- Auth shape: already salvaged. The relay mounts the same better-auth device
  flow the collab token used (0p-sync-design.md, "Transport and server"); the
  execution log records the collab/membership auth moving to the sync relay.

### Migration / coexistence: cutover at a closed-session boundary

Reuse WS-G2 coexistence rule 5 verbatim. During G2-B, dual-run: Hocuspocus
still serves cloud shared docs; the engine driver serves solo local docs.
Nothing shares a canonical source across the two — a cloud doc is Hocuspocus-
canonical, a local doc is file-or-engine-Y.Doc-canonical.

At G2-C cutover, a cloud doc migrates by: (i) admin-disconnect the Hocuspocus
doc (`admin.ts` `RevocationRegistry`) so no session is live; (ii) re-project
its Y.Doc to markdown and verify it equals the settled file (don't trust the
`atoms.body` cache — the "separate timelines" gap); (iii) seed the engine
driver's Y.Doc from the settled FILE via `markdownToYDoc`, NOT from the
Hocuspocus update log (the file is the durable artifact); (iv) record a
migration moment. A mismatch at (ii) preserves both (file plus an exported
`<path>.hocuspocus.md`) and surfaces a conflict. Never migrate a live doc;
never leave both stores writable for the same doc. Legacy update history is
not migrated (User Decision 6).

## Milestones

### G2-B — Y.Doc engine content driver (solo, single-machine)

Depends on 0P-A (the journal + blob discipline) for the storage reuse; does
NOT depend on the relay.

- **G2-B1 — Engine Y.Doc storage + driver.** The three lazy-additive tables,
  update-append/snapshot-write/reload API (Hocuspocus's load+replay shape),
  and snapshot cadence WITH the compaction the legacy stack skipped (snapshot
  on a threshold of accumulated updates; drop `ydoc_updates` below the
  snapshot's `up_to_seq`). Test gate: N updates persist and reload to a
  byte-identical Y.Doc state vector; snapshot compaction round-trips; a
  reload after compaction equals a reload before it.
- **G2-B2 — Markdown projection + capture integration.** `yDocToMarkdown`
  settle on quiesce -> `writeTextFile` moment; `markdownToYDoc` seed on open;
  self-write suppression; the fidelity harness (round-trip a corpus, assert a
  bound). Test gate: a settle produces exactly one engine moment; search and
  export see the projection; the fidelity corpus round-trips within bound;
  restore-into-live folds via three-way or rescues to `.conflict`.
- **G2-B3 — Editor binding for solo.** The engine provider replacing the
  Hocuspocus provider; `MarkdownEditor` bound to the engine-backed Y.Doc,
  single-writer. Test gate: solo edit -> close -> reopen preserves rich
  structure; version switch settles + reseeds (no double-canonical); no
  Hocuspocus, no token, no network touched (asserted).
- **G2-B4 — Driver behavior matrix + tests.** Declare the Refined Default 7
  matrix for the driver: snapshot (Y.Doc snapshot), diff (projected
  markdown), merge/conflict (cross-version = projection three-way + P0D
  preserve-both), search/export (over the projection), restore (seed Y.Doc
  from a moment's markdown), recovery (`.recovered`). Test gate: the matrix
  E2E, each behavior exercised once.

Exit: a rich doc is engine-Y.Doc-canonical while live and file-canonical
while closed, entirely offline, with no Hocuspocus in the loop for local
docs.

### G2-C — Replicated co-editing + Hocuspocus retirement

Depends on G2-B + 0P-B (the relay).

- **G2-C1 — `ydoc.update` replication.** The op kind, the commutative apply
  branch (no head check), journaling, re-projection, relay push/fetch
  carrying update blobs. Test gate: two engines converge via a `ydoc.update`
  round trip (identical Y.Doc state vector, different local `moment_order`
  allowed); concurrent edits to one doc converge with NO conflict rows;
  re-import is a no-op; a property/fuzz test over random update interleavings
  asserts convergence.
  - **DURABLE-RESUME LIFECYCLE (gate-fix correction).** A replicated doc
    (`createYDocEngineDriver({ replicated: true })`) is ONE durable lineage:
    seed + emit the BASE op EXACTLY ONCE on first creation, then ALWAYS resume
    the persisted CRDT on reopen (never re-seed from markdown — a fresh
    `markdownToYDoc` mints new Yjs ids and a second base op, which duplicates on
    a peer's replay), and NEVER prune the CRDT on close (keep it durable for the
    next resume and for peers). Prune-on-close + reseed-on-open + NO journaling
    stays ONLY for `replicated: false` LOCAL-ONLY docs (§markdown-is-the-artifact
    for the solo case). The §"discarded resume cache, reopen reseeds from file
    with zero loss" note above applies ONLY to a local-only doc — a replicated
    doc's CRDT is durable canonical state, not a discardable cache. Additional
    invariants: (a) apply REJECTS a `ydoc.update` whose path is occupied by a
    different object (or whose object sits at a different path) — no
    write-through the wrong file; (b) a remote update applied while a session is
    LIVE is routed into the in-memory Y.Doc (process-global live-doc registry) so
    close settles the converged state, not a stale one; (c) `recordUpdate` caps
    an update at `MAX_VERSIONED_BINARY_FILE_BYTES` before storing/journaling.
- **G2-C2 — Awareness + relay push.** The ephemeral awareness channel
  (pub/sub, never journaled) and relay push fan-out for low-latency co-edit.
  Test gate: presence appears and clears on disconnect; awareness is provably
  absent from `replication_log` and from bundles; a co-edit latency budget
  under push; awareness-channel-down still allows editing.
  - **Editor provider — reserved remote-apply origin (contract from G2-C1).**
    A remote `ydoc.update` applied into a LIVE in-memory doc is applied with the
    reserved transaction origin `REMOTE_YDOC_APPLY_ORIGIN` (exported from
    `@dohc/workspace-engine`; defined in `liveYDocRegistry.ts`). The G2-C2
    editor provider observes `doc.on("update", (u, origin) => …)` to journal
    LOCAL edits via `recordUpdate`, and it **MUST** skip any update whose
    `origin === REMOTE_YDOC_APPLY_ORIGIN`. That update is a remote op the store
    already persisted + journaled + acked in `applyReplicationOp`; re-journaling
    it under the local origin would echo it back to every peer (an echo storm).
    Editor/local edits carry a null/editor origin and ARE journaled.
  - **External edits as CRDT deltas (contract from G2-C1).**
    `YDocSession.applyExternalMarkdownEdit` currently REJECTS on a replicated
    doc (its merge branch reseeds via a fresh `markdownToYDoc`, forking the
    lineage). G2-C2 must implement restore/agent external edits for replicated
    docs as CRDT DELTAS applied to the live doc (diff the incoming markdown into
    the existing Y.Doc, emit an ordinary `recordUpdate`) so the single lineage is
    preserved — never a reseed + second base.
- **G2-C3 — Hocuspocus retirement.** Delete the service + provider + token
  route; ship the closed-boundary migration tool. Test gate: a cloud doc
  migrates at a closed boundary (file == re-projection verified, else
  preserve-both); co-editing works engine-native with no Hocuspocus
  reachable; the collab-decoupling E2E still green.

## Risks

1. **Projection fidelity gates the whole design.** File-canonical-while-
   closed means anything `yDocToMarkdown` drops is lost on every close, not
   just at migration. Suggestion threads and non-serialized marks are the
   known lossy corners. Mitigation: G2-B2 measures fidelity on a corpus
   before the editor binds; user question 1 decides whether lossy state must
   survive (which would grow the driver a Y.Doc-level sidecar).
2. **New writer surface on the riskiest path.** The engine provider rewrites
   the editor save path. Mitigation: `collabSession.ts` canonical logic is
   reused unchanged (already security-reviewed); the provider is the only new
   code; G2-B3 pins restore/switch/reopen before any multi-user exists.
3. **Update-log growth.** `ydoc_updates` is append-only like Hocuspocus's,
   which never compacted. Mitigation: G2-B1 ships compaction as a gate item,
   not a follow-up. Relay-side growth is the same 0P Risk 2, bounded by the
   same GC-before-GA framing.
4. **CRDT determinism across the projection boundary.** Two machines must
   project the same Y.Doc state to the same markdown or their `moment.append`
   settle history diverges cosmetically. Mitigation: `yDocToMarkdown` is
   deterministic; G2-C1's convergence fuzz asserts identical projections, not
   just identical Y.Doc state.

## Open questions for the user

1. **Is markdown-file fidelity sufficient as the durable rich-doc artifact,
   or must full Y.Doc state (suggestion threads, marks) survive a close?**
   File-canonical-while-closed drops whatever the projection loses on EVERY
   close. If suggestion threads must persist, G2-B grows a Y.Doc-state sidecar
   (keep `ydoc_snapshots` as durable-not-just-cache) and the "file is
   canonical when closed" rule softens to "file is canonical, Y.Doc snapshot
   is an authoritative attachment." Recommendation: markdown is sufficient at
   alpha — the file is the durable artifact everywhere else — with the
   sidecar as a named follow-up if suggestions ship.

2. **Does solo need the engine Y.Doc before multi-user exists, or does solo
   stay plain autosave until G2-C?** WS-G2 (a) already gives solo a good local
   editor with file-moment history and zero Y.Doc. Building solo-on-Y.Doc in
   G2-B buys the driver's storage/projection proof and a uniform editor path,
   but no user-visible payoff until co-editing lands. Alternative: G2-B ships
   storage + projection + tests but leaves the editor on plain autosave, and
   G2-C flips the editor to the engine provider when it also turns on
   replication. Recommendation: build storage + projection in G2-B (they are
   the risk), but defer the editor-provider swap to G2-C so it changes once.

3. **Do the Hocuspocus semantic surfaces (`suggestions.ts`,
   `semantic-api.ts`) re-home onto the engine Y.Doc, or retire with the
   service?** They are real capabilities (anchored AI edits, programmatic doc
   edits) with no engine equivalent yet. Re-homing them is extra G2-C scope;
   retiring them is a feature cut. Recommendation: retire at cutover and
   re-home only if usage warrants — the engine's own agent-write path plus
   the linked-chat rail cover most of the "AI edits a doc" need without
   relative-position anchoring.
</content>
</invoke>
