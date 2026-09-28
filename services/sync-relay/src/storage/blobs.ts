import { type StorageContext } from "./context";
import { assertWorkspaceQuota } from "./workspaces";
import { type PutBlobResult, type CollectUnreferencedBlobsResult } from "./types";
import { BLOB_LOG_TEXT_CHUNK, blobLogPayloadChunks, currentBlobLogSequence, isCanonicalBlobSha, removeBlobLogReferences } from "./blobLogRoots";

const DIRECT_SQL_INVENTORY_LIMIT = 16;

async function excludeLogReferencedBlobs(
  storage: StorageContext,
  workspaceId: string,
  remaining: Set<string>,
): Promise<string[]> {
  if (remaining.size === 0) return [];
  if (remaining.size <= DIRECT_SQL_INVENTORY_LIMIT) {
    // A few LIKE probes avoid copying a large raw payload into JavaScript.
    const reference = storage.db.prepare(`SELECT 1 FROM sync_relay_log
      WHERE workspace_id = ? AND payload_json LIKE '%' || ? || '%' LIMIT 1`);
    for (const sha of remaining) {
      if (reference.get(workspaceId, sha) !== undefined) remaining.delete(sha);
    }
    return Array.from(remaining);
  }
  let canonicalRemaining = 0;
  for (const sha of remaining) {
    if (isCanonicalBlobSha(sha)) canonicalRemaining++;
  }
  if (canonicalRemaining === 0) return Array.from(remaining);
  // Bound this read-only pass; later roots remain covered by locked deletion.
  const throughSeq = currentBlobLogSequence(storage.db, workspaceId);
  let pieces = 0;
  let characters = 0;
  for (const payload of blobLogPayloadChunks(storage.db, workspaceId, throughSeq)) {
    canonicalRemaining -= removeBlobLogReferences(remaining, payload);
    if (canonicalRemaining === 0) break;
    characters += payload.length;
    if (++pieces >= 32 || characters >= BLOB_LOG_TEXT_CHUNK) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      pieces = 0;
      characters = 0;
    }
  }
  // Noncanonical storage identifiers retain the original SQL LIKE behavior,
  // including wildcard characters, through the unchanged locked delete check.
  return Array.from(remaining);
}

