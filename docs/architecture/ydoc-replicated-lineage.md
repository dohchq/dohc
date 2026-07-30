# The replicated Y.Doc lineage, and how its base is claimed

This records an algorithm whose only worked implementation is scheduled for
deletion. `packages/workspace-engine/src/ydocEngineDriver.ts` is the legacy
TypeScript engine's Y.Doc driver; R16 removes that package. The Rust daemon has
the storage columns and the emit condition, but **no working origination path** —
so when the TypeScript driver goes, the reference goes with it.

Written down here rather than left in a deleted file's history, because the
oracle case that proves this behaviour (`ydoc.before-base-claim`,
`TEST_ORACLE.md`) has its harness *inside* the file being deleted. Delete the
file and the test disappears silently along with its subject.

Nothing here is a claim about current behaviour. **No rich document has ever
replicated** — see #378 and #356. This is a specification to build against, not
a description of something running.

## Why a base needs claiming at all

A replicated Y.Doc is one durable CRDT lineage that every peer converges to. A
peer that has never seen the document — no file, no prior state — must be able to
reconstruct it from the operation log alone. That requires the log to open with a
full-state **base** operation, followed by deltas.

The base must be emitted **exactly once per lineage**. Everything below follows
from that one requirement.

## Why re-seeding is the failure to design against

The tempting implementation is to seed the CRDT from the file's markdown every
time the document opens. It is wrong, and it fails in a way that is invisible
locally.

`markdownToYDoc` mints **fresh Yjs item ids** on every call. Two independent
seeds of identical text therefore produce two different lineages. A peer that
replays `base1 + deltas + base2` merges both and **duplicates the content**. The
originating machine looks fine — it only ever had one lineage in memory.

So the lifecycle is asymmetric on purpose:

- **First creation**, no persisted lineage: seed from markdown, emit the
  full-state base exactly once.
- **Every subsequent open**: resume from the persisted CRDT. Never re-seed.
- **Close**: settle the projection but **do not prune** the CRDT rows. They must
  stay durable both for the next resume and for a peer bootstrapping from the
  log. A replicated document never prunes and never re-emits a base.

## The local-only path, and why it may prune

A document with `replicated: false` keeps *markdown as the artifact*: the settled
`.md` file is the durable, searchable, restorable, diffable record; the object
journals no `ydoc.update` operation at all; the update log is only a fast-resume
cache; and closing prunes it, so reopening reseeds from the file with no loss.

Prune-on-close is correct **only** here. A document that never replicated cannot
diverge a peer. Do not generalise the pruning path to replicated documents — that
is the same forked-lineage bug arriving by another route.

The storage is deliberately additive-compatible: flipping
`persistClosedSessionState` makes even a local-only close keep its CRDT bytes,
with no schema change.

## The claim itself

Four properties, all load-bearing:

**1. Cap the base before writing anything.** An oversized base would journal
locally and then be rejected by every peer on hydrate
(`MAX_VERSIONED_BINARY_FILE_BYTES`), leaving a document that can never replicate
and no local signal that anything is wrong. Reject it locally *before* the blob
put and before the journal write.

**2. Re-check for an existing lineage inside the claim transaction.** A
pre-read that says "no lineage" is not enough. Another process can win the
first-open race between that read and the write. Inside the write transaction:

```sql
SELECT 1 FROM ydoc_docs
 WHERE workspace_id = ? AND version_id = ? AND object_id = ?
```

If a row exists, the concurrent writer already committed this lineage. Return
`exists`, seed nothing, journal nothing, and resume the winner's state. Emitting
a second base here is exactly the fork described above.

**3. Journal the base in the same transaction as the snapshot rows.** The
snapshot blob lands in `binary_blobs` first, satisfying blob-before-log, and the
`ydoc.update` base operation is journaled in that same transaction. Split them
and a crash between the two leaves a log entry referencing a blob that does not
exist, or a blob no peer is ever told about.

**4. Exactly-once falls out of structure, not vigilance.** The claim runs only
on first creation, and step 2 makes concurrent first-creation collapse to one
winner. There is no counter to maintain and no idempotency check downstream.

## The single-canonical reservation is process-global

The invariant "never two live Y.Docs for one object" must hold across every
driver instance in the process, not merely within one
`createYDocEngineDriver()`. The reservation is therefore process-global.

Related, and easy to get wrong when porting: writes go through a single write
lane. `node:sqlite` busy-waits block the JS thread, so two same-process writers
on separate connections deadlock until `busy_timeout`. The driver keeps its own
connection for **reads only** — WAL readers never block a writer. A Rust port
does not inherit the JS-thread constraint, but it does inherit the need for a
single writer per lineage.

## The test seams, and why they must be replaced rather than dropped

Two seams exist because these properties are otherwise unprovable. A port that
drops them keeps the behaviour and loses the proof, which is how this program's
dominant defect class — tests that pass while checking nothing — gets introduced.

- **`onBeforeBaseClaimForTest`** fires on a replicated first-creation open, after
  the pre-read has decided "no lineage" but **before** the atomic claim
  transaction. It lets a test commit a competing base on a separate connection,
  simulating a cross-process first-open race, and then assert that the claim's
  re-check observes it: resume the winner, journal no second base. This is the
  harness for oracle case `ydoc.before-base-claim`. Without an equivalent seam,
  property 2 above has no test.
- **`onAfterReserveForTest`** fires inside `openSession` after the global
  reservation is taken and persisted state is reset, but before the live session
  is installed. It lets a test simulate a mid-open failure in a later step and
  prove the reservation is released on *any* throw, never stranded "live".

Both are undefined in production.

## What the Rust side has, and what it is missing

The storage and the emit condition exist. The origination does not.

- Outbound journaling requires `emit_outbound: regime == Regime::Replicated &&
  base_claimed` (`crates/dohc-engine-collab/src/durable.rs:597`).
- The only SQL setting `regime = 'replicated'` is at `durable.rs:768`, inside
  `claim_base_in_tx`.
- `claim_base_in_tx` has exactly two non-test callers: `claim_base`
  (`durable.rs:719`), a public wrapper with **no** caller of its own, and the
  **inbound** apply at `crates/dohc-engine-sync/src/ydoc_apply.rs:715`. So the
  only live path into a replicated marker is a peer handing us one.
- No RPC reaches the origination path. `YDOC_METHOD`
  (`packages/workspace-engine-client/src/ydoc/ydocWireContract.ts`) exposes
  `ydoc.open`, `ydoc.recordUpdate`, `ydoc.settle`,
  `ydoc.applyExternalMarkdownEdit`, `ydoc.close` and `ydoc.resync` — there is no
  `ydoc.apply`. (Do not confuse the two: `applyExternalMarkdownEdit` is a
  different method and is wired.)
- `crates/dohc-engine-collab/Cargo.toml` states it plainly: *"Dormant; not wired
  into the product."*

So the Rust side can mark a lineage replicated when a **peer** hands it one, and
cannot originate one itself. That gap is #378.

## Do not fix base origination on its own

Implementing this specification alone would make rich `.md` documents replicate
while plaintext, binary and secret files silently do not — worse than today's
uniform nothing, because partial replication looks like working sync.

The paired gap: only chat operations and the dead ydoc path write to the
relay-visible `replication_log`. File, text and secret writes go to
`replication_journal`, a different table, and nothing drains one into the other.
Both belong to #356, and
`apps/desktop/e2e/workspace-sync-rejoin.spec.ts` is the acceptance gate for the
pair — currently disabled, which is how both gaps survived a cutover with no red
test.

Before claiming any sync behaviour works, check which table the write landed in.
