import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {asRecord} from "@dohc/workspace-core";
import {parseLiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseHostControlIdentifier, parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {parseLiveUpdateDigest, parseLiveUpdateIdentifier, parseLiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";
import type {StorageContext} from "./context";
import type {SyncRelayLogInput} from "./types";
import {relayError} from "../errors";
import {initialAcceptedHistoryDigest} from "../liveAcceptedHistory";
import {LIVE_JOURNAL_TABLE} from "./schema";
import {LIVE_DELIVERY_OWNERS} from "./liveCommittedDeliverySchema";
import {LIVE_DELIVERY_OWNER_HISTORY, SERVICE_ACTIVATIONS} from "./serviceActivationSchema";
import type {ServiceActivationRetirement} from "./serviceActivationRetirement";
import {liveApplicationConfirmed, preparedLiveApplication} from "./liveApplicationAuthorship";
import {preparedSettlement, settlementCommitted, settlementProofCurrent} from "./hostedSettlement";

// The retirement writer: what a retiring document's host may still publish.
// Each row needs the proof its kind names below, against the activation the
// open obligation names, bounded by that obligation's F and by what the
// retiring owner acknowledged applying. Callers have already kept every file
// write to content at the bound path.

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
class Unproved extends Error {}
// A proof no push can finish: its push held no other proof to leave out.
class OverBudget extends Error {}
function require(value: unknown): asserts value {if (!value) throw new Unproved();}
// A valid row the retiring owner has not acknowledged applying yet: the push retries.
const notYetApplied = () => relayError("settlement_proof_budget", "the retiring owner has not applied this publication yet");
// An audit screened before its document began settling: the retried push proves it.
const notYetProved = () => relayError("settlement_proof_budget", "the settlement audit was screened before its document began settling");

/** Why the retirement writer refused a settling document's row. */
export type RetirementRefusal = "unproved-retirement-output" | "retirement-proof-over-budget";
export type RetirementBatch = {originId: string; ops: ReadonlyMap<number, SyncRelayLogInput>; batched: boolean};

/** Whether an op charges a push's proof budget. */
export function chargesProofBudget(op: SyncRelayLogInput): boolean {
  if (op.opKind === "live.audit.settlement" || op.opKind === "live.audit.application") return true;
  return op.opKind === "moment.append" && Object.hasOwn(asRecord(JSON.parse(op.payloadJson)) ?? {}, "settlementReference");
}

// The rows whose final admission waits for the writer's settlement or application confirmation.
const awaiting = new WeakSet<SyncRelayLogInput>();

/** Whether the writer confirmed what a retirement publication's admission waited on. */
export function retirementPublicationConfirmed(op: SyncRelayLogInput): boolean {
  if (!awaiting.has(op)) return true;
  return op.opKind === "moment.append" ? settlementCommitted(op) : liveApplicationConfirmed(op);
}

/**
 * Under the append's writer, before settlement and application confirmation:
 * null when `op` is verified output of the retiring activation, otherwise why
 * it is refused. Throws a retryable error for a valid row that waits on the
 * owner's applied tip, for an audit nothing proved yet, and for a proof whose
 * budget a smaller push may leave room for.
 */
export function admitRetirementPublication(storage: StorageContext, retirement: ServiceActivationRetirement, op: SyncRelayLogInput,
  batch: RetirementBatch): RetirementRefusal | null {
  awaiting.delete(op);
  try {
    admit(storage, retirement, op, batch);
    return null;
  } catch (error) {
    if (error instanceof Unproved) return "unproved-retirement-output";
    if (error instanceof OverBudget) return "retirement-proof-over-budget";
    throw error;
  }
}

function admit(storage: StorageContext, retirement: ServiceActivationRetirement, op: SyncRelayLogInput, batch: RetirementBatch): void {
  const exhausted = () => batch.batched ? relayError("settlement_proof_budget") : new OverBudget();
  const document = [retirement.workspaceId, "main", retirement.objectId, retirement.lineageClaimId] as const;
  const live = storage.db.prepare(`SELECT lineage_state,restore_fence_generation,baseline_digest,length(baseline_bytes) AS baseline_length
    FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`).get(...document);
  require(live?.lineage_state === "current" && live.restore_fence_generation === retirement.restoreFenceGeneration);
  const activation = storage.db.prepare(`SELECT source_json,state_digest FROM ${SERVICE_ACTIVATIONS}
    WHERE relay_database_namespace=? AND activation_id=? AND retired_at_ms IS NULL`).get(retirement.relayDatabaseNamespace, retirement.activationId);
  require(activation);
  const source = JSON.parse(String(activation.source_json)) as Record<string, unknown>;
  const tip = Number(storage.db.prepare(`SELECT COALESCE(MAX(tip_cursor),0) AS tip FROM ${LIVE_DELIVERY_OWNERS}
    WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?
      AND json_extract(origin_json,'$.adoptionId')=?`).get(retirement.relayDatabaseNamespace, ...document, retirement.activationId)!.tip);
  // A journal-backed row: at or below F, then at or below the owner's applied tip.
  const bounded = (cursor: number) => {
    require(cursor <= retirement.acceptedThrough);
    if (cursor > tip) throw notYetApplied();
  };
  const settlement = (proof: ReturnType<typeof preparedSettlement>) => {
    if (proof === "unattempted") throw notYetProved();
    if (proof === "exhausted") throw exhausted();
    require(proof && proof.namespace === retirement.relayDatabaseNamespace && proof.binding.workspaceId === retirement.workspaceId &&
      proof.binding.objectId === retirement.objectId && proof.binding.lineageClaimId === retirement.lineageClaimId &&
      proof.binding.currentPath === retirement.path && proof.binding.restoreFenceGeneration === retirement.restoreFenceGeneration &&
      settlementProofCurrent(storage, proof));
    bounded(proof.terminal);
  };
  const blobLength = (sha256: unknown) => storage.db.prepare("SELECT byte_length FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?")
    .get(retirement.workspaceId, String(sha256))?.byte_length;
  const payload = asRecord(JSON.parse(op.payloadJson));
  require(payload);
  switch (op.opKind) {
    case "ydoc.update": {
      require(payload.lineageClaimId === retirement.lineageClaimId);
      // The immutable baseline, the retained source state, or an exact accepted journal update.
      if (payload.isBaseState === true) {
        require(payload.updateBlobSha256 === retirement.lineageClaimId && live.baseline_digest === retirement.lineageClaimId &&
          blobLength(payload.updateBlobSha256) === live.baseline_length);
        return;
      }
      require(payload.isBaseState === false);
      if (payload.updateBlobSha256 === activation.state_digest && blobLength(payload.updateBlobSha256) === source.fullStateByteLength) return;
      const journal = storage.db.prepare(`SELECT MIN(journal_cursor) AS cursor FROM ${LIVE_JOURNAL_TABLE}
        WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND relay_database_namespace=? AND update_digest=?`)
        .get(...document, retirement.relayDatabaseNamespace, String(payload.updateBlobSha256));
      require(journal?.cursor !== null && journal?.cursor !== undefined);
      bounded(Number(journal.cursor));
      return;
    }
    case "moment.append": {
      if (Object.hasOwn(payload, "settlementReference")) {
        settlement(preparedSettlement(op));
        require(op.settlementAdmission?.status === "accepted");
        awaiting.add(op);
        return;
      }
      // The exact source moment the activation retained, as native writes it.
      // Its authors, author context and attribution mark prove no authorship here.
      require(op.settlementAdmission === undefined && NATIVE_MOMENT_FIELDS.every(field => Object.hasOwn(payload, field)) &&
        payload.momentId === source.sourceMomentId && payload.payloadAfterBlobSha256 === source.sourceDigest &&
        payload.payloadAfterByteLength === source.sourceByteLength && payload.payloadAfterContentKind === "text");
      op.admittedAuthorSnapshot = undefined;
      return;
    }
    case "live.audit.application": {
      require(payload.relayDatabaseNamespace === retirement.relayDatabaseNamespace && payload.lineageClaimId === retirement.lineageClaimId);
      const cursor = preparedLiveApplication(op);
      if (cursor === "exhausted") throw exhausted();
      require(cursor !== null);
      bounded(cursor);
      awaiting.add(op);
      return;
    }
    case "live.audit.settlement":
      settlement(preparedSettlement(op));
      return;
    case "live.audit.base":
      requireBaseRecord(storage, retirement, op, payload, Number(live.baseline_length), batch);
      return;
    default:
      throw new Unproved();
  }
}

// The `MomentAppendPayload` fields native deserialization requires. A source
// moment's before-image is the host's own prior file, which the relay holds
// nothing to check against.
export const NATIVE_MOMENT_FIELDS: readonly string[] = ["momentId", "versionId", "objectId", "path", "recordedAtMs", "operation", "payloadAfterBlobSha256",
  "payloadAfterPath", "metadata", "beforePresent"];

function ordered(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = asRecord(value);
  require(record && Object.keys(record).length === fields.length && fields.every(field => Object.hasOwn(record, field)));
  return Object.fromEntries(fields.map(field => [field, record[field]]));
}
// The native field orders its record digest and origin stamp serialize.
const BINDING = ["workspaceId", "mainVersionId", "objectId", "lineageClaimId", "currentPath", "selectorPaths", "restoreFenceGeneration"];
const RECEIPT = ["deliveryId", "updateDigest", "journalCursor", "acceptingHostEpoch"];
const HOST = ["hostId", "hostEpoch", "instanceId", "connectionId"];
const OWNER_SOURCE = ["adoptionId", "evidenceDigest", "sourceMomentId", "sourceDigest", "sourceByteLength", "baselineMomentRelaySequence",
  "baselineRegisteredAtMs", "coverageDigest", "coveredOutboxSequence", "localYDocSequence", "terminalCursor", "terminalReceipt",
  "hostCoordinate", "maxPendingBytes", "maxPendingAgeMs"];
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

const valid = (parse: () => unknown) => {
  try {parse(); return true;} catch {return false;}
};
const identifier = (value: unknown) => valid(() => parseLiveUpdateIdentifier(value));
const between = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/**
 * Native `OriginRecord::stamp` validation of an owner source (`origin_record.rs`).
 * The relay's owner row holds the adoption, evidence, source, baseline and
 * terminal fields, which the caller compares. The coverage digest and
 * sequence, host coordinate and pending budgets are host-attested: the relay
 * keeps nothing to compare them with, so only their shape is checked here.
 */
function requireOwnerSource(source: Record<string, unknown>): void {
  const host = source.hostCoordinate as Record<string, unknown>, receipt = source.terminalReceipt;
  require(identifier(source.adoptionId) && identifier(source.sourceMomentId) &&
    [host.hostId, host.instanceId, host.connectionId].every(value => valid(() => parseHostControlIdentifier(value))) &&
    valid(() => parseHostEpoch(host.hostEpoch)) &&
    [source.evidenceDigest, source.sourceDigest, source.coverageDigest].every(value => valid(() => parseLiveUpdateDigest(value))) &&
    [source.baselineMomentRelaySequence, source.baselineRegisteredAtMs, source.coveredOutboxSequence, source.localYDocSequence,
      source.terminalCursor].every(value => between(value, 0)) && between(source.sourceByteLength, 0, MAX_SOURCE_BYTES) &&
    between(source.maxPendingBytes, 1) && between(source.maxPendingAgeMs, 1) &&
    (receipt === null || valid(() => parseLiveUpdateReceipt(receipt))));
}

/**
 * A `live.audit.base` record: the canonical event-zero checkpoint of the
 * lineage, the root owner origin the relay kept and its stamp, the immutable
 * baseline's digest and length, and a real base Y.Doc coordinate.
 */
function requireBaseRecord(storage: StorageContext, retirement: ServiceActivationRetirement, op: SyncRelayLogInput, value: Record<string, unknown>,
  baselineLength: number, batch: RetirementBatch): void {
  const payload = ordered(value, ["formatVersion", "recordDigest", "record"]);
  const record = ordered(payload.record, ["relayDatabaseNamespace", "checkpoint", "originStamp", "origin", "baseByteLength", "baseCoordinate"]);
  const checkpoint = ordered(record.checkpoint, ["eventCount", "terminal", "binding", "stateDigest", "evidenceDigest"]);
  const origin = ordered(record.origin, ["kind", "source"]), source = ordered(origin.source, OWNER_SOURCE);
  checkpoint.binding = ordered(checkpoint.binding, BINDING);
  source.terminalReceipt = source.terminalReceipt === null ? null : ordered(source.terminalReceipt, RECEIPT);
  source.hostCoordinate = ordered(source.hostCoordinate, HOST);
  const coordinate = ordered(record.baseCoordinate, ["originId", "originSeq"]);
  Object.assign(record, {checkpoint, origin: {...origin, source}, baseCoordinate: coordinate});
  require(payload.formatVersion === 1 && payload.recordDigest === hash(JSON.stringify(record)));
  const document = {workspaceId: retirement.workspaceId, mainVersionId: "main", objectId: retirement.objectId, lineageClaimId: retirement.lineageClaimId};
  let binding;
  try {binding = parseLiveObjectBinding(checkpoint.binding);} catch {throw new Unproved();}
  requireOwnerSource(source);
  require(isDeepStrictEqual(binding, checkpoint.binding) &&
    record.relayDatabaseNamespace === retirement.relayDatabaseNamespace && checkpoint.eventCount === 0 && checkpoint.terminal === null &&
    checkpoint.stateDigest === retirement.lineageClaimId && record.baseByteLength === baselineLength &&
    checkpoint.evidenceDigest === initialAcceptedHistoryDigest(retirement.relayDatabaseNamespace, document) &&
    binding.workspaceId === document.workspaceId && binding.objectId === document.objectId && binding.lineageClaimId === document.lineageClaimId);
  // The root origin is the first activation of the released chain, whose owner row may be archived.
  const root = storage.db.prepare(`WITH RECURSIVE chain(id,predecessor) AS (
      SELECT activation_id,predecessor_activation_id FROM ${SERVICE_ACTIVATIONS} WHERE relay_database_namespace=? AND activation_id=?
      UNION ALL SELECT a.activation_id,a.predecessor_activation_id FROM ${SERVICE_ACTIVATIONS} a JOIN chain c
        ON a.relay_database_namespace=? AND a.activation_id=c.predecessor)
    SELECT id FROM chain WHERE predecessor IS NULL`).get(retirement.relayDatabaseNamespace, retirement.activationId, retirement.relayDatabaseNamespace);
  require(root);
  const kept = storage.db.prepare(`SELECT origin_json FROM ${LIVE_DELIVERY_OWNERS} WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id='main'
      AND object_id=? AND lineage_claim_id=? AND json_extract(origin_json,'$.adoptionId')=?
    UNION ALL SELECT origin_json FROM ${LIVE_DELIVERY_OWNER_HISTORY} WHERE relay_database_namespace=? AND activation_id=? LIMIT 1`)
    .get(retirement.relayDatabaseNamespace, document.workspaceId, document.objectId, document.lineageClaimId, root.id, retirement.relayDatabaseNamespace, root.id);
  require(kept);
  const owner = JSON.parse(String(kept.origin_json)) as Record<string, unknown>, terminal = source.terminalReceipt as Record<string, unknown> | null;
  let original;
  try {original = parseLiveObjectBinding(owner.originalBinding);} catch {throw new Unproved();}
  require(origin.kind === "owner" && source.adoptionId === root.id && source.evidenceDigest === owner.originEvidenceDigest &&
    source.sourceMomentId === owner.sourceMomentId && source.sourceDigest === owner.sourceDigest && source.sourceByteLength === owner.sourceByteLength &&
    source.baselineMomentRelaySequence === owner.baselineMomentRelaySequence && source.baselineRegisteredAtMs === owner.baselineRegisteredAtMs &&
    source.localYDocSequence === owner.expectedLocalSequence && isDeepStrictEqual(terminal, owner.terminalReceipt ?? null) &&
    source.terminalCursor === (terminal?.journalCursor ?? 0) && isDeepStrictEqual(binding, original));
  // The native stamp hashes SQLite's JSON array, with the binding, receipt and host coordinate as embedded JSON strings.
  const stamp = storage.db.prepare(`SELECT json_array(?,?,?,?,?,CAST(? AS INTEGER),CAST(? AS INTEGER),CAST(? AS INTEGER),?,CAST(? AS INTEGER),
      CAST(? AS INTEGER),CAST(? AS INTEGER),?,?,CAST(? AS INTEGER),CAST(? AS INTEGER)) AS stamp`)
    .get(...[source.adoptionId, source.evidenceDigest, JSON.stringify(checkpoint.binding), source.sourceMomentId, source.sourceDigest,
      source.sourceByteLength, source.baselineMomentRelaySequence, source.baselineRegisteredAtMs, source.coverageDigest, source.coveredOutboxSequence,
      source.localYDocSequence, source.terminalCursor, JSON.stringify(terminal), JSON.stringify(source.hostCoordinate), source.maxPendingBytes,
      source.maxPendingAgeMs].map(value => {
      require(typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)));
      return value;
    }))!;
  require(record.originStamp === hash(String(stamp.stamp)));
  // A real base coordinate: the lineage's base Y.Doc row, earlier in this push or already admitted.
  require(identifier(coordinate.originId) && typeof coordinate.originSeq === "number" && Number.isSafeInteger(coordinate.originSeq) &&
    coordinate.originSeq >= 0 && (coordinate.originId !== batch.originId || coordinate.originSeq < op.originSeq));
  const pending = coordinate.originId === batch.originId ? batch.ops.get(coordinate.originSeq) : undefined;
  const row = pending ?? storage.db.prepare(`SELECT op_kind AS opKind,payload_json AS payloadJson FROM sync_relay_log
    WHERE workspace_id=? AND origin_id=? AND origin_seq=?`).get(document.workspaceId, coordinate.originId, coordinate.originSeq);
  require(row?.opKind === "ydoc.update" && (!pending || pending.relayAdmission !== "refused"));
  const base = asRecord(JSON.parse(String(row.payloadJson)));
  require(base?.versionId === "main" && base.objectId === document.objectId && base.lineageClaimId === document.lineageClaimId &&
    base.updateBlobSha256 === document.lineageClaimId && base.contentKind === "richdoc" && base.isBaseState === true);
}
