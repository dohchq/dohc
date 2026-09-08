import { type StorageContext } from "./context";
import { type ShareProposalOpRow, type ShareProposalRow, type ShareProposalState } from "./types";
import { rowToProposalRow, rowToProposalOpRow } from "./rows";

export function insertShareProposal(storage: StorageContext, input: {
    proposalId: string;
    shareId: string;
    workspaceId: string;
    proposedByUserId: string;
    versionId: string;
    submitId: string;
    createdAtMs: number;
    ops: ShareProposalOpRow[];
    guard?: () => void;
  }): { proposalId: string; created: boolean } {
    return storage.tx(() => {
      // The same posture appendLogBatch takes: the caller's authorization is
      // re-run under the write lock, so a revoke or a level narrowed
      // mid-flight loses the race rather than slipping a submit through.
      input.guard?.();
      const existing = storage.db
        .prepare(
          "SELECT proposal_id FROM sync_relay_share_proposals WHERE share_id = ? AND submit_id = ?",
        )
        .get(input.shareId, input.submitId);
      if (existing) {
        return { proposalId: String(existing.proposal_id), created: false };
      }
      storage.db
        .prepare(
          `INSERT INTO sync_relay_share_proposals (
            proposal_id, share_id, workspace_id, proposed_by_user_id, version_id,
            submit_id, state, created_at_ms, settled_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
        )
        .run(
          input.proposalId,
          input.shareId,
          input.workspaceId,
          input.proposedByUserId,
          input.versionId,
          input.submitId,
          Math.trunc(input.createdAtMs),
        );
      const insertOp = storage.db.prepare(
        `INSERT INTO sync_relay_share_proposal_ops (
          proposal_id, op_index, based_on_path, based_on_object_id, based_on_blob_sha256,
          operation, after_path, after_blob_sha256, after_content_kind, after_byte_length,
          recorded_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const op of input.ops) {
        insertOp.run(
          input.proposalId,
          op.opIndex,
          op.basedOnPath,
          op.basedOnObjectId,
          op.basedOnBlobSha256,
          op.operation,
          op.afterPath,
          op.afterBlobSha256,
          op.afterContentKind,
          op.afterByteLength,
          Math.trunc(op.recordedAtMs),
        );
      }
      return { proposalId: input.proposalId, created: true };
    });
  }

export function getShareProposal(
    storage: StorageContext,
    proposalId: string,
  ): (ShareProposalRow & { ops: ShareProposalOpRow[] }) | null {
    const row = storage.db
      .prepare(
        `SELECT proposal_id, share_id, workspace_id, proposed_by_user_id, version_id,
                state, created_at_ms, settled_at_ms
         FROM sync_relay_share_proposals WHERE proposal_id = ?`,
      )
      .get(proposalId);
    if (!row) return null;
    return { ...rowToProposalRow(row), ops: proposalOps(storage, proposalId) };
  }

export function listShareProposalsForShare(storage: StorageContext, shareId: string): Array<ShareProposalRow & { opCount: number }> {
    return storage.db
      .prepare(
        `SELECT p.proposal_id, p.share_id, p.workspace_id, p.proposed_by_user_id, p.version_id,
                p.state, p.created_at_ms, p.settled_at_ms,
                (SELECT COUNT(*) FROM sync_relay_share_proposal_ops o
                  WHERE o.proposal_id = p.proposal_id) AS op_count
         FROM sync_relay_share_proposals p
         WHERE p.share_id = ?
         ORDER BY p.created_at_ms DESC, p.proposal_id`,
      )
      .all(shareId)
      .map((row) => ({ ...rowToProposalRow(row), opCount: Number(row.op_count ?? 0) }));
  }

export function listShareProposalsForWorkspace(
    storage: StorageContext,
    workspaceId: string,
  ): Array<ShareProposalRow & { opCount: number }> {
    return storage.db
      .prepare(
        `SELECT p.proposal_id, p.share_id, p.workspace_id, p.proposed_by_user_id, p.version_id,
                p.state, p.created_at_ms, p.settled_at_ms,
                (SELECT COUNT(*) FROM sync_relay_share_proposal_ops o
                  WHERE o.proposal_id = p.proposal_id) AS op_count
         FROM sync_relay_share_proposals p
         WHERE p.workspace_id = ? AND p.state = 'open'
         ORDER BY p.created_at_ms, p.proposal_id`,
      )
      .all(workspaceId)
      .map((row) => ({ ...rowToProposalRow(row), opCount: Number(row.op_count ?? 0) }));
  }

export function settleShareProposal(
    storage: StorageContext,
    proposalId: string,
    to: Exclude<ShareProposalState, "open">,
    settledAtMs: number,
  ): boolean {
    return storage.tx(() =>
      storage.settleShareProposalInTransaction(proposalId, to, settledAtMs),
    );
  }

export function settleShareProposalInTransaction(
    storage: StorageContext,
    proposalId: string,
    to: Exclude<ShareProposalState, "open">,
    settledAtMs: number,
  ): boolean {
    // `state = 'open'` in the WHERE is the whole concurrency answer: the row
    // moves exactly once, and every later mover sees zero changed rows.
    const result = storage.db
      .prepare(
        `UPDATE sync_relay_share_proposals
         SET state = ?, settled_at_ms = ?
         WHERE proposal_id = ? AND state = 'open'`,
      )
      .run(to, Math.trunc(settledAtMs), proposalId);
    return Number(result.changes ?? 0) > 0;
  }

export function proposalOps(storage: StorageContext, proposalId: string): ShareProposalOpRow[] {
    return storage.db
      .prepare(
        `SELECT op_index, based_on_path, based_on_object_id, based_on_blob_sha256, operation,
                after_path, after_blob_sha256, after_content_kind, after_byte_length,
                recorded_at_ms
         FROM sync_relay_share_proposal_ops
         WHERE proposal_id = ?
         ORDER BY op_index`,
      )
      .all(proposalId)
      .map(rowToProposalOpRow);
  }
