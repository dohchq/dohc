import {setImmediate} from "node:timers/promises";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {StorageContext} from "./context";
import type {SyncRelayLogInput} from "./types";
import {LIVE_JOURNAL_TABLE, LIVE_APPLICATION_AUTHORSHIP_INDEX} from "./schema";
import {readAcceptedHistoryDeliveryMetadata, RestoreHistoryBudget, RestoreHistoryBudgetExceeded} from "./liveAcceptedHistory";
import {parseNativeRestoreCancellationReceipt} from "../liveRestoreFence";
import {parseSettlementAuthors} from "./hostedSettlement";

const PUSH_BYTES = 64_000_000;
// Match live_audit/chunks.rs and live_update_application::MAX_CANCELLED_RESTORES.
const MAX_CANCELLED_RESTORES = 4095;
const CANCELLATION_RECEIPT_BYTES = 643_576;
const CANCELLED_RESTORE_BYTES = CANCELLATION_RECEIPT_BYTES +
  Buffer.byteLength('{"originAdoptionId":"","cancellation":}') + 2 * 1024;
const RECORD_OVERHEAD_BYTES = MAX_CANCELLED_RESTORES * (CANCELLED_RESTORE_BYTES + 1) + 32_768;
const CHUNK_BYTES = 4 * 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function require(value: unknown): asserts value {if (!value) throw new Error("Unconfirmed live application.");}

// This order is the native RestoreSource serializer's order, including nested cuts.
function ordered(value: Record<string, unknown>, fields: string[]) {
  require(value && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)));
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}
function canonicalRestore(value: Record<string, unknown> | null) {
  if (value === null) return null;
  const result = ordered(value, ["operationId", "oldGeneration", "origin", "hostId", "appliedSequence", "fenceHeadSequence",
    "fencedAtMs", "point", "selected", "accepted", "originEvidenceDigest", "nativeSourceManifestDigest",
    "frozenStateDigest", "pointStateDigest", "finalContentDigest"]);
  result.origin = ordered(value.origin as Record<string, unknown>, ["kind", "id"]);
  result.point = ordered(value.point as Record<string, unknown>, ["journalCursor", "receiptDigest", "markdownDigest", "projectionDigest"]);
  for (const field of ["selected", "accepted"]) {
    const end = ordered(value[field] as Record<string, unknown>, ["eventCount", "terminal", "evidenceDigest"]);
    if (end.terminal !== null) end.terminal = ordered(end.terminal as Record<string, unknown>, ["deliveryId", "updateDigest", "journalCursor", "acceptingHostEpoch"]);
    result[field] = end;
  }
  return result;
}

function canonicalCancellations(value: unknown) {
  require(Array.isArray(value) && value.length <= MAX_CANCELLED_RESTORES);
  return value.map(entry => {
    const result = ordered(entry, ["originAdoptionId", "cancellation"]);
    require(result.originAdoptionId === null || (typeof result.originAdoptionId === "string" &&
      Buffer.byteLength(result.originAdoptionId) <= 1024));
    result.cancellation = parseNativeRestoreCancellationReceipt(result.cancellation);
    require(Buffer.byteLength(JSON.stringify(result.cancellation)) <= CANCELLATION_RECEIPT_BYTES);
    return result;
  });
}

const journalWhere = `workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?
  AND relay_database_namespace=? AND accepted_event_count=? AND update_digest=?`;
function journal(storage: StorageContext, workspaceId: string, payload: Record<string, unknown>) {
  return storage.db.prepare(`SELECT journal_cursor,delivery_id,accepted_event_count,accepted_evidence_digest,
    accepted_metadata_bytes,length(update_bytes) AS bytes FROM ${LIVE_JOURNAL_TABLE} INDEXED BY ${LIVE_APPLICATION_AUTHORSHIP_INDEX} WHERE ${journalWhere}`)
    .get(workspaceId, payload.mainVersionId, payload.objectId, payload.lineageClaimId,
      payload.relayDatabaseNamespace, payload.eventCount, payload.updateBlobSha256);
}

// A valid application keeps its proof even with no authors to confirm.
type Prepared = {workspaceId: string; originId: string; payloadJson: string; cursor: number;
  coordinate: {originId: string; originSeq: number}; contentJson: string;
  authors: NonNullable<SyncRelayLogInput["admittedAuthorSnapshot"]> | null};
const prepared = new WeakMap<SyncRelayLogInput, Prepared>();
// Audits the push's budget ran out before, and those the writer confirmed.
const exhaustedProofs = new WeakSet<SyncRelayLogInput>();
const confirmed = new WeakSet<SyncRelayLogInput>();

