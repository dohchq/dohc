import type { StorageContext } from "./context";
import { assertWorkspaceQuota } from "./workspaces";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { envelopeKeyCheck } from "@dohc/security-contract/secret-key-envelope";
import { SyncRelayConflictError } from "./errors";
import type { KeyEnvelopeRow } from "./types";

export function putKeyEnvelope(
  storage: StorageContext,
  input: {
    workspaceId: string;
    envelopeJson: string;
    updatedAtMs: number;
    expectedSha256: string | null;
  },
): { sha256: string } {
  const nextSha256 = sha256Hex(input.envelopeJson);
  return storage.tx(() => {
    const current = storage.db
      .prepare("SELECT envelope_json FROM sync_relay_key_envelopes WHERE workspace_id = ?")
      .get(input.workspaceId);
    const currentJson = typeof current?.envelope_json === "string" ? current.envelope_json : null;
    if (currentJson === input.envelopeJson) {
      // Byte-identical re-PUT: an idempotent retry (e.g. enroll after a
      // dropped response), not a replacement. No history entry.
      return { sha256: nextSha256 };
    }
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
    const keyCheck = envelopeKeyCheck(input.envelopeJson);
    if (keyCheck !== null && keyCheck === envelopeKeyCheck(currentJson)) {
      const prunedBytes = deleteHistoryWithKeyCheck(storage, input.workspaceId, keyCheck);
      assertWorkspaceQuota(
        storage,
        input.workspaceId,
        envelopeAddedBytes - Buffer.byteLength(currentJson, "utf8") - prunedBytes,
      );
      replaceCurrentEnvelope(storage, input);
      return { sha256: nextSha256 };
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
    replaceCurrentEnvelope(storage, input);
    return { sha256: nextSha256 };
  });
}

function replaceCurrentEnvelope(
  storage: StorageContext,
  input: { workspaceId: string; envelopeJson: string; updatedAtMs: number },
): void {
  storage.db
    .prepare(
      `UPDATE sync_relay_key_envelopes
         SET envelope_json = ?, updated_at_ms = ?
         WHERE workspace_id = ?`,
    )
    .run(input.envelopeJson, Math.trunc(input.updatedAtMs), input.workspaceId);
}

function deleteHistoryWithKeyCheck(
  storage: StorageContext,
  workspaceId: string,
  keyCheck: string,
): number {
  const rows = storage.db
    .prepare(
      "SELECT history_seq, envelope_json FROM sync_relay_key_envelope_history WHERE workspace_id = ?",
    )
    .all(workspaceId);
  const remove = storage.db.prepare(
    "DELETE FROM sync_relay_key_envelope_history WHERE history_seq = ?",
  );
  let bytes = 0;
  for (const row of rows) {
    if (typeof row.envelope_json !== "string" || envelopeKeyCheck(row.envelope_json) !== keyCheck) {
      continue;
    }
    remove.run(Number(row.history_seq));
    bytes += Buffer.byteLength(row.envelope_json, "utf8");
  }
  return bytes;
}

export function getKeyEnvelope(
  storage: StorageContext,
  workspaceId: string,
): KeyEnvelopeRow | null {
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
