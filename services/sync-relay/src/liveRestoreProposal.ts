import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {parseLiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseAdmittedLiveUpdateMetadata, parseLiveUpdateDigest, parseLiveUpdateIdentifier,
  parseLiveUpdateReceipt, parseLiveUpdateStructRange} from "@dohc/live-session-contract/live-update-admission";
import {parseNativeRestoreFenceReceipt} from "./liveRestoreFence";
import {configRecord} from "./deviceLiveHostConfig";
import {authorityInteger} from "./storage/liveDocumentAuthority";
import type {LiveRestoreProposalBytes} from "@dohc/ydoc-projection/restore-proof";
import {canonicalAcceptedMetadata, initialAcceptedHistoryDigest, nextAcceptedHistoryDigest} from "./liveAcceptedHistory";

export type RestoreProofBudget = {maxBytes: number; maxEvents: number};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const integer = (value: unknown, minimum = 0) => authorityInteger(value, minimum);
function require(condition: unknown): asserts condition {
  if (!condition) throw new Error("Native restore proposal is inconsistent.");
}
function array<T>(value: unknown, maximum: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError("Native restore array exceeds its configured bound.");
  return value.map(parse);
}
function nativeSource(value: unknown) {
  const row = configRecord(value, ["outboxId", "outboxSequence", "binding", "appendKey", "deliveryId", "updateDigest",
    "byteLength", "createdAtMs", "source", "acceptedReceipt"]);
  const source = configRecord(row.source, ["binding", "adoptionId", "nativeSequence", "updateDigest", "origin"]);
  const binding = parseLiveObjectBinding(row.binding), sourceBinding = parseLiveObjectBinding(source.binding);
  const origin = configRecord(source.origin, ["kind"], ["actorOriginId", "actorKind", "onBehalfOf", "chainDepth", "recordedAtMs"]);
  if (origin.kind === "adoptionSeed") configRecord(origin, ["kind"]);
  else {
    require(origin.kind === "nativeUpdate");
    configRecord(origin, ["kind", "actorOriginId", "actorKind", "onBehalfOf", "chainDepth", "recordedAtMs"]);
    for (const field of ["actorOriginId", "onBehalfOf"] as const) {
      if (origin[field] !== null) parseLiveUpdateIdentifier(origin[field]);
    }
    if (origin.actorKind !== null) require(origin.actorKind === "human" || origin.actorKind === "agent" || origin.actorKind === "automation");
    if (origin.chainDepth !== null) require(integer(origin.chainDepth) <= 64);
    integer(origin.recordedAtMs);
    require((origin.actorKind === null) === (origin.chainDepth === null));
    if (origin.actorKind === null) require(origin.onBehalfOf === null);
  }
  const updateDigest = parseLiveUpdateDigest(row.updateDigest), nativeSequence = integer(source.nativeSequence, origin.kind === "nativeUpdate" ? 1 : 0);
  const adoptionId = parseLiveUpdateIdentifier(source.adoptionId);
  require(isDeepStrictEqual(binding, sourceBinding) && isDeepStrictEqual(row.binding, binding) &&
    isDeepStrictEqual(source.binding, sourceBinding) && source.updateDigest === updateDigest);
  const expectedKey = origin.kind === "adoptionSeed" ? `owner-adoption:${digest([adoptionId, nativeSequence, updateDigest])}` : `adopted-local:${digest(source)}`;
  require(row.appendKey === expectedKey);
  require(row.outboxId === `owner-outbox-${textDigest(`${binding.workspaceId}\0${JSON.stringify(row.binding)}\0${binding.lineageClaimId}`)}`);
  require(row.deliveryId === `owner-delivery-${textDigest(`${row.outboxId}\0${row.outboxSequence}\0${updateDigest}`)}`);
  require(integer(row.byteLength, 1) <= 20_971_520);
  return {outboxId: parseLiveUpdateIdentifier(row.outboxId), outboxSequence: integer(row.outboxSequence, 1), binding,
    appendKey: expectedKey, deliveryId: parseLiveUpdateIdentifier(row.deliveryId), updateDigest,
    byteLength: integer(row.byteLength, 1), createdAtMs: integer(row.createdAtMs),
    source: {binding: sourceBinding, adoptionId, nativeSequence, updateDigest, origin},
    acceptedReceipt: row.acceptedReceipt === null ? null : parseLiveUpdateReceipt(row.acceptedReceipt)};
}

