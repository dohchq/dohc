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
The JavaScript gate runs the [affected packages'](#affected-packages) tests, the [selected repository tests](#repository-tests), the desktop script tests, and every integration proof.
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
The service verifies the commit in one of its own checkouts, `C:\w\_verification\lane` to `lane-4`, so your checkout is free to change while the request waits.
Stopping `pnpm verify:pr` does not stop the request. Run the same command again to follow it, or to get its result once it has finished.
Pass `--detach` to submit the request and return at once.

- [Owners take turns](#owners-take-turns). Each owner's requests run in the order the service accepted them, unless someone [moves one](#move-a-waiting-request).
- A newer commit on the same branch replaces that branch's waiting request and keeps its owner and its place, including a place a move gave it. A running request finishes.
- The same commit with the same gates joins the existing request, or reuses its pass.
- A run that fails because of the machine is retried in place, after 30 seconds, 2 minutes, 5 minutes, then every 15 minutes. Machine failures include a program that could not start, too little disk, and Docker or the host tools not responding.
- A run that fails a check is reported at once. The service never retries it.
- A run stops and fails after two hours of awake time. Time the machine spends asleep does not count.
- While Docker does not respond, runs that need the JavaScript gate wait and Rust-only runs continue.
- A run beyond the first starts only while free memory is at least 10 GB. The service counts only its own runs here, not inline gates holding a lane. A check that fails after free memory fell below 3 GB during the run is retried as a machine failure.
- While free disk is below the 40 GB floor, no run starts. The service first deletes the build output of its lanes that have no run.

Each lane runs with its own temp folder, `C:\w\_verification\tmp\<lane>`, which antivirus skips and the service empties before each run.
Each attempt records the load it verified under in `status.json` and `C:\w\_verification\history.jsonl`: the highest lane setting while it ran, the most runs at once, the lowest free memory, and the mean CPU use. Read them before changing the lane count, and to tell a failure under three lanes from one under two.
Each attempt has its own evidence folder, `C:\w\_verification\requests\<id>\attempts\<n>`, and its `result.json` names the request and attempt.
Read the service's verdict from the request's `status.json`, or from the last line `pnpm verify:pr` prints.

Run `pnpm verify:queue status` to see the service, a pause, the lane setting, the running requests, the line with each request's owner, and wait estimates.
Run `pnpm verify:queue cancel <id>` to stop one of your own requests. Never cancel a request another agent submitted. A finished request keeps its verdict.

The service also serves a dashboard at `http://127.0.0.1:4250` on the host. Its Now tab shows what holds each verification lane, a queued request or an agent's inline gate, with its steps and its live output, then the requests ready and waiting for a lane, the next requests in line, and the last day's runs, CPU, and waiting requests. Queue, History, Threads, Tests, and Nightly tabs show the whole line, every run this week, each thread's runs and results, the tests that failed on two or more branches in the last day, the slowest and flaky tests, and the nightly runs.
A test that fails on several branches and on main's nightly points to a broken main. One that the nightly did not fail is more often flaky.
When T3 runs on the host, the dashboard names each request by the T3 thread that linked its branch's pull request, or whose worktree or branch it uses. It reads T3's local database read-only once a minute. Without T3 it names requests by their branch.
Select a run to see its failing step's test summary, its steps on a timeline, and any of its logs. The dashboard refreshes every few seconds. It records the host's CPU and free memory once a minute in `monitor-load.json` in the queue root.
When the page cannot reach the dashboard server, it says so and since when, keeps what it last showed, and tries again. It waits at most 15 seconds for each answer.

The dashboard changes the queue in two ways: its Pause and Resume button, and its lane switch. Pause asks for an optional reason and does what `pnpm verify:queue pause` does. Resume does what `pnpm verify:queue resume` does, without asking first.
While the queue is paused, every tab shows a banner with the words `pnpm verify:queue status` uses, such as `Paused and idle: safe to restart`. A hold after a computer restart says so. Start estimates count from the resume, such as `40 min after resume`.
The pause records `by` as `{ "name": "dashboard", "host": "<host name the page used>" }`, and the service log records each pause and resume from the dashboard.

The lane switch beside Pause sets the host's lane count, `verification-lanes`, to 2 or 3 without asking first. It always shows the current setting, including a count of 1 or 4 set on the host.
At 3, the queue starts a third gate when a request waits and free memory allows another run. The first gate in `C:\w\_verification\lane-3` starts cold, because the service creates that checkout then.
Switching back to 2 stops nothing. Lane 3 finishes its current gate and takes no more. Until then, every tab shows `Lane 3 closes after its current gate`, and `pnpm verify:queue status` prints the same note.
The setting stays until someone changes it, through service and computer restarts.
The queue's history records each change from the dashboard as a `lanes` event, with `by` as for a pause, and the service log records it too.

To open the dashboard from another device, serve it on the tailnet only:

```powershell
tailscale serve --bg --https=8446 http://127.0.0.1:4250
```

Then open `https://<host>.<tailnet>.ts.net:8446`. Every device and user that the tailnet's access rules let reach this port can read the page, pause or resume the queue, and switch the lanes.
Do not use Tailscale Funnel: the page shows branch names and test output. The page refuses every request that arrives through Funnel.
The page answers only to the host's own names and to tailnet names.
Pause, resume, and the lane switch accept only a JSON `POST` whose `Origin` header names the host the request was sent to. A page from any other origin, including another port on this host or another tailnet machine, cannot send that request, so it cannot change the queue.
The lane switch accepts only `{ "lanes": 2 }` or `{ "lanes": 3 }`. The server refuses any other value and changes nothing.
A write body must arrive within 10 seconds and be at most 4 KB. The server answers a refused write and closes its connection.

The `dohc-verification-queue` scheduled task starts the service at logon and every five minutes if it is not running.
A supervisor runs the service in a Windows job object. When the service exits or its heartbeat stops for two minutes, the supervisor stops it and everything it started, then starts it again.
A request that was running when the service stopped runs again as a new attempt. A request whose receipt already finished keeps that result.
Install or upgrade the service from a checkout of `origin/main` with `pnpm verify:queue install`. An upgrade takes effect when the current runs end. No new run starts until then.

CI, other platforms, and runs with their own `DOHC_BUILD_SLOT_ROOT` verify inline in their checkout.
On the shared host, pass `--inline` only when the queue cannot do the job: the service is unavailable, or the run needs `--reuse-rust`, or `--keep-going` without `--full`.
An inline run takes a lane outside the [owners' turns](#owners-take-turns), and it says so when it starts. Inline runs still wait for the host's verification lane, so they never overlap a queued run.
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

The host runs one verification at a time unless `verification-lanes` in the slot root holds a larger count, up to `4`.
The queue service and every verifier from #1972 on read that file and agree on the count. Direct `pnpm verify:pr` runs on the host take the same lanes.
A verifier older than #1972 reads only 1 or 2. While the setting is 3 or 4, its `--inline` gate fails at admission; its queued gates are unaffected, because the service holds their lane.
The queue service runs each extra lane's requests in its own checkout, `C:\w\_verification\lane-2` to `lane-4`, and creates each one on its first run there. Each one's build output takes about 10 GB more disk.
Use the dashboard's lane switch for 2 or 3 lanes. For another count, write the file on the host:

```powershell
Set-Content C:\w\_locks\verification-lanes 4
```

Write a smaller count to return to fewer lanes. Runs already admitted to a lane finish first.

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

### Restart the computer without losing a run

A computer restart stops every run in progress, and each one later starts again from the beginning. Pause the queue first:

1. Run `pnpm verify:queue pause --reason "<why>"`.
2. Run `pnpm verify:queue status` until it prints `paused and idle: safe to restart`.
3. Restart the computer.
4. Run `pnpm verify:queue resume`.

The dashboard can do steps 1, 2, and 4: select Pause, wait for the banner `Paused and idle: safe to restart`, and select Resume after the restart.
With 3 or more lanes, read step 2 from the dashboard or from `status` in a checkout that includes #1972. An older checkout counts inline gates only in lanes 1 and 2, so it can call a restart safe while lane 3 runs.

While the queue is paused, runs in progress finish and no new run starts, the nightly run included. The line keeps its order.
An inline run that holds a verification lane counts as running. An inline run without a lane waits, says once that the queue is paused, and starts after the resume.
The pause lasts until you resume it, through service and computer restarts.

If the computer restarts while the queue is not paused, the service pauses it when it starts, with the reason `the computer restarted`.
No run starts until you run `pnpm verify:queue resume` or select Resume on the dashboard. `pnpm verify:queue status` shows the reason, and the dashboard shows the hold. A service restart within one boot, such as an upgrade, does not pause the queue.
Windows fast startup hibernates the system at shutdown, so the next start continues the same boot and the service sees no restart. Pause the queue before you shut down.

### Flaky tests

The gate runs a failing test once more before it fails the change.
nextest, vitest, and Playwright retry the failing test itself. The repository and desktop script steps run again when their report names a failed test; a failed check or build is not retried. The self-host proof runs again from an empty evidence folder.
A test that passes only on that retry does not fail the gate. `result.json` lists it under `flaky`, the verifier prints it, and the queue history records it.
A flaky test is a defect. Fix the condition it races, or report it to whoever owns it.
A repository or desktop script step reruns as a whole, after its first attempt's ignored outputs. A test that fails on a clean tree but passes beside those outputs is recorded as flaky like any other, so treat every entry as a real failure until you have read it.

Both tries run under the same load, so a package test or a repository or desktop script test that fails both tries runs once more, alone, with one worker.
The gate runs the test's whole file at once, with the step's environment, while other steps continue. A test that fails only after another test in its file still fails alone, and so does a file that fails in a way its report does not name.
A file passes alone only when it exits cleanly and its report shows, by name, that each of its tests that failed both tries passed. A test that skips itself alone is no pass.
If every file with a failed test passes alone, the step passes. `result.json` and `js-tests/result.json` list each failed test under `flaky` with `passedAlone: true`, and the verifier marks it "failed both tries, passed alone".
A test that passes only alone usually depends on timing, a race, or something other tests share. It is a defect like any other flaky test.
If a file fails alone too, the step fails, and the gate fails the change. `failed` then also lists each test the file failed alone, so the commands under `rerun` cover them. `js-tests/result.json` records each file run alone under its step's `alone`, with its log and its outcome: `passed`, `failed`, `no test ran`, or `interrupted`.
A step that failed outside its tests gets no isolated retry. That includes a failed check or build and a test with no rerun command. In package tests it also includes a file that failed to load, a failed hook, and an unhandled error.
In script tests, node:test reports a failed hook as a failed test, and a file that failed to load or threw an unhandled error as a failed file, so their files run alone.
A script test gets no isolated retry when it failed before the script's last command, because the commands after it never ran. It gets none when it failed only when the step ran again, because it did not fail both tries.
An interrupted step gets no isolated retry either. The Rust tests and the Playwright proofs have none yet.

### Failures other branches share

`result.json` lists each test that failed on its last try under `failed`, with the same step and test names as `flaky`. The queue records both lists for each attempt in `status.json` and the queue history.
The list covers package tests, the repository and desktop script tests, the account and desktop browser proofs, and the Rust tests. A step that fails outside a test, such as typecheck, lists none.
Before you resubmit a failed run, run each command that it prints and records under `rerun` until its failed tests pass.

When a run fails on the shared host, the verifier looks for its failed tests in the last day of queue history. It prints each test that another branch's run also failed, with those branches, and records them in `result.json` under `shared`. Runs of your own branch do not count.
A failure that other branches share often comes from main or from a flaky test, not from your change.

When the gate prints that list, check the test on `origin/main` and in the [last nightly](#nightly-run). Do this before you change your branch for that test.
Do not add a workaround for that failure to your PR. Fix main or the flaky test in its own PR, or wait for that fix and rebase.

### Owners take turns

The service records an owner for each request when it accepts it:

1. The T3 thread a person started for the work. A subagent's thread counts under the thread a person started above it. The service finds the thread as the dashboard does: by the checkout's worktree, a linked pull request, or the branch.
2. If T3 does not know the thread, the name given with `pnpm verify:pr --owner <name>`.
3. Otherwise, the checkout.

`pnpm verify:pr` prints the owner when the service accepts the request.
If T3 does not know your thread, pass the same `--owner` name for all of your thread's work. A new name for each request makes each request a new owner.

The service starts the nightly run first, then any request [moved with `--first`](#move-a-waiting-request).
Then the next lane goes to an owner with no run in progress, the one that has gone longest without a start. An owner that has never started goes first.
An owner with a run in progress waits until every owner without one has had a turn.
Each turn starts the owner's first request in line, so a thread with 30 waiting requests gets one start per turn, like a thread with one.
A request that cannot start yet, because it needs Docker while Docker is down or waits for a retry, holds no turn. Its owner's next request can take the turn.
An attempt that failed because of the machine uses no turn.
The turns add no capacity. They give each thread quick feedback on its most important request, so put that request first with `move --before`.

`pnpm verify:queue status`, the wait estimates, and the dashboard show the line in the order the service starts it when every request can start.
The dashboard's Queue tab shows each request's owner and how many requests that owner has waiting.
An [inline run](#the-verification-queue-on-the-shared-windows-host) takes no turn.

### Move a waiting request

```sh
pnpm verify:queue move <id> --before <other-id> --reason "<why>" [--by "<name>"]
pnpm verify:queue move <id> --first --reason "<why>" [--by "<name>"]
```

`--before` orders your own requests. It puts a request just ahead of another waiting request with the same owner, so it runs on that owner's next turn.
`--first` puts a request at the front of the line, behind only the nightly run and ahead of every owner's turn.
Use `--first` only to unblock other work: a fix for a failure that several branches share, a fix for a broken main, or a request a person asked to hurry.
Never use `--first` only to get your own run sooner. Any agent may move any waiting request, including one another thread submitted.

A move only brings a waiting request forward. `--before` needs another waiting request that is ahead of it now.
A move never stops or starts a run. It changes only which request starts next, and the nightly run still goes first.
The service applies the move within a few seconds, and the command prints the request's new place. If the service is not running, the move applies when it starts.
A service installed before this command existed applies no moves. After 30 seconds the command says so. Run `pnpm verify:queue upgrade` from a checkout of `origin/main` to install a service that applies them.
The command refuses to move a request that is unknown, running, or finished. It refuses `--before` a request with another owner, a request moved with `--first`, or one the request is already ahead of. It says why.

The service records each move in `history.jsonl` with its reason, the `--by` name, the OS user, and the checkout that asked. It keeps the reason to one line of at most 300 characters.
`pnpm verify:queue status` shows the last move beside the request, such as `moved first by Ice (C:\w\fix-grid): fixes the grid test three branches fail`. Every agent on the host runs as the same OS user, so the checkout always shows.
The dashboard marks a moved request in the line and in its lane once it runs. Point at the mark, or move keyboard focus to it, to see who moved it and why.

### A failure stops the run

The first step that fails stops the rest of a PR run. A step fails only after its retry and its isolated retry, so a test that passes on either stops nothing.
The runner interrupts the running Rust job, package tests, and proofs as it does on Ctrl+C. It then removes their processes, Postgres, and containers.
The verdict is FAIL. `result.json` names the failed step under `stopped.after` and lists each step that did not finish under `stopped.notRun`.
Each of those steps has the verdict `NOT RUN`. `js-tests/result.json` records the package tests and proofs that did not finish in the same way.
A stopped Rust job is never a pass, so its evidence cannot be reused.

Pass `--keep-going` to let both jobs finish after a failure. In the JavaScript job, running steps finish, but no new step starts.
Use it when you need every failure, or Rust evidence to reuse after a JavaScript failure.
A `--full` run always keeps going. On the shared host, the queue keeps going only with `--full`; add `--inline` to keep going without it.

### Nightly run

Every night at 03:07, the `dohc-verification-nightly` scheduled task submits a full verification of main's head: every gate, every package, every repository test, and every proof.
It covers everything merged since the last nightly that passed, and it runs before the rest of the line. A head that already passed is not verified again.
It keeps going after a failure, so triage sees the failures of both jobs.
`pnpm verify:queue status` shows the last passing nightly. Submit one by hand with `pnpm verify:queue nightly`.
A failed nightly means a merged change broke main, or the selection of affected packages or repository tests missed something. Find the change that broke it and revert or fix it the same day.
The [`verification-triage` skill](../../.agents/skills/verification-triage/SKILL.md) has the procedure.

### Affected packages

The JavaScript gate runs package tests only for the packages a change affects: the packages its files are in, and every package that depends on them.
A package depends on another when its manifest says so, or when its files reach into the other's files by a relative path, as some tests import another package's source.
A change to any file outside the workspace packages, such as a lockfile, a crate, or a root script, runs every package. Documentation changes run none.
Proofs always run. `pnpm verify:plan` lists the selected packages, and `result.json` records them under `packages` and `js-tests/result.json` under `skippedPackages`.
Pass `--full` to run every package. The nightly run on main always does.

### Repository tests

The repository tests check the tooling under `scripts/` and `tools/`.
A change to a file that they read runs all of them, `pnpm test:repo`.
The `repository` filter in [`pr-checks.yml`](../../.github/workflows/pr-checks.yml) lists those files: `scripts/`, `tools/`, `.github/`, the root files, every `package.json`, and the few app and crate files that a test reads.
Any other change that selects the JavaScript gate runs only the tests that read the source tree, `pnpm test:repo:tree`.
It runs the source checks in `pnpm test:repo:source`, then `packaged-benchmark.test.mjs` and `go-to-packaged-fixture.test.mjs` from `tools/perf-profiling/`, which read package source.

`--full`, `--keep-going`, and an empty diff run every repository test. The nightly run always runs every repository test.
`pnpm verify:plan` shows the script under `javascript.repositoryTests`, and `result.json` records it under `repositoryTests`.
When the gate runs only the tree set, the verifier prints `repository tests: tree set only (no tooling change). --full runs every repository test.`

A repository test that reads a file outside `scripts/`, `tools/`, `.github/`, and the root files must add that path to the `repository` filter.
A test that reads package source goes in `test:repo:tree` as well as `test:repo`, so that every JavaScript change runs it.

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
