import {SETTLEMENT_CUTS} from "./hostedSettlementSchema";
import {restorePublicationFits,restorePublicationReservation} from "./hostedSettlement";

import {RestoreAdmissionReads} from "./restoreAdmissionReads";
import {relayError} from "../errors";
import {nativeSourceAuthorMatches} from "./liveNativeSourceAuthors";
import {parseNativeRestoreApplicationReceipt,parseNativeRestoreSettlementReceipt,parseNativeRestoreResumeReceipt,type RestoreLifecycle,type NativeRestoreApplicationReceipt,type NativeRestoreSettlementReceipt,type NativeRestoreResumeReceipt} from "../liveRestoreLifecycle";
import { hasServiceActivation, type ServiceActivationAccess } from "./serviceActivationAccess";
import {readServiceActivationOrigin} from "./serviceActivationOrigin";
import {carryServiceActivationRetirement} from "./serviceActivationRetirement";
import {readRestoreAdmission,verifyRestoreCheckpoint,restoreDigest,type RestoreAdmission,type RestoreSourceRange} from "./liveRestoreCheckpoint";
import {retainedRestoreLifecycle,validateRestoreLifecycle,requireFinishedRestoreBinding} from "./liveRestoreLifecycleStorage";
import { randomUUID, createHash } from "node:crypto";
import {revalidateAcceptedHistoryDelivery,readAcceptedHistory, readAcceptedHistoryDelivery, requireAcceptedHistoryProof, RestoreHistoryBudget} from "./liveAcceptedHistory";
import {captureSqliteReadRevision} from "./readRevision";
import {requireRestoreLifecycleBudget} from "./liveRestoreLifecycleBudget";
import {HOST_CONTROL_IDENTIFIER_MAX_BYTES} from "@dohc/live-session-contract/host-control";
import {canonicalVersionedAcceptedMetadata, initialAcceptedHistoryDigest, nextVersionedAcceptedHistoryDigest} from "../liveAcceptedHistory";
import {assessLiveAuthorWindow} from "./liveAuthorWindow";
import type {NativeRestoreHistoryProof} from "../liveRestoreProposal";
export type {RestoreLifecycle} from "../liveRestoreLifecycle";
import type { LiveOwnerAdoptionCut, NativeOwnerActivationSource, RetainedPrefix, RetainedPrefixBody } from "@dohc/workspace-engine-client/daemon";
import { LIVE_DELIVERY_OWNER_HISTORY, SERVICE_ACTIVATIONS } from "./serviceActivationSchema";
import { isDeepStrictEqual } from "node:util";
import {
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
  LIVE_UPDATE_IDENTIFIER_MAX_BYTES,
  parseLiveUpdateReceipt,
  parseLiveUpdateHostApplicationAck,
  type LiveDocumentKey,
  type LiveUpdateReceipt,
  type AdmittedLiveUpdate,
} from "@dohc/live-session-contract/live-update-admission";
import {
  parseLiveObjectBinding,
  type LiveObjectBinding,
} from "@dohc/live-session-contract/live-object-binding";
import type { StorageContext } from "./context";
import type {
  LiveHostConnectionCoordinate,
  StoredLiveDocumentAuthority,
} from "./types";
import { snapshotHostCoordinate } from "../liveTicketInputs";
import {
  authorityInteger,
  baselineRecord,
  decodeLiveDocumentAuthorityStructure,
  currentLiveDocumentBinding,
  authorizeLiveDocument,
} from "./liveDocumentAuthority";
import {
  attachLiveJournalHistory,
  requireLiveJournalHistory,
  type LiveJournalHistoryAuthority,
} from "./liveJournalHistory";
import {
  LIVE_DELIVERY_BOOTSTRAPS as BOOTSTRAPS,
  LIVE_DELIVERY_EDGES as EDGES,
  LIVE_DELIVERY_OWNERS as OWNERS,
} from "./liveCommittedDeliverySchema";
import { LIVE_JOURNAL_TABLE } from "./schema";
import { liveJournalCheckpointDue } from "./liveJournalCheckpoint";
import {
  appendValidatedLiveJournal,subtractJournalRanges,
  journalDocument,
  journalHost,
  documentParams,
  liveJournalCut,
  verifyJournalCut,
  decodeJournalRow,
  verifyJournalRow,
  assertJournalCheckpointPosition,
} from "./liveUpdateJournal";
import { adoptLiveDeliveryPrefix, bindLiveDeliveryHostNamespace, consumeLiveDeliveryReservation } from "./liveDeliveryReservations";
import { acknowledgeStopRestoreCancellation, continueStopRestoreInTransaction, nativeRestoreFence, readStopRestoreCancellation, requireStopRestoreCut, requireStopRestoreOwnerOrigin, readStopRestoreInTransaction,
  stopRestoreDeclineRecorded, stopRestoreFinishedAtMovedPath, stopRestoreHoldsFrozenPath, stopRestoreIdentityHolds, stopRestoreRevocationHolds, type StopRestoreContinuation, type StopRestoreLookup, type StopRestoreOperation, type StopRestoreApplied } from "./liveRestoreOperation";
import {parseNativeRestoreFenceReceipt, type NativeRestoreCancellation, type NativeRestoreCancellationAnswer, type NativeRestoreFenceReceipt} from "../liveRestoreFence";
import {parseNativeRestoreProposalReceipt, decodeNativeRestoreProposal, type RestoreProofBudget} from "../liveRestoreProposal";
import {LiveRestoreTooLarge, type LiveRestoreProposalEvidence, type LiveRestoreValidator} from "../liveRestoreValidation";
import {readRestoreReviewHistory} from "./liveRestoreReview";
import {assertWorkspaceQuota} from "./workspaces";
import { LIVE_RESTORE_OPERATIONS, LIVE_RESTORE_PROPOSALS, LIVE_RESTORE_LIFECYCLES,LIVE_RESTORE_SOURCE_RANGES, UNFINISHED_RESTORE } from "./liveRestoreOperationSchema";

type RestoreProposalInput = StopRestoreLookup & {host: LiveHostConnectionCoordinate} & RestoreProofBudget;
type PreparedRestoreProposal = {saved: {bytes: Uint8Array; proposalDigest: string; candidateDigest: string; recordedAtMs: number};
  capture: ReturnType<LiveCommittedDeliveryStore["captureStopRestoreProposal"]>; validated: LiveRestoreProposalEvidence;
  assertCurrentInTransaction(): void};
function lifecycleInput(input:RestoreProposalInput):RestoreProposalInput {
  return {operationId:parseLiveUpdateIdentifier(input.operationId),workspaceId:parseLiveUpdateIdentifier(input.workspaceId),ownerUserId:parseLiveUpdateIdentifier(input.ownerUserId),host:snapshotHostCoordinate(input.host),maxBytes:authorityInteger(input.maxBytes,1),maxEvents:authorityInteger(input.maxEvents,1)};
}
const proposalCharge = (bytes: number, operationId: string, workspaceId: string, proposalDigest: string, candidateDigest: string, recordedAtMs: number, namespace:string) =>
  authorityInteger(bytes + Buffer.byteLength(JSON.stringify([namespace,operationId, workspaceId, proposalDigest, candidateDigest, recordedAtMs, Number.MAX_SAFE_INTEGER, "f".repeat(64)])), 1);
const proposalRecordDigest = (operationId: string, workspaceId: string, proposalDigest: string, candidateDigest: string, recordedAtMs: number, charge: number,namespace:string) =>
  createHash("sha256").update(JSON.stringify([namespace,operationId, workspaceId, proposalDigest, candidateDigest, recordedAtMs, charge])).digest("hex");

export interface CommittedBootstrap {
  readonly bootstrapId: string;
  readonly bootstrapMomentId: string;
  readonly binding: LiveObjectBinding;
  readonly baselineMomentRelaySequence: number;
  readonly baselineRegisteredAtMs: number;
  readonly baselineDigest: string;
  readonly projectedMarkdownDigest: string;
  readonly projectedMarkdownByteLength: number;
  readonly baselineBytes: Uint8Array;
}
export interface CommittedBootstrapAck {
  readonly bootstrapId: string;
  readonly bootstrapMomentId: string;
  readonly baselineDigest: string;
  readonly baselineMomentRelaySequence: number;
  readonly localYDocSequence: number;
  readonly bootstrapReplayed: boolean;
}
export interface CommittedDeliveryDrain {
  readonly baseline: CommittedBootstrap;
  readonly terminalReceipt: LiveUpdateReceipt | null;
}

export interface OwnerCutCapture {
  binding: LiveObjectBinding;
  cut: LiveOwnerAdoptionCut;
  assertCurrent(): void;
}
export interface RestoreOwnerOriginCapture {
  readonly binding: LiveObjectBinding;
  readonly adoptionId: string;
  readonly expectedLocalSequence: number;
  readonly eventCount: number;
  readonly terminalReceipt: LiveUpdateReceipt | null;
  readonly historyEvidenceDigest: string;
  readonly evidenceDigest: string;
  readonly nativeReceipt: NativeRestoreFenceReceipt;
  readonly point: { journalCursor: number; receiptDigest: string };
  assertCurrent(): void;
}
export interface RestoreHistoryCapture<Target extends "selected" | "accepted"> {
  artifact(digest: string): Uint8Array | undefined;
  readonly target: Target;
  readonly binding: LiveObjectBinding;
  readonly checkpoint: {cursor: number; bytes: Uint8Array; digest: string};
  readonly events: readonly AdmittedLiveUpdate[];
  readonly point: {journalCursor: number; receiptDigest: string};
  readonly nativeReceipt: NativeRestoreFenceReceipt;
  readonly proof: NativeRestoreHistoryProof;
  assertCurrent(): void;
}
export interface OwnerDeliveryCapture {
  binding: LiveObjectBinding;
  assertCurrent(): void;
}
/** An adopted document's owner delivery after its owner lost live authority: the relay's tip, and the next row it accepted after it. */
export interface DepartedOwnerDelivery {
  readonly binding: LiveObjectBinding;
  readonly tip: LiveUpdateReceipt | null;
  readonly next: LiveUpdateReceipt | null;
}
export interface StopRestoreCutCapture {
  readonly binding: LiveObjectBinding;
  readonly deliveryKind: "bootstrap" | "owner";
  readonly resumeAdoptionId: string | null;
}
type RestoreCapture = {
  baselineBytes: Uint8Array;
  lookup: StopRestoreLookup;
  host: LiveHostConnectionCoordinate;
  operation: StopRestoreOperation;
  drain?: CommittedDeliveryDrain;
  owner?: OwnerDeliveryCapture;
};
export type CommittedDeliveryStep =
  | { kind: "bootstrap"; baseline: CommittedBootstrap }
  | {
      kind: "next";
      admitted: AdmittedLiveUpdate;
      predecessor: LiveUpdateReceipt | null;
    }
  | { kind: "done"; terminalReceipt: LiveUpdateReceipt | null };
interface DrainCapture {
  restore?: {lookup: StopRestoreLookup; operation: StopRestoreOperation};
  host: LiveHostConnectionCoordinate;
  document: LiveDocumentKey;
  authority: StoredLiveDocumentAuthority;
  baseline: CommittedBootstrap;
  terminal: LiveUpdateReceipt | null;
  progress?: {
    predecessor: LiveUpdateReceipt | null;
    tip: Record<string, unknown> | null;
  };
  checkpoint?: {
    receipt: LiveUpdateReceipt;
    count: number;
    bytes: number;
    rowBytes: number;
    hasCheckpoint: boolean;
  };
}
const WHERE_DOCUMENT =
  "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
const WHERE_BOOTSTRAP =
  "relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND host_id=?";
function integrity(condition: unknown): asserts condition {
  if (!condition)
    throw new Error("Committed delivery evidence is damaged or conflicts.");
}
function receipt(row: Record<string, unknown>): LiveUpdateReceipt {
  return parseLiveUpdateReceipt({
    deliveryId: row.delivery_id,
    updateDigest: row.update_digest,
    journalCursor: row.journal_cursor,
    acceptingHostEpoch: row.accepting_host_epoch,
  });
}
function sameReceipt(
  a: LiveUpdateReceipt | null,
  b: LiveUpdateReceipt | null,
): boolean {
  return isDeepStrictEqual(a, b);
}
function parseBootstrapAck(value: unknown): CommittedBootstrapAck {
  const row = baselineRecord(value, [
    "bootstrapId",
    "bootstrapMomentId",
    "baselineDigest",
    "baselineMomentRelaySequence",
    "localYDocSequence",
    "bootstrapReplayed",
  ]);
  if (typeof row.bootstrapReplayed !== "boolean")
    throw new TypeError("Invalid bootstrap replay flag.");
  return {
    bootstrapId: parseLiveUpdateIdentifier(row.bootstrapId, "bootstrap ID"),
    bootstrapMomentId: parseLiveUpdateIdentifier(
      row.bootstrapMomentId,
      "bootstrap moment ID",
    ),
    baselineDigest: parseLiveUpdateDigest(row.baselineDigest),
    baselineMomentRelaySequence: authorityInteger(
      row.baselineMomentRelaySequence,
      1,
    ),
    localYDocSequence: authorityInteger(row.localYDocSequence),
    bootstrapReplayed: row.bootstrapReplayed,
  };
}
function copiedBaseline(value: CommittedBootstrap): CommittedBootstrap {
  return {
    ...value,
    binding: {
      ...value.binding,
      selectorPaths: [...value.binding.selectorPaths],
    },
    baselineBytes: new Uint8Array(value.baselineBytes),
  };
}

function ownerCutDigest(capture: OwnerCutCapture): string {
  const { baselineBytes,events,...header } = capture.cut;
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  return digest(Buffer.from(JSON.stringify({ binding: capture.binding,...header,baselineDigest: digest(baselineBytes),
    events: events.map(event => ({ metadata: event.metadata,digest: digest(event.updateBytes) })) })));
}

/**
 * The evidence native adoption hashes for `cut` (adoption.rs `validate_cut`).
 * A successor's prefix is the tenth element, only when present, so a first
 * adoption's evidence keeps its nine.
 */
