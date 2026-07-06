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
  getBlob(workspaceId: string, sha256: string): Uint8Array | null;
  missingBlobs(workspaceId: string, sha256s: string[]): string[];
  putKeyEnvelope(input: {
    workspaceId: string;
    envelopeJson: string;
    updatedAtMs: number;
  }): void;
  getKeyEnvelope(workspaceId: string): string | null;
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
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function openSyncRelayStorage(dbPath: string): SyncRelayStorage {
  const resolved = resolve(dbPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(resolved);
  try {
    db.exec(`PRAGMA busy_timeout = ${SYNC_RELAY_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    initializeSyncRelaySchema(db);
    return new SqliteSyncRelayStorage(db);
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}

class SqliteSyncRelayStorage implements SyncRelayStorage {
  constructor(private readonly db: SqliteDb) {}

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
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO sync_relay_blobs (workspace_id, sha256, byte_length, content)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.workspaceId, input.sha256, byteLength, Buffer.from(input.content));
    return { byteLength, alreadyHad: result.changes === 0 };
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
    const found = new Set<string>();
    const stmt = this.db.prepare(
      "SELECT 1 AS ok FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ?",
    );
    for (const sha256 of sha256s) {
      if (stmt.get(workspaceId, sha256)) found.add(sha256);
    }
    return sha256s.filter((sha256) => !found.has(sha256));
  }

  putKeyEnvelope(input: {
    workspaceId: string;
    envelopeJson: string;
    updatedAtMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sync_relay_key_envelopes (workspace_id, envelope_json, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           envelope_json = excluded.envelope_json,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(input.workspaceId, input.envelopeJson, Math.trunc(input.updatedAtMs));
  }

  getKeyEnvelope(workspaceId: string): string | null {
    const row = this.db
      .prepare("SELECT envelope_json FROM sync_relay_key_envelopes WHERE workspace_id = ?")
      .get(workspaceId);
    return typeof row?.envelope_json === "string" ? row.envelope_json : null;
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
      const insertStmt = this.db.prepare(
        `INSERT INTO sync_relay_log (
          workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );

      for (const op of input.ops) {
        const currentMax = Number(
          maxStmt.get(input.workspaceId, input.originId)?.max_seq ?? -1,
        );
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

      const currentMaxOriginSeq = Number(
        maxStmt.get(input.workspaceId, input.originId)?.max_seq ?? -1,
      );
      this.db.exec("COMMIT");
      return { inserted, skipped, currentMaxOriginSeq };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
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
