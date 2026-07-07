import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export interface SyncRelayLogInput {
  originSeq: number;
  opKind: string;
  payloadJson: string;
  recordedAtMs: number;
}

export interface SyncRelayLogRow extends SyncRelayLogInput {
  workspaceId: string;
  originId: string;
  relaySeq: number;
}

export interface AppendLogBatchResult {
  inserted: number;
  skipped: number;
  currentMaxOriginSeq: number;
}

export interface FetchLogPageResult {
  rows: SyncRelayLogRow[];
  nextCursor: number;
  hasMore: boolean;
}

export interface PutBlobResult {
  byteLength: number;
  alreadyHad: boolean;
}

export interface CollectUnreferencedBlobsResult {
  removed: number;
  removedSha256s: string[];
}

export interface KeyEnvelopeRow {
  envelopeJson: string;
  sha256: string;
  updatedAtMs: number;
}

export interface KeyEnvelopeHistoryRow {
  envelopeJson: string;
  sha256: string;
  replacedAtMs: number;
  replacedBySha256: string;
}

export interface SyncRelayShareRow {
  shareId: string;
  workspaceId: string;
  granterUserId: string;
  // null for a PENDING email invite: the granter addressed an email that has
  // no dohc account yet. It is claimed (recipient_user_id filled in) the first
  // time that account touches the relay (see claimPendingSharesForEmail).
  recipientUserId: string | null;
  // Set only for a pending email invite; cleared once claimed.
  recipientEmail: string | null;
  // Validated ShareSelector JSON (shareFilter.ts owns the shape).
  selectorJson: string;
  createdAtMs: number;
  revokedAtMs: number | null;
}

export interface SyncRelayStorage {
  close(): void;
  claimWorkspace(input: {
    workspaceId: string;
    ownerUserId: string;
    createdAtMs: number;
  }): "created" | "owned" | "not-owner";
  workspaceIsOwnedBy(workspaceId: string, ownerUserId: string): boolean;
  putBlob(input: {
    workspaceId: string;
    sha256: string;
    content: Uint8Array;
  }): PutBlobResult;
  collectUnreferencedBlobs(workspaceId: string): CollectUnreferencedBlobsResult;
  getBlob(workspaceId: string, sha256: string): Uint8Array | null;
  missingBlobs(workspaceId: string, sha256s: string[]): string[];
  // Create-only on first write (expectedSha256 null), compare-and-swap
  // thereafter: the caller must present the sha256 of the envelope it intends
  // to replace. Replaced envelopes are RETAINED in an append-only history
  // table (audit trail + server-side recovery from a bad overwrite).
  putKeyEnvelope(input: {
    workspaceId: string;
    envelopeJson: string;
    updatedAtMs: number;
    expectedSha256: string | null;
  }): { sha256: string };
  getKeyEnvelope(workspaceId: string): KeyEnvelopeRow | null;
  getKeyEnvelopeHistory(workspaceId: string): KeyEnvelopeHistoryRow[];
  appendLogBatch(input: {
    workspaceId: string;
    originId: string;
    ops: SyncRelayLogInput[];
  }): AppendLogBatchResult;
  fetchLogPage(input: {
    workspaceId: string;
    sinceRelaySeq: number;
    limit: number;
  }): FetchLogPageResult;
  // PR 18 share grants. Shares are append-only rows; revocation stamps
  // revoked_at_ms instead of deleting, so a grant leaves an audit trail.
  createShare(input: Omit<SyncRelayShareRow, "revokedAtMs">): void;
  // Claims any pending email invites addressed to `email` for `userId`,
  // filling recipient_user_id and clearing recipient_email. Idempotent; the
  // email match is exact on the normalized (lowercased) address. Returns the
  // number of rows claimed. This is the lazy claim path: an invited account
  // becomes a real recipient the first time it authenticates to the relay.
  claimPendingSharesForEmail(email: string, userId: string): number;
  getShare(shareId: string): SyncRelayShareRow | null;
  listSharesGrantedBy(granterUserId: string): SyncRelayShareRow[];
  // Received listings exclude revoked shares entirely: after revocation the
  // recipient must not be able to read even the share's metadata (paths,
  // version names) — a revoked share is indistinguishable from one that
  // never existed.
  listSharesReceivedBy(recipientUserId: string): SyncRelayShareRow[];
  // Idempotent; returns false only when the share does not exist.
  revokeShare(shareId: string, revokedAtMs: number): boolean;
  // Candidate rows for the shared-blob allowlist: every log row whose payload
  // MIGHT reference the given sha256 (LIKE pre-filter; the share filter makes
  // the actual decision). sha256 is validated hex upstream, so it cannot
  // carry LIKE wildcards.
  listLogRowsReferencing(workspaceId: string, sha256: string): SyncRelayLogRow[];
}

