# dohc Rust Workspace Engine Rewrite Plan — Rev 2

> Status: audit-verified; program authorized by Ice's go signal 2026-07-16
> (opens Wave 0 preparation only — capability implementation waits on Gate 0,
> defined below)
>
> Date: 2026-07-16 (Rev 2, same day)
>
> Decision owner: Ice
>
> Execution rule: the go signal authorized Wave 0 (artifacts, spikes, dormant
> scaffolding). No capability shard (Wave 1+) starts before Gate 0 passes.
> This document is the program's instruction set: any future decision change
> requires a same-day edit here before any agent consumes the stale text.

## Rev 2 changelog

Rev 1 was written by the planning session before several decisions were made
and before its claims were verified against the repository. Rev 2:

- **Verified every current-system finding against the repo** (16 claims:
  14 confirmed with file:line evidence, 2 corrected below, 0 wrong).
- **Bakes in the locked decisions**: full commitment (no go/no-go trial),
  clean reset of pre-launch data, yrs spike as week-one sole abort criterion,
  oracle built by porting the existing ~22k-line engine test suite, Rust over
  Go.
- **Deletes the dead machinery clean reset kills**: schema-variant fixtures,
  bridge TypeScript release, ownership-epoch fences, adversarial downgrade
  tests, emergency downgrade compatibility, the canary engine-selection flag,
  TS↔Rust wire-replication interop.
- **Adds what clean reset actually requires**: a durable, resumable,
  rehearsed reset state machine; a mandatory Y.Doc settle/verify step; a
  per-data-class loss ledger with export; relay replication-epoch reset.
- **Makes the anti-dual-write fence mechanical** in both directions
  (shadow-clone marker + real-root denylist pre-cutover; schema-version
  fingerprint post-cutover).
- **Restructures execution for the real orchestration capacity**
  (Claude Workflow cells up to ~16 concurrent agents + Codex/gpt-5.6-sol as
  free implementer labor): dependency waves instead of a linear lane list,
  module-level ownership instead of crate-level, integrator batching cadence,
  a dormant desktop-adapter lane, tiered review depth, machine-readable
  handoffs.
- **Right-sizes verification for a solo-dogfood cutover**: statistical soaks
  move post-cutover, fuzzing prioritized by input trust, perf gates limited to
  engine-attributable budgets, and the missing determinism/fault-injection
  infrastructure is scheduled first, not discovered mid-program.

## Executive decision

Rebuild the authoritative local dohc workspace engine in Rust while keeping
Electron, React, Tiptap/ProseMirror, live editor integration, agents,
integrations, sites, cloud authentication, and the remote sync relay in
TypeScript unless separately approved.

The end-state invariant:

> Rust is the sole writer of canonical **structured engine state**
> (`engine.db`, journals, versions, history, policy decisions, secrets,
> search, collaboration durability, and engine-managed materialization).

External editors, standalone agent tools, Git, and user database applications
remain legitimate filesystem writers; their changes become canonical engine
truth only after the Rust engine validates, captures, commits, and
acknowledges them.

Strategy: **parallel dormant construction with atomic authority cutover.**

- Land small, reviewable Rust capability PRs while they remain unreachable
  from production.
- The TypeScript engine stays the sole product authority during construction.
- Compare engines only on separately cloned workspaces — mechanically fenced,
  not by convention (see "Mechanical fences").
- Switch every canonical mutation path to Rust in one bounded cutover built
  around a clean data reset.
- Delete the TypeScript mutation authority immediately after cutover behind a
  mandatory deletion gate.

## Decisions locked (formerly "open decisions")

1. **Commitment**: full rewrite, approved in principle. There is no go/no-go
   trial. Phase 1's representative slices are **calibration** (shard sizing,
   porting-guide accuracy, review depth, throughput) — their gate adjusts the
   approach; it does not re-litigate the rewrite. The **only abort criterion**
   is the week-one yrs interoperability spike.
2. **Existing development data**: clean reset. No historical schema-variant
   support, no bridge TypeScript release, no ownership-epoch fence, no
   downgrade window. Two data-safety mechanisms are retained: (a) Rust refuses
   any database it does not recognize as its own — it never auto-initializes
   over one; (b) no Rust write to a real workspace before a verified,
   restore-tested backup exists.
3. **Schema**: clean reset applies to *data*, not to *shape*. The first Rust
   schema keeps the current logical table/column shapes (so the existing
   suite's ~148 raw-SQL assertion sites port unchanged and normalized-state
   diffing stays cheap) but stamps `schema_version = 2`, creates all tables
   eagerly at init (no lazy additive-upgrade reproduction — fresh databases
   only), and ships the ordered migration ledger plus the durable
   request/idempotency and materialization-job tables **day one**. The
   version-2 stamp doubles as the post-cutover fence: current TS code already
   fails closed on `schema_version != 1`
   (`engineDbSchema.ts:680` throws `corrupt()`), so every existing TS binary
   is mechanically locked out with no bridge release.
4. **Y.Doc**: `yrs` owns durability if and only if the week-one spike passes
   (concrete spec below). If it fails, the program pauses for an Ice decision.
   The Rev 1 four-option fallback menu is deleted.
5. **Language**: Rust (Go evaluated and rejected; yrs/Yjs compatibility was
   dispositive). Toolchain: pinned latest stable in `rust-toolchain.toml`,
   edition 2024, committed `Cargo.lock`.
6. **Oracle**: port the existing ~22k lines of workspace-engine tests to an
   implementation-neutral `EngineTestAdapter`, plus differential traces and
   named-fault-point crash injection. Implementation-neutral test style
   becomes the repo default immediately. No grand build-an-oracle-from-scratch
   phase.

## Open decisions still requiring Ice's approval at Gate 0

1. **Protocol**: framed JSON + binary streaming vs CBOR/MessagePack vs
   Protobuf — decided by the R03 spike, approved by Ice.
2. **CI policy**: mandatory Rust build/test/conformance/package matrix on
   Windows x64, macOS x64/arm64, Linux x64 — this changes the repo's reduced
   GitHub Actions policy and must be resolved in week one, before any
   capability lane opens (the dev machine is Windows-only; every macOS claim
   requires CI).
3. **Relay HTTP client**: Rust-owned at cutover (recommended) or temporarily
   TypeScript-scheduled with Rust owning validation/application.
4. **Standalone CLI/MCP**: remain external filesystem writers when desktop is
   absent (recommended for first cutover) or design headless authority.
5. **Share mounts**: cut over in the same atomic release (recommended) or
   disable mounts until their Rust session model passes.
6. **Account/DM/registry state**: TypeScript ownership + crash-recoverable
   Rust workspace sagas (recommended), or Rust owns account-level homing.
7. **Local agent-run attribution**: move the active-run lease and durable
   attribution under Rust with `.dohc/agent-runs.json` as a derived projection
   (recommended).
8. **Dogfood duration**: minimum canary/soak evidence before stable release.
9. **Mobile/web hosts**: explicitly deferred; the portability guardrails
   (library-first core, trait seams, in-process transport) hold the door
   open at near-zero cost. Building an FFI host or WASM target is a separate
   future decision.

## Why this rewrite exists

dohc is local-first. The desktop app and the per-workspace database at
`.dohc/engine/engine.db` are the product. The engine behaves like a local
database/filesystem kernel: it owns irreplaceable user state, watches and
materializes normal files, runs SQLite in WAL mode, maintains identity,
versions, history, merges and conflicts, stores encrypted secrets, journals
replicated operations, persists collaboration state, indexes policy-filtered
search, and coordinates long-lived resources across open/switch/sync/shutdown.

Rust is selected because ownership, bounded concurrency, typed state
transitions, deterministic cleanup (`Drop`), process isolation, and
compiler-enforced invariants align with those responsibilities — and because
the maintainers are agents, for whom compiler errors are a better feedback
loop than conventions. Rust is not a substitute for invariants, testing,
fault injection, or resource bounds.

## Bun rewrite inspiration

