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

/**
 * A successor activation that re-adopts a document at its predecessor's owner
 * tip after the host store lost the predecessor's source. A staged row holds
 * the successor until its adoption ACK installs it; installed rows stay for audit.
 */
export const SERVICE_ACTIVATION_HANDOFFS = "sync_relay_service_activation_handoffs";
const handoffMarker = "service-activation-handoff-v1";
const handoffSql = `CREATE TABLE ${SERVICE_ACTIVATION_HANDOFFS} (
  relay_database_namespace TEXT NOT NULL,
  successor_activation_id TEXT NOT NULL,
  predecessor_activation_id TEXT NOT NULL CHECK (predecessor_activation_id<>successor_activation_id),
  workspace_id TEXT NOT NULL,
  main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
  object_id TEXT NOT NULL,
  lineage_claim_id TEXT NOT NULL,
  predecessor_origin_digest TEXT CHECK (predecessor_origin_digest IS NULL OR (length(predecessor_origin_digest)=64 AND predecessor_origin_digest NOT GLOB '*[^0-9a-f]*')),
  successor_source_json TEXT NOT NULL CHECK (json_valid(successor_source_json)),
  successor_state_digest TEXT NOT NULL CHECK (length(successor_state_digest)=64 AND successor_state_digest NOT GLOB '*[^0-9a-f]*'),
  successor_state_bytes BLOB CHECK (successor_state_bytes IS NULL OR length(successor_state_bytes) BETWEEN 2 AND 20971520),
  cut_cursor INTEGER NOT NULL CHECK (cut_cursor BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('staged','installed') AND (state='staged' OR successor_state_bytes IS NULL)),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (relay_database_namespace,successor_activation_id),
  FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id)
    REFERENCES sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE
) STRICT`;
const handoffIndex = `CREATE INDEX idx_${SERVICE_ACTIVATION_HANDOFFS}_document ON ${SERVICE_ACTIVATION_HANDOFFS}(workspace_id,main_version_id,object_id,lineage_claim_id,state)`;

const same = (actual: unknown, expected: string) => typeof actual === "string" && actual.replace(/\s+/g, " ").trim() === expected.replace(/\s+/g, " ").trim();
function initializeTable(db: SqliteDb, input: {marker: string; table: string; sql: string; index?: string; uniqueIndexes: number; label: string}): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(input.marker);
  const row = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(input.table);
  if (!marked) {
    if (row) throw new Error(`Unmarked ${input.label.toLowerCase()} storage exists.`);
    db.exec(input.sql);
    if (input.index) db.exec(input.index);
  } else if (!row || row.type !== "table" || !same(row.sql, input.sql)) {
    throw new Error(`${input.label} storage is damaged.`);
  }
  const indexes = db.prepare(`PRAGMA index_list(${input.table})`).all();
  const unique = indexes.filter(row => row.unique === 1), plain = indexes.filter(row => row.unique !== 1);
  const index = input.index && db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(`idx_${input.table}_document`);
  if (unique.length !== input.uniqueIndexes || unique.some(row => row.partial !== 0 || (row.origin !== "pk" && row.origin !== "u")) ||
      plain.length !== (input.index ? 1 : 0) || (input.index && (!index || !same(index.sql, input.index))) ||
      db.prepare(`PRAGMA foreign_key_check(${input.table})`).all().length ||
      db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(input.table)) {
    throw new Error(`${input.label} constraints are damaged.`);
  }
  if (!marked) db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(input.marker, Date.now());
}

export function initializeServiceActivationSchema(db: SqliteDb): void {
  initializeOrdinaryActivationBasis(db);
  initializeTable(db, {marker, table: SERVICE_ACTIVATIONS, sql, uniqueIndexes: 2, label: "Service activation"});
  initializeTable(db, {marker: handoffMarker, table: SERVICE_ACTIVATION_HANDOFFS, sql: handoffSql, index: handoffIndex, uniqueIndexes: 1, label: "Service activation handoff"});
}
