# Enable Blacksmith CI

This procedure is for the maintainer enabling paid CI at launch.
Blacksmith is optional and off. Without it, PR checks run on GitHub-hosted `ubuntu-24.04` runners.
Track the remaining public-contributor setup in [issue #1193](https://github.com/dohchq/dohc/issues/1193).

## Keep Blacksmith off

The repository variable `BLACKSMITH_ENABLED` chooses the runners in `PR checks`.
With both runner variables unset, PR checks and default manual dispatch use GitHub-hosted `ubuntu-24.04` runners.
A manual dispatch with `runner_provider=blacksmith` opts that run into Blacksmith while the switch stays off.
Confinement always uses GitHub's `ubuntu-24.04` image.

Set `BLACKSMITH_BUILD_VCPUS` to `4` or `8` to move only the shared JavaScript build (`shared preparation`) to Blacksmith.
An absent, empty, or other value leaves that job on GitHub. Manual `runner_provider=blacksmith-builds` selects only that job using `runner_size`.
The Rust archive stays on the same runner type as its test jobs because tests read build-time paths.
The full-gate switch and manual `blacksmith` selection keep their existing runner sizes; manual build-only selection overrides the build variable's size.

Inspect the switch:

```sh
gh variable list --repo dohchq/dohc
```

Keep it off:

```sh
gh variable set BLACKSMITH_ENABLED --repo dohchq/dohc --body false
```

This switch does not install or uninstall Blacksmith's GitHub App.
It does not stop the app receiving GitHub events when installed.
Defer app installation too if Blacksmith must receive no repository activity before launch.

## Prepare the account at launch

1. Install the Blacksmith GitHub App for `dohchq/dohc` only.
2. Restrict its runner group's repository access to `dohchq/dohc`.
3. Set a monitored primary email under Account, then configure a $50 monthly threshold under Spending Alerts.
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
gh variable set BLACKSMITH_ENABLED --repo dohchq/dohc --body true
```

New updates to ready, same-repository PRs now run on Blacksmith.
Existing PRs need another push, a reopen, or a ready-for-review event to start checks.
Drafts and forks start no automatic checks. Converting a PR to draft cancels its older run.
New commits cancel older runs for the same PR.
There are no automatic main-branch, nightly, Windows, macOS, or release builds in this workflow.

Run a manual benchmark from the Actions page, or use:

```sh
gh workflow run pr-checks.yml --repo dohchq/dohc --ref main -f gate=all -f runner_provider=blacksmith -f runner_size=4
```

The `gate` input accepts `all`, `js`, or `rust`.
The `runner_provider` input accepts `github` (default), `blacksmith`, or `blacksmith-builds` for a manual opt-in.
The default does not override `BLACKSMITH_ENABLED=true`.
The `runner_size` input accepts `4` or `8` vCPUs and affects both manual Blacksmith modes.
Manual runs execute the requested gates. Automatic PR runs execute the gates that the changed files select.
Cloud workload budgets are 300 s for JavaScript and 600 s for Rust, including preparation and reporting.
Gate timing records each gate's wall span, including both confinement jobs, without estimating workload from runner waits.
An over-budget run with more than 30 s of gate-job runner wait warns that timing is unmeasured; uncontended overruns fail.
A confinement job's runner wait counts only if it started after shared preparation finished.
Individual jobs have separate termination limits. See [verification timing](verify-agent-work.md#verify-a-pull-request).

The workflow runs 20 JavaScript workers and 16 Rust test partitions. Combined runs permit at most 25 concurrent jobs.
The initial peak includes preparation, Rust build, Rust policy, and both confinement jobs.
Rust test partitions wait for the JavaScript worker matrix; the JavaScript aggregate can report alongside them.

Compare cold and warm runs before choosing larger runners or shorter timeouts.
Record elapsed time, billed cost, peak memory, and disk use for each gate.
The first Linux cloud run remains a launch check; local verification cannot establish its runtime or cost.

Run the first benchmark on `main`, then repeat it to measure cache reuse.
PRs can restore caches from their base branch and the default branch.
Caches created by a PR cannot warm unrelated PRs.
Confirm that a warm PR run restores the `main` cache before budgeting for reuse.
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
PR checks continue on GitHub-hosted runners after Blacksmith is off.

At $0.008 per minute, 950 PRs averaging ten combined 4-vCPU runner-minutes each cost $76 before credits and overhead.
Count all gate jobs across every run on each PR, including cancelled runs.
The 2-vCPU selection and verdict jobs add cost beyond those test-job minutes.
Use ten minutes per PR as a planning target, not a measured runtime or permission to remove required tests.
The free allowance is shared across the organization; check its remaining balance before including it in the budget.
An 8-vCPU runner costs twice as much per minute. Choose it only after comparing cost per passing run.

## Sandbox suites run on GitHub's image

Blacksmith's kernel has no Landlock, which the app compiler and the relay's replicas apply.
The `compiler confinement` and `relay confinement` jobs always use GitHub's `ubuntu-24.04` image with Landlock whenever either gate runs.
Their engine and compiler test binaries come from shared preparation's selected pool, including Blacksmith when enabled.
Both download and check the prepared artifacts. Both install Rust because the engine fingerprint reads the compiler version.
They run compiler and replica proofs on separate runners; only the compiler job needs nextest.
Both confinement jobs overlap setup with preparation, then wait for their published artifacts under a 15-minute cap.
Workers do not wait for confinement. Aggregates and final verification require both jobs and include their finishes in both gates' wall spans.
If confinement fails, select **Re-run all jobs**. **Re-run failed jobs** does not create preparation artifacts for the new attempt.
The relay job runs the replica suites in a container under Docker's default seccomp profile and the self-host compose's security options, as production runs the relay.
Both jobs fail if any required test skips.
The other jobs leave these suites out with `DOHC_CONFINEMENT_SUITES=exclude` and the `without-confinement` nextest profile.
The local gate runs no Linux JavaScript, so the replica suites run only in the relay confinement job.

The Bash profile fixtures use `--noprofile` and explicitly load their temporary profile. This isolates their assertions from the runner's system profile. They do not test automatic login-profile loading.

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
Drafts and other same-repository PRs without cloud checks need recorded local evidence before merging.
Never check out, install, build, or test fork PR code on the shared Windows host, the shared Mac, or any machine with Ice's credentials. Ask Ice how to verify it.
A skipped check provides no verification evidence.
Manual runs report `Manual verification`, so a partial benchmark cannot satisfy the required PR check.
Retain evidence for every gate selected by the PR.

Download the `verification-js-*` and `verification-rust-*` artifacts for receipts, logs, and step durations.
Artifacts expire after seven days. The workflow excludes browser traces, test workspaces, and profiles.
Record the run URL and verification scope in the PR before artifacts expire.

## Turn it off

Set `BLACKSMITH_ENABLED` to `false` with the command above.
Cancel any queued or running Blacksmith workflows in GitHub Actions.
Changing the variable alone does not cancel runners already allocated.
New PR checks and default manual dispatch use GitHub-hosted `ubuntu-24.04` runners.
An explicit `runner_provider=blacksmith` manual dispatch still opts into Blacksmith, so leave that input at `github`.
