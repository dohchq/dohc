import {SETTLEMENT_CUTS} from "./hostedSettlementSchema";
import {parseAutomationDeclaration} from "@dohc/live-session-contract/live-authorship";
import {automationPressAdmissionAllowed, automationGrantAdmissionAllowed} from "./automationPresses";
import {readRestoreAdmission,verifyRestoreCheckpoint, type RestoreAdmission} from "./liveRestoreCheckpoint";
import {acrossDeclinedRestores} from "./liveRestoreLifecycleStorage";
import { liveJournalHistoryNamespace, requireLiveJournalHistory } from "./liveJournalHistory";
import { liveJournalCheckpointDue } from "./liveJournalCheckpoint";
import { allowsServiceActivationCandidate, type ServiceActivationAccess } from "./serviceActivationAccess";
import {canonicalVersionedAcceptedMetadata as canonicalAcceptedMetadata, initialAcceptedHistoryDigest, nextVersionedAcceptedHistoryDigest as nextAcceptedHistoryDigest} from "../liveAcceptedHistory";
import { deriveLiveAuthorSnapshot } from "./liveAuthorSnapshot";
import { assessLiveAuthorWindow, liveAuthorCoverageCheckpointDue, limitLiveDeclaredAgents } from "./liveAuthorWindow";
import { LIVE_AUTHOR_CLIENTS } from "./liveAuthorshipSchema";
import { captureSqliteReadRevisionMatches } from "./readRevision";
import { liveAuthorIdentity, parseLiveAuthorSnapshot, type LiveAuthorSnapshot } from "@dohc/live-session-contract";
import { createHash } from "node:crypto";
import {setImmediate} from "node:timers/promises";
import { isDeepStrictEqual, types as nodeTypes } from "node:util";
import { LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT, parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseLiveCheckpointCoverage, type LiveCheckpointAuthorCoverage, parseLiveDocumentKey, parseLiveUpdateSubmissionMetadata, parseLiveUpdateReceipt, parseLiveUpdateDigest, parseLiveUpdateIdentifier, parseLiveUpdateStructRange, parseLiveUpdateStructRanges, parseServerDerivedLiveUpdateAuthority, type LiveDocumentKey, type LiveUpdateStructRange, type AdmittedLiveUpdate, type LiveUpdateSubmissionMetadata } from "@dohc/live-session-contract/live-update-admission";
import type { HostControlSnapshot } from "@dohc/live-session-contract/host-control";
import type { StorageContext } from "./context";
import type { SqliteDb, CurrentLiveBindingRequest, LiveHostConnectionCoordinate, LiveUpdateJournalCut, LiveUpdateJournalCutResult, LiveUpdateJournalCommitInput, RelayLiveUpdateJournalResult, CommittedLiveUpdateResult, LiveJournalValidation, StoredLiveDocumentAuthority } from "./types";
import { LiveJournalAdmittedCapacityError } from "./errors";
import {LIVE_RESTORE_OPERATIONS, LIVE_RESTORE_SOURCE_RANGES} from "./liveRestoreOperationSchema";
import {LIVE_RESTORE_CANCELLATIONS} from "./liveRestoreCancellationSchema";
import {parseNativeRestoreCancellationAnswer, type NativeRestoreCancellationReceipt} from "../liveRestoreFence";
import { LIVE_JOURNAL_TABLE, LIVE_JOURNAL_PROVENANCE } from "./schema";
import { snapshotHostCoordinate } from "../liveTicketInputs";
import { readLiveHostControl } from "./hostControl";
import { assertWorkspaceQuota } from "./workspaces";
import { registerLiveDeliveryEvent } from "./liveDeliveryReservations";
import { baselineRecord, baselineByteBuffer, baselineByteOffset, baselineByteLength, baselineBufferLength, baselineBufferResizable, authorityInteger, authorityIntegrity, currentLiveDocumentMoment, assertCurrentAuthorityHost, snapshotCurrentBindingRequest, decodeLiveDocumentAuthorityStructure, authorizeLiveDocument } from "./liveDocumentAuthority";

