# Desktop launch-readiness run

## Reader and decision

This run tells the launch owner whether the desktop app's local workflows are ready for an external user. It records what blocked each user archetype, what changed, and what remains open.

The run does not decide whether dohc has every planned feature. It decides whether the features already presented to a user work, explain themselves, and respond like a native desktop app.

## Current verdict

**Not launch-ready.** The launch-readiness-owned fixes are complete and the
5,000-file Explorer path now meets the measured interaction boundary. Seven
reproducible P1 defects remain behind active ownership fences: transient
History startup exposes an internal error; cold large-workspace adoption
misses the engine deadline; renaming an open Markdown file can fail to save;
192–250 KiB Markdown editing loses input and exits edit mode; oversized
Markdown reading creates multi-second main-thread work; transparent sites can
be unreadable in dark mode; and the Cloud surface defaults to localhost.

The verdict is based on the production Electron build, fresh-profile and
power-user computer-control tours, targeted durable-result E2Es, a 21-surface
light/dark visual audit, full JavaScript checks, the canonical Rust gate, and
default-engine performance profiles. Passing checks do not override the
reproduced data-loss and critical-workflow failures.

## Starting point

- Branch: `codex/launch-readiness-polish`
- Baseline commit: `ac0e650c7d1a9cd201aeb5c0d237413ae0eb237f`
- Product surface: 312 renderer files, 457 desktop test files, and 80 e2e files
- Existing baseline: unit tests, desktop e2e tests, UI audit screenshots, and profiling specs
- Rigor: high. The scope crosses most visible desktop surfaces, and visual polish cannot be proved by compilation.

## Conflict fence

Other sessions own share links and Notion-parity editor work. This run can test those workflows and record failures. It must not edit their source or tests.

Before each fix, check its files against active worktrees and the recent diff from the baseline. If ownership is unclear, leave the finding open instead of creating a parallel contract.

## Definition of done

The first launch-readiness tranche is complete only when all statements below are true.

1. Every critical local workflow in the tour matrix has a recorded `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE` outcome.
2. No reproducible P0 or P1 defect remains in this run's editable scope.
3. Each accepted fix has a regression check that fails on the baseline behavior and passes on the fixed behavior.
4. The desktop typecheck and the smallest affected desktop test suites pass on the final head.
5. A clean Electron build completes the critical tours after the fixes.
6. Common local actions show feedback within 100 ms and finish within 500 ms, unless the UI names the ongoing work.
7. No tested local action leaves the user with an unexplained wait longer than 1 second.
8. Every dialog, empty state, and error tested in the tour states what happened and gives a working next action when one is needed.
9. Every tested workflow is reachable with a pointer, and the critical create, open, search, edit, save, and navigate paths are reachable by keyboard.
10. Every remaining failure has an owner boundary, reproduction evidence, severity, and next step.

The timing budgets are observation thresholds for this run, not new public performance promises. A trace can justify a documented exception.

## Severity

- P0: data loss, authorization failure, destructive action without a true recovery path, or the app cannot start.
- P1: a critical workflow cannot finish, produces the wrong durable result, traps the user, or repeatedly exceeds the unexplained-wait budget.
- P2: the workflow finishes, but its route, copy, focus, feedback, or interaction cost makes a wrong action likely.
- P3: local inconsistency or finish work that does not block or mislead the user.

## Tour archetypes

Each archetype starts without repository knowledge. The tester records the first assumption before inspecting source.

| Archetype | Goal | Pressure applied |
| --- | --- | --- |
| New user | Open a folder, understand the shell, create and edit the first file | Discoverability, empty states, terminology, safe defaults |
| Student or researcher | Build linked notes, find material, inspect backlinks and history | Repeated capture, search, linking, recovery |
| Developer | Navigate a mixed workspace, inspect source, use keyboard commands, run a local app | Density, keyboard reach, code paths, panel ergonomics |
| Team collaborator | Use chat, presence, activity, versions, and agent attribution | State clarity, ownership, continuity, failure feedback |
| Power user | Switch workspaces and editor groups, resize panels, reopen work, recover from interruptions | Latency, focus, persistence, shortcut consistency |

## Critical tour matrix

