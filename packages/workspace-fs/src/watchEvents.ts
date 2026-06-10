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
