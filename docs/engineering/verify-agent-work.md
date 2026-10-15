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
The runner checks host tools before queueing.
Before queueing, it also runs the workspace typecheck when the installed dependencies match the lockfile.
When Rust is selected, it runs `cargo fmt --check`, then clippy and the nextest test build with the gate's arguments and target directory under one build slot.
A failure stops the run before it joins the queue. The `pre-queue-*` steps record these checks, and the full gate repeats them as evidence.
The runner labels its Postgres container and removes it by the recorded container ID.

### The verification queue on the shared Windows host

On the shared Windows host, a queue service runs PR verifications, one per verification lane.
After the pre-queue checks, `pnpm verify:pr` hands the commit to the service and reports its progress until it finishes.
The service verifies the commit in its own checkout, `C:\w\_verification\lane` or `C:\w\_verification\lane-2`, so your checkout is free to change while the request waits.
Stopping `pnpm verify:pr` does not stop the request. Run the same command again to follow it, or to get its result once it has finished.
Pass `--detach` to submit the request and return at once.

- Requests run in the order the service accepted them.
- A newer commit on the same branch replaces that branch's waiting request and keeps its place. A running request finishes.
- The same commit with the same gates joins the existing request, or reuses its pass.
- A run that fails because of the machine is retried in place, after 30 seconds, 2 minutes, 5 minutes, then every 15 minutes. Machine failures include a program that could not start, too little disk, and Docker or the host tools not responding.
- A run that fails a check is reported at once. The service never retries it.
- A run stops and fails after two hours of awake time. Time the machine spends asleep does not count.
- While Docker does not respond, runs that need the JavaScript gate wait and Rust-only runs continue.
- While free memory is below 10 GB, no second run starts. A check that fails after free memory fell below 3 GB during the run is retried as a machine failure.
- While free disk is below the 40 GB floor, no run starts. The service first deletes the build output of its lanes that have no run.

Each lane runs with its own temp folder, `C:\w\_verification\tmp\<lane>`, which antivirus skips and the service empties before each run.
Each attempt records the load it verified under in `status.json` and `C:\w\_verification\history.jsonl`: the lane count, the most runs at once, the lowest free memory, and the mean CPU use. Read them before changing the lane count.
Each attempt has its own evidence folder, `C:\w\_verification\requests\<id>\attempts\<n>`, and its `result.json` names the request and attempt.
Read the service's verdict from the request's `status.json`, or from the last line `pnpm verify:pr` prints.

Run `pnpm verify:queue status` to see the service, the running requests, the line, and wait estimates.
Run `pnpm verify:queue cancel <id>` to stop a request. A finished request keeps its verdict.

The service also serves a page at `http://127.0.0.1:4250` on the host. It shows the running requests and their current steps, the line with start estimates, each lane's runs over the last day or week, the nightly run, and the week's flaky and slowest tests.
Select a run to see its steps and the failing step's test summary. The page refreshes every five seconds and cannot change the queue.
To open it from another device, serve it on the tailnet only:

```powershell
tailscale serve --bg --https=8446 http://127.0.0.1:4250
```

Then open `https://<host>.<tailnet>.ts.net:8446`. Do not use Tailscale Funnel: the page shows branch names and test output.
The page answers only to the host's own names and to tailnet names.

The `dohc-verification-queue` scheduled task starts the service at logon and every five minutes if it is not running.
A supervisor runs the service in a Windows job object. When the service exits or its heartbeat stops for two minutes, the supervisor stops it and everything it started, then starts it again.
A request that was running when the service stopped runs again as a new attempt. A request whose receipt already finished keeps that result.
Install or upgrade the service from a checkout of `origin/main` with `pnpm verify:queue install`. An upgrade takes effect when the current runs end. No new run starts until then.

CI, other platforms, and runs with their own `DOHC_BUILD_SLOT_ROOT` verify inline in their checkout.
Pass `--inline` to do the same on the shared host when the service is unavailable. Inline runs still wait for the host's verification lane, so they never overlap a queued run.
An inline run owns its checkout until cleanup and receipt writing finish. Another PR run in that checkout fails before installation or queue admission and reports the owner.

Inspect the host's Cargo slots and verification lane without joining them:

```sh
node tools/rust-engine-program/build-slot.mjs --status
```

Use `--root <directory>` to inspect another queue root. The command emits JSON and does not create directories or acquire slots.
Each lane reports owners and waiters with their purpose, checkout, commit, phase, and elapsed time when recorded.
Older records without that metadata have an unknown purpose.
Wait estimates use the median duration of up to twenty completed runs in the same lane.
A cold history has no estimate. Estimates do not reject or reorder work.
Inline runs wait up to six hours. A live holder keeps its slot even if its heartbeat stops; investigate its recorded PID before changing its resources.
Only `pnpm verify:pr` can take a verification slot. Other scripts that request one fail. A verification slot does not provide an idle host for benchmarks.
Performance measurements must record concurrent host work and use the shared build budget when running Cargo.
The live-authorship profiling command uses a separate single owner and creates no PR queue ticket.
It defers when registered gates or builds hold or wait for slots.
If registered work arrives during measurement, it stops its own child and records the run as failed.
Its host context covers registered lanes and does not prove that the host was otherwise idle.

