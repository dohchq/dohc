import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {StorageContext} from "./context";
import type {SyncRelayLogInput} from "./types";
import {LIVE_JOURNAL_TABLE} from "./schema";
import {readAcceptedHistoryDeliveryMetadata, RestoreHistoryBudget} from "./liveAcceptedHistory";
import {parseSettlementAuthors} from "./hostedSettlement";

const MAX_RECORD_BYTES = 64_000_000;
const CHUNK_BYTES = 4 * 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function require(value: unknown): asserts value {if (!value) throw new Error("Unconfirmed live application.");}

/** A client audit is retained even when it cannot prove its authors. */
export function confirmLiveApplication(storage: StorageContext, op: SyncRelayLogInput, workspaceId: string,
  originId: string, batchCoordinates: ReadonlyMap<number, SyncRelayLogInput>) {
  if (op.opKind !== "live.audit.application") return;
  delete op.admittedAuthorSnapshot;
  try {
    const payload = JSON.parse(op.payloadJson);
    const manifest = payload.manifest;
    require(manifest?.formatVersion === 1 && Number.isSafeInteger(manifest.byteLength) &&
      manifest.byteLength > 0 && manifest.byteLength <= MAX_RECORD_BYTES && Array.isArray(manifest.chunks) &&
      manifest.chunks.length === Math.ceil(manifest.byteLength / CHUNK_BYTES));
    const chunks: Buffer[] = [];
    for (const [index, chunk] of manifest.chunks.entries()) {
      const length = Math.min(CHUNK_BYTES, manifest.byteLength - index * CHUNK_BYTES);
      require(chunk.byteLength === length && typeof chunk.sha256 === "string");
      const blob = storage.db.prepare(`SELECT content FROM sync_relay_blobs
        WHERE workspace_id=? AND sha256=? AND length(content)=?`).get(workspaceId, chunk.sha256, length)?.content;
      require(blob instanceof Uint8Array && blob.byteLength === length && sha(blob) === chunk.sha256);
      chunks.push(Buffer.isBuffer(blob) ? blob : Buffer.from(blob));
    }
    const bytes = Buffer.concat(chunks, manifest.byteLength);
    require(sha(bytes) === manifest.recordDigest);
    const record = JSON.parse(bytes.toString("utf8"));
    const metadata = record.metadata, binding = metadata?.accepted?.binding, receipt = metadata?.accepted?.receipt;
    require(record.kind === "application" && binding?.workspaceId === workspaceId &&
      binding.mainVersionId === payload.mainVersionId && binding.objectId === payload.objectId &&
      binding.lineageClaimId === payload.lineageClaimId && receipt?.updateDigest === payload.updateBlobSha256 &&
      record.eventCount === payload.eventCount && record.relayDatabaseNamespace === payload.relayDatabaseNamespace);
    const document = {workspaceId, mainVersionId: binding.mainVersionId, objectId: binding.objectId, lineageClaimId: binding.lineageClaimId};
    const header = storage.db.prepare(`SELECT accepted_event_count,accepted_evidence_digest,length(update_bytes) AS bytes
      FROM ${LIVE_JOURNAL_TABLE} WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?
      AND delivery_id=? AND journal_cursor=? AND relay_database_namespace=?`)
      .get(workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId,
        receipt.deliveryId, receipt.journalCursor, record.relayDatabaseNamespace);
    require(header && header.accepted_event_count === record.eventCount &&
      header.accepted_evidence_digest === record.evidenceDigest && header.bytes === record.updateByteLength);
    const trusted = readAcceptedHistoryDeliveryMetadata(storage, {document, namespace: record.relayDatabaseNamespace,
      through: receipt.journalCursor, eventCount: record.eventCount, deliveryId: receipt.deliveryId},
      new RestoreHistoryBudget(MAX_RECORD_BYTES, 1));
    require(trusted && isDeepStrictEqual(trusted, metadata));
    const coordinate = record.contentCoordinate;
    require(typeof coordinate?.originId === "string" && Number.isSafeInteger(coordinate.originSeq) && coordinate.originSeq >= 0);
    require(coordinate.originId !== originId || coordinate.originSeq < op.originSeq);
    const pending = coordinate.originId === originId ? batchCoordinates.get(coordinate.originSeq) : undefined;
    const content = pending ?? storage.db.prepare(`SELECT op_kind AS opKind,payload_json AS payloadJson FROM sync_relay_log
      WHERE workspace_id=? AND origin_id=? AND origin_seq=?`).get(workspaceId, coordinate.originId, coordinate.originSeq);
    require(content?.opKind === "ydoc.update");
    const update = JSON.parse(String(content.payloadJson));
    require(update.versionId === binding.mainVersionId && update.objectId === binding.objectId &&
      update.lineageClaimId === binding.lineageClaimId && update.path === binding.currentPath &&
      update.contentKind === "richdoc" && update.updateBlobSha256 === receipt.updateDigest && !update.isBaseState);
    const authors = new Map<string, unknown>();
    for (const author of [...(trusted.authorSnapshot ?? []), ...(trusted.checkpointCoverage ?? []).map(entry => entry.author)]) {
      authors.set(JSON.stringify(author), author);
    }
    if (authors.size) op.admittedAuthorSnapshot = parseSettlementAuthors([...authors.values()]);
  } catch {
    // No confirmation is safer than refusing the owner's content/log progress.
  }
}
