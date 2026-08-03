import { useSyncExternalStore } from "react";

// Set-aside drafts (#567): text a reopen took out of the save pipeline, held
// until the user copies or dismisses it. The store lives OUTSIDE the keyed
// document view because the notice promises the text stays recoverable —
// switching or closing the tab must not drop it (#579 review, P1). In-memory
// by design: the text never reaches disk, because writing it is the clobber
// the capture exists to prevent, so its lifetime is the app run.

export type OrphanedDraft = {
  id: number;
  // The full serialized document as the user last had it, frontmatter
  // included — what Copy hands back.
  text: string;
};

const EMPTY: readonly OrphanedDraft[] = [];
const EMPTY_PATHS: ReadonlySet<string> = new Set();
const drafts = new Map<string, readonly OrphanedDraft[]>();
const listeners = new Set<() => void>();
let nextId = 1;
let notifyQueued = false;
// Bumped on every mutation; snapshot caches key off it so useSyncExternalStore
// sees stable references between mutations.
let storeVersion = 0;
const pathSetCache = new Map<
  string,
  { version: number; paths: ReadonlySet<string> }
>();

function keyFor(workspaceId: string, path: string): string {
  // JSON quotes each part, so two different keys cannot collide.
  return JSON.stringify([workspaceId, path]);
}

// Deferred, because the capture runs during the document view's render (the
// render-phase transition in FileInspector) and notifying subscribers there
// would schedule re-renders mid-render. The capturing render does not need
// the notification: it reads the map through the same hook one microtask
// later.
function scheduleNotify(): void {
  // Every caller just mutated the map; the bump invalidates snapshot caches.
  storeVersion += 1;
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const listener of [...listeners]) listener();
  });
}

export function captureOrphanedDraft(
  workspaceId: string,
  path: string,
  text: string,
): void {
  const key = keyFor(workspaceId, path);
  // Append, never overwrite: a second reopen with the first notice still up
  // must not destroy the first draft (#579 review, P2).
  drafts.set(key, [...(drafts.get(key) ?? EMPTY), { id: nextId++, text }]);
  scheduleNotify();
}

export function dismissOrphanedDraft(
  workspaceId: string,
  path: string,
  id: number,
): void {
  const key = keyFor(workspaceId, path);
  const remaining = (drafts.get(key) ?? EMPTY).filter(
    (draft) => draft.id !== id,
  );
  if (remaining.length === 0) drafts.delete(key);
  else drafts.set(key, remaining);
  scheduleNotify();
}

// A rename or move re-keys the document, and the recovery must follow it —
// otherwise the notice dies with the old path while the tab remaps to the new
// one (#579 review, P1). The caller supplies the same projection the shell
// applies to tabs and pins. A null projection (a delete) keeps the drafts
// under their old key: destroying recovery text is never this store's call,
// and a restored or recreated file shows the notice again.
export function remapOrphanedDraftPaths(
  workspaceId: string,
  project: (path: string) => string | null,
): void {
  let changed = false;
  for (const [key, kept] of [...drafts]) {
    const [keyWorkspaceId, path] = JSON.parse(key) as [string, string];
    if (keyWorkspaceId !== workspaceId) continue;
    const next = project(path);
    if (next === null || next === path) continue;
    drafts.delete(key);
    const nextKey = keyFor(workspaceId, next);
    // Merge, never overwrite: the target path may hold drafts of its own.
    drafts.set(nextKey, [...(drafts.get(nextKey) ?? EMPTY), ...kept]);
    changed = true;
  }
  if (changed) scheduleNotify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOrphanedDrafts(
  workspaceId: string,
  path: string,
): readonly OrphanedDraft[] {
  return useSyncExternalStore(subscribe, () => {
    return drafts.get(keyFor(workspaceId, path)) ?? EMPTY;
  });
}

// Every path in one workspace that holds a set-aside draft. The tab strip
// marks INACTIVE tabs with it (#579 review, r4) — only the mounted inspector
// can report savable-dirty, but recovery is knowable for every tab.
export function useOrphanedDraftPaths(workspaceId: string): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => {
    const cached = pathSetCache.get(workspaceId);
    if (cached && cached.version === storeVersion) return cached.paths;
    const paths = new Set<string>();
    for (const key of drafts.keys()) {
      const [keyWorkspaceId, path] = JSON.parse(key) as [string, string];
      if (keyWorkspaceId === workspaceId) paths.add(path);
    }
    const entry = {
      version: storeVersion,
      paths: paths.size === 0 ? EMPTY_PATHS : paths,
    };
    pathSetCache.set(workspaceId, entry);
    return entry.paths;
  });
}

// Whether ANY workspace still holds set-aside drafts. The close warning keys
// off this (#579 review, r4): the store is in-memory, so closing the window
// is the one irreversible exit and the user must be told before it runs.
export function orphanedDraftCount(): number {
  let count = 0;
  for (const kept of drafts.values()) count += kept.length;
  return count;
}

export type OrphanedDraftRow = {
  workspaceId: string;
  // The name the UI shows for this workspace (the shell registers it) — the
  // raw id is a UUID no user recognizes (#579 review, r10). Falls back to
  // the id when no shell for that workspace ever mounted.
  workspaceLabel: string;
  path: string;
  draft: OrphanedDraft;
};

const workspaceLabels = new Map<string, string>();

// The shell knows the display name; the recovery surfaces (which can outlive
// or sit above the shell) only know ids. One registration per mount keeps
// the global recovery list readable.
export function noteWorkspaceLabel(workspaceId: string, label: string): void {
  if (workspaceLabels.get(workspaceId) === label) return;
  workspaceLabels.set(workspaceId, label);
  scheduleNotify();
}

let allRowsCache: { version: number; rows: readonly OrphanedDraftRow[] } | null =
  null;
const EMPTY_ROWS: readonly OrphanedDraftRow[] = [];

// Every unresolved draft, across workspaces, path-independent (#579 review,
// r5): a deleted file has no inspector left to render its notice, so the
// recovery surfaces that use this — the close-warning dialog and the notice
// center — must not depend on any path still existing.
export function useAllOrphanedDrafts(): readonly OrphanedDraftRow[] {
  return useSyncExternalStore(subscribe, () => {
    if (allRowsCache && allRowsCache.version === storeVersion) {
      return allRowsCache.rows;
    }
    const rows: OrphanedDraftRow[] = [];
    for (const [key, kept] of drafts) {
      const [workspaceId, path] = JSON.parse(key) as [string, string];
      const workspaceLabel = workspaceLabels.get(workspaceId) ?? workspaceId;
      for (const draft of kept) {
        rows.push({ workspaceId, workspaceLabel, path, draft });
      }
    }
    allRowsCache = {
      version: storeVersion,
      rows: rows.length === 0 ? EMPTY_ROWS : rows,
    };
    return allRowsCache.rows;
  });
}

// Test seam: the store is module state, so suites that capture drafts reset
// it between tests instead of leaking keys into each other.
export function resetOrphanedDrafts(): void {
  drafts.clear();
  workspaceLabels.clear();
  scheduleNotify();
}