Informed by [Rewriting Bun in Rust](https://bun.com/blog/bun-in-rust).

Copy: porting guide before mass implementation; explicit ownership/lifetime
modeling (`STATE_OWNERSHIP.tsv` ≈ Bun's `LIFETIMES.tsv`); representative
slices before scaling; preserve observable behavior first, refactor idiomatic
later; compiler failures as an organized work queue; implementer separated
from clean-context adversarial reviewers; repeated implement→review→fix→verify
cells; full suite on every supported platform; manual verification that no
test was skipped or weakened; fuzzing and failure injection; expect
regressions even after green.

Do not copy: Bun's justification (Zig manual memory — TypeScript is already
memory-safe; our problem is architectural authority, not segfaults); lines/
agent-count as metrics; 64 agents against tightly coupled storage semantics;
porting retired code; thousands of dormant compiler errors; one giant PR as
the first review boundary; any `unsafe` (target: zero); green tests as proof
without differential/crash/convergence/resource evidence.

Bun had a 1.3M-assertion language-independent oracle. dohc's equivalent is
the existing engine suite ported to a neutral adapter — that porting is a
first-class program track, not preparation.

## Current-system findings (audit-verified)

All claims below were verified against the repo on 2026-07-16.

### The engine is distributed — confirmed

Authority spans: `packages/workspace-engine` (~34 files; SQLite stores +
domain logic; `versionedTextStore.ts` alone is 6,272 lines);
`apps/desktop/src/workspaces/workspaceEngineCapture.ts` (2,418 lines —
capture, reconciliation, materialization, version ops, policy application,
Y.Doc session coordination, the `enqueue` promise-chain serializer at
lines 888–909); `workspaceWatcher.ts` + `workspaceActivity.ts`;
`relaySyncEngine.ts`; `apps/desktop/src/main.ts` (6,130 lines — authorization,
store singletons, IPC, shutdown); and the narrow Rust accelerator
(`crates/workspace-kernel` + `packages/workspace-kernel-client`).

### Multiple writers — confirmed, and worse than Rev 1 said

`engineDbSchema.ts:1-6` states verbatim that versionedTextStore and
linkedChatStore open the same `engine.db` over separate WAL connections and
"whichever opens first creates the schema." secretFileStore opens its own.
**Correction to Rev 1**: the desktop-side raw-SQL consumer is not `main.ts`
(zero SQL there) but `apps/desktop/src/agents/desktopAgentDispatchStore.ts`,
which opens its own `DatabaseSync` connection to the same file and issues raw
`ALTER TABLE`/`BEGIN IMMEDIATE`/`COMMIT` outside every store class and outside
the capture promise chain. Search and chat IPC delegate properly to engine
modules. The Rust design replaces all of this with one writer per workspace
actor.

### Schema version 1 is not one physical schema — confirmed

`ENGINE_SCHEMA_VERSION = 1` never bumps; ~10 lazy DDL families and 5
`PRAGMA table_info`-gated column adds install on open
(`engineDbSchema.ts:667-713`). Only the original 12 tables are strictly
asserted. Under clean reset this is a **finding to escape, not a surface to
reproduce**: Rust creates the full schema eagerly at version 2 and never
implements the additive-upgrade dance. `engineDbSchema.ts` is also the
second-churniest file in the repo (23 commits/30d) — freezing it is part of
the freeze policy below.

### Y.Doc rows: local-only cache vs replicated durable lineage — correction to Rev 1/Rev 2

Two distinct regimes; R11 must not conflate them:

- **Local-only sessions**: `ydoc_updates`/`ydoc_snapshots` are documented
  in-schema (`engineDbSchema.ts:263-289`) as a prunable fast-resume cache —
  "a closed session may prune to a single snapshot"; the settled markdown
  projection carries the durability weight.
- **Replicated sessions**: the engine journals `ydoc.update` operations and
  **explicitly never prunes those CRDT rows on close**, because peers
  bootstrap from that lineage (`ydocEngineDriver.ts:999-1007`,
  `ydocEngineDriver.ts:1090-1098`, `syncApply.ts:139-144`). For replicated
  rich docs the CRDT lineage itself is durable canonical state; markdown is
  a projection.

R11a's scope covers both regimes: resume cache + pruning policy for
local-only docs; durable lineage retention, export/reseed handling, and
`ydoc.update` replication for replicated docs; snapshots/compaction, leases,
and the settle pipeline for both. The mandatory pre-reset settle phase at
cutover stands (markdown must be fresh before any reset), and the reset's
epoch re-key restarts replicated lineage on the new epoch — the loss ledger
must list pre-reset replicated lineage explicitly.

### Kernel spike and silent fallback — confirmed

The kernel is NDJSON JSON-RPC with one OS thread per request
(`main.rs:249`); every build-failure path in
`build-workspace-kernel.mjs` warns and exits 0, and runtime falls back to TS
scanning on missing binary or handshake failure
(`workspaceEngineCapture.ts:827-879`), including a consecutive-failure
counter that permanently disables the kernel for the process. Valid for an
accelerator; invalid for the sole authority. Post-cutover: packaging fails
without the binary, incompatibility fails visibly, startup may offer
read-only recovery, and no TypeScript authority exists to fall back to.

### Collaboration, shares, registry, budgets, retired files — confirmed

Hocuspocus is retired (`docs/architecture/backend-modes.md:31-34`);
`ydoc.update` ops ride the engine replication log. Share mounts carry nested
`engine.db` stores excluded from host capture (`shareMounts.ts:16-24`). The
DM homing map and workspace registry live in account/user state outside any
engine.db (`dmHomeStore.ts`, `registryStore.ts`). Performance budgets exist
in `packages/performance/src/budgets.ts` with the exact Rev 1 numbers; the
storage bench only console-logs; **no budget or ratchet is enforced anywhere
in CI at all** (stronger than Rev 1 claimed). The release matrix packages 4
platforms but engine tests run only on ubuntu — the TS engine has never been
CI-tested natively on Windows or macOS despite ~989 platform-conditional
sites across 45 files. `changeSetStore.ts` (with its macOS durability gap)
and `versionedFileWorkspace.ts` are quarantined legacy — **do not port**.
`services/sync-relay` imports `classifyEngineFilePath` and
`AGENT_CHANNEL_WIRE_ID` from engine modules — these must be re-homed in a
shared generated contract package with Rust/TS parity fixtures before the old
exports die.

## Goals

1. Rust is the sole authority for canonical local workspace mutations.
2. Preserve currently shipped observable behavior unless an approved decision
   changes it (`BEHAVIOR_DELTA.md` records every approved delta).
3. Replace process-global maps and promise chains with bounded workspace
   actors and owned resources.
4. Every acknowledged write is durably committed; crash recovery is
   deterministic and testable.
5. Normal files stay inspectable and agent-friendly; Y.Doc convergence and
   markdown projection behavior are preserved.
6. Workspace, policy, sharing, and secret boundaries hold.
7. Engine-attributable performance budgets hold; memory, handles, queues, and
   shutdown are measurable.
8. Windows x64, macOS x64/arm64, Linux x64 from the first cutover.
9. A codebase agents can safely extend, with explicit protocol, ownership,
   state-machine, migration, test, and review contracts.

## Non-goals

- Rewriting Electron, React, Tiptap, ProseMirror, the auth service, the sync
  relay server, integrations, MCP transport, sites, or the SDK.
- Rewriting user-visible SQLite database files in the first cutover.
- Moving live awareness/selections/editor rendering into Rust.
- Reproducing non-observable implementation details.
- **Supporting any pre-reset database, wire stream, or downgrade path.**
- **TS-peer-to-Rust-peer replication interop** (all devices cut over
  together; relay state resets — see cutover).
- Two production authorities as a rollback mechanism.
- New product features inside porting shards.

## Product invariants

Unchanged from the repository's standing invariants, restated as binding on
every shard: server/desktop-derived authorization; workspace scoping on every
object and operation; agent writes respect locks/policies/shares/turn gates;
canonical rich-document state is never replaced by raw full-body markdown
patching while a Y.Doc session is live; conflicts preserve both sides; paths
are aliases, stable IDs carry identity; secret plaintext never enters
history, search, export, logs, IPC diagnostics, replication payloads, or
untrusted projections; async results bind to a workspace/session generation
before affecting state; no `.dohc/**` projection is re-ingested as user
content; every queue/cache/request/batch/retry is bounded; no acknowledged
operation is lost after restart; a restart never converts corruption into an
empty workspace.

## Target architecture

```text
Renderer / UI / editor / agents / integrations
                    |
          validated desktop main process
                    |
        generated bounded engine client
                    |
       authenticated framed IPC + events
                    |
          Rust dohc engine sidecar
          +-----------------------+
          | process supervisor    |
          | session registry      |
          | bounded worker pools  |
          +-----------+-----------+
                      |
              workspace actor
          +-----------+-----------+
          | one SQLite writer     |
          | bounded read access   |
          | watcher/reconcile     |
          | materialization       |
          | versions/history      |
          | policy/secrets        |
          | chats/dispatch        |
          | Y.Doc durable cache   |
          | sync/search           |
          +-----------+-----------+
                      |
       normal files + .dohc/engine/engine.db
                      |
          opt-in authenticated sync relay
```

### Process topology

One desktop-owned supervised sidecar per desktop process, one isolated actor
per open workspace/store. The sidecar exits when its parent disappears; the
desktop restarts it with bounded exponential backoff; restart recovery
reopens approved workspaces, replays durable pending work, and issues new
opaque session handles (old handles/generations invalid).

### Workspace actor model

Each writer actor is keyed by canonical physical `engine.db` file identity
(not lexical root, workspace ID, or session handle); aliases converge on one
actor; nested share stores get distinct actors. Session roles are explicit:
owned workspace (capture + bidirectional replication), received shared view
(filtered inbound materialization, no local capture, restricted reads),
mounted share (separately scoped nested store with declared direction). Each
actor owns: the physical root and DB identity, one writable `rusqlite`
connection on a dedicated thread (never blocking the async runtime), a
bounded read pool observing named committed generations, watcher/reconcile
generation, materialization state, Y.Doc sessions and leases, sync cursors,
search generation, secret-key handle, bounded command/event queues, a
cancellation tree, and `ready → draining → closed` shutdown.

Watcher overflow is not a retryable request: overflow sets a dirty generation
and schedules a bounded full rescan until disk and engine converge.
Coalescing may reduce duplicate work but never drops the only evidence of a
change. Saturation, native overflow, rename storms, and restart-while-dirty
are all tested.

### Crate graph

```text
dohc-engine-protocol   wire types, errors, bounds, schema generation
dohc-engine-domain     IDs, state machines, policy facts, version/merge/replication semantics
dohc-engine-storage    SQLite ownership, migration ledger, transactions, blobs, integrity, backup
dohc-engine-files      path floor, watcher, scan/hash/reconcile, atomic materialization
dohc-engine-crypto     secret keys, envelopes, AEAD, redaction-safe types
dohc-engine-collab     Y.Doc resume cache/snapshot/lease/settle/replication semantics
dohc-engine-sync       journals, cursors, op validation/application, relay client boundary
dohc-engine-runtime    actors, bounded scheduling, search, chats/dispatch composition
dohc-engine-testkit    fixtures, traces, NAMED FAULT POINTS, normalized state snapshots
dohc-workspace-engine  (binary) supervised IPC server and diagnostics
```

Dependency cycles are an architecture failure. The integrator owns graph
changes. **Write ownership is at module/table-family level, not crate level**
(see orchestration) — multiple shards extend `dohc-engine-domain` and
`dohc-engine-storage` concurrently in disjoint modules.

### Portability guardrails (mobile/web option value)

The rewrite does not build mobile or web surfaces, but it must not foreclose
them. Rust is the standard shared-core substrate for iOS/Android (Signal,
1Password, Mozilla Application Services ship one Rust core via FFI/UniFFI),
`yrs` compiles to wasm32, and SQLite runs in browsers over OPFS — but only if
platform assumptions stay out of the core. Three guardrails, enforced from
the first capability shard:

1. **Library-first invariant.** `dohc-workspace-engine` (the binary) is a
   thin host over an embeddable library API. A second host — a mobile FFI
   shell that cannot spawn child processes (iOS forbids sidecars) — must be
   possible without touching domain crates. Enforced in CI: the core crates
   (`domain`, `storage`, `crypto`, `collab`, `sync`, `protocol`) never depend
   on the binary/supervisor layer.
2. **Platform seams stay behind traits in core crates.** No direct
   tokio/thread/process/filesystem calls in the core crates; clock, spawn,
   and fs access go through the same trait seams the testkit already
   requires for deterministic clocks, fault points, and fixture filesystems.
   The verification program and the portability story are the same
   abstraction, paid for once. Desktop-specific responsibilities
   (watching, materialization against a real user file tree) stay isolated
   in `dohc-engine-files`/`dohc-engine-runtime`, which mobile/web hosts
   would not link.
3. **In-process transport.** The R03 protocol/bindings design must admit a
   direct-call transport alongside framed IPC, so an embedded engine does
   not serialize to itself. (Design constraint on the spike, not extra
   work now.)

Mobile UI, mobile's app-container workspace model, and any web surface remain
out of scope (open decision 9). Future non-desktop clients would lean on the
replication substrate — journals, cursors, Y.Doc durability, idempotent
apply — which is exactly what Rust owns after this rewrite.

### Rust policy

Pinned stable toolchain (`rust-toolchain.toml`), edition 2024, committed
lockfile, repo-level Cargo workspace. `#![forbid(unsafe_code)]` in all
ordinary crates; unsafe budget zero; any unavoidable platform/FFI unsafe
lives in a tiny dedicated crate with an approved `UNSAFE.md` entry, `SAFETY`
invariants, tests, and two adversarial reviews. Deny warnings once the
scaffold stabilizes. `rustfmt`, strict `clippy`, `cargo audit`, `cargo deny`.
Banned in production mutation paths: `todo!`, `unimplemented!`, placeholder
success, silent fallback, `mem::forget`, unbounded channels, unexplained
`unwrap`/`expect`. A paragraph-long comment defending a workaround is a
rejection signal.

## Authority matrix

| Capability | Rust end state | TypeScript end state |
| --- | --- | --- |
| `engine.db` schema/migration ledger | sole owner | no production SQL |
| workspace lifecycle | session actor, drain/recover | approved root selection, UI |
| versions/history/conflicts | complete authority | typed calls, presentation |
| files/watch/reconcile | complete authority | progress/error UX |
| materialization | plan, atomic write, recovery | none except explicit adapters |
| policy/path floor | enforcement | editing UX, pre-checks |
| secrets | keys, crypto, storage, materialization | passphrase/keychain UX |
| search | indexing, filtering, query snapshot | streaming result UI |
| replication | journal, apply, cursors, idempotency | credential acquisition initially |
| relay HTTP | preferred Rust ownership (open decision 3) | optional initial scheduler |
| chats/dispatch state | durable records and claims | model execution, chat UX |
| Y.Doc persistence | resume cache, snapshots, leases, settle, replication | live Y.Doc + editor binding |
| Y.Doc/markdown projection | provenance/acceptance | conversion implementation initially |
| awareness/presence | no durable state | ephemeral transport + UI |
| agent execution | durable run/claim state (open decision 7) | providers, prompts, processes |
| external normal-file writes | capture/validate/durable barrier | editors/agents write files |
| user-visible SQLite files | opaque capture after DB commit | current subsystem |
| shared security vocabulary | Rust enforcement + parity schema | generated relay/client constants |
| account/DM/registry bindings | idempotent saga endpoint (open decision 6) | trusted account-state owner |

## Engine protocol

Protocol selection is the R03 spike (candidates: length-framed JSON + chunked
binary, CBOR/MessagePack, Protobuf). Requirements: language-neutral schema
with generated TypeScript bindings; runtime validation both sides; explicit
protocol/storage compatibility versions; authenticated parent-child session;
opaque workspace handles; request IDs, deadlines, cancellation, idempotency
keys; ordered event sequence numbers and session generations; bounded frame/
string/collection/blob/batch sizes; streaming without base64-ing blobs;
backpressure with explicit overload errors; retryability classification;
stable machine error codes; capability negotiation; restart/reconnect;
redaction-safe diagnostics; deterministic fixtures readable by both test
suites; **named fault points as a first-class testkit feature** (see
verification); **and an in-process direct-call transport alongside framed
IPC** (portability guardrail 3 — an embedded engine must not serialize to
itself). NDJSON + thread-per-request is the seed, not the target.

Only desktop main connects during an active desktop session; renderer/CLI/MCP
proxy through validated desktop main. A renderer-supplied path or ID is never
authority. Standalone CLI/MCP remain external filesystem writers when desktop
is absent (open decision 4); the next Rust workspace open captures their
edits before reconciliation completes.

Desktop-controlled file writers (`workspaceFiles`, assets, sites SDK host,
shared projections, user database tooling, agent tools) are inventoried in
`ENGINE_SCOPE.md`; engine-mediated writes route through Rust; operations that
necessarily write an external canonical file first (user-visible SQLite
especially) ack only after the file's own commit completes and a Rust
capture/durability barrier records the resulting bytes/hash, with crash
recovery defined between the steps.

## Storage and recovery model

### SQLite ownership

One writer connection per workspace actor; foreign keys on; explicit
WAL/busy/checkpoint configuration; no hidden connection pools; reads observe
named committed generations. Compound domain mutation + its replication
journal entry commit in one transaction. Imported op + resulting state +
applied-op record + ack commit atomically. Search-index changes are in the
same transaction or a durable pending index generation repaired at startup.
R04 pins SQLite linkage (bundled vs system, FTS5/trigram options, extension
policy, defensive settings, WAL compatibility) with native cross-open
fixtures against the supported Node SQLite build (needed for read-only
tooling and the oracle, not for production dual-access).

### Day-one Rust schema (replaces "first-release schema compatibility")

- `schema_version = 2`; identical logical table/column shapes to current v1
  (all lazy additions included), created eagerly at init.
- Plus, from day one: the ordered migration ledger (migration ID, checksum,
  engine build, timestamps, transactional classification, integrity result),
  the durable request/idempotency ledger, materialization-job table, and an
  engine ownership record. Designed and fixture-tested in R04, not
  improvised.
- No additive-upgrade reproduction, no variant fixtures, no bridge release,
  no downgrade path. Rust refuses any database whose fingerprint it does not
  recognize — including every v1 TS database — with a typed
  "export/reset required" diagnostic, and never initializes over an existing
  file.
- Later schema changes go through the ledger: exclusive ownership, WAL
  checkpoint, verified backup, migrate (into a copy when not safely
  transactional), integrity + invariant checks, fixture comparison, then the
  cutover marker.

### Backups

Backups live outside the workspace root in a private recovery directory,
owner-only permissions where supported, excluded from watch/search/sync/
export/agent mounts. Preflight free space; never delete the only valid source
on disk-full. Manifest records opaque workspace ID, engine build, schema
fingerprint, checksum, size, retention — no document content. **Scope at
cutover: the whole `.dohc/engine` directory post-checkpoint plus a snapshot
of the desktop registry, DM homing map, and `.dohc/agent-runs.json`** (their
bindings reference workspace identities that change epoch at reset).
**"Verified" means restore-tested**: restore to a temp location, open with a
read-only checker, pass `integrity_check` plus row-count/domain-invariant
comparison against the source. Crash-test backup creation, validation,
retention cleanup, and disk-full behavior.

### Filesystem/database crash boundary

SQLite and the filesystem cannot share one transaction; materialization
intent is durable:

1. Commit canonical state + a durable materialization job/generation.
2. Write a sibling temp file, bounded bytes, restrictive mode.
3. Flush per the documented per-OS durability policy.
4. Atomically replace without following links — **on Windows via
   `ReplaceFile`/`MoveFileEx` semantics with bounded retry/backoff for
   sharing violations (AV/indexer transient handles), then fail closed**;
   POSIX rename assumptions do not transfer.
5. Record completion or leave the job pending; startup replays idempotently.

Every job carries expected disk presence, preimage hash/file identity, and
target generation; immediately before replacement the preimage is revalidated
without following links. If an external editor produced newer content after
the DB commit, do not overwrite: capture it and run the declared
merge/conflict/preserve-both path. Crash tests cover this race during
restore, version switch, merge, sync pull, and Y.Doc settle.

### Corruption behavior

Never auto-create an empty replacement over a corrupt database. Distinguish
unsupported-fingerprint, migration failure, corruption, permission, disk-full,
and transient lock errors. Preserve the original DB and WAL evidence. Offer
read-only diagnostics/recovery where safe. Redacted repair instructions and a
machine-readable diagnostic bundle — never containing document bodies,
secrets, keys, chat content, or tokens.

**Post-cutover active detection** (dogfood window): a scheduled background
verification job runs `PRAGMA quick_check`, a domain-invariant sweep, and a
bounded incremental disk-vs-DB inventory/hash diff; any mismatch produces a
preserved evidence bundle and a loud surface. Periodic post-cutover backups
run on the same verified-backup machinery so fix-forward incidents have a
fresh restore point.

## Mechanical fences (anti-dual-write)

"Never dual-write a canonical workspace" is enforced by machinery, not
convention:

- **Pre-cutover (Rust must not touch live workspaces):** every pre-Gate-7
  Rust build is compiled **shadow-only**: it refuses to open any workspace
  root lacking a harness-written clone marker
  (`.dohc/engine/SHADOW_CLONE` with a harness token), and refuses to open any
  `engine.db` bearing the TS v1 fingerprint for writing. Clone tooling
  creates markers; pointing a shadow binary at a real root is a hard startup
  error. The test harness additionally carries a denylist of Ice's real
  workspace roots and asserts every fixture path is outside them.
  Materialization in shadow builds is confined to the cloned root by the path
  floor, and that confinement is tested.
- **Post-cutover (TS must not touch Rust workspaces):** Rust initializes at
  `schema_version = 2`; every existing TS binary fails closed via the
  existing `engineDbSchema.ts:680` corrupt() check. No bridge release
  needed. Adversarially verified once in Gate 6 by launching the current TS
  desktop against a Rust-owned clone.

## Y.Doc: week-one spike and design

### The spike (week one; sole abort criterion)

Concretely, not just protocol-level:

1. Run the entire `ydocFidelity.test.ts` corpus through `yrs` and compare
   **converged doc JSON and markdown projection**, not just state vectors —
   divergence risk lives at the ProseMirror XmlFragment/attribute/Tiptap-
   schema level where two implementations can "converge" to different
   content.
2. Build a seeded alternating-driver fuzz: JS edit, Rust edit, random order/
   duplication/truncation/adversarial updates, compare converged content both
   directions. (~hundreds of lines; becomes the permanent R11 regression
   harness.)
3. Harvest real durable-update fixtures from Ice's own dogfood `engine.db`
   now (clean reset happens at cutover, not today). Fixture handling rules:
   copy-only extraction (never open the live file); harvested fixtures are
   personal content — they live locally outside the repo, scoped to the
   spike/R11 harnesses; raw fixtures are never committed or shared; anything
   committed must be synthetic, or deterministically redacted and
   secret-scanned with the scan result recorded.
4. Verify state vectors across alternating JS/Rust edits, compaction without
   convergence change, base-once durable lineage, and remote-apply
   origin/echo-suppression at the adapter layer.
5. Pin the exact yjs/yrs version pair as a locked, audited dependency — a
   later yjs upgrade can silently reopen interop divergence.

Pass → R11a starts as soon as R04's storage foundation lands. Fail → the
program pauses for an Ice decision. There is no fallback menu.

> **Verdict 2026-07-16: PASS** (PR #140, yjs 13.6.30 ↔ yrs 0.27.3 pinned).
> Binding carry-forward constraints recorded in `DECISIONS.md`: every
> wire-facing yrs `Doc` uses `OffsetKind::Utf16` (the byte-offset default is
> wire-unsafe); nested frontmatter map keys sorted before projection/
> content-addressing; UTF-16 well-formedness validated at the adapter; both
> engines share the declared root schema; projection provenance accounts for
> y-prosemirror's destructive normalization.

### Boundary design

Rust owns: the durable update resume cache, snapshots, state vectors,
compaction, leases, settle provenance, and replication. TypeScript owns: the
live Y.Doc and Tiptap/ProseMirror binding. Opening a document obtains a Rust
lease and initial update stream; a local JS update is durable only after Rust
ack; Rust emits accepted remote updates with sequence/generation metadata;
the TS adapter applies them with a reserved remote origin and never
re-journals them; TS produces markdown projections on request; Rust records
projection provenance and materializes through the durable pipeline.

The editor applies local changes optimistically before the durability ack,
so the adapter retains each unacknowledged update with a stable idempotency
key. On overload, timeout, daemon crash, lease invalidation, or close it
resends after Rust state/lease recovery, rebases visibly, or enters an
explicit recovery state — never silently discards an edit or journals it
twice. Tests kill the daemon after receipt, after commit, and before
response, then reopen and prove exactly-once durable convergence.

**R11 splits**: R11a (Rust durable cache/snapshots/compaction/leases) starts
right after the spike passes; R11b (the TS live-adapter protocol and editor
integration) starts as soon as R03's protocol freezes, so the adapter
accumulates dogfood hours through Phases 4–6 instead of debuting at shadow
replay.

## Policy and agent-run lifecycle

Policy files under `.dohc/**` are excluded from content capture, so the actor
has a dedicated bounded policy watcher or reload/version check before
protected operations. Partial writes/parse failures retain last-known-valid
policy only where explicitly safe; otherwise fail closed with a typed
diagnostic. Tests prove policy changes affect capture, search,
materialization, export, and sync consistently.

Agent runs: chat-dispatch records live in `engine.db`
(`chat_dispatch_ledger`, `agent_run_records`); local panel/MCP attribution
lives in `.dohc/agent-runs.json` (`AgentIntegration.ts:15-27`). Recommended
end state (open decision 7): the active-run lease and durable attribution
move under Rust; the JSON file remains as a derived inspectable projection.

## Preparation artifacts

All live in the program directory chosen at R00
(`docs/superpowers/plans/rust-engine/`), and all are machine-consumable:

- `ENGINE_SCOPE.md` — every public export and production caller classified:
  Rust authority / TS adapter / remains TS / retired-delete / decision
  required.
- `BEHAVIOR_INVENTORY.tsv` — one row per observable behavior: ID, current
  implementation and callers, inputs/outputs/errors/events, tables/files
  touched, transaction and ack boundary, ordering/idempotency, workspace/
  policy/secret classification, current tests + missing oracle, proposed
  crate::module, risk tier, port/review/parity status. This is the work
  queue.
- `STATE_OWNERSHIP.tsv` — the LIFETIMES.tsv analog: every long-lived resource
  (connections, transactions, watchers, leases, jobs, queues, caches,
  cursors, keys, handles, readers, requests, subscriptions, child processes)
  with owner, borrowers, thread/task affinity, max cardinality, cancellation,
  shutdown/drop order, crash recovery, may-outlive-session, and the test
  proving release.
- `PORTING.md` — approved mappings: undefined/null/omitted; JS numbers vs
  typed integers; timestamps/monotonic time; exceptions vs typed errors;
  promise serialization vs actors/channels; buffers/UTF-8/ownership; global
  registries; listener cleanup; SQLite binds/coercion/transactions; path
  normalization and fs identity; deterministic serialization; cancellation/
  deadlines; Drop/zeroization/shutdown; Arc/locks/atomics/channels/pools;
  banned shortcuts.
- `LANGUAGE_SEMANTICS_MATRIX.md` — TS/Node/SQLite → Rust for missing/null/
  defaults, numeric overflow/precision, iteration ordering, Unicode/BOM/line
  endings, JSON serialization, regex/glob, Windows drive/UNC/case/junction
  **plus rename-over-open-file and AV transient-lock semantics with
  conformance fixtures simulating a concurrent handle-holder**, POSIX
  symlink/descriptor behavior, SQLite types/errors/busy, hash inputs, async
  ordering, cancellation races, debug/release assertions, error
  compatibility. Every known difference points to a conformance fixture.
- `TEST_ORACLE.md` — trace format, normalizers, **named fault points**, crash
  tiers, anti-weakening mechanics (all specified below).
- `SHARDS.tsv` — **the machine-readable program state and the first thing
  every orchestrator session loads.** Columns: shard ID, behavior IDs, wave,
  dependency shards, owned `crate::module` paths and file paths, test files
  to port, risk tier, review tier, status (planned / in progress /
  implemented-unverified / parity-verified / gate-passed / cut-over /
  deleted), branch, PR. The orchestrator assigns shards; no self-claiming.
- `handoff.schema.json` / `findings.schema.json` — implementer handoffs and
  reviewer findings are structured outputs validated at the workflow layer,
  not prose. Handoff: shard/behavior IDs, files changed, APIs introduced,
  invariants relied on, exact commands/tests run, known semantic differences,
  resource bounds introduced, unsafe used (must be none), warnings remaining,
  recommended reviewer focus. Findings: severity, behavior ID, file/line,
  violated contract, concrete failure sequence, expected vs actual,
  regression test to add, blocks-integration, surfaces inspected even when
  clean.
- A reviewer-packet builder script assembling, by shard ID: behavior rows, TS
  source, diff, ported tests, and the specific contract docs — so spawned
  reviewers never improvise what "relevant contracts" means. Owned by
  R01-ORACLE (`tools/rust-engine-program/`); no Tier 1/2 review cell runs
  before it exists.
- `WINDOWS_DEV.md` — worktree layout under a short root path, per-worktree
  `CARGO_TARGET_DIR`, sccache shared across worktrees, Defender exclusions
  for all target dirs, the local concurrency budget (max 3–4 lanes running
  cargo concurrently; others in implement/review states), and a disk
  watermark that pauses new builds (Bun hit disk exhaustion even with cgroup
  isolation).
- `ENGINE_PROTOCOL.md`, `STORAGE_AND_RECOVERY.md`, `CRATE_GRAPH.md`,
  `UNSAFE.md`, `CUTOVER_AND_ROLLBACK.md` (now containing the reset state
  machine and loss ledger), `BEHAVIOR_DELTA.md`, `DECISIONS.md`,
  `EXECUTION_LOG.md` (append-only narrative behind SHARDS.tsv).

## Behavioral oracle and determinism

The oracle runs both engines against independently cloned fixtures and
compares normalized results: result + stable error code; events and ordering;
normalized `engine.db` logical state; object/version/moment/conflict graphs;
materialized files and modes; content hashes; search results and visibility;
chat/read/dispatch state; replication ops, origins, sequences, payloads,
acks; Y.Doc convergence; secret non-leak scans over DB/WAL/SHM/logs/export;
restart results; resource release.

**Determinism retrofit (R01, before any shard opens).** The trace format
requires a deterministic seed and clock, and the TS engine does not fully
offer one today: `syncReplication.ts:57` hard-codes
`origin_${randomUUID()}` with no injection hook; `ydocEngineDriver.ts`,
`secretFileStore.ts`, and `syncRelay.ts` call `randomUUID`/`Date.now`
directly; the capture layer is timer-driven. R01 closes every reachable
injection gap at the engine-store API (most stores already accept
`nowMs`/`createId` options — this is a handful of files), and fixes the trace
boundary at the engine-store API so watcher debounce timing is out of oracle
scope.

**Normalizers for the un-mappable** (committed in `TEST_ORACLE.md` before any
differential run): compare decrypted secret plaintext, not ciphertext (AEAD
nonces differ); converged Y.Doc content as doc-JSON + markdown projection,
not update bytes or client IDs; logical row state, not WAL/page layout.

**Week-one dual-use instruments** (pure TS, no Rust dependency, valuable
today):

- A trace recorder at the engine-store API capturing real operation traces
  from Ice's daily dogfood use — by the time Rust capabilities land, months
  of real-usage replay corpus exist.
- The secret non-leak scanner over DB/WAL/SHM/logs/export, run against the
  TS engine immediately.
- **Windows and macOS native CI runs of the existing TS engine suite** —
  the differential program is meaningless if the reference engine has never
  been tested on the founder's own platform. Fix or pin failures first;
  triage rule in `BEHAVIOR_DELTA.md`: when Rust is right and TS is
  platform-buggy, record an approved delta with a fixture — never make Rust
  reproduce the bug.

Never point both engines at the same workspace (mechanically fenced, above).

## Test porting program

The existing ~22k-line engine suite is the oracle. Porting it is a
first-class track with mechanized honesty:

1. **Classification first**: every existing test file is classified
   portable-behavioral / SQL-state-oracle (portable, given schema-shape
   stability) / hook-dependent (needs named fault points).
   "Implementation-specific, keep separate" is not a dumping ground.
2. **Named fault points as a shared engine feature**: the Rust testkit
   exposes crash/pause points by stable name over IPC; the TS engine maps the
   same names onto its existing hooks
   (`VersionedTextStoreTestHooks.beforeAtomicPublish` / `beforePersist` /
   `onLockBlocked` / `afterLoadWritableState`, and the hand-built post-crash
   filesystem states). One trace with an injected failure then runs on both
   engines. This is the single most important adapter-design decision and is
   fixed in `TEST_ORACLE.md` at R01.
3. **Anti-weakening mechanics** (Gate 6's "zero weakened tests" needs a
   detector, not attestation): per-behavior-ID assertion-count parity between
   original and ported files tracked in CI, plus a mutation-smoke gate — each
   ported suite runs once against a TS engine with a known injected bug; a
   ported suite that still passes was weakened, and the shard stops.
4. **After every differential trace**: close and reopen both engines, compare
   again, then perform another mutation to prove the reopened state is
   writable.
5. **Survivorship (Phase 8)**: when the TS engine — the differential
   oracle — is deleted, a curated subset of differential traces is frozen as
   golden input/normalized-output fixtures running against Rust alone in
   perpetuity, and the `EngineTestAdapter` suite becomes the permanent
   product suite. The hand-built in-memory reference model from Rev 1 is
   deferred indefinitely (pre-cutover, the TS engine is the reference model).

## Verification program

### Unit, property, and model tests

Pure state-machine tests for workspace/session/document/sync transitions;
property tests for ancestry, fork bases, merge, restore, conflict
preservation; idempotency for every retryable command; exhaustive error-code
and retryability tests; bounds at limit−1 / limit / limit+1.

### Differential tests

TS vs Rust for every behavior-inventory row; random operation sequences with
deterministic clocks/IDs; **Rust-to-Rust multi-instance replication with a
specified relay fault model** — seeded fuzz over {duplication, reordering,
drop, partition, relay restart mid-pull, peer crash between journal-apply and
cursor-advance}, N instances, converge, close/reopen/mutate; random Y.Doc
update order/duplication/batching via the spike's alternating-driver harness;
Windows/POSIX path corpus. Deleted: schema-variant differentials and
TS-peer↔Rust-peer wire interop (a state that exists for zero seconds under
all-devices-cutover + relay reset).

### Crash and failure injection — three explicit tiers

1. **Named in-process fault points** (the workhorse): before/during/after
   transaction; after DB commit before response; around journal append,
   cursor advance, temp-write/flush/rename, migration, backup, Y.Doc
   snapshot/compaction/settle, secret encrypt/materialize, index update,
   drain; at disk-full/permission/locked-file/corrupt-row/truncated-frame
   boundaries.
2. **Real process kill**: SIGKILL/TerminateProcess of the sidecar at
   randomized times during E2E scenarios (including parent-death), restart,
   assert integrity and exactly-once ack semantics.
3. **Torn-write/power-loss: honestly de-scoped** to SQLite's WAL guarantees
   plus the documented per-OS materialization durability policy (which
   flushes are issued on which OS and what is consequently guaranteed).
   Implied coverage is worse than honest de-scoping.

After every case: restart, assert integrity, idempotent retry, no silent
loss.

### Fuzzing — prioritized by input trust

Cutover-blocking (three families, remote/cross-process input): Y.Doc update
ingestion, IPC framing/protocol validation, replication envelopes.
Post-cutover continuous: policy TOML, paths/globs, migration/fingerprint
readers, secret envelopes, import/export manifests. Fuzzers run as background
tasks on the dev machine via the orchestration loop; every failure stores
seed/input and adds a regression test.

### Resource and soak tests — right-sized

Cutover-blocking: ~1,000 workspace open/close cycles; a 30–60 minute soak;
binary checks — threads/OS handles/queue depth return exactly to baseline
after all workspaces close (zero unowned handles), no monotonic RSS slope by
simple linear fit, queues return to steady state after bursts, workspace
close returns owned resources to baseline plus a documented constant, no
unbounded WAL/update-log/replication-log/index growth under
compaction/retention scenarios. Repeated sidecar crash/restart loops,
two-workspace switches with in-flight requests, watcher storms, cancellation
storms, and editor open/update/close cycles stay in.

Post-cutover (continuous during the dogfood window, not critical-path): the
6-hour and 24-hour statistical soaks with trend bounds — the founder is the
canary and dogfood time is free soak time. Track RSS/allocator, handles,
SQLite connections and WAL size, queue depths, session counts, task/worker
counts, cache bytes, latency, cancellation latency, shutdown duration.

### Performance gates — engine-attributable only

Cutover gates: open 1,000-file workspace ≤ 1,500 ms; file-tree search over
10k paths ≤ 100 ms; first content-search result ≤ 300 ms; complete content
search ≤ 1,500 ms; single-file sync detection ≤ 2,000 ms; 100-file change set
≤ 3,000 ms; no critical operation regresses > 10% at p95 against the honest
recorded baseline; sidecar steady-state RSS ≤ the isolated TS-engine
baseline; full app inside the existing 20% working-set ratchet. Shell/typing
budgets (cold 2,000 ms, warm 1,200 ms, long task 50 ms) are tracked as
informational — they are app properties, and their enforcement
infrastructure is a separate initiative (today no budget is CI-enforced at
all). p99 gating waits for post-cutover telemetry; do not gate on runner
noise. Do not invent numbers; record baselines first.

### Cross-platform matrix

Every cutover candidate passes on Windows x64, macOS x64, macOS arm64, Linux
x64: Rust build/format/lint/tests, protocol conformance, filesystem/path
suite, SQLite migration/integrity suite, packaged binary
presence/hash/version smoke, sidecar parent-death and restart, workspace
cleanup/handle release. Full engine-adjacent Electron E2E per platform before
Gate 6 (smaller native smoke subsets on PRs). Every native run asserts host
and binary architecture so cross-built artifacts can't masquerade as native
evidence. Nightly, not per-PR: per-platform E2E and soaks. **Prerequisite
(week one): the mandatory matrix is open decision 2 and must be approved
before capability lanes open** — the dev machine is Windows-only, so every
macOS claim in every lane's evidence requires CI.

## Multi-agent orchestration

### Capacity model

Orchestrated by Claude Code: Workflow cells run up to ~16 concurrent
subagents with per-agent git worktree isolation, structured outputs, and
background loops babysitting long-running jobs (soaks, fuzzers, PR review
bots). Codex (`gpt-5.6-sol` via `codex exec`) is effectively free additional
labor: **default implementer for mechanical port shards and third independent
reviewer for durability-critical shards**, always labeled `gpt-5.6-sol:` and
run in isolated worktrees. R00 checklist item: upgrade the Codex CLI (or bake
the current `-m` model workaround into the wrapper prompt template) —
scripted `codex exec` must work on first contact. Codex tokens are invisible
to workflow budgets; track its throughput in the execution log.

### The cell

```text
spec + behavior IDs + reviewer packet (built by script, not improvised)
        |
one implementation agent (Claude or gpt-5.6-sol per shard class)
        |
committed diff + ported tests + machine-validated handoff (handoff.schema.json)
       / \
reviewer A: behavior equivalence   reviewer B: robustness/security
(clean contexts; packet only; never the implementer's reasoning)
       \ /
triaged findings (findings.schema.json)
        |
fixer agent (cold context: handoff + findings only)
        |
re-check: a fresh clean-context agent receives packet + prior findings +
fix diff; verifies each finding plus a bounded spot-check; full re-review
only when the fix diff exceeds the findings' scope
        |
integrator verifies, runs the anti-weakening checks, accepts
```

Reviewer A (behavior equivalence) receives original TS source/tests, Rust
diff, porting guide, semantics matrix; hunts omitted branches, changed
defaults, error/ordering/idempotency drift, accidental redesign. Reviewer B
(robustness/security) receives the diff plus scope/ownership/storage/protocol
invariants; assumes the code is wrong; hunts data loss, workspace leakage,
identity trust, policy bypass, path escape, unbounded resources, deadlock,
cancellation races, drop ordering, crash inconsistency, secret leakage,
SQLite mistakes. Durability/security-critical shards add a third reviewer
(Codex). "Looks good" without inspected failure modes is not an acceptable
high-risk review result.

### Review tiers (pre-approved at Gate 0 — no per-PR exemption requests)

- **Tier 1 (storage/crypto/collab/replication/cutover shards)**: full stack —
  two Claude adversarial reviewers + Codex review + CodeRabbit + local Claude
  (Fable 5, fallback Opus 4.8) loop-until-clear with PR comments per repo
  convention.
- **Tier 2 (mechanical port shards)**: implementer (default Codex) + two
  clean-context Claude adversarial reviewers + CodeRabbit; Codex/local-Claude
  review batched at the capability-boundary integration PR.
- **Tier 3 (test-port and fixture-only PRs)**: one adversarial reviewer +
  CodeRabbit; the anti-weakening CI checks are the real gate.
- **Program-control docs** (this plan, `TEST_ORACLE.md`,
  `CUTOVER_AND_ROLLBACK.md`, the schemas, `WINDOWS_DEV.md`, `DECISIONS.md`):
  Codex + local Claude review, and plan-content changes additionally need
  Ice's sign-off — these documents define reset, authority, and privacy
  behavior, so they review like code. Routine status appends
  (`EXECUTION_LOG.md`, SHARDS.tsv status column) are Codex-only. This
  implements the repo's standing PR review loop; it does not replace it.

Per-PR bot loops (push → `@codex review` → local Claude → comment scope →
repeat) run as self-pacing background loops per open PR, not orchestrator
polling.

### Worktree and Git rules

Each shard: branch `codex/rust-engine-<shard>`, own worktree, unique
`CARGO_TARGET_DIR`, PR to `main`, dormant after merge. Ownership is
**module/table-family level** per SHARDS.tsv (e.g. R09 owns `domain::chats` +
`storage::chat_tables` + its test files); lanes own their leaf modules and
per-crate test files. The integrator exclusively owns: workspace root Cargo
files/lockfile, protocol schemas, generated bindings, shared error/type
cores, migration ordering, desktop supervision, CI, and cutover wiring — and
lands choke-point requests on a **batched cadence (2–3 merges/day, single
regenerate-bindings command)** so lanes never block longer than half a day.
Shards file choke-point requests naming the exact change; the integrator
lands it in a dedicated commit/prerequisite PR; the shard incorporates it.
No `git stash`; no `git reset --hard`; no reverting another lane's work; no
unapproved force-push; no formatting outside owned paths; no agent edits
another lane's files; no concurrent writers in one worktree; no
schema/protocol change without integrator sequencing; one coherent behavior
commit over thousands of single-file commits. After every merged PR, delete
the remote branch (unless an open dependent PR needs it) and verify the ref
is gone.

### Compiler and test loops

`main` and every capability PR compile at capability boundaries. Compiler
errors are saved as a generated queue grouped by owning crate/module. Never
"fix" compilation with stubs, placeholders, or fabricated success. Each shard
runs focused tests, then conformance, then integration; the integrator
centralizes full matrix/soak runs. Save deterministic seeds and minimized
traces for every nondeterministic failure. Bound test CPU/memory/process/
disk/duration; monitor disk and clean up child processes and workspaces
explicitly.

### Program continuity

`SHARDS.tsv` (status column) is the machine-readable source of truth every
orchestrator session loads first; `EXECUTION_LOG.md` is the append-only
narrative. Gate reviews get a one-page decision summary with links into
evidence. Ice-facing decisions batch into a daily digest instead of
per-exception interrupts. Status vocabulary: planned / in progress /
implemented but unverified / parity verified / gate passed / cut over /
deleted. "Mostly done" is not a status.

## Waves and shards (replaces the linear lane table)

Lane IDs are retained for continuity but scheduling is by dependency wave,
recorded per-shard in SHARDS.tsv:

**Wave 0 — week one, all parallel:**

- **yrs interoperability spike** (sole abort criterion; spec above).
- R00: this plan revision (done), program directory, SHARDS.tsv +
  schemas + packet builder + WINDOWS_DEV.md, Codex CLI fix, execution log.
- R01: behavior inventory; determinism retrofit; trace format + named fault
  points in `TEST_ORACLE.md`; trace recorder in dogfood; secret scanner;
  test-file classification; **TS suite native CI on Windows/macOS**.
- R02: Cargo workspace, toolchain, policy lints, CI skeleton; resolve open
  decision 2 (matrix policy).
- R03: protocol spike, generated client, bounded supervisor skeleton
  (replaces thread-per-request).
- Test-port shards begin as classification completes (Tier 3, high
  parallelism, Codex-heavy).

**Wave 1:** R04 storage core (day-one v2 schema + migration/idempotency/job
ledgers + backup/integrity + SQLite linkage decision), protocol freeze,
Phase-1 calibration slices (workspace open/close + transaction + restart;
versioned write/read/history/restore; scan/hash/reconcile + cancellation +
bounds) — each through the full cell as calibration.

**Wave 2 — parallel, disjoint module ownership:** R05 file identity/blobs/
versions/moments/restore; R08 secrets; R09 chats/read state/dispatch; R11a
Y.Doc durable cache (post-spike); R11b TS live adapter (post-protocol-
freeze); R12 search.

**Wave 3 — as prerequisites land:** R06 compare/merge/conflicts/
materialization recovery; R07 watcher/reconcile/path floor/policy; R10
replication/cursors/share apply (+ shared security-vocabulary contract
package with parity fixtures).

**Wave 3 (continued):** **R13b dormant desktop adapter** — the generated
client plus feature-flagged parallel wiring of `main.ts`/capture/activity/
sync call sites and sidecar supervision, started as soon as R03's protocol
freezes and landed unreachable in normal-sized PRs across Waves 3–4, so the
~8.5k lines of desktop rewiring never debut in the cutover PR.

**Wave 4:** R13 daemon composition + shadow replay (depends on R13b —
shadow replay exercises the real adapter, not a throwaway harness).

**Wave 5:** R14 robustness closure (fuzz targets stand up as each parser
surface lands, from Wave 1 onward; nightly soaks accumulate from Wave 4 so
Gate 6 reviews a trend history, not a first result).

**Cutover:** R15 atomic cutover + reset. **Deletion:** R16 legacy deletion
and hardening.

## Engine freeze and churn policy

The engine is currently churning ~218 commits/30 days, concentrated exactly
on the port's critical path (`versionedTextStore.ts` 34, `engineDbSchema.ts`
23, `linkedChatStore.ts` 23, sync ~22). Policy:

- **From Wave 0**: freeze `engineDbSchema.ts` and the sync/replication wire
  surfaces (schema and wire churn invalidates the most downstream Rust work
  per commit).
- **From Wave 1 (Phase 2 open)**: full engine feature freeze. Exceptions
  require Ice's approval, and the excepted PR must update
  `BEHAVIOR_DELTA.md` and the affected SHARDS.tsv rows in the same PR —
  enforced by a CI check on engine paths. The delta-reconcile machinery is
  the exception path, not the steady state.
- The freeze is an explicit accepted cost; the wave structure exists to keep
  it short. Product work that does not touch the engine continues freely.

## Execution phases and gates

Gates gate **cutover-relevant claims**, not work start; wall-clock-bound
evidence (soaks, E2E) accumulates nightly from mid-program.

### Phase 0 (Wave 0) — preparation

Deliver: all preparation artifacts; behavior inventory; determinism retrofit;
trace recorder live in dogfood; TS suite green natively on Windows/macOS (or
failures pinned as approved deltas); protocol/toolchain decisions; CI matrix
approval; baseline test/memory/perf/handle/WAL/shutdown evidence; the yrs
spike verdict.

**Program authorization (given 2026-07-16):** Ice's go signal on this
revision. It authorized Wave 0 — preparation artifacts, spikes, and dormant
scaffolding — and nothing further.

**Gate 0 (closes Phase 0, opens Wave 1 capability work):** yrs spike passed;
remaining open decisions resolved by Ice, including the CI/resource budget;
two independent reviewers approve `PORTING.md`, `STATE_OWNERSHIP.tsv`, and
the semantics matrix together; the reviewer-packet builder exists. No
capability shard starts before this gate.

### Phase 1 (Wave 1) — calibration slices

Three slices through the full cell.
**Gate 1 (calibration, not go/no-go):** porting-guide accuracy, shard sizing,
review depth, and throughput adjusted from evidence; protocol and packaging
are boring; state ownership is clearer than the current design; no
unexplained differential mismatch; resource bounds enforceable; no unsafe
emerged. Outcome: proceed as planned / adjust approach.

### Phase 2–3 (Waves 1–3) — durable, security, and filesystem core

**Gate 2:** every core behavior row has a Rust implementation and oracle
trace; crash points around transactions and materialization pass; integrity
and property tests pass; the mechanical shadow fence is in place and tested.
**Gate 3:** path/symlink/junction/case corpus passes on all platforms;
protected/ignored/secret rules match or intentionally improve via approved
delta; plaintext scans find no secret in DB/WAL/SHM/logs/search/export;
pending materialization recovers after every injected crash; search is
read-your-writes and workspace/policy safe.

### Phase 4 (Waves 2–3) — collaborative and social state

**Gate 4:** Rust-to-Rust randomized replication converges under the named
fault model {dup, reorder, drop, partition, relay restart, crash between
apply and cursor advance}; reapply is idempotent; imported
state/op/ack/cursor atomicity passes crash injection; Yjs/yrs convergence
holds at doc-JSON + projection level; remote updates cannot be echoed or
overwritten by stale close; chats/reactions/decisions/reads/mentions/dispatch
match the oracle; awareness stays ephemeral.

### Phase 5 (Wave 4) — composition and shadow replay

Production still runs TS. Dogfood traces replay against isolated cloned
workspace copies through the R13b adapter.
**Gate 5:** no Rust shadow process can write a live workspace (fence tested
by attempting it); all behavior rows implemented/replayed or explicitly
deleted; no production raw `engine.db` consumer lacks a replacement API
(including `desktopAgentDispatchStore.ts`); full desktop E2E passes against
Rust in an isolated cutover build; sidecar restart invalidates old sessions;
workspace-switch/request-generation race suite passes.

### Phase 6 (Wave 5) — robustness closure

**Gate 6 (release candidate):** zero skipped/weakened/deleted parity tests
(mechanically checked); no open P0/P1; no unexplained differential mismatch;
no unsafe; all package artifacts contain the correct tested binary; resource
plateaus per the right-sized budgets; engine perf gates pass;
**a full clone-reset rehearsal has run end-to-end on a byte-clone of every
real dogfood workspace**, verifying recaptured inventory and settled-
projection completeness against pre-reset state; the current TS desktop
launched against a Rust-owned clone and provably could not write; CodeRabbit,
Codex, local Claude, and security reviews clear.
**Gate 6 authorization:** Ice reviews the evidence packet (one page + links)
and explicitly authorizes the irreversible cutover.

### Phase 7 — atomic cutover with clean reset

Freeze schema/protocol for the window. All of Ice's devices cut over in one
operation (enumerated in the checklist); relay streams for reset workspaces
are wiped or re-keyed to a **new replication epoch/stream identity** — a
fresh Rust engine must never attach to a pre-reset stream (resurrected
pre-reset operations are silent corruption via the sync path). Devices that
miss the window: the relay permanently rejects pre-reset epoch/stream
credentials; a stale device never pushes — it rejoins the new epoch fresh,
and any unpushed local edits on it are exported and manually
rebased/imported, never automatically replayed into the reset workspace.

Per-workspace reset state machine (durable on-disk marker; every state
idempotently resumable; crash injection at every transition rehearsed in
Gate 6):

```text
not-started → settled → backed-up → moved-aside → initialized → capturing → complete
```

1. **Settle (under the last TS build)**: force-settle every live and durable
   Y.Doc to its markdown projection; verify projection freshness (state
   vector matches recorded projection provenance for every atom); **fail the
   reset if any document cannot settle** — `atoms.body` is a derived cache,
   and skipping this step silently loses any Y.Doc content newer than its
   materialized markdown.
2. **Loss ledger + export + inventory**: present the per-data-class ledger
   (survives-on-disk / exported / destroyed — chats, decisions, reactions,
   mentions, read state, agent runs, version history, moments, conflicts,
   Y.Doc lineage, cursors are engine.db-only); export chats/decisions/history
   to inspectable text files **written outside the workspace root in the
   recovery/export directory** (never into the workspace tree, so exports
   cannot perturb the capture comparison); Ice acknowledges per workspace.
   Then record the pre-reset disk inventory — file identity, size, mode,
   content hash, generation, and the exclusion list — durably in the reset
   marker/backup manifest.
3. **Backup**: checkpoint WAL, integrity-check, restore-tested backup of the
   whole `.dohc/engine` dir + registry/DM/agent-runs snapshot, manifest
   recorded.
4. **Move aside**: prove-zero-handles first — attempt exclusive open of
   **every file in the old DB triplet (`engine.db`, `-wal`, `-shm`)** with
   bounded retries; the TS engine's process-global stores leak WAL handles;
   on timeout, fail closed read-only with diagnostics. Prefer
   copy+verify+swap over bare rename so a failure can't strand a half-moved
   WAL triplet. Old DB is retained, never auto-deleted pre-launch.
5. **Initialize**: Rust fresh-init at schema v2; record ownership and a
   first-durable-write flag.
6. **Capture**: initial capture from disk; verify capture inventory (file
   count + hashes) against the persisted post-settle inventory recorded at
   step 2.
7. **Complete**: marker written; packaging now hard-fails without the engine
   binary; protocol/storage incompatibility fails visibly; startup may offer
   read-only recovery but never a TypeScript authority.

The restore tool refuses to restore any backup whose manifest generation
predates the current Rust DB's latest committed generation unless given an
explicit `--destroy-newer-work` flag that prints what will be lost.

**Gate 7:** Rust is the only canonical writer; all supported paths work
offline; sync reconnect and co-edit work on the new epoch; the reset
procedure and restore tool are tested and documented; no TS fallback exists.
Stable release requires a **second explicit Ice approval** after the defined
canary/dogfood window (open decision 8) with the background verification job
clean.

### Phase 8 — deletion and hardening

Delete retired TS engine mutation implementations (retain only generated
client types, editor/projection adapters, UI models, and approved black-box
test readers); delete the kernel spike and every fallback path; freeze the
golden-trace fixtures; refactor mechanically ported Rust toward idiomatic
modules without behavior change; continue fuzzing, leak/soak jobs, and the
background verification job.
**Gate 8:** production imports and raw-SQL audit clean; no dead dual-engine
flag; docs describe Rust as current truth; execution log lists every deletion
and retained adapter; branch cleanup verified.

## Stop-the-line rules — with detectors

Every rule names its detector; any rule whose detector is "reviewer
attention" is flagged to Ice as accepted risk.

| Trigger | Detected by |
| --- | --- |
| Test skipped/weakened/deleted for parity | assertion-count parity + skipped-test ratchet + mutation smoke in CI |
| Stub/placeholder satisfies compiler | CI grep: `todo!`/`unimplemented!`/placeholder patterns |
| Unapproved unsafe | `#![forbid(unsafe_code)]` compile failure in ordinary crates, plus a CI scan matching every `unsafe` occurrence across all crates (incl. any approved FFI crate, which cannot carry the forbid attr) to an `UNSAFE.md` approval entry |
| Workspace/auth/lock/policy/secret invariant weakened | invariant test suites + reviewer B checklist (accepted-risk residual) |
| Schema/protocol change without contract + migration update | integrator-owned paths + CI check on generated files |
| Unexplained differential mismatch | harness: every mismatch must attach an explanation or open a stop |
| Nondeterministic failure without saved seed/trace | harness assertion — fails the run itself |
| Resource growth without documented bound | soak trend checks + queue-depth assertions |
| Unresolved P0/P1 | SHARDS.tsv status gate |
| TS and Rust touch the same comparison workspace | shadow-clone marker + real-root denylist + v1-fingerprint write refusal |
| Agent writes outside shard ownership | pre-merge path-ownership hook derived from SHARDS.tsv |
| `main`/capability PR loses green beyond bounded repair | CI |
| Package can omit the engine binary | packaging assertion (post-cutover: hard fail) |
| Corruption handled by empty init or silent fallback | corruption test suite + code review (accepted-risk residual) |
| Forbidden Git ops, overwritten unowned work, reviewer separation breach, waived review on timeout, generated files edited outside the generator | orchestrator-level checks between agent turns + audit of the execution log |

## Program reporting

Per lane in the execution log: scope/behavior IDs, branch/worktree/owner,
commits/PR, files changed, exact commands and results, differential fixtures
and seeds, perf/resource evidence, failure-injection coverage, implementer
handoff, both adversarial reviews, CodeRabbit/Codex/Claude results,
security/privacy notes, cutover impact, unresolved risks, gate decision and
approver.

## Timeline estimate (honest, not a commitment)

With the wave structure, the freeze, ~16-way Claude cells plus Codex labor,
and the audit's binding constraints (integrator throughput, review-loop
latency, CI matrix availability, wall-clock soaks, and Ice's solo gate
reviews — not implementation speed):

