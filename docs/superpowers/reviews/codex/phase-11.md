# Phase 11 review — local agent + MCP (codex gpt-5.5 xhigh)

Review: codex `bzy0amtn8` on commit a4f5703 → `/tmp/codex-phase11.log`. Security
checkpoint for the local MCP stdio server (filesystem-affecting tools exposed to
an external AI agent). Confirmed no mutation bypass in `query_database` (regex +
read-only open held against CTE/PRAGMA/ATTACH/multi-statement) and no over-trust
(`create_app` → trusted:false, `share` → needs-confirmation). Findings below
closed by `phase11(fix)`.

## Findings → fixes

- **[P1] Lexical-only containment (symlink escape).** `safeResolve`
  (tools.ts) validated the string then `join(root, normalized)` with no realpath
  check, so an in-tree symlink pointing outside the workspace would be followed
  by every later fs call — the #1 property (path containment) was incomplete.
  **Fix:** `safeResolve` is now async and centralizes BOTH guards — lexical
  validation then `isWithinRealRoot`, which realpaths the deepest existing
  ancestor (the file for reads, the parent chain for not-yet-created targets)
  and requires it under `realpath(root)`. Fails closed. New test creates a real
  in-tree symlink to an outside dir and asserts every tool refuses it.

- **[P2] Nested `.dohc` allowed.** `isReservedPath` (workspace-core paths.ts)
  only checked the FIRST segment, so `notes/.dohc/x` passed and let tools
  read/write hidden internal areas the watcher/tree suppress everywhere.
  **Fix:** `isReservedPath` rejects a `.dohc` segment at ANY depth (matching
  `hasIgnoredSegment`); applies to the desktop write path too. New tests in
  paths.test.ts + tools.test.ts.

- **[P2] `query_database` no visible-db check + unbounded work.** Unlike
  `import_data` it never checked `databaseSyncStrategy === "operation-log"`, so a
  sidecar/non-db path could be opened; and `rows.slice(0,1000)` ran AFTER
  `.all()`, so a huge join / `randomblob` materialized fully first.
  **Fix:** require a visible-database target, and wrap the SELECT as
  `select * from (<sql>) limit 1000` so SQLite stops at the cap instead of
  materializing everything. New test (refuses a non-db path; a 1600-row
  self-join is capped to 1000).

- **[P2] Overlapping runs corrupt attribution.** `endAgentRun` cleared the
  workspace slot + child UNCONDITIONALLY, so start A → start B → end A silently
  unhooked B (B's later writes recorded as the local user).
  **Fix:** only clear when `s.activeRun?.id === runId`. New AgentIntegration
  test (end the older run; the newer keeps the slot).

- **[P2] `test_app` no source size bound.** 200 paths concatenated + transpiled
  could burn memory/CPU. **Fix:** cap total source at 2MB before the static
  check.

- **[P3] `agent-runs.json` temp not unique.** Fixed `pid` temp name could be
  re-used after a crash. **Fix:** add a `randomUUID` suffix to the temp name
  (writes are already serialized per workspace; rename stays atomic).

## Known limitation (accepted)

Agent-run attribution is batch-settle-timed (500ms): a local edit within ~500ms
before `startAgentRun`, or an agent write within ~500ms before `endAgentRun`,
can land in the wrong batch. This is a soft attribution boundary, not data loss
or a containment hole; tightening it (per-file run windows) is deferred.

## Gates

mcp 17 (+3) · workspace-core 89 · desktop unit 116 (+1) · mcp/desktop typecheck
clean · localAgent E2E 2/2 (settings toggle + real stdio server, incl. traversal
refusal).
