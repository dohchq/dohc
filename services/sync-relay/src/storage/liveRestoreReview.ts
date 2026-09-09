import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {LiveDocumentKey, LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";
import {decodeNativeRestoreProposal, type NativeRestoreProposalReceipt} from "../liveRestoreProposal";
import {readAcceptedHistoryDeliveryMetadata, readAcceptedHistoryInterval, RestoreHistoryBudget} from "./liveAcceptedHistory";
import {authorityInteger} from "./liveDocumentAuthority";
import {documentParams} from "./liveUpdateJournal";
import {readRestoreAdmission, restoreIntegrity as require} from "./liveRestoreCheckpoint";
import {LIVE_RESTORE_PROPOSALS} from "./liveRestoreOperationSchema";
import type {StorageContext} from "./context";

type NativeSource = NativeRestoreProposalReceipt["nativeSources"][number];
type SourceOccurrence = {
  operationId: string; proposalDigest: string; context: "current-fence" | "prior-restore";
  acceptedReceipt: LiveUpdateReceipt | null;
};
type ReviewSource = {
  source: Omit<NativeSource, "acceptedReceipt">;
  acceptedReceipt: LiveUpdateReceipt | null;
  acceptedRelation: "at-or-before-selected" | "after-selected" | "not-relay-accepted";
  occurrences: SourceOccurrence[];
};
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

/** Historical manifests are retained evidence; they are not current restore proposals. */
function historicalSources(storage: StorageContext, input: {
  namespace: string; document: LiveDocumentKey; operationId: string;
  metadata: ReturnType<typeof readAcceptedHistoryInterval>[number]["metadata"];
}, budget: RestoreHistoryBudget) {
  const admission = readRestoreAdmission(storage.db, input.namespace, input.operationId, budget.bytes, bytes => budget.chargeBytes(bytes));
  require(isDeepStrictEqual(admission.admitted, input.metadata) &&
    isDeepStrictEqual(documentParams(admission.admitted.accepted.binding), documentParams(input.document)));
  const header = storage.db.prepare(`SELECT length(proposal_bytes) AS bytes FROM ${LIVE_RESTORE_PROPOSALS}
    WHERE relay_database_namespace=? AND operation_id=? AND workspace_id=?`).get(input.namespace, input.operationId, input.document.workspaceId);
  require(header); const byteLength = authorityInteger(header.bytes, 1); budget.chargeBytes(byteLength);
  const saved = storage.db.prepare(`SELECT proposal_bytes,proposal_sha256,candidate_sha256 FROM ${LIVE_RESTORE_PROPOSALS}
    WHERE relay_database_namespace=? AND operation_id=? AND workspace_id=?`).get(input.namespace, input.operationId, input.document.workspaceId)!;
  require(saved.proposal_bytes instanceof Uint8Array && saved.proposal_bytes.byteLength === byteLength &&
    saved.proposal_sha256 === admission.proposalDigest && saved.candidate_sha256 === admission.candidateDigest &&
    hash(saved.proposal_bytes) === admission.proposalDigest);
  const decoded = decodeNativeRestoreProposal(saved.proposal_bytes, {maxBytes: byteLength, maxEvents: budget.events});
  const {receipt, bytes} = decoded;
  budget.chargeEvents(receipt.selectedHistory.suffix.length + receipt.acceptedHistory.suffix.length);
  require(isDeepStrictEqual(receipt.fence, admission.preparation.fence) && isDeepStrictEqual(receipt.point, admission.preparation.point) &&
    receipt.candidateDigest === admission.candidateDigest && receipt.nativeSourceManifestDigest === admission.nativeSourceManifestDigest &&
    hash(bytes.candidateBytes) === receipt.candidateDigest && hash(bytes.frozenStateBytes) === receipt.frozenStateDigest &&
    hash(bytes.pointStateBytes) === receipt.pointStateDigest);
  for (const [index, source] of receipt.nativeSources.entries()) {
    require(bytes.nativeSourceBytes[index]!.byteLength === source.byteLength && hash(bytes.nativeSourceBytes[index]!) === source.updateDigest);
  }
  return {receipt, proposalDigest: admission.proposalDigest};
}

/** Complete post-point accepted metadata plus separately identified retained native sources. */
export function readRestoreReviewHistory(storage: StorageContext, input: {
  document: LiveDocumentKey; namespace: string; proposalDigest: string; receipt: NativeRestoreProposalReceipt;
}, budget: RestoreHistoryBudget) {
  const {receipt, document, namespace} = input;
  const events = readAcceptedHistoryInterval(storage, {document, namespace,
    selected: receipt.selectedHistory, accepted: receipt.acceptedHistory}, budget);
  const acceptedByDelivery = new Map(events.map(event => [event.metadata.accepted.receipt.deliveryId, event.metadata]));
  require(acceptedByDelivery.size === events.length);
  const sources = new Map<string, ReviewSource>();
  const add = (source: NativeSource, occurrence: Omit<SourceOccurrence, "acceptedReceipt">) => {
    budget.chargeEvents(1);
    const accepted = acceptedByDelivery.get(source.deliveryId) ?? readAcceptedHistoryDeliveryMetadata(storage, {
      document, namespace, through: receipt.acceptedHistory.terminal?.journalCursor ?? 0,
      eventCount: receipt.acceptedHistory.eventCount, deliveryId: source.deliveryId,
    }, budget);
    if (accepted) {
      require(accepted.accepted.receipt.updateDigest === source.updateDigest && accepted.accepted.authority.principalKind === "owner" &&
        isDeepStrictEqual(accepted.accepted.binding, source.binding));
      if (source.acceptedReceipt) require(isDeepStrictEqual(source.acceptedReceipt, accepted.accepted.receipt));
    } else require(source.acceptedReceipt === null);
    const {acceptedReceipt: _receipt, ...native} = source;
    let entry = sources.get(source.deliveryId);
    if (entry) require(isDeepStrictEqual(entry.source, native));
    else {
      entry = {source: native, acceptedReceipt: accepted?.accepted.receipt ?? null,
        acceptedRelation: !accepted ? "not-relay-accepted" : accepted.accepted.receipt.journalCursor <= receipt.point.journalCursor
          ? "at-or-before-selected" : "after-selected", occurrences: []};
      sources.set(source.deliveryId, entry);
    }
    entry.occurrences.push({...occurrence, acceptedReceipt: source.acceptedReceipt});
  };
  for (const event of events) {
    if (event.restoreOperationId === null) continue;
    const previous = historicalSources(storage, {document, namespace, operationId: event.restoreOperationId, metadata: event.metadata}, budget);
    require(previous.receipt.fence.operation.newFence <= receipt.fence.operation.oldBinding.restoreFenceGeneration);
    for (const source of previous.receipt.nativeSources) add(source, {operationId: event.restoreOperationId,
      proposalDigest: previous.proposalDigest, context: "prior-restore"});
  }
  for (const source of receipt.nativeSources) add(source, {operationId: receipt.fence.operation.operationId,
    proposalDigest: input.proposalDigest, context: "current-fence"});
  return {acceptedEvents: events, nativeSources: [...sources.values()]};
}