The harness and manual tour must cover these workflow groups in light and dark themes where the surface changes materially.

1. First run, choose folder, recent workspace, cancel, and relaunch.
2. Create, rename, move, duplicate, and delete files and folders, including recovery copy.
3. Open, edit, save, close, reopen, and switch files across editor groups.
4. Quick open, command palette, workspace search, and no-result recovery.
5. Markdown input, keyboard selection, links, images, tables, and source view. Record findings only inside the Notion-parity fence.
6. Backlinks, graph, properties, file details, and history.
7. Chat creation, linked chat, message states, agent attribution, and interruption.
8. Settings navigation, theme changes, update state, and invalid configuration feedback.
9. Plugin details, panels, previews, local web apps, and external-link confirmation.
10. Window resizing, narrow layouts, panel toggles, focus order, Escape behavior, and visible focus.
11. Engine loss, stale async responses, missing files, unsupported files, and relaunch recovery.
12. Workspace switching and large-workspace paths covered by existing profiling fixtures.

Share-link workflows remain test-only for this branch.

## Workflow

### 1. Build the harness and capture the baseline

- Extend the existing UI audit instead of creating a second screenshot framework.
- Add a deterministic tour manifest that lists the workflow, archetype, input, expected durable result, and performance marker.
- Capture baseline screenshots, timings, console errors, and workflow outcomes from the exact starting commit.
- Reject blank screenshots and results without the expected workspace marker.

### 2. Run independent read-only audits

- A coverage worker maps visible actions to existing tests and names the gaps.
- An interface worker checks visible copy and control recipes outside the conflict fence.
- A performance worker checks existing traces and identifies the cheapest real measurements.
- Each worker writes only its own report. The orchestrator verifies every cited file and runtime claim.

### 3. Run the blind tours

- Use the real Electron app through Windows computer control.
- Observe before reading source. Record the attempted action, assumption, result, duration, and screenshot or trace.
- Classify a failure as wrong assumption, product bug, test-harness bug, or inconclusive.
- Repeat critical paths with keyboard input and after relaunch.

### 4. Triage into independently landable units

- Fix the riskiest verified unknown first.
- Prefer one workflow correction per unit.
- Keep share-link and Notion-parity files outside every unit.
- Give parallel implementation workers separate worktrees, branches, and file ownership.

### 5. Run the experiment loop

For each unit:

1. State the user-facing hypothesis.
2. Add or harden the failing observation.
3. Make the smallest change.
4. Exercise the real workflow.
5. Keep the change only if the predicate advances.
6. Append the outcome to the decision trail.

### 6. Integrate and judge

- Inspect each worker's diff and artifact before integration.
- Run a separate judge over delegated work.
- Use one Fable review for the final integrated, taste-sensitive UI judgment.
- Verify every review finding against the final source and real app.

### 7. Close the run

- Re-run the critical tour on the final head.
- Run the JavaScript gate selected by `pr-checks.yml` for the final diff.
- Encode repeated failures in the harness or a focused static check.
- Audit the decision trail against the run and resolve every evidence path.

## Evidence contract

- Canonical decisions: `docs/plans/launch-readiness-decisions.tsv`
- Tour findings: `docs/plans/launch-readiness-findings.tsv`
- Re-runnable checks: committed under `apps/desktop/e2e` or `apps/desktop/scripts`
- Screenshots, traces, and raw logs: `test-results/launch-readiness/`
- Verdicts: `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE`

Raw evidence stays out of Git. The manifest, checks, findings, and decisions stay in Git so another reviewer can rerun the work.

## Closeout status

- Launch-readiness-owned P1s: fixed or disproved with durable-result evidence.
- Conflict-fenced P1s: reproduced, assigned, and retained with traces or
  screenshots; none were edited in this branch.
- Post-fix product tour: New file, file creation, settings, focus, and light/dark
  surfaces rechecked in the production Electron build.
- Explorer performance: fixed from 5,004 mounted rows and 2,407 ms expansion to
  37 mounted rows and 80 ms to first child on the final production bundle.
- Remaining release decision: blocked until LR-002, LR-005, LR-010, LR-012,
  LR-014, LR-018, and LR-019 are fixed and their real-app journeys pass.
