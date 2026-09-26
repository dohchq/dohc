import { asRecord, validateUserWritePath } from "@dohc/workspace-core";
import type { SqliteDb, CurrentFileStateSnapshot, SyncRelayLogRow } from "./types";
import { LINK_REVISION_SCAN_LIMIT, SHARED_BLOB_CANDIDATE_LIMIT } from "./limits";
import { rowToLogRow } from "./rows";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import type { StorageContext } from "./context";
import { pathCollisionKey } from "../pathCollisionKey";

const CURRENT_FILE_KEYS_MIGRATION_ID = "current-file-collision-keys-v1";
// A new fold needs a new migration id: the fill below then keys every
// current file again.
const CURRENT_FILE_KEY_INSERT_SQL = `
  INSERT INTO sync_relay_current_file_keys (workspace_id, version_id, path, collision_key)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET collision_key = excluded.collision_key
    WHERE collision_key <> excluded.collision_key`;

// Each current file's collision key, so "does the owner have this path under
// any spelling?" is an index lookup, not a scan. A row goes with its current
// file. The first start with this table fills it from the current files.
export function initializeCurrentFileKeySchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_current_file_keys (
      workspace_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      path TEXT NOT NULL,
      collision_key TEXT NOT NULL,
      PRIMARY KEY (workspace_id, version_id, path),
      FOREIGN KEY (workspace_id, version_id, path)
        REFERENCES sync_relay_current_files(workspace_id, version_id, path) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_current_file_keys_key
      ON sync_relay_current_file_keys(workspace_id, version_id, collision_key);
  `);
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(CURRENT_FILE_KEYS_MIGRATION_ID)) return;
  const insert = db.prepare(CURRENT_FILE_KEY_INSERT_SQL);
  for (const row of db.prepare("SELECT workspace_id, version_id, path FROM sync_relay_current_files").iterate()) {
    const path = String(row.path);
    insert.run(String(row.workspace_id), String(row.version_id), path, pathCollisionKey(path));
  }
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)")
    .run(CURRENT_FILE_KEYS_MIGRATION_ID, Date.now());
}

// Where a `moment.append` payload says its object is after the op: the
// destination path of a write or a rename (a rename carries the destination in
// both `path` and `payloadAfterPath`, `crates/dohc-engine-domain/src/store/delete_rename.rs`
// `rename`), or NULL for a delete.
//
// NULL is also the answer for a moment that names an object but no readable
// path. That op moved the object somewhere this table cannot state, and a
// stale row would keep serving the object's chat at a path the relay can no
// longer prove. Unknown denies.
export function objectPathFromMomentPayload(
  payloadJson: string,
): { objectId: string; path: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;
  const objectId = record.objectId;
  if (typeof objectId !== "string" || objectId.length === 0) return null;
  if (record.operation === "delete") return { objectId, path: null };
  for (const field of ["path", "payloadAfterPath"] as const) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return { objectId, path: value };
  }
  return { objectId, path: null };
}

// What one `moment.append` says about its object, in the shape the
// base rewrite reads back. The three fields the read filter already trusts —
// `objectId`, the after path, the after hash — plus the moment's own id, which
// is what `head_fast_forward` compares against on the granter's engine
// (`crates/dohc-engine-sync/src/moment_apply.rs`).
//
// A delete states a null path and a null hash. A moment the relay cannot read
// this far states nothing, and an unindexed moment simply cannot be chosen as
// a base — which fails closed, because an unresolvable base opens a conflict.
export function objectMomentFromMomentPayload(
  payloadJson: string,
): {
  objectId: string;
  momentId: string;
  versionId: string;
  path: string | null;
  blobSha256: string | null;
  contentKind: string | null;
  byteLength: number | null;
  recordedAtMs: number;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;
  const objectId = record.objectId;
  const momentId = record.momentId;
  const versionId = record.versionId;
  const recordedAtMs = record.recordedAtMs;
  if (
    typeof objectId !== "string" ||
    objectId.length === 0 ||
    typeof momentId !== "string" ||
    momentId.length === 0 ||
    typeof versionId !== "string" ||
    versionId.length === 0 ||
    typeof recordedAtMs !== "number" ||
    !Number.isSafeInteger(recordedAtMs)
  ) {
    return null;
  }
  const deleted = record.operation === "delete";
  const path = deleted ? null : readableString(record.path) ?? readableString(record.payloadAfterPath);
  const blobSha256 = deleted ? null : readableString(record.payloadAfterBlobSha256);
  const contentKind = deleted ? null : readableString(record.payloadAfterContentKind);
  const byteLength =
    !deleted && typeof record.payloadAfterByteLength === "number" &&
    Number.isSafeInteger(record.payloadAfterByteLength)
      ? record.payloadAfterByteLength
      : null;
  return { objectId, momentId, versionId, path, blobSha256, contentKind, byteLength, recordedAtMs };
}

export function readableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const OBJECT_MOMENT_INSERT_SQL = `
  INSERT INTO sync_relay_object_moments (
    workspace_id, object_id, relay_seq, moment_id, version_id,
    path, blob_sha256, content_kind, byte_length, recorded_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(workspace_id, object_id, relay_seq) DO NOTHING`;

export const VERSION_SNAPSHOT_BLOB_INSERT_SQL = `
  INSERT INTO sync_relay_version_snapshot_blobs (
    workspace_id, relay_seq, version_id, blob_sha256
  ) VALUES (?, ?, ?, ?)
  ON CONFLICT(workspace_id, relay_seq, blob_sha256) DO NOTHING`;

interface CurrentFileStatements {
  get: ReturnType<SqliteDb["prepare"]>;
  put: ReturnType<SqliteDb["prepare"]>;
  key: ReturnType<SqliteDb["prepare"]>;
  remove: ReturnType<SqliteDb["prepare"]>;
}

// A current file and its collision key. Removing the file removes the key.
function putCurrentFile(
  statements: CurrentFileStatements,
  row: { workspaceId: string; versionId: string; path: string; blobSha256: string; contentKind: string; relaySeq: number },
): void {
  statements.put.run(row.workspaceId, row.versionId, row.path, row.blobSha256, row.contentKind, row.relaySeq);
  statements.key.run(row.workspaceId, row.versionId, row.path, pathCollisionKey(row.path));
}

export function currentFileStatements(db: SqliteDb): CurrentFileStatements {
  return {
    get: db.prepare(
      `SELECT blob_sha256
       FROM sync_relay_current_files
       WHERE workspace_id = ? AND version_id = ? AND path = ?`,
    ),
    put: db.prepare(
      `INSERT INTO sync_relay_current_files (
         workspace_id, version_id, path, blob_sha256, content_kind, state_relay_seq
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, version_id, path) DO UPDATE SET
         blob_sha256 = excluded.blob_sha256,
         content_kind = excluded.content_kind,
         state_relay_seq = excluded.state_relay_seq`,
    ),
    key: db.prepare(CURRENT_FILE_KEY_INSERT_SQL),
    remove: db.prepare(
      `DELETE FROM sync_relay_current_files
       WHERE workspace_id = ? AND version_id = ? AND path = ?`,
    ),
  };
}

function trackedPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const validation = validateUserWritePath(value);
  if (!validation.ok || validation.normalized !== value) return null;
  return classifyEngineFilePath(validation.normalized).kind === "tracked"
    ? validation.normalized
    : null;
}

function optionalPathAliasMatches(value: unknown, expected: string | null): boolean {
  if (value === null || value === undefined) return true;
  const path = trackedPath(value);
  return path !== null && expected !== null && path === expected;
}

function digest(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
    ? value
    : null;
}

export function applyCurrentFileOp(
  statements: CurrentFileStatements,
  workspaceId: string,
  opKind: string,
  payloadJson: string,
  relaySeq: number,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return;
  }
  const payload = asRecord(parsed);
  if (!payload) return;

  if (opKind === "version.create") {
    const versionId = readableString(payload.versionId);
    if (!versionId || !Array.isArray(payload.forkSnapshots)) return;
    for (const rawSnapshot of payload.forkSnapshots) {
      const snapshot = asRecord(rawSnapshot);
      if (!snapshot) continue;
      const path = trackedPath(snapshot.path);
      const blobSha256 = digest(snapshot.blobSha256);
      if (!path || !blobSha256) continue;
      if (statements.get.get(workspaceId, versionId, path) !== undefined) continue;
      putCurrentFile(statements, {
        workspaceId,
        versionId,
        path,
        blobSha256,
        contentKind: snapshot.contentKind === "binary" ? "binary" : "text",
        relaySeq,
      });
    }
    return;
  }

  if (opKind !== "moment.append") return;
  const versionId = readableString(payload.versionId);
  if (!versionId) return;
  const operation = payload.operation;
  if (operation !== "write" && operation !== "rename" && operation !== "delete") return;
  const hasNoBefore =
    (payload.payloadBeforePath === null || payload.payloadBeforePath === undefined) &&
    (payload.payloadBeforeBlobSha256 === null ||
      payload.payloadBeforeBlobSha256 === undefined);
  const beforePath = trackedPath(payload.payloadBeforePath);
  const beforeBlobSha256 = digest(payload.payloadBeforeBlobSha256);
  const before = beforePath && beforeBlobSha256
    ? { path: beforePath, blobSha256: beforeBlobSha256 }
    : null;
  if (!hasNoBefore && !before) return;
  if (!optionalPathAliasMatches(payload.beforePath, before?.path ?? null)) return;

  if (operation === "delete") {
    if (!before) return;
    if (
      !optionalPathAliasMatches(payload.path, before.path) ||
      !optionalPathAliasMatches(payload.payloadAfterPath, before.path)
    ) {
      return;
    }
    const current = statements.get.get(workspaceId, versionId, before.path);
    if (current?.blob_sha256 !== before.blobSha256) return;
    statements.remove.run(workspaceId, versionId, before.path);
    return;
  }

  const afterPath = trackedPath(payload.payloadAfterPath);
  const afterBlobSha256 = digest(payload.payloadAfterBlobSha256);
  if (!afterPath || !afterBlobSha256) return;
  if (!optionalPathAliasMatches(payload.path, afterPath)) return;
  if (before && before.path !== afterPath && operation !== "rename") return;
  if (hasNoBefore) {
    if (statements.get.get(workspaceId, versionId, afterPath) !== undefined) return;
  } else {
    if (!before) return;
    const current = statements.get.get(workspaceId, versionId, before.path);
    if (current !== undefined) {
      if (current.blob_sha256 !== before.blobSha256) return;
      if (
        before.path !== afterPath &&
        statements.get.get(workspaceId, versionId, afterPath) !== undefined
      ) {
        return;
      }
      if (before.path !== afterPath) {
        statements.remove.run(workspaceId, versionId, before.path);
      }
    } else if (statements.get.get(workspaceId, versionId, afterPath) !== undefined) {
      return;
    }
  }
  putCurrentFile(statements, {
    workspaceId,
    versionId,
    path: afterPath,
    blobSha256: afterBlobSha256,
    contentKind: payload.payloadAfterContentKind === "binary" ? "binary" : "text",
    relaySeq,
  });
}

function currentFileSelectorClause(selectorPaths: readonly string[], column = "path"): {
  sql: string;
  params: string[];
} {
  if (selectorPaths.length === 0) return { sql: "", params: [] };
  const params: string[] = [];
  const ranges = selectorPaths.map((root) => {
    const descendantPrefix = `${root}/`;
    // Normalized roots never end in slash. Under SQLite binary collation,
    // replacing the descendant slash (0x2f) with `0` (0x30) is the exact
    // exclusive upper bound, including descendants that start with a
    // supplementary Unicode code point.
    params.push(root, descendantPrefix, `${root}0`);
    return `(${column} = ? OR (${column} >= ? AND ${column} < ?))`;
  });
  return { sql: ` AND (${ranges.join(" OR ")})`, params };
}

export function currentFileStateQuery(selectorPaths: readonly string[]): {
  sql: string;
  selectorParams: string[];
} {
  const selector = currentFileSelectorClause(selectorPaths);
  return {
    sql:
      `SELECT path, blob_sha256, content_kind
       FROM sync_relay_current_files INDEXED BY idx_sync_relay_current_files_path
       WHERE workspace_id = ? AND version_id = ?
         AND state_relay_seq > ? AND state_relay_seq <= ?${selector.sql}
       ORDER BY path
       LIMIT ?`,
    selectorParams: selector.params,
  };
}

export function currentFileBlobByteLengthQuery(selectorPaths: readonly string[]): {
  sql: string;
  selectorParams: string[];
} {
  const selector = currentFileSelectorClause(selectorPaths);
  return {
    sql:
      `SELECT CAST(blob.byte_length AS TEXT) AS byte_length
       FROM sync_relay_current_files INDEXED BY idx_sync_relay_current_files_blob
       JOIN sync_relay_blobs AS blob
         ON blob.workspace_id = sync_relay_current_files.workspace_id
        AND blob.sha256 = sync_relay_current_files.blob_sha256
       WHERE sync_relay_current_files.workspace_id = ?
         AND sync_relay_current_files.version_id = ?
         AND sync_relay_current_files.blob_sha256 = ?
         AND sync_relay_current_files.state_relay_seq > ?${selector.sql}
       LIMIT 1`,
    selectorParams: selector.params,
  };
}

// The log rows that produced `sha256` for objects still in the share, newest
// first: per object, its latest moment with this content above the epoch floor
// at a selected path, kept only when the object's latest moment in the version
// is the current file at a selected path. The scan reads at most
// LINK_REVISION_SCAN_LIMIT moments with this content, so a link request's work
// does not grow with how often the content recurs. Membership is checked
// before the result is capped.
export function listLinkRevisionLogRows(storage: StorageContext, input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    sha256: string;
    epochLogFloor: number;
  }): SyncRelayLogRow[] {
    const revisionSelector = currentFileSelectorClause(input.selectorPaths, "scanned.path");
    const currentSelector = currentFileSelectorClause(input.selectorPaths, "current_file.path");
    const latest = (column: "path" | "relay_seq") =>
      `(SELECT latest.${column}
        FROM sync_relay_object_moments AS latest
          INDEXED BY idx_sync_relay_object_moments_latest
        WHERE latest.workspace_id = ? AND latest.version_id = ?
          AND latest.object_id = revisions.object_id
        ORDER BY latest.relay_seq DESC
        LIMIT 1)`;
    return storage.db
      .prepare(
        `WITH scanned AS MATERIALIZED (
           SELECT object_id, relay_seq, path
           FROM sync_relay_object_moments
             INDEXED BY idx_sync_relay_object_moments_blob_lookup
           WHERE workspace_id = ? AND version_id = ? AND blob_sha256 = ?
           LIMIT ?
         ),
         revisions AS (
           SELECT scanned.object_id, MAX(scanned.relay_seq) AS relay_seq
           FROM scanned
           WHERE scanned.relay_seq > ?${revisionSelector.sql}
           GROUP BY scanned.object_id
         ),
         placed AS MATERIALIZED (
           SELECT revisions.relay_seq,
                  ${latest("path")} AS latest_path,
                  ${latest("relay_seq")} AS latest_relay_seq
           FROM revisions
         )
         SELECT l.workspace_id, l.origin_id, l.origin_seq, l.op_kind,
                l.payload_json, l.recorded_at_ms, l.relay_seq
         FROM placed
         JOIN sync_relay_current_files AS current_file
           ON current_file.workspace_id = ?
          AND current_file.version_id = ?
          AND current_file.path = placed.latest_path
          AND current_file.state_relay_seq = placed.latest_relay_seq
         JOIN sync_relay_log l ON l.relay_seq = placed.relay_seq
         WHERE current_file.state_relay_seq > ?${currentSelector.sql}
         ORDER BY placed.relay_seq DESC
         LIMIT ?`,
      )
      .all(
        input.workspaceId,
        input.versionId,
        input.sha256,
        LINK_REVISION_SCAN_LIMIT,
        input.epochLogFloor,
        ...revisionSelector.params,
        input.workspaceId,
        input.versionId,
        input.workspaceId,
        input.versionId,
        input.workspaceId,
        input.versionId,
        input.epochLogFloor,
        ...currentSelector.params,
        SHARED_BLOB_CANDIDATE_LIMIT,
      )
      .map(rowToLogRow);
  }

// The bytes of `sha256` when the object is in the share now: its latest moment
// in this version is the current file at a selected path, set above the epoch
// floor. A delete, a move out of the selector, or another object taking the
// path leaves no answer.
export function currentObjectBlobByteLength(storage: StorageContext, input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    objectId: string;
    sha256: string;
    epochLogFloor: number;
  }): number | null {
    const selector = currentFileSelectorClause(input.selectorPaths);
    const latest = (column: "path" | "relay_seq") =>
      `(SELECT latest.${column}
        FROM sync_relay_object_moments AS latest
          INDEXED BY idx_sync_relay_object_moments_latest
        WHERE latest.workspace_id = ? AND latest.version_id = ? AND latest.object_id = ?
        ORDER BY latest.relay_seq DESC
        LIMIT 1)`;
    const row = storage.db
      .prepare(
        `SELECT CAST(blob.byte_length AS TEXT) AS byte_length
         FROM sync_relay_current_files
         JOIN sync_relay_blobs AS blob
           ON blob.workspace_id = sync_relay_current_files.workspace_id
          AND blob.sha256 = ?
         WHERE sync_relay_current_files.workspace_id = ?
           AND sync_relay_current_files.version_id = ?
           AND sync_relay_current_files.path = ${latest("path")}
           AND sync_relay_current_files.state_relay_seq = ${latest("relay_seq")}
           AND sync_relay_current_files.state_relay_seq > ?${selector.sql}
         LIMIT 1`,
      )
      .get(
        input.sha256,
        input.workspaceId,
        input.versionId,
        input.workspaceId,
        input.versionId,
        input.objectId,
        input.workspaceId,
        input.versionId,
        input.objectId,
        input.epochLogFloor,
        ...selector.params,
      );
    return row && typeof row.byte_length === "string"
      ? Number(row.byte_length)
      : null;
  }

// The paths of the object's moments in this version after `afterRelaySeq`,
// newest first, at most `limit` of them. A delete answers null.
export function laterObjectMomentPaths(storage: StorageContext, input: {
    workspaceId: string;
    versionId: string;
    objectId: string;
    afterRelaySeq: number;
    limit: number;
  }): Array<string | null> {
    return storage.db
      .prepare(
        `SELECT later.path
         FROM sync_relay_object_moments AS later
           INDEXED BY idx_sync_relay_object_moments_latest
         WHERE later.workspace_id = ? AND later.version_id = ? AND later.object_id = ?
           AND later.relay_seq > ?
         ORDER BY later.relay_seq DESC
         LIMIT ?`,
      )
      .all(input.workspaceId, input.versionId, input.objectId, input.afterRelaySeq, input.limit)
      .map((row) => (typeof row.path === "string" ? row.path : null));
  }

// Latest-wins: a rename is a later fact about the same object, and the share
// must follow the file rather than its history.
//
// The relay_seq guard is defence in depth, and today it is unreachable: both
// writers walk the log in relay order (appendLogBatch inserts under the write
// lock and reads back the row it just took; the seed scans ORDER BY
// relay_seq), so no upsert here can arrive out of order. Its inverse mutation
// therefore survives, which is recorded rather than papered over. It stays
// because this table decides which chat a share serves, and a path moved
// backwards by a future out-of-order writer would serve a file's discussion at
// a path the relay can no longer prove.
export const OBJECT_PATH_UPSERT_SQL = `
  INSERT INTO sync_relay_object_paths (workspace_id, object_id, path, relay_seq)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(workspace_id, object_id) DO UPDATE
    SET path = excluded.path, relay_seq = excluded.relay_seq
    WHERE excluded.relay_seq > sync_relay_object_paths.relay_seq`;

export function readCurrentFileState(storage: StorageContext, input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    limit: number;
  }): CurrentFileStateSnapshot {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("current file limit must be a positive safe integer");
    }
    return storage.readTx(() => {
      const workspace = storage.db
        .prepare(
          `SELECT COALESCE(epoch_log_floor, 0) AS epoch_log_floor
           FROM sync_relay_workspaces
           WHERE workspace_id = ?`,
        )
        .get(input.workspaceId);
      const cursor = storage.db
        .prepare(
          `SELECT relay_seq
           FROM sync_relay_log INDEXED BY idx_sync_relay_log_page
           WHERE workspace_id = ?
           ORDER BY relay_seq DESC
           LIMIT 1`,
        )
        .get(input.workspaceId);
      const epochLogFloor = Number(workspace?.epoch_log_floor ?? 0);
      const nextCursor = Number(cursor?.relay_seq ?? 0);
      const query = currentFileStateQuery(input.selectorPaths);
      const rows = storage.db
        .prepare(query.sql)
        .all(
          input.workspaceId,
          input.versionId,
          epochLogFloor,
          nextCursor,
          ...query.selectorParams,
          input.limit + 1,
        );
      return {
        files: rows.slice(0, input.limit).map((row) => ({
          path: String(row.path),
          blobSha256: String(row.blob_sha256),
          contentKind: row.content_kind === "binary" ? "binary" : "text",
        })),
        nextCursor,
        epochLogFloor,
        tooMany: rows.length > input.limit,
      };
    });
  }

export function currentFileBlobByteLength(storage: StorageContext, input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    sha256: string;
    epochLogFloor: number;
  }): number | null {
    const query = currentFileBlobByteLengthQuery(input.selectorPaths);
    const row = storage.db
      .prepare(query.sql)
      .get(
        input.workspaceId,
        input.versionId,
        input.sha256,
        input.epochLogFloor,
        ...query.selectorParams,
      );
    return row && typeof row.byte_length === "string"
      ? Number(row.byte_length)
      : null;
  }
