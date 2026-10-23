import { bridge } from "./bridge";
import { useSyncExternalStore } from "react";
import { base64ToBytes } from "./base64";
import type { LiveDraftRecoveryRecord } from "../ipc/bridgeContract";
import {
  clearStoredDrafts,
  forgetStoredDraft,
  loadStoredDrafts,
  isStoredDraftCurrent,
  persistable,
  remapStoredDraftPaths,
  replaceStoredDraft,
  storeDraft,
  type DraftRecoveryIdentity,
} from "./orphanedDraftStorage";

// Set-aside drafts: text a reopen took out of the save pipeline, held
// until the user copies or dismisses it. The store lives outside the keyed
// document view because the notice promises the text stays recoverable —
// switching or closing the tab must not drop it.
//
// The text never goes back into the document — writing it there is the clobber
// the capture exists to prevent — but it does reach disk, in the app's
// own storage and never in the workspace tree. `orphanedDraftStorage` keeps
// the copy that outlives the app run; this module keeps the copy every surface
// reads, and `restoreOrphanedDrafts` puts the two together at startup.

export type OrphanedDraft = {
  id: number;
  // The full serialized document as the user last had it, frontmatter
  // included — what Copy hands back.
  text: string;
  // When the reopen set this text aside. The order key (see the merge in
  // `remapOrphanedDraftPaths`), and deliberately not the id: an id is a slot
  // an allocator can hand out again after a dismissal frees it, so the newest
  // draft in a run can hold a lower id than a survivor captured before it.
  // A capture time is the same number on both sides of a restart, and storage
  // has carried it since #600.
  capturedAtMs: number;
  recovery?: DraftRecoveryIdentity;
};

// The order every surface reads: oldest first. Capture time is the key, and
// the id breaks a tie — two reopens inside one millisecond are ordinary, and
// leaving those to a stable sort is not enough, because the two halves feed
// their sort in different orders (this map merges target-then-moved, storage
// keeps arrival order) and would disagree exactly on the tie.
//
// Both numbers travel with the row and survive a restart, so the notice reads
// the same before and after a launch. That is what this order promises. It
// does not promise which of two drafts captured in the same millisecond truly
// came first — nothing recorded can answer that, and no surface asks.
function byCaptureOrder(
  a: { capturedAtMs: number; id: number },
  b: { capturedAtMs: number; id: number },
): number {
  return a.capturedAtMs - b.capturedAtMs || a.id - b.id;
}

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
const recoveryRequests = new Map<string, Promise<void>>();

// A late list or dismiss reply must not reintroduce a record a later dismiss removed.
function withRecoveryRequest(workspaceId: string, work: () => Promise<void>): Promise<void> {
  const request = (recoveryRequests.get(workspaceId) ?? Promise.resolve()).catch(() => {}).then(work);
  recoveryRequests.set(workspaceId, request);
  void request.finally(() => {
    if (recoveryRequests.get(workspaceId) === request) recoveryRequests.delete(workspaceId);
  }).catch(() => {});
  return request;
}

function captureLiveDraftRecovery(workspaceId: string, records: readonly LiveDraftRecoveryRecord[]): void {
  for (const record of records) {
    if (findWorkspaceDraft(workspaceId, draft => draft.recovery?.recordId === record.recordId)) continue;
    const current = drafts.get(keyFor(workspaceId, record.path)) ?? EMPTY;
    const recovery = {objectId: record.objectId, updateBase64: record.updateBase64, recordId: record.recordId, ...(record.reason ? {reason: record.reason} : {})};
    const existing = current.find(draft => draft.recovery?.recordId === undefined &&
      draft.recovery?.objectId === record.objectId && draft.recovery.updateBase64 === record.updateBase64 && draft.text === record.text);
    if (existing) replaceOrphanedDraft(workspaceId, record.path, existing.id, record.text, recovery);
    else captureOrphanedDraft(workspaceId, record.path, record.text, recovery);
  }
}

function findWorkspaceDraft(workspaceId: string, matches: (draft: OrphanedDraft) => boolean): {path: string; draft: OrphanedDraft} | undefined {
  for (const [key, kept] of drafts) {
    const [keyWorkspaceId, path] = JSON.parse(key) as [string, string];
    if (keyWorkspaceId !== workspaceId) continue;
    const draft = kept.find(matches);
    if (draft) return {path, draft};
  }
}

