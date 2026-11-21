import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import type { SetAsideDraftChange } from "../ipc/bridgeContract";
import { bridge } from "./bridge";

export const ORPHANED_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STORED_DRAFT_VERSION = 1;
export type DraftRecoveryIdentity = {
  objectId: string;
  updateBase64: string;
  recordId?: string;
  reason?: "deleted";
};
type StoredOrphanedDraft = {
  id: number;
  workspaceId: string;
  path: string;
  text: string;
  capturedAtMs: number;
  recovery?: DraftRecoveryIdentity;
};
const files = new Map<string, string>();
const fileListeners = new Set<() => void>();
// Numeric handles belong to this renderer. Each durable recovery owns one file,
// so another window never rewrites a file holding this window's work.
const keys = new Map<number, string>();
const expected = new Map<number, string>();
const ownedKeys = new Set<string>();
const pending = new Map<number, number>();
const refused = new Set<number>();
let stopHearing: (() => void) | null = null;
let heldWhileListing: SetAsideDraftChange[] | null = null;
const inFlight = new Set<Promise<unknown>>();
// Only a tracked path's draft may reach plaintext storage.
export function persistable(path: string): boolean {
  return classifyEngineFilePathForRead(path, bridge().platform).kind === "tracked";
}
function unsupportedVersion(value: unknown): boolean {
  // Missing versions are the original version 1 format. Leave unknown formats untouched.
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version !== STORED_DRAFT_VERSION
  );
}
function serialize(draft: StoredOrphanedDraft): string {
  return JSON.stringify({ ...draft, version: STORED_DRAFT_VERSION });
}
function valid(value: unknown): value is StoredOrphanedDraft {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "number" &&
    typeof row.workspaceId === "string" &&
    typeof row.path === "string" &&
    typeof row.text === "string" &&
    typeof row.capturedAtMs === "number" &&
    (row.recovery === undefined ||
      (typeof row.recovery === "object" &&
        row.recovery !== null &&
        "objectId" in row.recovery &&
        typeof row.recovery.objectId === "string" &&
        "updateBase64" in row.recovery &&
        typeof row.recovery.updateBase64 === "string" &&
        (!("recordId" in row.recovery) || typeof row.recovery.recordId === "string") &&
        (!("reason" in row.recovery) || row.recovery.reason === "deleted")))
  );
}
function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
function notifyFiles(): void {
  for (const listener of [...fileListeners]) listener();
}
function apply(change: SetAsideDraftChange): void {
  if (change.raw === null) files.delete(change.key);
  else files.set(change.key, change.raw);
  notifyFiles();
}

export function onDraftFilesChanged(listener: () => void): () => void {
  fileListeners.add(listener);
  return () => fileListeners.delete(listener);
}

function hear(): void {
  stopHearing ??= bridge().onSetAsideDraftChanged((change) => {
    if (heldWhileListing) heldWhileListing.push(change);
    else apply(change);
  });
}

export async function loadDraftFiles(): Promise<void> {
  heldWhileListing = [];
  try {
    hear();
    for (const { key, raw } of await bridge().listSetAsideDrafts({})) files.set(key, raw);
  } finally {
    const held = heldWhileListing;
    heldWhileListing = null;
    for (const change of held) apply(change);
  }
}

function send(
  ids: readonly number[],
  request: () => Promise<boolean>,
  onAnswer: (written: boolean) => void = () => undefined,
): Promise<boolean> {
  for (const id of ids) pending.set(id, (pending.get(id) ?? 0) + 1);
  const answer = (async () => {
    try {
      hear();
      return await request();
    } catch {
      return false;
    }
  })();
  const settled = answer.then((written) => {
    onAnswer(written);
    for (const id of ids) {
      const left = (pending.get(id) ?? 1) - 1;
      if (left > 0) pending.set(id, left);
      else pending.delete(id);
    }
    inFlight.delete(settled);
    notifyFiles();
    return written;
  });
  inFlight.add(settled);
  return settled;
}
function removeIfCurrent(key: string | undefined, raw: string | undefined): void {
  if (key === undefined || raw === undefined) return;
  void send([], () => bridge().removeSetAsideDraft({ key, ifCurrent: raw }));
}

