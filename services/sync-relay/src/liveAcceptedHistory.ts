import {createHash} from "node:crypto";
import type {AdmittedLiveUpdateMetadata, LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import {parseLiveCheckpointCoverage} from "@dohc/live-session-contract/live-update-admission";
import {parseLiveAuthorSnapshot} from "@dohc/live-session-contract/live-authorship";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * The exact JSON the relay and the native engine hash. An absent agent
 * declaration has no member, so an undeclared event keeps its bytes.
 */
export function canonicalAcceptedMetadata(metadata: AdmittedLiveUpdateMetadata): AdmittedLiveUpdateMetadata {
  const {receipt: r, binding: b, authority: a, receivedAtMs} = metadata.accepted;
  return {accepted: {
    receipt: {deliveryId: r.deliveryId, updateDigest: r.updateDigest, journalCursor: r.journalCursor, acceptingHostEpoch: r.acceptingHostEpoch},
    binding: {workspaceId: b.workspaceId, mainVersionId: b.mainVersionId, objectId: b.objectId, lineageClaimId: b.lineageClaimId,
      currentPath: b.currentPath, selectorPaths: [...b.selectorPaths], restoreFenceGeneration: b.restoreFenceGeneration},
    authority: a.principalKind === "owner"
      ? {grantGeneration: null, grantId: null, principalId: a.principalId, principalKind: "owner"}
      : {grantGeneration: a.grantGeneration, grantId: a.grantId, principalId: a.principalId, principalKind: a.principalKind},
    receivedAtMs,
  }, firstSeen: metadata.firstSeen.map(r => ({clientId: r.clientId, startClock: r.startClock, endClock: r.endClock}))};
}

export function initialAcceptedHistoryDigest(namespace: string, document: LiveDocumentKey): string {
  return hash(["accepted-history-v1", [namespace, document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId]]);
}

export function nextAcceptedHistoryDigest(previous: string, eventCount: number, metadata: AdmittedLiveUpdateMetadata): string {
  return hash(["accepted-event-v1", previous, eventCount, canonicalAcceptedMetadata(metadata)]);
}

export function canonicalVersionedAcceptedMetadata(metadata: AdmittedLiveUpdateMetadata): AdmittedLiveUpdateMetadata {
  const canonical = canonicalAcceptedMetadata(metadata);
  if (metadata.canonicalVersion === undefined) return canonical;
  if (metadata.canonicalVersion !== 2) throw new TypeError("Unknown accepted history version.");
  if (!Array.isArray(metadata.firstSeenDeletes)) throw new TypeError("Missing accepted deletion coverage.");
  return {...canonical, canonicalVersion: 2, authorSnapshot: parseLiveAuthorSnapshot(metadata.authorSnapshot),
    firstSeenDeletes: metadata.firstSeenDeletes.map(range => ({clientId: range.clientId, startClock: range.startClock, endClock: range.endClock})),
    ...(metadata.checkpointCoverage === undefined ? {} : {checkpointCoverage: parseLiveCheckpointCoverage(metadata.checkpointCoverage)})};
}

export function nextVersionedAcceptedHistoryDigest(previous: string, eventCount: number, metadata: AdmittedLiveUpdateMetadata): string {
  if (metadata.canonicalVersion === undefined) return nextAcceptedHistoryDigest(previous, eventCount, metadata);
  return hash(["accepted-event-v2", previous, eventCount, canonicalVersionedAcceptedMetadata(metadata)]);
}