// Every draft main keeps for the workspace, as main lists them now. A row of
// main's draft that is no longer listed goes: main removed it, or replaced it
// with a draft of newer text, which the listing adds.
export function loadLiveDraftRecovery(workspaceId: string, isCurrent: () => boolean): Promise<void> {
  return withRecoveryRequest(workspaceId, async () => {
    if (!isCurrent()) return;
    const records = await bridge().listLiveDraftRecovery({workspaceId});
    if (!isCurrent()) return;
    const listed = new Set(records.map(record => record.recordId));
    for (const [key, kept] of [...drafts]) {
      const [keyWorkspaceId, path] = JSON.parse(key) as [string, string];
      if (keyWorkspaceId !== workspaceId) continue;
      for (const draft of kept) {
        const recordId = draft.recovery?.recordId;
        if (recordId !== undefined && !listed.has(recordId)) retireOrphanedDraft(workspaceId, path, draft.id);
      }
    }
    captureLiveDraftRecovery(workspaceId, records);
  });
}

function keyFor(workspaceId: string, path: string): string {
  // JSON quotes each part, so two different keys cannot collide.
  return JSON.stringify([workspaceId, path]);
}

// Deferred because some captures still run during document-view render. A
// synchronous notification there would schedule subscriber renders mid-render.
if (typeof window !== "undefined") window.addEventListener("storage", scheduleNotify);

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
// Synchronous because event-boundary and render-boundary captures cannot await.
//
// Ids are never reused, which is why dismissing does not give one back. The
// close guard remembers the ids the user approved losing,
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
  recovery?: DraftRecoveryIdentity,
): number {
  const key = keyFor(workspaceId, path);
  const id = allocateDraftId();
  // One reading for both halves, or the copy that outlives the run would sort
  // against a different clock than the copy on screen.
  const capturedAtMs = Date.now();
  // Durable before the notice exists. The write is synchronous, so the
  // answer the close guard needs is already true here — a draft is at risk
  // only when storage refused it.
  if (storeDraft({ id, workspaceId, path, text, capturedAtMs, recovery })) {
    storedIds.add(id);
  }
  // Append, never overwrite: a second reopen with the first notice still up
  // must not destroy the first draft.
  drafts.set(key, [...(drafts.get(key) ?? EMPTY), { id, text, capturedAtMs, recovery }]);
  scheduleNotify();
  return id;
}

// A second snapshot from the same deletion updates its existing recovery.
// Separate deletions still use captureOrphanedDraft and append separate rows.
export function replaceOrphanedDraft(
  workspaceId: string,
  path: string,
  id: number,
  text: string,
  recovery?: DraftRecoveryIdentity,
): void {
  const key = keyFor(workspaceId, path);
  const current = drafts.get(key) ?? EMPTY;
  const captured = current.find((draft) => draft.id === id);
  // Unchanged text still retries a write storage refused.
  if (!captured || (captured.text === text && recovery === undefined && !orphanedDraftStorageRefused(path, id))) return;
  let replacementRecovery = recovery ?? captured.recovery;
  if (recovery === undefined && text !== captured.text && replacementRecovery?.recordId !== undefined) {
    replacementRecovery = {objectId: replacementRecovery.objectId, updateBase64: replacementRecovery.updateBase64};
  }
  const replacement = { ...captured, text, recovery: replacementRecovery };
  drafts.set(
    key,
    current.map((draft) => (draft.id === id ? replacement : draft)),
  );
  if (
    replaceStoredDraft({
      id,
      workspaceId,
      path,
      text,
      capturedAtMs: captured.capturedAtMs,
      recovery: replacement.recovery,
    })
  ) {
    storedIds.add(id);
  } else {
    storedIds.delete(id);
  }
  scheduleNotify();
}

// Startup restore: the persisted recoveries land in the same store the
// in-document notice, the tab dot, the notice center, and the close warning
// already read, so every one of those surfaces works unchanged. Called once,
// from main.tsx before the root renders — synchronous, before any subscriber
// or any workspace exists, so there is nothing to notify and no in-flight
// response that could repaint a workspace the user has switched away from.
export function restoreOrphanedDrafts(nowMs: number = Date.now()): void {
  // Oldest first, by the same key the merge uses — storage holds arrival
  // order, which agrees with it except for a row whose capture time the load
  // pass had to repair.
  const stored = [...loadStoredDrafts(nowMs)].sort(byCaptureOrder);
  for (const row of stored) {
    const key = keyFor(row.workspaceId, row.path);
    drafts.set(key, [
      ...(drafts.get(key) ?? EMPTY),
      { id: row.id, text: row.text, capturedAtMs: row.capturedAtMs, recovery: row.recovery },
    ]);
    storedIds.add(row.id);
    // Storage maps each local handle to its durable key. Reserve restored
    // handles so this renderer's new captures cannot reuse them.
    claimedIds.add(row.id);
  }
}

