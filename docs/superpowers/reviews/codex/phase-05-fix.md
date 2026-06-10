OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019eb15b-7176-73a0-ba92-1044d99d7c62
--------
user
commit d87f2f1
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git status --short && git rev-parse --show-toplevel && git rev-parse d87f2f1''^ && git rev-parse d87f2f1' in /home/ice/dev/dohc
 succeeded in 0ms:
?? docs/superpowers/reviews/codex/phase-05-fix.md
/home/ice/dev/dohc
69366d6795874566a94dccb43eb660e49b8fac6e
d87f2f11c2e4c00761437a5c419817ffe5e4477d

exec
/bin/bash -lc 'git diff --stat d87f2f1''^ d87f2f1 && git diff --name-status d87f2f1''^ d87f2f1' in /home/ice/dev/dohc
 succeeded in 0ms:
 apps/desktop/src/workspaces/workspaceWatcher.ts    |   11 +-
 ...desktop-local-first-cloud-sync.execution-log.md |   28 +-
 docs/superpowers/reviews/codex/phase-05.md         | 3611 ++++++++++++++++++++
 packages/workspace-fs/src/watchEvents.test.ts      |   26 +-
 packages/workspace-fs/src/watchEvents.ts           |   18 +-
 .../workspace-history/src/changeSetStore.test.ts   |   14 +
 packages/workspace-history/src/changeSetStore.ts   |   93 +-
 7 files changed, 3742 insertions(+), 59 deletions(-)
M	apps/desktop/src/workspaces/workspaceWatcher.ts
M	docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
A	docs/superpowers/reviews/codex/phase-05.md
M	packages/workspace-fs/src/watchEvents.test.ts
M	packages/workspace-fs/src/watchEvents.ts
M	packages/workspace-history/src/changeSetStore.test.ts
M	packages/workspace-history/src/changeSetStore.ts

exec
/bin/bash -lc 'find .. -name AGENTS.md -print' in /home/ice/dev/dohc
 succeeded in 6359ms:
../vibeam-pr-0.4/AGENTS.md
../vibeam-pr-0.4/agents/founding-engineer/AGENTS.md
../vibeam-pr-0.4/agents/ceo/AGENTS.md
../vibeam-pr-0.4/agents/cmo/AGENTS.md
../vibeam-pr-0.4/agents/cos/AGENTS.md
../extra/vibeam-mono/vibeam-app/AGENTS.md
../extra/vibeam-mono/AGENTS.md
../extra/vibeam-mono/vibe-gui/AGENTS.md
../extra/vibeam-mono/agents/founding-engineer/AGENTS.md
../extra/vibeam-mono/agents/ceo/AGENTS.md
../extra/vibeam-mono/agents/cmo/AGENTS.md
../extra/vibeam-mono/agents/cos/AGENTS.md
../dohc/AGENTS.md
../dohc/apps/app/AGENTS.md
../vibeam-pr-0.3/AGENTS.md
../vibeam-pr-0.3/agents/founding-engineer/AGENTS.md
../vibeam-pr-0.3/agents/ceo/AGENTS.md
../vibeam-pr-0.3/agents/cmo/AGENTS.md
../vibeam-pr-0.3/agents/cos/AGENTS.md
../projects/opflow/node_modules/ts-loader/AGENTS.md
../projects/opflow/node_modules/recharts/AGENTS.md
../projects/opflow/packages/frontend/node_modules/ts-loader/AGENTS.md
../projects/opflow/packages/frontend/node_modules/recharts/AGENTS.md
../projects/bundae/apps/web/AGENTS.md
../projects/remote-ai-tool/vibeam/AGENTS.md
../projects/remote-ai-tool/agentic-clis/AGENTS.md
../vibeam-pr-0.2/AGENTS.md
../vibeam-pr-0.2/agents/founding-engineer/AGENTS.md
../vibeam-pr-0.2/agents/ceo/AGENTS.md
../vibeam-pr-0.2/agents/cmo/AGENTS.md
../vibeam-pr-0.2/agents/cos/AGENTS.md
../work/vacuumlabs/swell/swhype/contracts/lib/devtools/AGENTS.md
../work/vacuumlabs/swell/swhype/contracts/lib/devtools/packages/AGENTS.md
../work/vacuumlabs/swell/swhype/contracts/lib/devtools/tests/AGENTS.md
../work/vacuumlabs/swell/swhype/contracts/lib/devtools/examples/AGENTS.md
../work/vacuumlabs/opnet/opnft-fun/AGENTS.md
../work/vacuumlabs/opnet/opnft-fun/node_modules/recharts/AGENTS.md
../work/vacuumlabs/opnet/opnft-fun/packages/db/AGENTS.md
../work/vacuumlabs/opnet/opnft-fun/frontend/AGENTS.md
../work/vacuumlabs/opnet/motoswap-ui/node_modules/recharts/AGENTS.md
../work/vacuumlabs/opnet/momoto-bug-repro/node_modules/ts-loader/AGENTS.md
../vibeam-pr-0.5/AGENTS.md
../vibeam-pr-0.5/agents/founding-engineer/AGENTS.md
../vibeam-pr-0.5/agents/ceo/AGENTS.md
../vibeam-pr-0.5/agents/cmo/AGENTS.md
../vibeam-pr-0.5/agents/cos/AGENTS.md
../vibeam/vibeam-app/AGENTS.md
../vibeam/AGENTS.md
../vibeam/agents/founding-engineer/AGENTS.md
../vibeam/agents/ceo/AGENTS.md
../vibeam/agents/cmo/AGENTS.md
../vibeam/agents/cos/AGENTS.md
../oss-repos/codex/AGENTS.md
../oss-repos/t3code/AGENTS.md
../oss-repos/t3code/.repos/alchemy-effect/AGENTS.md
../oss-repos/t3code/.repos/alchemy-effect/packages/alchemy/src/AWS/AGENTS.md
../oss-repos/t3code/.repos/effect-smol/AGENTS.md
../vibeam-pr-0.9/AGENTS.md
../vibeam-pr-0.9/agents/founding-engineer/AGENTS.md
../vibeam-pr-0.9/agents/ceo/AGENTS.md
../vibeam-pr-0.9/agents/cmo/AGENTS.md
../vibeam-pr-0.9/agents/cos/AGENTS.md

exec
/bin/bash -lc 'git diff --find-renames --find-copies --submodule=diff d87f2f1''^ d87f2f1 -- apps/desktop/src/workspaces/workspaceWatcher.ts packages/workspace-fs/src/watchEvents.ts packages/workspace-fs/src/watchEvents.test.ts packages/workspace-history/src/changeSetStore.ts packages/workspace-history/src/changeSetStore.test.ts' in /home/ice/dev/dohc
 succeeded in 0ms:
diff --git a/apps/desktop/src/workspaces/workspaceWatcher.ts b/apps/desktop/src/workspaces/workspaceWatcher.ts
index 3df14c6..75bcd0b 100644
--- a/apps/desktop/src/workspaces/workspaceWatcher.ts
+++ b/apps/desktop/src/workspaces/workspaceWatcher.ts
@@ -3,7 +3,11 @@ import type {
   WatcherEvent,
   WatcherEventBatch,
 } from "@dohc/workspace-core";
-import { shouldIgnoreWatchPath, watchWorkspaceEvents } from "@dohc/workspace-fs";
+import {
+  collapseSqliteSidecars,
+  shouldIgnoreWatchPath,
+  watchWorkspaceEvents,
+} from "@dohc/workspace-fs";
 import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
 import { batchToChangeSet } from "@dohc/workspace-sync";
 import { createHash, randomUUID } from "node:crypto";
