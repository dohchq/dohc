import {commitHostedSettlement,settlementResponseIdentifier} from "./hostedSettlement";
import { type StorageContext } from "./context";
import { enforceWorkspaceIdentityInTransaction, assertWorkspaceQuota } from "./workspaces";
import {
  type SyncRelayLogInput,
  type AppendLogBatchGuardContext,
  type AppendLogBatchResult,
  type FetchLogPageResult,
  type RedundantRecovery,
  type SyncRelayLogRow,
  type SqliteDb,
} from "./types";
import { asRecord } from "@dohc/workspace-core";
import { SyncRelayConflictError, logBlobsMissing } from "./errors";
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
import { notifyDesktopReadiness } from "../desktopReadinessChanges";
import {confirmLiveApplication} from "./liveApplicationAuthorship";
import {REFUSED_OP_KIND} from "./relayAdmission";
import { parseLiveAuthorSnapshot, type LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import { SHARE_MEMBER_ORIGIN_PREFIX } from "../relayLogInputs";
import { stableJsonStringify } from "../canonicalJson";

function withAdmittedChatName(op: SyncRelayLogInput, snapshot: LiveAuthorSnapshot): SyncRelayLogInput {
  const human = snapshot.find(author => author.kind === "human");
  if (!human) throw new Error("named chat admission requires an account author");
  const payload = JSON.parse(op.payloadJson) as Record<string, unknown>;
  if (op.opKind === "chat.reaction.set" || payload.authorKind === "human") {
    payload.authorDisplayName = human.humanName;
    delete payload.authorOwnerDisplayName;
  } else {
    payload.authorOwnerDisplayName = human.humanName;
  }
  return {...op, payloadJson: stableJsonStringify(payload), admittedAuthorSnapshot: snapshot};
}

const logPageStatements = new WeakMap<SqliteDb, ReturnType<SqliteDb["prepare"]>>();

/** Every copy of retained work's creation moment ID starts with this. */
export const RELEASED_COPY_MOMENT_PREFIX = "released-copy-moment-";

/**
 * A copy of retained work's creation, by what identical creations on two
 * devices share: version, object, moment, bytes, length and correlation, a
 * new text object, and exactly the same authors as each push left them.
 * Recording time and path are left out.
 */
function releasedCopyCreation(payloadJson: string): {objectId: string; momentId: string; key: string} | null {
  let payload: Record<string, unknown> | null;
  try {
    payload = asRecord(JSON.parse(payloadJson));
  } catch {
    return null;
  }
  const metadata = asRecord(payload?.metadata);
  if (!payload || typeof payload.momentId !== "string" || !payload.momentId.startsWith(RELEASED_COPY_MOMENT_PREFIX) ||
    typeof payload.objectId !== "string" || payload.operation !== "write" ||
    (payload.beforePresent !== "absent" && payload.beforePresent !== "null") ||
    (payload.payloadAfterContentKind != null && payload.payloadAfterContentKind !== "text") ||
    typeof metadata?.correlationId !== "string" || !/^[0-9a-f]{64}$/.test(metadata.correlationId)) return null;
  return {objectId: payload.objectId, momentId: payload.momentId, key: stableJsonStringify([payload.versionId, payload.objectId,
    payload.momentId, payload.payloadAfterBlobSha256, payload.payloadAfterByteLength, metadata.correlationId,
    payload.authors ?? null, payload.attributionUnavailable ?? null])};
}

export function appendLogBatch(storage: StorageContext, input: {
    workspaceId: string;
    originId: string;
    ops: SyncRelayLogInput[];
    guard?: (context: AppendLogBatchGuardContext) => void;
    admit?: (ops: SyncRelayLogInput[]) => void;
    confirm?: (ops: SyncRelayLogInput[]) => void;
    classifyRedundantRecoveries?: boolean;
  }): AppendLogBatchResult {
    return storage.tx(() => appendLogBatchInTransaction(storage, input));
  }

/** Internal append for callers already holding the relay write transaction. */
export function appendLogBatchInTransaction(storage: StorageContext, input: {
  workspaceId: string;
  originId: string;
  ops: SyncRelayLogInput[];
  guard?: (context: AppendLogBatchGuardContext) => void;
  admit?: (ops: SyncRelayLogInput[]) => void;
  confirm?: (ops: SyncRelayLogInput[]) => void;
  classifyRedundantRecoveries?: boolean;
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
        `SELECT op_kind, payload_json, recorded_at_ms, settlement_admission_json, admitted_author_snapshot_json
         FROM sync_relay_log
         WHERE workspace_id = ? AND origin_id = ? AND origin_seq = ?`,
      );
      // Read the current MAX(origin_seq) once, then track it locally: each
      // insert is exactly currentMax + 1, so re-querying per op (was N extra
      // SELECTs per batch) is unnecessary. Skipped ops leave it unchanged.
      let currentMax = Number(
        maxStmt.get(input.workspaceId, input.originId)?.max_seq ?? -1,
      );
      // The log's first accepted creation of a copy is its only projected one,
      // so the first object moment with its ID names it, on every retry alike.
      const redundant = new Map<number, RedundantRecovery>();
      const firstCreationStmt = input.classifyRedundantRecoveries ? storage.db.prepare(
        `SELECT l.origin_id, l.origin_seq, l.relay_seq, l.payload_json
         FROM sync_relay_object_moments m JOIN sync_relay_log l ON l.relay_seq = m.relay_seq
         WHERE m.workspace_id = ? AND m.object_id = ? AND m.moment_id = ?
           AND l.op_kind = 'moment.append' AND l.relay_admission IS NULL
         ORDER BY m.relay_seq LIMIT 1`,
      ) : undefined;
      const classify = (op: SyncRelayLogInput) => {
        if (!firstCreationStmt || op.opKind !== "moment.append") return;
        const creation = releasedCopyCreation(op.payloadJson);
        if (!creation) return;
        const first = firstCreationStmt.get(input.workspaceId, creation.objectId, creation.momentId);
        if (!first || (first.origin_id === input.originId && Number(first.origin_seq) === op.originSeq)) return;
        if (releasedCopyCreation(String(first.payload_json))?.key !== creation.key) return;
        redundant.set(op.originSeq, {originSeq: op.originSeq, recoveryMomentId: creation.momentId,
          acceptedOriginId: String(first.origin_id), acceptedOriginSeq: Number(first.origin_seq), acceptedRelaySeq: Number(first.relay_seq)});
      };
      for (const inputOp of input.ops) {
        const admittedChat = input.originId.startsWith(SHARE_MEMBER_ORIGIN_PREFIX) &&
          (inputOp.opKind === "chat.message.append" || inputOp.opKind === "chat.reaction.set") &&
          inputOp.admittedAuthorSnapshot !== undefined;
        let op = admittedChat ? withAdmittedChatName(inputOp, inputOp.admittedAuthorSnapshot!) : inputOp;
        if (op.originSeq <= currentMax) {
          const existing = existingStmt.get(
            input.workspaceId,
            input.originId,
            op.originSeq,
          );
          // Account names belong to the first admission, even after a rename.
          if (admittedChat && existing?.admitted_author_snapshot_json != null) {
            op = withAdmittedChatName(inputOp, parseLiveAuthorSnapshot(JSON.parse(String(existing.admitted_author_snapshot_json))));
          }
          if (
            existing &&
            existing.op_kind === op.opKind &&
            existing.payload_json === op.payloadJson &&
            existing.settlement_admission_json === (op.settlementAdmission === undefined ? null : JSON.stringify(op.settlementAdmission)) &&
            Number(existing.recorded_at_ms) === op.recordedAtMs
          ) {
            skipped += 1;
            classify(op);
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
        classify(op);
        newOps.push(op);
        addedLogBytes += Buffer.byteLength(op.payloadJson, "utf8");
        if (op.admittedAuthorSnapshot !== undefined) {
          addedLogBytes += Buffer.byteLength(JSON.stringify(op.admittedAuthorSnapshot), "utf8");
        }
      }

      input.admit?.(newOps);
      for (const op of newOps) {
        // Only the relay writes a refusal, and only as one.
        if ((op.opKind === REFUSED_OP_KIND) !== (op.relayAdmission === "refused")) {
          throw new Error(`${REFUSED_OP_KIND} rows are written only by the relay`);
        }
      }

      let batchCoordinates: Map<number, SyncRelayLogInput> | undefined;
      for (const op of newOps) {
        commitHostedSettlement(storage, op, input.workspaceId, input.originId);
        if (op.opKind === "live.audit.application") {
          batchCoordinates ??= new Map(newOps.map(entry => [entry.originSeq, entry]));
          confirmLiveApplication(storage, op, input.workspaceId, input.originId, batchCoordinates);
        }
      }
      input.confirm?.(newOps);
      addedLogBytes=newOps.reduce((bytes,op)=>bytes+Buffer.byteLength(op.payloadJson)+
        (op.admittedAuthorSnapshot===undefined?0:Buffer.byteLength(JSON.stringify(op.admittedAuthorSnapshot)))+
        (op.settlementAdmission===undefined?0:Buffer.byteLength(JSON.stringify(op.settlementAdmission))),0);
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
        if(op.settlementAdmission?.status === "refused")continue;
        for (const sha of referencedBlobShas(op.opKind, op.payloadJson, {
          workspaceId: input.workspaceId,
          recordedAtMs: op.recordedAtMs,
        })) {
          referencedShas.add(sha);
        }
      }
      if (referencedShas.size > 0) {
        const missing = storage.missingBlobs(input.workspaceId, [...referencedShas]);
        if (missing.length > 0) throw logBlobsMissing(missing);
      }

      const insertStmt = storage.db.prepare(
        `INSERT INTO sync_relay_log (
          workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, admitted_author_snapshot_json, settlement_admission_json,
          relay_admission
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          op.admittedAuthorSnapshot === undefined ? null : JSON.stringify(op.admittedAuthorSnapshot),
          op.settlementAdmission === undefined ? null : JSON.stringify(op.settlementAdmission),
          op.relayAdmission ?? null,
        );
        inserted += 1;
        // A departed publication must move neither projection: either one
        // alone would bring the document back where it no longer is. A
        // redundant copy keeps the accepted creation's object, path and file.
        if(op.settlementAdmission?.status === "refused" || op.relayAdmission !== undefined || redundant.has(op.originSeq))continue;
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
            if (moment.versionId === "main" && moment.path !== null) notifyDesktopReadiness(storage, {workspaceId: input.workspaceId, path: moment.path});
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
      const settlementRefusals=input.ops.filter(op=>op.settlementAdmission?.status === "refused").map(op=>({originId:input.originId,originSeq:op.originSeq,
        momentId:settlementResponseIdentifier((JSON.parse(op.payloadJson) as Record<string,unknown>).momentId),settlementId:op.settlementAdmission!.settlementId,reason:"authorship-mismatch"}));
      return { inserted, skipped, currentMaxOriginSeq: currentMax,...(settlementRefusals.length?{settlementRefusals}:{}),
        ...(redundant.size ? {redundantRecoveries: [...redundant.values()]} : {}) };
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
    let statement = logPageStatements.get(storage.db);
    if (!statement) {
      statement = storage.db.prepare(
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq, admitted_author_snapshot_json, settlement_admission_json, relay_admission
         FROM sync_relay_log
         WHERE workspace_id = ? AND relay_seq > ?
         ORDER BY relay_seq
         LIMIT ?`,
      );
      logPageStatements.set(storage.db, statement);
    }
    const rows = statement.all(input.workspaceId, input.sinceRelaySeq, input.limit + 1);
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
              `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq, admitted_author_snapshot_json, settlement_admission_json, relay_admission
               FROM sync_relay_log
               WHERE workspace_id = ?
               ORDER BY relay_seq DESC
               LIMIT ?`,
            )
            .all(input.workspaceId, input.limit)
        : storage.db
            .prepare(
              `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq, admitted_author_snapshot_json, settlement_admission_json, relay_admission
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
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq, admitted_author_snapshot_json, settlement_admission_json, relay_admission
         FROM sync_relay_log
         WHERE workspace_id = ? AND origin_id = ? AND origin_seq = ?`,
      )
      .get(input.workspaceId, input.originId, input.originSeq);
    return row ? rowToLogRow(row) : null;
  }

