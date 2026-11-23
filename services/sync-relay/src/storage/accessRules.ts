import {
  FOLDER_MARKER_FILE,
  FOLDER_MARKER_MAX_BYTES,
  accessRuleFolder,
  accessRuleSet,
  parseFolderMarker,
  parseFormattedAccessRule,
  type AccessRule,
  type AccessRuleSet,
} from "@dohc/security-contract/access-rules";
import { pathCollisionKey } from "../pathCollisionKey";
import type { SqliteDb } from "./types";

// Folder rules (ADR 0017). The relay keeps each rule in `sync_relay_folder_rules`;
// `rule_text` is its canonical text, or NULL once it is cleared. A cleared row
// stays, so a marker that still names it means "no rule" rather than
// "unknown". `sync_relay_folder_rule_bindings` holds the folders each rule
// covers.
//
// `sync_relay_access_rules` is what members are judged by: each folder's rule
// in main, by the log span it held for. `rule_text` is NULL when the folder is
// hidden because its marker can't be matched or two rules cover it.
export function initializeAccessRuleSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_access_rules (
      workspace_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      rule_text TEXT,
      from_seq INTEGER NOT NULL,
      to_seq INTEGER,
      PRIMARY KEY (workspace_id, folder, from_seq),
      FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_access_rules_open
      ON sync_relay_access_rules(workspace_id, folder) WHERE to_seq IS NULL;
    CREATE TABLE IF NOT EXISTS sync_relay_folder_rules (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      rule_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      rule_text TEXT,
      changed_by_user_id TEXT,
      changed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, rule_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_relay_folder_rule_bindings (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      rule_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      PRIMARY KEY (workspace_id, rule_id, folder)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_folder_rule_bindings_folder
      ON sync_relay_folder_rule_bindings(workspace_id, folder);
    -- Rule rows and spans outlive the change that made them, so the workspace pays for them.
    CREATE TRIGGER IF NOT EXISTS sync_relay_access_rules_usage_insert
      AFTER INSERT ON sync_relay_access_rules BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes
        + length(CAST(NEW.folder AS BLOB)) + COALESCE(length(CAST(NEW.rule_text AS BLOB)), 0)
      WHERE workspace_id = NEW.workspace_id; END;
    CREATE TRIGGER IF NOT EXISTS sync_relay_access_rules_usage_delete
      AFTER DELETE ON sync_relay_access_rules BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes
        - length(CAST(OLD.folder AS BLOB)) - COALESCE(length(CAST(OLD.rule_text AS BLOB)), 0)
      WHERE workspace_id = OLD.workspace_id; END;
    CREATE TRIGGER IF NOT EXISTS sync_relay_folder_rules_usage_insert
      AFTER INSERT ON sync_relay_folder_rules BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes
        + COALESCE(length(CAST(NEW.rule_text AS BLOB)), 0)
      WHERE workspace_id = NEW.workspace_id; END;
    CREATE TRIGGER IF NOT EXISTS sync_relay_folder_rules_usage_update
      AFTER UPDATE OF rule_text ON sync_relay_folder_rules BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes
        + COALESCE(length(CAST(NEW.rule_text AS BLOB)), 0) - COALESCE(length(CAST(OLD.rule_text AS BLOB)), 0)
      WHERE workspace_id = NEW.workspace_id; END;
    CREATE TRIGGER IF NOT EXISTS sync_relay_folder_rules_usage_delete
      AFTER DELETE ON sync_relay_folder_rules BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes
        - COALESCE(length(CAST(OLD.rule_text AS BLOB)), 0)
      WHERE workspace_id = OLD.workspace_id; END;
    CREATE TRIGGER IF NOT EXISTS sync_relay_folder_rule_bindings_usage_insert
      AFTER INSERT ON sync_relay_folder_rule_bindings BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes + length(CAST(NEW.folder AS BLOB))
      WHERE workspace_id = NEW.workspace_id; END;
    CREATE TRIGGER IF NOT EXISTS sync_relay_folder_rule_bindings_usage_delete
      AFTER DELETE ON sync_relay_folder_rule_bindings BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes - length(CAST(OLD.folder AS BLOB))
      WHERE workspace_id = OLD.workspace_id; END;
  `);
}

export interface AccessRuleStatements {
  markers: ReturnType<SqliteDb["prepare"]>;
  blob: ReturnType<SqliteDb["prepare"]>;
  rule: ReturnType<SqliteDb["prepare"]>;
  bind: ReturnType<SqliteDb["prepare"]>;
  unbind: ReturnType<SqliteDb["prepare"]>;
  bound: ReturnType<SqliteDb["prepare"]>;
  ruleFolders: ReturnType<SqliteDb["prepare"]>;
  boundAbove: ReturnType<SqliteDb["prepare"]>;
  fileUnder: ReturnType<SqliteDb["prepare"]>;
  open: ReturnType<SqliteDb["prepare"]>;
  close: ReturnType<SqliteDb["prepare"]>;
  drop: ReturnType<SqliteDb["prepare"]>;
  insert: ReturnType<SqliteDb["prepare"]>;
}

export function accessRuleStatements(db: SqliteDb): AccessRuleStatements {
  return {
    markers: db.prepare(
      `SELECT f.path, f.blob_sha256, f.content_kind
       FROM sync_relay_current_file_keys k JOIN sync_relay_current_files f
         ON f.workspace_id = k.workspace_id AND f.version_id = k.version_id AND f.path = k.path
       WHERE k.workspace_id = ? AND k.version_id = 'main' AND k.collision_key = ?`,
    ),
    blob: db.prepare(
      "SELECT content FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ? AND byte_length <= ?",
    ),
    rule: db.prepare(
      "SELECT rule_text FROM sync_relay_folder_rules WHERE workspace_id = ? AND rule_id = ?",
    ),
    bind: db.prepare(
      `INSERT INTO sync_relay_folder_rule_bindings (workspace_id, rule_id, folder) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ),
    unbind: db.prepare(
      "DELETE FROM sync_relay_folder_rule_bindings WHERE workspace_id = ? AND rule_id = ? AND folder = ?",
    ),
    bound: db.prepare(
      `SELECT b.rule_id, r.rule_text FROM sync_relay_folder_rule_bindings b
       JOIN sync_relay_folder_rules r ON r.workspace_id = b.workspace_id AND r.rule_id = b.rule_id
       WHERE b.workspace_id = ? AND b.folder = ?`,
    ),
    ruleFolders: db.prepare(
      "SELECT folder FROM sync_relay_folder_rule_bindings WHERE workspace_id = ? AND rule_id = ?",
    ),
    boundAbove: db.prepare(
      `SELECT DISTINCT folder FROM sync_relay_folder_rule_bindings
       WHERE workspace_id = ? AND folder <> '' AND ? >= folder || '/' AND ? < folder || '0'`,
    ),
    // "0" sorts just after "/", so this range is every path under the folder.
    fileUnder: db.prepare(
      `SELECT 1 FROM sync_relay_current_files
       WHERE workspace_id = ? AND version_id = 'main' AND path >= ? AND path < ? LIMIT 1`,
    ),
    open: db.prepare(
      `SELECT rule_text, from_seq FROM sync_relay_access_rules
       WHERE workspace_id = ? AND folder = ? AND to_seq IS NULL`,
    ),
    close: db.prepare(
      `UPDATE sync_relay_access_rules SET to_seq = ?
       WHERE workspace_id = ? AND folder = ? AND from_seq = ?`,
    ),
    drop: db.prepare(
      `DELETE FROM sync_relay_access_rules
       WHERE workspace_id = ? AND folder = ? AND from_seq = ?`,
    ),
    insert: db.prepare(
      `INSERT INTO sync_relay_access_rules (workspace_id, folder, rule_text, from_seq, to_seq)
       VALUES (?, ?, ?, ?, NULL)`,
    ),
  };
}