export function ownerAdoptionCutEvidenceDigest(binding: LiveObjectBinding, cut: LiveOwnerAdoptionCut): string {
  const evidence: unknown[] = [binding, cut.relayDatabaseNamespace, cut.sourceMomentId, cut.sourceDigest, cut.sourceByteLength,
    cut.baselineMomentRelaySequence, cut.baselineRegisteredAtMs, cut.expectedLocalSequence,
    cut.events.map(event => canonicalVersionedAcceptedMetadata(event.metadata))];
  const prefix = cut.retainedPrefix;
  if (prefix) {
    const terminal = prefix.terminalReceipt;
    evidence.push({terminalReceipt: terminal && {deliveryId: terminal.deliveryId, updateDigest: terminal.updateDigest,
      journalCursor: terminal.journalCursor, acceptingHostEpoch: terminal.acceptingHostEpoch},
    eventCount: prefix.eventCount, historyEvidenceDigest: prefix.historyEvidenceDigest, predecessorActivationId: prefix.predecessorActivationId});
  }
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

/** Internal storage consumer. Authentication and namespace provisioning belong to its caller. */
export class LiveCommittedDeliveryStore {
  readonly #drains = new WeakMap<CommittedDeliveryDrain, DrainCapture>();
  readonly #storage: StorageContext;
  readonly #history: LiveJournalHistoryAuthority;
  readonly #ownerCuts = new WeakMap<OwnerCutCapture,{ host: LiveHostConnectionCoordinate; document: LiveDocumentKey; digest: string;
    activation: NativeOwnerActivationSource | null }>();
  readonly #ownerDeliveries = new WeakMap<OwnerDeliveryCapture,{host: LiveHostConnectionCoordinate;document: LiveDocumentKey;highWater: number}>();
  readonly #restores = new WeakMap<StopRestoreCutCapture,RestoreCapture>();
  constructor(storage: StorageContext, history: LiveJournalHistoryAuthority, private readonly activation?: ServiceActivationAccess) {
    this.#storage = storage;
    this.#history = history;
    attachLiveJournalHistory(storage, history);
  }

  nextOwnerDocument(workspaceId: string, afterObject: string): LiveDocumentKey | undefined {
    parseLiveUpdateIdentifier(workspaceId, "workspace ID");
    return this.#storage.readTx(() => {
      const row = this.#storage.db.prepare("SELECT workspace_id,main_version_id,object_id,lineage_claim_id FROM sync_relay_live_documents WHERE workspace_id=? AND lineage_state='current' AND admission_state='open' AND object_id>? ORDER BY object_id LIMIT 1").get(workspaceId, afterObject);
      return row ? journalDocument({ workspaceId: row.workspace_id, mainVersionId: row.main_version_id,
        objectId: row.object_id, lineageClaimId: row.lineage_claim_id }) : undefined;
    });
  }
  #ownerSource(document: LiveDocumentKey, adoptionId: string, authority: Pick<StoredLiveDocumentAuthority,
    "binding" | "baselineSequence" | "projectedDigest" | "projectedLength" | "registeredAtMs">) {
    const activation = readServiceActivationOrigin(this.#storage,this.#history.namespace,document,adoptionId);
    if (activation) {
      integrity(activation.source.currentPath === authority.binding.currentPath &&
        activation.baseline.relaySequence === authority.baselineSequence && activation.baseline.projectedDigest === authority.projectedDigest &&
        activation.baseline.projectedLength === authority.projectedLength && activation.baseline.registeredAtMs === authority.registeredAtMs);
      return {sourceMomentId: activation.source.sourceMomentId, sourceDigest: activation.source.sourceDigest,
        sourceByteLength: activation.source.sourceByteLength, activation};
    }
    const source = this.#storage.db.prepare("SELECT moment_id,version_id,path,content_kind,blob_sha256,byte_length FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=?")
      .get(document.workspaceId,document.objectId,authority.baselineSequence);
    integrity(source && source.version_id === document.mainVersionId && source.path === authority.binding.currentPath &&
      source.content_kind === "text" && source.blob_sha256 === authority.projectedDigest && source.byte_length === authority.projectedLength);
    return {sourceMomentId: parseLiveUpdateIdentifier(source.moment_id,"source moment ID"), sourceDigest: authority.projectedDigest,
      sourceByteLength: authority.projectedLength, activation: null};
  }
  // A successor's retained prefix: the boundary its retired predecessor released, or none when that chain never adopted.
  #retainedPrefix(source: NativeOwnerActivationSource | undefined): RetainedPrefix | null {
    const predecessorActivationId = source?.predecessorActivationId;
    if (predecessorActivationId === undefined) return null;
    const row = this.#storage.db.prepare(`SELECT retired_boundary_json FROM ${SERVICE_ACTIVATIONS}
      WHERE relay_database_namespace=? AND activation_id=? AND retired_at_ms IS NOT NULL`).get(this.#history.namespace, predecessorActivationId);
    integrity(row);
    const boundary = JSON.parse(String(row.retired_boundary_json)) as RetainedPrefixBody | null;
    return boundary && {terminalReceipt: boundary.terminalReceipt, eventCount: boundary.eventCount,
      historyEvidenceDigest: boundary.historyEvidenceDigest, predecessorActivationId};
  }
  // The owner row's adoption against the live document row: its baseline, its
  // source and its original binding. Live authority is the caller's to check.
  #ownerOrigin(document: LiveDocumentKey, owner: Record<string, unknown>) {
    const origin = JSON.parse(String(owner.origin_json));
    const row = this.#storage.db.prepare(`SELECT workspace_id,main_version_id,object_id,lineage_claim_id,current_path,restore_fence_generation,lineage_state,admission_state,baseline_digest,baseline_projected_sha256,baseline_projected_byte_length,baseline_moment_relay_seq,registered_at_ms FROM sync_relay_live_documents WHERE ${WHERE_DOCUMENT}`).get(...documentParams(document));
    integrity(row && row.lineage_state === "current" && row.baseline_digest === document.lineageClaimId &&
      row.baseline_moment_relay_seq === origin.baselineMomentRelaySequence && row.registered_at_ms === origin.baselineRegisteredAtMs);
    const binding = parseLiveObjectBinding({...document,currentPath: row.current_path,selectorPaths: [row.current_path],restoreFenceGeneration: row.restore_fence_generation});
    const source = this.#ownerSource(document,origin.adoptionId,{binding,baselineSequence: authorityInteger(row.baseline_moment_relay_seq,1),
      projectedDigest: parseLiveUpdateDigest(row.baseline_projected_sha256),projectedLength: authorityInteger(row.baseline_projected_byte_length),
      registeredAtMs: authorityInteger(row.registered_at_ms)});
    integrity(source.sourceMomentId === origin.sourceMomentId && source.sourceDigest === origin.sourceDigest && source.sourceByteLength === origin.sourceByteLength &&
      (!source.activation || source.activation.source.nativeHeadSequence === origin.expectedLocalSequence));
    const originalBinding=parseLiveObjectBinding(origin.originalBinding);
    integrity(createHash("sha256").update(JSON.stringify(originalBinding)).digest("hex")===origin.bindingDigest);
    return {row,origin,binding,source,originalBinding};
  }
  openOwnerDelivery(input: {host: LiveHostConnectionCoordinate;document: LiveDocumentKey;actor: import("./types").CurrentLiveBindingRequest["actor"]}): OwnerDeliveryCapture {
    const host = snapshotHostCoordinate(input.host), document = journalDocument(input.document);
    const read = () => {
      this.#standing(host);
      const owner = this.#ownerRow(host,document); integrity(owner);
      const {row,binding,source,originalBinding} = this.#ownerOrigin(document,owner);
      integrity(row.admission_state === "open");
      const hostState = this.#storage.getLiveHostControl(); integrity(hostState);
      const current = authorizeLiveDocument(this.#storage,{document,actor: input.actor},hostState,{binding,current: true,open: true,baselineSequence: authorityInteger(row.baseline_moment_relay_seq,1)},this.activation);
      integrity(current.kind === "current" && isDeepStrictEqual(current.host,host));
      requireFinishedRestoreBinding(this.#storage.db,this.#history.namespace,originalBinding,current.binding);
      return {row,origin: String(owner.origin_json),binding: current.binding,source};
    };
    const initial = this.#storage.readTx(read);
    const assertCurrent = () => {const current = read(); integrity(isDeepStrictEqual(current,initial));};
    const high = this.#storage.db.prepare(`SELECT MAX(journal_cursor) AS cursor FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT}`).get(...documentParams(document))!;
    const capture = {binding: initial.binding,assertCurrent};
    this.#ownerDeliveries.set(capture,{host,document,highWater: high.cursor === null ? 0 : authorityInteger(high.cursor,1)});
    return capture;
  }
  existingOwnerDelivery(input: Parameters<LiveCommittedDeliveryStore["openOwnerDelivery"]>[0]): OwnerDeliveryCapture | null {
    const host=snapshotHostCoordinate(input.host),document=journalDocument(input.document);
    const exists=this.#storage.readTx(() => {
      this.#standing(host);
      const current=currentLiveDocumentBinding(this.#storage,{document,actor:input.actor},this.activation);
      integrity(current.kind==="current" && isDeepStrictEqual(current.host,host));
      return this.#ownerRow(host,document)!==undefined;
    });
    return exists?this.openOwnerDelivery({...input,host,document}):null;
  }
  #ownerDelivery(capture: OwnerDeliveryCapture) {
    const saved = this.#ownerDeliveries.get(capture); integrity(saved);
    capture.assertCurrent();
    return saved;
  }
  /**
   * `sequence` is the greatest native sequence delivery proved. `adoptionSequence`
   * is the native head the host adopted at, as its adoption ACK confirmed.
   */
  ownerDeliveryProgress(capture: OwnerDeliveryCapture): {terminal: LiveUpdateReceipt | null;sequence: number;adoptionId:string;adoptionSequence: number;adoptionTerminal: LiveUpdateReceipt | null} {
    const {host,document} = this.#ownerDelivery(capture), row = this.#ownerRow(host,document); integrity(row);
    const parsed = this.#ownerTip(row);
    integrity(authorityInteger(row.tip_application_sequence) <= authorityInteger(row.tip_sequence));
    const origin = JSON.parse(String(row.origin_json));
    return {terminal: parsed,sequence: authorityInteger(row.tip_sequence),adoptionId:parseLiveUpdateIdentifier(origin.adoptionId),
      adoptionSequence: authorityInteger(origin.expectedLocalSequence),
      adoptionTerminal: origin.terminalReceipt === null ? null : parseLiveUpdateReceipt(origin.terminalReceipt)};
  }
  /**
   * The adoption's owner delivery once its owner lost live authority, as after
   * Pause, Stop or the loss of the last Edit grant. It needs this connection's standing
   * and the adoption's exact binding, not the document's live authority, so
   * what the host already applied can settle. Null when the host never adopted it.
   */
  departedOwnerDelivery(input: {host: LiveHostConnectionCoordinate; document: LiveDocumentKey; adoptionId: string}): DepartedOwnerDelivery | null {
    const host = snapshotHostCoordinate(input.host), document = journalDocument(input.document);
    const adoptionId = parseLiveUpdateIdentifier(input.adoptionId, "adoption ID");
    return this.#storage.readTx(() => {
      const departed = this.#departed(host,document,adoptionId);
      return departed && {binding: departed.binding,tip: departed.tip,next: departed.next};
    });
  }
  /**
   * Records the host's ACK of the next row the journal accepted after the tip.
   * It accepts nothing: the ACK must match that row's whole receipt. An ACK of
   * the tip itself changes nothing. Returns the delivery after it.
   */
  recordDepartedApplication(input: {host: LiveHostConnectionCoordinate; document: LiveDocumentKey; adoptionId: string; binding: LiveObjectBinding},value: unknown): DepartedOwnerDelivery {
    const host = snapshotHostCoordinate(input.host), document = journalDocument(input.document);
    const adoptionId = parseLiveUpdateIdentifier(input.adoptionId, "adoption ID"), binding = parseLiveObjectBinding(input.binding);
    const ack = parseLiveUpdateHostApplicationAck(value);
    const acknowledged = {deliveryId: ack.deliveryId,updateDigest: ack.updateDigest,journalCursor: ack.journalCursor,acceptingHostEpoch: ack.acceptingHostEpoch};
    return this.#storage.tx(() => {
      let departed = this.#departed(host,document,adoptionId);
      integrity(departed && isDeepStrictEqual(departed.binding,binding));
      if (sameReceipt(departed.tip,acknowledged)) integrity(departed.owner.tip_application_sequence === ack.localYDocSequence);
      else {
        integrity(departed.next && sameReceipt(departed.next,acknowledged));
        this.#advanceOwnerTip(host,document,departed.owner,departed.next,ack);
        departed = this.#departed(host,document,adoptionId)!;
      }
      return {binding: departed.binding,tip: departed.tip,next: departed.next};
    });
  }
  #departed(host: LiveHostConnectionCoordinate,document: LiveDocumentKey,adoptionId: string) {
    this.#standing(host);
    const owner = this.#ownerRow(host,document);
    if (!owner) return null;
    const {origin,row,originalBinding} = this.#ownerOrigin(document,owner);
    integrity(origin.adoptionId === adoptionId);
    // Without live authority the adoption's own binding stands, at the document's current restore generation.
    const binding = parseLiveObjectBinding({...originalBinding,currentPath: row.current_path,restoreFenceGeneration: row.restore_fence_generation});
    requireFinishedRestoreBinding(this.#storage.db,this.#history.namespace,originalBinding,binding);
    const tip = this.#ownerTip(owner);
    const raw = this.#storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor>? ORDER BY journal_cursor LIMIT 1`)
      .get(...documentParams(document),tip?.journalCursor ?? 0);
    let next: LiveUpdateReceipt | null = null;
    if (raw) {
      const decoded = decodeJournalRow(this.#storage.db,raw); assertJournalCheckpointPosition(this.#storage.db,decoded); verifyJournalRow(decoded);
      next = decoded.admitted.metadata.accepted.receipt;
    }
    return {owner,binding,tip,next};
  }
  #ownerTip(row: Record<string, unknown>): LiveUpdateReceipt | null {
    const terminal = JSON.parse(String(row.tip_receipt_json)), parsed = terminal === null ? null : parseLiveUpdateReceipt(terminal);
    integrity((parsed?.journalCursor ?? 0) === row.tip_cursor);
    return parsed;
  }
  nextOwnerApplication(capture: OwnerDeliveryCapture): AdmittedLiveUpdate | undefined {
    const {document,highWater} = this.#ownerDelivery(capture), progress = this.ownerDeliveryProgress(capture);
    const raw = this.#storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT 1`)
      .get(...documentParams(document),progress.terminal?.journalCursor ?? 0,highWater);
    if (!raw) {integrity((progress.terminal?.journalCursor ?? 0) === highWater); return undefined;}
    const row = decodeJournalRow(this.#storage.db,raw); assertJournalCheckpointPosition(this.#storage.db,row); verifyJournalRow(row);
    return row.admitted;
  }
  acknowledgeOwnerDeliveryApplication(capture: OwnerDeliveryCapture,value: unknown): void {
    this.#acknowledgeOwnerApplication(capture,value);
  }
  #acknowledgeOwnerApplication(capture: OwnerDeliveryCapture,value: unknown,predecessor?: LiveUpdateReceipt | null): void {
    const ack = parseLiveUpdateHostApplicationAck(value), {host,document} = this.#ownerDelivery(capture);
    this.#storage.tx(() => {
      const acknowledged = {deliveryId: ack.deliveryId,updateDigest: ack.updateDigest,journalCursor: ack.journalCursor,acceptingHostEpoch: ack.acceptingHostEpoch};
      if (predecessor !== undefined) {
        const progress = this.ownerDeliveryProgress(capture);
        if (sameReceipt(progress.terminal,acknowledged)) {
          const row = this.#ownerRow(host,document); integrity(row && row.tip_application_sequence === ack.localYDocSequence);
          const previous = this.#storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor<? ORDER BY journal_cursor DESC LIMIT 1`)
            .get(...documentParams(document),ack.journalCursor);
          if (previous) {
            const decoded = decodeJournalRow(this.#storage.db,previous); assertJournalCheckpointPosition(this.#storage.db,decoded); verifyJournalRow(decoded);
            integrity(sameReceipt(decoded.admitted.metadata.accepted.receipt,predecessor));
          } else integrity(predecessor === null);
          return;
        }
        integrity(sameReceipt(progress.terminal,predecessor));
      }
      const next = this.nextOwnerApplication(capture); integrity(next);
      const receipt = next.metadata.accepted.receipt;
      integrity(sameReceipt(receipt,acknowledged));
      const row = this.#ownerRow(host,document); integrity(row);
      this.#advanceOwnerTip(host,document,row,receipt,ack);
    });
  }
  // Moves the owner tip to the next accepted receipt, whose ACK the caller matched.
  #advanceOwnerTip(host: LiveHostConnectionCoordinate,document: LiveDocumentKey,row: Record<string, unknown>,receipt: LiveUpdateReceipt,
    ack: ReturnType<typeof parseLiveUpdateHostApplicationAck>): void {
    // Content dedupe reports the original native update sequence. Retain the
    // greatest sequence already proved by an authenticated application ACK.
    const sequence = Math.max(authorityInteger(row.tip_sequence),ack.localYDocSequence);
    const tip = JSON.stringify(receipt), values = [this.#history.namespace,...documentParams(document),host.hostId,row.origin_json,tip,ack.journalCursor,sequence,ack.localYDocSequence];
    const charge = Buffer.byteLength(JSON.stringify(values)), previousCharge = authorityInteger(row.accounted_bytes,1), delta = Math.max(1,charge-previousCharge);
    consumeLiveDeliveryReservation(this.#storage,document,host.hostId,ack.journalCursor,delta,true);
    const refund = previousCharge + delta - charge; if (refund) this.#refundOwner(document.workspaceId,refund);
    const changed = this.#storage.db.prepare(`UPDATE ${OWNERS} SET tip_receipt_json=?,tip_cursor=?,tip_sequence=?,tip_application_sequence=?,accounted_bytes=? WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id=?`)
      .run(tip,ack.journalCursor,sequence,ack.localYDocSequence,charge,this.#history.namespace,...documentParams(document),host.hostId);
    integrity(changed.changes === 1);
  }
  captureOwnerBinding(input: {host: LiveHostConnectionCoordinate; document: LiveDocumentKey;
    actor: import("./types").CurrentLiveBindingRequest["actor"]}) {
    const host = snapshotHostCoordinate(input.host), document = journalDocument(input.document), actor = structuredClone(input.actor);
    const read = () => {
      this.#standing(host);
      const current = currentLiveDocumentBinding(this.#storage,{document,actor},this.activation);
      integrity(current.kind === "current" && isDeepStrictEqual(current.host,host));
      return current;
    };
    const initial = this.#storage.readTx(read);
    return {binding: structuredClone(initial.binding), assertCurrent: () => {
      integrity(isDeepStrictEqual(this.#storage.readTx(read),initial));
    }};
  }
  captureOwnerCut(input: { host: LiveHostConnectionCoordinate; document: LiveDocumentKey; adoptionId: string;
    expectedLocalSequence: number; maxBytes: number; maxEvents: number; throughCursor?: number;
    actor?: import("./types").CurrentLiveBindingRequest["actor"] }): OwnerCutCapture {
    const host = snapshotHostCoordinate(input.host), document = journalDocument(input.document);
    const adoptionId = parseLiveUpdateIdentifier(input.adoptionId, "adoption ID");
    const sequence = authorityInteger(input.expectedLocalSequence), maxBytes = authorityInteger(input.maxBytes, 1), maxEvents = authorityInteger(input.maxEvents, 1);
    const requestedCursor = input.throughCursor === undefined ? undefined : authorityInteger(input.throughCursor);
    const captured = this.#storage.readTx(() => {
      this.#standing(host);
      const result = liveJournalCut(this.#storage, document);
      if (result.kind !== "cut") throw new Error(`Owner adoption ${result.reason}.`);
      const authority = result.cut.authorityHistory.find(row => row.current)!;
      const authorized = input.actor ? currentLiveDocumentBinding(this.#storage,{document,actor: input.actor},this.activation) : undefined;
      if (authorized && (authorized.kind !== "current" || !isDeepStrictEqual(authorized.host,host))) throw new Error("Owner standing changed.");
      const source = this.#ownerSource(document,adoptionId,authority);
      // Without an actor, as when a retirement recovers an adoption whose ACK was lost, a service activation keeps the binding it was granted.
      const binding = authorized?.kind === "current" ? authorized.binding : source.activation?.binding ?? authority.binding;
      integrity(!source.activation || source.activation.source.nativeHeadSequence === sequence);
      const prefix = this.#retainedPrefix(source.activation?.source);
      const events: AdmittedLiveUpdate[] = [];
      let bytes = authority.baselineBytes.byteLength;
      if (prefix) {
        // A successor adopts at its predecessor's released boundary; ordinary delivery then brings what the journal accepted after it.
        // Before adoption the engine reports no cursor of its own.
        integrity(requestedCursor === undefined || requestedCursor === 0 || requestedCursor === (prefix.terminalReceipt?.journalCursor ?? 0));
      } else {
        const count = this.#storage.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(update_bytes)),0) AS bytes FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor<=?`).get(...documentParams(document),requestedCursor ?? Number.MAX_SAFE_INTEGER)!;
        if (authorityInteger(count.count) > maxEvents || authorityInteger(count.bytes) > maxBytes) throw new Error(`Owner adoption cut exceeds configured bounds: ${count.count} journal events / ${maxEvents} allowed; ${count.bytes} journal bytes / ${maxBytes} allowed.`);
        for (const raw of this.#storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor<=? ORDER BY journal_cursor`).iterate(...documentParams(document),requestedCursor ?? Number.MAX_SAFE_INTEGER)) {
          const row = decodeJournalRow(this.#storage.db, raw);
          assertJournalCheckpointPosition(this.#storage.db, row);
          verifyJournalRow(row);
          bytes += row.admitted.updateBytes.byteLength + Buffer.byteLength(JSON.stringify(row.admitted.metadata)) + 8;
          if (bytes > maxBytes || events.length === maxEvents) throw new Error("Owner adoption cut exceeds its configured bounds.");
          events.push(row.admitted);
        }
        integrity((events.at(-1)?.metadata.accepted.receipt.journalCursor ?? 0) === (requestedCursor ?? result.cut.highWater ?? 0) && events.length === count.count);
      }
      const terminal = prefix ? prefix.terminalReceipt : events.at(-1)?.metadata.accepted.receipt ?? null;
      const cut: LiveOwnerAdoptionCut = { relayDatabaseNamespace: this.#history.namespace, adoptionId,
        sourceMomentId: source.sourceMomentId, sourceDigest: source.sourceDigest,
        sourceByteLength: source.sourceByteLength, baselineMomentRelaySequence: authority.baselineSequence,
        baselineRegisteredAtMs: authority.registeredAtMs, expectedLocalSequence: sequence,
        terminalReceipt: terminal, retainedPrefix: prefix, baselineBytes: new Uint8Array(authority.baselineBytes), events };
      const { events: _events, baselineBytes: _baseline, ...header } = cut;
      if (bytes + Buffer.byteLength(JSON.stringify({ ...header, eventCount: events.length })) + 8 > maxBytes) throw new Error("Owner adoption cut exceeds its configured bounds.");
      return { journal: result.cut, authority: structuredClone(authority), binding: structuredClone(binding), source: { ...source }, cut };
    });
    verifyJournalCut(captured.journal);
    const assertCurrent = (): void => {
      this.#standing(host);
      const raw = this.#storage.db.prepare(`SELECT * FROM sync_relay_live_documents WHERE ${WHERE_DOCUMENT}`).get(...documentParams(document));
      integrity(raw && isDeepStrictEqual(decodeLiveDocumentAuthorityStructure(this.#storage.db, document, raw), captured.authority));
      const source = this.#ownerSource(document,adoptionId,captured.authority);
      integrity(isDeepStrictEqual(source, captured.source));
      if (input.actor) {
        const authorized = currentLiveDocumentBinding(this.#storage,{document,actor: input.actor},this.activation);
        integrity(authorized.kind === "current" && isDeepStrictEqual(authorized.binding,captured.binding) && isDeepStrictEqual(authorized.host,host));
      }
    };
    assertCurrent();
    const capture = { binding: structuredClone(captured.binding), cut: captured.cut, assertCurrent };
    this.#ownerCuts.set(capture,{ host,document,digest: ownerCutDigest(capture),activation: captured.source.activation?.source ?? null });
    return capture;
  }
  #ownerCapture(capture: OwnerCutCapture) {
    const saved = this.#ownerCuts.get(capture);
    integrity(saved && saved.digest === ownerCutDigest(capture));
    capture.assertCurrent();
    return saved;
  }
  #ownerRow(host: LiveHostConnectionCoordinate,document: LiveDocumentKey) {
    return this.#storage.db.prepare(`SELECT * FROM ${OWNERS} WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id=?`)
      .get(this.#history.namespace,...documentParams(document),host.hostId);
  }
  acknowledgeOwnerAdoption(capture: OwnerCutCapture, value: unknown): void {
    const { host,document,activation } = this.#ownerCapture(capture), cut = capture.cut;
    const ack = baselineRecord(value,["adoptionId","localYDocSequence","terminalCursor","adoptionReplayed"]);
    integrity(ack.adoptionId === cut.adoptionId && ack.localYDocSequence === cut.expectedLocalSequence && ack.terminalCursor === (cut.terminalReceipt?.journalCursor ?? 0) && typeof ack.adoptionReplayed === "boolean");
    // The evidence digest binds a successor's prefix, so the origin keeps only its count and history.
    const { baselineBytes: _baseline,events: _events,retainedPrefix: prefix,...header } = cut;
    const cutEvidenceDigest = ownerAdoptionCutEvidenceDigest(capture.binding, cut);
    // Native adoption of an ordinary service activation also binds its retained source, as native evidence does.
    const originEvidenceDigest = activation === null ? cutEvidenceDigest
      : createHash("sha256").update(JSON.stringify(["ordinary-replication", cutEvidenceDigest, activation])).digest("hex");
    const originEventCount = prefix ? prefix.eventCount : cut.events.length;
    const originHistoryEvidenceDigest = prefix ? prefix.historyEvidenceDigest : cut.events.reduce((previous, event, index) =>
      nextVersionedAcceptedHistoryDigest(previous, index + 1, event.metadata), initialAcceptedHistoryDigest(this.#history.namespace, document));
    const origin = JSON.stringify({ ...header,bindingDigest: createHash("sha256").update(JSON.stringify(capture.binding)).digest("hex"),
      originEvidenceDigest, originEventCount, originHistoryEvidenceDigest,originalBinding:structuredClone(capture.binding) });
    this.#storage.tx(() => {
      this.#ownerCapture(capture);
      if (cut.terminalReceipt) {
        const endpoint = this.#storage.db.prepare(`SELECT relay_database_namespace,accepted_event_count,accepted_evidence_digest FROM ${LIVE_JOURNAL_TABLE}
          WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`).get(...documentParams(document), cut.terminalReceipt.journalCursor);
        integrity(endpoint && endpoint.relay_database_namespace === this.#history.namespace && endpoint.accepted_event_count === originEventCount &&
          endpoint.accepted_evidence_digest === originHistoryEvidenceDigest);
      }
      bindLiveDeliveryHostNamespace(this.#storage,document.workspaceId,host.hostId,this.#history.namespace);
      integrity(!this.#storage.db.prepare(`SELECT 1 FROM ${BOOTSTRAPS} WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id=?`).get(this.#history.namespace,...documentParams(document),host.hostId));
      const previous = this.#ownerRow(host,document);
      if (previous) { integrity(previous.origin_json === origin && Number(previous.tip_cursor) >= Number(ack.terminalCursor)); return; }
      // A service activation adopts on one host, once: it retires only there.
      if (activation && this.#storage.db.prepare(`SELECT 1 FROM ${OWNERS} WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id<>?
          AND json_extract(origin_json,'$.adoptionId')=? LIMIT 1`).get(this.#history.namespace,...documentParams(document),host.hostId,cut.adoptionId)) {
        throw new Error("Service activation adopted on another host.");
      }
      const tip = JSON.stringify(cut.terminalReceipt), cursor = cut.terminalReceipt?.journalCursor ?? 0;
      const values = [this.#history.namespace,...documentParams(document),host.hostId,origin,tip,cursor,cut.expectedLocalSequence,cut.expectedLocalSequence];
      const charge = Buffer.byteLength(JSON.stringify(values));
      consumeLiveDeliveryReservation(this.#storage,document,host.hostId,0,charge,true);
      if (prefix) adoptLiveDeliveryPrefix(this.#storage,document,host.hostId,cursor);
      for (const event of cut.events) {
        consumeLiveDeliveryReservation(this.#storage,document,host.hostId,event.metadata.accepted.receipt.journalCursor,1,true);
        this.#refundOwner(document.workspaceId,1);
      }
      this.#storage.db.prepare(`INSERT INTO ${OWNERS}(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,host_id,origin_json,tip_receipt_json,tip_cursor,tip_sequence,tip_application_sequence,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values,charge);
    });
  }
  #refundOwner(workspaceId: string, amount: number) {
    integrity(this.#storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id=? AND usage_bytes>=?").run(amount,workspaceId,amount).changes === 1);
  }
  #standing(host: LiveHostConnectionCoordinate): void {
    requireLiveJournalHistory(this.#storage, this.#history);
    const standing = journalHost(this.#storage.db, host);
    if ("kind" in standing)
      throw new Error(`Committed delivery ${standing.reason}.`);
  }
  #capture(drain: CommittedDeliveryDrain): DrainCapture {
    const capture = this.#drains.get(drain);
    if (!capture) throw new TypeError("Unknown committed delivery drain.");
    this.#standing(capture.host);
    if (capture.restore) {
      this.#restore(capture.restore.lookup,capture.host,capture.restore.operation,capture.authority.baselineBytes);
      return capture;
    }
    const raw = this.#storage.db
      .prepare(
        `SELECT workspace_id,main_version_id,object_id,lineage_claim_id,current_path,
          restore_fence_generation,replaces_lineage_claim_id,registered_at_ms,lineage_state,
          admission_state,retired_at_ms,baseline_digest,baseline_projected_sha256,
          baseline_projected_byte_length,baseline_moment_relay_seq,baseline_bytes=? AS baseline_matches
          FROM sync_relay_live_documents WHERE ${WHERE_DOCUMENT}`,
      )
      .get(capture.authority.baselineBytes, ...documentParams(capture.document));
    integrity(raw && raw.baseline_matches === 1);
    const authority = decodeLiveDocumentAuthorityStructure(
      this.#storage.db,
      capture.document,
      { ...raw, baseline_bytes: capture.authority.baselineBytes },
    );
    integrity(isDeepStrictEqual(authority, capture.authority));
    if (capture.terminal) {
      const terminal = this.#storage.db
        .prepare(
          `SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`,
        )
        .get(
          ...documentParams(capture.document),
          capture.terminal.journalCursor,
        );
      integrity(terminal && sameReceipt(receipt(terminal), capture.terminal));
    }
    return capture;
  }
  #bootstrapRow(capture: DrainCapture): Record<string, unknown> {
    const row = this.#storage.db
      .prepare(`SELECT * FROM ${BOOTSTRAPS} WHERE ${WHERE_BOOTSTRAP}`)
      .get(
        this.#history.namespace,
        ...documentParams(capture.document),
        capture.host.hostId,
      );
    integrity(row);
    const b = capture.baseline;
    requireFinishedRestoreBinding(this.#storage.db,this.#history.namespace,parseLiveObjectBinding(JSON.parse(String(row.binding_json))),b.binding);
    integrity(
      row.bootstrap_id === b.bootstrapId &&
        row.bootstrap_moment_id === b.bootstrapMomentId &&
        row.baseline_digest === b.baselineDigest &&
        row.baseline_byte_length === b.baselineBytes.byteLength &&
        row.baseline_moment_relay_seq === b.baselineMomentRelaySequence &&
        row.baseline_registered_at_ms === b.baselineRegisteredAtMs &&
        row.projected_markdown_digest === b.projectedMarkdownDigest &&
        row.projected_markdown_byte_length === b.projectedMarkdownByteLength,
    );
    authorityInteger(row.accounted_bytes, 1);
    if (row.local_ydoc_sequence === null) {
      integrity(
        [
          row.ack_host_mode,
          row.ack_host_epoch,
          row.ack_instance_id,
          row.ack_connection_id,
        ].every((x) => x === null),
      );
    } else {
      authorityInteger(row.local_ydoc_sequence);
      snapshotHostCoordinate({
        mode: row.ack_host_mode,
        hostId: row.host_id,
        hostEpoch: row.ack_host_epoch,
        instanceId: row.ack_instance_id,
        connectionId: row.ack_connection_id,
      });
    }
    return row;
  }
  open(input: { host: LiveHostConnectionCoordinate; document: LiveDocumentKey }): CommittedDeliveryDrain {
    return this.#open(input, true);
  }
  openSettlement(input: { host: LiveHostConnectionCoordinate; document: LiveDocumentKey }): CommittedDeliveryDrain {
    return this.#open(input, false);
  }
  #open(input: {
    host: LiveHostConnectionCoordinate;
    document: LiveDocumentKey;
  }, createBootstrap: boolean): CommittedDeliveryDrain {
    const host = snapshotHostCoordinate(input.host),
      document = journalDocument(input.document);
    const read = this.#storage.readTx(() => {
      this.#standing(host);
      const cut = liveJournalCut(this.#storage, document);
      if (cut.kind !== "cut")
        throw new Error(`Committed delivery ${cut.reason}.`);
      const authority = cut.cut.authorityHistory.find((row) => row.current)!;
      const terminalRaw =
        cut.cut.highWater === null
          ? null
          : this.#storage.db
              .prepare(
                `SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`,
              )
              .get(...documentParams(document), cut.cut.highWater);
      integrity(cut.cut.highWater === null || terminalRaw);
      const terminal = terminalRaw
        ? decodeJournalRow(this.#storage.db, terminalRaw)
        : null;
      return { cut: cut.cut, authority, terminal };
    });
    verifyJournalCut(read.cut);
    if (read.terminal) verifyJournalRow(read.terminal);
    return this.#createDrain(host,document,read.authority,read.terminal?.admitted.metadata.accepted.receipt ?? null,createBootstrap);
  }
  #createDrain(host: LiveHostConnectionCoordinate,document: LiveDocumentKey,authority: StoredLiveDocumentAuthority,
    terminal: LiveUpdateReceipt | null,createBootstrap: boolean,restore?: DrainCapture["restore"]): CommittedDeliveryDrain {
    const baseline: CommittedBootstrap = {
      bootstrapId: randomUUID(),
      bootstrapMomentId: randomUUID(),
      binding: structuredClone(authority.binding),
      baselineMomentRelaySequence: authority.baselineSequence,
      baselineRegisteredAtMs: authority.registeredAtMs,
      baselineDigest: authority.baselineDigest,
      projectedMarkdownDigest: authority.projectedDigest,
      projectedMarkdownByteLength: authority.projectedLength,
      baselineBytes: new Uint8Array(authority.baselineBytes),
    };
    const capture: DrainCapture = {
      host,
      document,
      authority: structuredClone(authority),
      baseline,
      terminal,
      ...(restore ? {restore} : {}),
    };
    const drain: CommittedDeliveryDrain = Object.freeze({
      get baseline() {
        return copiedBaseline(capture.baseline);
      },
      get terminalReceipt() {
        return capture.terminal ? { ...capture.terminal } : null;
      },
    });
    this.#drains.set(drain, capture);
    try {
      this.#storage.tx(() => {
        this.#capture(drain);
        bindLiveDeliveryHostNamespace(this.#storage, document.workspaceId, host.hostId, this.#history.namespace);
        if (restore) integrity(!this.#ownerRow(host,document));
        const row = this.#storage.db
          .prepare(`SELECT * FROM ${BOOTSTRAPS} WHERE ${WHERE_BOOTSTRAP}`)
          .get(
            this.#history.namespace,
            ...documentParams(document),
            host.hostId,
          );
        if (row) {
          capture.baseline = {
            ...baseline,
            bootstrapId: parseLiveUpdateIdentifier(
              row.bootstrap_id,
              "bootstrap ID",
            ),
            bootstrapMomentId: parseLiveUpdateIdentifier(
              row.bootstrap_moment_id,
              "bootstrap moment ID",
            ),
          };
          this.#bootstrapRow(capture);
          return;
        }
        if (!createBootstrap) throw new Error("Committed delivery must finish before settlement.");
        // A retired owner adoption on this host consumed the lineage's adoption reservation and covers what it applied.
        if (this.#storage.db.prepare(`SELECT 1 FROM ${LIVE_DELIVERY_OWNER_HISTORY} WHERE ${WHERE_DOCUMENT} AND host_id=?`).get(...documentParams(document),host.hostId)) {
          throw new Error("Committed delivery follows a retired owner adoption.");
        }
        // A service activation's lineage is delivered only through its owner adoption, and is funded only for that.
        if (hasServiceActivation(this.#storage, document)) {
          throw new Error("Committed delivery cannot bootstrap a service activation's lineage.");
        }
        const values = [
          baseline.bootstrapId,
          baseline.bootstrapMomentId,
          this.#history.namespace,
          ...documentParams(document),
          host.hostId,
          JSON.stringify(baseline.binding),
          baseline.baselineMomentRelaySequence,
          baseline.baselineRegisteredAtMs,
          baseline.baselineDigest,
          baseline.baselineBytes.byteLength,
          baseline.projectedMarkdownDigest,
          baseline.projectedMarkdownByteLength,
        ];
        const charge = Buffer.byteLength(JSON.stringify(values));
        consumeLiveDeliveryReservation(this.#storage, document, host.hostId, 0, charge, false);
        this.#storage.db
          .prepare(
            `INSERT INTO ${BOOTSTRAPS}(bootstrap_id,bootstrap_moment_id,relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,host_id,
          binding_json,baseline_moment_relay_seq,baseline_registered_at_ms,baseline_digest,baseline_byte_length,projected_markdown_digest,projected_markdown_byte_length,accounted_bytes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(...values, charge);
        this.#bootstrapRow(capture);
      });
      return drain;
    } catch (error) {
      this.#drains.delete(drain);
      throw error;
    }
  }
  #nextReceipt(capture: DrainCapture, after: number): LiveUpdateReceipt | null {
    const row = this.#storage.db
      .prepare(
        `SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM ${LIVE_JOURNAL_TABLE}
      WHERE ${WHERE_DOCUMENT} AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT 1`,
      )
      .get(
        ...documentParams(capture.document),
        after,
        capture.terminal?.journalCursor ?? 0,
      );
    return row ? receipt(row) : null;
  }
  #progress(capture: DrainCapture): {
    bootstrap: Record<string, unknown>;
    predecessor: LiveUpdateReceipt | null;
  } {
    const bootstrap = this.#bootstrapRow(capture);
    const tip =
      this.#storage.db
        .prepare(
          `SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor<=? ORDER BY journal_cursor DESC LIMIT 1`,
        )
        .get(
          capture.baseline.bootstrapId,
          capture.terminal?.journalCursor ?? 0,
        ) ?? null;
    if (capture.progress && isDeepStrictEqual(tip, capture.progress.tip)) {
      return { bootstrap, predecessor: capture.progress.predecessor };
    }
    capture.checkpoint = undefined;
    const edges = this.#storage.db
      .prepare(
        `SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor<=? ORDER BY journal_cursor`,
      )
      .all(capture.baseline.bootstrapId, capture.terminal?.journalCursor ?? 0);
    if (bootstrap.local_ydoc_sequence === null) integrity(edges.length === 0);
    let predecessor: LiveUpdateReceipt | null = null;
    for (const edge of edges) {
      integrity(
        bootstrap.local_ydoc_sequence !== null &&
          edge.workspace_id === capture.document.workspaceId &&
          edge.predecessor_cursor === (predecessor?.journalCursor ?? 0),
      );
      const expected = this.#nextReceipt(
        capture,
        predecessor?.journalCursor ?? 0,
      );
      integrity(expected && sameReceipt(receipt(edge), expected));
      authorityInteger(edge.local_ydoc_sequence, 1);
      authorityInteger(edge.accounted_bytes, 1);
      snapshotHostCoordinate({
        mode: edge.ack_host_mode,
        hostId: capture.host.hostId,
        hostEpoch: edge.ack_host_epoch,
        instanceId: edge.ack_instance_id,
        connectionId: edge.ack_connection_id,
      });
      predecessor = expected;
    }
    capture.progress = { predecessor, tip };
    return { bootstrap, predecessor };
  }
  #checkpointPosition(
    capture: DrainCapture,
    row: ReturnType<typeof decodeJournalRow>,
  ): NonNullable<DrainCapture["checkpoint"]> {
    const restored=verifyRestoreCheckpoint(this.#storage.db,row);
    const current = row.admitted.metadata.accepted.receipt,
      prior = capture.checkpoint;
    const rowBytes = row.admitted.updateBytes.byteLength,
      hasCheckpoint = row.checkpoint !== null;
    if (prior && sameReceipt(prior.receipt, current)) {
      integrity(
        prior.rowBytes === rowBytes && prior.hasCheckpoint === hasCheckpoint,
      );
      return prior;
    }
    let position;
    if (
      prior &&
      sameReceipt(
        this.#nextReceipt(capture, prior.receipt.journalCursor),
        current,
      )
    ) {
      const count = (prior.hasCheckpoint ? 0 : prior.count) + 1;
      const bytes = (prior.hasCheckpoint ? 0 : prior.bytes) + rowBytes;
      integrity(
        count <= 4095 &&
          hasCheckpoint === (restored!==null || row.admitted.metadata.checkpointCoverage !== undefined || liveJournalCheckpointDue(count, bytes)),
      );
      position = { count, bytes };
    } else {
      position = assertJournalCheckpointPosition(this.#storage.db, row);
    }
    return { receipt: current, ...position, rowBytes, hasCheckpoint };
  }
  next(drain: CommittedDeliveryDrain): CommittedDeliveryStep {
    const result = this.#storage.readTx(() => {
      const capture = this.#capture(drain),
        progress = this.#progress(capture);
      if (progress.bootstrap.local_ydoc_sequence === null)
        return {
          kind: "bootstrap" as const,
          baseline: copiedBaseline(capture.baseline),
        };
      const next = this.#nextReceipt(
        capture,
        progress.predecessor?.journalCursor ?? 0,
      );
      if (!next) {
        integrity(sameReceipt(progress.predecessor, capture.terminal));
        return {
          kind: "done" as const,
          terminalReceipt: capture.terminal ? { ...capture.terminal } : null,
        };
      }
      const raw = this.#storage.db
        .prepare(
          `SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`,
        )
        .get(...documentParams(capture.document), next.journalCursor);
      integrity(raw);
      const row = decodeJournalRow(this.#storage.db, raw),
        checkpoint = this.#checkpointPosition(capture, row);
      return {
        kind: "next" as const,
        row,
        predecessor: progress.predecessor,
        capture,
        checkpoint,
      };
    });
    if (result.kind !== "next") return result;
    verifyJournalRow(result.row);
    result.capture.checkpoint = result.checkpoint;
    return {
      kind: "next",
      admitted: result.row.admitted,
      predecessor: result.predecessor ? { ...result.predecessor } : null,
    };
  }

  settlement(drain: CommittedDeliveryDrain): {
    binding: LiveObjectBinding;
    terminalReceipt: LiveUpdateReceipt | null;
  } {
    integrity(!this.#drains.get(drain)?.restore);
    const next = this.next(drain);
    if (next.kind !== "done") throw new Error("Committed delivery must finish before settlement.");
    const capture = this.#drains.get(drain)!;
    return { binding: structuredClone(capture.authority.binding), terminalReceipt: next.terminalReceipt };
  }

  #restore(lookup: StopRestoreLookup,host: LiveHostConnectionCoordinate,expected?: StopRestoreOperation,checkedBaseline?: Uint8Array) {
    this.#standing(host);
    const current = requireStopRestoreCut(this.#storage,lookup,checkedBaseline);
    integrity(current.operation.basis.namespace === this.#history.namespace &&
      current.operation.basis.hostMode === host.mode && current.operation.basis.hostId === host.hostId);
    if (expected) integrity(current.operation.phase === "fenced" && isDeepStrictEqual(current.operation,expected));
    return current;
  }

  openStopRestoreCut(input: StopRestoreLookup & {host: LiveHostConnectionCoordinate}):
    {kind: "waiting"} | {kind: "complete"; receipt: StopRestoreApplied} | {kind: "ready"; capture: StopRestoreCutCapture} {
    const lookup = {operationId: parseLiveUpdateIdentifier(input.operationId),workspaceId: parseLiveUpdateIdentifier(input.workspaceId),ownerUserId: parseLiveUpdateIdentifier(input.ownerUserId)};
    const host = snapshotHostCoordinate(input.host);
    const {operation,authority} = this.#storage.readTx(() => this.#restore(lookup,host));
    if (operation.phase === "old-cut-applied" || operation.phase === "native-fenced") {integrity(operation.applied); return {kind: "complete",receipt: structuredClone(operation.applied)};}
    const document = operation.intent.document;
    const saved: RestoreCapture = {lookup,host,operation,baselineBytes:authority.baselineBytes};
    if (operation.intent.deliveryKind === "owner") {
      const owner = this.#ownerRow(host,document);
      if (operation.basis.ownerOrigin === null) return {kind: "waiting"};
      integrity(owner && owner.origin_json === operation.basis.ownerOrigin);
      const originJson = String(owner.origin_json);
      requireStopRestoreOwnerOrigin(this.#storage,operation.basis);
      const assertCurrent = () => {
        this.#restore(lookup,host,operation,authority.baselineBytes);
        integrity(this.#ownerRow(host,document)?.origin_json === originJson);
      };
      const capture: OwnerDeliveryCapture = {binding: structuredClone(operation.basis.ownerBinding),assertCurrent};
      this.#ownerDeliveries.set(capture,{host,document,highWater: operation.cutoverCursor!});
      const progress = this.ownerDeliveryProgress(capture);
      integrity((progress.terminal?.journalCursor ?? 0) <= operation.cutoverCursor!);
      if (progress.terminal) {
        const raw = this.#storage.db.prepare(`SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`)
          .get(...documentParams(document),progress.terminal.journalCursor);
        integrity(raw && sameReceipt(receipt(raw),progress.terminal));
      }
      saved.owner = capture;
    } else {
      integrity(!this.#ownerRow(host,document));
      saved.drain = this.#createDrain(host,document,authority,operation.terminal,true,{lookup,operation});
    }
    const binding = structuredClone(operation.intent.deliveryKind === "owner" ? operation.basis.ownerBinding : operation.basis.binding);
    const capture: StopRestoreCutCapture = Object.freeze({get binding() {return structuredClone(binding);},
      deliveryKind: operation.intent.deliveryKind,
      resumeAdoptionId: operation.intent.deliveryKind === "owner" ? parseLiveUpdateIdentifier(JSON.parse(operation.basis.ownerOrigin!).adoptionId) : null});
    this.#restores.set(capture,saved);
    return {kind: "ready",capture};
  }
  #savedRestoreCapture(capture: StopRestoreCutCapture): RestoreCapture {
    const saved = this.#restores.get(capture);
    if (!saved) throw new TypeError("Unknown restore cut capture.");
    return saved;
  }
  nextStopRestoreCut(capture: StopRestoreCutCapture): CommittedDeliveryStep {
    const saved = this.#savedRestoreCapture(capture);
    if (saved.drain) return this.next(saved.drain);
    return this.#storage.readTx(() => {
      integrity(saved.owner);
      const progress = this.ownerDeliveryProgress(saved.owner), next = this.nextOwnerApplication(saved.owner);
      if (!next) {integrity(sameReceipt(progress.terminal,saved.operation.terminal)); return {kind: "done",terminalReceipt: progress.terminal};}
      return {kind: "next",admitted: next,predecessor: progress.terminal};
    });
  }
  acknowledgeStopRestoreBootstrap(capture: StopRestoreCutCapture,ack: unknown): void {
    const saved = this.#savedRestoreCapture(capture); integrity(saved.drain); this.acknowledgeBootstrap(saved.drain,ack);
  }
  acknowledgeStopRestoreApplication(capture: StopRestoreCutCapture,predecessor: LiveUpdateReceipt | null,ack: unknown): void {
    const saved = this.#savedRestoreCapture(capture);
    if (saved.drain) this.acknowledge(saved.drain,predecessor,ack);
    else {
      integrity(saved.owner && predecessor !== undefined);
      this.#acknowledgeOwnerApplication(saved.owner,ack,predecessor);
    }
  }
  completeStopRestoreCut(capture: StopRestoreCutCapture): StopRestoreApplied {
    const saved = this.#restores.get(capture);
    if (!saved) throw new TypeError("Unknown restore cut capture.");
    return this.#storage.tx(() => {
      const current = this.#restore(saved.lookup,saved.host,undefined,saved.baselineBytes);
      if (current.operation.phase === "old-cut-applied") {integrity(current.operation.applied); return structuredClone(current.operation.applied);}
      integrity(current.operation.phase === "fenced");
      let sourceId: string, localYDocSequence: number;
      if (saved.drain) {
        const drain = this.#capture(saved.drain), progress = this.#progress(drain);
        integrity(progress.bootstrap.local_ydoc_sequence !== null && sameReceipt(progress.predecessor,saved.operation.terminal));
        sourceId = drain.baseline.bootstrapId;
        const tip = drain.progress?.tip;
        localYDocSequence = authorityInteger(tip?.local_ydoc_sequence ?? progress.bootstrap.local_ydoc_sequence);
      } else {
        integrity(saved.owner);
        const progress = this.ownerDeliveryProgress(saved.owner), row = this.#ownerRow(saved.host,saved.operation.intent.document); integrity(row);
        integrity(sameReceipt(progress.terminal,saved.operation.terminal));
        sourceId = parseLiveUpdateIdentifier(JSON.parse(String(row.origin_json)).adoptionId);
        localYDocSequence = authorityInteger(row.tip_application_sequence);
      }
      const applied: StopRestoreApplied = {operationId:saved.lookup.operationId,
        binding: saved.operation.intent.deliveryKind === "owner" ? saved.operation.basis.ownerBinding : saved.operation.basis.binding,
        kind: saved.operation.intent.deliveryKind,namespace: this.#history.namespace,
        hostMode: saved.host.mode,hostId: saved.host.hostId,sourceId,localYDocSequence,terminal: saved.operation.terminal};
      const changed = this.#storage.db.prepare(`UPDATE ${LIVE_RESTORE_OPERATIONS} SET phase='old-cut-applied',applied_json=? WHERE relay_database_namespace=? AND operation_id=? AND workspace_id=? AND phase='fenced'`)
        .run(JSON.stringify(applied),this.#history.namespace,saved.lookup.operationId,saved.lookup.workspaceId);
      integrity(changed.changes === 1);
      return structuredClone(applied);
    });
  }
  captureStopRestoreOwnerOrigin(input: StopRestoreLookup & {
    host: LiveHostConnectionCoordinate; maxBytes: number; maxEvents: number;
  }, sharedBudget?: RestoreHistoryBudget): RestoreOwnerOriginCapture {
    const lookup = {operationId: parseLiveUpdateIdentifier(input.operationId), workspaceId: parseLiveUpdateIdentifier(input.workspaceId),
      ownerUserId: parseLiveUpdateIdentifier(input.ownerUserId)};
    const host = snapshotHostCoordinate(input.host), maxBytes = authorityInteger(input.maxBytes, 1), maxEvents = authorityInteger(input.maxEvents, 1);
    const budget = sharedBudget ?? new RestoreHistoryBudget(maxBytes, maxEvents);
    const read = () => {
      const baseline = this.#storage.db.prepare(`SELECT length(d.baseline_bytes) AS bytes FROM sync_relay_live_documents d
        JOIN ${LIVE_RESTORE_OPERATIONS} o USING(workspace_id,main_version_id,object_id,lineage_claim_id)
        WHERE o.relay_database_namespace=? AND o.operation_id=? AND o.workspace_id=?`).get(this.#history.namespace,lookup.operationId, lookup.workspaceId);
      integrity(baseline); budget.chargeBytes(authorityInteger(baseline.bytes, 1));
      const {operation, authority} = this.#restore(lookup, host);
      integrity(operation.phase === "native-fenced" && operation.nativeReceipt && operation.intent.deliveryKind === "owner");
      const document = operation.intent.document;
      const length = this.#storage.db.prepare(`SELECT length(CAST(origin_json AS BLOB)) AS bytes FROM ${OWNERS}
        WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id=?`).get(this.#history.namespace, ...documentParams(document), host.hostId);
      integrity(length); budget.chargeBytes(authorityInteger(length.bytes, 1) + Buffer.byteLength(JSON.stringify(operation.nativeReceipt)));
      const row = this.#ownerRow(host, document);
      integrity(row && operation.basis.ownerOrigin !== null && row.origin_json === operation.basis.ownerOrigin);
      requireStopRestoreOwnerOrigin(this.#storage, operation.basis);
      const raw = baselineRecord(JSON.parse(operation.basis.ownerOrigin), ["relayDatabaseNamespace", "adoptionId", "sourceMomentId",
        "sourceDigest", "sourceByteLength", "baselineMomentRelaySequence", "baselineRegisteredAtMs", "expectedLocalSequence", "terminalReceipt", "bindingDigest",
        "originEvidenceDigest", "originEventCount", "originHistoryEvidenceDigest", "originalBinding"]);
      const terminalReceipt = raw.terminalReceipt === null ? null : parseLiveUpdateReceipt(raw.terminalReceipt);
      const eventCount = authorityInteger(raw.originEventCount), historyEvidenceDigest = parseLiveUpdateDigest(raw.originHistoryEvidenceDigest);
      integrity((eventCount === 0) === (terminalReceipt === null) && (terminalReceipt?.journalCursor ?? 0) <= operation.cutoverCursor! && raw.adoptionId === operation.applied?.sourceId);
      const verifyEndpoint = () => {
        if (!terminalReceipt) {integrity(historyEvidenceDigest === initialAcceptedHistoryDigest(this.#history.namespace, document)); return;}
        const endpoint = this.#storage.db.prepare(`SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch,relay_database_namespace,
          accepted_event_count,accepted_evidence_digest FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`)
          .get(...documentParams(document), terminalReceipt.journalCursor);
        integrity(endpoint && endpoint.relay_database_namespace === this.#history.namespace && endpoint.accepted_event_count === eventCount &&
          endpoint.accepted_evidence_digest === historyEvidenceDigest && sameReceipt(parseLiveUpdateReceipt({deliveryId: endpoint.delivery_id,
            updateDigest: endpoint.update_digest, journalCursor: endpoint.journal_cursor, acceptingHostEpoch: endpoint.accepting_host_epoch}), terminalReceipt));
      };
      verifyEndpoint();
      return {operation, baselineBytes: authority.baselineBytes, verifyEndpoint, origin: {binding: parseLiveObjectBinding(raw.originalBinding),
        adoptionId: parseLiveUpdateIdentifier(raw.adoptionId), expectedLocalSequence: authorityInteger(raw.expectedLocalSequence),
        eventCount, terminalReceipt, historyEvidenceDigest, evidenceDigest: parseLiveUpdateDigest(raw.originEvidenceDigest)}};
    };
    const saved = this.#storage.readTx(read);
    const capture: RestoreOwnerOriginCapture = Object.freeze({...saved.origin, nativeReceipt: structuredClone(saved.operation.nativeReceipt!),
      point: {journalCursor: saved.operation.intent.restorePointCursor, receiptDigest: saved.operation.intent.restorePointReceiptDigest}, assertCurrent: () => {
        this.#storage.captureStanding();integrity(fingerprint === digest());
        integrity(isDeepStrictEqual(this.#restore(lookup, host, undefined, saved.baselineBytes).operation, saved.operation));
        integrity(this.#ownerRow(host, saved.operation.intent.document)?.origin_json === saved.operation.basis.ownerOrigin);
        requireStopRestoreOwnerOrigin(this.#storage, saved.operation.basis);
        saved.verifyEndpoint();
      }});
    const digest = () => createHash("sha256").update(JSON.stringify(capture)).digest("hex"), fingerprint = digest();
    this.#storage.readTx(() => capture.assertCurrent());return capture;
  }
  captureStopRestorePoint(input: StopRestoreLookup & {
    host: LiveHostConnectionCoordinate; maxBytes: number; maxEvents: number;
  }): RestoreHistoryCapture<"selected"> {
    return this.#captureRestoreHistory(input, "selected");
  }
  /** Resolves the selected point in `validator`. Its `assertCurrent` checks the evidence in a read transaction. */
  async resolveStopRestorePoint(input: StopRestoreLookup & {
    host: LiveHostConnectionCoordinate; maxBytes: number; maxEvents: number;
  }, validator: LiveRestoreValidator, signal?: AbortSignal) {
    const selected = this.captureStopRestorePoint(input);
    const assertCurrent = () => this.#storage.readTx(() => selected.assertCurrent());
    return {point: await validator.point({...selected, assertCurrent}, signal), assertCurrent};
  }
  async recordStopRestoreProposal(input: RestoreProposalInput,
    bytes: Uint8Array, validator: LiveRestoreValidator, now: number, signal?: AbortSignal) {
    const budget = {maxBytes: authorityInteger(input.maxBytes, 1), maxEvents: authorityInteger(input.maxEvents, 1)};
    const request = {operationId: parseLiveUpdateIdentifier(input.operationId), workspaceId: parseLiveUpdateIdentifier(input.workspaceId),
      ownerUserId: parseLiveUpdateIdentifier(input.ownerUserId), host: snapshotHostCoordinate(input.host), ...budget};
    const at = authorityInteger(now), decoded = decodeNativeRestoreProposal(bytes, budget);
    const {capture, assertCurrentInTransaction} = this.#captureStopRestoreProposal(request, decoded.receiptJson,decoded.bytes.nativeSourceBytes);
    const content = await validator.proposal(capture, decoded.bytes, budget, signal);
    const assertTailCurrent = captureSqliteReadRevision(this.#storage.db);
    const proposalDigest = createHash("sha256").update(decoded.captured).digest("hex");
    const operationId = capture.receipt.fence.operation.operationId, workspaceId = capture.selected.binding.workspaceId;
    const charge = proposalCharge(decoded.captured.byteLength, operationId, workspaceId, proposalDigest, content.content.candidateDigest, at,this.#history.namespace);
    const replayMatches=this.#storage.readTx(()=>{
      const header=this.#storage.db.prepare(`SELECT length(proposal_bytes) AS bytes FROM ${LIVE_RESTORE_PROPOSALS} WHERE relay_database_namespace=? AND operation_id=?`)
        .get(this.#history.namespace,operationId);
      if (!header) return false;
      integrity(authorityInteger(header.bytes,1)<=budget.maxBytes);
      const row=this.#storage.db.prepare(`SELECT proposal_bytes FROM ${LIVE_RESTORE_PROPOSALS} WHERE relay_database_namespace=? AND operation_id=?`)
        .get(this.#history.namespace,operationId)!;
      integrity(row.proposal_bytes instanceof Uint8Array);
      return Buffer.compare(row.proposal_bytes,decoded.captured)===0;
    });
    return this.#storage.tx(() => {
      assertTailCurrent();
      assertCurrentInTransaction();
      const old = this.#storage.db.prepare(`SELECT workspace_id,proposal_sha256,candidate_sha256,recorded_at_ms,accounted_bytes,record_sha256,length(proposal_bytes) AS bytes
        FROM ${LIVE_RESTORE_PROPOSALS} WHERE relay_database_namespace=? AND operation_id=?`).get(this.#history.namespace,operationId);
      if (old) {
        integrity(old.workspace_id === workspaceId && old.proposal_sha256 === proposalDigest && old.candidate_sha256 === content.content.candidateDigest && old.bytes === decoded.captured.byteLength);
        const recordedAtMs = authorityInteger(old.recorded_at_ms);
        integrity(old.accounted_bytes === proposalCharge(decoded.captured.byteLength, operationId, workspaceId, proposalDigest, content.content.candidateDigest, recordedAtMs,this.#history.namespace));
        integrity(old.record_sha256 === proposalRecordDigest(operationId, workspaceId, proposalDigest, content.content.candidateDigest, recordedAtMs, authorityInteger(old.accounted_bytes, 1),this.#history.namespace));
        integrity(replayMatches);
        return {proposalDigest, candidateDigest: content.content.candidateDigest, recordedAtMs, replayed: true};
      }
      assertWorkspaceQuota(this.#storage, workspaceId, charge);
      const recordDigest = proposalRecordDigest(operationId, workspaceId, proposalDigest, content.content.candidateDigest, at, charge,this.#history.namespace);
      const changed = this.#storage.db.prepare(`INSERT INTO ${LIVE_RESTORE_PROPOSALS}(relay_database_namespace,operation_id,workspace_id,proposal_bytes,proposal_sha256,candidate_sha256,recorded_at_ms,accounted_bytes,record_sha256)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(this.#history.namespace,operationId, workspaceId, decoded.captured, proposalDigest, content.content.candidateDigest, at, charge, recordDigest);
      integrity(changed.changes === 1);
      const usage = this.#storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge, workspaceId);
      integrity(usage.changes === 1);
      return {proposalDigest, candidateDigest: content.content.candidateDigest, recordedAtMs: at, replayed: false};
    });
  }
  async readStopRestoreProposal(input: RestoreProposalInput, validator: LiveRestoreValidator, signal?: AbortSignal) {
    const prepared = await this.#prepareStopRestoreProposal(input, validator, signal);
    return prepared ? {...prepared.saved, receipt: prepared.capture.receipt} : null;
  }
  /** With `maxOutputBytes`, validation also projects the owner review. */
  async #prepareStopRestoreProposal(input: RestoreProposalInput, validator: LiveRestoreValidator, signal: AbortSignal | undefined,
    maxOutputBytes?: number, reads?: RestoreAdmissionReads): Promise<PreparedRestoreProposal | null> {
    const read = () => this.#captureStopRestoreProposalInput(input);
    const prepared = reads ? reads.capture(read) : read();
    if (!prepared) return null;
    const {saved, decoded, budget} = prepared;
    const original = prepared.capture;
    const assertCurrentInTransaction = reads ? () => reads.assertCurrent() : prepared.assertCurrentInTransaction;
    const capture = reads ? {...original, selected: {...original.selected,
      artifact: (digest: string) => reads.capture(() => original.selected.artifact(digest))},
      assertCurrent: () => this.#storage.readTx(assertCurrentInTransaction)} : original;
    const validated = await validator.proposal(capture, decoded.bytes, {...budget,
      ...(maxOutputBytes === undefined ? {} : {maxOutputBytes}), ...(reads ? {admission: true} : {})}, signal);
    integrity(validated.content.candidateDigest === saved.candidateDigest);
    return {saved, capture, validated, assertCurrentInTransaction};
  }
  #captureStopRestoreProposalInput(input: RestoreProposalInput) {
    const lookup = {operationId: parseLiveUpdateIdentifier(input.operationId), workspaceId: parseLiveUpdateIdentifier(input.workspaceId),
      ownerUserId: parseLiveUpdateIdentifier(input.ownerUserId)}, host = snapshotHostCoordinate(input.host);
    const budget = {maxBytes: authorityInteger(input.maxBytes, 1), maxEvents: authorityInteger(input.maxEvents, 1)};
    const saved = this.#storage.readTx(() => {
      this.#restore(lookup, host);
      const header = this.#storage.db.prepare(`SELECT workspace_id,length(proposal_bytes) AS bytes FROM ${LIVE_RESTORE_PROPOSALS} WHERE relay_database_namespace=? AND operation_id=?`).get(this.#history.namespace,lookup.operationId);
      if (!header) return null;
      integrity(header.workspace_id === lookup.workspaceId);
      if (authorityInteger(header.bytes, 1) > budget.maxBytes) throw new Error("Stored restore proposal exceeds configured bounds.");
      const row = this.#storage.db.prepare(`SELECT * FROM ${LIVE_RESTORE_PROPOSALS} WHERE relay_database_namespace=? AND operation_id=?`).get(this.#history.namespace,lookup.operationId)!;
      integrity(row.proposal_bytes instanceof Uint8Array && row.proposal_bytes.byteLength === header.bytes);
      const proposalDigest = parseLiveUpdateDigest(row.proposal_sha256), candidateDigest = parseLiveUpdateDigest(row.candidate_sha256), recordedAtMs = authorityInteger(row.recorded_at_ms);
      integrity(row.accounted_bytes === proposalCharge(row.proposal_bytes.byteLength, lookup.operationId, lookup.workspaceId, proposalDigest, candidateDigest, recordedAtMs,this.#history.namespace));
      integrity(row.record_sha256 === proposalRecordDigest(lookup.operationId, lookup.workspaceId, proposalDigest, candidateDigest, recordedAtMs, authorityInteger(row.accounted_bytes, 1),this.#history.namespace));
      return {bytes: new Uint8Array(row.proposal_bytes), proposalDigest, candidateDigest, recordedAtMs};
    });
    if (!saved) return null;
    integrity(createHash("sha256").update(saved.bytes).digest("hex") === saved.proposalDigest);
    const decoded = decodeNativeRestoreProposal(saved.bytes, budget);
    const proposalCurrent = () => {
      const row = this.#storage.db.prepare(`SELECT workspace_id,proposal_sha256,candidate_sha256,recorded_at_ms,length(proposal_bytes) AS bytes
        FROM ${LIVE_RESTORE_PROPOSALS} WHERE relay_database_namespace=? AND operation_id=?`).get(this.#history.namespace,lookup.operationId);
      integrity(row && row.workspace_id === lookup.workspaceId && row.proposal_sha256 === saved.proposalDigest &&
        row.candidate_sha256 === saved.candidateDigest && row.recorded_at_ms === saved.recordedAtMs && row.bytes === saved.bytes.byteLength);
      // The length matched above, so this comparison reads no more than the bytes validation already charged.
      const stored = this.#storage.db.prepare(`SELECT proposal_bytes=? AS proposal_matches FROM ${LIVE_RESTORE_PROPOSALS}
        WHERE relay_database_namespace=? AND operation_id=?`).get(saved.bytes, this.#history.namespace, lookup.operationId);
      integrity(stored?.proposal_matches === 1);
    };
    const {capture, assertCurrentInTransaction} = this.#captureStopRestoreProposal({...lookup, host, ...budget}, decoded.receiptJson,
      decoded.bytes.nativeSourceBytes, proposalCurrent);
    return {saved, capture, decoded, budget, assertCurrentInTransaction};
  }
  captureStopRestoreProposal(input: RestoreProposalInput, receiptJson: string) {
    return this.#captureStopRestoreProposal(input, receiptJson).capture;
  }
  /** Private complete projection only. Reading it does not authorize replacement or resume. */
  async readStopRestoreReview(input: RestoreProposalInput & {maxOutputBytes: number}, validator: LiveRestoreValidator, signal?: AbortSignal) {
    return (await this.#prepareStopRestoreReview(input, validator, signal))?.review ?? null;
  }
  async #prepareStopRestoreReview(input: RestoreProposalInput & {maxOutputBytes: number}, validator: LiveRestoreValidator, signal: AbortSignal | undefined, reads?: RestoreAdmissionReads) {
    const request = lifecycleInput(input), maxOutputBytes = authorityInteger(input.maxOutputBytes, 1);
    const prepared = await this.#prepareStopRestoreProposal(request, validator, signal, maxOutputBytes, reads);
    if (!prepared) return null;
    const {saved, capture, validated, assertCurrentInTransaction} = prepared;
    const historyBudget = () => {
      const budget = new RestoreHistoryBudget(request.maxBytes, request.maxEvents);
      budget.chargeBytes(saved.bytes.byteLength);
      budget.chargeEvents(capture.receipt.selectedHistory.suffix.length + capture.receipt.acceptedHistory.suffix.length);
      return budget;
    };
    const readHistory = (budget: RestoreHistoryBudget) => this.#storage.readTx(() => {
      assertCurrentInTransaction(); this.#restore(request, request.host);
      return readRestoreReviewHistory(this.#storage, {document: capture.selected.binding,
        namespace: this.#history.namespace, proposalDigest: saved.proposalDigest, receipt: capture.receipt}, budget);
    });
    const budget = historyBudget();
    const content = validated.review;
    integrity(content);
    const history = reads ? reads.capture(() => readRestoreReviewHistory(this.#storage, {document: capture.selected.binding,
      namespace: this.#history.namespace, proposalDigest: saved.proposalDigest, receipt: capture.receipt}, budget)) : readHistory(budget);
    const review = {operationId: request.operationId, workspaceId: request.workspaceId, binding: capture.selected.binding,
      proposalDigest: saved.proposalDigest, candidateDigest: saved.candidateDigest, recordedAtMs: saved.recordedAtMs,
      point: capture.receipt.point, frozenTerminal: capture.receipt.acceptedHistory.terminal,
      selectedEventCount: capture.receipt.selectedHistory.eventCount, acceptedEventCount: capture.receipt.acceptedHistory.eventCount,
      selectedHistoryDigest: capture.receipt.selectedHistory.evidenceDigest, acceptedHistoryDigest: capture.receipt.acceptedHistory.evidenceDigest,
      nativeSourceManifestDigest: capture.receipt.nativeSourceManifestDigest, content, ...history};
    const outputBytes = Buffer.byteLength(JSON.stringify(review));
    if (outputBytes > maxOutputBytes) throw new Error("Restore review exceeds its output budget.");
    budget.chargeBytes(outputBytes);
    return {review, prepared};
  }
  /** `proposalCurrent` checks any stored proposal the receipt came from along with the rest of the evidence. */
  #captureStopRestoreProposal(input: RestoreProposalInput, receiptJson: string,ownedSourceBytes?:readonly Uint8Array[], proposalCurrent?: () => void) {
    const lookup = {operationId: parseLiveUpdateIdentifier(input.operationId), workspaceId: parseLiveUpdateIdentifier(input.workspaceId),
      ownerUserId: parseLiveUpdateIdentifier(input.ownerUserId)}, host = snapshotHostCoordinate(input.host);
    const budget = {maxBytes: authorityInteger(input.maxBytes, 1), maxEvents: authorityInteger(input.maxEvents, 1)};
    const receipt = parseNativeRestoreProposalReceipt(receiptJson, budget);
    const request = {...lookup, host, ...budget};
    const historyBudget = new RestoreHistoryBudget(budget.maxBytes, budget.maxEvents);
    historyBudget.chargeBytes(Buffer.byteLength(receiptJson));
    historyBudget.chargeEvents(receipt.nativeSources.length);
    const selected = this.#captureRestoreHistory(request, "selected", historyBudget), accepted = this.#captureRestoreHistory(request, "accepted", historyBudget);
    requireAcceptedHistoryProof(selected.proof, receipt.selectedHistory);
    requireAcceptedHistoryProof(accepted.proof, receipt.acceptedHistory);
    integrity(isDeepStrictEqual(receipt.fence, selected.nativeReceipt) && isDeepStrictEqual(selected.nativeReceipt, accepted.nativeReceipt));
    integrity(receipt.point.journalCursor === selected.point.journalCursor && receipt.point.receiptDigest === selected.point.receiptDigest);
    const ownerOrigin = receipt.fence.operation.origin.kind === "owner" ? this.captureStopRestoreOwnerOrigin(request, historyBudget) : null;
    for (const source of receipt.nativeSources) {
      if ("adoptionId" in source.source && source.source.origin.kind === "adoptionSeed") integrity(ownerOrigin && source.source.nativeSequence === ownerOrigin.expectedLocalSequence);
    }
    // Artifact reads later charge the shared budget; every source check gets what was left at capture.
    const sourceBytes = historyBudget.bytes, sourceEvents = historyBudget.events;
    const verifySources = () => {
      const operation=readStopRestoreInTransaction(this.#storage,lookup);integrity(operation);
      integrity(operation.phase === "native-fenced" && isDeepStrictEqual(operation.nativeReceipt, receipt.fence));
      const through = operation.terminal?.journalCursor ?? 0, document = operation.intent.document;
      const sourceBudget = new RestoreHistoryBudget(sourceBytes, sourceEvents);
      for (const [index,source] of receipt.nativeSources.entries()) {
        const lookup={document,namespace:operation.basis.namespace,through,eventCount:accepted.proof.eventCount,deliveryId:source.deliveryId};
        const metadata=ownedSourceBytes?revalidateAcceptedHistoryDelivery(this.#storage,lookup,sourceBudget,ownedSourceBytes[index]!):readAcceptedHistoryDelivery(this.#storage,lookup,sourceBudget);
        if (!metadata) {integrity(source.acceptedReceipt === null); continue;}
        integrity(isDeepStrictEqual(source.acceptedReceipt, metadata.accepted.receipt) && metadata.accepted.authority.principalKind === "owner" &&
          metadata.accepted.receipt.updateDigest === source.updateDigest &&
          nativeSourceAuthorMatches(this.#storage, source, metadata, sourceBudget));
      }
      integrity(sameReceipt(accepted.proof.terminal, operation.terminal));
      let origin: unknown;
      if (ownerOrigin) {
        ownerOrigin.assertCurrent();
      } else {
        const b = this.#storage.db.prepare(`SELECT * FROM ${BOOTSTRAPS} WHERE bootstrap_id=?`).get(operation.applied!.sourceId);
        integrity(b && b.relay_database_namespace === operation.basis.namespace && b.workspace_id === lookup.workspaceId &&
          b.object_id === document.objectId && b.lineage_claim_id === document.lineageClaimId && b.host_id === host.hostId);
        requireFinishedRestoreBinding(this.#storage.db,this.#history.namespace,parseLiveObjectBinding(JSON.parse(String(b.binding_json))),receipt.fence.operation.oldBinding);
        origin = {bootstrapId: b.bootstrap_id, bootstrapMomentId: b.bootstrap_moment_id,
          baselineMomentRelaySequence: b.baseline_moment_relay_seq, baselineRegisteredAtMs: b.baseline_registered_at_ms,
          baselineDigest: b.baseline_digest, baselineByteLength: b.baseline_byte_length,
          projectedMarkdownDigest: b.projected_markdown_digest, projectedMarkdownByteLength: b.projected_markdown_byte_length};
      }
      integrity((ownerOrigin?.evidenceDigest ?? createHash("sha256").update(JSON.stringify(origin)).digest("hex")) === receipt.originEvidenceDigest);
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    this.#storage.readTx(() => {verifySources();selected.assertCurrent();accepted.assertCurrent();});
    // Compares only this restore's evidence, so writes elsewhere in the relay never refuse it.
    const assertCurrentInTransaction = () => {
      this.#storage.captureStanding();
      try {
        integrity(createHash("sha256").update(JSON.stringify(receipt)).digest("hex")===fingerprint);
        selected.assertCurrent();accepted.assertCurrent();verifySources();proposalCurrent?.();
      } catch (cause) {throw new Error("Relay evidence changed during validation.", {cause});}
    };
    const assertCurrent = () => this.#storage.readTx(assertCurrentInTransaction);
    return {capture: Object.freeze({receipt, selected, accepted, ownerOrigin, assertCurrent}), assertCurrentInTransaction};
  }
  captureStopRestoreAcceptedCut(input: StopRestoreLookup & {
    host: LiveHostConnectionCoordinate; maxBytes: number; maxEvents: number;
  }): RestoreHistoryCapture<"accepted"> {
    return this.#captureRestoreHistory(input, "accepted");
  }
  #captureRestoreHistory<Target extends "selected" | "accepted">(input: StopRestoreLookup & {
    host: LiveHostConnectionCoordinate; maxBytes: number; maxEvents: number;
  }, target: Target, sharedBudget?: RestoreHistoryBudget): RestoreHistoryCapture<Target> {
    const lookup = {operationId: parseLiveUpdateIdentifier(input.operationId), workspaceId: parseLiveUpdateIdentifier(input.workspaceId),
      ownerUserId: parseLiveUpdateIdentifier(input.ownerUserId)};
    const host = snapshotHostCoordinate(input.host), maxBytes = authorityInteger(input.maxBytes, 1), maxEvents = authorityInteger(input.maxEvents, 1);
    const budget = sharedBudget ?? new RestoreHistoryBudget(maxBytes, maxEvents);
    const saved = this.#storage.readTx(() => {
      const baseline = this.#storage.db.prepare(`SELECT length(d.baseline_bytes) AS bytes FROM sync_relay_live_documents d
        JOIN ${LIVE_RESTORE_OPERATIONS} o USING(workspace_id,main_version_id,object_id,lineage_claim_id)
        WHERE o.operation_id=? AND o.workspace_id=?`).get(lookup.operationId, lookup.workspaceId);
      integrity(baseline); budget.chargeBytes(authorityInteger(baseline.bytes, 1));
      const {operation, authority} = this.#restore(lookup, host);
      integrity(operation.phase === "native-fenced" && operation.nativeReceipt);
      budget.chargeBytes(Buffer.byteLength(JSON.stringify(operation.nativeReceipt)));
      const point = target === "selected"
        ? {journalCursor: operation.intent.restorePointCursor, receiptDigest: operation.intent.restorePointReceiptDigest}
        : {journalCursor: operation.terminal?.journalCursor ?? 0, receiptDigest: operation.terminal?.updateDigest ?? authority.baselineDigest};
      const binding = operation.intent.deliveryKind === "owner" ? operation.basis.ownerBinding : operation.basis.binding;
      integrity(binding);
      // History with no checkpoint starts where the lineage registered, at generation 1, not at this binding's.
      // A restore declined after its fence moves the generation without a checkpoint.
      const historyInput = {document: operation.intent.document, namespace: operation.basis.namespace, through: point.journalCursor,
        baseline: authority.baselineBytes, baselineDigest: authority.baselineDigest, originBinding: {...binding, restoreFenceGeneration: 1}};
      const history = readAcceptedHistory(this.#storage, historyInput, budget);
      integrity((history.proof.terminal?.updateDigest ?? authority.baselineDigest) === point.receiptDigest);
      return {operation, binding, historyInput, ...history, point};
    });
    const chargedArtifacts = new Set<string>();
    // Each answered digest, and whether this object's artifact history held it.
    const answers = new Map<string, boolean>();
    const stored = (digest: string) => this.#storage.db.prepare(`SELECT b.sha256,b.byte_length,length(b.content) AS actual FROM sync_relay_object_moments m
      JOIN sync_relay_blobs b ON b.workspace_id=m.workspace_id AND b.sha256=m.blob_sha256
      WHERE m.workspace_id=? AND m.version_id=? AND m.object_id=? AND m.path=? AND m.content_kind='text' AND m.blob_sha256=?
      AND b.byte_length<=2097152 ORDER BY m.relay_seq LIMIT 1`)
      .get(saved.binding.workspaceId,saved.binding.mainVersionId,saved.binding.objectId,saved.binding.currentPath,digest);
    const capture: RestoreHistoryCapture<Target> = Object.freeze({target, binding: structuredClone(saved.binding), checkpoint: saved.checkpoint,
      artifact: (digest: string) => this.#storage.readTx(() => {
        capture.assertCurrent();
        parseLiveUpdateDigest(digest);
        const row = stored(digest);
        if (!row) {answers.set(digest, false); return undefined;}
        integrity(row.byte_length===row.actual);
        if (!chargedArtifacts.has(digest)) {budget.chargeBytes(authorityInteger(row.actual)); chargedArtifacts.add(digest);}
        const blob = this.#storage.db.prepare("SELECT content FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?")
          .get(saved.binding.workspaceId,digest);
        integrity(blob?.content instanceof Uint8Array && blob.content.length===row.byte_length &&
          createHash("sha256").update(blob.content).digest("hex")===digest);
        answers.set(digest, true);
        return new Uint8Array(blob.content);
      }),
      events: saved.events, proof: saved.proof, point: saved.point,
      nativeReceipt: structuredClone(saved.operation.nativeReceipt!), assertCurrent: () => {
        this.#storage.captureStanding();
        integrity(fingerprint === digest());
        integrity(isDeepStrictEqual(this.#restore(lookup, host, undefined, saved.historyInput.baseline).operation, saved.operation));
        const current = readAcceptedHistory(this.#storage, saved.historyInput, new RestoreHistoryBudget(maxBytes, maxEvents));
        integrity(isDeepStrictEqual(current.proof, saved.proof) && current.checkpoint.digest === saved.checkpoint.digest);
        for (const [digest, present] of answers) {
          if ((stored(digest) !== undefined) !== present) throw new Error("Relay evidence changed during validation.");
        }
      }});
    const digest = () => createHash("sha256").update(JSON.stringify({target: capture.target, binding: capture.binding, proof: capture.proof,
      checkpoint: {...capture.checkpoint, bytes: undefined, actualDigest: createHash("sha256").update(capture.checkpoint.bytes).digest("hex")},
      point: capture.point, nativeReceipt: capture.nativeReceipt,
      events: capture.events.map(event => ({metadata: event.metadata, digest: createHash("sha256").update(event.updateBytes).digest("hex")}))})).digest("hex");
    const fingerprint = digest();
    this.#storage.readTx(() => capture.assertCurrent());
    return capture;
  }
  #readLifecycle(input: RestoreProposalInput) {
    const host=snapshotHostCoordinate(input.host);
    this.#standing(host);
    requireRestoreLifecycleBudget(this.#storage.db,this.#history.namespace,input.operationId,input.workspaceId,input.maxBytes);
    const operation=readStopRestoreInTransaction(this.#storage,input);integrity(operation);
    integrity(operation.basis.namespace===this.#history.namespace && operation.basis.hostId===host.hostId && operation.basis.hostMode===host.mode);
    const saved=retainedRestoreLifecycle(this.#storage.db,this.#history.namespace,input.operationId,input.maxBytes);
    if (!saved) {integrity(!["relay-admitted","native-applied","settled","resumed"].includes(operation.phase));return null;}
    integrity(saved.lifecycle.phase===operation.phase);
    const raw=this.#storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE relay_database_namespace=? AND restore_operation_id=?`)
      .get(this.#history.namespace,input.operationId);integrity(raw);
    const journal=decodeJournalRow(this.#storage.db,raw);
    integrity(journal.checkpoint && journal.checkpoint.digest===saved.admission.checkpointDigest && isDeepStrictEqual(journal.admitted.metadata,saved.lifecycle.admitted));
    return {...saved,operation,journal,host};
  }
  readStopRestoreLifecycle(input: RestoreProposalInput): RestoreLifecycle|null {
    input=lifecycleInput(input);
    const saved=this.#storage.readTx(()=>this.#readLifecycle(input));
    if (!saved) return null;
    verifyJournalRow(saved.journal);
    return structuredClone(saved.lifecycle);
  }
  #activeLifecycle(saved: {operation:StopRestoreOperation;lifecycle:RestoreLifecycle}) {
    const {operation,lifecycle}=saved,document=operation.intent.document;
    const row=this.#storage.db.prepare(`SELECT restore_fence_generation,current_path,lineage_state,admission_state FROM sync_relay_live_documents WHERE ${WHERE_DOCUMENT}`)
      .get(...documentParams(document));
    // current_path is the lineage's registered path. A rename after admission doesn't end the restore; it finishes at its frozen path.
    integrity(row && row.restore_fence_generation===operation.newFence && row.current_path===lifecycle.admitted.accepted.binding.currentPath &&
      row.lineage_state==="current" && row.admission_state==="closed");
    integrity(stopRestoreRevocationHolds(this.#storage,operation) && stopRestoreIdentityHolds(this.#storage,operation));
    const tip=this.#storage.db.prepare(`SELECT journal_cursor FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} ORDER BY journal_cursor DESC LIMIT 1`).get(...documentParams(document));
    integrity(tip?.journal_cursor===lifecycle.admitted.accepted.receipt.journalCursor);
    const active=this.#storage.db.prepare(`SELECT operation_id FROM ${LIVE_RESTORE_OPERATIONS} WHERE workspace_id=? AND main_version_id=? AND object_id=? AND ${UNFINISHED_RESTORE}`)
      .get(document.workspaceId,document.mainVersionId,document.objectId);
    integrity(active?.operation_id===operation.intent.operationId);
  }
  async admitStopRestoreProposal(input: RestoreProposalInput, expectedProposalDigest:string, validator: LiveRestoreValidator, now:number,
    signal?: AbortSignal):Promise<RestoreLifecycle> {
    return this.#admitStopRestoreProposal(input, expectedProposalDigest, validator, now, undefined, signal);
  }
  async admitReviewedStopRestoreProposal(input: RestoreProposalInput & {maxOutputBytes: number}, expectedProposalDigest: string,
    validator: LiveRestoreValidator, now: number, signal?: AbortSignal): Promise<RestoreLifecycle> {
    return this.#admitStopRestoreProposal(input, expectedProposalDigest, validator, now, authorityInteger(input.maxOutputBytes, 1), signal);
  }
  async #admitStopRestoreProposal(input: RestoreProposalInput, expectedProposalDigest:string, validator: LiveRestoreValidator,
    now:number, maxOutputBytes?: number, signal?: AbortSignal):Promise<RestoreLifecycle> {
    signal?.throwIfAborted();
    input=lifecycleInput(input);
    expectedProposalDigest=parseLiveUpdateDigest(expectedProposalDigest);
    const historical=this.readStopRestoreLifecycle(input);
    if (historical) {integrity(historical.proposalDigest===expectedProposalDigest);return historical;}
    const reads = new RestoreAdmissionReads(this.#storage.db);
    let prepared: PreparedRestoreProposal | null;
    try {
      prepared = maxOutputBytes === undefined
        ? await this.#prepareStopRestoreProposal(input, validator, signal, undefined, reads)
        : (await this.#prepareStopRestoreReview({...input, maxOutputBytes}, validator, signal, reads))?.prepared ?? null;
    } catch (error) {
      if (error instanceof LiveRestoreTooLarge) {
        throw relayError("payload_too_large","The server can't confirm this restore: the restored file is too large for it to check. Decline this restore.");
      }
      throw error;
    }
    signal?.throwIfAborted();
    integrity(prepared && prepared.saved.proposalDigest===expectedProposalDigest);
    const {saved:proposal,capture,validated}=prepared;
    const updateBytes=validated.candidateBytes,checkpointBytes=validated.content.stateUpdate;
    const checkpointDigest=createHash("sha256").update(checkpointBytes).digest("hex"),at=authorityInteger(now);
    const {fence,point,nativeSourceManifestDigest}=capture.receipt,document=journalDocument({workspaceId:fence.operation.oldBinding.workspaceId,mainVersionId:fence.operation.oldBinding.mainVersionId,objectId:fence.operation.oldBinding.objectId,lineageClaimId:fence.operation.oldBinding.lineageClaimId});
    const binding=parseLiveObjectBinding({...fence.operation.oldBinding,restoreFenceGeneration:fence.operation.newFence});
    const sourceRanges:RestoreSourceRange[]=[];
    const known=[...validated.content.acceptedCheckpointRanges,...capture.accepted.events.flatMap(event=>event.metadata.firstSeen)]
      .sort((a,b)=>a.clientId-b.clientId || a.startClock-b.startClock);
    for (const [sourceOrdinal,ranges] of validated.nativeSourceRanges.entries()) {
      const source=capture.receipt.nativeSources[sourceOrdinal]!;
      if (source.acceptedReceipt!==null) continue;
      for (const range of subtractJournalRanges(ranges,known)) sourceRanges.push({...range,sourceOrdinal,sourceDigest:restoreDigest(source)});
    }
    const metadata={deliveryId:`restore-${restoreDigest([this.#history.namespace,input.operationId,expectedProposalDigest])}`,
      updateDigest:proposal.candidateDigest,binding};
    const host=snapshotHostCoordinate(input.host);
    const priorMetadata=this.#storage.readTx(()=>{
      const raw=this.#storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} ORDER BY journal_cursor DESC LIMIT 1`).get(...documentParams(document));
      return raw?decodeJournalRow(this.#storage.db,raw).admitted.metadata:null;
    });
    const authorWindow = assessLiveAuthorWindow(capture.accepted.events.map(event => event.metadata), {
      authorSnapshot: [], firstSeen: validated.content.replacementRanges, firstSeenDeletes: validated.content.firstSeenDeletes});
    integrity(!authorWindow.refused);
    this.#storage.tx(()=>{
      signal?.throwIfAborted();
      this.#storage.captureStanding();
      this.#standing(host);
      reads.assertCurrent();
      const operation=readStopRestoreInTransaction(this.#storage,input);integrity(operation);
      // The same writer records a Decline, so exactly one of them takes the fenced restore.
      integrity(operation.phase==="native-fenced" && !stopRestoreDeclineRecorded(this.#storage,operation) && stopRestoreHoldsFrozenPath(this.#storage,operation));
      const admitted=appendValidatedLiveJournal(this.#storage,{document,namespace:this.#history.namespace,host,
        current:{binding,authority:{principalKind:"owner",principalId:input.ownerUserId,grantId:null,grantGeneration:null}},metadata,
        updateBytes,receivedAtMs:at,firstSeen:validated.content.replacementRanges,firstSeenDeletes:validated.content.firstSeenDeletes,
        authorSnapshot:[],checkpointCoverage:authorWindow.coverage,checkpointBytes,checkpointDigest,priorMetadata,restoreOperationId:input.operationId});
      assertWorkspaceQuota(this.#storage,document.workspaceId,144);
      this.#storage.db.prepare(`INSERT INTO ${SETTLEMENT_CUTS}(journal_cursor,state_sha256,markdown_sha256,state_byte_length,markdown_byte_length) VALUES(?,?,?,?,?)`).run(
        admitted.metadata.accepted.receipt.journalCursor,validated.content.restoredStateDigest,validated.content.projectedMarkdownSha256,
        checkpointBytes.byteLength,validated.content.projectedMarkdownByteLength);
      const admission:RestoreAdmission={proposalDigest:expectedProposalDigest,candidateDigest:proposal.candidateDigest,preparation:{fence,point},
        nativeSourceManifestDigest,admitted:admitted.metadata,checkpointDigest,sourceRanges,recordedAtMs:at};
      const admissionJson=JSON.stringify(admission);
      // Both identifier contracts refuse controls; quotes and backslashes cost two JSON bytes.
      const id="\\".repeat(LIVE_UPDATE_IDENTIFIER_MAX_BYTES),hostId="\\".repeat(HOST_CONTROL_IDENTIFIER_MAX_BYTES),integer=Number.MAX_SAFE_INTEGER;
      const application={fence,candidateDigest:proposal.candidateDigest,nativeSourceManifestDigest,admitted:admitted.metadata,
        localHeadSequence:integer,hostCoordinate:{hostId:host.hostId,hostEpoch:integer,instanceId:hostId,connectionId:hostId},recordedAtMs:integer};
      const settlement={settlementId:id,previousCursor:integer,terminalCursor:integer,applicationCount:integer,localYDocSequence:integer,
        momentId:id,markdownDigest:"f".repeat(64),materialized:false,collectionReconcileRequired:false};
      const resume={relayDatabaseNamespace:this.#history.namespace,operationId:input.operationId,binding,applicationReceipt:admitted.metadata.accepted.receipt,
        settlementId:id,momentId:id,markdownDigest:"f".repeat(64),localHeadSequence:integer,recordedAtMs:integer};
      const reservation=Buffer.byteLength(JSON.stringify(application))+2*Buffer.byteLength(JSON.stringify(settlement))+Buffer.byteLength(JSON.stringify(resume));
      const values=[this.#history.namespace,input.operationId,document.workspaceId,input.maxBytes,admissionJson,restoreDigest(admission)];
      // The restore's publication must land, so admission funds it too, apart from the evidence limit.
      const publication=restorePublicationReservation(this.#history.namespace,binding);
      const charge=Buffer.byteLength(JSON.stringify(values))+reservation+publication;
      const sourceRows=sourceRanges.map(range=>{
        const values=[this.#history.namespace,input.operationId,...documentParams(document),range.sourceOrdinal,range.clientId,range.startClock,range.endClock,
          expectedProposalDigest,range.sourceDigest];
        return {values,charge:Buffer.byteLength(JSON.stringify(values))};
      });
      const total=charge+sourceRows.reduce((n,row)=>n+row.charge,0);
      assertWorkspaceQuota(this.#storage,document.workspaceId,total);
      integrity(this.#storage.db.prepare(`INSERT INTO ${LIVE_RESTORE_LIFECYCLES}(relay_database_namespace,operation_id,workspace_id,max_evidence_bytes,admission_json,admission_sha256,receipt_reservation_bytes,publication_reservation_bytes,accounted_bytes)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(...values,reservation,publication,charge).changes===1);
      const insert=this.#storage.db.prepare(`INSERT INTO ${LIVE_RESTORE_SOURCE_RANGES}(relay_database_namespace,operation_id,workspace_id,main_version_id,object_id,lineage_claim_id,source_ordinal,client_id,start_clock,end_clock,proposal_sha256,source_sha256,accounted_bytes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const row of sourceRows) integrity(insert.run(...row.values,row.charge).changes===1);
      integrity(this.#storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(total,document.workspaceId).changes===1);
      integrity(this.#storage.db.prepare(`UPDATE ${LIVE_RESTORE_OPERATIONS} SET phase='relay-admitted' WHERE relay_database_namespace=? AND operation_id=? AND phase='native-fenced'`)
        .run(this.#history.namespace,input.operationId).changes===1);
      // The fence carried the open retirement to this generation. It now names the restore's own accepted row.
      carryServiceActivationRetirement(this.#storage,document,fence.operation.newFence,admitted.metadata.accepted.receipt.journalCursor);
      requireRestoreLifecycleBudget(this.#storage.db,this.#history.namespace,input.operationId,input.workspaceId,input.maxBytes);
      if (!restorePublicationFits(this.#storage,this.#history.namespace,fence.operation.oldBinding,binding,admitted.metadata.accepted.receipt.journalCursor)) {
        throw relayError("payload_too_large","The server can't confirm this restore: too many changes to this file haven't been confirmed yet. Decline this restore.");
      }
    });
    return this.readStopRestoreLifecycle(input)!;
  }
  acknowledgeStopRestoreReplacement(input:RestoreProposalInput,value:unknown):RestoreLifecycle {
    return this.#acknowledgeLifecycle(input,"application",parseNativeRestoreApplicationReceipt(value));
  }
  acknowledgeStopRestoreSettlement(input:RestoreProposalInput,value:unknown):RestoreLifecycle {
    return this.#acknowledgeLifecycle(input,"settlement",parseNativeRestoreSettlementReceipt(value));
  }
  acknowledgeStopRestoreResume(input:RestoreProposalInput,value:unknown):RestoreLifecycle {
    return this.#acknowledgeLifecycle(input,"resume",parseNativeRestoreResumeReceipt(value));
  }
  #acknowledgeLifecycle(input:RestoreProposalInput,stage:"application"|"settlement"|"resume",value:NativeRestoreApplicationReceipt|NativeRestoreSettlementReceipt|NativeRestoreResumeReceipt):RestoreLifecycle {
    input=lifecycleInput(input);
    const assertDatabaseCurrent=captureSqliteReadRevision(this.#storage.db);
    const before=this.#storage.readTx(()=>this.#readLifecycle(input));integrity(before);verifyJournalRow(before.journal);
    return this.#storage.tx(()=>{
      assertDatabaseCurrent();const saved=before;
      const existing=saved.lifecycle[stage];
      if (existing) {
        if (stage!=="settlement" || (existing as NativeRestoreSettlementReceipt).materialized) {
          integrity(isDeepStrictEqual(existing,value));return structuredClone(saved.lifecycle);
        }
        const pending=existing as NativeRestoreSettlementReceipt,next=value as NativeRestoreSettlementReceipt;
        integrity(isDeepStrictEqual({...pending,materialized:next.materialized,collectionReconcileRequired:next.collectionReconcileRequired},next));
      }
      this.#activeLifecycle(saved);
      const lifecycle=structuredClone(saved.lifecycle);
      let column:"application_json"|"pending_settlement_json"|"settlement_json"|"resume_json";
      if (stage==="application") {
        integrity(lifecycle.phase==="relay-admitted");lifecycle.application=value as NativeRestoreApplicationReceipt;lifecycle.phase="native-applied";column="application_json";
      } else if (stage==="settlement") {
        integrity(lifecycle.phase==="native-applied");lifecycle.settlement=value as NativeRestoreSettlementReceipt;
        if (lifecycle.settlement.materialized) {lifecycle.phase="settled";column="settlement_json";} else column="pending_settlement_json";
      } else {
        integrity(lifecycle.phase==="settled");lifecycle.resume=value as NativeRestoreResumeReceipt;lifecycle.phase="resumed";column="resume_json";
      }
      validateRestoreLifecycle(saved.admission,lifecycle);
      const json=JSON.stringify(value),oldBytes=stage==="settlement" && saved.row.pending_settlement_json!==null?Buffer.byteLength(String(saved.row.pending_settlement_json)):0;
      const used=Buffer.byteLength(json)-oldBytes,reserved=authorityInteger(saved.row.receipt_reservation_bytes);
      integrity(used<=reserved);
      const remaining=reserved-used,refund=stage==="resume"?remaining:0;
      integrity(this.#storage.db.prepare(`UPDATE ${LIVE_RESTORE_LIFECYCLES} SET ${column}=?,receipt_reservation_bytes=?,accounted_bytes=accounted_bytes-?
        ${column==="settlement_json"?",pending_settlement_json=NULL":""} WHERE relay_database_namespace=? AND operation_id=?`)
        .run(json,stage==="resume"?0:remaining,refund,this.#history.namespace,input.operationId).changes===1);
      if (refund) this.#refundOwner(input.workspaceId,refund);
      if (stage==="resume") this.#resumeDeliveryProgress(saved.operation,lifecycle,saved.host);
      integrity(this.#storage.db.prepare(`UPDATE ${LIVE_RESTORE_OPERATIONS} SET phase=? WHERE relay_database_namespace=? AND operation_id=? AND phase=?`)
        .run(lifecycle.phase,this.#history.namespace,input.operationId,saved.lifecycle.phase).changes===1);
      if (stage==="resume") {
        integrity(this.#storage.db.prepare(`UPDATE sync_relay_live_documents SET admission_state='open' WHERE ${WHERE_DOCUMENT} AND restore_fence_generation=? AND admission_state='closed' AND lineage_state='current'`)
          .run(...documentParams(saved.operation.intent.document),saved.operation.newFence).changes===1);
      }
      requireRestoreLifecycleBudget(this.#storage.db,this.#history.namespace,input.operationId,input.workspaceId,input.maxBytes);
      return structuredClone(lifecycle);
    });
  }
  #resumeDeliveryProgress(operation:StopRestoreOperation,lifecycle:RestoreLifecycle,host:LiveHostConnectionCoordinate):void {
    const {application,resume}=lifecycle;integrity(application && resume);
    const document=operation.intent.document,receipt=lifecycle.admitted.accepted.receipt;
    if (operation.intent.deliveryKind==="owner") {
      const row=this.#ownerRow(host,document);integrity(row && row.origin_json===operation.basis.ownerOrigin);
      integrity(sameReceipt(JSON.parse(String(row.tip_receipt_json)),operation.terminal) && row.tip_cursor===operation.cutoverCursor);
      const sequence=Math.max(authorityInteger(row.tip_sequence),application.localHeadSequence),tip=JSON.stringify(receipt);
      const values=[this.#history.namespace,...documentParams(document),host.hostId,row.origin_json,tip,receipt.journalCursor,sequence,application.localHeadSequence];
      const charge=Buffer.byteLength(JSON.stringify(values)),previous=authorityInteger(row.accounted_bytes,1),delta=Math.max(1,charge-previous);
      consumeLiveDeliveryReservation(this.#storage,document,host.hostId,receipt.journalCursor,delta,true);
      if (previous+delta>charge) this.#refundOwner(document.workspaceId,previous+delta-charge);
      integrity(this.#storage.db.prepare(`UPDATE ${OWNERS} SET tip_receipt_json=?,tip_cursor=?,tip_sequence=?,tip_application_sequence=?,accounted_bytes=?
        WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id=?`).run(tip,receipt.journalCursor,sequence,application.localHeadSequence,charge,
          this.#history.namespace,...documentParams(document),host.hostId).changes===1);
    } else {
      const b=this.#storage.db.prepare(`SELECT * FROM ${BOOTSTRAPS} WHERE ${WHERE_BOOTSTRAP}`).get(this.#history.namespace,...documentParams(document),host.hostId);
      integrity(b && b.bootstrap_id===operation.applied?.sourceId && b.local_ydoc_sequence!==null);
      const prior=this.#storage.db.prepare(`SELECT * FROM ${EDGES} WHERE bootstrap_id=? ORDER BY journal_cursor DESC LIMIT 1`).get(b.bootstrap_id);
      integrity(sameReceipt(prior?parseLiveUpdateReceipt({deliveryId:prior.delivery_id,updateDigest:prior.update_digest,journalCursor:prior.journal_cursor,acceptingHostEpoch:prior.accepting_host_epoch}):null,operation.terminal));
      const h=application.hostCoordinate,values=[b.bootstrap_id,document.workspaceId,receipt.journalCursor,operation.cutoverCursor,
        receipt.deliveryId,receipt.updateDigest,receipt.acceptingHostEpoch,application.localHeadSequence,host.mode,h.hostEpoch,h.instanceId,h.connectionId];
      const charge=Buffer.byteLength(JSON.stringify(values));
      consumeLiveDeliveryReservation(this.#storage,document,host.hostId,receipt.journalCursor,charge,true);
      this.#storage.db.prepare(`INSERT INTO ${EDGES}(bootstrap_id,workspace_id,journal_cursor,predecessor_cursor,delivery_id,update_digest,accepting_host_epoch,local_ydoc_sequence,ack_host_mode,ack_host_epoch,ack_instance_id,ack_connection_id,accounted_bytes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values,charge);
    }
  }

  stopRestoreDocument(input: StopRestoreLookup & {host: LiveHostConnectionCoordinate}): LiveDocumentKey {
    const host=snapshotHostCoordinate(input.host);
    return this.#storage.readTx(() => {
      this.#standing(host);
      const operation=readStopRestoreInTransaction(this.#storage,input);integrity(operation);
      integrity(operation.basis.namespace===this.#history.namespace && operation.basis.hostId===host.hostId && operation.basis.hostMode===host.mode);
      return structuredClone(operation.intent.document);
    });
  }
  pendingStopRestoreFence(input: StopRestoreLookup & {host: LiveHostConnectionCoordinate}) {
    return this.#storage.readTx(() => {
      const {operation} = this.#restore(input, input.host);
      integrity((operation.phase === "old-cut-applied" || operation.phase === "native-fenced") && operation.applied && operation.newFence !== null);
      return {operation: nativeRestoreFence(operation.applied, operation.newFence, operation.intent), receipt: structuredClone(operation.nativeReceipt)};
    });
  }
  acknowledgeStopRestoreFence(input: StopRestoreLookup & {host: LiveHostConnectionCoordinate}, value: unknown): NativeRestoreFenceReceipt {
    const receipt = parseNativeRestoreFenceReceipt(value);
    return this.#storage.tx(() => {
      const {operation} = this.#restore(input, input.host);
      integrity((operation.phase === "old-cut-applied" || operation.phase === "native-fenced") && operation.applied && operation.newFence !== null);
      integrity(isDeepStrictEqual(receipt.operation, nativeRestoreFence(operation.applied, operation.newFence, operation.intent)));
      if (operation.nativeReceipt) {
        integrity(isDeepStrictEqual(operation.nativeReceipt, receipt));
        return structuredClone(operation.nativeReceipt);
      }
      const changed = this.#storage.db.prepare(`UPDATE ${LIVE_RESTORE_OPERATIONS} SET phase='native-fenced',native_receipt_json=? WHERE relay_database_namespace=? AND operation_id=? AND workspace_id=? AND phase='old-cut-applied'`)
        .run(JSON.stringify(receipt), this.#history.namespace,input.operationId, input.workspaceId);
      integrity(changed.changes === 1);
      return structuredClone(receipt);
    });
  }
  /** The native cancellation a recorded Decline needs from this host, or null once answered. */
  pendingStopRestoreCancellation(input: StopRestoreLookup & {host: LiveHostConnectionCoordinate}): NativeRestoreCancellation | null {
    const host = snapshotHostCoordinate(input.host);
    return this.#storage.readTx(() => {
      this.#cancellingHost(input, host);
      return readStopRestoreCancellation(this.#storage, input);
    });
  }
  acknowledgeStopRestoreCancellation(input: StopRestoreLookup & {host: LiveHostConnectionCoordinate}, answer: NativeRestoreCancellationAnswer, now: number): StopRestoreOperation {
    const host = snapshotHostCoordinate(input.host);
    return this.#storage.tx(() => {
      this.#cancellingHost(input, host);
      return acknowledgeStopRestoreCancellation(this.#storage, input, answer, now);
    });
  }
  /** Whether this resumed restore's file moved before it finished, so it finished at the path the file left. */
  stopRestoreFinishedAtMovedPath(input: StopRestoreLookup): boolean {
    return this.#storage.readTx(() => {
      const operation = readStopRestoreInTransaction(this.#storage, input); integrity(operation);
      return stopRestoreFinishedAtMovedPath(this.#storage, operation);
    });
  }
  /** Whether this host goes on with the restore, or ends it through its cancellation because Decline or a departed path ended it. */
  continueStopRestore(input: StopRestoreLookup & {host: LiveHostConnectionCoordinate}, now: number): StopRestoreContinuation {
    const host = snapshotHostCoordinate(input.host);
    return this.#storage.tx(() => {
      const operation = this.#cancellingHost(input, host);
      requireLiveJournalHistory(this.#storage);
      return continueStopRestoreInTransaction(this.#storage, operation, now);
    });
  }
  // Cancellation does not recheck the frozen cut: a Decline ends the restore
  // even where that cut no longer describes the current file.
  #cancellingHost(input: StopRestoreLookup, host: LiveHostConnectionCoordinate): StopRestoreOperation {
    this.#standing(host);
    const operation = readStopRestoreInTransaction(this.#storage, input); integrity(operation);
    integrity(operation.basis.namespace === this.#history.namespace && operation.basis.hostId === host.hostId && operation.basis.hostMode === host.mode);
    return operation;
  }
  closeStopRestoreCut(capture: StopRestoreCutCapture): void {
    const saved = this.#restores.get(capture);
    if (!saved) return;
    if (saved.drain) this.close(saved.drain);
    if (saved.owner) this.#ownerDeliveries.delete(saved.owner);
    this.#restores.delete(capture);
  }
  acknowledgeBootstrap(drain: CommittedDeliveryDrain, input: unknown): void {
    const ack = parseBootstrapAck(input);
    this.#storage.tx(() => {
      const capture = this.#capture(drain),
        b = capture.baseline,
        row = this.#bootstrapRow(capture);
      integrity(
        ack.bootstrapId === b.bootstrapId &&
          ack.bootstrapMomentId === b.bootstrapMomentId &&
          ack.baselineDigest === b.baselineDigest &&
          ack.baselineMomentRelaySequence === b.baselineMomentRelaySequence,
      );
      if (row.local_ydoc_sequence !== null) {
        integrity(row.local_ydoc_sequence === ack.localYDocSequence);
        return;
      }
      const h = capture.host,
        charge = Buffer.byteLength(
          JSON.stringify([
            ack.localYDocSequence,
            h.mode,
            h.hostEpoch,
            h.instanceId,
            h.connectionId,
          ]),
        );
      consumeLiveDeliveryReservation(this.#storage, capture.document, h.hostId, 0, charge, true);
      this.#storage.db
        .prepare(
          `UPDATE ${BOOTSTRAPS} SET local_ydoc_sequence=?,ack_host_mode=?,ack_host_epoch=?,ack_instance_id=?,ack_connection_id=?,accounted_bytes=accounted_bytes+? WHERE bootstrap_id=? AND local_ydoc_sequence IS NULL`,
        )
        .run(
          ack.localYDocSequence,
          h.mode,
          h.hostEpoch,
          h.instanceId,
          h.connectionId,
          charge,
          b.bootstrapId,
        );
      integrity(
        this.#bootstrapRow(capture).local_ydoc_sequence ===
          ack.localYDocSequence,
      );
    });
  }
  acknowledge(
    drain: CommittedDeliveryDrain,
    predecessor: LiveUpdateReceipt | null,
    input: unknown,
  ): void {
    const ack = parseLiveUpdateHostApplicationAck(input),
      previous =
        predecessor === null ? null : parseLiveUpdateReceipt(predecessor);
    this.#storage.tx(() => {
      const capture = this.#capture(drain),
        progress = this.#progress(capture);
      integrity(progress.bootstrap.local_ydoc_sequence !== null);
      integrity(
        capture.terminal && ack.journalCursor <= capture.terminal.journalCursor,
      );
      const repeated = this.#storage.db
        .prepare(
          `SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor=?`,
        )
        .get(capture.baseline.bootstrapId, ack.journalCursor);
      if (repeated) {
        integrity(
          sameReceipt(
            receipt(repeated),
            parseLiveUpdateReceipt({
              deliveryId: ack.deliveryId,
              updateDigest: ack.updateDigest,
              journalCursor: ack.journalCursor,
              acceptingHostEpoch: ack.acceptingHostEpoch,
            }),
          ) &&
            repeated.predecessor_cursor === (previous?.journalCursor ?? 0) &&
            repeated.local_ydoc_sequence === ack.localYDocSequence,
        );
        if (previous) {
          const original = this.#storage.db
            .prepare(
              `SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor=?`,
            )
            .get(capture.baseline.bootstrapId, previous.journalCursor);
          integrity(original && sameReceipt(receipt(original), previous));
        }
        return;
      }
      integrity(sameReceipt(progress.predecessor, previous));
      const expected = this.#nextReceipt(capture, previous?.journalCursor ?? 0);
      integrity(
        expected &&
          expected.deliveryId === ack.deliveryId &&
          expected.updateDigest === ack.updateDigest &&
          expected.journalCursor === ack.journalCursor &&
          expected.acceptingHostEpoch === ack.acceptingHostEpoch,
      );
      const h = capture.host,
        values = [
          capture.baseline.bootstrapId,
          capture.document.workspaceId,
          ack.journalCursor,
          previous?.journalCursor ?? 0,
          ack.deliveryId,
          ack.updateDigest,
          ack.acceptingHostEpoch,
          ack.localYDocSequence,
          h.mode,
          h.hostEpoch,
          h.instanceId,
          h.connectionId,
        ];
      const charge = Buffer.byteLength(JSON.stringify(values));
      consumeLiveDeliveryReservation(this.#storage, capture.document, h.hostId, ack.journalCursor, charge, true);
      this.#storage.db
        .prepare(
          `INSERT INTO ${EDGES}(bootstrap_id,workspace_id,journal_cursor,predecessor_cursor,delivery_id,update_digest,accepting_host_epoch,local_ydoc_sequence,ack_host_mode,ack_host_epoch,ack_instance_id,ack_connection_id,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(...values, charge);
      const inserted = this.#storage.db
        .prepare(
          `SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor=?`,
        )
        .get(capture.baseline.bootstrapId, ack.journalCursor);
      integrity(
        inserted &&
          sameReceipt(receipt(inserted), expected) &&
          inserted.predecessor_cursor === (previous?.journalCursor ?? 0) &&
          inserted.local_ydoc_sequence === ack.localYDocSequence,
      );
      capture.progress = { predecessor: expected, tip: inserted };
    });
  }
  close(drain: CommittedDeliveryDrain): void {
    this.#drains.delete(drain);
  }
}
