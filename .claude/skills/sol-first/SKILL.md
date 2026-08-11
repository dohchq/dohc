---
name: sol-first
description: Run an orchestration session that spends GPT-5.6-sol freely and Claude sparingly while keeping Fable-level quality. Use when Ice asks to save or preserve Claude usage, cut cost, maximize Sol or Codex usage, or invokes /sol-first before delegated implementation, review, or a fix campaign.
---

# Sol-first: Sol does the work, Claude does the judgment

The premise: Sol usage is effectively free, Claude usage is scarce, and
quality lives in two places — the design an implementer receives, and the
judgment applied to what comes back. Spend Claude only there.

## Model allocation

| Work                                                             | Who                                        | Why                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Implementation, mechanical verification, mutation re-runs        | GPT-5.6-sol via codex CLI                  | Free; executes a stated design well                                                                |
| Implementation-lane shells (verify, commit, push, report)        | sonnet wrapper                             | Cheapest shell that can drive git and judge Sol's diff                                             |
| Review-shaped codex runs (simplification prompts to Sol, audits) | The orchestrator's own background Bash     | No wrapper: zero agent tokens; read the report file                                                |
| First-pass review coverage                                       | codex cloud (`@codex review`) + CodeRabbit | Free. Recheck CodeRabbit per head — its rate limit is intermittent                                 |
| Simplification review (required per code PR)                     | opus-5                                     | The family rule flips when Sol implements: the reviewer must be Claude, and reviews need taste ≥ 7 |
| Exact-head replay: re-run a stated battery, severs, affected suites | sonnet                                     | The battery is already written; running it is mechanical                                           |
| Adversarial construction: invent the failure history nobody wrote  | opus-5                                     | Building a counterexample is not replay                                                            |
| Material durability, privacy, authorization, or consensus doubt  | fable                                      | The one place cheap review is false economy                                                        |
| Orchestration: triage, declines, merges, coverage records        | fable (the session itself)                 | This is the quality mechanism — never delegate it                                                  |

Never spawn opus for implementation. Never use Haiku.

Route certification by failure properties, not by diff size or file path. A
one-line change to a generation fence earns adversarial construction; a
five-hundred-line rename does not. Concurrency, retry and idempotency,
migrations, cleanup, destructive recovery, and cross-machine state all carry
those properties whatever the diff looks like.

**Name the model on every dispatch.** An agent spawned without a `model`
inherits the caller's — Fable. That default is how a routine re-run becomes
the most expensive agent in the campaign. A dispatch that does not state a
model is not ready to send.

## The per-PR Fable contract

Fable touches each PR exactly three times. Everything between is Sol and
free reviewers.

1. **The dispatch brief is the implementation plan.** Before Sol writes a
   line, the brief states the fix shape, the red-first pins it must produce,
   the constraints (no `any`, pinned names, lock protocols), and what is
   already DECLINED so the lane does not implement it. Sol executes a
   design; it does not invent one. Sol also drafts the brief's measured
   scaffold — scope enumeration, caller lists, line counts, gate commands —
   in a background codex run; Fable writes only the decisions into it.
   Editing a scaffold costs a fraction of authoring a brief.
2. **Finding triage, continuously.** Every finding from every reviewer is
   verified or declined by the orchestrator against source before a lane
   acts on it. Reviewers propose; the orchestrator disposes. Record every
   decline on the PR with the technical reason.
3. **One comprehensive pre-merge review.** Immediately before merge, the
   orchestrator reads the full PR diff once — correctness, invariants,
   taste, copy register. Batch the result into a single verdict: verified
   blockers go to the lane as ONE consolidated fix round; nits the
   orchestrator fixes directly in one commit or records as accepted. No
   iterative Fable rounds; the certifier's exact-head re-run covers
   post-fix regression.

## What never gets cheapened

The evidence protocol is the floor, whatever the models cost:

- Every new pin proves itself red-first; every accepted deletion re-runs
  the mutations it could have silenced.
- Certification of record on the EXACT merge head, by an agent with no
  implementation context, that re-runs mutations itself — green claims from
  the author are never sufficient.
- Gates run from the orchestrator's own shell on the exact head, with
  fetch + checkout + install + test all inside the serialization lock.
  Read the Rust gate's `== summary ==`, never its exit code.
- The merge protocol: `review_status` on the exact head, coverage record
  naming every reviewer, rewritten squash message, branch deletion gated on
  `state==MERGED`, smoke on merged main.
- A delta certification inherits the prior head's baseline only when the
  delta cannot invalidate it. Scope from impact, not from changed
  filenames: shared code, schemas, migrations, feature flags, and
  transitive callers all reach past the diff.

## Mechanics that make Sol cheap instead of flaky

- codex flag order: `-m gpt-5.6-sol` BEFORE `exec`. Long runs exceed Bash's
  10-minute timeout — explicit timeout or background + poll the report file.
