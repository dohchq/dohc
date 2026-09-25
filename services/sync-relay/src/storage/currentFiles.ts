import { asRecord, validateUserWritePath } from "@dohc/workspace-core";
import type { SqliteDb, CurrentFileStateSnapshot } from "./types";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import type { StorageContext } from "./context";

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
  remove: ReturnType<SqliteDb["prepare"]>;
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
      statements.put.run(
        workspaceId,
        versionId,
        path,
        blobSha256,
        snapshot.contentKind === "binary" ? "binary" : "text",
        relaySeq,
      );
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
  statements.put.run(
    workspaceId,
    versionId,
    afterPath,
    afterBlobSha256,
    payload.payloadAfterContentKind === "binary" ? "binary" : "text",
    relaySeq,
  );
}

function currentFileSelectorClause(selectorPaths: readonly string[]): {
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
    return "(path = ? OR (path >= ? AND path < ?))";
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

// The bytes of `sha256` when the object is in the share now: its latest moment
// in this version is the current file at a selected path, set above the epoch
// floor. A delete, a move out of the selector, or another object taking the
// path leaves no such row.
export function currentObjectBlobByteLength(storage: StorageContext, input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    objectId: string;
    sha256: string;
    epochLogFloor: number;
  }): number | null {
    const selector = currentFileSelectorClause(input.selectorPaths);
    const row = storage.db
      .prepare(
        `SELECT CAST(blob.byte_length AS TEXT) AS byte_length
         FROM sync_relay_current_files
         JOIN sync_relay_blobs AS blob
           ON blob.workspace_id = sync_relay_current_files.workspace_id
          AND blob.sha256 = ?
         WHERE sync_relay_current_files.workspace_id = ?
           AND sync_relay_current_files.version_id = ?
           AND sync_relay_current_files.state_relay_seq > ?
           AND (sync_relay_current_files.path, sync_relay_current_files.state_relay_seq) = (
             SELECT latest.path, latest.relay_seq
             FROM sync_relay_object_moments latest
             WHERE latest.workspace_id = ? AND latest.object_id = ? AND latest.version_id = ?
             ORDER BY latest.relay_seq DESC
             LIMIT 1
           )${selector.sql}
         LIMIT 1`,
      )
      .get(
        input.sha256,
        input.workspaceId,
        input.versionId,
        input.epochLogFloor,
        input.workspaceId,
        input.objectId,
        input.versionId,
        ...selector.params,
      );
    return row && typeof row.byte_length === "string"
      ? Number(row.byte_length)
      : null;
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
