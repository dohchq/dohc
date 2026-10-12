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

On Linux, install Chromium system dependencies once with `pnpm exec playwright install-deps chromium`.
This preparation requires administrator access.
The verifier installs the pinned browser.
Missing host dependencies fail the browser proofs.

Run `pnpm run doctor` to inspect readiness without changing the checkout.
`pnpm doctor` invokes pnpm's own command and does not check this repository's readiness.
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
When the JavaScript gate applies, the plan also lists the services, prepared builds, and integration proofs it needs.
The JavaScript gate always runs the complete JavaScript suite: every package's tests, `pnpm test:repo`, the desktop script tests, and every integration proof.
Commit the changes. Run `pnpm verify:pr --base <target-ref>` against that clean commit.
The runner rejects changes to the source or commit during verification.
The JavaScript gate prepares the engine and desktop, typechecks the whole workspace, then runs repository checks alongside package tests.
A Rust-only run skips Electron, desktop preparation, Postgres, and the browser proofs.
On headless Linux hosts, only the desktop proof runs under Xvfb.
The runner starts a dedicated Postgres container for the database tests and proofs.
Integration suites must run; unavailable prerequisites cause failure rather than a silent skip.
The native self-host editing proof checks the prepared engine and its complete delivery evidence.
The `@states-page` pixel gallery runs only on Windows, where its baselines were taken.
The Rust gate uses the repository build budget and checks its summary verdict.
On the shared Windows host, one PR verification runs at a time. Runs wait in FIFO order.
Each PR run owns its checkout until cleanup and receipt writing finish.
Another PR run in that checkout fails before installation or queue admission and reports the owner.
The runner checks host tools before queueing and rechecks its source, tools, and disk after admission.
Before queueing, it also runs the workspace typecheck when the installed dependencies match the lockfile.
When Rust is selected, it runs `cargo fmt --check`, then clippy and the nextest test build with the gate's arguments and target directory under one build slot.
A failure stops the run before it joins the queue. The `pre-queue-*` steps record these checks.
The lane repeats them as evidence. Its clippy and test steps reuse those builds; only the engine binary that preparation rebuilt relinks.
The runner removes its Postgres container by the recorded container ID.

Inspect the host's queues without joining them:

```sh
node tools/rust-engine-program/build-slot.mjs --status
```

Use `--root <directory>` to inspect another queue root. The command emits JSON and does not create directories or acquire slots.
Each lane reports owners and waiters with their purpose, checkout, commit, phase, and elapsed time when recorded.
Older records without that metadata have an unknown purpose.
Wait estimates use the median duration of up to twenty completed runs in the same lane.
A cold history has no estimate. Estimates do not reject or reorder work.
Runs wait up to six hours. A live holder keeps its slot even if its heartbeat stops; investigate its recorded PID before changing its resources.
Only `pnpm verify:pr` can take a verification slot. Other scripts that request one fail. A verification slot does not provide an idle host for benchmarks.
Performance measurements must record concurrent host work and use the shared build budget when running Cargo.
The live-authorship profiling command uses a separate single owner and creates no PR queue ticket.
It defers when registered gates or builds hold or wait for slots.
If registered work arrives during measurement, it stops its own child and records the run as failed.
Its host context covers registered lanes and does not prove that the host was otherwise idle.

The lane count defaults to one. To compare one and two lanes, use an isolated root and explicit trial flags in PowerShell:

```powershell
$env:DOHC_VERIFICATION_SLOT_ROOT = 'C:\w\_locks-verification-trial'
$env:DOHC_VERIFICATION_TRIAL = '1'
$env:DOHC_VERIFICATION_LANES = '2'
pnpm verify:pr --base origin/main
```