/** The markers in exactly this folder of main, every spelling of the name. */
export function markersIn(statements: AccessRuleStatements, workspaceId: string, folder: string) {
  const key = pathCollisionKey(
    folder === "" ? FOLDER_MARKER_FILE : `${folder}/${FOLDER_MARKER_FILE}`,
  );
  // The key folds the folder too; only a marker in exactly this folder counts.
  return statements.markers
    .all(workspaceId, key)
    .filter((file) => accessRuleFolder(String(file.path)) === folder);
}

/** The rule a marker file names, or null when it can't be read. */
function markerRuleId(
  statements: AccessRuleStatements,
  workspaceId: string,
  file: Record<string, unknown>,
): string | null {
  if (file.content_kind !== "text") return null;
  const content = statements.blob.get(
    workspaceId,
    String(file.blob_sha256),
    FOLDER_MARKER_MAX_BYTES,
  )?.content;
  if (!(content instanceof Uint8Array)) return null;
  try {
    return parseFolderMarker(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    return null;
  }
}

/** The rule this folder's one readable marker names, or null. */
export function folderMarkerRule(
  statements: AccessRuleStatements,
  workspaceId: string,
  folder: string,
): string | null {
  const markers = markersIn(statements, workspaceId, folder);
  return markers.length === 1 ? markerRuleId(statements, workspaceId, markers[0]!) : null;
}

/** Whether main has any file under the folder. */
export function folderHasFiles(
  statements: AccessRuleStatements,
  workspaceId: string,
  folder: string,
): boolean {
  return folder === ""
    ? true
    : statements.fileUnder.get(workspaceId, `${folder}/`, `${folder}0`) !== undefined;
}

/**
 * Brings a folder's open span up to date at `relaySeq`, after a marker in it
 * was written or removed, its last file left, or a rule binding it changed.
 * Call it inside the transaction that made the change.
 *
 * A marker naming an active rule binds its folder to that rule. A marker that
 * names no known rule, can't be read, or has a twin hides the folder, and so
 * do two rules. A removed marker releases its folder once no file is left
 * under it and another folder still holds the rule's marker: an outside move
 * writes the new marker first and deletes the old one last.
 */
export function refreshFolderAccess(
  statements: AccessRuleStatements,
  workspaceId: string,
  folder: string,
  relaySeq: number,
): void {
  const markers = markersIn(statements, workspaceId, folder);
  let unmatched = markers.length > 1;
  if (markers.length === 1) {
    const ruleId = markerRuleId(statements, workspaceId, markers[0]!);
    const rule = ruleId === null ? undefined : statements.rule.get(workspaceId, ruleId);
    if (!rule) unmatched = true;
    else if (rule.rule_text !== null) statements.bind.run(workspaceId, ruleId, folder);
  }
  const bound = statements.bound.all(workspaceId, folder);
  if (markers.length === 0 && !folderHasFiles(statements, workspaceId, folder)) {
    for (const { rule_id: ruleId } of bound) {
      const elsewhere = statements.ruleFolders
        .all(workspaceId, ruleId)
        .some(
          (row) =>
            row.folder !== folder &&
            folderMarkerRule(statements, workspaceId, String(row.folder)) === ruleId,
        );
      if (elsewhere) statements.unbind.run(workspaceId, ruleId, folder);
    }
  }
  const texts = statements.bound
    .all(workspaceId, folder)
    .flatMap((row) => (typeof row.rule_text === "string" ? [row.rule_text] : []));
  const wanted = unmatched || texts.length > 1 ? null : texts.length === 1 ? texts[0]! : undefined;
  const open = statements.open.get(workspaceId, folder);
  if (!open && wanted === undefined) return;
  if (open && (open.rule_text ?? null) === wanted) return;
  if (open) {
    const fromSeq = Number(open.from_seq);
    // A span opened earlier at this same position never held for any reader.
    if (fromSeq === relaySeq) statements.drop.run(workspaceId, folder, fromSeq);
    else statements.close.run(relaySeq, workspaceId, folder, fromSeq);
  }
  if (wanted !== undefined) statements.insert.run(workspaceId, folder, wanted, relaySeq);
}

/** The rules that hold now in main. */
export function currentAccessRuleSet(db: SqliteDb, workspaceId: string): AccessRuleSet {
  const rows = db
    .prepare(
      `SELECT folder, rule_text FROM sync_relay_access_rules
     WHERE workspace_id = ? AND to_seq IS NULL`,
    )
    .all(workspaceId);
  return accessRuleSet(
    rows.map((row) => {
      const text = row.rule_text;
      return [
        String(row.folder),
        typeof text === "string" ? parseFormattedAccessRule(text) : null,
      ] as const;
    }),
  );
}

/**
 * Rules immediately before the deleting operation, including a rule it removes.
 * `parsed` lets one read share parses across many deletions.
 */
export function accessRuleSetBefore(
  db: SqliteDb,
  workspaceId: string,
  seq: number,
  parsed = new Map<string, AccessRule | null>(),
): AccessRuleSet {
  const rows = db
    .prepare(`SELECT folder, rule_text FROM sync_relay_access_rules
    WHERE workspace_id = ? AND from_seq < ? AND (to_seq IS NULL OR to_seq >= ?)`)
    .all(workspaceId, seq, seq);
  const parse = (text: string) => {
    if (!parsed.has(text)) parsed.set(text, parseFormattedAccessRule(text));
    return parsed.get(text)!;
  };
  return accessRuleSet(
    rows.map(
      (row) =>
        [
          String(row.folder),
          typeof row.rule_text === "string" ? parse(row.rule_text) : null,
        ] as const,
    ),
  );
}
