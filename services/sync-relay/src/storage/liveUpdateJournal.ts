import {readRestoreAdmission,verifyRestoreCheckpoint} from "./liveRestoreCheckpoint";
import { liveJournalHistoryNamespace, requireLiveJournalHistory } from "./liveJournalHistory";
import { allowsServiceActivationCandidate, type ServiceActivationAccess } from "./serviceActivationAccess";
import {canonicalAcceptedMetadata, initialAcceptedHistoryDigest, nextAcceptedHistoryDigest} from "../liveAcceptedHistory";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, types as nodeTypes } from "node:util";
import { LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT, parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseLiveDocumentKey, parseLiveUpdateSubmissionMetadata, parseAdmittedLiveUpdateMetadata, parseLiveUpdateDigest, parseLiveUpdateIdentifier, parseLiveUpdateStructRange, parseServerDerivedLiveUpdateAuthority, type LiveDocumentKey, type LiveUpdateStructRange, type AdmittedLiveUpdate } from "@dohc/live-session-contract/live-update-admission";
import type { HostControlSnapshot } from "@dohc/live-session-contract/host-control";
import type { StorageContext } from "./context";
import type { SqliteDb, CurrentLiveBindingRequest, LiveHostConnectionCoordinate, LiveUpdateJournalCut, LiveUpdateJournalCutResult, LiveUpdateJournalCommitInput, RelayLiveUpdateJournalResult, CommittedLiveUpdateResult, LiveJournalValidation, StoredLiveDocumentAuthority } from "./types";
import { LiveJournalAdmittedCapacityError } from "./errors";
import {LIVE_RESTORE_SOURCE_RANGES} from "./liveRestoreOperationSchema";
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
function journalRanges(value: unknown): LiveUpdateStructRange[] {
  const ranges = journalArray(value, Number.MAX_SAFE_INTEGER, row => parseLiveUpdateStructRange(baselineRecord(row, ["clientId", "startClock", "endClock"])));
  for (let index = 1; index < ranges.length; index++) {
    const a = ranges[index - 1]!, b = ranges[index]!;
    if (a.clientId > b.clientId || (a.clientId === b.clientId && a.endClock >= b.startClock)) throw new TypeError("Noncanonical journal ranges.");
  }
  return ranges;
}
function journalBinding(value: unknown): LiveObjectBinding {
  const record = baselineRecord(value, ["workspaceId", "mainVersionId", "objectId", "lineageClaimId", "currentPath", "selectorPaths", "restoreFenceGeneration"]);
  const paths = journalArray(record.selectorPaths, LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT, value => {
    if (typeof value !== "string") throw new TypeError("Invalid journal selector.");
    return value;
  });
  return parseLiveObjectBinding({ ...record, selectorPaths: paths });
}
export function documentParams(document: LiveDocumentKey): [string, string, string, string] {
  return [document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId];
}
const JOURNAL_DOCUMENT_WHERE = "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
interface DecodedJournalRow {
  admitted: AdmittedLiveUpdate;
  checkpoint: { digest: string; bytes: Uint8Array } | null;
  restoreOperationId: string | null;
  history: {namespace: string; eventCount: number; evidenceDigest: string; metadataBytes: number};
}
export function decodeJournalMetadata(db: SqliteDb, raw: Record<string, unknown>, provenance?: Record<string, unknown>[]): AdmittedLiveUpdate["metadata"] {
  const binding = parseLiveObjectBinding({ workspaceId: raw.workspace_id, mainVersionId: raw.main_version_id,
    objectId: raw.object_id, lineageClaimId: raw.lineage_claim_id, currentPath: raw.current_path,
    selectorPaths: typeof raw.selector_paths_json === "string" ? JSON.parse(raw.selector_paths_json) : null,
    restoreFenceGeneration: raw.restore_fence_generation });
  journalIntegrity(binding.mainVersionId === "main" && binding.currentPath === raw.current_path &&
    JSON.stringify(binding.selectorPaths) === raw.selector_paths_json);
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
  return parseAdmittedLiveUpdateMetadata({ accepted: {
    receipt: { deliveryId: raw.delivery_id, updateDigest: raw.update_digest, journalCursor: cursor, acceptingHostEpoch: raw.accepting_host_epoch },
    binding, authority: { principalKind: raw.principal_kind, principalId: raw.principal_id, grantId: raw.grant_id, grantGeneration: raw.grant_generation },
    receivedAtMs: raw.received_at_ms,
  }, firstSeen });
}
export function decodeJournalRow(db: SqliteDb, raw: Record<string, unknown>, provenance?: Record<string, unknown>[]): DecodedJournalRow {
  const metadata=decodeJournalMetadata(db,raw,provenance);
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
  journalIntegrity(history.metadataBytes === Buffer.byteLength(JSON.stringify(canonicalAcceptedMetadata(metadata))));
  const predecessor = db.prepare(`SELECT relay_database_namespace,accepted_event_count,accepted_evidence_digest FROM ${LIVE_JOURNAL_TABLE}
    WHERE ${JOURNAL_DOCUMENT_WHERE} AND journal_cursor<? ORDER BY journal_cursor DESC LIMIT 1`).get(...documentParams(binding), receipt.journalCursor);
  if (predecessor) journalIntegrity(predecessor.relay_database_namespace === history.namespace);
  const previousCount = predecessor ? authorityInteger(predecessor.accepted_event_count, 1) : 0;
  const previousDigest = predecessor ? parseLiveUpdateDigest(predecessor.accepted_evidence_digest) : initialAcceptedHistoryDigest(history.namespace, binding);
  journalIntegrity(previousCount < Number.MAX_SAFE_INTEGER && history.eventCount === previousCount + 1 &&
    history.evidenceDigest === nextAcceptedHistoryDigest(previousDigest, history.eventCount, metadata));
}
export function assertJournalCheckpointPosition(db: SqliteDb, row: {admitted: {metadata: AdmittedLiveUpdate["metadata"]}; checkpoint: {digest: string} | null;
  restoreOperationId: string | null; history: {namespace: string}}, budget?:{bytes:number;chargeBytes(value:number):void}): { count: number; bytes: number } {
  const restored = verifyRestoreCheckpoint(db, row,budget?.bytes,budget?value=>budget.chargeBytes(value):undefined);
  const { binding, receipt } = row.admitted.metadata.accepted;
  const predecessor=db.prepare(`SELECT current_path,restore_fence_generation FROM ${LIVE_JOURNAL_TABLE} WHERE ${JOURNAL_DOCUMENT_WHERE} AND journal_cursor<? ORDER BY journal_cursor DESC LIMIT 1`).get(...documentParams(binding),receipt.journalCursor);
  if (predecessor) journalIntegrity(predecessor.current_path===binding.currentPath && (restored
    ? predecessor.restore_fence_generation===restored.preparation.fence.operation.oldBinding.restoreFenceGeneration
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
    const due = index + 1 === 4095 || bytes >= 20_971_520;
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
  const evidence = baselineRecord(accepted.evidence, ["version", "document", "currentPath", "checkpointDigest", "checkpointRanges", "suffixDigests",
    "candidate", "stateUpdateSha256", "stateUpdateByteLength", ...(checkpointDue ? ["stateUpdate"] : [])], true);
  if (evidence.version !== 1 || typeof evidence.currentPath !== "string") throw new TypeError("Unknown journal evidence.");
  const candidate = baselineRecord(evidence.candidate, ["updateDigest", "ranges"]);
  const stateUpdateSha256 = parseLiveUpdateDigest(evidence.stateUpdateSha256);
  const stateUpdateByteLength = authorityInteger(evidence.stateUpdateByteLength, 1);
  if (stateUpdateByteLength > 20_971_520) throw new TypeError("Journal state length exceeds the existing bound.");
  const stateUpdate = checkpointDue ? journalBytes(evidence.stateUpdate) : undefined;
  if (stateUpdate) {
    if (stateUpdate.byteLength !== stateUpdateByteLength) throw new TypeError("Journal state length mismatch.");
    journalDigest(stateUpdate, stateUpdateSha256);
  }
  return { kind: "accepted", evidence: { version: 1, document: journalDocument(evidence.document), currentPath: evidence.currentPath,
    checkpointDigest: parseLiveUpdateDigest(evidence.checkpointDigest), checkpointRanges: journalRanges(evidence.checkpointRanges), suffixDigests: journalArray(evidence.suffixDigests, 4094, parseLiveUpdateDigest),
    candidate: { updateDigest: parseLiveUpdateDigest(candidate.updateDigest), ranges: journalRanges(candidate.ranges) },
    ...(stateUpdate ? { stateUpdate } : {}), stateUpdateSha256, stateUpdateByteLength } };
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


export function readLiveUpdateJournalCut(storage: StorageContext, input: { document: LiveDocumentKey }): LiveUpdateJournalCutResult {
    const outer = baselineRecord(input, ["document"]), document = journalDocument(outer.document);
    const result = storage.readTx(() => liveJournalCut(storage, document));
    if (result.kind === "cut") {
      verifyJournalCut(result.cut);
      return { kind: "cut", cut: result.cut };
    }
    return result;
  }

/** Internal insertion only. Each caller must revalidate its admission capture in this transaction. */
export function appendValidatedLiveJournal(storage: StorageContext, input: {
  document: LiveDocumentKey; namespace: string; host: LiveHostConnectionCoordinate;
  current: {binding: LiveObjectBinding; authority: AdmittedLiveUpdate["metadata"]["accepted"]["authority"]};
  metadata: {deliveryId: string; updateDigest: string}; updateBytes: Uint8Array; receivedAtMs: number;
  restoreOperationId?: string;
  firstSeen: AdmittedLiveUpdate["metadata"]["firstSeen"]; checkpointBytes: Uint8Array | null; checkpointDigest: string | null;
  priorMetadata: AdmittedLiveUpdate["metadata"] | null | undefined; onFirstWrite?: () => void;
}): AdmittedLiveUpdate {
  const {document,namespace,host,current,metadata,updateBytes,receivedAtMs,firstSeen,checkpointBytes,checkpointDigest,priorMetadata,onFirstWrite}=input;
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
    acceptingHostEpoch: host.hostEpoch}, binding: current.binding, authority: current.authority, receivedAtMs}, firstSeen};
  const evidenceDigest = nextAcceptedHistoryDigest(previousDigest, eventCount, intended);
  const acceptedMetadataBytes = Buffer.byteLength(JSON.stringify(canonicalAcceptedMetadata(intended)));
  const values = [metadata.deliveryId, metadata.updateDigest, ...documentParams(document),
    current.binding.currentPath, JSON.stringify(current.binding.selectorPaths), current.binding.restoreFenceGeneration,
    current.authority.principalKind, current.authority.principalId, current.authority.grantId, current.authority.grantGeneration,
    host.hostEpoch, receivedAtMs];
  // Logical stored values, as with delivery reservations; excludes SQLite pages and indexes.
  const metadataBytes = Buffer.byteLength(JSON.stringify([nextCursor, ...values, checkpointDigest, namespace, eventCount, evidenceDigest, acceptedMetadataBytes,restoreOperationId]));
  const provenanceBytes = firstSeen.reduce((total, range) => total + Buffer.byteLength(JSON.stringify([
    ...documentParams(document), range.clientId, range.startClock, range.endClock, nextCursor,
  ])), 0);
  const charge = updateBytes.byteLength + (checkpointBytes?.byteLength ?? 0) + metadataBytes + provenanceBytes;
  assertWorkspaceQuota(storage, document.workspaceId, charge);
  onFirstWrite?.();
  const insert = storage.db.prepare(`INSERT INTO ${LIVE_JOURNAL_TABLE}(delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,
    current_path,selector_paths_json,restore_fence_generation,principal_kind,principal_id,grant_id,grant_generation,
    accepting_host_epoch,received_at_ms,update_bytes,validation_checkpoint_sha256,validation_checkpoint_bytes,
    relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes,restore_operation_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values, updateBytes, checkpointDigest, checkpointBytes, namespace, eventCount, evidenceDigest, acceptedMetadataBytes,restoreOperationId);
  const cursor = authorityInteger(typeof insert.lastInsertRowid === "bigint" ? Number(insert.lastInsertRowid) : insert.lastInsertRowid, 1);
  journalIntegrity(cursor === nextCursor);
  const insertRange = storage.db.prepare(`INSERT INTO ${LIVE_JOURNAL_PROVENANCE}(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock,end_clock,journal_cursor) VALUES (?,?,?,?,?,?,?,?)`);
  for (const range of firstSeen) insertRange.run(...documentParams(document), range.clientId, range.startClock, range.endClock, cursor);
  const raw = storage.db.prepare(`SELECT journal_cursor,delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,
    current_path,selector_paths_json,restore_fence_generation,principal_kind,principal_id,grant_id,grant_generation,accepting_host_epoch,received_at_ms,
    validation_checkpoint_sha256,length(update_bytes) AS update_length,length(validation_checkpoint_bytes) AS checkpoint_length
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
    const outer = baselineRecord(input, ["host", "actor", "expectedAuthority", "metadata", "cutToken", "validation", "updateBytes", "receivedAtMs"]);
    const host = snapshotHostCoordinate(outer.host);
    const rawMetadata = baselineRecord(outer.metadata, ["deliveryId", "updateDigest", "binding"]);
    const metadata = parseLiveUpdateSubmissionMetadata({ ...rawMetadata, binding: journalBinding(rawMetadata.binding) });
    const document = journalDocument({ workspaceId: metadata.binding.workspaceId, mainVersionId: metadata.binding.mainVersionId,
      objectId: metadata.binding.objectId, lineageClaimId: metadata.binding.lineageClaimId });
    const expectedAuthority = parseServerDerivedLiveUpdateAuthority(baselineRecord(outer.expectedAuthority,
      ["principalKind", "principalId", "grantId", "grantGeneration"]));
    const actorKind = baselineRecord(outer.actor, ["kind"], true).kind;
    if (actorKind !== "owner" && actorKind !== "named" && actorKind !== "link") return { result: { kind: "refused", reason: "authority-refused" }, admitted: null };
    const request = snapshotCurrentBindingRequest({ document, actor: outer.actor as CurrentLiveBindingRequest["actor"] });
    const token = copyJournalData(outer.cutToken) as LiveUpdateJournalCut;
    verifyJournalCut(token);
    const updateBytes = journalBytes(outer.updateBytes), receivedAtMs = authorityInteger(outer.receivedAtMs);
    if (createHash("sha256").update(updateBytes).digest("hex") !== metadata.updateDigest) return { result: { kind: "refused", reason: "invalid-update" }, admitted: null };
    const anticipatedCheckpoint = token.suffixCount + 1 === 4095 || token.suffixBytes + updateBytes.byteLength >= 20_971_520;
    const validation = snapshotJournalValidation(outer.validation, anticipatedCheckpoint);
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
            !isDeepStrictEqual(previous.authority, current.authority)) return refused({ kind: "refused", reason: "delivery-conflict" });
          liveJournalCoverage(storage, document, stored.ranges);
          return { reply: { result: { kind: "accepted" as const, receipt: { ...previous.receipt }, replayed: true }, admitted: row.admitted }, row, history };
        }
        const read = liveJournalCut(storage, document);
        if (read.kind !== "cut") return refused({ kind: "refused", reason: read.reason });
        if (read.cut.highWater !== token.highWater) {
          journalIntegrity(read.cut.highWater !== null && (token.highWater === null || read.cut.highWater > token.highWater));
          return { ...refused({ kind: "retry", reason: "admission-unavailable" }), advancedCut: read.cut };
        }
        journalIntegrity(isDeepStrictEqual(read.cut, token));
        if (validation.kind === "refused") return refused(journalValidationRefusal(validation));
        requireRestoreSourceCoverage(storage, document, namespace, validation.evidence.candidate.ranges, validation.evidence.checkpointRanges, read.coverage);
        const firstSeen = subtractJournalRanges(subtractJournalRanges(validation.evidence.candidate.ranges, validation.evidence.checkpointRanges), read.coverage);
        const due = read.cut.suffixCount + 1 === 4095 || read.cut.suffixBytes + updateBytes.byteLength >= 20_971_520;
        journalIntegrity(due === anticipatedCheckpoint);
        const checkpointBytes = due ? validation.evidence.stateUpdate! : null;
        const checkpointDigest = due ? validation.evidence.stateUpdateSha256 : null;
        const admitted = appendValidatedLiveJournal(storage, {document,namespace,host,current,metadata,updateBytes,receivedAtMs,
          firstSeen,checkpointBytes,checkpointDigest,priorMetadata: read.cut.suffix.at(-1)?.metadata ?? read.cut.checkpoint.metadata,
          onFirstWrite() {firstWriteAttempted = true;}});
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
    | { kind: "cut"; cut: LiveUpdateJournalCut; coverage: LiveUpdateStructRange[] }
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
    const suffix = rawSuffix.map(raw => {
      const row = decodeJournalRow(storage.db, raw, provenance.get(authorityInteger(raw.journal_cursor, 1)) ?? []), receipt = row.admitted.metadata.accepted.receipt;
      journalIntegrity(receipt.journalCursor > last && receipt.journalCursor <= (highWater ?? 0) && row.checkpoint === null);
      last = receipt.journalCursor; suffixBytes += row.admitted.updateBytes.byteLength;
      return { cursor: receipt.journalCursor, digest: receipt.updateDigest, bytes: row.admitted.updateBytes, metadata: row.admitted.metadata };
    });
    journalIntegrity(last === (highWater ?? 0) && suffixBytes < 20_971_520);
    const coverage = liveJournalCoverage(storage, document, stored.ranges);
    const cut: LiveUpdateJournalCut = { authorityHistory: history.map(row => ({ ...row, baselineBytes: new Uint8Array(row.baselineBytes) })),
      document: { ...document }, currentPath: stored.binding.currentPath, restoreFenceGeneration: stored.binding.restoreFenceGeneration,
      baseline: { sequence: stored.baselineSequence, digest: stored.baselineDigest, bytes: new Uint8Array(stored.baselineBytes),
        ranges: stored.ranges, projectedDigest: stored.projectedDigest, projectedLength: stored.projectedLength,
        registeredAtMs: stored.registeredAtMs, replacesLineageClaimId: stored.replacesLineageClaimId },
      checkpoint, suffix, highWater, suffixCount: suffix.length, suffixBytes };
    return { kind: "cut", cut, coverage };
  }

