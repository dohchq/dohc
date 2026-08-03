import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { AGENT_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import { RELAY_ERRORS } from "./errorCodes";

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

export interface WorkspaceSyncIdentity {
  replicationEpoch: string;
  streamIdentity: string;
}

export interface WorkspaceBootstrap {
  hasContent: boolean;
  identity: WorkspaceSyncIdentity | null;
}

export type ClaimWorkspaceIdentityResult =
  | "claimed"
  | "matched"
  | "epoch-superseded"
  | "epoch-unknown"
  | "stream-mismatch";

export type VerifyWorkspaceIdentityResult = Exclude<
  ClaimWorkspaceIdentityResult,
  "claimed"
>;

export type EnforceWorkspaceIdentityResult =
  | ClaimWorkspaceIdentityResult
  | "identity-required";

export type RotateWorkspaceIdentityResult =
  | "rotated"
  | "not-owner"
  | "unchanged"
  | "epoch-superseded";

export interface AppendLogBatchGuardContext {
  enforceWorkspaceIdentity(
    identity: WorkspaceSyncIdentity | null,
  ): EnforceWorkspaceIdentityResult;
}

export interface SyncRelayStorage {
  close(): void;
  claimWorkspace(input: {
    workspaceId: string;
    ownerUserId: string;
    createdAtMs: number;
  }): "created" | "owned" | "not-owner";
  getWorkspaceBootstrap(workspaceId: string): WorkspaceBootstrap;
  getWorkspaceIdentity(workspaceId: string): WorkspaceSyncIdentity | null;
  getEpochLogFloor(workspaceId: string): number;
  verifyWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): VerifyWorkspaceIdentityResult;
  claimWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): ClaimWorkspaceIdentityResult;
  rotateWorkspaceIdentity(input: {
    workspaceId: string;
    ownerUserId: string;
    replicationEpoch: string;
    streamIdentity: string;
    rotatedAtMs: number;
  }): RotateWorkspaceIdentityResult;
  workspaceIsOwnedBy(workspaceId: string, ownerUserId: string): boolean;
  putBlob(input: {
    workspaceId: string;
    sha256: string;
    content: Uint8Array;
    createdAtMs: number;
  }): PutBlobResult;
  // Async + chunked so a large sweep never monopolizes the event loop on the
  // request path. Only reclaims blobs that are BOTH unreferenced AND older than
  // the retention grace window (created_at_ms <= nowMs - grace), which is what
  // keeps a blob uploaded moments before its referencing log op is appended
  // from being deleted between the two phases.
  collectUnreferencedBlobs(
    workspaceId: string,
    options: { nowMs: number },
  ): Promise<CollectUnreferencedBlobsResult>;
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
    // MU-C4 revoke-race gate: runs INSIDE the append's BEGIN IMMEDIATE
    // transaction, i.e. under the SQLite write lock that serializes revokes,
    // before anything is inserted. A throwing guard rolls the whole batch
    // back. This is how the member-append route re-verifies the share
    // (recipient-owned, unrevoked, granter in standing) with NO window left
    // between the check and the insert — a route-level re-check alone leaves
    // a gap where a concurrent revoke commits after the check but before the
    // transaction opens.
    guard?: (context: AppendLogBatchGuardContext) => void;
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
  // MU-C4 shared channels: the channelWireId bound by the EARLIEST
  // chat.thread.create op for this threadId in the workspace's log (relay
  // order). undefined means no create exists; null means the earliest create
  // exists but carries no shareable channel binding. Earliest-wins mirrors the
  // engine's insert-if-absent thread apply, so a later forged re-create can
  // never re-bind an existing thread across a share boundary.
  findThreadCreateChannelWireId(
    workspaceId: string,
    threadId: string,
  ): string | null | undefined;
  // The kind claimed by the EARLIEST chat.channel.create op for this wire id.
  // undefined means no create exists; null means the earliest exact create is
  // malformed/unshareable. Later duplicate creates never override the first.
  findChannelCreateKind(
    workspaceId: string,
    channelWireId: string,
  ): "channel" | "dm" | "agent" | null | undefined;
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
// Retention grace for freshly-uploaded blobs (0P sync-hardening item 4). Blob
// upload is two-phase (PUT /blobs/:sha, then POST /log referencing it); GC that
// runs between the two must NOT reclaim the blob just because no log row
// references it yet. Any blob younger than this window is untouchable. Ten
// minutes comfortably covers a slow/retried push.
export const DEFAULT_BLOB_GRACE_MS = 10 * 60 * 1000;

export interface OpenSyncRelayStorageOptions {
  workspaceQuotaBytes?: number;
  blobGraceMs?: number;
}

