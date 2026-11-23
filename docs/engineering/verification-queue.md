# The verification queue

The shared Windows host and the shared Mac verify PRs through a queue service. For the gates themselves, read [Verify desktop work](verify-agent-work.md#verify-a-pull-request).

## How it works

On a shared host, `pnpm verify:pr` runs its quick checks, then hands the commit to the queue. The queue verifies it in its own checkout, called a lane, so your checkout is free while you wait. Stopping `pnpm verify:pr` doesn't stop the request. Run the same command again to follow it or get the result. `--detach` submits and returns at once.

| | Windows host | Mac |
| --- | --- | --- |
| Build slot root | `C:\w\_locks` | `~/dev/worktrees/.locks` |
| Queue root | `C:\w\_verification` | `~/dev/worktrees/_verification` |
| Lanes | `lane` to `lane-4` | `lane` only |
| Service | `dohc-verification-queue` scheduled task | `app.dohc.verification-queue` LaunchAgent |
| Nightly | `dohc-verification-nightly` scheduled task | `app.dohc.verification-nightly` LaunchAgent |

- A newer commit on the same branch replaces that branch's waiting request and keeps its place.
- The same commit with the same gates joins the existing request or reuses its pass.
- A run that fails because of the machine, such as low disk or Docker not answering, is retried after 30 s, 2 min, 5 min, then every 15 min. A run that fails a check is reported at once and never retried.
- A run fails after two hours awake.
- No run starts while free disk is under 40 GB. A second run starts only with 10 GB of free memory.

Commands:

- `pnpm verify:queue status` shows the service, the running requests, the line, and wait times.
- `pnpm verify:queue cancel <id>` stops one of your own requests. Never cancel another agent's request.

Each attempt keeps its evidence in `requests/<id>/attempts/<n>` in the queue root. The request's `status.json` holds the verdict. `history.jsonl` in the queue root records every run, with its load.

The code is in [`queue-service.mjs`](../../scripts/verification/queue-service.mjs), [`queue-monitor.mjs`](../../scripts/verification/queue-monitor.mjs), and [`queue-supervisor.mjs`](../../scripts/verification/queue-supervisor.mjs).

## Dashboard

The service serves a dashboard at `http://127.0.0.1:4250` on the host. It shows each lane's live output, the line, the week's runs, failures shared across branches, slow and flaky tests, and the nightly runs. It can pause and resume the queue, and switch the Windows host between 2 and 3 lanes.

To open it from another device, serve it on the tailnet only:

```powershell
tailscale serve --bg --https=8446 http://127.0.0.1:4250
```

Anyone the tailnet lets reach that port can change the queue. Never use Tailscale Funnel. The page shows branch names and test output.

## Install the service

Run `pnpm verify:queue install` from a checkout of `origin/main`. An upgrade takes effect when the current runs end. The service starts at logon, and a supervisor restarts it if it stops.

On a Mac, the install needs the Xcode Command Line Tools, and must run from a shell that finds node, git, cargo, and Docker. `pnpm verify:queue uninstall` removes the service and keeps the queue's files. When a Mac run ends, the service stops the processes it left behind.

## Inline runs

CI, Linux, and Macs without the service verify in your own checkout. On a shared host, pass `--inline` only when the queue can't do the job: the service is down, or you need `--reuse-rust`, or `--keep-going` without `--full`. An inline run still waits for a free lane, up to six hours, and skips the owners' turns.

## Lanes

The Windows host runs one verification at a time unless `C:\w\_locks\verification-lanes` holds a bigger number, up to 4. Use the dashboard for 2 or 3 lanes. For 4, write the file:

```powershell
Set-Content C:\w\_locks\verification-lanes 4
```

Each extra lane takes about 10 GB more disk. Keep the Mac at one lane: desktop tests open windows on its one display and can't share it.

To check the build slots without joining them, run `node tools/rust-engine-program/build-slot.mjs --status`.

## Rust on Linux

On the Windows host, a run that selects Rust also builds Rust in WSL, so a Linux-only break fails before merge. A PR run runs clippy and the app compiler's Landlock and seccomp tests there. A full run runs every Rust test. `C:\w\_locks\verification-linux` names the WSL distro. Without that file, nothing runs on Linux.

The step is `rust-linux`, with its evidence in the attempt's `rust-linux` folder. A clippy warning or failed test fails the change. A WSL or network failure is a machine failure and is retried. To rerun a failed Linux check, use your own clone in WSL, not the queue's. [`linux.mjs`](../../scripts/verification/linux.mjs) holds the details.

## Restart the computer without losing a run

A restart stops every run, and each one starts over. Pause the queue first:

1. Run `pnpm verify:queue pause --reason "<why>"`.
2. Run `pnpm verify:queue status` until it says `paused and idle: safe to restart`.
3. Restart.
4. Run `pnpm verify:queue resume`.

The dashboard can do steps 1, 2, and 4. If the computer restarts without a pause, the queue pauses itself and waits for a resume. Windows fast startup hides a shutdown from the service, so pause before you shut down too.

## Failures other branches share

`result.json` lists each test that failed under `failed`, and the command to rerun it under `rerun`. Run those commands until the tests pass before you resubmit.

On a shared host, the verifier also lists under `shared` each failed test that another branch failed in the last day. That usually means main or a flaky test is broken, not your change. Check the test on `origin/main` and in the last [nightly](#nightly-run). Don't work around it in your PR. Fix it in its own PR, or wait for the fix and rebase.

## Owners take turns

Each request has an owner: the T3 thread a person started, or the name given with `--owner`, or else the checkout. If T3 doesn't know your thread, use the same `--owner` name for all its work.

The nightly run goes first, then any request moved with `--first`. After that, the next lane goes to the owner who has waited longest without a run. Each turn starts that owner's first request, so 30 waiting requests get no more turns than one. Put your most important request first with `move --before`.

## Move a waiting request

```sh
pnpm verify:queue move <id> --before <other-id> --reason "<why>" [--by "<name>"]
pnpm verify:queue move <id> --first --reason "<why>" [--by "<name>"]
```

- `--before` reorders one owner's waiting requests.
- `--first` puts a request at the front, behind only the nightly. Use it only to unblock other work: a fix for a broken main, a fix for a failure several branches share, or a request a person asked to hurry. Never use it just to get your own run sooner.

A move never stops or starts a run. The service records each move with its reason and who asked. If a move isn't applied after 30 seconds, run `pnpm verify:queue upgrade` from a checkout of `origin/main`.

## Nightly run

Every night at 03:07, the host verifies main's head in full: every job, package, repository test, and proof. It runs before the rest of the line and keeps going after a failure. It also runs each desktop unit test file in its own worker, so it catches tests that only pass because of another file. A head that already passed isn't run again.

A failed nightly means a merged change broke main, or the PR checks missed something. Find the change and revert or fix it the same day. Submit a nightly by hand with `pnpm verify:queue nightly`. The [`verification-triage`](../../.agents/skills/verification-triage/SKILL.md) skill has the steps.

## Slowest tests

`result.json` keeps each gate's 20 slowest tests under `slowest`. A per-PR gate should take 15 minutes or less on an idle lane. A weekly review fixes, splits, or speeds up the tests that cost the most, through the `verification-triage` skill.