function historyProof(value: unknown, namespace: string, maximum: number) {
  const row = configRecord(value, ["checkpoint", "suffix", "eventCount", "terminal", "evidenceDigest"]);
  const c = configRecord(row.checkpoint, ["eventCount", "terminal", "binding", "stateDigest", "evidenceDigest"], ["restoreOperationId"]);
  const checkpoint = {eventCount: integer(c.eventCount), terminal: c.terminal === null ? null : parseLiveUpdateReceipt(c.terminal),
    binding: parseLiveObjectBinding(c.binding), stateDigest: parseLiveUpdateDigest(c.stateDigest), evidenceDigest: parseLiveUpdateDigest(c.evidenceDigest),
    ...(c.restoreOperationId === undefined ? {} : {restoreOperationId: parseLiveUpdateIdentifier(c.restoreOperationId)})};
  require((checkpoint.eventCount === 0) === (checkpoint.terminal === null));
  if (checkpoint.restoreOperationId !== undefined) require(checkpoint.eventCount > 0);
  if (checkpoint.eventCount === 0) require(checkpoint.evidenceDigest === initialAcceptedHistoryDigest(namespace, checkpoint.binding)
    && checkpoint.stateDigest === checkpoint.binding.lineageClaimId);
  const suffix = array(row.suffix, Math.min(maximum, 4094), value => canonicalAcceptedMetadata(parseAdmittedLiveUpdateMetadata(value)));
  let count = checkpoint.eventCount, evidence = checkpoint.evidenceDigest, terminal = checkpoint.terminal;
  for (const event of suffix) {
    const {binding, receipt} = event.accepted;
    require(binding.workspaceId === checkpoint.binding.workspaceId && binding.mainVersionId === checkpoint.binding.mainVersionId &&
      binding.objectId === checkpoint.binding.objectId && binding.lineageClaimId === checkpoint.binding.lineageClaimId);
    require(count < Number.MAX_SAFE_INTEGER && receipt.journalCursor > (terminal?.journalCursor ?? 0));
    evidence = nextAcceptedHistoryDigest(evidence, ++count, event); terminal = receipt;
  }
  require(integer(row.eventCount) === count && parseLiveUpdateDigest(row.evidenceDigest) === evidence);
  require(isDeepStrictEqual(row.terminal === null ? null : parseLiveUpdateReceipt(row.terminal), terminal));
  return {checkpoint, suffix, eventCount: count, terminal, evidenceDigest: evidence};
}
export type NativeRestoreHistoryProof = ReturnType<typeof historyProof>;

/** Parses bounded host evidence. Storage and content checks still decide admission. */
export function parseNativeRestoreProposalReceipt(json: string, budget: RestoreProofBudget) {
  integer(budget.maxBytes, 1); integer(budget.maxEvents, 1);
  if (typeof json !== "string" || json.length > budget.maxBytes || Buffer.byteLength(json) > budget.maxBytes) {
    throw new TypeError("Native restore metadata exceeds its configured byte bound.");
  }
  const row = configRecord(JSON.parse(json), ["fence", "point", "candidateDigest", "frozenStateDigest", "pointStateDigest",
    "finalContentDigest", "beforeStateVector", "afterStateVector", "replacementRanges", "originEvidenceDigest",
    "selectedHistory", "acceptedHistory", "nativeSources", "nativeSourceManifestDigest"]);
  const fence = parseNativeRestoreFenceReceipt(row.fence);
  const point = configRecord(row.point, ["journalCursor", "receiptDigest", "markdownDigest", "projectionDigest"]);
  const vector = (value: unknown) => array(value, budget.maxBytes, v => {const n = integer(v);require(n <= 255);return n;});
  const selectedHistory = historyProof(row.selectedHistory, fence.operation.relayDatabaseNamespace, budget.maxEvents);
  const acceptedHistory = historyProof(row.acceptedHistory, fence.operation.relayDatabaseNamespace, budget.maxEvents - selectedHistory.suffix.length);
  const nativeSources = array(row.nativeSources, budget.maxEvents - selectedHistory.suffix.length - acceptedHistory.suffix.length, nativeSource);
  const replacementRanges = array(row.replacementRanges, budget.maxBytes, parseLiveUpdateStructRange);
  require(replacementRanges.length > 0);
  for (let i = 0; i < replacementRanges.length; i++) {
    require(replacementRanges[i]!.startClock === 0 && (i === 0 || replacementRanges[i - 1]!.clientId < replacementRanges[i]!.clientId));
  }
  const manifestDigest = parseLiveUpdateDigest(row.nativeSourceManifestDigest);
  require(digest([row.fence, row.nativeSources]) === manifestDigest);
  require(new Set(nativeSources.map(source => source.deliveryId)).size === nativeSources.length);
  for (let i = 0; i < nativeSources.length; i++) {
    const source = nativeSources[i]!, prior = nativeSources[i - 1];
    require(isDeepStrictEqual(source.binding, fence.operation.oldBinding));
    require(fence.operation.origin.kind === "owner" && source.source.adoptionId === fence.operation.origin.id &&
      source.source.nativeSequence <= fence.localHeadSequence);
    if (prior) require(prior.outboxId === source.outboxId && prior.outboxSequence < source.outboxSequence);
    if (source.acceptedReceipt) require(source.acceptedReceipt.deliveryId === source.deliveryId && source.acceptedReceipt.updateDigest === source.updateDigest);
  }
  return {fence, point: {journalCursor: integer(point.journalCursor), receiptDigest: parseLiveUpdateDigest(point.receiptDigest),
    markdownDigest: parseLiveUpdateDigest(point.markdownDigest), projectionDigest: parseLiveUpdateDigest(point.projectionDigest)},
    candidateDigest: parseLiveUpdateDigest(row.candidateDigest), frozenStateDigest: parseLiveUpdateDigest(row.frozenStateDigest),
    pointStateDigest: parseLiveUpdateDigest(row.pointStateDigest), finalContentDigest: parseLiveUpdateDigest(row.finalContentDigest),
    beforeStateVector: vector(row.beforeStateVector), afterStateVector: vector(row.afterStateVector), replacementRanges,
    originEvidenceDigest: parseLiveUpdateDigest(row.originEvidenceDigest), selectedHistory, acceptedHistory, nativeSources,
    nativeSourceManifestDigest: manifestDigest};
}
export type NativeRestoreProposalReceipt = ReturnType<typeof parseNativeRestoreProposalReceipt>;

