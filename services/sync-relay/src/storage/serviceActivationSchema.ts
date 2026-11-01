import type { SqliteDb } from "./types";
import {initializeOrdinaryActivationBasis} from "./ordinaryActivationBasis";

export const SERVICE_ACTIVATIONS = "sync_relay_service_activations";
export const LIVE_DELIVERY_OWNER_HISTORY = "sync_relay_live_delivery_owner_history";
const V1_MIGRATION = "service-activation-v1";
const MIGRATION = "service-activation-v2";
const SAFE = 9_007_199_254_740_991;
const optionalInteger = (name: string) => `${name} INTEGER CHECK (${name} IS NULL OR ${name} BETWEEN 0 AND ${SAFE})`;
// A retirement obligation (`retire_*`) is recorded by Stop and stays as it was
// until the activation retires. Only a retired activation drops its state.
const sql = `CREATE TABLE ${SERVICE_ACTIVATIONS} (
  relay_database_namespace TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
  object_id TEXT NOT NULL,
  lineage_claim_id TEXT NOT NULL,
  predecessor_activation_id TEXT,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  state_digest TEXT NOT NULL CHECK (length(state_digest)=64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
  state_bytes BLOB CHECK (state_bytes IS NULL OR length(state_bytes) BETWEEN 2 AND 20971520),
  owner_user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  completion_json TEXT CHECK (completion_json IS NULL OR json_valid(completion_json)),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND ${SAFE}),
  ${optionalInteger("retire_requested_at_ms")},
  ${optionalInteger("retire_restore_generation")},
  ${optionalInteger("retire_accepted_cursor")},
  ${optionalInteger("retired_at_ms")},
  retired_boundary_json TEXT CHECK (retired_boundary_json IS NULL OR json_valid(retired_boundary_json)),
  CHECK ((retire_requested_at_ms IS NULL)=(retire_restore_generation IS NULL) AND (retire_requested_at_ms IS NULL)=(retire_accepted_cursor IS NULL)),
  CHECK ((retired_at_ms IS NULL)=(retired_boundary_json IS NULL) AND (retired_at_ms IS NULL)=(state_bytes IS NOT NULL)),
  CHECK (retired_at_ms IS NULL OR (retire_requested_at_ms IS NOT NULL AND retired_at_ms>=retire_requested_at_ms)),
  CHECK (predecessor_activation_id IS NULL OR predecessor_activation_id<>activation_id),
  PRIMARY KEY (relay_database_namespace,activation_id),
  FOREIGN KEY (relay_database_namespace,predecessor_activation_id) REFERENCES ${SERVICE_ACTIVATIONS}(relay_database_namespace,activation_id),
  FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id)
    REFERENCES sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE
) STRICT`;
const v1Sql = `CREATE TABLE ${SERVICE_ACTIVATIONS} (
  relay_database_namespace TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
  object_id TEXT NOT NULL,
  lineage_claim_id TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  state_digest TEXT NOT NULL CHECK (length(state_digest)=64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
  state_bytes BLOB NOT NULL CHECK (length(state_bytes) BETWEEN 2 AND 20971520),
  owner_user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  completion_json TEXT CHECK (completion_json IS NULL OR json_valid(completion_json)),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (relay_database_namespace,activation_id),
  UNIQUE (workspace_id,main_version_id,object_id,lineage_claim_id),
  FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id)
    REFERENCES sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE
) STRICT`;
// One activation of a lineage is not retired, and a predecessor has at most one successor.
const indexes = {
  idx_sync_relay_service_activations_lineage: `CREATE INDEX idx_sync_relay_service_activations_lineage
    ON ${SERVICE_ACTIVATIONS}(workspace_id,main_version_id,object_id,lineage_claim_id)`,
  idx_sync_relay_service_activations_current: `CREATE UNIQUE INDEX idx_sync_relay_service_activations_current
    ON ${SERVICE_ACTIVATIONS}(workspace_id,main_version_id,object_id,lineage_claim_id) WHERE retired_at_ms IS NULL`,
  idx_sync_relay_service_activations_successor: `CREATE UNIQUE INDEX idx_sync_relay_service_activations_successor
    ON ${SERVICE_ACTIVATIONS}(relay_database_namespace,predecessor_activation_id) WHERE predecessor_activation_id IS NOT NULL`,
};
// A retired activation's complete owner-delivery row, with its accounting charge.
const historySql = `CREATE TABLE ${LIVE_DELIVERY_OWNER_HISTORY} (
  relay_database_namespace TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
  object_id TEXT NOT NULL,
  lineage_claim_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  origin_json TEXT NOT NULL CHECK (json_valid(origin_json)),
  tip_receipt_json TEXT NOT NULL CHECK (json_valid(tip_receipt_json)),
  tip_cursor INTEGER NOT NULL CHECK (tip_cursor BETWEEN 0 AND ${SAFE}),
  tip_sequence INTEGER NOT NULL CHECK (tip_sequence BETWEEN 0 AND ${SAFE}),
  tip_application_sequence INTEGER NOT NULL CHECK (tip_application_sequence BETWEEN 0 AND ${SAFE}),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND ${SAFE}),
  CHECK (tip_application_sequence <= tip_sequence),
  PRIMARY KEY (relay_database_namespace,activation_id),
  FOREIGN KEY (relay_database_namespace,activation_id) REFERENCES ${SERVICE_ACTIVATIONS}(relay_database_namespace,activation_id) ON DELETE CASCADE
) STRICT`;
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
const exact = (db: SqliteDb, name: string, type: string, expected: string) => {
  const row = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(name);
  return !!row && row.type === type && typeof row.sql === "string" && normalized(row.sql) === normalized(expected);
};

