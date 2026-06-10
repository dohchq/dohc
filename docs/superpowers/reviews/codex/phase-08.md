# Codex + verifier review — phase8 (commit 46e50c9)

Codex `exec review --commit 46e50c9` (gpt-5.5, xhigh) found five P2s — all
confirmed real, all fixed in `phase8(fix)`. The combined verifier workflow
(phase8 lenses + retro phases-0-7 audit) findings are appended below.

## Codex findings (all fixed)

- **[P2] Import silently replaced an existing database.** `writeWorkspaceBytes`
  ended in `rename`, which clobbers: re-importing `wallet.csv` after the user
  edited `wallet.sqlite` dropped those edits. **Fix:** materialize via
  `link(temp, target)` (EEXIST-safe) — import never overwrites a canonical
  file; the CSV view surfaces "Database already exists". Unit test pins the
  edit surviving a re-import attempt.

- **[P2] mkdir before the containment check.** A workspace-internal symlinked
  ancestor could make `mkdir -p` create directories outside the root before
  realpath containment ran. **Fix:** check the deepest EXISTING ancestor
  (shared `existingAncestor`, now exported from workspaceFiles) before mkdir —
  mirrors `createFile` exactly.

- **[P2] Non-unique row key could update several rows.** The studio guessed
  `id`/first-column as the edit key; `WHERE id = ?` on a duplicated column
  edits every matching row. **Fix:** snapshots carry SQLite `rowid` per row
  (`__dohc_rowid`, plain-SELECT fallback for WITHOUT ROWID tables); edits key
  on rowid, else a single-column declared pk, else editing is disabled. Unit
  test: duplicated `id` column, exactly one row changes.

- **[P2] Stale snapshot could cross-target a different database.** Switching
  to an unreadable/slow db left the previous rows rendered (and editable)
  under the new header. **Fix:** path switches blank the view + editing state
  immediately; failed loads clear the snapshot; in-flight reads and edit
  responses are dropped if the user switched databases meanwhile.

- **[P2] Op-log slug collisions.** `a/b.sqlite` and `a_b.sqlite` both slugged
  to `a_b.sqlite`, interleaving unrelated op logs. **Fix:**
  `databaseOpLogPath` appends a pure FNV-1a path tag (workspace-core stays
  renderer-safe — no node:crypto); collision test added.

## Combined workflow: phase8 verify + retro phases 0-7 audit (wf wcwhi4ai8)

48 agents (12 finders + adversarial verification): **35 confirmed** (1 HIGH,
30 MED, 4 LOW), 2 rejected, 55 LOW/INFO unverified. 8 of the 35 duplicated the
Codex P2s above. All remaining confirmed findings fixed in `phase8(fix)`:

- **HIGH — attach could permanently brick the app**: `registerWorkspace` ran
  BEFORE `WorkspaceSummary.parse`, so a foreign manifest with an oversized id
  was persisted and every later registry read threw → blank window forever.
  Fixed: parse-then-register in both handlers; `WORKSPACE_ID` now requires
  hostname-safe lowercase (it doubles as the dohc-file:// URL hostname, fixing
  the case-aliasing/404 findings too); `DesktopRoot` renders a recovery screen
  instead of swallowing registry failures.
- **Watcher/sync pipeline**: settle-window starvation fixed with a
  non-resetting `maxWindowMs` deadline (live-tested); quit now `preventDefault`s
  and awaits the drained record chain (batches recorded strictly in order,
  failures logged with context instead of unhandled rejections); chokidar
  `ready` is awaited by `openWorkspace` so post-open writes are guaranteed
  observed; stat errors no longer fabricate deletes (ENOENT/ENOTDIR only);
  `.sqlite3` sidecar regex divergence killed by single-sourcing
  `isDatabaseFile`/`sidecarBasePath` from workspace-core; watcher ignore-set
  unified with the file tree via shared `hasIgnoredSegment` (.dohc/.git/
  node_modules at any depth); dead `SettleBatcher` deleted from workspace-sync.
- **Hostile-input bounds**: database snapshots cap tables (200) and cells (4KB,
  blobs become placeholders); dohc-file asset serving caps at 64MB and serves a
  zero-copy view with `nosniff`; op-log version race fixed by per-database edit
  serialization.
- **appPackage TOCTOU**: fingerprint now computed from the exact bytes fed to
  the static check (single read, length-prefix-framed injective encoding);
  state writes serialized; AppPackageView renders a "Not an app package yet"
  card instead of an eternal Loading for stray .apps paths.
- **paths hardening**: Windows trailing dot/space aliases of `.dohc`/`..`
  rejected; `changeSetStore.list()` skips one corrupt record instead of
  bricking the timeline.
- **Test quality**: fileTypes E2E now seeds a REAL SQLite db and asserts the
  studio's table+cells (the old fixture exercised only the error state);
  firstRun proves a full settle cycle before asserting no `.dohc` leak; smoke
  fails on early exit/abnormal codes and scans stdout with --enable-logging;
  baseline gate now runs the pivot's own suites; studio post-load errors render.
- **Design LOWs applied**: schema-chip emphasis, editable-cell hover, numeric
  right-align + tabular-nums, single text color per cell, last-row border.

Rejected (adversarially, real=false): multi-row fallback edit (already fixed in
the Codex round), import rename-clobber (same).

## Known-LOW backlog (recorded, deliberately not fixed now)

percent-encoded legit filenames mangled by validateUserWritePath (needs design;
affects reads too); CSV view naive comma split (quoted fields misalign —
display-only); useTextContent one-frame stale paint is fixed but UTF-8
truncation can split a code point at the 2MB cut; globToRegExp space/?
literalness (write ceilings unconsumed until 7b); history growth/index rewrite
(Phase 16 perf); palette/overlay focus traps (Phase 17 polish); registry tmp
accumulation; D-20 wording: window.open→shell.openExternal lacks a user-gesture
gate — currently unreachable by user content; Phase 9 will deny window.open
entirely in favor of an explicit openExternalUrl IPC.
