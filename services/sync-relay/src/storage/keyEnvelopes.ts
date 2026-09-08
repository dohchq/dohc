import type { StorageContext } from "./context";
import { assertWorkspaceQuota } from "./workspaces";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { SyncRelayConflictError } from "./errors";
import type { KeyEnvelopeRow } from "./types";

export function putKeyEnvelope(storage: StorageContext, input: {
    workspaceId: string;
    envelopeJson: string;
    updatedAtMs: number;
    expectedSha256: string | null;
  }): { sha256: string } {
    const nextSha256 = sha256Hex(input.envelopeJson);
    storage.db.exec("BEGIN IMMEDIATE");
    try {
      const current = storage.db
        .prepare(
          "SELECT envelope_json FROM sync_relay_key_envelopes WHERE workspace_id = ?",
        )
        .get(input.workspaceId);
      const currentJson =
        typeof current?.envelope_json === "string" ? current.envelope_json : null;
      if (currentJson === input.envelopeJson) {
        // Byte-identical re-PUT: an idempotent retry (e.g. enroll after a
        // dropped response), not a replacement. No history entry.
        storage.db.exec("COMMIT");
        return { sha256: nextSha256 };
      }
      // The envelope + its append-only history count toward the workspace
      // quota: each rotation adds roughly the new
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
        assertWorkspaceQuota(storage, input.workspaceId, envelopeAddedBytes);
        storage.db
          .prepare(
            `INSERT INTO sync_relay_key_envelopes (workspace_id, envelope_json, updated_at_ms)
             VALUES (?, ?, ?)`,
          )
          .run(input.workspaceId, input.envelopeJson, Math.trunc(input.updatedAtMs));
        storage.db.exec("COMMIT");
        return { sha256: nextSha256 };
      }
      const currentSha256 = sha256Hex(currentJson);
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
      assertWorkspaceQuota(storage, input.workspaceId, envelopeAddedBytes);
      storage.db
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
      storage.db
        .prepare(
          `UPDATE sync_relay_key_envelopes
           SET envelope_json = ?, updated_at_ms = ?
           WHERE workspace_id = ?`,
        )
        .run(input.envelopeJson, Math.trunc(input.updatedAtMs), input.workspaceId);
      storage.db.exec("COMMIT");
      return { sha256: nextSha256 };
    } catch (error) {
      try {
        storage.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

export function getKeyEnvelope(storage: StorageContext, workspaceId: string): KeyEnvelopeRow | null {
    const row = storage.db
      .prepare(
        "SELECT envelope_json, updated_at_ms FROM sync_relay_key_envelopes WHERE workspace_id = ?",
      )
      .get(workspaceId);
    if (typeof row?.envelope_json !== "string") return null;
    return {
      envelopeJson: row.envelope_json,
      sha256: sha256Hex(row.envelope_json),
      updatedAtMs: Number(row.updated_at_ms),
    };
  }
