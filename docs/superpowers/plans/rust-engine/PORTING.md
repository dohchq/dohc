# PORTING.md — approved TS→Rust mappings (R01-CONTRACTS)

> Status: Gate 0 contract artifact. Together with `STATE_OWNERSHIP.tsv` and
> `LANGUAGE_SEMANTICS_MATRIX.md`, this is the instruction set for every
> porting shard. A Rust diff that contradicts an approved mapping here is a
> review rejection unless it carries an approved `BEHAVIOR_DELTA.md` entry.
>
> Line numbers cite the repo as of 2026-07-16 (branch point `origin/main`,
> post-PR-135). The engine freeze makes these stable; if a frozen file moves,
> update the citation in the same PR that consumed it.

How to read each section: **TS pattern** (with a real engine example),
**approved Rust pattern**, **reviewers reject**. `NEEDS-DECISION` marks places
where the current TS behavior is itself dubious and the shard must escalate
rather than silently choose.

---

## 1. `undefined` vs `null` vs omitted fields

**TS pattern.** The engine distinguishes all three:

- Omitted-when-absent output fields: `appliedApplyResult` spreads
  `pendingConflictResolves`/`pendingResolves` into the result only when
  non-empty (`packages/workspace-engine/src/syncReplication.ts:155-169`);
  `createVersionedTextStoreWithHooks` spreads `...(author !== undefined ?
  { author } : {})` (`versionedTextStore.ts:5439`).
- `?? null` at the SQL boundary: optional values become SQL `NULL` explicitly
  (`ydocEngineDriver.ts:990` — `opts?.actorOriginId ?? null`).
- Lazy-additive columns treat `NULL` as the *older-writer truth* with a
  defined meaning: `moments.sync_record_only` NULL means "applied"
  (`engineDbSchema.ts:750-770`); `chat_threads.channel_id` NULL means
  file-linked thread (`engineDbSchema.ts:659-687`).
- Input validation rejects `undefined` where a field is required
  (`assertString`, `versionedTextStore.ts:186-190`).

**Approved Rust pattern.**

- Domain structs use `Option<T>` for every field that is nullable in SQL or
  omitted on the wire. There is no Rust distinction between "absent" and
  "null" — the *serialization layer* owns it: wire types use
  `#[serde(skip_serializing_if = "Option::is_none")]` where the TS engine
  omits, and plain `Option` (serialized as `null`) where the TS engine emits
  `null`. The choice per field comes from the behavior-inventory
  `io_contract` column; do not guess.
- SQL `NULL` maps to `Option::None` via rusqlite; the *meaning* of `None`
  ("applied", "file-linked", "unattributed") is documented on the struct
  field, ported verbatim from the schema comments in `engineDbSchema.ts`.
- Deserialization of persisted/wire input uses
  `#[serde(deny_unknown_fields)]` only where the TS engine fails closed on
  unknown shapes; the store hydration paths (`normalizeHydratedState`,
  `versionedTextStore.ts:570-617`) fail closed on *wrong-typed* fields but
  tolerate extra keys — match that: typed extractors, unknown keys ignored.

**Reviewers reject:** `Option<Option<T>>` to model absent-vs-null (push it to
serde attributes); sentinel values (`""`, `-1`, `0`) standing in for `None`;
`unwrap_or_default()` that silently converts `None` into a meaningful value
the TS engine would have rejected; any new field whose `None` meaning is
undocumented.

---

## 2. JS numbers vs typed integers

**TS pattern.** Every numeric value is an f64. The engine's own guards:
`assertNumber` requires `Number.isFinite` (`versionedTextStore.ts:206-210`);
`normalizeTimestamp` likewise (`versionedTextStore.ts:2114-2122`). Sequence
numbers are allocated as `MAX(...) + 1` reads coerced with `Number(...)`
(`syncReplication.ts:73-86`, `versionedTextStore.ts:2932`). Byte lengths come
from `Buffer.byteLength` (`versionedTextStore.ts:2160`).

**Wire alignment (binding).** The R03 protocol already bounds every wire
integer to `Number.MAX_SAFE_INTEGER`:
`MAX_WIRE_INTEGER: u64 = (1 << 53) - 1`
(`crates/dohc-engine-protocol/src/limits.rs:10`, mirrored in
`generated/limits.json`). All engine-visible counters MUST stay within that
bound so TS clients read plain `number`s losslessly.

**Approved Rust pattern.**

