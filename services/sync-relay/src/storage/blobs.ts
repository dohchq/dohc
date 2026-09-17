import { type StorageContext } from "./context";
import { assertWorkspaceQuota } from "./workspaces";
import { type PutBlobResult, type CollectUnreferencedBlobsResult } from "./types";

async function excludeLogReferencedBlobs(
  storage: StorageContext,
  workspaceId: string,
  candidates: string[],
): Promise<string[]> {
  const unreferenced = new Set(candidates.filter((sha) => /^[a-f0-9]{64}$/.test(sha)));
  const referenced = new Set<string>();
  if (unreferenced.size === 0) return candidates;
  // Bound this read-only pass; later roots remain covered by locked deletion.
  const throughSeq = Number(storage.db.prepare(
    "SELECT MAX(relay_seq) AS seq FROM sync_relay_log WHERE workspace_id = ?",
  ).get(workspaceId)?.seq ?? 0);

  // Bound copied text even for a large payload. SQLite substr stops at
  // literal NUL, as LIKE does. Offsets count SQLite characters, not JS UTF-16.
  const TEXT_CHUNK = 32_768;
  const PAGE_ROWS = 32;
  const pageStmt = storage.db.prepare(
    `SELECT relay_seq, substr(payload_json, 1, ?) AS payload
     FROM sync_relay_log WHERE workspace_id = ? AND relay_seq > ? AND relay_seq <= ?
     ORDER BY relay_seq LIMIT ?`,
  );
  const continuationStmt = storage.db.prepare(
    `SELECT substr(payload_json, ?, ?) AS payload
     FROM sync_relay_log WHERE workspace_id = ? AND relay_seq = ?`,
  );
  let afterSeq = 0;
  while (unreferenced.size > 0) {
    const page = pageStmt.all(TEXT_CHUNK, workspaceId, afterSeq, throughSeq, PAGE_ROWS);
    if (page.length === 0) break;
    for (const row of page) {
      let payload = String(row.payload);
      let offset = TEXT_CHUNK + 1;
      let carry = "";
      while (payload.length > 0) {
        const text = carry + payload;
        for (const match of text.matchAll(/[a-fA-F0-9]{64,}/g)) {
          const run = match[0].toLowerCase();
          // LIKE also matches hashes embedded in longer runs, including overlaps.
          for (let start = 0; start <= run.length - 64; start++) {
            const sha = run.slice(start, start + 64);
            if (unreferenced.delete(sha)) referenced.add(sha);
          }
        }
        if (unreferenced.size === 0) break;
        // A short UTF-16 string is necessarily shorter than TEXT_CHUNK SQLite
        // characters. Astral text can require one harmless extra read.
        if (payload.length < TEXT_CHUNK) break;
        carry = text.slice(-63);
        await new Promise<void>((resolve) => setImmediate(resolve));
        payload = String(continuationStmt.get(offset, TEXT_CHUNK, workspaceId, row.relay_seq)?.payload ?? "");
        offset += TEXT_CHUNK;
      }
      if (unreferenced.size === 0) break;
    }
    afterSeq = Number(page[page.length - 1]!.relay_seq);
    if (unreferenced.size > 0 && page.length === PAGE_ROWS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    } else {
      break;
    }
  }
  // Noncanonical storage identifiers retain the original SQL LIKE behavior,
  // including wildcard characters, through the unchanged locked delete check.
  return candidates.filter((sha) => !referenced.has(sha));
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
    // "decline". A settled proposal stops protecting its blobs: an accepted
    // one has them in the log, and a declined one never will.
    // Immutable publications retain their manifest and bundle pins after withdrawal.
    const cutoff = options.nowMs - storage.options.blobGraceMs;
    // Read aged candidates without a write lock, then scan log roots once.
    const agedCandidates = storage.db
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
               AND p.state = 'open'
               AND o.after_blob_sha256 = b.sha256
           )
           AND NOT EXISTS (
             SELECT 1 FROM sync_relay_app_publication_blobs p
             WHERE p.workspace_id = b.workspace_id AND p.sha256 = b.sha256
           )
         ORDER BY b.sha256`,
      )
      .all(workspaceId, cutoff)
      .map((row) => String(row.sha256));
    const candidates = await excludeLogReferencedBlobs(storage, workspaceId, agedCandidates);
    // Each deletion still rechecks every root and age under the write lock.
    // Discovery can yield without granting stale results deletion authority.
    // Yield between committed chunks; each orphan still scans its log history.
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
           WHERE p.workspace_id = ? AND p.state = 'open' AND o.after_blob_sha256 = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM sync_relay_app_publication_blobs p
           WHERE p.workspace_id = sync_relay_blobs.workspace_id AND p.sha256 = sync_relay_blobs.sha256
         )`,
    );
    const CHUNK = 200;
    for (let start = 0; start < candidates.length; start += CHUNK) {
      const chunk = candidates.slice(start, start + CHUNK);
      storage.tx(() => {
        for (const sha256 of chunk) {
          const result = deleteStmt.run(
            workspaceId,
            sha256,
            cutoff,
            workspaceId,
            sha256,
            workspaceId,
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