/** The journal cursor an application's proof names, "exhausted" when its push's budget ran out first, or null. */
export function preparedLiveApplication(op: SyncRelayLogInput): number | "exhausted" | null {
  if (exhaustedProofs.has(op)) return "exhausted";
  const proof = prepared.get(op);
  return proof && proof.payloadJson === op.payloadJson ? proof.cursor : null;
}

/** Whether the writer confirmed the application's proof against its journal and content coordinates. */
export function liveApplicationConfirmed(op: SyncRelayLogInput): boolean {
  return confirmed.has(op);
}

/** Blob work is bounded across the push and runs before acquiring the writer. */
export async function prepareLiveApplications(storage: StorageContext,
  input: {workspaceId: string; originId: string; ops: SyncRelayLogInput[]}, signal?: AbortSignal) {
  if (!input.ops.some(op => op.opKind === "live.audit.application")) return;
  const budget = new RestoreHistoryBudget(PUSH_BYTES, input.ops.length);
  let exhausted = false;
  let bytesSinceYield = 0;
  let audits = 0;
  const coordinates = new Map(input.ops.map(op => [op.originSeq, op]));
  for (const op of input.ops) {
    if (op.opKind !== "live.audit.application") continue;
    prepared.delete(op);
    exhaustedProofs.delete(op);
    delete op.admittedAuthorSnapshot;
    if (exhausted) {exhaustedProofs.add(op); continue;}
    if (++audits % 32 === 0) await setImmediate(undefined, {signal});
    try {
      const payloadJson = op.payloadJson;
      const payload = JSON.parse(payloadJson);
      // A client supplies routing, never the person. Unknown routes cost no blob reads.
      const header = journal(storage, input.workspaceId, payload);
      require(header && Number.isSafeInteger(header.accepted_metadata_bytes) && Number(header.accepted_metadata_bytes) > 0);
      const manifest = payload.manifest;
      require(manifest?.formatVersion === 1 && Number.isSafeInteger(manifest.byteLength) &&
        manifest.byteLength > 0 && manifest.byteLength <= Number(header.accepted_metadata_bytes) + RECORD_OVERHEAD_BYTES &&
        Array.isArray(manifest.chunks) && manifest.chunks.length === Math.ceil(manifest.byteLength / CHUNK_BYTES));
      budget.chargeBytes(manifest.byteLength);
      const chunks: Buffer[] = [];
      const recordHash = manifest.chunks.length > 1 ? createHash("sha256") : undefined;
      for (const [index, chunk] of manifest.chunks.entries()) {
        const length = Math.min(CHUNK_BYTES, manifest.byteLength - index * CHUNK_BYTES);
        require(chunk.byteLength === length && typeof chunk.sha256 === "string");
        const blob = storage.db.prepare(`SELECT content FROM sync_relay_blobs
          WHERE workspace_id=? AND sha256=? AND length(content)=?`).get(input.workspaceId, chunk.sha256, length)?.content;
        require(blob instanceof Uint8Array && blob.byteLength === length && sha(blob) === chunk.sha256);
        recordHash?.update(blob);
        chunks.push(Buffer.isBuffer(blob) ? blob : Buffer.from(blob));
        bytesSinceYield += length;
        if (bytesSinceYield >= CHUNK_BYTES) {
          await setImmediate(undefined, {signal});
          bytesSinceYield = 0;
        }
      }
      const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, manifest.byteLength);
      require(chunks.length === 1 ? manifest.recordDigest === manifest.chunks[0].sha256 : recordHash!.digest("hex") === manifest.recordDigest);
      const record = JSON.parse(bytes.toString("utf8"));
      const metadata = record.metadata, binding = metadata?.accepted?.binding, receipt = metadata?.accepted?.receipt;
      require(record.kind === "application" && binding?.workspaceId === input.workspaceId &&
        binding.mainVersionId === payload.mainVersionId && binding.objectId === payload.objectId &&
        binding.lineageClaimId === payload.lineageClaimId && receipt?.updateDigest === payload.updateBlobSha256 &&
        receipt.deliveryId === header.delivery_id && receipt.journalCursor === header.journal_cursor &&
        record.eventCount === payload.eventCount && record.relayDatabaseNamespace === payload.relayDatabaseNamespace &&
        header.accepted_evidence_digest === record.evidenceDigest && header.bytes === record.updateByteLength);
      const document = {workspaceId: input.workspaceId, mainVersionId: binding.mainVersionId,
        objectId: binding.objectId, lineageClaimId: binding.lineageClaimId};
      const trusted = readAcceptedHistoryDeliveryMetadata(storage, {document, namespace: record.relayDatabaseNamespace,
        through: receipt.journalCursor, eventCount: record.eventCount, deliveryId: receipt.deliveryId}, budget);
      require(trusted && isDeepStrictEqual(trusted, metadata));
      const coordinate = record.contentCoordinate;
      require(typeof coordinate?.originId === "string" && Number.isSafeInteger(coordinate.originSeq) && coordinate.originSeq >= 0);
      require(coordinate.originId !== input.originId || coordinate.originSeq < op.originSeq);
      const pending = coordinate.originId === input.originId ? coordinates.get(coordinate.originSeq) : undefined;
      const content = pending ?? storage.db.prepare(`SELECT op_kind AS opKind,payload_json AS payloadJson FROM sync_relay_log
        WHERE workspace_id=? AND origin_id=? AND origin_seq=?`).get(input.workspaceId, coordinate.originId, coordinate.originSeq);
      require(content?.opKind === "ydoc.update");
      const update = JSON.parse(String(content.payloadJson));
      require(update.versionId === binding.mainVersionId && update.objectId === binding.objectId &&
        update.lineageClaimId === binding.lineageClaimId && update.path === binding.currentPath &&
        update.contentKind === "richdoc" && update.updateBlobSha256 === receipt.updateDigest && !update.isBaseState);
      const source = record.sourceApplication;
      const canonical = {kind: "application", relayDatabaseNamespace: record.relayDatabaseNamespace,
        eventCount: record.eventCount, evidenceDigest: record.evidenceDigest, updateByteLength: record.updateByteLength,
        metadata: trusted, sourceApplication: source === null ? null : {localYDocSequence: source.localYDocSequence,
          hostCoordinate: {hostId: source.hostCoordinate.hostId, hostEpoch: source.hostCoordinate.hostEpoch,
            instanceId: source.hostCoordinate.instanceId, connectionId: source.hostCoordinate.connectionId}},
        sourceRestore: canonicalRestore(record.sourceRestore), cancelledRestores: canonicalCancellations(record.cancelledRestores),
        contentCoordinate: {originId: coordinate.originId, originSeq: coordinate.originSeq}};
      // Reject alternate key order, whitespace and extra top-level/metadata/source fields.
      require(bytes.equals(Buffer.from(JSON.stringify(canonical))));
      const authors = new Map<string, unknown>();
      for (const author of [...(trusted.authorSnapshot ?? []), ...(trusted.checkpointCoverage ?? []).map(entry => entry.author)]) {
        authors.set(JSON.stringify(author), author);
      }
      prepared.set(op, {workspaceId: input.workspaceId, originId: input.originId,
        payloadJson, cursor: Number(header.journal_cursor), coordinate, contentJson: String(content.payloadJson),
        authors: authors.size ? parseSettlementAuthors([...authors.values()]) : null});
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof RestoreHistoryBudgetExceeded) {exhausted = true; exhaustedProofs.add(op);}
      // Exhausted budgets and mismatches retain the audit without confirmation.
    }
  }
}