export function putBlob(storage: StorageContext, input: {
    workspaceId: string;
    sha256: string;
    content: Uint8Array;
    createdAtMs: number;
  }): PutBlobResult {
    const byteLength = input.content.byteLength;
    return storage.tx(() => {
      const existing = storage.db
        .prepare(
          "SELECT 1 AS ok FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ?",
        )
        .get(input.workspaceId, input.sha256);
      if (existing !== undefined) {
        return { byteLength, alreadyHad: true };
      }
      assertWorkspaceQuota(storage, input.workspaceId, byteLength);
      storage.db
        .prepare(
          `INSERT INTO sync_relay_blobs (workspace_id, sha256, byte_length, content, created_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.workspaceId,
          input.sha256,
          byteLength,
          Buffer.from(input.content),
          Math.trunc(input.createdAtMs),
        );
      return { byteLength, alreadyHad: false };
    });
  }

export async function collectUnreferencedBlobs(
    storage: StorageContext,
    workspaceId: string,
    options: { nowMs: number },
  ): Promise<CollectUnreferencedBlobsResult> {
    // Grace window (item 4): never reclaim a blob younger than blobGraceMs, so
    // a blob uploaded just before its referencing log op is appended survives
    // the gap between the two phases. cutoff is the newest created_at_ms still
    // eligible for collection.
    //
    // An open proposal's content is referenced too, and the log
    // cannot say so — a proposed change is not in the log, which is the whole
    // point of holding it. Without this second clause a proposal left open
    // past the grace window would lose its content to the sweep and could
    // never be accepted, so the granter's only honest answer would be
    // "decline". Removal receipts retain declined proposals during Undo.
    // Immutable publications retain their manifest and bundle pins after withdrawal.
    const cutoff = options.nowMs - storage.options.blobGraceMs;
    const retainedProposal = `(p.state = 'open' OR EXISTS (
      SELECT 1 FROM sync_relay_share_removals r, json_each(r.proposals_json) proposal
      WHERE r.share_id = p.share_id AND r.undone = 0 AND r.voided = 0
        AND r.expires_at_ms > ? AND proposal.value = p.proposal_id
    ))`;
    // Read aged candidates without a write lock, then scan log roots once.
    const agedCandidates = new Set<string>();
    const agedRows = storage.db
      .prepare(
        `SELECT b.sha256
         FROM sync_relay_blobs b
         WHERE b.workspace_id = ?
           AND b.created_at_ms <= ?
           AND NOT EXISTS (
             SELECT 1
             FROM sync_relay_share_proposal_ops o
             JOIN sync_relay_share_proposals p ON p.proposal_id = o.proposal_id
             WHERE p.workspace_id = b.workspace_id
               AND ${retainedProposal}
               AND o.after_blob_sha256 = b.sha256
           )
           AND NOT EXISTS (
             SELECT 1 FROM sync_relay_app_publication_blobs p
             WHERE p.workspace_id = b.workspace_id AND p.sha256 = b.sha256
           )
         ORDER BY b.sha256`,
      )
      .iterate(workspaceId, cutoff, options.nowMs);
    for (const row of agedRows) agedCandidates.add(String(row.sha256));
    const smallInventory = agedCandidates.size <= DIRECT_SQL_INVENTORY_LIMIT;
    const candidates = await excludeLogReferencedBlobs(storage, workspaceId, agedCandidates);
    if (candidates.length === 0) return { removed: 0, removedSha256s: [] };
    // Discovery never grants deletion authority. Each transaction reads current
    // log roots before deletion and keeps proposal, publication, and age checks.
    const removedSha256s: string[] = [];
    const deleteStmt = storage.db.prepare(
      `DELETE FROM sync_relay_blobs
       WHERE workspace_id = ? AND sha256 = ? AND created_at_ms <= ?
         AND NOT EXISTS (
           SELECT 1
           FROM sync_relay_log l
           WHERE l.workspace_id = ?
             AND l.payload_json LIKE '%' || ? || '%'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM sync_relay_share_proposal_ops o
           JOIN sync_relay_share_proposals p ON p.proposal_id = o.proposal_id
           WHERE p.workspace_id = ? AND ${retainedProposal} AND o.after_blob_sha256 = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM sync_relay_app_publication_blobs p
           WHERE p.workspace_id = sync_relay_blobs.workspace_id AND p.sha256 = sync_relay_blobs.sha256
         )`,
    );
    const deleteScannedStmt = !smallInventory && candidates.length > 1 ? storage.db.prepare(
      `DELETE FROM sync_relay_blobs
       WHERE workspace_id = ? AND sha256 = ? AND created_at_ms <= ?
         AND NOT EXISTS (
           SELECT 1 FROM sync_relay_share_proposal_ops o
           JOIN sync_relay_share_proposals p ON p.proposal_id = o.proposal_id
           WHERE p.workspace_id = ? AND ${retainedProposal} AND o.after_blob_sha256 = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM sync_relay_app_publication_blobs p
           WHERE p.workspace_id = sync_relay_blobs.workspace_id AND p.sha256 = sync_relay_blobs.sha256
         )`,
    ) : null;
    const CHUNK = 200;
    for (let start = 0; start < candidates.length; start += CHUNK) {
      const chunk = candidates.slice(start, start + CHUNK);
      storage.tx(() => {
        const unreferenced = new Set(chunk.filter(isCanonicalBlobSha));
        // One canonical candidate already needs only one SQL scan.
        const bulk = deleteScannedStmt !== null && unreferenced.size > 1;
        if (bulk) {
          const throughSeq = currentBlobLogSequence(storage.db, workspaceId);
          for (const payload of blobLogPayloadChunks(storage.db, workspaceId, throughSeq)) {
            removeBlobLogReferences(unreferenced, payload);
            if (unreferenced.size === 0) break;
          }
        }
        for (const sha256 of chunk) {
          const scanned = bulk && isCanonicalBlobSha(sha256);
          if (scanned && !unreferenced.has(sha256)) continue;
          const result = scanned ? deleteScannedStmt!.run(workspaceId, sha256, cutoff, workspaceId, options.nowMs, sha256) : deleteStmt.run(
            workspaceId,
            sha256,
            cutoff,
            workspaceId,
            sha256,
            workspaceId,
            options.nowMs,
            sha256,
          );
          if (result.changes > 0) removedSha256s.push(sha256);
        }
      });
      if (start + CHUNK < candidates.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return { removed: removedSha256s.length, removedSha256s };
  }

export function getBlob(storage: StorageContext, workspaceId: string, sha256: string): Uint8Array | null {
    const row = storage.db
      .prepare(
        "SELECT content FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ?",
      )
      .get(workspaceId, sha256);
    const content = row?.content;
    if (Buffer.isBuffer(content)) return content;
    if (content instanceof Uint8Array) return Buffer.from(content);
    return null;
  }

export function missingBlobs(storage: StorageContext, workspaceId: string, sha256s: string[]): string[] {
    if (sha256s.length === 0) return [];
    // Batch the presence check into chunked `IN (...)` queries instead of one
    // point SELECT per hash (was up to ~2,000 sequential round trips). Dedupe
    // the probe set but preserve the caller's order/duplicates in the result.
    const unique = [...new Set(sha256s)];
    const found = new Set<string>();
    // Keep well under SQLite's default 999 bound-variable limit (one slot is
    // taken by workspace_id).
    const CHUNK = 500;
    for (let start = 0; start < unique.length; start += CHUNK) {
      const chunk = unique.slice(start, start + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = storage.db
        .prepare(
          `SELECT sha256 FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 IN (${placeholders})`,
        )
        .all(workspaceId, ...chunk);
      for (const row of rows) {
        if (typeof row.sha256 === "string") found.add(row.sha256);
      }
    }
    return sha256s.filter((sha256) => !found.has(sha256));
  }