export function hasRefusedSettlement(storage: StorageContext, input: {
  workspaceId: string; originId: string; originSeq: number;
  settlementId: string; momentId: string; reason: string;
}): boolean {
  return storage.db.prepare(`SELECT 1 FROM sync_relay_log
    WHERE workspace_id=? AND origin_id=? AND origin_seq<? AND op_kind='moment.append'
      AND json_extract(settlement_admission_json,'$.status')='refused'
      AND json_extract(settlement_admission_json,'$.settlementId')=?
      AND json_extract(settlement_admission_json,'$.reason')=?
      AND json_extract(payload_json,'$.momentId')=? LIMIT 1`)
    .get(input.workspaceId,input.originId,input.originSeq,input.settlementId,input.reason,input.momentId) !== undefined;
}

export const CHAT_HISTORY_SCAN_WINDOW = 2_000;
export const CHAT_HISTORY_SCAN_BYTES = 4 * 1024 * 1024;

export function fetchChatMessages(storage: StorageContext, input: {
  workspaceId: string; channelWireId: string; cursor: number | null; direction: "older" | "newer"; limit: number;
}): FetchLogPageResult & {latestCursor: number} {
  const older = input.direction === "older";
  const coordinates = storage.db.prepare(`SELECT relay_seq, octet_length(payload_json) AS payload_bytes FROM sync_relay_log
    WHERE workspace_id = ? ${input.cursor === null ? "" : `AND relay_seq ${older ? "<" : ">"} ?`}
    ORDER BY relay_seq ${older ? "DESC" : "ASC"} LIMIT ?`)
    .iterate(input.workspaceId, ...(input.cursor === null ? [] : [input.cursor]), CHAT_HISTORY_SCAN_WINDOW);
  const window: number[] = [];
  let payloadBytes = 0, byteLimited = false;
  for (const row of coordinates) {
    const bytes = Number(row.payload_bytes);
    if (window.length > 0 && payloadBytes + bytes > CHAT_HISTORY_SCAN_BYTES) {byteLimited = true; break;}
    window.push(Number(row.relay_seq));
    payloadBytes += bytes;
    if (payloadBytes >= CHAT_HISTORY_SCAN_BYTES) {byteLimited = true; break;}
  }
  if (window.length === 0) return {rows: [], nextCursor: input.cursor ?? 0, latestCursor: input.cursor ?? 0, hasMore: false};
  const first = window[0]!, edge = window[window.length - 1]!;
  const matches = storage.db.prepare(`WITH window_messages AS MATERIALIZED (
      SELECT m.* FROM sync_relay_log m
      WHERE m.workspace_id = ? AND m.relay_seq BETWEEN ? AND ?
        AND m.op_kind = 'chat.message.append' AND json_valid(m.payload_json)
    ), window_threads AS MATERIALIZED (
      SELECT DISTINCT json_extract(payload_json, '$.threadId') AS thread_id FROM window_messages
    ), channel_threads AS MATERIALIZED (
      SELECT w.thread_id FROM window_threads w
      WHERE json_extract((SELECT t.payload_json FROM sync_relay_log t
        WHERE t.workspace_id = ? AND t.op_kind = 'chat.thread.create' AND json_valid(t.payload_json)
          AND json_extract(t.payload_json, '$.threadId') = w.thread_id
        ORDER BY t.relay_seq LIMIT 1), '$.channelWireId') = ?
    )
    SELECT * FROM window_messages
    WHERE json_extract(payload_json, '$.threadId') IN (SELECT thread_id FROM channel_threads)
    ORDER BY relay_seq ${older ? "DESC" : "ASC"} LIMIT ?`)
    .all(input.workspaceId, Math.min(first, edge), Math.max(first, edge), input.workspaceId, input.channelWireId, input.limit + 1);
  const rows = matches.slice(0, input.limit).map(rowToLogRow);
  const truncated = matches.length > input.limit;
  return {rows, nextCursor: truncated ? rows[rows.length - 1]!.relaySeq : edge,
    latestCursor: Math.max(first, edge), hasMore: truncated || byteLimited || window.length === CHAT_HISTORY_SCAN_WINDOW};
}

