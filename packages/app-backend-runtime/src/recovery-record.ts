import { createHash } from "node:crypto";
import type { DatasetCursor, JournalExportRecord } from "./journal.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function invalidRecovery(reason: string): never { throw new Error(`dohc could not read this recovery file: ${reason}`); }
export function recoveryObject(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidRecovery("expected object.");
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) return invalidRecovery("unexpected record fields.");
  return row;
}
export function recoveryText(v: unknown, max = 4096): string {
  if (typeof v !== "string" || !v || v.includes("\0") || Buffer.byteLength(v) > max) return invalidRecovery("invalid text.");
  return v;
}
export function recoveryInteger(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) return invalidRecovery("invalid number."); return v;
}
export function recoveryDigest(v: unknown): string { if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) return invalidRecovery("invalid hash."); return v; }
export function parseRecoveryCursor(v: unknown): DatasetCursor {
  const r = recoveryObject(v, ["workspaceId", "datasetId", "hostEpoch", "approvedRevisionHash", "revision", "digest"]);
  return { workspaceId: recoveryText(r.workspaceId), datasetId: recoveryText(r.datasetId), hostEpoch: recoveryText(r.hostEpoch, 256),
    approvedRevisionHash: recoveryDigest(r.approvedRevisionHash), revision: recoveryInteger(r.revision), digest: recoveryDigest(r.digest) };
}
export function equalRecoveryCursor(a: DatasetCursor, b: DatasetCursor): boolean {
  return a.workspaceId === b.workspaceId && a.datasetId === b.datasetId && a.hostEpoch === b.hostEpoch &&
    a.approvedRevisionHash === b.approvedRevisionHash && a.revision === b.revision && a.digest === b.digest;
}
/** Metadata only; the caller must separately verify the streamed blob's length and hash. */
export function parseRecoveryJournalRecord(value: unknown, maxEventBytes = 16 * 1024 * 1024): JournalExportRecord {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === "checkpoint") {
    const r = recoveryObject(value, ["kind", "cursor", "previous", "source", "schemaSql", "definitionJson", "capacityBytes", "byteLength", "sha256"]);
    const c = parseRecoveryCursor(r.cursor), p = r.previous === null ? null : parseRecoveryCursor(r.previous);
    const source = recoveryText(r.source, 256 * 1024), schemaSql = recoveryText(r.schemaSql, 256 * 1024), definitionJson = recoveryText(r.definitionJson, 256 * 1024);
    JSON.parse(definitionJson);
    const capacityBytes = recoveryInteger(r.capacityBytes, 4096, 1024 * 1024 * 1024), byteLength = recoveryInteger(r.byteLength, 100, capacityBytes), sha256 = recoveryDigest(r.sha256);
    if (p ? p.workspaceId !== c.workspaceId || p.datasetId !== c.datasetId || p.revision + 1 !== c.revision : c.revision !== 0) return invalidRecovery("checkpoint ancestry differs.");
    const actual = hash(JSON.stringify(["dohc-dataset-checkpoint-v1", c.workspaceId, c.datasetId, c.hostEpoch, c.approvedRevisionHash, c.revision,
      p ? [p.workspaceId, p.datasetId, p.hostEpoch, p.approvedRevisionHash, p.revision, p.digest] : null, sha256, hash(source), hash(schemaSql), hash(definitionJson), capacityBytes]));
    if (actual !== c.digest) return invalidRecovery("checkpoint digest differs.");
    return { kind, cursor: c, previous: p, source, schemaSql, definitionJson, capacityBytes, byteLength, sha256 };
  }
  if (kind !== "event") return invalidRecovery("unexpected journal record.");
  const r = recoveryObject(value, ["kind", "cursor", "previousDigest", "proposalId", "operation", "callerKey", "idempotencyKey", "payloadSha256", "resultJson", "changesetSha256", "attachedFileIds", "recordedAtMs", "byteLength"]);
  const c = parseRecoveryCursor(r.cursor), previousDigest = recoveryDigest(r.previousDigest), proposalId = recoveryText(r.proposalId, 256), operation = recoveryText(r.operation, 256),
    callerKey = recoveryText(r.callerKey, 1024), idempotencyKey = recoveryText(r.idempotencyKey, 128), payloadSha256 = recoveryDigest(r.payloadSha256),
    resultJson = recoveryText(r.resultJson, 256 * 1024), changesetSha256 = recoveryDigest(r.changesetSha256), recordedAtMs = recoveryInteger(r.recordedAtMs), byteLength = recoveryInteger(r.byteLength, 0, maxEventBytes);
  JSON.parse(resultJson);
  if (!Array.isArray(r.attachedFileIds) || r.attachedFileIds.length > 64 || r.attachedFileIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(id)) || new Set(r.attachedFileIds).size !== r.attachedFileIds.length) return invalidRecovery("invalid attachment references.");
  const attachedFileIds = [...r.attachedFileIds].sort() as string[];
  if (hash(JSON.stringify(["dohc-dataset-event-v1", c.workspaceId, c.datasetId, c.hostEpoch, c.approvedRevisionHash, c.revision, previousDigest,
    proposalId, operation, callerKey, idempotencyKey, payloadSha256, hash(resultJson), changesetSha256, attachedFileIds, recordedAtMs])) !== c.digest) return invalidRecovery("event digest differs.");
  return { kind, cursor: c, previousDigest, proposalId, operation, callerKey, idempotencyKey, payloadSha256, resultJson, changesetSha256, attachedFileIds, recordedAtMs, byteLength };
}
