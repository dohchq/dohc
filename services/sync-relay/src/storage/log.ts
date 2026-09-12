import { type StorageContext } from "./context";
import { enforceWorkspaceIdentityInTransaction, assertWorkspaceQuota } from "./workspaces";
import {
  type SyncRelayLogInput,
  type AppendLogBatchGuardContext,
  type AppendLogBatchResult,
  type FetchLogPageResult,
  type SyncRelayLogRow,
} from "./types";
import { SyncRelayConflictError, SyncRelayBlobMissingError } from "./errors";
import { referencedBlobShas, versionIdFromVersionCreatePayload } from "./blobReferences";
import {
  OBJECT_PATH_UPSERT_SQL,
  OBJECT_MOMENT_INSERT_SQL,
  VERSION_SNAPSHOT_BLOB_INSERT_SQL,
  currentFileStatements,
  objectPathFromMomentPayload,
  objectMomentFromMomentPayload,
  applyCurrentFileOp,
} from "./currentFiles";
import { rowToLogRow } from "./rows";

export function appendLogBatch(storage: StorageContext, input: {
    workspaceId: string;
    originId: string;
    ops: SyncRelayLogInput[];
    guard?: (context: AppendLogBatchGuardContext) => void;
  }): AppendLogBatchResult {
    return storage.tx(() => appendLogBatchInTransaction(storage, input));
  }

