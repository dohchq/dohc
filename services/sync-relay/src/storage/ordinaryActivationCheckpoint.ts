import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";

/**
 * Folded ordinary history that earlier relays stored for a lineage. Nothing reads or writes these rows. Each keeps its
 * charge until its object is deleted or its epoch is superseded.
 */
export const ORDINARY_CHECKPOINTS = "sync_relay_ordinary_checkpoints";
const marker = "ordinary-checkpoint-v1";
const SAFE = 9007199254740991;
const sha = "CHECK (length(%)=64 AND % NOT GLOB '*[^0-9a-f]*')";
const hex = (column: string) => sha.replaceAll("%", column);
const schema = `CREATE TABLE ${ORDINARY_CHECKPOINTS} (
  workspace_id TEXT NOT NULL,
  main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
  object_id TEXT NOT NULL,
  lineage_claim_id TEXT NOT NULL,
  relay_database_namespace TEXT NOT NULL,
  replication_epoch TEXT NOT NULL,
  stream_identity TEXT NOT NULL,
  base_relay_seq INTEGER NOT NULL CHECK (base_relay_seq BETWEEN 1 AND ${SAFE}),
  base_origin_id TEXT NOT NULL,
  base_origin_seq INTEGER NOT NULL CHECK (base_origin_seq BETWEEN 0 AND ${SAFE}),
  through_relay_seq INTEGER NOT NULL CHECK (through_relay_seq BETWEEN base_relay_seq AND ${SAFE}),
  folded_entries INTEGER NOT NULL CHECK (folded_entries BETWEEN 1 AND ${SAFE}),
  state_bytes BLOB NOT NULL,
  state_sha256 TEXT NOT NULL ${hex("state_sha256")},
  current_path TEXT NOT NULL,
  projected_sha256 TEXT NOT NULL ${hex("projected_sha256")},
  projected_byte_length INTEGER NOT NULL CHECK (projected_byte_length BETWEEN 0 AND ${SAFE}),
  tail_json TEXT NOT NULL CHECK (json_valid(tail_json) AND json_type(tail_json)='array'),
  moments_json TEXT NOT NULL CHECK (json_valid(moments_json) AND json_type(moments_json)='array'),
  moments_from_seq INTEGER NOT NULL CHECK (moments_from_seq BETWEEN base_relay_seq AND through_relay_seq+1),
  latest_rename_seq INTEGER CHECK (latest_rename_seq BETWEEN base_relay_seq+1 AND through_relay_seq),
  latest_write_seq INTEGER CHECK (latest_write_seq BETWEEN base_relay_seq+1 AND through_relay_seq),
  latest_write_sha256 TEXT ${hex("latest_write_sha256")},
  latest_write_byte_length INTEGER CHECK (latest_write_byte_length BETWEEN 0 AND 2097152),
  policy_sha256 TEXT NOT NULL ${hex("policy_sha256")},
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND ${SAFE}),
  folded_at_ms INTEGER NOT NULL CHECK (folded_at_ms BETWEEN 0 AND ${SAFE}),
  CHECK ((latest_write_seq IS NULL)=(latest_write_sha256 IS NULL) AND (latest_write_seq IS NULL)=(latest_write_byte_length IS NULL)),
  PRIMARY KEY (workspace_id,main_version_id,object_id,lineage_claim_id),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
) STRICT`;
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
export function initializeOrdinaryCheckpoints(db: SqliteDb) {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(marker);
  const row = db
    .prepare("SELECT type,sql FROM sqlite_schema WHERE name=?")
    .get(ORDINARY_CHECKPOINTS);
  if (!marked) {
    if (row) throw new Error("Unmarked ordinary checkpoints exist.");
    db.exec(schema);
  } else if (
    !row ||
    row.type !== "table" ||
    typeof row.sql !== "string" ||
    normalized(row.sql) !== normalized(schema)
  )
    throw new Error("Ordinary checkpoints are damaged.");
  const indexes = db.prepare(`PRAGMA index_list(${ORDINARY_CHECKPOINTS})`).all();
  if (
    indexes.length !== 1 ||
    indexes[0]!.unique !== 1 ||
    indexes[0]!.partial !== 0 ||
    indexes[0]!.origin !== "pk" ||
    db.prepare(`PRAGMA foreign_key_check(${ORDINARY_CHECKPOINTS})`).all().length ||
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
      .get(ORDINARY_CHECKPOINTS)
  )
    throw new Error("Ordinary checkpoint constraints are damaged.");
  if (!marked)
    db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(
      marker,
      Date.now(),
    );
}

/** Deletes the workspace's checkpoints folded under any identity but `current`, and frees their charge, in the caller's transaction. */
export function forgetSupersededOrdinaryCheckpoints(
  storage: StorageContext,
  workspaceId: string,
  current: { readonly replicationEpoch: string; readonly streamIdentity: string },
) {
  forgetOrdinaryCheckpoints(
    storage,
    workspaceId,
    "NOT (replication_epoch=? AND stream_identity=?)",
    current.replicationEpoch,
    current.streamIdentity,
  );
}

/** Deletes a deleted object's main checkpoints, and frees their charge, in the transaction that appends its delete moment. */
export function forgetDeletedOrdinaryCheckpoints(
  storage: StorageContext,
  workspaceId: string,
  objectId: string,
) {
  forgetOrdinaryCheckpoints(
    storage,
    workspaceId,
    "main_version_id='main' AND object_id=?",
    objectId,
  );
}

function forgetOrdinaryCheckpoints(
  storage: StorageContext,
  workspaceId: string,
  where: string,
  ...params: string[]
) {
  const freed = storage.db
    .prepare(
      `DELETE FROM ${ORDINARY_CHECKPOINTS} WHERE workspace_id=? AND ${where} RETURNING accounted_bytes`,
    )
    .all(workspaceId, ...params)
    .reduce((sum, row) => sum + Number(row.accounted_bytes), 0);
  if (freed === 0) return;
  const usage = storage.db
    .prepare(
      "UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id=? AND usage_bytes>=?",
    )
    .run(freed, workspaceId, freed);
  if (usage.changes !== 1) throw new Error("Ordinary checkpoint usage is damaged.");
}
