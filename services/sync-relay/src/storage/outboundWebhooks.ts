import { MAX_WORKSPACE_HTTP_APPROVALS } from "@dohc/workspace-contracts/http-step-approvals";
import { accountIsFenced, workspaceIsDeleted } from "./accountDeletion";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";
import { assertWorkspaceQuota } from "./workspaces";

const HTTP_DISPATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const HTTP_DISPATCH_PRUNE_BATCH = 100;

export type ApproveWorkspaceHttpStepResult =
  | { readonly ok: true; readonly approvalDigest: string }
  | {
      readonly ok: false;
      readonly reason: "limit-reached";
      readonly limit: number;
      readonly count: number;
    }
  | { readonly ok: false; readonly reason: "unauthorized" };

export type ReserveWorkspaceHttpDispatchResult<Refusal = never> =
  | { readonly ok: true; readonly reserved: true }
  | {
      readonly ok: true;
      readonly reserved: false;
      readonly existing: {
        readonly status: "pending" | "sent" | "failed";
        readonly httpStatus: number | null;
        readonly errorReason: string | null;
      };
    }
  | { readonly ok: false; readonly reason: "unauthorized" }
  | { readonly ok: false; readonly reason: "refused"; readonly refusal: Refusal };

export interface ActiveWorkspaceShareGrantRow {
  readonly selectorJson: string;
  readonly access: string;
  readonly principalKind: string;
  readonly principalUserId: string | null;
  readonly pendingMemberInvite: boolean;
}

const MAX_DISPATCH_ERROR_REASON_BYTES = 500;

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let end = low;
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

