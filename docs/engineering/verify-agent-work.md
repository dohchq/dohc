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
`pnpm qa:e2e` and the PR verifier install the pinned browser.
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

Run `pnpm test:together` after a change to shared editing. See [Editing together](#editing-together).

The runner writes a result, step logs, and desktop evidence under `.agent-artifacts/verification/<run>`.
Each Electron instance records its process, profile, workspace, and prepared build.
Read the failing assertion and its logs together. Inspect the screenshot and Playwright trace when the behavior is unclear.
Treat traces as private artifacts. They can contain document text and credentials entered during the test.

## Editing together

`pnpm test:together` puts several people on one share link and has them edit the same note.
The people are headless browsers. The server is a sync relay with its own engine and the share page's server, started on your computer.
A headless engine plays the note's owner. The tests start no desktop app and reach no other server.

Run `pnpm qa:prepare` first. It builds the engine, the Markdown reader, and the share page that the tests start.

The tests cover four things:

- Two people change the same place at the same moment.
- The relay is killed and started again while people type.
- The share page's server restarts under open pages.
- Several people make ordinary edits for some minutes. Set `TOGETHER_MINUTES`, `TOGETHER_PEOPLE`, or `TOGETHER_SEED` to change the run.

[`knownFaults.ts`](../../apps/desktop/e2e/together/knownFaults.ts) lists the faults that are known and not yet fixed.
A listed case must fail the way its fault does. The check fails if that case comes out right, or goes wrong another way.
If you fix a listed fault, remove its line in the same change.
If a case fails that is not listed, your change broke it, or you found a new fault. Do not add a line to pass the check without an issue that describes the fault.

The PR checks run these tests in the `editing together` job when a change touches the relay, the share page, the engine, a workspace package, or the desktop code the tests load.
The desktop's engine capture plays the note's owner, so most code changes select the job.
The job's filter is `together` in [`pr-checks.yml`](../../.github/workflows/pr-checks.yml). `PR verification` requires the job when the filter selects it.
`pnpm verify:pr` does not run these tests. When it selects `together`, the report lists the job under `ciEvidence`, and a merge needs a passing run of it for the head.

To read a failure, open `test-results/together-report.json`. Each case records what every page showed and what the services printed.

The same job has a second leg, `share page`. It runs the share page's own end-to-end tests in `services/share-web/e2e`, on its own runner.
Run them locally with `pnpm --filter @dohc/share-web test:e2e`.

## Windows package

The **Windows package** job in the PR checks builds the Windows desktop app and opens it.
It builds the desktop and the release engine, checks the package's settings, and packs the app with `electron-builder --dir`.
It then runs the release workflow's Windows packaged smoke against that app: an edit, persistence on disk, and a restart.
It builds no installer and signs nothing. The release workflow does both.

The job runs when a change touches what goes into the package or the smoke that opens it.
That is the desktop's source and build scripts, the workspace packages and services the desktop bundles, the engine, the packaging configuration, the smoke, and the install inputs.
The job's filter is `windows` in [`pr-checks.yml`](../../.github/workflows/pr-checks.yml). `PR verification` requires the job when the filter selects it.
The job always uses GitHub's `windows-2025` runner and receives no secrets.
It took about 8 minutes with the Rust build cache and 14 minutes without it.

`pnpm verify:pr` does not run this job. When it selects `windows`, the report lists the job under `ciEvidence`, and a merge needs a passing run of it for the head.
To run the same smoke on a Windows computer, build a [fixed preview](#hand-someone-a-fixed-preview).

## Debug a separate app

Run `pnpm qa:debug` to start a prepared desktop with its own workspace, home, and profile.
Read the printed `instance.json` for the main-process inspector and renderer debugger addresses.
Attach a debugger to those loopback endpoints. Confirm the recorded checkout before editing or measuring.
Close that app or interrupt its command to stop the session and retain logs, a screenshot, and a trace.
The session retains its disposable data beside the evidence for diagnosis.
On macOS and Linux, the app reaches its home through a short link in the system temp folder.
The short path keeps the desktop's CLI socket path under the system's limit, so agents can reply.
`instance.json` records the link as `home` and the folder as `homeFiles`. The session removes the link when it ends.

For native folder-dialog QA, run `pnpm qa:debug -- --native-dialogs`.
Ask the operator to choose the printed disposable workspace, cancel a second picker, and confirm keyboard focus returns to the app.
Record the operator's result with the session evidence. The automated picker seam does not prove native-dialog behavior.

## Hand someone a fixed preview

A debug session runs the checkout's changing build. To let a person try one commit beside their installed dohc on Windows, build a fixed preview instead.

1. Commit the change. Check out that commit with no other changes.
2. Run `pnpm qa:preview --commit <full SHA> --base <target-ref> --pr <number>`.
3. Send the person the `Try it` text that the command prints at the end.

The command builds the desktop and the release engine, then packages the app with `electron-builder --dir`. Cargo waits for the shared build budget.
It refuses a checkout at another commit or with uncommitted changes. It checks the source again after packaging.
It copies the package into a new delivery folder, `~/dohc-previews/<id>` unless you pass `--output`.
It then runs the release workflow's Windows packaged smoke against that copy: an edit, persistence on disk, and a restart.
The package is unsigned. The builder removes signing, telemetry, and Vite settings from its environment.

The delivery folder holds:

- `app`, the package.
- `manifest.json`, with the commit, base, PR, build steps and log hashes, package tree hash, executable, ASAR and engine hashes, signing status, and smoke result.
- `launch.mjs` and `Try it.cmd`, which start the preview.
- `evidence`, with the build logs and the smoke's `result.json`.

Start only with `Try it.cmd`, which uses the Node runtime inside the package. Opening `app/dohc.exe` directly uses the installed app's profile and link handler.
The launcher reads nothing from the checkout. It refuses to start the app if any package file differs from the manifest, or if the smoke did not pass.
The app keeps its own profile, home, `APPDATA`, and `LOCALAPPDATA` in the folder's `data` subfolder.
It leaves the installed app's link handler and recent documents alone.
The launcher removes `DOHC_*` and agent configuration variables from the app's environment.
The preview never downloads or installs an update. The launcher serves it an empty update feed on `127.0.0.1` for as long as it runs.
Close all preview windows to quit. If it stays in the tray, use Quit dohc there. The app checks for unsaved work.
The launcher does not force the app or engine to stop. Ctrl+C leaves an open preview running.
If startup recovery relaunches the app, the launcher cannot track the replacement process. Close that preview's windows before starting another. If it stays in the tray, use Quit dohc there.

This separates data. It is not an OS sandbox: the app runs as the current user, and a folder the person chooses is a real folder.
The launcher redirects `HOME` and `USERPROFILE` and removes explicit agent configuration paths. Agents can still use configuration from the operating system account, environment credentials, or Windows Credential Manager.
Open only a new folder or a copy of a workspace. Opening a workspace used by installed dohc can migrate its engine store and prevent the installed build from opening it.
Build previews only from branches in this repository. Never build one from a fork's code on a host that holds credentials.
The person deletes the delivery folder when they finish. That removes only its contents. Workspaces opened elsewhere and their engine stores remain there.

## Verify a pull request

A merge needs passing evidence for every selected job, on a head that covers the change:

- One verification owner runs the gates. Others reuse that evidence and run focused checks.
- Missing, cancelled, or failed runs are not passes.
- Evidence carries across a rebase or merge once you check the delta. Rerun only the checks that changed source, dependencies, configuration, or a conflict resolution affect. Advancing main alone needs no rerun.
- If a job reads a changed file outside its filter, fix the filter and run the job. When the impact is unclear, run `--full`.
- Windows and macOS behavior needs its own platform check.
- Windows screenshot baseline differences do not block a merge. Record them. The nightly catches drift, and a follow-up PR updates the PNGs.
- Record the tested commit, target, selected jobs, results, evidence, and any reuse in the PR.

This section explains how to read the cloud PR checks and how to run the same gates locally.
[The verification queue](verification-queue.md) covers the queue service on the shared hosts, the nightly run, and moving requests.

### Cloud PR checks

The [`PR checks` workflow](../../.github/workflows/pr-checks.yml) runs the complete selected JavaScript and Rust inventories, split across parallel jobs.
Each gate also requires shared preparation and both confinement jobs to pass. A failed JavaScript job does not suppress Rust's verdict.
Cloud jobs retry failing Vitest group cases, desktop and account browser proofs, and node:test files once. Other commands do not retry.
A test that passes on retry stays in the receipts under `flaky`, and the job logs name its task and test.
If confinement fails, select **Re-run all jobs**. Artifacts belong to a run attempt, so **Re-run failed jobs** cannot recreate preparation artifacts for the new attempt.

Android compiles only in CI. The **Android Kotlin compile** job runs when a change reaches a file in the workflow's `android` filter: the phone's native modules, its Expo config, or the install inputs.
It generates the Expo Android project and compiles the Kotlin of both native modules for debug. A Kotlin error fails the job with its file and line.
Nothing Android runs locally. When `pnpm verify:plan` or `pnpm verify:pr` selects `android`, the report lists the job under `ciEvidence`, and a merge needs a passing run of it for the head.

The Windows package job also runs only in the PR checks. See [Windows package](#windows-package).

The iOS sample UI tests run in their own advisory workflow on GitHub's free `xcode-27` runner. They don't gate merges, and a newer push cancels the running job.

The timing targets are 300 s for JavaScript and 600 s for Rust. The failure ceilings are 400 s and 700 s.
A gate's `seconds` runs from the start of `what changed` to the finish of the gate's last job.
Receipts record the target as `targetSeconds` and the ceiling as `budgetSeconds`. Read the receipt's `timing`:

- `"within budget"`: at or below the target.
- `"over target"`: above the target, up to and including the ceiling. The run passes with a warning.
- `"over budget"`: above the ceiling. The run fails.
- `"unmeasured"`: above the target while a job waited more than 30 s for a runner. The run warns with the wait and does not fail for time, even above the ceiling.
  A receipt transfer above 30 s excuses only its own seconds. The run still fails if it is above the ceiling without them.

`"unmeasured"` excuses time only. Failed tests, incomplete inventory or coverage, wrong commits, and missing, duplicated, cancelled, or failed jobs still fail.
The organisation's Team plan permits 60 concurrent standard-runner jobs.
A combined run peaks at 25 jobs, so two combined runs fit and a third can queue.
The workflow holds the job graph, wait caps, and job timeouts.
[`cloud.mjs`](../../scripts/verification/cloud.mjs) and [`cloud-rust.mjs`](../../scripts/verification/cloud-rust.mjs) run each job's tests. [`cloud-aggregate.mjs`](../../scripts/verification/cloud-aggregate.mjs) checks the receipts and computes the timing verdict.

For a full measurement, dispatch `PR checks` with `gate=all` and `cache=cold`, then repeat with `cache=warm` on the same commit.
Read the cache logs before describing a hit or miss. A requested cache condition alone does not establish one.
To measure custom REST requests, read the request counts that each wait logs. Standard action upload, download, and cache requests are additional.
Use the [Blacksmith setup procedure](enable-blacksmith.md) to inspect or change the optional Blacksmith runners.

### Run the gates locally

Fetch the PR's target branch. Use its fetched ref as `<target-ref>` below, such as `origin/main`.
Run `pnpm verify:plan --base <target-ref>` to see the applicable workflow gates.
When the JavaScript gate applies, the plan also lists the services, prepared builds, and integration proofs it needs.
Commit the changes. Run `pnpm verify:pr --base <target-ref>` against that clean commit.
The runner rejects changes to the source or commit during verification.
A local `pnpm verify:pr` runs the whole selected gate. [`verify.mjs`](../../scripts/verification/verify.mjs) holds the runner.

The JavaScript gate prepares the engine and desktop and typechecks the whole workspace.
It then runs the [affected packages'](#affected-packages) tests, the [selected repository tests](#repository-tests), the desktop script tests, and every integration proof.
Integration suites must run. An unavailable prerequisite fails the run instead of skipping the suite.
A standalone `pnpm test` does not run the integration proofs.
The runner starts its own Postgres container for the database tests and proofs, and removes it by its recorded container ID.
On headless Linux hosts, only the desktop proof runs under Xvfb.
The `@states-page` pixel gallery runs only on Windows, where its baselines were taken.
A local Rust-only run skips Electron, desktop preparation, Postgres, and the browser proofs.
The Rust gate uses the repository build budget and checks its summary verdict.

Before a run queues, the runner checks the host tools.
It also runs the workspace typecheck when the installed dependencies match the lockfile.
When Rust is selected, it runs `cargo fmt --check`, then clippy and the nextest test build under one build slot.
A failure stops the run before it joins the queue. The `pre-queue-*` steps record these checks, and the full gate repeats them as evidence.

### Choose the jobs and reuse Rust evidence

To schedule jobs separately, use `pnpm verify:pr --base <target-ref> --job js` and `--job rust`.
Each report states its scope. Every selected job needs passing evidence that covers the change.
An explicit `--job` runs that job even when the filters omit it.
Use it when a build or test step reads a changed file outside the filters.

Run `pnpm verify:pr --base <target-ref> --full` before a release or when impact is uncertain.
It runs both gates even when the filters omit one, including when the diff is empty, and keeps going after a failure.
Use `pnpm verify:plan --base <target-ref> --full` to inspect that selection.

After a renderer fix, reuse completed Rust evidence with `pnpm verify:pr --base <target-ref> --reuse-rust <original-result.json>`.
The current run must select Rust. Add `--job rust` to request that job explicitly.
The verifier accepts an original Rust pass from a completed PR run, including one whose JavaScript job failed.
Without `--keep-going`, a JavaScript failure stops the Rust job, so that run has no Rust pass.
The original report must contain a Rust identity and every required passing gate check. A report without that identity requires a fresh Rust run.
The verifier compares Git content, tools, platform, environment, and Cargo configuration.
Only renderer source changes and commits with identical inputs can reuse Rust evidence.
All other tracked changes require a fresh Rust job, including dependencies, fixtures, and verification scripts.
Every reuse runs the pinned tool probes, `cargo deny check`, and `cargo audit` again.
Read the current report's `rustEvidence` reference and `rust-reuse` step to distinguish reused checks from executed checks.
The reference keeps the original tested commit, report hash, gate log hash, and changed paths.
Keep the original report and logs until review finishes. Reused evidence cannot become another reuse source.

### Read the report

Read `result.json` before reporting a pass.
Use the report's `steps[].seconds` when recording verification delays.
Use its top-level `seconds` for the complete run, including preparation and cleanup.
The `timings` rows record the queue wait, source checks, preparation, and database setup and cleanup, including failed phases.
The Rust and JavaScript jobs start together, so their step rows can overlap. Do not add step durations to estimate elapsed time.
Runtime packaging waits until Rust finishes. The `packaging-wait` timing records that wait, which also counts toward the `tests` step.
Package results and durations are in the JS test report that `result.json` references.

### Flaky tests

The gate runs a failing test once more before it fails the change.
A test that passes only on that retry does not fail the gate. `result.json` lists it under `flaky`, the verifier prints it, and the queue history records it.
A flaky test is a defect. Fix the condition it races, or report it to whoever owns it.
Treat every `flaky` entry as a real failure until you have read it.
A repository or desktop script step reruns as a whole, after its first attempt's ignored outputs, so a test that fails on a clean tree but passes beside those outputs is also recorded as flaky.

A package test or a repository or desktop script test that fails both tries runs once more: its whole file, alone, with one worker.
If every file with a failed test passes alone, the step passes. `result.json` and `js-tests/result.json` list each failed test under `flaky` with `passedAlone: true`, and the verifier marks it "failed both tries, passed alone".
A test that passes only alone usually depends on timing, a race, or something other tests share. It is a defect like any other flaky test.
If a file fails alone too, the gate fails the change. `failed` then also lists each test the file failed alone, so the commands under `rerun` cover them.
`js-tests/result.json` records each file run alone under its step's `alone`, with its log and its outcome: `passed`, `failed`, `no test ran`, or `interrupted`.
The Rust tests and the Playwright proofs have no isolated retry. Neither does an interrupted step, or a step that failed outside its tests, such as a failed check or build.
[`flaky.mjs`](../../scripts/verification/flaky.mjs) and [`js-tests.mjs`](../../scripts/verification/js-tests.mjs) hold the retry rules for each kind of test.

### A failure stops the run

The first step that fails stops the rest of a PR run. A step fails only after its retry and its isolated retry, so a test that passes on either stops nothing.
The runner interrupts the running Rust job, package tests, and proofs as it does on Ctrl+C. It then removes their processes, Postgres, and containers.
The verdict is FAIL. `result.json` names the failed step under `stopped.after` and lists each step that did not finish under `stopped.notRun`.
Each of those steps has the verdict `NOT RUN`. `js-tests/result.json` records the package tests and proofs that did not finish in the same way.
A stopped Rust job is never a pass, so its evidence cannot be reused.

Pass `--keep-going` to let both jobs finish after a failure. In the JavaScript job, running steps finish, but no new step starts.
Use it when you need every failure, or Rust evidence to reuse after a JavaScript failure.
A `--full` run always keeps going. On the shared host, the queue keeps going only with `--full`; add `--inline` to keep going without it.

### Affected packages

The JavaScript gate runs package tests only for the packages a change affects: the packages its files are in, and every package that depends on them.
A change to any file outside the workspace packages, such as a lockfile, a crate, or a root script, runs every package. Documentation changes run none.
Proofs always run. `pnpm verify:plan` lists the selected packages, and `result.json` records them under `packages` and `js-tests/result.json` under `skippedPackages`.
Pass `--full` to run every package. The nightly run on main always does.
[`selection.mjs`](../../scripts/verification/selection.mjs) holds the rules that select packages and repository tests.

### Repository tests

The repository tests check the tooling under `scripts/` and `tools/`.
A change to a file that they read runs all of them, `pnpm test:repo`. The `repository` filter in [`pr-checks.yml`](../../.github/workflows/pr-checks.yml) lists those files.
Any other change that selects the JavaScript gate runs only the tests that read the source tree, `pnpm test:repo:tree`.
That script runs the source checks in `pnpm test:repo:source`, then the repository tests that read package source.

`--full`, `--keep-going`, and an empty diff run every repository test. The nightly run always runs every repository test.
`pnpm verify:plan` shows the script under `javascript.repositoryTests`, and `result.json` records it under `repositoryTests`.
When the gate runs only the tree set, the verifier prints `repository tests: tree set only (no tooling change). --full runs every repository test.`

A repository test that reads a file outside `scripts/`, `tools/`, `.github/`, and the root files must add that path to the `repository` filter.
A test that reads package source goes in `test:repo:tree` as well as `test:repo`, so that every JavaScript change runs it.

## Measure performance

Use `node tools/perf-profiling/run-profiles.mjs --output <directory> --seed <uint32>` in each checkout.
Use the same machine, fixture seed, scenario settings, and build mode for the base and candidate.
The profiling report records bundle and engine hashes. Keep both reports with the comparison.
Use `--tiny` to check the harness; use the full fixture for performance claims.

## Finish the task

Keep verification evidence until review finishes, then remove the task worktree, its build targets, and the evidence.
