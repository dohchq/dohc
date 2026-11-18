# Verify desktop work

How to set up a worktree, prove a change, and verify a pull request.

## Prepare the checkout

1. Create a worktree from the base you intend to merge into. Keep dependencies, builds, and app profiles inside it.
2. On Windows, install PowerShell 7 and put `pwsh.exe` on `PATH`. Verification uses it to stop leftover processes.
3. Run `pnpm setup:worktree`. It installs the pinned dependencies and checks your tools.
4. On Linux, run `pnpm exec playwright install-deps chromium` once. It needs administrator access.
5. Run `pnpm run doctor` to check that the checkout is ready. (`pnpm doctor` is pnpm's own command and checks nothing here.)
6. Run `pnpm qa:prepare` to build the native engine and the desktop. The desktop tests refuse a missing or stale build.

To run the Rust gate locally, also install these tools within the [Rust build budget](../../.agents/skills/rust-gate/SKILL.md#cargo-outside-the-gate). The versions must match `.github/workflows/pr-checks.yml`:

```sh
cargo install cargo-deny --locked --version 0.20.2
cargo install cargo-audit --locked --version 0.22.2
cargo install cargo-nextest --locked --version 0.9.143
```

## Prove the change

- While you edit, run the smallest unit or integration test that covers the change.
- `pnpm qa:smoke` starts the desktop, edits a note, checks it on disk, and restarts.
- `pnpm qa:e2e -- --grep <test-name>` runs one desktop flow.
- `pnpm qa:e2e -- --grep @two-client` runs two desktops that edit offline, resolve the conflict, and restart.
- `pnpm test:together` runs the shared-editing tests. See [Editing together](#editing-together).

Results, logs, screenshots, and Playwright traces go to `.agent-artifacts/verification/<run>`. Read the failing assertion with its log. Traces can hold document text and credentials, so keep them private.

## Editing together

`pnpm test:together` puts several headless browsers on one share link, editing the same note. It starts a sync relay and the share page's server on your computer. Run `pnpm qa:prepare` first.

The tests cover two people editing the same place at once, the relay restarting while people type, the share server restarting under open pages, and several minutes of ordinary edits. `TOGETHER_MINUTES`, `TOGETHER_PEOPLE`, and `TOGETHER_SEED` change that last run.

[`knownFaults.ts`](../../apps/desktop/e2e/together/knownFaults.ts) lists known faults. A listed case must fail the way its fault says. If you fix a fault, remove its line in the same change. If an unlisted case fails, your change broke it or you found a new fault. Only add a line with an issue that describes the fault.

The PR checks run these tests in the `editing together` job, with the share page's own tests (`pnpm --filter @dohc/share-web test:e2e`) beside them. `pnpm verify:pr` doesn't run them. When it selects the job, the merge needs a passing cloud run of it. Read failures in `test-results/together-report.json`.

## Windows package

The **Windows package** PR check builds the Windows app with `electron-builder --dir`, opens it, edits a note, checks it on disk, and restarts. It builds no installer, signs nothing, gets no secrets, and takes about 8 to 14 minutes. `pnpm verify:pr` doesn't run it. When it selects `windows`, the merge needs a passing cloud run. To try the same build on a Windows computer, make a [fixed preview](#hand-someone-a-fixed-preview).

## Debug a separate app

Run `pnpm qa:debug` to start a desktop with its own workspace, home, and profile. The printed `instance.json` has the debugger addresses. Close the app to end the session. It keeps logs, a screenshot, and a trace.

To test the native folder picker, run `pnpm qa:debug -- --native-dialogs` and ask a person to choose the printed workspace, cancel a second picker, and check that focus returns. Record their answer. Automated tests don't prove the native dialog.

## Hand someone a fixed preview

To let a person try one commit on Windows beside their installed dohc:

1. Commit the change, and check out that commit with no other changes.
2. Run `pnpm qa:preview --commit <full SHA> --base <target-ref> --pr <number>`.
3. Send the person the `Try it` text the command prints.

The command builds and packages the app, runs the Windows smoke on it, and copies it to `~/dohc-previews/<id>`. The package is unsigned.

The person starts it only with `Try it.cmd`. Opening `app/dohc.exe` directly uses the installed app's profile. The preview keeps its data in its own folder, never updates itself, and leaves the installed app alone. It is not a sandbox: it runs as the person, and can still reach their files and agent credentials. Open only a new folder or a copy of a workspace. The person deletes the folder when they finish.

Build previews only from branches in this repository.

## Verify a pull request

A merge needs a pass for every selected job, on a commit that covers the change:

- One person or agent owns verification. Others reuse that result and run focused checks.
- A missing, cancelled, or failed run is not a pass.
- A pass still counts after a rebase if you check what changed. Rerun only the checks the new changes affect. A newer main alone needs no rerun.
- If a job reads a changed file outside its filter, fix the filter and run the job. If you aren't sure, run with `--full`.
- Windows and macOS behavior needs its own check on that platform.
- Windows screenshot differences don't block a merge. Note them. A follow-up PR updates the images.
- Record the tested commit, target, jobs, results, and any reuse in the PR.

The queue on the shared hosts has [its own guide](verification-queue.md).

### Cloud PR checks

Ready PRs from this repository run the [`PR checks` workflow](../../.github/workflows/pr-checks.yml) on GitHub's runners. Passing checks on the latest commit replace a local `pnpm verify:pr`. Drafts and forks start no checks.

- A failing test runs once more. A test that passes on the retry shows under `flaky`.
- If a confinement job fails, use **Re-run all jobs**, not **Re-run failed jobs**.
- Android and the Windows package build only in the cloud. When the plan selects them, the merge needs their cloud pass.
- The iOS UI tests run in a separate workflow and don't block merges.
- The time targets are 300 s for JavaScript and 600 s for Rust, and the limits are 400 s and 700 s. The receipt's `timing` says `within budget`, `over target` (passes with a warning), `over budget` (fails), or `unmeasured` (a job waited over 30 s for a runner, so time doesn't count).

### Run the gates locally

1. Fetch the target branch, such as `origin/main`.
2. Run `pnpm verify:plan --base <target-ref>` to see which jobs apply.
3. Commit your changes.
4. Run `pnpm verify:pr --base <target-ref>`. Don't change the checkout while it runs.
5. Read `result.json` before you report a pass.

The JavaScript gate builds the engine and desktop, typechecks everything, and runs the [affected packages'](#affected-packages) tests, the [repository tests](#repository-tests), and every integration test. A missing prerequisite fails the run instead of skipping it. The Rust gate builds within the shared budget and reads its summary verdict.

Before a run joins the queue, it checks your tools, typechecks, and, for Rust, runs `cargo fmt --check` and clippy. A failure there stops it early.

Useful flags:

- `--job js` or `--job rust` runs one job, even if the filters skip it.
- `--full` runs every job and package, and keeps going after a failure. Use it before a release or when you aren't sure what a change affects.
- `--keep-going` lets both jobs finish after a failure.
- `--reuse-rust <original-result.json>` reuses a Rust pass after a renderer-only fix. Any other change needs a fresh Rust run.

### Flaky tests

A failing test runs once more before it fails the change. If it passes then, `result.json` lists it under `flaky`. If a JavaScript test fails twice, its file runs once more, alone. If it passes alone, it is listed under `flaky` with `passedAlone: true`.

A flaky test is a bug. Treat every `flaky` entry as a real failure until you read it. Fix the race, or report it to the test's owner. Rust tests and Playwright proofs get no run-alone retry.

### A failure stops the run

The first failing step stops the rest of the run. `result.json` names it under `stopped.after`, and marks the steps that didn't finish `NOT RUN`. A stopped Rust job is never a pass. Use `--keep-going` when you need every failure.

### Affected packages

The JavaScript gate tests only the packages a change touches, plus every package that depends on them. A change outside the workspace packages, such as the lockfile or a root script, tests every package. Docs test none. `pnpm verify:plan` lists the packages. [`selection.mjs`](../../scripts/verification/selection.mjs) holds the rules.

### Repository tests

The repository tests check the tools in `scripts/` and `tools/`. A change to a file they read runs all of them (`pnpm test:repo`). Any other JavaScript change runs only those that read package source (`pnpm test:repo:tree`). The `repository` filter in `pr-checks.yml` lists the files.

If you add a repository test that reads a file outside `scripts/`, `tools/`, `.github/`, and the root, add that path to the `repository` filter. If it reads package source, add it to `test:repo:tree` too.

## Measure performance

Run `node tools/perf-profiling/run-profiles.mjs --output <directory> --seed <uint32>` in the base and in your checkout, on the same machine with the same settings. Keep both reports. `--tiny` only checks the harness.

## Finish

Keep the evidence until review finishes. Then remove the worktree, its build output, and the evidence.
