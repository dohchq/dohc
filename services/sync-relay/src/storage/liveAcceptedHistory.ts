import {isDeepStrictEqual} from "node:util";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseLiveUpdateDigest, type AdmittedLiveUpdate, type LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import {canonicalAcceptedMetadata, initialAcceptedHistoryDigest, nextAcceptedHistoryDigest} from "../liveAcceptedHistory";
import type {NativeRestoreHistoryProof} from "../liveRestoreProposal";
import type {StorageContext} from "./context";
import {authorityInteger} from "./liveDocumentAuthority";
import {assertJournalCheckpointPosition, decodeJournalMetadata, decodeJournalRow, documentParams, verifyJournalHistoryMetadata, verifyJournalHistoryRow, verifyJournalRow} from "./liveUpdateJournal";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {LIVE_JOURNAL_TABLE, LIVE_JOURNAL_PROVENANCE} from "./schema";

const documentWhere = "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
function require(value: unknown): asserts value {if (!value) throw new Error("Accepted journal history is damaged.");}

export class RestoreHistoryBudget {
  bytes: number;
  events: number;
  constructor(maxBytes: number, maxEvents: number) {this.bytes = authorityInteger(maxBytes); this.events = authorityInteger(maxEvents);}
  chargeBytes(value: number) {const n = authorityInteger(value); if (n > this.bytes) throw new Error("Restore history exceeds configured byte bounds."); this.bytes -= n;}
  chargeEvents(value: number) {const n = authorityInteger(value); if (n > this.events) throw new Error("Restore history exceeds configured event bounds."); this.events -= n;}
}

type HistoryInput = {document: LiveDocumentKey; namespace: string; through: number; baseline: Uint8Array; baselineDigest: string; originBinding: LiveObjectBinding};

const metadataColumns = "journal_cursor,relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,delivery_id,update_digest,accepting_host_epoch,principal_kind,principal_id,grant_id,grant_generation,received_at_ms,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes,restore_operation_id,validation_checkpoint_sha256";
// Actual stored string lengths, independent of the cached accepted_metadata_bytes.
const metadataLengths = ["relay_database_namespace", "workspace_id", "main_version_id", "object_id", "lineage_claim_id", "current_path", "selector_paths_json", "delivery_id", "update_digest", "principal_kind", "principal_id", "grant_id", "accepted_evidence_digest", "restore_operation_id", "validation_checkpoint_sha256"]
  .map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join("+");
function boundedMetadata(storage: StorageContext, document: LiveDocumentKey, cursor: number, budget: RestoreHistoryBudget) {
  const params = documentParams(document);
  const header = storage.db.prepare(`SELECT ${metadataLengths}+8*7 AS bytes FROM ${LIVE_JOURNAL_TABLE}
    WHERE ${documentWhere} AND journal_cursor=?`).get(...params, cursor);
  require(header);
  const provenance = storage.db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(workspace_id AS BLOB))+length(CAST(main_version_id AS BLOB))+
    length(CAST(object_id AS BLOB))+length(CAST(lineage_claim_id AS BLOB))+8*4),0) AS bytes FROM ${LIVE_JOURNAL_PROVENANCE} WHERE journal_cursor=?`).get(cursor)!;
  budget.chargeBytes(authorityInteger(header.bytes, 1) + authorityInteger(provenance.bytes));
  const raw = storage.db.prepare(`SELECT ${metadataColumns} FROM ${LIVE_JOURNAL_TABLE} WHERE ${documentWhere} AND journal_cursor=?`).get(...params, cursor)!;
  const ranges = storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_PROVENANCE} WHERE journal_cursor=? ORDER BY client_id,start_clock`).all(cursor);
  require(ranges.length === provenance.count);
  const metadata = canonicalAcceptedMetadata(decodeJournalMetadata(storage.db, raw, ranges));
  require(raw.accepted_metadata_bytes === Buffer.byteLength(JSON.stringify(metadata)));
  return {raw, metadata};
}

