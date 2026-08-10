# S4 design: two-peer base arbitration (#547)

**DECIDED — Ice approved the recommendation, 2026-08-10:** first claim owns
the coordinate, the loser becomes a visible conflict, no auto-merge in S4.
Auto-merge stays a possible follow-up if real usage shows conflict fatigue.

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
- dohc already has the machinery for divergent content: conflict records, the
  conflict review UI, and resolution paths. The product invariant applies:
  every reversible change needs a visible reverse path.

## Recommendation: first claim owns the coordinate, the loser becomes a conflict

1. **Arbiter:** the relay's log order. The first base claim to commit at the
   relay owns the lineage coordinate. Deterministic, no clocks, no
   coordination protocol — the log already serializes claims.
2. **The loser keeps everything, visibly.** The losing machine's content
   materializes through the existing conflict machinery: its state lands as a
   conflict side on the winning lineage's head, and the user resolves it in
   the conflict UI they already know. Its Y.Doc re-seeds from the winning
   lineage going forward.
3. **No auto-merge in S4.** A three-way text merge could resolve some cases
   without a conflict, but there is no common ancestor for independently
   created files, so any merge is a heuristic. S4 stays obvious: same path,
   two histories, one visible conflict. Auto-merge can be a later follow-up
   if real usage shows conflict fatigue.

No silent loss: both contents are durable before, during, and after
arbitration. Reversible: the conflict record is the reverse path. Obvious:
the user sees exactly what happened — two machines made the same file, pick.

## Questions for Ice

1. Approve first-claim-owns-coordinate with loser-as-conflict?
2. Should S4 attempt any automatic content merge before materializing the
   conflict (recommendation: no — keep it a visible conflict)?
3. Anything about the conflict copy/UX for this case you want different from
   ordinary edit conflicts? (It reads "two machines created this file
   independently", not "your edit collided".)

Answer here, in the PR that carries this file, or by telling the orchestrator.
