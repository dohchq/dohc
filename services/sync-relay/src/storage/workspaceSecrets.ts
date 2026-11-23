import {
  MAX_WORKSPACE_SECRETS,
  type WorkspaceSecretSummary,
  type WorkspaceSecretUsage,
  type WorkspaceSecretWriteMode,
} from "@dohc/workspace-contracts/workspace-secrets";
import { accountIsFenced, workspaceIsDeleted } from "./accountDeletion";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";
import { assertWorkspaceQuota } from "./workspaces";

export interface StoredWorkspaceSecret {
  readonly summary: WorkspaceSecretSummary;
  readonly sealedValue: string;
  readonly keyId: string;
}

export type UpsertWorkspaceSecretResult =
  | {
      readonly ok: true;
      readonly secret: WorkspaceSecretSummary;
      readonly secrets: WorkspaceSecretSummary[];
    }
  | {
      readonly ok: false;
      readonly reason: "limit-reached";
      readonly limit: number;
      readonly count: number;
    }
  | { readonly ok: false; readonly reason: "already-exists" | "not-found" | "unauthorized" };

export type DeleteWorkspaceSecretResult =
  | { readonly ok: true; readonly deleted: boolean; readonly secrets: WorkspaceSecretSummary[] }
  | { readonly ok: false; readonly reason: "unauthorized" };

export function initializeWorkspaceSecretSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_workspace_secrets (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
      usage TEXT NOT NULL CHECK (usage IN ('http-header', 'http-url')),
      allowed_hosts_json TEXT NOT NULL CHECK (json_valid(allowed_hosts_json)),
      sealed_value TEXT NOT NULL CHECK (length(sealed_value) > 0),
      key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 64),
      generation INTEGER NOT NULL CHECK (generation >= 1),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
      storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
      PRIMARY KEY (workspace_id, name)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_workspace_secrets_workspace
      ON sync_relay_workspace_secrets(workspace_id, name);
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_secrets_usage_insert
      AFTER INSERT ON sync_relay_workspace_secrets
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes + NEW.storage_bytes
        WHERE workspace_id = NEW.workspace_id;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_secrets_usage_update
      AFTER UPDATE OF storage_bytes ON sync_relay_workspace_secrets
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes + NEW.storage_bytes
        WHERE workspace_id = NEW.workspace_id;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_secrets_usage_delete
      AFTER DELETE ON sync_relay_workspace_secrets
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes
        WHERE workspace_id = OLD.workspace_id;
      END;
  `);
}

function summaryFromRow(row: Record<string, unknown>): WorkspaceSecretSummary {
  const allowedHosts = JSON.parse(String(row.allowed_hosts_json)) as string[];
  return {
    name: String(row.name),
    usage: String(row.usage) as WorkspaceSecretUsage,
    allowedHosts,
    generation: Number(row.generation),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function listWorkspaceSecrets(
  storage: StorageContext,
  workspaceId: string,
): WorkspaceSecretSummary[] {
  const rows = storage.db
    .prepare(
      `SELECT name, usage, allowed_hosts_json, generation, created_at_ms, updated_at_ms
         FROM sync_relay_workspace_secrets
         WHERE workspace_id = ?
         ORDER BY name ASC`,
    )
    .all(workspaceId);
  return rows.map(summaryFromRow);
}

export function readWorkspaceSecretForExecution(
  storage: StorageContext,
  workspaceId: string,
  name: string,
): StoredWorkspaceSecret | null {
  const row = storage.db
    .prepare(
      `SELECT name, usage, allowed_hosts_json, sealed_value, key_id, generation, created_at_ms, updated_at_ms
         FROM sync_relay_workspace_secrets
         WHERE workspace_id = ? AND name = ?`,
    )
    .get(workspaceId, name);
  if (!row) return null;
  return {
    summary: summaryFromRow(row),
    sealedValue: String(row.sealed_value),
    keyId: String(row.key_id),
  };
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

export function upsertWorkspaceSecret(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly name: string;
    readonly mode: WorkspaceSecretWriteMode;
    readonly usage: WorkspaceSecretUsage;
    readonly allowedHosts: readonly string[];
    readonly keyId: string;
    readonly seal: (generation: number) => string;
    readonly nowMs: number;
  },
): UpsertWorkspaceSecretResult {
  const now = Math.trunc(input.nowMs);
  const allowedHostsJson = JSON.stringify(input.allowedHosts);
  return storage.tx(() => {
    if (!ownerMayMutateWorkspace(storage, input.workspaceId, input.ownerUserId)) {
      return { ok: false, reason: "unauthorized" };
    }
    const existing = storage.db
      .prepare(
        `SELECT generation, created_at_ms, storage_bytes
           FROM sync_relay_workspace_secrets
           WHERE workspace_id = ? AND name = ?`,
      )
      .get(input.workspaceId, input.name);

    if (input.mode === "create" && existing) {
      return { ok: false, reason: "already-exists" };
    }
    if (input.mode === "replace" && !existing) {
      return { ok: false, reason: "not-found" };
    }

    const generation = existing ? Number(existing.generation) + 1 : 1;
    const createdAtMs = existing ? Number(existing.created_at_ms) : now;
    const updatedAtMs = Math.max(createdAtMs, now);

    if (!existing) {
      const countRow = storage.db
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_relay_workspace_secrets WHERE workspace_id = ?",
        )
        .get(input.workspaceId);
      const count = Number(countRow?.count ?? 0);
      if (count >= MAX_WORKSPACE_SECRETS) {
        return { ok: false, reason: "limit-reached", limit: MAX_WORKSPACE_SECRETS, count };
      }
    }

    const sealedValue = input.seal(generation);
    const storageBytes =
      Buffer.byteLength(input.name, "utf8") +
      Buffer.byteLength(input.usage, "utf8") +
      Buffer.byteLength(allowedHostsJson, "utf8") +
      Buffer.byteLength(sealedValue, "utf8") +
      Buffer.byteLength(input.keyId, "utf8");

    const previousBytes = existing ? Number(existing.storage_bytes) : 0;
    if (storageBytes > previousBytes) {
      assertWorkspaceQuota(storage, input.workspaceId, storageBytes - previousBytes);
    }

    if (existing) {
      storage.db
        .prepare(
          `UPDATE sync_relay_workspace_secrets
              SET usage = ?, allowed_hosts_json = ?, sealed_value = ?, key_id = ?,
                  generation = ?, updated_at_ms = ?, storage_bytes = ?
            WHERE workspace_id = ? AND name = ?`,
        )
        .run(
          input.usage,
          allowedHostsJson,
          sealedValue,
          input.keyId,
          generation,
          updatedAtMs,
          storageBytes,
          input.workspaceId,
          input.name,
        );
    } else {
      storage.db
        .prepare(
          `INSERT INTO sync_relay_workspace_secrets (
              workspace_id, name, usage, allowed_hosts_json, sealed_value, key_id,
              generation, created_at_ms, updated_at_ms, storage_bytes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.workspaceId,
          input.name,
          input.usage,
          allowedHostsJson,
          sealedValue,
          input.keyId,
          generation,
          createdAtMs,
          updatedAtMs,
          storageBytes,
        );
    }

    return {
      ok: true,
      secret: {
        name: input.name,
        usage: input.usage,
        allowedHosts: [...input.allowedHosts],
        generation,
        createdAtMs,
        updatedAtMs,
      },
      secrets: listWorkspaceSecrets(storage, input.workspaceId),
    };
  });
}

export function deleteWorkspaceSecret(
  storage: StorageContext,
  workspaceId: string,
  ownerUserId: string,
  name: string,
): DeleteWorkspaceSecretResult {
  return storage.tx(() => {
    if (!ownerMayMutateWorkspace(storage, workspaceId, ownerUserId)) {
      return { ok: false, reason: "unauthorized" };
    }
    const result = storage.db
      .prepare("DELETE FROM sync_relay_workspace_secrets WHERE workspace_id = ? AND name = ?")
      .run(workspaceId, name);
    return {
      ok: true,
      deleted: Number(result.changes) > 0,
      secrets: listWorkspaceSecrets(storage, workspaceId),
    };
  });
}
