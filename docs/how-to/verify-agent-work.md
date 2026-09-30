# Verify desktop work

Use this procedure when changing dohc through an agent or an isolated worktree.

## Prepare the checkout

Create a worktree from the intended base. Keep dependencies, build outputs, and application profiles inside that worktree.
On Windows, install PowerShell 7 and put `pwsh.exe` on `PATH` before running setup.
Verification uses it to own command descendants and stop them after interruption or timeout, even when their launcher exits first.
Run `pnpm setup:worktree`. This installs the pinned dependencies and checks the local tools.
Codex runs the same setup through `.codex/environments/environment.toml` when creating a worktree.

For local Rust PR verification, install these host tools at the versions pinned in `.github/workflows/pr-checks.yml`.
The verification owner installs these tools before running the full Rust gate.
Setup and doctor check Rust and Cargo, but do not install or check these additional tools.
Use the [Rust build budget](../../.agents/skills/rust-gate/SKILL.md#cargo-outside-the-gate) for these installations.

```sh
cargo install cargo-deny --locked --version 0.20.2
cargo install cargo-audit --locked --version 0.22.2
cargo install cargo-nextest --locked --version 0.9.143
```

The PR verifier rejects missing tools or versions that differ from those workflow pins.

Run `pnpm doctor` to inspect readiness without changing the checkout.
Run `pnpm qa:prepare` to build the native engine and desktop.
Preparation reconciles the installed dependencies with the frozen lockfile before reusing or building artifacts.
Preparation records source and artifact hashes under `.dohc-dev/verification`.
The desktop harness rejects missing or mismatched builds, including stale staged engines.

## Prove the changed behavior

Run the smallest relevant unit or integration check while editing.
Run `pnpm qa:smoke` to exercise desktop startup, an editor change, disk persistence, and restart.
Run `pnpm qa:e2e -- --grep <test-name>` to exercise a specific desktop flow.
Run `pnpm qa:e2e -- --grep @two-client` for the two-desktop sync flow.
This flow makes conflicting offline edits, resolves them through the UI, and checks persistence after restart.
It does not prove unsolicited updates to an idle desktop.
Run `pnpm qa:artifacts` to prove that an intentional failure retains its evidence.

The runner writes a result, step logs, and desktop evidence under `.agent-artifacts/verification/<run>`.
Each Electron instance records its process, profile, workspace, and prepared build.
Read the failing assertion and its logs together. Inspect the screenshot and Playwright trace when the behavior is unclear.
Treat traces as private artifacts. They can contain document text and credentials entered during the test.

## Debug a separate app

Run `pnpm qa:debug` to start a prepared desktop with its own workspace, home, and profile.
Read the printed `instance.json` for the main-process inspector and renderer debugger addresses.
Attach a debugger to those loopback endpoints. Confirm the recorded checkout before editing or measuring.
Close that app or interrupt its command to stop the session and retain logs, a screenshot, and a trace.
The session retains its disposable data beside the evidence for diagnosis.

For native folder-dialog QA, run `pnpm qa:debug -- --native-dialogs`.
Ask the operator to choose the printed disposable workspace, cancel a second picker, and confirm keyboard focus returns to the app.
Record the operator's result with the session evidence. The automated picker seam does not prove native-dialog behavior.

## Verify a pull request

One verification owner records passing evidence for every selected gate in the PR.
While Blacksmith is off, run the gates locally.
When enabled, reuse passing CI evidence that covers the change instead of repeating full gates locally.
Use the [Blacksmith setup procedure](enable-blacksmith.md) to inspect or change activation.
Run focused checks locally. Use the [review policy](../../AGENTS.md#select-reviewers) to select independent reviewers and handle later fixes.
Before merging, confirm passing evidence covers the PR's changes under the [evidence reuse rules](../../AGENTS.md#verify-the-change).
For platform-specific changes, add focused checks on that platform.

Use the canonical runner below. Other agents reuse its evidence instead of reconstructing or repeating the full verification.

Fetch the PR's target branch. Use its fetched ref as `<target-ref>` below, such as `origin/main`.
Run `pnpm verify:plan --base <target-ref>` to see the applicable workflow gates.
The plan also lists selected JavaScript packages, test files, integration proofs, and required services.
JavaScript selection follows workspace dependencies and declared external test inputs.
Site-only changes run the site's tests and two desktop renderer compatibility files, without desktop packaging or native proofs.
Additional desktop or integration inputs retain their complete suites and required proofs.
Desktop-only changes run the Y.Doc compatibility files that import desktop code.
Changes to Y.Doc projection or its other inputs run the complete Y.Doc suite, including the checkpoint boundary test.
Shared configuration and unclassified code inputs select the full JavaScript suite.
Ordinary package changes run repository source guards: exports, brand, dependency inputs, and Vitest version consistency.
Shared inputs and full mode also run the repository's verification, release, process, and self-host contracts.
These contracts read scripts, tools, workflows, and configuration; product files inside their fixtures are synthetic.
When a contract gains a real package input, add that input to full selection before narrowing its coverage.
`pnpm test:repo` retains the complete repository suite.
Commit the changes. Run `pnpm verify:pr --base <target-ref>` against that clean commit.
The runner rejects changes to the source or commit during verification.
The JavaScript gate typechecks the whole workspace and runs repository checks before selected package tests.
It installs Electron only when desktop preparation is selected.
On headless Linux hosts, only the desktop proof runs under Xvfb.
It starts a dedicated Postgres container when selected tests or proofs need one.
Selected integration suites must run; unavailable prerequisites cause failure rather than a silent skip.
The native self-host editing proof checks the prepared engine and its complete delivery evidence when selected.
The Rust gate uses the repository build budget and checks its summary verdict.
On the shared Windows host, one PR verification runs at a time. A later run waits for the first to finish.
The runner removes its Postgres container by the recorded container ID.

To schedule jobs separately, use `pnpm verify:pr --base <target-ref> --job js` and `--job rust`.
Each report states its scope. Every selected job needs passing evidence that covers the change.
An explicit `--job` runs that job even when the filters omit it.
Use it when a build or test step reads a changed file outside the filters.
For a forced JavaScript job with no matching changes, the runner selects the complete JavaScript suite.

Run `pnpm verify:pr --base <target-ref> --full` for comprehensive verification before a release or when impact is uncertain.
This runs both gates, every package, and every mandatory integration proof, including when the diff is empty.
Combine `--full` with `--job js` or `--job rust` to run one complete job.
Use `pnpm verify:plan --base <target-ref> --full` to inspect the full selection.

Read `result.json` before reporting a pass. Include the commit, gates, and evidence directory in the PR.
Include its JavaScript package and proof selection when reusing evidence for a narrower run.
After review fixes or integration changes, rerun affected checks and record why the remaining evidence still applies.
Keep each receipt's tested commit and target unchanged; document reuse in the PR.
Use the report's `steps[].seconds` when recording verification delays.
Use its top-level `seconds` for the complete run, including preparation and cleanup.
The `timings` rows record the queue wait, source checks, preparation, and database setup and cleanup, including failed phases.
Preparation finishes before the Rust and JavaScript jobs start together. Their step rows can overlap, as can failed startup cleanup.
Do not add step durations to estimate elapsed time.

`pnpm test` builds the SDK and app runtime before testing packages.
It runs repository tests first, then at most two packages concurrently, then desktop packaging tests.
Database consumers share one slot. Vitest uses at most four workers per package and retains stricter existing limits.
Package results and durations are in the JS test report referenced by `result.json`.
The canonical verifier supplies the prerequisites once before running this test schedule.
It holds desktop packaging until Rust finishes because both use the built app runtime.
The `packaging-wait` timing records that wait, which also contributes to the `tests` step.

## Measure performance

Use `node tools/perf-profiling/run-profiles.mjs --output <directory> --seed <uint32>` in each checkout.
Use the same machine, fixture seed, scenario settings, and build mode for the base and candidate.
The profiling report records bundle and engine hashes. Keep both reports with the comparison.
Use `--tiny` to check the harness; use the full fixture for performance claims.

## Finish the task

Keep verification evidence until review finishes, then remove the task worktree, its build targets, and the evidence.
