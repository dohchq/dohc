import type { SqliteDb } from "./types";

export const LIVE_RESTORE_OPERATIONS = "sync_relay_live_restore_operations";
export const LIVE_RESTORE_PROPOSALS = "sync_relay_live_restore_proposals";
export const LIVE_RESTORE_LIFECYCLES = "sync_relay_live_restore_lifecycles";
export const LIVE_RESTORE_SOURCE_RANGES = "sync_relay_live_restore_source_ranges";
const marker = "live-restore-operation-v1";
// Adds the declined phase. The phase is final, like resumed, so neither counts
// as the document's unfinished restore.
const declinedMarker = "live-restore-declined-v1";
// Adds a lifecycle's publication reservation and its refused publication.
const publicationMarker = "live-restore-publication-v1";
const safe = Number.MAX_SAFE_INTEGER;
/** Where a restore no longer blocks another restore of its document. */
export const UNFINISHED_RESTORE = "phase NOT IN ('resumed','declined')";
const operationColumns = `operation_id TEXT NOT NULL CHECK (length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 512),
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
    native_receipt_json TEXT CHECK (json_valid(native_receipt_json)),`;
const operationKeys = `PRIMARY KEY (relay_database_namespace,operation_id),
    UNIQUE (relay_database_namespace,workspace_id,main_version_id,object_id,new_fence),
    FOREIGN KEY (relay_database_namespace,previous_operation_id) REFERENCES ${LIVE_RESTORE_OPERATIONS}(relay_database_namespace,operation_id) ON DELETE NO ACTION,
    FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id)
      REFERENCES sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE
  ) STRICT`;
/** The operation table before the declined phase. A test builds a v1 store from it. */
export const LIVE_RESTORE_OPERATIONS_V1_SQL = `CREATE TABLE ${LIVE_RESTORE_OPERATIONS} (
    ${operationColumns}
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
    ${operationKeys}`;
// A restore declined before its fence keeps no fence columns. A later decline
// keeps the columns of the phase it ended in.
const operationsSql = `CREATE TABLE ${LIVE_RESTORE_OPERATIONS} (
    ${operationColumns}
    phase TEXT NOT NULL CHECK (phase IN ('authority-invalidated','fenced','old-cut-applied','native-fenced','relay-admitted','native-applied','settled','resumed','declined')),
    old_fence INTEGER NOT NULL CHECK (old_fence BETWEEN 1 AND ${safe - 1}),
    new_fence INTEGER CHECK (new_fence=old_fence+1),
    cutover_cursor INTEGER CHECK (cutover_cursor BETWEEN 0 AND ${safe}),
    revoked_generation INTEGER NOT NULL CHECK (revoked_generation BETWEEN 2 AND ${safe}),
    invalidated_at_ms INTEGER NOT NULL CHECK (invalidated_at_ms BETWEEN 0 AND ${safe}),
    fenced_at_ms INTEGER CHECK (fenced_at_ms BETWEEN invalidated_at_ms AND ${safe}),
    declined_at_ms INTEGER CHECK (declined_at_ms BETWEEN invalidated_at_ms AND ${safe}),
    accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND ${safe}),
    CHECK ((phase IN ('authority-invalidated','declined') AND new_fence IS NULL AND cutover_cursor IS NULL AND fenced_at_ms IS NULL AND terminal_json IS NULL AND applied_json IS NULL AND native_receipt_json IS NULL)
      OR (phase<>'authority-invalidated' AND new_fence IS NOT NULL AND cutover_cursor IS NOT NULL AND fenced_at_ms IS NOT NULL AND terminal_json IS NOT NULL)),
    CHECK (phase='declined' OR (phase NOT IN ('authority-invalidated','fenced')) = (applied_json IS NOT NULL)),
    CHECK (phase='declined' OR (phase NOT IN ('authority-invalidated','fenced','old-cut-applied')) = (native_receipt_json IS NOT NULL)),
    CHECK ((phase='declined') = (declined_at_ms IS NOT NULL)),
    ${operationKeys}`;
const lifecycleColumns = `relay_database_namespace TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    max_evidence_bytes INTEGER NOT NULL CHECK (max_evidence_bytes BETWEEN 1 AND ${safe}),
    admission_json TEXT NOT NULL CHECK (json_valid(admission_json)),
    admission_sha256 TEXT NOT NULL CHECK (length(admission_sha256)=64 AND admission_sha256 NOT GLOB '*[^0-9a-f]*'),
    application_json TEXT CHECK (json_valid(application_json)),
    pending_settlement_json TEXT CHECK (json_valid(pending_settlement_json)),
    settlement_json TEXT CHECK (json_valid(settlement_json)),
    resume_json TEXT CHECK (json_valid(resume_json)),
    receipt_reservation_bytes INTEGER NOT NULL CHECK (receipt_reservation_bytes BETWEEN 0 AND ${safe}),`;
const lifecycleKeys = `accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND ${safe}),
    PRIMARY KEY (relay_database_namespace,operation_id),
    FOREIGN KEY (relay_database_namespace,operation_id) REFERENCES ${LIVE_RESTORE_OPERATIONS}(relay_database_namespace,operation_id) ON DELETE CASCADE,
    CHECK ((pending_settlement_json IS NULL AND settlement_json IS NULL) OR application_json IS NOT NULL),
    CHECK (resume_json IS NULL OR settlement_json IS NOT NULL)
  ) STRICT`;