export function initializeSyncRelaySchema(db: SqliteDb): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_relay_workspaces (
        workspace_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        replication_epoch TEXT,
        stream_identity TEXT,
        epoch_log_floor INTEGER
      );

      -- Every epoch that stops being active remains durable here. This makes
      -- stale pre-reset credentials permanently identifiable after rotation.
      CREATE TABLE IF NOT EXISTS sync_relay_epoch_supersessions (
        workspace_id TEXT NOT NULL,
        replication_epoch TEXT NOT NULL,
        stream_identity TEXT NOT NULL,
        superseded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, replication_epoch, stream_identity),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
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
      -- MU-C4: findThreadCreateChannelWireId's LIKE pre-filter cannot use an
      -- index on payload_json, but this PARTIAL index confines the scan to a
      -- workspace's chat.thread.create rows (a tiny slice of a busy log) in
      -- relay order, instead of every log row. Per-request memoization in the
      -- caller (server.ts chatResolverFor) removes the per-message repeats;
      -- if channel history ever makes even the confined scan hot, the upgrade
      -- path is a dedicated thread_channel_bindings table filled at insert.
      CREATE INDEX IF NOT EXISTS idx_sync_relay_log_thread_creates
        ON sync_relay_log(workspace_id, relay_seq)
        WHERE op_kind = 'chat.thread.create';
      CREATE INDEX IF NOT EXISTS idx_sync_relay_log_channel_creates
        ON sync_relay_log(workspace_id, relay_seq)
        WHERE op_kind = 'chat.channel.create';
      -- One-base-per-lineage arbitration (dohc-ai/dohc#547): appendOps checks
      -- every pushed base against the workspace's stored base for that
      -- (versionId, objectId) coordinate, inside BEGIN IMMEDIATE. Without an
      -- index that check rescans the workspace's whole log per base and a
      -- legal 500-base batch can blow the 5-second busy timeout. This PARTIAL
      -- expression index confines the probe to base rows keyed by the exact
      -- coordinate the query names.
      CREATE INDEX IF NOT EXISTS idx_sync_relay_log_ydoc_bases
        ON sync_relay_log(
          workspace_id,
          json_extract(payload_json, '$.versionId'),
          json_extract(payload_json, '$.objectId')
        )
        WHERE op_kind = 'ydoc.update'
          AND json_extract(payload_json, '$.isBaseState') = 1;

      CREATE TABLE IF NOT EXISTS sync_relay_blobs (
        workspace_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content BLOB NOT NULL,
        created_at_ms INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS sync_relay_migrations (
        migration_id TEXT PRIMARY KEY,
        completed_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    // Lazy additive migration (0P sync-hardening item 4): dbs created before the
    // blob retention window gain created_at_ms on open. Existing rows default to
    // 0, so a legacy unreferenced blob is immediately past any grace window and
    // still collectible — the new protection only applies to blobs uploaded
    // with a real timestamp going forward.
    const blobColumns = db
      .prepare("PRAGMA table_info(sync_relay_blobs)")
      .all()
      .map((row) => String(row.name));
    if (!blobColumns.includes("created_at_ms")) {
      db.exec(
        "ALTER TABLE sync_relay_blobs ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0",
      );
    }
    // R10b lazy additive migration: existing relay databases predate sync
    // identity. Both columns stay nullable so legacy workspaces remain unset
    // until the first identity-bearing request claims them.
    const workspaceColumns = db
      .prepare("PRAGMA table_info(sync_relay_workspaces)")
      .all()
      .map((row) => String(row.name));
    if (!workspaceColumns.includes("replication_epoch")) {
      db.exec("ALTER TABLE sync_relay_workspaces ADD COLUMN replication_epoch TEXT");
    }
    if (!workspaceColumns.includes("stream_identity")) {
      db.exec("ALTER TABLE sync_relay_workspaces ADD COLUMN stream_identity TEXT");
    }
    if (!workspaceColumns.includes("epoch_log_floor")) {
      db.exec("ALTER TABLE sync_relay_workspaces ADD COLUMN epoch_log_floor INTEGER");
    }
    const timestampMigrationId = "recorded-at-safe-integer-v1";
    const timestampValidated = db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM sync_relay_migrations WHERE migration_id=?) AS complete",
      )
      .get(timestampMigrationId);
    if (Number(timestampValidated?.complete ?? 0) === 0) {
      const invalidTimestamp = db
        .prepare(
          `SELECT EXISTS(
             SELECT 1 FROM sync_relay_log
             WHERE recorded_at_ms != CAST(recorded_at_ms AS INTEGER)
                OR recorded_at_ms < -9007199254740991
                OR recorded_at_ms > 9007199254740991
           ) AS invalid`,
        )
        .get();
      if (Number(invalidTimestamp?.invalid ?? 0) !== 0) {
        throw new Error("sync relay log contains a timestamp outside the integer wire contract");
      }
      db.prepare(
        "INSERT INTO sync_relay_migrations (migration_id,completed_at_ms) VALUES (?,?)",
      ).run(timestampMigrationId, Date.now());
    }
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
  // Validate the quota HERE, not just in main.ts: this helper is exported and
  // reused (tests, other services). A NaN/Infinity/negative cap would silently
  // disable the quota check (currentUsage + added > NaN is always false), so
  // reject anything that is not a positive safe integer before constructing
  // storage.
  if (!Number.isSafeInteger(workspaceQuotaBytes) || workspaceQuotaBytes <= 0) {
    throw new Error(
      `workspaceQuotaBytes must be a positive safe integer, got ${String(workspaceQuotaBytes)}`,
    );
  }
  const blobGraceMs = options.blobGraceMs ?? DEFAULT_BLOB_GRACE_MS;
  if (!Number.isSafeInteger(blobGraceMs) || blobGraceMs < 0) {
    throw new Error(
      `blobGraceMs must be a non-negative safe integer, got ${String(blobGraceMs)}`,
    );
  }
  const db = new DatabaseSync(resolved);
  try {
    db.exec(`PRAGMA busy_timeout = ${SYNC_RELAY_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    initializeSyncRelaySchema(db);
    return new SqliteSyncRelayStorage(db, workspaceQuotaBytes, blobGraceMs);
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
    private readonly blobGraceMs: number,
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

  getWorkspaceIdentity(workspaceId: string): WorkspaceSyncIdentity | null {
    const row = this.db
      .prepare(
        `SELECT replication_epoch, stream_identity
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === undefined) return null;
    const replicationEpoch = row.replication_epoch;
    const streamIdentity = row.stream_identity;
    if (replicationEpoch == null && streamIdentity == null) return null;
    if (typeof replicationEpoch !== "string" || typeof streamIdentity !== "string") {
      throw new Error("sync relay workspace identity is partially populated");
    }
    return { replicationEpoch, streamIdentity };
  }

  getWorkspaceBootstrap(workspaceId: string): WorkspaceBootstrap {
    const row = this.db
      .prepare(
        `SELECT replication_epoch, stream_identity,
                EXISTS(
                  SELECT 1 FROM sync_relay_log
                  WHERE sync_relay_log.workspace_id = sync_relay_workspaces.workspace_id
                    AND sync_relay_log.relay_seq >
                      COALESCE(sync_relay_workspaces.epoch_log_floor, 0)
                  LIMIT 1
                ) AS has_content
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === undefined) throw new Error("workspace does not exist");
    const hasContent = row.has_content;
    if (hasContent !== 0 && hasContent !== 1) {
      throw new Error("sync relay workspace content state is invalid");
    }
    return {
      hasContent: hasContent === 1,
      identity: workspaceIdentityFromRow(row),
    };
  }

  // Transaction-composable floor read for appendOps (which already holds
  // BEGIN IMMEDIATE); absent rows read as floor 0 - workspace existence is
  // the caller's check.
  private getEpochLogFloorInTransaction(workspaceId: string): number {
    const row = this.db
      .prepare(
        `SELECT epoch_log_floor
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === undefined || row.epoch_log_floor == null) return 0;
    const floor = Number(row.epoch_log_floor);
    if (!Number.isSafeInteger(floor) || floor < 0) {
      throw new Error("sync relay workspace epoch log floor is invalid");
    }
    return floor;
  }

  getEpochLogFloor(workspaceId: string): number {
    const row = this.db
      .prepare(
        `SELECT epoch_log_floor
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === undefined) throw new Error("workspace does not exist");
    if (row.epoch_log_floor == null) return 0;
    const floor = Number(row.epoch_log_floor);
    if (!Number.isSafeInteger(floor) || floor < 0) {
      throw new Error("sync relay workspace epoch log floor is invalid");
    }
    return floor;
  }

  verifyWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): VerifyWorkspaceIdentityResult {
    const row = this.db
      .prepare(
        `SELECT replication_epoch, stream_identity
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(input.workspaceId);
    if (row === undefined) {
      throw new Error("cannot verify identity for an absent workspace");
    }
    const current = workspaceIdentityFromRow(row);
    // Reads never establish identity. An identity-bearing GET against an
    // unset workspace has no coordinate to match and is therefore unknown.
    if (current === null) return "epoch-unknown";
    return this.classifyWorkspaceIdentity(input.workspaceId, current, input);
  }

  claimWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): ClaimWorkspaceIdentityResult {
    // The common path is verification only. Do this SELECT before taking a
    // write lock so matched identity-bearing pulls/claims do not serialize
    // against relay writers.
    const initial = this.db
      .prepare(
        `SELECT replication_epoch, stream_identity
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(input.workspaceId);
    if (initial === undefined) {
      throw new Error("cannot claim identity for an absent workspace");
    }
    const initialIdentity = workspaceIdentityFromRow(initial);
    if (initialIdentity !== null) {
      return this.classifyWorkspaceIdentity(
        input.workspaceId,
        initialIdentity,
        input,
      );
    }

    // Only first adoption needs a write transaction. Re-read after acquiring
    // the lock to close the race with another claimant.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT replication_epoch, stream_identity
           FROM sync_relay_workspaces
           WHERE workspace_id = ?`,
        )
        .get(input.workspaceId);
      if (row === undefined) {
        throw new Error("cannot claim identity for an absent workspace");
      }
      const current = workspaceIdentityFromRow(row);
      if (current === null) {
        this.db
          .prepare(
            `UPDATE sync_relay_workspaces
             SET replication_epoch = ?, stream_identity = ?, epoch_log_floor = 0
             WHERE workspace_id = ?`,
          )
          .run(input.replicationEpoch, input.streamIdentity, input.workspaceId);
        this.db.exec("COMMIT");
        return "claimed";
      }
      const result = this.classifyWorkspaceIdentity(input.workspaceId, current, input);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  rotateWorkspaceIdentity(input: {
    workspaceId: string;
    ownerUserId: string;
    replicationEpoch: string;
    streamIdentity: string;
    rotatedAtMs: number;
  }): RotateWorkspaceIdentityResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT owner_user_id, replication_epoch, stream_identity
           FROM sync_relay_workspaces
           WHERE workspace_id = ?`,
        )
        .get(input.workspaceId);
      if (row === undefined || row.owner_user_id !== input.ownerUserId) {
        this.db.exec("COMMIT");
        return "not-owner";
      }
      const replicationEpoch = row.replication_epoch;
      const streamIdentity = row.stream_identity;
      if (replicationEpoch == null && streamIdentity != null) {
        throw new Error("sync relay workspace identity is partially populated");
      }
      if (replicationEpoch != null && typeof replicationEpoch !== "string") {
        throw new Error("sync relay workspace identity has an invalid epoch");
      }
      if (streamIdentity == null && replicationEpoch != null) {
        throw new Error("sync relay workspace identity is partially populated");
      }
      if (streamIdentity != null && typeof streamIdentity !== "string") {
        throw new Error("sync relay workspace identity has an invalid stream");
      }
      if (
        replicationEpoch === input.replicationEpoch &&
        streamIdentity === input.streamIdentity
      ) {
        this.db.exec("COMMIT");
        return "unchanged";
      }

      // An epoch number that has entered history must never become active
      // again, even under a freshly minted stream id. This prevents a reset
      // generation from being resurrected by changing only half the coordinate.
      const targetEpochWasSuperseded =
        this.db
          .prepare(
            `SELECT 1 AS ok
             FROM sync_relay_epoch_supersessions
             WHERE workspace_id = ? AND replication_epoch = ?
             LIMIT 1`,
          )
          .get(input.workspaceId, input.replicationEpoch) !== undefined;
      if (targetEpochWasSuperseded) {
        this.db.exec("COMMIT");
        return "epoch-superseded";
      }
      if (typeof replicationEpoch === "string" && typeof streamIdentity === "string") {
        const alreadyRecorded =
          this.db
            .prepare(
              `SELECT 1 AS ok
               FROM sync_relay_epoch_supersessions
               WHERE workspace_id = ? AND replication_epoch = ? AND stream_identity = ?`,
            )
            .get(input.workspaceId, replicationEpoch, streamIdentity) !== undefined;
        if (!alreadyRecorded) {
          this.assertWorkspaceQuota(
            input.workspaceId,
            Buffer.byteLength(replicationEpoch, "utf8") +
              Buffer.byteLength(streamIdentity, "utf8"),
          );
        }
        this.db
          .prepare(
            `INSERT OR IGNORE INTO sync_relay_epoch_supersessions (
              workspace_id, replication_epoch, stream_identity, superseded_at_ms
          ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            input.workspaceId,
            replicationEpoch,
            streamIdentity,
            Math.trunc(input.rotatedAtMs),
          );
      }
      const floor = Number(
        this.db
          .prepare(
            `SELECT COALESCE(MAX(relay_seq), 0) AS floor
             FROM sync_relay_log
             WHERE workspace_id = ?`,
          )
          .get(input.workspaceId)?.floor ?? 0,
      );
      this.db
        .prepare(
          `UPDATE sync_relay_workspaces
           SET replication_epoch = ?, stream_identity = ?, epoch_log_floor = ?
           WHERE workspace_id = ?`,
        )
        .run(input.replicationEpoch, input.streamIdentity, floor, input.workspaceId);
      this.db.exec("COMMIT");
      return "rotated";
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private classifyWorkspaceIdentity(
    workspaceId: string,
    current: WorkspaceSyncIdentity,
    presented: WorkspaceSyncIdentity,
  ): VerifyWorkspaceIdentityResult {
    if (
      current.replicationEpoch === presented.replicationEpoch &&
      current.streamIdentity === presented.streamIdentity
    ) {
      return "matched";
    }
    const coordinateWasSuperseded =
      this.db
        .prepare(
          `SELECT 1 AS ok
           FROM sync_relay_epoch_supersessions
           WHERE workspace_id = ? AND replication_epoch = ? AND stream_identity = ?`,
        )
        .get(
          workspaceId,
          presented.replicationEpoch,
          presented.streamIdentity,
        ) !== undefined;
    if (coordinateWasSuperseded) return "epoch-superseded";
    if (current.replicationEpoch !== presented.replicationEpoch) {
      return "epoch-unknown";
    }
    return "stream-mismatch";
  }

  private enforceWorkspaceIdentityInTransaction(
    workspaceId: string,
    presented: WorkspaceSyncIdentity | null,
  ): EnforceWorkspaceIdentityResult {
    const row = this.db
      .prepare(
        `SELECT replication_epoch, stream_identity
         FROM sync_relay_workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === undefined) {
      throw new Error("cannot enforce identity for an absent workspace");
    }
    const current = workspaceIdentityFromRow(row);
    if (presented === null) {
      return current === null ? "matched" : "identity-required";
    }
    if (current !== null) {
      return this.classifyWorkspaceIdentity(workspaceId, current, presented);
    }
    this.db
      .prepare(
        `UPDATE sync_relay_workspaces
         SET replication_epoch = ?, stream_identity = ?, epoch_log_floor = 0
         WHERE workspace_id = ?`,
      )
      .run(presented.replicationEpoch, presented.streamIdentity, workspaceId);
    return "claimed";
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
    createdAtMs: number;
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
      this.db.exec("COMMIT");
      return { byteLength, alreadyHad: false };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async collectUnreferencedBlobs(
    workspaceId: string,
    options: { nowMs: number },
  ): Promise<CollectUnreferencedBlobsResult> {
    // Grace window (item 4): never reclaim a blob younger than blobGraceMs, so
    // a blob uploaded just before its referencing log op is appended survives
    // the gap between the two phases. cutoff is the newest created_at_ms still
    // eligible for collection.
    const cutoff = options.nowMs - this.blobGraceMs;
    // Phase 1 (read only, no write lock): candidate shas that are unreferenced
    // AND aged past the grace window.
    const candidates = this.db
      .prepare(
        `SELECT b.sha256
         FROM sync_relay_blobs b
         WHERE b.workspace_id = ?
           AND b.created_at_ms <= ?
           AND NOT EXISTS (
             SELECT 1
             FROM sync_relay_log l
             WHERE l.workspace_id = b.workspace_id
               AND l.payload_json LIKE '%' || b.sha256 || '%'
           )
         ORDER BY b.sha256`,
      )
      .all(workspaceId, cutoff)
      .map((row) => String(row.sha256));
    // Phase 2: delete in bounded chunks, each in its OWN short transaction, and
    // yield the event loop between chunks so a large sweep never monopolizes it
    // (CodeRabbit: keep GC off the single-threaded request path). The delete
    // RE-CHECKS unreferenced + aged so a blob newly referenced (or replaced)
    // between phases is left alone.
    const removedSha256s: string[] = [];
    const deleteStmt = this.db.prepare(
      `DELETE FROM sync_relay_blobs
       WHERE workspace_id = ? AND sha256 = ? AND created_at_ms <= ?
         AND NOT EXISTS (
           SELECT 1
           FROM sync_relay_log l
           WHERE l.workspace_id = ?
             AND l.payload_json LIKE '%' || ? || '%'
         )`,
    );
    const CHUNK = 200;
    for (let start = 0; start < candidates.length; start += CHUNK) {
      const chunk = candidates.slice(start, start + CHUNK);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const sha256 of chunk) {
          const result = deleteStmt.run(workspaceId, sha256, cutoff, workspaceId, sha256);
          if (result.changes > 0) removedSha256s.push(sha256);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
      if (start + CHUNK < candidates.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return { removed: removedSha256s.length, removedSha256s };
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
      // The envelope + its append-only history count toward the workspace
      // quota (CodeRabbit Stability): each rotation adds roughly the new
      // envelope's size (the prior copy moves into history), so the cap now
      // bounds unbounded rotation growth. workspaceUsageBytes already includes
      // both tables, so the incremental bytes to charge is the new envelope.
      const envelopeAddedBytes = Buffer.byteLength(input.envelopeJson, "utf8");
      if (currentJson === null) {
        if (input.expectedSha256 !== null) {
          throw new SyncRelayConflictError(
            "key envelope does not exist; a conditional replace has nothing to match",
          );
        }
        this.assertWorkspaceQuota(input.workspaceId, envelopeAddedBytes);
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
      this.assertWorkspaceQuota(input.workspaceId, envelopeAddedBytes);
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
    guard?: (context: AppendLogBatchGuardContext) => void;
  }): AppendLogBatchResult {
    for (const op of input.ops) {
      if (typeof op.recordedAtMs !== "number" || !Number.isSafeInteger(op.recordedAtMs)) {
        throw new Error("recordedAtMs must be an integer in the safe wire range");
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Authorization re-verification under the write lock (see the interface
      // comment): BEGIN IMMEDIATE serializes writers, so a revoke committed
      // by another writer is either already visible here (guard throws, batch
      // rolls back) or must wait for this COMMIT — there is no in-between.
      input.guard?.({
        enforceWorkspaceIdentity: (identity) =>
          this.enforceWorkspaceIdentityInTransaction(input.workspaceId, identity),
      });
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

      // One base per lineage (dohc-ai/dohc#547): the relay arbitrates Y.Doc
      // lineage origination the same way it arbitrates workspace identity —
      // first claim wins. Object ids derive from the path, so two machines
      // that each create the same document originate two different bases for
      // one lineage coordinate; accepting both wedges every receiver in
      // BaseStateDiverged. The first `isBaseState: true` op for a
      // (workspace, versionId, objectId) coordinate is durable; a later base
      // carrying DIFFERENT bytes is refused, and the losing origin adopts the
      // stored base and republishes its rows as deltas. A same-sha base is
      // accepted: a redelivery on a new coordinate (origin recovery) is valid
      // and receivers resume it idempotently. The whole batch is refused
      // atomically, like the gap and blob checks around it.
      // Arbitration reads only the CURRENT epoch (codex #547 round 4): a
      // rotation resets the workspace generation and floors pulls at
      // epoch_log_floor, so a pre-rotation base is history nobody can fetch.
      // Letting it keep the claim would refuse the fresh generation's base
      // while making the alleged winner unadoptable - a reset workspace
      // could never establish a lineage again.
      const epochLogFloor = this.getEpochLogFloorInTransaction(input.workspaceId);
      const storedBaseStmt = this.db.prepare(
        `SELECT origin_id, json_extract(payload_json, '$.updateBlobSha256') AS sha
         FROM sync_relay_log
         WHERE workspace_id = ? AND op_kind = 'ydoc.update'
           AND relay_seq > ?
           AND json_extract(payload_json, '$.isBaseState') = 1
           AND json_extract(payload_json, '$.versionId') = ?
           AND json_extract(payload_json, '$.objectId') = ?
         LIMIT 1`,
      );
      const batchBaseShas = new Map<string, string>();
      for (const op of newOps) {
        if (op.opKind !== "ydoc.update") continue;
        let payload: unknown;
        try {
          payload = JSON.parse(op.payloadJson);
        } catch {
          continue;
        }
        if (typeof payload !== "object" || payload === null) continue;
        const record = payload as Record<string, unknown>;
        if (record.isBaseState !== true) continue;
        const versionId = typeof record.versionId === "string" ? record.versionId : "";
        const objectId = typeof record.objectId === "string" ? record.objectId : "";
        const sha = typeof record.updateBlobSha256 === "string" ? record.updateBlobSha256 : "";
        if (!versionId || !objectId || !sha) continue;
        const lineage = `${versionId}\u0000${objectId}`;
        const stored = storedBaseStmt.get(
          input.workspaceId,
          epochLogFloor,
          versionId,
          objectId,
        );
        const winner = stored
          ? { originId: String(stored.origin_id), sha: String(stored.sha) }
          : batchBaseShas.has(lineage)
            ? { originId: input.originId, sha: batchBaseShas.get(lineage)! }
            : undefined;
        if (winner && winner.sha !== sha) {
          throw new SyncRelayYdocBaseClaimedError(
            `one Y.Doc base per lineage: lineage ${versionId}/${objectId} already has ` +
              `base ${winner.sha} from origin ${winner.originId}; refused base ${sha} ` +
              `from origin ${input.originId} — adopt the stored base and republish ` +
              `local rows as deltas`,
          );
        }
        batchBaseShas.set(lineage, sha);
      }

      this.assertWorkspaceQuota(input.workspaceId, addedLogBytes);

      // Data-integrity gate (0P sync-hardening): a log op must never be made
      // durable while it references a blob the relay does not hold. The blob
      // GC grace window covers the fresh PUT->POST gap, but NOT an old blob
      // that ages past the grace, nor a blob GC'd after a failed /log that a
      // retry then re-references via /blobs/have. Validate every referenced
      // sha IN THIS SAME transaction, before inserting: SQLite serializes
      // writers (BEGIN IMMEDIATE), so a concurrent GC cannot delete a checked
      // blob between this probe and the insert that pins it. Only NEW ops are
      // checked -- a skipped idempotent duplicate is already durable and its
      // blobs were validated at first append. Any missing blob rejects the
      // WHOLE batch atomically (no partial append) with a retryable error the
      // client resolves by re-uploading and re-posting.
      const referencedShas = new Set<string>();
      for (const op of newOps) {
        for (const sha of referencedBlobShas(op.opKind, op.payloadJson)) {
          referencedShas.add(sha);
        }
      }
      if (referencedShas.size > 0) {
        const missing = this.missingBlobs(input.workspaceId, [...referencedShas]);
        if (missing.length > 0) {
          throw new SyncRelayBlobMissingError(
            `log append references ${missing.length} blob(s) not stored on the relay ` +
              `(first: ${missing[0]}); (re-)upload the blob(s) and retry`,
          );
        }
      }

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
    // Key envelopes count toward the quota too (CodeRabbit Stability): the
    // current envelope plus the append-only history table can otherwise grow
    // without bound across repeated CAS rotations, letting a workspace bypass
    // its cap by replacing the envelope over and over.
    const envelopeRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(length(CAST(envelope_json AS BLOB))), 0) AS bytes
         FROM sync_relay_key_envelopes
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    const envelopeHistoryRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(length(CAST(envelope_json AS BLOB))), 0) AS bytes
         FROM sync_relay_key_envelope_history
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    // Epoch supersessions are append-only identity history. Count both
    // identifier payloads so repeated rotations cannot grow the relay DB
    // outside the same per-workspace cap as log/blob/key-envelope history.
    const supersessionRow = this.db
      .prepare(
        `SELECT COALESCE(
           SUM(
             length(CAST(replication_epoch AS BLOB)) +
             length(CAST(stream_identity AS BLOB))
           ),
           0
         ) AS bytes
         FROM sync_relay_epoch_supersessions
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    return (
      Number(blobRow?.bytes ?? 0) +
      Number(logRow?.bytes ?? 0) +
      Number(envelopeRow?.bytes ?? 0) +
      Number(envelopeHistoryRow?.bytes ?? 0) +
      Number(supersessionRow?.bytes ?? 0)
    );
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

  findThreadCreateChannelWireId(
    workspaceId: string,
    threadId: string,
  ): string | null | undefined {
    if (!threadId) return undefined;
    // LIKE pre-filter on the exact JSON fragment the canonical (sorted-key,
    // JSON.stringify-escaped) payload stores, wildcards escaped so a hostile
    // threadId cannot widen the match; the JSON.parse comparison below makes
    // the real decision.
    const needle = `"threadId":${JSON.stringify(threadId)}`
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM sync_relay_log
         WHERE workspace_id = ? AND op_kind = 'chat.thread.create'
           AND payload_json LIKE ? ESCAPE '\\'
         ORDER BY relay_seq`,
      )
      .all(workspaceId, `%${needle}%`);
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        continue;
      }
      const record = asObject(payload);
      if (!record || record.threadId !== threadId) continue;
      // The EARLIEST matching op is authoritative, whatever it says: a string
      // channelWireId with no linked-file owner is the binding; anything else
      // (a file-linked/both-owned thread or a pre-wire-id slug binding) is "no
      // shareable binding" — fail closed.
      return record.linkedObjectId === undefined &&
        typeof record.channelWireId === "string" &&
        record.channelWireId.length > 0
        ? record.channelWireId
        : null;
    }
    return undefined;
  }

  findChannelCreateKind(
    workspaceId: string,
    channelWireId: string,
  ): "channel" | "dm" | "agent" | null | undefined {
    if (!channelWireId) return undefined;
    // Canonical payload JSON sorts keys, so this exact fragment is a useful
    // pre-filter. Escaping LIKE metacharacters prevents a hostile wire id from
    // widening the scan; parsed exact equality below remains authoritative.
    const needle = `"wireId":${JSON.stringify(channelWireId)}`
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM sync_relay_log
         WHERE workspace_id = ? AND op_kind = 'chat.channel.create'
           AND payload_json LIKE ? ESCAPE '\\'
         ORDER BY relay_seq`,
      )
      .all(workspaceId, `%${needle}%`);
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        continue;
      }
      const record = asObject(payload);
      if (!record || record.wireId !== channelWireId) continue;
      // The earliest exact create is authoritative even when malformed; do not
      // skip forward to a later op that could forge a shareable kind. Require
      // the engine's basic replay shape and reserved agent-wire/kind invariant
      // before trusting a human kind; malformed creates resolve permanently
      // unshareable.
      if (
        typeof record.channelId !== "string" ||
        record.channelId.length === 0 ||
        typeof record.name !== "string" ||
        record.name.length === 0 ||
        typeof record.slug !== "string" ||
        record.slug.length === 0 ||
        (record.kind !== "channel" && record.kind !== "dm" && record.kind !== "agent") ||
        typeof record.createdAtMs !== "number" ||
        !Number.isFinite(record.createdAtMs) ||
        ((record.kind === "agent") !== (record.wireId === AGENT_CHANNEL_WIRE_ID))
      ) {
        return null;
      }
      return record.kind;
    }
    return undefined;
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

function workspaceIdentityFromRow(
  row: Record<string, unknown>,
): WorkspaceSyncIdentity | null {
  const replicationEpoch = row.replication_epoch;
  const streamIdentity = row.stream_identity;
  if (replicationEpoch == null && streamIdentity == null) return null;
  if (typeof replicationEpoch !== "string" || typeof streamIdentity !== "string") {
    throw new Error("sync relay workspace identity is partially populated");
  }
  return { replicationEpoch, streamIdentity };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Every blob sha an op REQUIRES the relay to already hold before the op may be
// durably logged. This MUST mirror dohc-engine-sync collect_blob_refs exactly:
// the push client uploads precisely this set (text + binary) before
// POST /log, so validating the same set neither rejects an honest push nor
// lets a referencing op slip through unvalidated. Enumerated by op kind:
//   - moment.append:      payloadBefore/After/before blob shas (both content
//                         kinds ship as uploaded blobs).
//   - conflict.open:      base/current/incoming state shas, but ONLY for
//                         binary states -- text conflict states carry their
//                         bytes INLINE in the payload and are never uploaded,
//                         so requiring them would wrongly reject a valid op.
//   - version.create:     every forkSnapshot blob sha (both content kinds).
//   - secret.file.put:    the ciphertext blob sha.
//   - secret.version.fork: every row's ciphertext blob sha.
// All other kinds (workspace.init, secret.file.delete, chat.*, reserved
// version.rename/chat.thread.update, and any unknown/opaque kind) reference no
// uploaded blobs. Fully defensive: a malformed payload shape yields no refs
// for that branch rather than throwing (the store's apply-time validation is
// the fail-closed backstop for shape).
export function referencedBlobShas(opKind: string, payloadJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  const record = asObject(parsed);
  if (!record) return [];
  const shas: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) shas.push(value);
  };
  if (opKind === "moment.append") {
    push(record.payloadBeforeBlobSha256);
    push(record.payloadAfterBlobSha256);
    push(record.beforeBlobSha256);
  } else if (opKind === "conflict.open") {
    for (const key of ["base", "current", "incoming"] as const) {
      const state = asObject(record[key]);
      if (state && state.exists === true && state.contentKind === "binary") {
        push(state.sha256);
      }
    }
  } else if (opKind === "version.create") {
    const snapshots = Array.isArray(record.forkSnapshots) ? record.forkSnapshots : [];
    for (const raw of snapshots) {
      const snapshot = asObject(raw);
      if (snapshot) push(snapshot.blobSha256);
    }
  } else if (opKind === "ydoc.update") {
    // A ydoc.update's Yjs bytes are content-addressed like any binary blob. The
    // relay stays content-agnostic (dumb log) but must count this reference so
    // (a) append-time validation requires the blob uploaded first, and (b) the
    // blob GC treats a blob a live ydoc.update op references as a ROOT — a live
    // rich-doc update blob is never collected out from under the log.
    push(record.updateBlobSha256);
  } else if (opKind === "secret.file.put") {
    push(record.ciphertextSha256);
  } else if (opKind === "secret.version.fork") {
    const rows = Array.isArray(record.rows) ? record.rows : [];
    for (const raw of rows) {
      const row = asObject(raw);
      if (row) push(row.ciphertextSha256);
    }
  }
  return shas;
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
  readonly statusCode = RELAY_ERRORS.conflict.status;
  readonly code = RELAY_ERRORS.conflict.code;
}