/** Internal append for callers already holding the relay write transaction. */
export function appendLogBatchInTransaction(storage: StorageContext, input: {
  workspaceId: string;
  originId: string;
  ops: SyncRelayLogInput[];
  guard?: (context: AppendLogBatchGuardContext) => void;
}): AppendLogBatchResult {
      for (const op of input.ops) {
        if (!Number.isSafeInteger(op.recordedAtMs)) throw new Error("recordedAtMs must be an integer in the safe wire range");
      }
      // Authorization re-verification under the write lock (see the interface
      // comment): BEGIN IMMEDIATE serializes writers, so a revoke committed
      // by another writer is either already visible here (guard throws, batch
      // rolls back) or must wait for this COMMIT — there is no in-between.
      input.guard?.({
        enforceWorkspaceIdentity: (identity) =>
          enforceWorkspaceIdentityInTransaction(storage, input.workspaceId, identity),
      });
      let inserted = 0;
      let skipped = 0;
      let addedLogBytes = 0;
      const newOps: SyncRelayLogInput[] = [];
      const maxStmt = storage.db.prepare(
        `SELECT COALESCE(MAX(origin_seq), -1) AS max_seq
         FROM sync_relay_log
         WHERE workspace_id = ? AND origin_id = ?`,
      );
      const existingStmt = storage.db.prepare(
        `SELECT op_kind, payload_json, recorded_at_ms
         FROM sync_relay_log
         WHERE workspace_id = ? AND origin_id = ? AND origin_seq = ?`,
      );
      // Read the current MAX(origin_seq) once, then track it locally: each
      // insert is exactly currentMax + 1, so re-querying per op (was N extra
      // SELECTs per batch) is unnecessary. Skipped ops leave it unchanged.
      let currentMax = Number(
        maxStmt.get(input.workspaceId, input.originId)?.max_seq ?? -1,
      );
      for (const op of input.ops) {
        if (op.originSeq <= currentMax) {
          const existing = existingStmt.get(
            input.workspaceId,
            input.originId,
            op.originSeq,
          );
          if (
            existing &&
            existing.op_kind === op.opKind &&
            existing.payload_json === op.payloadJson &&
            Number(existing.recorded_at_ms) === op.recordedAtMs
          ) {
            skipped += 1;
            continue;
          }
          throw new SyncRelayConflictError(
            `origin_seq ${op.originSeq} already exists with different content`,
          );
        }
        if (op.originSeq !== currentMax + 1) {
          throw new SyncRelayConflictError(
            `origin_seq gap: expected ${currentMax + 1}, got ${op.originSeq}`,
          );
        }
        currentMax = op.originSeq;
        newOps.push(op);
        addedLogBytes += Buffer.byteLength(op.payloadJson, "utf8");
      }

      assertWorkspaceQuota(storage, input.workspaceId, addedLogBytes);

      // Data-integrity gate (0P sync-hardening): a log op must never be made
      // durable while it references a blob the relay does not hold. The blob
      // GC grace window covers the fresh PUT->POST gap, but not an old blob
      // that ages past the grace, nor a blob GC'd after a failed /log that a
      // retry then re-references via /blobs/have. Validate every referenced
      // sha IN THIS SAME transaction, before inserting: SQLite serializes
      // writers (BEGIN IMMEDIATE), so a concurrent GC cannot delete a checked
      // blob between this probe and the insert that pins it. Only new ops are
      // checked -- a skipped idempotent duplicate is already durable and its
      // blobs were validated at first append. Any missing blob rejects the
      // whole batch atomically (no partial append) with a retryable error the
      // client resolves by re-uploading and re-posting.
      const referencedShas = new Set<string>();
      for (const op of newOps) {
        for (const sha of referencedBlobShas(op.opKind, op.payloadJson, {
          workspaceId: input.workspaceId,
          recordedAtMs: op.recordedAtMs,
        })) {
          referencedShas.add(sha);
        }
      }
      if (referencedShas.size > 0) {
        const missing = storage.missingBlobs(input.workspaceId, [...referencedShas]);
        if (missing.length > 0) {
          throw new SyncRelayBlobMissingError(
            `log append references ${missing.length} blob(s) not stored on the relay ` +
              `(first: ${missing[0]}); (re-)upload the blob(s) and retry`,
          );
        }
      }

      const insertStmt = storage.db.prepare(
        `INSERT INTO sync_relay_log (
          workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const objectPathStmt = storage.db.prepare(OBJECT_PATH_UPSERT_SQL);
      const objectMomentStmt = storage.db.prepare(OBJECT_MOMENT_INSERT_SQL);
      const versionSnapshotBlobStmt = storage.db.prepare(VERSION_SNAPSHOT_BLOB_INSERT_SQL);
      const currentFileStmt = currentFileStatements(storage.db);
      for (const op of newOps) {
        const result = insertStmt.run(
          input.workspaceId,
          input.originId,
          op.originSeq,
          op.opKind,
          op.payloadJson,
          op.recordedAtMs,
        );
        inserted += 1;
        // Keep "where is this object now?" answerable by primary
        // key. The relay_seq this row just took IS the order the guard in the
        // upsert compares, so a later moment always wins and an out-of-order
        // one never moves a path backwards.
        if (op.opKind === "moment.append") {
          const resolved = objectPathFromMomentPayload(op.payloadJson);
          if (resolved) {
            objectPathStmt.run(
              input.workspaceId,
              resolved.objectId,
              resolved.path,
              Number(result.lastInsertRowid),
            );
          }
          // The same insert, one question deeper. The row above
          // keeps "where is this object now?" answerable; this one keeps
          // "which moment produced this content?" answerable, which is what a
          // proposal's base resolves to at accept.
          const moment = objectMomentFromMomentPayload(op.payloadJson);
          if (moment) {
            objectMomentStmt.run(
              input.workspaceId,
              moment.objectId,
              Number(result.lastInsertRowid),
              moment.momentId,
              moment.versionId,
              moment.path,
              moment.blobSha256,
              moment.contentKind,
              moment.byteLength,
              moment.recordedAtMs,
            );
          }
        }
        if (op.opKind === "version.create") {
          const versionId = versionIdFromVersionCreatePayload(op.payloadJson);
          if (versionId) {
            const shas = referencedBlobShas(op.opKind, op.payloadJson, {
              workspaceId: input.workspaceId,
              recordedAtMs: op.recordedAtMs,
            });
            for (const sha256 of new Set(shas)) {
              versionSnapshotBlobStmt.run(
                input.workspaceId,
                Number(result.lastInsertRowid),
                versionId,
                sha256,
              );
            }
          }
        }
        applyCurrentFileOp(
          currentFileStmt,
          input.workspaceId,
          op.opKind,
          op.payloadJson,
          Number(result.lastInsertRowid),
        );
      }
      return { inserted, skipped, currentMaxOriginSeq: currentMax };
  }

export function maxOriginSeq(storage: StorageContext, workspaceId: string, originId: string): number {
    const row = storage.db
      .prepare(
        `SELECT COALESCE(MAX(origin_seq), -1) AS max_seq
         FROM sync_relay_log WHERE workspace_id = ? AND origin_id = ?`,
      )
      .get(workspaceId, originId);
    return Number(row?.max_seq ?? -1);
  }

export function fetchLogPage(storage: StorageContext, input: {
    workspaceId: string;
    sinceRelaySeq: number;
    limit: number;
  }): FetchLogPageResult {
    const rows = storage.db
      .prepare(
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq
         FROM sync_relay_log
         WHERE workspace_id = ? AND relay_seq > ?
         ORDER BY relay_seq
         LIMIT ?`,
      )
      .all(input.workspaceId, input.sinceRelaySeq, input.limit + 1);
    const pageRows = rows.slice(0, input.limit).map(rowToLogRow);
    const last = pageRows[pageRows.length - 1];
    return {
      rows: pageRows,
      nextCursor: last?.relaySeq ?? input.sinceRelaySeq,
      hasMore: rows.length > input.limit,
    };
  }

export function fetchLogPageDescending(storage: StorageContext, input: {
    workspaceId: string;
    beforeRelaySeq: number | null;
    limit: number;
  }): SyncRelayLogRow[] {
    const rows =
      input.beforeRelaySeq === null
        ? storage.db
            .prepare(
              `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq
               FROM sync_relay_log
               WHERE workspace_id = ?
               ORDER BY relay_seq DESC
               LIMIT ?`,
            )
            .all(input.workspaceId, input.limit)
        : storage.db
            .prepare(
              `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq
               FROM sync_relay_log
               WHERE workspace_id = ? AND relay_seq < ?
               ORDER BY relay_seq DESC
               LIMIT ?`,
            )
            .all(input.workspaceId, input.beforeRelaySeq, input.limit);
    return rows.map(rowToLogRow);
  }

export function fetchLogCoordinate(storage: StorageContext, input: {
    workspaceId: string;
    originId: string;
    originSeq: number;
  }): SyncRelayLogRow | null {
    const row = storage.db
      .prepare(
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq
         FROM sync_relay_log
         WHERE workspace_id = ? AND origin_id = ? AND origin_seq = ?`,
      )
      .get(input.workspaceId, input.originId, input.originSeq);
    return row ? rowToLogRow(row) : null;
  }
