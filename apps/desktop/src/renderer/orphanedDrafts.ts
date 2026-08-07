import { useSyncExternalStore } from "react";
import {
  clearStoredDrafts,
  forgetStoredDraft,
  loadStoredDrafts,
  remapStoredDraftPaths,
  storeDraft,
} from "./orphanedDraftStorage";

// Set-aside drafts (#567): text a reopen took out of the save pipeline, held
// until the user copies or dismisses it. The store lives OUTSIDE the keyed
// document view because the notice promises the text stays recoverable —
// switching or closing the tab must not drop it (#579 review, P1).
//
// The text never goes back into the document — writing it there is the clobber
// the capture exists to prevent — but it does reach disk (#600), in the app's
// own storage and never in the workspace tree. `orphanedDraftStorage` keeps
// the copy that outlives the app run; this module keeps the copy every surface
// reads, and `restoreOrphanedDrafts` puts the two together at startup.

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
// Every id this run has handed out, restored rows included. It only grows:
// see `allocateDraftId`.
const claimedIds = new Set<number>();
let notifyQueued = false;
// Bumped on every mutation; snapshot caches key off it so useSyncExternalStore
// sees stable references between mutations.
let storeVersion = 0;
const pathSetCache = new Map<
  string,
  { version: number; paths: ReadonlySet<string> }
>();
// The drafts a restart brings back. Everything else — a secret-classified
// path the plaintext store refuses, and a draft whose write the storage quota
// refused — dies with this app run, and only those stay behind the close
// warning.
let storedIds: Set<number> = new Set();

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

// The lowest id nothing in this run holds. Counting UP from the highest one
// instead is what breaks: a restored id near the end of the safe range takes
// the count with it, and there `+ 1` returns the same number, so two drafts
// get one id and one Dismiss deletes both texts. The lowest free id is bounded
// by how many drafts this run has seen, so it never reaches that end.
//
// Synchronous, because a capture runs during a render and cannot await.
//
// Ids are never reused, which is why dismissing does not give one back. The
// close guard remembers the ids the user approved losing (#579 review, r13),
// and re-issuing a dismissed id inside that window would hand a brand-new
// draft someone else's approval and exit without ever showing it.
function allocateDraftId(): number {
  let id = 1;
  while (claimedIds.has(id)) id += 1;
  claimedIds.add(id);
  return id;
}

export function captureOrphanedDraft(
  workspaceId: string,
  path: string,
  text: string,
): void {
  const key = keyFor(workspaceId, path);
  const id = allocateDraftId();
  // Durable before the notice exists (#600). The write is synchronous, so the
  // answer the close guard needs is already true here — a draft is at risk
  // only when storage REFUSED it.
  if (storeDraft({ id, workspaceId, path, text, capturedAtMs: Date.now() })) {
    storedIds.add(id);
  }
  // Append, never overwrite: a second reopen with the first notice still up
  // must not destroy the first draft (#579 review, P2).
  drafts.set(key, [...(drafts.get(key) ?? EMPTY), { id, text }]);
  scheduleNotify();
}

// Startup restore (#600): the persisted recoveries land in the SAME store the
// in-document notice, the tab dot, the notice center, and the close warning
// already read, so every one of those surfaces works unchanged. Called once,
// from main.tsx before the root renders — synchronous, before any subscriber
// or any workspace exists, so there is nothing to notify and no in-flight
// response that could repaint a workspace the user has switched away from.
export function restoreOrphanedDrafts(nowMs: number = Date.now()): void {
  for (const row of loadStoredDrafts(nowMs)) {
    const key = keyFor(row.workspaceId, row.path);
    drafts.set(key, [
      ...(drafts.get(key) ?? EMPTY),
      { id: row.id, text: row.text },
    ]);
    storedIds.add(row.id);
    // Ids stay stable across restarts so a dismissal reaches the right stored
    // row. Claiming them is what keeps this run's captures clear of them —
    // the storage load already guaranteed they are unique and countable from.
    claimedIds.add(row.id);
  }
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
  // The stored copy goes with the in-memory one. This is the one path that
  // retires a draft, so it is the one place the persisted copy can die —
  // leaving it would show a notice the user has already dealt with on the
  // next launch. (Copy leaves the draft standing on purpose: taking the text
  // is not deciding you are done with it.)
  forgetStoredDraft(id);
  storedIds.delete(id);
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
  // The stored copies move with them, and a rename onto a secret-classified
  // path drops its plaintext row instead (#446 floor) — those drafts stop
  // being durable and go back behind the close warning.
  const demoted = remapStoredDraftPaths(workspaceId, project);
  for (const id of demoted) storedIds.delete(id);
  let changed = demoted.size > 0;
  for (const [key, kept] of [...drafts]) {
    const [keyWorkspaceId, path] = JSON.parse(key) as [string, string];
    if (keyWorkspaceId !== workspaceId) continue;
    const next = project(path);
    if (next === null || next === path) continue;
    drafts.delete(key);
    const nextKey = keyFor(workspaceId, next);
    // Merge, never overwrite: the target path may hold drafts of its own.
    // Sorted by id, which is capture order, because that is the one order the
    // store offers — appending would read newest-first here and oldest-first
    // after the next launch, which reorders the Copy buttons under the user.
    drafts.set(
      nextKey,
      [...(drafts.get(nextKey) ?? EMPTY), ...kept].sort((a, b) => a.id - b.id),
    );
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

// Every set-aside draft an exit would DESTROY, by id. The close warning keys
// off this (#579 review, r4): losing these is irreversible, and the user must
// be told before it runs. It compares the LIVE list against the ids the user
// approved losing (#579 review, r13) — a count alone cannot tell "the same two
// drafts" from "one dismissed and one new". A draft the list does not contain
// was in no warning, and the exit stops for it.
//
// A persisted draft is not one of them (#600) — it comes back on the next
// launch, and calling it lost would be a lie about durability on every quit.
// What is left behind the warning is what nothing else can bring back: a
// secret-classified path the plaintext store refuses, and a draft whose write
// storage refused.
export function atRiskOrphanedDraftIds(): readonly number[] {
  const ids: number[] = [];
  for (const kept of drafts.values()) {
    for (const draft of kept) if (!storedIds.has(draft.id)) ids.push(draft.id);
  }
  return ids;
}

export type OrphanedDraftRow = {
  workspaceId: string;
  // The name the UI shows for this workspace (the shell registers it) — the
  // raw id is a UUID no user recognizes (#579 review, r10). Falls back to
  // the id when no shell for that workspace ever mounted.
  workspaceLabel: string;
  path: string;
  draft: OrphanedDraft;
  // Whether this row survives a restart. The close warning lists only the
  // rows that do not (#600).
  persisted: boolean;
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
        rows.push({
          workspaceId,
          workspaceLabel,
          path,
          draft,
          persisted: storedIds.has(draft.id),
        });
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
  storedIds = new Set();
  clearStoredDrafts();
  claimedIds.clear();
  scheduleNotify();
}