/** Recheck immutable journal/content coordinates under the writer; never read blobs here. */
export function confirmLiveApplication(storage: StorageContext, op: SyncRelayLogInput, workspaceId: string,
  originId: string, batchCoordinates: ReadonlyMap<number, SyncRelayLogInput>) {
  if (op.opKind !== "live.audit.application") return;
  delete op.admittedAuthorSnapshot;
  confirmed.delete(op);
  const proof = prepared.get(op);
  if (!proof || proof.workspaceId !== workspaceId || proof.originId !== originId || proof.payloadJson !== op.payloadJson) return;
  const payload = JSON.parse(op.payloadJson);
  // The covering index checks the primary coordinate and scope without decoding a blob row.
  const header = storage.db.prepare(`SELECT journal_cursor FROM ${LIVE_JOURNAL_TABLE}
    INDEXED BY ${LIVE_APPLICATION_AUTHORSHIP_INDEX} WHERE journal_cursor=? AND ${journalWhere}`)
    .get(proof.cursor, workspaceId, payload.mainVersionId, payload.objectId, payload.lineageClaimId,
      payload.relayDatabaseNamespace, payload.eventCount, payload.updateBlobSha256);
  if (!header) return;
  const pending = proof.coordinate.originId === originId ? batchCoordinates.get(proof.coordinate.originSeq) : undefined;
  const content = pending ?? storage.db.prepare(`SELECT op_kind AS opKind,payload_json AS payloadJson FROM sync_relay_log
    WHERE workspace_id=? AND origin_id=? AND origin_seq=?`).get(workspaceId, proof.coordinate.originId, proof.coordinate.originSeq);
  if (content?.opKind !== "ydoc.update" || content.payloadJson !== proof.contentJson) return;
  confirmed.add(op);
  if (proof.authors) op.admittedAuthorSnapshot = proof.authors;
}