The host runs one verification at a time unless `verification-lanes` in the slot root contains `2`.
Every verifier and the queue service read that file, so all of them agree on the count.
The queue service runs the second lane's requests in `C:\w\_verification\lane-2`. That checkout's build output takes about 10 GB more disk.

```powershell
Set-Content C:\w\_locks\verification-lanes 2
```

Write `1` to return to one lane. Runs already admitted to the second lane finish first.

To compare lane counts without changing the host, use an isolated root with its own setting in PowerShell:

```powershell
$env:DOHC_VERIFICATION_SLOT_ROOT = 'C:\w\_locks-verification-trial'
$env:DOHC_VERIFICATION_TRIAL = '1'
pnpm verify:pr --base origin/main --inline
```

Keep `DOHC_BUILD_SLOT_ROOT` unchanged. Cargo still uses the host's shared four-lane budget during a verification trial.
Record other host builds and gates during the comparison; a separate outer queue does not isolate CPU, memory, or disk load.
Compare elapsed time, queue time, failures, and peak host memory under matching work and cache conditions.
Do not change the live queue root or remove another run's tickets to conduct a trial.
Remove the two verification trial environment variables from the shell before returning to ordinary verification.

### Flaky tests

The gate runs a failing test once more before it fails the change.
nextest, vitest, and Playwright retry the failing test itself. The repository and desktop script steps run again when their report names a failed test; a failed check or build is not retried. The self-host proof runs again from an empty evidence folder.
A test that passes only on that retry does not fail the gate. `result.json` lists it under `flaky`, the verifier prints it, and the queue history records it.
A flaky test is a defect. Fix the condition it races, or report it to whoever owns it. A test that fails twice still fails the gate.
A repository or desktop script step reruns as a whole, after its first attempt's ignored outputs. A test that fails on a clean tree but passes beside those outputs is recorded as flaky like any other, so treat every entry as a real failure until you have read it.

### A failure stops the run

The first step that fails stops the rest of a PR run. A step fails only after its retry, so a test that passes on retry stops nothing.
The runner interrupts the running Rust job, package tests, and proofs as it does on Ctrl+C. It then removes their processes, Postgres, and containers.
The verdict is FAIL. `result.json` names the failed step under `stopped.after` and lists each step that did not finish under `stopped.notRun`.
Each of those steps has the verdict `NOT RUN`. `js-tests/result.json` records the package tests and proofs that did not finish in the same way.
A stopped Rust job is never a pass, so its evidence cannot be reused.

Pass `--keep-going` to let both jobs finish after a failure. In the JavaScript job, running steps finish, but no new step starts.
Use it when you need every failure, or Rust evidence to reuse after a JavaScript failure.
A `--full` run always keeps going. On the shared host, the queue keeps going only with `--full`; add `--inline` to keep going without it.

### Nightly run

Every night at 03:07, the `dohc-verification-nightly` scheduled task submits a full verification of main's head: every gate, every package, and every proof.
It covers everything merged since the last nightly that passed, and it runs before the rest of the line. A head that already passed is not verified again.
It keeps going after a failure, so triage sees the failures of both jobs.
`pnpm verify:queue status` shows the last passing nightly. Submit one by hand with `pnpm verify:queue nightly`.
A failed nightly means a merged change broke main or an affected-package selection missed something. Find the change that broke it and revert or fix it the same day.
The [`verification-triage` skill](../../.agents/skills/verification-triage/SKILL.md) has the procedure.

### Affected packages

The JavaScript gate runs package tests only for the packages a change affects: the packages its files are in, and every package that depends on them.
A package depends on another when its manifest says so, or when its files reach into the other's files by a relative path, as some tests import another package's source.
A change to any file outside the workspace packages, such as a lockfile, a crate, or a root script, runs every package. Documentation changes run none.
Repository checks and proofs always run. `pnpm verify:plan` lists the selected packages, and `result.json` records them under `packages` and `js-tests/result.json` under `skippedPackages`.
Pass `--full` to run every package. The nightly run on main always does.

### Slowest tests

Each gate keeps its 20 slowest tests in `result.json` under `slowest`, and prints the five slowest. The queue history keeps each run's step times and ten slowest tests.
A test that takes more than a second is a scenario test. Keep it, but make it earn its time: the per-PR gate should take 15 minutes or less on an idle lane.
A weekly review reads the history, then fixes, splits, or speeds up the tests and suites that cost the most. The [`verification-triage` skill](../../.agents/skills/verification-triage/SKILL.md) has its procedure.

To schedule jobs separately, use `pnpm verify:pr --base <target-ref> --job js` and `--job rust`.
Each report states its scope. Every selected job needs passing evidence that covers the change.
An explicit `--job` runs that job even when the filters omit it.
Use it when a build or test step reads a changed file outside the filters.

After a renderer fix, reuse completed Rust evidence with `pnpm verify:pr --base <target-ref> --reuse-rust <original-result.json>`.
The current run must select Rust. Add `--job rust` to request that job explicitly.
The verifier accepts an original Rust pass from a completed PR run, including one whose JavaScript job failed.
Without `--keep-going`, a JavaScript failure stops the Rust job, so that run has no Rust pass.
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
It runs both gates even when the filters omit one, including when the diff is empty, and keeps going after a failure.
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
