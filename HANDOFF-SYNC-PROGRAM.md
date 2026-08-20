# Handoff: finish the sync program (#356)

Written 2026-08-11 by the orchestrating session, for the agent that finishes
this work. Read this file first, then the two plan documents it names. Every
statement here is a fact about the repository at `715425b8` or a decision the
owner already made.

## Read these before you touch code

1. `AGENTS.md` — the repository contract. It governs everything below.
   Nothing in this file relaxes it.
2. `docs/superpowers/plans/2026-08-09-dohc-sync-program.md` — the seven-shard
   program and each shard's acceptance case.
3. `docs/superpowers/plans/2026-08-10-s4-base-arbitration-design.md` — the
   arbitration policy AND the revised mechanism. The mechanism changed on
   2026-08-11; the section "How the loser survives" is binding.
4. Your own model-budget setup — how this campaign spends models, how subagents
   report, and how to wait on work without burning the budget. This lives in
   your user-level skills, not in this repository.

## Where the program stands

Merged and closed: S1 (#750, every owned committed moment drains into the
relay-visible log), S2 (#752, honest origins at the replication boundary),
S3 (#754, the two-daemon harness that proves a captured file reaches a second
machine's disk). `main` is green: typecheck and the desktop suite both pass.

Open issues: #356 (the parent), #547 (S4), #548 (S5), #646 (S7).

Two pull requests are open and NEITHER is close to merge.

### PR #761 — S5, origination retry (#548)

Five rounds landed; head `6d32f5db`. The enrolment backfill re-journals what
a workspace originated before its first relay position existed. Its predicate
is exact provenance: a row backfills only when no imported replication-log row
carries the same identity. `metadata_origin` cannot decide this — the apply
side stores the sender's value verbatim, and S2's boundary stamp covers
snapshots only.

Certification chain: `d11a2e0a` PASS, `389e5c7e` PASS, `4b459632` FAIL on one
claim (fixed), `a84d707c` (round 5 input). Round 5 fixed, each red-first: the
migration-ledger count in `crates/dohc-engine-testkit/tests/durability.rs`
(26 → 29 for the new ordinals — that crate was missing from earlier
verification lists, which is why the gate caught it); prior-store upgrade
coverage for ordinals 27 and 28; a legacy unclaimed Y.Doc lineage whose NULL
path reached neither replication channel (now persisted on both dedupe
returns, and a still-NULL row is refused loudly rather than dropped); version
backfill ordered by timestamp rather than fork ancestry, which wedged pulls
past the 500-op page (now topological); migration 28 leaving legacy imported
secrets NULL and re-journaling them as local; and a spurious conflict on fresh
replicas for one causal history.

Suites are green on that head, including testkit, fmt and clippy.

**What #761 still needs:** certification of record on the exact merge head,
the opus-5 simplification review, reviewer coverage with substitutions
recorded, and both gates. It holds migration ordinals 26, 27 and 28.

### PR #762 — S4, base arbitration (#547): rebuild it

Certification FAILED twice. The first two blockers were fixed and proven
fixed. The mechanism then failed again in three new places, all
construction-proven, all in the same conflict-row machinery:

- The canonical case — both machines create the same NEW path — has no
  visible head, so no conflict is created, the loser's rows are purged, and a
  scan of every table found zero traces of the typed text.
- The winning machine never records the loser at all, and the losing
  machine's conflict never replicates.
- The conflict that is created cannot be resolved: every choice returns
  `ConflictStaleTarget`, because the winner's projection overwrites the head
  the conflict recorded.

The owner approved a mechanism change on 2026-08-11. **The conflict-row work
in #762 is withdrawn.** Rebuild the shard on "How the loser survives" in the
design document. Keep from the current branch only what the new mechanism
still needs: relay-order arbitration itself (`claim_base_in_tx`, the
`relay_seq` threading, the migration that stores the coordinate), and the
`is_sync_conflict_origin` fix if the new mechanism still produces that
origin. Read the certification records in the PR comments before deleting
anything — they name what was proven and what was refuted.

Two blockers survive the mechanism change and must be fixed:

- Y.Doc operations carry no lineage identity, so deltas from a rejected base
  park forever. Put the claim identity on the wire.
- `base_relay_seq` is NULL on documents claimed before the migration and
  nothing re-stamps it, so a divergent base wedges the entire workspace pull.
  Repair the coordinate before any destructive path runs.

### After these two merge

S6: second-machine join, end to end. S7: file share access levels (#646).
Both are specified in the program plan. #356 closes when its two-real-peers
acceptance passes verbatim.

## How to work

Implementation is yours. Judgment, review, and merge follow the repository
contract, and the contract is not optional because a model is cheap.

**Every change lands red-first.** Write the pin, run it against the unfixed
code, keep the failure output, then fix, then green. A pin that never failed
proves nothing. `AGENTS.md` and the certification records show the standard.

**Certification of record.** Before any merge, an agent with NO implementation
context re-runs the mutations itself on the EXACT merge head. Your own green
run is not evidence. Route it by failure properties, not diff size: exact-head
replay is mechanical; inventing a failure history is not. Both of this
shard's real defects came from constructed histories — a crash before settle,
two indistinguishable bases — so give the durability paths an adversarial
certifier, not a replay.

**Simplification review is required** for every code PR, by a reviewer from a
different model family than the implementer. Sol implements here, so the
reviewer is Claude — opus-5. Give it the diff, the source, and the required
behavior; never give it your reasoning. Invoke it directly:

```
claude -p --model opus "…diff path, required behavior, ask what can be deleted,
combined, or made obvious without weakening behavior or product invariants…"
```

Verify each finding before applying it, apply the clear ones, and record the
reviewed commit and result in the PR. Findings are evidence, not commands.

**Reviewer coverage.** A review applies to a commit, not a pull request. Use
the `pr-review-watch` skill; do not build another poller. Both automated
reviewers were usage-limited on 2026-08-11 — the cloud code reviewer answered
"You have reached your Codex usage limits for code reviews", and Fable was
exhausted. Recheck them; they recover. When a required reviewer cannot run,
substitute an independent one and record the substitution and its reason in
the PR, as this campaign did.

**Gates.** Reproduce the workflow's `rust` and `js` jobs locally for the exact
head, inside the machine's serialization lock. Read the Rust gate's
`== summary ==` block and never its exit code — it exits 0 while its own
summary says FAIL. `dohc-engine-testkit` belongs in the verification list.

**Merge protocol.** Coverage record naming every reviewer, squash message
rewritten (GitHub takes the first commit's message otherwise), branch deleted
only after the merge reports `MERGED`, remote ref verified gone, and main
smoked afterward.

## Traps this campaign hit

- **Migration ordinals collide across branches.** #761 holds 26, 27, 28.
  Whichever branch merges second renumbers and reruns its migration test.
  Append ordinals; never edit baseline DDL — its checksum is what lets an
  existing store open, and editing a comment inside it locked every prior
  store out.
- **Never `git stash`.** It is repo-wide across worktrees and will take
  another agent's work. Use a temporary commit, or
  `git checkout <sha> -- <file>`.
- **Cargo is single-occupancy on this machine.** Concurrent Rust builds have
  crashed it. Check for other `cargo`/`rustc` processes and wait.
- **Bound every test run.** A panicking assertion can leave engine threads
  alive and hang the binary. Judge `test result:` lines, not exit codes.
- **Disk fills.** Abandoned worktree `target/` directories consumed the volume
  twice; one lane reclaimed 194 GB. They are regenerable.
- **A green suite is not coverage.** Every defect this campaign found sat
  exactly where the suites did not look. Sever the fix and confirm a pin goes
  red; if nothing reds, the behavior is unpinned, and say so out loud.

## Definition of done

#547, #548 and #646 closed by merged pull requests; #356 closed by its own
two-real-peers acceptance, passing verbatim; main green after each merge;
every branch deleted and verified gone; `CAMPAIGN-SWEEP.md` updated; and the
owner told what shipped, in plain language, including anything deferred and
why.