- A wrapper must never end its turn while its codex run is alive: poll in a
  loop (sleep 60 inside its own Bash calls) or arm a monitor on the PID.
  An idle-returned wrapper is dead until resumed.
- Prefix every scratchpad artifact with a lane id — parallel agents share
  one scratchpad and generic names collide silently.
- If codex classifier-blocks CRDT/byte-level engine content, the wrapper
  implements directly and says so — never works around the refusal.
- Sol's self-reports are input, not evidence: the wrapper independently
  re-runs the red-first proofs and suites before committing.

## The reporting contract

A subagent wakes the orchestrator for three events only: it finished, it hit
a blocker it cannot resolve, or it needs a decision only the orchestrator can
make. Progress is not one of them. A wake-up that says "still running" costs
a full transcript re-read and returns nothing.

Silence must not mean death. Every lane appends one status line to its own
scratchpad file at each step — the step, the clock time, the artifact it
produced. The orchestrator reads that file when it wants to know. Ban the
notification, keep the telemetry.

## How to wait

An interval heartbeat pays for every beat and still misses the event between
beats. Wait on the condition instead.

- Ask a level-triggered question: does the required result exist NOW? Never
  depend on catching the moment it changed.
- A producer writes its result to a temporary file and renames it into
  place. Never grep a live log for a completion word — a partial write reads
  as finished, and an old marker answers a new question.
- One watcher polls every open condition. Polling costs no model tokens;
  only a fired condition wakes the orchestrator.
- Keep open conditions in a ledger file: an id, the immutable target (exact
  head SHA, gate run id), and the evidence that closes it.
- Re-scan that ledger on every start. This is what recovers a condition that
  fired while nothing was watching — a crashed watcher, a restarted host.
- A failed query records UNKNOWN, never false. Re-read the head after
  judging a reviewer: a moved head voids the verdict.
- For GitHub, keep the notice/judgment split the `pr-review-watch` skill
  already draws. A notice says look; `review_status` decides. Batch the
  queries — a per-PR loop drains a rate limit shared with every agent.

The guarantee this buys, stated honestly: every open condition is detected
while the watcher runs, and reconciled on the next start. Exactly-once
waking is neither achievable nor needed. At-least-once delivery with an
idempotent check is the correct contract.

## Token hygiene — the orchestrator's own bill

The orchestrator's transcript is the largest Claude cost in this design.
Every turn re-bills it, including heartbeat wakeups that do nothing. Keep it
small and keep turns few.

- Raw bytes never enter the orchestrator context. Tee gate runs, Sol
  reports, and diffs to files; read only summary blocks and targeted hunks.
  The one whole-diff read is the pre-merge review, once per PR.
- Triage from dossiers. A zero-wrapper codex run assembles per-finding
  evidence: the claim, verbatim code excerpts with paths and lines, repro
  output. Fable reads the dossier and disposes. Open source directly only
  when the dossier cannot decide — and say so in the decline record.
- Checkpoint and shed. After each merge, write state to the campaign
  handoff, then start the next PR on a cleared context. Never carry a
  merged PR's transcript forward. Context size multiplies every wake-up
  that follows it, so this saves more than any wake-up tuning can.
- A wakeup with nothing actionable makes zero tool calls and ends in one
  line. Better: do not take that wakeup at all — see "How to wait".
- Batch judgments. One consolidated turn beats five small ones: every turn
  pays thinking overhead plus a transcript re-read.

## Round count is the multiplier

A reviewer round is never one comment. It is a fix commit, a fresh
certification, a gate run, and another reviewer pass. Four rounds cost four
of each. Stabilize the head first, then let every reviewer read the same
one:

1. Land implementation, local gates, and the simplification review.
2. Stabilize the head.
3. Trigger Codex and CodeRabbit together on that head.
4. Wait for both before triaging.
5. Triage every finding in one pass; batch the accepted ones into ONE fix
   round; record every decline.
6. Run affected gates and the certification once, on the fixed head.
7. Request one combined re-review.

Do not let each arriving finding open its own round. Repo policy still bars
review requests while a PR is a draft — change that ordering by editing the
policy, never by renaming a review.

## Escalation

Cost never blocks escalation. If a Sol lane misses the bar twice on the
same defect, or a finding disputes a durability/authorization contract,
move that piece to Fable directly and say so in the ledger.

A plan that names Fable for a specific shard — the sync program does, for
S2 and S4 — states a policy, not a budget. Downgrading it is a decision for
Ice, never a cost optimization taken quietly mid-campaign.

Codex carries its own escalation rule in
`.agents/skills/conserve-fable/SKILL.md`: that skill decides when Codex asks
for Fable, this one decides how the orchestrator spends it. Keep the two
consistent and do not restate either inside the other.

If usage still drains after the hygiene above, the remaining floor is
Fable's three touches per PR. Cutting deeper — opus-5 orchestration for
routine PRs, or fewer certification tiers — revises the standing fable-5
orchestrator order and needs Ice's explicit sign-off first.
