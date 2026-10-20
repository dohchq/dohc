import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { bridge } from "./bridge";

export const ORPHANED_DRAFT_STORAGE_KEY = "dohc-set-aside-drafts";
export const ORPHANED_DRAFT_STORAGE_PREFIX = `${ORPHANED_DRAFT_STORAGE_KEY}:`;
export const ORPHANED_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STORED_DRAFT_VERSION = 1;
export type DraftRecoveryIdentity = {objectId: string; updateBase64: string; recordId?: string; reason?: "deleted"};
type StoredOrphanedDraft = { id: number; workspaceId: string; path: string; text: string; capturedAtMs: number; recovery?: DraftRecoveryIdentity };
// Numeric handles belong to this renderer. Each durable recovery owns one key,
// so another window never rewrites an array containing this window's work.
const keys = new Map<number, string>();
const expected = new Map<number, string>();
const ownedKeys = new Set<string>();
// Only a tracked path's draft may reach plaintext storage.
export function persistable(path: string): boolean {
  return classifyEngineFilePathForRead(path, bridge().platform).kind === "tracked";
}
function unsupportedVersion(value: unknown): boolean {
  // Missing versions are the original version 1 format. Leave unknown formats untouched.
  return typeof value === "object" && value !== null && "version" in value && value.version !== STORED_DRAFT_VERSION;
}
function serialize(draft: StoredOrphanedDraft): string {
  return JSON.stringify({ ...draft, version: STORED_DRAFT_VERSION });
}
function valid(value: unknown): value is StoredOrphanedDraft {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "number" && typeof row.workspaceId === "string" && typeof row.path === "string" &&
    typeof row.text === "string" && typeof row.capturedAtMs === "number" &&
    (row.recovery === undefined || (typeof row.recovery === "object" && row.recovery !== null && "objectId" in row.recovery && typeof row.recovery.objectId === "string" && "updateBase64" in row.recovery && typeof row.recovery.updateBase64 === "string" && (!("recordId" in row.recovery) || typeof row.recovery.recordId === "string") &&
      (!("reason" in row.recovery) || row.recovery.reason === "deleted")));
}
function storedKeys(): string[] {
  const result: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(ORPHANED_DRAFT_STORAGE_PREFIX)) result.push(key);
  }
  return result;
}
function remove(key: string): void { try { localStorage.removeItem(key); } catch { /* Refused storage remains unavailable. */ } }
function removeIfCurrent(key: string | undefined, raw: string | undefined): void {
  try {if (key !== undefined && raw !== undefined && localStorage.getItem(key) === raw) remove(key);}
  catch { /* Preserve a copy whose bytes cannot be checked. */ }
}

