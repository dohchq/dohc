# Operate the Mac check runner

This procedure is for the maintainer who runs dohc's self-hosted macOS check runner on a Mac mini with Apple silicon.
The runner registers with the labels `self-hosted`, `macOS`, `ARM64`, and `dohc-ci`.

## Trust model

Any repository writer can run any code on this runner, as its macOS user.
A writer pushes a branch whose workflow names the runner's labels, and the job starts at once, with no review.
A rule that a workflow runs only from `main` does not prevent this, because the branch carries its own workflow.
The writers are Ice and every GitHub App with `contents` and `workflows` write access: today `chatgpt-codex-connector`, `blacksmith-sh`, and `macroscopeapp`.

The runner therefore follows these rules:

- It runs as `dohc-ci`, a dedicated standard macOS user. It never runs as a person's account or as an administrator.
- The `dohc-ci` account holds no credentials or secrets. It has no `gh` login, SSH key, Git credential, cloud account, keychain item, or signing identity.
- No release job runs on it. The macOS release jobs run on GitHub-hosted runners, and only they receive the macOS signing secrets.
- No workflow gives it the `desktop-release` label.

A job can still change anything `dohc-ci` can change: its home folder, its toolchains, its Colima VM, and the runner's own files.
A later run, including the nightly check of `main`, inherits those changes.
Treat a passing check as evidence from a machine that every writer controls, not as a release gate.
To reset the runner, delete the `dohc-ci` user and repeat the setup below.

Other local users' files must stay closed to `dohc-ci`.
macOS gives every standard user the `staff` group, and a new home folder lets that group read it.
Services on `127.0.0.1` are reachable from every account on the Mac. Each one must authenticate its callers.

For pull requests from forks:

- Keep fork pull request workflows disabled while the repository is private.
- Before the repository becomes public, set "Require approval for all external contributors" in the repository's Actions settings.
- No workflow may add a `pull_request` trigger that runs on this runner.

## What it runs

`macOS checks` runs every night at 03:37 UTC+8, and when a maintainer dispatches it.
It runs `pnpm verify:pr --base HEAD --full`, the canonical PR gate in full mode, then the whole desktop e2e suite with `pnpm test:desktop:e2e`.
The PR gate runs only the desktop proofs, so macOS e2e failures otherwise go unnoticed.

Each run starts from a clean checkout and removes every ignored file with `git clean -ffdx`.
Nothing that an earlier run left in the checkout, such as build output, locks, or evidence, reaches the next run.
Each run therefore builds the engine and desktop from the beginning.

The run uploads `result.json`, step logs, and Playwright reports as the `macos-verification-<attempt>` artifact for 14 days.
Traces, test workspaces, and profiles stay in the runner's checkout until the next run. They can contain document text.

`PR checks` never uses this runner. It is one machine and can be off, so no required check depends on it.

## Check a pull request on the Mac

Dispatch `macOS checks` from `main` and name the pull request's head branch:

```sh
gh workflow run macos-checks.yml --repo dohchq/dohc --ref main -f ref=<branch>
```

The workflow file comes from `main`, and the checked-out code comes from `<branch>`.
The job fails unless the checked ref is a branch of this repository.
A fork's branch, a `pull/<n>/head` ref, a tag, or a commit SHA does not resolve.
To check a fork's change, review it, then push it to a branch of this repository.

One check runs at a time. GitHub keeps one pending run and cancels an older pending run, including a dispatch.

## Set up the runner

Ice runs this setup once with administrator rights.
It creates `dohc-ci`, gives it its own login session, and registers the runner inside that session.
The session is necessary because the e2e suite opens Electron windows.

### Prepare the Mac as Ice

1. Remove the old runner registration. Its service is already unloaded.

   ```sh
   cd ~/dev/actions-runner
   ./svc.sh uninstall
   ./config.sh remove --token "$(gh api -X POST repos/dohchq/dohc/actions/runners/remove-token --jq .token)"
   cd ~ && rm -rf ~/dev/actions-runner
   ```

2. Close your home folder to other local users:

   ```sh
   chmod 700 /Users/ice
   ```

3. Create `dohc-ci` as a standard user. The command asks for its password.

   ```sh
   sudo sysadminctl -addUser dohc-ci -fullName "dohc CI" -password -
   ```

4. Turn on fast user switching, and stop the Mac from sleeping. A sleeping Mac does not start the nightly run.

   ```sh
   sudo defaults write /Library/Preferences/.GlobalPreferences MultipleSessionEnabled -bool true
   sudo pmset -a sleep 0
   ```

5. Confirm that Homebrew has Colima, Docker, and Git: `brew install colima docker git`.
   `dohc-ci` runs these programs but cannot change them.

6. Create a runner registration token. Keep it for the next part. It expires after one hour.

   ```sh
   gh api -X POST repos/dohchq/dohc/actions/runners/registration-token --jq .token
   ```

### Install the runner as dohc-ci

Switch to `dohc-ci` with fast user switching, sign in, and open Terminal.

1. Install rustup and the cargo tools that `.github/workflows/pr-checks.yml` pins:

   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
   source "$HOME/.cargo/env"
   cargo install --locked cargo-deny --version 0.20.2
   cargo install --locked cargo-audit --version 0.22.2
   cargo install --locked cargo-nextest --version 0.9.143
   ```

2. Start this user's own Colima VM once: `colima start`.
   Each job starts it again if it is not running.
   Do not give `dohc-ci` another user's Docker socket. A Docker client controls the Colima VM, and Colima mounts its owner's home folder into that VM.

3. Download the macOS ARM64 runner into `~/actions-runner`. Follow the download step on the repository's Settings > Actions > Runners > New self-hosted runner page.

4. Register and start the runner with the token from Ice's step 6:

   ```sh
   cd ~/actions-runner
   export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
   ./config.sh --url https://github.com/dohchq/dohc --token <token> --name dohc-ci-mac-mini --labels dohc-ci --unattended
   ./svc.sh install
   ./svc.sh start
   ```

   The runner records that `PATH` in `.path`. Jobs find `cargo`, `colima`, and `docker` through it.
   `svc.sh` installs a launch agent for `dohc-ci`, so it starts each time `dohc-ci` signs in.

5. Switch back to your own account. Leave `dohc-ci` signed in.

Each job downloads the Node version in `.node-version` and the pnpm version in `package.json`.
The verifier installs the pinned Playwright Chromium for `dohc-ci`. Xcode Command Line Tools are installed for every user.

### After a restart

FileVault prevents automatic login.
Sign in as Ice, switch to `dohc-ci` and sign in, then switch back.
The runner starts when `dohc-ci` signs in.

## Unverified until the first run

The e2e suite has not yet run in a background fast-user-switching session.
The first nightly run must confirm that Electron windows open and render there, and that failure screenshots capture them.
It must also confirm that the clipboard tests pass, because each session has its own clipboard.
Until then, a failure in those areas can come from the session rather than from dohc.
