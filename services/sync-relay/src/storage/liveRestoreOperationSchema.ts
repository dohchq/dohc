import type { SqliteDb } from "./types";

export const LIVE_RESTORE_OPERATIONS = "sync_relay_live_restore_operations";
export const LIVE_RESTORE_PROPOSALS = "sync_relay_live_restore_proposals";
export const LIVE_RESTORE_LIFECYCLES = "sync_relay_live_restore_lifecycles";
export const LIVE_RESTORE_SOURCE_RANGES = "sync_relay_live_restore_source_ranges";
const marker = "live-restore-operation-v1";
const safe = Number.MAX_SAFE_INTEGER;
const schema = {
  [LIVE_RESTORE_OPERATIONS]: `CREATE TABLE ${LIVE_RESTORE_OPERATIONS} (
    operation_id TEXT NOT NULL CHECK (length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 512),
    relay_database_namespace TEXT NOT NULL CHECK (length(CAST(relay_database_namespace AS BLOB)) BETWEEN 1 AND 512),
    previous_operation_id TEXT,
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
    basis_json TEXT NOT NULL CHECK (json_valid(basis_json)),
    terminal_json TEXT CHECK (json_valid(terminal_json)),
    applied_json TEXT CHECK (json_valid(applied_json)),
    native_receipt_json TEXT CHECK (json_valid(native_receipt_json)),
    phase TEXT NOT NULL CHECK (phase IN ('authority-invalidated','fenced','old-cut-applied','native-fenced','relay-admitted','native-applied','settled','resumed')),
    old_fence INTEGER NOT NULL CHECK (old_fence BETWEEN 1 AND ${safe - 1}),
    new_fence INTEGER CHECK (new_fence=old_fence+1),
    cutover_cursor INTEGER CHECK (cutover_cursor BETWEEN 0 AND ${safe}),
    revoked_generation INTEGER NOT NULL CHECK (revoked_generation BETWEEN 2 AND ${safe}),
    invalidated_at_ms INTEGER NOT NULL CHECK (invalidated_at_ms BETWEEN 0 AND ${safe}),
    fenced_at_ms INTEGER CHECK (fenced_at_ms BETWEEN invalidated_at_ms AND ${safe}),
    accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND ${safe}),
    CHECK ((phase='authority-invalidated' AND new_fence IS NULL AND cutover_cursor IS NULL AND fenced_at_ms IS NULL AND terminal_json IS NULL AND applied_json IS NULL)
      OR (phase<>'authority-invalidated' AND new_fence IS NOT NULL AND cutover_cursor IS NOT NULL AND fenced_at_ms IS NOT NULL AND terminal_json IS NOT NULL)),
    CHECK ((phase NOT IN ('authority-invalidated','fenced')) = (applied_json IS NOT NULL)),
    CHECK ((phase NOT IN ('authority-invalidated','fenced','old-cut-applied')) = (native_receipt_json IS NOT NULL)),
    PRIMARY KEY (relay_database_namespace,operation_id),
    UNIQUE (relay_database_namespace,workspace_id,main_version_id,object_id,new_fence),
    FOREIGN KEY (relay_database_namespace,previous_operation_id) REFERENCES ${LIVE_RESTORE_OPERATIONS}(relay_database_namespace,operation_id) ON DELETE NO ACTION,
    FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id)
      REFERENCES sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE
  ) STRICT`,
  [LIVE_RESTORE_PROPOSALS]: `CREATE TABLE ${LIVE_RESTORE_PROPOSALS} (
    operation_id TEXT NOT NULL,
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    proposal_bytes BLOB NOT NULL CHECK (length(proposal_bytes)>0),
    proposal_sha256 TEXT NOT NULL CHECK (length(proposal_sha256)=64 AND proposal_sha256 NOT GLOB '*[^0-9a-f]*'),
    candidate_sha256 TEXT NOT NULL CHECK (length(candidate_sha256)=64 AND candidate_sha256 NOT GLOB '*[^0-9a-f]*'),
    record_sha256 TEXT NOT NULL CHECK (length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms BETWEEN 0 AND ${safe}),
    accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND ${safe}),
    PRIMARY KEY (relay_database_namespace,operation_id),
    FOREIGN KEY (relay_database_namespace,operation_id) REFERENCES ${LIVE_RESTORE_OPERATIONS}(relay_database_namespace,operation_id) ON DELETE CASCADE
  ) STRICT`,
  [LIVE_RESTORE_LIFECYCLES]: `CREATE TABLE ${LIVE_RESTORE_LIFECYCLES} (
    relay_database_namespace TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    max_evidence_bytes INTEGER NOT NULL CHECK (max_evidence_bytes BETWEEN 1 AND ${safe}),
    admission_json TEXT NOT NULL CHECK (json_valid(admission_json)),
    admission_sha256 TEXT NOT NULL CHECK (length(admission_sha256)=64 AND admission_sha256 NOT GLOB '*[^0-9a-f]*'),
    application_json TEXT CHECK (json_valid(application_json)),
    pending_settlement_json TEXT CHECK (json_valid(pending_settlement_json)),
    settlement_json TEXT CHECK (json_valid(settlement_json)),
    resume_json TEXT CHECK (json_valid(resume_json)),
    receipt_reservation_bytes INTEGER NOT NULL CHECK (receipt_reservation_bytes BETWEEN 0 AND ${safe}),
    accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND ${safe}),
    PRIMARY KEY (relay_database_namespace,operation_id),
    FOREIGN KEY (relay_database_namespace,operation_id) REFERENCES ${LIVE_RESTORE_OPERATIONS}(relay_database_namespace,operation_id) ON DELETE CASCADE,
    CHECK ((pending_settlement_json IS NULL AND settlement_json IS NULL) OR application_json IS NOT NULL),
    CHECK (resume_json IS NULL OR settlement_json IS NOT NULL)
  ) STRICT`,
  [LIVE_RESTORE_SOURCE_RANGES]: `CREATE TABLE ${LIVE_RESTORE_SOURCE_RANGES} (
    relay_database_namespace TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    source_ordinal INTEGER NOT NULL CHECK (source_ordinal BETWEEN 0 AND ${safe}),
    client_id INTEGER NOT NULL CHECK (client_id BETWEEN 0 AND ${safe}),
    start_clock INTEGER NOT NULL CHECK (start_clock BETWEEN 0 AND ${safe}),
    end_clock INTEGER NOT NULL CHECK (end_clock BETWEEN start_clock+1 AND ${safe}),
    proposal_sha256 TEXT NOT NULL CHECK (length(proposal_sha256)=64 AND proposal_sha256 NOT GLOB '*[^0-9a-f]*'),
    source_sha256 TEXT NOT NULL CHECK (length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
    accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND ${safe}),
    PRIMARY KEY (relay_database_namespace,operation_id,source_ordinal,client_id,start_clock),
    FOREIGN KEY (relay_database_namespace,operation_id) REFERENCES ${LIVE_RESTORE_LIFECYCLES}(relay_database_namespace,operation_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id) REFERENCES sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE
  ) STRICT`,
};

