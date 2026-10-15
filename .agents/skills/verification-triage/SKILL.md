---
name: verification-triage
description: Triage dohc's nightly verification run, run one by hand, or fix the week's flaky and slow tests. Use when a scheduled task or Ice asks for nightly triage or the weekly test cleanup.
---

# Triage verification runs

The verification queue service runs every PR gate on this host. Its root is `C:\w\_verification`.
Every night at 03:07, the `dohc-verification-nightly` scheduled task submits a full run of main's head.
Read [the verification procedure](../../../docs/engineering/verify-agent-work.md) for the queue, flaky tests, the nightly run, and test times.

Both procedures follow these rules:

- Follow `AGENTS.md`. Keep one concern per PR.
- Create worktrees with `~/dev/garage/tools/worktree.mjs`. Remove your worktrees and processes when you finish.
- Verify each PR with `pnpm verify:pr --base origin/main` through the queue.
- Do not cancel, kill, or edit another request under `C:\w\_verification` or `C:\w\_locks`.
- Do not stop another agent's run.

## Run a nightly by hand

Run `pnpm verify:queue nightly` from a checkout of origin/main.
It verifies main's head against the last nightly that passed. The queue runs it before every PR request.
If the `dohc-verification-nightly` task is missing, run `pnpm verify:queue install`. It registers the task again.

## Triage the nightly run

1. Find the newest nightly request. It is the newest folder under `C:\w\_verification\requests` whose `request.json` has `"nightly": true`.
2. Read its `status.json`. Its `result` field names the last attempt's `result.json`.
   `pnpm verify:queue status` also shows the line and the last passing nightly.
3. If no nightly exists, or its state is `queued` or `running`, report that in one line and stop. Do not submit another.
4. If its state is `error`, the host failed it after retries. Report the `reason` from `status.json` and stop. Do not change code.
5. If its state is `passed`, report its commit, run time, `flaky` list, and `slowest` list.
   Name a flaky test as recurring when it is also flaky in another finished run in the last 7 days of `C:\w\_verification\history.jsonl`. Stop.
6. If its state is `failed`, find the merge that broke main:
   1. List the failing tests from `result.json` and the failing step's log.
   2. Run only those tests at `head` from `request.json` to confirm the failure.
   3. Run `git bisect run` over `base..head` with those tests alone. Do not run the full gate to bisect.
7. Open one PR on its own branch. Revert the culprit with `git revert <sha>`, or make a small, obvious fix.
   Main uses squash merges, so the culprit is one commit. In the PR body, explain the failure and link the culprit PR.
8. Verify the PR. A pure revert is routine. A fix needs the independent review that `AGENTS.md` requires. Merge the PR when it passes.
9. Comment on the culprit PR. Say what failed and link your PR.
10. Submit a fresh nightly with `pnpm verify:queue nightly`.
11. Report the nightly's commit and verdict, your PR links, and anything that needs a human.

## Fix the week's flaky and slow tests

The queue appends one line with `"event": "finished"` to `C:\w\_verification\history.jsonl` for each run. Each line has these fields:

- `flaky`: the tests that passed only on retry.
- `slowest`: the run's ten slowest tests, with seconds.
- `steps`: each step's seconds.
- `load`: the lanes, peak concurrent runs, lowest free memory, and mean CPU.
- `outcome`: the run's result.

1. Read the finished events from the last 7 days. Build three tables:
   - flaky tests by count;
   - slow tests by total seconds, which is the count times the median seconds;
   - steps by median seconds, compared with the week before when that data exists.
2. Pick at most three problems, most costly first. A problem is one of these:
   - a test that was flaky in two or more runs;
   - a test or suite whose time dominates its step;
   - a step whose median grew by more than about 10%.
3. For each problem, find the root cause. Open one PR that fixes it without weakening what the test proves.
   Remove the race and wait for the actual condition. Do not add a sleep or raise a timeout.
   Split a scenario that does several jobs, or cut repeated setup.
4. Measure the test before and after the fix on this host.
5. Verify each PR, get the independent review that `AGENTS.md` requires, and merge the PR when it passes.
6. Report the top five rows of each table, the merged PRs with the measured time saved, and any problem that needs a human decision.
   A per-PR gate should take 15 minutes or less on an idle lane. Report how far the median gate is from that.
   If nothing is worth changing, report the tables and stop.