- Storage/domain integers are `i64` (SQLite's native INTEGER width), wrapped
  in domain newtypes where they carry identity or ordering:
  `MomentOrder(i64)`, `OriginSeq(i64)`, `UpdateSeq(i64)`, `ByteLength(u64)`.
- Every value that crosses the protocol is range-checked against
  `MAX_WIRE_INTEGER` at the protocol boundary (the R03 codec already does
  this — do not duplicate ad-hoc checks in domain code, but do rely on the
  fact that no engine counter can realistically exceed 2^53).
- Timestamps and byte counts read from SQLite REAL columns are `f64` at the
  storage layer and converted with explicit, checked conversion where an
  integer is required (see §3 and `LANGUAGE_SEMANTICS_MATRIX.md` §2).
- Arithmetic on sequence counters uses `checked_add`/`checked_sub` in debug
  and release alike where the input is remote (replication seq math in
  `dohc-engine-sync`); local monotonic allocation (`MAX+1` inside the write
  transaction) may use plain `+ 1` after the read is validated `< i64::MAX`.

**Reviewers reject:** `as` casts between numeric types on any
remote/persisted input (use `try_from` / `TryInto` with a typed error);
`u32`/`usize` for anything that lands in SQLite INTEGER columns (silent
truncation on 32-bit-usize targets); floats used for sequence/order values;
wrapping arithmetic anywhere; unchecked `f64 as i64`.

---

## 3. Timestamps and monotonic time

**TS pattern.** One clock: injected `nowMs` defaulting to `Date.now()`
(`versionedTextStore.ts:3510-3511`), validated only as *finite*
(`normalizeTimestamp`, `versionedTextStore.ts:2114-2122`) — negative,
fractional, and non-monotonic values are all accepted and persisted. Columns
are inconsistently typed: `REAL` in the original tables
(`moments.recorded_at_ms REAL`, `engineDbSchema.ts:1017`) but `INTEGER` in the
chat-phase-one and dispatch tables (`chat_decisions.at_ms INTEGER`,
`engineDbSchema.ts:467`; `chat_dispatch_ledger.created_at_ms INTEGER`,
`engineDbSchema.ts:608`). There is no monotonic clock anywhere in the engine;
ordering that matters is carried by explicit counters (`moment_order`,
`origin_seq`, `seq`), never by wall-clock comparison — except the LWW
registers, which order by `(at_ms, state, origin_id, origin_seq)`
(`engineDbSchema.ts:419-432`).

**Approved Rust pattern.**

- One `Clock` trait seam in `dohc-engine-domain` (`fn now_ms(&self) -> f64`
  or a `TimestampMs(f64)` newtype), injected everywhere — this is the same
  seam the determinism retrofit (R01-DETERMINISM) standardizes on the TS
  side. Production impl reads the system wall clock; testkit impl is seeded.
- `TimestampMs` is an `f64` newtype (matches REAL columns and fractional
  test-injected clocks), validated finite at construction, compared only for
  LWW where the TS engine does.
- Columns keep their current SQLite types (schema-shape stability, locked
  decision 3): REAL stays REAL, INTEGER stays INTEGER. The storage layer owns
  the per-table conversion; `TimestampMs` → INTEGER column goes through a
  checked "is integral" conversion. NEEDS-DECISION only if a differential
  trace surfaces a fractional timestamp written into an INTEGER column today
  (SQLite would store the REAL; TS reads it back as-is — see
  `LANGUAGE_SEMANTICS_MATRIX.md` §2 fixture `semantics/int-column-real-bind`).
- Monotonic time (`std::time::Instant`) is allowed ONLY for
  intervals/timeouts/backoff inside `dohc-engine-runtime` (never persisted,
  never compared to wall time). Deadlines arriving over the protocol are
  relative durations, per the R03 envelope.

**Reviewers reject:** `SystemTime::now()`/`Instant::now()` called directly in
core crates (must come through the trait seam — portability guardrail 2);
persisting `Instant`-derived values; deriving ordering from timestamps where
the TS engine uses a counter; "fixing" the REAL/INTEGER column inconsistency
inside a port shard (that is a schema change; integrator + delta only).

---

## 4. Exceptions vs typed errors

**TS pattern.** Every store defines an `Error` subclass with a closed union
of machine codes, and tests assert the codes:

- `VersionedTextStoreError` + `VersionedTextStoreErrorCode` — 22 codes:
  `conflict-not-found | conflict-stale-target | duplicate-id |
  file-too-large | file-not-found | fork-base-not-found |
  invalid-generated-id | invalid-input | invalid-metadata | invalid-object |
  invalid-path | invalid-root | invalid-version | invalid-text |
  invalid-timestamp | invalid-version-name | invalid-workspace |
  persist-failed | state-corrupt | target-path-exists |
  version-name-conflict | version-not-found | workspace-mismatch |
  write-lane-reentry` (`packages/workspace-contracts/src/engine.ts:38-62`,
  class at `versionedTextStore.ts:121-129`).
- `LinkedChatStoreError` — 20 codes incl. `channel-exists`,
  `read-state-revision-mismatch`, `state-corrupt`, `workspace-mismatch`
  (`engine.ts:1066-1085`).
- `SecretFileStoreError` — 11 codes incl. `decrypt-failed`, `key-corrupt`,
  `not-secret-path` (`engine.ts:1804-1815`).
- `AgentDispatchStoreError` — incl. `invalid-input`, `state-corrupt`
  (`agentDispatchStore.ts:27-48`).
- `YDocEngineDriverError` — `state-corrupt | not-found | already-live |
  session-closed | invalid-input` (`ydocEngineDriver.ts:106-120`).
- Sync relay: distinct classes instead of codes —
  `RelayUnauthorizedError`, `RelayWorkspaceUnavailableError`,
  `RelayConflictError`, `RelayOriginDivergedError`, `RelayBlobMissingError`,
  `RelayKeyEnvelopeMissingError` (`syncRelay.ts:64-113`).

Conventions that are part of the contract: the `corrupt(cause?)` factory
attaches the underlying error as `.cause` but the *message* is a fixed,
redaction-safe string ("Versioned text store is corrupt.",
`versionedTextStore.ts:553-559`); infrastructure failures are *converted* to
the store's taxonomy at the boundary (`openDatabase` wraps any SQLite throw
in `corruptStore`, `versionedTextStore.ts:530-550`); corruption fails closed
and never auto-repairs (`engineDbSchema.ts:839-852` — foreign tables or a
wrong `schema_version` throw `corrupt()`).

**Approved Rust pattern.**

