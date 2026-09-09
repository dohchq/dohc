import {configRecord} from "./deviceLiveHostConfig";
import {parseHostControlIdentifier} from "@dohc/live-session-contract/host-control";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseAdmittedLiveUpdateMetadata, parseLiveUpdateDigest, parseLiveUpdateIdentifier, parseLiveUpdateReceipt,
  type AdmittedLiveUpdateMetadata, type LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";
import {parseNativeRestoreFenceReceipt, type NativeRestoreFenceReceipt} from "./liveRestoreFence";
import {authorityInteger} from "./storage/liveDocumentAuthority";

export type NativeRestoreApplicationReceipt = {
  fence: NativeRestoreFenceReceipt; candidateDigest: string; nativeSourceManifestDigest: string;
  admitted: AdmittedLiveUpdateMetadata; localHeadSequence: number;
  hostCoordinate: {hostId: string; hostEpoch: number; instanceId: string; connectionId: string}; recordedAtMs: number;
};
export type NativeRestoreSettlementReceipt = {
  settlementId: string; previousCursor: number; terminalCursor: number; applicationCount: number;
  localYDocSequence: number; momentId: string; markdownDigest: string; materialized: boolean; collectionReconcileRequired: boolean;
};
export type NativeRestoreResumeReceipt = {
  relayDatabaseNamespace: string; operationId: string; binding: LiveObjectBinding; applicationReceipt: LiveUpdateReceipt;
  settlementId: string; momentId: string; markdownDigest: string; localHeadSequence: number; recordedAtMs: number;
};
export type RestoreLifecycle = {
  phase: "relay-admitted" | "native-applied" | "settled" | "resumed";
  proposalDigest: string; candidateDigest: string;
  preparation: {fence: NativeRestoreFenceReceipt; point: {journalCursor: number; receiptDigest: string; markdownDigest: string; projectionDigest: string}};
  nativeSourceManifestDigest: string; admitted: AdmittedLiveUpdateMetadata;
  application: NativeRestoreApplicationReceipt | null; settlement: NativeRestoreSettlementReceipt | null; resume: NativeRestoreResumeReceipt | null;
};

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("Invalid native restore boolean.");
  return value;
}
export function parseNativeRestoreApplicationReceipt(value: unknown): NativeRestoreApplicationReceipt {
  const r=configRecord(value,["fence","candidateDigest","nativeSourceManifestDigest","admitted","localHeadSequence","hostCoordinate","recordedAtMs"]);
  const h=configRecord(r.hostCoordinate,["hostId","hostEpoch","instanceId","connectionId"]);
  return {fence:parseNativeRestoreFenceReceipt(r.fence),candidateDigest:parseLiveUpdateDigest(r.candidateDigest),
    nativeSourceManifestDigest:parseLiveUpdateDigest(r.nativeSourceManifestDigest),admitted:parseAdmittedLiveUpdateMetadata(r.admitted),
    localHeadSequence:authorityInteger(r.localHeadSequence),hostCoordinate:{hostId:parseHostControlIdentifier(h.hostId),
      hostEpoch:authorityInteger(h.hostEpoch,1),instanceId:parseHostControlIdentifier(h.instanceId),connectionId:parseHostControlIdentifier(h.connectionId)},
    recordedAtMs:authorityInteger(r.recordedAtMs)};
}
export function parseNativeRestoreSettlementReceipt(value: unknown): NativeRestoreSettlementReceipt {
  const r=configRecord(value,["settlementId","previousCursor","terminalCursor","applicationCount","localYDocSequence","momentId","markdownDigest","materialized","collectionReconcileRequired"]);
  const previousCursor=authorityInteger(r.previousCursor),terminalCursor=authorityInteger(r.terminalCursor),applicationCount=authorityInteger(r.applicationCount,1);
  if (previousCursor>=terminalCursor || applicationCount>terminalCursor-previousCursor) throw new TypeError("Invalid native restore settlement coverage.");
  return {settlementId:parseLiveUpdateIdentifier(r.settlementId),previousCursor,terminalCursor,applicationCount,localYDocSequence:authorityInteger(r.localYDocSequence),
    momentId:parseLiveUpdateIdentifier(r.momentId),markdownDigest:parseLiveUpdateDigest(r.markdownDigest),materialized:boolean(r.materialized),
    collectionReconcileRequired:boolean(r.collectionReconcileRequired)};
}
export function parseNativeRestoreResumeReceipt(value: unknown): NativeRestoreResumeReceipt {
  const r=configRecord(value,["relayDatabaseNamespace","operationId","binding","applicationReceipt","settlementId","momentId","markdownDigest","localHeadSequence","recordedAtMs"]);
  return {relayDatabaseNamespace:parseLiveUpdateIdentifier(r.relayDatabaseNamespace),operationId:parseLiveUpdateIdentifier(r.operationId),
    binding:parseLiveObjectBinding(r.binding),applicationReceipt:parseLiveUpdateReceipt(r.applicationReceipt),settlementId:parseLiveUpdateIdentifier(r.settlementId),
    momentId:parseLiveUpdateIdentifier(r.momentId),markdownDigest:parseLiveUpdateDigest(r.markdownDigest),localHeadSequence:authorityInteger(r.localHeadSequence),recordedAtMs:authorityInteger(r.recordedAtMs)};
}
