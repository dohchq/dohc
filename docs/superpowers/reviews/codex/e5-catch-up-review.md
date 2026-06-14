# E5 Catch-Up Codex Review

Date: 2026-06-14

Scope: uncommitted E5 catch-up/history slice on
`codex/desktop-experience-parity`, including the small editor preload/perf
support needed to keep the desktop budgets green.

Command:

```sh
CODEX_HOME=/tmp/codex-e5-graph-review codex review --uncommitted
codex review --uncommitted 2>&1 | tee /tmp/e5-catch-up-review-final9.raw
```

Temporary review traces were written under `/tmp/e5-catch-up-review-final*.raw`.
They are not committed because they include noisy CLI transcripts; this file
records the actionable review ledger. The default-CODEX_HOME final9 run is the
authoritative clean closeout; final8 failed before inspecting the diff because
its temporary sandbox launcher did not initialize.

## Findings Fixed

- P2: catch-up did not refresh when a same-timestamp or clock-skewed history
  record arrived below the current top row. The refresh key now includes every
  visible change-set id and timestamp, with a renderer regression test.
- P2: timestamp-only catch-up persistence could skip later appended records
  whose clocks moved backward. History now exposes a durable append index and
  the UI persists id + append index alongside the compatibility timestamp.
- P2: long catch-up summaries could be truncated while still advancing the
  cursor past unrepresented work. The summary now keeps 49 concrete lines and a
  final omitted-count line inside the 50-line IPC cap.
- P1: the editor placeholder/performance follow-up briefly depended on the
  full markdown `value`, which could recreate Tiptap from an autosave snapshot
  and lose in-flight WYSIWYG edits. Placeholder inclusion is now mount-stable
  and independent of autosave value updates.

## Closeout

Final review trace: `/tmp/e5-catch-up-review-final9.raw`.

Note: the final reviewer also tried an ad hoc package test under the system
Node 18, which failed at Vitest startup because this repo requires newer Node.
The verified gates for this slice ran under Node 25 separately.

Final result:

> I did not identify any discrete regressions in the staged, unstaged, or
> untracked changes. The catch-up summary IPC, persistence, history indexing,
> and renderer wiring appear consistent with existing patterns.
