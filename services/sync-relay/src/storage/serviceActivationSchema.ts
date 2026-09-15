import type { SqliteDb } from "./types";
import {initializeOrdinaryActivationBasis} from "./ordinaryActivationBasis";

export const SERVICE_ACTIVATIONS = "sync_relay_service_activations";
const marker = "service-activation-v1";
const sql = `CREATE TABLE ${SERVICE_ACTIVATIONS} (
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

export function initializeServiceActivationSchema(db: SqliteDb): void {
  initializeOrdinaryActivationBasis(db);
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(marker);
  const row = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(SERVICE_ACTIVATIONS);
  if (!marked) {
    if (row) throw new Error("Unmarked service activation storage exists.");
    db.exec(sql);
  } else if (!row || row.type !== "table" || typeof row.sql !== "string" ||
    row.sql.replace(/\s+/g, " ").trim() !== sql.replace(/\s+/g, " ").trim()) {
    throw new Error("Service activation storage is damaged.");
  }
  const indexes = db.prepare(`PRAGMA index_list(${SERVICE_ACTIVATIONS})`).all();
  if (indexes.length !== 2 || indexes.some(row => row.unique !== 1 || row.partial !== 0 || (row.origin !== "pk" && row.origin !== "u")) ||
      db.prepare(`PRAGMA foreign_key_check(${SERVICE_ACTIVATIONS})`).all().length ||
      db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(SERVICE_ACTIVATIONS)) {
    throw new Error("Service activation constraints are damaged.");
  }
  if (!marked) db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(marker, Date.now());
}
