import {isDeepStrictEqual} from "node:util";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseLiveUpdateDigest, type AdmittedLiveUpdate, type LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import {canonicalAcceptedMetadata, initialAcceptedHistoryDigest, nextAcceptedHistoryDigest} from "../liveAcceptedHistory";
import type {NativeRestoreHistoryProof} from "../liveRestoreProposal";
import type {StorageContext} from "./context";
import {authorityInteger} from "./liveDocumentAuthority";
import {assertJournalCheckpointPosition, decodeJournalRow, documentParams, verifyJournalHistoryRow, verifyJournalRow} from "./liveUpdateJournal";
import {LIVE_JOURNAL_TABLE} from "./schema";

const documentWhere = "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
function require(value: unknown): asserts value {if (!value) throw new Error("Accepted journal history is damaged.");}

export class RestoreHistoryBudget {
  bytes: number;
  events: number;
  constructor(maxBytes: number, maxEvents: number) {this.bytes = authorityInteger(maxBytes); this.events = authorityInteger(maxEvents);}
  chargeBytes(value: number) {const n = authorityInteger(value); if (n > this.bytes) throw new Error("Restore history exceeds configured byte bounds."); this.bytes -= n;}
  chargeEvents(value: number) {const n = authorityInteger(value); if (n > this.events) throw new Error("Restore history exceeds configured event bounds."); this.events -= n;}
}

export function readAcceptedHistory(storage: StorageContext, input: {
  document: LiveDocumentKey; namespace: string; through: number; baseline: Uint8Array; baselineDigest: string; originBinding: LiveObjectBinding;
}, budget: RestoreHistoryBudget) {
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
    const row = decodeJournalRow(storage.db, raw); verifyJournalRow(row); assertJournalCheckpointPosition(storage.db, row);
    verifyJournalHistoryRow(storage.db, row);
    require(row.history.namespace === namespace && row.checkpoint);
    checkpoint = {cursor: floor, bytes: row.checkpoint.bytes, digest: row.checkpoint.digest};
    c = {eventCount: row.history.eventCount, terminal: row.admitted.metadata.accepted.receipt, binding: row.admitted.metadata.accepted.binding,
      stateDigest: checkpoint.digest, evidenceDigest: row.history.evidenceDigest};
  }
  const events: AdmittedLiveUpdate[] = [];
  let count = c.eventCount, digest = c.evidenceDigest, terminal = c.terminal, suffixBytes = 0;
  for (const h of headers) {
    const raw = storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${documentWhere} AND journal_cursor=?`).get(...params, h.journal_cursor)!;
    const row = decodeJournalRow(storage.db, raw); verifyJournalRow(row);
    require(row.history.metadataBytes === Buffer.byteLength(JSON.stringify(canonicalAcceptedMetadata(row.admitted.metadata))));
    require(row.history.namespace === namespace && !row.checkpoint && count < Number.MAX_SAFE_INTEGER);
    require(row.admitted.metadata.accepted.receipt.journalCursor > (terminal?.journalCursor ?? 0));
    digest = nextAcceptedHistoryDigest(digest, ++count, row.admitted.metadata);
    require(row.history.eventCount === count && row.history.evidenceDigest === digest);
    terminal = row.admitted.metadata.accepted.receipt; suffixBytes += row.admitted.updateBytes.byteLength;
    events.push(row.admitted);
    if (terminal.journalCursor === through) assertJournalCheckpointPosition(storage.db, row);
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

export function readAcceptedHistoryDelivery(storage: StorageContext, input: {
  document: LiveDocumentKey; namespace: string; through: number; eventCount: number; deliveryId: string;
}, budget: RestoreHistoryBudget) {
  const header = storage.db.prepare(`SELECT length(update_bytes) AS bytes,COALESCE(length(validation_checkpoint_bytes),0) AS checkpoint_bytes,
    accepted_metadata_bytes FROM ${LIVE_JOURNAL_TABLE} WHERE delivery_id=?`).get(input.deliveryId);
  if (!header) return null;
  budget.chargeBytes(authorityInteger(header.bytes, 1) + authorityInteger(header.checkpoint_bytes) + authorityInteger(header.accepted_metadata_bytes, 1));
  const raw = storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE delivery_id=?`).get(input.deliveryId)!;
  const row = decodeJournalRow(storage.db, raw); verifyJournalRow(row); verifyJournalHistoryRow(storage.db, row);
  const {binding, receipt} = row.admitted.metadata.accepted;
  require(isDeepStrictEqual(documentParams(binding), documentParams(input.document)) && row.history.namespace === input.namespace &&
    receipt.journalCursor <= input.through && row.history.eventCount <= input.eventCount);
  return canonicalAcceptedMetadata(row.admitted.metadata);
}
