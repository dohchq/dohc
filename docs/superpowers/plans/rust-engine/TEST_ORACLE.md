# TEST_ORACLE.md — trace format, normalizers, named fault points, crash tiers, anti-weakening

> Program-control document (review tier: Codex + local Claude; plan-content
> changes need Ice's sign-off). Owned by shard R01-ORACLE.
>
> Status: v1, 2026-07-16. Consumed by every test-port shard, the differential
> harness, R04's storage testkit, and the reviewer-packet builder
> (`tools/rust-engine-program/build-reviewer-packet.mjs`).
>
> Grounding: every hook and crash-state mapping below was verified against the
> repo source on 2026-07-16 (file:line cited inline). Where this document and
> the Rev 2 plan disagree on a line number, this document is the corrected one.

The oracle contract in one paragraph: a **trace** is a deterministic,
replayable JSON-lines program of engine operations, injected faults, restarts,
and comparison checkpoints. The TS engine (pre-cutover reference) and the Rust
engine each execute the same trace through their `EngineTestAdapter`; the
harness compares **normalized** state at every `compare` record. Operation
vocabulary comes from `BEHAVIOR_INVENTORY.tsv` — the trace format adds nothing
the inventory does not name. Fault vocabulary comes from the registry in
section 3 — no test may invent an ad-hoc pause/crash mechanism once its family's
named point exists.

---

## 1. Operation trace format

One JSON object per line (JSON-lines; UTF-8, `\n` line endings, no BOM).
`traceVersion` is bumped on any breaking change to this section; harnesses
refuse unknown versions. Field order in examples is illustrative — JSON key
order is not significant, but any trace file that is content-addressed or
diffed must be written with sorted keys.

### 1.1 Record types

Every record has `"t"` (type). Types: `header`, `fs`, `state`, `op`, `fault`,
`clear-faults`, `restart`, `kill`, `compare`, `note`.

#### `header` (exactly one, first line)

```json
{"t":"header","traceVersion":1,"traceId":"tr-20260716-000042",
 "seed":424242,
 "clock":{"epochMs":1700000000000,"stepMs":10},
 "idScheme":"seeded-counter-v1",
 "workspaces":[{"workspaceId":"workspace-a","generation":1,
                "rootFixture":"fixtures/basic-md","replicated":false}],
 "actors":[{"actorId":"user-1","kind":"user","caps":["read","write","versions","secrets"]},
           {"actorId":"agent-1","kind":"agent","caps":["read","write"]},
           {"actorId":"editor-x","kind":"external-editor","caps":["fs-write"]},
           {"actorId":"peer-b","kind":"remote-peer","caps":["replicate"]}],
 "normalizers":"docs/superpowers/plans/rust-engine/TEST_ORACLE.md#2-normalizers",
 "minimizedFrom":null,
 "engines":["ts","rust"],
 "tier2":false}
```

- `seed` — single integer seeding *all* nondeterminism the harness owns:
  the clock schedule, the ID generator, fuzz choices, relay fault schedules.
  Replaying the same trace file with the same seed is byte-deterministic at
  the normalized-comparison level.
- `clock` — deterministic clock: `nowMs()` starts at `epochMs` and advances
  `stepMs` per call (the retrofitted `nowMs` option on every store —
  see `DETERMINISM_AUDIT.tsv`). Traces may also advance time explicitly via
  `{"t":"note","advanceClockMs":N}` for staleness/retention scenarios.
- `idScheme` — `seeded-counter-v1`: generated IDs are
  `<kind>-<seed>-<counter>` per kind, injected through the stores'
  `createId`/`createRunId`/`createMomentId` options. IDs that remain
  non-injectable after the R01-DETERMINISM retrofit are handled by
  normalizer N5, never by fuzzy matching.
- `workspaces[].generation` — the session generation the trace starts at
  (integer ≥ 1); `open()` initializes the workspace actor at exactly this
  generation (section 6) and `restart` records increment it. Ops carry the
  generation they expect so a stale-generation response is a trace failure,
  not a silent repaint (mirrors the repo's workspace/request-token invariant).
- `actors` — capability fixtures. `kind` ∈
  `user | agent | external-editor | remote-peer | system`. The adapter maps
  actor kind onto the engine's write-metadata origin (the
  `localFileWrite`/`apiWrite`-style metadata the current tests use) and onto
  policy/lock/turn-gate identity. `external-editor` actors may only issue
  `fs` records (they write files, never call the engine API).
  **Caps are expectations, never grants (normative).** Authorization is
  derived engine-side from the actor's registered identity, workspace
  membership, and policy, exactly as in production (repo invariant:
  authorization is derived server-side; a caller never supplies its own
  authority) — a trace cannot mint capability. Each behavior's required
  scope comes from the inventory's `security_class` column. An `op` issued
  by an actor lacking the required capability MUST carry
  `expect: {"outcome":"error","code":"forbidden"}` (or the behavior's
  documented scoping error, e.g. `workspace-mismatch`); a trace expecting
  success for such an op fails validation before any engine runs, and an
  engine that accepts the op fails the differential run — authz parity is
  asserted, not assumed.
- `normalizers` — pointer to the committed normalization rules in force
  (this document, section 2). A trace is invalid without it.
- `minimizedFrom` — for minimized replays of a failing fuzz/soak run: the
  original trace ID (and, by convention, the original file at
  `traces/failed/<traceId>.jsonl`). `null` for hand-written traces. Every
  nondeterministic failure MUST persist seed + minimized trace (stop-the-line
  rule "Nondeterministic failure without saved seed/trace").
- `engines` — which engines the trace runs on (default `["ts","rust"]`).
  `["rust"]` marks a Rust-only trace, **required** whenever any expectation
  in the trace depends on a fault the TS engine cannot express (`crash` or
  `error` action at a G point): skipping just the fault record would leave
  the two engines with contradictory `expect` values, so such traces must
  not claim to be differential. Rust-only traces are self-consistency
  evidence, same honesty rule as tier 2.
- `tier2` — `true` marks a trace containing `kill` records; the TS adapter
  refuses tier-2 traces honestly (section 4). `tier2: true` implies
  `engines: ["rust"]`.

#### `fs` — filesystem precondition / external edit

```json
{"t":"fs","actor":"editor-x","op":"write","workspaceId":"workspace-a",
 "path":"notes/today.md","contentUtf8":"External edit\n"}
```

`op` ∈ `write | delete | mkdir | rename | chmod | symlink`. Binary content
uses `contentBase64`. Paths are workspace-root-relative, forward slashes.
`fs` records before the first `op` establish disk preconditions; `fs` records
mid-trace model external editors/agents racing the engine (the capture path
must observe them per its watcher/reconcile contract — but see the trace
boundary note in 1.3).

`symlink` records (normative): `target` is required and explicit. A target
that resolves inside the fixture workspace root is created as-is. A target
that resolves outside it MUST set `"escapesRoot": true` — the harness then
creates the target only inside a harness-owned scratch sibling directory
(never a real user path; the shadow-fence denylist applies) and the record
exists precisely to *prove containment*: the engine contract is that
capture, scan, and materialization never follow a link out of the workspace
root (the existing containment-sandwich guards in
`workspaceEngineCapture.ts`/`shareMounts.ts`), so the trace asserts the
external content is never read, indexed, or written through. A `symlink`
record without `escapesRoot` whose target escapes the root fails trace
validation.

#### `state` — constructed engine-state precondition (logical rows)

```json
{"t":"state","workspaceId":"workspace-a","corrupt":true,
 "edit":{"table":"snapshots",
         "set":{"path":"../escape.md"},
         "where":{"workspace_id":"workspace-a","object_id":"object-424242-1"}}}
```

This is the trace-format home of the suite's 148+ raw-SQL *setup* sites
(`rawExec`/`rawCorrupt` in `versionedTextStore.test.ts` etc.). Edits are
expressed as logical row operations (`edit`, `insert`, `delete`, `dropTable`,
`sql` as an escape hatch restricted to the shared v1/v2 logical schema —
decision 3 keeps the logical shapes identical, which is what makes this
portable). `corrupt: true` marks edits that intentionally violate invariants
(the adapter may need to bypass its own foreign-key/validation layer, as
`rawCorrupt` does today by toggling `foreign_keys` off —
`versionedTextStore.test.ts:131`). The adapter applies `state` records only
while the workspace actor is quiesced.

#### `op` — one engine operation

```json
{"t":"op","opId":"op-000007","behaviorId":"versions-write-text-file",
 "actor":"user-1","workspaceId":"workspace-a","sessionGeneration":1,
 "params":{"versionId":"main","path":"notes/today.md","text":"Hello\n"},
 "idempotencyKey":"op-000007","retryOf":null,
 "expect":{"outcome":"ok"},
 "events":[{"kind":"moment.created"}]}
```

- `behaviorId` — MUST be a `behavior_id` from `BEHAVIOR_INVENTORY.tsv`.
  **The trace vocabulary IS the behavior inventory** (all 229 rows;
  52 critical / 63 high). Params are the behavior's `io_contract` inputs with
  workspace/actor/clock/id concerns lifted into the envelope. A trace using an
  unknown `behaviorId` fails validation before any engine runs.
- `idempotencyKey` — defaults to `opId`. `retryOf` names a prior `opId` this
  op retries (same key); the expected outcome of a retry is dictated by the
  inventory row's `ordering_idempotency` column — e.g. a retried
  `versions-write-text-file` after a crash-before-ack must be exactly-once
  (no duplicate moment, no duplicate journal entry). Behaviors the inventory
  flags as **not** currently idempotent (`versions-resolve-text-conflict`
  keep-current re-resolve, `secrets-fork-version` re-journal —
  `INVENTORY_NOTES.md` versions/secrets clusters) get traces asserting
  today's TS behavior, plus a `BEHAVIOR_DELTA.md` entry if Gate 0 approves
  fixing them in Rust.
- `expect` — `{"outcome":"ok"}`, `{"outcome":"error","code":"state-corrupt"}`
  (stable machine error codes only — never message text), or
  `{"outcome":"crashed"}` when a `fault` with `action:"crash"` is armed for
  this op. Optional `result` subsets assert response fields (post-
  normalization).
- `events` — expected emitted events for this op, in order, compared after
  normalization (N7).

#### `fault` / `clear-faults` — arm a named fault point

```json
{"t":"fault","point":"storage.before-persist","action":"error",
 "errorKind":"env.disk-full","scope":{"opId":"op-000008"},"armAfter":0}
{"t":"fault","point":"materialize.before-preimage-revalidate","action":"error",
 "errorKind":"env.sharing-violation-transient","errorArgs":{"count":5}}
{"t":"fault","point":"sync.between-apply-and-cursor-commit","action":"crash",
 "scope":{"behaviorId":"relay-pull-workspace"}}
{"t":"clear-faults"}
```

- `point` — MUST name a registry entry (section 3). Unknown points fail
  validation.
- `action` ∈ `crash` (terminate the engine at the point — in-process
  simulated for TS, real abort for the Rust sidecar testkit), `error` (raise
  the typed error `errorKind` at the point), `pause` (hold at the point until
  `{"t":"note","release":"<point>"}` — for interleaving/race traces),
  `observe` (record that the point was reached; the harness asserts
  reached/not-reached counts).
- `scope` — restricts the arm to a matching `opId` or `behaviorId`;
  `armAfter` skips N traversals first. An armed `crash` fault consumes itself.
- `errorArgs` — optional parameters for the injected `errorKind`, validated
  per kind against the registry (section 3.10): `env.sharing-violation-transient`
  takes `{"count": n}` (consecutive failing probes, default 3; `n ≥ 5`
  exercises the fail-closed terminal). Kinds with no declared parameters
  reject a non-empty `errorArgs`. The adapter's `FaultSpec` (section 6)
  carries the same field.
- `optionalFor` — optional array of engine IDs; the only allowed value at
  `traceVersion` 1 is `"ts"` (validation rejects anything else). Semantics:
  the harness may skip this fault record for an engine only if the engine is
  listed here AND its `listFaultPoints()` (section 6) does not report the
  point. For any engine not listed, a missing point fails the run.
  **Validation restricts `optionalFor` to expectation-neutral actions**
  (`observe`, `pause`): skipping those changes no `expect` value, so the
  trace stays differential. A `crash` or `error` fault at a point one engine
  lacks changes downstream expectations — such traces MUST instead set the
  header's `engines: ["rust"]` (Rust-only, self-consistency evidence);
  a `crash`/`error` fault carrying `optionalFor` fails validation. Omitting
  `optionalFor` means the point is mandatory on every engine in `engines`.
- Environmental kinds (`env.*`) and relay fault kinds (`relay.fault.*`) are
  listed in the registry, sections 3.9–3.10.

#### `restart`, `kill`

```json
{"t":"restart"}
{"t":"kill","tier":2,"atMs":null}
```

`restart` = orderly close + reopen of every open workspace/session
(generation increments; old handles invalid). After a `crash`-action fault,
`restart` is how the trace resumes. **Convention (mandatory, from the plan's
test-porting program):** after every differential comparison the trace ends
with `restart` → `compare` → one further mutating `op` → `compare`, proving
the reopened state is writable. `kill` is tier-2 only: SIGKILL /
`TerminateProcess` of the Rust sidecar at a randomized (seeded) moment;
`tier2:true` must be set in the header.

#### `compare`

```json
{"t":"compare","scopes":["db","files","events","search","ydoc","secrets","resources"]}
```

Runs the normalized-state comparison (section 2) between the two engines (or,
post-deletion, against the frozen golden fixture). Scopes:

| scope | compares |
| --- | --- |
| `db` | normalized logical rows of every inventory-touched table (N2, N4–N6) |
| `files` | materialized tree: paths, content hashes, modes (N8) |
| `events` | drained event log since last compare (N7) |
| `search` | search results + visibility for the trace's declared queries (N9) |
| `ydoc` | converged doc-JSON + markdown projection per open/durable doc (N3) |
| `secrets` | decrypted plaintext state + non-leak scan (N1, N10) |
| `resources` | released handles/threads/queues back to baseline (tier-1 subset) |

### 1.2 Storage and provenance

- Committed conformance traces: `crates/dohc-engine-testkit/traces/*.jsonl`
  (fixture-reviewed, Tier 3 review).
- Recorded dogfood traces (the week-one TS trace recorder): local only,
  personal content — same handling rules as the yrs-spike fixtures (never
  committed; anything committed must be synthetic or deterministically
  redacted + secret-scanned with the scan result recorded).
- Failed-run artifacts: seed + minimized trace under `traces/failed/`,
  referenced by `minimizedFrom` in the reduced replay.

### 1.3 Trace boundary (binding)

The trace boundary is the **engine-store API** (per the plan's determinism
retrofit): watcher debounce timing, capture batching timers, and relay retry
pacing are out of oracle scope (`DETERMINISM_AUDIT.tsv` classifies these
`out-of-scope-timer`). A trace models an external edit as an `fs` record
followed by an explicit capture/reconcile `op`
(`desktop-capture-batch`, `desktop-capture-reconcile-disk-into-version`) —
never by waiting for a real debounce.

---

## 2. Normalizers

Committed rules, not prose. The differential harness implements exactly these,
by rule ID; every mismatch report cites the rule that was applied (or that no
rule allowed the difference — which is a stop-the-line mismatch).

- **N1 — secrets: compare decrypted plaintext, never ciphertext.** AEAD
  nonces/IVs and data keys are real randomness on both engines
  (`secretFileStore.ts:247,383` — deliberately non-injectable per
  `DETERMINISM_AUDIT.tsv`). Ciphertext, IV, tag, and wrapped-key columns of
  the secret tables are excluded from `db` comparison; instead the adapter
  decrypts through the engine's own read path and the harness compares
  plaintext, key *identity* (fingerprint), and tip/moment structure.
- **N2 — logical row state, not physical layout.** Comparison reads logical
  rows via the adapter; WAL/page layout, freelist, `sqlite_sequence`,
  rowids, index b-trees, `PRAGMA` state, and file byte size are never
  compared. Row sets are compared order-insensitively under each table's
  declared logical key (its v1 primary key), except tables whose contract is
  ordered (`moments` by order column, replication logs by seq).
- **N3 — Y.Doc: converged content, never update bytes.** Compare
  (a) doc-JSON of the converged document and (b) the markdown projection.
  Never compare update byte streams, state-vector encodings, client IDs, or
  `ydoc_updates` row counts (compaction folds them — two correct engines
  legitimately differ). **Binding constraint from `DECISIONS.md` (yrs spike):**
  doc-JSON serialization sorts nested map keys before comparison or
  content-addressing (yrs re-encode makes nested `Any::Map` key order
  nondeterministic), and comparison operates on the shared declared root
  schema. Projection comparison must account for y-prosemirror's destructive
  normalization via projection provenance — a projection difference with
  identical doc-JSON is a projection bug, not CRDT divergence; report it as
  such.
- **N4 — `ydoc_updates`/`ydoc_snapshots` rows** (both regimes): compared only
  through reconstruction — load persisted doc, then apply N3. For replicated
  docs additionally compare the *logical op stream*: op kinds, origins,
  per-origin sequence numbers, and base-op count (base-once), with update
  payloads compared by post-apply convergence, not bytes.
- **N5 — generated IDs.** With the seeded `createId`/`nowMs` retrofit,
  IDs and timestamps are directly comparable — that is the point of the
  retrofit; no fuzzy ID matching. Residual non-injectable IDs (tracked in
  `DETERMINISM_AUDIT.tsv` until R01-DETERMINISM closes them, e.g.
  `syncReplication.ts:57`, `syncRelay.ts:598`, the seven
  `workspaceEngineCapture.ts` correlation IDs) are normalized by
  **structural substitution**: first occurrence in normalized output is
  canonicalized to `<kind>#1`, second to `<kind>#2`, etc., consistently
  across every column/event that carries the same raw value. Two engines
  match iff the substitution is a bijection.
- **N6 — JSON columns** (`author_json`, metadata summaries, policy blobs):
  parsed and re-serialized with sorted keys, `undefined`/absent and explicit
  `null` distinguished per `PORTING.md`'s mapping, before comparison.
- **N7 — events**: compared as ordered per-workspace sequences of
  `{kind, normalized payload}`; sequence numbers themselves are compared as
  *gapless and ordered*, not for absolute values. Cross-workspace ordering is
  not compared.
- **N8 — files**: content by hash; paths NFC-normalized, forward-slash;
  mode compared as the per-OS documented policy's equivalence classes
  (executable bit on POSIX; nothing on Windows), per
  `LANGUAGE_SEMANTICS_MATRIX.md`. mtimes never compared.
- **N9 — search**: compared as result sets (object/path/snippet-hash +
  visibility decision), not FTS internals or ranking scores; ordering
  compared only where the query contract declares an order.
- **N10 — non-leak scan** (runs in `secrets` scope and at every tier-1/2
  crash comparison): scan DB + WAL + SHM + logs + export + diagnostics for
  every plaintext secret the trace ever wrote. Finding = P0. This is a scan,
  not a diff — it runs identically against both engines.
- **N11 — error identity**: stable machine code only (`expect.code`);
  message text, stack, and error class hierarchy are never compared.
- **N12 — replication acks/cursors**: compared as logical positions.
  Origin → seq maps, cursor values, gaps, and monotonicity are compared
  **numerically** — `[1,3]` and `[1,2]` must never canonicalize equal, or a
  dropped op / invalid cursor advance would be masked. N5 structural
  substitution applies only to *opaque* relay identifiers (stream/epoch/
  origin IDs the relay mints), never to sequence numbers or cursors.

Anything not covered by N1–N12 is compared byte-for-byte after N2's row
normalization. A needed-but-missing normalizer is a change to this document
(program-control review), never a harness-local patch.

---

## 3. Named fault-point registry

The single most load-bearing adapter-design decision (plan, "Test porting
program" item 2). Names are **stable API**: the Rust testkit exposes them over
IPC (`installFault`), the TS adapter maps them onto the existing hooks below,
and traces reference them. Adding a point is cheap; renaming one is a
program-control change.

Naming: `family.position` — a *position* in an operation pipeline, not an
operation. The `fault.scope` binds it to an operation. One position therefore
covers every behavior that flows through it (e.g.
`storage.after-commit-before-ack` scoped to `secrets-fork-version` expresses
the inventory's known double-journal-on-retry flag).

Implementation styles (column S): **H** = TS hook exists today (file:line);
**C** = constructed crash-state today (the test hand-builds the post-crash
state instead of pausing/killing; file:line of the constructor);
**A** = structural in the API (the two-phase API itself is the injection
surface — "crash here" = "don't call phase 2"); **G** = gap — no TS
implementation today (Rust testkit provides it; TS side gets the hook in
R01-DETERMINISM only where a differential trace needs it pre-cutover,
otherwise tier-2/Rust-only).

Rust contract (all points): `dohc-engine-testkit` registers each point as a
zero-cost-when-disarmed await point on the owning actor's pipeline; the
`installFault` IPC verb arms `{point, action, scope, armAfter}`; `crash`
aborts the sidecar process (real exit, tier 1's strongest form), `error`
raises the mapped typed error, `pause` parks the pipeline task and releases on
command, `observe` counts. Points compile out of release builds.

### 3.1 storage — serialized write lane (versionedTextStore → `dohc-engine-storage`)

| # | fault point | position contract | today (S) | tier |
|---|---|---|---|---|
| 1 | `storage.after-write-admitted` | write task holds the lane, writable state loaded, no mutation applied yet. Pause here to build cross-instance interleavings. | H `VersionedTextStoreTestHooks.afterLoadWritableState` — `versionedTextStore.ts:132`, fired `:3543`; race test `versionedTextStore.test.ts:2282-2368` | 1 |
| 2 | `storage.before-persist` | inside the open `BEGIN IMMEDIATE`, all mutation SQL issued, before commit begins. `error` here ⇒ ROLLBACK ⇒ typed `persist-failed`, in-memory/observable state unchanged. | H `beforePersist` — `versionedTextStore.ts:134`, fired `:3548` in `persistBarrier`; test `versionedTextStore.test.ts:1894-1948` | 1 |
| 3 | `storage.before-atomic-publish` | last instant before the commit is made durable (v1: before `COMMIT` at `versionedTextStore.ts:3563`; v2: before the WAL commit record). `crash` here ⇒ restart shows the *pre*-op state. | H `beforeAtomicPublish` — `versionedTextStore.ts:133`, fired `:3549` (today adjacent to #2; kept distinct because v2 separates them) | 1 |
| 4 | `storage.after-commit-before-ack` | txn durably committed, response not yet delivered. `crash` ⇒ restart shows the *post*-op state; a `retryOf` op must be exactly-once (idempotency ledger). | **G** — no TS hook. Known consequence documented in `INVENTORY_NOTES.md` (secrets cluster: `secrets-fork-version` would double-journal on literal retry). Highest-priority gap. | 1 |
| 5 | `storage.write-queued` | observe-only: a write queued behind the lane instead of running immediately. | H `onWriteQueued` — `versionedTextStore.ts:138`, fired `:3590` | 1 |
| 6 | `storage.during-lane-task` | crash inside a `runInEngineWriteLane` SQL task ⇒ ROLLBACK, lane released, no partial rows. | A — throw inside the lane task (`versions-run-in-engine-write-lane`, rollback path `versionedTextStore.ts:3565-3569`) | 1 |

Dead hooks, recorded so nobody "ports" them: `onLockBlocked`, `lockStaleMs`,
`lockTimeoutMs` are declared in the interface (`versionedTextStore.ts:135-137`)
but **invoked nowhere** — vestiges of the pre-SQLite directory-lock store
(the in-file comment at `versionedTextStore.test.ts:2278-2281` confirms WAL
file locks replaced that mechanism). They get no fault point.

### 3.2 storage — open / validate / migrate (`dohc-engine-storage::schema`)

| # | fault point | position contract | today (S) | tier |
|---|---|---|---|---|
| 7 | `storage.open-missing-table` | open a DB missing an expected table ⇒ v1: lazy-create where additive, else corrupt; v2: unsupported-fingerprint, refuse (decision 3). | C `activeVersion.test.ts:112` (`DROP TABLE active_versions`, reopen) | 1 |
| 8 | `storage.open-corrupt-rows` | open/load with invariant-violating rows ⇒ typed `state-corrupt`, never auto-reset, original DB preserved. | C — the `rawCorrupt`/`rawExec` fixture corpus (`versionedTextStore.test.ts:121-131` helpers; ~45 sites incl. `:1953` schema-version, `:2162` empty object id, `:2080` path escape; `momentAuthor.test.ts` 3 sites). Trace form: `state` records with `corrupt:true`. | 1 |
| 9 | `storage.open-version-fingerprint-mismatch` | open a DB with a foreign schema version ⇒ fail closed (v1 fence: `engineDbSchema.ts:851-852` throws `corrupt()` on `version !== 1`; Rust: typed export/reset-required diagnostic on any non-v2 fingerprint, never init-over). | C `versionedTextStore.test.ts:1950-1959` | 1 |
| 10 | `migrate.between-steps` | crash between ledgered migration N and N+1 ⇒ restart resumes idempotently from the ledger; no consumer ever observes the gap. | **G** — v1's un-transactional lazy-DDL sequence has exactly this window and **no test** (`INVENTORY_NOTES.md`, schema cluster). Rust replaces the dance with the day-one migration ledger; this point is the ledger's proof. | 1 |
| 11 | `migrate.before-ledger-commit` | migration body applied, ledger row not yet committed ⇒ restart re-runs or rolls back per the migration's transactional classification; integrity check passes either way. | **G** | 1 |

### 3.3 materialize — durable-job filesystem pipeline (`dohc-engine-files::materialize`)

The v2 pipeline is the plan's 5 steps (commit job → temp write → flush →
atomic replace → complete). The TS *production* capture path has no hooks
here; the behavioral precedent is the quarantined `versionedFileWorkspace`
pending-mutation-journal corpus — its **semantics** port (recovery,
preimage discipline, preserve-both), its implementation does not.

| # | fault point | position contract | today (S) | tier |
|---|---|---|---|---|
| 12 | `materialize.after-job-commit` | job row durable, nothing on disk ⇒ restart replays the job to completion. | C — journal-only fixtures via `writePendingMutationJournalForTest` (`versionedFileWorkspace.test.ts:293`, cases `:1514`, `:1532` ff.) | 1 |
| 13 | `materialize.after-temp-write` | temp sibling written, not flushed/renamed ⇒ restart discards or completes per job state; temp never captured as user content. | C — journal + backup/temp-file fixtures (`versionedFileWorkspace.test.ts:1521-1553`, inline-preimage variant `:1565-1597`) | 1 |
| 14 | `materialize.after-flush-before-rename` | flushed per per-OS durability policy, not yet renamed ⇒ same recovery contract as 13; distinct point because the per-OS flush policy is itself under test. | **G** (v2 step; no v1 analog distinct from 13) | 1 |
| 15 | `materialize.before-preimage-revalidate` | pause immediately before the atomic replace, trace mutates the target via `fs` ⇒ engine must observe the newer external content, NOT overwrite: capture + declared merge/conflict/preserve-both path. | C — disk-mutating crash fixtures (`versionedFileWorkspace.test.ts:1703-1729`, conflict variant `:1745-1770`); hook precedent `VersionedFileWorkspaceTestHooks.afterFileWriteBeforeHistory` (`versionedFileWorkspace.ts:194`) | 1 |
| 16 | `materialize.after-rename-before-complete` | file replaced, job not marked complete ⇒ restart replay is idempotent (preimage hash now matches the new content; no second write, no duplicate moment). | C — journal-with-completed-disk fixtures (`versionedFileWorkspace.test.ts:1660-1692`) | 1 |

Applies (via `scope`) to every materializing behavior: version switch, merge,
restore, sync pull, Y.Doc settle, secret materialize
(`secrets-materialize-secret-file`), share-mount refresh. Crash tests cover
this pipeline **during restore, version switch, merge, sync pull, and settle**
(plan, storage/recovery section) — that is scope multiplication in traces, not
new points.

### 3.4 ydoc — sessions, lineage, settle (`dohc-engine-collab`)

| # | fault point | position contract | today (S) | tier |
|---|---|---|---|---|
| 17 | `ydoc.after-reserve-before-install` | single-canonical reservation taken, persisted state reset/claimed, live session not yet installed. `error`/`crash` ⇒ reservation is released — object never stranded "live". | H `onAfterReserveForTest` — `ydocEngineDriver.ts:334`, fired `:892`; test `ydocEngineDriver.test.ts:697` | 1 |
| 18 | `ydoc.before-base-claim` | replicated first-open decided "no lineage", atomic claim txn not yet run. `pause` + competing base via a second connection ⇒ claim re-check resumes the winner; **exactly one** base op ever journaled. | H `onBeforeBaseClaimForTest` — `ydocEngineDriver.ts:341`, fired `:869`; test `ydocReplication.test.ts:869-913` | 1 |
| 19 | `ydoc.before-settle-commit` | projection computed, non-journaling projected write (`writeProjectedTextFile`) not yet committed. `crash` ⇒ CRDT state durable, projection stale, provenance says so; reopen re-settles; **no `moment.append` is ever journaled for a rich-doc settle** (would collide two peers' settles into a conflict — `ydocEngineDriver.ts:909-919`). | **G** — settle failure only reachable indirectly today. Cutover reset step 1 (force-settle + verify freshness) depends on this contract; the reset rehearsal reuses this point. | 1 |
| 20 | `ydoc.before-compaction-commit` | snapshot fold computed, fold+prune txn not committed ⇒ crash leaves the un-compacted log fully reconstructable; convergence unchanged (spike: compaction is convergence-neutral). | **G** — `ydoc-compact-peer-log` has no direct threshold test today (`INVENTORY_NOTES.md`, ydoc cluster). | 1 |
| 21 | `ydoc.after-update-persist-before-ack` | local editor update durably journaled, durability ack not yet sent. The R11b adapter must retain the unacked update under its idempotency key and resend ⇒ exactly-once durable convergence. Plan mandates killing **after receipt, after commit, and before response** — this point plus #4 plus tier-2 kills implement that triple. | **G** — protocol is R11b; no TS equivalent exists or will (the TS engine has no ack boundary to the live doc). | 1+2 |

### 3.5 sync — journal, apply, cursors (`dohc-engine-sync`)

| # | fault point | position contract | today (S) | tier |
|---|---|---|---|---|
| 22 | `sync.during-journal-txn` | crash inside the compound txn (domain mutation + replication journal entry) ⇒ neither is visible; there is NO position between them (single-txn invariant, plan storage section). `observe` asserts the txn really is compound. | A — same `BEGIN IMMEDIATE` today (`journalLocalReplicationOp` inside the store txn) | 1 |
| 23 | `sync.before-apply-commit` | imported op validated, resulting state + applied-op record + ack staged, txn not committed ⇒ crash = op not applied, not acked; refetch re-applies idempotently. | A + C — dedup/gap admission tests (`versions-replication-apply-envelope`, `chats-replication-op-admission`) | 1 |
| 24 | `sync.between-apply-and-cursor-commit` | op-apply txn committed, fetch-cursor commit not run ⇒ restart refetches the same ops; apply is idempotent; **cursor only ever advances after durable apply**. | A — the two-phase API is the injection surface: `commitFetchCursor` withheld (`syncRelay.test.ts:875-904`, helper `:342-348`), `commitCursor` withheld (`syncShareView.test.ts:271-283`), cursor-rewind overlap (`syncSharedChannel.test.ts:454-468`). Rust keeps a two-phase apply/commit seam in the testkit even if production fuses them. | 1 |
| 25 | `sync.after-push-before-cursor-persist` | ops pushed to relay, local push cursor not persisted ⇒ next push recovers via the relay's dedup/`RelayOriginDivergedError` recovery path, never double-applies. | C — lost/reset push-cursor fixtures (`syncRelay.test.ts:442`, restore-older-db `:960-983`) | 1 |
| 26 | `sync.before-blob-hydrate-commit` | op references blobs; blob hydration incomplete ⇒ fail closed, nothing applied, cursor unmoved. | C — `syncRelay.test.ts:939-946` | 1 |

### 3.6 secrets (`dohc-engine-crypto`)

| # | fault point | position contract | today (S) | tier |
|---|---|---|---|---|
| 27 | `secrets.after-encrypt-before-persist` | plaintext encrypted, ciphertext row not committed ⇒ no partial secret state; plaintext appears nowhere on disk (N10 scan at the crash point). | **G** | 1 |
| 28 | `secrets.before-key-install-commit` | data-key envelope validated, install txn not committed ⇒ retryable; a half-installed key can never decrypt-fail into data loss. | **G** (`secrets-install-workspace-data-key` is critical-tier with enrollment callers) | 1 |

Plus `storage.after-commit-before-ack` scoped to `secrets-fork-version`
(the inventory's known double-journal retry window) and `materialize.*` scoped
to `secrets-materialize-secret-file`.

### 3.7 search (`dohc-engine-storage::search`)

| # | fault point | position contract | today (S) | tier |
|---|---|---|---|---|
| 29 | `search.between-commit-and-index` | domain txn committed with search-index change deferred to a pending index generation ⇒ crash leaves a durable pending generation repaired at startup; queries never see the gap as missing-forever (read-your-writes after repair). | **G** — v1 indexes in the same txn (no window); v2 keeps same-txn where possible, this point guards the declared exception (plan, SQLite ownership). | 1 |

### 3.8 runtime — sessions, watcher, drain (`dohc-engine-runtime`, `dohc-engine-files::watch`)

| # | fault point | position contract | today (S) | tier |
|---|---|---|---|---|
| 30 | `session.during-drain` | crash while `ready → draining` with queued commands ⇒ restart: acked work durable, unacked work idempotently retryable, no queue leak. | **G** (v1 analog: process-global maps, untestable by design) | 1+2 |
| 31 | `session.before-close-release` | crash between logical close and resource release ⇒ reopen works; `resources` compare returns to baseline. | C — the teardown sweep exists precisely because v1 leaks (`closeTrackedEngineDbHandlesForTest`, `engineDbSchema.ts:48-82`); Rust replaces the registry with `Drop` and this point proves it. | 1 |
| 32 | `watch.overflow` | injected native-watcher overflow ⇒ dirty generation + bounded full rescan until disk and engine converge; coalescing never drops the only evidence of a change. | **G** — `workspaceWatcher.ts` has **no dedicated test at all** (`INVENTORY_NOTES.md`, desktop cluster). | 1 |

### 3.9 backup / reset (cutover machinery, `dohc-engine-storage::backup` + R15)

| # | fault point | position contract | today (S) | tier |
|---|---|---|---|---|
| 33 | `backup.after-copy-before-manifest` | backup bytes copied, manifest not written ⇒ backup invalid-by-absence-of-manifest; retention cleanup never counts it; retry produces a fresh verified backup. | **G** | 1 |
| 34 | `backup.during-restore-verify` | crash mid restore-test ⇒ source untouched; "verified" flag never set. | **G** | 1 |
| 35 | `reset.between-states` (parameterized: `settled→backed-up`, `backed-up→moved-aside`, `moved-aside→initialized`, `initialized→capturing`, `capturing→complete`) | crash at each reset-state-machine transition ⇒ durable marker resumes idempotently; Gate 6 rehearses every transition. | **G** — R15 machinery | 1+2 |

### 3.10 Environmental error kinds (`env.*`) and relay fault model (`relay.fault.*`)

Not positions — injectable **error kinds** usable as `fault.action:"error"`
payloads at any registry point, implemented behind the core crates' fs/db
trait seams (portability guardrail 2 — same seams as the deterministic clock):

`env.disk-full` · `env.permission-denied` ·
`env.sharing-violation-transient` · `env.locked-file` · `env.sqlite-busy` ·
`env.truncated-ipc-frame` (protocol layer; pairs with the R03 panic-free
decoder).

`env.sharing-violation-transient` (Windows AV/indexer handle) is normative,
not prose: the fault reports a sharing violation for exactly `n` consecutive
probes (trace-specified via the fault record's `errorArgs.count`, default 3).
The engine's `ReplaceFile` sequence retries on a deterministic schedule under
the test clock with a **normative maximum of 5 attempts** (the single shared
constant lives in `STORAGE_AND_RECOVERY.md` and both engines read it from the
generated contract package). Outcome the harness asserts: `n < 5` ⇒ success
on attempt `n+1` with exactly `n+1` traversals of the fault point; `n ≥ 5` ⇒
fail closed after exactly 5 attempts with the stable error code
`file-locked` and the materialization job left pending (replayed at startup).
Two engines that retry differently cannot both pass.

Relay fault model (Gate 4's named set; seeded schedule from the trace header,
applied by the harness's relay fixture, N instances):
`relay.fault.duplicate` · `relay.fault.reorder` · `relay.fault.drop` ·
`relay.fault.partition` · `relay.fault.restart-mid-pull` — plus peer crash
between journal-apply and cursor-advance, which is point 24 under tier 2.

### 3.11 Registry census

**35 named position points** (6 storage-lane, 5 open/migrate, 5 materialize,
5 ydoc, 5 sync, 2 secrets, 1 search, 3 runtime/watch, 3 backup/reset — #35
parameterized over 5 transitions) **+ 6 environmental kinds + 5 relay fault
kinds**. Mapping census (each point counted once, under its primary style;
point 23 is structural with a constructed-state corpus attached and counts
as A; point 15's hook precedent lives in a quarantined file and counts as C):
6 existing TS hooks (H: 1, 2, 3, 5, 17, 18), 10 constructed-state corpora
(C: 7, 8, 9, 12, 13, 15, 16, 25, 26, 31), 4 structural (A: 6, 22, 23, 24),
and 15 gaps (G: 4, 10, 11, 14, 19, 20, 21, 27, 28, 29, 30, 32, 33, 34, 35)
that exist only because v2 adds the durability machinery v1 lacks (migration
ledger, materialization jobs, ack boundary, pending index generation, reset
machine) — every G point ships in the same shard as the machinery it tests,
and its shard is not parity-verified without it.

### 3.12 Crash-shaped TS tests with no fault point — explicit dispositions

- `changeSetStore.test.ts` corrupt on-disk JSON + stale-lock/heartbeat/PID
  liveness (`__setWin32ProcessStartResolverForTest`, `changeSetStore.ts:736`;
  `currentProcessIdentityForTest`, test `:79`): **de-scoped by quarantine
  decision** — `changeSetStore.ts` is named do-not-port in the plan. The
  cross-process fs-mutex subsystem it tests is deleted by the single-writer
  actor model, not reimplemented. If open decision 4 ever grants headless
  CLI/MCP write authority, this gap must be re-opened first.
- `versionedFileWorkspace.test.ts` stale file-mutation locks
  (`createExternalMutationLockForTest` `:248`, `unusedPidForTest` `:182`,
  hooks `afterFileMutationLockAcquired`/`onFileMutationLockWait`/
  `forcePlatformMode`, `versionedFileWorkspace.ts:192-198`): same quarantine
  disposition; the pending-journal semantics however DO carry forward as the
  section 3.3 contracts.
- `workspaceEngineCapture.test.ts` crashing fake kernel
  (`writeCrashingFakeKernel` `:152`, disable-after-3-failures fallback):
  **retired at cutover by design** — post-cutover there is no fallback; the
  replacement behaviors are packaging hard-fail + visible startup
  incompatibility, tested in R13, not a fault point.
- Real `SIGKILL` of the engine: inexpressible against the in-process TS
  engine, period — tier-2 traces are Rust-only (section 4).

---

## 4. Crash tiers

1. **Tier 1 — named in-process fault points** (the workhorse; everything in
   section 3). Deterministic, seeded, runs on both engines wherever an H/C/A
   mapping exists; G points run Rust-only until/unless a TS hook is added.
   `crash` at tier 1 in Rust is a real process abort of the sidecar at the
   armed point — deterministic placement, real death.
2. **Tier 2 — real process kill.** SIGKILL/`TerminateProcess` of the Rust
   sidecar at seeded-random times during E2E trace execution, including
   parent-death. Restart, `compare`, then mutate. **The TS engine cannot
   execute tier-2 traces** (it lives inside the test-runner process); tier-2
   evidence is Rust self-consistency (crash → recover → invariants) plus
   tier-1 differential coverage of the same positions. This asymmetry is
   accepted and recorded here, not papered over.
3. **Tier 3 — torn-write/power-loss: honestly de-scoped** to (a) SQLite's WAL
   guarantees under the pinned linkage/compile options R04 selects, and
   (b) the documented per-OS materialization durability policy (which flushes
   are issued on which OS and what is consequently guaranteed —
   `STORAGE_AND_RECOVERY.md` owns the table). No torn-write simulator will be
   built; claiming implied coverage is a stop-the-line offense.

After every tier-1/2 case: restart, integrity check, idempotent retry of the
in-flight op, assert no silent loss (plan, verification program).

---

## 5. Anti-weakening mechanics

Gate 6's "zero skipped/weakened/deleted parity tests" needs a detector, not
attestation. Two mechanisms, both CI-enforced:

### 5.1 Per-behavior-ID assertion-count parity

- **Annotation**: every ported test carries a machine-readable behavior
  binding — TS: `// oracle: <behavior-id>[, <behavior-id>...]` on the
  `it(...)`; Rust: `#[dohc_oracle("behavior-id", ...)]` attribute macro from
  `dohc-engine-testkit` (doubles as the differential-trace tag).
- **Counting rule**: static count of **assertion chains**, each chain counted
  exactly once at its terminal matcher — the rules are mutually exclusive:
  - a TS `expect(...)` chain = 1, counted at the terminal matcher, sync or
    async: `expect(x).toBe(y)` = 1; `expect(x).toMatchObject({...})` = 1;
    `await expect(p).rejects.toThrow(...)` = 1 (the `expect(` call is
    **not** counted separately from its `rejects`/`resolves` terminal);
    `await expect(p).resolves.toEqual(...)` = 1.
  - a bare `assert.*(...)` call = 1 (only when not part of an `expect` chain,
    which cannot syntactically occur).
  - Rust: each `assert!`/`assert_eq!`/`assert_ne!` = 1; each
    `#[should_panic]`/`unwrap_err`-style expectation helper from the testkit
    = 1.
  - Loops don't multiply (call sites, not executions — same convention the
    inventory used for raw-SQL counts).
  The counter is a small deterministic script in
  `tools/rust-engine-program/` (owned by this shard's follow-up; the packet
  builder already carries the TSV plumbing it reuses) and ships with fixture
  cases for each bullet above, including the sync and async forms.
- **Ledger**: `docs/superpowers/plans/rust-engine/TEST_PARITY.tsv` —
  `original_file · behavior_id · original_assertions · ported_file ·
  ported_assertions · mutation_ids · delta_approval`. Committed, reviewed
  at the porting shard's tier.
- **Parity exceptions are structured, never free text.** A row with
  `ported_assertions < original_assertions` passes CI only if
  `delta_approval` parses as
  `ref=<PR-or-issue-number>;approver=<reviewer handle or bot>;expires=<gate id>`
  with all three fields present: `ref` must name the reviewed PR/issue that
  approved the delta (for behavior-changing deltas this is the PR that added
  the matching `BEHAVIOR_DELTA.md` entry), `approver` names who approved it,
  and `expires` names the gate (`GATE2`…`GATE8`) at which the exception is
  re-audited — an expired exception fails CI again. Malformed, partial, or
  absent approval ⇒ fail closed. Arbitrary prose cannot bypass the gate.
- **CI check** (`oracle-parity` job, wired beside the `--check` hook of the
  packet builder): recount both sides, fail if
  `ported_assertions < original_assertions` without a valid `delta_approval`
  per the rule above, if any annotation names an unknown behavior ID, if
  any inventory row whose `current_tests` names a ported file has zero ported
  assertions, or if the skipped-test count (`it.skip`/`#[ignore]`) rose.
  Approved deltas are the *audited exception path*, reviewed like code.

### 5.2 Mutation-smoke gate

Each ported suite must **fail** against an engine with a known injected bug.
A ported suite that still passes was weakened — the shard stops (status
regresses to `in progress`, finding filed, integrator notified).

- **Mechanism**: mutations are compiled-in-but-disarmed bug switches selected
  by ID — TS: `DOHC_ENGINE_MUTATION=<id>` read once at store construction
  (test builds only; production packaging asserts the variable is rejected);
  Rust: `--features mutation-smoke` + the same env var in the testkit build.
  One mutation armed per run.
- **Declaration**: every `TEST_PARITY.tsv` row lists ≥1 `mutation_ids` its
  ported file must be killed by. CI runs each ported suite once per declared
  mutation and requires a non-zero exit.
- **Seed mutation registry** (extends as capability shards land; IDs stable):

| id | injected bug | must be killed by |
|---|---|---|
| `M-STORE-ACK-NO-COMMIT` | report success before COMMIT durable | storage-lane suites (points 3/4 traces) |
| `M-STORE-SKIP-JOURNAL` | skip replication-journal append on local write | sync/versions suites (point 22) |
| `M-STORE-WS-FILTER` | drop `workspace_id` predicate on a moment read | any sql-state-oracle suite touching moments |
| `M-STORE-DUP-APPLY` | skip duplicate-op dedup in replication apply | apply-envelope suites (point 23) |
| `M-YDOC-RESERVE-LEAK` | don't release reservation on failed open | ydoc session suites (point 17) |
| `M-YDOC-SECOND-BASE` | skip atomic claim re-check, always journal base | ydoc replication suites (point 18) |
| `M-YDOC-SETTLE-JOURNALS` | settle journals a `moment.append` | settle suites (point 19) |
| `M-SYNC-CURSOR-EAGER` | advance fetch cursor before apply commits | pull suites (point 24) |
| `M-SECRET-PLAINTEXT` | write plaintext into the ciphertext column | secret suites + the N10 scan |
| `M-SEARCH-POLICY-LEAK` | index secret-classified paths | search/policy suites |
| `M-CONFLICT-CLOBBER` | resolve conflict without head-match check | conflict suites |
| `M-MAT-NO-PREIMAGE` | skip preimage revalidation before replace | materialize suites (point 15) |

- Plus the harness-level checks that ride every differential run: every
  mismatch must attach a rule ID (section 2) or open a stop; every
  nondeterministic failure must persist seed + minimized trace or the run
  itself fails.

---

## 6. EngineTestAdapter — implementation-neutral surface

Both engines implement this; every ported test and every trace runs against
it. TS: an in-process object wrapping the real stores (thin — the stores
already take `nowMs`/`createId`). Rust: an IPC client of the sidecar's
testkit endpoint (same framed protocol as production plus the `testkit.*`
verbs, compiled out of release builds).

```ts
interface EngineTestAdapter {
  // -- lifecycle -----------------------------------------------------------
  open(fixture: WorkspaceFixture, opts: {
    seed: number; clock: ClockSpec; replicated?: boolean;
    generation?: number;                       // header workspaces[].generation, default 1
  }): Promise<EngineHandle>;                   // actor up at opts.generation
  close(h: EngineHandle): Promise<void>;       // orderly drain + release
  restart(h: EngineHandle): Promise<EngineHandle>;  // close+reopen, generation++
  crashRestart(h: EngineHandle): Promise<EngineHandle>; // post-`crash` recovery open
  kill(): Promise<void>;                       // tier 2; TS adapter: throws Unsupported

  // -- operations (the whole inventory through one door) --------------------
  invoke(h: EngineHandle, op: {
    behaviorId: BehaviorId;                    // BEHAVIOR_INVENTORY.tsv key
    actor: ActorRef; params: Json;
    idempotencyKey: string; retryOf?: string;
    sessionGeneration: number;
  }): Promise<
    | { outcome: "ok"; result: Json }
    | { outcome: "error"; code: string }
    | { outcome: "crashed" }                   // armed crash fault / tier-2 kill fired
  >;
  drainEvents(h: EngineHandle): Promise<EngineEvent[]>;   // ordered, per-workspace

  // -- raw logical state (the sql-state-oracle port) -------------------------
  queryLogicalRows(h: EngineHandle, select: LogicalSelect): Promise<Row[]>;
  execStateEdit(h: EngineHandle, edit: StateEdit): Promise<void>; // §1.1 `state` records; actor quiesced

  // -- fault control (§3 registry) -------------------------------------------
  listFaultPoints(): Promise<string[]>;        // registry names this engine implements
  installFault(f: FaultSpec): Promise<void>;   // {point, action, scope?, armAfter?, errorKind?, errorArgs?}
  releasePause(point: string): Promise<void>;
  clearFaults(): Promise<void>;

  // -- normalized snapshots (§2) ---------------------------------------------
  snapshotNormalizedState(h: EngineHandle, scopes: CompareScope[]): Promise<CanonicalJson>;

  // -- clock ------------------------------------------------------------------
  advanceClock(ms: number): Promise<void>;
}
```

15 methods. Design notes:

- **`invoke` is behavior-ID-keyed, not method-per-operation.** 229 typed
  methods would freeze the inventory into an interface; instead the adapter
  validates `params` against the per-behavior schema generated from the R03
  protocol work, and typed convenience wrappers live in the harness, not the
  adapter contract.
- **How the 17 sql-state-oracle files keep asserting rows**: decision 3 keeps
  v1's logical table/column shapes at `schema_version = 2`, so
  `queryLogicalRows` accepts the same SELECTs the suites issue today
  (read-only, logical schema only). TS backing: the same
  `DatabaseSync`-over-engine.db the tests' `rawRows` helpers use. Rust
  backing: a testkit read connection opened on the actor's committed
  generation (never a second writer). The 45-site `rawExec`/`rawCorrupt`
  setup pattern ports as `execStateEdit` (§1.1 `state` records). The 17
  files (12 in `packages/workspace-engine`, 5 desktop — per
  `TEST_CLASSIFICATION.tsv`) therefore port without assertion rewrites, which
  is what keeps the ~148 raw-SQL assertion sites cheap (plan, decision 3).
- **`crashed` is a first-class outcome**: the adapter resolves `invoke` with
  `{ outcome: "crashed" }` iff the transport/process was lost while a `crash`
  fault was armed for that op (or a tier-2 `kill` was scheduled). Transport
  loss with **no** armed crash is an adapter exception that fails the run —
  the harness must never confuse an accidental sidecar death or rejected
  promise with an expected fault. After `crashed`, the only legal next trace
  record is `restart` (or end-of-trace) — `crashRestart` is an **adapter
  method, not a trace record**: the harness executes a `restart` record via
  `crashRestart()` when the engine is in a crashed state and via
  `restart()` otherwise, so traces stay engine-state-agnostic. The harness
  enforces this ordering.
- **`listFaultPoints` is how G-points stay honest**: the harness skips a
  trace's fault record only if the engine reports the point unimplemented
  AND the fault record lists that engine in `optionalFor` (§1.1; only
  `"ts"` is valid at traceVersion 1, and only for expectation-neutral
  `observe`/`pause` actions — crash/error traces at G points are
  header-marked `engines: ["rust"]` instead) — otherwise missing point =
  failed run. A Rust shard cannot silently ship without its family's points.
- **Resource scope**: `snapshotNormalizedState(["resources"])` returns
  thread/handle/queue-depth counts for the plateau checks; on TS it returns
  the tracked-handle registry size (`engineDbSchema.ts:48-82`) — coarse, and
  that's fine: the binding budgets are Rust-side.
- **Survivorship (Phase 8)**: the adapter outlives the TS engine. Golden
  traces freeze as `(trace.jsonl, expected-normalized-state.json)` pairs
  replayed against Rust alone; the `EngineTestAdapter` suite becomes the
  permanent product suite.

---

## 7. Open escalations out of this document

1. **`storage.after-commit-before-ack` has no TS implementation** and the
   inventory documents a real consequence (`secrets-fork-version`
   double-journal). Recommendation: R01-DETERMINISM adds the one hook
   (post-COMMIT callback in `persistBarrier`'s caller, `runTransaction`) so
   the exactly-once contract is differential, not Rust-only. Cheap; high
   leverage.
2. **`watch.overflow` has no test on either engine** and `workspaceWatcher.ts`
   has no dedicated test file at all. The R07 shard must treat the watcher
   fault family as new-test work, not porting.
3. The vestigial `onLockBlocked`/`lockStaleMs`/`lockTimeoutMs` hook fields
   (`versionedTextStore.ts:135-137`) should be deleted from the TS interface
   in R01-DETERMINISM so no porting agent maps a fault point onto dead code.
4. Tier-2 asymmetry (TS cannot be killed) is accepted and stated in §4 —
   flagged here so Gate 0 reviewers approve it explicitly.