function journalAuthorityHistory(storage: StorageContext, document: LiveDocumentKey): StoredLiveDocumentAuthority[] {
  return storage.db.prepare(`SELECT * FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id=? AND object_id=? ORDER BY lineage_claim_id`)
    .all(document.workspaceId, document.mainVersionId, document.objectId).map(row => decodeLiveDocumentAuthorityStructure(storage.db, document, row));
}
function journalIntegrity(condition: unknown): asserts condition {
  if (!condition) throw new Error("live update journal is damaged");
}
function journalDigest(bytes: Uint8Array, digest: string): void {
  journalIntegrity(createHash("sha256").update(bytes).digest("hex") === digest);
}
export function journalDocument(value: unknown): LiveDocumentKey {
  const document = parseLiveDocumentKey(baselineRecord(value, ["workspaceId", "mainVersionId", "objectId", "lineageClaimId"]));
  if (document.mainVersionId !== "main") throw new TypeError("Journal document must be main.");
  return document;
}
function journalBytes(value: unknown): Uint8Array {
  if (!nodeTypes.isUint8Array(value)) throw new TypeError("Invalid journal bytes.");
  const buffer = Reflect.apply(baselineByteBuffer, value, []) as ArrayBuffer;
  const offset = Reflect.apply(baselineByteOffset, value, []) as number;
  const length = Reflect.apply(baselineByteLength, value, []) as number;
  const backingLength = Reflect.apply(baselineBufferLength, buffer, []) as number;
  if (length < 1 || length > 20_971_520 || offset > backingLength || length > backingLength - offset ||
    (baselineBufferResizable && Reflect.apply(baselineBufferResizable, buffer, []))) throw new TypeError("Invalid journal bytes.");
  return new Uint8Array(new Uint8Array(buffer, offset, length));
}
function journalArray<T>(value: unknown, maximum: number, capture: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("Invalid journal array.");
  const count = Object.getOwnPropertyDescriptor(value, "length")!.value as number;
  if (count > maximum || Reflect.ownKeys(value).length !== count + 1) throw new TypeError("Invalid journal array.");
  return Array.from({ length: count }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid journal array entry.");
    return capture(descriptor.value);
  });
}
function journalRecord(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  const result = baselineRecord(value, required, true);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) throw new TypeError("Invalid journal fields.");
    if (required.includes(key)) continue;
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid journal field.");
    result[key] = descriptor.value;
  }
  return result;
}
function journalRanges(value: unknown): LiveUpdateStructRange[] {
  const ranges = journalArray(value, Number.MAX_SAFE_INTEGER, row => parseLiveUpdateStructRange(baselineRecord(row, ["clientId", "startClock", "endClock"])));
  for (let index = 1; index < ranges.length; index++) {
    const a = ranges[index - 1]!, b = ranges[index]!;
    if (a.clientId > b.clientId || (a.clientId === b.clientId && a.endClock >= b.startClock)) throw new TypeError("Noncanonical journal ranges.");
  }
  return ranges;
}
function journalBinding(value: unknown, previous?: LiveObjectBinding): LiveObjectBinding {
  const record = baselineRecord(value, ["workspaceId", "mainVersionId", "objectId", "lineageClaimId", "currentPath", "selectorPaths", "restoreFenceGeneration"]);
  const paths = journalArray(record.selectorPaths, LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT, value => {
    if (typeof value !== "string") throw new TypeError("Invalid journal selector.");
    return value;
  });
  if (previous && record.workspaceId === previous.workspaceId && record.mainVersionId === previous.mainVersionId &&
    record.objectId === previous.objectId && record.lineageClaimId === previous.lineageClaimId &&
    record.currentPath === previous.currentPath && Object.is(record.restoreFenceGeneration, previous.restoreFenceGeneration) &&
    paths.length === previous.selectorPaths.length && paths.every((path, index) => path === previous.selectorPaths[index])) {
    return { ...previous, selectorPaths: paths };
  }
  return parseLiveObjectBinding({ ...record, selectorPaths: paths });
}
export function documentParams(document: LiveDocumentKey): [string, string, string, string] {
  return [document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId];
}
const JOURNAL_DOCUMENT_WHERE = "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
function liveJournalSeedSource(storage: StorageContext, document: LiveDocumentKey): Record<string,unknown> | undefined {
  const source = storage.db.prepare(`SELECT m.moment_id,m.blob_sha256 FROM sync_relay_live_documents d
    JOIN sync_relay_object_moments m ON m.workspace_id=d.workspace_id AND m.object_id=d.object_id
      AND m.relay_seq=d.baseline_moment_relay_seq WHERE d.workspace_id=? AND d.main_version_id=? AND d.object_id=? AND d.lineage_claim_id=?`)
    .get(...documentParams(document));
  return source;
}
function liveJournalSeedClient(document: LiveDocumentKey, source: Record<string,unknown> | undefined): number | null {
  if (!source || typeof source.moment_id !== "string" || typeof source.blob_sha256 !== "string") return null;
  const hash = createHash("sha256").update("dohc:ydoc-seed-client:v1");
  for (const field of [document.workspaceId,document.mainVersionId,document.objectId,"text",source.moment_id,source.blob_sha256]) {
    const bytes=Buffer.from(field), length=Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length).update(bytes);
  }
  return Math.max(1,hash.digest().readUInt32BE(0));
}
interface DecodedJournalRow {
  admitted: AdmittedLiveUpdate;
  checkpoint: { digest: string; bytes: Uint8Array } | null;
  restoreOperationId: string | null;
  history: {namespace: string; eventCount: number; evidenceDigest: string; metadataBytes: number};
}
export function decodeJournalMetadata(db: SqliteDb, raw: Record<string, unknown>, provenance?: Record<string, unknown>[]): AdmittedLiveUpdate["metadata"] {
  return journalMetadataWithBinding(db, raw, journalBindingFromRow(raw), provenance);
}
function journalBindingFromRow(raw: Record<string, unknown>): LiveObjectBinding {
  const binding = parseLiveObjectBinding({ workspaceId: raw.workspace_id, mainVersionId: raw.main_version_id,
    objectId: raw.object_id, lineageClaimId: raw.lineage_claim_id, currentPath: raw.current_path,
    selectorPaths: typeof raw.selector_paths_json === "string" ? JSON.parse(raw.selector_paths_json) : null,
    restoreFenceGeneration: raw.restore_fence_generation });
  journalIntegrity(binding.mainVersionId === "main" && binding.currentPath === raw.current_path &&
    JSON.stringify(binding.selectorPaths) === raw.selector_paths_json);
  return binding;
}
function journalMetadataWithBinding(db: SqliteDb, raw: Record<string, unknown>, binding: LiveObjectBinding,
  provenance?: Record<string, unknown>[], snapshots?: Map<string, LiveAuthorSnapshot>): AdmittedLiveUpdate["metadata"] {
  const cursor = authorityInteger(raw.journal_cursor, 1);
  const rows = provenance ?? db.prepare(`SELECT * FROM ${LIVE_JOURNAL_PROVENANCE} WHERE journal_cursor=? ORDER BY client_id,start_clock`).all(cursor);
  const firstSeen = rows.map(row => {
    journalIntegrity(row.workspace_id === binding.workspaceId && row.main_version_id === binding.mainVersionId &&
      row.object_id === binding.objectId && row.lineage_claim_id === binding.lineageClaimId && row.journal_cursor === cursor);
    return parseLiveUpdateStructRange({ clientId: row.client_id, startClock: row.start_clock, endClock: row.end_clock });
  });
  for (let index = 1; index < firstSeen.length; index++) {
    const a = firstSeen[index - 1]!, b = firstSeen[index]!;
    journalIntegrity(a.clientId < b.clientId || (a.clientId === b.clientId && a.endClock < b.startClock));
  }
  const receipt = parseLiveUpdateReceipt({ deliveryId: raw.delivery_id, updateDigest: raw.update_digest, journalCursor: cursor, acceptingHostEpoch: raw.accepting_host_epoch });
  const authority = parseServerDerivedLiveUpdateAuthority({ principalKind: raw.principal_kind, principalId: raw.principal_id, grantId: raw.grant_id, grantGeneration: raw.grant_generation });
  const receivedAtMs = raw.received_at_ms;
  if (typeof receivedAtMs !== "number" || !Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) throw new TypeError("receivedAtMs must be a non-negative safe integer.");
  journalIntegrity(raw.canonical_version === 1 || raw.canonical_version === 2);
  const seed = raw.seed_first_seen_json === "[]" ? [] : journalRanges(JSON.parse(String(raw.seed_first_seen_json)));
  const credited = seed.length === 0 ? firstSeen : subtractJournalRanges(firstSeen, seed);
  if (seed.length !== 0) journalIntegrity(subtractJournalRanges(seed, firstSeen).length === 0);
  const extension = raw.canonical_version === 2 ? {
    canonicalVersion: 2 as const, authorSnapshot: journalAuthorSnapshot(raw.author_snapshot_json, snapshots),
    firstSeenDeletes: raw.first_seen_deletes_json === "[]" ? [] : journalRanges(JSON.parse(String(raw.first_seen_deletes_json))),
    ...(raw.checkpoint_coverage_json === null ? {} : {checkpointCoverage: parseLiveCheckpointCoverage(JSON.parse(String(raw.checkpoint_coverage_json)))})
  } : {};
  if (raw.canonical_version === 1) journalIntegrity(raw.author_snapshot_json === null && raw.author_context_json === null &&
    raw.first_seen_deletes_json === "[]" && raw.checkpoint_coverage_json === null && seed.length === 0);
  return { accepted: { receipt, binding, authority, receivedAtMs }, firstSeen: credited, ...extension };
}
function journalAuthorSnapshot(value: unknown, snapshots?: Map<string, LiveAuthorSnapshot>): LiveAuthorSnapshot {
  journalIntegrity(typeof value === "string");
  const cached = snapshots?.get(value);
  // Reuse validation for identical stored bytes only within this SQLite read.
  // Each row owns its entries so callers cannot change another row's credit.
  if (cached) return cached.map(author => ({...author}));
  const parsed = parseLiveAuthorSnapshot(JSON.parse(value));
  snapshots?.set(value, parsed.map(author => ({...author})));
  return parsed;
}
export function decodeJournalRow(db: SqliteDb, raw: Record<string, unknown>, provenance?: Record<string, unknown>[]): DecodedJournalRow {
  return journalRowWithBinding(db, raw, journalBindingFromRow(raw), provenance);
}
function journalRowWithBinding(db: SqliteDb, raw: Record<string, unknown>, binding: LiveObjectBinding,
  provenance?: Record<string, unknown>[], snapshots?: Map<string, LiveAuthorSnapshot>): DecodedJournalRow {
  const metadata=journalMetadataWithBinding(db,raw,binding,provenance,snapshots);
  journalIntegrity((raw.validation_checkpoint_sha256 === null) === (raw.validation_checkpoint_bytes === null));
  const checkpoint = raw.validation_checkpoint_sha256 === null ? null : {
    digest: parseLiveUpdateDigest(raw.validation_checkpoint_sha256), bytes: journalBytes(raw.validation_checkpoint_bytes),
  };
  const history = {namespace: parseLiveUpdateIdentifier(raw.relay_database_namespace), eventCount: authorityInteger(raw.accepted_event_count, 1),
    evidenceDigest: parseLiveUpdateDigest(raw.accepted_evidence_digest), metadataBytes: authorityInteger(raw.accepted_metadata_bytes, 1)};
  const restoreOperationId = raw.restore_operation_id === null ? null : parseLiveUpdateIdentifier(raw.restore_operation_id);
  journalIntegrity(restoreOperationId === null || checkpoint !== null);
  return { admitted: { metadata, updateBytes: journalBytes(raw.update_bytes) }, checkpoint, history, restoreOperationId };
}
export function verifyJournalHistoryRow(db: SqliteDb, row: DecodedJournalRow): void {
  verifyJournalHistoryMetadata(db, row.admitted.metadata, row.history);
}
export function verifyJournalHistoryMetadata(db: SqliteDb, metadata: AdmittedLiveUpdate["metadata"], history: DecodedJournalRow["history"]): void {
  const {binding, receipt} = metadata.accepted;
  const predecessor = db.prepare(`SELECT canonical_version,relay_database_namespace,accepted_event_count,accepted_evidence_digest FROM ${LIVE_JOURNAL_TABLE}
    WHERE ${JOURNAL_DOCUMENT_WHERE} AND journal_cursor<? ORDER BY journal_cursor DESC LIMIT 1`).get(...documentParams(binding), receipt.journalCursor);
  verifyJournalHistoryLink(metadata, history, predecessor);
}
function verifyJournalHistoryLink(metadata: AdmittedLiveUpdate["metadata"], history: DecodedJournalRow["history"],
  predecessor: Record<string, unknown> | undefined): void {
  const {binding} = metadata.accepted;
  journalIntegrity(history.metadataBytes === Buffer.byteLength(JSON.stringify(canonicalAcceptedMetadata(metadata))));
  if (predecessor) journalIntegrity(predecessor.relay_database_namespace === history.namespace &&
    !(predecessor.canonical_version === 2 && metadata.canonicalVersion !== 2));
  const previousCount = predecessor ? authorityInteger(predecessor.accepted_event_count, 1) : 0;
  const previousDigest = predecessor ? parseLiveUpdateDigest(predecessor.accepted_evidence_digest) : initialAcceptedHistoryDigest(history.namespace, binding);
  journalIntegrity(previousCount < Number.MAX_SAFE_INTEGER && history.eventCount === previousCount + 1 &&
    history.evidenceDigest === nextAcceptedHistoryDigest(previousDigest, history.eventCount, metadata));
}
export function assertJournalCheckpointPosition(db: SqliteDb, row: {admitted: {metadata: AdmittedLiveUpdate["metadata"]}; checkpoint: {digest: string} | null;
  restoreOperationId: string | null; history: {namespace: string}}, budget?:{bytes:number;chargeBytes(value:number):void}): { count: number; bytes: number } {
  const restored = verifyRestoreCheckpoint(db, row,budget?.bytes,budget?value=>budget.chargeBytes(value):undefined);
  const { binding, receipt } = row.admitted.metadata.accepted;
  const predecessor=db.prepare(`SELECT journal_cursor,current_path,restore_fence_generation FROM ${LIVE_JOURNAL_TABLE} WHERE ${JOURNAL_DOCUMENT_WHERE} AND journal_cursor<? ORDER BY journal_cursor DESC LIMIT 1`).get(...documentParams(binding),receipt.journalCursor);
  if (predecessor) journalIntegrity(predecessor.current_path===binding.currentPath && (restored
    ? predecessor.restore_fence_generation===acrossDeclinedRestores(db,row.history.namespace,restored.preparation.fence.operation.oldBinding,
      authorityInteger(predecessor.journal_cursor,1),budget?value=>budget.chargeBytes(value):undefined)?.restoreFenceGeneration
    : predecessor.restore_fence_generation===binding.restoreFenceGeneration));
  const previous = db.prepare(`SELECT journal_cursor FROM ${LIVE_JOURNAL_TABLE} WHERE ${JOURNAL_DOCUMENT_WHERE}
    AND journal_cursor<? AND validation_checkpoint_bytes IS NOT NULL ORDER BY journal_cursor DESC LIMIT 1`)
    .get(...documentParams(binding), receipt.journalCursor);
  const floor = previous ? authorityInteger(previous.journal_cursor, 1) : 0;
  const segment = db.prepare(`SELECT journal_cursor, typeof(update_bytes) AS update_type, length(update_bytes) AS update_length,
      validation_checkpoint_sha256 IS NOT NULL AS has_checkpoint_digest,
      validation_checkpoint_bytes IS NOT NULL AS has_checkpoint_bytes FROM ${LIVE_JOURNAL_TABLE}
    WHERE ${JOURNAL_DOCUMENT_WHERE} AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT 4096`)
    .all(...documentParams(binding), floor, receipt.journalCursor);
  journalIntegrity(segment.length > 0 && segment.length <= 4095);
  let bytes = 0;
  for (const [index, raw] of segment.entries()) {
    journalIntegrity(raw.update_type === "blob");
    const length = authorityInteger(raw.update_length, 1);
    journalIntegrity(length <= 20_971_520);
    bytes += length;
    const authorDue = index === segment.length - 1 && row.admitted.metadata.checkpointCoverage !== undefined &&
      liveAuthorCoverageCheckpointDue(row.admitted.metadata.checkpointCoverage);
    const due = liveJournalCheckpointDue(index + 1, bytes) || authorDue;
    const hasCheckpoint = raw.has_checkpoint_bytes === 1;
    journalIntegrity(hasCheckpoint === (raw.has_checkpoint_digest === 1));
    journalIntegrity((due || (restored !== null && index === segment.length - 1)) === hasCheckpoint);
    if (index < segment.length - 1) journalIntegrity(!due);
  }
  return { count: segment.length, bytes };
}
export function verifyJournalRow(row: DecodedJournalRow): void {
  journalDigest(row.admitted.updateBytes, row.admitted.metadata.accepted.receipt.updateDigest);
  if (row.checkpoint) journalDigest(row.checkpoint.bytes, row.checkpoint.digest);
}

export const REPLICA_LIVE_JOURNAL_MAX_ROWS = 500;
// The accepted record and the stored JSON columns bound metadata work conservatively.
const REPLICA_METADATA_JSON_COLUMNS = ["author_snapshot_json", "author_context_json", "first_seen_deletes_json", "checkpoint_coverage_json", "seed_first_seen_json"] as const;
function replicaMetadataBytes(raw: Record<string, unknown>, retained = true): number {
  return REPLICA_METADATA_JSON_COLUMNS.reduce((total, column) => {
    if (!retained && (column === "author_context_json" || column === "seed_first_seen_json")) return total;
    const value = raw[column];
    return total + (typeof value === "string" ? Buffer.byteLength(value) : 0);
  }, authorityInteger(raw.accepted_metadata_bytes, 1));
}
export const REPLICA_LIVE_JOURNAL_MAX_BYTES = 32 * 1024 * 1024;
// Independent documents and restores can checkpoint within the same page.
const REPLICA_LIVE_JOURNAL_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

export interface ReplicaLiveJournalAuthority {
  readonly lineageClaimId: string;
  readonly baselineSequence: number;
  readonly restoreFenceGeneration: number;
}

export interface ReplicaLiveJournalRow {
  readonly admitted: {readonly metadata: AdmittedLiveUpdate["metadata"]; readonly updateBytes: string};
  readonly relayDatabaseNamespace: string;
  readonly evidenceDigest: string;
  readonly journalCursor: number;
  readonly restore: {readonly operationId: string; readonly checkpoint: {readonly digest: string; readonly bytes: string};
    readonly proof: RestoreAdmission} | null;
  // A retired object has no current authority until another lineage is registered.
  readonly authority: ReplicaLiveJournalAuthority | null;
}

/**
 * A restore declined after its native fence committed, at the journal cursor
 * the relay gave its host's receipt. It is no delivery and carries no bytes:
 * a replica advances the document's generation and nothing else.
 */