export function initializeOutboundWebhookSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_http_approvals (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      approval_digest TEXT NOT NULL CHECK (length(approval_digest) = 64),
      collection_path TEXT NOT NULL CHECK (length(collection_path) BETWEEN 1 AND 1024),
      automation_id TEXT NOT NULL CHECK (length(automation_id) BETWEEN 1 AND 64),
      step_ordinal INTEGER NOT NULL CHECK (step_ordinal >= 0),
      approved_at_ms INTEGER NOT NULL CHECK (approved_at_ms >= 0),
      storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
      PRIMARY KEY (workspace_id, approval_digest)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_http_approvals_workspace
      ON sync_relay_http_approvals(workspace_id, approved_at_ms);
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_http_approvals_usage_insert
      AFTER INSERT ON sync_relay_http_approvals
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes + NEW.storage_bytes
        WHERE workspace_id = NEW.workspace_id;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_http_approvals_usage_update
      AFTER UPDATE OF storage_bytes ON sync_relay_http_approvals
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes + NEW.storage_bytes
        WHERE workspace_id = NEW.workspace_id;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_http_approvals_usage_delete
      AFTER DELETE ON sync_relay_http_approvals
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes
        WHERE workspace_id = OLD.workspace_id;
      END;

    CREATE TABLE IF NOT EXISTS sync_relay_http_dispatches (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      delivery_id TEXT NOT NULL CHECK (length(delivery_id) = 64),
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
      http_status INTEGER,
      error_reason TEXT,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
      storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
      PRIMARY KEY (workspace_id, delivery_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_http_dispatches_prune
      ON sync_relay_http_dispatches(workspace_id, status, updated_at_ms);
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_http_dispatches_usage_insert
      AFTER INSERT ON sync_relay_http_dispatches
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes + NEW.storage_bytes
        WHERE workspace_id = NEW.workspace_id;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_http_dispatches_usage_update
      AFTER UPDATE OF storage_bytes ON sync_relay_http_dispatches
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes + NEW.storage_bytes
        WHERE workspace_id = NEW.workspace_id;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_http_dispatches_usage_delete
      AFTER DELETE ON sync_relay_http_dispatches
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes
        WHERE workspace_id = OLD.workspace_id;
      END;
  `);
}

function ownerMayMutateWorkspace(
  storage: StorageContext,
  workspaceId: string,
  ownerUserId: string,
): boolean {
  if (accountIsFenced(storage, ownerUserId) || workspaceIsDeleted(storage, workspaceId)) {
    return false;
  }
  const row = storage.db
    .prepare(
      "SELECT 1 FROM sync_relay_workspaces WHERE workspace_id = ? AND owner_user_id = ? LIMIT 1",
    )
    .get(workspaceId, ownerUserId);
  return row !== undefined;
}

export function listWorkspaceHttpStepApprovals(
  storage: StorageContext,
  workspaceId: string,
): string[] {
  const rows = storage.db
    .prepare(
      `SELECT approval_digest
         FROM sync_relay_http_approvals
         WHERE workspace_id = ?
         ORDER BY approval_digest ASC`,
    )
    .all(workspaceId);
  return rows.map((row) => String(row.approval_digest));
}

export function hasWorkspaceHttpStepApproval(
  storage: StorageContext,
  workspaceId: string,
  approvalDigest: string,
): boolean {
  const row = storage.db
    .prepare(
      `SELECT 1 FROM sync_relay_http_approvals
         WHERE workspace_id = ? AND approval_digest = ? LIMIT 1`,
    )
    .get(workspaceId, approvalDigest);
  return row !== undefined;
}

export function approveWorkspaceHttpStep(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly approvalDigest: string;
    readonly collectionPath: string;
    readonly automationId: string;
    readonly stepOrdinal: number;
    readonly nowMs: number;
  },
): ApproveWorkspaceHttpStepResult {
  const now = Math.trunc(input.nowMs);
  return storage.tx(() => {
    if (!ownerMayMutateWorkspace(storage, input.workspaceId, input.ownerUserId)) {
      return { ok: false, reason: "unauthorized" };
    }
    storage.db
      .prepare(
        `DELETE FROM sync_relay_http_approvals
          WHERE workspace_id = ?
            AND collection_path = ?
            AND automation_id = ?
            AND step_ordinal = ?
            AND approval_digest <> ?`,
      )
      .run(
        input.workspaceId,
        input.collectionPath,
        input.automationId,
        input.stepOrdinal,
        input.approvalDigest,
      );
    const existing = storage.db
      .prepare(
        `SELECT storage_bytes FROM sync_relay_http_approvals
           WHERE workspace_id = ? AND approval_digest = ?`,
      )
      .get(input.workspaceId, input.approvalDigest);
    if (!existing) {
      const countRow = storage.db
        .prepare("SELECT COUNT(*) AS count FROM sync_relay_http_approvals WHERE workspace_id = ?")
        .get(input.workspaceId);
      const count = Number(countRow?.count ?? 0);
      if (count >= MAX_WORKSPACE_HTTP_APPROVALS) {
        return {
          ok: false,
          reason: "limit-reached",
          limit: MAX_WORKSPACE_HTTP_APPROVALS,
          count,
        };
      }
    }
    const storageBytes =
      Buffer.byteLength(input.approvalDigest, "utf8") +
      Buffer.byteLength(input.collectionPath, "utf8") +
      Buffer.byteLength(input.automationId, "utf8") +
      32;
    const previousBytes = existing ? Number(existing.storage_bytes) : 0;
    if (storageBytes > previousBytes) {
      assertWorkspaceQuota(storage, input.workspaceId, storageBytes - previousBytes);
    }
    if (existing) {
      storage.db
        .prepare(
          `UPDATE sync_relay_http_approvals
              SET collection_path = ?, automation_id = ?, step_ordinal = ?, approved_at_ms = ?, storage_bytes = ?
            WHERE workspace_id = ? AND approval_digest = ?`,
        )
        .run(
          input.collectionPath,
          input.automationId,
          input.stepOrdinal,
          now,
          storageBytes,
          input.workspaceId,
          input.approvalDigest,
        );
    } else {
      storage.db
        .prepare(
          `INSERT INTO sync_relay_http_approvals (
              workspace_id, approval_digest, collection_path, automation_id,
              step_ordinal, approved_at_ms, storage_bytes
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.workspaceId,
          input.approvalDigest,
          input.collectionPath,
          input.automationId,
          input.stepOrdinal,
          now,
          storageBytes,
        );
    }
    return { ok: true, approvalDigest: input.approvalDigest };
  });
}

export function reserveWorkspaceHttpDispatch<Refusal = never>(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly deliveryId: string;
    readonly nowMs: number;
    readonly beforeReserve?: () => Refusal | null;
  },
): ReserveWorkspaceHttpDispatchResult<Refusal> {
  const now = Math.trunc(input.nowMs);
  const cutoff = Math.max(0, now - HTTP_DISPATCH_RETENTION_MS);
  return storage.tx(() => {
    if (!ownerMayMutateWorkspace(storage, input.workspaceId, input.ownerUserId)) {
      return { ok: false, reason: "unauthorized" };
    }
    if (input.beforeReserve) {
      const refusal = input.beforeReserve();
      if (refusal !== null) {
        return { ok: false, reason: "refused", refusal };
      }
    }
    storage.db
      .prepare(
        `DELETE FROM sync_relay_http_dispatches
          WHERE workspace_id = ? AND delivery_id IN (
            SELECT delivery_id FROM sync_relay_http_dispatches
             WHERE workspace_id = ? AND updated_at_ms < ?
             ORDER BY updated_at_ms ASC
             LIMIT ?
          )`,
      )
      .run(input.workspaceId, input.workspaceId, cutoff, HTTP_DISPATCH_PRUNE_BATCH);

    const existing = storage.db
      .prepare(
        `SELECT status, http_status, error_reason
           FROM sync_relay_http_dispatches
           WHERE workspace_id = ? AND delivery_id = ?`,
      )
      .get(input.workspaceId, input.deliveryId);
    if (existing) {
      return {
        ok: true,
        reserved: false,
        existing: {
          status: String(existing.status) as "pending" | "sent" | "failed",
          httpStatus: existing.http_status == null ? null : Number(existing.http_status),
          errorReason: existing.error_reason == null ? null : String(existing.error_reason),
        },
      };
    }

    const reservedBytes =
      Buffer.byteLength(input.deliveryId, "utf8") + 32 + MAX_DISPATCH_ERROR_REASON_BYTES;
    assertWorkspaceQuota(storage, input.workspaceId, reservedBytes);
    storage.db
      .prepare(
        `INSERT INTO sync_relay_http_dispatches (
            workspace_id, delivery_id, status, http_status, error_reason,
            created_at_ms, updated_at_ms, storage_bytes
          ) VALUES (?, ?, 'pending', NULL, NULL, ?, ?, ?)`,
      )
      .run(input.workspaceId, input.deliveryId, now, now, reservedBytes);
    return { ok: true, reserved: true };
  });
}

