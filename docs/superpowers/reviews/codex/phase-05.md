# Phase 5 review — watcher, batched sync, local-first history (codex gpt-5.5 xhigh)

Reviews: codex session `019eb152-fbae` on commit eb6c0c3 (phase5: file
watcher, batched sync, and local-first history); the fix re-review is
`phase-05-fix.md`. All findings closed by `phase5(fix)` d87f2f1 and
`phase5(fix2)` 4142e6f. (This file is the distilled dossier of the raw
transcript — Phase 17 cleanup; the transcript lives in git history.)

Verdict on eb6c0c3: the patch could miss SQLite-backed workspace changes,
watch outside workspace boundaries through symlinks, and lose history entries
during concurrent records or shutdown.

## Findings → fixes

- **[P1] SQLite sidecars dropped before collapse → missed DB changes.** In WAL
  mode a commit can touch only `wallet.db-wal`/`-shm`, never the base file.
  The watcher's ignore predicate (and the desktop defense-in-depth filter)
  discarded sidecar paths before `collapseSqliteSidecars` could convert them
  into a base-DB update — the history/sync pipeline silently missed those
  database changes. **Fix:** sidecars stay in the event stream and are
  collapsed (to a base-path update) before recording; the sidecar path itself
  never surfaces (`packages/workspace-fs/src/watchEvents.ts`).

- **[P2] Watcher followed symlinks out of the workspace.** chokidar's default
  `followSymlinks: true` subscribed to external targets that `listFiles`
  deliberately skips, so out-of-workspace changes could be hashed and recorded
  as workspace history. **Fix:** symlinks are not followed; watch scope
  matches scan scope.

- **[P2] Concurrent `record()` lost change sets.** Two settled batches could
  both read `index.json`, append, and last-write-wins — orphaning a record
  file that `list()`/`get()` would never show (the live watcher records from
  fire-and-forget callbacks). **Fix:** history index updates are serialized
  (`packages/workspace-history/src/changeSetStore.ts`). The adversarial
  verifier independently found the same race.

- **[P2] Pending batch dropped on stop.** Stopping a watcher (desktop calls
  `stopAll()` from `will-quit`) inside the settle window cleared the timer
  without emitting pending paths — the most recent edit never reached history.
  **Fix:** stop flushes the pending batch before closing.

## Fix re-review (phase-05-fix.md) → fix

- **[P2] Sidecar collapse downgraded real DB deletes.** Deleting a WAL-mode DB
  unlinks base + sidecars in one batch; the collapse forced the base entry
  back to `update`, so history recorded a write instead of the delete.
  **Fix (4142e6f):** the base file's OWN delete event always survives the
  collapse; sidecar churn alone never implies deletion (pinned in
  `watchEvents` tests).

## Deferred (recorded in the execution log, with owners)

- Rename surfaces as delete+create (rename identity needs the sync engine's
  prior-content index) → Phase 9. Content-lossless today.
- Live watcher hardcodes `author=local-user` — agent attribution lands with
  MCP (Phase 11), import provenance with Phase 8; contract/store already
  support all kinds.

## Gates after fixes

All 5 package suites + desktop E2E + smoke green (see execution log Phase 5).