export interface ReplicaLiveJournalCancellation {
  readonly relayDatabaseNamespace: string;
  readonly journalCursor: number;
  readonly cancellation: NativeRestoreCancellationReceipt;
}

export interface ReplicaLiveJournalPage {
  readonly rows: readonly (ReplicaLiveJournalRow | ReplicaLiveJournalCancellation)[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

export interface ReplicaLiveJournalRead {
  readonly workspaceId: string;
  readonly after: number;
  readonly limit: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
  readonly guard?: () => void;
}

interface ReplicaJournalSnapshotRow {
  raw: Record<string, unknown>;
  provenance: Record<string, unknown>[];
  predecessor: Record<string, unknown> | undefined;
  projected: ReplicaJournalProjection;
  restoreProof: RestoreAdmission | null;
}

interface ReplicaJournalProjection {
  document: LiveDocumentKey;
  journalCursor: number;
  authority: ReplicaLiveJournalAuthority | null;
}

// Field names, digests, cursor and authority around each served row; phase 2 checks the exact size again.
const REPLICA_JOURNAL_ROW_FRAME_BYTES = 1024;

function captureReplicaJournalRows(storage: StorageContext, workspaceId: string, after: number,
  projected: readonly ReplicaJournalProjection[], maxBytes: number): ReplicaJournalSnapshotRow[] {
  if (projected.length === 0) return [];
  const through = projected.at(-1)!.journalCursor;
  const rawRows: Record<string, unknown>[] = [];
  let rowBytes = 0, captureBytes = 0;
  const fits = (encodedBytes: number, retainedBytes: number, cursor: number) => rawRows.length === 0 ||
    (replicaJournalResponseBytes(rowBytes + encodedBytes, rawRows.length + 1, cursor, false) <= maxBytes &&
      captureBytes + retainedBytes <= REPLICA_LIVE_JOURNAL_MAX_CAPTURE_BYTES);
  for (const raw of storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE}
    WHERE workspace_id=? AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor`).iterate(workspaceId, after, through)) {
    const updateLength = (raw.update_bytes as Uint8Array).byteLength;
    const checkpointLength = (raw.validation_checkpoint_bytes as Uint8Array | null)?.byteLength ?? 0;
    let retainedBytes = updateLength + checkpointLength + replicaMetadataBytes(raw);
    let encodedBytes = 4 * Math.ceil(updateLength / 3) + replicaMetadataBytes(raw, false) + REPLICA_JOURNAL_ROW_FRAME_BYTES +
      Buffer.byteLength(JSON.stringify(String(raw.relay_database_namespace))) +
      (raw.restore_operation_id === null ? 0 : 4 * Math.ceil(checkpointLength / 3) + Buffer.byteLength(JSON.stringify(String(raw.restore_operation_id))));
    const cursor = authorityInteger(raw.journal_cursor, 1);
    // Keep the first admitted row even when it exceeds a cap.
    if (!fits(encodedBytes, retainedBytes, cursor)) break;
    const proofBytes = raw.restore_operation_id === null ? 0 : authorityInteger(storage.db.prepare(
      `SELECT length(CAST(l.admission_json AS BLOB)) AS bytes FROM sync_relay_live_restore_lifecycles l JOIN ${LIVE_RESTORE_OPERATIONS} o USING(relay_database_namespace,operation_id)
        WHERE l.relay_database_namespace=? AND l.operation_id=? AND o.workspace_id=?`)
      .get(raw.relay_database_namespace, raw.restore_operation_id, workspaceId)?.bytes, 1);
    encodedBytes += proofBytes;
    retainedBytes += proofBytes;
    if (!fits(encodedBytes, retainedBytes, cursor)) break;
    rawRows.push(raw);
    rowBytes += encodedBytes;
    captureBytes += retainedBytes;
  }
  journalIntegrity(rawRows.length > 0);
  const keptThrough = authorityInteger(rawRows.at(-1)!.journal_cursor, 1);
  const provenance = new Map<number, Record<string, unknown>[]>();
  const ranges = storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_PROVENANCE}
    WHERE +workspace_id=? AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor,client_id,start_clock`)
    .all(workspaceId, after, keptThrough);
  for (const raw of ranges) {
    const cursor = authorityInteger(raw.journal_cursor, 1);
    const rows = provenance.get(cursor) ?? [];
    rows.push(raw); provenance.set(cursor, rows);
  }
  const previous = new Map<string, Record<string, unknown>>();
  const predecessorQuery = storage.db.prepare(`SELECT canonical_version,relay_database_namespace,accepted_event_count,accepted_evidence_digest
    FROM ${LIVE_JOURNAL_TABLE} WHERE ${JOURNAL_DOCUMENT_WHERE} AND journal_cursor<? ORDER BY journal_cursor DESC LIMIT 1`);
  return rawRows.map((raw, index) => {
    const projection = projected[index]!;
    journalIntegrity(raw.journal_cursor === projection.journalCursor);
    const key = JSON.stringify(documentParams(projection.document));
    const predecessor = previous.get(key) ?? predecessorQuery.get(...documentParams(projection.document), projection.journalCursor);
    previous.set(key, raw);
    const restoreProof = raw.restore_operation_id === null ? null : readRestoreAdmission(storage.db,
      parseLiveUpdateIdentifier(raw.relay_database_namespace), parseLiveUpdateIdentifier(raw.restore_operation_id));
    return {raw, projected: projection, provenance: provenance.get(projection.journalCursor) ?? [], predecessor, restoreProof};
  });
}

function replicaJournalInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError("Invalid replica journal page input.");
  return value;
}

function replicaJournalAuthority(raw: Record<string, unknown> | undefined): ReplicaLiveJournalAuthority | null {
  if (!raw) return null;
  return {lineageClaimId: parseLiveUpdateDigest(raw.lineage_claim_id),
    baselineSequence: authorityInteger(raw.baseline_moment_relay_seq, 1),
    restoreFenceGeneration: authorityInteger(raw.restore_fence_generation)};
}

function replicaJournalProjection(raw: Record<string, unknown>, authority: ReplicaLiveJournalAuthority | null): ReplicaJournalProjection {
  return {
    document: journalDocument({workspaceId: raw.workspace_id, mainVersionId: raw.main_version_id,
      objectId: raw.object_id, lineageClaimId: raw.lineage_claim_id}),
    journalCursor: authorityInteger(raw.journal_cursor, 1),
    authority,
  };
}

function replicaJournalResponseBytes(rowBytes: number, count: number, nextCursor: number, hasMore: boolean): number {
  return Buffer.byteLength(JSON.stringify({ok: true, rows: [], nextCursor, hasMore})) + rowBytes + Math.max(0, count - 1);
}

/** Captures committed rows and current authority together, independent of host application. */
export async function readReplicaLiveJournal(storage: StorageContext, input: ReplicaLiveJournalRead): Promise<ReplicaLiveJournalPage> {
  const workspaceId = parseLiveUpdateIdentifier(input.workspaceId);
  const after = replicaJournalInteger(input.after, 0, Number.MAX_SAFE_INTEGER);
  const limit = replicaJournalInteger(input.limit, 1, REPLICA_LIVE_JOURNAL_MAX_ROWS);
  const maxBytes = replicaJournalInteger(input.maxBytes ?? REPLICA_LIVE_JOURNAL_MAX_BYTES, 1, REPLICA_LIVE_JOURNAL_MAX_BYTES);
  const assertStanding = storage.captureStanding();
  const check = () => {input.signal?.throwIfAborted(); assertStanding(); input.guard?.();};
  check();
  const snapshot = storage.readTx(() => {
    const projectedRows: ReplicaJournalProjection[] = [];
    const authorities = new Map<string, ReplicaLiveJournalAuthority | null>();
    const currentAuthority = storage.db.prepare(`SELECT lineage_claim_id,baseline_moment_relay_seq,restore_fence_generation
      FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_state='current'`);
    // Lengths avoid walking either blob; price stored metadata while capturing full rows.
    const headers = storage.db.prepare(`SELECT journal_cursor,workspace_id,main_version_id,object_id,lineage_claim_id,
      length(update_bytes) AS update_length,length(validation_checkpoint_bytes) AS checkpoint_length
      FROM ${LIVE_JOURNAL_TABLE} WHERE workspace_id=? AND journal_cursor>? ORDER BY journal_cursor LIMIT ?`)
      .iterate(workspaceId, after, limit + 1);
    let rowBytes = 0, captureBytes = 0, nextCursor = after, hasMore = false;
    for (const header of headers) {
      if (projectedRows.length === limit) {hasMore = true; break;}
      const key = JSON.stringify([header.main_version_id, header.object_id]);
      let authority = authorities.get(key);
      if (authority === undefined) {
        authority = replicaJournalAuthority(currentAuthority.get(workspaceId, header.main_version_id, header.object_id));
        authorities.set(key, authority);
      }
      const projected = replicaJournalProjection(header, authority);
      journalIntegrity(projected.document.workspaceId === workspaceId && projected.journalCursor > nextCursor);
      const updateLength = authorityInteger(header.update_length, 1);
      journalIntegrity(updateLength <= 20_971_520);
      const checkpointLength = header.checkpoint_length === null ? 0 : authorityInteger(header.checkpoint_length, 1);
      journalIntegrity(checkpointLength <= 20_971_520);
      const retainedBytes = updateLength + checkpointLength;
      const encodedBytes = 4 * Math.ceil(updateLength / 3);
      // The first row is always served: the relay admitted it, so the replica must be able to read it.
      if (projectedRows.length > 0 && (replicaJournalResponseBytes(rowBytes + encodedBytes, projectedRows.length + 1, projected.journalCursor, false) > maxBytes ||
          captureBytes + retainedBytes > REPLICA_LIVE_JOURNAL_MAX_CAPTURE_BYTES)) {
        hasMore = true; break;
      }
      projectedRows.push(projected);
      captureBytes += retainedBytes;
      rowBytes += encodedBytes;
      nextCursor = projected.journalCursor;
    }
    const captured = captureReplicaJournalRows(storage, workspaceId, after, projectedRows, maxBytes);
    // Cancellation control entries take cursors between deliveries; one past the limit shows there are more.
    const controls = storage.db.prepare(`SELECT relay_database_namespace,journal_cursor,acknowledgment_json FROM ${LIVE_RESTORE_CANCELLATIONS}
      WHERE workspace_id=? AND journal_cursor IS NOT NULL AND journal_cursor>? ORDER BY journal_cursor LIMIT ?`).all(workspaceId, after, limit + 1).map(row => {
      const answer = parseNativeRestoreCancellationAnswer(JSON.parse(String(row.acknowledgment_json)));
      journalIntegrity(answer.status === "fenceCancelled");
      return {relayDatabaseNamespace: parseLiveUpdateIdentifier(row.relay_database_namespace), journalCursor: authorityInteger(row.journal_cursor, 1),
        cancellation: answer.receipt} satisfies ReplicaLiveJournalCancellation;
    });
    return {captured, controls, hasMore: hasMore || captured.length < projectedRows.length};
  });
  const rows: (ReplicaLiveJournalRow | ReplicaLiveJournalCancellation)[] = [];
  let workBytes = 0, rowBytes = 0, nextCursor = after, hasMore = snapshot.hasMore, control = 0;
  // Serves the control entries ordered before `cursor`. False once the page is full.
  const serveControls = (cursor: number) => {
    for (; control < snapshot.controls.length && snapshot.controls[control]!.journalCursor < cursor; control++) {
      const entry = snapshot.controls[control]!, encodedBytes = Buffer.byteLength(JSON.stringify(entry));
      if (rows.length === limit || (rows.length > 0 && replicaJournalResponseBytes(rowBytes + encodedBytes, rows.length + 1, entry.journalCursor, false) > maxBytes)) return false;
      rows.push(entry);
      rowBytes += encodedBytes;
      nextCursor = entry.journalCursor;
    }
    return true;
  };
  if (replicaJournalResponseBytes(0, 0, after, false) > maxBytes) throw new RangeError("Replica journal response exceeds the byte budget.");
  const yieldWork = async () => {await setImmediate(); check(); workBytes = 0;};
  // Keep intermediate chunks divisible by three, so only the last has base64 padding.
  const chunkBytes = 1024 * 1024 - 1;
  const verifyAndEncode = async (bytes: Uint8Array, digest: string, encode: boolean) => {
    const hash = createHash("sha256"), encoded: string[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      const chunk = bytes.subarray(offset, offset + chunkBytes);
      if (workBytes + chunk.byteLength > chunkBytes) await yieldWork();
      hash.update(chunk);
      if (encode) encoded.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64"));
      workBytes += chunk.byteLength;
    }
    journalIntegrity(hash.digest("hex") === digest);
    return encoded.join("");
  };
  for (const [index, entry] of snapshot.captured.entries()) {
    if (!serveControls(entry.projected.journalCursor) || rows.length === limit) {hasMore = true; break;}
    // Verification and encoding do not hold a SQLite transaction or monopolize pushes.
    if (index % 16 === 0) await yieldWork();
    const metadataBytes = replicaMetadataBytes(entry.raw);
    if (workBytes + metadataBytes > chunkBytes) await yieldWork();
    workBytes += metadataBytes;
    const decoded = decodeJournalRow(storage.db, entry.raw, entry.provenance);
    const row: ReplicaLiveJournalRow = {admitted: {metadata: decoded.admitted.metadata, updateBytes: ""},
      relayDatabaseNamespace: decoded.history.namespace, evidenceDigest: decoded.history.evidenceDigest,
      journalCursor: entry.projected.journalCursor, authority: entry.projected.authority,
      restore: entry.restoreProof ? {operationId: decoded.restoreOperationId!,
        checkpoint: {digest: decoded.checkpoint!.digest, bytes: ""}, proof: entry.restoreProof} : null};
    const encodedBytes = Buffer.byteLength(JSON.stringify(row)) + 4 * Math.ceil(decoded.admitted.updateBytes.byteLength / 3) +
      (row.restore ? 4 * Math.ceil(decoded.checkpoint!.bytes.byteLength / 3) : 0);
    if (rows.length > 0 && replicaJournalResponseBytes(rowBytes + encodedBytes, rows.length + 1, row.journalCursor, false) > maxBytes) {
      hasMore = true; break;
    }
    verifyJournalHistoryLink(decoded.admitted.metadata, decoded.history, entry.predecessor);
    if (entry.restoreProof) journalIntegrity(decoded.checkpoint && decoded.checkpoint.digest === entry.restoreProof.checkpointDigest &&
      isDeepStrictEqual(decoded.admitted.metadata, entry.restoreProof.admitted));
    const update = await verifyAndEncode(decoded.admitted.updateBytes, decoded.admitted.metadata.accepted.receipt.updateDigest, true);
    const checkpoint = decoded.checkpoint ? await verifyAndEncode(decoded.checkpoint.bytes, decoded.checkpoint.digest, decoded.restoreOperationId !== null) : null;
    rows.push({...row, admitted: {...row.admitted, updateBytes: update},
      restore: row.restore ? {...row.restore, checkpoint: {...row.restore.checkpoint, bytes: checkpoint!}} : null});
    rowBytes += encodedBytes;
    nextCursor = row.journalCursor;
  }
  // Entries after the last served delivery belong to this page only when no delivery was left for the next.
  if (!hasMore && !serveControls(Number.MAX_SAFE_INTEGER)) hasMore = true;
  check();
  return {rows, nextCursor, hasMore};
}