/** The lifecycle table before its publication columns. A test builds an earlier store from it. */
export const LIVE_RESTORE_LIFECYCLES_V1_SQL = `CREATE TABLE ${LIVE_RESTORE_LIFECYCLES} (
    ${lifecycleColumns}
    ${lifecycleKeys}`;
// The publication reservation funds the restore's settlement binding and log
// row until its publication lands. A refused publication needs repair.
const lifecyclesSql = `CREATE TABLE ${LIVE_RESTORE_LIFECYCLES} (
    ${lifecycleColumns}
    publication_reservation_bytes INTEGER NOT NULL DEFAULT 0 CHECK (publication_reservation_bytes BETWEEN 0 AND ${safe}),
    publication_refused INTEGER NOT NULL DEFAULT 0 CHECK (publication_refused IN (0,1)),
    ${lifecycleKeys}`;
const schema = {
  [LIVE_RESTORE_OPERATIONS]: operationsSql,
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
  [LIVE_RESTORE_LIFECYCLES]: lifecyclesSql,
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
  sync_relay_live_restore_active: `CREATE UNIQUE INDEX sync_relay_live_restore_active ON ${LIVE_RESTORE_OPERATIONS}(workspace_id,main_version_id,object_id) WHERE ${UNFINISHED_RESTORE}`,
  sync_relay_live_restore_source_clients: `CREATE INDEX sync_relay_live_restore_source_clients ON ${LIVE_RESTORE_SOURCE_RANGES}(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock)`,
};
/** The active-restore index before the declined phase. */
export const LIVE_RESTORE_ACTIVE_V1_SQL = `CREATE UNIQUE INDEX sync_relay_live_restore_active ON ${LIVE_RESTORE_OPERATIONS}(workspace_id,main_version_id,object_id) WHERE phase<>'resumed'`;

// Runs inside the relay's schema transaction, where foreign keys stay on.
// Dropping a parent table would cascade into its children, so `tables`, a
// parent before its children, move through temporary copies, and a column a
// table did not have takes its default. Journal rows that name an operation
// wait on deferred checks until the operation rows return.
function rebuild(db: SqliteDb, tables: readonly (keyof typeof schema)[], indexes: readonly (keyof typeof indexSchema)[]): void {
  const columns = tables.map(table => db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all().map(row => String(row.name)).join(","));
  db.exec("PRAGMA defer_foreign_keys=ON");
  for (const table of tables) db.exec(`CREATE TEMP TABLE ${table}_previous AS SELECT * FROM main.${table}`);
  for (const table of [...tables].reverse()) db.exec(`DROP TABLE main.${table}`);
  for (const table of tables) db.exec(schema[table]);
  for (const [index, table] of tables.entries()) db.exec(`INSERT INTO main.${table}(${columns[index]}) SELECT ${columns[index]} FROM temp.${table}_previous`);
  for (const table of tables) db.exec(`DROP TABLE temp.${table}_previous`);
  for (const index of indexes) db.exec(indexSchema[index]);
}

export function initializeLiveRestoreOperationSchema(db: SqliteDb): void {
  const isMarked = (migration: string) => db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(migration) !== undefined;
  const marked = isMarked(marker), declined = isMarked(declinedMarker), published = isMarked(publicationMarker);
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const expected = (name: string, sql: string) => {
    if (!marked) return sql;
    if (!declined && name === LIVE_RESTORE_OPERATIONS) return LIVE_RESTORE_OPERATIONS_V1_SQL;
    if (!declined && name === "sync_relay_live_restore_active") return LIVE_RESTORE_ACTIVE_V1_SQL;
    return !published && name === LIVE_RESTORE_LIFECYCLES ? LIVE_RESTORE_LIFECYCLES_V1_SQL : sql;
  };
  for (const [name, sql] of Object.entries(schema)) {
    const row = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(name);
    if (!marked) {
      if (row) throw new Error("Unmarked live restore schema already exists.");
      db.exec(sql);
    } else if (!row || row.type !== "table" || typeof row.sql !== "string" || normalize(row.sql) !== normalize(expected(name, sql))) {
      throw new Error("Live restore schema is missing or damaged.");
    }
  }
  for (const [name,sql] of Object.entries(indexSchema)) {
    const row=db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(name);
    if (!marked) {
      if (row) throw new Error("Unmarked live restore index already exists.");
      db.exec(sql);
    } else if (!row || row.type!=="index" || typeof row.sql!=="string" || normalize(row.sql)!==normalize(expected(name, sql))) {
      throw new Error("Live restore index is missing or damaged.");
    }
  }
  const tables = [LIVE_RESTORE_OPERATIONS, LIVE_RESTORE_PROPOSALS, LIVE_RESTORE_LIFECYCLES, LIVE_RESTORE_SOURCE_RANGES] as const;
  if (marked && !declined) rebuild(db, tables, ["sync_relay_live_restore_active", "sync_relay_live_restore_source_clients"]);
  else if (marked && !published) rebuild(db, tables.slice(2), ["sync_relay_live_restore_source_clients"]);
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
  for (const migration of [...(marked ? [] : [marker]), ...(declined ? [] : [declinedMarker]), ...(published ? [] : [publicationMarker])]) {
    db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(migration, Date.now());
  }
}