export function liveJournalCoverage(storage: StorageContext, document: LiveDocumentKey, baseline: readonly LiveUpdateStructRange[]): LiveUpdateStructRange[] {
    const rows = storage.db.prepare(`SELECT p.*, j.workspace_id AS parent_workspace, j.main_version_id AS parent_version,
      j.object_id AS parent_object, j.lineage_claim_id AS parent_lineage FROM ${LIVE_JOURNAL_PROVENANCE} p
      LEFT JOIN ${LIVE_JOURNAL_TABLE} j ON j.journal_cursor=p.journal_cursor
      WHERE p.workspace_id=? AND p.main_version_id=? AND p.object_id=? AND p.lineage_claim_id=? ORDER BY p.client_id,p.start_clock`)
      .all(...documentParams(document));
    const ranges = rows.map(row => {
      journalIntegrity(row.parent_workspace === document.workspaceId && row.parent_version === document.mainVersionId &&
        row.parent_object === document.objectId && row.parent_lineage === document.lineageClaimId);
      return { ...parseLiveUpdateStructRange({ clientId: row.client_id, startClock: row.start_clock, endClock: row.end_clock }),
        cursor: authorityInteger(row.journal_cursor, 1) };
    });
    const combined = [...baseline.map(range => ({ ...range, cursor: null })), ...ranges].sort((a,b) => a.clientId-b.clientId || a.startClock-b.startClock);
    for (let index = 1; index < combined.length; index++) {
      const a = combined[index-1]!, b = combined[index]!;
      journalIntegrity(a.clientId !== b.clientId || (a.endClock <= b.startClock && (a.endClock !== b.startClock || a.cursor !== b.cursor)));
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
      const baseline = storage.db.prepare(`SELECT client_id,start_clock,end_clock FROM sync_relay_live_document_baseline_ranges
        WHERE ${JOURNAL_DOCUMENT_WHERE} ORDER BY client_id,start_clock`).all(...documentParams(document));
      const ranges = journalRanges(baseline.map(range => ({ clientId: range.client_id, startClock: range.start_clock, endClock: range.end_clock })));
      liveJournalCoverage(storage, document, ranges);
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