export function finalizeWorkspaceHttpDispatch(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly deliveryId: string;
    readonly status: "sent" | "failed";
    readonly httpStatus: number | null;
    readonly errorReason: string | null;
    readonly nowMs: number;
  },
): void {
  const now = Math.trunc(input.nowMs);
  storage.tx(() => {
    const existing = storage.db
      .prepare(
        `SELECT created_at_ms, storage_bytes FROM sync_relay_http_dispatches
           WHERE workspace_id = ? AND delivery_id = ?`,
      )
      .get(input.workspaceId, input.deliveryId);
    if (!existing) return;
    const boundedReason = input.errorReason
      ? truncateUtf8Bytes(input.errorReason, MAX_DISPATCH_ERROR_REASON_BYTES)
      : null;
    const storageBytes =
      Buffer.byteLength(input.deliveryId, "utf8") +
      (boundedReason ? Buffer.byteLength(boundedReason, "utf8") : 0) +
      32;
    const updatedAtMs = Math.max(Number(existing.created_at_ms), now);
    storage.db
      .prepare(
        `UPDATE sync_relay_http_dispatches
            SET status = ?, http_status = ?, error_reason = ?, updated_at_ms = ?, storage_bytes = ?
          WHERE workspace_id = ? AND delivery_id = ?`,
      )
      .run(
        input.status,
        input.httpStatus,
        boundedReason,
        updatedAtMs,
        storageBytes,
        input.workspaceId,
        input.deliveryId,
      );
  });
}

export function listActiveWorkspaceShareGrants(
  storage: StorageContext,
  workspaceId: string,
): ActiveWorkspaceShareGrantRow[] {
  const rows = storage.db
    .prepare(
      `SELECT s.selector_json, g.access, g.principal_kind, g.principal_user_id,
              EXISTS (SELECT 1 FROM sync_relay_workspace_members m
                       WHERE m.grant_id = g.grant_id AND m.state = 'invited') AS pending_member_invite
         FROM sync_relay_shares s
         JOIN sync_relay_share_grants g ON g.share_id = s.share_id
        WHERE s.workspace_id = ? AND g.status = 'active'`,
    )
    .all(workspaceId);
  return rows.map((row) => ({
    selectorJson: String(row.selector_json),
    access: String(row.access),
    principalKind: String(row.principal_kind),
    principalUserId: row.principal_user_id == null ? null : String(row.principal_user_id),
    pendingMemberInvite: Number(row.pending_member_invite) === 1,
  }));
}

export function readCommittedWorkspaceTextFile(
  storage: StorageContext,
  workspaceId: string,
  versionId: string,
  path: string,
  maxBytes: number,
): string | null {
  const row = storage.db
    .prepare(
      `SELECT f.blob_sha256, b.byte_length
         FROM sync_relay_current_files f
         JOIN sync_relay_blobs b
           ON b.workspace_id = f.workspace_id AND b.sha256 = f.blob_sha256
        WHERE f.workspace_id = ? AND f.version_id = ? AND f.path = ?`,
    )
    .get(workspaceId, versionId, path);
  if (!row) return null;
  const byteLength = Number(row.byte_length);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxBytes) return null;
  const blob = storage.getBlob(workspaceId, String(row.blob_sha256));
  if (!blob || blob.byteLength !== byteLength) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob);
  } catch {
    return null;
  }
}

export function committedWorkspaceFileExists(
  storage: StorageContext,
  workspaceId: string,
  versionId: string,
  path: string,
): boolean {
  const row = storage.db
    .prepare(
      `SELECT 1 FROM sync_relay_current_files
         WHERE workspace_id = ? AND version_id = ? AND path = ? LIMIT 1`,
    )
    .get(workspaceId, versionId, path);
  return row !== undefined;
}
