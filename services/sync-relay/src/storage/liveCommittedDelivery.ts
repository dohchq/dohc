import { randomUUID, createHash } from "node:crypto";
import {readAcceptedHistory, readAcceptedHistoryDelivery, requireAcceptedHistoryProof, RestoreHistoryBudget} from "./liveAcceptedHistory";
import {canonicalAcceptedMetadata, initialAcceptedHistoryDigest, nextAcceptedHistoryDigest} from "../liveAcceptedHistory";
import type {NativeRestoreHistoryProof} from "../liveRestoreProposal";
import type { LiveOwnerAdoptionCut } from "@dohc/workspace-engine-client/daemon";
import { isDeepStrictEqual } from "node:util";
import {
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
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
import {
  journalDocument,
  journalHost,
  documentParams,
  liveJournalCut,
  verifyJournalCut,
  decodeJournalRow,
  verifyJournalRow,
  assertJournalCheckpointPosition,
} from "./liveUpdateJournal";
import { bindLiveDeliveryHostNamespace, consumeLiveDeliveryReservation } from "./liveDeliveryReservations";
import { nativeRestoreFence, requireStopRestoreCut, requireStopRestoreOwnerOrigin, type StopRestoreLookup, type StopRestoreOperation, type StopRestoreApplied } from "./liveRestoreOperation";
import {parseNativeRestoreFenceReceipt, type NativeRestoreFenceReceipt} from "../liveRestoreFence";
import {parseNativeRestoreProposalReceipt, decodeNativeRestoreProposal, type RestoreProofBudget} from "../liveRestoreProposal";
import {validateLiveRestoreProposal, type OrderedLiveUpdateCutPolicy} from "@dohc/ydoc-projection/restore-proof";
import {assertWorkspaceQuota} from "./workspaces";
import { LIVE_RESTORE_OPERATIONS, LIVE_RESTORE_PROPOSALS } from "./liveRestoreOperationSchema";

type RestoreProposalInput = StopRestoreLookup & {host: LiveHostConnectionCoordinate} & RestoreProofBudget;
const proposalCharge = (bytes: number, operationId: string, workspaceId: string, proposalDigest: string, candidateDigest: string, recordedAtMs: number) =>
  authorityInteger(bytes + Buffer.byteLength(JSON.stringify([operationId, workspaceId, proposalDigest, candidateDigest, recordedAtMs, Number.MAX_SAFE_INTEGER, "f".repeat(64)])), 1);
const proposalRecordDigest = (operationId: string, workspaceId: string, proposalDigest: string, candidateDigest: string, recordedAtMs: number, charge: number) =>
  createHash("sha256").update(JSON.stringify([operationId, workspaceId, proposalDigest, candidateDigest, recordedAtMs, charge])).digest("hex");

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

/** Internal storage consumer. Authentication and namespace provisioning belong to its caller. */
export class LiveCommittedDeliveryStore {
  readonly #drains = new WeakMap<CommittedDeliveryDrain, DrainCapture>();
  readonly #storage: StorageContext;
  readonly #history: LiveJournalHistoryAuthority;
  readonly #ownerCuts = new WeakMap<OwnerCutCapture,{ host: LiveHostConnectionCoordinate; document: LiveDocumentKey; digest: string }>();
  readonly #ownerDeliveries = new WeakMap<OwnerDeliveryCapture,{host: LiveHostConnectionCoordinate;document: LiveDocumentKey;highWater: number}>();
  readonly #restores = new WeakMap<StopRestoreCutCapture,RestoreCapture>();
  constructor(storage: StorageContext, history: LiveJournalHistoryAuthority) {
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
  openOwnerDelivery(input: {host: LiveHostConnectionCoordinate;document: LiveDocumentKey;actor: import("./types").CurrentLiveBindingRequest["actor"]}): OwnerDeliveryCapture {
    const host = snapshotHostCoordinate(input.host), document = journalDocument(input.document);
    const read = () => {
      this.#standing(host);
      const owner = this.#ownerRow(host,document); integrity(owner);
      const origin = JSON.parse(String(owner.origin_json));
      const row = this.#storage.db.prepare(`SELECT workspace_id,main_version_id,object_id,lineage_claim_id,current_path,restore_fence_generation,lineage_state,admission_state,baseline_digest,baseline_projected_sha256,baseline_projected_byte_length,baseline_moment_relay_seq,registered_at_ms FROM sync_relay_live_documents WHERE ${WHERE_DOCUMENT}`).get(...documentParams(document));
      integrity(row && row.lineage_state === "current" && row.admission_state === "open" && row.baseline_digest === document.lineageClaimId &&
        row.baseline_projected_sha256 === origin.sourceDigest && row.baseline_projected_byte_length === origin.sourceByteLength &&
        row.baseline_moment_relay_seq === origin.baselineMomentRelaySequence && row.registered_at_ms === origin.baselineRegisteredAtMs);
      const binding = parseLiveObjectBinding({...document,currentPath: row.current_path,selectorPaths: [row.current_path],restoreFenceGeneration: row.restore_fence_generation});
      const source = this.#storage.db.prepare("SELECT moment_id,version_id,path,content_kind,blob_sha256,byte_length FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=?")
        .get(document.workspaceId,document.objectId,row.baseline_moment_relay_seq);
      integrity(source && source.moment_id === origin.sourceMomentId && source.version_id === document.mainVersionId && source.path === binding.currentPath &&
        source.content_kind === "text" && source.blob_sha256 === origin.sourceDigest && source.byte_length === origin.sourceByteLength);
      const hostState = this.#storage.getLiveHostControl(); integrity(hostState);
      const current = authorizeLiveDocument(this.#storage,{document,actor: input.actor},hostState,{binding,current: true,open: true,baselineSequence: authorityInteger(row.baseline_moment_relay_seq,1)});
      integrity(current.kind === "current" && isDeepStrictEqual(current.host,host));
      integrity(createHash("sha256").update(JSON.stringify(current.binding)).digest("hex") === origin.bindingDigest);
      return {row,origin: String(owner.origin_json),binding: current.binding};
    };
    const initial = this.#storage.readTx(read);
    const assertCurrent = () => {const current = read(); integrity(isDeepStrictEqual(current,initial));};
    const high = this.#storage.db.prepare(`SELECT MAX(journal_cursor) AS cursor FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT}`).get(...documentParams(document))!;
    const capture = {binding: initial.binding,assertCurrent};
    this.#ownerDeliveries.set(capture,{host,document,highWater: high.cursor === null ? 0 : authorityInteger(high.cursor,1)});
    return capture;
  }
  #ownerDelivery(capture: OwnerDeliveryCapture) {
    const saved = this.#ownerDeliveries.get(capture); integrity(saved);
    capture.assertCurrent();
    return saved;
  }
  ownerDeliveryProgress(capture: OwnerDeliveryCapture): {terminal: LiveUpdateReceipt | null;sequence: number} {
    const {host,document} = this.#ownerDelivery(capture), row = this.#ownerRow(host,document); integrity(row);
    const terminal = JSON.parse(String(row.tip_receipt_json)), parsed = terminal === null ? null : parseLiveUpdateReceipt(terminal);
    integrity((parsed?.journalCursor ?? 0) === row.tip_cursor);
    integrity(authorityInteger(row.tip_application_sequence) <= authorityInteger(row.tip_sequence));
    return {terminal: parsed,sequence: authorityInteger(row.tip_sequence)};
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
    });
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
      const count = this.#storage.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(update_bytes)),0) AS bytes FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor<=?`).get(...documentParams(document),requestedCursor ?? Number.MAX_SAFE_INTEGER)!;
      if (authorityInteger(count.count) > maxEvents || authorityInteger(count.bytes) > maxBytes) throw new Error(`Owner adoption cut exceeds configured bounds: ${count.count} journal events / ${maxEvents} allowed; ${count.bytes} journal bytes / ${maxBytes} allowed.`);
      const result = liveJournalCut(this.#storage, document);
      if (result.kind !== "cut") throw new Error(`Owner adoption ${result.reason}.`);
      const authority = result.cut.authorityHistory.find(row => row.current)!;
      const authorized = input.actor ? currentLiveDocumentBinding(this.#storage,{document,actor: input.actor}) : undefined;
      if (authorized && (authorized.kind !== "current" || !isDeepStrictEqual(authorized.host,host))) throw new Error("Owner standing changed.");
      const binding = authorized?.kind === "current" ? authorized.binding : authority.binding;
      const source = this.#storage.db.prepare(`SELECT moment_id,version_id,path,content_kind,blob_sha256,byte_length FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=?`)
        .get(document.workspaceId, document.objectId, authority.baselineSequence);
      integrity(source && source.version_id === document.mainVersionId && source.path === authority.binding.currentPath && source.content_kind === "text" &&
        source.blob_sha256 === authority.projectedDigest && source.byte_length === authority.projectedLength);
      const events: AdmittedLiveUpdate[] = [];
      let bytes = authority.baselineBytes.byteLength;
      for (const raw of this.#storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor<=? ORDER BY journal_cursor`).iterate(...documentParams(document),requestedCursor ?? Number.MAX_SAFE_INTEGER)) {
        const row = decodeJournalRow(this.#storage.db, raw);
        assertJournalCheckpointPosition(this.#storage.db, row);
        verifyJournalRow(row);
        bytes += row.admitted.updateBytes.byteLength + Buffer.byteLength(JSON.stringify(row.admitted.metadata)) + 8;
        if (bytes > maxBytes || events.length === maxEvents) throw new Error("Owner adoption cut exceeds its configured bounds.");
        events.push(row.admitted);
      }
      const terminal = events.at(-1)?.metadata.accepted.receipt ?? null;
      integrity((terminal?.journalCursor ?? 0) === (requestedCursor ?? result.cut.highWater ?? 0) && events.length === count.count);
      const cut: LiveOwnerAdoptionCut = { relayDatabaseNamespace: this.#history.namespace, adoptionId,
        sourceMomentId: parseLiveUpdateIdentifier(source.moment_id, "source moment ID"), sourceDigest: authority.projectedDigest,
        sourceByteLength: authority.projectedLength, baselineMomentRelaySequence: authority.baselineSequence,
        baselineRegisteredAtMs: authority.registeredAtMs, expectedLocalSequence: sequence,
        terminalReceipt: terminal, baselineBytes: new Uint8Array(authority.baselineBytes), events };
      const { events: _events, baselineBytes: _baseline, ...header } = cut;
      if (bytes + Buffer.byteLength(JSON.stringify({ ...header, eventCount: events.length })) + 8 > maxBytes) throw new Error("Owner adoption cut exceeds its configured bounds.");
      return { journal: result.cut, authority: structuredClone(authority), binding: structuredClone(binding), source: { ...source }, cut };
    });
    verifyJournalCut(captured.journal);
    const assertCurrent = (): void => {
      this.#standing(host);
      const raw = this.#storage.db.prepare(`SELECT * FROM sync_relay_live_documents WHERE ${WHERE_DOCUMENT}`).get(...documentParams(document));
      integrity(raw && isDeepStrictEqual(decodeLiveDocumentAuthorityStructure(this.#storage.db, document, raw), captured.authority));
      const source = this.#storage.db.prepare(`SELECT moment_id,version_id,path,content_kind,blob_sha256,byte_length FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=?`)
        .get(document.workspaceId, document.objectId, captured.authority.baselineSequence);
      integrity(source && isDeepStrictEqual({ ...source }, captured.source));
      if (input.actor) {
        const authorized = currentLiveDocumentBinding(this.#storage,{document,actor: input.actor});
        integrity(authorized.kind === "current" && isDeepStrictEqual(authorized.binding,captured.binding) && isDeepStrictEqual(authorized.host,host));
      }
    };
    assertCurrent();
    const capture = { binding: structuredClone(captured.binding), cut: captured.cut, assertCurrent };
    this.#ownerCuts.set(capture,{ host,document,digest: ownerCutDigest(capture) });
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
    const { host,document } = this.#ownerCapture(capture), cut = capture.cut;
    const ack = baselineRecord(value,["adoptionId","localYDocSequence","terminalCursor","adoptionReplayed"]);
    integrity(ack.adoptionId === cut.adoptionId && ack.localYDocSequence === cut.expectedLocalSequence && ack.terminalCursor === (cut.terminalReceipt?.journalCursor ?? 0) && typeof ack.adoptionReplayed === "boolean");
    const { baselineBytes: _baseline,events: _events,...header } = cut;
    const originEvidenceDigest = createHash("sha256").update(JSON.stringify([capture.binding, cut.relayDatabaseNamespace, cut.sourceMomentId,
      cut.sourceDigest, cut.sourceByteLength, cut.baselineMomentRelaySequence, cut.baselineRegisteredAtMs, cut.expectedLocalSequence,
      cut.events.map(event => canonicalAcceptedMetadata(event.metadata))])).digest("hex");
    const originEventCount = cut.events.length;
    const originHistoryEvidenceDigest = cut.events.reduce((previous, event, index) => nextAcceptedHistoryDigest(previous, index + 1, event.metadata),
      initialAcceptedHistoryDigest(this.#history.namespace, document));
    const origin = JSON.stringify({ ...header,bindingDigest: createHash("sha256").update(JSON.stringify(capture.binding)).digest("hex"),
      originEvidenceDigest, originEventCount, originHistoryEvidenceDigest });
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
      const tip = JSON.stringify(cut.terminalReceipt), cursor = cut.terminalReceipt?.journalCursor ?? 0;
      const values = [this.#history.namespace,...documentParams(document),host.hostId,origin,tip,cursor,cut.expectedLocalSequence,cut.expectedLocalSequence];
      const charge = Buffer.byteLength(JSON.stringify(values));
      consumeLiveDeliveryReservation(this.#storage,document,host.hostId,0,charge,true);
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
    integrity(
      row.bootstrap_id === b.bootstrapId &&
        row.bootstrap_moment_id === b.bootstrapMomentId &&
        row.baseline_digest === b.baselineDigest &&
        row.baseline_byte_length === b.baselineBytes.byteLength &&
        row.baseline_moment_relay_seq === b.baselineMomentRelaySequence &&
        row.baseline_registered_at_ms === b.baselineRegisteredAtMs &&
        row.projected_markdown_digest === b.projectedMarkdownDigest &&
        row.projected_markdown_byte_length === b.projectedMarkdownByteLength &&
        isDeepStrictEqual(
          parseLiveObjectBinding(JSON.parse(String(row.binding_json))),
          b.binding,
        ),
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
    row: Parameters<typeof assertJournalCheckpointPosition>[1],
  ): NonNullable<DrainCapture["checkpoint"]> {
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
          hasCheckpoint === (count === 4095 || bytes >= 20_971_520),
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
      const changed = this.#storage.db.prepare(`UPDATE ${LIVE_RESTORE_OPERATIONS} SET phase='old-cut-applied',applied_json=? WHERE operation_id=? AND workspace_id=? AND phase='fenced'`)
        .run(JSON.stringify(applied),saved.lookup.operationId,saved.lookup.workspaceId);
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
        WHERE o.operation_id=? AND o.workspace_id=?`).get(lookup.operationId, lookup.workspaceId);
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
        "originEvidenceDigest", "originEventCount", "originHistoryEvidenceDigest"]);
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
      return {operation, baselineBytes: authority.baselineBytes, verifyEndpoint, origin: {binding: structuredClone(operation.basis.ownerBinding),
        adoptionId: parseLiveUpdateIdentifier(raw.adoptionId), expectedLocalSequence: authorityInteger(raw.expectedLocalSequence),
        eventCount, terminalReceipt, historyEvidenceDigest, evidenceDigest: parseLiveUpdateDigest(raw.originEvidenceDigest)}};
    };
    const saved = this.#storage.readTx(read);
    const capture: RestoreOwnerOriginCapture = Object.freeze({...saved.origin, nativeReceipt: structuredClone(saved.operation.nativeReceipt!),
      point: {journalCursor: saved.operation.intent.restorePointCursor, receiptDigest: saved.operation.intent.restorePointReceiptDigest}, assertCurrent: () => {
        this.#storage.captureStanding();integrity(fingerprint === digest());
        integrity(isDeepStrictEqual(this.#restore(lookup, host, undefined, saved.baselineBytes).operation, saved.operation));
        integrity(this.#ownerRow(host, saved.operation.intent.document)?.origin_json === saved.operation.basis.ownerOrigin);
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
  recordStopRestoreProposal(input: RestoreProposalInput,
    bytes: Uint8Array, policy: OrderedLiveUpdateCutPolicy, now: number) {
    const budget = {maxBytes: authorityInteger(input.maxBytes, 1), maxEvents: authorityInteger(input.maxEvents, 1)};
    const request = {operationId: parseLiveUpdateIdentifier(input.operationId), workspaceId: parseLiveUpdateIdentifier(input.workspaceId),
      ownerUserId: parseLiveUpdateIdentifier(input.ownerUserId), host: snapshotHostCoordinate(input.host), ...budget};
    const at = authorityInteger(now), decoded = decodeNativeRestoreProposal(bytes, budget);
    const {capture, assertCurrentInTransaction} = this.#captureStopRestoreProposal(request, decoded.receiptJson);
    const content = validateLiveRestoreProposal(capture, decoded.bytes, policy, budget);
    const proposalDigest = createHash("sha256").update(decoded.captured).digest("hex");
    const operationId = capture.receipt.fence.operation.operationId, workspaceId = capture.selected.binding.workspaceId;
    const charge = proposalCharge(decoded.captured.byteLength, operationId, workspaceId, proposalDigest, content.content.candidateDigest, at);
    return this.#storage.tx(() => {
      assertCurrentInTransaction();
      const old = this.#storage.db.prepare(`SELECT workspace_id,proposal_sha256,candidate_sha256,recorded_at_ms,accounted_bytes,record_sha256,length(proposal_bytes) AS bytes
        FROM ${LIVE_RESTORE_PROPOSALS} WHERE operation_id=?`).get(operationId);
      if (old) {
        integrity(old.workspace_id === workspaceId && old.proposal_sha256 === proposalDigest && old.candidate_sha256 === content.content.candidateDigest && old.bytes === decoded.captured.byteLength);
        const recordedAtMs = authorityInteger(old.recorded_at_ms);
        integrity(old.accounted_bytes === proposalCharge(decoded.captured.byteLength, operationId, workspaceId, proposalDigest, content.content.candidateDigest, recordedAtMs));
        integrity(old.record_sha256 === proposalRecordDigest(operationId, workspaceId, proposalDigest, content.content.candidateDigest, recordedAtMs, authorityInteger(old.accounted_bytes, 1)));
        const row = this.#storage.db.prepare(`SELECT proposal_bytes FROM ${LIVE_RESTORE_PROPOSALS} WHERE operation_id=?`).get(operationId)!;
        integrity(row.proposal_bytes instanceof Uint8Array && Buffer.compare(row.proposal_bytes, decoded.captured) === 0);
        return {proposalDigest, candidateDigest: content.content.candidateDigest, recordedAtMs, replayed: true};
      }
      assertWorkspaceQuota(this.#storage, workspaceId, charge);
      const recordDigest = proposalRecordDigest(operationId, workspaceId, proposalDigest, content.content.candidateDigest, at, charge);
      const changed = this.#storage.db.prepare(`INSERT INTO ${LIVE_RESTORE_PROPOSALS}(operation_id,workspace_id,proposal_bytes,proposal_sha256,candidate_sha256,recorded_at_ms,accounted_bytes,record_sha256)
        VALUES (?,?,?,?,?,?,?,?)`).run(operationId, workspaceId, decoded.captured, proposalDigest, content.content.candidateDigest, at, charge, recordDigest);
      integrity(changed.changes === 1);
      const usage = this.#storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge, workspaceId);
      integrity(usage.changes === 1);
      return {proposalDigest, candidateDigest: content.content.candidateDigest, recordedAtMs: at, replayed: false};
    });
  }
  readStopRestoreProposal(input: RestoreProposalInput,
    policy: OrderedLiveUpdateCutPolicy) {
    const lookup = {operationId: parseLiveUpdateIdentifier(input.operationId), workspaceId: parseLiveUpdateIdentifier(input.workspaceId),
      ownerUserId: parseLiveUpdateIdentifier(input.ownerUserId)}, host = snapshotHostCoordinate(input.host);
    const budget = {maxBytes: authorityInteger(input.maxBytes, 1), maxEvents: authorityInteger(input.maxEvents, 1)};
    const saved = this.#storage.readTx(() => {
      this.#restore(lookup, host);
      const header = this.#storage.db.prepare(`SELECT workspace_id,length(proposal_bytes) AS bytes FROM ${LIVE_RESTORE_PROPOSALS} WHERE operation_id=?`).get(lookup.operationId);
      if (!header) return null;
      integrity(header.workspace_id === lookup.workspaceId);
      if (authorityInteger(header.bytes, 1) > budget.maxBytes) throw new Error("Stored restore proposal exceeds configured bounds.");
      const row = this.#storage.db.prepare(`SELECT * FROM ${LIVE_RESTORE_PROPOSALS} WHERE operation_id=?`).get(lookup.operationId)!;
      integrity(row.proposal_bytes instanceof Uint8Array && row.proposal_bytes.byteLength === header.bytes);
      const proposalDigest = parseLiveUpdateDigest(row.proposal_sha256), candidateDigest = parseLiveUpdateDigest(row.candidate_sha256), recordedAtMs = authorityInteger(row.recorded_at_ms);
      integrity(row.accounted_bytes === proposalCharge(row.proposal_bytes.byteLength, lookup.operationId, lookup.workspaceId, proposalDigest, candidateDigest, recordedAtMs));
      integrity(row.record_sha256 === proposalRecordDigest(lookup.operationId, lookup.workspaceId, proposalDigest, candidateDigest, recordedAtMs, authorityInteger(row.accounted_bytes, 1)));
      return {bytes: new Uint8Array(row.proposal_bytes), proposalDigest, candidateDigest, recordedAtMs};
    });
    if (!saved) return null;
    integrity(createHash("sha256").update(saved.bytes).digest("hex") === saved.proposalDigest);
    const decoded = decodeNativeRestoreProposal(saved.bytes, budget), capture = this.captureStopRestoreProposal({...lookup, host, ...budget}, decoded.receiptJson);
    const validated = validateLiveRestoreProposal(capture, decoded.bytes, policy, budget);
    integrity(validated.content.candidateDigest === saved.candidateDigest);
    return {...saved, receipt: capture.receipt};
  }
  captureStopRestoreProposal(input: RestoreProposalInput, receiptJson: string) {
    return this.#captureStopRestoreProposal(input, receiptJson).capture;
  }
  #captureStopRestoreProposal(input: RestoreProposalInput, receiptJson: string) {
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
      if (source.source.origin.kind === "adoptionSeed") integrity(ownerOrigin && source.source.nativeSequence === ownerOrigin.expectedLocalSequence);
    }
    const verifySources = () => {
      const {operation} = this.#restore(lookup, host);
      integrity(operation.phase === "native-fenced" && isDeepStrictEqual(operation.nativeReceipt, receipt.fence));
      const through = operation.terminal?.journalCursor ?? 0, document = operation.intent.document;
      const sourceBudget = new RestoreHistoryBudget(historyBudget.bytes, historyBudget.events);
      for (const source of receipt.nativeSources) {
        const metadata = readAcceptedHistoryDelivery(this.#storage, {document, namespace: operation.basis.namespace, through,
          eventCount: accepted.proof.eventCount, deliveryId: source.deliveryId}, sourceBudget);
        if (!metadata) {integrity(source.acceptedReceipt === null); continue;}
        integrity(isDeepStrictEqual(source.acceptedReceipt, metadata.accepted.receipt) && metadata.accepted.authority.principalKind === "owner" &&
          metadata.accepted.receipt.updateDigest === source.updateDigest);
      }
      integrity(sameReceipt(accepted.proof.terminal, operation.terminal));
      let origin: unknown;
      if (ownerOrigin) {
        ownerOrigin.assertCurrent();
      } else {
        const b = this.#storage.db.prepare(`SELECT * FROM ${BOOTSTRAPS} WHERE bootstrap_id=?`).get(operation.applied!.sourceId);
        integrity(b && b.relay_database_namespace === operation.basis.namespace && b.workspace_id === lookup.workspaceId &&
          b.object_id === document.objectId && b.lineage_claim_id === document.lineageClaimId && b.host_id === host.hostId &&
          isDeepStrictEqual(JSON.parse(String(b.binding_json)), receipt.fence.operation.oldBinding));
        origin = {bootstrapId: b.bootstrap_id, bootstrapMomentId: b.bootstrap_moment_id,
          baselineMomentRelaySequence: b.baseline_moment_relay_seq, baselineRegisteredAtMs: b.baseline_registered_at_ms,
          baselineDigest: b.baseline_digest, baselineByteLength: b.baseline_byte_length,
          projectedMarkdownDigest: b.projected_markdown_digest, projectedMarkdownByteLength: b.projected_markdown_byte_length};
      }
      integrity((ownerOrigin?.evidenceDigest ?? createHash("sha256").update(JSON.stringify(origin)).digest("hex")) === receipt.originEvidenceDigest);
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    const assertCurrentInTransaction = () => {
      this.#storage.captureStanding();
      integrity(createHash("sha256").update(JSON.stringify(receipt)).digest("hex") === fingerprint);
      selected.assertCurrent(); accepted.assertCurrent(); ownerOrigin?.assertCurrent(); verifySources();
    };
    const assertCurrent = () => this.#storage.readTx(assertCurrentInTransaction);
    assertCurrent();
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
      const historyInput = {document: operation.intent.document, namespace: operation.basis.namespace, through: point.journalCursor,
        baseline: authority.baselineBytes, baselineDigest: authority.baselineDigest, originBinding: binding};
      const history = readAcceptedHistory(this.#storage, historyInput, budget);
      integrity((history.proof.terminal?.updateDigest ?? authority.baselineDigest) === point.receiptDigest);
      return {operation, binding, historyInput, ...history, point};
    });
    const capture: RestoreHistoryCapture<Target> = Object.freeze({target, binding: structuredClone(saved.binding), checkpoint: saved.checkpoint,
      events: saved.events, proof: saved.proof, point: saved.point,
      nativeReceipt: structuredClone(saved.operation.nativeReceipt!), assertCurrent: () => {
        this.#storage.captureStanding();
        integrity(fingerprint === digest());
        integrity(isDeepStrictEqual(this.#restore(lookup, host, undefined, saved.historyInput.baseline).operation, saved.operation));
        const current = readAcceptedHistory(this.#storage, saved.historyInput, new RestoreHistoryBudget(maxBytes, maxEvents));
        integrity(isDeepStrictEqual(current.proof, saved.proof) && current.checkpoint.digest === saved.checkpoint.digest);
      }});
    const digest = () => createHash("sha256").update(JSON.stringify({target: capture.target, binding: capture.binding, proof: capture.proof,
      checkpoint: {...capture.checkpoint, bytes: undefined, actualDigest: createHash("sha256").update(capture.checkpoint.bytes).digest("hex")},
      point: capture.point, nativeReceipt: capture.nativeReceipt,
      events: capture.events.map(event => ({metadata: event.metadata, digest: createHash("sha256").update(event.updateBytes).digest("hex")}))})).digest("hex");
    const fingerprint = digest();
    this.#storage.readTx(() => capture.assertCurrent());
    return capture;
  }
  stopRestoreDocument(input: StopRestoreLookup & {host: LiveHostConnectionCoordinate}): LiveDocumentKey {
    return this.#storage.readTx(() => structuredClone(this.#restore(input, input.host).operation.intent.document));
  }
  pendingStopRestoreFence(input: StopRestoreLookup & {host: LiveHostConnectionCoordinate}) {
    return this.#storage.readTx(() => {
      const {operation} = this.#restore(input, input.host);
      integrity((operation.phase === "old-cut-applied" || operation.phase === "native-fenced") && operation.applied && operation.newFence !== null);
      return {operation: nativeRestoreFence(operation.applied, operation.newFence), receipt: structuredClone(operation.nativeReceipt)};
    });
  }
  acknowledgeStopRestoreFence(input: StopRestoreLookup & {host: LiveHostConnectionCoordinate}, value: unknown): NativeRestoreFenceReceipt {
    const receipt = parseNativeRestoreFenceReceipt(value);
    return this.#storage.tx(() => {
      const {operation} = this.#restore(input, input.host);
      integrity((operation.phase === "old-cut-applied" || operation.phase === "native-fenced") && operation.applied && operation.newFence !== null);
      integrity(isDeepStrictEqual(receipt.operation, nativeRestoreFence(operation.applied, operation.newFence)));
      if (operation.nativeReceipt) {
        integrity(isDeepStrictEqual(operation.nativeReceipt, receipt));
        return structuredClone(operation.nativeReceipt);
      }
      const changed = this.#storage.db.prepare(`UPDATE ${LIVE_RESTORE_OPERATIONS} SET phase='native-fenced',native_receipt_json=? WHERE operation_id=? AND workspace_id=? AND phase='old-cut-applied'`)
        .run(JSON.stringify(receipt), input.operationId, input.workspaceId);
      integrity(changed.changes === 1);
      return structuredClone(receipt);
    });
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
