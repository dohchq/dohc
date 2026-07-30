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
- **Close**: settle the projection, and **do not prune the lineage**. The CRDT
  state must stay durable both for the next resume and for a peer bootstrapping
  from the log. A replicated document never re-emits a base.

"Do not prune the lineage" is not "do not delete rows", and the distinction
matters or a port retains an unbounded update log. **Bounded compaction is
required, not forbidden.** Both implementations fold the update log into a fresh
full-state snapshot and then delete the folded updates and now-superseded older
snapshots — `compact` in the TypeScript reference, `maybe_compact` in Rust, which
a replicated close calls with a threshold of `0` to force it. That is
convergence-neutral: the snapshot is a full-state re-encode, so reconstructing
from it yields the same converged content as replaying the un-compacted log.

The invariant is that whatever remains must still reconstruct the lineage. Delete
what is redundant; never delete the lineage itself.

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

**2. Re-check inside the claim transaction — on `base_claimed`, not on row
existence.** A pre-read that says "no lineage" is not enough: another process can
win the first-open race between that read and the write.

But the predicate matters, and the TypeScript reference gets it wrong for a port's
purposes. It tests row existence in `ydoc_docs`. A bare marker row is *not* a
claimed lineage — `ensure_marker` deliberately creates one with
`base_claimed = 0`, so a document previously opened **local-only** already has a
row. Following row-existence would return `exists` for it, and its base would
never be promoted or journaled when it later becomes replicated.

Test the claimed-state predicate. The Rust side does this correctly
(`claim_base_in_tx`, `durable.rs`): read the head, and branch on `base_claimed`.

There is a second condition the TypeScript version does not have, and it is
load-bearing. When a base *is* already claimed, look up the stored seq-0 snapshot
sha and branch **three** ways — not two:

| Stored sha | Action |
| --- | --- |
| present and **equal** to the incoming base | resume |
| present and **different** | **fail loudly** — the lineage has diverged |
| **absent** | resume |

The middle arm is the one the TypeScript reference lacks: silently resuming and
acking a *different* base drops a divergent lineage while the relay cursor
advances past it, leaving that peer's later updates depending on an operation
nobody can recover.

The third arm is not an oversight, and getting it wrong is worse than the bug the
second arm fixes. Compaction legitimately folds the seq-0 base away once later
updates supersede it (see the compaction note above), so a missing snapshot is the
*normal* state of a long-lived document. At that point divergence is no longer
verifiable, base-once still holds, and refusing would wedge the relay cursor on a
**valid** replica. Resume.

So the sha comparison is conditional on the original snapshot still existing.
Stating the rule unconditionally — "resume only if the incoming base is the stored
base" — would make an implementation reject every base delivery after the first
compaction.

Otherwise: seed nothing, journal nothing, resume. Emitting a second base is the
fork described above.

**2b. A promoted lineage's base must encode the persisted state, not a fresh
seed.** This follows directly from the case above and is easy to miss, because
"first creation" suggests there is nothing to preserve.

An unclaimed marker is not necessarily an empty one. A `base_claimed = 0`
local-only document can already hold durable update rows — a crash before
settle/close leaves exactly that. Those rows were never written to
`replication_log`, so if promotion journals a *fresh markdown seed* as the base,
the origin still reconstructs its content from its own private rows while every
new peer is permanently missing it. The divergence is invisible from the machine
that has the data.

So the base must be the **reconstructed lineage plus** the incoming bytes. The
Rust inbound path already does this for the analogous case
(`crates/dohc-engine-sync/src/ydoc_apply.rs`): load the persisted document, apply
the base bytes onto it, and refuse if they fail validation. Its own comment states
the requirement — the projection must be the reconstructed lineage *plus* the
base, "or the visible snapshot would drop local content that is still durably part
of the CRDT."

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
- **`onAfterReserveForTest`** fires inside `openSession` at the **shared point
  after the open branch is selected** — after reset, or claim, or resume — and
  before the live session is installed. It lets a test simulate a mid-open failure
  and prove the reservation is released on *any* throw, never stranded "live".

  The placement is the whole point, so do not describe it as "after the state is
  reset". A resumed open never resets persisted state at all, and a fresh
  replicated open reaches the seam only after the base *claim*. A replacement hook
  placed inside the reset branch would leave reservation cleanup after claim and
  after resume untested — and the existing seam's own comment says it exists to
  cover "the whole open path (not just the reset step)".

