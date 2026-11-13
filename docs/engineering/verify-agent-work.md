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

[`AGENTS.md`](../../AGENTS.md#verify-the-change) holds the merge policy: who owns verification, which evidence a merge needs, when to reuse it, and what to record in the PR.
It also says how to [select reviewers](../../AGENTS.md#select-reviewers).
This section explains how to read the cloud PR checks and how to run the same gates locally.

### Cloud PR checks

The [`PR checks` workflow](../../.github/workflows/pr-checks.yml) runs the complete selected JavaScript and Rust inventories, split across parallel jobs.
Each gate also requires shared preparation and both confinement jobs to pass. A failed JavaScript job does not suppress Rust's verdict.
Cloud jobs retry failing Vitest group cases, desktop and account browser proofs, and node:test files once. Other commands do not retry.
A test that passes on retry stays in the receipts under `flaky`, and the job logs name its task and test.
If confinement fails, select **Re-run all jobs**. Artifacts belong to a run attempt, so **Re-run failed jobs** cannot recreate preparation artifacts for the new attempt.

The timing targets are 300 s for JavaScript and 600 s for Rust. The failure ceilings are 400 s and 700 s.
A gate's `seconds` runs from the start of `what changed` to the finish of the gate's last job.
Receipts record the target as `targetSeconds` and the ceiling as `budgetSeconds`. Read the receipt's `timing`:

- `"within budget"`: at or below the target.
- `"over target"`: above the target, up to and including the ceiling. The run passes with a warning.
- `"over budget"`: above the ceiling. The run fails.
- `"unmeasured"`: above the target while a job waited more than 30 s for a runner. The run warns with the wait and does not fail for time, even above the ceiling.
  A receipt transfer above 30 s excuses only its own seconds. The run still fails if it is above the ceiling without them.

`"unmeasured"` excuses time only. Failed tests, incomplete inventory or coverage, wrong commits, and missing, duplicated, cancelled, or failed jobs still fail.
The organisation's Team plan permits 60 concurrent standard-runner jobs, so three combined runs fit and a fourth can queue.
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

### The verification queue on the shared hosts

The shared Windows host and the shared Mac each run a queue service for PR verifications.
After the pre-queue checks, `pnpm verify:pr` hands the commit to the service and reports its progress until it finishes.
The service verifies the commit in one of its own checkouts, the lanes, so your checkout is free to change while the request waits.
Stopping `pnpm verify:pr` does not stop the request. Run the same command again to follow it, or to get its result once it has finished.
Pass `--detach` to submit the request and return at once.

Each host keeps its queue root beside its build slot root:

| | Windows host | Mac |
| --- | --- | --- |
| Build slot root | `C:\w\_locks` | `~/dev/worktrees/.locks` |
| Queue root | `C:\w\_verification` | `~/dev/worktrees/_verification` |
| Lanes | `lane` to `lane-4` in the queue root | `lane` in the queue root |
| Service | `dohc-verification-queue` scheduled task | `app.dohc.verification-queue` LaunchAgent |
| Nightly run | `dohc-verification-nightly` scheduled task | `app.dohc.verification-nightly` LaunchAgent |

A Mac takes the shared build budget only while `~/dev/worktrees/.locks` exists, and queues only while the service is installed. Other Macs verify inline.

- [Owners take turns](#owners-take-turns). Each owner's requests run in the order the service accepted them, unless someone [moves one](#move-a-waiting-request).
- A newer commit on the same branch replaces that branch's waiting request and keeps its owner and its place, including a place a move gave it. A running request finishes.
- The same commit with the same gates joins the existing request, or reuses its pass.
- A run that fails because of the machine is retried in place, after 30 seconds, 2 minutes, 5 minutes, then every 15 minutes. Machine failures include a program that could not start, too little disk, and Docker or the host tools not responding.
- A run that fails a check is reported at once. The service never retries it.
- A run stops and fails after two hours of awake time. Time the machine spends asleep does not count.
- A request that was running when the service stopped runs again as a new attempt. A request whose receipt already finished keeps that result.
- While Docker does not respond, runs that need the JavaScript gate wait and Rust-only runs continue.
- The service starts a run beyond its first only while free memory is at least 10 GB. Inline gates that hold a lane do not count as its runs.
- A check that fails after free memory fell below 3 GB during the run is retried as a machine failure.
- While free disk is below the 40 GB floor, no run starts. The service first deletes the build output of its lanes that have no run.
- The service removes each request's Docker containers itself.

Run `pnpm verify:queue status` to see the service, a pause, the lane setting, the running requests, the line with each request's owner, and wait estimates.
Run `pnpm verify:queue cancel <id>` to stop one of your own requests. Never cancel a request another agent submitted. A finished request keeps its verdict.

Each attempt has its own evidence folder, `requests/<id>/attempts/<n>` in the queue root, and its `result.json` names the request and attempt.
Read the service's verdict from the request's `status.json`, or from the last line `pnpm verify:pr` prints.
Each attempt records the load it ran under in `status.json` and in `history.jsonl` in the queue root: the highest lane setting, the most runs at once, the lowest free memory, and the mean CPU use.
Read the load before changing the lane count, and to tell a failure under three lanes from one under two.

For how the service works, read [`queue-service.mjs`](../../scripts/verification/queue-service.mjs), [`queue-monitor.mjs`](../../scripts/verification/queue-monitor.mjs) for the dashboard, and [`queue-supervisor.mjs`](../../scripts/verification/queue-supervisor.mjs) for the Mac supervisor.

#### Dashboard

The service serves a dashboard at `http://127.0.0.1:4250` on the host.
It shows what holds each lane with its live output, the line, the week's runs, the tests that failed on two or more branches in the last day, the slowest and flaky tests, and the nightly runs.
A test that fails on several branches and on main's nightly points to a broken main. One that the nightly did not fail is more often flaky.

The dashboard changes the queue in two ways, and the service log records each change:

- Pause asks for an optional reason and does what `pnpm verify:queue pause` does. Resume does what `pnpm verify:queue resume` does, without asking first.
- The lane switch sets the host's lane count, `verification-lanes`, to 2 or 3 without asking first. The setting stays until someone changes it, through service and computer restarts.
  Switching back to 2 stops nothing. Lane 3 finishes its current gate and takes no more. The Mac's dashboard [refuses the switch](#lanes-on-the-mac).

To open the dashboard from another device, serve it on the tailnet only:

```powershell
tailscale serve --bg --https=8446 http://127.0.0.1:4250
```

Then open `https://<host>.<tailnet>.ts.net:8446`. Every device and user that the tailnet's access rules let reach this port can read the page, pause or resume the queue, and switch the lanes.
Do not use Tailscale Funnel: the page shows branch names and test output. The page refuses every request that arrives through Funnel.
The page answers only to the host's own names and to tailnet names. A page from any other origin cannot change the queue.

#### Install and run the service

Install or upgrade the service from a checkout of `origin/main` with `pnpm verify:queue install`. An upgrade takes effect when the current runs end. No new run starts until then.
Each host starts the service at logon. A supervisor restarts the service when it exits or its heartbeat stops for two minutes, and first stops the service and everything it started.

On a Mac, the install creates `~/dev/worktrees/.locks` if it is missing. It writes both LaunchAgents to `~/Library/LaunchAgents` and loads them with `launchctl bootstrap gui/<uid>`.
The install builds `procenv` in the queue root with the system `cc`, so a Mac needs the Xcode Command Line Tools. The supervisor finds the service's processes with `procenv`.
Only your user can change `procenv` and the queue's files, because `~/dev` is open to its owner only. A queue root that `DOHC_VERIFICATION_QUEUE_ROOT` places elsewhere loses that protection.
The LaunchAgents keep the installer's `PATH`. Run the install from a shell that finds node, git, cargo, and Docker.
`pnpm verify:queue restart` loads the supervisor's LaunchAgent again, so a changed definition applies.
To remove the service from a Mac, run `pnpm verify:queue uninstall`. It unloads and deletes both LaunchAgents, and `pnpm verify:pr` then runs inline.
The queue root keeps its requests, history, lanes, and installs, so a later install starts with warm lanes. The uninstall prints how to remove them too.
`~/dev/worktrees/.locks` also stays, so builds and gates on that Mac keep sharing the build budget. To end that, delete the folder while no build or gate runs.

#### What the Mac service stops

On the Mac, the service and every process it starts carry `DOHC_VERIFICATION_SERVICE_INSTANCE` in their environment. Each run's processes also carry `DOHC_VERIFICATION_REQUEST`.
When an attempt ends, the service stops what its verifier left running, such as a daemon a test started. Before the supervisor starts a service, it stops what the last service left running.

- A shared per-user daemon that a verifier happens to start first carries the marker, and the service stops it with the run. Examples are an ssh ControlMaster, gpg-agent, watchman, and a tmux server on its default socket.
- Some processes escape: one that clears its environment, one that launchd starts on the run's behalf, such as an app opened through Launch Services, and some of Apple's own programs, whose environment macOS hides.
- A lane stays held until its run's leftover processes have stopped, and `pnpm verify:queue status` shows the run as `held`. The attempt records the stopped count as `strays`.
- If the supervisor cannot stop the last service's processes, it starts no service and keeps trying. `pnpm verify:queue status` prints `held since`, and `supervisor.log` records each try.
- While a run is active, the service holds off idle sleep, so a Mac set to sleep does not pause a gate.

#### Inline runs

CI, Linux, Macs without the service, and runs with their own `DOHC_BUILD_SLOT_ROOT` verify inline in their checkout.
On a shared host, pass `--inline` only when the queue cannot do the job: the service is unavailable, or the run needs `--reuse-rust`, or `--keep-going` without `--full`.
An inline run takes a lane outside the [owners' turns](#owners-take-turns), and it says so when it starts. Inline runs still wait for the host's verification lane, so they never overlap a queued run. They wait up to six hours.
An inline run owns its checkout until cleanup and receipt writing finish. Another PR run in that checkout fails before installation or queue admission and reports the owner.

#### Slots and lanes

Inspect the host's Cargo slots and verification lane without joining them:

```sh
node tools/rust-engine-program/build-slot.mjs --status
```

Use `--root <directory>` to inspect another queue root. The command emits JSON and does not create directories or acquire slots.
Wait estimates do not reject or reorder work. A lane with no completed runs has no estimate.
A live holder keeps its slot even if its heartbeat stops. Investigate its recorded PID before changing its resources.
Only `pnpm verify:pr` can take a verification slot. Other scripts that request one fail. A verification slot does not provide an idle host for benchmarks.
Performance measurements must record concurrent host work and use the shared build budget when running Cargo.
The live-authorship profiling command defers when registered gates or builds hold or wait for slots. If registered work arrives during measurement, it stops its own child and records the run as failed.
Its host context covers registered lanes and does not prove that the host was otherwise idle.

The host runs one verification at a time unless `verification-lanes` in the slot root holds a larger count, up to `4`.
The queue service and direct `pnpm verify:pr` runs on the host take the same lanes.
With 3 or 4 lanes, use a current checkout, one that includes #1972. An older checkout fails its `--inline` gate at admission.
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

#### Lanes on the Mac

Keep the Mac at one lane. Each desktop proof opens Electron windows on the Mac's one display, and Electron runs cannot share it.
The dashboard refuses the lane switch there. Do not write `verification-lanes` on the Mac.

### Rust on Linux

On the shared Windows host, a run that selects Rust also checks Rust in WSL. A change that breaks only the Linux build then fails before merge.
A PR run runs the gate's clippy command there, which builds every target, tests included, without running them.
It then runs the app compiler owner's tests, which check its Landlock and seccomp rules. Those compile only on Linux.
A full run, such as the nightly, runs the whole Rust job there, tests included.

The host names its WSL distro in `verification-linux` in the build slot root:

```powershell
Set-Content C:\w\_locks\verification-linux Ubuntu
```

Without that file, nothing runs on Linux. Other hosts and CI do not have it.
The distro needs systemd, and the Node, pnpm, Rust, and cargo tool versions that `pr-checks.yml` pins on the `PATH` of a login shell.

- The step is `rust-linux`. Its evidence is in the attempt's `rust-linux` folder: a `result.json`, the logs, and the scripts that ran in WSL. In a full run, that `result.json` and the logs are the Linux verifier's own.
- A clippy error or warning, or a failed Linux test, fails the change. A failed test appears under `failed` and `flaky` with the step `rust-linux`.
- A failure of WSL, of the transfer, or of the Linux host is a machine failure, and the queue retries it.
- The job first runs `cargo fetch --locked`. If cargo gives up after network errors, the run is a machine failure too. Any other failed fetch, such as a lockfile that needs an update, fails the change.
- The host runs one Linux job at a time for every lane. The job waits for the Linux slot, a cargo lane, and free memory on Windows.
  It waits at most 75 minutes in all, or 55 minutes in a full run. A longer wait is a machine failure, so the queue retries the run.
- The job runs in a systemd user scope with a memory limit of 11 GB, because all WSL distros share one VM with Docker.
  The scope's peak memory and out-of-memory kills are in the job's `scope.json`. A failure after a kill at the limit is a machine failure.
- If WSL's connection broke during a run, its Linux build can keep running beside other builds until the scope's two-hour limit.
  The next job stops a scope that a killed run left behind, and does not start while one still runs.
- `pnpm verify:plan` shows the distro under `linux`. A run that reuses Rust evidence with `--reuse-rust` runs nothing on Linux, because a reuse covers renderer changes only.

To run a failed Linux check again, use your own clone in the distro, not the queue's checkout in `~/.dohc-verification/linux`.
[`linux.mjs`](../../scripts/verification/linux.mjs) holds the transfer, the slots, and the scope.

### Restart the computer without losing a run

A computer restart stops every run in progress, and each one later starts again from the beginning. Pause the queue first:

1. Run `pnpm verify:queue pause --reason "<why>"`.
2. Run `pnpm verify:queue status` until it prints `paused and idle: safe to restart`.
3. Restart the computer.
4. Run `pnpm verify:queue resume`.

The dashboard can do steps 1, 2, and 4: select Pause, wait for the banner `Paused and idle: safe to restart`, and select Resume after the restart.
With 3 or more lanes, read step 2 from the dashboard or from `status` in a current checkout, one that includes #1972. An older checkout can call a restart safe while lane 3 runs.

While the queue is paused, runs in progress finish and no new run starts, the nightly run included. The line keeps its order.
An inline run that holds a verification lane counts as running. An inline run without a lane waits, says once that the queue is paused, and starts after the resume.
The pause lasts until you resume it, through service and computer restarts.

If the computer restarts while the queue is not paused, the service pauses it when it starts, with the reason `the computer restarted`.
No run starts until you run `pnpm verify:queue resume` or select Resume on the dashboard. `pnpm verify:queue status` shows the reason, and the dashboard shows the hold. A service restart within one boot, such as an upgrade, does not pause the queue.
Windows fast startup hibernates the system at shutdown, so the next start continues the same boot and the service sees no restart. Pause the queue before you shut down.

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

### Failures other branches share

`result.json` lists each test that failed on its last try under `failed`, with the same step and test names as `flaky`. The queue records both lists for each attempt in `status.json` and the queue history.
The list covers package tests, the repository and desktop script tests, the account and desktop browser proofs, and the Rust tests. A step that fails outside a test, such as typecheck, lists none.
Before you resubmit a failed run, run each command that it prints and records under `rerun` until its failed tests pass.

When a run fails on the shared host, the verifier looks for its failed tests in the last day of queue history. It prints each test that another branch's run also failed, with those branches, and records them in `result.json` under `shared`. Runs of your own branch do not count.
A failure that other branches share often comes from main or from a flaky test, not from your change.

When the gate prints that list, check the test on `origin/main` and in the [last nightly](#nightly-run). Do this before you change your branch for that test.
Do not add a workaround for that failure to your PR. Fix main or the flaky test in its own PR, or wait for that fix and rebase.

### Owners take turns

The service records an owner for each request when it accepts it, and `pnpm verify:pr` prints that owner:

1. The T3 thread a person started for the work. A subagent's thread counts under the thread a person started above it.
2. If T3 does not know the thread, the name given with `pnpm verify:pr --owner <name>`.
3. Otherwise, the checkout.

If T3 does not know your thread, pass the same `--owner` name for all of your thread's work. A new name for each request makes each request a new owner.

The service starts the nightly run first, then any request [moved with `--first`](#move-a-waiting-request).
Then the next lane goes to an owner with no run in progress, the one that has gone longest without a start. An owner that has never started goes first.
An owner with a run in progress waits until every owner without one has had a turn.
Each turn starts the owner's first request in line, so a thread with 30 waiting requests gets one start per turn, like a thread with one.
A request that cannot start yet holds no turn, and its owner's next request can take it. An attempt that failed because of the machine uses no turn. An [inline run](#inline-runs) takes no turn.
The turns add no capacity. They give each thread quick feedback on its most important request, so put that request first with `move --before`.
`pnpm verify:queue status`, the wait estimates, and the dashboard show the line in the order the service starts it when every request can start.

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
The command prints the request's new place, or says why it refused the move. If the service is not running, the move applies when it starts.
If the command says after 30 seconds that the service applies no moves, run `pnpm verify:queue upgrade` from a checkout of `origin/main`.
The service records each move in `history.jsonl` with its reason, the `--by` name, the OS user, and the checkout that asked.
`pnpm verify:queue status` and the dashboard show the last move beside the request, with who moved it and why.

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

Every night at 03:07, the host's nightly task submits a full verification of main's head: every gate, every package, every repository test, and every proof.
On the Mac, launchd runs a night the Mac slept through when it wakes.
It covers everything merged since the last nightly that passed, and it runs before the rest of the line. A head that already passed is not verified again.
It keeps going after a failure, so triage sees the failures of both jobs.
A PR run lets desktop unit test files share workers. A full run, the nightly included, runs each desktop unit test file in a worker of its own, so a test that passes only when another file runs before it in the same worker fails there.
`pnpm verify:queue status` shows the last passing nightly. Submit one by hand with `pnpm verify:queue nightly`.
A failed nightly means a merged change broke main, or the selection of affected packages or repository tests missed something. Find the change that broke it and revert or fix it the same day.
The [`verification-triage` skill](../../.agents/skills/verification-triage/SKILL.md) has the procedure.

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

### Slowest tests

Each gate keeps its 20 slowest tests in `result.json` under `slowest`, and prints the five slowest. The queue history keeps each run's step times and ten slowest tests.
A test that takes more than a second is a scenario test. Keep it, but make it earn its time: the per-PR gate should take 15 minutes or less on an idle lane.
A weekly review reads the history, then fixes, splits, or speeds up the tests and suites that cost the most. The [`verification-triage` skill](../../.agents/skills/verification-triage/SKILL.md) has its procedure.

## Measure performance

Use `node tools/perf-profiling/run-profiles.mjs --output <directory> --seed <uint32>` in each checkout.
Use the same machine, fixture seed, scenario settings, and build mode for the base and candidate.
The profiling report records bundle and engine hashes. Keep both reports with the comparison.
Use `--tiny` to check the harness; use the full fixture for performance claims.

## Finish the task

Keep verification evidence until review finishes, then remove the task worktree, its build targets, and the evidence.