function copyJournalData(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (nodeTypes.isUint8Array(value)) return journalBytes(value);
  if (Array.isArray(value)) return journalArray(value, Number.MAX_SAFE_INTEGER, copyJournalData);
  if (typeof value !== "object" || nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError("Invalid journal capture.");
  const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new TypeError("Invalid journal capture key.");
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid journal capture field.");
    Object.defineProperty(result, key, { value: copyJournalData(descriptor.value), enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function snapshotJournalCut(value: unknown): LiveUpdateJournalCut {
  const outer = baselineRecord(value, ["authorityHistory", "document", "currentPath", "restoreFenceGeneration", "baseline",
    "checkpoint", "suffix", "highWater", "suffixCount", "suffixBytes"]);
  let previousBinding: LiveObjectBinding | undefined;
  const suffix = journalArray(outer.suffix, 4094, value => {
    const row = baselineRecord(value, ["cursor", "digest", "bytes", "metadata"]);
    const metadata = journalRecord(row.metadata, ["accepted", "firstSeen"], ["canonicalVersion","authorSnapshot","firstSeenDeletes","checkpointCoverage"]);
    if (metadata.canonicalVersion === undefined) journalIntegrity(Object.keys(metadata).length === 2);
    else journalIntegrity(metadata.canonicalVersion === 2 && Object.hasOwn(metadata,"authorSnapshot") && Object.hasOwn(metadata,"firstSeenDeletes"));
    const accepted = baselineRecord(metadata.accepted, ["receipt", "binding", "authority", "receivedAtMs"]);
    const receipt = parseLiveUpdateReceipt(baselineRecord(accepted.receipt, ["deliveryId", "updateDigest", "journalCursor", "acceptingHostEpoch"]));
    const binding = journalBinding(accepted.binding, previousBinding);
    const rawBinding = baselineRecord(accepted.binding, ["workspaceId", "mainVersionId", "objectId", "lineageClaimId", "currentPath", "selectorPaths", "restoreFenceGeneration"]);
    journalIntegrity(binding.mainVersionId === "main" && binding.currentPath === rawBinding.currentPath &&
      isDeepStrictEqual(binding.selectorPaths, rawBinding.selectorPaths));
    previousBinding = binding;
    const authority = parseServerDerivedLiveUpdateAuthority(baselineRecord(accepted.authority, ["principalKind", "principalId", "grantId", "grantGeneration"]));
    const cursor = authorityInteger(row.cursor, 1), digest = parseLiveUpdateDigest(row.digest);
    journalIntegrity(cursor === receipt.journalCursor && digest === receipt.updateDigest);
    return { cursor, digest, bytes: journalBytes(row.bytes), metadata: {
      accepted: { receipt, binding, authority, receivedAtMs: authorityInteger(accepted.receivedAtMs) },
      firstSeen: journalRanges(metadata.firstSeen),
      ...(metadata.canonicalVersion === 2 ? {canonicalVersion: 2 as const, authorSnapshot: parseLiveAuthorSnapshot(copyJournalData(metadata.authorSnapshot)),
        firstSeenDeletes: journalRanges(metadata.firstSeenDeletes), ...(metadata.checkpointCoverage === undefined ? {} : {checkpointCoverage: parseLiveCheckpointCoverage(copyJournalData(metadata.checkpointCoverage))})} : {}),
    } };
  });
  return { ...copyJournalData({ ...outer, suffix: [] }) as LiveUpdateJournalCut, suffix };
}

interface IssuedJournalCut {
  storage: StorageContext;
  cut: LiveUpdateJournalCut;
  current: () => boolean;
}
const issuedJournalCuts = new WeakMap<object, IssuedJournalCut>();

// Compare data descriptors, never caller getters or proxy traps. The issued cut
// stays private, including its byte arrays; public tokens remain mutable.
function journalDataMatches(value: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(value, expected);
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) return false;
  if (nodeTypes.isUint8Array(expected)) {
    if (!nodeTypes.isUint8Array(value)) return false;
    return Buffer.compare(journalBytes(value), expected) === 0;
  }
  const array = Array.isArray(expected);
  if (Array.isArray(value) !== array) return false;
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(expected);
  if (Reflect.ownKeys(value).length !== keys.length) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== !(array && key === "length") ||
      !journalDataMatches(descriptor.value, Reflect.get(expected, key))) return false;
  }
  return true;
}

function captureJournalCut(storage: StorageContext, value: unknown): { token: LiveUpdateJournalCut; issued?: IssuedJournalCut } {
  const issued = typeof value === "object" && value !== null ? issuedJournalCuts.get(value) : undefined;
  if (issued?.storage === storage && journalDataMatches(value, issued.cut)) return { token: issued.cut, issued };
  const token = snapshotJournalCut(value);
  verifyJournalCut(token);
  return { token };
}

function compareJournalSuffixRow(raw: Record<string, unknown>, expected: LiveUpdateJournalCut["suffix"][number],
  provenance: readonly Record<string, unknown>[]): void {
  const { receipt, binding, authority, receivedAtMs } = expected.metadata.accepted;
  journalIntegrity(raw.journal_cursor === expected.cursor && raw.delivery_id === receipt.deliveryId &&
    raw.update_digest === expected.digest && raw.accepting_host_epoch === receipt.acceptingHostEpoch &&
    raw.workspace_id === binding.workspaceId && raw.main_version_id === binding.mainVersionId &&
    raw.object_id === binding.objectId && raw.lineage_claim_id === binding.lineageClaimId &&
    raw.current_path === binding.currentPath && raw.selector_paths_json === JSON.stringify(binding.selectorPaths) &&
    Object.is(raw.restore_fence_generation, binding.restoreFenceGeneration) &&
    raw.principal_kind === authority.principalKind && raw.principal_id === authority.principalId &&
    raw.grant_id === authority.grantId && raw.grant_generation === authority.grantGeneration && Object.is(raw.received_at_ms, receivedAtMs) &&
    raw.validation_checkpoint_sha256 === null && raw.validation_checkpoint_bytes === null && raw.restore_operation_id === null);
  parseLiveUpdateIdentifier(raw.relay_database_namespace);
  authorityInteger(raw.accepted_event_count, 1);
  parseLiveUpdateDigest(raw.accepted_evidence_digest);
  authorityInteger(raw.accepted_metadata_bytes, 1);
  journalIntegrity(nodeTypes.isUint8Array(raw.update_bytes) && Buffer.compare(raw.update_bytes, expected.bytes) === 0);
  const seed = journalRanges(JSON.parse(String(raw.seed_first_seen_json)));
  const expectedRanges = [...expected.metadata.firstSeen, ...seed].sort((a,b) => a.clientId-b.clientId || a.startClock-b.startClock);
  journalIntegrity(raw.canonical_version === (expected.metadata.canonicalVersion ?? 1) &&
    (raw.canonical_version === 1 || (raw.author_snapshot_json === JSON.stringify(expected.metadata.authorSnapshot) &&
      raw.first_seen_deletes_json === JSON.stringify(expected.metadata.firstSeenDeletes) && raw.checkpoint_coverage_json === null)));
  journalIntegrity(provenance.length === expectedRanges.length);
  for (let index = 0; index < provenance.length; index++) {
    const row = provenance[index]!, range = expectedRanges[index]!;
    journalIntegrity(row.workspace_id === binding.workspaceId && row.main_version_id === binding.mainVersionId &&
      row.object_id === binding.objectId && row.lineage_claim_id === binding.lineageClaimId && row.journal_cursor === expected.cursor &&
      Object.is(row.client_id, range.clientId) && Object.is(row.start_clock, range.startClock) && row.end_clock === range.endClock);
  }
}
export function verifyJournalCut(cut: LiveUpdateJournalCut): void {
  for (const authority of cut.authorityHistory) journalDigest(authority.baselineBytes, authority.baselineDigest);
  journalDigest(cut.baseline.bytes, cut.baseline.digest);
  journalDigest(cut.checkpoint.bytes, cut.checkpoint.digest);
  if (cut.checkpoint.metadata && cut.checkpoint.updateBytes) journalDigest(cut.checkpoint.updateBytes, cut.checkpoint.metadata.accepted.receipt.updateDigest);
  for (const row of cut.suffix) journalDigest(row.bytes, row.digest);
}
export function journalHost(db: SqliteDb, candidate: LiveHostConnectionCoordinate): HostControlSnapshot |
  { kind: "retry"; reason: "host-unavailable" } | { kind: "refused"; reason: "stale-session" } {
  const host = readLiveHostControl(db);
  if (host) assertCurrentAuthorityHost(db, host);
  if (!host || host.admissionState !== "open" || host.transition) return { kind: "retry", reason: "host-unavailable" };
  authorityIntegrity(host.registeredInstanceId !== null && host.registeredConnectionId !== null);
  if (candidate.mode !== host.configuredMode || candidate.hostId !== host.configuredHostId || candidate.hostEpoch !== host.hostEpoch ||
    candidate.instanceId !== host.registeredInstanceId || candidate.connectionId !== host.registeredConnectionId) return { kind: "refused", reason: "stale-session" };
  return host;
}

function snapshotJournalValidation(value: unknown, checkpointDue: boolean): LiveJournalValidation {
  const outer = baselineRecord(value, ["kind"], true);
  if (outer.kind === "refused") {
    const refused = baselineRecord(value, ["kind", "reason", "source"]);
    if (!["call", "admitted-cut", "candidate", "final"].includes(String(refused.source)) ||
      !["invalid-input", "invalid-update", "invalid-schema", "projection-mutated", "capacity-refused"].includes(String(refused.reason))) throw new TypeError("Invalid journal refusal.");
    return refused as unknown as LiveJournalValidation;
  }
  if (outer.kind !== "accepted") throw new TypeError("Invalid journal validation.");
  const accepted = baselineRecord(value, ["kind", "evidence"]);
  baselineRecord(accepted.evidence, ["version"], true);
  const stateDescriptor = Object.getOwnPropertyDescriptor(accepted.evidence,"stateUpdate");
  const captureState = checkpointDue || (stateDescriptor !== undefined && Object.hasOwn(stateDescriptor,"value"));
  const evidence = baselineRecord(accepted.evidence, ["version", "document", "currentPath", "checkpointDigest", "checkpointRanges", "suffixDigests",
    "candidate", "stateUpdateSha256", "stateUpdateByteLength", "projectedMarkdownSha256", "projectedMarkdownByteLength", ...(captureState ? ["stateUpdate"] : [])], true);
  if (evidence.version !== 1 || typeof evidence.currentPath !== "string") throw new TypeError("Unknown journal evidence.");
  const candidate = baselineRecord(evidence.candidate, ["updateDigest", "ranges", "firstSeen", "firstSeenDeletes"]);
  const stateUpdateSha256 = parseLiveUpdateDigest(evidence.stateUpdateSha256);
  const stateUpdateByteLength = authorityInteger(evidence.stateUpdateByteLength, 1);
  if (stateUpdateByteLength > 20_971_520) throw new TypeError("Journal state length exceeds the existing bound.");
  const stateUpdate = Object.hasOwn(evidence, "stateUpdate") ? journalBytes(evidence.stateUpdate) : undefined;
  if (checkpointDue && !stateUpdate) throw new TypeError("Checkpoint state is missing.");
  if (stateUpdate) {
    if (stateUpdate.byteLength !== stateUpdateByteLength) throw new TypeError("Journal state length mismatch.");
    journalDigest(stateUpdate, stateUpdateSha256);
  }
  return { kind: "accepted", evidence: { version: 1, document: journalDocument(evidence.document), currentPath: evidence.currentPath,
    checkpointDigest: parseLiveUpdateDigest(evidence.checkpointDigest), checkpointRanges: journalRanges(evidence.checkpointRanges), suffixDigests: journalArray(evidence.suffixDigests, 4094, parseLiveUpdateDigest),
    candidate: { updateDigest: parseLiveUpdateDigest(candidate.updateDigest), ranges: journalRanges(candidate.ranges),
      firstSeen: journalRanges(candidate.firstSeen), firstSeenDeletes: journalRanges(candidate.firstSeenDeletes) },
    ...(stateUpdate ? { stateUpdate } : {}), stateUpdateSha256, stateUpdateByteLength,
    projectedMarkdownSha256:parseLiveUpdateDigest(evidence.projectedMarkdownSha256),projectedMarkdownByteLength:authorityInteger(evidence.projectedMarkdownByteLength) } };
}
function journalValidationRefusal(validation: Extract<LiveJournalValidation, { kind: "refused" }>): Exclude<RelayLiveUpdateJournalResult["result"], { kind: "accepted" }> {
  const { source, reason } = validation;
  if (source === "call" || reason === "projection-mutated") throw new Error("Live journal validator integration failed.");
  if (source === "admitted-cut") {
    if (reason === "capacity-refused") throw new LiveJournalAdmittedCapacityError();
    if (reason === "invalid-update" || reason === "invalid-schema") throw new Error("Admitted live journal storage cannot validate.");
    throw new Error("Impossible admitted journal refusal.");
  }
  return { kind: "refused", reason: reason === "capacity-refused" ? "capacity-refused" : "invalid-update" };
}
export function subtractJournalRanges(candidate: readonly LiveUpdateStructRange[], coverage: readonly LiveUpdateStructRange[]): LiveUpdateStructRange[] {
  const result: LiveUpdateStructRange[] = [];
  let index = 0;
  for (const range of candidate) {
    let start = range.startClock;
    while (index < coverage.length && (coverage[index]!.clientId < range.clientId ||
      (coverage[index]!.clientId === range.clientId && coverage[index]!.endClock <= start))) index++;
    for (let cursor = index; cursor < coverage.length; cursor++) {
      const old = coverage[cursor]!;
      if (old.clientId !== range.clientId || old.startClock >= range.endClock) break;
      if (old.startClock > start) result.push({ clientId: range.clientId, startClock: start, endClock: old.startClock });
      start = Math.max(start, old.endClock);
      if (start >= range.endClock) break;
    }
    if (start < range.endClock) result.push({ clientId: range.clientId, startClock: start, endClock: range.endClock });
  }
  return result;
}


export function readLiveUpdateJournalCut(storage: StorageContext, input: { document: LiveDocumentKey }, reserveBytes?: (size: number) => void): LiveUpdateJournalCutResult {
    const outer = baselineRecord(input, ["document"]), document = journalDocument(outer.document);
    let current: (() => boolean) | undefined;
    const result = storage.readTx(() => {
      if (reserveBytes) {
        const history = storage.db.prepare(`SELECT COALESCE(SUM(length(baseline_bytes)),0) AS bytes
          FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id=? AND object_id=?`)
          .get(document.workspaceId, document.mainVersionId, document.objectId)!;
        const checkpoint = storage.db.prepare(`SELECT journal_cursor FROM ${LIVE_JOURNAL_TABLE}
          WHERE ${JOURNAL_DOCUMENT_WHERE} AND validation_checkpoint_bytes IS NOT NULL ORDER BY journal_cursor DESC LIMIT 1`)
          .get(...documentParams(document));
        const journal = storage.db.prepare(`SELECT COALESCE(SUM(length(update_bytes)+COALESCE(length(validation_checkpoint_bytes),0)),0) AS bytes
          FROM ${LIVE_JOURNAL_TABLE} WHERE ${JOURNAL_DOCUMENT_WHERE} AND journal_cursor>=?`)
          .get(...documentParams(document), checkpoint?.journal_cursor ?? 0)!;
        // SQLite rows, decoded cut, public token, validation clone, and checkpoint output can coexist.
        reserveBytes(5 * (Number(history.bytes) + Number(journal.bytes)));
      }
      const read = liveJournalCut(storage, document);
      if (read.kind === "cut") current = captureSqliteReadRevisionMatches(storage.db);
      return read;
    });
    if (result.kind === "cut") {
      verifyJournalCut(result.cut);
      const cut = structuredClone(result.cut);
      issuedJournalCuts.set(cut, { storage, cut: result.cut, current: current! });
      return { kind: "cut", cut };
    }
    return result;
  }

/** Internal insertion only. Each caller must revalidate its admission capture in this transaction. */
export function appendValidatedLiveJournal(storage: StorageContext, input: {
  document: LiveDocumentKey; namespace: string; host: LiveHostConnectionCoordinate;
  current: {binding: LiveObjectBinding; authority: AdmittedLiveUpdate["metadata"]["accepted"]["authority"]};
  metadata: {deliveryId: string; updateDigest: string}; updateBytes: Uint8Array; receivedAtMs: number;
  authorContext?: LiveUpdateSubmissionMetadata["authorContext"];
  authorSnapshot?: LiveAuthorSnapshot;
  firstSeenDeletes?: readonly LiveUpdateStructRange[];
  seedFirstSeen?: readonly LiveUpdateStructRange[];
  checkpointCoverage?: readonly LiveCheckpointAuthorCoverage[];
  restoreOperationId?: string;
  firstSeen: AdmittedLiveUpdate["metadata"]["firstSeen"]; checkpointBytes: Uint8Array | null; checkpointDigest: string | null;
  priorMetadata: AdmittedLiveUpdate["metadata"] | null | undefined; onFirstWrite?: () => void;
}): AdmittedLiveUpdate {
  const {document,namespace,host,current,metadata,updateBytes,receivedAtMs,firstSeen,checkpointBytes,checkpointDigest,priorMetadata,onFirstWrite}=input;
  const authorContextJson = input.authorContext === undefined ? null : JSON.stringify(input.authorContext);
  const authorSnapshot = input.authorSnapshot ?? [];
  const firstSeenDeletes = input.firstSeenDeletes ?? [];
  const seedFirstSeen = input.seedFirstSeen ?? [];
  const checkpointCoverage = input.checkpointCoverage ?? (checkpointBytes === null ? undefined : []);
  const authorSnapshotJson = JSON.stringify(authorSnapshot), deletesJson = JSON.stringify(firstSeenDeletes), seedJson = JSON.stringify(seedFirstSeen);
  const checkpointCoverageJson = checkpointCoverage === undefined ? null : JSON.stringify(checkpointCoverage);
  // Preserve the journal decoder's bounds without copying the owned insert bytes.
  for (const bytes of [updateBytes,checkpointBytes]) if (bytes!==null && (bytes.byteLength<1 || bytes.byteLength>20_971_520))
    throw new TypeError("Invalid journal bytes.");
  const restoreOperationId=input.restoreOperationId??null;
  journalIntegrity(restoreOperationId===null || checkpointBytes!==null);
  requireLiveJournalHistory(storage);
  journalIntegrity(liveJournalHistoryNamespace(storage) === namespace);
  const sequenceRows = storage.db.prepare("SELECT seq FROM sqlite_sequence WHERE name=?").all(LIVE_JOURNAL_TABLE);
  const maximum = storage.db.prepare(`SELECT MAX(journal_cursor) AS maximum FROM ${LIVE_JOURNAL_TABLE}`).get()!.maximum;
  const maximumCursor = maximum === null ? 0 : authorityInteger(maximum, 1);
  journalIntegrity(sequenceRows.length <= 1);
  const sequence = sequenceRows.length ? authorityInteger(sequenceRows[0]!.seq) : 0;
  journalIntegrity((sequenceRows.length !== 0 || maximumCursor === 0) && sequence >= maximumCursor && sequence < Number.MAX_SAFE_INTEGER);
  const nextCursor = sequence + 1;
  const predecessor = storage.db.prepare(`SELECT relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes FROM ${LIVE_JOURNAL_TABLE}
    WHERE ${JOURNAL_DOCUMENT_WHERE} ORDER BY journal_cursor DESC LIMIT 1`).get(...documentParams(document));
  if (predecessor) journalIntegrity(predecessor.relay_database_namespace === namespace);
  const previousCount = predecessor ? authorityInteger(predecessor.accepted_event_count, 1) : 0;
  journalIntegrity(previousCount < Number.MAX_SAFE_INTEGER);
  const eventCount = previousCount + 1;
  const previousDigest = predecessor ? parseLiveUpdateDigest(predecessor.accepted_evidence_digest) : initialAcceptedHistoryDigest(namespace, document);
  if (predecessor) {
    journalIntegrity(priorMetadata);
    verifyJournalHistoryMetadata(storage.db, priorMetadata, {namespace, eventCount: previousCount, evidenceDigest: previousDigest,
      metadataBytes: authorityInteger(predecessor.accepted_metadata_bytes, 1)});
  }
  const intended = {accepted: {receipt: {deliveryId: metadata.deliveryId, updateDigest: metadata.updateDigest, journalCursor: nextCursor,
    acceptingHostEpoch: host.hostEpoch}, binding: current.binding, authority: current.authority, receivedAtMs}, firstSeen,
    canonicalVersion: 2 as const, authorSnapshot, firstSeenDeletes, ...(checkpointCoverage === undefined ? {} : {checkpointCoverage})};
  const evidenceDigest = nextAcceptedHistoryDigest(previousDigest, eventCount, intended);
  const acceptedMetadataBytes = Buffer.byteLength(JSON.stringify(canonicalAcceptedMetadata(intended)));
  const values = [metadata.deliveryId, metadata.updateDigest, ...documentParams(document),
    current.binding.currentPath, JSON.stringify(current.binding.selectorPaths), current.binding.restoreFenceGeneration,
    current.authority.principalKind, current.authority.principalId, current.authority.grantId, current.authority.grantGeneration,
    host.hostEpoch, receivedAtMs];
  // Logical stored values, as with delivery reservations; excludes SQLite pages and indexes.
  const metadataBytes = Buffer.byteLength(JSON.stringify([nextCursor, ...values, checkpointDigest, namespace, eventCount, evidenceDigest, acceptedMetadataBytes,restoreOperationId,
    2,authorContextJson,authorSnapshotJson,deletesJson,checkpointCoverageJson,seedJson]));
  const storedRanges = [...firstSeen,...seedFirstSeen].sort((a,b) => a.clientId-b.clientId || a.startClock-b.startClock);
  for (let index = 1; index < storedRanges.length; index++) {
    const a = storedRanges[index-1]!, b = storedRanges[index]!;
    journalIntegrity(a.clientId !== b.clientId || a.endClock < b.startClock);
  }
  journalIntegrity(isDeepStrictEqual(subtractJournalRanges(storedRanges, liveJournalCoverageWithin(storage, document, storedRanges)), storedRanges));
  const provenanceBytes = storedRanges.reduce((total, range) => total + Buffer.byteLength(JSON.stringify([
    ...documentParams(document), range.clientId, range.startClock, range.endClock, nextCursor,
  ])), 0);
  const charge = updateBytes.byteLength + (checkpointBytes?.byteLength ?? 0) + metadataBytes + provenanceBytes;
  assertWorkspaceQuota(storage, document.workspaceId, charge);
  onFirstWrite?.();
  const insert = storage.db.prepare(`INSERT INTO ${LIVE_JOURNAL_TABLE}(delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,
    current_path,selector_paths_json,restore_fence_generation,principal_kind,principal_id,grant_id,grant_generation,
    accepting_host_epoch,received_at_ms,update_bytes,validation_checkpoint_sha256,validation_checkpoint_bytes,
    relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes,restore_operation_id,
    canonical_version,author_context_json,author_snapshot_json,first_seen_deletes_json,checkpoint_coverage_json,seed_first_seen_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values, updateBytes, checkpointDigest, checkpointBytes, namespace, eventCount, evidenceDigest, acceptedMetadataBytes,restoreOperationId,
      2,authorContextJson,authorSnapshotJson,deletesJson,checkpointCoverageJson,seedJson);
  const cursor = authorityInteger(typeof insert.lastInsertRowid === "bigint" ? Number(insert.lastInsertRowid) : insert.lastInsertRowid, 1);
  journalIntegrity(cursor === nextCursor);
  const insertRange = storage.db.prepare(`INSERT INTO ${LIVE_JOURNAL_PROVENANCE}(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock,end_clock,journal_cursor) VALUES (?,?,?,?,?,?,?,?)`);
  for (const range of storedRanges) insertRange.run(...documentParams(document), range.clientId, range.startClock, range.endClock, cursor);
  const raw = storage.db.prepare(`SELECT journal_cursor,delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,
    current_path,selector_paths_json,restore_fence_generation,principal_kind,principal_id,grant_id,grant_generation,accepting_host_epoch,received_at_ms,
    validation_checkpoint_sha256,length(update_bytes) AS update_length,length(validation_checkpoint_bytes) AS checkpoint_length,
    canonical_version,author_context_json,author_snapshot_json,first_seen_deletes_json,checkpoint_coverage_json,seed_first_seen_json
    FROM ${LIVE_JOURNAL_TABLE} WHERE journal_cursor=?`).get(cursor);
  journalIntegrity(raw);
  const storedMetadata=decodeJournalMetadata(storage.db,raw);
  journalIntegrity(isDeepStrictEqual(storedMetadata,intended) && raw.update_length===updateBytes.byteLength &&
    raw.validation_checkpoint_sha256===checkpointDigest && raw.checkpoint_length===(checkpointBytes?.byteLength??null));
  storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge, document.workspaceId);
  registerLiveDeliveryEvent(storage, document, host.hostId, raw);
  return {metadata:storedMetadata,updateBytes};
}

export function commitLiveUpdateJournal(storage: StorageContext, input: LiveUpdateJournalCommitInput, activation?: ServiceActivationAccess): RelayLiveUpdateJournalResult {
    requireLiveJournalHistory(storage);
    const outer = journalRecord(input, ["host", "actor", "expectedAuthority", "metadata", "cutToken", "validation", "updateBytes", "receivedAtMs"], ["trustedAccount", "trustedAutomation", "trustedAutomationPress", "trustedAutomationGrant"]);
    const trustedAccount = outer.trustedAccount === undefined ? undefined : baselineRecord(outer.trustedAccount, ["accountId", "name"]) as {accountId:string;name:string};
    const trustedAutomation = outer.trustedAutomation === undefined ? undefined : parseAutomationDeclaration(outer.trustedAutomation);
    const trustedAutomationPress = outer.trustedAutomationPress === undefined ? undefined : {
      hostPressId: parseLiveUpdateIdentifier(baselineRecord(outer.trustedAutomationPress, ["hostPressId", "automationId"]).hostPressId),
      automationId: parseLiveUpdateIdentifier(baselineRecord(outer.trustedAutomationPress, ["hostPressId", "automationId"]).automationId),
    };
    const trustedAutomationGrant = outer.trustedAutomationGrant === undefined ? undefined : (() => {
      const grant = baselineRecord(outer.trustedAutomationGrant, ["grantId", "grantGeneration"]);
      return {grantId: parseLiveUpdateIdentifier(grant.grantId), grantGeneration: authorityInteger(grant.grantGeneration, 1)};
    })();
    const host = snapshotHostCoordinate(outer.host);
    const rawMetadata = journalRecord(outer.metadata, ["deliveryId", "updateDigest", "binding"], ["authorContext"]);
    const metadata = parseLiveUpdateSubmissionMetadata({ ...rawMetadata, binding: journalBinding(rawMetadata.binding) });
    const document = journalDocument({ workspaceId: metadata.binding.workspaceId, mainVersionId: metadata.binding.mainVersionId,
      objectId: metadata.binding.objectId, lineageClaimId: metadata.binding.lineageClaimId });
    const expectedAuthority = parseServerDerivedLiveUpdateAuthority(baselineRecord(outer.expectedAuthority,
      ["principalKind", "principalId", "grantId", "grantGeneration"]));
    const actorKind = baselineRecord(outer.actor, ["kind"], true).kind;
    if (actorKind !== "owner" && actorKind !== "named" && actorKind !== "link") return { result: { kind: "refused", reason: "authority-refused" }, admitted: null };
    const request = snapshotCurrentBindingRequest({ document, actor: outer.actor as CurrentLiveBindingRequest["actor"] });
    if (trustedAutomation && actorKind !== "owner") return {result: {kind: "refused", reason: "authority-refused"}, admitted: null};
    if (trustedAutomationPress && (!trustedAutomation || actorKind !== "owner")) return {result: {kind: "refused", reason: "authority-refused"}, admitted: null};
    if (trustedAutomationGrant && (!trustedAutomation || actorKind !== "owner" || trustedAutomationPress)) return {result: {kind: "refused", reason: "authority-refused"}, admitted: null};
    const { token, issued } = captureJournalCut(storage, outer.cutToken);
    const updateBytes = journalBytes(outer.updateBytes), receivedAtMs = authorityInteger(outer.receivedAtMs);
    if (createHash("sha256").update(updateBytes).digest("hex") !== metadata.updateDigest) return { result: { kind: "refused", reason: "invalid-update" }, admitted: null };
    const anticipatedCheckpoint = liveJournalCheckpointDue(token.suffixCount + 1, token.suffixBytes + updateBytes.byteLength);
    const validation = snapshotJournalValidation(outer.validation, anticipatedCheckpoint);
    const seedSource = liveJournalSeedSource(storage,document);
    const seedId = liveJournalSeedClient(document,seedSource);
    if (validation.kind === "accepted") {
      const evidence = validation.evidence;
      if (evidence.candidate.updateDigest !== metadata.updateDigest || !isDeepStrictEqual(evidence.document, token.document) ||
        evidence.currentPath !== token.currentPath || evidence.checkpointDigest !== token.checkpoint.digest ||
        !isDeepStrictEqual(evidence.suffixDigests, token.suffix.map(row => row.digest))) throw new Error("Journal validation does not match its owned cut.");
    }
    let firstWriteAttempted = false;
    const refused = (result: Exclude<RelayLiveUpdateJournalResult["result"], { kind: "accepted" }>) => ({ reply: { result, admitted: null } as RelayLiveUpdateJournalResult });
    let committed: { reply: RelayLiveUpdateJournalResult; row?: DecodedJournalRow; history?: StoredLiveDocumentAuthority[]; advancedCut?: LiveUpdateJournalCut };
    try {
      committed = storage.tx(() => {
        requireLiveJournalHistory(storage);
        const namespace = liveJournalHistoryNamespace(storage);
        const currentHost = journalHost(storage.db, host);
        if ("kind" in currentHost) return refused(currentHost);
        const history = journalAuthorityHistory(storage, document);
        if (!history.length) return refused({ kind: "refused", reason: "baseline-missing" });
        const stored = history.find(row => row.current) ?? null;
        if (!stored || !stored.open) return refused({ kind: "refused", reason: "authority-refused" });
        const current = authorizeLiveDocument(storage, request, currentHost, stored, activation);
        if (current.kind !== "current") return refused({ kind: "refused", reason: current.reason === "stale-document" || current.reason === "stale-selector" ? "stale-binding" : "authority-refused" });
        if (current.binding.restoreFenceGeneration !== metadata.binding.restoreFenceGeneration) return refused({ kind: "refused", reason: "restore-fenced" });
        if (!isDeepStrictEqual(current.binding, metadata.binding)) return refused({ kind: "refused", reason: "stale-binding" });
        if (!isDeepStrictEqual(current.authority, expectedAuthority)) return refused({ kind: "refused", reason: "authority-refused" });
        if (!allowsServiceActivationCandidate(storage, request, host, current.binding, metadata.updateDigest, metadata.deliveryId, activation)) {
          return refused({kind: "refused", reason: "authority-refused"});
        }
        const replayRaw = storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE delivery_id=?`).get(metadata.deliveryId);
        if (replayRaw) {
          const row = decodeJournalRow(storage.db, replayRaw); assertJournalCheckpointPosition(storage.db, row);
          journalIntegrity(row.history.namespace === namespace);
          verifyJournalHistoryRow(storage.db, row);
          const previous = row.admitted.metadata.accepted;
          if (previous.receipt.updateDigest !== metadata.updateDigest || !isDeepStrictEqual(previous.binding, current.binding) ||
            !isDeepStrictEqual(previous.authority, current.authority) ||
            (trustedAutomation ? !isDeepStrictEqual(row.admitted.metadata.authorSnapshot, [{kind: "automation", ...trustedAutomation}]) : row.admitted.metadata.authorSnapshot?.some(author => author.kind === "automation")) ||
            replayRaw.author_context_json !== (metadata.authorContext === undefined ? null : JSON.stringify(metadata.authorContext))) return refused({ kind: "refused", reason: "delivery-conflict" });
          liveJournalCoverageWithin(storage, document, [...row.admitted.metadata.firstSeen, ...journalRanges(JSON.parse(String(replayRaw.seed_first_seen_json)))]);
          return { reply: { result: { kind: "accepted" as const, receipt: { ...previous.receipt }, replayed: true }, admitted: row.admitted }, row, history };
        }
        if (trustedAutomationPress && (request.actor.kind !== "owner" || !automationPressAdmissionAllowed(storage, {
          workspaceId: document.workspaceId, ownerUserId: request.actor.userId,
          currentPath: current.binding.currentPath,
          hostPressId: trustedAutomationPress.hostPressId, automationId: trustedAutomationPress.automationId, declaration: trustedAutomation!,
        }))) return refused({kind: "refused", reason: "authority-refused"});
        if (trustedAutomation?.attribution.onBehalfOf !== undefined && request.actor.kind === "owner" &&
          trustedAutomation.attribution.onBehalfOf !== request.actor.userId && !trustedAutomationPress && !trustedAutomationGrant) {
          return refused({kind: "refused", reason: "authority-refused"});
        }
        if (trustedAutomationGrant && (request.actor.kind !== "owner" || !automationGrantAdmissionAllowed(storage, {
          workspaceId: document.workspaceId, ownerUserId: request.actor.userId, currentPath: current.binding.currentPath,
          ...trustedAutomationGrant, declaration: trustedAutomation!,
        }))) return refused({kind: "refused", reason: "authority-refused"});
        // BEGIN IMMEDIATE excludes competing writers after this revision check.
        const read = issued?.current() && isDeepStrictEqual(token.document, document) ? { kind: "cut" as const, cut: token }
          : readJournalCut(storage, document, token);
        if (read.kind !== "cut") return refused({ kind: "refused", reason: read.reason });
        if (read.cut.highWater !== token.highWater) {
          journalIntegrity(read.cut.highWater !== null && (token.highWater === null || read.cut.highWater > token.highWater));
          return { ...refused({ kind: "retry", reason: "admission-unavailable" }), advancedCut: read.cut };
        }
        journalIntegrity(isDeepStrictEqual(read.cut, token));
        if (validation.kind === "refused") return refused(journalValidationRefusal(validation));
        const coverage = liveJournalCoverageWithin(storage, document, validation.evidence.candidate.ranges);
        requireRestoreSourceCoverage(storage, document, namespace, validation.evidence.candidate.ranges, validation.evidence.checkpointRanges, coverage);
        const allFirstSeen = validation.evidence.candidate.firstSeen;
        journalIntegrity(subtractJournalRanges(allFirstSeen, validation.evidence.candidate.ranges).length === 0);
        if (!isDeepStrictEqual(subtractJournalRanges(allFirstSeen, coverage), allFirstSeen)) {
          return refused({kind:"refused",reason:"provenance-refused"});
        }
        let authorSnapshot: LiveAuthorSnapshot = trustedAutomation ? [{kind: "automation", ...trustedAutomation}] : deriveLiveAuthorSnapshot(storage, current.authority, metadata.authorContext, trustedAccount);
        journalIntegrity(isDeepStrictEqual(seedSource,liveJournalSeedSource(storage,document)));
        const seedFirstSeen = allFirstSeen.filter(range => range.clientId === seedId);
        const firstSeen = allFirstSeen.filter(range => range.clientId !== seedId);
        const firstSeenDeletes = validation.evidence.candidate.firstSeenDeletes;
        const clients = [...new Set(firstSeen.map(range => range.clientId))];
        const bindings: {clientId:number; snapshot:string}[] = [];
        if (authorSnapshot.length && clients.length) {
          const encoded = JSON.stringify(authorSnapshot);
          const identities = authorSnapshot.map(liveAuthorIdentity);
          let unbound = 0, bindingFailed = false;
          for (const clientId of clients) {
            const prior = storage.db.prepare(`SELECT author_snapshot_json FROM ${LIVE_AUTHOR_CLIENTS} WHERE ${JOURNAL_DOCUMENT_WHERE} AND client_id=?`).get(...documentParams(document), clientId);
            if (prior) {
              const storedSnapshot = parseLiveAuthorSnapshot(JSON.parse(String(prior.author_snapshot_json)));
              if (!isDeepStrictEqual(storedSnapshot.map(liveAuthorIdentity), identities)) bindingFailed = true;
              authorSnapshot = storedSnapshot;
            }
            if (!prior) {unbound++; bindings.push({clientId,snapshot:encoded});}
          }
          if (bindingFailed || unbound > 1) {
            if (request.actor.kind !== "owner" || trustedAutomation) return refused({kind:"refused",reason:"provenance-refused"});
            authorSnapshot = [];
            bindings.length = 0;
          }
        }
        authorSnapshot = limitLiveDeclaredAgents(read.cut.suffix.map(row => row.metadata), current.authority, authorSnapshot);
        const window = assessLiveAuthorWindow(read.cut.suffix.map(row => row.metadata), {authorSnapshot,firstSeen,firstSeenDeletes});
        if (window.refused) return refused({kind:"refused",reason:"capacity-refused"});
        const due = anticipatedCheckpoint || window.checkpointDue;
        if (due && !validation.evidence.stateUpdate) throw new Error("Author checkpoint state was not captured.");
        const checkpointBytes = due ? validation.evidence.stateUpdate! : null;
        const checkpointDigest = due ? validation.evidence.stateUpdateSha256 : null;
        const admitted = appendValidatedLiveJournal(storage, {document,namespace,host,current,metadata,updateBytes,receivedAtMs,
          firstSeen,firstSeenDeletes,authorSnapshot,seedFirstSeen,authorContext:metadata.authorContext,
          ...(due ? {checkpointCoverage:window.coverage} : {}),checkpointBytes,checkpointDigest,priorMetadata: read.cut.suffix.at(-1)?.metadata ?? read.cut.checkpoint.metadata,
          onFirstWrite() {firstWriteAttempted = true;}});
        assertWorkspaceQuota(storage,document.workspaceId,144);
        storage.db.prepare(`INSERT INTO ${SETTLEMENT_CUTS}(journal_cursor,state_sha256,markdown_sha256,state_byte_length,markdown_byte_length) VALUES(?,?,?,?,?)`).run(
          admitted.metadata.accepted.receipt.journalCursor,validation.evidence.stateUpdateSha256,validation.evidence.projectedMarkdownSha256,
          validation.evidence.stateUpdateByteLength,validation.evidence.projectedMarkdownByteLength);
        for (const binding of bindings) {
          const storageBytes = Buffer.byteLength(JSON.stringify([...documentParams(document),binding.clientId,binding.snapshot]));
          assertWorkspaceQuota(storage,document.workspaceId,storageBytes);
          storage.db.prepare(`INSERT INTO ${LIVE_AUTHOR_CLIENTS}(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,author_snapshot_json,storage_bytes) VALUES (?,?,?,?,?,?,?)`).run(...documentParams(document),binding.clientId,binding.snapshot,storageBytes);
        }
        return {reply: {result: {kind: "accepted" as const, receipt: {...admitted.metadata.accepted.receipt}, replayed: false}, admitted}};
      });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      const errcode = typeof error === "object" && error !== null && "errcode" in error ? error.errcode : undefined;
      const busy = /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(code) ||
        (code === "ERR_SQLITE_ERROR" && typeof errcode === "number" && ((errcode & 255) === 5 || (errcode & 255) === 6));
      if (!firstWriteAttempted && busy) return { result: { kind: "retry", reason: "admission-unavailable" }, admitted: null };
      throw error;
    }
    if (committed.row) verifyJournalRow(committed.row);
    if (committed.advancedCut) verifyJournalCut(committed.advancedCut);
    if (committed.history) for (const authority of committed.history) journalDigest(authority.baselineBytes, authority.baselineDigest);
    return committed.reply;
  }

