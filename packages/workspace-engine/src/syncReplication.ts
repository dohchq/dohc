import { randomUUID } from "node:crypto";
import type {
  EngineWriteLaneConnection,
  PendingConflictResolve as PendingConflictResolveType,
  SyncApplyResult,
  SyncReplicationOpKind,
  WorkspaceId,
} from "@dohc/workspace-contracts/engine";

// The journaling + peer-ack helpers only ever call `db.prepare(...).run/get`, so
// they accept the minimal EngineWriteLaneConnection surface rather than the full
// EngineSqliteDb. This lets the Y.Doc engine driver journal a `ydoc.update` op
// on the store's shared write-lane connection (which is handed to lane tasks as
// EngineWriteLaneConnection) INSIDE the same transaction as the ydoc_updates
// append — every EngineSqliteDb is assignable here, so existing callers are
// unaffected.
type JournalConnection = EngineWriteLaneConnection;

// The per-op payload shapes are contract-owned (they discriminate
// SyncReplicationEnvelope so opKind/payload agreement is compile-checked);
// re-exported here so engine-internal modules keep one import surface.
export type {
  ChatChannelCreatePayload,
  ChatMessageAppendPayload,
  ChatThreadCreatePayload,
  ConflictResolvePayload,
  MomentAppendPayload,
  PendingConflictResolve,
  SecretFileDeletePayload,
  SecretFilePutPayload,
  SecretVersionForkPayload,
  SyncApplyResult,
  SyncMomentBeforePresence,
  SyncReplicationEnvelope,
  SyncReplicationOpKind,
  VersionCreateForkSnapshot,
  VersionCreatePayload,
} from "@dohc/workspace-contracts/engine";

export interface JournalReplicationOpInput {
  workspaceId: WorkspaceId;
  originId: string;
  originSeq: number;
  opKind: SyncReplicationOpKind;
  payload: unknown;
  recordedAtMs: number;
}

export function ensureOriginId(db: JournalConnection, workspaceId: WorkspaceId): string {
  const existing = db
    .prepare("SELECT origin_id FROM sync_identity WHERE workspace_id = ?")
    .get(workspaceId);
  if (typeof existing?.origin_id === "string") return existing.origin_id;
  const originId = `origin_${randomUUID()}`;
  db.prepare("INSERT OR IGNORE INTO sync_identity (workspace_id, origin_id) VALUES (?, ?)").run(
    workspaceId,
    originId,
  );
  const row = db
    .prepare("SELECT origin_id FROM sync_identity WHERE workspace_id = ?")
    .get(workspaceId);
  if (typeof row?.origin_id !== "string") {
    throw new Error(`Failed to initialize sync origin for workspace ${workspaceId}.`);
  }
  return row.origin_id;
}

export function nextOriginSeq(
  db: JournalConnection,
  workspaceId: WorkspaceId,
  originId: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(origin_seq), -1) + 1 AS next_seq
       FROM replication_log
       WHERE workspace_id = ? AND origin_id = ?`,
    )
    .get(workspaceId, originId);
  return Number(row?.next_seq ?? 0);
}

export function journalReplicationOp(
  db: JournalConnection,
  input: JournalReplicationOpInput,
): void {
  db.prepare(
    `INSERT INTO replication_log (
      workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.workspaceId,
    input.originId,
    input.originSeq,
    input.opKind,
    JSON.stringify(input.payload),
    input.recordedAtMs,
  );
}

export function journalLocalReplicationOp(
  db: JournalConnection,
  input: {
    workspaceId: WorkspaceId;
    opKind: SyncReplicationOpKind;
    payload: unknown;
    recordedAtMs: number;
  },
): void {
  const originId = ensureOriginId(db, input.workspaceId);
  journalReplicationOp(db, {
    workspaceId: input.workspaceId,
    originId,
    originSeq: nextOriginSeq(db, input.workspaceId, originId),
    opKind: input.opKind,
    payload: input.payload,
    recordedAtMs: input.recordedAtMs,
  });
}

export function readReplicationAckedSeq(
  db: JournalConnection,
  workspaceId: WorkspaceId,
  originId: string,
): number {
  const row = db
    .prepare("SELECT acked_seq FROM replication_peers WHERE workspace_id = ? AND origin_id = ?")
    .get(workspaceId, originId);
  return Number(row?.acked_seq ?? -1);
}

export function ackReplicationPeer(
  db: JournalConnection,
  workspaceId: WorkspaceId,
  originId: string,
  originSeq: number,
): void {
  db.prepare(
    `INSERT INTO replication_peers (workspace_id, origin_id, acked_seq)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id, origin_id) DO UPDATE SET
       acked_seq = MAX(replication_peers.acked_seq, excluded.acked_seq)`,
  ).run(workspaceId, originId, originSeq);
}

export function skippedApplyResult(): SyncApplyResult {
  return { status: "skipped", conflictsOpened: 0 };
}

export function appliedApplyResult(
  conflictsOpened = 0,
  pendingResolves: PendingConflictResolveType[] = [],
): SyncApplyResult {
  return {
    status: "applied",
    conflictsOpened,
    // Count and identities travel together (0P-C gate fix): the count keeps
    // existing consumers working; the identities let the surfacing layer
    // lifecycle the "needs a look" state instead of accumulating forever.
    ...(pendingResolves.length > 0
      ? { pendingConflictResolves: pendingResolves.length, pendingResolves }
      : {}),
  };
}
