import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";

// The durable half of the set-aside recovery store (#600). `orphanedDrafts.ts`
// holds the copy this app run reads; this holds the copy that survives a quit,
// a crash, and a forced restart.
//
// Renderer-owned storage, not a main-owned file: the capture runs DURING a
// render and the close guard decides inside `beforeunload`, and both need a
// synchronous answer to "is this text already durable?". An IPC round trip
// gives neither one in time, so the guard would have to warn about text that
// is already safe — a lie about durability, on every quit.
//
// It is app-scoped, not workspace-scoped. A recovery outlives the workspace
// it came from: the notice center and the close warning already list drafts
// across workspaces, and a draft's path can belong to a workspace this run
// never opened. Nothing goes inside the workspace tree — the text is exactly
// what the capture refused to write there.
//
// It is PLAINTEXT, which is why the secret floor below decides what may enter
// it at all.

// Exported so tests can read the RAW stored bytes. Asserting through the
// store's own API would pass a floor that leaked: the question "did this text
// reach plaintext storage?" can only be answered by looking at storage.
export const ORPHANED_DRAFT_STORAGE_KEY = "dohc-set-aside-drafts";

// How long an unresolved recovery survives. Housekeeping, not a limit on the
// user's work: nothing is rejected, and a draft this old has outlived the app
// run that set it aside, every notice that offered it, and every restart
// since. Expiry is the only bound — a count or byte cap would delete recovery
// text the user can still see, and destroying that text is never this store's
// call (the same rule the in-memory store follows for a deleted path).
export const ORPHANED_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type StoredOrphanedDraft = {
  id: number;
  workspaceId: string;
  path: string;
  text: string;
  capturedAtMs: number;
};

// THE floor (#446): a draft over a secret-classified path never reaches
// plaintext storage. Only a `tracked` path is eligible — `ignored` is a path
// the engine floor could not normalize, and a store that cannot classify a
// path does not get to guess it is safe. Unpersistable drafts keep their
// in-memory copy, and the close warning is the last line for them.
function isPersistableDraftPath(path: string): boolean {
  return classifyEngineFilePathForRead(path).kind === "tracked";
}

function isStoredDraft(value: unknown): value is StoredOrphanedDraft {
  if (typeof value !== "object" || value === null) return false;
  const row: Record<string, unknown> = value as Record<string, unknown>;
  return (
    typeof row.id === "number" &&
    typeof row.workspaceId === "string" &&
    typeof row.path === "string" &&
    typeof row.text === "string" &&
    typeof row.capturedAtMs === "number"
  );
}

// Unreadable storage and unreadable content answer the same way: no stored
// recoveries. There is nothing else to do with either, and a throw here would
// take down the render that is trying to set a draft aside.
function readRows(): StoredOrphanedDraft[] {
  try {
    const raw = localStorage.getItem(ORPHANED_DRAFT_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStoredDraft) : [];
  } catch {
    return [];
  }
}

// Returns whether the rows are now on disk. A refusal (the quota is full)
// leaves the caller's draft in memory only, and the caller reports it as
// unpersisted rather than claiming a durability it does not have.
function writeRows(rows: readonly StoredOrphanedDraft[]): boolean {
  try {
    localStorage.setItem(ORPHANED_DRAFT_STORAGE_KEY, JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}

// Every recovery still worth restoring, oldest first. Expired rows and rows
// the floor no longer allows are dropped here AND removed from storage: a
// path renamed onto `.env` between two runs must not leave its plaintext
// behind.
export function loadStoredDrafts(nowMs: number): readonly StoredOrphanedDraft[] {
  const rows = readRows();
  const kept = rows.filter(
    (row) =>
      isPersistableDraftPath(row.path) &&
      nowMs - row.capturedAtMs < ORPHANED_DRAFT_RETENTION_MS,
  );
  if (kept.length !== rows.length) writeRows(kept);
  return kept;
}

export function storeDraft(draft: StoredOrphanedDraft): boolean {
  if (!isPersistableDraftPath(draft.path)) return false;
  return writeRows([...readRows(), draft]);
}

export function forgetStoredDraft(id: number): void {
  const rows = readRows();
  const kept = rows.filter((row) => row.id !== id);
  if (kept.length !== rows.length) writeRows(kept);
}

// A rename re-keys the recovery on disk too, or the notice comes back on a
// path that no longer exists. Returns the ids that LOST their stored copy —
// a rename onto a secret-classified path takes the text out of plaintext
// storage at once, and the caller stops calling those drafts durable.
export function remapStoredDraftPaths(
  workspaceId: string,
  project: (path: string) => string | null,
): ReadonlySet<number> {
  const rows = readRows();
  const dropped = new Set<number>();
  const next: StoredOrphanedDraft[] = [];
  let changed = false;
  for (const row of rows) {
    const projected =
      row.workspaceId === workspaceId ? project(row.path) : row.path;
    if (projected === null || projected === row.path) {
      next.push(row);
      continue;
    }
    changed = true;
    if (isPersistableDraftPath(projected)) next.push({ ...row, path: projected });
    else dropped.add(row.id);
  }
  if (changed) writeRows(next);
  return dropped;
}

// Test seam, matching `resetOrphanedDrafts`: module state and storage are one
// store, so a suite that resets one must reset both.
export function clearStoredDrafts(): void {
  try {
    localStorage.removeItem(ORPHANED_DRAFT_STORAGE_KEY);
  } catch {
    // No storage to clear.
  }
}