- One error enum per store/domain module, `thiserror`-derived, with a
  `#[non_exhaustive]` attribute and a `pub fn code(&self) -> &'static str`
  returning the **byte-identical kebab-case code string**. The code string is
  the compatibility contract (ported tests assert it); the message is
  best-effort human text and must stay redaction-safe (no paths with user
  content, no secret material, no document bodies — the corrupt() messages
  above are deliberately constant).
- Causes: wrap with `#[source]`/`#[from]` — this is the `.cause` analog. The
  source chain is for diagnostics only; never match on it for control flow.
- Cross-layer conversion tables live with the protocol: engine error →
  `ErrorCode` (SCREAMING_SNAKE wire codes,
  `crates/dohc-engine-protocol/generated/ts/ErrorCode.ts`) plus a
  `retryability` classification per the R03 envelope. The kebab-case store
  code rides in the error envelope's detail payload so ported tests keep
  asserting the exact store-level code.
- `Result<T, StoreError>` everywhere; no panics for expected failures.
  Corruption detection returns `state-corrupt` errors — it never panics and
  never initializes over the database (product invariant; plan §Corruption
  behavior).
- Catch-all conversion at the storage boundary mirrors TS: any unexpected
  rusqlite error inside an open/validate path becomes the module's
  `StateCorrupt` variant with the source attached
  (mirror of `versionedTextStore.ts:544-550`).

**Reviewers reject:** `anyhow` in library crates; stringly-typed errors;
losing or renaming a code the test suite asserts; mapping distinct TS codes
onto one Rust variant ("close enough" collapses like
`invalid-path`+`invalid-input`); `panic!`/`unwrap` standing in for a typed
error on any input-derived path; error messages that embed document content,
secret paths' contents, or key material.

---

## 5. Promise-chain serialization → actors/channels

**TS pattern (the thing being replaced).** Three layers of ad-hoc
serialization:

1. **Process-global store write chain**: `storeWriteChains: Map<string,
   Promise<unknown>>` keyed by canonical engine.db path
   (`versionedTextStore.ts:141`), threaded by `serialize()`
   (`versionedTextStore.ts:3575-3605`): each write chains behind the
   previous (`previous.then(() => runTransaction(task), () =>
   runTransaction(task))` — note a *failed* predecessor still runs the next
   task), every write runs in one `BEGIN IMMEDIATE`/`COMMIT`
   (`runTransaction`, `versionedTextStore.ts:3556-3573`), and reads that need
   write visibility use `afterWrites()` (`versionedTextStore.ts:3607-3610`)
   which awaits the chain head — a barrier, not a lock.
2. **Capture chain**: the desktop capture serializes batch capture,
   reconciliation and version ops on a single promise chain —
   `let chain: Promise<void>` + `enqueue`/`enqueueResult`
   (`apps/desktop/src/workspaces/workspaceEngineCapture.ts:954-987`; the plan
   cites this as "the enqueue chain at 888-909" from an earlier file
   revision — same mechanism). `enqueue` swallows task failures into
   `onError`; `enqueueResult` propagates the result to the caller while
   keeping the chain alive; `stopped` refuses only NEW work — already-queued
   work still runs (`workspaceEngineCapture.ts:956-962,976-980`).
3. **Write-lane reentry**: `runInEngineWriteLane` hands foreign modules
   (Y.Doc driver) the store's connection inside the serialized lane, with a
   synchronous-reentry guard that throws `write-lane-reentry`
   (`versionedTextStore.ts:5399-5420,3575-3587`).

**Approved Rust pattern.**

- One **workspace actor** per canonical engine.db identity (plan §Workspace
  actor model) owning the single writable connection on a dedicated OS
  thread. Commands arrive on a **bounded** `mpsc` channel; the actor
  processes them strictly in order. This subsumes all three TS layers: the
  storeWriteChains Map (actor registry keyed the same way — see
  `STATE_OWNERSHIP.tsv` row `actor-registry`), the capture chain (capture
  commands are just commands in the same queue), and `runInEngineWriteLane`
  (foreign-module writes become commands or a composed transaction API — no
  connection ever leaves the actor).
- Failure semantics are ported explicitly: a failed command must NOT poison
  the queue (TS: chain continues after rejection). Background-style commands
  (capture batches) report failures to an error sink; request-style commands
  (version ops) reply on their oneshot. Two command classes, one queue —
  matching `enqueue` vs `enqueueResult`.
- `afterWrites()` becomes a read that observes a **named committed
  generation**: the actor bumps a generation counter at COMMIT; read pool
  requests carry `min_generation`. No global await-the-chain barrier.
- Shutdown: `ready → draining → closed`. `draining` = the channel is closed
  to new senders, queued commands run to completion (TS: work enqueued
  before `stop()` still runs). No new work accepted after drain begins
  (`stopped` flag analog is the closed channel, not a boolean).
- Reentry deadlock is prevented by construction (an actor cannot send to
  itself and block); the `write-lane-reentry` error therefore has no Rust
  equivalent — the ported tests that assert it are re-pointed at the
  compile-time impossibility per `TEST_ORACLE.md` classification
  (hook-dependent, adapter maps it to a typed refusal on the composed
  transaction API).

**Reviewers reject:** unbounded channels (banned outright); `tokio::spawn`
per request against a shared connection; `Mutex<Connection>` (serialization
by lock is the promise chain with worse fairness — the connection must be
*owned*); a second connection to work around the single writer;
fire-and-forget task failures without a routed error sink; blocking the
async runtime on the SQLite thread (must be `spawn_blocking`-style dedicated
thread with channel handoff).