interface SqliteRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): SqliteRunResult;
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDb;
}

const requireModule = createRequire(import.meta.url);

function nodeSqlite(): SqliteModule {
  return requireModule("node:sqlite") as SqliteModule;
}

export const SYNC_RELAY_BUSY_TIMEOUT_MS = 5_000;
export const DEFAULT_WORKSPACE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export interface OpenSyncRelayStorageOptions {
  workspaceQuotaBytes?: number;
}

export function initializeSyncRelaySchema(db: SqliteDb): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_relay_workspaces (
        workspace_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_relay_log (
        workspace_id TEXT NOT NULL,
        origin_id TEXT NOT NULL,
        origin_seq INTEGER NOT NULL,
        op_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        recorded_at_ms REAL NOT NULL,
        relay_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        UNIQUE(workspace_id, origin_id, origin_seq),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sync_relay_log_page
        ON sync_relay_log(workspace_id, relay_seq);

      CREATE TABLE IF NOT EXISTS sync_relay_blobs (
        workspace_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content BLOB NOT NULL,
        PRIMARY KEY (workspace_id, sha256),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sync_relay_key_envelopes (
        workspace_id TEXT PRIMARY KEY,
        envelope_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );

      -- Append-only audit trail: every replaced key envelope is retained with
      -- when it was replaced and by what (sha256 of the successor). The
      -- envelope is the only recovery path for the wrapped workspace key, so
      -- an overwrite — even a CAS-correct one — must never destroy the prior
      -- copy; a lockout caused by a bad replacement stays recoverable
      -- server-side.
      CREATE TABLE IF NOT EXISTS sync_relay_key_envelope_history (
        history_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        envelope_sha256 TEXT NOT NULL,
        replaced_at_ms INTEGER NOT NULL,
        replaced_by_sha256 TEXT NOT NULL,
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sync_relay_key_envelope_history
        ON sync_relay_key_envelope_history(workspace_id, history_seq);

      -- PR 18 share grants: one row per grant. Revocation stamps
      -- revoked_at_ms (rows are never deleted while the workspace lives).
      -- recipient_user_id is NULL for a pending email invite (an email with
      -- no dohc account yet); recipient_email holds the addressed email until
      -- the invite is claimed. Exactly one of the two identifies the
      -- recipient at any time.
      CREATE TABLE IF NOT EXISTS sync_relay_shares (
        share_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        granter_user_id TEXT NOT NULL,
        recipient_user_id TEXT,
        recipient_email TEXT,
        selector_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sync_relay_shares_granter
        ON sync_relay_shares(granter_user_id, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_sync_relay_shares_recipient
        ON sync_relay_shares(recipient_user_id, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_sync_relay_shares_recipient_email
        ON sync_relay_shares(recipient_email, created_at_ms);
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function openSyncRelayStorage(
  dbPath: string,
  options: OpenSyncRelayStorageOptions = {},
): SyncRelayStorage {
  const resolved = resolve(dbPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const { DatabaseSync } = nodeSqlite();
  const workspaceQuotaBytes =
    options.workspaceQuotaBytes ?? DEFAULT_WORKSPACE_QUOTA_BYTES;
  const db = new DatabaseSync(resolved);
  try {
    db.exec(`PRAGMA busy_timeout = ${SYNC_RELAY_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    initializeSyncRelaySchema(db);
    return new SqliteSyncRelayStorage(db, workspaceQuotaBytes);
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}

class SqliteSyncRelayStorage implements SyncRelayStorage {
  constructor(
    private readonly db: SqliteDb,
    private readonly workspaceQuotaBytes: number,
  ) {}

  close(): void {
    this.db.close();
  }

  claimWorkspace(input: {
    workspaceId: string;
    ownerUserId: string;
    createdAtMs: number;
  }): "created" | "owned" | "not-owner" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ?",
        )
        .get(input.workspaceId);
      if (typeof existing?.owner_user_id === "string") {
        this.db.exec("COMMIT");
        return existing.owner_user_id === input.ownerUserId ? "owned" : "not-owner";
      }
      this.db
        .prepare(
          `INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms)
           VALUES (?, ?, ?)`,
        )
        .run(input.workspaceId, input.ownerUserId, Math.trunc(input.createdAtMs));
      this.db.exec("COMMIT");
      return "created";
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  workspaceIsOwnedBy(workspaceId: string, ownerUserId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok
         FROM sync_relay_workspaces
         WHERE workspace_id = ? AND owner_user_id = ?`,
      )
      .get(workspaceId, ownerUserId);
    return row !== undefined;
  }

  putBlob(input: {
    workspaceId: string;
    sha256: string;
    content: Uint8Array;
  }): PutBlobResult {
    const byteLength = input.content.byteLength;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT 1 AS ok FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ?",
        )
        .get(input.workspaceId, input.sha256);
      if (existing !== undefined) {
        this.db.exec("COMMIT");
        return { byteLength, alreadyHad: true };
      }
      this.assertWorkspaceQuota(input.workspaceId, byteLength);
      this.db
        .prepare(
          `INSERT INTO sync_relay_blobs (workspace_id, sha256, byte_length, content)
           VALUES (?, ?, ?, ?)`,
        )
        .run(input.workspaceId, input.sha256, byteLength, Buffer.from(input.content));
      this.db.exec("COMMIT");
      return { byteLength, alreadyHad: false };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  collectUnreferencedBlobs(workspaceId: string): CollectUnreferencedBlobsResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT b.sha256
           FROM sync_relay_blobs b
           WHERE b.workspace_id = ?
             AND NOT EXISTS (
               SELECT 1
               FROM sync_relay_log l
               WHERE l.workspace_id = b.workspace_id
                 AND l.payload_json LIKE '%' || b.sha256 || '%'
             )
           ORDER BY b.sha256`,
        )
        .all(workspaceId);
      const removedSha256s = rows.map((row) => String(row.sha256));
      const deleteStmt = this.db.prepare(
        "DELETE FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ?",
      );
      for (const sha256 of removedSha256s) {
        deleteStmt.run(workspaceId, sha256);
      }
      this.db.exec("COMMIT");
      return { removed: removedSha256s.length, removedSha256s };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  getBlob(workspaceId: string, sha256: string): Uint8Array | null {
    const row = this.db
      .prepare(
        "SELECT content FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ?",
      )
      .get(workspaceId, sha256);
    const content = row?.content;
    if (Buffer.isBuffer(content)) return content;
    if (content instanceof Uint8Array) return Buffer.from(content);
    return null;
  }

  missingBlobs(workspaceId: string, sha256s: string[]): string[] {
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
      const rows = this.db
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

  putKeyEnvelope(input: {
    workspaceId: string;
    envelopeJson: string;
    updatedAtMs: number;
    expectedSha256: string | null;
  }): { sha256: string } {
    const nextSha256 = sha256HexUtf8(input.envelopeJson);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare(
          "SELECT envelope_json FROM sync_relay_key_envelopes WHERE workspace_id = ?",
        )
        .get(input.workspaceId);
      const currentJson =
        typeof current?.envelope_json === "string" ? current.envelope_json : null;
      if (currentJson === input.envelopeJson) {
        // Byte-identical re-PUT: an idempotent retry (e.g. enroll after a
        // dropped response), not a replacement. No history entry.
        this.db.exec("COMMIT");
        return { sha256: nextSha256 };
      }
      if (currentJson === null) {
        if (input.expectedSha256 !== null) {
          throw new SyncRelayConflictError(
            "key envelope does not exist; a conditional replace has nothing to match",
          );
        }
        this.db
          .prepare(
            `INSERT INTO sync_relay_key_envelopes (workspace_id, envelope_json, updated_at_ms)
             VALUES (?, ?, ?)`,
          )
          .run(input.workspaceId, input.envelopeJson, Math.trunc(input.updatedAtMs));
        this.db.exec("COMMIT");
        return { sha256: nextSha256 };
      }
      const currentSha256 = sha256HexUtf8(currentJson);
      if (input.expectedSha256 === null) {
        throw new SyncRelayConflictError(
          "key envelope already exists; replacing it requires If-Match with the current sha256",
        );
      }
      if (input.expectedSha256 !== currentSha256) {
        throw new SyncRelayConflictError(
          "key envelope was replaced concurrently; refresh and retry with the current sha256",
        );
      }
      this.db
        .prepare(
          `INSERT INTO sync_relay_key_envelope_history (
            workspace_id, envelope_json, envelope_sha256, replaced_at_ms, replaced_by_sha256
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.workspaceId,
          currentJson,
          currentSha256,
          Math.trunc(input.updatedAtMs),
          nextSha256,
        );
      this.db
        .prepare(
          `UPDATE sync_relay_key_envelopes
           SET envelope_json = ?, updated_at_ms = ?
           WHERE workspace_id = ?`,
        )
        .run(input.envelopeJson, Math.trunc(input.updatedAtMs), input.workspaceId);
      this.db.exec("COMMIT");
      return { sha256: nextSha256 };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  getKeyEnvelope(workspaceId: string): KeyEnvelopeRow | null {
    const row = this.db
      .prepare(
        "SELECT envelope_json, updated_at_ms FROM sync_relay_key_envelopes WHERE workspace_id = ?",
      )
      .get(workspaceId);
    if (typeof row?.envelope_json !== "string") return null;
    return {
      envelopeJson: row.envelope_json,
      sha256: sha256HexUtf8(row.envelope_json),
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  getKeyEnvelopeHistory(workspaceId: string): KeyEnvelopeHistoryRow[] {
    return this.db
      .prepare(
        `SELECT envelope_json, envelope_sha256, replaced_at_ms, replaced_by_sha256
         FROM sync_relay_key_envelope_history
         WHERE workspace_id = ?
         ORDER BY history_seq`,
      )
      .all(workspaceId)
      .map((row) => ({
        envelopeJson: String(row.envelope_json),
        sha256: String(row.envelope_sha256),
        replacedAtMs: Number(row.replaced_at_ms),
        replacedBySha256: String(row.replaced_by_sha256),
      }));
  }

  appendLogBatch(input: {
    workspaceId: string;
    originId: string;
    ops: SyncRelayLogInput[];
  }): AppendLogBatchResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let inserted = 0;
      let skipped = 0;
      let addedLogBytes = 0;
      const newOps: SyncRelayLogInput[] = [];
      const maxStmt = this.db.prepare(
        `SELECT COALESCE(MAX(origin_seq), -1) AS max_seq
         FROM sync_relay_log
         WHERE workspace_id = ? AND origin_id = ?`,
      );
      const existingStmt = this.db.prepare(
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

      this.assertWorkspaceQuota(input.workspaceId, addedLogBytes);

      const insertStmt = this.db.prepare(
        `INSERT INTO sync_relay_log (
          workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const op of newOps) {
        insertStmt.run(
          input.workspaceId,
          input.originId,
          op.originSeq,
          op.opKind,
          op.payloadJson,
          op.recordedAtMs,
        );
        inserted += 1;
      }

      this.db.exec("COMMIT");
      return { inserted, skipped, currentMaxOriginSeq: currentMax };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private workspaceUsageBytes(workspaceId: string): number {
    const blobRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(byte_length), 0) AS bytes
         FROM sync_relay_blobs
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    const logRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
         FROM sync_relay_log
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    return Number(blobRow?.bytes ?? 0) + Number(logRow?.bytes ?? 0);
  }

  private assertWorkspaceQuota(workspaceId: string, addedBytes: number): void {
    if (addedBytes <= 0) return;
    const currentUsage = this.workspaceUsageBytes(workspaceId);
    if (currentUsage + addedBytes > this.workspaceQuotaBytes) {
      throw new SyncRelayQuotaExceededError(
        `workspace storage quota exceeded: ${currentUsage + addedBytes} bytes would exceed quota ${this.workspaceQuotaBytes}`,
      );
    }
  }

  createShare(input: Omit<SyncRelayShareRow, "revokedAtMs">): void {
    this.db
      .prepare(
        `INSERT INTO sync_relay_shares (
          share_id, workspace_id, granter_user_id, recipient_user_id, recipient_email,
          selector_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.shareId,
        input.workspaceId,
        input.granterUserId,
        input.recipientUserId,
        input.recipientEmail,
        input.selectorJson,
        Math.trunc(input.createdAtMs),
      );
  }

  claimPendingSharesForEmail(email: string, userId: string): number {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return 0;
    const result = this.db
      .prepare(
        `UPDATE sync_relay_shares
         SET recipient_user_id = ?, recipient_email = NULL
         WHERE recipient_user_id IS NULL AND recipient_email = ?`,
      )
      .run(userId, normalized);
    return Number(result.changes ?? 0);
  }

  getShare(shareId: string): SyncRelayShareRow | null {
    const row = this.db
      .prepare(
        `SELECT share_id, workspace_id, granter_user_id, recipient_user_id, recipient_email,
                selector_json, created_at_ms, revoked_at_ms
         FROM sync_relay_shares WHERE share_id = ?`,
      )
      .get(shareId);
    return row ? rowToShareRow(row) : null;
  }

  listSharesGrantedBy(granterUserId: string): SyncRelayShareRow[] {
    return this.db
      .prepare(
        `SELECT share_id, workspace_id, granter_user_id, recipient_user_id, recipient_email,
                selector_json, created_at_ms, revoked_at_ms
         FROM sync_relay_shares
         WHERE granter_user_id = ?
         ORDER BY created_at_ms DESC, share_id`,
      )
      .all(granterUserId)
      .map(rowToShareRow);
  }

  listSharesReceivedBy(recipientUserId: string): SyncRelayShareRow[] {
    return this.db
      .prepare(
        `SELECT share_id, workspace_id, granter_user_id, recipient_user_id, recipient_email,
                selector_json, created_at_ms, revoked_at_ms
         FROM sync_relay_shares
         WHERE recipient_user_id = ? AND revoked_at_ms IS NULL
         ORDER BY created_at_ms DESC, share_id`,
      )
      .all(recipientUserId)
      .map(rowToShareRow);
  }

  revokeShare(shareId: string, revokedAtMs: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT revoked_at_ms FROM sync_relay_shares WHERE share_id = ?")
        .get(shareId);
      if (existing === undefined) {
        this.db.exec("COMMIT");
        return false;
      }
      if (existing.revoked_at_ms === null || existing.revoked_at_ms === undefined) {
        this.db
          .prepare("UPDATE sync_relay_shares SET revoked_at_ms = ? WHERE share_id = ?")
          .run(Math.trunc(revokedAtMs), shareId);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  listLogRowsReferencing(workspaceId: string, sha256: string): SyncRelayLogRow[] {
    return this.db
      .prepare(
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq
         FROM sync_relay_log
         WHERE workspace_id = ? AND payload_json LIKE ?
         ORDER BY relay_seq`,
      )
      .all(workspaceId, `%${sha256}%`)
      .map(rowToLogRow);
  }

  fetchLogPage(input: {
    workspaceId: string;
    sinceRelaySeq: number;
    limit: number;
  }): FetchLogPageResult {
    const rows = this.db
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
}

function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function rowToShareRow(row: Record<string, unknown>): SyncRelayShareRow {
  return {
    shareId: String(row.share_id),
    workspaceId: String(row.workspace_id),
    granterUserId: String(row.granter_user_id),
    recipientUserId:
      row.recipient_user_id === null || row.recipient_user_id === undefined
        ? null
        : String(row.recipient_user_id),
    recipientEmail:
      row.recipient_email === null || row.recipient_email === undefined
        ? null
        : String(row.recipient_email),
    selectorJson: String(row.selector_json),
    createdAtMs: Number(row.created_at_ms),
    revokedAtMs:
      row.revoked_at_ms === null || row.revoked_at_ms === undefined
        ? null
        : Number(row.revoked_at_ms),
  };
}

function rowToLogRow(row: Record<string, unknown>): SyncRelayLogRow {
  return {
    workspaceId: String(row.workspace_id),
    originId: String(row.origin_id),
    originSeq: Number(row.origin_seq),
    opKind: String(row.op_kind),
    payloadJson: String(row.payload_json),
    recordedAtMs: Number(row.recorded_at_ms),
    relaySeq: Number(row.relay_seq),
  };
}

export class SyncRelayConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "conflict";
}

export class SyncRelayQuotaExceededError extends Error {
  readonly statusCode = 413;
  readonly code = "quota_exceeded";
}
