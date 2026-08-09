---
name: sol-first
description: Run an orchestration session that spends GPT-5.6-sol freely and Claude sparingly while keeping Fable-level quality. Use when Ice asks to save or preserve Claude usage, cut cost, maximize Sol or Codex usage, or invokes /sol-first before delegated implementation, review, or a fix campaign.
---

# Sol-first: Sol does the work, Claude does the judgment

The premise: Sol usage is effectively free, Claude usage is scarce, and
quality lives in two places — the design an implementer receives, and the
judgment applied to what comes back. Spend Claude only there.

## Model allocation

| Work | Who | Why |
| --- | --- | --- |
| Implementation, mechanical verification, mutation re-runs | GPT-5.6-sol via codex CLI | Free; executes a stated design well |
| Implementation-lane shells (verify, commit, push, report) | sonnet wrapper | Cheapest shell that can drive git and judge Sol's diff |
| Review-shaped codex runs (simplification prompts to Sol, audits) | The orchestrator's own background Bash | No wrapper: zero agent tokens; read the report file |
| First-pass review coverage | codex cloud (`@codex review`) + CodeRabbit | Free. Recheck CodeRabbit per head — its rate limit is intermittent |
| Simplification review (required per code PR) | opus-5 | The family rule flips when Sol implements: the reviewer must be Claude, and reviews need taste ≥ 7 |
| Substitution/delta certification when CodeRabbit is limited | sonnet for routine surfaces | An exact-head cert is mostly mechanical re-running |
| Certification of durability-critical surfaces, disputed blockers | fable | The one place cheap review is false economy |
| Orchestration: triage, declines, merges, coverage records | fable (the session itself) | This is the quality mechanism — never delegate it |

Never spawn opus for implementation. Never use Haiku.

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
  merged PR's transcript forward.
- A wakeup with nothing actionable makes zero tool calls and ends in one
  line. Heartbeat intervals are 20 minutes or longer.
- Batch judgments. One consolidated turn beats five small ones: every turn
  pays thinking overhead plus a transcript re-read.

## Escalation

Cost never blocks escalation. If a Sol lane misses the bar twice on the
same defect, or a finding disputes a durability/authorization contract,
move that piece to Fable directly and say so in the ledger.

If usage still drains after the hygiene above, the remaining floor is
Fable's three touches per PR. Cutting deeper — opus-5 orchestration for
routine PRs, or fewer certification tiers — revises the standing fable-5
orchestrator order and needs Ice's explicit sign-off first.