export async function dismissOrphanedDraft(
  workspaceId: string,
  path: string,
  id: number,
): Promise<void> {
  const key = keyFor(workspaceId, path);
  const captured = drafts.get(key)?.find(draft => draft.id === id);
  if (!captured) return;
  const recovery = captured.recovery;
  if (recovery) {
    const discardedAtMs = Date.now();
    await withRecoveryRequest(workspaceId, async () => {
      const assertCurrent = () => {
        const current = findWorkspaceDraft(workspaceId, draft => draft.id === id);
        if (!current || current.draft.text !== captured.text ||
          current.draft.recovery?.objectId !== recovery.objectId || current.draft.recovery.updateBase64 !== recovery.updateBase64) {
          throw new Error("This draft changed while dohc dismissed it. Review it and try again.");
        }
        return current;
      };
      assertCurrent();
      const bytes = base64ToBytes(recovery.updateBase64);
      const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
      const current = assertCurrent();
      const snapshotSha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
      const records = await bridge().discardLiveDraftRecovery({
        workspaceId, path: current.path, objectId: recovery.objectId, snapshotSha256, discardedAtMs, recordId: current.draft.recovery?.recordId,
      });
      captureLiveDraftRecovery(workspaceId, records);
      const latest = assertCurrent();
      if (!records.some(record => record.recordId === latest.draft.recovery?.recordId)) {
        retireOrphanedDraft(workspaceId, latest.path, id);
      }
    });
    return;
  }
  retireOrphanedDraft(workspaceId, path, id);
}

function retireOrphanedDraft(workspaceId: string, path: string, id: number): void {
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
// one. The caller supplies the same projection the shell
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
    // Merge, never overwrite: the target path may hold drafts of its own, and
    // `byCaptureOrder` is what keeps this run's reading and the next launch's
    // reading the same — appending would read one way here and the other way
    // after a restart, reordering the Copy buttons under the user.
    drafts.set(
      nextKey,
      [...(drafts.get(nextKey) ?? EMPTY), ...kept].sort(byCaptureOrder),
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
// marks inactive tabs with it — only the mounted inspector
// can report savable-dirty, but recovery is knowable for every tab.
export function retainedOrphanedDraftPaths(workspaceId: string): string[] {
  const paths = [...drafts.keys()].map(key => JSON.parse(key) as [string, string]).filter(([id]) => id === workspaceId).map(([, path]) => path);
  return [...new Set([...paths, ...loadStoredDrafts(Date.now(), {bindHandles: false}).filter(draft => draft.workspaceId === workspaceId).map(draft => draft.path)])];
}

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

// Every set-aside draft an exit would destroy, by id. The close warning keys
// off this: losing these is irreversible, and the user must
// be told before it runs. It compares the live list against the ids the user
// approved losing — a count alone cannot tell "the same two
// drafts" from "one dismissed and one new". A draft the list does not contain
// was in no warning, and the exit stops for it.
//
// A persisted draft is not one of them — it comes back on the next
// launch, and calling it lost would be a lie about durability on every quit.
// What is left behind the warning is what nothing else can bring back: a
// secret-classified path the plaintext store refuses, and a draft whose write
// storage refused.
export function atRiskOrphanedDraftIds(): readonly number[] {
  const ids: number[] = [];
  for (const kept of drafts.values()) {
    for (const draft of kept) if (!isOrphanedDraftStored(draft.id)) ids.push(draft.id);
  }
  return ids;
}

// Whether a restart brings this draft back.
export function isOrphanedDraftStored(id: number): boolean {
  return storedIds.has(id) && isStoredDraftCurrent(id);
}

// Whether storage refused a draft it should keep. A path storage never keeps
// stays in this run, behind the close warning.
export function orphanedDraftStorageRefused(path: string, id: number): boolean {
  return persistable(path) && !isOrphanedDraftStored(id);
}

export type OrphanedDraftRow = {
  workspaceId: string;
  // The name the UI shows for this workspace (the shell registers it) — the
  // raw id is a UUID no user recognizes. Falls back to
  // the id when no shell for that workspace ever mounted.
  workspaceLabel: string;
  path: string;
  draft: OrphanedDraft;
  // Whether this row survives a restart. The close warning lists only the
  // rows that do not.
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
          persisted: isOrphanedDraftStored(draft.id),
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

// Test seam: counts the mutations this run has made. Resetting the store is
// not enough on its own — an unmounted view can still capture a draft on a
// later turn, and the notification that follows re-renders the recovery notice
// inside the next test, under whatever it was about to click. A teardown reads
// this to tell "the capture already landed" from "it is still coming".
export function orphanedDraftStoreVersionForTests(): number {
  return storeVersion;
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