export function loadStoredDrafts(
  nowMs: number,
  options: { bindHandles?: boolean } = {},
): readonly StoredOrphanedDraft[] {
  const bind = options.bindHandles !== false;
  const result: StoredOrphanedDraft[] = [];
  const used = new Set<number>();
  const recoveries = new Set<string>();
  for (const [key, raw] of files) {
    const row = parse(raw);
    if (unsupportedVersion(row)) continue;
    if (!valid(row) || !persistable(row.path)) {
      if (bind) removeIfCurrent(key, raw);
      continue;
    }
    const capturedAtMs =
      Number.isFinite(row.capturedAtMs) && row.capturedAtMs > 0 ? row.capturedAtMs : nowMs;
    if (nowMs - capturedAtMs >= ORPHANED_DRAFT_RETENTION_MS) {
      if (bind) removeIfCurrent(key, raw);
      continue;
    }
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
    const restored = { ...row, id, capturedAtMs };
    if (bind) {
      keys.set(id, key);
      if (capturedAtMs === row.capturedAtMs) expected.set(id, raw);
      else {
        const normalized = serialize(restored);
        expected.set(id, normalized);
        void send([id], () =>
          bridge().writeSetAsideDraft({ key, raw: normalized, ifCurrent: raw }),
        );
      }
    }
    result.push(restored);
  }
  return result;
}
function write(
  draft: StoredOrphanedDraft,
  key: string,
  ifCurrent: string | null,
): Promise<boolean> {
  if (!persistable(draft.path)) return Promise.resolve(false);
  const raw = serialize(draft);
  keys.set(draft.id, key);
  expected.set(draft.id, raw);
  ownedKeys.add(key);
  return send(
    [draft.id],
    () => bridge().writeSetAsideDraft({ key, raw, ifCurrent }),
    (written) => {
      if (written) refused.delete(draft.id);
      else {
        refused.add(draft.id);
        ownedKeys.delete(key);
        if (expected.get(draft.id) === raw) {
          const held = files.get(key);
          if (held === undefined) expected.delete(draft.id);
          else expected.set(draft.id, held);
        }
      }
    },
  );
}
export function storeDraft(draft: StoredOrphanedDraft): Promise<boolean> {
  return write(draft, crypto.randomUUID(), null);
}
export async function replaceStoredDraft(draft: StoredOrphanedDraft): Promise<boolean> {
  const key = keys.get(draft.id);
  const raw = expected.get(draft.id);
  // Restored files may also be in another window. Refine into this window's own copy.
  if (
    key !== undefined &&
    raw !== undefined &&
    ownedKeys.has(key) &&
    (pending.has(draft.id) || isStoredDraftCurrent(draft.id))
  )
    return write(draft, key, raw);
  if (!(await storeDraft(draft))) return false;
  removeIfCurrent(key, raw);
  if (key) ownedKeys.delete(key);
  return true;
}
export function isStoredDraftCurrent(id: number): boolean {
  const key = keys.get(id),
    raw = expected.get(id);
  return !refused.has(id) && key !== undefined && raw !== undefined && files.get(key) === raw;
}
export function isStoredDraftPending(id: number): boolean {
  return pending.has(id);
}
export function forgetStoredDraft(id: number): void {
  const key = keys.get(id);
  const raw = expected.get(id);
  const row = raw === undefined ? undefined : parse(raw);
  if (valid(row) && row.recovery?.recordId !== undefined) {
    // Separate windows can save the same reviewed record in separate files.
    for (const [copyKey, copyRaw] of files) {
      if (copyKey === key) continue;
      const copy = parse(copyRaw);
      if (
        valid(copy) &&
        !unsupportedVersion(copy) &&
        copy.workspaceId === row.workspaceId &&
        copy.recovery?.recordId === row.recovery.recordId &&
        copy.text === row.text &&
        copy.recovery.objectId === row.recovery.objectId &&
        copy.recovery.updateBase64 === row.recovery.updateBase64
      )
        removeIfCurrent(copyKey, copyRaw);
    }
  }
  removeIfCurrent(key, raw);
  if (key) ownedKeys.delete(key);
  keys.delete(id);
  expected.delete(id);
  refused.delete(id);
}
export function remapStoredDraftPaths(
  workspaceId: string,
  project: (path: string) => string | null,
): ReadonlySet<number> {
  const dropped = new Set<number>();
  const handles = new Map<string, number[]>();
  for (const [id, key] of keys) handles.set(key, [...(handles.get(key) ?? []), id]);
  const held = new Map(files);
  for (const [id, key] of keys) {
    const sent = expected.get(id);
    if (pending.has(id) && sent !== undefined) held.set(key, sent);
  }
  for (const [key, raw] of held) {
    const ids = handles.get(key) ?? [];
    const row = parse(raw);
    if (unsupportedVersion(row) || !valid(row) || row.workspaceId !== workspaceId) continue;
    const path = project(row.path);
    if (path === null || path === row.path) continue;
    if (!persistable(path)) {
      removeIfCurrent(key, raw);
      for (const id of ids) {
        expected.delete(id);
        dropped.add(id);
      }
    } else {
      const next = serialize({ ...row, path });
      void send(ids, () => bridge().writeSetAsideDraft({ key, raw: next, ifCurrent: raw }));
      // Only advance handles that still describe the bytes just remapped.
      // Another window's replacement must not make stale local text durable.
      for (const id of ids) if (expected.get(id) === raw) expected.set(id, next);
    }
  }
  return dropped;
}
export async function storedDraftSettled(id: number): Promise<void> {
  while (pending.has(id)) await Promise.all([...inFlight]);
}
export async function draftFileWritesSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}
export function clearStoredDrafts(): void {
  files.clear();
  keys.clear();
  expected.clear();
  ownedKeys.clear();
  pending.clear();
  refused.clear();
  stopHearing?.();
  stopHearing = null;
}
