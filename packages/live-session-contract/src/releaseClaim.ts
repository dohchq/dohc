import type {LiveObjectBinding} from "./liveObjectBinding";
import {parseLiveDocumentKey, parseLiveUpdateDigest, type AdmittedLiveUpdate, type LiveDocumentKey, type LiveUpdateReceipt} from "./liveUpdateAdmission";

export interface ReleasePublicationTag {
  releaseId: string;
  restoreFenceGeneration: number;
  document: LiveDocumentKey;
}
export function parseReleasePublicationTag(value: unknown): ReleasePublicationTag {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid release tag.");
  const raw = value as Record<string,unknown>;
  if (Object.keys(raw).sort().join() !== "document,releaseId,restoreFenceGeneration" ||
    !Number.isSafeInteger(raw.restoreFenceGeneration) || Number(raw.restoreFenceGeneration) < 0) throw new TypeError("Invalid release tag.");
  const document = parseLiveDocumentKey(raw.document);
  parseLiveUpdateDigest(document.lineageClaimId);
  if (document.mainVersionId !== "main") throw new TypeError("Invalid release document.");
  return {releaseId:parseLiveUpdateDigest(raw.releaseId),restoreFenceGeneration:Number(raw.restoreFenceGeneration),document};
}
export interface ReleaseHistoryProof {
  checkpoint: {eventCount: number; terminal: LiveUpdateReceipt | null; binding: LiveObjectBinding;
    stateDigest: string; evidenceDigest: string; canonicalVersion?: 2; restoreOperationId?: string};
  suffix: AdmittedLiveUpdate["metadata"][];
  eventCount: number;
  terminal: LiveUpdateReceipt | null;
  evidenceDigest: string;
}
export interface RelayReleaseClaim {
  digest: string;
  computerName: string;
  anchor: {document: LiveDocumentKey; relayDatabaseNamespace: string; replicationEpoch: string; streamIdentity: string;
    restoreFenceGeneration: number; cursor: number; proof: ReleaseHistoryProof; receipts: ReleaseDeliveryReceipt[]};
}
export interface ReleaseDeliveryReceipt {deliveryId: string; metadata: AdmittedLiveUpdate["metadata"] | null}
export type ReleaseClaimRefusalCode = "release-abandoned" | "release-claimed" | "release-changed" | "restore-in-progress" |
  "restore-fenced" | "workspace-changed" | "document-unavailable" | "live-again";
export interface RelayReleaseRefusal {ok: false; code: ReleaseClaimRefusalCode; claim?: RelayReleaseClaim; path?: string; message?: string}
export interface RelayReleaseRequest {
  action: "acquire" | "status" | "complete" | "abandon" | "catch-up";
  document: LiveDocumentKey;
  relayDatabaseNamespace: string;
  replicationEpoch: string;
  streamIdentity: string;
  restoreFenceGeneration: number;
  releaseId?: string;
  computerName?: string;
  requireRetired?: boolean;
  claimDigest?: string;
  receiptDeliveryIds?: string[];
}
export type RelayReleaseResponse =
  | RelayReleaseRefusal
  | {ok: true; status: "held"; claim: RelayReleaseClaim}
  | {ok: true; status: "not-held"; claim?: RelayReleaseClaim}
  | {ok: true; status: "unresolved"; code: ReleaseClaimRefusalCode}
  | {ok: true; history: {checkpoint: {cursor: number; bytes: string; digest: string};
      events: {metadata: AdmittedLiveUpdate["metadata"]; updateBytes: string}[]; proof: ReleaseHistoryProof; receipts: ReleaseDeliveryReceipt[]}};
export type ReleasePublicationRefusalReason = "release-publication-fenced" | "release-generation-fenced" | "release-restore-in-progress" | "release-document-changed";
export interface ReleasePublicationAdmission {
  status: "refused";
  kind: "release-publication";
  releaseId: string;
  reason: ReleasePublicationRefusalReason;
}
export interface ReleasePushRefusal extends ReleasePublicationAdmission {originId: string; originSeq: number}
