import type { SqliteDb } from "./types";

export const BLOB_LOG_TEXT_CHUNK = 32_768;
const PAGE_ROWS = 32;

export function isCanonicalBlobSha(sha: string): boolean {
  return sha.length === 64 && /^[a-f0-9]{64}$/.test(sha);
}

export function removeBlobLogReferences(remaining: Set<string>, payload: string | null): number {
  if (payload === null) return 0;
  if (typeof payload !== "string") throw new TypeError("blob log payload must be text");
  const nul = payload.indexOf("\0");
  const text = nul < 0 ? payload : payload.slice(0, nul);
  let removed = 0;
  for (const match of text.matchAll(/[a-fA-F0-9]{64,}/g)) {
    const run = match[0].toLowerCase();
    for (let start = 0; start <= run.length - 64; start++) {
      if (remaining.delete(run.slice(start, start + 64))) removed++;
    }
  }
  return removed;
}

export function currentBlobLogSequence(db: SqliteDb, workspaceId: string): number | null {
  const row = db.prepare("SELECT MAX(relay_seq) AS seq FROM sync_relay_log WHERE workspace_id = ?").get(workspaceId);
  if (row?.seq === null) return null;
  if (typeof row?.seq !== "number" || !Number.isSafeInteger(row.seq)) {
    throw new TypeError("invalid blob log sequence");
  }
  return row.seq;
}

// Every statement completes before yielding a bounded piece to the caller.
// A synchronous consumer never yields the event loop or leaves its transaction.
export function* blobLogPayloadChunks(db: SqliteDb, workspaceId: string, throughSeq: number | null): Generator<string> {
  if (throughSeq === null) return;
  const firstPage = db.prepare(`SELECT relay_seq, substr(payload_json, 1, ?) AS payload
    FROM sync_relay_log WHERE workspace_id = ? AND relay_seq <= ? ORDER BY relay_seq LIMIT ?`);
  const nextPage = db.prepare(`SELECT relay_seq, substr(payload_json, 1, ?) AS payload
    FROM sync_relay_log WHERE workspace_id = ? AND relay_seq > ? AND relay_seq <= ? ORDER BY relay_seq LIMIT ?`);
  const continuation = db.prepare(`SELECT substr(payload_json, ?, ?) AS payload
    FROM sync_relay_log WHERE workspace_id = ? AND relay_seq = ?`);
  let afterSeq: number | null = null;
  while (true) {
    const page: Array<Record<string, unknown>> = afterSeq === null
      ? firstPage.all(BLOB_LOG_TEXT_CHUNK, workspaceId, throughSeq, PAGE_ROWS)
      : nextPage.all(BLOB_LOG_TEXT_CHUNK, workspaceId, afterSeq, throughSeq, PAGE_ROWS);
    if (page.length === 0) return;
    for (const row of page) {
      let payload = row.payload;
      let offset = BLOB_LOG_TEXT_CHUNK + 1;
      let carry = "";
      while (true) {
        if (typeof payload !== "string") throw new TypeError("blob log payload must be text");
        if (payload.length === 0) break;
        const text = carry + payload;
        yield text;
        if (payload.length < BLOB_LOG_TEXT_CHUNK) break;
        carry = text.slice(-63);
        const part = continuation.get(offset, BLOB_LOG_TEXT_CHUNK, workspaceId, row.relay_seq);
        if (part === undefined) break;
        payload = part.payload;
        offset += BLOB_LOG_TEXT_CHUNK;
      }
    }
    const sequence = page[page.length - 1]!.relay_seq;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || (afterSeq !== null && sequence <= afterSeq)) {
      throw new TypeError("invalid blob log page sequence");
    }
    afterSeq = sequence;
    if (page.length < PAGE_ROWS) return;
  }
}
