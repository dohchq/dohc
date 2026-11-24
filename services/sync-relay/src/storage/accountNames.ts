import { handleForName, normalizeHandle } from "@dohc/workspace-contracts/chat-mentions";
import { normalizeShareDiscussionDisplayName } from "@dohc/security-contract/share-discussion";
import { NO_LIVE_AUTHORITY } from "../relayWriteChanges";
import { accountIsFenced } from "./accountDeletion";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";

// The relay's last known display name for each account, and the mention
// handle it gives. A message's append transaction cannot ask the account
// database, so mentions find people here. Account deletion removes the row
// with the account's other `user_id` rows.
const MARKER = "account-names-v1";
const schema = {
  sync_relay_account_names: `CREATE TABLE sync_relay_account_names (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
    handle TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  idx_sync_relay_account_names_handle: `CREATE INDEX idx_sync_relay_account_names_handle ON sync_relay_account_names(handle)`,
} as const;

export function initializeAccountNames(db: SqliteDb): void {
  const normalize = (sql: string) => sql.trim().replace(/\s+/gu, " ");
  const assert = () => {
    for (const [name, sql] of Object.entries(schema)) {
      const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name);
      if (typeof row?.sql !== "string" || normalize(row.sql) !== normalize(sql))
        throw Error("account name schema is missing or damaged");
    }
  };
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER)) {
    assert();
    return;
  }
  for (const name of Object.keys(schema)) {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name))
      throw Error("unmarked account name schema already exists");
  }
  for (const sql of Object.values(schema)) db.exec(sql);
  assert();
  db.prepare("INSERT INTO sync_relay_migrations(migration_id, completed_at_ms) VALUES (?, ?)").run(
    MARKER,
    Date.now(),
  );
}

/** Keeps the account's current name, inside the caller's transaction. Writes only when it changed. */
export function saveAccountName(
  storage: StorageContext,
  userId: string,
  name: string | null,
  nowMs: number,
): void {
  if (accountIsFenced(storage, userId)) return;
  const normalized = normalizeShareDiscussionDisplayName(name);
  if (!normalized.ok) return;
  const current = storage.db
    .prepare("SELECT display_name FROM sync_relay_account_names WHERE user_id = ?")
    .get(userId);
  if (current?.display_name === normalized.value) return;
  storage.db
    .prepare(`INSERT INTO sync_relay_account_names (user_id, display_name, handle, updated_at_ms)
    VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name,
    handle = excluded.handle, updated_at_ms = excluded.updated_at_ms`)
    .run(userId, normalized.value, normalizeHandle(handleForName(normalized.value)), nowMs);
}

const accountNameVersions = new WeakMap<
  SqliteDb,
  { seq: number; pending: Set<number>; applied: Map<string, number> }
>();

function versionState(db: SqliteDb) {
  let state = accountNameVersions.get(db);
  if (!state) {
    state = { seq: 0, pending: new Set(), applied: new Map() };
    accountNameVersions.set(db, state);
  }
  return state;
}

export interface AccountNameLookupToken {
  readonly generation: number;
  finish(): void;
}

export function beginAccountNameLookup(storage: StorageContext): AccountNameLookupToken {
  const state = versionState(storage.db);
  const generation = ++state.seq;
  state.pending.add(generation);
  let finished = false;
  return {
    generation,
    finish() {
      if (finished) return;
      finished = true;
      const wasOldest = state.pending.values().next().value === generation;
      state.pending.delete(generation);
      if (state.pending.size === 0) {
        state.applied.clear();
        return;
      }
      if (!wasOldest) return;
      const oldestPending = state.pending.values().next().value!;
      for (const [userId, appliedGeneration] of state.applied) {
        if (appliedGeneration <= oldestPending) state.applied.delete(userId);
      }
    },
  };
}

function noteAppliedGeneration(db: SqliteDb, userId: string, generation: number): void {
  const state = versionState(db);
  const oldestPending = state.pending.values().next().value;
  if (oldestPending === undefined || oldestPending >= generation) return;
  if ((state.applied.get(userId) ?? 0) < generation) state.applied.set(userId, generation);
}

function isStaleGeneration(db: SqliteDb, userId: string, generation: number | undefined): boolean {
  return generation !== undefined && generation < (versionState(db).applied.get(userId) ?? 0);
}

function applyAccountNameInTransaction(
  storage: StorageContext,
  userId: string,
  name: string | null,
  nowMs: number,
  generation: number | undefined,
): void {
  if (accountIsFenced(storage, userId) || isStaleGeneration(storage.db, userId, generation)) return;
  const normalized = normalizeShareDiscussionDisplayName(name);
  if (normalized.ok) {
    saveAccountName(storage, userId, normalized.value, nowMs);
  } else {
    storage.db.prepare("DELETE FROM sync_relay_account_names WHERE user_id = ?").run(userId);
  }
  if (generation !== undefined) noteAppliedGeneration(storage.db, userId, generation);
}

/** Keeps the account's current name in its own transaction, clearing it when an authoritative lookup returns an unusable name. */
export function recordAccountName(
  storage: StorageContext,
  userId: string,
  name: string | null,
  nowMs = Date.now(),
  generation?: number,
): void {
  if (accountIsFenced(storage, userId) || isStaleGeneration(storage.db, userId, generation)) return;
  const normalized = normalizeShareDiscussionDisplayName(name);
  const desired = normalized.ok ? normalized.value : null;
  if (accountName(storage, userId) === desired) {
    if (generation !== undefined) noteAppliedGeneration(storage.db, userId, generation);
    return;
  }
  storage.tx(
    () => applyAccountNameInTransaction(storage, userId, name, nowMs, generation),
    NO_LIVE_AUTHORITY,
  );
}

/** Keeps changed account names in one transaction, clearing rows whose authoritative lookup returned an unusable name. */
export function recordAccountNames(
  storage: StorageContext,
  entries: Iterable<readonly [string, string | null]>,
  nowMs = Date.now(),
  generation?: number,
): void {
  const changed: Array<[string, string | null]> = [];
  for (const [userId, name] of entries) {
    if (accountIsFenced(storage, userId) || isStaleGeneration(storage.db, userId, generation))
      continue;
    const normalized = normalizeShareDiscussionDisplayName(name);
    const desired = normalized.ok ? normalized.value : null;
    if (accountName(storage, userId) === desired) {
      if (generation !== undefined) noteAppliedGeneration(storage.db, userId, generation);
      continue;
    }
    changed.push([userId, desired]);
  }
  if (changed.length === 0) return;
  storage.tx(() => {
    for (const [userId, name] of changed)
      applyAccountNameInTransaction(storage, userId, name, nowMs, generation);
  }, NO_LIVE_AUTHORITY);
}

export function workspaceAccountIds(
  storage: StorageContext,
  workspaceId: string,
  limit = 2_000,
): string[] {
  return storage.db
    .prepare(`SELECT user_id FROM (
      SELECT owner_user_id AS user_id FROM sync_relay_workspaces WHERE workspace_id = ?
      UNION
      SELECT g.principal_user_id AS user_id
      FROM sync_relay_share_grants g
      JOIN sync_relay_shares s USING (share_id)
      WHERE s.workspace_id = ? AND g.principal_kind = 'user' AND g.principal_user_id IS NOT NULL AND g.status = 'active'
    )
    ORDER BY user_id
    LIMIT ?`)
    .all(workspaceId, workspaceId, limit)
    .map((row) => String(row.user_id));
}

export function unnamedAccountIds(
  storage: StorageContext,
  limit: number,
  afterUserId = "",
): string[] {
  return storage.db
    .prepare(`SELECT user_id FROM (
      SELECT owner_user_id AS user_id FROM sync_relay_workspaces
      UNION
      SELECT g.principal_user_id AS user_id
      FROM sync_relay_share_grants g
      WHERE g.principal_kind = 'user' AND g.principal_user_id IS NOT NULL AND g.status = 'active'
    ) eligible
    WHERE user_id > ?
      AND NOT EXISTS (SELECT 1 FROM sync_relay_account_names n WHERE n.user_id = eligible.user_id)
    ORDER BY user_id
    LIMIT ?`)
    .all(afterUserId, limit)
    .map((row) => String(row.user_id));
}

export function accountName(storage: StorageContext, userId: string): string | null {
  const row = storage.db
    .prepare("SELECT display_name FROM sync_relay_account_names WHERE user_id = ?")
    .get(userId);
  return row ? String(row.display_name) : null;
}
