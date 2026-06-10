OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: xhigh
reasoning summaries: none
session id: 019eb152-fbae-7851-a942-69db2a14df10
--------
user
commit eb6c0c3
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git status --short && git rev-parse --show-toplevel && git show --stat --oneline --decorate --find-renames eb6c0c3' in /home/ice/dev/dohc
 succeeded in 0ms:
?? docs/superpowers/reviews/codex/phase-05.md
/home/ice/dev/dohc
eb6c0c3 phase5: file watcher, batched sync, and local-first history
 apps/desktop/e2e/firstRunWorkspace.spec.ts         |  19 +-
 apps/desktop/electron.vite.config.ts               |  13 +-
 apps/desktop/package.json                          |   3 +
 apps/desktop/src/ipc/bridgeContract.ts             |  52 ++++
 apps/desktop/src/ipc/channels.ts                   |   4 +
 apps/desktop/src/main.ts                           |  50 +++-
 apps/desktop/src/preload.ts                        |   9 +
 .../desktop/src/renderer/DesktopWorkspaceShell.tsx | 126 +++++++--
 apps/desktop/src/workspaces/registryStore.ts       |  11 +-
 apps/desktop/src/workspaces/workspaceActivity.ts   |  89 +++++++
 apps/desktop/src/workspaces/workspaceFiles.ts      |  11 +-
 apps/desktop/src/workspaces/workspaceWatcher.ts    |  95 +++++++
 ...desktop-local-first-cloud-sync.execution-log.md |  24 ++
 packages/workspace-fs/package.json                 |   1 +
 packages/workspace-fs/src/index.ts                 |   1 +
 packages/workspace-fs/src/watchEvents.test.ts      | 216 ++++++++++++++++
 packages/workspace-fs/src/watchEvents.ts           | 191 ++++++++++++++
 .../workspace-history/src/changeSetStore.test.ts   | 192 ++++++++++++++
 packages/workspace-history/src/changeSetStore.ts   | 169 ++++++++++++
 packages/workspace-history/src/index.ts            |   1 +
 packages/workspace-sync/src/batchedSync.test.ts    | 284 +++++++++++++++++++++
 packages/workspace-sync/src/batchedSync.ts         | 125 +++++++++
 packages/workspace-sync/src/index.ts               |   1 +
 pnpm-lock.yaml                                     |  12 +
 24 files changed, 1662 insertions(+), 37 deletions(-)

exec
/bin/bash -lc 'find .. -name AGENTS.md -print' in /home/ice/dev/dohc
 succeeded in 6683ms:
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
/bin/bash -lc 'git show --find-renames --find-copies --relative --format=fuller --stat --patch eb6c0c3 -- apps/desktop/src/workspaces/workspaceWatcher.ts apps/desktop/src/workspaces/workspaceActivity.ts packages/workspace-fs/src/watchEvents.ts packages/workspace-history/src/changeSetStore.ts packages/workspace-sync/src/batchedSync.ts' in /home/ice/dev/dohc
 succeeded in 0ms:
commit eb6c0c3bab0a13dc4af935b9fe703dfa0961d328
Author:     Ice de Vera <iestyndevera@gmail.com>
AuthorDate: Wed Jun 10 19:37:16 2026 +0800
Commit:     Ice de Vera <iestyndevera@gmail.com>
CommitDate: Wed Jun 10 19:37:16 2026 +0800

    phase5: file watcher, batched sync, and local-first history
    
    Three file-disjoint packages built in parallel against locked
    workspace-core contracts: workspace-fs gains a chokidar watcher with
    ignore rules (temp files, .dohc, SQLite WAL/journal sidecar collapse);
    workspace-sync gains a settle-window batcher (18 rapid writes -> one
    change set) + batch->ChangeSet; workspace-history persists change sets
    as inspectable JSON under .dohc/history/ with a newest-first,
    attributed, git-marker-free timeline. Desktop wires the live
    watcher->history pipeline into a visible History timeline (the "git
    log for everyday people") and a live sync-status footer. A screenshot
    caught a feedback loop (watcher recording its own .dohc writes via
    chokidar's absolute-path ignored predicate) — fixed at two layers and
    regressed at fs-unit + E2E. 146 unit tests + 4 E2E + smoke green.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
---
 apps/desktop/src/workspaces/workspaceActivity.ts |  89 +++++++++++
 apps/desktop/src/workspaces/workspaceWatcher.ts  |  95 +++++++++++
 packages/workspace-fs/src/watchEvents.ts         | 191 +++++++++++++++++++++++
 packages/workspace-history/src/changeSetStore.ts | 169 ++++++++++++++++++++
 packages/workspace-sync/src/batchedSync.ts       | 125 +++++++++++++++
 5 files changed, 669 insertions(+)

diff --git a/apps/desktop/src/workspaces/workspaceActivity.ts b/apps/desktop/src/workspaces/workspaceActivity.ts
new file mode 100644
index 0000000..f68ca5e
--- /dev/null
+++ b/apps/desktop/src/workspaces/workspaceActivity.ts
@@ -0,0 +1,89 @@
+import { deriveSyncStatus, type SyncStatus } from "@dohc/workspace-core";
+import type {
+  ChangeSetRecord,
+  SyncStatusResult,
+} from "../ipc/bridgeContract";
+import type { CreatedWorkspace } from "./createWorkspaceFolder";
+import {
+  createChangeSetStore,
+  humanSummary,
+  startWorkspaceWatch,
+  type WorkspaceWatchHandle,
+} from "./workspaceWatcher";
+
+interface WatchedWorkspace {
+  workspace: CreatedWorkspace;
+  handle: WorkspaceWatchHandle;
+  inFlight: boolean;
+  lastSyncedAtMs: number | null;
+}
+
+// Owns the live file-watch → history pipeline per workspace and the derived
+// sync status. The desktop layer opens a workspace once; subsequent timeline
+// and status reads are served from here, and activity pushes notify the UI.
+export function createWorkspaceActivity(notify: () => void) {
+  const watched = new Map<string, WatchedWorkspace>();
+
+  function statusFor(workspaceId: string): SyncStatus {
+    const w = watched.get(workspaceId);
+    // Local-only today: nothing is "pending" (edits save immediately) and no
+    // cloud, so state is synced unless a batch is being recorded. Cloud and
+    // conflict states become reachable in Phases 9/10 through the same
+    // deriveSyncStatus inputs.
+    return deriveSyncStatus({
+      pendingChangeCount: 0,
+      inFlight: w?.inFlight ?? false,
+      hasConflict: false,
+      cloudEnabled: false,
+      cloudConnected: false,
+      lastSyncedAtMs: w?.lastSyncedAtMs ?? null,
+    });
+  }
+
+  function open(workspace: CreatedWorkspace): SyncStatusResult {
+    if (!watched.has(workspace.workspaceId)) {
+      const entry: WatchedWorkspace = {
+        workspace,
+        inFlight: false,
+        lastSyncedAtMs: null,
+        handle: { stop: () => {} },
+      };
+      watched.set(workspace.workspaceId, entry);
+      entry.handle = startWorkspaceWatch(workspace, {
+        onRecorded: () => {
+          entry.inFlight = false;
+          entry.lastSyncedAtMs = Date.now();
+          notify();
+        },
+      });
+    }
+    return statusFor(workspace.workspaceId);
+  }
+
+  async function listChangeSets(
+    workspace: CreatedWorkspace,
+  ): Promise<ChangeSetRecord[]> {
+    const store = createChangeSetStore(workspace.rootPath);
+    const records = await store.list();
+    return records.map((record) => ({
+      id: record.id,
+      recordedAtMs: record.recordedAtMs,
+      kind: record.kind,
+      author: record.author,
+      summary: record.summary,
+      humanSummary: humanSummary(record),
+      fileCount: record.files.length,
+    }));
+  }
+
+  function getStatus(workspaceId: string): SyncStatusResult {
+    return statusFor(workspaceId);
+  }
+
+  function stopAll(): void {
+    for (const w of watched.values()) w.handle.stop();
+    watched.clear();
+  }
+
+  return { open, listChangeSets, getStatus, stopAll };
+}
diff --git a/apps/desktop/src/workspaces/workspaceWatcher.ts b/apps/desktop/src/workspaces/workspaceWatcher.ts
new file mode 100644
index 0000000..3df14c6
--- /dev/null
+++ b/apps/desktop/src/workspaces/workspaceWatcher.ts
@@ -0,0 +1,95 @@
+import type {
+  ChangeAuthor,
+  WatcherEvent,
+  WatcherEventBatch,
+} from "@dohc/workspace-core";
+import { shouldIgnoreWatchPath, watchWorkspaceEvents } from "@dohc/workspace-fs";
+import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
+import { batchToChangeSet } from "@dohc/workspace-sync";
+import { createHash, randomUUID } from "node:crypto";
+import { readFile, stat } from "node:fs/promises";
+import { join } from "node:path";
+import type { CreatedWorkspace } from "./createWorkspaceFolder";
+
+// Local user is the implicit author of filesystem edits (an external agent's
+// writes also land here; provenance/attribution sharpens in later phases).
+const LOCAL_USER: ChangeAuthor = { kind: "user", userId: "local" };
+
+async function sha256OrUndefined(absolute: string): Promise<string | undefined> {
+  try {
+    return createHash("sha256").update(await readFile(absolute)).digest("hex");
+  } catch {
+    return undefined;
+  }
+}
+
+// Turn the watcher's settled changed paths into WatcherEvents. Operation is
+// inferred from current existence (present => write/create, absent => delete);
+// this is the pure, testable core of the live pipeline.
+export async function pathsToEvents(
+  rootPath: string,
+  paths: string[],
+): Promise<WatcherEvent[]> {
+  const events: WatcherEvent[] = [];
+  for (const path of paths) {
+    const absolute = join(rootPath, path);
+    let exists = false;
+    try {
+      exists = (await stat(absolute)).isFile();
+    } catch {
+      exists = false;
+    }
+    events.push(
+      exists
+        ? { path, operation: "update", sha256: await sha256OrUndefined(absolute) }
+        : { path, operation: "delete" },
+    );
+  }
+  return events;
+}
+
+export interface WorkspaceWatchHandle {
+  stop: () => void;
+}
+
+// Wires the file watcher to the history store: each settled batch of changes
+// becomes one recorded change set. onRecorded lets the desktop layer refresh
+// sync status and push the new timeline entry to the renderer.
+export function startWorkspaceWatch(
+  workspace: CreatedWorkspace,
+  options: {
+    settleMs?: number;
+    now?: () => number;
+    onRecorded?: () => void;
+  } = {},
+): WorkspaceWatchHandle {
+  const store = createChangeSetStore(workspace.rootPath);
+  const now = options.now ?? (() => Date.now());
+
+  const stop = watchWorkspaceEvents(
+    { rootDir: workspace.rootPath, settleMs: options.settleMs },
+    (paths) => {
+      void (async () => {
+        // Defense in depth: never record changes to .dohc/** (our own history
+        // writes, manifest, cache) — recording them would feed back into the
+        // watcher. The watcher already ignores these; this guards a leak.
+        const userPaths = paths.filter((p) => !shouldIgnoreWatchPath(p));
+        if (userPaths.length === 0) return;
+        const events = await pathsToEvents(workspace.rootPath, userPaths);
+        if (events.length === 0) return;
+        const batch: WatcherEventBatch = {
+          settledAtMs: now(),
+          windowMs: options.settleMs ?? 500,
+          events,
+        };
+        const changeSet = batchToChangeSet(batch, { author: LOCAL_USER });
+        await store.record(changeSet, { id: randomUUID(), recordedAtMs: now() });
+        options.onRecorded?.();
+      })();
+    },
+  );
+
+  return { stop };
+}
+
+export { createChangeSetStore, humanSummary };
diff --git a/packages/workspace-fs/src/watchEvents.ts b/packages/workspace-fs/src/watchEvents.ts
new file mode 100644
index 0000000..7f2afbd
--- /dev/null
+++ b/packages/workspace-fs/src/watchEvents.ts
@@ -0,0 +1,191 @@
+// Phase 5: the raw filesystem watch layer for a local-first workspace.
+//
+// Two concerns live here, kept separate so the noisy parts stay testable:
+//   1. PURE rules that decide which paths are workspace noise vs. real user
+//      files, and how SQLite's multi-file write protocol collapses back to a
+//      single logical database change.
+//   2. A thin chokidar wrapper that debounces raw events into a quiet-window
+//      settle and hands the changed relative paths up to the caller.
+//
+// The pure helpers are exhaustively unit-tested; the chokidar wrapper only
+// needs to construct and tear down cleanly, since real fs-event timing is
+// exercised by the desktop E2E suite.
+
+import { watch } from "chokidar";
+import { isAbsolute, relative } from "node:path";
+import type { WatcherEvent } from "@dohc/workspace-core";
+
+// Normalize separators so a single set of rules covers POSIX and the
+// backslash paths a Windows watcher hands back.
+function toPosix(relativePath: string): string {
+  return relativePath.replaceAll("\\", "/");
+}
+
+// SQLite sidecars: the WAL/SHM/journal files SQLite writes alongside a
+// database. Anchored to the end so "data/walmart.csv" (contains "wal") and
+// "notes/journal.md" never match.
+const SQLITE_SIDECAR = /^(.*\.(?:db|sqlite))-(?:wal|shm|journal)$/i;
+
+// Editor scratch/swap/autosave artifacts that churn while a user types but are
+// never the file we sync.
+const EDITOR_NOISE = [
+  /\.tmp$/i, // foo.tmp
+  /\.tmp\..+$/i, // foo.tmp.1234 (atomic-write staging)
+  /\.swp$/i, // vim swap
+  /\.swo$/i, // vim secondary swap
+  /~$/, // emacs/gedit trailing-tilde backup
+  /^#.*#$/, // emacs autosave: #foo#
+  /^\.DS_Store$/i, // macOS Finder metadata
+];
+
+// TRUE when the watcher should drop this relative path before it ever becomes
+// a user file op. Covers the reserved .dohc/ tree (including its cache),
+// editor scratch files, and SQLite sidecars — see the regexes above for why
+// each is anchored to avoid false positives on real user files.
+export function shouldIgnoreWatchPath(relativePath: string): boolean {
+  const path = toPosix(relativePath);
+  const lower = path.toLowerCase();
+
+  // .dohc/ is dohc's own reserved/derived state (registry, cache, ...). Match
+  // the directory exactly or as a prefix — but NOT ".dohcrc", which is a
+  // sibling file, not the reserved directory.
+  if (lower === ".dohc" || lower.startsWith(".dohc/")) return true;
+
+  const basename = path.slice(path.lastIndexOf("/") + 1);
+  if (EDITOR_NOISE.some((pattern) => pattern.test(basename))) return true;
+
+  if (SQLITE_SIDECAR.test(path)) return true;
+
+  return false;
+}
+
+// Strip a SQLite sidecar suffix back to its base database path, or return
+// undefined for a path that is not a sidecar.
+function baseDbPath(path: string): string | undefined {
+  const match = SQLITE_SIDECAR.exec(toPosix(path));
+  return match ? match[1] : undefined;
+}
+
+// Collapse SQLite's multi-file write protocol back to one logical change.
+//
+// A single transaction can touch wallet.db, wallet.db-wal and wallet.db-shm,
+// and a WAL checkpoint can even read as a *delete* of a sidecar while the base
+// db emits nothing. The user-facing truth is always "the database changed", so
+// we: drop every sidecar event, and guarantee exactly one "update" event for
+// each affected base db — inserted at the position of its first related event
+// to preserve ordering relative to other (non-sqlite) files.
+export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
+  const out: WatcherEvent[] = [];
+  // Maps a base-db path to the index in `out` holding its single update, so a
+  // later base or sidecar event for the same db folds into that one slot.
+  const baseDbIndex = new Map<string, number>();
+
+  const ensureBaseDbUpdate = (dbPath: string): void => {
+    const existing = baseDbIndex.get(dbPath);
+    if (existing !== undefined) {
+      // Force "update": a checkpoint may have arrived as create/delete, but the
+      // database content changing is always an update from the user's view.
+      out[existing] = { path: dbPath, operation: "update" };
+      return;
+    }
+    baseDbIndex.set(dbPath, out.length);
+    out.push({ path: dbPath, operation: "update" });
+  };
+
+  for (const event of events) {
+    const sidecarBase = baseDbPath(event.path);
+    if (sidecarBase !== undefined) {
+      // A sidecar event stands in for (or accompanies) its base db.
+      ensureBaseDbUpdate(sidecarBase);
+      continue;
+    }
+    const normalized = toPosix(event.path);
+    if (baseDbIndex.has(normalized)) {
+      // The base db itself changed and we already have a slot for it.
+      ensureBaseDbUpdate(normalized);
+      continue;
+    }
+    // Track base-db paths so a sidecar arriving later folds into this event.
+    if (/\.(?:db|sqlite)$/i.test(normalized)) {
+      baseDbIndex.set(normalized, out.length);
+    }
+    out.push(event);
+  }
+
+  return out;
+}
+
+export type WatchWorkspaceEventsOptions = {
+  rootDir: string;
+  // Quiet-window before a burst of raw events is reported as one batch. An
+  // agent run or a save-all touching many files settles into a single batch.
+  settleMs?: number;
+  signal?: AbortSignal;
+};
+
+// Thin chokidar wrapper: watches rootDir, ignores noise via
+// shouldIgnoreWatchPath, debounces raw events into a quiet-window settle, and
+// calls onBatch with the unique changed relative paths once things go quiet.
+// Returns an idempotent stop function.
+export function watchWorkspaceEvents(
+  { rootDir, settleMs = 500, signal }: WatchWorkspaceEventsOptions,
+  onBatch: (paths: string[]) => void,
+): () => void {
+  if (signal?.aborted) return () => undefined;
+
+  // cwd makes chokidar hand back EVENT paths relative to rootDir, but the
+  // `ignored` predicate is called with ABSOLUTE paths during the initial scan
+  // — relativize first or .dohc/** (incl. our own history writes) leaks
+  // through and the watcher records its own output in a feedback loop.
+  const watcher = watch(".", {
+    cwd: rootDir,
+    // We diff the filesystem ourselves on change; an initial flood of "add"
+    // events for every existing file would be pure noise.
+    ignoreInitial: true,
+    ignored: (path: string) => {
+      const rel = isAbsolute(path) ? relative(rootDir, path) : path;
+      if (rel === "" || rel === ".") return false;
+      return shouldIgnoreWatchPath(rel);
+    },
+  });
+
+  const pending = new Set<string>();
+  let timer: ReturnType<typeof setTimeout> | undefined;
+  let stopped = false;
+
+  const flush = (): void => {
+    timer = undefined;
+    if (pending.size === 0) return;
+    const paths = [...pending];
+    pending.clear();
+    onBatch(paths);
+  };
+
+  const onEvent = (relativePath: string): void => {
+    // chokidar's cwd-relative path is already separator-normalized for our
+    // matcher; track it and (re)arm the quiet window.
+    pending.add(toPosix(relativePath));
+    if (timer !== undefined) clearTimeout(timer);
+    timer = setTimeout(flush, settleMs);
+  };
+
+  watcher.on("add", onEvent);
+  watcher.on("change", onEvent);
+  watcher.on("unlink", onEvent);
+  // Surface watcher errors rather than swallowing them; a dead watcher should
+  // be visible upstream, not silently stop reporting changes.
+  watcher.on("error", (error) => {
+    console.error("[workspace-fs] watch error", error);
+  });
+
+  const stop = (): void => {
+    if (stopped) return;
+    stopped = true;
+    if (timer !== undefined) clearTimeout(timer);
+    signal?.removeEventListener("abort", stop);
+    void watcher.close();
+  };
+
+  signal?.addEventListener("abort", stop, { once: true });
+  return stop;
+}
diff --git a/packages/workspace-history/src/changeSetStore.ts b/packages/workspace-history/src/changeSetStore.ts
new file mode 100644
index 0000000..25a28a0
--- /dev/null
+++ b/packages/workspace-history/src/changeSetStore.ts
@@ -0,0 +1,169 @@
+import { mkdir, readFile, writeFile } from "node:fs/promises";
+import { join } from "node:path";
+import type {
+  BoundaryCrossing,
+  ChangeAuthor,
+  ChangeProvenance,
+  ChangeSet,
+  ChangeSetKind,
+  FileChange,
+} from "@dohc/workspace-core";
+
+// One persisted change set. Mirrors ChangeSet but adds the identity and
+// timestamp the store assigns, so each record is self-describing on disk.
+export interface HistoryRecord {
+  id: string;
+  recordedAtMs: number;
+  kind: ChangeSetKind;
+  author: ChangeAuthor;
+  summary: string;
+  files: FileChange[];
+  provenance?: ChangeProvenance;
+  boundaryCrossings: BoundaryCrossing[];
+}
+
+// The index is a lightweight, ordered table of contents — enough to render a
+// timeline without opening every per-record file. Ordering source of truth.
+interface IndexEntry {
+  id: string;
+  recordedAtMs: number;
+  kind: ChangeSetKind;
+  author: ChangeAuthor;
+  summary: string;
+  fileCount: number;
+}
+
+export interface ChangeSetStore {
+  record(
+    set: ChangeSet,
+    opts: { id: string; recordedAtMs: number },
+  ): Promise<HistoryRecord>;
+  list(): Promise<HistoryRecord[]>;
+  get(id: string): Promise<HistoryRecord | null>;
+}
+
+// Each record lives in its own file so history is inspectable: open
+// .dohc/history/<recordedAtMs>-<id>.json and read what changed and why.
+function recordFileName(opts: { id: string; recordedAtMs: number }): string {
+  return `${opts.recordedAtMs}-${opts.id}.json`;
+}
+
+async function readJson<T>(path: string): Promise<T | null> {
+  try {
+    return JSON.parse(await readFile(path, "utf8")) as T;
+  } catch (error) {
+    // A missing file is the empty case (no history yet), not an error.
+    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
+    throw error;
+  }
+}
+
+export function createChangeSetStore(rootDir: string): ChangeSetStore {
+  // All history stays inside .dohc/history — never written outside it.
+  const historyDir = join(rootDir, ".dohc", "history");
+  const indexPath = join(historyDir, "index.json");
+
+  async function readIndex(): Promise<IndexEntry[]> {
+    return (await readJson<IndexEntry[]>(indexPath)) ?? [];
+  }
+
+  return {
+    async record(set, opts) {
+      const record: HistoryRecord = {
+        id: opts.id,
+        recordedAtMs: opts.recordedAtMs,
+        kind: set.kind,
+        author: set.author,
+        summary: set.summary,
+        files: set.files,
+        boundaryCrossings: set.boundaryCrossings,
+        ...(set.provenance ? { provenance: set.provenance } : {}),
+      };
+
+      await mkdir(historyDir, { recursive: true });
+      // Pretty JSON: history is meant to be opened and read by a person.
+      await writeFile(
+        join(historyDir, recordFileName(opts)),
+        `${JSON.stringify(record, null, 2)}\n`,
+        "utf8",
+      );
+
+      const entry: IndexEntry = {
+        id: record.id,
+        recordedAtMs: record.recordedAtMs,
+        kind: record.kind,
+        author: record.author,
+        summary: record.summary,
+        fileCount: record.files.length,
+      };
+      const index = await readIndex();
+      index.push(entry);
+      await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
+
+      return record;
+    },
+
+    async list() {
+      const index = await readIndex();
+      // The index is the ordering source; sort newest first by timestamp,
+      // breaking ties on id so ordering is stable within the same ms.
+      const ordered = [...index].sort(
+        (a, b) =>
+          b.recordedAtMs - a.recordedAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
+      );
+      const records: HistoryRecord[] = [];
+      for (const entry of ordered) {
+        // Read the full record from its own file — the index only holds a
+        // summary, the per-record file is the source of full detail.
+        const record = await readJson<HistoryRecord>(
+          join(historyDir, recordFileName(entry)),
+        );
+        if (record) records.push(record);
+      }
+      return records;
+    },
+
+    async get(id) {
+      const index = await readIndex();
+      const entry = index.find((e) => e.id === id);
+      if (!entry) return null;
+      return readJson<HistoryRecord>(join(historyDir, recordFileName(entry)));
+    },
+  };
+}
+
+// Plain-language attribution: who did what, to how many files. Author-aware so
+// a user edit and an agent run read differently. Deliberately prose, never Git
+// conflict markers — history is for humans to skim.
+export function humanSummary(record: HistoryRecord): string {
+  const count = record.files.length;
+  const noun = count === 1 ? "file" : "files";
+  const verb = verbForKind(record.kind);
+
+  if (record.author.kind === "agent") {
+    // Attribute to the person the agent acted for, e.g. "Maya's agent".
+    return `${record.author.onBehalfOf}'s agent ${verb} ${count} ${noun}`;
+  }
+
+  // A single, named file reads better than a count for solo user edits.
+  if (count === 1) {
+    return `You ${verb} ${record.files[0].path}`;
+  }
+  return `You ${verb} ${count} ${noun}`;
+}
+
+function verbForKind(kind: ChangeSetKind): string {
+  switch (kind) {
+    case "import":
+      return "imported";
+    case "agent-run":
+      return "ran an agent over";
+    case "sync":
+      return "synced";
+    case "app-build":
+      return "built";
+    case "user-edit":
+    default:
+      return "edited";
+  }
+}
diff --git a/packages/workspace-sync/src/batchedSync.ts b/packages/workspace-sync/src/batchedSync.ts
new file mode 100644
index 0000000..079c877
--- /dev/null
+++ b/packages/workspace-sync/src/batchedSync.ts
@@ -0,0 +1,125 @@
+// Phase 5: turn the raw stream of file-watcher events into reviewable units.
+// Two pieces: a settle-window batcher that waits for the workspace to go quiet
+// before grouping events, and a mapper from a settled batch to a ChangeSet.
+// An agent run touching 18 files becomes ONE batch and ONE change set, not 18.
+
+import {
+  addFileChanges,
+  createChangeSet,
+  type ChangeAuthor,
+  type ChangeProvenance,
+  type ChangeSet,
+  type ChangeSetKind,
+  type FileChange,
+  type WatcherEvent,
+  type WatcherEventBatch,
+} from "@dohc/workspace-core";
+
+export interface SettleBatcherOptions {
+  // Quiet period (ms) the workspace must stay event-free before a batch emits.
+  windowMs: number;
+  // Injected clock so behavior is deterministic in tests and host-driven in
+  // production. Stamps each event's arrival time.
+  now: () => number;
+  onBatch: (batch: WatcherEventBatch) => void;
+}
+
+export interface SettleBatcher {
+  push(event: WatcherEvent): void;
+  // Probe called by the host (e.g. from a real interval) with the current time.
+  // Emits the pending batch when the workspace has been quiet for windowMs.
+  tick(currentMs: number): void;
+  // Emit any pending batch right now, ignoring the window (e.g. on shutdown).
+  flush(): void;
+}
+
+export function createSettleBatcher(
+  opts: SettleBatcherOptions,
+): SettleBatcher {
+  // Pending events keyed by path so rapid edits to the same file collapse into
+  // a single event carrying the latest sha256. Map preserves insertion order,
+  // so the emitted batch keeps first-seen ordering of paths.
+  const pending = new Map<string, WatcherEvent>();
+  let lastEventMs = 0;
+
+  function emit(settledAtMs: number): void {
+    if (pending.size === 0) return;
+    const batch: WatcherEventBatch = {
+      settledAtMs,
+      windowMs: opts.windowMs,
+      events: Array.from(pending.values()),
+    };
+    pending.clear();
+    opts.onBatch(batch);
+  }
+
+  return {
+    push(event: WatcherEvent): void {
+      // A later event for the same path supersedes the earlier one: keep the
+      // newest operation and sha256 (e.g. create then update -> latest update).
+      pending.set(event.path, event);
+      lastEventMs = opts.now();
+    },
+    tick(currentMs: number): void {
+      if (pending.size === 0) return;
+      if (currentMs - lastEventMs >= opts.windowMs) {
+        emit(currentMs);
+      }
+    },
+    flush(): void {
+      emit(opts.now());
+    },
+  };
+}
+
+// Watcher operations map onto the coarser change vocabulary: a create or an
+// update both land as a "write" (the file now has new content); delete and
+// rename pass through directly.
+function toFileChange(event: WatcherEvent): FileChange {
+  switch (event.operation) {
+    case "delete":
+      return { path: event.path, operation: "delete" };
+    case "rename":
+      return { path: event.path, operation: "rename" };
+    case "create":
+    case "update":
+      return { path: event.path, operation: "write" };
+  }
+}
+
+// Provenance source and change-set kind share the same vocabulary, so the kind
+// is just the source when known, defaulting to a plain user edit.
+function kindFromProvenance(provenance?: ChangeProvenance): ChangeSetKind {
+  return provenance?.source ?? "user-edit";
+}
+
+// A human-friendly default summary derived from the batch. Imports read
+// "Imported N files"; everything else reads "Edited N files".
+function defaultSummary(
+  count: number,
+  provenance?: ChangeProvenance,
+): string {
+  const noun = count === 1 ? "file" : "files";
+  const verb = provenance?.source === "import" ? "Imported" : "Edited";
+  return `${verb} ${count} ${noun}`;
+}
+
+export interface BatchToChangeSetInput {
+  author: ChangeAuthor;
+  summary?: string;
+  provenance?: ChangeProvenance;
+}
+
+export function batchToChangeSet(
+  batch: WatcherEventBatch,
+  input: BatchToChangeSetInput,
+): ChangeSet {
+  const files = batch.events.map(toFileChange);
+  const set = createChangeSet({
+    kind: kindFromProvenance(input.provenance),
+    author: input.author,
+    summary: input.summary ?? defaultSummary(files.length, input.provenance),
+    ...(input.provenance ? { provenance: input.provenance } : {}),
+  });
+  return addFileChanges(set, files);
+}

exec
/bin/bash -lc 'git show --patch --find-renames --find-copies eb6c0c3 -- apps/desktop/src/ipc/bridgeContract.ts apps/desktop/src/ipc/channels.ts apps/desktop/src/main.ts apps/desktop/src/preload.ts apps/desktop/src/renderer/DesktopWorkspaceShell.tsx apps/desktop/src/workspaces/registryStore.ts apps/desktop/src/workspaces/workspaceFiles.ts apps/desktop/electron.vite.config.ts apps/desktop/e2e/firstRunWorkspace.spec.ts apps/desktop/package.json packages/workspace-fs/package.json packages/workspace-fs/src/index.ts packages/workspace-sync/src/index.ts packages/workspace-history/src/index.ts pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md' in /home/ice/dev/dohc
 succeeded in 0ms:
commit eb6c0c3bab0a13dc4af935b9fe703dfa0961d328
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 19:37:16 2026 +0800

    phase5: file watcher, batched sync, and local-first history
    
    Three file-disjoint packages built in parallel against locked
    workspace-core contracts: workspace-fs gains a chokidar watcher with
    ignore rules (temp files, .dohc, SQLite WAL/journal sidecar collapse);
    workspace-sync gains a settle-window batcher (18 rapid writes -> one
    change set) + batch->ChangeSet; workspace-history persists change sets
    as inspectable JSON under .dohc/history/ with a newest-first,
    attributed, git-marker-free timeline. Desktop wires the live
    watcher->history pipeline into a visible History timeline (the "git
    log for everyday people") and a live sync-status footer. A screenshot
    caught a feedback loop (watcher recording its own .dohc writes via
    chokidar's absolute-path ignored predicate) — fixed at two layers and
    regressed at fs-unit + E2E. 146 unit tests + 4 E2E + smoke green.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/apps/desktop/e2e/firstRunWorkspace.spec.ts b/apps/desktop/e2e/firstRunWorkspace.spec.ts
index ccd3da3..e9065db 100644
--- a/apps/desktop/e2e/firstRunWorkspace.spec.ts
+++ b/apps/desktop/e2e/firstRunWorkspace.spec.ts
@@ -71,12 +71,14 @@ test("first run creates a real workspace folder and lands in a native shell", as
     mode: "local-first",
   });
 
-  // --- Shell surfaces: sidebar/file tree, status, agent panel ---
+  // --- Shell surfaces: sidebar/file tree, status, history timeline ---
   await expect(page.getByTestId("file-tree")).toBeVisible();
   await expect(page.getByTestId("sync-status")).toBeVisible();
-  await expect(page.getByTestId("agent-panel")).toBeVisible();
-  // Agent activity is a panel with an empty-state action, not a paragraph.
-  await expect(page.getByTestId("agent-panel")).toContainText(/no agent runs/i);
+  await expect(page.getByTestId("history-timeline")).toBeVisible();
+  // History is a panel with a designed empty state, not a paragraph dump.
+  await expect(page.getByTestId("history-timeline")).toContainText(
+    /no changes yet/i,
+  );
 
   // --- Keyboard: new file ---
   await page.keyboard.press("ControlOrMeta+n");
@@ -89,6 +91,15 @@ test("first run creates a real workspace folder and lands in a native shell", as
   ).toBeVisible();
   expect(existsSync(join(workspaceRoot, "notes", "today.md"))).toBe(true);
 
+  // --- The watcher records the change into the visible history timeline ---
+  await expect(page.getByTestId("history-timeline")).toContainText(
+    /today\.md/i,
+    { timeout: 15_000 },
+  );
+  // The watcher must NEVER record its own .dohc writes (feedback loop): the
+  // timeline shows user files only.
+  await expect(page.getByTestId("history-timeline")).not.toContainText(".dohc");
+
   // --- Keyboard: command palette opens, filters, closes ---
   await page.keyboard.press("ControlOrMeta+k");
   const palette = page.getByTestId("command-palette");
diff --git a/apps/desktop/electron.vite.config.ts b/apps/desktop/electron.vite.config.ts
index 53a7d24..8ec511f 100644
--- a/apps/desktop/electron.vite.config.ts
+++ b/apps/desktop/electron.vite.config.ts
@@ -6,7 +6,18 @@ export default defineConfig({
   main: {
     // Workspace packages ship raw TS — they must be bundled, not
     // externalized, or Node ESM fails on their extensionless imports.
-    plugins: [externalizeDepsPlugin({ exclude: ["@dohc/workspace-core"] })],
+    // chokidar and other real npm deps stay external (loaded from node_modules).
+    plugins: [
+      externalizeDepsPlugin({
+        exclude: [
+          "@dohc/workspace-core",
+          "@dohc/workspace-contracts",
+          "@dohc/workspace-fs",
+          "@dohc/workspace-sync",
+          "@dohc/workspace-history",
+        ],
+      }),
+    ],
     build: {
       outDir: "dist/main",
       lib: { entry: "src/main.ts" },
diff --git a/apps/desktop/package.json b/apps/desktop/package.json
index 0a2d68f..08548e9 100644
--- a/apps/desktop/package.json
+++ b/apps/desktop/package.json
@@ -32,6 +32,9 @@
   "dependencies": {
     "@dohc/brand": "workspace:*",
     "@dohc/workspace-core": "workspace:*",
+    "@dohc/workspace-fs": "workspace:*",
+    "@dohc/workspace-history": "workspace:*",
+    "@dohc/workspace-sync": "workspace:*",
     "electron-updater": "^6.8.9",
     "lucide-react": "^1.16.0",
     "react": "^19.2.6",
diff --git a/apps/desktop/src/ipc/bridgeContract.ts b/apps/desktop/src/ipc/bridgeContract.ts
index 3b4e3bd..68da86e 100644
--- a/apps/desktop/src/ipc/bridgeContract.ts
+++ b/apps/desktop/src/ipc/bridgeContract.ts
@@ -95,6 +95,49 @@ export type ImportWorkspaceFilesResult = z.infer<
   typeof ImportWorkspaceFilesResult
 >;
 
+export const OpenWorkspacePayload = z.object({
+  workspaceId: WORKSPACE_ID,
+});
+export type OpenWorkspacePayload = z.infer<typeof OpenWorkspacePayload>;
+
+export const SyncStatusResult = z.object({
+  state: z.enum([
+    "synced",
+    "syncing",
+    "local-changes",
+    "conflict",
+    "cloud-disconnected",
+  ]),
+  pendingChangeCount: z.number().int().nonnegative(),
+  lastSyncedAtMs: z.number().nullable(),
+});
+export type SyncStatusResult = z.infer<typeof SyncStatusResult>;
+
+const ChangeAuthorSchema = z.union([
+  z.object({ kind: z.literal("user"), userId: z.string() }),
+  z.object({
+    kind: z.literal("agent"),
+    agentId: z.string(),
+    onBehalfOf: z.string(),
+  }),
+]);
+
+export const ChangeSetRecord = z.object({
+  id: z.string().min(1),
+  recordedAtMs: z.number(),
+  kind: z.enum(["user-edit", "agent-run", "import", "sync", "app-build"]),
+  author: ChangeAuthorSchema,
+  summary: z.string(),
+  humanSummary: z.string(),
+  fileCount: z.number().int().nonnegative(),
+});
+export type ChangeSetRecord = z.infer<typeof ChangeSetRecord>;
+
+export const ListChangeSetsResult = z.object({
+  changeSets: z.array(ChangeSetRecord),
+});
+export type ListChangeSetsResult = z.infer<typeof ListChangeSetsResult>;
+
 export const LaunchMarksResult = z.object({
   appReadyMs: z.number().positive(),
   firstWindowMs: z.number().positive(),
@@ -122,4 +165,13 @@ export interface DohcDesktopBridge {
   importWorkspaceFiles(
     payload: ImportWorkspaceFilesPayload,
   ): Promise<ImportWorkspaceFilesResult>;
+  openWorkspace(payload: OpenWorkspacePayload): Promise<SyncStatusResult>;
+  listChangeSets(
+    payload: ListWorkspaceFilesPayload,
+  ): Promise<ListChangeSetsResult>;
+  getSyncStatus(payload: ListWorkspaceFilesPayload): Promise<SyncStatusResult>;
+  // Live push: main signals the renderer when the active workspace's files
+  // or history changed (settled filesystem batch recorded). Returns an
+  // unsubscribe function.
+  onWorkspaceActivity(listener: () => void): () => void;
 }
diff --git a/apps/desktop/src/ipc/channels.ts b/apps/desktop/src/ipc/channels.ts
index e71df11..7b98f4e 100644
--- a/apps/desktop/src/ipc/channels.ts
+++ b/apps/desktop/src/ipc/channels.ts
@@ -7,6 +7,10 @@ export const CHANNELS = {
   listWorkspaceFiles: "desktop:list-workspace-files",
   createWorkspaceFile: "desktop:create-workspace-file",
   importWorkspaceFiles: "desktop:import-workspace-files",
+  openWorkspace: "desktop:open-workspace",
+  listChangeSets: "desktop:list-change-sets",
+  getSyncStatus: "desktop:get-sync-status",
+  workspaceActivity: "desktop:workspace-activity",
   firstPaint: "desktop:first-paint",
   getLaunchMarks: "desktop:test:get-launch-marks",
 } as const;
diff --git a/apps/desktop/src/main.ts b/apps/desktop/src/main.ts
index af5ec45..8505bf2 100644
--- a/apps/desktop/src/main.ts
+++ b/apps/desktop/src/main.ts
@@ -3,8 +3,8 @@ import {
   normalizeAbsolutePath,
   validateWorkspaceRootChoice,
 } from "@dohc/workspace-core";
-import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
-import { relative, sep } from "node:path";
+import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
+import { isAbsolute, relative, sep } from "node:path";
 import {
   AttachWorkspaceFolderPayload,
   CreateLocalWorkspacePayload,
@@ -14,9 +14,12 @@ import {
   ImportWorkspaceFilesPayload,
   ImportWorkspaceFilesResult,
   LaunchMarksResult,
+  ListChangeSetsResult,
   ListWorkspaceFilesPayload,
   ListWorkspaceFilesResult,
+  OpenWorkspacePayload,
   PickWorkspaceRootResult,
+  SyncStatusResult,
   WorkspaceRegistryResult,
   WorkspaceSummary,
 } from "./ipc/bridgeContract";
@@ -31,6 +34,7 @@ import {
   listWorkspaces,
   registerWorkspace,
 } from "./workspaces/WorkspaceRegistry";
+import { createWorkspaceActivity } from "./workspaces/workspaceActivity";
 import {
   copyIntoWorkspace,
   createFile,
@@ -43,6 +47,16 @@ function requireWorkspace(workspaceId: string) {
   return workspace;
 }
 
+// Live file-watch → history pipeline. Pushes a renderer notification whenever
+// a settled batch is recorded so the file tree, timeline, and sync status
+// refresh without polling.
+const activity = createWorkspaceActivity(() => {
+  for (const win of BrowserWindow.getAllWindows()) {
+    win.webContents.send(CHANNELS.workspaceActivity);
+  }
+});
+app.on("will-quit", () => activity.stopAll());
+
 // Workspace roots the main process itself produced — the default suggestion
 // and any folder the user chose through the real OS dialog. A renderer cannot
 // invent a path (e.g. ~/.ssh) it was never handed; create/attach roots must
@@ -58,7 +72,14 @@ function isApprovedRoot(normalized: string): boolean {
   for (const approved of approvedRoots) {
     if (normalized === approved) return true;
     const rel = relative(approved, normalized);
-    if (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep)) {
+    // On Windows, relative() across drives returns an absolute path
+    // (C:\ws -> D:\evil gives "D:\evil"), which is NOT a descendant.
+    if (
+      rel.length > 0 &&
+      !isAbsolute(rel) &&
+      !rel.startsWith("..") &&
+      !rel.startsWith(sep)
+    ) {
       return true;
     }
   }
@@ -184,6 +205,29 @@ function registerIpcHandlers(): void {
     return ImportWorkspaceFilesResult.parse({ imported });
   });
 
+  ipcMain.handle(CHANNELS.openWorkspace, (event, payload) => {
+    assertTrustedSender(event);
+    const input = OpenWorkspacePayload.parse(payload);
+    const workspace = requireWorkspace(input.workspaceId);
+    return SyncStatusResult.parse(activity.open(workspace));
+  });
+
+  ipcMain.handle(CHANNELS.listChangeSets, async (event, payload) => {
+    assertTrustedSender(event);
+    const input = ListWorkspaceFilesPayload.parse(payload);
+    const workspace = requireWorkspace(input.workspaceId);
+    return ListChangeSetsResult.parse({
+      changeSets: await activity.listChangeSets(workspace),
+    });
+  });
+
+  ipcMain.handle(CHANNELS.getSyncStatus, (event, payload) => {
+    assertTrustedSender(event);
+    const input = ListWorkspaceFilesPayload.parse(payload);
+    requireWorkspace(input.workspaceId);
+    return SyncStatusResult.parse(activity.getStatus(input.workspaceId));
+  });
+
   ipcMain.on(CHANNELS.firstPaint, (event) => {
     if (isTrustedFrame(event.senderFrame?.url ?? "")) {
       launchMarks.firstPaint();
diff --git a/apps/desktop/src/preload.ts b/apps/desktop/src/preload.ts
index 9be669c..b0ce479 100644
--- a/apps/desktop/src/preload.ts
+++ b/apps/desktop/src/preload.ts
@@ -24,6 +24,15 @@ const bridge: DohcDesktopBridge = {
     ipcRenderer.invoke(CHANNELS.createWorkspaceFile, payload),
   importWorkspaceFiles: (payload) =>
     ipcRenderer.invoke(CHANNELS.importWorkspaceFiles, payload),
+  openWorkspace: (payload) => ipcRenderer.invoke(CHANNELS.openWorkspace, payload),
+  listChangeSets: (payload) =>
+    ipcRenderer.invoke(CHANNELS.listChangeSets, payload),
+  getSyncStatus: (payload) => ipcRenderer.invoke(CHANNELS.getSyncStatus, payload),
+  onWorkspaceActivity: (listener: () => void) => {
+    const handler = () => listener();
+    ipcRenderer.on(CHANNELS.workspaceActivity, handler);
+    return () => ipcRenderer.removeListener(CHANNELS.workspaceActivity, handler);
+  },
 };
 
 contextBridge.exposeInMainWorld("dohcDesktop", bridge);
diff --git a/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx b/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
index 2ca32e6..e348867 100644
--- a/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
+++ b/apps/desktop/src/renderer/DesktopWorkspaceShell.tsx
@@ -6,11 +6,34 @@ import {
   Database,
   FilePlus2,
   FileText,
+  History,
   Import,
   LayoutGrid,
+  User,
 } from "lucide-react";
+
+const SYNC_LABEL: Record<SyncStatusResult["state"], string> = {
+  synced: "Local · saved",
+  syncing: "Saving…",
+  "local-changes": "Local changes",
+  conflict: "Conflict",
+  "cloud-disconnected": "Cloud disconnected",
+};
+
+const SYNC_DOT: Record<SyncStatusResult["state"], string> = {
+  synced: "bg-success",
+  syncing: "bg-warning",
+  "local-changes": "bg-warning",
+  conflict: "bg-danger",
+  "cloud-disconnected": "bg-subtle",
+};
 import { memo, useCallback, useEffect, useMemo, useState } from "react";
-import type { WorkspaceFileEntry, WorkspaceSummary } from "../ipc/bridgeContract";
+import type {
+  ChangeSetRecord,
+  SyncStatusResult,
+  WorkspaceFileEntry,
+  WorkspaceSummary,
+} from "../ipc/bridgeContract";
 import { bridge } from "./bridge";
 import { CommandPalette, type Command } from "./CommandPalette";
 import { NewFileDialog } from "./NewFileDialog";
@@ -58,6 +81,8 @@ export function DesktopWorkspaceShell(props: {
   onSwitchWorkspace: (workspace: Workspace) => void;
 }) {
   const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
+  const [changeSets, setChangeSets] = useState<ChangeSetRecord[]>([]);
+  const [syncStatus, setSyncStatus] = useState<SyncStatusResult | null>(null);
   const [selected, setSelected] = useState<string | null>(null);
   const [paletteOpen, setPaletteOpen] = useState(false);
   const [newFileOpen, setNewFileOpen] = useState(false);
@@ -65,25 +90,49 @@ export function DesktopWorkspaceShell(props: {
   const [switcherOpen, setSwitcherOpen] = useState(false);
   const [cloudOpen, setCloudOpen] = useState(false);
 
+  const workspaceId = props.workspace.workspaceId;
+
   const refreshFiles = useCallback(async () => {
-    const result = await bridge().listWorkspaceFiles({
-      workspaceId: props.workspace.workspaceId,
-    });
+    const result = await bridge().listWorkspaceFiles({ workspaceId });
     setFiles(result.files);
-  }, [props.workspace.workspaceId]);
+  }, [workspaceId]);
+
+  const refreshHistory = useCallback(async () => {
+    const [history, status] = await Promise.all([
+      bridge().listChangeSets({ workspaceId }),
+      bridge().getSyncStatus({ workspaceId }),
+    ]);
+    setChangeSets(history.changeSets);
+    setSyncStatus(status);
+  }, [workspaceId]);
 
   const importFiles = useCallback(async () => {
-    await bridge().importWorkspaceFiles({
-      workspaceId: props.workspace.workspaceId,
-    });
+    await bridge().importWorkspaceFiles({ workspaceId });
     await refreshFiles();
-  }, [props.workspace.workspaceId, refreshFiles]);
+  }, [workspaceId, refreshFiles]);
 
   const selectFile = useCallback((path: string) => setSelected(path), []);
 
+  // Open the workspace (starts the file watcher in main), load the initial
+  // file tree + history, and refresh everything whenever a settled batch is
+  // recorded — the timeline and status stay live without polling.
   useEffect(() => {
-    void refreshFiles();
-  }, [refreshFiles]);
+    let cancelled = false;
+    void (async () => {
+      const status = await bridge().openWorkspace({ workspaceId });
+      if (!cancelled) setSyncStatus(status);
+      await refreshFiles();
+      await refreshHistory();
+    })();
+    const unsubscribe = bridge().onWorkspaceActivity(() => {
+      void refreshFiles();
+      void refreshHistory();
+    });
+    return () => {
+      cancelled = true;
+      unsubscribe();
+    };
+  }, [workspaceId, refreshFiles, refreshHistory]);
 
   useEffect(() => {
     function onKeyDown(event: KeyboardEvent) {
@@ -281,23 +330,49 @@ export function DesktopWorkspaceShell(props: {
           )}
         </main>
 
-        {/* Agent activity panel */}
+        {/* History timeline — the "git log for everyday people". Every
+            settled change (yours or your agent's) lands here, newest first. */}
         <aside
-          data-testid="agent-panel"
-          aria-label="Agent activity"
+          data-testid="history-timeline"
+          aria-label="History"
           className="flex w-64 shrink-0 flex-col border-l border-line bg-panel-2"
         >
           <header className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-[13px] font-semibold">
-            <Bot size={14} aria-hidden />
-            Agent activity
+            <History size={14} aria-hidden />
+            History
           </header>
-          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
-            <span className="text-xs text-muted">No agent runs yet</span>
-            <span className="text-[11px] text-subtle">
-              Point Codex or Claude Code at this folder — changes show up here
-              as a timeline.
-            </span>
-          </div>
+          {changeSets.length === 0 ? (
+            <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
+              <span className="text-xs text-muted">No changes yet</span>
+              <span className="text-[11px] text-subtle">
+                Edits — yours or your agent's — show up here as a timeline you
+                can review.
+              </span>
+            </div>
+          ) : (
+            <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
+              {changeSets.map((change) => (
+                <li
+                  key={change.id}
+                  className="flex flex-col gap-0.5 border-b border-line px-3 py-2"
+                >
+                  <span className="flex items-center gap-1.5 text-[12px] text-ink">
+                    {change.author.kind === "agent" ? (
+                      <Bot size={12} aria-hidden className="shrink-0 text-subtle" />
+                    ) : (
+                      <User size={12} aria-hidden className="shrink-0 text-subtle" />
+                    )}
+                    <span className="truncate">{change.humanSummary}</span>
+                  </span>
+                  <span className="text-[10px] text-subtle">
+                    {change.fileCount} file{change.fileCount === 1 ? "" : "s"}
+                    {" · "}
+                    {change.kind}
+                  </span>
+                </li>
+              ))}
+            </ul>
+          )}
         </aside>
       </div>
 
@@ -305,13 +380,14 @@ export function DesktopWorkspaceShell(props: {
       <footer className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel-2 px-3">
         <span
           data-testid="sync-status"
+          data-state={syncStatus?.state ?? "synced"}
           className="flex items-center gap-1.5 text-[11px] text-muted"
         >
           <span
             aria-hidden
-            className="inline-block h-1.5 w-1.5 rounded-full bg-success"
+            className={`inline-block h-1.5 w-1.5 rounded-full ${SYNC_DOT[syncStatus?.state ?? "synced"]}`}
           />
-          Local · saved
+          {SYNC_LABEL[syncStatus?.state ?? "synced"]}
         </span>
         <button
           type="button"
diff --git a/apps/desktop/src/workspaces/registryStore.ts b/apps/desktop/src/workspaces/registryStore.ts
index 5f0cefa..7622f7b 100644
--- a/apps/desktop/src/workspaces/registryStore.ts
+++ b/apps/desktop/src/workspaces/registryStore.ts
@@ -31,8 +31,15 @@ export function createRegistryStore(registryFile: string) {
     let text: string;
     try {
       text = readFileSync(registryFile, "utf8");
-    } catch {
-      // Genuinely absent: a fresh empty registry is correct.
+    } catch (error) {
+      // Only a genuinely absent file is a fresh empty registry. A permission
+      // or I/O error must NOT be treated as "no workspaces" — that would let
+      // the next write() clobber a registry we simply failed to read.
+      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
+        throw new Error(
+          `Cannot read workspace registry (${registryFile}); refusing to overwrite it.`,
+        );
+      }
       cache = { version: 1, workspaces: [] };
       return cache;
     }
diff --git a/apps/desktop/src/workspaces/workspaceFiles.ts b/apps/desktop/src/workspaces/workspaceFiles.ts
index 2caa894..096d2ea 100644
--- a/apps/desktop/src/workspaces/workspaceFiles.ts
+++ b/apps/desktop/src/workspaces/workspaceFiles.ts
@@ -4,7 +4,7 @@ import {
 } from "@dohc/workspace-core";
 import { constants } from "node:fs";
 import { copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
-import { basename, dirname, join, relative, sep } from "node:path";
+import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
 
 // Deepest already-existing ancestor of a (possibly not-yet-created) path —
 // the part realpath can resolve, so we can check containment BEFORE mkdir.
@@ -25,10 +25,17 @@ import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
 const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);
 
 // True iff `child` is the same as or nested under `parent` (both real paths).
+// On Windows, relative() across drives returns an absolute path (e.g.
+// C:\ws -> D:\evil gives "D:\evil"), which is not a descendant.
 function isInside(parent: string, child: string): boolean {
   if (child === parent) return true;
   const rel = relative(parent, child);
-  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`${sep}`);
+  return (
+    rel.length > 0 &&
+    !isAbsolute(rel) &&
+    !rel.startsWith("..") &&
+    !rel.startsWith(`${sep}`)
+  );
 }
 
 export async function listFiles(
diff --git a/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md b/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
index 766d57e..3dd57a9 100644
--- a/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
+++ b/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
@@ -147,6 +147,30 @@ Consult high-value batches (await verifier confirmation before fixing; transcrib
 
 ## Phase Logs
 
+### Phase 5: File Watcher, Batched Sync, And Local-First History
+
+- Status: in progress (all gates green; commit pending; then verifiers + codex)
+- Execution map: recon fan-out → lock 4 contracts in workspace-core (committed ce589f3) → scaffold workspace-sync + workspace-history, add chokidar → 3 parallel worktree-equivalent lanes (file-disjoint packages) → merge → lead-owned shell wiring (sync status binding + history timeline panel + IPC) → live-pipeline E2E → bug found via screenshot (feedback loop) → fixed + regressed → gate green.
+- Resume notes: ready to commit phase5; then verifier fan-out + codex review.
+- Files changed: packages/workspace-core (watcher.ts, syncStatus.ts + test, changeSet provenance — committed ce589f3); packages/workspace-fs (watchEvents.ts + test — lane A + absolute-path ignore fix); packages/workspace-sync (batchedSync.ts + test + index — lane B); packages/workspace-history (changeSetStore.ts + test + index — lane C); apps/desktop (workspaceWatcher.ts, workspaceActivity.ts, ipc channels/contract, main handlers, preload, DesktopWorkspaceShell history timeline + sync-status binding, e2e); deps + lockfile
+- Code deleted or consolidated: agent-panel placeholder → real History timeline; hardcoded "Local · saved" → live SyncStatus binding
+- Net LOC delta: recorded at commit
+- Dependencies added: chokidar ^5 (workspace-fs); workspace-fs/sync/history added as desktop deps; workspace-core added as workspace-fs dep (lane A discovered it was unlinked)
+- Decisions made: D-15/16/17 (lane boundaries, JSON history not SQLite, chokidar+pure-logic split — all in pre-phase section); D-18 | createSettleBatcher (workspace-sync) is public package API for Phase 9 cloud-push settling; live local pipeline uses the watcher's own settle + batchToChangeSet (the watcher debounces fs noise; the batcher will settle change-sets before remote POST) — both legitimate, knip-allowlisted as public exports
+- Tests added: workspace-core +6 (syncStatus); workspace-fs +18 (ignore rules, sidecar collapse, watcher wrapper incl. .dohc-absolute-path regression); workspace-sync +15 (settle batcher, 18-writes→1-changeset, batch→ChangeSet); workspace-history +9 (JSON store, newest-first, attributed humanSummary, no git markers); desktop E2E +live-pipeline assertions (file edit → timeline entry; NO .dohc in timeline)
+- Commands run: per-lane RED→GREEN; all 5 package suites (core 54, fs 26, sync 15, history 9, desktop 42) + typechecks + build + 4 E2E + smoke — green under pinned Node
+- Failing tests fixed: feedback-loop bug (watcher recorded its own .dohc/history writes — chokidar passes ABSOLUTE paths to ignored predicate, shouldIgnoreWatchPath expected relative) — FIXED: relativize in watcher ignored predicate + defense-in-depth filter in workspaceWatcher; regressed at fs-unit AND E2E level. Caught by the Phase-5 design screenshot.
+- Electron E2E/manual smoke: 4/4 E2E + smoke green
+- UI/UX screenshot/design review: History timeline screenshot inspected — clean (warm panel, user/agent icon, "You edited notes/today.md", file count + kind), no .dohc noise after fix. Sync-status footer binds to live state (synced/syncing/local-changes/conflict/cloud-disconnected with state-driven dot color).
+- Performance measurements: watcher settle 500ms; no polling loop (chokidar event-driven); registry parsed-cache from checkpoint-1 avoids per-IPC reads. Virtualization of timeline/tree deferred to Phase 16.
+- Security/collaboration regressions: .dohc never recorded (feedback-loop guard, 2 layers); history is inspectable JSON under .dohc/history; no git markers in summaries (asserted)
+- Reviewer/subagent findings: 3 lanes all GREEN with recorded RED; pending pre-commit verifier fan-out
+- Codex third-party review findings: pending post-commit (high-risk phase — data/sync)
+- Relevant findings fixed: feedback-loop pre-commit
+- Deferred findings with reason: live co-editing/conflict states (Phase 10); cloud-disconnected reachable Phase 9; timeline virtualization Phase 16
+- Remaining risk: chokidar timing under heavy load unmeasured (Phase 16); settle window fixed at 500ms (per-file-type windows from plan deferred — markdown/app/sqlite all use one window for now)
+- Next phase: 6
+
 ### Phase 0: Baseline, Tooling, And Old-Plan Inventory
 
 - Status: in progress
diff --git a/packages/workspace-fs/package.json b/packages/workspace-fs/package.json
index 5704363..8ad4643 100644
--- a/packages/workspace-fs/package.json
+++ b/packages/workspace-fs/package.json
@@ -12,6 +12,7 @@
   },
   "dependencies": {
     "@dohc/workspace-contracts": "workspace:*",
+    "@dohc/workspace-core": "workspace:*",
     "chokidar": "^5.0.0"
   },
   "devDependencies": {
diff --git a/packages/workspace-fs/src/index.ts b/packages/workspace-fs/src/index.ts
index 1971ed1..80bb3d7 100644
--- a/packages/workspace-fs/src/index.ts
+++ b/packages/workspace-fs/src/index.ts
@@ -5,3 +5,4 @@ export * from "./metadata";
 export * from "./scan";
 export * from "./syncClient";
 export * from "./watch";
+export * from "./watchEvents";
diff --git a/packages/workspace-history/src/index.ts b/packages/workspace-history/src/index.ts
new file mode 100644
index 0000000..f4e6cfd
--- /dev/null
+++ b/packages/workspace-history/src/index.ts
@@ -0,0 +1 @@
+export * from "./changeSetStore";
diff --git a/packages/workspace-sync/src/index.ts b/packages/workspace-sync/src/index.ts
new file mode 100644
index 0000000..31eb254
--- /dev/null
+++ b/packages/workspace-sync/src/index.ts
@@ -0,0 +1 @@
+export * from "./batchedSync";
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 78427af..efb1bdc 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -216,6 +216,15 @@ importers:
       '@dohc/workspace-core':
         specifier: workspace:*
         version: link:../../packages/workspace-core
+      '@dohc/workspace-fs':
+        specifier: workspace:*
+        version: link:../../packages/workspace-fs
+      '@dohc/workspace-history':
+        specifier: workspace:*
+        version: link:../../packages/workspace-history
+      '@dohc/workspace-sync':
+        specifier: workspace:*
+        version: link:../../packages/workspace-sync
       electron-updater:
         specifier: ^6.8.9
         version: 6.8.9
@@ -347,6 +356,9 @@ importers:
       '@dohc/workspace-contracts':
         specifier: workspace:*
         version: link:../workspace-contracts
+      '@dohc/workspace-core':
+        specifier: workspace:*
+        version: link:../workspace-core
       chokidar:
         specifier: ^5.0.0
         version: 5.0.0

exec
/bin/bash -lc "git show --patch --find-renames eb6c0c3 -- packages/workspace-fs/src/watchEvents.test.ts packages/workspace-sync/src/batchedSync.test.ts packages/workspace-history/src/changeSetStore.test.ts | sed -n '1,260p'" in /home/ice/dev/dohc
 succeeded in 0ms:
commit eb6c0c3bab0a13dc4af935b9fe703dfa0961d328
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 19:37:16 2026 +0800

    phase5: file watcher, batched sync, and local-first history
    
    Three file-disjoint packages built in parallel against locked
    workspace-core contracts: workspace-fs gains a chokidar watcher with
    ignore rules (temp files, .dohc, SQLite WAL/journal sidecar collapse);
    workspace-sync gains a settle-window batcher (18 rapid writes -> one
    change set) + batch->ChangeSet; workspace-history persists change sets
    as inspectable JSON under .dohc/history/ with a newest-first,
    attributed, git-marker-free timeline. Desktop wires the live
    watcher->history pipeline into a visible History timeline (the "git
    log for everyday people") and a live sync-status footer. A screenshot
    caught a feedback loop (watcher recording its own .dohc writes via
    chokidar's absolute-path ignored predicate) — fixed at two layers and
    regressed at fs-unit + E2E. 146 unit tests + 4 E2E + smoke green.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/packages/workspace-fs/src/watchEvents.test.ts b/packages/workspace-fs/src/watchEvents.test.ts
new file mode 100644
index 0000000..98cd7b8
--- /dev/null
+++ b/packages/workspace-fs/src/watchEvents.test.ts
@@ -0,0 +1,216 @@
+import { describe, expect, it } from "vitest";
+import type { WatcherEvent } from "@dohc/workspace-core";
+import {
+  collapseSqliteSidecars,
+  shouldIgnoreWatchPath,
+  watchWorkspaceEvents,
+} from "./watchEvents";
+
+describe("shouldIgnoreWatchPath", () => {
+  it("ignores everything under the reserved .dohc/ tree", () => {
+    // .dohc/ holds dohc's own derived/reserved state; raw fs noise from it must
+    // never surface as user file ops or it would loop sync back on itself.
+    expect(shouldIgnoreWatchPath(".dohc")).toBe(true);
+    expect(shouldIgnoreWatchPath(".dohc/registry.json")).toBe(true);
+    expect(shouldIgnoreWatchPath(".dohc/cache/blob-0001")).toBe(true);
+    expect(shouldIgnoreWatchPath(".dohc/cache/nested/deep/file")).toBe(true);
+    // Case-insensitive: on macOS/Windows .DOHC aliases .dohc.
+    expect(shouldIgnoreWatchPath(".DOHC/cache/x")).toBe(true);
+    expect(shouldIgnoreWatchPath(".Dohc")).toBe(true);
+  });
+
+  it("does not ignore a sibling whose name merely starts with .dohc", () => {
+    // ".dohcrc" is a distinct file, not the reserved ".dohc/" directory.
+    expect(shouldIgnoreWatchPath(".dohcrc")).toBe(false);
+    expect(shouldIgnoreWatchPath("notes/.dohc-notes.md")).toBe(false);
+  });
+
+  it("ignores editor temp / swap / autosave files", () => {
+    expect(shouldIgnoreWatchPath("notes/draft.tmp")).toBe(true);
+    expect(shouldIgnoreWatchPath("notes/draft.tmp.1234")).toBe(true);
+    expect(shouldIgnoreWatchPath("notes/today.md.swp")).toBe(true);
+    expect(shouldIgnoreWatchPath("notes/today.md.swo")).toBe(true);
+    expect(shouldIgnoreWatchPath("notes/today.md~")).toBe(true);
+    expect(shouldIgnoreWatchPath("#today.md#")).toBe(true);
+    expect(shouldIgnoreWatchPath("notes/#today.md#")).toBe(true);
+    expect(shouldIgnoreWatchPath(".DS_Store")).toBe(true);
+    expect(shouldIgnoreWatchPath("notes/.DS_Store")).toBe(true);
+  });
+
+  it("ignores SQLite sidecar journals and shared-memory files", () => {
+    expect(shouldIgnoreWatchPath("finance/wallet.db-wal")).toBe(true);
+    expect(shouldIgnoreWatchPath("finance/wallet.db-journal")).toBe(true);
+    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-wal")).toBe(true);
+    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-journal")).toBe(true);
+    expect(shouldIgnoreWatchPath("finance/wallet.db-shm")).toBe(true);
+    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-shm")).toBe(true);
+  });
+
+  it("keeps normal user files watchable", () => {
+    expect(shouldIgnoreWatchPath("notes/today.md")).toBe(false);
+    expect(shouldIgnoreWatchPath("finance/wallet.sqlite")).toBe(false);
+    expect(shouldIgnoreWatchPath("finance/wallet.db")).toBe(false);
+    expect(shouldIgnoreWatchPath("finance/.apps/ledger/app.json")).toBe(false);
+    // A file that merely mentions "tmp"/"swp"/"wal" in its name is fine.
+    expect(shouldIgnoreWatchPath("notes/tmp-ideas.md")).toBe(false);
+    expect(shouldIgnoreWatchPath("notes/swap-meet.md")).toBe(false);
+    expect(shouldIgnoreWatchPath("data/walmart.csv")).toBe(false);
+  });
+
+  it("normalizes backslash separators before matching", () => {
+    // Watchers on Windows hand back backslash paths; the reserved/cache guard
+    // must still fire.
+    expect(shouldIgnoreWatchPath(".dohc\\cache\\blob")).toBe(true);
+    expect(shouldIgnoreWatchPath("notes\\today.md")).toBe(false);
+  });
+});
+
+const update = (path: string): WatcherEvent => ({ path, operation: "update" });
+
+describe("collapseSqliteSidecars", () => {
+  it("collapses a sidecar event into a single update for its base db", () => {
+    // SQLite writes hit wallet.db-wal first; the base wallet.db may not emit an
+    // fs event at all, so a WAL touch must still surface as one base-db update.
+    const out = collapseSqliteSidecars([update("finance/wallet.db-wal")]);
+    expect(out).toEqual([update("finance/wallet.db")]);
+  });
+
+  it("collapses .sqlite-* and -shm sidecars to their base too", () => {
+    expect(collapseSqliteSidecars([update("a/x.sqlite-journal")])).toEqual([
+      update("a/x.sqlite"),
+    ]);
+    expect(collapseSqliteSidecars([update("a/x.sqlite-wal")])).toEqual([
+      update("a/x.sqlite"),
+    ]);
+    expect(collapseSqliteSidecars([update("a/x.db-shm")])).toEqual([
+      update("a/x.db"),
+    ]);
+  });
+
+  it("drops the sidecar event when the base db also changed", () => {
+    // Both base and WAL emitted: keep exactly one base update, drop the sidecar.
+    const out = collapseSqliteSidecars([
+      update("finance/wallet.db"),
+      update("finance/wallet.db-wal"),
+      update("finance/wallet.db-shm"),
+    ]);
+    expect(out).toEqual([update("finance/wallet.db")]);
+  });
+
+  it("deduplicates multiple sidecars of the same base into one update", () => {
+    const out = collapseSqliteSidecars([
+      update("finance/wallet.db-wal"),
+      update("finance/wallet.db-shm"),
+      update("finance/wallet.db-journal"),
+    ]);
+    expect(out).toEqual([update("finance/wallet.db")]);
+  });
+
+  it("forces the base-db event to 'update' even if the base arrived as create/delete", () => {
+    // A WAL checkpoint reads as a delete of the sidecar, but the user-facing
+    // truth is that the database content changed — never report it as a delete.
+    const out = collapseSqliteSidecars([
+      { path: "finance/wallet.db", operation: "create" },
+      { path: "finance/wallet.db-wal", operation: "delete" },
+    ]);
+    expect(out).toEqual([update("finance/wallet.db")]);
+  });
+
+  it("preserves base-db event order while collapsing in place", () => {
+    const out = collapseSqliteSidecars([
+      update("notes/today.md"),
+      update("finance/wallet.db-wal"),
+      update("inbox/scan.png"),
+    ]);
+    expect(out).toEqual([
+      update("notes/today.md"),
+      update("finance/wallet.db"),
+      update("inbox/scan.png"),
+    ]);
+  });
+
+  it("collapses sidecars for several distinct databases independently", () => {
+    const out = collapseSqliteSidecars([
+      update("a/one.db-wal"),
+      update("b/two.sqlite-shm"),
+      update("b/two.sqlite-wal"),
+    ]);
+    expect(out).toEqual([update("a/one.db"), update("b/two.sqlite")]);
+  });
+
+  it("leaves non-sqlite and bare-db events untouched", () => {
+    const events = [update("notes/today.md"), update("finance/wallet.db")];
+    expect(collapseSqliteSidecars(events)).toEqual(events);
+  });
+
+  it("never emits a sidecar path as a user file op", () => {
+    const out = collapseSqliteSidecars([
+      update("finance/wallet.db-wal"),
+      update("finance/wallet.db-shm"),
+      update("finance/wallet.db-journal"),
+      update("finance/wallet.sqlite-wal"),
+    ]);
+    for (const event of out) {
+      expect(event.path).not.toMatch(/-(wal|shm|journal)$/);
+    }
+  });
+
+  it("returns an empty array for no events", () => {
+    expect(collapseSqliteSidecars([])).toEqual([]);
+  });
+});
+
+describe("watchWorkspaceEvents", () => {
+  it("returns a stop function that is idempotent and respects a pre-aborted signal", async () => {
+    // Pure timing is covered by desktop E2E; here we just prove the wrapper
+    // constructs against a real (empty) temp dir and the stop fn is safe.
+    const { mkdtemp, rm } = await import("node:fs/promises");
+    const { tmpdir } = await import("node:os");
+    const { join } = await import("node:path");
+    const root = await mkdtemp(join(tmpdir(), "dohc-watch-"));
+    try {
+      const controller = new AbortController();
+      controller.abort();
+      const stopAborted = watchWorkspaceEvents(
+        { rootDir: root, signal: controller.signal },
+        () => undefined,
+      );
+      expect(typeof stopAborted).toBe("function");
+      stopAborted();
+
+      const stop = watchWorkspaceEvents({ rootDir: root, settleMs: 10 }, () => undefined);
+      expect(typeof stop).toBe("function");
+      stop();
+      // Calling stop twice must not throw.
+      stop();
+    } finally {
+      await rm(root, { recursive: true, force: true });
+    }
+  });
+
+  it("ignores .dohc writes but reports user files (chokidar passes absolute paths to ignored)", async () => {
+    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
+    const { tmpdir } = await import("node:os");
+    const { join } = await import("node:path");
+    const root = await mkdtemp(join(tmpdir(), "dohc-watch-"));
+    try {
+      const batches: string[][] = [];
+      const stop = watchWorkspaceEvents({ rootDir: root, settleMs: 80 }, (paths) =>
+        batches.push(paths),
+      );
+      // Give chokidar a moment to attach before writing.
+      await new Promise((r) => setTimeout(r, 200));
+      await mkdir(join(root, ".dohc", "history"), { recursive: true });
+      await writeFile(join(root, ".dohc", "history", "1.json"), "{}");
+      await writeFile(join(root, "notes.md"), "hi");
+      await new Promise((r) => setTimeout(r, 600));
+      stop();
+      const seen = batches.flat();
+      // The user file is reported; nothing under .dohc/ ever is (no feedback loop).
+      expect(seen).toContain("notes.md");
+      expect(seen.some((p) => p.includes(".dohc"))).toBe(false);
+    } finally {
+      await rm(root, { recursive: true, force: true });
+    }
+  });
+});
diff --git a/packages/workspace-history/src/changeSetStore.test.ts b/packages/workspace-history/src/changeSetStore.test.ts
new file mode 100644
index 0000000..2e0df7b
--- /dev/null
+++ b/packages/workspace-history/src/changeSetStore.test.ts
@@ -0,0 +1,192 @@
+import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { afterEach, beforeEach, describe, expect, it } from "vitest";
+import {
+  addBoundaryCrossing,
+  addFileChanges,
+  createChangeSet,
+  type ChangeSet,
+} from "@dohc/workspace-core";
+import { createChangeSetStore, humanSummary } from "./changeSetStore";

exec
/bin/bash -lc "git show --patch eb6c0c3 -- packages/workspace-history/src/changeSetStore.test.ts packages/workspace-sync/src/batchedSync.test.ts | sed -n '260,620p'" in /home/ice/dev/dohc
 succeeded in 0ms:
+      windowMs: 500,
+      now: clock.now,
+      onBatch: (batch) => batches.push(batch),
+    });
+
+    clock.set(0);
+    batcher.push({ path: "notes/today.md", operation: "update", sha256: "a" });
+
+    // Still inside the window — nothing should fire yet.
+    clock.set(400);
+    batcher.tick(400);
+    expect(batches).toHaveLength(0);
+
+    // Window has elapsed since the last event — one batch emits.
+    clock.set(500);
+    batcher.tick(500);
+    expect(batches).toHaveLength(1);
+    expect(batches[0].events).toHaveLength(1);
+    expect(batches[0].events[0].path).toBe("notes/today.md");
+    expect(batches[0].settledAtMs).toBe(500);
+    expect(batches[0].windowMs).toBe(500);
+  });
+
+  it("groups 18 rapid writes within the window into one batch", () => {
+    const clock = controllableClock();
+    const batches: WatcherEventBatch[] = [];
+    const batcher = createSettleBatcher({
+      windowMs: 500,
+      now: clock.now,
+      onBatch: (batch) => batches.push(batch),
+    });
+
+    // 18 distinct app files written in quick succession (an agent build).
+    for (let i = 0; i < 18; i++) {
+      clock.set(i * 10);
+      batcher.push({
+        path: `finance/.apps/ledger/src/file-${i}.tsx`,
+        operation: "create",
+        sha256: `sha-${i}`,
+      });
+    }
+
+    // No batch while events keep arriving inside the window.
+    clock.set(180);
+    batcher.tick(180);
+    expect(batches).toHaveLength(0);
+
+    // After windowMs of quiet, all 18 collapse into a single batch.
+    clock.set(170 + 500);
+    batcher.tick(170 + 500);
+    expect(batches).toHaveLength(1);
+    expect(batches[0].events).toHaveLength(18);
+  });
+
+  it("collapses rapid edits to the same path into one event with the latest sha256", () => {
+    const clock = controllableClock();
+    const batches: WatcherEventBatch[] = [];
+    const batcher = createSettleBatcher({
+      windowMs: 500,
+      now: clock.now,
+      onBatch: (batch) => batches.push(batch),
+    });
+
+    clock.set(0);
+    batcher.push({ path: "notes/today.md", operation: "create", sha256: "v1" });
+    clock.set(50);
+    batcher.push({ path: "notes/today.md", operation: "update", sha256: "v2" });
+    clock.set(100);
+    batcher.push({ path: "notes/today.md", operation: "update", sha256: "v3" });
+
+    clock.set(600);
+    batcher.tick(600);
+
+    expect(batches).toHaveLength(1);
+    expect(batches[0].events).toHaveLength(1);
+    expect(batches[0].events[0].sha256).toBe("v3");
+  });
+
+  it("starts a fresh batch after one settles", () => {
+    const clock = controllableClock();
+    const batches: WatcherEventBatch[] = [];
+    const batcher = createSettleBatcher({
+      windowMs: 500,
+      now: clock.now,
+      onBatch: (batch) => batches.push(batch),
+    });
+
+    clock.set(0);
+    batcher.push({ path: "a.md", operation: "update", sha256: "a" });
+    clock.set(500);
+    batcher.tick(500);
+
+    clock.set(1000);
+    batcher.push({ path: "b.md", operation: "update", sha256: "b" });
+    clock.set(1500);
+    batcher.tick(1500);
+
+    expect(batches).toHaveLength(2);
+    expect(batches[0].events[0].path).toBe("a.md");
+    expect(batches[1].events[0].path).toBe("b.md");
+  });
+
+  it("does not emit an empty batch when ticked with no pending events", () => {
+    const clock = controllableClock();
+    const batches: WatcherEventBatch[] = [];
+    const batcher = createSettleBatcher({
+      windowMs: 500,
+      now: clock.now,
+      onBatch: (batch) => batches.push(batch),
+    });
+
+    clock.set(1000);
+    batcher.tick(1000);
+    expect(batches).toHaveLength(0);
+  });
+
+  it("flush() emits the pending batch immediately regardless of the window", () => {
+    const clock = controllableClock();
+    const batches: WatcherEventBatch[] = [];
+    const batcher = createSettleBatcher({
+      windowMs: 500,
+      now: clock.now,
+      onBatch: (batch) => batches.push(batch),
+    });
+
+    clock.set(0);
+    batcher.push({ path: "notes/today.md", operation: "update", sha256: "a" });
+    clock.set(100);
+    batcher.flush();
+
+    expect(batches).toHaveLength(1);
+    expect(batches[0].events).toHaveLength(1);
+
+    // Nothing left to emit after a flush.
+    batcher.flush();
+    expect(batches).toHaveLength(1);
+  });
+});
+
+describe("batchToChangeSet", () => {
+  const batch = (events: WatcherEvent[]): WatcherEventBatch => ({
+    settledAtMs: 1000,
+    windowMs: 500,
+    events,
+  });
+
+  it("maps a single markdown save to one write change", () => {
+    const set = batchToChangeSet(
+      batch([{ path: "notes/today.md", operation: "update", sha256: "a" }]),
+      { author: userAuthor },
+    );
+    expect(set.files).toEqual([{ path: "notes/today.md", operation: "write" }]);
+    expect(set.kind).toBe("user-edit");
+    expect(set.author).toEqual(userAuthor);
+  });
+
+  it("maps create/update to write, delete to delete, rename to rename", () => {
+    const set = batchToChangeSet(
+      batch([
+        { path: "new.md", operation: "create", sha256: "n" },
+        { path: "edited.md", operation: "update", sha256: "e" },
+        { path: "gone.md", operation: "delete" },
+        { path: "to.md", operation: "rename", fromPath: "from.md" },
+      ]),
+      { author: userAuthor },
+    );
+    expect(set.files).toEqual([
+      { path: "new.md", operation: "write" },
+      { path: "edited.md", operation: "write" },
+      { path: "gone.md", operation: "delete" },
+      { path: "to.md", operation: "rename" },
+    ]);
+  });
+
+  it("groups an 18-file batch into a single change set", () => {
+    const events: WatcherEvent[] = Array.from({ length: 18 }, (_, i) => ({
+      path: `finance/.apps/ledger/src/file-${i}.tsx`,
+      operation: "create" as const,
+      sha256: `sha-${i}`,
+    }));
+    const set = batchToChangeSet(batch(events), {
+      author: agentAuthor,
+      provenance: { source: "agent-run", agentRunId: "run-1" },
+    });
+    expect(set.files).toHaveLength(18);
+  });
+
+  it("derives kind agent-run from agent-run provenance", () => {
+    const provenance: ChangeProvenance = {
+      source: "agent-run",
+      agentRunId: "run-1",
+    };
+    const set = batchToChangeSet(
+      batch([{ path: "app.tsx", operation: "create", sha256: "a" }]),
+      { author: agentAuthor, provenance },
+    );
+    expect(set.kind).toBe("agent-run");
+    expect(set.provenance).toEqual(provenance);
+  });
+
+  it("defaults kind to user-edit when no provenance is given", () => {
+    const set = batchToChangeSet(
+      batch([{ path: "a.md", operation: "update", sha256: "a" }]),
+      { author: userAuthor },
+    );
+    expect(set.kind).toBe("user-edit");
+  });
+
+  it("derives a default summary that counts edited files", () => {
+    const set = batchToChangeSet(
+      batch([
+        { path: "a.md", operation: "update", sha256: "a" },
+        { path: "b.md", operation: "update", sha256: "b" },
+        { path: "c.md", operation: "create", sha256: "c" },
+      ]),
+      { author: userAuthor },
+    );
+    expect(set.summary).toBe("Edited 3 files");
+  });
+
+  it("uses an import-flavored summary for import provenance", () => {
+    const events: WatcherEvent[] = Array.from({ length: 18 }, (_, i) => ({
+      path: `imported/file-${i}.csv`,
+      operation: "create" as const,
+      sha256: `sha-${i}`,
+    }));
+    const set = batchToChangeSet(batch(events), {
+      author: userAuthor,
+      provenance: { source: "import", importPath: "/tmp/data" },
+    });
+    expect(set.kind).toBe("import");
+    expect(set.summary).toBe("Imported 18 files");
+  });
+
+  it("singularizes the default summary for a single file", () => {
+    const set = batchToChangeSet(
+      batch([{ path: "a.md", operation: "update", sha256: "a" }]),
+      { author: userAuthor },
+    );
+    expect(set.summary).toBe("Edited 1 file");
+  });
+
+  it("honors an explicit summary over the derived default", () => {
+    const set = batchToChangeSet(
+      batch([{ path: "a.md", operation: "update", sha256: "a" }]),
+      { author: userAuthor, summary: "Reworded the intro" },
+    );
+    expect(set.summary).toBe("Reworded the intro");
+  });
+});

exec
/bin/bash -lc "sed -n '1,200p' packages/workspace-core/src/syncStatus.ts && sed -n '1,220p' packages/workspace-core/src/changeSet.ts && grep -R \"export interface WatcherEvent\" -n packages/workspace-core/src" in /home/ice/dev/dohc
 succeeded in 0ms:
// Phase 5 shared contract: the user-visible sync state. workspace-history /
// the desktop bridge produce it; the shell's status surface binds to it.

export type SyncState =
  | "synced"
  | "syncing"
  | "local-changes"
  | "conflict"
  | "cloud-disconnected";

export interface SyncStatus {
  state: SyncState;
  pendingChangeCount: number;
  lastSyncedAtMs: number | null;
}

export interface SyncStatusInput {
  pendingChangeCount: number;
  inFlight: boolean;
  hasConflict: boolean;
  cloudEnabled: boolean;
  cloudConnected: boolean;
  lastSyncedAtMs: number | null;
}

// Single source of truth for state precedence so the shell never re-derives
// it: conflict beats everything, then in-flight, then disconnect (cloud only),
// then pending edits, then settled.
export function deriveSyncStatus(input: SyncStatusInput): SyncStatus {
  const base = {
    pendingChangeCount: input.pendingChangeCount,
    lastSyncedAtMs: input.lastSyncedAtMs,
  };
  if (input.hasConflict) return { ...base, state: "conflict" };
  if (input.inFlight) return { ...base, state: "syncing" };
  // Disconnection only matters once the user has opted into cloud sync;
  // local-only workspaces are never "disconnected".
  if (input.cloudEnabled && !input.cloudConnected) {
    return { ...base, state: "cloud-disconnected" };
  }
  if (input.pendingChangeCount > 0) return { ...base, state: "local-changes" };
  return { ...base, state: "synced" };
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
packages/workspace-core/src/watcher.ts:7:export interface WatcherEvent {
packages/workspace-core/src/watcher.ts:19:export interface WatcherEventBatch {

exec
/bin/bash -lc "sed -n '1,120p' packages/workspace-core/src/watcher.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
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

exec
/bin/bash -lc "ls -R packages/workspace-sync packages/workspace-history packages/workspace-fs | sed -n '1,220p' && cat packages/workspace-sync/package.json packages/workspace-history/package.json packages/workspace-fs/package.json" in /home/ice/dev/dohc
 succeeded in 101ms:
{
  "name": "@dohc/workspace-history",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dohc/workspace-core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.19.19",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}
{
  "name": "@dohc/workspace-fs",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "sync": "tsx src/syncClient.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dohc/workspace-contracts": "workspace:*",
    "@dohc/workspace-core": "workspace:*",
    "chokidar": "^5.0.0"
  },
  "devDependencies": {
    "@dohc/workspace-api": "workspace:*",
    "@types/node": "^22.19.19",
    "tsx": "^4.22.3",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}

exec
/bin/bash -lc "sed -n '1,220p' apps/desktop/electron.vite.config.ts && cat apps/desktop/package.json | sed -n '1,120p'" in /home/ice/dev/dohc
 succeeded in 0ms:
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    // Workspace packages ship raw TS — they must be bundled, not
    // externalized, or Node ESM fails on their extensionless imports.
    // chokidar and other real npm deps stay external (loaded from node_modules).
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@dohc/workspace-core",
          "@dohc/workspace-contracts",
          "@dohc/workspace-fs",
          "@dohc/workspace-sync",
          "@dohc/workspace-history",
        ],
      }),
    ],
    build: {
      outDir: "dist/main",
      lib: { entry: "src/main.ts" },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      // Sandboxed preloads must be CommonJS.
      lib: { entry: "src/preload.ts", formats: ["cjs"] },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), tailwindcss()],
    build: {
      outDir: "dist/renderer",
      rollupOptions: { input: "src/renderer/index.html" },
    },
  },
});
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

exec
/bin/bash -lc "ls -l apps/desktop/node_modules/chokidar apps/desktop/node_modules/@dohc/workspace-fs/node_modules/chokidar 2>/dev/null || true && node -e \"console.log(require.resolve('chokidar',{paths:['/home/ice/dev/dohc/apps/desktop']}))\"" in /home/ice/dev/dohc
 succeeded in 0ms:
/home/ice/dev/dohc/node_modules/chokidar/index.js

exec
/bin/bash -lc "nl -ba apps/desktop/src/workspaces/workspaceActivity.ts | sed -n '1,120p'
nl -ba apps/desktop/src/workspaces/workspaceWatcher.ts | sed -n '1,130p'
nl -ba packages/workspace-fs/src/watchEvents.ts | sed -n '1,220p'
nl -ba packages/workspace-history/src/changeSetStore.ts | sed -n '1,140p'" in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import { deriveSyncStatus, type SyncStatus } from "@dohc/workspace-core";
     2	import type {
     3	  ChangeSetRecord,
     4	  SyncStatusResult,
     5	} from "../ipc/bridgeContract";
     6	import type { CreatedWorkspace } from "./createWorkspaceFolder";
     7	import {
     8	  createChangeSetStore,
     9	  humanSummary,
    10	  startWorkspaceWatch,
    11	  type WorkspaceWatchHandle,
    12	} from "./workspaceWatcher";
    13	
    14	interface WatchedWorkspace {
    15	  workspace: CreatedWorkspace;
    16	  handle: WorkspaceWatchHandle;
    17	  inFlight: boolean;
    18	  lastSyncedAtMs: number | null;
    19	}
    20	
    21	// Owns the live file-watch → history pipeline per workspace and the derived
    22	// sync status. The desktop layer opens a workspace once; subsequent timeline
    23	// and status reads are served from here, and activity pushes notify the UI.
    24	export function createWorkspaceActivity(notify: () => void) {
    25	  const watched = new Map<string, WatchedWorkspace>();
    26	
    27	  function statusFor(workspaceId: string): SyncStatus {
    28	    const w = watched.get(workspaceId);
    29	    // Local-only today: nothing is "pending" (edits save immediately) and no
    30	    // cloud, so state is synced unless a batch is being recorded. Cloud and
    31	    // conflict states become reachable in Phases 9/10 through the same
    32	    // deriveSyncStatus inputs.
    33	    return deriveSyncStatus({
    34	      pendingChangeCount: 0,
    35	      inFlight: w?.inFlight ?? false,
    36	      hasConflict: false,
    37	      cloudEnabled: false,
    38	      cloudConnected: false,
    39	      lastSyncedAtMs: w?.lastSyncedAtMs ?? null,
    40	    });
    41	  }
    42	
    43	  function open(workspace: CreatedWorkspace): SyncStatusResult {
    44	    if (!watched.has(workspace.workspaceId)) {
    45	      const entry: WatchedWorkspace = {
    46	        workspace,
    47	        inFlight: false,
    48	        lastSyncedAtMs: null,
    49	        handle: { stop: () => {} },
    50	      };
    51	      watched.set(workspace.workspaceId, entry);
    52	      entry.handle = startWorkspaceWatch(workspace, {
    53	        onRecorded: () => {
    54	          entry.inFlight = false;
    55	          entry.lastSyncedAtMs = Date.now();
    56	          notify();
    57	        },
    58	      });
    59	    }
    60	    return statusFor(workspace.workspaceId);
    61	  }
    62	
    63	  async function listChangeSets(
    64	    workspace: CreatedWorkspace,
    65	  ): Promise<ChangeSetRecord[]> {
    66	    const store = createChangeSetStore(workspace.rootPath);
    67	    const records = await store.list();
    68	    return records.map((record) => ({
    69	      id: record.id,
    70	      recordedAtMs: record.recordedAtMs,
    71	      kind: record.kind,
    72	      author: record.author,
    73	      summary: record.summary,
    74	      humanSummary: humanSummary(record),
    75	      fileCount: record.files.length,
    76	    }));
    77	  }
    78	
    79	  function getStatus(workspaceId: string): SyncStatusResult {
    80	    return statusFor(workspaceId);
    81	  }
    82	
    83	  function stopAll(): void {
    84	    for (const w of watched.values()) w.handle.stop();
    85	    watched.clear();
    86	  }
    87	
    88	  return { open, listChangeSets, getStatus, stopAll };
    89	}
     1	import type {
     2	  ChangeAuthor,
     3	  WatcherEvent,
     4	  WatcherEventBatch,
     5	} from "@dohc/workspace-core";
     6	import { shouldIgnoreWatchPath, watchWorkspaceEvents } from "@dohc/workspace-fs";
     7	import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
     8	import { batchToChangeSet } from "@dohc/workspace-sync";
     9	import { createHash, randomUUID } from "node:crypto";
    10	import { readFile, stat } from "node:fs/promises";
    11	import { join } from "node:path";
    12	import type { CreatedWorkspace } from "./createWorkspaceFolder";
    13	
    14	// Local user is the implicit author of filesystem edits (an external agent's
    15	// writes also land here; provenance/attribution sharpens in later phases).
    16	const LOCAL_USER: ChangeAuthor = { kind: "user", userId: "local" };
    17	
    18	async function sha256OrUndefined(absolute: string): Promise<string | undefined> {
    19	  try {
    20	    return createHash("sha256").update(await readFile(absolute)).digest("hex");
    21	  } catch {
    22	    return undefined;
    23	  }
    24	}
    25	
    26	// Turn the watcher's settled changed paths into WatcherEvents. Operation is
    27	// inferred from current existence (present => write/create, absent => delete);
    28	// this is the pure, testable core of the live pipeline.
    29	export async function pathsToEvents(
    30	  rootPath: string,
    31	  paths: string[],
    32	): Promise<WatcherEvent[]> {
    33	  const events: WatcherEvent[] = [];
    34	  for (const path of paths) {
    35	    const absolute = join(rootPath, path);
    36	    let exists = false;
    37	    try {
    38	      exists = (await stat(absolute)).isFile();
    39	    } catch {
    40	      exists = false;
    41	    }
    42	    events.push(
    43	      exists
    44	        ? { path, operation: "update", sha256: await sha256OrUndefined(absolute) }
    45	        : { path, operation: "delete" },
    46	    );
    47	  }
    48	  return events;
    49	}
    50	
    51	export interface WorkspaceWatchHandle {
    52	  stop: () => void;
    53	}
    54	
    55	// Wires the file watcher to the history store: each settled batch of changes
    56	// becomes one recorded change set. onRecorded lets the desktop layer refresh
    57	// sync status and push the new timeline entry to the renderer.
    58	export function startWorkspaceWatch(
    59	  workspace: CreatedWorkspace,
    60	  options: {
    61	    settleMs?: number;
    62	    now?: () => number;
    63	    onRecorded?: () => void;
    64	  } = {},
    65	): WorkspaceWatchHandle {
    66	  const store = createChangeSetStore(workspace.rootPath);
    67	  const now = options.now ?? (() => Date.now());
    68	
    69	  const stop = watchWorkspaceEvents(
    70	    { rootDir: workspace.rootPath, settleMs: options.settleMs },
    71	    (paths) => {
    72	      void (async () => {
    73	        // Defense in depth: never record changes to .dohc/** (our own history
    74	        // writes, manifest, cache) — recording them would feed back into the
    75	        // watcher. The watcher already ignores these; this guards a leak.
    76	        const userPaths = paths.filter((p) => !shouldIgnoreWatchPath(p));
    77	        if (userPaths.length === 0) return;
    78	        const events = await pathsToEvents(workspace.rootPath, userPaths);
    79	        if (events.length === 0) return;
    80	        const batch: WatcherEventBatch = {
    81	          settledAtMs: now(),
    82	          windowMs: options.settleMs ?? 500,
    83	          events,
    84	        };
    85	        const changeSet = batchToChangeSet(batch, { author: LOCAL_USER });
    86	        await store.record(changeSet, { id: randomUUID(), recordedAtMs: now() });
    87	        options.onRecorded?.();
    88	      })();
    89	    },
    90	  );
    91	
    92	  return { stop };
    93	}
    94	
    95	export { createChangeSetStore, humanSummary };
     1	// Phase 5: the raw filesystem watch layer for a local-first workspace.
     2	//
     3	// Two concerns live here, kept separate so the noisy parts stay testable:
     4	//   1. PURE rules that decide which paths are workspace noise vs. real user
     5	//      files, and how SQLite's multi-file write protocol collapses back to a
     6	//      single logical database change.
     7	//   2. A thin chokidar wrapper that debounces raw events into a quiet-window
     8	//      settle and hands the changed relative paths up to the caller.
     9	//
    10	// The pure helpers are exhaustively unit-tested; the chokidar wrapper only
    11	// needs to construct and tear down cleanly, since real fs-event timing is
    12	// exercised by the desktop E2E suite.
    13	
    14	import { watch } from "chokidar";
    15	import { isAbsolute, relative } from "node:path";
    16	import type { WatcherEvent } from "@dohc/workspace-core";
    17	
    18	// Normalize separators so a single set of rules covers POSIX and the
    19	// backslash paths a Windows watcher hands back.
    20	function toPosix(relativePath: string): string {
    21	  return relativePath.replaceAll("\\", "/");
    22	}
    23	
    24	// SQLite sidecars: the WAL/SHM/journal files SQLite writes alongside a
    25	// database. Anchored to the end so "data/walmart.csv" (contains "wal") and
    26	// "notes/journal.md" never match.
    27	const SQLITE_SIDECAR = /^(.*\.(?:db|sqlite))-(?:wal|shm|journal)$/i;
    28	
    29	// Editor scratch/swap/autosave artifacts that churn while a user types but are
    30	// never the file we sync.
    31	const EDITOR_NOISE = [
    32	  /\.tmp$/i, // foo.tmp
    33	  /\.tmp\..+$/i, // foo.tmp.1234 (atomic-write staging)
    34	  /\.swp$/i, // vim swap
    35	  /\.swo$/i, // vim secondary swap
    36	  /~$/, // emacs/gedit trailing-tilde backup
    37	  /^#.*#$/, // emacs autosave: #foo#
    38	  /^\.DS_Store$/i, // macOS Finder metadata
    39	];
    40	
    41	// TRUE when the watcher should drop this relative path before it ever becomes
    42	// a user file op. Covers the reserved .dohc/ tree (including its cache),
    43	// editor scratch files, and SQLite sidecars — see the regexes above for why
    44	// each is anchored to avoid false positives on real user files.
    45	export function shouldIgnoreWatchPath(relativePath: string): boolean {
    46	  const path = toPosix(relativePath);
    47	  const lower = path.toLowerCase();
    48	
    49	  // .dohc/ is dohc's own reserved/derived state (registry, cache, ...). Match
    50	  // the directory exactly or as a prefix — but NOT ".dohcrc", which is a
    51	  // sibling file, not the reserved directory.
    52	  if (lower === ".dohc" || lower.startsWith(".dohc/")) return true;
    53	
    54	  const basename = path.slice(path.lastIndexOf("/") + 1);
    55	  if (EDITOR_NOISE.some((pattern) => pattern.test(basename))) return true;
    56	
    57	  if (SQLITE_SIDECAR.test(path)) return true;
    58	
    59	  return false;
    60	}
    61	
    62	// Strip a SQLite sidecar suffix back to its base database path, or return
    63	// undefined for a path that is not a sidecar.
    64	function baseDbPath(path: string): string | undefined {
    65	  const match = SQLITE_SIDECAR.exec(toPosix(path));
    66	  return match ? match[1] : undefined;
    67	}
    68	
    69	// Collapse SQLite's multi-file write protocol back to one logical change.
    70	//
    71	// A single transaction can touch wallet.db, wallet.db-wal and wallet.db-shm,
    72	// and a WAL checkpoint can even read as a *delete* of a sidecar while the base
    73	// db emits nothing. The user-facing truth is always "the database changed", so
    74	// we: drop every sidecar event, and guarantee exactly one "update" event for
    75	// each affected base db — inserted at the position of its first related event
    76	// to preserve ordering relative to other (non-sqlite) files.
    77	export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
    78	  const out: WatcherEvent[] = [];
    79	  // Maps a base-db path to the index in `out` holding its single update, so a
    80	  // later base or sidecar event for the same db folds into that one slot.
    81	  const baseDbIndex = new Map<string, number>();
    82	
    83	  const ensureBaseDbUpdate = (dbPath: string): void => {
    84	    const existing = baseDbIndex.get(dbPath);
    85	    if (existing !== undefined) {
    86	      // Force "update": a checkpoint may have arrived as create/delete, but the
    87	      // database content changing is always an update from the user's view.
    88	      out[existing] = { path: dbPath, operation: "update" };
    89	      return;
    90	    }
    91	    baseDbIndex.set(dbPath, out.length);
    92	    out.push({ path: dbPath, operation: "update" });
    93	  };
    94	
    95	  for (const event of events) {
    96	    const sidecarBase = baseDbPath(event.path);
    97	    if (sidecarBase !== undefined) {
    98	      // A sidecar event stands in for (or accompanies) its base db.
    99	      ensureBaseDbUpdate(sidecarBase);
   100	      continue;
   101	    }
   102	    const normalized = toPosix(event.path);
   103	    if (baseDbIndex.has(normalized)) {
   104	      // The base db itself changed and we already have a slot for it.
   105	      ensureBaseDbUpdate(normalized);
   106	      continue;
   107	    }
   108	    // Track base-db paths so a sidecar arriving later folds into this event.
   109	    if (/\.(?:db|sqlite)$/i.test(normalized)) {
   110	      baseDbIndex.set(normalized, out.length);
   111	    }
   112	    out.push(event);
   113	  }
   114	
   115	  return out;
   116	}
   117	
   118	export type WatchWorkspaceEventsOptions = {
   119	  rootDir: string;
   120	  // Quiet-window before a burst of raw events is reported as one batch. An
   121	  // agent run or a save-all touching many files settles into a single batch.
   122	  settleMs?: number;
   123	  signal?: AbortSignal;
   124	};
   125	
   126	// Thin chokidar wrapper: watches rootDir, ignores noise via
   127	// shouldIgnoreWatchPath, debounces raw events into a quiet-window settle, and
   128	// calls onBatch with the unique changed relative paths once things go quiet.
   129	// Returns an idempotent stop function.
   130	export function watchWorkspaceEvents(
   131	  { rootDir, settleMs = 500, signal }: WatchWorkspaceEventsOptions,
   132	  onBatch: (paths: string[]) => void,
   133	): () => void {
   134	  if (signal?.aborted) return () => undefined;
   135	
   136	  // cwd makes chokidar hand back EVENT paths relative to rootDir, but the
   137	  // `ignored` predicate is called with ABSOLUTE paths during the initial scan
   138	  // — relativize first or .dohc/** (incl. our own history writes) leaks
   139	  // through and the watcher records its own output in a feedback loop.
   140	  const watcher = watch(".", {
   141	    cwd: rootDir,
   142	    // We diff the filesystem ourselves on change; an initial flood of "add"
   143	    // events for every existing file would be pure noise.
   144	    ignoreInitial: true,
   145	    ignored: (path: string) => {
   146	      const rel = isAbsolute(path) ? relative(rootDir, path) : path;
   147	      if (rel === "" || rel === ".") return false;
   148	      return shouldIgnoreWatchPath(rel);
   149	    },
   150	  });
   151	
   152	  const pending = new Set<string>();
   153	  let timer: ReturnType<typeof setTimeout> | undefined;
   154	  let stopped = false;
   155	
   156	  const flush = (): void => {
   157	    timer = undefined;
   158	    if (pending.size === 0) return;
   159	    const paths = [...pending];
   160	    pending.clear();
   161	    onBatch(paths);
   162	  };
   163	
   164	  const onEvent = (relativePath: string): void => {
   165	    // chokidar's cwd-relative path is already separator-normalized for our
   166	    // matcher; track it and (re)arm the quiet window.
   167	    pending.add(toPosix(relativePath));
   168	    if (timer !== undefined) clearTimeout(timer);
   169	    timer = setTimeout(flush, settleMs);
   170	  };
   171	
   172	  watcher.on("add", onEvent);
   173	  watcher.on("change", onEvent);
   174	  watcher.on("unlink", onEvent);
   175	  // Surface watcher errors rather than swallowing them; a dead watcher should
   176	  // be visible upstream, not silently stop reporting changes.
   177	  watcher.on("error", (error) => {
   178	    console.error("[workspace-fs] watch error", error);
   179	  });
   180	
   181	  const stop = (): void => {
   182	    if (stopped) return;
   183	    stopped = true;
   184	    if (timer !== undefined) clearTimeout(timer);
   185	    signal?.removeEventListener("abort", stop);
   186	    void watcher.close();
   187	  };
   188	
   189	  signal?.addEventListener("abort", stop, { once: true });
   190	  return stop;
   191	}
     1	import { mkdir, readFile, writeFile } from "node:fs/promises";
     2	import { join } from "node:path";
     3	import type {
     4	  BoundaryCrossing,
     5	  ChangeAuthor,
     6	  ChangeProvenance,
     7	  ChangeSet,
     8	  ChangeSetKind,
     9	  FileChange,
    10	} from "@dohc/workspace-core";
    11	
    12	// One persisted change set. Mirrors ChangeSet but adds the identity and
    13	// timestamp the store assigns, so each record is self-describing on disk.
    14	export interface HistoryRecord {
    15	  id: string;
    16	  recordedAtMs: number;
    17	  kind: ChangeSetKind;
    18	  author: ChangeAuthor;
    19	  summary: string;
    20	  files: FileChange[];
    21	  provenance?: ChangeProvenance;
    22	  boundaryCrossings: BoundaryCrossing[];
    23	}
    24	
    25	// The index is a lightweight, ordered table of contents — enough to render a
    26	// timeline without opening every per-record file. Ordering source of truth.
    27	interface IndexEntry {
    28	  id: string;
    29	  recordedAtMs: number;
    30	  kind: ChangeSetKind;
    31	  author: ChangeAuthor;
    32	  summary: string;
    33	  fileCount: number;
    34	}
    35	
    36	export interface ChangeSetStore {
    37	  record(
    38	    set: ChangeSet,
    39	    opts: { id: string; recordedAtMs: number },
    40	  ): Promise<HistoryRecord>;
    41	  list(): Promise<HistoryRecord[]>;
    42	  get(id: string): Promise<HistoryRecord | null>;
    43	}
    44	
    45	// Each record lives in its own file so history is inspectable: open
    46	// .dohc/history/<recordedAtMs>-<id>.json and read what changed and why.
    47	function recordFileName(opts: { id: string; recordedAtMs: number }): string {
    48	  return `${opts.recordedAtMs}-${opts.id}.json`;
    49	}
    50	
    51	async function readJson<T>(path: string): Promise<T | null> {
    52	  try {
    53	    return JSON.parse(await readFile(path, "utf8")) as T;
    54	  } catch (error) {
    55	    // A missing file is the empty case (no history yet), not an error.
    56	    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    57	    throw error;
    58	  }
    59	}
    60	
    61	export function createChangeSetStore(rootDir: string): ChangeSetStore {
    62	  // All history stays inside .dohc/history — never written outside it.
    63	  const historyDir = join(rootDir, ".dohc", "history");
    64	  const indexPath = join(historyDir, "index.json");
    65	
    66	  async function readIndex(): Promise<IndexEntry[]> {
    67	    return (await readJson<IndexEntry[]>(indexPath)) ?? [];
    68	  }
    69	
    70	  return {
    71	    async record(set, opts) {
    72	      const record: HistoryRecord = {
    73	        id: opts.id,
    74	        recordedAtMs: opts.recordedAtMs,
    75	        kind: set.kind,
    76	        author: set.author,
    77	        summary: set.summary,
    78	        files: set.files,
    79	        boundaryCrossings: set.boundaryCrossings,
    80	        ...(set.provenance ? { provenance: set.provenance } : {}),
    81	      };
    82	
    83	      await mkdir(historyDir, { recursive: true });
    84	      // Pretty JSON: history is meant to be opened and read by a person.
    85	      await writeFile(
    86	        join(historyDir, recordFileName(opts)),
    87	        `${JSON.stringify(record, null, 2)}\n`,
    88	        "utf8",
    89	      );
    90	
    91	      const entry: IndexEntry = {
    92	        id: record.id,
    93	        recordedAtMs: record.recordedAtMs,
    94	        kind: record.kind,
    95	        author: record.author,
    96	        summary: record.summary,
    97	        fileCount: record.files.length,
    98	      };
    99	      const index = await readIndex();
   100	      index.push(entry);
   101	      await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
   102	
   103	      return record;
   104	    },
   105	
   106	    async list() {
   107	      const index = await readIndex();
   108	      // The index is the ordering source; sort newest first by timestamp,
   109	      // breaking ties on id so ordering is stable within the same ms.
   110	      const ordered = [...index].sort(
   111	        (a, b) =>
   112	          b.recordedAtMs - a.recordedAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
   113	      );
   114	      const records: HistoryRecord[] = [];
   115	      for (const entry of ordered) {
   116	        // Read the full record from its own file — the index only holds a
   117	        // summary, the per-record file is the source of full detail.
   118	        const record = await readJson<HistoryRecord>(
   119	          join(historyDir, recordFileName(entry)),
   120	        );
   121	        if (record) records.push(record);
   122	      }
   123	      return records;
   124	    },
   125	
   126	    async get(id) {
   127	      const index = await readIndex();
   128	      const entry = index.find((e) => e.id === id);
   129	      if (!entry) return null;
   130	      return readJson<HistoryRecord>(join(historyDir, recordFileName(entry)));
   131	    },
   132	  };
   133	}
   134	
   135	// Plain-language attribution: who did what, to how many files. Author-aware so
   136	// a user edit and an agent run read differently. Deliberately prose, never Git
   137	// conflict markers — history is for humans to skim.
   138	export function humanSummary(record: HistoryRecord): string {
   139	  const count = record.files.length;
   140	  const noun = count === 1 ? "file" : "files";

exec
/bin/bash -lc 'rg "collapseSqliteSidecars|shouldIgnoreWatchPath|createSettleBatcher|inFlight" -n' in /home/ice/dev/dohc
 succeeded in 0ms:
packages/workspace-sync/src/batchedSync.ts:36:export function createSettleBatcher(
packages/workspace-sync/src/batchedSync.test.ts:8:import { batchToChangeSet, createSettleBatcher } from "./batchedSync";
packages/workspace-sync/src/batchedSync.test.ts:34:    const batcher = createSettleBatcher({
packages/workspace-sync/src/batchedSync.test.ts:61:    const batcher = createSettleBatcher({
packages/workspace-sync/src/batchedSync.test.ts:92:    const batcher = createSettleBatcher({
packages/workspace-sync/src/batchedSync.test.ts:116:    const batcher = createSettleBatcher({
packages/workspace-sync/src/batchedSync.test.ts:140:    const batcher = createSettleBatcher({
packages/workspace-sync/src/batchedSync.test.ts:154:    const batcher = createSettleBatcher({
packages/workspace-core/src/syncStatus.ts:19:  inFlight: boolean;
packages/workspace-core/src/syncStatus.ts:35:  if (input.inFlight) return { ...base, state: "syncing" };
packages/workspace-core/src/syncStatus.test.ts:6:  inFlight: false,
packages/workspace-core/src/syncStatus.test.ts:26:      deriveSyncStatus({ ...base, pendingChangeCount: 3, inFlight: true }).state,
packages/workspace-core/src/syncStatus.test.ts:35:        inFlight: true,
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:161:- Decisions made: D-15/16/17 (lane boundaries, JSON history not SQLite, chokidar+pure-logic split — all in pre-phase section); D-18 | createSettleBatcher (workspace-sync) is public package API for Phase 9 cloud-push settling; live local pipeline uses the watcher's own settle + batchToChangeSet (the watcher debounces fs noise; the batcher will settle change-sets before remote POST) — both legitimate, knip-allowlisted as public exports
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:164:- Failing tests fixed: feedback-loop bug (watcher recorded its own .dohc/history writes — chokidar passes ABSOLUTE paths to ignored predicate, shouldIgnoreWatchPath expected relative) — FIXED: relativize in watcher ignored predicate + defense-in-depth filter in workspaceWatcher; regressed at fs-unit AND E2E level. Caught by the Phase-5 design screenshot.
packages/workspace-fs/src/watchEvents.ts:45:export function shouldIgnoreWatchPath(relativePath: string): boolean {
packages/workspace-fs/src/watchEvents.ts:77:export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
packages/workspace-fs/src/watchEvents.ts:127:// shouldIgnoreWatchPath, debounces raw events into a quiet-window settle, and
packages/workspace-fs/src/watchEvents.ts:148:      return shouldIgnoreWatchPath(rel);
packages/workspace-fs/src/watchEvents.test.ts:4:  collapseSqliteSidecars,
packages/workspace-fs/src/watchEvents.test.ts:5:  shouldIgnoreWatchPath,
packages/workspace-fs/src/watchEvents.test.ts:9:describe("shouldIgnoreWatchPath", () => {
packages/workspace-fs/src/watchEvents.test.ts:13:    expect(shouldIgnoreWatchPath(".dohc")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:14:    expect(shouldIgnoreWatchPath(".dohc/registry.json")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:15:    expect(shouldIgnoreWatchPath(".dohc/cache/blob-0001")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:16:    expect(shouldIgnoreWatchPath(".dohc/cache/nested/deep/file")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:18:    expect(shouldIgnoreWatchPath(".DOHC/cache/x")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:19:    expect(shouldIgnoreWatchPath(".Dohc")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:24:    expect(shouldIgnoreWatchPath(".dohcrc")).toBe(false);
packages/workspace-fs/src/watchEvents.test.ts:25:    expect(shouldIgnoreWatchPath("notes/.dohc-notes.md")).toBe(false);
packages/workspace-fs/src/watchEvents.test.ts:29:    expect(shouldIgnoreWatchPath("notes/draft.tmp")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:30:    expect(shouldIgnoreWatchPath("notes/draft.tmp.1234")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:31:    expect(shouldIgnoreWatchPath("notes/today.md.swp")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:32:    expect(shouldIgnoreWatchPath("notes/today.md.swo")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:33:    expect(shouldIgnoreWatchPath("notes/today.md~")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:34:    expect(shouldIgnoreWatchPath("#today.md#")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:35:    expect(shouldIgnoreWatchPath("notes/#today.md#")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:36:    expect(shouldIgnoreWatchPath(".DS_Store")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:37:    expect(shouldIgnoreWatchPath("notes/.DS_Store")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:41:    expect(shouldIgnoreWatchPath("finance/wallet.db-wal")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:42:    expect(shouldIgnoreWatchPath("finance/wallet.db-journal")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:43:    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-wal")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:44:    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-journal")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:45:    expect(shouldIgnoreWatchPath("finance/wallet.db-shm")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:46:    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-shm")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:50:    expect(shouldIgnoreWatchPath("notes/today.md")).toBe(false);
packages/workspace-fs/src/watchEvents.test.ts:51:    expect(shouldIgnoreWatchPath("finance/wallet.sqlite")).toBe(false);
packages/workspace-fs/src/watchEvents.test.ts:52:    expect(shouldIgnoreWatchPath("finance/wallet.db")).toBe(false);
packages/workspace-fs/src/watchEvents.test.ts:53:    expect(shouldIgnoreWatchPath("finance/.apps/ledger/app.json")).toBe(false);
packages/workspace-fs/src/watchEvents.test.ts:55:    expect(shouldIgnoreWatchPath("notes/tmp-ideas.md")).toBe(false);
packages/workspace-fs/src/watchEvents.test.ts:56:    expect(shouldIgnoreWatchPath("notes/swap-meet.md")).toBe(false);
packages/workspace-fs/src/watchEvents.test.ts:57:    expect(shouldIgnoreWatchPath("data/walmart.csv")).toBe(false);
packages/workspace-fs/src/watchEvents.test.ts:63:    expect(shouldIgnoreWatchPath(".dohc\\cache\\blob")).toBe(true);
packages/workspace-fs/src/watchEvents.test.ts:64:    expect(shouldIgnoreWatchPath("notes\\today.md")).toBe(false);
packages/workspace-fs/src/watchEvents.test.ts:70:describe("collapseSqliteSidecars", () => {
packages/workspace-fs/src/watchEvents.test.ts:74:    const out = collapseSqliteSidecars([update("finance/wallet.db-wal")]);
packages/workspace-fs/src/watchEvents.test.ts:79:    expect(collapseSqliteSidecars([update("a/x.sqlite-journal")])).toEqual([
packages/workspace-fs/src/watchEvents.test.ts:82:    expect(collapseSqliteSidecars([update("a/x.sqlite-wal")])).toEqual([
packages/workspace-fs/src/watchEvents.test.ts:85:    expect(collapseSqliteSidecars([update("a/x.db-shm")])).toEqual([
packages/workspace-fs/src/watchEvents.test.ts:92:    const out = collapseSqliteSidecars([
packages/workspace-fs/src/watchEvents.test.ts:101:    const out = collapseSqliteSidecars([
packages/workspace-fs/src/watchEvents.test.ts:112:    const out = collapseSqliteSidecars([
packages/workspace-fs/src/watchEvents.test.ts:120:    const out = collapseSqliteSidecars([
packages/workspace-fs/src/watchEvents.test.ts:133:    const out = collapseSqliteSidecars([
packages/workspace-fs/src/watchEvents.test.ts:143:    expect(collapseSqliteSidecars(events)).toEqual(events);
packages/workspace-fs/src/watchEvents.test.ts:147:    const out = collapseSqliteSidecars([
packages/workspace-fs/src/watchEvents.test.ts:159:    expect(collapseSqliteSidecars([])).toEqual([]);
docs/superpowers/reviews/codex/phase-05.md:168:+  inFlight: boolean;
docs/superpowers/reviews/codex/phase-05.md:186:+      inFlight: w?.inFlight ?? false,
docs/superpowers/reviews/codex/phase-05.md:198:+        inFlight: false,
docs/superpowers/reviews/codex/phase-05.md:205:+          entry.inFlight = false;
docs/superpowers/reviews/codex/phase-05.md:252:+import { shouldIgnoreWatchPath, watchWorkspaceEvents } from "@dohc/workspace-fs";
docs/superpowers/reviews/codex/phase-05.md:322:+        const userPaths = paths.filter((p) => !shouldIgnoreWatchPath(p));
docs/superpowers/reviews/codex/phase-05.md:392:+export function shouldIgnoreWatchPath(relativePath: string): boolean {
docs/superpowers/reviews/codex/phase-05.md:424:+export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
docs/superpowers/reviews/codex/phase-05.md:474:+// shouldIgnoreWatchPath, debounces raw events into a quiet-window settle, and
docs/superpowers/reviews/codex/phase-05.md:495:+      return shouldIgnoreWatchPath(rel);
docs/superpowers/reviews/codex/phase-05.md:755:+export function createSettleBatcher(
docs/superpowers/reviews/codex/phase-05.md:1408:+- Decisions made: D-15/16/17 (lane boundaries, JSON history not SQLite, chokidar+pure-logic split — all in pre-phase section); D-18 | createSettleBatcher (workspace-sync) is public package API for Phase 9 cloud-push settling; live local pipeline uses the watcher's own settle + batchToChangeSet (the watcher debounces fs noise; the batcher will settle change-sets before remote POST) — both legitimate, knip-allowlisted as public exports
docs/superpowers/reviews/codex/phase-05.md:1411:+- Failing tests fixed: feedback-loop bug (watcher recorded its own .dohc/history writes — chokidar passes ABSOLUTE paths to ignored predicate, shouldIgnoreWatchPath expected relative) — FIXED: relativize in watcher ignored predicate + defense-in-depth filter in workspaceWatcher; regressed at fs-unit AND E2E level. Caught by the Phase-5 design screenshot.
docs/superpowers/reviews/codex/phase-05.md:1525:+  collapseSqliteSidecars,
docs/superpowers/reviews/codex/phase-05.md:1526:+  shouldIgnoreWatchPath,
docs/superpowers/reviews/codex/phase-05.md:1530:+describe("shouldIgnoreWatchPath", () => {
docs/superpowers/reviews/codex/phase-05.md:1534:+    expect(shouldIgnoreWatchPath(".dohc")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1535:+    expect(shouldIgnoreWatchPath(".dohc/registry.json")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1536:+    expect(shouldIgnoreWatchPath(".dohc/cache/blob-0001")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1537:+    expect(shouldIgnoreWatchPath(".dohc/cache/nested/deep/file")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1539:+    expect(shouldIgnoreWatchPath(".DOHC/cache/x")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1540:+    expect(shouldIgnoreWatchPath(".Dohc")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1545:+    expect(shouldIgnoreWatchPath(".dohcrc")).toBe(false);
docs/superpowers/reviews/codex/phase-05.md:1546:+    expect(shouldIgnoreWatchPath("notes/.dohc-notes.md")).toBe(false);
docs/superpowers/reviews/codex/phase-05.md:1550:+    expect(shouldIgnoreWatchPath("notes/draft.tmp")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1551:+    expect(shouldIgnoreWatchPath("notes/draft.tmp.1234")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1552:+    expect(shouldIgnoreWatchPath("notes/today.md.swp")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1553:+    expect(shouldIgnoreWatchPath("notes/today.md.swo")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1554:+    expect(shouldIgnoreWatchPath("notes/today.md~")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1555:+    expect(shouldIgnoreWatchPath("#today.md#")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1556:+    expect(shouldIgnoreWatchPath("notes/#today.md#")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1557:+    expect(shouldIgnoreWatchPath(".DS_Store")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1558:+    expect(shouldIgnoreWatchPath("notes/.DS_Store")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1562:+    expect(shouldIgnoreWatchPath("finance/wallet.db-wal")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1563:+    expect(shouldIgnoreWatchPath("finance/wallet.db-journal")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1564:+    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-wal")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1565:+    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-journal")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1566:+    expect(shouldIgnoreWatchPath("finance/wallet.db-shm")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1567:+    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-shm")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1571:+    expect(shouldIgnoreWatchPath("notes/today.md")).toBe(false);
docs/superpowers/reviews/codex/phase-05.md:1572:+    expect(shouldIgnoreWatchPath("finance/wallet.sqlite")).toBe(false);
docs/superpowers/reviews/codex/phase-05.md:1573:+    expect(shouldIgnoreWatchPath("finance/wallet.db")).toBe(false);
docs/superpowers/reviews/codex/phase-05.md:1574:+    expect(shouldIgnoreWatchPath("finance/.apps/ledger/app.json")).toBe(false);
docs/superpowers/reviews/codex/phase-05.md:1576:+    expect(shouldIgnoreWatchPath("notes/tmp-ideas.md")).toBe(false);
docs/superpowers/reviews/codex/phase-05.md:1577:+    expect(shouldIgnoreWatchPath("notes/swap-meet.md")).toBe(false);
docs/superpowers/reviews/codex/phase-05.md:1578:+    expect(shouldIgnoreWatchPath("data/walmart.csv")).toBe(false);
docs/superpowers/reviews/codex/phase-05.md:1584:+    expect(shouldIgnoreWatchPath(".dohc\\cache\\blob")).toBe(true);
docs/superpowers/reviews/codex/phase-05.md:1585:+    expect(shouldIgnoreWatchPath("notes\\today.md")).toBe(false);
docs/superpowers/reviews/codex/phase-05.md:1591:+describe("collapseSqliteSidecars", () => {
docs/superpowers/reviews/codex/phase-05.md:1595:+    const out = collapseSqliteSidecars([update("finance/wallet.db-wal")]);
docs/superpowers/reviews/codex/phase-05.md:1600:+    expect(collapseSqliteSidecars([update("a/x.sqlite-journal")])).toEqual([
docs/superpowers/reviews/codex/phase-05.md:1603:+    expect(collapseSqliteSidecars([update("a/x.sqlite-wal")])).toEqual([
docs/superpowers/reviews/codex/phase-05.md:1606:+    expect(collapseSqliteSidecars([update("a/x.db-shm")])).toEqual([
docs/superpowers/reviews/codex/phase-05.md:1613:+    const out = collapseSqliteSidecars([
docs/superpowers/reviews/codex/phase-05.md:1622:+    const out = collapseSqliteSidecars([
docs/superpowers/reviews/codex/phase-05.md:1633:+    const out = collapseSqliteSidecars([
docs/superpowers/reviews/codex/phase-05.md:1641:+    const out = collapseSqliteSidecars([
docs/superpowers/reviews/codex/phase-05.md:1654:+    const out = collapseSqliteSidecars([
docs/superpowers/reviews/codex/phase-05.md:1664:+    expect(collapseSqliteSidecars(events)).toEqual(events);
docs/superpowers/reviews/codex/phase-05.md:1668:+    const out = collapseSqliteSidecars([
docs/superpowers/reviews/codex/phase-05.md:1680:+    expect(collapseSqliteSidecars([])).toEqual([]);
docs/superpowers/reviews/codex/phase-05.md:1785:+    const batcher = createSettleBatcher({
docs/superpowers/reviews/codex/phase-05.md:1816:+    const batcher = createSettleBatcher({
docs/superpowers/reviews/codex/phase-05.md:1840:+    const batcher = createSettleBatcher({
docs/superpowers/reviews/codex/phase-05.md:1864:+    const batcher = createSettleBatcher({
docs/superpowers/reviews/codex/phase-05.md:1878:+    const batcher = createSettleBatcher({
docs/superpowers/reviews/codex/phase-05.md:2031:  inFlight: boolean;
docs/superpowers/reviews/codex/phase-05.md:2047:  if (input.inFlight) return { ...base, state: "syncing" };
docs/superpowers/reviews/codex/phase-05.md:2326:    17	  inFlight: boolean;
docs/superpowers/reviews/codex/phase-05.md:2344:    35	      inFlight: w?.inFlight ?? false,
docs/superpowers/reviews/codex/phase-05.md:2356:    47	        inFlight: false,
docs/superpowers/reviews/codex/phase-05.md:2363:    54	          entry.inFlight = false;
docs/superpowers/reviews/codex/phase-05.md:2404:     6	import { shouldIgnoreWatchPath, watchWorkspaceEvents } from "@dohc/workspace-fs";
docs/superpowers/reviews/codex/phase-05.md:2474:    76	        const userPaths = paths.filter((p) => !shouldIgnoreWatchPath(p));
docs/superpowers/reviews/codex/phase-05.md:2538:    45	export function shouldIgnoreWatchPath(relativePath: string): boolean {
docs/superpowers/reviews/codex/phase-05.md:2570:    77	export function collapseSqliteSidecars(events: WatcherEvent[]): WatcherEvent[] {
docs/superpowers/reviews/codex/phase-05.md:2620:   127	// shouldIgnoreWatchPath, debounces raw events into a quiet-window settle, and
docs/superpowers/reviews/codex/phase-05.md:2641:   148	      return shouldIgnoreWatchPath(rel);
apps/desktop/src/workspaces/workspaceWatcher.ts:6:import { shouldIgnoreWatchPath, watchWorkspaceEvents } from "@dohc/workspace-fs";
apps/desktop/src/workspaces/workspaceWatcher.ts:76:        const userPaths = paths.filter((p) => !shouldIgnoreWatchPath(p));
apps/desktop/src/workspaces/workspaceActivity.ts:17:  inFlight: boolean;
apps/desktop/src/workspaces/workspaceActivity.ts:35:      inFlight: w?.inFlight ?? false,
apps/desktop/src/workspaces/workspaceActivity.ts:47:        inFlight: false,
apps/desktop/src/workspaces/workspaceActivity.ts:54:          entry.inFlight = false;
apps/app/src/components/WorkspaceManagementDialog.tsx:333:  const inFlight = useRef(false)
apps/app/src/components/WorkspaceManagementDialog.tsx:339:        if (inFlight.current) return
apps/app/src/components/WorkspaceManagementDialog.tsx:342:        inFlight.current = true
apps/app/src/components/WorkspaceManagementDialog.tsx:347:          inFlight.current = false

exec
/bin/bash -lc "sed -n '1,280p' apps/desktop/src/main.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import {
  defaultWorkspaceRoot,
  normalizeAbsolutePath,
  validateWorkspaceRootChoice,
} from "@dohc/workspace-core";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { isAbsolute, relative, sep } from "node:path";
import {
  AttachWorkspaceFolderPayload,
  CreateLocalWorkspacePayload,
  CreateWorkspaceFilePayload,
  CreateWorkspaceFileResult,
  DefaultWorkspaceRootResult,
  ImportWorkspaceFilesPayload,
  ImportWorkspaceFilesResult,
  LaunchMarksResult,
  ListChangeSetsResult,
  ListWorkspaceFilesPayload,
  ListWorkspaceFilesResult,
  OpenWorkspacePayload,
  PickWorkspaceRootResult,
  SyncStatusResult,
  WorkspaceRegistryResult,
  WorkspaceSummary,
} from "./ipc/bridgeContract";
import { CHANNELS } from "./ipc/channels";
import { launchMarks } from "./performance/launchMarks";
import { decideNavigation } from "./security/electronSecurity";
import { navigationPolicy } from "./window/createMainWindow";
import { createWorkspaceFolder } from "./workspaces/createWorkspaceFolder";
import {
  effectiveHome,
  findWorkspace,
  listWorkspaces,
  registerWorkspace,
} from "./workspaces/WorkspaceRegistry";
import { createWorkspaceActivity } from "./workspaces/workspaceActivity";
import {
  copyIntoWorkspace,
  createFile,
  listFiles,
} from "./workspaces/workspaceFiles";

function requireWorkspace(workspaceId: string) {
  const workspace = findWorkspace(workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  return workspace;
}

// Live file-watch → history pipeline. Pushes a renderer notification whenever
// a settled batch is recorded so the file tree, timeline, and sync status
// refresh without polling.
const activity = createWorkspaceActivity(() => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.workspaceActivity);
  }
});
app.on("will-quit", () => activity.stopAll());

// Workspace roots the main process itself produced — the default suggestion
// and any folder the user chose through the real OS dialog. A renderer cannot
// invent a path (e.g. ~/.ssh) it was never handed; create/attach roots must
// be one of these or a descendant. Populated by getDefaultWorkspaceRoot and
// pickWorkspaceRoot before the renderer can create/attach.
const approvedRoots = new Set<string>();

function approveRoot(rootPath: string): void {
  approvedRoots.add(normalizeAbsolutePath(rootPath));
}

function isApprovedRoot(normalized: string): boolean {
  for (const approved of approvedRoots) {
    if (normalized === approved) return true;
    const rel = relative(approved, normalized);
    // On Windows, relative() across drives returns an absolute path
    // (C:\ws -> D:\evil gives "D:\evil"), which is NOT a descendant.
    if (
      rel.length > 0 &&
      !isAbsolute(rel) &&
      !rel.startsWith("..") &&
      !rel.startsWith(sep)
    ) {
      return true;
    }
  }
  return false;
}

// The navigation policy is constant for the process lifetime (env var and
// packaged bundle dir cannot change), so compute it once.
let cachedPolicy: ReturnType<typeof navigationPolicy> | null = null;
function policy() {
  if (!cachedPolicy) cachedPolicy = navigationPolicy();
  return cachedPolicy;
}

// IPC is an untrusted boundary: handlers only answer frames the navigation
// policy itself would allow (exact dev origin or the packaged bundle).
function isTrustedFrame(frameUrl: string): boolean {
  return decideNavigation(frameUrl, policy()).action === "allow";
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frameUrl = event.senderFrame?.url ?? "";
  if (!isTrustedFrame(frameUrl)) {
    throw new Error(`Untrusted IPC sender: ${frameUrl}`);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.pickWorkspaceRoot, async (event) => {
    assertTrustedSender(event);
    // Test seam: native dialogs cannot be driven by Playwright.
    const testPick = process.env.DOHC_TEST_PICK_PATH;
    if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged && testPick) {
      approveRoot(testPick);
      return PickWorkspaceRootResult.parse(testPick);
    }
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
    if (picked) approveRoot(picked);
    return PickWorkspaceRootResult.parse(picked);
  });

  ipcMain.handle(CHANNELS.getWorkspaceRegistry, (event) => {
    assertTrustedSender(event);
    return WorkspaceRegistryResult.parse({ workspaces: listWorkspaces() });
  });

  ipcMain.handle(CHANNELS.getDefaultWorkspaceRoot, (event) => {
    assertTrustedSender(event);
    const root = defaultWorkspaceRoot(effectiveHome());
    approveRoot(root);
    return DefaultWorkspaceRootResult.parse(root);
  });

  // Validates, canonicalizes, AND confirms the root traces to a main-process
  // suggestion or dialog pick — a renderer cannot scope fs ops to a path it
  // invented. All downstream ops use the normalized root.
  function usableRoot(rootPath: string): string {
    const check = validateWorkspaceRootChoice(rootPath, effectiveHome());
    if (!check.ok) throw new Error(check.reason);
    if (!isApprovedRoot(check.normalized)) {
      throw new Error(
        "Workspace root must be chosen through dohc (the default location or the folder picker).",
      );
    }
    return check.normalized;
  }

  ipcMain.handle(CHANNELS.createLocalWorkspace, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateLocalWorkspacePayload.parse(payload);
    const created = await createWorkspaceFolder({
      rootPath: usableRoot(input.rootPath),
      kind: input.kind,
    });
    registerWorkspace(created);
    return WorkspaceSummary.parse(created);
  });

  ipcMain.handle(CHANNELS.attachWorkspaceFolder, async (event, payload) => {
    assertTrustedSender(event);
    const input = AttachWorkspaceFolderPayload.parse(payload);
    // Adopts an existing dohc workspace (manifest identity preserved) or
    // turns the folder into a fresh personal workspace in place.
    const attached = await createWorkspaceFolder({
      rootPath: usableRoot(input.rootPath),
      kind: "personal",
    });
    registerWorkspace(attached);
    return WorkspaceSummary.parse(attached);
  });

  ipcMain.handle(CHANNELS.listWorkspaceFiles, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return ListWorkspaceFilesResult.parse({
      files: await listFiles(workspace.rootPath),
    });
  });

  ipcMain.handle(CHANNELS.createWorkspaceFile, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateWorkspaceFilePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const path = await createFile(workspace.rootPath, input.relativePath);
    return CreateWorkspaceFileResult.parse({ path });
  });

  ipcMain.handle(CHANNELS.importWorkspaceFiles, async (event, payload) => {
    assertTrustedSender(event);
    const input = ImportWorkspaceFilesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      title: "Import files into workspace",
    });
    const imported = result.canceled
      ? []
      : await copyIntoWorkspace(workspace.rootPath, result.filePaths);
    return ImportWorkspaceFilesResult.parse({ imported });
  });

  ipcMain.handle(CHANNELS.openWorkspace, (event, payload) => {
    assertTrustedSender(event);
    const input = OpenWorkspacePayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return SyncStatusResult.parse(activity.open(workspace));
  });

  ipcMain.handle(CHANNELS.listChangeSets, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    const workspace = requireWorkspace(input.workspaceId);
    return ListChangeSetsResult.parse({
      changeSets: await activity.listChangeSets(workspace),
    });
  });

  ipcMain.handle(CHANNELS.getSyncStatus, (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceFilesPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    return SyncStatusResult.parse(activity.getStatus(input.workspaceId));
  });

  ipcMain.on(CHANNELS.firstPaint, (event) => {
    if (isTrustedFrame(event.senderFrame?.url ?? "")) {
      launchMarks.firstPaint();
    }
  });

  // Double-gated: env flag AND unpackaged build. A packaged app launched
  // with the env var set must never grow test surface.
  if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
    ipcMain.handle(CHANNELS.getLaunchMarks, (event) => {
      assertTrustedSender(event);
      return LaunchMarksResult.parse(launchMarks.snapshot());
    });
  }
}

// Single-instance lock gates the entire bootstrap, not just a quit() call.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(async () => {
    launchMarks.appReady();
    registerIpcHandlers();
    const { createMainWindow } = await import("./window/createMainWindow");
    createMainWindow();
    launchMarks.firstWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

exec
/bin/bash -lc "sed -n '1,260p' apps/desktop/src/workspaces/workspaceFiles.ts" in /home/ice/dev/dohc
 succeeded in 0ms:
import {
  classifyPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

// Deepest already-existing ancestor of a (possibly not-yet-created) path —
// the part realpath can resolve, so we can check containment BEFORE mkdir.
async function existingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}
import type { WorkspaceFileEntry } from "../ipc/bridgeContract";

const IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);

// True iff `child` is the same as or nested under `parent` (both real paths).
// On Windows, relative() across drives returns an absolute path (e.g.
// C:\ws -> D:\evil gives "D:\evil"), which is not a descendant.
function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return (
    rel.length > 0 &&
    !isAbsolute(rel) &&
    !rel.startsWith("..") &&
    !rel.startsWith(`${sep}`)
  );
}

export async function listFiles(
  rootPath: string,
): Promise<WorkspaceFileEntry[]> {
  const entries: WorkspaceFileEntry[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      // Never follow symlinks: a dir/file symlink could point outside the
      // workspace and leak names or recurse into foreign trees.
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRS.has(dirent.name)) await walk(join(dir, dirent.name), rel);
      } else if (dirent.isFile()) {
        entries.push({ path: rel, kind: classifyPath(rel).kind });
      }
    }
  }

  await walk(rootPath, "");
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export async function createFile(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const validated = validateUserWritePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid file path (${validated.reason}): ${relativePath}`);
  }
  const absolute = join(rootPath, validated.normalized);
  // Lexical validation can't see symlinks: a workspace-internal symlinked
  // ancestor ("link/evil.md") could resolve outside the root. Check the real
  // deepest-existing ancestor BEFORE mkdir, so a symlinked ancestor can't even
  // cause directories to be created outside the workspace.
  const realRoot = await realpath(rootPath);
  if (!isInside(realRoot, await existingAncestor(dirname(absolute)))) {
    throw new Error(`Invalid file path (escapes workspace): ${relativePath}`);
  }
  await mkdir(dirname(absolute), { recursive: true });
  // Re-check after mkdir (the resolved parent now exists) as belt-and-braces;
  // wx + O_EXCL additionally prevents a final-segment symlink from escaping.
  if (!isInside(realRoot, await realpath(dirname(absolute)))) {
    throw new Error(`Invalid file path (escapes workspace): ${relativePath}`);
  }
  await writeFile(absolute, "", { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  return validated.normalized;
}

// Imports copy external files into the workspace root by basename; existing
// files are never overwritten (skipped, not errored — imports are additive).
export async function copyIntoWorkspace(
  rootPath: string,
  absolutePaths: string[],
): Promise<string[]> {
  const imported: string[] = [];
  for (const source of absolutePaths) {
    const name = basename(source);
    const validated = validateUserWritePath(name);
    if (!validated.ok) continue;
    try {
      await copyFile(source, join(rootPath, validated.normalized), constants.COPYFILE_EXCL);
      imported.push(validated.normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return imported;
}

exec
/bin/bash -lc "node -e \"const fs=require('fs'); const p=require.resolve('chokidar/package.json'); console.log(p); console.log(JSON.parse(fs.readFileSync(p,'utf8')).version)\" && rg \"followSymlinks\" node_modules/chokidar -n | head -20" in /home/ice/dev/dohc
 exited 1 in 0ms:
node:internal/modules/cjs/loader:685
      throw e;
      ^

Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './package.json' is not defined by "exports" in /home/ice/dev/dohc/node_modules/chokidar/package.json
    at exportsNotFound (node:internal/modules/esm/resolve:313:10)
    at packageExportsResolve (node:internal/modules/esm/resolve:661:9)
    at resolveExports (node:internal/modules/cjs/loader:678:36)
    at Module._findPath (node:internal/modules/cjs/loader:745:31)
    at Module._resolveFilename (node:internal/modules/cjs/loader:1405:27)
    at require.resolve (node:internal/modules/helpers:163:19)
    at [eval]:1:41
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:451:12
    at [eval]-wrapper:6:24 {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
}

Node.js v25.2.1

exec
/bin/bash -lc "rg \"followSymlinks\" node_modules/.pnpm/chokidar@5.0.0*/node_modules/chokidar -n | head -40 && sed -n '1,120p' node_modules/.pnpm/chokidar@5.0.0*/node_modules/chokidar/index.js | sed -n '1,80p'" in /home/ice/dev/dohc
 succeeded in 0ms:
rg: node_modules/.pnpm/chokidar@5.0.0*/node_modules/chokidar: IO error for operation on node_modules/.pnpm/chokidar@5.0.0*/node_modules/chokidar: No such file or directory (os error 2)
sed: can't read node_modules/.pnpm/chokidar@5.0.0*/node_modules/chokidar/index.js: No such file or directory

exec
/bin/bash -lc "ls -l node_modules/chokidar && rg \"followSymlinks\" node_modules/chokidar -n | head -40 && sed -n '1,160p' node_modules/chokidar/index.js" in /home/ice/dev/dohc
 succeeded in 0ms:
total 100
-rw-r--r-- 14 ice ice  1124 Sep  2  2025 LICENSE
-rw-r--r--  2 ice ice 13357 Jan 14 01:19 README.md
-rw-r--r--  2 ice ice  3912 Jan 14 01:19 handler.d.ts
-rw-r--r--  2 ice ice 24768 Jan 14 01:19 handler.js
-rw-r--r--  2 ice ice  8103 Jan 14 01:19 index.d.ts
-rw-r--r--  2 ice ice 29452 Jan 14 01:19 index.js
drwxr-xr-x  3 ice ice  4096 May 22 02:54 node_modules
-rw-r--r--  2 ice ice  1346 Jan 14 01:19 package.json
node_modules/chokidar/index.js:185:    followSymlinks;
node_modules/chokidar/index.js:198:        this.followSymlinks = follow;
node_modules/chokidar/index.js:266:            followSymlinks: true,
node_modules/chokidar/index.js:678:        return new WatchHelper(path, this.options.followSymlinks, this);
node_modules/chokidar/index.d.ts:13:    followSymlinks: boolean;
node_modules/chokidar/index.d.ts:66:    followSymlinks: boolean;
node_modules/chokidar/handler.js:416:        if (!this.fsw.options.followSymlinks) {
node_modules/chokidar/handler.js:587:            const follow = this.fsw.options.followSymlinks;
node_modules/chokidar/README.md:131:  followSymlinks: true,
node_modules/chokidar/README.md:160:- `followSymlinks` (default: `true`). When `false`, only the
/*! chokidar - MIT License (c) 2012 Paul Miller (paulmillr.com) */
import { EventEmitter } from 'node:events';
import { stat as statcb, Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import * as sp from 'node:path';
import { readdirp, ReaddirpStream } from 'readdirp';
import { EMPTY_FN, EVENTS as EV, isIBMi, isWindows, NodeFsHandler, STR_CLOSE, STR_END, } from './handler.js';
const SLASH = '/';
const SLASH_SLASH = '//';
const ONE_DOT = '.';
const TWO_DOTS = '..';
const STRING_TYPE = 'string';
const BACK_SLASH_RE = /\\/g;
const DOUBLE_SLASH_RE = /\/\//g;
const DOT_RE = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;
const REPLACER_RE = /^\.[/\\]/;
function arrify(item) {
    return Array.isArray(item) ? item : [item];
}
const isMatcherObject = (matcher) => typeof matcher === 'object' && matcher !== null && !(matcher instanceof RegExp);
function createPattern(matcher) {
    if (typeof matcher === 'function')
        return matcher;
    if (typeof matcher === 'string')
        return (string) => matcher === string;
    if (matcher instanceof RegExp)
        return (string) => matcher.test(string);
    if (typeof matcher === 'object' && matcher !== null) {
        return (string) => {
            if (matcher.path === string)
                return true;
            if (matcher.recursive) {
                const relative = sp.relative(matcher.path, string);
                if (!relative) {
                    return false;
                }
                return !relative.startsWith('..') && !sp.isAbsolute(relative);
            }
            return false;
        };
    }
    return () => false;
}
function normalizePath(path) {
    if (typeof path !== 'string')
        throw new Error('string expected');
    path = sp.normalize(path);
    path = path.replace(/\\/g, '/');
    let prepend = false;
    if (path.startsWith('//'))
        prepend = true;
    path = path.replace(DOUBLE_SLASH_RE, '/');
    if (prepend)
        path = '/' + path;
    return path;
}
function matchPatterns(patterns, testString, stats) {
    const path = normalizePath(testString);
    for (let index = 0; index < patterns.length; index++) {
        const pattern = patterns[index];
        if (pattern(path, stats)) {
            return true;
        }
    }
    return false;
}
function anymatch(matchers, testString) {
    if (matchers == null) {
        throw new TypeError('anymatch: specify first argument');
    }
    // Early cache for matchers.
    const matchersArray = arrify(matchers);
    const patterns = matchersArray.map((matcher) => createPattern(matcher));
    if (testString == null) {
        return (testString, stats) => {
            return matchPatterns(patterns, testString, stats);
        };
    }
    return matchPatterns(patterns, testString);
}
const unifyPaths = (paths_) => {
    const paths = arrify(paths_).flat();
    if (!paths.every((p) => typeof p === STRING_TYPE)) {
        throw new TypeError(`Non-string provided as watch path: ${paths}`);
    }
    return paths.map(normalizePathToUnix);
};
// If SLASH_SLASH occurs at the beginning of path, it is not replaced
//     because "//StoragePC/DrivePool/Movies" is a valid network path
const toUnix = (string) => {
    let str = string.replace(BACK_SLASH_RE, SLASH);
    let prepend = false;
    if (str.startsWith(SLASH_SLASH)) {
        prepend = true;
    }
    str = str.replace(DOUBLE_SLASH_RE, SLASH);
    if (prepend) {
        str = SLASH + str;
    }
    return str;
};
// Our version of upath.normalize
// TODO: this is not equal to path-normalize module - investigate why
const normalizePathToUnix = (path) => toUnix(sp.normalize(toUnix(path)));
// TODO: refactor
const normalizeIgnored = (cwd = '') => (path) => {
    if (typeof path === 'string') {
        return normalizePathToUnix(sp.isAbsolute(path) ? path : sp.join(cwd, path));
    }
    else {
        return path;
    }
};
const getAbsolutePath = (path, cwd) => {
    if (sp.isAbsolute(path)) {
        return path;
    }
    return sp.join(cwd, path);
};
const EMPTY_SET = Object.freeze(new Set());
/**
 * Directory entry.
 */
class DirEntry {
    path;
    _removeWatcher;
    items;
    constructor(dir, removeWatcher) {
        this.path = dir;
        this._removeWatcher = removeWatcher;
        this.items = new Set();
    }
    add(item) {
        const { items } = this;
        if (!items)
            return;
        if (item !== ONE_DOT && item !== TWO_DOTS)
            items.add(item);
    }
    async remove(item) {
        const { items } = this;
        if (!items)
            return;
        items.delete(item);
        if (items.size > 0)
            return;
        const dir = this.path;
        try {
            await readdir(dir);
        }
        catch (err) {
            if (this._removeWatcher) {
                this._removeWatcher(sp.dirname(dir), sp.basename(dir));
            }
        }
    }
    has(item) {
        const { items } = this;
        if (!items)
            return;

codex
The patch can miss SQLite-backed workspace changes, watch outside workspace boundaries through symlinks, and lose history entries during concurrent records or shutdown. These affect the correctness and safety of the new local-first history pipeline.

Full review comments:

- [P1] Don't drop SQLite sidecars before collapsing them — /home/ice/dev/dohc/packages/workspace-fs/src/watchEvents.ts:57-57
  When SQLite runs in WAL mode, commits can touch only `wallet.db-wal`/`-shm` and not the base DB; returning `true` here makes both the chokidar ignore predicate and the desktop defense-in-depth filter discard those paths before `collapseSqliteSidecars` can convert them into a base-DB update. The live history/sync pipeline will silently miss those database changes unless sidecars stay in the event stream and are collapsed before recording.

- [P2] Disable symlink following in the workspace watcher — /home/ice/dev/dohc/packages/workspace-fs/src/watchEvents.ts:140-149
  For a workspace containing a symlinked directory to somewhere outside the workspace, chokidar's default `followSymlinks: true` causes this watcher to subscribe to the external target, while `listFiles` explicitly skips symlinks to avoid crossing workspace boundaries. Changes under that target can then be hashed and recorded as workspace history, so the watcher should set `followSymlinks: false` or otherwise ignore symlink dirents.

- [P2] Serialize history index updates — /home/ice/dev/dohc/packages/workspace-history/src/changeSetStore.ts:99-101
  When two settled batches are recorded concurrently, both `record()` calls can read the same `index.json`, append their own entry, and then the later write overwrites the earlier one. The live watcher starts `store.record()` from fire-and-forget callbacks, so overlapping records on a slow disk can orphan a record file and make `list()`/`get()` never show that change set; queue these writes or make the index update atomic.

- [P2] Flush pending watcher paths on stop — /home/ice/dev/dohc/packages/workspace-fs/src/watchEvents.ts:184-184
  If the app quits or a watcher is stopped within the settle window after a file event, this clears the timer without emitting the pending paths, so the most recent edit is never recorded in local history. Stop should flush the pending batch before closing the chokidar watcher, especially because desktop calls `stopAll()` from `will-quit`.
The patch can miss SQLite-backed workspace changes, watch outside workspace boundaries through symlinks, and lose history entries during concurrent records or shutdown. These affect the correctness and safety of the new local-first history pipeline.

Full review comments:

- [P1] Don't drop SQLite sidecars before collapsing them — /home/ice/dev/dohc/packages/workspace-fs/src/watchEvents.ts:57-57
  When SQLite runs in WAL mode, commits can touch only `wallet.db-wal`/`-shm` and not the base DB; returning `true` here makes both the chokidar ignore predicate and the desktop defense-in-depth filter discard those paths before `collapseSqliteSidecars` can convert them into a base-DB update. The live history/sync pipeline will silently miss those database changes unless sidecars stay in the event stream and are collapsed before recording.

- [P2] Disable symlink following in the workspace watcher — /home/ice/dev/dohc/packages/workspace-fs/src/watchEvents.ts:140-149
  For a workspace containing a symlinked directory to somewhere outside the workspace, chokidar's default `followSymlinks: true` causes this watcher to subscribe to the external target, while `listFiles` explicitly skips symlinks to avoid crossing workspace boundaries. Changes under that target can then be hashed and recorded as workspace history, so the watcher should set `followSymlinks: false` or otherwise ignore symlink dirents.

- [P2] Serialize history index updates — /home/ice/dev/dohc/packages/workspace-history/src/changeSetStore.ts:99-101
  When two settled batches are recorded concurrently, both `record()` calls can read the same `index.json`, append their own entry, and then the later write overwrites the earlier one. The live watcher starts `store.record()` from fire-and-forget callbacks, so overlapping records on a slow disk can orphan a record file and make `list()`/`get()` never show that change set; queue these writes or make the index update atomic.

- [P2] Flush pending watcher paths on stop — /home/ice/dev/dohc/packages/workspace-fs/src/watchEvents.ts:184-184
  If the app quits or a watcher is stopped within the settle window after a file event, this clears the timer without emitting the pending paths, so the most recent edit is never recorded in local history. Stop should flush the pending batch before closing the chokidar watcher, especially because desktop calls `stopAll()` from `will-quit`.