export function decodeNativeRestoreProposal(bytes: Uint8Array, budget: RestoreProofBudget) {
  integer(budget.maxBytes, 1);integer(budget.maxEvents, 1);
  if (!(bytes instanceof Uint8Array) || bytes.buffer instanceof SharedArrayBuffer || bytes.byteLength > budget.maxBytes) {
    throw new TypeError("Native restore binary exceeds its configured bound.");
  }
  const captured = new Uint8Array(bytes), view = new DataView(captured.buffer);
  let offset = 0;
  const field = () => {
    require(offset + 4 <= captured.byteLength);
    const length = view.getUint32(offset, true);offset += 4;
    require(length <= captured.byteLength - offset);
    const value = captured.subarray(offset, offset + length);offset += length;return value;
  };
  const receiptJson = new TextDecoder("utf-8", {fatal: true}).decode(field());
  const receipt = parseNativeRestoreProposalReceipt(receiptJson, budget);
  const candidateBytes = field(), frozenStateBytes = field(), pointStateBytes = field(), nativeSourceBytes: Uint8Array[] = [];
  for (let index = 0; index < receipt.nativeSources.length; index++) nativeSourceBytes.push(field());
  require(offset === captured.byteLength);
  return {receiptJson, receipt, bytes: {candidateBytes, frozenStateBytes, pointStateBytes, nativeSourceBytes}, captured};
}

export function encodeNativeRestoreProposal(receiptJson: string, input: LiveRestoreProposalBytes, budget: RestoreProofBudget): Uint8Array {
  const receipt = parseNativeRestoreProposalReceipt(receiptJson, budget);
  const nativeSourceBytes = input.nativeSourceBytes, count = receipt.nativeSources.length;
  require(Array.isArray(nativeSourceBytes) && nativeSourceBytes.length === count);
  const fields = [Buffer.from(receiptJson), input.candidateBytes, input.frozenStateBytes, input.pointStateBytes];
  for (let index = 0; index < count; index++) fields.push(nativeSourceBytes[index]!);
  let length = 0;
  for (const field of fields) {
    require(field instanceof Uint8Array && !(field.buffer instanceof SharedArrayBuffer) && field.byteLength <= 0xffff_ffff);
    length += 4 + field.byteLength;require(length <= budget.maxBytes);
  }
  const result = new Uint8Array(length), view = new DataView(result.buffer);let offset = 0;
  for (const field of fields) {view.setUint32(offset, field.byteLength, true);offset += 4;result.set(field, offset);offset += field.byteLength;}
  return result;
}