- Week 1: Wave 0 — yrs spike verdict, artifacts, determinism retrofit,
  protocol/CI decisions, test-port start.
- Weeks 2–3: storage core, protocol freeze, calibration slices (Gate 1).
- Weeks 3–6: parallel capability waves (Gates 2–4).
- Weeks 6–9: composition, R13b adapter, shadow replay, nightly robustness
  accumulation (Gate 5, Gate 6 evidence).
- Weeks 9–12: cutover rehearsals, canary, reset, deletion (Gates 6–8).

Realistic: **8–12 weeks**; optimistic 6–7. The engine freeze spans roughly
Waves 1 through cutover.

## Immediate next steps after the go signal

Do not begin porting `versionedTextStore.ts`. Open Wave 0:

1. Program directory + SHARDS.tsv + schemas + WINDOWS_DEV.md + execution
   log; Codex CLI fix. (The reviewer-packet builder is R01-ORACLE's, not
   R00's — no Tier 1/2 review cell runs before it exists.)
2. The yrs spike (fixtures harvested from Ice's dogfood engine.db first).
3. `ENGINE_SCOPE.md`, `BEHAVIOR_INVENTORY.tsv`, `STATE_OWNERSHIP.tsv`,
   `PORTING.md`, `LANGUAGE_SEMANTICS_MATRIX.md`, `TEST_ORACLE.md`.
4. Determinism retrofit; trace recorder into dogfood; secret scanner; TS
   suite native on Windows/macOS CI.
5. R02 Cargo/CI skeleton; R03 protocol spike.
6. Honest baseline measurements.
7. Two independent adversarial reviews of the preparation set.
8. Gate 0 decision summary to Ice.

## Definition of success

Users experience the same or deliberately approved-better dohc behavior; Rust
is the sole canonical local writer; normal files remain inspectable and
agent-friendly; offline operation, versions, history, restore, search, chats,
secrets, sync, and co-editing pass their product tests; crashes at every
durable boundary recover without silent loss; random replication/Y.Doc
interleavings converge; memory, handles, queues, sessions, WAL, and logs stay
bounded; all packages contain the correct tested sidecar; every platform is
green; no parity test was skipped or weakened; no secret or workspace
metadata crosses its boundary; the TypeScript mutation authority and every
silent fallback are deleted; and future agents inherit explicit protocol,
ownership, state-machine, migration, test, and review contracts.

The intended result is boring in the best sense: greater stability, recovery,
and headroom — not a different product.