Use that same trial root with `DOHC_VERIFICATION_LANES=1` for the comparison.
Keep `DOHC_BUILD_SLOT_ROOT` unchanged. Cargo still uses the host's shared four-lane budget during a verification trial.
Record other host builds and gates during the comparison; a separate outer queue does not isolate CPU, memory, or disk load.
Compare elapsed time, queue time, failures, and peak host memory under matching work and cache conditions.
Do not change the live queue root or remove another run's tickets to conduct a trial.
Remove the three verification trial environment variables from the shell before returning to ordinary verification.

To schedule jobs separately, use `pnpm verify:pr --base <target-ref> --job js` and `--job rust`.
Each report states its scope. Every selected job needs passing evidence that covers the change.
An explicit `--job` runs that job even when the filters omit it.
Use it when a build or test step reads a changed file outside the filters.

After a renderer fix, reuse completed Rust evidence with `pnpm verify:pr --base <target-ref> --reuse-rust <original-result.json>`.
The current run must select Rust. Add `--job rust` to request that job explicitly.
The verifier accepts an original Rust pass from a completed PR run, including one whose JavaScript job failed.
The original report must contain a Rust identity and every required passing gate check.
Older reports without this identity require a fresh Rust run.
The verifier compares Git content, tools, platform, environment, and Cargo configuration.
Only renderer source changes and commits with identical inputs can reuse Rust evidence.
All other tracked changes require a fresh Rust job, including dependencies, fixtures, and verification scripts.
Every reuse runs the pinned tool probes, `cargo deny check`, and `cargo audit` again.
Read the current report's `rustEvidence` reference and `rust-reuse` step to distinguish reused checks from executed checks.
The reference keeps the original tested commit, report hash, gate log hash, and changed paths.
Keep the original report and logs until review finishes. Reused evidence cannot become another reuse source.

Run `pnpm verify:pr --base <target-ref> --full` before a release or when impact is uncertain.
It runs both gates even when the filters omit one, including when the diff is empty.
Use `pnpm verify:plan --base <target-ref> --full` to inspect that selection.

Read `result.json` before reporting a pass. Include the commit, gates, and evidence directory in the PR.
After review fixes or integration changes, rerun affected checks and record why the remaining evidence still applies.
Keep each receipt's tested commit and target unchanged; document reuse in the PR.
Use the report's `steps[].seconds` when recording verification delays.
Use its top-level `seconds` for the complete run, including preparation and cleanup.
The `timings` rows record the queue wait, source checks, preparation, and database setup and cleanup, including failed phases.
Preparation finishes before the Rust and JavaScript jobs start together. Their step rows can overlap, as can failed startup cleanup.
Do not add step durations to estimate elapsed time.

`pnpm test` builds the app runtime before testing packages.
Repository checks run beside at most two package commands.
The complete repository suite runs at most two independent fixture files at once.
Repository source guards retain their sequential schedule.
Isolated desktop script tests then use the repository lane.
PR verification then reuses that lane for the integration proofs after every database package finishes.
In PR verification, desktop and database package tests start first so proofs can overlap the remaining package tests.
Standalone `pnpm test` does not run these integration proofs.
The runtime packaging test waits for all three lanes, including proof readers, because it rebuilds shared runtime files.
Database consumers share one slot. Vitest uses at most four workers per package and retains stricter existing limits.
Package results and durations are in the JS test report referenced by `result.json`.
The canonical verifier supplies the prerequisites once before running this test schedule.
It also holds runtime packaging until Rust finishes because both use the built app runtime.
The `packaging-wait` timing records that wait, which also contributes to the `tests` step.

## Measure performance

Use `node tools/perf-profiling/run-profiles.mjs --output <directory> --seed <uint32>` in each checkout.
Use the same machine, fixture seed, scenario settings, and build mode for the base and candidate.
The profiling report records bundle and engine hashes. Keep both reports with the comparison.
Use `--tiny` to check the harness; use the full fixture for performance claims.

## Finish the task

Keep verification evidence until review finishes, then remove the task worktree, its build targets, and the evidence.
