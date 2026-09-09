import {createHash} from "node:crypto";
import type {AdmittedLiveUpdateMetadata, LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

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