export function liveJournalCut(storage: StorageContext, document: LiveDocumentKey):
    | { kind: "cut"; cut: LiveUpdateJournalCut }
    | Exclude<LiveUpdateJournalCutResult, { kind: "cut" }> {
  return readJournalCut(storage, document);
}
function readJournalCut(storage: StorageContext, document: LiveDocumentKey, expected?: LiveUpdateJournalCut):
    | { kind: "cut"; cut: LiveUpdateJournalCut }
    | Exclude<LiveUpdateJournalCutResult, { kind: "cut" }> {
    const history = journalAuthorityHistory(storage, document);
    if (!history.length) return { kind: "refused", reason: "baseline-missing" };
    const stored = history.find(row => row.current);
    if (!stored || !stored.open) return { kind: "refused", reason: "authority-refused" };
    if (stored.binding.lineageClaimId !== document.lineageClaimId ||
      stored.baselineSequence <= storage.getEpochLogFloor(document.workspaceId) ||
      !currentLiveDocumentMoment(storage, document, stored.binding.currentPath)) return { kind: "refused", reason: "stale-binding" };
    const high = storage.db.prepare(`SELECT MAX(journal_cursor) AS cursor FROM ${LIVE_JOURNAL_TABLE} WHERE ${JOURNAL_DOCUMENT_WHERE}`).get(...documentParams(document))!;
    const highWater = high.cursor === null ? null : authorityInteger(high.cursor, 1);
    const checkpointRaw = storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${JOURNAL_DOCUMENT_WHERE}
      AND journal_cursor<=? AND validation_checkpoint_bytes IS NOT NULL ORDER BY journal_cursor DESC LIMIT 1`)
      .get(...documentParams(document), highWater ?? 0);
    let checkpoint: LiveUpdateJournalCut["checkpoint"] = { cursor: null, digest: stored.baselineDigest,
      bytes: new Uint8Array(stored.baselineBytes), metadata: null, updateBytes: null };
    if (checkpointRaw) {
      const row = decodeJournalRow(storage.db, checkpointRaw); assertJournalCheckpointPosition(storage.db, row);
      journalIntegrity(row.checkpoint);
      checkpoint = { cursor: row.admitted.metadata.accepted.receipt.journalCursor, digest: row.checkpoint.digest,
        bytes: row.checkpoint.bytes, metadata: row.admitted.metadata, updateBytes: row.admitted.updateBytes };
    }
    const rawSuffix = storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${JOURNAL_DOCUMENT_WHERE}
      AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT 4095`)
      .all(...documentParams(document), checkpoint.cursor ?? 0, highWater ?? 0);
    journalIntegrity(rawSuffix.length <= 4094);
    const provenance = new Map<number, Record<string, unknown>[]>();
    const suffixProvenance = storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_PROVENANCE} WHERE journal_cursor IN
      (SELECT journal_cursor FROM ${LIVE_JOURNAL_TABLE} WHERE ${JOURNAL_DOCUMENT_WHERE} AND journal_cursor>? AND journal_cursor<=?)
      ORDER BY journal_cursor,client_id,start_clock`).all(...documentParams(document), checkpoint.cursor ?? 0, highWater ?? 0);
    for (const row of suffixProvenance) {
      const cursor = authorityInteger(row.journal_cursor, 1), rows = provenance.get(cursor) ?? [];
      rows.push(row); provenance.set(cursor, rows);
    }
    let last = checkpoint.cursor ?? 0, suffixBytes = 0;
    let previousBinding: { raw: Record<string, unknown>; binding: LiveObjectBinding } | undefined;
    const matchingSuffix = expected?.highWater === highWater ? expected.suffix : undefined;
    if (matchingSuffix) journalIntegrity(matchingSuffix.length === rawSuffix.length);
    const snapshots = new Map<string, LiveAuthorSnapshot>();
    const suffix = rawSuffix.map((raw, index) => {
      if (matchingSuffix) {
        const entry = matchingSuffix[index]!;
        compareJournalSuffixRow(raw, entry, provenance.get(entry.cursor) ?? []);
        journalIntegrity(entry.cursor > last && entry.cursor <= (highWater ?? 0));
        last = entry.cursor; suffixBytes += entry.bytes.byteLength;
        return entry;
      }
      // Reuse validation only for identical SQLite values within this read.
      const prior = previousBinding;
      const binding = prior && raw.workspace_id === prior.raw.workspace_id && raw.main_version_id === prior.raw.main_version_id &&
        raw.object_id === prior.raw.object_id && raw.lineage_claim_id === prior.raw.lineage_claim_id &&
        raw.current_path === prior.raw.current_path && raw.selector_paths_json === prior.raw.selector_paths_json &&
        raw.restore_fence_generation === prior.raw.restore_fence_generation
        ? { ...prior.binding, selectorPaths: [...prior.binding.selectorPaths] } : journalBindingFromRow(raw);
      previousBinding = { raw, binding };
      const row = journalRowWithBinding(storage.db, raw, binding, provenance.get(authorityInteger(raw.journal_cursor, 1)) ?? [], snapshots), receipt = row.admitted.metadata.accepted.receipt;
      journalIntegrity(receipt.journalCursor > last && receipt.journalCursor <= (highWater ?? 0) && row.checkpoint === null &&
        row.admitted.metadata.checkpointCoverage === undefined);
      last = receipt.journalCursor; suffixBytes += row.admitted.updateBytes.byteLength;
      return { cursor: receipt.journalCursor, digest: receipt.updateDigest, bytes: row.admitted.updateBytes, metadata: row.admitted.metadata };
    });
    journalIntegrity(last === (highWater ?? 0) && suffixBytes < 20_971_520);
    const cut: LiveUpdateJournalCut = { authorityHistory: history.map(row => ({ ...row, baselineBytes: new Uint8Array(row.baselineBytes) })),
      document: { ...document }, currentPath: stored.binding.currentPath, restoreFenceGeneration: stored.binding.restoreFenceGeneration,
      baseline: { sequence: stored.baselineSequence, digest: stored.baselineDigest, bytes: new Uint8Array(stored.baselineBytes),
        ranges: stored.ranges, projectedDigest: stored.projectedDigest, projectedLength: stored.projectedLength,
        registeredAtMs: stored.registeredAtMs, replacesLineageClaimId: stored.replacesLineageClaimId },
      checkpoint, suffix, highWater, suffixCount: suffix.length, suffixBytes };
    return { kind: "cut", cut };
  }

const coverageStatements = new WeakMap<SqliteDb, {provenance: ReturnType<SqliteDb["prepare"]>; baseline: ReturnType<SqliteDb["prepare"]>}>();

function prepareCoverageStatements(db: SqliteDb) {
    let statements = coverageStatements.get(db);
    if (statements) return statements;
    const provenance = db.prepare(`SELECT p.*, j.workspace_id AS parent_workspace, j.main_version_id AS parent_version,
      j.object_id AS parent_object, j.lineage_claim_id AS parent_lineage FROM ${LIVE_JOURNAL_PROVENANCE} p
      LEFT JOIN ${LIVE_JOURNAL_TABLE} j ON j.journal_cursor=p.journal_cursor
      WHERE p.workspace_id=? AND p.main_version_id=? AND p.object_id=? AND p.lineage_claim_id=?
        AND p.client_id=? AND p.start_clock<=? AND p.start_clock>=COALESCE(
          (SELECT MAX(start_clock) FROM ${LIVE_JOURNAL_PROVENANCE} WHERE ${JOURNAL_DOCUMENT_WHERE} AND client_id=? AND start_clock<?), ?)
      ORDER BY p.start_clock`);
    const baseline = db.prepare(`SELECT client_id,start_clock,end_clock FROM sync_relay_live_document_baseline_ranges
      WHERE ${JOURNAL_DOCUMENT_WHERE} AND client_id=? AND start_clock<=? AND start_clock>=COALESCE(
        (SELECT MAX(start_clock) FROM sync_relay_live_document_baseline_ranges WHERE ${JOURNAL_DOCUMENT_WHERE} AND client_id=? AND start_clock<?), ?)
      ORDER BY start_clock`);
    statements = {provenance, baseline};
    coverageStatements.set(db, statements);
    return statements;
}

type JournalCoverageRange = LiveUpdateStructRange & {cursor: number | null};

export function journalCoverageRange(document: LiveDocumentKey, row: Record<string, unknown>): JournalCoverageRange {
    journalIntegrity(row.parent_workspace === document.workspaceId && row.parent_version === document.mainVersionId &&
      row.parent_object === document.objectId && row.parent_lineage === document.lineageClaimId);
    return {...parseLiveUpdateStructRange({clientId: row.client_id, startClock: row.start_clock, endClock: row.end_clock}),
      cursor: authorityInteger(row.journal_cursor, 1)};
}

export function assertJournalCoveragePair(a: JournalCoverageRange, b: JournalCoverageRange): void {
    journalIntegrity(a.clientId !== b.clientId || (a.endClock <= b.startClock && (a.endClock !== b.startClock || a.cursor !== b.cursor)));
}

export function liveJournalCoverageWithin(storage: StorageContext, document: LiveDocumentKey, windows: readonly LiveUpdateStructRange[]): LiveUpdateStructRange[] {
    if (windows.length === 0) return [];
    const {provenance, baseline} = prepareCoverageStatements(storage.db);
    const ranges = new Map<string, JournalCoverageRange>();
    for (const window of windows) {
      const params = [...documentParams(document), window.clientId, window.endClock,
        ...documentParams(document), window.clientId, window.startClock, window.startClock];
      for (const row of provenance.all(...params)) {
        const range = journalCoverageRange(document, row);
        ranges.set(`p:${range.clientId}:${range.startClock}`, range);
      }
      for (const row of baseline.all(...params)) {
        const range = parseLiveUpdateStructRange({ clientId: row.client_id, startClock: row.start_clock, endClock: row.end_clock });
        ranges.set(`b:${range.clientId}:${range.startClock}`, {...range, cursor: null});
      }
    }
    const combined = [...ranges.values()].sort((a,b) => a.clientId-b.clientId || a.startClock-b.startClock);
    for (let index = 1; index < combined.length; index++) {
      const a = combined[index-1]!, b = combined[index]!;
      assertJournalCoveragePair(a, b);
    }
    return combined.map(({ clientId, startClock, endClock }) => ({ clientId, startClock, endClock }));
  }

export function readCommittedLiveUpdate(storage: StorageContext, input: { host: LiveHostConnectionCoordinate; document: LiveDocumentKey; journalCursor: number }): CommittedLiveUpdateResult {
    const outer = baselineRecord(input, ["host", "document", "journalCursor"]);
    const host = snapshotHostCoordinate(outer.host), document = journalDocument(outer.document), cursor = authorityInteger(outer.journalCursor, 1);
    const result = storage.readTx(() => {
      const current = journalHost(storage.db, host);
      if ("kind" in current) return current;
      const raw = storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${JOURNAL_DOCUMENT_WHERE} AND journal_cursor=?`).get(...documentParams(document), cursor);
      if (!raw) return { kind: "missing" as const };
      const row = decodeJournalRow(storage.db, raw); assertJournalCheckpointPosition(storage.db, row);
      liveJournalCoverageWithin(storage, document, [...row.admitted.metadata.firstSeen, ...journalRanges(JSON.parse(String(raw.seed_first_seen_json)))]);
      return { kind: "committed" as const, row };
    });
    if (result.kind === "committed") { verifyJournalRow(result.row); return { kind: "committed", admitted: result.row.admitted }; }
    return result;
  }