/** Metadata lookup for native-source association; does not load historical update/checkpoint blobs. */
export function readAcceptedHistoryDeliveryMetadata(storage: StorageContext, input: HistoryDeliveryInput, budget: RestoreHistoryBudget) {
  const header = storage.db.prepare(`SELECT journal_cursor FROM ${LIVE_JOURNAL_TABLE} WHERE delivery_id=? AND ${documentWhere}`)
    .get(input.deliveryId, ...documentParams(input.document));
  if (!header) return null;
  budget.chargeEvents(1);
  const {raw, metadata} = boundedMetadata(storage, input.document, authorityInteger(header.journal_cursor, 1), budget);
  const history = {namespace: parseLiveUpdateIdentifier(raw.relay_database_namespace), eventCount: authorityInteger(raw.accepted_event_count, 1),
    evidenceDigest: parseLiveUpdateDigest(raw.accepted_evidence_digest), metadataBytes: authorityInteger(raw.accepted_metadata_bytes, 1)};
  require(history.namespace === input.namespace && metadata.accepted.receipt.journalCursor <= input.through && history.eventCount <= input.eventCount);
  verifyJournalHistoryMetadata(storage.db, metadata, history);
  return metadata;
}

/** Complete metadata between authenticated cuts, including events folded into checkpoints. */
export function readAcceptedHistoryInterval(storage: StorageContext, input: {
  document: LiveDocumentKey; namespace: string;
  selected: Pick<NativeRestoreHistoryProof, "eventCount" | "terminal" | "evidenceDigest">;
  accepted: Pick<NativeRestoreHistoryProof, "eventCount" | "terminal" | "evidenceDigest">;
}, budget: RestoreHistoryBudget) {
  const {document, namespace, selected, accepted} = input, params = documentParams(document);
  const from = selected.terminal?.journalCursor ?? 0, through = accepted.terminal?.journalCursor ?? 0;
  const count = authorityInteger(accepted.eventCount - selected.eventCount);
  require(from <= through);
  const actual = storage.db.prepare(`SELECT COUNT(*) AS count FROM ${LIVE_JOURNAL_TABLE}
    WHERE ${documentWhere} AND journal_cursor>? AND journal_cursor<=?`).get(...params, from, through)!;
  require(actual.count === count); budget.chargeEvents(count);
  let cursor = from, eventCount = selected.eventCount, evidenceDigest = selected.evidenceDigest, terminal = selected.terminal;
  const events: {metadata: AdmittedLiveUpdate["metadata"]; restoreOperationId: string | null}[] = [];
  for (let index = 0; index < count; index++) {
    const header = storage.db.prepare(`SELECT journal_cursor FROM ${LIVE_JOURNAL_TABLE}
      WHERE ${documentWhere} AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT 1`).get(...params, cursor, through);
    require(header); const next = authorityInteger(header.journal_cursor, 1);
    const {raw, metadata} = boundedMetadata(storage, document, next, budget);
    require(raw.relay_database_namespace === namespace);
    const restoreOperationId = raw.restore_operation_id === null ? null : parseLiveUpdateIdentifier(raw.restore_operation_id);
    if (raw.validation_checkpoint_sha256 !== null || restoreOperationId !== null) {
      assertJournalCheckpointPosition(storage.db, {admitted: {metadata}, restoreOperationId, history: {namespace},
        checkpoint: raw.validation_checkpoint_sha256 === null ? null : {digest: parseLiveUpdateDigest(raw.validation_checkpoint_sha256)}}, budget);
    }
    evidenceDigest = nextAcceptedHistoryDigest(evidenceDigest, ++eventCount, metadata);
    require(raw.accepted_event_count === eventCount && raw.accepted_evidence_digest === evidenceDigest);
    terminal = metadata.accepted.receipt; cursor = terminal.journalCursor;
    events.push({metadata, restoreOperationId});
  }
  require(eventCount === accepted.eventCount && evidenceDigest === accepted.evidenceDigest && isDeepStrictEqual(terminal, accepted.terminal));
  return events;
}

