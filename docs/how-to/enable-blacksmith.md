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
3. Set the billing email and a $50 monthly spending alert in Blacksmith.
4. Plan for $100 per month. Confirm any provider-enforced cutoff before enabling automatic runs.
5. While private, keep fork PR workflows disabled in GitHub Actions settings.
6. Before making the repository public, require approval for all external contributors in GitHub Actions settings.
7. Inspect workflow changes before approving any outside contributor's run.

Blacksmith's [documented spending threshold](https://docs.blacksmith.sh/introduction/settings) sends an email; it does not promise to stop jobs.
GitHub's Actions spending limit does not cap Blacksmith's separate bill.
Timeouts and cancellation limit wasted work, not total monthly spending.
PRs can change their own workflow files, including the switch and fork checks.
Use GitHub's [fork approval controls](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/approving-workflow-runs-from-public-forks) to control who can start those runs.
The workflow switch is not a spending boundary against malicious contributors or repository writers.

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

Run the first benchmark on `main`, then repeat it to measure cache reuse.
GitHub lets PRs restore caches from their base branch and the default branch.
Caches created by a PR cannot warm unrelated PRs.
Repeat the `main` benchmark after dependency or Rust toolchain changes when the shared cache needs refreshing.
Keep the separate JavaScript and Rust cache keys. Their build outputs differ.

## Keep runs within budget

Keep implementation PRs in draft until focused checks pass and the change is ready for review.
Batch review fixes into one push. If substantial implementation resumes, return the PR to draft.
Every material fix still needs passing verification before merge.
Reuse passing cloud evidence instead of repeating the full gates locally.
Keep focused local checks for platform-specific behavior.

Review spending, runs per PR, and cancelled runner minutes each week.
Cancellation stops future work; Blacksmith still bills time already used.
At the $50 alert, compare the month's projected spend with the $100 budget.
If projected spending exceeds the budget, reduce unnecessary reruns or follow the shutdown procedure below.
Continue required verification locally while cloud execution is off.

At $0.008 per minute, 950 PRs with ten combined 4-vCPU runner-minutes each cost $76 before credits and overhead.
Combined minutes include both jobs, even when they run in parallel.
Use ten minutes per PR as a planning target, not a measured runtime or permission to remove required tests.
The free allowance is shared across the organization; check its remaining balance before including it in the budget.
An 8-vCPU runner costs twice as much per minute. Choose it only after comparing cost per passing run.

## Read the result

PR jobs check out the event's merge commit and compare it with the event's base commit.
The path filter uses Git, avoiding the PR files API's file limit.
The canonical verifier records the tested commit and base in `result.json`.

Require the `PR verification` result after enabling CI and confirming the repository plan supports required checks.
When this job runs, it succeeds only when selection succeeds and every selected gate passes.
Intentionally unselected gates must be skipped; failed or cancelled gates cannot pass.
GitHub accepts skipped checks when their names match a required check.
In the observed disabled run, GitHub left this job's dynamic name unexpanded.
A required `PR verification` check can therefore remain `Expected` for a skipped run.
Resolve the fork-verification policy in issue #1193 before requiring this check for outside contributors.
Forks, drafts, and all PRs while Blacksmith is off still need recorded local evidence before merging.
A skipped check provides no verification evidence.
Manual runs report `Manual verification`, so a partial benchmark cannot satisfy the required PR check.
Retain evidence for every gate selected by the PR.

Download the `verification-js-*` and `verification-rust-*` artifacts for receipts, logs, and step durations.
Artifacts expire after seven days. The workflow excludes browser traces, test workspaces, and profiles.
Record the run URL and verification scope in the PR before artifacts expire.

## Turn it off

Remove `PR verification` from required checks before turning cloud CI off.
Set `BLACKSMITH_ENABLED` to `false` with the command above.
Cancel any queued or running Blacksmith workflows in GitHub Actions.
Changing the variable alone does not cancel runners already allocated.
Resume local verification. Manual dispatch returns to self-hosted runners.