export function fetchChatMessage(storage: StorageContext, input: {
  workspaceId: string; originId: string; messageId: string;
}): SyncRelayLogRow | null {
  const row = storage.db.prepare(`SELECT * FROM sync_relay_log
    WHERE workspace_id = ? AND origin_id = ? AND op_kind = 'chat.message.append'
      AND json_extract(payload_json, '$.messageId') = ? ORDER BY relay_seq LIMIT 1`)
    .get(input.workspaceId, input.originId, input.messageId);
  return row ? rowToLogRow(row) : null;
}

export function appendBrowserChatBatch(storage: StorageContext, input: {
  workspaceId: string; originId: string; messageId: string; ops: SyncRelayLogInput[];
  guard?: (context: AppendLogBatchGuardContext) => void;
}): AppendLogBatchResult {
  return storage.tx(() => {
    const existing = fetchChatMessage(storage, input);
    const storedPayload = existing ? JSON.parse(existing.payloadJson) as Record<string, unknown> : null;
    if (existing) {
      const previous = fetchLogCoordinate(storage, {...input, originSeq: existing.originSeq - 1});
      const createdThread = previous?.opKind === "chat.thread.create" &&
        (JSON.parse(previous.payloadJson) as {threadId?: unknown}).threadId ===
        (JSON.parse(existing.payloadJson) as {threadId?: unknown}).threadId;
      if (input.ops.length !== (createdThread ? 2 : 1)) {
        throw new SyncRelayConflictError("retry changes thread creation");
      }
    }
    const firstSequence = existing ? existing.originSeq - input.ops.length + 1 : Number(storage.db.prepare(
      `SELECT COALESCE(MAX(origin_seq), -1) AS seq FROM sync_relay_log WHERE workspace_id = ? AND origin_id = ?`,
    ).get(input.workspaceId, input.originId)?.seq ?? -1) + 1;
    const ops = input.ops.map((op, index) => {
      const payload = JSON.parse(op.payloadJson) as Record<string, unknown>;
      const recordedAtMs = existing?.recordedAtMs ?? op.recordedAtMs;
      return {...op, originSeq: firstSequence + index, recordedAtMs,
        payloadJson: JSON.stringify({...payload, createdAtMs: recordedAtMs,
          ...(storedPayload && op.opKind === "chat.message.append" ?
            payload.authorKind === "human" ? {authorDisplayName: storedPayload.authorDisplayName} :
              {authorOwnerDisplayName: storedPayload.authorOwnerDisplayName} : {})})};
    });
    return appendLogBatchInTransaction(storage, {...input, ops});
  });
}
