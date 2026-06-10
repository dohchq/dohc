# Desktop Local-First Cloud Sync Plan Audit

Date: 2026-06-10

Reviewed plan: [`docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md)

## Verdict

Almost handoff-ready.

The updated plan fixed the major first-pass blockers around desktop Playwright wiring, broad Convex deletion staging, explicit cloud-service bring-up, governance-source reads, and live co-editing data-loss requirements.

The Codex collaboration model is good if the intended shape is: **Claude or another lead agent implements, Codex acts as independent reviewer/red-team/recovery consultant, and Codex never authors production artifacts.** That separation is exactly the right instinct. It preserves independent review, gives you cross-model critique, and avoids burning Codex budget on ordinary keystrokes.

Before starting, fix the remaining stale Codex instructions in the main loop and copy-paste prompt. They are small text edits, but important because agents usually obey the prompt block literally.

## Findings

### P1: Copy-paste prompt and main loop still override Codex effort tiering

The plan now has a good Codex budget model: high-risk phase reviews and checkpoints use `xhigh`; low-risk reviews and advisory uses can use `high`; fallback reviewers are allowed when the preferred Codex model/tool is unavailable.

But older command examples still tell the implementer to run `model_reasoning_effort="xhigh"` after every phase commit. The copy-paste prompt repeats that instruction. Because the copy-paste prompt is what the implementing agent is most likely to follow, this can burn Codex quota unnecessarily and undermine the budget rule.

Evidence:

- [`plan:L292`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L292)
- [`plan:L334`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L334)
- [`plan:L336`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L336)
- [`plan:L2471`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L2471)

Recommendation:

Replace the stale examples with wording like:

```text
After every phase commit, run independent third-party review using the effort tier specified in the Codex third-party review section. Prefer:
- xhigh for checkpoints and high-risk phases 2, 4, 5, 9, 10, 11, 13, 16, 17, 18.
- high for low-risk phases 0, 1, 12, 14, 15 and advisory screenshot/scenario passes.

If preferred Codex gpt-5.5 is unavailable, use the fallback chain and record the reviewer in the execution log.
```

The copy-paste prompt should say the same thing rather than hardcoding `xhigh` for every phase.

### P2: Copy-paste stop conditions are stale

The main plan requires the Recovery Protocol fresh-model consult before declaring blocked after repeated attempts. The copy-paste prompt still says to stop after three attempts, without the required recovery consult.

Evidence:

- [`plan:L420`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L420)
- [`plan:L442`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L442)
- [`plan:L2503`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L2503)

Recommendation:

Update the prompt block so its stop condition matches the main plan:

```text
Stop only if the same blocker remains after three concrete attempts plus the Recovery Protocol fresh-model consult, or if an external secret/service, user decision, or non-negotiable violation genuinely blocks progress.
```

### P2: Codex preflight wording has one confusing edge case

Phase 0 says failed Codex capabilities disable only the uses needing that capability and "never the review gate." That is true for optional `codex exec` and image attachment uses, but not for `codex exec review`: if review itself fails, the plan should explicitly trigger the independent-review fallback chain.

Evidence:

- [`plan:L343`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L343)
- [`plan:L652`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L652)

Recommendation:

Change the Phase 0 preflight wording to:

```text
If optional Codex capabilities fail, disable only the uses needing them. If `codex exec review` or the preferred model fails, use the independent-review fallback chain from the Codex third-party review section.
```

### P3: Make the lead/Codex role split explicit in the copy-paste prompt

The detailed plan says Codex is review-only and must not author implementation artifacts. That is good. The copy-paste prompt does not make the role split as explicit, and this matters because it uses a `claude/` branch name while heavily invoking Codex.

Evidence:

- [`plan:L347`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L347)
- [`plan:L460`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L460)
- [`plan:L2452`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L2452)
- [`plan:L2470`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L2470)

Recommendation:

Add one line to the prompt:

```text
Role split: the lead implementation agent owns code, tests, commits, and execution log; Codex is used only as read-only independent reviewer/red-team/consultant, with all Codex findings verified by non-Codex verifiers before fixes land.
```

## Resolved First-Pass Findings

- Desktop Playwright config contradiction is fixed. Phase 2 now creates `apps/desktop/playwright.config.ts`, keeps root `playwright.config.ts` untouched, and uses `playwright test --config apps/desktop/playwright.config.ts`.
- Phase 2 now includes `pnpm-workspace.yaml` for the Electron `onlyBuiltDependencies` allowlist.
- Convex deletion staging is fixed. Phase 13 now uses full `git add -A` after a recorded `git status --short`.
- Cloud service bring-up is now listed in the Phase 9, Phase 10, Phase 15, Phase 17, and Phase 18 command blocks.
- Governance source-read exception is now explicit: digests cannot replace direct reads of `AGENTS.md`, `apps/app/AGENTS.md`, or Convex guidelines before governed edits.
- Phase 10 now defines the canonical-state model and requires data-loss tests for active CRDT sessions, materialization base versions, watcher suppression, external edits during live sessions, offline reconnect, and rename/delete.

## Codex Collaboration Assessment

The collaboration design is strong with the small prompt cleanup above.

What is good:

- Codex is independent and read-only for reviews.
- Codex is not assigned implementation lanes, scripts, migrations, or tests.
- Codex findings are triaged and verified by non-Codex verifiers before they become work.
- Mandatory reviews get budget priority; discretionary Codex uses are capped and skippable.
- Codex transcripts go to `docs/superpowers/reviews/codex/` instead of bloating the execution log.
- Phase 13 adds a valuable cross-model pre-deletion audit over Convex source, which is exactly where diff-only review can miss behavior.
- Recovery consults are bounded and do not reset the blocked-attempt counter.

What to keep in mind:

- This is not a good plan for Codex as the lead implementer, because the plan intentionally says Codex must not author or materially shape production artifacts. That is fine if Claude or another agent is lead.
- If the team wants Codex to implement, the role split must be rewritten. Otherwise Codex should stay reviewer/red-team only.

## Verification Performed

- Reviewed the updated plan front matter, AI execution contract, Codex collaboration section, Phase 0 preflight, Phase 2 Electron/Playwright setup, Phase 9 cloud auth/sync, Phase 10 collaboration/live co-editing, Phase 13 Convex deletion, Phase 15/17/18 service bring-up, acceptance criteria, and copy-paste prompt.
- Ran `git diff --check -- docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md docs/superpowers/reviews/2026-06-10-desktop-local-first-cloud-sync-plan-audit.md`; result was clean.
- Verified local Codex CLI presence: `/mnt/c/Users/ice/.codex/bin/wsl/81645c5d269e0fb2/codex`, version `codex-cli 0.137.0-alpha.4`.
- Verified `codex exec review --help` supports `--commit`, `--base`, `--uncommitted`, `-m`, `-c`, `--json`, and `--output-schema`.
- Did not run an actual `gpt-5.5` review invocation, so model/auth availability should still be verified by Phase 0 as the plan requires.

## Summary

Fix the three prompt/wording issues above, then I would consider this ready for the team to start. The architecture and execution loop are ambitious but coherent, and the Codex collaboration setup is meaningfully better than "ask another model to look at it" because it has independence, budget, provenance, verification, and bounded recovery rules.
