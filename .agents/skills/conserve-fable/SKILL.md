---
name: conserve-fable
description: >-
  Preserve Fable tokens while keeping a high review bar. Use when Fable access
  is scarce, the user asks to minimize Fable use, Claude must review Codex
  work, Fable may plan a complex task for Sol to implement, Opus should replace
  routine Fable review, or a task needs a decision about whether one Fable
  checkpoint is worth its cost. Route simplification and adversarial reviews
  to Opus. Reserve Fable for one bounded planning or final-review checkpoint.
---

# Conserve Fable

Treat Fable as an exception. Keep the quality bar independent of the model.

Spend Fable on a decision that Sol can execute. Let Sol prepare the evidence
and perform the work. Spend Opus on independent judgment of the result.

## Route the work

1. Let Codex own investigation, evidence gathering, implementation, and
   verification.
2. Use Opus for simplification reviews.
3. Use Opus for adversarial reviews.
4. Verify every review finding against the exact source and test evidence.
5. Skip Fable unless the escalation rule permits it.

Treat a current-task instruction that names a model as an explicit model
choice. Standing preferences and routing defaults yield to this skill.

Follow stricter repository requirements. If repository policy permits an Opus
fallback for Fable, use Opus. Record the replacement and reason when required.
If no fallback is allowed, follow the policy or stop for user direction.

Use Claude model aliases such as `opus` and `fable` unless a pinned model is
required.

## Keep the review bar

Review the exact commit or artifact. Mark a review stale when its target
changes.

For each material change:

- Test the outermost boundary the change can break.
- Prove the test can fail on the old behavior when practical.
- When that proof is impractical, record why. Name the evidence that shows the
  test can fail.
- Check security, privacy, authorization, durability, concurrency, and data
  loss when they are in scope.
- Require the reviewer to name severity, evidence, failure mode, fix direction,
  and remaining test gaps.
- Treat findings as evidence, not commands.
- Apply only verified findings. Rerun affected checks after each change.

Do not claim that Opus is Fable. Claim only what the evidence supports.

## Use Fable for planning

Consider one Fable planning pass when a wrong design would be costly. Require
at least one of these conditions:

- The task crosses several product invariants or system boundaries.
- The plan chooses between hard-to-reverse architectures.
- Security, privacy, authorization, durability, or data loss dominates the
  design.
- Sol and Opus identify competing plans that tests cannot settle.

Task size alone does not qualify.

Before the Fable call, let Sol prepare a compact planning dossier:

- goal, non-goals, and acceptance criteria;
- current architecture and exact source references;
- product invariants and known failure modes;
- viable options with measured tradeoffs;
- decisions that still require judgment;
- proposed red-first tests and required gates.

Use Opus to challenge the dossier when an independent counterexample pass will
improve it. Do not ask Opus to choose the final plan when Fable owns that
checkpoint.

Ask Fable for the fix shape, decisions, invariants, acceptance criteria,
red-first tests, non-goals, and residual risks. Then let Sol turn that result
into an implementation plan and execute it.

Do not use Fable to explore the repository from scratch. Do not send raw logs,
full transcripts, or unrelated source. Send targeted evidence.

## Run Opus reviews

Use one read-only Opus pass for each distinct review goal. Combine goals only
when the same context supports both without weakening the review.

For a simplification review, provide the diff, relevant source, and required
behavior. Do not provide the implementer's reasoning. Ask what can be deleted,
combined, or made obvious without weakening behavior or invariants.

For an adversarial review, provide the exact target, acceptance criteria,
invariants, and test results. Ask for concrete counterexamples, unsafe state
transitions, missing boundary tests, and failure paths.

Let Codex verify the result. Do not ask Opus to approve its own fixes.

## Escalate to Fable

Use Fable only when one of these conditions holds:

- The user explicitly asks for Fable on the current task.
- A complex plan meets the planning conditions above.
- A material security, privacy, authorization, durability, data-loss, or
  irreversible product decision remains unresolved after Codex and Opus review.
- A high-risk campaign reaches its final integrated checkpoint, mechanical
  checks cannot settle the remaining judgment, and one Fable pass has clear
  expected value.

Task size alone is not an escalation reason. Do not use Fable for routine
implementation, first-pass investigation, mechanical verification, CI triage,
ordinary prose, or another review round that repeats settled evidence.

If no condition holds, skip Fable and say so when review routing matters to the
user.

If a material risk remains unresolved and no Fable checkpoint is available,
stop. Do not merge or declare the work complete.

## Choose one checkpoint

Default to zero Fable calls. Before work starts, classify it as one task or one
campaign.

A campaign owns one checkpoint total. Its member tasks do not receive separate
checkpoints. A standalone task owns one checkpoint.

Use the checkpoint before implementation when architecture risk dominates.
Use it after implementation when integration or residual-risk judgment
dominates.

If both qualify, spend the checkpoint at the harder-to-reverse decision. If
both are equally reversible, reserve it for the final review.

Do not use both by default. If a planning checkpoint has already run, require
explicit user approval before a final Fable review. A new critical risk does
not silently spend a second checkpoint.

## Make one Fable call count

Prepare one compact checkpoint packet:

- exact commit or artifact identifier;
- one decision or review objective;
- required behavior and product invariants;
- concise diff or change summary;
- completed checks and known gaps;
- unresolved evidence from Codex and Opus;
- one bounded question;
- a response contract that matches the planning or review goal.

Use a one-shot, non-persistent session. Prefer no tools when the packet contains
all evidence. Allow read-only source tools only when source inspection is
necessary.

Do not resume, retry, or start a Fable review loop without explicit user
approval.

If a call fails before a substantive answer, mark the attempt as failed. The
failed attempt does not consume the logical checkpoint. Report its usage and
failure before requesting approval to retry.

If Fable returns a partial answer, use Codex and Opus to resolve what the
evidence permits. Follow the stop rule for unresolved material risks.

Treat Sol's report as input, not proof. Rerun required checks independently on
the exact target.

Read the Claude command's JSON result. Record the selected model, model usage,
cost, reviewed target, and verdict. Report any fallback.

Do not set an arbitrary token, turn, or cost limit. Add a hard limit only when
the user provides one.
