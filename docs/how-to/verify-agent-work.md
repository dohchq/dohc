# Verify desktop work

Use this procedure when changing dohc through an agent or an isolated worktree.

## Prepare the checkout

Create a worktree from the intended base. Keep dependencies, build outputs, and application profiles inside that worktree.
On Windows, install PowerShell 7 and put `pwsh.exe` on `PATH` before running setup.
Verification uses it to own command descendants and stop them after interruption or timeout, even when their launcher exits first.
Run `pnpm setup:worktree`. This installs the pinned dependencies and checks the local tools.
Codex runs the same setup through `.codex/environments/environment.toml` when creating a worktree.

For local Rust PR verification, install these host tools at the versions pinned in `.github/workflows/pr-checks.yml`.
CI installs these tools itself. Local focused work does not require a duplicate full gate.
Setup and doctor check Rust and Cargo, but do not install or check these additional tools.
Use the [Rust build budget](../../.agents/skills/rust-gate/SKILL.md#cargo-outside-the-gate) for these installations.

```sh
cargo install cargo-deny --locked --version 0.20.2
cargo install cargo-audit --locked --version 0.22.2
cargo install cargo-nextest --locked --version 0.9.143
```

The PR verifier rejects missing tools or versions that differ from those workflow pins.

Run `pnpm doctor` to inspect readiness without changing the checkout.
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

CI owns the full suite. One verification owner links the run and records the selected gates in the PR.
Run focused checks locally. Use the [review policy](../../AGENTS.md#select-reviewers) to select independent reviewers and handle later fixes.
Before merging, confirm every applicable job passed for the final head and its tested integration with the target branch.
For platform-specific changes, add focused checks on that platform.

If CI is unavailable, use the local fallback below. Preserve all applicable checks and record why CI could not run.

Fetch the PR's target branch. Use its fetched ref as `<target-ref>` below, such as `origin/main`.
Run `pnpm verify:plan --base <target-ref>` to see the applicable workflow gates.
Commit the changes. Run `pnpm verify:pr --base <target-ref>` against that clean commit.
The runner rejects changes to the source or commit during verification.
The JavaScript gate uses a dedicated Postgres container and requires the normally optional integration suites.
The Rust gate uses the repository build budget and checks its summary verdict.
The runner removes its Postgres container by the recorded container ID.

To schedule jobs separately, use `pnpm verify:pr --base <target-ref> --job js` and `--job rust`.
Each report states its scope. Both selected jobs must pass on the same commit before claiming a complete PR gate.
An explicit `--job` runs that job even when the filters omit it.
Use it when a build or test step reads a changed file outside the filters.

Read `result.json` before reporting a pass. Include the commit, gates, and evidence directory in the PR.
After review fixes, let CI verify the new commit or rerun the applicable local fallback.
Evidence from another commit does not prove the new commit.
Use CI job timings or the local report's `steps[].seconds` when recording verification delays.

## Measure performance

Use `node tools/perf-profiling/run-profiles.mjs --output <directory> --seed <uint32>` in each checkout.
Use the same machine, fixture seed, scenario settings, and build mode for the base and candidate.
The profiling report records bundle and engine hashes. Keep both reports with the comparison.
Use `--tiny` to check the harness; use the full fixture for performance claims.

## Finish the task

Stop every process started by the task. Keep its evidence until review finishes.
Remove only worktrees owned by the task, after accounting for their commits and checking for uncommitted work.
Do not infer ownership from a worktree's name or age.