@@ -75,7 +79,10 @@ export function startWorkspaceWatch(
         // watcher. The watcher already ignores these; this guards a leak.
         const userPaths = paths.filter((p) => !shouldIgnoreWatchPath(p));
         if (userPaths.length === 0) return;
-        const events = await pathsToEvents(workspace.rootPath, userPaths);
+        const rawEvents = await pathsToEvents(workspace.rootPath, userPaths);
+        // Fold SQLite WAL/journal/shm churn into a single base-db update so the
+        // history shows "wallet.sqlite changed", never the transient sidecars.
+        const events = collapseSqliteSidecars(rawEvents);
         if (events.length === 0) return;
         const batch: WatcherEventBatch = {
           settledAtMs: now(),
diff --git a/packages/workspace-fs/src/watchEvents.test.ts b/packages/workspace-fs/src/watchEvents.test.ts
index 98cd7b8..cb82e81 100644
--- a/packages/workspace-fs/src/watchEvents.test.ts
+++ b/packages/workspace-fs/src/watchEvents.test.ts
@@ -37,13 +37,25 @@ describe("shouldIgnoreWatchPath", () => {
     expect(shouldIgnoreWatchPath("notes/.DS_Store")).toBe(true);
   });
 
-  it("ignores SQLite sidecar journals and shared-memory files", () => {
-    expect(shouldIgnoreWatchPath("finance/wallet.db-wal")).toBe(true);
-    expect(shouldIgnoreWatchPath("finance/wallet.db-journal")).toBe(true);
-    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-wal")).toBe(true);
-    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-journal")).toBe(true);
-    expect(shouldIgnoreWatchPath("finance/wallet.db-shm")).toBe(true);
-    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-shm")).toBe(true);
+  it("does NOT ignore SQLite sidecars — they signal a db change and are collapsed", () => {
+    // A SQLite write often touches only the WAL; ignoring sidecars would make
+    // the change invisible. They pass through here and collapseSqliteSidecars
+    // folds them into one base-db update (so the sidecar path never surfaces).
+    expect(shouldIgnoreWatchPath("finance/wallet.db-wal")).toBe(false);
+    expect(shouldIgnoreWatchPath("finance/wallet.db-journal")).toBe(false);
+    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-wal")).toBe(false);
+    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-journal")).toBe(false);
+    expect(shouldIgnoreWatchPath("finance/wallet.db-shm")).toBe(false);
+    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-shm")).toBe(false);
+  });
+
+  it("collapses a WAL-only change into a base-db update (db never missed)", () => {
+    // The base .db file is untouched until checkpoint; only the WAL changed.
+    expect(
+      collapseSqliteSidecars([
+        { path: "finance/wallet.sqlite-wal", operation: "update" },
+      ]),
+    ).toEqual([{ path: "finance/wallet.sqlite", operation: "update" }]);
   });
 
   it("keeps normal user files watchable", () => {
diff --git a/packages/workspace-fs/src/watchEvents.ts b/packages/workspace-fs/src/watchEvents.ts
index 7f2afbd..3d5372c 100644
--- a/packages/workspace-fs/src/watchEvents.ts
+++ b/packages/workspace-fs/src/watchEvents.ts
@@ -39,9 +39,13 @@ const EDITOR_NOISE = [
 ];
 
 // TRUE when the watcher should drop this relative path before it ever becomes
-// a user file op. Covers the reserved .dohc/ tree (including its cache),
-// editor scratch files, and SQLite sidecars — see the regexes above for why
-// each is anchored to avoid false positives on real user files.
+// a user file op. Covers the reserved .dohc/ tree (including its cache) and
+// editor scratch files. NOTE: SQLite sidecars (.db-wal/-journal/-shm) are NOT
+// ignored here — a SQLite write often touches only the WAL while the base .db
+// is untouched until checkpoint, so ignoring sidecars would make the change
+// INVISIBLE. Instead the pipeline lets sidecar events through and folds them
+// into one base-db update via collapseSqliteSidecars, so the sidecar path
+// never surfaces but the database change is never missed.
 export function shouldIgnoreWatchPath(relativePath: string): boolean {
   const path = toPosix(relativePath);
   const lower = path.toLowerCase();
@@ -54,8 +58,6 @@ export function shouldIgnoreWatchPath(relativePath: string): boolean {
   const basename = path.slice(path.lastIndexOf("/") + 1);
   if (EDITOR_NOISE.some((pattern) => pattern.test(basename))) return true;
 
-  if (SQLITE_SIDECAR.test(path)) return true;
-
   return false;
 }
 
@@ -142,6 +144,9 @@ export function watchWorkspaceEvents(
     // We diff the filesystem ourselves on change; an initial flood of "add"
     // events for every existing file would be pure noise.
     ignoreInitial: true,
+    // Never follow symlinks out of the workspace — a symlinked dir would let
+    // the watcher observe (and record) files outside the workspace root.
+    followSymlinks: false,
     ignored: (path: string) => {
       const rel = isAbsolute(path) ? relative(rootDir, path) : path;
       if (rel === "" || rel === ".") return false;
@@ -182,6 +187,9 @@ export function watchWorkspaceEvents(
     if (stopped) return;
     stopped = true;
     if (timer !== undefined) clearTimeout(timer);
+    // Flush any settled-but-not-yet-emitted changes so a save right before
+    // stop/quit is recorded into history rather than silently dropped.
+    flush();
     signal?.removeEventListener("abort", stop);
     void watcher.close();
   };
diff --git a/packages/workspace-history/src/changeSetStore.test.ts b/packages/workspace-history/src/changeSetStore.test.ts
index 2e0df7b..d5b01cd 100644
--- a/packages/workspace-history/src/changeSetStore.test.ts
+++ b/packages/workspace-history/src/changeSetStore.test.ts
@@ -189,4 +189,18 @@ describe("humanSummary", () => {
     expect(humanSummary(userRec)).not.toMatch(/<{7}|>{7}|={7}/);
     expect(humanSummary(agentRec)).not.toMatch(/<{7}|>{7}|={7}/);
   });
+
+  it("does not drop entries when records are fired concurrently", async () => {
+    // The live watcher fires record() fire-and-forget; without serialization
+    // two close-together records race on index.json and the second clobbers
+    // the first's entry, silently dropping it from the timeline.
+    const store = createChangeSetStore(root);
+    const writes = Array.from({ length: 25 }, (_, i) =>
+      store.record(userEdit(), { id: `c${i}`, recordedAtMs: 1000 + i }),
+    );
+    await Promise.all(writes);
+    const listed = await store.list();
+    expect(listed).toHaveLength(25);
+    expect(new Set(listed.map((r) => r.id)).size).toBe(25);
+  });
 });
diff --git a/packages/workspace-history/src/changeSetStore.ts b/packages/workspace-history/src/changeSetStore.ts
index 25a28a0..d41dcec 100644
--- a/packages/workspace-history/src/changeSetStore.ts
+++ b/packages/workspace-history/src/changeSetStore.ts
@@ -1,4 +1,4 @@
-import { mkdir, readFile, writeFile } from "node:fs/promises";
+import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
 import { join } from "node:path";
 import type {
   BoundaryCrossing,
@@ -58,6 +58,15 @@ async function readJson<T>(path: string): Promise<T | null> {
   }
 }
 
+// Atomic write: serialize to a temp file then rename over the target so a
+// concurrent reader never sees a half-written index, and a crash can't leave
+// a truncated file.
+async function writeFileAtomic(path: string, data: string): Promise<void> {
+  const tmp = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
+  await writeFile(tmp, data, "utf8");
+  await rename(tmp, path);
+}
+
 export function createChangeSetStore(rootDir: string): ChangeSetStore {
   // All history stays inside .dohc/history — never written outside it.
   const historyDir = join(rootDir, ".dohc", "history");
@@ -67,40 +76,58 @@ export function createChangeSetStore(rootDir: string): ChangeSetStore {
     return (await readJson<IndexEntry[]>(indexPath)) ?? [];
   }
 
-  return {
-    async record(set, opts) {
-      const record: HistoryRecord = {
-        id: opts.id,
-        recordedAtMs: opts.recordedAtMs,
-        kind: set.kind,
-        author: set.author,
-        summary: set.summary,
-        files: set.files,
-        boundaryCrossings: set.boundaryCrossings,
-        ...(set.provenance ? { provenance: set.provenance } : {}),
-      };
-
-      await mkdir(historyDir, { recursive: true });
-      // Pretty JSON: history is meant to be opened and read by a person.
-      await writeFile(
-        join(historyDir, recordFileName(opts)),
-        `${JSON.stringify(record, null, 2)}\n`,
-        "utf8",
-      );
+  // Serialize record() within this store instance: the index is a
+  // read-modify-write, and the live watcher fires records fire-and-forget, so
+  // two close-together batches would race and the second writeFile would drop
+  // the first's index entry (silent timeline loss). This promise chain makes
+  // index updates strictly sequential.
+  let writeChain: Promise<unknown> = Promise.resolve();
+  function serialize<T>(task: () => Promise<T>): Promise<T> {
+    const run = writeChain.then(task, task);
+    // Keep the chain alive even if a task rejects, without unhandled rejection.
+    writeChain = run.then(
+      () => undefined,
+      () => undefined,
+    );
+    return run;
+  }
 
-      const entry: IndexEntry = {
-        id: record.id,
-        recordedAtMs: record.recordedAtMs,
-        kind: record.kind,
-        author: record.author,
-        summary: record.summary,
-        fileCount: record.files.length,
-      };
-      const index = await readIndex();
-      index.push(entry);
-      await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
+  return {
+    record(set, opts) {
+      return serialize(async () => {
+        const record: HistoryRecord = {
+          id: opts.id,
+          recordedAtMs: opts.recordedAtMs,
+          kind: set.kind,
+          author: set.author,
+          summary: set.summary,
+          files: set.files,
+          boundaryCrossings: set.boundaryCrossings,
+          ...(set.provenance ? { provenance: set.provenance } : {}),
+        };
+
+        await mkdir(historyDir, { recursive: true });
+        // Pretty JSON: history is meant to be opened and read by a person.
+        await writeFile(
+          join(historyDir, recordFileName(opts)),
+          `${JSON.stringify(record, null, 2)}\n`,
+          "utf8",
+        );
 
-      return record;
+        const entry: IndexEntry = {
+          id: record.id,
+          recordedAtMs: record.recordedAtMs,
+          kind: record.kind,
+          author: record.author,
+          summary: record.summary,
+          fileCount: record.files.length,
+        };
+        const index = await readIndex();
+        index.push(entry);
+        await writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);
+
+        return record;
+      });
     },
 
     async list() {

exec
/bin/bash -lc 'git diff d87f2f1''^ d87f2f1 -- packages/workspace-history/src/changeSetStore.ts | sed -n '"'120,260p'" in /home/ice/dev/dohc
 succeeded in 0ms:
exec
/bin/bash -lc "sed -n '1,260p' packages/workspace-fs/src/watchEvents.ts && printf '\\n--- history ---\\n' && sed -n '1,260p' packages/workspace-history/src/changeSetStore.ts && printf '\\n--- watcher ---\\n' && sed -n '1,220p' apps/desktop/src/workspaces/workspaceWatcher.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
// Phase 5: the raw filesystem watch layer for a local-first workspace.
//
// Two concerns live here, kept separate so the noisy parts stay testable:
//   1. PURE rules that decide which paths are workspace noise vs. real user
//      files, and how SQLite's multi-file write protocol collapses back to a
//      single logical database change.
//   2. A thin chokidar wrapper that debounces raw events into a quiet-window
//      settle and hands the changed relative paths up to the caller.
//
// The pure helpers are exhaustively unit-tested; the chokidar wrapper only
// needs to construct and tear down cleanly, since real fs-event timing is
// exercised by the desktop E2E suite.

import { watch } from "chokidar";
import { isAbsolute, relative } from "node:path";
import type { WatcherEvent } from "@dohc/workspace-core";

// Normalize separators so a single set of rules covers POSIX and the
// backslash paths a Windows watcher hands back.
function toPosix(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}

// SQLite sidecars: the WAL/SHM/journal files SQLite writes alongside a
// database. Anchored to the end so "data/walmart.csv" (contains "wal") and
// "notes/journal.md" never match.
const SQLITE_SIDECAR = /^(.*\.(?:db|sqlite))-(?:wal|shm|journal)$/i;

// Editor scratch/swap/autosave artifacts that churn while a user types but are
// never the file we sync.
const EDITOR_NOISE = [
  /\.tmp$/i, // foo.tmp
  /\.tmp\..+$/i, // foo.tmp.1234 (atomic-write staging)
  /\.swp$/i, // vim swap
  /\.swo$/i, // vim secondary swap
  /~$/, // emacs/gedit trailing-tilde backup
  /^#.*#$/, // emacs autosave: #foo#
  /^\.DS_Store$/i, // macOS Finder metadata
];

// TRUE when the watcher should drop this relative path before it ever becomes
// a user file op. Covers the reserved .dohc/ tree (including its cache) and
// editor scratch files. NOTE: SQLite sidecars (.db-wal/-journal/-shm) are NOT
// ignored here — a SQLite write often touches only the WAL while the base .db
// is untouched until checkpoint, so ignoring sidecars would make the change
// INVISIBLE. Instead the pipeline lets sidecar events through and folds them
// into one base-db update via collapseSqliteSidecars, so the sidecar path
// never surfaces but the database change is never missed.
export function shouldIgnoreWatchPath(relativePath: string): boolean {
  const path = toPosix(relativePath);
  const lower = path.toLowerCase();

  // .dohc/ is dohc's own reserved/derived state (registry, cache, ...). Match
  // the directory exactly or as a prefix — but NOT ".dohcrc", which is a
  // sibling file, not the reserved directory.
  if (lower === ".dohc" || lower.startsWith(".dohc/")) return true;

  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (EDITOR_NOISE.some((pattern) => pattern.test(basename))) return true;

  return false;
}

// Strip a SQLite sidecar suffix back to its base database path, or return
// undefined for a path that is not a sidecar.
function baseDbPath(path: string): string | undefined {
  const match = SQLITE_SIDECAR.exec(toPosix(path));
  return match ? match[1] : undefined;
}

// Collapse SQLite's multi-file write protocol back to one logical change.
//
// A single transaction can touch wallet.db, wallet.db-wal and wallet.db-shm,
// and a WAL checkpoint can even read as a *delete* of a sidecar while the base
// db emits nothing. The user-facing truth is always "the database changed", so
// we: drop every sidecar event, and guarantee exactly one "update" event for
// each affected base db — inserted at the position of its first related event
// to preserve ordering relative to other (non-sqlite) files.
export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
  const out: WatcherEvent[] = [];
  // Maps a base-db path to the index in `out` holding its single update, so a
  // later base or sidecar event for the same db folds into that one slot.
  const baseDbIndex = new Map<string, number>();

  const ensureBaseDbUpdate = (dbPath: string): void => {
    const existing = baseDbIndex.get(dbPath);
    if (existing !== undefined) {
      // Force "update": a checkpoint may have arrived as create/delete, but the
      // database content changing is always an update from the user's view.
      out[existing] = { path: dbPath, operation: "update" };
      return;
    }
    baseDbIndex.set(dbPath, out.length);
    out.push({ path: dbPath, operation: "update" });
  };

  for (const event of events) {
    const sidecarBase = baseDbPath(event.path);
    if (sidecarBase !== undefined) {
      // A sidecar event stands in for (or accompanies) its base db.
      ensureBaseDbUpdate(sidecarBase);
      continue;
    }
    const normalized = toPosix(event.path);
    if (baseDbIndex.has(normalized)) {
      // The base db itself changed and we already have a slot for it.
      ensureBaseDbUpdate(normalized);
      continue;
    }
    // Track base-db paths so a sidecar arriving later folds into this event.
    if (/\.(?:db|sqlite)$/i.test(normalized)) {
      baseDbIndex.set(normalized, out.length);
    }
    out.push(event);
  }

  return out;
}

export type WatchWorkspaceEventsOptions = {
  rootDir: string;
  // Quiet-window before a burst of raw events is reported as one batch. An
  // agent run or a save-all touching many files settles into a single batch.
  settleMs?: number;
  signal?: AbortSignal;
};

// Thin chokidar wrapper: watches rootDir, ignores noise via
// shouldIgnoreWatchPath, debounces raw events into a quiet-window settle, and
// calls onBatch with the unique changed relative paths once things go quiet.
// Returns an idempotent stop function.
export function watchWorkspaceEvents(
  { rootDir, settleMs = 500, signal }: WatchWorkspaceEventsOptions,
  onBatch: (paths: string[]) => void,
): () => void {
  if (signal?.aborted) return () => undefined;

  // cwd makes chokidar hand back EVENT paths relative to rootDir, but the
  // `ignored` predicate is called with ABSOLUTE paths during the initial scan
  // — relativize first or .dohc/** (incl. our own history writes) leaks
  // through and the watcher records its own output in a feedback loop.
  const watcher = watch(".", {
    cwd: rootDir,
    // We diff the filesystem ourselves on change; an initial flood of "add"
    // events for every existing file would be pure noise.
    ignoreInitial: true,
    // Never follow symlinks out of the workspace — a symlinked dir would let
    // the watcher observe (and record) files outside the workspace root.
    followSymlinks: false,
    ignored: (path: string) => {
      const rel = isAbsolute(path) ? relative(rootDir, path) : path;
      if (rel === "" || rel === ".") return false;
      return shouldIgnoreWatchPath(rel);
    },
  });

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const flush = (): void => {
    timer = undefined;
    if (pending.size === 0) return;
    const paths = [...pending];
    pending.clear();
    onBatch(paths);
  };

  const onEvent = (relativePath: string): void => {
    // chokidar's cwd-relative path is already separator-normalized for our
    // matcher; track it and (re)arm the quiet window.
    pending.add(toPosix(relativePath));
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, settleMs);
  };

  watcher.on("add", onEvent);
  watcher.on("change", onEvent);
  watcher.on("unlink", onEvent);
  // Surface watcher errors rather than swallowing them; a dead watcher should
  // be visible upstream, not silently stop reporting changes.
  watcher.on("error", (error) => {
    console.error("[workspace-fs] watch error", error);
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    // Flush any settled-but-not-yet-emitted changes so a save right before
    // stop/quit is recorded into history rather than silently dropped.
    flush();
    signal?.removeEventListener("abort", stop);
    void watcher.close();
  };

  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}

--- history ---
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BoundaryCrossing,
  ChangeAuthor,
  ChangeProvenance,
  ChangeSet,
  ChangeSetKind,
  FileChange,
} from "@dohc/workspace-core";

// One persisted change set. Mirrors ChangeSet but adds the identity and
// timestamp the store assigns, so each record is self-describing on disk.
export interface HistoryRecord {
  id: string;
  recordedAtMs: number;
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  files: FileChange[];
  provenance?: ChangeProvenance;
  boundaryCrossings: BoundaryCrossing[];
}

// The index is a lightweight, ordered table of contents — enough to render a
// timeline without opening every per-record file. Ordering source of truth.
interface IndexEntry {
  id: string;
  recordedAtMs: number;
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  fileCount: number;
}

export interface ChangeSetStore {
  record(
    set: ChangeSet,
    opts: { id: string; recordedAtMs: number },
  ): Promise<HistoryRecord>;
  list(): Promise<HistoryRecord[]>;
  get(id: string): Promise<HistoryRecord | null>;
}

// Each record lives in its own file so history is inspectable: open
// .dohc/history/<recordedAtMs>-<id>.json and read what changed and why.
function recordFileName(opts: { id: string; recordedAtMs: number }): string {
  return `${opts.recordedAtMs}-${opts.id}.json`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    // A missing file is the empty case (no history yet), not an error.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Atomic write: serialize to a temp file then rename over the target so a
// concurrent reader never sees a half-written index, and a crash can't leave
// a truncated file.
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

export function createChangeSetStore(rootDir: string): ChangeSetStore {
  // All history stays inside .dohc/history — never written outside it.
  const historyDir = join(rootDir, ".dohc", "history");
  const indexPath = join(historyDir, "index.json");

  async function readIndex(): Promise<IndexEntry[]> {
    return (await readJson<IndexEntry[]>(indexPath)) ?? [];
  }

  // Serialize record() within this store instance: the index is a
  // read-modify-write, and the live watcher fires records fire-and-forget, so
  // two close-together batches would race and the second writeFile would drop
  // the first's index entry (silent timeline loss). This promise chain makes
  // index updates strictly sequential.
  let writeChain: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = writeChain.then(task, task);
    // Keep the chain alive even if a task rejects, without unhandled rejection.
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    record(set, opts) {
      return serialize(async () => {
        const record: HistoryRecord = {
          id: opts.id,
          recordedAtMs: opts.recordedAtMs,
          kind: set.kind,
          author: set.author,
          summary: set.summary,
          files: set.files,
          boundaryCrossings: set.boundaryCrossings,
          ...(set.provenance ? { provenance: set.provenance } : {}),
        };

        await mkdir(historyDir, { recursive: true });
        // Pretty JSON: history is meant to be opened and read by a person.
        await writeFile(
          join(historyDir, recordFileName(opts)),
          `${JSON.stringify(record, null, 2)}\n`,
          "utf8",
        );

        const entry: IndexEntry = {
          id: record.id,
          recordedAtMs: record.recordedAtMs,
          kind: record.kind,
          author: record.author,
          summary: record.summary,
          fileCount: record.files.length,
        };
        const index = await readIndex();
        index.push(entry);
        await writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);

        return record;
      });
    },

    async list() {
      const index = await readIndex();
      // The index is the ordering source; sort newest first by timestamp,
      // breaking ties on id so ordering is stable within the same ms.
      const ordered = [...index].sort(
        (a, b) =>
          b.recordedAtMs - a.recordedAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
      const records: HistoryRecord[] = [];
      for (const entry of ordered) {
        // Read the full record from its own file — the index only holds a
        // summary, the per-record file is the source of full detail.
        const record = await readJson<HistoryRecord>(
          join(historyDir, recordFileName(entry)),
        );
        if (record) records.push(record);
      }
      return records;
    },

    async get(id) {
      const index = await readIndex();
      const entry = index.find((e) => e.id === id);
      if (!entry) return null;
      return readJson<HistoryRecord>(join(historyDir, recordFileName(entry)));
    },
  };
}

// Plain-language attribution: who did what, to how many files. Author-aware so
// a user edit and an agent run read differently. Deliberately prose, never Git
// conflict markers — history is for humans to skim.
export function humanSummary(record: HistoryRecord): string {
  const count = record.files.length;
  const noun = count === 1 ? "file" : "files";
  const verb = verbForKind(record.kind);

  if (record.author.kind === "agent") {
    // Attribute to the person the agent acted for, e.g. "Maya's agent".
    return `${record.author.onBehalfOf}'s agent ${verb} ${count} ${noun}`;
  }

  // A single, named file reads better than a count for solo user edits.
  if (count === 1) {
    return `You ${verb} ${record.files[0].path}`;
  }
  return `You ${verb} ${count} ${noun}`;
}

function verbForKind(kind: ChangeSetKind): string {
  switch (kind) {
    case "import":
      return "imported";
    case "agent-run":
      return "ran an agent over";
    case "sync":
      return "synced";
    case "app-build":
      return "built";
    case "user-edit":
    default:
      return "edited";
  }
}

--- watcher ---
import type {
  ChangeAuthor,
  WatcherEvent,
  WatcherEventBatch,
} from "@dohc/workspace-core";
import {
  collapseSqliteSidecars,
  shouldIgnoreWatchPath,
  watchWorkspaceEvents,
} from "@dohc/workspace-fs";
import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
import { batchToChangeSet } from "@dohc/workspace-sync";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

// Local user is the implicit author of filesystem edits (an external agent's
// writes also land here; provenance/attribution sharpens in later phases).
const LOCAL_USER: ChangeAuthor = { kind: "user", userId: "local" };

async function sha256OrUndefined(absolute: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(absolute)).digest("hex");
  } catch {
    return undefined;
  }
}

// Turn the watcher's settled changed paths into WatcherEvents. Operation is
// inferred from current existence (present => write/create, absent => delete);
// this is the pure, testable core of the live pipeline.
export async function pathsToEvents(
  rootPath: string,
  paths: string[],
): Promise<WatcherEvent[]> {
  const events: WatcherEvent[] = [];
  for (const path of paths) {
    const absolute = join(rootPath, path);
    let exists = false;
    try {
      exists = (await stat(absolute)).isFile();
    } catch {
      exists = false;
    }
    events.push(
      exists
        ? { path, operation: "update", sha256: await sha256OrUndefined(absolute) }
        : { path, operation: "delete" },
    );
  }
  return events;
}

export interface WorkspaceWatchHandle {
  stop: () => void;
}

// Wires the file watcher to the history store: each settled batch of changes
// becomes one recorded change set. onRecorded lets the desktop layer refresh
// sync status and push the new timeline entry to the renderer.
export function startWorkspaceWatch(
  workspace: CreatedWorkspace,
  options: {
    settleMs?: number;
    now?: () => number;
    onRecorded?: () => void;
  } = {},
): WorkspaceWatchHandle {
  const store = createChangeSetStore(workspace.rootPath);
  const now = options.now ?? (() => Date.now());

  const stop = watchWorkspaceEvents(
    { rootDir: workspace.rootPath, settleMs: options.settleMs },
    (paths) => {
      void (async () => {
        // Defense in depth: never record changes to .dohc/** (our own history
        // writes, manifest, cache) — recording them would feed back into the
        // watcher. The watcher already ignores these; this guards a leak.
        const userPaths = paths.filter((p) => !shouldIgnoreWatchPath(p));
        if (userPaths.length === 0) return;
        const rawEvents = await pathsToEvents(workspace.rootPath, userPaths);
        // Fold SQLite WAL/journal/shm churn into a single base-db update so the
        // history shows "wallet.sqlite changed", never the transient sidecars.
        const events = collapseSqliteSidecars(rawEvents);
        if (events.length === 0) return;
        const batch: WatcherEventBatch = {
          settledAtMs: now(),
          windowMs: options.settleMs ?? 500,
          events,
        };
        const changeSet = batchToChangeSet(batch, { author: LOCAL_USER });
        await store.record(changeSet, { id: randomUUID(), recordedAtMs: now() });
        options.onRecorded?.();
      })();
    },
  );

  return { stop };
}

export { createChangeSetStore, humanSummary };

exec
/bin/bash -lc "ls packages/workspace-fs/src && sed -n '1,200p' packages/workspace-fs/src/index.ts && grep -R \"collapseSqliteSidecars\" -n . --exclude-dir=node_modules --exclude-dir=.git" in /home/ice/dev/dohc
 succeeded in 133ms:
./apps/desktop/src/workspaces/workspaceWatcher.ts:7:  collapseSqliteSidecars,
./apps/desktop/src/workspaces/workspaceWatcher.ts:85:        const events = collapseSqliteSidecars(rawEvents);
./apps/desktop/dist/main/main.js:2217:function collapseSqliteSidecars(events) {
./apps/desktop/dist/main/main.js:2466:			const events = collapseSqliteSidecars(await pathsToEvents(workspace.rootPath, userPaths));
./packages/workspace-fs/src/watchEvents.test.ts:4:  collapseSqliteSidecars,
./packages/workspace-fs/src/watchEvents.test.ts:42:    // the change invisible. They pass through here and collapseSqliteSidecars
./packages/workspace-fs/src/watchEvents.test.ts:55:      collapseSqliteSidecars([
./packages/workspace-fs/src/watchEvents.test.ts:82:describe("collapseSqliteSidecars", () => {
./packages/workspace-fs/src/watchEvents.test.ts:86:    const out = collapseSqliteSidecars([update("finance/wallet.db-wal")]);
./packages/workspace-fs/src/watchEvents.test.ts:91:    expect(collapseSqliteSidecars([update("a/x.sqlite-journal")])).toEqual([
./packages/workspace-fs/src/watchEvents.test.ts:94:    expect(collapseSqliteSidecars([update("a/x.sqlite-wal")])).toEqual([
./packages/workspace-fs/src/watchEvents.test.ts:97:    expect(collapseSqliteSidecars([update("a/x.db-shm")])).toEqual([
./packages/workspace-fs/src/watchEvents.test.ts:104:    const out = collapseSqliteSidecars([
./packages/workspace-fs/src/watchEvents.test.ts:113:    const out = collapseSqliteSidecars([
./packages/workspace-fs/src/watchEvents.test.ts:124:    const out = collapseSqliteSidecars([
./packages/workspace-fs/src/watchEvents.test.ts:132:    const out = collapseSqliteSidecars([
./packages/workspace-fs/src/watchEvents.test.ts:145:    const out = collapseSqliteSidecars([
./packages/workspace-fs/src/watchEvents.test.ts:155:    expect(collapseSqliteSidecars(events)).toEqual(events);
./packages/workspace-fs/src/watchEvents.test.ts:159:    const out = collapseSqliteSidecars([
./packages/workspace-fs/src/watchEvents.test.ts:171:    expect(collapseSqliteSidecars([])).toEqual([]);
./packages/workspace-fs/src/watchEvents.ts:47:// into one base-db update via collapseSqliteSidecars, so the sidecar path
./packages/workspace-fs/src/watchEvents.ts:79:export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
./docs/superpowers/reviews/codex/phase-05.md:424:+export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
./docs/superpowers/reviews/codex/phase-05.md:1525:+  collapseSqliteSidecars,
./docs/superpowers/reviews/codex/phase-05.md:1591:+describe("collapseSqliteSidecars", () => {
./docs/superpowers/reviews/codex/phase-05.md:1595:+    const out = collapseSqliteSidecars([update("finance/wallet.db-wal")]);
./docs/superpowers/reviews/codex/phase-05.md:1600:+    expect(collapseSqliteSidecars([update("a/x.sqlite-journal")])).toEqual([
./docs/superpowers/reviews/codex/phase-05.md:1603:+    expect(collapseSqliteSidecars([update("a/x.sqlite-wal")])).toEqual([
./docs/superpowers/reviews/codex/phase-05.md:1606:+    expect(collapseSqliteSidecars([update("a/x.db-shm")])).toEqual([
./docs/superpowers/reviews/codex/phase-05.md:1613:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:1622:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:1633:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:1641:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:1654:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:1664:+    expect(collapseSqliteSidecars(events)).toEqual(events);
./docs/superpowers/reviews/codex/phase-05.md:1668:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:1680:+    expect(collapseSqliteSidecars([])).toEqual([]);
./docs/superpowers/reviews/codex/phase-05.md:2570:    77	export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
./docs/superpowers/reviews/codex/phase-05.md:2827:/bin/bash -lc 'rg "collapseSqliteSidecars|shouldIgnoreWatchPath|createSettleBatcher|inFlight" -n' in /home/ice/dev/dohc
./docs/superpowers/reviews/codex/phase-05.md:2845:packages/workspace-fs/src/watchEvents.ts:77:export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
./docs/superpowers/reviews/codex/phase-05.md:2848:packages/workspace-fs/src/watchEvents.test.ts:4:  collapseSqliteSidecars,
./docs/superpowers/reviews/codex/phase-05.md:2883:packages/workspace-fs/src/watchEvents.test.ts:70:describe("collapseSqliteSidecars", () => {
./docs/superpowers/reviews/codex/phase-05.md:2884:packages/workspace-fs/src/watchEvents.test.ts:74:    const out = collapseSqliteSidecars([update("finance/wallet.db-wal")]);
./docs/superpowers/reviews/codex/phase-05.md:2885:packages/workspace-fs/src/watchEvents.test.ts:79:    expect(collapseSqliteSidecars([update("a/x.sqlite-journal")])).toEqual([
./docs/superpowers/reviews/codex/phase-05.md:2886:packages/workspace-fs/src/watchEvents.test.ts:82:    expect(collapseSqliteSidecars([update("a/x.sqlite-wal")])).toEqual([
./docs/superpowers/reviews/codex/phase-05.md:2887:packages/workspace-fs/src/watchEvents.test.ts:85:    expect(collapseSqliteSidecars([update("a/x.db-shm")])).toEqual([
./docs/superpowers/reviews/codex/phase-05.md:2888:packages/workspace-fs/src/watchEvents.test.ts:92:    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2889:packages/workspace-fs/src/watchEvents.test.ts:101:    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2890:packages/workspace-fs/src/watchEvents.test.ts:112:    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2891:packages/workspace-fs/src/watchEvents.test.ts:120:    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2892:packages/workspace-fs/src/watchEvents.test.ts:133:    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2893:packages/workspace-fs/src/watchEvents.test.ts:143:    expect(collapseSqliteSidecars(events)).toEqual(events);
./docs/superpowers/reviews/codex/phase-05.md:2894:packages/workspace-fs/src/watchEvents.test.ts:147:    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2895:packages/workspace-fs/src/watchEvents.test.ts:159:    expect(collapseSqliteSidecars([])).toEqual([]);
./docs/superpowers/reviews/codex/phase-05.md:2903:docs/superpowers/reviews/codex/phase-05.md:424:+export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
./docs/superpowers/reviews/codex/phase-05.md:2909:docs/superpowers/reviews/codex/phase-05.md:1525:+  collapseSqliteSidecars,
./docs/superpowers/reviews/codex/phase-05.md:2944:docs/superpowers/reviews/codex/phase-05.md:1591:+describe("collapseSqliteSidecars", () => {
./docs/superpowers/reviews/codex/phase-05.md:2945:docs/superpowers/reviews/codex/phase-05.md:1595:+    const out = collapseSqliteSidecars([update("finance/wallet.db-wal")]);
./docs/superpowers/reviews/codex/phase-05.md:2946:docs/superpowers/reviews/codex/phase-05.md:1600:+    expect(collapseSqliteSidecars([update("a/x.sqlite-journal")])).toEqual([
./docs/superpowers/reviews/codex/phase-05.md:2947:docs/superpowers/reviews/codex/phase-05.md:1603:+    expect(collapseSqliteSidecars([update("a/x.sqlite-wal")])).toEqual([
./docs/superpowers/reviews/codex/phase-05.md:2948:docs/superpowers/reviews/codex/phase-05.md:1606:+    expect(collapseSqliteSidecars([update("a/x.db-shm")])).toEqual([
./docs/superpowers/reviews/codex/phase-05.md:2949:docs/superpowers/reviews/codex/phase-05.md:1613:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2950:docs/superpowers/reviews/codex/phase-05.md:1622:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2951:docs/superpowers/reviews/codex/phase-05.md:1633:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2952:docs/superpowers/reviews/codex/phase-05.md:1641:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2953:docs/superpowers/reviews/codex/phase-05.md:1654:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2954:docs/superpowers/reviews/codex/phase-05.md:1664:+    expect(collapseSqliteSidecars(events)).toEqual(events);
./docs/superpowers/reviews/codex/phase-05.md:2955:docs/superpowers/reviews/codex/phase-05.md:1668:+    const out = collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05.md:2956:docs/superpowers/reviews/codex/phase-05.md:1680:+    expect(collapseSqliteSidecars([])).toEqual([]);
./docs/superpowers/reviews/codex/phase-05.md:2971:docs/superpowers/reviews/codex/phase-05.md:2570:    77	export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
./docs/superpowers/reviews/codex/phase-05.md:3587:  When SQLite runs in WAL mode, commits can touch only `wallet.db-wal`/`-shm` and not the base DB; returning `true` here makes both the chokidar ignore predicate and the desktop defense-in-depth filter discard those paths before `collapseSqliteSidecars` can convert them into a base-DB update. The live history/sync pipeline will silently miss those database changes unless sidecars stay in the event stream and are collapsed before recording.
./docs/superpowers/reviews/codex/phase-05.md:3602:  When SQLite runs in WAL mode, commits can touch only `wallet.db-wal`/`-shm` and not the base DB; returning `true` here makes both the chokidar ignore predicate and the desktop defense-in-depth filter discard those paths before `collapseSqliteSidecars` can convert them into a base-DB update. The live history/sync pipeline will silently miss those database changes unless sidecars stay in the event stream and are collapsed before recording.
./docs/superpowers/reviews/codex/phase-05-fix.md:121:+  collapseSqliteSidecars,
./docs/superpowers/reviews/codex/phase-05-fix.md:136:+        const events = collapseSqliteSidecars(rawEvents);
./docs/superpowers/reviews/codex/phase-05-fix.md:157:+    // the change invisible. They pass through here and collapseSqliteSidecars
./docs/superpowers/reviews/codex/phase-05-fix.md:170:+      collapseSqliteSidecars([
./docs/superpowers/reviews/codex/phase-05-fix.md:193:+// into one base-db update via collapseSqliteSidecars, so the sidecar path
./docs/superpowers/reviews/codex/phase-05-fix.md:420:// into one base-db update via collapseSqliteSidecars, so the sidecar path
./docs/superpowers/reviews/codex/phase-05-fix.md:452:export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
./docs/superpowers/reviews/codex/phase-05-fix.md:779:  collapseSqliteSidecars,
./docs/superpowers/reviews/codex/phase-05-fix.md:857:        const events = collapseSqliteSidecars(rawEvents);
./docs/superpowers/reviews/codex/phase-05-fix.md:877:/bin/bash -lc "ls packages/workspace-fs/src && sed -n '1,200p' packages/workspace-fs/src/index.ts && grep -R \"collapseSqliteSidecars\" -n . --exclude-dir=node_modules --exclude-dir=.git" in /home/ice/dev/dohc
./docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:171:  - P1 SQLite sidecars dropped before collapse (shouldIgnoreWatchPath ignored .db-wal so WAL-only writes were INVISIBLE, and collapse never ran) — FIXED: stop ignoring sidecars; wire collapseSqliteSidecars into the live workspaceWatcher path; tests flipped (sidecars not ignored) + WAL-only→base-db-update test.

exec
/bin/bash -lc "sed -n '1,240p' packages/workspace-fs/src/watchEvents.test.ts && printf '\\n--- old watcher? ---\\n' && git show d87f2f1"'^:packages/workspace-fs/src/watchEvents.ts | sed -n '"'1,240p'" in /home/ice/dev/dohc
 succeeded in 0ms:
import { describe, expect, it } from "vitest";
import type { WatcherEvent } from "@dohc/workspace-core";
import {
  collapseSqliteSidecars,
  shouldIgnoreWatchPath,
  watchWorkspaceEvents,
} from "./watchEvents";

describe("shouldIgnoreWatchPath", () => {
  it("ignores everything under the reserved .dohc/ tree", () => {
    // .dohc/ holds dohc's own derived/reserved state; raw fs noise from it must
    // never surface as user file ops or it would loop sync back on itself.
    expect(shouldIgnoreWatchPath(".dohc")).toBe(true);
    expect(shouldIgnoreWatchPath(".dohc/registry.json")).toBe(true);
    expect(shouldIgnoreWatchPath(".dohc/cache/blob-0001")).toBe(true);
    expect(shouldIgnoreWatchPath(".dohc/cache/nested/deep/file")).toBe(true);
    // Case-insensitive: on macOS/Windows .DOHC aliases .dohc.
    expect(shouldIgnoreWatchPath(".DOHC/cache/x")).toBe(true);
    expect(shouldIgnoreWatchPath(".Dohc")).toBe(true);
  });

  it("does not ignore a sibling whose name merely starts with .dohc", () => {
    // ".dohcrc" is a distinct file, not the reserved ".dohc/" directory.
    expect(shouldIgnoreWatchPath(".dohcrc")).toBe(false);
    expect(shouldIgnoreWatchPath("notes/.dohc-notes.md")).toBe(false);
  });

  it("ignores editor temp / swap / autosave files", () => {
    expect(shouldIgnoreWatchPath("notes/draft.tmp")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/draft.tmp.1234")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/today.md.swp")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/today.md.swo")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/today.md~")).toBe(true);
    expect(shouldIgnoreWatchPath("#today.md#")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/#today.md#")).toBe(true);
    expect(shouldIgnoreWatchPath(".DS_Store")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/.DS_Store")).toBe(true);
  });

  it("does NOT ignore SQLite sidecars — they signal a db change and are collapsed", () => {
    // A SQLite write often touches only the WAL; ignoring sidecars would make
    // the change invisible. They pass through here and collapseSqliteSidecars
    // folds them into one base-db update (so the sidecar path never surfaces).
    expect(shouldIgnoreWatchPath("finance/wallet.db-wal")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.db-journal")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-wal")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-journal")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.db-shm")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-shm")).toBe(false);
  });

  it("collapses a WAL-only change into a base-db update (db never missed)", () => {
    // The base .db file is untouched until checkpoint; only the WAL changed.
    expect(
      collapseSqliteSidecars([
        { path: "finance/wallet.sqlite-wal", operation: "update" },
      ]),
    ).toEqual([{ path: "finance/wallet.sqlite", operation: "update" }]);
  });

  it("keeps normal user files watchable", () => {
    expect(shouldIgnoreWatchPath("notes/today.md")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.sqlite")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.db")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/.apps/ledger/app.json")).toBe(false);
    // A file that merely mentions "tmp"/"swp"/"wal" in its name is fine.
    expect(shouldIgnoreWatchPath("notes/tmp-ideas.md")).toBe(false);
    expect(shouldIgnoreWatchPath("notes/swap-meet.md")).toBe(false);
    expect(shouldIgnoreWatchPath("data/walmart.csv")).toBe(false);
  });

  it("normalizes backslash separators before matching", () => {
    // Watchers on Windows hand back backslash paths; the reserved/cache guard
    // must still fire.
    expect(shouldIgnoreWatchPath(".dohc\\cache\\blob")).toBe(true);
    expect(shouldIgnoreWatchPath("notes\\today.md")).toBe(false);
  });
});

const update = (path: string): WatcherEvent => ({ path, operation: "update" });

describe("collapseSqliteSidecars", () => {
  it("collapses a sidecar event into a single update for its base db", () => {
    // SQLite writes hit wallet.db-wal first; the base wallet.db may not emit an
    // fs event at all, so a WAL touch must still surface as one base-db update.
    const out = collapseSqliteSidecars([update("finance/wallet.db-wal")]);
    expect(out).toEqual([update("finance/wallet.db")]);
  });

  it("collapses .sqlite-* and -shm sidecars to their base too", () => {
    expect(collapseSqliteSidecars([update("a/x.sqlite-journal")])).toEqual([
      update("a/x.sqlite"),
    ]);
    expect(collapseSqliteSidecars([update("a/x.sqlite-wal")])).toEqual([
      update("a/x.sqlite"),
    ]);
    expect(collapseSqliteSidecars([update("a/x.db-shm")])).toEqual([
      update("a/x.db"),
    ]);
  });

  it("drops the sidecar event when the base db also changed", () => {
    // Both base and WAL emitted: keep exactly one base update, drop the sidecar.
    const out = collapseSqliteSidecars([
      update("finance/wallet.db"),
      update("finance/wallet.db-wal"),
      update("finance/wallet.db-shm"),
    ]);
    expect(out).toEqual([update("finance/wallet.db")]);
  });

  it("deduplicates multiple sidecars of the same base into one update", () => {
    const out = collapseSqliteSidecars([
      update("finance/wallet.db-wal"),
      update("finance/wallet.db-shm"),
      update("finance/wallet.db-journal"),
    ]);
    expect(out).toEqual([update("finance/wallet.db")]);
  });

  it("forces the base-db event to 'update' even if the base arrived as create/delete", () => {
    // A WAL checkpoint reads as a delete of the sidecar, but the user-facing
    // truth is that the database content changed — never report it as a delete.
    const out = collapseSqliteSidecars([
      { path: "finance/wallet.db", operation: "create" },
      { path: "finance/wallet.db-wal", operation: "delete" },
    ]);
    expect(out).toEqual([update("finance/wallet.db")]);
  });

  it("preserves base-db event order while collapsing in place", () => {
    const out = collapseSqliteSidecars([
      update("notes/today.md"),
      update("finance/wallet.db-wal"),
      update("inbox/scan.png"),
    ]);
    expect(out).toEqual([
      update("notes/today.md"),
      update("finance/wallet.db"),
      update("inbox/scan.png"),
    ]);
  });

  it("collapses sidecars for several distinct databases independently", () => {
    const out = collapseSqliteSidecars([
      update("a/one.db-wal"),
      update("b/two.sqlite-shm"),
      update("b/two.sqlite-wal"),
    ]);
    expect(out).toEqual([update("a/one.db"), update("b/two.sqlite")]);
  });

  it("leaves non-sqlite and bare-db events untouched", () => {
    const events = [update("notes/today.md"), update("finance/wallet.db")];
    expect(collapseSqliteSidecars(events)).toEqual(events);
  });

  it("never emits a sidecar path as a user file op", () => {
    const out = collapseSqliteSidecars([
      update("finance/wallet.db-wal"),
      update("finance/wallet.db-shm"),
      update("finance/wallet.db-journal"),
      update("finance/wallet.sqlite-wal"),
    ]);
    for (const event of out) {
      expect(event.path).not.toMatch(/-(wal|shm|journal)$/);
    }
  });

  it("returns an empty array for no events", () => {
    expect(collapseSqliteSidecars([])).toEqual([]);
  });
});

describe("watchWorkspaceEvents", () => {
  it("returns a stop function that is idempotent and respects a pre-aborted signal", async () => {
    // Pure timing is covered by desktop E2E; here we just prove the wrapper
    // constructs against a real (empty) temp dir and the stop fn is safe.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "dohc-watch-"));
    try {
      const controller = new AbortController();
      controller.abort();
      const stopAborted = watchWorkspaceEvents(
        { rootDir: root, signal: controller.signal },
        () => undefined,
      );
      expect(typeof stopAborted).toBe("function");
      stopAborted();

      const stop = watchWorkspaceEvents({ rootDir: root, settleMs: 10 }, () => undefined);
      expect(typeof stop).toBe("function");
      stop();
      // Calling stop twice must not throw.
      stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores .dohc writes but reports user files (chokidar passes absolute paths to ignored)", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "dohc-watch-"));
    try {
      const batches: string[][] = [];
      const stop = watchWorkspaceEvents({ rootDir: root, settleMs: 80 }, (paths) =>
        batches.push(paths),
      );
      // Give chokidar a moment to attach before writing.
      await new Promise((r) => setTimeout(r, 200));
      await mkdir(join(root, ".dohc", "history"), { recursive: true });
      await writeFile(join(root, ".dohc", "history", "1.json"), "{}");
      await writeFile(join(root, "notes.md"), "hi");
      await new Promise((r) => setTimeout(r, 600));
      stop();
      const seen = batches.flat();
      // The user file is reported; nothing under .dohc/ ever is (no feedback loop).
      expect(seen).toContain("notes.md");
      expect(seen.some((p) => p.includes(".dohc"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

--- old watcher? ---
// Phase 5: the raw filesystem watch layer for a local-first workspace.
//
// Two concerns live here, kept separate so the noisy parts stay testable:
//   1. PURE rules that decide which paths are workspace noise vs. real user
//      files, and how SQLite's multi-file write protocol collapses back to a
//      single logical database change.
//   2. A thin chokidar wrapper that debounces raw events into a quiet-window
//      settle and hands the changed relative paths up to the caller.
//
// The pure helpers are exhaustively unit-tested; the chokidar wrapper only
// needs to construct and tear down cleanly, since real fs-event timing is
// exercised by the desktop E2E suite.

import { watch } from "chokidar";
import { isAbsolute, relative } from "node:path";
import type { WatcherEvent } from "@dohc/workspace-core";

// Normalize separators so a single set of rules covers POSIX and the
// backslash paths a Windows watcher hands back.
function toPosix(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}

// SQLite sidecars: the WAL/SHM/journal files SQLite writes alongside a
// database. Anchored to the end so "data/walmart.csv" (contains "wal") and
// "notes/journal.md" never match.
const SQLITE_SIDECAR = /^(.*\.(?:db|sqlite))-(?:wal|shm|journal)$/i;

// Editor scratch/swap/autosave artifacts that churn while a user types but are
// never the file we sync.
const EDITOR_NOISE = [
  /\.tmp$/i, // foo.tmp
  /\.tmp\..+$/i, // foo.tmp.1234 (atomic-write staging)
  /\.swp$/i, // vim swap
  /\.swo$/i, // vim secondary swap
  /~$/, // emacs/gedit trailing-tilde backup
  /^#.*#$/, // emacs autosave: #foo#
  /^\.DS_Store$/i, // macOS Finder metadata
];

// TRUE when the watcher should drop this relative path before it ever becomes
// a user file op. Covers the reserved .dohc/ tree (including its cache),
// editor scratch files, and SQLite sidecars — see the regexes above for why
// each is anchored to avoid false positives on real user files.
export function shouldIgnoreWatchPath(relativePath: string): boolean {
  const path = toPosix(relativePath);
  const lower = path.toLowerCase();

  // .dohc/ is dohc's own reserved/derived state (registry, cache, ...). Match
  // the directory exactly or as a prefix — but NOT ".dohcrc", which is a
  // sibling file, not the reserved directory.
  if (lower === ".dohc" || lower.startsWith(".dohc/")) return true;

  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (EDITOR_NOISE.some((pattern) => pattern.test(basename))) return true;

  if (SQLITE_SIDECAR.test(path)) return true;

  return false;
}

// Strip a SQLite sidecar suffix back to its base database path, or return
// undefined for a path that is not a sidecar.
function baseDbPath(path: string): string | undefined {
  const match = SQLITE_SIDECAR.exec(toPosix(path));
  return match ? match[1] : undefined;
}

// Collapse SQLite's multi-file write protocol back to one logical change.
//
// A single transaction can touch wallet.db, wallet.db-wal and wallet.db-shm,
// and a WAL checkpoint can even read as a *delete* of a sidecar while the base
// db emits nothing. The user-facing truth is always "the database changed", so
// we: drop every sidecar event, and guarantee exactly one "update" event for
// each affected base db — inserted at the position of its first related event
// to preserve ordering relative to other (non-sqlite) files.
export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
  const out: WatcherEvent[] = [];
  // Maps a base-db path to the index in `out` holding its single update, so a
  // later base or sidecar event for the same db folds into that one slot.
  const baseDbIndex = new Map<string, number>();

  const ensureBaseDbUpdate = (dbPath: string): void => {
    const existing = baseDbIndex.get(dbPath);
    if (existing !== undefined) {
      // Force "update": a checkpoint may have arrived as create/delete, but the
      // database content changing is always an update from the user's view.
      out[existing] = { path: dbPath, operation: "update" };
      return;
    }
    baseDbIndex.set(dbPath, out.length);
    out.push({ path: dbPath, operation: "update" });
  };

  for (const event of events) {
    const sidecarBase = baseDbPath(event.path);
    if (sidecarBase !== undefined) {
      // A sidecar event stands in for (or accompanies) its base db.
      ensureBaseDbUpdate(sidecarBase);
      continue;
    }
    const normalized = toPosix(event.path);
    if (baseDbIndex.has(normalized)) {
      // The base db itself changed and we already have a slot for it.
      ensureBaseDbUpdate(normalized);
      continue;
    }
    // Track base-db paths so a sidecar arriving later folds into this event.
    if (/\.(?:db|sqlite)$/i.test(normalized)) {
      baseDbIndex.set(normalized, out.length);
    }
    out.push(event);
  }

  return out;
}

export type WatchWorkspaceEventsOptions = {
  rootDir: string;
  // Quiet-window before a burst of raw events is reported as one batch. An
  // agent run or a save-all touching many files settles into a single batch.
  settleMs?: number;
  signal?: AbortSignal;
};

// Thin chokidar wrapper: watches rootDir, ignores noise via
// shouldIgnoreWatchPath, debounces raw events into a quiet-window settle, and
// calls onBatch with the unique changed relative paths once things go quiet.
// Returns an idempotent stop function.
export function watchWorkspaceEvents(
  { rootDir, settleMs = 500, signal }: WatchWorkspaceEventsOptions,
  onBatch: (paths: string[]) => void,
): () => void {
  if (signal?.aborted) return () => undefined;

  // cwd makes chokidar hand back EVENT paths relative to rootDir, but the
  // `ignored` predicate is called with ABSOLUTE paths during the initial scan
  // — relativize first or .dohc/** (incl. our own history writes) leaks
  // through and the watcher records its own output in a feedback loop.
  const watcher = watch(".", {
    cwd: rootDir,
    // We diff the filesystem ourselves on change; an initial flood of "add"
    // events for every existing file would be pure noise.
    ignoreInitial: true,
    ignored: (path: string) => {
      const rel = isAbsolute(path) ? relative(rootDir, path) : path;
      if (rel === "" || rel === ".") return false;
      return shouldIgnoreWatchPath(rel);
    },
  });

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const flush = (): void => {
    timer = undefined;
    if (pending.size === 0) return;
    const paths = [...pending];
    pending.clear();
    onBatch(paths);
  };

  const onEvent = (relativePath: string): void => {
    // chokidar's cwd-relative path is already separator-normalized for our
    // matcher; track it and (re)arm the quiet window.
    pending.add(toPosix(relativePath));
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, settleMs);
  };

  watcher.on("add", onEvent);
  watcher.on("change", onEvent);
  watcher.on("unlink", onEvent);
  // Surface watcher errors rather than swallowing them; a dead watcher should
  // be visible upstream, not silently stop reporting changes.
  watcher.on("error", (error) => {
    console.error("[workspace-fs] watch error", error);
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    void watcher.close();
  };

  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}

exec
/bin/bash -lc "grep -R \"interface WatcherEvent\\|type WatcherEvent\\|sha256\\|batchToChangeSet\\|operation\" -n packages apps/desktop/src | head -200" in /home/ice/dev/dohc
 succeeded in 0ms:
packages/workspace-history/src/changeSetStore.test.ts:38:    [{ path: "notes/today.md", operation: "write" }],
packages/workspace-history/src/changeSetStore.test.ts:45:    operation: "write" as const,
packages/workspace-history/node_modules/@dohc/workspace-core/src/changeSet.ts:23:  operation: "write" | "delete" | "rename";
packages/workspace-history/node_modules/@dohc/workspace-core/src/watcher.ts:7:export interface WatcherEvent {
packages/workspace-history/node_modules/@dohc/workspace-core/src/watcher.ts:9:  operation: WatcherOperation;
packages/workspace-history/node_modules/@dohc/workspace-core/src/watcher.ts:10:  sha256?: string;
packages/workspace-history/node_modules/@dohc/workspace-core/src/watcher.ts:19:export interface WatcherEventBatch {
packages/workspace-history/node_modules/@dohc/workspace-core/src/paths.ts:95:// file operations the user's entire disk or home. Callers must use the
packages/workspace-history/node_modules/@dohc/workspace-core/src/changeSet.test.ts:26:      operation: "write" as const,
packages/workspace-history/node_modules/@dohc/workspace-core/src/changeSet.test.ts:43:      [{ path: "notes/today.md", operation: "write" }],
packages/workspace-fs/src/watchEvents.test.ts:56:        { path: "finance/wallet.sqlite-wal", operation: "update" },
packages/workspace-fs/src/watchEvents.test.ts:58:    ).toEqual([{ path: "finance/wallet.sqlite", operation: "update" }]);
packages/workspace-fs/src/watchEvents.test.ts:80:const update = (path: string): WatcherEvent => ({ path, operation: "update" });
packages/workspace-fs/src/watchEvents.test.ts:125:      { path: "finance/wallet.db", operation: "create" },
packages/workspace-fs/src/watchEvents.test.ts:126:      { path: "finance/wallet.db-wal", operation: "delete" },
packages/workspace-fs/src/watchEvents.ts:90:      out[existing] = { path: dbPath, operation: "update" };
packages/workspace-fs/src/watchEvents.ts:94:    out.push({ path: dbPath, operation: "update" });
packages/workspace-fs/src/syncClient.ts:143:      const operations = await Promise.all(local.map((operation) => enrichOperation(rootDir, operation)));
packages/workspace-fs/src/syncClient.ts:148:          { operations },
packages/workspace-fs/src/syncClient.ts:266:          operations: [
packages/workspace-fs/src/syncClient.ts:282:        operations: [{ op: "delete", path }],
packages/workspace-fs/src/syncClient.ts:290:  return diff.operations.filter((operation) => !isConflictOperation(operation));
packages/workspace-fs/src/syncClient.ts:293:function isConflictOperation(operation: FsDiffOperation) {
packages/workspace-fs/src/syncClient.ts:294:  if (operation.op === "rename") {
packages/workspace-fs/src/syncClient.ts:295:    return operation.fromPath.endsWith(".conflict") || operation.toPath.endsWith(".conflict");
packages/workspace-fs/src/syncClient.ts:297:  return operation.path.endsWith(".conflict");
packages/workspace-fs/src/syncClient.ts:304:  operations: FsDiffOperation[],
packages/workspace-fs/src/syncClient.ts:307:  for (const operation of operations) {
packages/workspace-fs/src/syncClient.ts:308:    const expectedRevision = "expectedRevision" in operation ? operation.expectedRevision : undefined;
packages/workspace-fs/src/syncClient.ts:310:    const path = operation.op === "rename" ? operation.fromPath : operation.path;
packages/workspace-fs/src/syncClient.ts:313:      conflicts.push(await collectConflictFile(rootDir, operation, "remote revision changed before local sync"));
packages/workspace-fs/src/syncClient.ts:319:async function collectDirtyPullConflicts(rootDir: string, operations: FsDiffOperation[]): Promise<PendingLocalSyncConflict[]> {
packages/workspace-fs/src/syncClient.ts:321:    operations
packages/workspace-fs/src/syncClient.ts:322:      .filter((operation) => operation.op === "update" || operation.op === "delete")
packages/workspace-fs/src/syncClient.ts:323:      .map((operation) => collectConflictFile(rootDir, operation, "remote pull found uncommitted local changes")),
packages/workspace-fs/src/syncClient.ts:343:  operation: FsDiffOperation,
packages/workspace-fs/src/syncClient.ts:346:  const path = operation.op === "rename" ? operation.toPath : operation.path;
packages/workspace-fs/src/syncClient.ts:348:  const localBody = operation.op === "delete" ? "" : await readLocalConflictBody(rootDir, path);
packages/workspace-fs/src/syncClient.ts:385:async function enrichOperation(rootDir: string, operation: FsDiffOperation): Promise<ApiSyncOperation> {
packages/workspace-fs/src/syncClient.ts:386:  if (operation.op === "delete" || operation.op === "rename") return operation;
packages/workspace-fs/src/syncClient.ts:388:  const path = assertSafeWorkspacePath(operation.path);
packages/workspace-fs/src/syncClient.ts:389:  const mediaType = operation.op === "create" ? operation.mediaType : mediaTypeForPath(path);
packages/workspace-fs/src/syncClient.ts:393:      ...operation,
packages/workspace-fs/src/syncClient.ts:400:    ...operation,
packages/workspace-fs/src/syncClient.ts:450:function firstOperationPath(operations: FsDiffOperation[]) {
packages/workspace-fs/src/syncClient.ts:451:  const first = operations[0];
packages/workspace-fs/src/materialize.ts:7:  sha256,
packages/workspace-fs/src/materialize.ts:52:          sha256: sha256(read.body),
packages/workspace-fs/src/materialize.ts:62:          sha256: sha256(read.bytes),
packages/workspace-fs/src/metadata.ts:13:  sha256?: string;
packages/workspace-fs/src/metadata.ts:59:export function sha256(bytes: Uint8Array | string) {
packages/workspace-fs/src/metadata.ts:60:  return createHash("sha256").update(bytes).digest("hex");
packages/workspace-fs/src/fsProjection.test.ts:211:      expect(diff.operations).toEqual([
packages/workspace-fs/src/fsProjection.test.ts:220:  it("applies diffs through backend operations with revision checks", async () => {
packages/workspace-fs/src/fsProjection.test.ts:270:          diff: { operations: [{ op: "create", path: "../escape.txt", mediaType: "text/plain" }] },
packages/workspace-fs/src/apply.ts:29:  for (const operation of diff.operations) {
packages/workspace-fs/src/apply.ts:30:    if (operation.op === "create") {
packages/workspace-fs/src/apply.ts:31:      const path = assertSafeWorkspacePath(operation.path);
packages/workspace-fs/src/apply.ts:33:      const mediaType = operation.mediaType || mediaTypeForPath(path);
packages/workspace-fs/src/apply.ts:48:    } else if (operation.op === "update") {
packages/workspace-fs/src/apply.ts:49:      const path = assertSafeWorkspacePath(operation.path);
packages/workspace-fs/src/apply.ts:56:          expectedRevision: operation.expectedRevision,
packages/workspace-fs/src/apply.ts:67:    } else if (operation.op === "delete") {
packages/workspace-fs/src/apply.ts:68:      await backend.deleteFile(actor, assertSafeWorkspacePath(operation.path));
packages/workspace-fs/src/apply.ts:70:      const fromPath = assertSafeWorkspacePath(operation.fromPath);
packages/workspace-fs/src/apply.ts:71:      const toPath = assertSafeWorkspacePath(operation.toPath);
packages/workspace-fs/src/apply.ts:78:        expectedRevision: operation.expectedRevision,
packages/workspace-fs/src/diff.ts:16:  operations: FsDiffOperation[];
packages/workspace-fs/src/diff.ts:34:      sha256: entry.sha256,
packages/workspace-fs/src/diff.ts:39:      return entry && entry.sha256 !== file.sha256;
packages/workspace-fs/src/diff.ts:53:    if (!deleted.sha256) continue;
packages/workspace-fs/src/diff.ts:54:    const createIndex = remainingCreates.findIndex((created) => created.sha256 === deleted.sha256);
packages/workspace-fs/src/diff.ts:68:    operations: [
packages/workspace-fs/src/scan.ts:5:import { assertSafeWorkspacePath, mediaTypeForPath, sha256 } from "./metadata";
packages/workspace-fs/src/scan.ts:14:  sha256: string;
packages/workspace-fs/src/scan.ts:42:      sha256: bytes ? sha256(bytes) : await sha256File(fullPath),
packages/workspace-fs/src/scan.ts:72:async function sha256File(path: string): Promise<string> {
packages/workspace-fs/src/scan.ts:73:  const hash = createHash("sha256");
packages/workspace-fs/node_modules/@dohc/workspace-api/src/workspaceApi.test.ts:160:          operations: [
packages/workspace-fs/node_modules/@dohc/workspace-api/src/workspaceApi.test.ts:212:        operations: [{
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:42:  operations: WorkspaceSyncOperation[];
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:52:  if (!Array.isArray(request.operations)) {
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:53:    throw new Error("sync apply requires an operations array");
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:59:  // failing operation path attached to the error, and prior operations may
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:61:  for (const operation of request.operations) {
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:63:      const file = await applyOperation(backend, actor, operation);
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:67:      attachOperationPath(error, operation);
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:78:  operation: WorkspaceSyncOperation,
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:80:  if (operation.op === "create") {
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:81:    if (operation.body !== undefined) {
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:83:        path: operation.path,
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:84:        kind: atomKind(operation.kind),
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:85:        body: operation.body,
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:89:      path: operation.path,
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:90:      kind: assetKind(operation.kind),
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:91:      mediaType: operation.mediaType ?? "application/octet-stream",
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:92:      bytes: bytesFromOperation(operation),
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:96:  if (operation.op === "update") {
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:97:    if (operation.body !== undefined) {
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:99:        path: operation.path,
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:100:        expectedRevision: operation.expectedRevision,
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:101:        body: operation.body,
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:105:      path: operation.path,
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:106:      kind: operation.kind ?? "file",
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:107:      mediaType: operation.mediaType ?? "application/octet-stream",
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:108:      bytes: bytesFromOperation(operation),
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:112:  if (operation.op === "delete") {
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:113:    await backend.deleteFile(actor, operation.path);
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:117:  if (dirname(operation.fromPath) !== dirname(operation.toPath)) {
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:120:  const toName = operation.toPath.includes("/")
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:121:    ? operation.toPath.slice(operation.toPath.lastIndexOf("/") + 1)
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:122:    : operation.toPath;
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:124:    fromPath: operation.fromPath,
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:126:    expectedRevision: operation.expectedRevision,
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:130:function bytesFromOperation(operation: Extract<WorkspaceSyncOperation, { op: "create" | "update" }>) {
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:131:  if (!operation.bytesBase64) {
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:132:    throw new Error("binary sync operations require bytesBase64");
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:134:  assertBase64Size(operation.bytesBase64, MAX_SYNC_ASSET_BYTES, "sync asset operation");
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:135:  return Buffer.from(operation.bytesBase64, "base64");
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:161:function attachOperationPath(error: unknown, operation: WorkspaceSyncOperation) {
packages/workspace-fs/node_modules/@dohc/workspace-api/src/routes/sync.ts:163:  const path = operation.op === "rename" ? operation.fromPath : operation.path;
packages/workspace-fs/node_modules/@dohc/workspace-core/src/changeSet.ts:23:  operation: "write" | "delete" | "rename";
packages/workspace-fs/node_modules/@dohc/workspace-core/src/watcher.ts:7:export interface WatcherEvent {
packages/workspace-fs/node_modules/@dohc/workspace-core/src/watcher.ts:9:  operation: WatcherOperation;
packages/workspace-fs/node_modules/@dohc/workspace-core/src/watcher.ts:10:  sha256?: string;
packages/workspace-fs/node_modules/@dohc/workspace-core/src/watcher.ts:19:export interface WatcherEventBatch {
packages/workspace-fs/node_modules/@dohc/workspace-core/src/paths.ts:95:// file operations the user's entire disk or home. Callers must use the
packages/workspace-fs/node_modules/@dohc/workspace-core/src/changeSet.test.ts:26:      operation: "write" as const,
packages/workspace-fs/node_modules/@dohc/workspace-core/src/changeSet.test.ts:43:      [{ path: "notes/today.md", operation: "write" }],
packages/workspace-core/src/changeSet.ts:23:  operation: "write" | "delete" | "rename";
packages/workspace-core/src/watcher.ts:7:export interface WatcherEvent {
packages/workspace-core/src/watcher.ts:9:  operation: WatcherOperation;
packages/workspace-core/src/watcher.ts:10:  sha256?: string;
packages/workspace-core/src/watcher.ts:19:export interface WatcherEventBatch {
packages/workspace-core/src/paths.ts:95:// file operations the user's entire disk or home. Callers must use the
packages/workspace-core/src/changeSet.test.ts:26:      operation: "write" as const,
packages/workspace-core/src/changeSet.test.ts:43:      [{ path: "notes/today.md", operation: "write" }],
packages/workspace-sync/src/batchedSync.test.ts:8:import { batchToChangeSet, createSettleBatcher } from "./batchedSync";
packages/workspace-sync/src/batchedSync.test.ts:41:    batcher.push({ path: "notes/today.md", operation: "update", sha256: "a" });
packages/workspace-sync/src/batchedSync.test.ts:72:        operation: "create",
packages/workspace-sync/src/batchedSync.test.ts:73:        sha256: `sha-${i}`,
packages/workspace-sync/src/batchedSync.test.ts:89:  it("collapses rapid edits to the same path into one event with the latest sha256", () => {
packages/workspace-sync/src/batchedSync.test.ts:99:    batcher.push({ path: "notes/today.md", operation: "create", sha256: "v1" });
packages/workspace-sync/src/batchedSync.test.ts:101:    batcher.push({ path: "notes/today.md", operation: "update", sha256: "v2" });
packages/workspace-sync/src/batchedSync.test.ts:103:    batcher.push({ path: "notes/today.md", operation: "update", sha256: "v3" });
packages/workspace-sync/src/batchedSync.test.ts:110:    expect(batches[0].events[0].sha256).toBe("v3");
packages/workspace-sync/src/batchedSync.test.ts:123:    batcher.push({ path: "a.md", operation: "update", sha256: "a" });
packages/workspace-sync/src/batchedSync.test.ts:128:    batcher.push({ path: "b.md", operation: "update", sha256: "b" });
packages/workspace-sync/src/batchedSync.test.ts:161:    batcher.push({ path: "notes/today.md", operation: "update", sha256: "a" });
packages/workspace-sync/src/batchedSync.test.ts:174:describe("batchToChangeSet", () => {
packages/workspace-sync/src/batchedSync.test.ts:182:    const set = batchToChangeSet(
packages/workspace-sync/src/batchedSync.test.ts:183:      batch([{ path: "notes/today.md", operation: "update", sha256: "a" }]),
packages/workspace-sync/src/batchedSync.test.ts:186:    expect(set.files).toEqual([{ path: "notes/today.md", operation: "write" }]);
packages/workspace-sync/src/batchedSync.test.ts:192:    const set = batchToChangeSet(
packages/workspace-sync/src/batchedSync.test.ts:194:        { path: "new.md", operation: "create", sha256: "n" },
packages/workspace-sync/src/batchedSync.test.ts:195:        { path: "edited.md", operation: "update", sha256: "e" },
packages/workspace-sync/src/batchedSync.test.ts:196:        { path: "gone.md", operation: "delete" },
packages/workspace-sync/src/batchedSync.test.ts:197:        { path: "to.md", operation: "rename", fromPath: "from.md" },
packages/workspace-sync/src/batchedSync.test.ts:202:      { path: "new.md", operation: "write" },
packages/workspace-sync/src/batchedSync.test.ts:203:      { path: "edited.md", operation: "write" },
packages/workspace-sync/src/batchedSync.test.ts:204:      { path: "gone.md", operation: "delete" },
packages/workspace-sync/src/batchedSync.test.ts:205:      { path: "to.md", operation: "rename" },
packages/workspace-sync/src/batchedSync.test.ts:212:      operation: "create" as const,
packages/workspace-sync/src/batchedSync.test.ts:213:      sha256: `sha-${i}`,
packages/workspace-sync/src/batchedSync.test.ts:215:    const set = batchToChangeSet(batch(events), {
packages/workspace-sync/src/batchedSync.test.ts:227:    const set = batchToChangeSet(
packages/workspace-sync/src/batchedSync.test.ts:228:      batch([{ path: "app.tsx", operation: "create", sha256: "a" }]),
packages/workspace-sync/src/batchedSync.test.ts:236:    const set = batchToChangeSet(
packages/workspace-sync/src/batchedSync.test.ts:237:      batch([{ path: "a.md", operation: "update", sha256: "a" }]),
packages/workspace-sync/src/batchedSync.test.ts:244:    const set = batchToChangeSet(
packages/workspace-sync/src/batchedSync.test.ts:246:        { path: "a.md", operation: "update", sha256: "a" },
packages/workspace-sync/src/batchedSync.test.ts:247:        { path: "b.md", operation: "update", sha256: "b" },
packages/workspace-sync/src/batchedSync.test.ts:248:        { path: "c.md", operation: "create", sha256: "c" },
packages/workspace-sync/src/batchedSync.test.ts:258:      operation: "create" as const,
packages/workspace-sync/src/batchedSync.test.ts:259:      sha256: `sha-${i}`,
packages/workspace-sync/src/batchedSync.test.ts:261:    const set = batchToChangeSet(batch(events), {
packages/workspace-sync/src/batchedSync.test.ts:270:    const set = batchToChangeSet(
packages/workspace-sync/src/batchedSync.test.ts:271:      batch([{ path: "a.md", operation: "update", sha256: "a" }]),
packages/workspace-sync/src/batchedSync.test.ts:278:    const set = batchToChangeSet(
packages/workspace-sync/src/batchedSync.test.ts:279:      batch([{ path: "a.md", operation: "update", sha256: "a" }]),
packages/workspace-sync/src/batchedSync.ts:14:  type WatcherEvent,
packages/workspace-sync/src/batchedSync.ts:15:  type WatcherEventBatch,
packages/workspace-sync/src/batchedSync.ts:40:  // a single event carrying the latest sha256. Map preserves insertion order,
packages/workspace-sync/src/batchedSync.ts:59:      // newest operation and sha256 (e.g. create then update -> latest update).
packages/workspace-sync/src/batchedSync.ts:75:// Watcher operations map onto the coarser change vocabulary: a create or an
packages/workspace-sync/src/batchedSync.ts:79:  switch (event.operation) {
packages/workspace-sync/src/batchedSync.ts:81:      return { path: event.path, operation: "delete" };
packages/workspace-sync/src/batchedSync.ts:83:      return { path: event.path, operation: "rename" };
packages/workspace-sync/src/batchedSync.ts:86:      return { path: event.path, operation: "write" };
packages/workspace-sync/src/batchedSync.ts:113:export function batchToChangeSet(
packages/workspace-sync/node_modules/@dohc/workspace-core/src/changeSet.ts:23:  operation: "write" | "delete" | "rename";
packages/workspace-sync/node_modules/@dohc/workspace-core/src/watcher.ts:7:export interface WatcherEvent {
packages/workspace-sync/node_modules/@dohc/workspace-core/src/watcher.ts:9:  operation: WatcherOperation;
packages/workspace-sync/node_modules/@dohc/workspace-core/src/watcher.ts:10:  sha256?: string;
packages/workspace-sync/node_modules/@dohc/workspace-core/src/watcher.ts:19:export interface WatcherEventBatch {
packages/workspace-sync/node_modules/@dohc/workspace-core/src/paths.ts:95:// file operations the user's entire disk or home. Callers must use the
packages/workspace-sync/node_modules/@dohc/workspace-core/src/changeSet.test.ts:26:      operation: "write" as const,
packages/workspace-sync/node_modules/@dohc/workspace-core/src/changeSet.test.ts:43:      [{ path: "notes/today.md", operation: "write" }],
packages/workspace-postgres/src/db/schema.ts:18:// database_operations.database_file_id -> database_files.id,
packages/workspace-postgres/src/db/schema.ts:30:  "database_operations",
grep: write error: Broken pipe

exec
/bin/bash -lc "sed -n '1,180p' packages/workspace-sync/src/batchedSync.ts && sed -n '1,80p' packages/workspace-core/src/watcher.ts && sed -n '1,100p' packages/workspace-core/src/changeSet.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
// Phase 5: turn the raw stream of file-watcher events into reviewable units.
// Two pieces: a settle-window batcher that waits for the workspace to go quiet
// before grouping events, and a mapper from a settled batch to a ChangeSet.
// An agent run touching 18 files becomes ONE batch and ONE change set, not 18.

import {
  addFileChanges,
  createChangeSet,
  type ChangeAuthor,
  type ChangeProvenance,
  type ChangeSet,
  type ChangeSetKind,
  type FileChange,
  type WatcherEvent,
  type WatcherEventBatch,
} from "@dohc/workspace-core";

export interface SettleBatcherOptions {
  // Quiet period (ms) the workspace must stay event-free before a batch emits.
  windowMs: number;
  // Injected clock so behavior is deterministic in tests and host-driven in
  // production. Stamps each event's arrival time.
  now: () => number;
  onBatch: (batch: WatcherEventBatch) => void;
}

export interface SettleBatcher {
  push(event: WatcherEvent): void;
  // Probe called by the host (e.g. from a real interval) with the current time.
  // Emits the pending batch when the workspace has been quiet for windowMs.
  tick(currentMs: number): void;
  // Emit any pending batch right now, ignoring the window (e.g. on shutdown).
  flush(): void;
}

export function createSettleBatcher(
  opts: SettleBatcherOptions,
): SettleBatcher {
  // Pending events keyed by path so rapid edits to the same file collapse into
  // a single event carrying the latest sha256. Map preserves insertion order,
  // so the emitted batch keeps first-seen ordering of paths.
  const pending = new Map<string, WatcherEvent>();
  let lastEventMs = 0;

  function emit(settledAtMs: number): void {
    if (pending.size === 0) return;
    const batch: WatcherEventBatch = {
      settledAtMs,
      windowMs: opts.windowMs,
      events: Array.from(pending.values()),
    };
    pending.clear();
    opts.onBatch(batch);
  }

  return {
    push(event: WatcherEvent): void {
      // A later event for the same path supersedes the earlier one: keep the
      // newest operation and sha256 (e.g. create then update -> latest update).
      pending.set(event.path, event);
      lastEventMs = opts.now();
    },
    tick(currentMs: number): void {
      if (pending.size === 0) return;
      if (currentMs - lastEventMs >= opts.windowMs) {
        emit(currentMs);
      }
    },
    flush(): void {
      emit(opts.now());
    },
  };
}

// Watcher operations map onto the coarser change vocabulary: a create or an
// update both land as a "write" (the file now has new content); delete and
// rename pass through directly.
function toFileChange(event: WatcherEvent): FileChange {
  switch (event.operation) {
    case "delete":
      return { path: event.path, operation: "delete" };
    case "rename":
      return { path: event.path, operation: "rename" };
    case "create":
    case "update":
      return { path: event.path, operation: "write" };
  }
}

// Provenance source and change-set kind share the same vocabulary, so the kind
// is just the source when known, defaulting to a plain user edit.
function kindFromProvenance(provenance?: ChangeProvenance): ChangeSetKind {
  return provenance?.source ?? "user-edit";
}

// A human-friendly default summary derived from the batch. Imports read
// "Imported N files"; everything else reads "Edited N files".
function defaultSummary(
  count: number,
  provenance?: ChangeProvenance,
): string {
  const noun = count === 1 ? "file" : "files";
  const verb = provenance?.source === "import" ? "Imported" : "Edited";
  return `${verb} ${count} ${noun}`;
}

export interface BatchToChangeSetInput {
  author: ChangeAuthor;
  summary?: string;
  provenance?: ChangeProvenance;
}

export function batchToChangeSet(
  batch: WatcherEventBatch,
  input: BatchToChangeSetInput,
): ChangeSet {
  const files = batch.events.map(toFileChange);
  const set = createChangeSet({
    kind: kindFromProvenance(input.provenance),
    author: input.author,
    summary: input.summary ?? defaultSummary(files.length, input.provenance),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  return addFileChanges(set, files);
}
// Phase 5 shared contract: the watcher event shape that workspace-fs emits
// and workspace-sync batches. Defined here so the lanes code against one
// interface instead of inventing parallel change models.

export type WatcherOperation = "create" | "update" | "delete" | "rename";

export interface WatcherEvent {
  path: string;
  operation: WatcherOperation;
  sha256?: string;
  previousSha256?: string;
  // For rename, the path the file moved from.
  fromPath?: string;
}

// A settled group of events: workspace-sync accumulates raw events and emits
// one batch once the workspace has been quiet for `windowMs`. One batch maps
// to one change set, so an agent run touching 18 files is a single unit.
export interface WatcherEventBatch {
  settledAtMs: number;
  windowMs: number;
  events: WatcherEvent[];
}
export type ChangeSetKind =
  | "user-edit"
  | "agent-run"
  | "import"
  | "sync"
  | "app-build";

export type BoundaryCrossing =
  | "public-share"
  | "external-export"
  | "permission-change"
  | "bulk-delete"
  | "app-trust"
  | "private-to-shared"
  | "unmergeable-overwrite";

export type ChangeAuthor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string; onBehalfOf: string };

export interface FileChange {
  path: string;
  operation: "write" | "delete" | "rename";
}

// Where a change came from — a prompt, an import source, an agent run — so
// history can answer "why did this change?" not just "what changed?".
export interface ChangeProvenance {
  source: "user-edit" | "agent-run" | "import" | "sync" | "app-build";
  prompt?: string;
  agentRunId?: string;
  importPath?: string;
}

export interface ChangeSet {
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  files: FileChange[];
  boundaryCrossings: BoundaryCrossing[];
  provenance?: ChangeProvenance;
}

export function createChangeSet(input: {
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  provenance?: ChangeProvenance;
}): ChangeSet {
  return {
    kind: input.kind,
    author: input.author,
    summary: input.summary,
    files: [],
    boundaryCrossings: [],
    ...(input.provenance ? { provenance: input.provenance } : {}),
  };
}

export function addFileChanges(set: ChangeSet, files: FileChange[]): ChangeSet {
  return { ...set, files: [...set.files, ...files] };
}

export function addBoundaryCrossing(
  set: ChangeSet,
  crossing: BoundaryCrossing,
): ChangeSet {
  return { ...set, boundaryCrossings: [...set.boundaryCrossings, crossing] };
}

// Liberal by default: ordinary edits sync freely; only genuine boundary
// crossings need a human to look.
export function requiresReview(set: ChangeSet): boolean {
  return set.boundaryCrossings.length > 0;
}

exec
/bin/bash -lc 'grep -R "createChangeSetStore" -n --exclude-dir=node_modules --exclude-dir=.git .' in /home/ice/dev/dohc
 succeeded in 0ms:
./apps/desktop/src/workspaces/workspaceWatcher.ts:11:import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
./apps/desktop/src/workspaces/workspaceWatcher.ts:70:  const store = createChangeSetStore(workspace.rootPath);
./apps/desktop/src/workspaces/workspaceWatcher.ts:102:export { createChangeSetStore, humanSummary };
./apps/desktop/src/workspaces/workspaceActivity.ts:8:  createChangeSetStore,
./apps/desktop/src/workspaces/workspaceActivity.ts:66:    const store = createChangeSetStore(workspace.rootPath);
./apps/desktop/dist/main/main.js:2313:function createChangeSetStore(rootDir) {
./apps/desktop/dist/main/main.js:2457:	const store = createChangeSetStore(workspace.rootPath);
./apps/desktop/dist/main/main.js:2514:		return (await createChangeSetStore(workspace.rootPath).list()).map((record) => ({
./packages/workspace-history/src/changeSetStore.ts:70:export function createChangeSetStore(rootDir: string): ChangeSetStore {
./packages/workspace-history/src/changeSetStore.test.ts:11:import { createChangeSetStore, humanSummary } from "./changeSetStore";
./packages/workspace-history/src/changeSetStore.test.ts:60:    const store = createChangeSetStore(root);
./packages/workspace-history/src/changeSetStore.test.ts:88:    const store = createChangeSetStore(root);
./packages/workspace-history/src/changeSetStore.test.ts:93:    const store = createChangeSetStore(root);
./packages/workspace-history/src/changeSetStore.test.ts:106:    const store = createChangeSetStore(root);
./packages/workspace-history/src/changeSetStore.test.ts:126:    const store = createChangeSetStore(root);
./packages/workspace-history/src/changeSetStore.test.ts:144:    const store = createChangeSetStore(root);
./packages/workspace-history/src/changeSetStore.test.ts:156:    const store = createChangeSetStore(root);
./packages/workspace-history/src/changeSetStore.test.ts:167:    const store = createChangeSetStore(root);
./packages/workspace-history/src/changeSetStore.test.ts:180:    const store = createChangeSetStore(root);
./packages/workspace-history/src/changeSetStore.test.ts:197:    const store = createChangeSetStore(root);
./docs/superpowers/reviews/codex/phase-05.md:159:+  createChangeSetStore,
./docs/superpowers/reviews/codex/phase-05.md:217:+    const store = createChangeSetStore(workspace.rootPath);
./docs/superpowers/reviews/codex/phase-05.md:253:+import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
./docs/superpowers/reviews/codex/phase-05.md:312:+  const store = createChangeSetStore(workspace.rootPath);
./docs/superpowers/reviews/codex/phase-05.md:341:+export { createChangeSetStore, humanSummary };
./docs/superpowers/reviews/codex/phase-05.md:605:+export function createChangeSetStore(rootDir: string): ChangeSetStore {
./docs/superpowers/reviews/codex/phase-05.md:1754:+import { createChangeSetStore, humanSummary } from "./changeSetStore";
./docs/superpowers/reviews/codex/phase-05.md:2317:     8	  createChangeSetStore,
./docs/superpowers/reviews/codex/phase-05.md:2375:    66	    const store = createChangeSetStore(workspace.rootPath);
./docs/superpowers/reviews/codex/phase-05.md:2405:     7	import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
./docs/superpowers/reviews/codex/phase-05.md:2464:    66	  const store = createChangeSetStore(workspace.rootPath);
./docs/superpowers/reviews/codex/phase-05.md:2493:    95	export { createChangeSetStore, humanSummary };
./docs/superpowers/reviews/codex/phase-05.md:2745:    61	export function createChangeSetStore(rootDir: string): ChangeSetStore {
./docs/superpowers/reviews/codex/phase-05-fix.md:125: import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
./docs/superpowers/reviews/codex/phase-05-fix.md:240:+    const store = createChangeSetStore(root);
./docs/superpowers/reviews/codex/phase-05-fix.md:273: export function createChangeSetStore(rootDir: string): ChangeSetStore {
./docs/superpowers/reviews/codex/phase-05-fix.md:276:@@ -67,40 +76,58 @@ export function createChangeSetStore(rootDir: string): ChangeSetStore {
./docs/superpowers/reviews/codex/phase-05-fix.md:644:export function createChangeSetStore(rootDir: string): ChangeSetStore {
./docs/superpowers/reviews/codex/phase-05-fix.md:783:import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
./docs/superpowers/reviews/codex/phase-05-fix.md:842:  const store = createChangeSetStore(workspace.rootPath);
./docs/superpowers/reviews/codex/phase-05-fix.md:874:export { createChangeSetStore, humanSummary };

exec
/bin/bash -lc "sed -n '1,140p' apps/desktop/src/workspaces/workspaceActivity.ts && sed -n '1,260p' packages/workspace-history/src/changeSetStore.test.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import { deriveSyncStatus, type SyncStatus } from "@dohc/workspace-core";
import type {
  ChangeSetRecord,
  SyncStatusResult,
} from "../ipc/bridgeContract";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import {
  createChangeSetStore,
  humanSummary,
  startWorkspaceWatch,
  type WorkspaceWatchHandle,
} from "./workspaceWatcher";

interface WatchedWorkspace {
  workspace: CreatedWorkspace;
  handle: WorkspaceWatchHandle;
  inFlight: boolean;
  lastSyncedAtMs: number | null;
}

// Owns the live file-watch → history pipeline per workspace and the derived
// sync status. The desktop layer opens a workspace once; subsequent timeline
// and status reads are served from here, and activity pushes notify the UI.
export function createWorkspaceActivity(notify: () => void) {
  const watched = new Map<string, WatchedWorkspace>();

  function statusFor(workspaceId: string): SyncStatus {
    const w = watched.get(workspaceId);
    // Local-only today: nothing is "pending" (edits save immediately) and no
    // cloud, so state is synced unless a batch is being recorded. Cloud and
    // conflict states become reachable in Phases 9/10 through the same
    // deriveSyncStatus inputs.
    return deriveSyncStatus({
      pendingChangeCount: 0,
      inFlight: w?.inFlight ?? false,
      hasConflict: false,
      cloudEnabled: false,
      cloudConnected: false,
      lastSyncedAtMs: w?.lastSyncedAtMs ?? null,
    });
  }

  function open(workspace: CreatedWorkspace): SyncStatusResult {
    if (!watched.has(workspace.workspaceId)) {
      const entry: WatchedWorkspace = {
        workspace,
        inFlight: false,
        lastSyncedAtMs: null,
        handle: { stop: () => {} },
      };
      watched.set(workspace.workspaceId, entry);
      entry.handle = startWorkspaceWatch(workspace, {
        onRecorded: () => {
          entry.inFlight = false;
          entry.lastSyncedAtMs = Date.now();
          notify();
        },
      });
    }
    return statusFor(workspace.workspaceId);
  }

  async function listChangeSets(
    workspace: CreatedWorkspace,
  ): Promise<ChangeSetRecord[]> {
    const store = createChangeSetStore(workspace.rootPath);
    const records = await store.list();
    return records.map((record) => ({
      id: record.id,
      recordedAtMs: record.recordedAtMs,
      kind: record.kind,
      author: record.author,
      summary: record.summary,
      humanSummary: humanSummary(record),
      fileCount: record.files.length,
    }));
  }

  function getStatus(workspaceId: string): SyncStatusResult {
    return statusFor(workspaceId);
  }

  function stopAll(): void {
    for (const w of watched.values()) w.handle.stop();
    watched.clear();
  }

  return { open, listChangeSets, getStatus, stopAll };
}
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addBoundaryCrossing,
  addFileChanges,
  createChangeSet,
  type ChangeSet,
} from "@dohc/workspace-core";
import { createChangeSetStore, humanSummary } from "./changeSetStore";

const userAuthor = { kind: "user" as const, userId: "user-1" };
const agentAuthor = {
  kind: "agent" as const,
  agentId: "codex-local",
  onBehalfOf: "Maya",
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-history-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function userEdit(): ChangeSet {
  return addFileChanges(
    createChangeSet({
      kind: "user-edit",
      author: userAuthor,
      summary: "Edited today's notes",
      provenance: { source: "user-edit" },
    }),
    [{ path: "notes/today.md", operation: "write" }],
  );
}

function agentImport(): ChangeSet {
  const files = Array.from({ length: 18 }, (_, i) => ({
    path: `finance/import/file-${i}.csv`,
    operation: "write" as const,
  }));
  return addFileChanges(
    createChangeSet({
      kind: "import",
      author: agentAuthor,
      summary: "Imported transactions",
      provenance: { source: "import", importPath: "/tmp/transactions" },
    }),
    files,
  );
}

describe("changeSetStore persistence", () => {
  it("writes an inspectable JSON file under .dohc/history and round-trips via get", async () => {
    const store = createChangeSetStore(root);
    const recorded = await store.record(userEdit(), {
      id: "abc",
      recordedAtMs: 1000,
    });

    // The per-record file is plain, pretty JSON anyone can open and read.
    const historyDir = join(root, ".dohc", "history");
    const entries = await readdir(historyDir);
    const recordFile = entries.find((name) => name === "1000-abc.json");
    expect(recordFile).toBeDefined();

    const raw = await readFile(join(historyDir, recordFile!), "utf8");
    // Pretty-printed (indented), inspectable JSON — not a packed blob.
    expect(raw).toContain("\n  ");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe("abc");
    expect(parsed.kind).toBe("user-edit");

    const got = await store.get("abc");
    expect(got).not.toBeNull();
    expect(got).toEqual(recorded);
    expect(got!.files).toHaveLength(1);
    expect(got!.author).toEqual(userAuthor);
    expect(got!.provenance).toEqual({ source: "user-edit" });
  });

  it("returns null from get for an unknown id", async () => {
    const store = createChangeSetStore(root);
    expect(await store.get("nope")).toBeNull();
  });

  it("lists the timeline newest first", async () => {
    const store = createChangeSetStore(root);
    await store.record(userEdit(), { id: "first", recordedAtMs: 1000 });
    await store.record(agentImport(), { id: "second", recordedAtMs: 2000 });
    await store.record(userEdit(), { id: "third", recordedAtMs: 3000 });

    const timeline = await store.list();
    expect(timeline.map((r) => r.id)).toEqual(["third", "second", "first"]);
    // Each listed record is the full record read back from its own file.
    expect(timeline[1].files).toHaveLength(18);
    expect(timeline[1].kind).toBe("import");
  });

  it("appends to an ordered index.json carrying lightweight summaries", async () => {
    const store = createChangeSetStore(root);
    await store.record(userEdit(), { id: "first", recordedAtMs: 1000 });
    await store.record(agentImport(), { id: "second", recordedAtMs: 2000 });

    const indexPath = join(root, ".dohc", "history", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    expect(Array.isArray(index)).toBe(true);
    expect(index).toHaveLength(2);
    const entry = index.find((e: { id: string }) => e.id === "second");
    expect(entry).toMatchObject({
      id: "second",
      recordedAtMs: 2000,
      kind: "import",
      summary: "Imported transactions",
      fileCount: 18,
    });
    expect(entry.author).toEqual(agentAuthor);
  });

  it("records carry kind, author, provenance, and boundary crossings", async () => {
    const store = createChangeSetStore(root);
    const set = addBoundaryCrossing(agentImport(), "external-export");
    const recorded = await store.record(set, { id: "x", recordedAtMs: 5000 });
    expect(recorded.kind).toBe("import");
    expect(recorded.author).toEqual(agentAuthor);
    expect(recorded.provenance).toEqual({
      source: "import",
      importPath: "/tmp/transactions",
    });
    expect(recorded.boundaryCrossings).toContain("external-export");

    const got = await store.get("x");
    expect(got!.boundaryCrossings).toContain("external-export");
  });
});

describe("humanSummary", () => {
  it("attributes an agent run to the person it acted on behalf of", async () => {
    const store = createChangeSetStore(root);
    const recorded = await store.record(agentImport(), {
      id: "agent",
      recordedAtMs: 1000,
    });
    const line = humanSummary(recorded);
    expect(line).toContain("Maya");
    expect(line).toContain("agent");
    expect(line).toContain("18");
  });

  it("attributes a user edit to the user, not an agent", async () => {
    const store = createChangeSetStore(root);
    const recorded = await store.record(userEdit(), {
      id: "user",
      recordedAtMs: 1000,
    });
    const line = humanSummary(recorded);
    expect(line.toLowerCase()).toContain("you");
    expect(line).not.toContain("agent");
  });

  it("produces different attributed summaries for a user edit vs an agent run", async () => {
    const store = createChangeSetStore(root);
    const userRec = await store.record(userEdit(), {
      id: "u",
      recordedAtMs: 1000,
    });
    const agentRec = await store.record(agentImport(), {
      id: "a",
      recordedAtMs: 2000,
    });
    expect(humanSummary(userRec)).not.toBe(humanSummary(agentRec));
  });

  it("never contains git conflict markers", async () => {
    const store = createChangeSetStore(root);
    const userRec = await store.record(userEdit(), {
      id: "u",
      recordedAtMs: 1000,
    });
    const agentRec = await store.record(agentImport(), {
      id: "a",
      recordedAtMs: 2000,
    });
    expect(humanSummary(userRec)).not.toMatch(/<{7}|>{7}|={7}/);
    expect(humanSummary(agentRec)).not.toMatch(/<{7}|>{7}|={7}/);
  });

  it("does not drop entries when records are fired concurrently", async () => {
    // The live watcher fires record() fire-and-forget; without serialization
    // two close-together records race on index.json and the second clobbers
    // the first's entry, silently dropping it from the timeline.
    const store = createChangeSetStore(root);
    const writes = Array.from({ length: 25 }, (_, i) =>
      store.record(userEdit(), { id: `c${i}`, recordedAtMs: 1000 + i }),
    );
    await Promise.all(writes);
    const listed = await store.list();
    expect(listed).toHaveLength(25);
    expect(new Set(listed.map((r) => r.id)).size).toBe(25);
  });
});

exec
/bin/bash -lc 'git show --no-patch --format=fuller d87f2f1' in /home/ice/dev/dohc
 succeeded in 0ms:
commit d87f2f11c2e4c00761437a5c419817ffe5e4477d
Author:     Ice de Vera <iestyndevera@gmail.com>
AuthorDate: Wed Jun 10 19:46:53 2026 +0800
Commit:     Ice de Vera <iestyndevera@gmail.com>
CommitDate: Wed Jun 10 19:46:53 2026 +0800

    phase5(fix): close history data-loss + watcher findings
    
    Verifier + Codex both caught a silent history-loss bug: concurrent
    fire-and-forget record() calls raced on index.json and the second
    clobbered the first's entry. Fixed: serialize record() per store
    instance + atomic temp+rename index write (25-concurrent-records
    regression test). Plus three watcher fixes: SQLite sidecars are no
    longer ignored (WAL-only writes were invisible) — they pass through
    and collapse to one base-db update; followSymlinks:false; flush
    pending changes on stop. Rename-identity detection deferred to Phase 9
    (needs the sync engine's prior-content index). All suites + E2E green.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

exec
/bin/bash -lc "nl -ba apps/desktop/src/workspaces/workspaceWatcher.ts | sed -n '76,90p'; nl -ba packages/workspace-fs/src/watchEvents.ts | sed -n '82,98p'" in /home/ice/dev/dohc
 succeeded in 0ms:
    76	      void (async () => {
    77	        // Defense in depth: never record changes to .dohc/** (our own history
    78	        // writes, manifest, cache) — recording them would feed back into the
    79	        // watcher. The watcher already ignores these; this guards a leak.
    80	        const userPaths = paths.filter((p) => !shouldIgnoreWatchPath(p));
    81	        if (userPaths.length === 0) return;
    82	        const rawEvents = await pathsToEvents(workspace.rootPath, userPaths);
    83	        // Fold SQLite WAL/journal/shm churn into a single base-db update so the
    84	        // history shows "wallet.sqlite changed", never the transient sidecars.
    85	        const events = collapseSqliteSidecars(rawEvents);
    86	        if (events.length === 0) return;
    87	        const batch: WatcherEventBatch = {
    88	          settledAtMs: now(),
    89	          windowMs: options.settleMs ?? 500,
    90	          events,
    82	  // later base or sidecar event for the same db folds into that one slot.
    83	  const baseDbIndex = new Map<string, number>();
    84	
    85	  const ensureBaseDbUpdate = (dbPath: string): void => {
    86	    const existing = baseDbIndex.get(dbPath);
    87	    if (existing !== undefined) {
    88	      // Force "update": a checkpoint may have arrived as create/delete, but the
    89	      // database content changing is always an update from the user's view.
    90	      out[existing] = { path: dbPath, operation: "update" };
    91	      return;
    92	    }
    93	    baseDbIndex.set(dbPath, out.length);
    94	    out.push({ path: dbPath, operation: "update" });
    95	  };
    96	
    97	  for (const event of events) {
    98	    const sidecarBase = baseDbPath(event.path);

exec
/bin/bash -lc 'git diff --unified=0 d87f2f1''^ d87f2f1 -- packages/workspace-fs/src/watchEvents.ts apps/desktop/src/workspaces/workspaceWatcher.ts' in /home/ice/dev/dohc
 succeeded in 0ms:
diff --git a/apps/desktop/src/workspaces/workspaceWatcher.ts b/apps/desktop/src/workspaces/workspaceWatcher.ts
index 3df14c6..75bcd0b 100644
--- a/apps/desktop/src/workspaces/workspaceWatcher.ts
+++ b/apps/desktop/src/workspaces/workspaceWatcher.ts
@@ -6 +6,5 @@ import type {
-import { shouldIgnoreWatchPath, watchWorkspaceEvents } from "@dohc/workspace-fs";
+import {
+  collapseSqliteSidecars,
+  shouldIgnoreWatchPath,
+  watchWorkspaceEvents,
+} from "@dohc/workspace-fs";
@@ -78 +82,4 @@ export function startWorkspaceWatch(
-        const events = await pathsToEvents(workspace.rootPath, userPaths);
+        const rawEvents = await pathsToEvents(workspace.rootPath, userPaths);
+        // Fold SQLite WAL/journal/shm churn into a single base-db update so the
+        // history shows "wallet.sqlite changed", never the transient sidecars.
+        const events = collapseSqliteSidecars(rawEvents);
diff --git a/packages/workspace-fs/src/watchEvents.ts b/packages/workspace-fs/src/watchEvents.ts
index 7f2afbd..3d5372c 100644
--- a/packages/workspace-fs/src/watchEvents.ts
+++ b/packages/workspace-fs/src/watchEvents.ts
@@ -42,3 +42,7 @@ const EDITOR_NOISE = [
-// a user file op. Covers the reserved .dohc/ tree (including its cache),
-// editor scratch files, and SQLite sidecars — see the regexes above for why
-// each is anchored to avoid false positives on real user files.
+// a user file op. Covers the reserved .dohc/ tree (including its cache) and
+// editor scratch files. NOTE: SQLite sidecars (.db-wal/-journal/-shm) are NOT
+// ignored here — a SQLite write often touches only the WAL while the base .db
+// is untouched until checkpoint, so ignoring sidecars would make the change
+// INVISIBLE. Instead the pipeline lets sidecar events through and folds them
+// into one base-db update via collapseSqliteSidecars, so the sidecar path
+// never surfaces but the database change is never missed.
@@ -57,2 +60,0 @@ export function shouldIgnoreWatchPath(relativePath: string): boolean {
-  if (SQLITE_SIDECAR.test(path)) return true;
-
@@ -144,0 +147,3 @@ export function watchWorkspaceEvents(
+    // Never follow symlinks out of the workspace — a symlinked dir would let
+    // the watcher observe (and record) files outside the workspace root.
+    followSymlinks: false,
@@ -184,0 +190,3 @@ export function watchWorkspaceEvents(
+    // Flush any settled-but-not-yet-emitted changes so a save right before
+    // stop/quit is recorded into history rather than silently dropped.
+    flush();

exec
/bin/bash -lc "node - <<'NODE'
function collapse(events){
 const SQLITE_SIDECAR=/"'^(.*'"\\.(?:db|sqlite))-(?:wal|shm|journal)"'$/i; const out=[]; const map=new Map(); const toPosix=p=>p.replaceAll('"'\\\\','/'); const baseDbPath=p=>{const m=SQLITE_SIDECAR.exec(toPosix(p)); return m?m[1]:undefined}; const ensure=(db)=>{const existing=map.get(db); if(existing"'!==undefined){out[existing]={path:db,operation:'"'update'};return;} map.set(db,out.length); out.push({path:db,operation:'update'});}; for(const e of events){const side=baseDbPath(e.path); if(side){ensure(side); continue;} const norm=toPosix(e.path); if(map.has(norm)){ensure(norm); continue;} if(/\\.(?:db|sqlite)"'$/i.test(norm)){map.set(norm,out.length);} out.push(e);} return out;
}
console.log(collapse([{path:'"'finance/wallet.db', operation:'delete'},{path:'finance/wallet.db-wal', operation:'delete'}]));
NODE" in /home/ice/dev/dohc
 succeeded in 0ms:
[ { path: 'finance/wallet.db', operation: 'update' } ]

exec
/bin/bash -lc "cat package.json | sed -n '1,220p'; grep -R \"chokidar\" -n package.json packages/*/package.json apps/*/package.json pnpm-lock.yaml | head -100" in /home/ice/dev/dohc
 succeeded in 0ms:
{
  "name": "dohc",
  "private": true,
  "type": "module",
  "engines": {
    "node": "^20.19.0 || ^22.13.0 || >=24.0.0",
    "pnpm": "10.24.0"
  },
  "scripts": {
    "dev": "node scripts/dev-sync.mjs && pnpm --filter @dohc/web --if-present run dev",
    "dev:app": "pnpm --filter @dohc/web --if-present run dev",
    "dev:desktop": "pnpm --filter @dohc/desktop dev",
    "build:desktop": "pnpm --filter @dohc/desktop build",
    "test:desktop": "pnpm --filter @dohc/desktop test",
    "test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts",
    "smoke:desktop": "node apps/desktop/scripts/smoke-test.mjs",
    "dev:sync": "node scripts/dev-sync.mjs",
    "dev:hocuspocus": "pnpm --filter @dohc/hocuspocus --if-present run dev",
    "dev:workspace-api": "pnpm --filter @dohc/workspace-api dev",
    "dev:postgres": "docker compose -f docker-compose.dev.yml up -d postgres minio",
    "build": "pnpm -r --if-present build",
    "start": "pnpm --filter @dohc/web --if-present run start",
    "preview": "pnpm --filter @dohc/web --if-present run preview",
    "reset:dev": "node scripts/reset-dev-data.mjs",
    "reset:postgres": "node scripts/reset-postgres-dev-data.mjs",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    "test:e2e": "playwright test",
    "test:hocuspocus:integration": "pnpm --filter @dohc/hocuspocus run test:integration",
    "sync:local": "pnpm --filter @dohc/workspace-fs sync",
    "lint": "pnpm -r --if-present lint",
    "check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs",
    "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs",
    "check:self-host": "node scripts/check-self-host.mjs",
    "check:debt": "node scripts/check-tech-debt.mjs"
  },
  "packageManager": "pnpm@10.24.0",
  "devDependencies": {
    "@playwright/test": "^1.60.0"
  }
}
packages/workspace-fs/package.json:16:    "chokidar": "^5.0.0"
pnpm-lock.yaml:130:        version: 3.0.260429-beta(chokidar@5.0.0)(dotenv@16.6.1)(drizzle-orm@0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.21.0))(jiti@2.7.0)(lru-cache@11.5.0)(rollup@4.60.4)(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
pnpm-lock.yaml:362:      chokidar:
pnpm-lock.yaml:2847:  chokidar@4.0.3:
pnpm-lock.yaml:2851:  chokidar@5.0.0:
pnpm-lock.yaml:5022:      chokidar: ^4 || ^5
pnpm-lock.yaml:5061:      chokidar:
pnpm-lock.yaml:6725:      chokidar: 5.0.0
pnpm-lock.yaml:7560:  chokidar@4.0.3:
pnpm-lock.yaml:7564:  chokidar@5.0.0:
pnpm-lock.yaml:9106:  nitro@3.0.260429-beta(chokidar@5.0.0)(dotenv@16.6.1)(drizzle-orm@0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.21.0))(jiti@2.7.0)(lru-cache@11.5.0)(rollup@4.60.4)(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)):
pnpm-lock.yaml:9121:      unstorage: 2.0.0-alpha.7(chokidar@5.0.0)(db0@0.3.4(drizzle-orm@0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.21.0)))(lru-cache@11.5.0)(ofetch@2.0.0-alpha.3)
pnpm-lock.yaml:9147:      - chokidar
pnpm-lock.yaml:9886:      chokidar: 4.0.3
pnpm-lock.yaml:9999:  unstorage@2.0.0-alpha.7(chokidar@5.0.0)(db0@0.3.4(drizzle-orm@0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.21.0)))(lru-cache@11.5.0)(ofetch@2.0.0-alpha.3):
pnpm-lock.yaml:10001:      chokidar: 5.0.0

exec
/bin/bash -lc "node -e \"const fs=require('fs'); const p='packages/workspace-fs/node_modules/chokidar/esm/index.d.ts'; console.log(fs.existsSync(p)); if(fs.existsSync(p)) console.log(fs.readFileSync(p,'utf8').slice(0,4000))\"" in /home/ice/dev/dohc
 succeeded in 0ms:
false

exec
/bin/bash -lc 'ls packages/workspace-fs/node_modules/chokidar && find packages/workspace-fs/node_modules/chokidar -maxdepth 2 -type f | head -20' in /home/ice/dev/dohc
 exited 2 in 0ms:
ls: cannot access 'packages/workspace-fs/node_modules/chokidar': No such file or directory

exec
/bin/bash -lc "ls -la packages/workspace-fs | sed -n '1,120p'; find node_modules -maxdepth 3 -name chokidar -type d | head -20" in /home/ice/dev/dohc
 succeeded in 0ms:
total 96
drwxr-xr-x  4 ice ice  4096 Jun 10 19:23 .
drwxr-xr-x 11 ice ice  4096 Jun 10 19:21 ..
drwxr-xr-x  4 ice ice  4096 Jun  9 12:45 node_modules
-rw-r--r--  1 ice ice   551 Jun 10 19:23 package.json
drwxr-xr-x  2 ice ice  4096 Jun 10 19:45 src
-rw-r--r--  1 ice ice    74 Jun 10 12:11 tsconfig.json
-rw-r--r--  1 ice ice 73006 Jun 10 19:45 tsconfig.tsbuildinfo
node_modules/tsdown/node_modules/chokidar
node_modules/chokidar

exec
/bin/bash -lc 'grep -R "followSymlinks" -n node_modules/chokidar | head -20' in /home/ice/dev/dohc
 succeeded in 0ms:
node_modules/chokidar/handler.js:416:        if (!this.fsw.options.followSymlinks) {
node_modules/chokidar/handler.js:587:            const follow = this.fsw.options.followSymlinks;
node_modules/chokidar/index.d.ts:13:    followSymlinks: boolean;
node_modules/chokidar/index.d.ts:66:    followSymlinks: boolean;
node_modules/chokidar/README.md:131:  followSymlinks: true,
node_modules/chokidar/README.md:160:- `followSymlinks` (default: `true`). When `false`, only the
node_modules/chokidar/index.js:185:    followSymlinks;
node_modules/chokidar/index.js:198:        this.followSymlinks = follow;
node_modules/chokidar/index.js:266:            followSymlinks: true,
node_modules/chokidar/index.js:678:        return new WatchHelper(path, this.options.followSymlinks, this);

exec
/bin/bash -lc "cat apps/desktop/package.json && find apps/desktop -maxdepth 2 -type f | sort | sed -n '1,120p'" in /home/ice/dev/dohc
 succeeded in 0ms:
{
  "name": "@dohc/desktop",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "dist/main/main.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@electron/fuses": "^2.1.2",
    "@tailwindcss/vite": "^4.3.0",
    "@testing-library/dom": "^10.4.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "@types/node": "^22.19.19",
    "@types/react": "^19.2.15",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.2",
    "electron": "^42.4.0",
    "electron-builder": "^26.15.2",
    "electron-vite": "^5.0.0",
    "jsdom": "^29.1.1",
    "tailwindcss": "^4.3.0",
    "typescript": "^5.9.3",
    "vite": "^8.0.14",
    "vitest": "^2.1.9"
  },
  "dependencies": {
    "@dohc/brand": "workspace:*",
    "@dohc/workspace-core": "workspace:*",
    "@dohc/workspace-fs": "workspace:*",
    "@dohc/workspace-history": "workspace:*",
    "@dohc/workspace-sync": "workspace:*",
    "electron-updater": "^6.8.9",
    "lucide-react": "^1.16.0",
    "react": "^19.2.6",
    "react-dom": "^19.2.6",
    "zod": "^3.25.76"
  }
}
apps/desktop/e2e/desktopLaunch.spec.ts
apps/desktop/e2e/firstRunWorkspace.spec.ts
apps/desktop/e2e/launch.ts
apps/desktop/electron.vite.config.ts
apps/desktop/package.json
apps/desktop/playwright.config.ts
apps/desktop/scripts/smoke-test.mjs
apps/desktop/src/main.ts
apps/desktop/src/preload.ts
apps/desktop/tsconfig.json
apps/desktop/tsconfig.tsbuildinfo
apps/desktop/vitest.config.ts

exec
/bin/bash -lc 'git ls-files apps/desktop/dist/main/main.js && git diff d87f2f1''^ d87f2f1 -- apps/desktop/dist/main/main.js | head -20 && grep -n "followSymlinks" apps/desktop/dist/main/main.js | head' in /home/ice/dev/dohc
 succeeded in 0ms:
1383:		if (!this.fsw.options.followSymlinks) {
1518:			const follow = this.fsw.options.followSymlinks;
1683:	followSymlinks;
1695:		this.followSymlinks = follow;
1762:			followSymlinks: true,
2081:		return new WatchHelper(path, this.options.followSymlinks, this);
2256:		followSymlinks: false,

exec
/bin/bash -lc 'git status --short apps/desktop/dist/main/main.js; git ls-files apps/desktop/dist/main/main.js --error-unmatch >/dev/null 2>&1; echo tracked:$?' in /home/ice/dev/dohc
 succeeded in 0ms:
tracked:1

exec
/bin/bash -lc "grep -R \"sqlite\\|sidecar\\|watch\" -n docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md | head -80" in /home/ice/dev/dohc
 succeeded in 0ms:
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:11:**Architecture:** Workspaces are real folders on disk. The desktop app is the primary product surface and runs a local dohc core that watches folders, batches changes, maintains `.dohc/` metadata, serves the React renderer, exposes MCP/tools to local agents, and syncs with dohc Cloud/self-hosted Postgres when enabled. The existing dual-backend branch is treated as a completed prototype: keep/port the useful Postgres, filesystem, app, SQLite, sandbox, upload, and AppTester pieces; delete Convex and web-first compatibility paths once equivalent local-first tests prove the replacement.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:67:- User-meaningful SQLite databases can be visible `.sqlite` files; hidden managed databases are allowed only for internal cache/app internals.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:202:- file watcher settle and detect single markdown save: under 2.0s.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:239:Every phase touching UI, filesystem watching, sync, database import, app runtime, or agent tooling must add or update a performance check.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:325:- Design judge panels: before implementing the sync protocol (Phase 9) and the conflict/co-editing model (Phase 10), generate at least 3 independent designs and score them with parallel judges against concrete failure scenarios: concurrent edit, offline rename, half-written file, watcher storm, clock skew, partial upload, reconnect-after-divergence. Each candidate is a doc with fixed sections: data model, message/protocol flow, behavior under each named failure scenario, estimated LOC and new dependencies, what it deletes. Judges receive identical briefs (candidate docs + Non-Negotiables + sync payload list + settle windows + perf budgets) and output a scored matrix (scenario × design, 0-2) plus a one-paragraph verdict. The winning design goes to `docs/architecture/` (losing designs and fatal flaws included); the Decision Ledger gets a one-line entry.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:376:Phase 5:  lead defines watcher-event/change-set contracts first, then 3 worktree TDD lanes: A=workspace-fs watch/scan/diff, B=workspace-sync batchedSync, C=workspace-history changeSetStore. Lead-owned tail: shell wiring (shared DesktopWorkspaceShell.tsx).
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:542:  workspace-fs/             # existing package promoted: watch/materialize/scan/diff/apply
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:552:  sqlite-worker/            # SQLite import/materialization/query
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:603:- Keep/promote: `workspace-postgres`, `workspace-fs`, `workspace-api`, `agent-sandbox`, `sqlite-worker`, `app-tester`, `workspace-contracts` concepts.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:628:  ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:708:- `.sqlite`, `.sqlite3`, and `.db` are visible database files.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1094:- Modify: `packages/workspace-fs/src/watch.ts`
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1106:- [ ] **Step 1: Install watcher dependency**
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1212:finance/wallet.sqlite
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1240:All paths should converge through workspace watcher/history.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1333:- Modify: `services/sqlite-worker/src/sqliteEngine.ts`
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1336:- Create: `apps/desktop/e2e/sqliteImport.spec.ts`
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1345:2. agent or import UI creates `finance/wallet.sqlite`.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1368:pnpm --filter @dohc/sqlite-worker test
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1370:pnpm test:desktop:e2e apps/desktop/e2e/sqliteImport.spec.ts
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1378:git add packages/workspace-core services/sqlite-worker apps/desktop docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1546:  - watcher suppression for self-materialized writes (no materialize → watch → materialize loops).
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1872:- sqlite worker starts.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1931:  sqliteTenThousandRowsFirstPageMs: 1000,
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2012:- debounce and batch file watcher work.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2159:services/sqlite-worker
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2227:database file rules -> packages/workspace-core + sqlite-worker
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2387:- user-meaningful SQLite databases can be visible `.sqlite` files.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:8:- Exact next action: Phase 6 (real file UX) — lead writes failing fileTypes E2E + fixture workspace (notes/today.md, data/transactions.csv, data/config.json, uploads/{receipt.png,contract.pdf,voice.m4a}, finance/wallet.sqlite, finance/.apps/ledger/app.json) + scaffolds FileInspector as a dispatch table (one file per view); port FileTypeView/DatabaseStudio/DatabaseTableGrid from apps/app/src/components (reuse-map: clean/props-driven, strip Convex/web hooks, data via bridge); optional 2-4 view lanes; DESIGN REVIEW LOOP (UI phase). DUE THIS PHASE: codex phase-02 finding #4 (window.open user-gesture/allowlist — user content first renders here).
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:48:- All 9 packages/services mature and tested: workspace-contracts (conformance harness, 8 tests), workspace-postgres (Drizzle schema/migrations/repos/services, 12 tests, dev-ready, zero Convex coupling), workspace-fs (materialize/scan/diff/apply/syncClient/watch — watch is POLLING, 6 tests), workspace-api (HTTP handler + ResolveActor at src/auth/session.ts, 1 test, no production listener), agent-sandbox (allowlist shell, diff capture, 2+4 tests), sqlite-worker (11 tests; needs node:sqlite ⇒ Node 22.13+), app-tester (25 tests, backend matrix), hocuspocus (78 tests, Convex-coupled ACL), workspace-convex-compat (conformance-only consumer: workspace-contracts tests).
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:83:- workspace-fs: watch.ts is POLLING (setInterval, default 1000ms, "something changed" signal only — no event stream). scan.ts = full-tree snapshot w/ sha256 + rename detection + SQLite-header detection, excludes .dohc/. diff.ts = create/update/delete/rename ops vs .dohc/manifest.json. apply.ts = per-op backend writes (no batching). syncClient.ts = dual-backend orchestrator, watch() calls syncLocalChanges() every poll — NO debounce/batch, NO change-set concept. metadata.ts = manifest + media-type/atom-kind/asset-kind inference + path-safety.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:88:- GOTCHAS: SQLite keeps .db-wal/.db-journal sidecars — collapse to the base .db, never sync as separate ops; exclude temp files (*.tmp, .swp/.swo, ~, #*#) and .dohc/cache/**; never sync .dohc/manifest.json (derived) or cache; conflict files must be explicitly named (path.conflict), never look like user content.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:91:- D-15 | Lane boundaries: workspace-core owns event/status TYPES (lead, first); workspace-fs owns ignore-rules + chokidar watch + fs→WatcherEvent[]; workspace-sync owns settle-window batcher + batch→ChangeSet; workspace-history owns changeSetStore (persist + timeline). Disjoint packages → lanes are file-disjoint.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:92:- D-16 | History stored as inspectable JSON under .dohc/history/ (NOT a SQLite history.db as recon suggested) — matches plan ("Store history under .dohc/history/"), the "user-meaningful work remains inspectable" ethos, and avoids pulling sqlite-worker into Phase 5. One JSON file per change set + an ordered index.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:93:- D-17 | chokidar added per plan, but pure logic (ignore rules, sidecar collapse, settle batching) is unit-tested as pure functions independent of chokidar; chokidar wrapper is thin and covered by E2E (keeps tests fast/deterministic).
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:157:- Files changed: packages/workspace-core (watcher.ts, syncStatus.ts + test, changeSet provenance — committed ce589f3); packages/workspace-fs (watchEvents.ts + test — lane A + absolute-path ignore fix); packages/workspace-sync (batchedSync.ts + test + index — lane B); packages/workspace-history (changeSetStore.ts + test + index — lane C); apps/desktop (workspaceWatcher.ts, workspaceActivity.ts, ipc channels/contract, main handlers, preload, DesktopWorkspaceShell history timeline + sync-status binding, e2e); deps + lockfile
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:161:- Decisions made: D-15/16/17 (lane boundaries, JSON history not SQLite, chokidar+pure-logic split — all in pre-phase section); D-18 | createSettleBatcher (workspace-sync) is public package API for Phase 9 cloud-push settling; live local pipeline uses the watcher's own settle + batchToChangeSet (the watcher debounces fs noise; the batcher will settle change-sets before remote POST) — both legitimate, knip-allowlisted as public exports
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:162:- Tests added: workspace-core +6 (syncStatus); workspace-fs +18 (ignore rules, sidecar collapse, watcher wrapper incl. .dohc-absolute-path regression); workspace-sync +15 (settle batcher, 18-writes→1-changeset, batch→ChangeSet); workspace-history +9 (JSON store, newest-first, attributed humanSummary, no git markers); desktop E2E +live-pipeline assertions (file edit → timeline entry; NO .dohc in timeline)
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:164:- Failing tests fixed: feedback-loop bug (watcher recorded its own .dohc/history writes — chokidar passes ABSOLUTE paths to ignored predicate, shouldIgnoreWatchPath expected relative) — FIXED: relativize in watcher ignored predicate + defense-in-depth filter in workspaceWatcher; regressed at fs-unit AND E2E level. Caught by the Phase-5 design screenshot.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:167:- Performance measurements: watcher settle 500ms; no polling loop (chokidar event-driven); registry parsed-cache from checkpoint-1 avoids per-IPC reads. Virtualization of timeline/tree deferred to Phase 16.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:169:- Reviewer/subagent findings: verifiers wf_36257875-c12 — test-quality PASS (ran 4 behavioral mutations, all caught: sha-keyed batcher, non-relativized ignore, oldest-first sort, injected git marker). claimed-vs-actual FAIL on 2 live-pipeline data-loss bugs. Codex phase-05 (xhigh) independently found the same index race + 3 watcher issues. All triaged in phase5(fix):
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:171:  - P1 SQLite sidecars dropped before collapse (shouldIgnoreWatchPath ignored .db-wal so WAL-only writes were INVISIBLE, and collapse never ran) — FIXED: stop ignoring sidecars; wire collapseSqliteSidecars into the live workspaceWatcher path; tests flipped (sidecars not ignored) + WAL-only→base-db-update test.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:172:  - P2 chokidar followSymlinks default true (could watch outside workspace) — FIXED: followSymlinks:false.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:176:- Deferred findings with reason: (1) rename recorded as delete+create losing rename-identity — DEFERRED to Phase 9: detecting rename needs the prior-content index the sync engine maintains (the deleted file's hash is gone when the watcher sees it; diff.ts does it against the manifest the live watcher lacks); content-lossless today (both files on disk, timeline truthful). (2) live watcher hardcodes author=local-user + no provenance, so agent/import/sync kinds unreachable via the fs pipeline — EXPECTED: agent attribution arrives with MCP (Phase 11), import provenance with the import flow (Phase 8); contract+store already support all kinds. (3) conflict/local-changes/cloud-disconnected states wired but unreachable until Phases 9/10. (4) timeline/tree virtualization → Phase 16.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:192:- Commands run: docker compose ps (healthy); node path checks; component path verification; `pnpm check:desktop-local-first-baseline` (Node-pinned, background) — @dohc/web typecheck PASS, web tests 1618/1623 PASS (4 pre-existing, recorded in Gotchas); continue-on-error sweep of remaining suites — workspace-contracts 10/10, workspace-postgres 14/14, workspace-fs 8/8, workspace-api 3/3, app-tester 25/25, sqlite-worker 11/11, agent-sandbox 3/3, check:debt PASS (after rewording two self-tripping doc lines), web typecheck PASS
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:216:- Tests added: 31 (modes 4, paths 19, changeSet/conflicts 8) — covers all plan-required assertions incl. per-workspace-not-per-file mode, encoded/double-encoded/backslash traversal, reserved .dohc, .apps/.sqlite classification, 5 boundary crossings, marker-free conflict summaries
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:271:- Performance measurements: launch marks pipeline intact (E2E re-verified); shell adds React — bundle size watch begins Phase 16 ratchet
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:298:- Reviewer/subagent findings: verifiers wf_76209a51-999 — test-quality FAIL with two PROBE-CONFIRMED escapes, both FIXED pre-commit with pinning tests: (1) dot-segment disguises ("/home/ice/.", "/x/..") defeated the root guard — fixed via lexical normalizeAbsolutePath (drive/UNC-aware) + validateWorkspaceRootChoice returns canonical path used by ALL downstream fs/registry ops (also kills trailing-slash duplicate registrations); (2) attaching a copied workspace folder registered a duplicate workspaceId, silently mistargeting file IPC to the first root — fixed: register rejects identity duplicates with remediation message. Also added missing Windows drive-root test case. Mutation checks passed (store deletion + throw-removal both bite). claimed-vs-actual PASS (all plan Step 1/2/4 claims verified by re-run; metadata.ts divergence judged no-gap; D-14 naming accepted; registerWorkspace behavior change judged low-risk). Residuals tracked: symlink-variant duplicate roots (needs realpath — fs-touching, deferred to Phase 5 watcher work where fs identity matters), mixed separators cosmetic on Windows.

exec
/bin/bash -lc "sed -n '700,725p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md; sed -n '1190,1220p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md" in /home/ice/dev/dohc
 succeeded in 0ms:

Tests must assert:

- `~/dohc` is the default root suggestion.
- attached folders are allowed.
- `.dohc/manifest.json` is reserved.
- path traversal is rejected.
- `.apps/<name>/app.json` is a visible app source path.
- `.sqlite`, `.sqlite3`, and `.db` are visible database files.

- [ ] **Step 3: Write failing change-set tests**

Tests must assert:

- one agent run editing many files groups into one change set.
- normal allowed edits do not require approval.
- boundary crossings require review: public share, permission change, bulk delete, app trust/install, private-to-shared move.
- conflicts produce human-readable summaries, not Git markers.

- [ ] **Step 4: Implement workspace core**

Implement:

```ts
export type WorkspaceMode = "local-first" | "cloud-first-local-copy" | "cloud-only";
export type WorkspaceKind = "personal" | "shared" | "cloud-only";
## Phase 6: Real File UX For Text, Data, Media, Apps, And Databases

**Files:**

- Modify: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`
- Create: `apps/desktop/src/renderer/FileInspector.tsx`
- Create: `apps/desktop/src/renderer/FileInspector.test.tsx`
- Create: `apps/desktop/e2e/fileTypes.spec.ts`
- Modify: existing file-type view code from `apps/app/src/components/FileTypeView.tsx`
- Modify: app runtime and Database Studio code as needed

- [ ] **Step 1: Write failing file-type E2E**

Create a local workspace with:

```txt
notes/today.md
data/transactions.csv
data/config.json
uploads/receipt.png
uploads/contract.pdf
uploads/voice.m4a
finance/wallet.sqlite
finance/.apps/ledger/app.json
```

Test must assert:

- markdown opens as document/editor.
- CSV opens as data/table view with raw toggle.
- JSON opens as code/data view.

exec
/bin/bash -lc "sed -n '1,160p' packages/workspace-fs/src/scan.ts; sed -n '1,140p' packages/workspace-fs/src/watch.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { assertSafeWorkspacePath, mediaTypeForPath, sha256 } from "./metadata";

export const MAX_INLINE_FILE_SIZE = 10 * 1024 * 1024;

export type ScannedWorkspaceFile = {
  path: string;
  mediaType: string;
  bytes?: Uint8Array;
  size: number;
  sha256: string;
};

export async function scanWorkspaceFiles(rootDir: string): Promise<ScannedWorkspaceFile[]> {
  const files: ScannedWorkspaceFile[] = [];
  await scanDir(rootDir, rootDir, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function scanDir(rootDir: string, dir: string, files: ScannedWorkspaceFile[]) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".dohc") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDir(rootDir, fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = assertSafeWorkspacePath(relative(rootDir, fullPath).replace(/\\/g, "/"));
    const size = await fileSize(fullPath);
    const bytes = size <= MAX_INLINE_FILE_SIZE ? await readFile(fullPath) : undefined;
    const mediaType = await mediaTypeForScannedFile(rel, fullPath, bytes);
    files.push({
      path: rel,
      mediaType,
      bytes,
      size,
      sha256: bytes ? sha256(bytes) : await sha256File(fullPath),
    });
  }
}

async function mediaTypeForScannedFile(path: string, fullPath: string, bytes: Uint8Array | undefined) {
  if (!path.toLowerCase().endsWith(".db")) return mediaTypeForPath(path);
  const header = bytes ? bytes.slice(0, 16) : await readHeader(fullPath, 16);
  return new TextDecoder().decode(header) === "SQLite format 3\0"
    ? "application/vnd.sqlite3"
    : mediaTypeForPath(path);
}

async function readHeader(path: string, length: number) {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { start: 0, end: length - 1 });
    stream.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return Buffer.concat(chunks);
}

async function fileSize(path: string) {
  return (await stat(path)).size;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
export type WatchWorkspaceOptions = {
  rootDir: string;
  pollMs?: number;
  signal?: AbortSignal;
  onChange(): void | Promise<void>;
};

export function watchWorkspace({
  pollMs = 1000,
  signal,
  onChange,
}: WatchWorkspaceOptions): () => void {
  if (signal?.aborted) return () => undefined;
  let isRunning = false;
  const timer = setInterval(() => {
    if (isRunning) return;
    isRunning = true;
    void Promise.resolve(onChange())
      .catch((error) => {
        console.error("[workspace-fs] watch onChange failed", error);
      })
      .finally(() => {
        isRunning = false;
      });
  }, pollMs);
  const stop = () => clearInterval(timer);
  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}

exec
/bin/bash -lc "sed -n '1,220p' apps/desktop/src/workspaces/createWorkspaceFolder.ts; grep -R \"realpath\\|symlink\" -n apps/desktop/src packages/workspace-core/src | head -100" in /home/ice/dev/dohc
 succeeded in 0ms:
import {
  checkManifest,
  createWorkspaceManifest,
  defaultWorkspaceMode,
  validateAttachedFolder,
  type WorkspaceKind,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CreatedWorkspace {
  workspaceId: string;
  rootPath: string;
  kind: WorkspaceKind;
  mode: ReturnType<typeof defaultWorkspaceMode>;
}

const FIRST_CONTEXT = `# About me

Tell your agents who you are and how you like to work.
This file lives at .context/me.md inside your workspace folder.
`;

type ManifestState =
  | { kind: "absent" }
  | { kind: "valid"; workspaceId: string; workspaceKind: WorkspaceKind; mode: CreatedWorkspace["mode"] }
  | { kind: "blocked"; reason: string };

async function inspectManifest(rootPath: string): Promise<ManifestState> {
  let raw: string;
  try {
    raw = await readFile(join(rootPath, ".dohc", "manifest.json"), "utf8");
  } catch {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "blocked", reason: "this folder has a corrupt .dohc/manifest.json" };
  }
  const check = checkManifest(parsed);
  if (check.status === "valid") {
    return {
      kind: "valid",
      workspaceId: check.manifest.workspaceId,
      workspaceKind: check.manifest.kind,
      mode: check.manifest.mode,
    };
  }
  if (check.status === "newer-version") {
    return {
      kind: "blocked",
      reason: `this workspace was created by a newer version of dohc (manifest v${check.version})`,
    };
  }
  // A present-but-broken manifest must never be silently overwritten (it may
  // be the user's data). checkManifest never returns "absent" for a file that
  // exists, but narrow defensively.
  const reason = check.status === "invalid" ? check.reason : "unrecognized manifest";
  return { kind: "blocked", reason: `this folder has an invalid .dohc/manifest.json: ${reason}` };
}

export async function createWorkspaceFolder(input: {
  rootPath: string;
  kind: Extract<WorkspaceKind, "personal" | "shared">;
}): Promise<CreatedWorkspace> {
  const folderCheck = validateAttachedFolder(input.rootPath);
  if (!folderCheck.ok) {
    throw new Error(`Invalid workspace root: ${folderCheck.reason}`);
  }

  const state = await inspectManifest(input.rootPath);
  if (state.kind === "blocked") {
    throw new Error(state.reason);
  }
  // A folder that is already a dohc workspace keeps its identity — sync and
  // history hang off workspaceId, so overwriting the manifest severs them.
  if (state.kind === "valid") {
    return {
      workspaceId: state.workspaceId,
      rootPath: input.rootPath,
      kind: state.workspaceKind === "cloud-only" ? input.kind : state.workspaceKind,
      mode: state.mode,
    };
  }

  const manifest = createWorkspaceManifest({
    workspaceId: randomUUID(),
    kind: input.kind,
  });

  await mkdir(join(input.rootPath, ".dohc"), { recursive: true });
  await mkdir(join(input.rootPath, ".context"), { recursive: true });
  // wx: manifest is absent (inspectManifest returned "absent"); never clobber
  // an unexpected file that appeared between the check and the write.
  await writeFile(
    join(input.rootPath, ".dohc", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(join(input.rootPath, ".context", "me.md"), FIRST_CONTEXT, {
    flag: "wx",
  }).catch((error: unknown) => {
    // An existing me.md is the user's; never overwrite it. Real failures
    // (permissions, disk) must still surface.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });

  return {
    workspaceId: manifest.workspaceId,
    rootPath: input.rootPath,
    kind: input.kind,
    mode: manifest.mode,
  };
}
apps/desktop/src/workspaces/workspaceFiles.ts:6:import { copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
apps/desktop/src/workspaces/workspaceFiles.ts:10:// the part realpath can resolve, so we can check containment BEFORE mkdir.
apps/desktop/src/workspaces/workspaceFiles.ts:15:      return await realpath(current);
apps/desktop/src/workspaces/workspaceFiles.ts:50:      // Never follow symlinks: a dir/file symlink could point outside the
apps/desktop/src/workspaces/workspaceFiles.ts:75:  // Lexical validation can't see symlinks: a workspace-internal symlinked
apps/desktop/src/workspaces/workspaceFiles.ts:77:  // deepest-existing ancestor BEFORE mkdir, so a symlinked ancestor can't even
apps/desktop/src/workspaces/workspaceFiles.ts:79:  const realRoot = await realpath(rootPath);
apps/desktop/src/workspaces/workspaceFiles.ts:85:  // wx + O_EXCL additionally prevents a final-segment symlink from escaping.
apps/desktop/src/workspaces/workspaceFiles.ts:86:  if (!isInside(realRoot, await realpath(dirname(absolute)))) {
apps/desktop/src/workspaces/workspaceFiles.test.ts:2:import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
apps/desktop/src/workspaces/workspaceFiles.test.ts:32:  it("refuses to write through a symlinked directory that escapes the workspace", async () => {
apps/desktop/src/workspaces/workspaceFiles.test.ts:34:    await symlink(outside, join(root, "link"), "dir");
apps/desktop/src/workspaces/workspaceFiles.test.ts:54:  it("does not follow symlinks (file or directory) out of the workspace", async () => {
apps/desktop/src/workspaces/workspaceFiles.test.ts:60:    await symlink(join(outside, "secret.md"), join(root, "link.md"), "file");
apps/desktop/src/workspaces/workspaceFiles.test.ts:61:    await symlink(outside, join(root, "linkdir"), "dir");

exec
/bin/bash -lc "grep -R \"function validateAttachedFolder\\|validateAttachedFolder\" -n packages/workspace-core/src apps/desktop/src | head -40 && sed -n '1,160p' packages/workspace-core/src/paths.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
packages/workspace-core/src/paths.test.ts:6:  validateAttachedFolder,
packages/workspace-core/src/paths.test.ts:16:    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
packages/workspace-core/src/paths.test.ts:17:    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
packages/workspace-core/src/paths.test.ts:21:    expect(validateAttachedFolder("C:\\Users\\ice\\dohc").ok).toBe(true);
packages/workspace-core/src/paths.test.ts:22:    expect(validateAttachedFolder("C:/Users/ice/dohc").ok).toBe(true);
packages/workspace-core/src/paths.test.ts:23:    expect(validateAttachedFolder("\\\\server\\share\\dohc").ok).toBe(true);
packages/workspace-core/src/paths.test.ts:27:    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
packages/workspace-core/src/paths.ts:16:export function validateAttachedFolder(path: string): FolderValidation {
packages/workspace-core/src/paths.ts:101:  const attached = validateAttachedFolder(rootPath);
apps/desktop/src/workspaces/createWorkspaceFolder.ts:5:  validateAttachedFolder,
apps/desktop/src/workspaces/createWorkspaceFolder.ts:69:  const folderCheck = validateAttachedFolder(input.rootPath);
export function defaultWorkspaceRoot(homeDir: string): string {
  return `${homeDir.replace(/\/+$/, "")}/dohc`;
}

export type FolderValidation = { ok: true } | { ok: false; reason: string };

// POSIX absolute, Windows drive-qualified (C:\ or C:/), or UNC (\\server).
function isAbsolutePathLike(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}

export function validateAttachedFolder(path: string): FolderValidation {
  if (!isAbsolutePathLike(path)) {
    return { ok: false, reason: "attached folders must be absolute paths" };
  }
  return { ok: true };
}

// Case-insensitive: on default macOS/Windows filesystems .DOHC aliases .dohc,
// so a case-sensitive guard would let writes overwrite dohc metadata.
export function isReservedPath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return lower === ".dohc" || lower.startsWith(".dohc/");
}

export type WritePathValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: "traversal" | "absolute" | "reserved" | "invalid" };

export function validateUserWritePath(relativePath: string): WritePathValidation {
  if (relativePath.includes("\0")) return { ok: false, reason: "invalid" };
  if (isAbsolutePathLike(relativePath)) return { ok: false, reason: "absolute" };
  // Percent-encoded dots/separators are traversal in disguise; decode until
  // stable so double-encoding (%252e -> %2e -> .) cannot slip through.
  let decoded = relativePath;
  for (;;) {
    const next = decoded
      .replace(/%25/gi, "%")
      .replace(/%2e/gi, ".")
      .replace(/%2f/gi, "/")
      .replace(/%5c/gi, "\\");
    if (next === decoded) break;
    decoded = next;
  }
  // Decoding may reveal an absolute path (%2fetc, C%3A is out of scope but
  // drive letters survive decoding as-is).
  if (isAbsolutePathLike(decoded)) return { ok: false, reason: "absolute" };
  const segments = decoded.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) return { ok: false, reason: "traversal" };
  const normalized = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
  if (normalized.length === 0) return { ok: false, reason: "invalid" };
  if (isReservedPath(normalized)) return { ok: false, reason: "reserved" };
  return { ok: true, normalized };
}

// Lexical normalization: resolves "." and ".." segments and separator noise
// WITHOUT touching the filesystem, so dot-segment disguises ("/home/ice/.")
// cannot slip past string comparisons. Preserves drive and UNC prefixes.
export function normalizeAbsolutePath(path: string): string {
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
  const rest = drive ? path.slice(drive.length) : path;
  // A real UNC path needs a server segment after \\ or //; a bare POSIX
  // leading // (or ///) is just the filesystem root and must collapse to /,
  // otherwise "//home/ice" would dodge the home-directory guard.
  const uncMatch = /^([\\/])\1+([^\\/])/.exec(rest);
  const unc = drive === "" && uncMatch !== undefined && uncMatch !== null;
  const segments = rest.replaceAll("\\", "/").split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const prefix = unc ? "//" : "/";
  const joined = `${drive}${prefix}${out.join("/")}`;
  const trimmed = joined.replace(/\/+$/, "");
  return trimmed || (drive ? drive : "/");
}

export type RootChoiceValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

// Registry policy: a workspace root must be a real folder choice — never the
// filesystem root or the home directory itself, which would hand workspace
// file operations the user's entire disk or home. Callers must use the
// returned normalized path so registry equality checks are canonical.
export function validateWorkspaceRootChoice(
  rootPath: string,
  homeDir: string,
): RootChoiceValidation {
  const attached = validateAttachedFolder(rootPath);
  if (!attached.ok) return attached;
  const normalized = normalizeAbsolutePath(rootPath);
  const home = normalizeAbsolutePath(homeDir);
  // Filesystem root, a drive root (C:), or a UNC server/share root (//server,
  // //server/share) — never a workspace.
  if (
    normalized === "/" ||
    /^[A-Za-z]:$/.test(normalized) ||
    /^\/\/[^/]*(\/[^/]*)?$/.test(normalized)
  ) {
    return { ok: false, reason: "workspace root cannot be the filesystem root" };
  }
  // Case-insensitive compare: on macOS/Windows "/Home/Ice" aliases the home
  // directory, so a case variant must not slip past this guard.
  if (normalized.toLowerCase() === home.toLowerCase()) {
    return { ok: false, reason: "workspace root cannot be the home directory itself" };
  }
  return { ok: true, normalized };
}

export type PathClassification =
  | { kind: "app-source"; appName: string }
  | { kind: "database" }
  | { kind: "file" };

const DATABASE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"];

export function classifyPath(relativePath: string): PathClassification {
  const segments = relativePath.split("/");
  const appsIndex = segments.indexOf(".apps");
  const appName = appsIndex === -1 ? undefined : segments[appsIndex + 1];
  if (appName) return { kind: "app-source", appName };
  const lower = relativePath.toLowerCase();
  if (DATABASE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { kind: "database" };
  }
  return { kind: "file" };
}

codex
The patch fixes several watcher/history issues, but it introduces a live-pipeline misclassification for SQLite database deletions when sidecars are present. That can make the recorded change set claim a deleted database was written instead.

Review comment:

- [P2] Preserve SQLite database deletes when collapsing sidecars — /home/ice/dev/dohc/apps/desktop/src/workspaces/workspaceWatcher.ts:85-85
  When a user deletes a WAL-mode SQLite database and its `-wal`/`-shm` files are unlinked in the same watcher batch, `pathsToEvents` produces a base `delete` plus sidecar deletes, but this call collapses the batch through `collapseSqliteSidecars`, which forces the base entry back to `update`; `batchToChangeSet` then records a write rather than a delete. That makes history/sync miss the removal of `wallet.sqlite`, so the collapse needs to preserve a base delete when the base file is absent.
The patch fixes several watcher/history issues, but it introduces a live-pipeline misclassification for SQLite database deletions when sidecars are present. That can make the recorded change set claim a deleted database was written instead.

Review comment:

- [P2] Preserve SQLite database deletes when collapsing sidecars — /home/ice/dev/dohc/apps/desktop/src/workspaces/workspaceWatcher.ts:85-85
  When a user deletes a WAL-mode SQLite database and its `-wal`/`-shm` files are unlinked in the same watcher batch, `pathsToEvents` produces a base `delete` plus sidecar deletes, but this call collapses the batch through `collapseSqliteSidecars`, which forces the base entry back to `update`; `batchToChangeSet` then records a write rather than a delete. That makes history/sync miss the removal of `wallet.sqlite`, so the collapse needs to preserve a base delete when the base file is absent.