export function initializeServiceActivationSchema(db: SqliteDb): void {
  initializeOrdinaryActivationBasis(db);
  const marked = (migration: string) => db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(migration) !== undefined;
  const present = (name: string) => db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name) !== undefined;
  const create = () => {
    db.exec(sql);
    for (const index of Object.values(indexes)) db.exec(index);
    db.exec(historySql);
  };
  const v2 = marked(MIGRATION);
  if (!v2 && marked(V1_MIGRATION)) {
    if (!exact(db, SERVICE_ACTIVATIONS, "table", v1Sql) || present(LIVE_DELIVERY_OWNER_HISTORY)) throw new Error("Service activation storage is damaged.");
    assertV1Constraints(db);
    // Every v1 activation is current: Stop recorded no obligation before v2.
    db.exec(`ALTER TABLE ${SERVICE_ACTIVATIONS} RENAME TO ${SERVICE_ACTIVATIONS}_v1`);
    create();
    db.exec(`INSERT INTO ${SERVICE_ACTIVATIONS}(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
        source_json,binding_json,state_digest,state_bytes,owner_user_id,share_id,completion_json,accounted_bytes)
      SELECT relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
        source_json,binding_json,state_digest,state_bytes,owner_user_id,share_id,completion_json,accounted_bytes FROM ${SERVICE_ACTIVATIONS}_v1;
      DROP TABLE ${SERVICE_ACTIVATIONS}_v1;`);
  } else if (!v2) {
    if (present(SERVICE_ACTIVATIONS) || present(LIVE_DELIVERY_OWNER_HISTORY)) throw new Error("Unmarked service activation storage exists.");
    create();
  }
  if (!exact(db, SERVICE_ACTIVATIONS, "table", sql) || !exact(db, LIVE_DELIVERY_OWNER_HISTORY, "table", historySql)) {
    throw new Error("Service activation storage is damaged.");
  }
  const activationIndexes = db.prepare(`PRAGMA index_list(${SERVICE_ACTIVATIONS})`).all();
  const historyIndexes = db.prepare(`PRAGMA index_list(${LIVE_DELIVERY_OWNER_HISTORY})`).all();
  if (activationIndexes.length !== 4 || activationIndexes.some(row => row.origin === "pk"
      ? row.unique !== 1 || row.partial !== 0
      : row.origin !== "c" || !Object.hasOwn(indexes, String(row.name)) || !exact(db, String(row.name), "index", indexes[row.name as keyof typeof indexes])) ||
      historyIndexes.length !== 1 || historyIndexes[0]!.origin !== "pk" || historyIndexes[0]!.partial !== 0 ||
      db.prepare(`PRAGMA foreign_key_check(${SERVICE_ACTIVATIONS})`).all().length ||
      db.prepare(`PRAGMA foreign_key_check(${LIVE_DELIVERY_OWNER_HISTORY})`).all().length ||
      db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name IN (?,?)").get(SERVICE_ACTIVATIONS, LIVE_DELIVERY_OWNER_HISTORY)) {
    throw new Error("Service activation constraints are damaged.");
  }
  if (!v2) db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(MIGRATION, Date.now());
}

function assertV1Constraints(db: SqliteDb): void {
  const indexes = db.prepare(`PRAGMA index_list(${SERVICE_ACTIVATIONS})`).all();
  if (indexes.length !== 2 || indexes.some(row => row.unique !== 1 || row.partial !== 0 || (row.origin !== "pk" && row.origin !== "u")) ||
      db.prepare(`PRAGMA foreign_key_check(${SERVICE_ACTIVATIONS})`).all().length ||
      db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(SERVICE_ACTIVATIONS)) {
    throw new Error("Service activation constraints are damaged.");
  }
}