---

## 6. Buffers, UTF-8, and binary ownership

**TS pattern.**

- Text is engine-ownable only if it round-trips UTF-8:
  `Buffer.from(text, "utf8").toString() === text` at the write gate
  (`versionedTextStore.ts:2156-2174`) and `Buffer.from(bytes →
  toString("utf8") → back).equals(bytes)` at capture
  (`workspaceEngineCapture.ts:559-563`) — content that fails is demoted to
  *binary*, not rejected. Note `Buffer.prototype.toString("utf8")` is
  **lossy** (invalid bytes → U+FFFD); the equality check is what detects the
  loss.
- Size caps in bytes, not chars: `Buffer.byteLength(text, "utf8")` vs
  `MAX_VERSIONED_TEXT_FILE_BYTES` (`versionedTextStore.ts:2160-2166`);
  capture caps `MAX_ENGINE_CAPTURE_TEXT_BYTES` / `_BINARY_BYTES`
  (`workspaceEngineCapture.ts:546-567`).
- Binary blobs are content-addressed and **verified on read**: byte_length
  and sha256 recomputed, mismatch → `state-corrupt`
  (`ydocEngineDriver.ts:209-223`, duplicated at
  `versionedTextStore.ts:1188-1200`).
- Blob rows store `BLOB` via `Buffer` (`putYDocBlob`,
  `ydocEngineDriver.ts:200-207`).

**Approved Rust pattern.**

- Text at rest is `String` (guaranteed well-formed UTF-8). The capture-side
  demotion decision ports as: `match String::from_utf8(bytes) { Ok(s) =>
  text-candidate, Err(e) => binary(e.into_bytes()) }` — do NOT use
  `from_utf8_lossy` + compare (allocates twice and reproduces the JS
  detour); the result is behaviorally identical because TS accepts exactly
  the inputs where lossy conversion is lossless.
- Size caps compare `str::len()` (already UTF-8 bytes) — no conversion
  needed; this is one of the places Rust is *simpler*, not different.
- Binary is `Vec<u8>`/`bytes::Bytes` with single ownership; blob reads keep
  the verify-on-read posture (recompute sha256 + length before returning;
  mismatch → `state-corrupt`).
- The wire layer never base64s blobs (R03 requirement); in-process transport
  passes `Bytes` without copy.
- UTF-16 concerns live ONLY at the Y.Doc boundary: every wire-facing yrs
  `Doc` uses `OffsetKind::Utf16` and the TS adapter validates
  `isWellFormed()` (binding spike constraints, `DECISIONS.md` 2026-07-16).

**Reviewers reject:** `from_utf8_unchecked` (unsafe, banned);
`from_utf8_lossy` on any path that then *stores* the lossy result as text
(silent corruption — TS demotes instead); `.len()` on `char`-counted or
UTF-16 units for byte caps; returning blob bytes without the digest check on
any path the TS engine verifies; cloning large buffers where ownership can
move.

---

## 7. Global maps/registries

**TS pattern (inventory — every process-global in the engine):**

| Global | Where | Purpose |
| --- | --- | --- |
| `storeWriteChains: Map<path, Promise>` | `versionedTextStore.ts:141` | cross-store write serialization per physical DB |
| `liveYDocs: Map<key, Y.Doc>` | `liveYDocRegistry.ts:55` | route remote ydoc.update into the live doc |
| `globalLiveYDocReservations: Set<string>` | `ydocEngineDriver.ts:355` | at-most-one live session per (db, workspace, object) |
| `workspaceKernelDisabledForProcess` + failure counter | `workspaceEngineCapture.ts:69,940-946` | disable kernel sidecar after N consecutive failures |
| `trackedEngineDbHandlesForTest: Set` | `engineDbSchema.ts:48` | test-only Windows handle sweeping |
| per-capture `liveYDocSessions: Map` | `workspaceEngineCapture.ts:866` | authoritative live-session registry per workspace |
| per-driver `liveSessions: Map` | `ydocEngineDriver.ts:429` | driver-level session registry |

The keying discipline is the important behavior: identity is the
**canonical physical engine.db path** (`canonicalEngineDbPath`,
`versionedTextStore.ts:483-497` — realpath of the deepest existing ancestor,
NUL-joined composite keys `liveYDocKey`, `liveYDocRegistry.ts:47-53`).

**Approved Rust pattern.**

- Zero `static mut`, zero `lazy_static`/`OnceLock` mutable registries in core
  crates. Every one of these globals becomes **state owned by a specific
  struct** with a row in `STATE_OWNERSHIP.tsv`:
  - `storeWriteChains` → the supervisor's actor registry
    (`HashMap<EngineDbIdentity, ActorHandle>`) owned by the session
    registry, keyed by the same canonical-path identity (plus file identity
    — see `LANGUAGE_SEMANTICS_MATRIX.md` §7).
  - `liveYDocs` + `globalLiveYDocReservations` + both session Maps → the
    workspace actor's collab session table. The at-most-one reservation
    becomes an ownership fact (the actor holds the only session slot per
    object) instead of a global Set.
  - kernel disable flag → deleted with the kernel spike (no fallback exists
    post-cutover; plan §Kernel spike and silent fallback).
  - test handle tracking → unnecessary (Drop closes connections
    deterministically); the testkit asserts release instead
    (`STATE_OWNERSHIP.tsv` release_test column).
- Cross-actor lookups go through the supervisor's registry API with explicit
  lifetimes (a handle, not a reference into another actor).

