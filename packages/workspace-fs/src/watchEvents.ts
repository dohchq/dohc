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
import {
  hasIgnoredSegment,
  isDatabaseFile,
  sidecarBasePath,
  type WatcherEvent,
} from "@dohc/workspace-core";

// Normalize separators so a single set of rules covers POSIX and the
// backslash paths a Windows watcher hands back.
function toPosix(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}

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
// a user file op. Shares hasIgnoredSegment with the file-tree walker so the
// watcher never records history for paths the tree hides (.dohc at any depth,
// .git, node_modules), plus editor scratch files. NOTE: SQLite sidecars
// (.db-wal/-journal/-shm) are NOT ignored here — a SQLite write often touches
// only the WAL while the base .db is untouched until checkpoint, so ignoring
// sidecars would make the change INVISIBLE. Instead the pipeline lets sidecar
// events through and folds them into one base-db update via
// collapseSqliteSidecars, so the sidecar path never surfaces but the database
// change is never missed.
export function shouldIgnoreWatchPath(relativePath: string): boolean {
  const path = toPosix(relativePath);
  if (hasIgnoredSegment(path)) return true;

  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (EDITOR_NOISE.some((pattern) => pattern.test(basename))) return true;

  return false;
}

// Strip a SQLite sidecar suffix back to its base database path, or return
// undefined for a path that is not a sidecar. The extension set lives in
// workspace-core (databases.ts) — single-sourced so it cannot drift from the
// sync rules (.sqlite3 sidecars were once missed by a local copy).
function baseDbPath(path: string): string | undefined {
  return sidecarBasePath(toPosix(path)) ?? undefined;
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
  // Maps a base-db path to the index in `out` holding its single event, so a
  // later base or sidecar event for the same db folds into that one slot.
  const baseDbIndex = new Map<string, number>();

  // Default to "update" — a sidecar event (incl. a WAL checkpoint that reads
  // as a sidecar delete) means the database CHANGED, not that it was deleted.
  // Only the base db's OWN delete event means the database was deleted, so a
  // delete of the base path takes precedence over any sidecar churn.
  const foldBaseDb = (dbPath: string, baseOwnOperation?: WatcherEvent["operation"]): void => {
    const existing = baseDbIndex.get(dbPath);
    if (existing !== undefined) {
      const current = out[existing].operation;
      // A real delete (base's own delete event) wins and is never downgraded.
      const operation =
        baseOwnOperation === "delete" || current === "delete" ? "delete" : "update";
      out[existing] = { path: dbPath, operation };
      return;
    }
    baseDbIndex.set(dbPath, out.length);
    out.push({ path: dbPath, operation: baseOwnOperation === "delete" ? "delete" : "update" });
  };

  for (const event of events) {
    const sidecarBase = baseDbPath(event.path);
    if (sidecarBase !== undefined) {
      // A sidecar event stands in for (or accompanies) its base db; a sidecar
      // alone never implies the base db was deleted.
      foldBaseDb(sidecarBase);
      continue;
    }
    const normalized = toPosix(event.path);
    if (isDatabaseFile(normalized)) {
      // The base db itself — carry its real operation (delete must survive).
      foldBaseDb(normalized, event.operation);
      continue;
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
  // Hard ceiling on how long a continuous burst can postpone a flush. Without
  // it, a busy database WAL (or a long agent run) writing faster than settleMs
  // would starve the settle window forever and nothing would ever record.
  maxWindowMs?: number;
  signal?: AbortSignal;
};

export type WorkspaceEventsWatcher = {
  // Idempotent; flushes pending changes so a save right before quit records.
  stop: () => void;
  // Resolves when chokidar's initial scan completes — writes made after this
  // point are guaranteed to be observed. (Writes landing DURING the initial
  // scan can be folded into it and dropped; callers that trigger writes, like
  // the desktop's openWorkspace, await this first. Changes made while the app
  // was closed are reconciled by sync's manifest diff, not the watcher.)
  ready: Promise<void>;
};

// Thin chokidar wrapper: watches rootDir, ignores noise via
// shouldIgnoreWatchPath, debounces raw events into a quiet-window settle, and
// calls onBatch with the unique changed relative paths once things go quiet.
export function watchWorkspaceEvents(
  { rootDir, settleMs = 500, maxWindowMs = settleMs * 8, signal }: WatchWorkspaceEventsOptions,
  onBatch: (paths: string[]) => void,
): WorkspaceEventsWatcher {
  if (signal?.aborted) return { stop: () => undefined, ready: Promise.resolve() };

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
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (deadline !== undefined) clearTimeout(deadline);
    timer = undefined;
    deadline = undefined;
    if (pending.size === 0) return;
    const paths = [...pending];
    pending.clear();
    onBatch(paths);
  };

  const onEvent = (relativePath: string): void => {
    if (stopped) return;
    // chokidar's cwd-relative path is already separator-normalized for our
    // matcher; track it and (re)arm the quiet window. The deadline timer is
    // armed once per burst and never reset — under continuous writes it
    // guarantees a flush every maxWindowMs even though the settle timer keeps
    // being pushed back.
    pending.add(toPosix(relativePath));
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, settleMs);
    if (deadline === undefined) deadline = setTimeout(flush, maxWindowMs);
  };

  const ready = new Promise<void>((resolve, reject) => {
    watcher.on("ready", () => resolve());
    watcher.on("error", reject);
  });

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
    // Flush any settled-but-not-yet-emitted changes so a save right before
    // stop/quit is recorded into history rather than silently dropped.
    flush();
    signal?.removeEventListener("abort", stop);
    void watcher.close();
  };

  signal?.addEventListener("abort", stop, { once: true });
  return { stop, ready };
}
