import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { bridge } from "./bridge";

export const ORPHANED_DRAFT_STORAGE_KEY = "dohc-set-aside-drafts";
export const ORPHANED_DRAFT_STORAGE_PREFIX = `${ORPHANED_DRAFT_STORAGE_KEY}:`;
export const ORPHANED_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type StoredOrphanedDraft = { id: number; workspaceId: string; path: string; text: string; capturedAtMs: number };
// Numeric handles belong to this renderer. Each durable recovery owns one key,
// so another window never rewrites an array containing this window's work.
const keys = new Map<number, string>();
const expected = new Map<number, string>();
function persistable(path: string): boolean {
  return classifyEngineFilePathForRead(path, bridge().platform).kind === "tracked";
}
function valid(value: unknown): value is StoredOrphanedDraft {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "number" && typeof row.workspaceId === "string" && typeof row.path === "string" &&
    typeof row.text === "string" && typeof row.capturedAtMs === "number";
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

// Preserve existing recoveries on upgrade. Deterministic keys let two starting
// windows resume a partial transfer without creating duplicate copies.
function importExistingArray(nowMs: number): StoredOrphanedDraft[] {
  const raw = localStorage.getItem(ORPHANED_DRAFT_STORAGE_KEY);
  if (raw === null) return [];
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { remove(ORPHANED_DRAFT_STORAGE_KEY); return []; }
  if (!Array.isArray(rows)) { remove(ORPHANED_DRAFT_STORAGE_KEY); return []; }
  const remaining: StoredOrphanedDraft[] = [];
  for (const [index, row] of rows.entries()) {
    if (!valid(row) || !persistable(row.path)) continue;
    const normalized = { ...row,
      id: Number.isSafeInteger(row.id) && row.id > 0 && row.id < Number.MAX_SAFE_INTEGER ? row.id : index + 1,
      capturedAtMs: Number.isFinite(row.capturedAtMs) && row.capturedAtMs > 0 ? row.capturedAtMs : nowMs,
    };
    if (nowMs - normalized.capturedAtMs >= ORPHANED_DRAFT_RETENTION_MS) continue;
    const key = `${ORPHANED_DRAFT_STORAGE_PREFIX}import:${index}`;
    try {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(normalized));
    } catch { remaining.push(normalized); }
  }
  if (remaining.length === 0) remove(ORPHANED_DRAFT_STORAGE_KEY);
  return remaining;
}

export function loadStoredDrafts(nowMs: number): readonly StoredOrphanedDraft[] {
  let untransferred: StoredOrphanedDraft[] = [];
  try { untransferred = importExistingArray(nowMs); } catch { /* Storage cannot be read. */ }
  const result: StoredOrphanedDraft[] = [];
  const used = new Set<number>();
  try {
    for (const key of storedKeys()) {
      let row: unknown;
      const raw = localStorage.getItem(key);
      try { row = JSON.parse(raw ?? "null"); } catch { remove(key); continue; }
      if (!valid(row) || !persistable(row.path)) { remove(key); continue; }
      const capturedAtMs = Number.isFinite(row.capturedAtMs) && row.capturedAtMs > 0 ? row.capturedAtMs : nowMs;
      if (nowMs - capturedAtMs >= ORPHANED_DRAFT_RETENTION_MS) { remove(key); continue; }
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
            const normalized = JSON.stringify({ ...row, capturedAtMs });
            localStorage.setItem(key, normalized);
            durableRaw = normalized;
          }
        } catch { /* Keep refused repairs visible and at risk. */ }
      }
      const restored = { ...row, id, capturedAtMs };
      keys.set(id, key);
      if (durableRaw !== undefined) expected.set(id, durableRaw);
      else expected.delete(id);
      result.push(restored);
    }
  } catch { /* Storage can be unavailable; capture will retain work in memory. */ }
  // Quota can prevent splitting an existing array. Keep its text visible and
  // at risk until it has an independent durable key; never claim a failed transfer.
  for (const row of untransferred) {
    let id = row.id;
    if (used.has(id)) {
      id = 1;
      while (used.has(id)) id++;
    }
    used.add(id);
    result.push({ ...row, id });
  }
  return result;
}
function write(draft: StoredOrphanedDraft, key: string): boolean {
  if (!persistable(draft.path)) return false;
  try {
    const raw = JSON.stringify(draft);
    localStorage.setItem(key, raw);
    keys.set(draft.id, key); expected.set(draft.id, raw);
    return true;
  } catch { return false; }
}
export function storeDraft(draft: StoredOrphanedDraft): boolean {
  return write(draft, `${ORPHANED_DRAFT_STORAGE_PREFIX}${crypto.randomUUID()}`);
}
export function replaceStoredDraft(draft: StoredOrphanedDraft): boolean {
  return write(draft, keys.get(draft.id) ?? `${ORPHANED_DRAFT_STORAGE_PREFIX}${crypto.randomUUID()}`);
}
export function isStoredDraftCurrent(id: number): boolean {
  const key = keys.get(id), raw = expected.get(id);
  try { return key !== undefined && raw !== undefined && localStorage.getItem(key) === raw; } catch { return false; }
}
export function forgetStoredDraft(id: number): void {
  const key = keys.get(id);
  if (key) remove(key);
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
      if (!valid(row) || row.workspaceId !== workspaceId) continue;
      const path = project(row.path);
      if (path === null || path === row.path) continue;
      if (!persistable(path)) {
        remove(key);
        for (const id of ids) { expected.delete(id); dropped.add(id); }
      } else {
        const next = JSON.stringify({ ...row, path });
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
  try { for (const key of storedKeys()) remove(key); remove(ORPHANED_DRAFT_STORAGE_KEY); } catch { /* Test reset. */ }
  keys.clear(); expected.clear();
}
