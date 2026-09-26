# Enable Blacksmith CI

This procedure is for the maintainer enabling paid CI at launch.
Track the remaining public-contributor setup in [issue #1193](https://github.com/dohc-ai/dohc/issues/1193).

## Keep cloud execution off

The repository variable `BLACKSMITH_ENABLED` controls runner allocation in `PR checks`.
An absent variable or `false` skips every PR job before a runner starts.
Manual dispatch still uses registered self-hosted Linux x64 runners.

Inspect the switch:

```sh
gh variable list --repo dohc-ai/dohc
```

Keep it off until launch:

```sh
gh variable set BLACKSMITH_ENABLED --repo dohc-ai/dohc --body false
```

This switch does not install or uninstall Blacksmith's GitHub App.
It does not stop the app receiving GitHub events when installed.
Defer app installation too if Blacksmith must receive no repository activity before launch.

## Prepare the account at launch

1. Install the Blacksmith GitHub App for `dohc-ai/dohc` only.
2. Restrict its runner group's repository access to `dohc-ai/dohc`.
3. Set the billing email and an early monthly spending alert in Blacksmith.
4. Confirm an acceptable monthly budget and any provider-enforced cutoff before enabling automatic runs.
5. Keep fork workflows disabled in GitHub Actions settings.

Blacksmith's [documented spending threshold](https://docs.blacksmith.sh/introduction/settings) sends an email; it does not promise to stop jobs.
GitHub's Actions spending limit does not cap Blacksmith's separate bill.
Timeouts and cancellation limit wasted work, not total monthly spending.
Repository writers can change workflow files, so the switch is not a boundary against a malicious writer.

## Turn it on

Set the switch only when paid runs are authorized:

```sh
gh variable set BLACKSMITH_ENABLED --repo dohc-ai/dohc --body true
```

New updates to ready, same-repository PRs now run on Blacksmith.
Existing PRs need another push, a reopen, or a ready-for-review event to start checks.
Drafts and forks remain local-only. Converting a PR to draft cancels its older run.
New commits cancel older runs for the same PR.
There are no automatic main-branch, nightly, Windows, macOS, or release builds in this workflow.

Run a manual benchmark from the Actions page, or use:

```sh
gh workflow run pr-checks.yml --repo dohc-ai/dohc --ref main -f gate=all -f runner_size=4
```

The `gate` input accepts `all`, `js`, or `rust`.
The `runner_size` input accepts `4` or `8` vCPUs and affects manual Blacksmith runs only.
Manual runs execute the full requested gates; automatic PR runs select affected gates and JavaScript packages.
Shared inputs still select full coverage. Each test job has a 60-minute timeout.

Compare cold and warm runs before choosing larger runners or shorter timeouts.
Record elapsed time, billed cost, peak memory, and disk use for each gate.
The first Linux cloud run remains a launch check; local verification cannot establish its runtime or cost.

## Read the result

PR jobs check out the event's merge commit and compare it with the event's base commit.
The path filter uses Git, avoiding the PR files API's file limit.
The canonical verifier records the tested commit and base in `result.json`.

Require the `PR verification` result after enabling CI and confirming the repository plan supports required checks.
It succeeds only when selection succeeds and every selected gate passes.
Intentionally unselected gates must be skipped; failed or cancelled gates cannot pass.
A skipped workflow while Blacksmith is off is not verification evidence.
Manual runs prove only their requested gates, so retain evidence for every gate selected by the PR.

Download the `verification-js-*` and `verification-rust-*` artifacts for receipts, logs, and step durations.
Artifacts expire after seven days. The workflow excludes browser traces, test workspaces, and profiles.
Record the run URL and verification scope in the PR before artifacts expire.

## Turn it off

Set `BLACKSMITH_ENABLED` to `false` with the command above.
Cancel any queued or running Blacksmith workflows in GitHub Actions.
Changing the variable alone does not cancel runners already allocated.
Resume local verification. Manual dispatch returns to self-hosted runners.
