# Operate the Mac runner

This procedure is for the maintainer who runs dohc's self-hosted macOS runner, a Mac mini with Apple silicon.
The runner registers with the labels `self-hosted`, `macOS`, `ARM64`, and `desktop-release`.

## What it runs

| Workflow | Jobs on the Mac |
| --- | --- |
| `macOS checks` | Every night at 03:37 UTC+8, and on dispatch: `pnpm verify:pr --base HEAD --full`, then `pnpm test:desktop:e2e` |
| `Desktop Release` | The macOS arm64 package for `macos` and `all`. Preflight, version check, and Publish for `macos` |

`macOS checks` runs the same canonical gate as a pull request, in full mode, then the whole desktop e2e suite.
The PR gate runs only the desktop proofs, so macOS e2e failures otherwise go unnoticed.
The run uploads `result.json`, step logs, and Playwright reports as the `macos-verification-<attempt>` artifact for 14 days.
Traces, test workspaces, and profiles stay in the runner's checkout until the next run. They can contain document text.

`PR checks` never uses the Mac. It is one machine and can be off, so no required check depends on it.

## Check a pull request on the Mac

Dispatch `macOS checks` from `main` and name the pull request's head branch:

```sh
gh workflow run macos-checks.yml --repo dohchq/dohc --ref main -f ref=<branch>
```

The workflow file comes from `main`, and the checked-out code comes from `<branch>`.
The `ref` input accepts only a branch of this repository.
A fork's branch, a `pull/<n>/head` ref, or a commit SHA fails at checkout.
To check a fork's change, review it, then push it to a branch of this repository.
That push is the decision to run its code on the Mac.

One check runs at a time. GitHub keeps one pending run and cancels an older pending run, including a dispatch.
A release job also waits while a check holds the runner.

## Share the Mac with a person

Electron windows open on the Mac's only display, take focus, and use the system clipboard.
Before the first Electron window opens, the job waits until two conditions hold:

- Nobody has used the keyboard or mouse for 15 minutes. The job reads `HIDIdleTime` from `ioreg`.
- No other process holds the display lock, the directory `/tmp/dohc-display.lock`.

The job then holds the lock until it ends. It waits at most three hours, then fails.
A dispatch made at the Mac starts its checks 15 minutes after its sender leaves the Mac.

Agents and scripts that open Electron on the Mac must take the same lock:

1. Create the directory with `mkdir /tmp/dohc-display.lock`. If `mkdir` fails, another process holds the lock.
2. Write the holder's process ID to `pid` in that directory, and a description to `what`.
3. Remove the directory when the work ends.

A lock whose `pid` names no running process is stale, and the next process removes it.
The job writes its `Runner.Worker` process ID, so the lock goes stale when the job ends for any reason.

If you need the Mac while a check runs, cancel the run from the Actions page or with `gh run cancel <run-id>`.
Do not type into dohc windows that a run opened.
After a run that was killed, list leftover Postgres containers with `docker ps --all --filter label=dohc.verification` and remove them.

## Install the runner's tools

The jobs run under the runner's noninteractive `PATH`, which the runner records in its `.path` file.
Keep `/opt/homebrew/bin` before `/bin` in that file.

- Sign in to the macOS account that owns the runner. FileVault prevents automatic login, so sign in again after each restart.
- Turn off system sleep with `sudo pmset -a sleep 0`. A sleeping Mac does not start the nightly run.
- Install Homebrew bash 4 or newer with `brew install bash`. The release coordinator jobs do not run under the bash 3.2 that macOS ships.
- Install Xcode Command Line Tools with `xcode-select --install`.
- Install `gh` with `brew install gh`. The release version check and publish job use it.
- Install Docker through Colima with `brew install colima docker`. Start it at login with `brew services start colima`. The verifier starts its Postgres container through Docker.
- Install rustup. The checkout's `rust-toolchain.toml` selects the Rust toolchain.
- Install the cargo tools at the versions that `.github/workflows/pr-checks.yml` pins, with `cargo install --locked`: `cargo-deny`, `cargo-audit`, and `cargo-nextest`.

Each job downloads the Node version in `.node-version` and the pnpm version in `package.json`.
The verifier installs the pinned Playwright Chromium.
Rosetta is not required. dohc does not build for Intel Macs.

Confirm Docker from a shell with the runner's `PATH`:

```sh
env -i HOME="$HOME" PATH="$(cat ~/dev/actions-runner/.path)" docker info
```

The check keeps ignored build output, such as `target/` and `node_modules/`, between runs.
A release job in the same checkout removes that output, and the next check rebuilds it.

## Register the runner again

Run these steps in the runner's directory, `~/dev/actions-runner`, as the account that owns the runner:

1. Stop and remove the service with `./svc.sh stop`, then `./svc.sh uninstall`.
2. Remove the registration with `./config.sh remove --token <token>`. Get the token from the repository's Actions runner settings.
3. Register with `./config.sh --url https://github.com/dohchq/dohc --token <token> --labels desktop-release`. The runner adds `self-hosted`, `macOS`, and `ARM64`.
4. Install and start the service with `./svc.sh install`, then `./svc.sh start`.

The service is a launch agent for the signed-in account, so its jobs can open windows.
The runner records `PATH` in `.path` when it is configured. Correct that file if the tools above move.

## Trust model

Every job runs as the macOS account that owns the runner.
A job can read and change everything that account can: its home folder, SSH keys, keychains, Git credentials, and other checkouts.
A job also receives the workflow's token, and release jobs receive the `desktop-release` environment's signing secrets.

Only code that a repository writer put on a branch of this repository runs on the Mac.
`macOS checks` has no pull request trigger, and its `ref` input resolves only this repository's branches.
`Desktop Release` runs only from `main`.
Do not add a `pull_request` trigger that targets this runner. Do not enable fork pull request workflows for the repository.
Register the runner only on a Mac whose owner accepts this access, and keep personal secrets out of that account where possible.
