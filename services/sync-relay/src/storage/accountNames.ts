import { handleForName, normalizeHandle } from "@dohc/workspace-contracts/chat-mentions";
import { normalizeShareDiscussionDisplayName } from "@dohc/security-contract/share-discussion";
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

/** Keeps the account's current name in its own transaction. */
export function recordAccountName(
  storage: StorageContext,
  userId: string,
  name: string | null,
  nowMs = Date.now(),
): void {
  const normalized = normalizeShareDiscussionDisplayName(name);
  if (!normalized.ok || accountName(storage, userId) === normalized.value) return;
  storage.tx(() => saveAccountName(storage, userId, normalized.value, nowMs));
}

export function accountName(storage: StorageContext, userId: string): string | null {
  const row = storage.db
    .prepare("SELECT display_name FROM sync_relay_account_names WHERE user_id = ?")
    .get(userId);
  return row ? String(row.display_name) : null;
}