Both are undefined in production.

## What the Rust side has, and what it is missing

The storage and the emit condition exist. The origination does not.

- Outbound journaling requires `emit_outbound: regime == Regime::Replicated &&
  base_claimed` (`crates/dohc-engine-collab/src/durable.rs:597`).
- The only SQL setting `regime = 'replicated'` is at `durable.rs:768`, inside
  `claim_base_in_tx`.
- `claim_base_in_tx` has exactly two non-test callers: `claim_base`
  (`durable.rs:719`), a public wrapper with **no** caller of its own, and the
  **inbound** apply at `crates/dohc-engine-sync/src/ydoc_apply.rs:715`.
- **`ydoc.apply` does exist as a server RPC** — dispatched in
  `crates/dohc-workspace-engine/src/lib.rs`, and its actor path calls
  `record_local_update_creating_marker(..., Regime::Replicated, ...)`
  (`crates/dohc-engine-runtime/src/actor.rs`), so it *does* create a replicated
  marker. It does **not** claim a base, so the origination gap stands — but the
  endpoint is live and must not be missed during the port or the deletion.
- What is missing is the **TypeScript client** method. `YDOC_METHOD`
  (`packages/workspace-engine-client/src/ydoc/ydocWireContract.ts`) exposes
  `ydoc.open`, `ydoc.recordUpdate`, `ydoc.settle`,
  `ydoc.applyExternalMarkdownEdit`, `ydoc.close` and `ydoc.resync` — no
  `ydoc.apply`. Do not confuse `ydoc.apply` with
  `ydoc.applyExternalMarkdownEdit`; they are different methods and the latter is
  wired on both sides. A grep for `ydoc.apply` matches both.
**Do not trust `dohc-engine-collab`'s manifest description.** It ends *"Dormant;
not wired into the product"*, and that sentence is **stale**.
`dohc-engine-runtime`, `dohc-engine-sync` and `dohc-workspace-engine` all depend
on the crate, and live daemon paths call it for Y.Doc open, update, settle, close,
resync and inbound apply — the `ydoc.apply` bullet above is itself one such call.
Treating that description as an architectural fact would let a deletion or port
handle a live product dependency as dead code.

What is dormant is the **origination path specifically**, not the crate.

Keep two things separate here, or an inventory of Rust entry points will
contradict itself — and the local apply path is the one that gets dropped:

- **Creating a replicated marker** happens locally today. `ydoc.apply` reaches
  `record_local_update_creating_marker(..., Regime::Replicated, ...)`.
- **Claiming a base** does not. The only live caller of `claim_base_in_tx` is the
  inbound apply, so a peer-delivered base is currently the only way a lineage
  gets one.

The gap is therefore narrower and more specific than "Rust cannot originate":
Rust can mark a lineage replicated on its own, and cannot *claim its base*
without a peer. That gap is #378.

## Do not fix base origination on its own

Implementing this specification alone would make rich `.md` documents replicate
while plaintext, binary and secret files silently do not — worse than today's
uniform nothing, because partial replication looks like working sync.

The paired gap: only chat operations and the dead ydoc path write to the
relay-visible `replication_log`. File, text and secret writes go to
`replication_journal`, a different table, and nothing drains one into the other.
Both belong to #356.

**There is currently no acceptance gate for base origination, and the obvious
candidate is not one.** `apps/desktop/e2e/workspace-sync-rejoin.spec.ts` is
disabled and is often cited as the gate for the pair. It is a gate for the
journal-drain gap only. It bootstraps `notes/plan.md` as an ordinary captured
file and makes its second-machine edit through
`createVersionedTextStore().writeTextFile`; it never opens a Y.Doc session and
never asserts a base or delta operation. Its single mention of ydoc is a comment.

So re-enabling that spec once the drain is fixed would go green and report **both**
gaps closed while base origination remained entirely unimplemented — a green check
that checks nothing, which is this program's dominant defect class arriving by the
most plausible-looking route available.

Closing #378 therefore needs a **new** assertion: two peers, a rich document, and
a check that the base operation is emitted exactly once and that a delta follows
it. Write that gate before writing the implementation.

Before claiming any sync behaviour works, check which table the write landed in.