**Reviewers reject:** any process-global mutable registry in a core crate;
`Arc<Mutex<HashMap<...>>>` reachable from more than one owner ("shared
registry" smell — route through the owning actor); keys built by string
concatenation without the NUL/typed-tuple discipline; identity keyed on
lexical paths (must be canonical DB identity).

---

## 8. Listener/event cleanup

**TS pattern.**

- Expected-event suppression is a **TTL registry, not a leak-prone
  subscription**: `registerExpectedEngineEvents` stamps
  `expiresAtMs = now() + EXPECTED_ENGINE_EVENT_EXPIRY_MS` (10s)
  (`workspaceEngineCapture.ts:154,1034-1039`), consumers filter expired
  entries on every pass (`workspaceEngineCapture.ts:1022`), and registration
  returns a cancel closure (`workspaceEngineCapture.ts:266,1629,2748`).
- Y.Doc sessions unregister on close in a strict order: mark closed → drop
  session map entry → drop reservation → `unregisterLiveYDoc`
  (`ydocEngineDriver.ts:1083-1089`), and the failure path also releases the
  reservation (`ydocEngineDriver.ts:1115`).
- Capture teardown retains failed sessions as `failing-close` rather than
  dropping them (`workspaceEngineCapture.ts:855-865`) — cleanup failure is
  loud and retryable, never silent.

**Approved Rust pattern.**

- Subscriptions/observers are owned guards: registering returns a
  `SubscriptionGuard` whose `Drop` unregisters. The TTL suppression registry
  ports as a data structure (entries with deadlines, swept on access) owned
  by the actor — same semantics, no timer task needed.
- Ordered teardown is encoded in struct field order (Rust drops fields in
  declaration order) plus explicit `close()` for fallible/async teardown.
  Rule: **Drop is for infallible release only; anything that can fail or
  must settle data has an explicit async `close()` that the actor's drain
  state calls, and Drop after a missed close logs-and-releases, never
  settles.** This ports the `failing-close` retention: a failed `close()`
  keeps the session registered in a poisoned state; retry goes through the
  same close path (`workspaceEngineCapture.ts:855-887`).
- Event emission to the desktop client carries sequence numbers and session
  generation (R03 envelope) so a listener that reconnects can detect gaps
  instead of relying on never-dropped registrations.

**Reviewers reject:** `std::mem::forget` on guards (banned); listeners
registered in `new()` with cleanup "handled elsewhere"; Drop impls that do
I/O that can fail silently (fsync, settle, SQL) — that work belongs in
`close()`; unregistering in only the happy path (TS releases the
reservation on failure too — `ydocEngineDriver.ts:1115`).

---

## 9. SQLite: binds, coercion, transactions (node:sqlite → rusqlite)

Full behavioral table in `LANGUAGE_SEMANTICS_MATRIX.md` §8. The approved
*patterns*:

**TS pattern.**

- Connection open ritual, identical in all three stores:
  `busy_timeout = 5000` (`ENGINE_SQLITE_BUSY_TIMEOUT_MS`,
  `engineDbSchema.ts:15`), `foreign_keys = ON`, `journal_mode = WAL`, then
  schema init/validate, then `quick_check`
  (`versionedTextStore.ts:522-551`, `secretFileStore.ts:157-183`,
  `syncApply.ts:74-100`; the Y.Doc driver opens `readOnly: true` and skips
  DDL/journal_mode, `ydocEngineDriver.ts:161-189`).
- Writes: exactly one `BEGIN IMMEDIATE` … `COMMIT` per serialized task with
  ROLLBACK-and-rethrow (`versionedTextStore.ts:3556-3573`); migrations use
  the same shape with a re-check after taking the writer lock
  (`engineDbSchema.ts:789-837`).
- Reads coerce defensively: `Number(row?.x ?? fallback)`,
  `String(row.name)` (`syncReplication.ts:85,134`;
  `engineDbSchema.ts:852`) because node:sqlite returns
  `Record<string, unknown>`.
- Idempotent writes lean on SQL: `INSERT OR IGNORE` for first-writer-wins
  (`sync_identity`, `syncReplication.ts:60`; blobs,
  `ydocEngineDriver.ts:203-205`), `ON CONFLICT … DO UPDATE SET acked_seq =
  MAX(old, new)` for monotonic acks (`syncReplication.ts:143-148`).
- Compound invariant: domain mutation + replication journal entry commit in
  ONE transaction (`ydocEngineDriver.ts:964-1014` — blob put, head advance,
  and `journalLocalReplicationOp` on the same lane connection).

**Approved Rust pattern.**

- rusqlite with the bundled feature per the R04 linkage decision. Open
  ritual is a single `open_engine_db()` in `dohc-engine-storage` — the ONLY
  place pragmas are set; every caller goes through it. Pragmas identical:
  `busy_timeout(Duration::from_millis(5000))`, `foreign_keys = ON`,
  WAL. Integrity: `PRAGMA quick_check` expecting exactly one `ok` row
  (`engineDbSchema.ts:915-925` posture).
- Transactions: `Transaction` with `TransactionBehavior::Immediate`,
  `commit()` consumed by value; the drop-is-rollback default is the safety
  net, never the control flow. One transaction per actor command; the
  journal append and the domain mutation use the same `&Transaction`.
- Statement reuse via `prepare_cached` (node:sqlite re-prepares every call —
  Rust may cache; observable behavior is unchanged and perf gates want it).
- Row extraction is **typed at the column**: `row.get::<_, i64>` /
  `Option<String>` / `f64`, mapping declared per table in
  `dohc-engine-storage`. The TS `Number(...)`-coerce-anything posture is NOT
  ported (see matrix §8 rows on affinity); where the TS engine tolerates a
  wrong-typed cell by coercion, the Rust port fails `state-corrupt` — this
  is an approved delta ONLY for cells the schema can't legally contain;
  anything a real v1 DB can contain must be handled equivalently
  (fixture-pinned).
- `INSERT OR IGNORE` / `ON CONFLICT` SQL text is ported verbatim; do not
  re-express as read-then-write (loses the atomicity the SQL had).

**Reviewers reject:** any connection opened outside `open_engine_db()`;
pragma drift between open sites (the desktopAgentDispatchStore's separately
hardcoded `busy_timeout` — `apps/desktop/src/agents/desktopAgentDispatchStore.ts`
— is a bug class to eliminate, not port); `execute_batch` for anything with
user data (no binds); string-interpolated SQL (SQL injection + no plan
cache; the TS engine has one interpolation — `PRAGMA table_info(${table})`,
`engineDbSchema.ts:723` — which dies with the lazy-upgrade machinery);
deferred transactions for writes (must be Immediate); read-modify-write
where the TS engine used a single atomic UPSERT; swallowing
`SQLITE_BUSY` (typed overload/retry error per protocol retryability).

---

## 10. Path normalization and filesystem identity

**TS pattern.**

- Workspace-relative path admission is ONE pipeline:
  `validateWorkspacePath` (`packages/workspace-core/src/paths.ts:129-176`)
  — NUL rejection, absolute rejection (POSIX / drive / UNC,
  `paths.ts:10-16`), percent-decode-until-stable (`%252e → %2e → .`,
  `paths.ts:140-149`), backslash→slash, `..` traversal rejection including
  Windows dots-and-spaces aliases (`paths.ts:158-166`), empty/`.` segment
  collapse, reserved checks (`.dohc` at any depth, case-insensitive,
  Windows-alias-stripped, `paths.ts:40-47`; `shared-with-me` write-reserved,
  `paths.ts:54-61`), ignored segments (`.dohc`, `.git`, `node_modules`,
  `.dohc-write-*` prefix, `paths.ts:73-87`).
- Secret classification runs on the DECODED path
  (`enginePathFloor.ts:18-48`), with `stripWindowsAliasSuffix` per segment so
  `secret.env ` classifies secret on Windows.
- Physical identity: `canonicalEngineDbPath` realpaths the deepest existing
  ancestor and rejoins the fixed relative tail
  (`versionedTextStore.ts:483-497`) — symlinked roots converge on one
  identity.
- Containment: engine disk writes realpath-check root and parent, walk to
  nearest existing ancestor before mkdir, and refuse symlink leaves
  (`workspaceEngineCapture.ts:654-730`); reads `lstat`, never `stat`, and
  treat a symlink leaf as untracked
  (`workspaceEngineCapture.ts:533-543`).

**Approved Rust pattern.**

- Port the admission pipeline as pure functions in `dohc-engine-domain`
  (`WorkspacePath` newtype constructed only via `validate_user_write_path`
  / `_read_path`) with byte-for-byte identical accept/reject/normalize
  behavior — this is the highest-fanout pure logic in the engine; it gets a
  dedicated conformance corpus (matrix §6/§7 fixtures). String ops on the
  raw `String`, NOT `std::path::Path` (Path/PathBuf are platform-dependent;
  workspace paths are a platform-neutral, forward-slash domain language).
- `std::path` is used ONLY in `dohc-engine-files` where paths touch the real
  filesystem. Physical DB identity combines the canonicalized path
  (`std::fs::canonicalize`, which returns `\\?\`-prefixed paths on Windows —
  normalize before comparing, matrix §7) with true file identity (dev+inode
  / volume+file-index) per plan §Workspace actor model.
- Containment checks port the same sandwich (canonicalize root + parent,
  nearest-existing-ancestor walk, `symlink_metadata` for lstat) with the
  Windows atomic-replace + retry semantics defined in the plan
  (§Filesystem/database crash boundary) — note the current TS writer is a
  plain `writeFile` with **no temp file, no atomic replace, and no fsync**
  (`workspaceEngineCapture.ts:707-728`): the Rust materialization pipeline
  is an approved improvement, recorded in `BEHAVIOR_DELTA.md`, not silent.
- Case-insensitivity decisions (`toLowerCase()` comparisons in
  `paths.ts:43,57,78`) port as Unicode simple case folding with the exact
  JS-vs-Rust divergence corpus pinned (matrix §6 fixture
  `semantics/case-fold-corpus`).

**Reviewers reject:** `Path::components()`/`canonicalize` used for
workspace-relative validation (different traversal semantics than the TS
pipeline); TOCTOU windows the TS code closes (containment re-check after
mkdir must stay); `stat` where TS uses `lstat`; comparing canonical paths
without stripping/normalizing the Windows `\\?\` prefix; skipping the
decode-until-stable loop ("one decode is enough" is exactly the bug it
guards).

---

## 11. Deterministic serialization

**TS pattern.**

- `payload_json` in the replication log is `JSON.stringify(payload)`
  (`syncReplication.ts:101`) — key order is object-insertion order, so the
  byte content is deterministic per *code path* but not canonical; nothing
  hashes payload_json today.
- The relay path has an explicit `canonicalJson`/`stableStringify` for what
  it signs/compares (`syncRelay.ts` — see `STATE_OWNERSHIP.tsv` sync rows).
- Content addressing hashes exact bytes: UTF-8 text (`sha256Text`,
  `versionedTextStore.ts:1164-1166`), raw binary (`sha256Bytes`, `:1168-1170`),
  ciphertext bytes for secret replication (`secretFileStore.ts:366-368`),
  deterministic derived IDs from sha256 of composite strings
  (`linkedChatStore.ts:1165-1171`).
- Spike constraint: nested `Any::Map` key order is nondeterministic through
  yrs re-encode — nested frontmatter keys must be sorted before projection
  or content-addressing (`DECISIONS.md` carry-forward 2).

**Approved Rust pattern.**

- `serde_json` with `preserve_order` feature (struct-field-declaration order
  standing in for TS insertion order) for `payload_json` compatibility, and
  the struct field order for each op payload declared to match the TS
  emitter — pinned by differential fixtures comparing journal bytes, since
  peers' dedup keys on `(origin_id, origin_seq)`, not payload bytes.
  NEEDS-DECISION at R10 if any consumer is found comparing payload_json
  bytes across engines; if none, byte-equality is relaxed to
  JSON-value-equality in the oracle normalizer (record in `TEST_ORACLE.md`).
- Everything NEW that is hashed, signed, or content-addressed uses a real
  canonical form (sorted keys, no insignificant whitespace, forbidden
  non-finite floats) in `dohc-engine-protocol::canonical` — one
  implementation, parity-tested against the TS `stableStringify` fixtures.
- f64 formatting: JSON numbers must round-trip; use serde_json's default
  (shortest round-trip, same algorithm family as V8's) and pin with fixture
  `semantics/json-float-format` (matrix §5).

**Reviewers reject:** `HashMap` anywhere in a serialized type (iteration
order nondeterminism — use `BTreeMap` or ordered structs); hashing a
serde_json `Value` re-serialization where TS hashed original bytes;
canonicalization invented per-module; floats in canonical forms without the
round-trip fixture.

---

## 12. Cancellation and deadlines

**TS pattern.** The engine has **no cancellation at all**: zero
`AbortSignal`/`AbortController` in `packages/workspace-engine/src` (verified
by grep 2026-07-16). The only deadline-ish machinery: the kernel client's
per-request `timeoutMs: 30_000` (`workspaceEngineCapture.ts:911-913`), the
expected-event TTL (§8), lock-timeout test hooks
(`versionedTextStore.ts:131-139`), and the capture `stopped` flag that
refuses new work (`workspaceEngineCapture.ts:961-962,976-980`). Once a store
write starts, nothing can stop it before COMMIT/ROLLBACK.

**Approved Rust pattern.**

- Cancellation is a first-class **cancellation tree** per workspace actor
  (plan §Workspace actor model) driven by `CancellationToken`
  (tokio-util) — session generation invalidation cancels all children.
- Cancel points are BETWEEN durable steps, never inside a transaction: a
  command checks its token before starting the transaction and between
  retry attempts; once `BEGIN IMMEDIATE` succeeds, the transaction runs to
  COMMIT or error (matching the TS atomicity envelope — a differential trace
  must never see a half-cancelled mutation).
- Deadlines come from the R03 envelope (request deadline, `CANCELLED` /
  `DEADLINE_EXCEEDED` wire codes,
  `crates/dohc-engine-protocol/generated/ts/ErrorCode.ts`). Deadline expiry
  before the durable step → typed retryable error; after the durable step →
  the response is still delivered/recorded (exactly-once ack semantics; the
  idempotency ledger makes the retry safe).
- Every await on an external resource (fs, channel, relay HTTP) is raced
  with the token via `select!` or timeout wrappers — no un-cancellable
  awaits in the actor loop.

**Reviewers reject:** cancellation checked inside an open transaction that
then rolls back *committed-intent* work (cancel must not undo what the TS
engine would have completed); dropping a future as the cancellation
mechanism for anything holding a transaction or temp file (must run its
cleanup path); deadlines enforced by killing the SQLite thread; ignoring the
token on "quick" operations (queue delay makes everything slow under load).

---

## 13. Drop, zeroization, shutdown

**TS pattern.**

- Secret keys live as long-lived `Buffer`s parsed from the key file
  (`loadSecretDataKey`, `secretFileStore.ts:217-263`); JS cannot zeroize
  reliably and the engine doesn't try. Key files are written 0o600 with
  `wx` exclusive-create racing (`secretFileStore.ts:243-262`), and lax perms
  are healed on read (`secretFileStore.ts:225-226`).
- Store close: each store has a `close()` seam; the test sweeper documents
  the real-world failure mode — **Windows cannot delete files with open
  handles**, and process-global chains leak WAL handles
  (`engineDbSchema.ts:43-83`; plan cutover step 4 relies on prove-zero-
  handles for the same reason).
- Shutdown ordering at the capture layer: stop refuses new work, queued
  work drains, live Y.Doc sessions settle-then-close with failures retained
  loudly (§5, §8 citations).

**Approved Rust pattern.**

- Key material: `Zeroizing<[u8; 32]>` (zeroize crate) inside a `SecretKey`
  handle type whose `Debug`/`Display` never print bytes
  (redaction-safe types are a `dohc-engine-crypto` requirement, plan §Crate
  graph). Key handle is owned by the workspace actor; row
  `secret-key-handle` in `STATE_OWNERSHIP.tsv`.
- File permission posture ports exactly: 0o600/0o700 on Unix, documented
  no-op on Windows (same as TS `chmod(...).catch(() => undefined)`), plus
  the `wx`-equivalent `OpenOptions::new().create_new(true)` race resolution.
- Connections: rusqlite `Connection` closes on Drop; the actor's `closed`
  state drops the connection **after** WAL checkpoint
  (`PRAGMA wal_checkpoint(TRUNCATE)` on clean close is an approved
  improvement — record in `BEHAVIOR_DELTA.md`; TS never checkpoints
  explicitly). Drop order within the actor: sessions → jobs →
  read pool → write connection → watcher (see `STATE_OWNERSHIP.tsv`
  `shutdown_drop_order` column; the table is authoritative).
- The process exits with zero unowned handles — the soak gate asserts
  threads/handles return exactly to baseline (plan §Resource and soak
  tests). Anything with a finalizer requirement appears in
  `STATE_OWNERSHIP.tsv` with its release test.

**Reviewers reject:** key bytes in plain `Vec<u8>`/`String`, in error
messages, in `Debug` derives, or in trace logs; `mem::forget` (banned);
Drop impls that panic; close paths that skip the settle step a TS close
performed (`ydocEngineDriver.ts:1072-1100` — close settles unless told not
to); relying on process exit to release anything a workspace *close* must
release (workspace close ≠ shutdown).

---

## 14. Arc, locks, atomics, channels, worker pools

**TS pattern.** Single-threaded JS: all "locking" is the promise chains
(§5), all "atomics" are plain variables mutated between awaits, e.g. the
kernel failure counter (`workspaceEngineCapture.ts:940-946`), `seq` captured
by closure inside the write lane (`ydocEngineDriver.ts:963-976`).

**Approved Rust pattern (the concurrency budget).**

- Default: **message passing over shared state.** State lives inside one
  actor/task; other parties hold an `ActorHandle` (clonable sender +
  metadata) — `Arc` appears only inside handles and for immutable config.
- Approved primitives, in order of preference: bounded `mpsc` + `oneshot`
  replies; `watch` for generation/status broadcast; `CancellationToken`;
  `Semaphore` for bounding pools; `OnceCell` for immutable init. `Mutex` is
  allowed only for small, never-held-across-await metadata maps in the
  supervisor (registry insert/remove), documented per use.
- Atomics: counters/flags that are genuinely monotonic and race-tolerant
  (metrics, generation reads) — any atomic whose correctness argument needs
  more than one sentence becomes a message to the owning actor instead.
- Worker pools: fixed-size, created at actor start, bounded queues, sized
  by config not `num_cpus` guesses in library code; every pool has a
  `STATE_OWNERSHIP.tsv` row (max_cardinality is enforced, not aspirational).
- Blocking work (SQLite, fs scans, hashing large files) runs on dedicated
  threads or `spawn_blocking` with a bounded concurrency budget — never on
  the async runtime worker threads.

**Reviewers reject:** unbounded channels (banned); `std::sync::Mutex` held
across `.await` (compile-refused by clippy `await_holding_lock` — deny);
`RwLock` on hot mutation state (the actor owns it); `Arc<Mutex<T>>` as the
default sharing idiom; spawned tasks without a home in the cancellation
tree; ad-hoc `thread::spawn` in core crates (platform seam violation —
spawning goes through the runtime trait, portability guardrail 2);
`Ordering::Relaxed` with a load-bearing correctness comment (if it needs
the comment, use a channel).

---

## 15. Banned shortcuts (mutation paths)

Restating the plan's Rust policy as review checklist items, with the TS
behaviors they would silently break:

1. `todo!()` / `unimplemented!()` / placeholder success — CI-grepped
   (plan §Stop-the-line). A stubbed branch is how an omitted error path
   ships; every `match` on op kinds must be exhaustive with the TS
   `default: throw invalid-input` arm ported
   (`versionedTextStore.ts:5374-5384`).
2. `unwrap()`/`expect()` in any mutation path on input-derived data. Allowed
   only for compiler-provable invariants with a one-line proof comment
   (e.g. a value just inserted into a map). "A paragraph-long comment
   defending a workaround is a rejection signal" (repo rule).
3. Silent fallback — the defining anti-pattern of the kernel spike
   (`workspaceEngineCapture.ts:942-948` falls back to TS scanning and
   permanently disables the kernel). Post-cutover there is no fallback
   authority: failures are typed, loud, and recoverable-read-only at worst.
4. Unbounded channels/queues/caches/batches — every buffer names its bound
   (product invariant). Backpressure produces the protocol's `OVERLOADED`
   error, never an unbounded queue.
5. `mem::forget`, leaked guards, `Box::leak` outside process-lifetime
   config.
6. `unsafe` — `#![forbid(unsafe_code)]` in ordinary crates; the budget is
   zero (plan §Rust policy).
7. Swallowed errors: `let _ = fallible()` on anything durable. The TS
   engine's deliberate swallows are exactly three shapes and they port as
   documented decisions, not habits: best-effort `chmod`
   (`secretFileStore.ts:226`), ROLLBACK-after-failed-COMMIT
   (`versionedTextStore.ts:3566-3568`), close-during-error-path
   (`versionedTextStore.ts:545-547`).
8. Re-expressing atomic SQL as read-modify-write, or splitting the TS
   engine's single-transaction compounds (domain write + journal + ack)
   into multiple transactions — the crash-consistency contract is the
   transaction boundary listed per behavior row in
   `BEHAVIOR_INVENTORY.tsv` (`txn_ack_boundary` column).
