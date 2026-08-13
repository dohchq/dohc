# S4 design: two-peer base arbitration (#547)

**POLICY DECIDED — Ice, 2026-08-10:** first claim owns the coordinate, the
loser's content survives visibly, no auto-merge in S4. Auto-merge stays a
possible follow-up if real usage shows conflict fatigue.

**MECHANISM REVISED — Ice, 2026-08-11.** The policy above is unchanged. The
way the loser survives is not. The first attempt wrote a text CONFLICT ROW.
Three certification rounds each fixed "the loser's content survives" in one
shape and broke it in another, so the mechanism changed. Read "How the loser
survives" below before touching this code; the conflict-row approach and
everything built on it is withdrawn.

**IMPLEMENTED — 2026-08-13.** Every Y.Doc operation carries its immutable
lineage claim. Pulled operations also carry their relay position. The engine
validates a complete pull page before it changes state. When two bases differ,
the lower relay position wins. The losing peer writes its exact projection as
one ordinary recovered file before it installs the winner. Live sessions use
the claim as a write fence and replace their Y.Doc after a lineage change.
Legacy claims without a relay position use an authenticated exact-coordinate
lookup and remain pending while the answer is ambiguous.

## The problem

Two machines each create the same path (say `notes/todo.md`) before either
syncs. Each originates its own Y.Doc lineage for that path-derived object.
When the second claim reaches a receiver, the base SHAs differ, the receiver
returns `BaseStateDiverged`, and that coordinate wedges forever. Nothing
arbitrates.

The recorded claim rule already handles the easy cases: equal SHA resumes,
absent seq-0 resumes, different SHA fails loudly. S4 decides what happens
after the loud failure — which lineage owns the coordinate, and what happens
to the loser's content.

## What the decision rests on

- The two documents have independent seed roots. Yjs merges concurrent edits
  inside one lineage, but two independently seeded docs have no shared
  baseline — merging them interleaves unpredictably. A CRDT merge cannot
  arbitrate this case.
- Wall clocks cannot either. The relay orders cross-origin ops by
  `recorded_at_ms`, and S1's review record already shows machine clocks
  disagreeing. Last-writer-wins by timestamp is silent loss with extra steps.
- The product invariant applies whatever the mechanism: every reversible
  change needs a visible reverse path. Conflict records were the first
  candidate for that path. They did not fit — see below.

## Decision: first claim owns the coordinate, the loser is recovered as a file

1. **Arbiter:** the relay's log order. The first base claim to commit at the
   relay owns the lineage coordinate. Deterministic, no clocks, no
   coordination protocol — the log already serializes claims.
2. **The loser's content is recovered as an ordinary file.** The losing
   machine writes its own projection to a sibling path — a normal text
   moment, replicated by the normal path — and re-seeds its Y.Doc from the
   winner. "How the loser survives" states the rules.
3. **No auto-merge in S4.** A three-way text merge could resolve some cases
   without a copy, but there is no common ancestor for independently created
   files, so any merge is a heuristic. S4 stays obvious: same path, two
   histories, both kept. Auto-merge can be a later follow-up if real usage
   shows fatigue.

No silent loss: both contents are durable before, during, and after
arbitration. Reversible: the recovered file is the reverse path — the user
reads both and deletes one. Obvious: two machines made the same file, and
both are still here.

## How the loser survives

The losing peer — the one whose claim is replaced — is the **single
authoritative producer** of the recovered file. The winning peer must not
write its own copy: at `AlreadyWon` it holds only the loser's base, which may
be empty or older than the loser's later edits, so two producers would write
different contents and race. The winner receives the recovered file the
ordinary way, by replication.

Rules the implementation must satisfy:

- **Capture before purge.** Project the losing lineage before the claim
  transaction can delete its update rows. A crash between capture and commit
  must lose nothing: the arbitration commits in one transaction.
- **Write a real moment.** Use the ordinary text write path, so the recovered
  file replicates like any other file. Do not use the capture-ingest path
  (it assumes the bytes came from disk) or the projected-write path (it
  deliberately suppresses replication). In the same transaction: index it,
  enqueue materialization, journal the outbound moment when the workspace
  replicates, and record the correlation that makes redelivery idempotent.
- **Name it deterministically.** Derive the suffix from the losing claim
  identity, not from a machine label or anything locale-dependent — the wire
  payload carries no friendly name, and two locales must never choose two
  durable paths. `todo (recovered 8f31c2ab).md` is the shape. Localize the
  explanation in the UI, never the stored path.
- **Never adopt an occupant.** The ordinary write path adopts an existing
  object at the target path. Probe the candidate first. A matching recovery
  correlation is a replay and reuses the same object; anything else picks the
  next deterministic candidate.
- **Do not touch the bytes.** No banner, no frontmatter. The loser's exact
  content survives. Provenance lives in the moment's summary and correlation
  metadata, naming the original path and the losing claim.
- **Suppress the capture loop.** The engine writes the moment first and
  materializes it as an expected engine write. Writing the file and letting
  the watcher capture it emits a duplicate moment and loses provenance. The
  recovery path belongs in the pull's changed-path ledger so crash
  redelivery repeats the same materialization and the same suppression.

## What this mechanism costs

State these honestly rather than discovering them later.

- A conflict record carried an explicit "undecided" state; two files do not.
  Recovery metadata must stay visible until the user acts on it.
- The recovered file is a NEW coordinate. Exact-path shares do not
  automatically include it. Decide visibility deliberately for shared paths.
- Arbitration removes the same-path collision. It does not remove every
  namespace collision: a peer may independently occupy the recovered path,
  and ordinary moment application handles that the ordinary way.
- Recovery has one producer: the losing peer. If that peer uploads its lineage
  and then disappears before it learns that it lost, another peer cannot safely
  reconstruct edits that it has never seen. The relay keeps the bytes, but this
  design does not elect a second recovery producer.

## Lineage identity — required by this shard

Y.Doc wire operations carry no lineage or base identity today. After
arbitration rejects a base, later deltas from that peer take the normal apply
path, fail to find their base, and park — suppressing projection. Neither a
conflict record nor a recovered file decides what happens to those already
journaled deltas.

Put a lineage identifier — the base claim digest, or another stable claim id —
on every Y.Doc operation, so a receiver can tell a rejected lineage's deltas
from deltas made after the loser re-seeded. Backward compatibility is not
required, so change the contract rather than inferring the boundary from
origin sequences.

## Relay-position repair

`base_relay_seq` can be NULL on documents claimed before the arbitration
migration. Before arbitration, the engine asks the relay for the exact stored
origin coordinate. A present coordinate supplies the relay position, including
a retained coordinate below the current epoch floor. A confirmed absence
permits replacement only after any local unpublished base is pushed. A missing,
malformed, tampered, or otherwise ambiguous answer keeps the operation pending
without changing the lineage or pull cursor.
