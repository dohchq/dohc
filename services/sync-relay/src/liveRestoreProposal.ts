import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {parseLiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseAdmittedLiveUpdateMetadata, parseLiveUpdateDigest, parseLiveUpdateIdentifier,
  parseLiveUpdateReceipt, parseLiveUpdateStructRange} from "@dohc/live-session-contract/live-update-admission";
import {parseNativeRestoreFenceReceipt} from "./liveRestoreFence";
import {configRecord} from "./deviceLiveHostConfig";
import {authorityInteger} from "./storage/liveDocumentAuthority";

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
    for (const field of ["actorOriginId", "actorKind", "onBehalfOf"] as const) {
      if (origin[field] !== null) parseLiveUpdateIdentifier(origin[field]);
    }
    if (origin.chainDepth !== null) integer(origin.chainDepth);
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

/** Parses bounded host evidence. Storage and content checks still decide admission. */
export function parseNativeRestoreProposalReceipt(json: string, budget: RestoreProofBudget) {
  integer(budget.maxBytes, 1); integer(budget.maxEvents, 1);
  if (typeof json !== "string" || json.length > budget.maxBytes || Buffer.byteLength(json) > budget.maxBytes) {
    throw new TypeError("Native restore metadata exceeds its configured byte bound.");
  }
  const row = configRecord(JSON.parse(json), ["fence", "point", "candidateDigest", "frozenStateDigest", "pointStateDigest",
    "finalContentDigest", "beforeStateVector", "afterStateVector", "replacementRanges", "originEvidenceDigest",
    "acceptedSources", "nativeSources", "nativeSourceManifestDigest"]);
  const fence = parseNativeRestoreFenceReceipt(row.fence);
  const point = configRecord(row.point, ["journalCursor", "receiptDigest", "markdownDigest", "projectionDigest"]);
  const vector = (value: unknown) => array(value, budget.maxBytes, v => {const n = integer(v);require(n <= 255);return n;});
  const acceptedSources = array(row.acceptedSources, budget.maxEvents, parseAdmittedLiveUpdateMetadata);
  const nativeSources = array(row.nativeSources, budget.maxEvents - acceptedSources.length, nativeSource);
  const replacementRanges = array(row.replacementRanges, budget.maxBytes, parseLiveUpdateStructRange);
  require(replacementRanges.length > 0);
  for (let i = 0; i < replacementRanges.length; i++) {
    require(replacementRanges[i]!.startClock === 0 && (i === 0 || replacementRanges[i - 1]!.clientId < replacementRanges[i]!.clientId));
  }
  const manifestDigest = parseLiveUpdateDigest(row.nativeSourceManifestDigest);
  require(digest([row.fence, row.nativeSources]) === manifestDigest);
  const deliveries = new Map(acceptedSources.map(event => [event.accepted.receipt.deliveryId, event]));
  require(deliveries.size === acceptedSources.length);
  require(new Set(nativeSources.map(source => source.deliveryId)).size === nativeSources.length);
  for (let i = 0; i < nativeSources.length; i++) {
    const source = nativeSources[i]!, prior = nativeSources[i - 1];
    require(isDeepStrictEqual(source.binding, fence.operation.oldBinding));
    require(fence.operation.origin.kind === "owner" && source.source.adoptionId === fence.operation.origin.id &&
      source.source.nativeSequence <= fence.localHeadSequence);
    if (prior) require(prior.outboxId === source.outboxId && prior.outboxSequence < source.outboxSequence);
    const admitted = deliveries.get(source.deliveryId);
    require(isDeepStrictEqual(source.acceptedReceipt, admitted?.accepted.receipt ?? null));
    if (admitted) require(admitted.accepted.authority.principalKind === "owner" && admitted.accepted.receipt.updateDigest === source.updateDigest);
  }
  return {fence, point: {journalCursor: integer(point.journalCursor), receiptDigest: parseLiveUpdateDigest(point.receiptDigest),
    markdownDigest: parseLiveUpdateDigest(point.markdownDigest), projectionDigest: parseLiveUpdateDigest(point.projectionDigest)},
    candidateDigest: parseLiveUpdateDigest(row.candidateDigest), frozenStateDigest: parseLiveUpdateDigest(row.frozenStateDigest),
    pointStateDigest: parseLiveUpdateDigest(row.pointStateDigest), finalContentDigest: parseLiveUpdateDigest(row.finalContentDigest),
    beforeStateVector: vector(row.beforeStateVector), afterStateVector: vector(row.afterStateVector), replacementRanges,
    originEvidenceDigest: parseLiveUpdateDigest(row.originEvidenceDigest), acceptedSources, nativeSources,
    nativeSourceManifestDigest: manifestDigest};
}
export type NativeRestoreProposalReceipt = ReturnType<typeof parseNativeRestoreProposalReceipt>;
