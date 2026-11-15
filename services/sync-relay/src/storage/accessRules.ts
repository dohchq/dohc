import {
  ACCESS_RULE_FILE,
  ACCESS_RULE_MAX_BYTES,
  accessRuleFolder,
  accessRuleSet,
  formatAccessRule,
  parseAccessRule,
  type AccessRuleSet,
} from "@dohc/security-contract/access-rules";
import { pathCollisionKey } from "../pathCollisionKey";
import type { SqliteDb } from "./types";

const ACCESS_RULES_MIGRATION_ID = "access-rules-v1";

// Each folder's rule in each Version, by the log span it held for. `rule_text`
// is the rule's canonical text, or NULL when the folder's rule couldn't be
// read: not UTF-8, over the size cap, outside the format, or two files that
// are one rule on some disk. An unreadable rule hides its folder from members.
export function initializeAccessRuleSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_access_rules (
      workspace_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      rule_text TEXT,
      from_seq INTEGER NOT NULL,
      to_seq INTEGER,
      PRIMARY KEY (workspace_id, version_id, folder, from_seq),
      FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_access_rules_open
      ON sync_relay_access_rules(workspace_id, version_id, folder) WHERE to_seq IS NULL;
    -- Where each workspace's rule history begins. Rows came from current
    -- files, so a rule removed earlier left none: below this seq, the rules
    -- that held aren't known.
    CREATE TABLE IF NOT EXISTS sync_relay_access_rule_floors (
      workspace_id TEXT PRIMARY KEY REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      relay_seq INTEGER NOT NULL
    ) STRICT;
  `);
  if (
    db
      .prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?")
      .get(ACCESS_RULES_MIGRATION_ID)
  )
    return;
  db.prepare(
    `INSERT INTO sync_relay_access_rule_floors (workspace_id, relay_seq)
     SELECT w.workspace_id, MAX(l.relay_seq) FROM sync_relay_workspaces w
     JOIN sync_relay_log l ON l.workspace_id = w.workspace_id GROUP BY w.workspace_id`,
  ).run();
  // A rule file written before this table existed starts its span at the
  // file's own state.
  const statements = accessRuleStatements(db);
  for (const row of db
    .prepare(
      `SELECT f.workspace_id, f.version_id, f.path, f.state_relay_seq
     FROM sync_relay_current_file_keys k JOIN sync_relay_current_files f
       ON f.workspace_id = k.workspace_id AND f.version_id = k.version_id AND f.path = k.path
     WHERE k.collision_key = ? OR k.collision_key LIKE ?
     ORDER BY f.state_relay_seq`,
    )
    .iterate(ACCESS_RULE_FILE, `%/${ACCESS_RULE_FILE}`)) {
    refreshAccessRule(
      statements,
      String(row.workspace_id),
      String(row.version_id),
      accessRuleFolder(String(row.path)),
      Number(row.state_relay_seq),
    );
  }
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(
    ACCESS_RULES_MIGRATION_ID,
    Date.now(),
  );
}

export interface AccessRuleStatements {
  candidates: ReturnType<SqliteDb["prepare"]>;
  blob: ReturnType<SqliteDb["prepare"]>;
  open: ReturnType<SqliteDb["prepare"]>;
  close: ReturnType<SqliteDb["prepare"]>;
  drop: ReturnType<SqliteDb["prepare"]>;
  insert: ReturnType<SqliteDb["prepare"]>;
}

export function accessRuleStatements(db: SqliteDb): AccessRuleStatements {
  return {
    candidates: db.prepare(
      `SELECT f.path, f.blob_sha256, f.content_kind
       FROM sync_relay_current_file_keys k JOIN sync_relay_current_files f
         ON f.workspace_id = k.workspace_id AND f.version_id = k.version_id AND f.path = k.path
       WHERE k.workspace_id = ? AND k.version_id = ? AND k.collision_key = ?`,
    ),
    blob: db.prepare(
      "SELECT content FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ? AND byte_length <= ?",
    ),
    open: db.prepare(
      `SELECT rule_text, from_seq FROM sync_relay_access_rules
       WHERE workspace_id = ? AND version_id = ? AND folder = ? AND to_seq IS NULL`,
    ),
    close: db.prepare(
      `UPDATE sync_relay_access_rules SET to_seq = ?
       WHERE workspace_id = ? AND version_id = ? AND folder = ? AND from_seq = ?`,
    ),
    drop: db.prepare(
      `DELETE FROM sync_relay_access_rules
       WHERE workspace_id = ? AND version_id = ? AND folder = ? AND from_seq = ?`,
    ),
    insert: db.prepare(
      `INSERT INTO sync_relay_access_rules (workspace_id, version_id, folder, rule_text, from_seq, to_seq)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ),
  };
}

function ruleText(
  statements: AccessRuleStatements,
  workspaceId: string,
  file: Record<string, unknown>,
): string | null {
  if (file.content_kind !== "text") return null;
  const content = statements.blob.get(
    workspaceId,
    String(file.blob_sha256),
    ACCESS_RULE_MAX_BYTES,
  )?.content;
  if (!(content instanceof Uint8Array)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
  const rule = parseAccessRule(text);
  return rule === null ? null : formatAccessRule(rule);
}

/**
 * Brings a folder's open rule row up to date with its current files, after a
 * rule file in it was written or removed at `relaySeq`. Call it inside the
 * transaction that changed the current files.
 */
export function refreshAccessRule(
  statements: AccessRuleStatements,
  workspaceId: string,
  versionId: string,
  folder: string,
  relaySeq: number,
): void {
  const key = pathCollisionKey(folder === "" ? ACCESS_RULE_FILE : `${folder}/${ACCESS_RULE_FILE}`);
  // The key folds the folder too; only a file in exactly this folder is its rule.
  const files = statements.candidates
    .all(workspaceId, versionId, key)
    .filter((file) => accessRuleFolder(String(file.path)) === folder);
  const present = files.length > 0;
  const text = files.length === 1 ? ruleText(statements, workspaceId, files[0]!) : null;
  const open = statements.open.get(workspaceId, versionId, folder);
  if (!open && !present) return;
  if (open && present && (open.rule_text ?? null) === text) return;
  if (open) {
    const fromSeq = Number(open.from_seq);
    // A row opened earlier in this same op never held for any reader.
    if (fromSeq === relaySeq) statements.drop.run(workspaceId, versionId, folder, fromSeq);
    else statements.close.run(relaySeq, workspaceId, versionId, folder, fromSeq);
  }
  if (present) statements.insert.run(workspaceId, versionId, folder, text, relaySeq);
}

/**
 * The seq at or below which a workspace's past rules aren't known. Judging
 * History there, treat what a member could reach then as nothing.
 */
export function accessRuleHistoryFloor(db: SqliteDb, workspaceId: string): number {
  const row = db
    .prepare("SELECT relay_seq FROM sync_relay_access_rule_floors WHERE workspace_id = ?")
    .get(workspaceId);
  return row ? Number(row.relay_seq) : 0;
}

/** The rules that hold now in one Version. */
export function currentAccessRuleSet(
  db: SqliteDb,
  workspaceId: string,
  versionId: string,
): AccessRuleSet {
  const rows = db
    .prepare(
      `SELECT folder, rule_text FROM sync_relay_access_rules
     WHERE workspace_id = ? AND version_id = ? AND to_seq IS NULL`,
    )
    .all(workspaceId, versionId);
  return accessRuleSet(
    rows.map((row) => {
      const text = row.rule_text;
      return [String(row.folder), typeof text === "string" ? parseAccessRule(text) : null] as const;
    }),
  );
}
