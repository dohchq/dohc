import { createHash } from "node:crypto";
import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";
import { assertWorkspaceQuota } from "./workspaces";

/**
 * A lineage's ordinary history folded through one relay position: the full state after it, and what activation needs to
 * continue from there without replaying the rows before it. Only this relay writes it, after its own validation accepted
 * every row it covers. Relay log rows never change after insert, so a row stays true until the lineage or epoch changes.
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

export interface OrdinaryCheckpointBase {
  readonly relaySeq: number;
  readonly originId: string;
  readonly originSeq: number;
}
/** Which lineage a checkpoint must belong to, as the relay and the activation source see it now. */
export interface OrdinaryCheckpointScope {
  readonly namespace: string;
  readonly document: LiveDocumentKey;
  readonly replicationEpoch: string;
  readonly streamIdentity: string;
  readonly base: OrdinaryCheckpointBase;
  readonly policySha256: string;
}
export type OrdinaryCheckpointProjection = {
  readonly projectedMarkdownSha256: string;
  readonly projectedMarkdownByteLength: number;
};
/**
 * One of the last folded Y.Doc rows, which activation may still name as its source, and the projection of the history
 * through it when the fold kept that. The fold keeps it only for the rows of a page that reached the relay's cursor.
 */
export interface OrdinaryCheckpointRow {
  readonly relaySeq: number;
  readonly originId: string;
  readonly originSeq: number;
  readonly ordinary: boolean;
  readonly projection: OrdinaryCheckpointProjection | null;
}
/** A folded file moment of this object, and the projection of the history before it, which a later artifact's proof compares. */
export interface OrdinaryCheckpointMoment extends OrdinaryCheckpointProjection {
  readonly relaySeq: number;
  readonly operation: "write" | "rename";
  /** A write's file and whether the relay recorded it as this object's moment. */
  readonly write: {
    readonly blobSha256: string;
    readonly byteLength: number;
    readonly objectMoment: boolean;
  } | null;
}
export interface OrdinaryCheckpoint {
  /** The last row of this document the checkpoint covers: a Y.Doc row or a file moment. */
  readonly throughRelaySeq: number;
  readonly foldedEntries: number;
  readonly state: Uint8Array;
  readonly stateSha256: string;
  /** The document's path after `throughRelaySeq`, which the moves after it must prove back to. */
  readonly currentPath: string;
  readonly projection: OrdinaryCheckpointProjection;
  /** The last folded Y.Doc rows, at most CHECKPOINT_TAIL_ROWS, oldest first. */
  readonly tail: readonly OrdinaryCheckpointRow[];
  /** The newest folded file moments, at most CHECKPOINT_MOMENTS, oldest first, and the row from which none was dropped. */
  readonly moments: readonly OrdinaryCheckpointMoment[];
  readonly momentsFromSeq: number;
  /**
   * The latest folded rename and the latest folded write the relay recorded as this object's moment, or null when the
   * fold found none since the base. They stay when older moments are dropped.
   */
  readonly latestRename: number | null;
  readonly latestWrite: {
    readonly relaySeq: number;
    readonly blobSha256: string;
    readonly byteLength: number;
  } | null;
}
export const CHECKPOINT_TAIL_ROWS = 32,
  CHECKPOINT_MOMENTS = 256;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const key = (document: LiveDocumentKey) => [
  document.workspaceId,
  document.mainVersionId,
  document.objectId,
  document.lineageClaimId,
];
/** The digest a checkpoint's validation policy is recorded under. A checkpoint folded under another policy is not used. */
export const checkpointPolicySha256 = (policy: object) =>
  hash(JSON.stringify(Object.entries(policy).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/**
 * The lineage's checkpoint, or null when it has none this relay can use: another relay database, epoch, stream, base or
 * validation policy, or state bytes that differ from their digest. A null checkpoint means activation starts from the base.
 */
export function readOrdinaryCheckpoint(
  storage: StorageContext,
  scope: OrdinaryCheckpointScope,
): OrdinaryCheckpoint | null {
  const row = storage.db
    .prepare(
      `SELECT * FROM ${ORDINARY_CHECKPOINTS} WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`,
    )
    .get(...key(scope.document));
  if (!row) return null;
  const state = row.state_bytes instanceof Uint8Array ? row.state_bytes : null;
  if (
    row.relay_database_namespace !== scope.namespace ||
    row.replication_epoch !== scope.replicationEpoch ||
    row.stream_identity !== scope.streamIdentity ||
    row.base_relay_seq !== scope.base.relaySeq ||
    row.base_origin_id !== scope.base.originId ||
    row.base_origin_seq !== scope.base.originSeq ||
    row.policy_sha256 !== scope.policySha256 ||
    !state ||
    hash(state) !== row.state_sha256
  )
    return null;
  return {
    throughRelaySeq: Number(row.through_relay_seq),
    foldedEntries: Number(row.folded_entries),
    state: new Uint8Array(state),
    stateSha256: String(row.state_sha256),
    currentPath: String(row.current_path),
    projection: {
      projectedMarkdownSha256: String(row.projected_sha256),
      projectedMarkdownByteLength: Number(row.projected_byte_length),
    },
    tail: JSON.parse(String(row.tail_json)),
    moments: JSON.parse(String(row.moments_json)),
    momentsFromSeq: Number(row.moments_from_seq),
    latestRename: row.latest_rename_seq === null ? null : Number(row.latest_rename_seq),
    latestWrite:
      row.latest_write_seq === null
        ? null
        : {
            relaySeq: Number(row.latest_write_seq),
            blobSha256: String(row.latest_write_sha256),
            byteLength: Number(row.latest_write_byte_length),
          },
  };
}

/**
 * Replaces the lineage's checkpoint with one folded further, in the caller's transaction. `expected` is the position the
 * fold started from, or null when it started from the base: any other row now means another fold won, and this one is
 * dropped. The relay's committed cursor must still cover the new position. Returns whether it was saved.
 */
export function replaceOrdinaryCheckpoint(
  storage: StorageContext,
  input: {
    scope: OrdinaryCheckpointScope;
    expected: number | null;
    checkpoint: OrdinaryCheckpoint;
    nowMs: number;
  },
): boolean {
  const { scope, expected, checkpoint } = input,
    { document } = scope;
  const prior = storage.db
    .prepare(
      `SELECT through_relay_seq,accounted_bytes FROM ${ORDINARY_CHECKPOINTS} WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`,
    )
    .get(...key(document));
  const usable = prior && readOrdinaryCheckpoint(storage, scope);
  if (
    (usable ? usable.throughRelaySeq : null) !== expected ||
    checkpoint.throughRelaySeq <= (expected ?? scope.base.relaySeq - 1)
  )
    return false;
  const cursor = storage.db
    .prepare("SELECT COALESCE(MAX(relay_seq),0) AS cursor FROM sync_relay_log WHERE workspace_id=?")
    .get(document.workspaceId);
  if (!cursor || Number(cursor.cursor) < checkpoint.throughRelaySeq) return false;
  if (hash(checkpoint.state) !== checkpoint.stateSha256)
    throw new Error("Ordinary checkpoint state differs from its digest.");
  const fields = [
    scope.namespace,
    scope.replicationEpoch,
    scope.streamIdentity,
    scope.base.originId,
    checkpoint.stateSha256,
    checkpoint.currentPath,
    checkpoint.projection.projectedMarkdownSha256,
    scope.policySha256,
    checkpoint.latestWrite?.blobSha256 ?? null,
    ...key(document),
  ];
  const tailJson = JSON.stringify(checkpoint.tail),
    momentsJson = JSON.stringify(checkpoint.moments);
  const accounted =
    checkpoint.state.length +
    Buffer.byteLength(JSON.stringify(fields)) +
    Buffer.byteLength(tailJson) +
    Buffer.byteLength(momentsJson) +
    11 * 8;
  const charge = accounted - (prior ? Number(prior.accounted_bytes) : 0);
  assertWorkspaceQuota(storage, document.workspaceId, charge);
  storage.db
    .prepare(`INSERT INTO ${ORDINARY_CHECKPOINTS}(workspace_id,main_version_id,object_id,lineage_claim_id,relay_database_namespace,replication_epoch,stream_identity,
      base_relay_seq,base_origin_id,base_origin_seq,through_relay_seq,folded_entries,state_bytes,state_sha256,current_path,projected_sha256,projected_byte_length,
      tail_json,moments_json,moments_from_seq,latest_rename_seq,latest_write_seq,latest_write_sha256,latest_write_byte_length,policy_sha256,accounted_bytes,folded_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,main_version_id,object_id,lineage_claim_id) DO UPDATE SET relay_database_namespace=excluded.relay_database_namespace,
      replication_epoch=excluded.replication_epoch,stream_identity=excluded.stream_identity,base_relay_seq=excluded.base_relay_seq,base_origin_id=excluded.base_origin_id,
      base_origin_seq=excluded.base_origin_seq,through_relay_seq=excluded.through_relay_seq,folded_entries=excluded.folded_entries,state_bytes=excluded.state_bytes,
      state_sha256=excluded.state_sha256,current_path=excluded.current_path,projected_sha256=excluded.projected_sha256,projected_byte_length=excluded.projected_byte_length,
      tail_json=excluded.tail_json,moments_json=excluded.moments_json,moments_from_seq=excluded.moments_from_seq,
      latest_rename_seq=excluded.latest_rename_seq,latest_write_seq=excluded.latest_write_seq,latest_write_sha256=excluded.latest_write_sha256,
      latest_write_byte_length=excluded.latest_write_byte_length,policy_sha256=excluded.policy_sha256,accounted_bytes=excluded.accounted_bytes,folded_at_ms=excluded.folded_at_ms`)
    .run(
      ...key(document),
      scope.namespace,
      scope.replicationEpoch,
      scope.streamIdentity,
      scope.base.relaySeq,
      scope.base.originId,
      scope.base.originSeq,
      checkpoint.throughRelaySeq,
      checkpoint.foldedEntries,
      checkpoint.state,
      checkpoint.stateSha256,
      checkpoint.currentPath,
      checkpoint.projection.projectedMarkdownSha256,
      checkpoint.projection.projectedMarkdownByteLength,
      tailJson,
      momentsJson,
      checkpoint.momentsFromSeq,
      checkpoint.latestRename,
      checkpoint.latestWrite?.relaySeq ?? null,
      checkpoint.latestWrite?.blobSha256 ?? null,
      checkpoint.latestWrite?.byteLength ?? null,
      scope.policySha256,
      accounted,
      input.nowMs,
    );
  const usage = storage.db
    .prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?")
    .run(charge, document.workspaceId);
  if (usage.changes !== 1) throw new Error("Ordinary checkpoint usage is damaged.");
  return true;
}

/**
 * Deletes the workspace's checkpoints folded under any identity but `current`, and returns their charge, in the caller's
 * transaction. A checkpoint is read only under the workspace's current epoch and stream, and a superseded epoch never
 * becomes current again.
 */
export function forgetSupersededOrdinaryCheckpoints(
  storage: StorageContext,
  workspaceId: string,
  current: { readonly replicationEpoch: string; readonly streamIdentity: string },
) {
  const freed = storage.db
    .prepare(
      `DELETE FROM ${ORDINARY_CHECKPOINTS} WHERE workspace_id=? AND NOT (replication_epoch=? AND stream_identity=?) RETURNING accounted_bytes`,
    )
    .all(workspaceId, current.replicationEpoch, current.streamIdentity)
    .reduce((sum, row) => sum + Number(row.accounted_bytes), 0);
  if (freed === 0) return;
  const usage = storage.db
    .prepare(
      "UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id=? AND usage_bytes>=?",
    )
    .run(freed, workspaceId, freed);
  if (usage.changes !== 1) throw new Error("Ordinary checkpoint usage is damaged.");
}
