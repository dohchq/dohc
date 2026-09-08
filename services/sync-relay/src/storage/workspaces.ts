import {
  type WorkspaceSyncIdentity,
  type WorkspaceBootstrap,
  type VerifyWorkspaceIdentityResult,
  type ClaimWorkspaceIdentityResult,
  type RotateWorkspaceIdentityResult,
  type EnforceWorkspaceIdentityResult,
} from "./types";
import { type StorageContext } from "./context";
import { SyncRelayQuotaExceededError } from "./errors";

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

export function claimWorkspace(storage: StorageContext, input: {
    workspaceId: string;
    ownerUserId: string;
    createdAtMs: number;
  }): "created" | "owned" | "not-owner" {
    return storage.tx(() => {
      const existing = storage.db
        .prepare(
          "SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ?",
        )
        .get(input.workspaceId);
      if (typeof existing?.owner_user_id === "string") {
        return existing.owner_user_id === input.ownerUserId ? "owned" : "not-owner";
      }
      storage.db
        .prepare(
          `INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms)
           VALUES (?, ?, ?)`,
        )
        .run(input.workspaceId, input.ownerUserId, Math.trunc(input.createdAtMs));
      return "created";
    });
  }

export function getWorkspaceIdentity(storage: StorageContext, workspaceId: string): WorkspaceSyncIdentity | null {
    const row = storage.db
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

export function getWorkspaceBootstrap(storage: StorageContext, workspaceId: string): WorkspaceBootstrap {
    const row = storage.db
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

export function getEpochLogFloor(storage: StorageContext, workspaceId: string): number {
    const row = storage.db
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

export function verifyWorkspaceIdentity(storage: StorageContext, input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): VerifyWorkspaceIdentityResult {
    const row = storage.db
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
    return classifyWorkspaceIdentity(storage, input.workspaceId, current, input);
  }

export function claimWorkspaceIdentity(storage: StorageContext, input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): ClaimWorkspaceIdentityResult {
    // The common path is verification only. Do this SELECT before taking a
    // write lock so matched identity-bearing pulls/claims do not serialize
    // against relay writers.
    const initial = storage.db
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
      return classifyWorkspaceIdentity(storage,
        input.workspaceId,
        initialIdentity,
        input,
      );
    }

    // Only first adoption needs a write transaction. Re-read after acquiring
    // the lock to close the race with another claimant.
    return storage.tx(() => {
      const row = storage.db
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
        storage.db
          .prepare(
            `UPDATE sync_relay_workspaces
             SET replication_epoch = ?, stream_identity = ?, epoch_log_floor = 0
             WHERE workspace_id = ?`,
          )
          .run(input.replicationEpoch, input.streamIdentity, input.workspaceId);
        return "claimed";
      }
      const result = classifyWorkspaceIdentity(storage, input.workspaceId, current, input);
      return result;
    });
  }

export function rotateWorkspaceIdentity(storage: StorageContext, input: {
    workspaceId: string;
    ownerUserId: string;
    replicationEpoch: string;
    streamIdentity: string;
    rotatedAtMs: number;
  }): RotateWorkspaceIdentityResult {
    return storage.tx(() => {
      const row = storage.db
        .prepare(
          `SELECT owner_user_id, replication_epoch, stream_identity
           FROM sync_relay_workspaces
           WHERE workspace_id = ?`,
        )
        .get(input.workspaceId);
      if (row === undefined || row.owner_user_id !== input.ownerUserId) {
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
        return "unchanged";
      }

      // An epoch number that has entered history must never become active
      // again, even under a freshly minted stream id. This prevents a reset
      // generation from being resurrected by changing only half the coordinate.
      const targetEpochWasSuperseded =
        storage.db
          .prepare(
            `SELECT 1 AS ok
             FROM sync_relay_epoch_supersessions
             WHERE workspace_id = ? AND replication_epoch = ?
             LIMIT 1`,
          )
          .get(input.workspaceId, input.replicationEpoch) !== undefined;
      if (targetEpochWasSuperseded) {
        return "epoch-superseded";
      }
      if (typeof replicationEpoch === "string" && typeof streamIdentity === "string") {
        const alreadyRecorded =
          storage.db
            .prepare(
              `SELECT 1 AS ok
               FROM sync_relay_epoch_supersessions
               WHERE workspace_id = ? AND replication_epoch = ? AND stream_identity = ?`,
            )
            .get(input.workspaceId, replicationEpoch, streamIdentity) !== undefined;
        if (!alreadyRecorded) {
          assertWorkspaceQuota(storage,
            input.workspaceId,
            Buffer.byteLength(replicationEpoch, "utf8") +
              Buffer.byteLength(streamIdentity, "utf8"),
          );
        }
        storage.db
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
        storage.db
          .prepare(
            `SELECT COALESCE(MAX(relay_seq), 0) AS floor
             FROM sync_relay_log
             WHERE workspace_id = ?`,
          )
          .get(input.workspaceId)?.floor ?? 0,
      );
      storage.db
        .prepare(
          `UPDATE sync_relay_workspaces
           SET replication_epoch = ?, stream_identity = ?, epoch_log_floor = ?
           WHERE workspace_id = ?`,
        )
        .run(input.replicationEpoch, input.streamIdentity, floor, input.workspaceId);
      storage.db
        .prepare(
          `DELETE FROM sync_relay_current_files
           WHERE workspace_id = ?`,
        )
        .run(input.workspaceId);
      return "rotated";
    });
  }

export function classifyWorkspaceIdentity(
    storage: StorageContext,
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
      storage.db
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

export function enforceWorkspaceIdentityInTransaction(
    storage: StorageContext,
    workspaceId: string,
    presented: WorkspaceSyncIdentity | null,
  ): EnforceWorkspaceIdentityResult {
    const row = storage.db
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
      return classifyWorkspaceIdentity(storage, workspaceId, current, presented);
    }
    storage.db
      .prepare(
        `UPDATE sync_relay_workspaces
         SET replication_epoch = ?, stream_identity = ?, epoch_log_floor = 0
         WHERE workspace_id = ?`,
      )
      .run(presented.replicationEpoch, presented.streamIdentity, workspaceId);
    return "claimed";
  }

export function workspaceIsOwnedBy(storage: StorageContext, workspaceId: string, ownerUserId: string): boolean {
    const row = storage.db
      .prepare(
        `SELECT 1 AS ok
         FROM sync_relay_workspaces
         WHERE workspace_id = ? AND owner_user_id = ?`,
      )
      .get(workspaceId, ownerUserId);
    return row !== undefined;
  }

export function workspaceUsageBytes(storage: StorageContext, workspaceId: string): number {
    const row = storage.db
      .prepare(
        `SELECT usage_bytes
         FROM sync_relay_workspace_usage
         WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === undefined) {
      throw new Error("workspace usage counter is missing");
    }
    return Number(row.usage_bytes);
  }

export function assertWorkspaceQuota(storage: StorageContext, workspaceId: string, addedBytes: number): void {
    if (addedBytes <= 0) return;
    const currentUsage = workspaceUsageBytes(storage, workspaceId);
    if (currentUsage + addedBytes > storage.options.workspaceQuotaBytes) {
      throw new SyncRelayQuotaExceededError(
        `workspace storage quota exceeded: ${currentUsage + addedBytes} bytes would exceed quota ${storage.options.workspaceQuotaBytes}`,
      );
    }
  }