function requireRestoreSourceCoverage(storage: StorageContext, document: LiveDocumentKey, namespace: string,
  candidate: readonly LiveUpdateStructRange[], checkpoint: readonly LiveUpdateStructRange[], accepted: readonly LiveUpdateStructRange[]): void {
  const checkpointOnly = subtractJournalRanges(checkpoint, accepted);
  const lookup = storage.db.prepare(`SELECT * FROM ${LIVE_RESTORE_SOURCE_RANGES} WHERE relay_database_namespace=?
    AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND client_id=?
    AND start_clock<=? AND end_clock>? ORDER BY end_clock DESC LIMIT 1`);
  let retained: {operationId: string; admission: ReturnType<typeof readRestoreAdmission>} | undefined;
  let checkpointIndex=0;
  // Both range lists are ordered by client and start clock.
  for (const next of candidate) {
    while (checkpointIndex<checkpointOnly.length && (checkpointOnly[checkpointIndex]!.clientId<next.clientId ||
      (checkpointOnly[checkpointIndex]!.clientId===next.clientId && checkpointOnly[checkpointIndex]!.endClock<=next.startClock))) checkpointIndex++;
    for (let index=checkpointIndex;index<checkpointOnly.length;index++) {
      const range=checkpointOnly[index]!;
      if (range.clientId>next.clientId || range.startClock>=next.endClock) break;
      let start = Math.max(next.startClock, range.startClock), end = Math.min(next.endClock, range.endClock);
      while (start < end) {
        const row = lookup.get(namespace, ...documentParams(document), range.clientId, start, start);
        journalIntegrity(row);
        const operationId = parseLiveUpdateIdentifier(row.operation_id);
        if (retained?.operationId !== operationId) retained = {operationId, admission: readRestoreAdmission(storage.db, namespace, operationId)};
        const admission = retained.admission;
        journalIntegrity(isDeepStrictEqual(documentParams(admission.admitted.accepted.binding), documentParams(document)) &&
          row.proposal_sha256 === admission.proposalDigest && admission.sourceRanges.some(source =>
            source.sourceOrdinal === row.source_ordinal && source.clientId === row.client_id && source.startClock === row.start_clock &&
            source.endClock === row.end_clock && source.sourceDigest === row.source_sha256));
        start = Math.min(end, authorityInteger(row.end_clock, 1));
      }
    }
  }
}