export function loadStoredDrafts(nowMs: number, options: {bindHandles?: boolean} = {}): readonly StoredOrphanedDraft[] {
  const result: StoredOrphanedDraft[] = [];
  const used = new Set<number>();
  const recoveries = new Set<string>();
  try {
    for (const key of storedKeys()) {
      let row: unknown;
      const raw = localStorage.getItem(key);
      try { row = JSON.parse(raw ?? "null"); } catch { remove(key); continue; }
      if (unsupportedVersion(row)) continue;
      if (!valid(row) || !persistable(row.path)) { remove(key); continue; }
      const capturedAtMs = Number.isFinite(row.capturedAtMs) && row.capturedAtMs > 0 ? row.capturedAtMs : nowMs;
      if (nowMs - capturedAtMs >= ORPHANED_DRAFT_RETENTION_MS) { remove(key); continue; }
      if (row.recovery?.recordId !== undefined) {
        const identity = JSON.stringify([row.workspaceId, row.recovery.recordId]);
        if (recoveries.has(identity)) continue;
        recoveries.add(identity);
      }
      let id = row.id;
      if (!Number.isSafeInteger(id) || id <= 0 || id >= Number.MAX_SAFE_INTEGER || used.has(id)) {
        id = 1;
        while (used.has(id)) id++;
      }
      used.add(id);
      let durableRaw: string | undefined = raw!;
      if (capturedAtMs !== row.capturedAtMs) {
        durableRaw = undefined;
        try {
          if (localStorage.getItem(key) === raw) {
            const normalized = serialize({ ...row, id, capturedAtMs });
            localStorage.setItem(key, normalized);
            durableRaw = normalized;
          }
        } catch { /* Keep refused repairs visible and at risk. */ }
      }
      const restored = { ...row, id, capturedAtMs };
      if (options.bindHandles !== false) {
        keys.set(id, key);
        if (durableRaw !== undefined) expected.set(id, durableRaw);
        else expected.delete(id);
      }
      result.push(restored);
    }
  } catch { /* Storage can be unavailable; capture will retain work in memory. */ }
  return result;
}
function write(draft: StoredOrphanedDraft, key: string): boolean {
  if (!persistable(draft.path)) return false;
  try {
    const raw = serialize(draft);
    localStorage.setItem(key, raw);
    keys.set(draft.id, key); expected.set(draft.id, raw);
    ownedKeys.add(key);
    return true;
  } catch { return false; }
}
export function storeDraft(draft: StoredOrphanedDraft): boolean {
  return write(draft, `${ORPHANED_DRAFT_STORAGE_PREFIX}${crypto.randomUUID()}`);
}
export function replaceStoredDraft(draft: StoredOrphanedDraft): boolean {
  const key = keys.get(draft.id);
  const raw = expected.get(draft.id);
  // Restored keys may also be in another window. Refine into this window's own copy.
  if (key !== undefined && ownedKeys.has(key) && isStoredDraftCurrent(draft.id)) return write(draft, key);
  if (!storeDraft(draft)) return false;
  removeIfCurrent(key, raw);
  if (key) ownedKeys.delete(key);
  return true;
}
export function isStoredDraftCurrent(id: number): boolean {
  const key = keys.get(id), raw = expected.get(id);
  try { return key !== undefined && raw !== undefined && localStorage.getItem(key) === raw; } catch { return false; }
}
export function forgetStoredDraft(id: number): void {
  const key = keys.get(id);
  const raw = expected.get(id);
  try {
    const row: unknown = JSON.parse(raw ?? "null");
    if (valid(row) && row.recovery?.recordId !== undefined) {
      // Separate windows can save the same reviewed record under separate keys.
      for (const copyKey of storedKeys()) {
        let copy: unknown;
        try {copy = JSON.parse(localStorage.getItem(copyKey) ?? "null");} catch {continue;}
        if (valid(copy) && !unsupportedVersion(copy) && copy.workspaceId === row.workspaceId &&
          copy.recovery?.recordId === row.recovery.recordId && copy.text === row.text &&
          copy.recovery.objectId === row.recovery.objectId && copy.recovery.updateBase64 === row.recovery.updateBase64) remove(copyKey);
      }
    }
  } catch { /* Preserve copies whose identity cannot be checked. */ }
  removeIfCurrent(key, raw);
  if (key) ownedKeys.delete(key);
  keys.delete(id); expected.delete(id);
}
export function remapStoredDraftPaths(workspaceId: string, project: (path: string) => string | null): ReadonlySet<number> {
  const dropped = new Set<number>();
  let durableKeys: string[];
  try { durableKeys = storedKeys(); } catch { return new Set(keys.keys()); }
  const handles = new Map<string, number[]>();
  for (const [id, key] of keys) handles.set(key, [...(handles.get(key) ?? []), id]);
  for (const key of durableKeys) {
    const ids = handles.get(key) ?? [];
    try {
      const raw = localStorage.getItem(key);
      const row: unknown = JSON.parse(raw ?? "null");
      if (unsupportedVersion(row) || !valid(row) || row.workspaceId !== workspaceId) continue;
      const path = project(row.path);
      if (path === null || path === row.path) continue;
      if (!persistable(path)) {
        remove(key);
        for (const id of ids) { expected.delete(id); dropped.add(id); }
      } else {
        const next = serialize({ ...row, path });
        localStorage.setItem(key, next);
        // Only advance handles that still describe the bytes just remapped.
        // Another window's replacement must not make stale local text durable.
        for (const id of ids) if (expected.get(id) === raw) expected.set(id, next);
      }
    } catch { for (const id of ids) dropped.add(id); }
  }
  return dropped;
}
export function clearStoredDrafts(): void {
  try { for (const key of storedKeys()) remove(key); } catch { /* Test reset. */ }
  keys.clear(); expected.clear(); ownedKeys.clear();
}
