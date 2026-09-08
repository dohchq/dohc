import type { SqliteDb } from "./types";

export const LIVE_RESTORE_OPERATIONS = "sync_relay_live_restore_operations";
const marker = "live-restore-operation-v1";
const safe = Number.MAX_SAFE_INTEGER;
const schema = {
  [LIVE_RESTORE_OPERATIONS]: `CREATE TABLE ${LIVE_RESTORE_OPERATIONS} (
    operation_id TEXT PRIMARY KEY CHECK (length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 512),
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
    phase TEXT NOT NULL CHECK (phase IN ('authority-invalidated','fenced')),
    old_fence INTEGER NOT NULL CHECK (old_fence BETWEEN 1 AND ${safe - 1}),
    new_fence INTEGER CHECK (new_fence=old_fence+1),
    cutover_cursor INTEGER CHECK (cutover_cursor BETWEEN 0 AND ${safe}),
    revoked_generation INTEGER NOT NULL CHECK (revoked_generation BETWEEN 2 AND ${safe}),
    invalidated_at_ms INTEGER NOT NULL CHECK (invalidated_at_ms BETWEEN 0 AND ${safe}),
    fenced_at_ms INTEGER CHECK (fenced_at_ms BETWEEN invalidated_at_ms AND ${safe}),
    accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND ${safe}),
    CHECK ((phase='authority-invalidated' AND new_fence IS NULL AND cutover_cursor IS NULL AND fenced_at_ms IS NULL)
      OR (phase='fenced' AND new_fence IS NOT NULL AND cutover_cursor IS NOT NULL AND fenced_at_ms IS NOT NULL)),
    UNIQUE (workspace_id,main_version_id,object_id),
    FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id)
      REFERENCES sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE
  ) STRICT`,
};

export function initializeLiveRestoreOperationSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(marker);
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  for (const [name, sql] of Object.entries(schema)) {
    const row = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(name);
    if (!marked) {
      if (row) throw new Error("Unmarked live restore schema already exists.");
      db.exec(sql);
    } else if (!row || row.type !== "table" || typeof row.sql !== "string" || normalize(row.sql) !== normalize(sql)) {
      throw new Error("Live restore schema is missing or damaged.");
    }
  }
  if (!marked) db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(marker, Date.now());
}
