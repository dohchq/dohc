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
const drafts = new Map<string, readonly OrphanedDraft[]>();
const listeners = new Set<() => void>();
let nextId = 1;
let notifyQueued = false;

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

// Test seam: the store is module state, so suites that capture drafts reset
// it between tests instead of leaking keys into each other.
export function resetOrphanedDrafts(): void {
  drafts.clear();
  scheduleNotify();
}