// A log append tried to originate a SECOND base for a Y.Doc lineage that
// already has one (dohc-ai/dohc#547). 409 with a distinct code: the push
// client must not confuse this with same-origin log divergence (plain
// `conflict`), because recovery is adoption — pull the winner's base and
// republish local rows as deltas — not a rewind/probe.
export class SyncRelayYdocBaseClaimedError extends Error {
  readonly statusCode = RELAY_ERRORS.ydoc_base_claimed.status;
  readonly code = RELAY_ERRORS.ydoc_base_claimed.code;
}

export class SyncRelayQuotaExceededError extends Error {
  readonly statusCode = RELAY_ERRORS.quota_exceeded.status;
  readonly code = RELAY_ERRORS.quota_exceeded.code;
}

// A log append referenced a blob the relay does not hold. 422 (not 409): the
// push client reserves 409 for same-origin log divergence (rewind/probe
// recovery), so a blob-missing rejection must use a DISTINCT retryable status
// the client surfaces as a generic failure and retries -- its next push
// re-uploads the missing blob (via /blobs/have) before re-posting the batch.
export class SyncRelayBlobMissingError extends Error {
  readonly statusCode = RELAY_ERRORS.blob_missing.status;
  readonly code = RELAY_ERRORS.blob_missing.code;
}