export function readAcceptedHistory(storage:StorageContext,input:HistoryInput,budget:RestoreHistoryBudget) {
  return captureAcceptedHistory(storage,input,budget,verifyJournalRow);
}
function captureAcceptedHistory(storage: StorageContext, input: {
  document: LiveDocumentKey; namespace: string; through: number; baseline: Uint8Array; baselineDigest: string; originBinding: LiveObjectBinding;
}, budget: RestoreHistoryBudget, verifyContent:typeof verifyJournalRow) {
  const {document, namespace, through} = input, params = documentParams(document);
  const header = storage.db.prepare(`SELECT journal_cursor,length(validation_checkpoint_bytes) AS checkpoint_bytes,
    length(update_bytes) AS update_bytes,accepted_metadata_bytes FROM ${LIVE_JOURNAL_TABLE}
    WHERE ${documentWhere} AND journal_cursor<=? AND validation_checkpoint_bytes IS NOT NULL ORDER BY journal_cursor DESC LIMIT 1`).get(...params, through);
  const floor = header ? authorityInteger(header.journal_cursor, 1) : 0;
  const headers = storage.db.prepare(`SELECT journal_cursor,length(update_bytes) AS update_bytes,accepted_metadata_bytes FROM ${LIVE_JOURNAL_TABLE}
    WHERE ${documentWhere} AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT 4095`).all(...params, floor, through);
  require(headers.length <= 4094);
  budget.chargeEvents(headers.length);
  if (header) budget.chargeBytes(authorityInteger(header.checkpoint_bytes, 1) + authorityInteger(header.update_bytes, 1) + authorityInteger(header.accepted_metadata_bytes, 1));
  else budget.chargeBytes(input.baseline.byteLength);
  for (const row of headers) budget.chargeBytes(authorityInteger(row.update_bytes, 1) + authorityInteger(row.accepted_metadata_bytes, 1));
  let checkpoint = {cursor: 0, bytes: header ? input.baseline : new Uint8Array(input.baseline), digest: input.baselineDigest};
  let c: NativeRestoreHistoryProof["checkpoint"] = {eventCount: 0, terminal: null, binding: structuredClone(input.originBinding),
    stateDigest: input.baselineDigest, evidenceDigest: initialAcceptedHistoryDigest(namespace, document)};
  if (header) {
    const raw = storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${documentWhere} AND journal_cursor=?`).get(...params, floor)!;
    const row = decodeJournalRow(storage.db, raw); verifyContent(row); assertJournalCheckpointPosition(storage.db, row,budget);
    verifyJournalHistoryRow(storage.db, row);
    require(row.history.namespace === namespace && row.checkpoint);
    checkpoint = {cursor: floor, bytes: row.checkpoint.bytes, digest: row.checkpoint.digest};
    c = {eventCount: row.history.eventCount, terminal: row.admitted.metadata.accepted.receipt, binding: row.admitted.metadata.accepted.binding,
      stateDigest: checkpoint.digest, evidenceDigest: row.history.evidenceDigest,
      ...(row.restoreOperationId===null?{}:{restoreOperationId:row.restoreOperationId})};
  }
  const events: AdmittedLiveUpdate[] = [];
  let count = c.eventCount, digest = c.evidenceDigest, terminal = c.terminal, suffixBytes = 0;
  const rows=storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${documentWhere}
    AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT 4095`).all(...params,floor,through);
  require(rows.length===headers.length);
  const provenance=new Map<number,Record<string,unknown>[]>();
  for (const range of storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_PROVENANCE} WHERE journal_cursor IN
    (SELECT journal_cursor FROM ${LIVE_JOURNAL_TABLE} WHERE ${documentWhere} AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT 4095)
    ORDER BY journal_cursor,client_id,start_clock`).all(...params,floor,through)) {
    const cursor=authorityInteger(range.journal_cursor,1), ranges=provenance.get(cursor)??[];
    ranges.push(range);provenance.set(cursor,ranges);
  }
  for (const [index,raw] of rows.entries()) {
    require(raw.journal_cursor===headers[index]!.journal_cursor);
    const row = decodeJournalRow(storage.db, raw,provenance.get(authorityInteger(raw.journal_cursor,1))??[]); verifyContent(row);
    require(row.history.metadataBytes === Buffer.byteLength(JSON.stringify(canonicalAcceptedMetadata(row.admitted.metadata))));
    require(row.history.namespace === namespace && !row.checkpoint && count < Number.MAX_SAFE_INTEGER);
    require(row.admitted.metadata.accepted.binding.currentPath===c.binding.currentPath &&
      row.admitted.metadata.accepted.binding.restoreFenceGeneration===c.binding.restoreFenceGeneration);
    require(row.admitted.metadata.accepted.receipt.journalCursor > (terminal?.journalCursor ?? 0));
    digest = nextAcceptedHistoryDigest(digest, ++count, row.admitted.metadata);
    require(row.history.eventCount === count && row.history.evidenceDigest === digest);
    terminal = row.admitted.metadata.accepted.receipt; suffixBytes += row.admitted.updateBytes.byteLength;
    events.push(row.admitted);
    if (terminal.journalCursor === through) assertJournalCheckpointPosition(storage.db, row,budget);
  }
  require((terminal?.journalCursor ?? 0) === through && suffixBytes < 20_971_520);
  const proof: NativeRestoreHistoryProof = {checkpoint: c, suffix: events.map(e => canonicalAcceptedMetadata(e.metadata)),
    eventCount: count, terminal, evidenceDigest: digest};
  return {checkpoint, events, proof};
}

export function requireAcceptedHistoryProof(retained: NativeRestoreHistoryProof, native: NativeRestoreHistoryProof): void {
  // Native checkpoints use Yrs encoding. Their raw bytes are not part of the receipt.
  parseLiveUpdateDigest(native.checkpoint.stateDigest);
  require(isDeepStrictEqual({...retained, checkpoint: {...retained.checkpoint, stateDigest: undefined}},
    {...native, checkpoint: {...native.checkpoint, stateDigest: undefined}}));
  if (retained.checkpoint.eventCount === 0) require(retained.checkpoint.stateDigest === native.checkpoint.stateDigest);
}

type HistoryDeliveryInput = {document: LiveDocumentKey; namespace: string; through: number; eventCount: number; deliveryId: string};
export function readAcceptedHistoryDelivery(storage:StorageContext,input:HistoryDeliveryInput,budget:RestoreHistoryBudget) {
  return capturedHistoryDelivery(storage,input,budget,verifyJournalRow);
}
export function revalidateAcceptedHistoryDelivery(storage:StorageContext,input:HistoryDeliveryInput,budget:RestoreHistoryBudget,ownedBytes:Uint8Array) {
  return capturedHistoryDelivery(storage,input,budget,row=>require(Buffer.compare(row.admitted.updateBytes,ownedBytes)===0));
}
function capturedHistoryDelivery(storage: StorageContext, input: {
  document: LiveDocumentKey; namespace: string; through: number; eventCount: number; deliveryId: string;
}, budget: RestoreHistoryBudget,verifyContent:typeof verifyJournalRow) {
  const header = storage.db.prepare(`SELECT length(update_bytes) AS bytes,COALESCE(length(validation_checkpoint_bytes),0) AS checkpoint_bytes,
    accepted_metadata_bytes FROM ${LIVE_JOURNAL_TABLE} WHERE delivery_id=? AND ${documentWhere}`).get(input.deliveryId,...documentParams(input.document));
  if (!header) return null;
  budget.chargeBytes(authorityInteger(header.bytes, 1) + authorityInteger(header.checkpoint_bytes) + authorityInteger(header.accepted_metadata_bytes, 1));
  const raw = storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE delivery_id=? AND ${documentWhere}`).get(input.deliveryId,...documentParams(input.document))!;
  const row = decodeJournalRow(storage.db, raw); verifyContent(row); verifyJournalHistoryRow(storage.db, row);
  const {binding, receipt} = row.admitted.metadata.accepted;
  require(isDeepStrictEqual(documentParams(binding), documentParams(input.document)) && row.history.namespace === input.namespace &&
    receipt.journalCursor <= input.through && row.history.eventCount <= input.eventCount);
  return canonicalAcceptedMetadata(row.admitted.metadata);
}