const indexSchema = {
  sync_relay_live_restore_active: `CREATE UNIQUE INDEX sync_relay_live_restore_active ON ${LIVE_RESTORE_OPERATIONS}(workspace_id,main_version_id,object_id) WHERE phase<>'resumed'`,
  sync_relay_live_restore_source_clients: `CREATE INDEX sync_relay_live_restore_source_clients ON ${LIVE_RESTORE_SOURCE_RANGES}(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock)`,
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
  for (const [name,sql] of Object.entries(indexSchema)) {
    const row=db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(name);
    if (!marked) {
      if (row) throw new Error("Unmarked live restore index already exists.");
      db.exec(sql);
    } else if (!row || row.type!=="index" || typeof row.sql!=="string" || normalize(row.sql)!==normalize(sql)) {
      throw new Error("Live restore index is missing or damaged.");
    }
  }
  const indexes = db.prepare(`PRAGMA index_list(${LIVE_RESTORE_OPERATIONS})`).all();
  if (indexes.length !== 3 || indexes.some(row => row.unique !== 1 || (row.name==="sync_relay_live_restore_active" ? row.partial!==1 || row.origin!=="c" : row.partial!==0 || (row.origin!=="pk" && row.origin!=="u")))) {
    throw new Error("Live restore index is damaged.");
  }
  for (const table of [LIVE_RESTORE_LIFECYCLES,LIVE_RESTORE_SOURCE_RANGES]) {
    const indexes=db.prepare(`PRAGMA index_list(${table})`).all();
    const expected=table===LIVE_RESTORE_SOURCE_RANGES?2:1;
    if (indexes.length!==expected || db.prepare(`PRAGMA foreign_key_check(${table})`).all().length) throw new Error("Live restore lifecycle storage is damaged.");
  }
  if (db.prepare(`PRAGMA foreign_key_check(${LIVE_RESTORE_OPERATIONS})`).all().length) {
    throw new Error("Live restore parent is damaged.");
  }
  const proposalIndexes = db.prepare(`PRAGMA index_list(${LIVE_RESTORE_PROPOSALS})`).all();
  if (proposalIndexes.length !== 1 || proposalIndexes[0]!.unique !== 1 || proposalIndexes[0]!.origin !== "pk" ||
    proposalIndexes[0]!.partial !== 0 || db.prepare(`PRAGMA foreign_key_check(${LIVE_RESTORE_PROPOSALS})`).all().length) {
    throw new Error("Live restore proposal storage is damaged.");
  }
  if (!marked) db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(marker, Date.now());
}
