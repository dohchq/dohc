import { requireResumedBinding } from "./liveRestoreLifecycleStorage";
import { parseNativeOwnerActivationSource } from "@dohc/workspace-engine-client/daemon";
import { registerLiveHostInTransaction } from "./hostControl";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { NativeOwnerActivation, NativeOwnerActivationSource, RetainedPrefixBody } from "@dohc/workspace-engine-client/daemon";
import { parseLiveDocumentKey, parseLiveUpdateDigest, parseLiveUpdateIdentifier, parseLiveUpdateReceipt, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { createLiveMarkdownRegistrationValidator, createLiveMarkdownHistoryValidator } from "../../../../packages/ydoc-projection/src/liveDocumentValidation";
import type { StorageContext } from "./context";
import type { LiveHostConnectionCoordinate } from "./types";
import { attachLiveJournalHistory, requireLiveJournalHistory, type LiveJournalHistoryAuthority } from "./liveJournalHistory";
import { authorityInteger, currentLiveDocumentBinding, ownerLiveDocumentBinding, registerOrdinaryActivationBaselineInTransaction } from "./liveDocumentAuthority";
import { releaseRetiredLiveDelivery, reserveLiveDeliverySuccessor } from "./liveDeliveryReservations";
import { initialAcceptedHistoryDigest } from "../liveAcceptedHistory";
import { LIVE_DELIVERY_OWNERS } from "./liveCommittedDeliverySchema";
import { forgetIdleServiceHostUploads, restoreInProgress, SERVICE_HOST_ENROLLMENTS } from "./serviceHostEnrollment";
import type { RetirementKey } from "./serviceActivationRetirement";
import {verifyOrdinaryActivationCut,type OrdinaryActivationBounds} from "./ordinaryActivationSource";
export {ServiceActivationStaleCut} from "./ordinaryActivationSource";
import { assertWorkspaceQuota } from "./workspaces";
import { LIVE_DELIVERY_OWNER_HISTORY, SERVICE_ACTIVATIONS } from "./serviceActivationSchema";
import { predecessorAcceptedThrough, readServiceActivation, serviceActivationAccess, serviceActivationState, type ServiceActivationAccess } from "./serviceActivationAccess";
import { LIVE_JOURNAL_TABLE } from "./schema";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function retirementKey(value: RetirementKey): RetirementKey {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "acceptedThrough,activationId,lineageClaimId,objectId,restoreFenceGeneration") {
    throw new TypeError("Invalid retirement key.");
  }
  return {objectId: parseLiveUpdateIdentifier(value.objectId, "object ID"), lineageClaimId: parseLiveUpdateDigest(value.lineageClaimId),
    activationId: parseLiveUpdateIdentifier(value.activationId, "activation ID"), restoreFenceGeneration: authorityInteger(value.restoreFenceGeneration),
    acceptedThrough: authorityInteger(value.acceptedThrough)};
}
// The boundary a release kept, in the one form the relay stores.
function retainedBoundary(value: RetainedPrefixBody | null): RetainedPrefixBody | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "eventCount,historyEvidenceDigest,terminalReceipt") {
    throw new TypeError("Invalid released boundary.");
  }
  const terminal = value.terminalReceipt === null ? null : parseLiveUpdateReceipt(value.terminalReceipt);
  return {terminalReceipt: terminal && {deliveryId: terminal.deliveryId, updateDigest: terminal.updateDigest, journalCursor: terminal.journalCursor,
    acceptingHostEpoch: terminal.acceptingHostEpoch}, eventCount: authorityInteger(value.eventCount), historyEvidenceDigest: parseLiveUpdateDigest(value.historyEvidenceDigest)};
}
const key = (source: NativeOwnerActivationSource): LiveDocumentKey => parseLiveDocumentKey({workspaceId: source.workspaceId,
  mainVersionId: source.mainVersionId, objectId: source.objectId, lineageClaimId: source.lineageClaimId});

export class ServiceActivationStore {
  constructor(private readonly storage: StorageContext, private readonly history: LiveJournalHistoryAuthority) {
    attachLiveJournalHistory(storage, history);
  }

  pending(document: LiveDocumentKey, host: LiveHostConnectionCoordinate): ServiceActivationAccess {
    requireLiveJournalHistory(this.storage, this.history);
    const row = readServiceActivation(this.storage, document);
    if (!row || row.relay_database_namespace !== this.history.namespace) throw new Error("Service activation is unavailable.");
    return serviceActivationAccess(this.storage, String(row.activation_id), parseLiveObjectBinding(JSON.parse(String(row.binding_json))), host);
  }

  resume(input: {document: LiveDocumentKey; activationId: string; host: LiveHostConnectionCoordinate;
    registeredAtMs: number; guard(): void}) {
    return this.storage.tx(() => {
      input.guard(); requireLiveJournalHistory(this.storage, this.history);
      const row = readServiceActivation(this.storage, input.document);
      if (!row || row.activation_id !== input.activationId || row.relay_database_namespace !== this.history.namespace) {
        throw new Error("Retained service activation is unavailable.");
      }
      if (!registerLiveHostInTransaction(this.storage, {...input.host, updatedAtMs: input.registeredAtMs, guard: input.guard}).ok) {
        throw new Error("Service activation host is unavailable.");
      }
      const access = row.completion_json === null ? this.pending(input.document, input.host) : undefined;
      const current = currentLiveDocumentBinding(this.storage, {document: input.document,
        actor: {kind: "owner", userId: String(row.owner_user_id), shareId: String(row.share_id)}}, access);
      if (current.kind !== "current" || !isDeepStrictEqual(current.host, input.host)) {
        throw new Error("Retained service activation authority changed.");
      }
      const original=parseLiveObjectBinding(JSON.parse(String(row.binding_json)));
      if(row.completion_json===null && !isDeepStrictEqual(current.binding,original))throw new Error("Pending service activation binding changed.");
      requireResumedBinding(this.storage.db,this.history.namespace,original,current.binding);
      return {access, binding:current.binding, completed: row.completion_json !== null};
    });
  }

  /**
   * `resume` for a document whose owner lost live authority over it: it
   * establishes this connection's standing for the retained activation
   * without the owner's authority, so what the host applied can settle.
   */
  departing(input: {document: LiveDocumentKey; activationId: string; host: LiveHostConnectionCoordinate;
    registeredAtMs: number; guard(): void}): void {
    this.storage.tx(() => {
      input.guard(); requireLiveJournalHistory(this.storage, this.history);
      const row = readServiceActivation(this.storage, input.document);
      if (!row || row.activation_id !== input.activationId || row.relay_database_namespace !== this.history.namespace) {
        throw new Error("Retained service activation is unavailable.");
      }
      if (!registerLiveHostInTransaction(this.storage, {...input.host, updatedAtMs: input.registeredAtMs, guard: input.guard}).ok) {
        throw new Error("Service activation host is unavailable.");
      }
    });
  }

  complete(input: {document: LiveDocumentKey; host: LiveHostConnectionCoordinate; access: ServiceActivationAccess;
    nativeState: {adoptionId: string; pendingBytes: number}; guard(): void}) {
    return this.storage.tx(() => {
      input.guard(); requireLiveJournalHistory(this.storage,this.history);
      const row = readServiceActivation(this.storage,input.document);
      if (!row || row.activation_id !== input.access.activationId || row.relay_database_namespace !== this.history.namespace) throw new Error("Service activation is unavailable.");
      const source = parseNativeOwnerActivationSource(JSON.parse(String(row.source_json)), JSON.parse(String(row.binding_json)).currentPath, 20_971_520);
      const actor = {kind:"owner" as const,userId:String(row.owner_user_id),shareId:String(row.share_id)};
      const current = currentLiveDocumentBinding(this.storage,{document:input.document,actor},input.access);
      if (current.kind !== "current" || !isDeepStrictEqual(current.host,input.host) || input.nativeState.adoptionId !== row.activation_id || input.nativeState.pendingBytes !== 0) {
        throw new Error("Native activation has not completed.");
      }
      if (row.completion_json !== null) return;
      const owner = this.storage.db.prepare(`SELECT origin_json,tip_cursor,tip_receipt_json,tip_application_sequence FROM sync_relay_live_delivery_owners
        WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND host_id=?`)
        .get(this.history.namespace,input.document.workspaceId,input.document.mainVersionId,input.document.objectId,input.document.lineageClaimId,input.host.hostId);
      if (!owner) throw new Error("Native adoption acknowledgement is missing.");
      // The adoption kept its predecessor's released prefix, or none for a first activation or a chain that never adopted.
      const prefix = row.predecessor_activation_id === null ? null : retainedBoundary(JSON.parse(String(this.storage.db.prepare(`SELECT retired_boundary_json
        FROM ${SERVICE_ACTIVATIONS} WHERE relay_database_namespace=? AND activation_id=? AND retired_at_ms IS NOT NULL`)
        .get(this.history.namespace,row.predecessor_activation_id)?.retired_boundary_json ?? "false")));
      const origin = JSON.parse(String(owner.origin_json));
      if (origin.adoptionId !== row.activation_id || origin.expectedLocalSequence !== source.nativeHeadSequence ||
          origin.sourceMomentId !== source.sourceMomentId || origin.sourceDigest !== source.sourceDigest ||
          origin.originEventCount !== (prefix?.eventCount ?? 0) || !isDeepStrictEqual(origin.terminalReceipt, prefix?.terminalReceipt ?? null) ||
          origin.originHistoryEvidenceDigest !== (prefix?.historyEvidenceDigest ?? initialAcceptedHistoryDigest(this.history.namespace, input.document))) {
        throw new Error("Native adoption acknowledgement differs from activation.");
      }
      // The predecessor's accepted-before-Stop suffix runs through F. After it, the journal holds at most this activation's own seed.
      const where = `WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`;
      const params = [input.document.workspaceId,input.document.mainVersionId,input.document.objectId,input.document.lineageClaimId];
      const seeded = this.storage.db.prepare(`SELECT update_digest,principal_kind,principal_id FROM ${LIVE_JOURNAL_TABLE} ${where} AND journal_cursor>? ORDER BY journal_cursor LIMIT 2`)
        .all(...params,predecessorAcceptedThrough(this.storage,row));
      if (seeded.length > 1 || (seeded.length === 1 && (seeded[0]!.update_digest !== row.state_digest ||
          seeded[0]!.principal_kind !== "owner" || seeded[0]!.principal_id !== row.owner_user_id))) {
        throw new Error("Service activation journal holds another update after its predecessor's.");
      }
      // The host applied every row through the document's last, by its own ACKs.
      const last = this.storage.db.prepare(`SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM ${LIVE_JOURNAL_TABLE} ${where}
        ORDER BY journal_cursor DESC LIMIT 1`).get(...params);
      if (owner.tip_cursor !== (last?.journal_cursor ?? 0) || !isDeepStrictEqual(JSON.parse(String(owner.tip_receipt_json)), last ? {deliveryId: last.delivery_id,
          updateDigest: last.update_digest, journalCursor: last.journal_cursor, acceptingHostEpoch: last.accepting_host_epoch} : null)) {
        throw new Error("Native activation application acknowledgement is missing.");
      }
      const completion = JSON.stringify({adoptionId:row.activation_id,localYDocSequence:owner.tip_application_sequence,
        terminalReceipt:JSON.parse(String(owner.tip_receipt_json)),nativeOutboxEmpty:true});
      const charge = Buffer.byteLength(completion) - 4;
      assertWorkspaceQuota(this.storage,input.document.workspaceId,charge);
      this.storage.db.prepare(`UPDATE ${SERVICE_ACTIVATIONS} SET completion_json=?,accounted_bytes=accounted_bytes+?
        WHERE relay_database_namespace=? AND activation_id=? AND completion_json IS NULL`).run(completion,charge,this.history.namespace,row.activation_id);
      this.storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge,input.document.workspaceId);
    });
  }

  /**
   * Retires the activation its open obligation names, once the engine released
   * it at `boundary` and its document parked. Archives its owner row, releases
   * the lineage's adoption reservation here and every reservation it holds on
   * another host, keeps that boundary, and drops its retained state, refunding
   * those bytes once. It needs no quota. An activation that adopted retires
   * only on the host it adopted on. Exact replay changes nothing, so it never
   * touches a successor's owner row.
   */
  completeRetirement(input: {workspaceId: string; key: RetirementKey; boundary: RetainedPrefixBody | null;
    host: LiveHostConnectionCoordinate; registeredAtMs: number; nowMs: number; guard(): void}): {status: "retired"; replayed: boolean} {
    const key = retirementKey(input.key), boundary = retainedBoundary(input.boundary), boundaryJson = JSON.stringify(boundary);
    const nowMs = authorityInteger(input.nowMs);
    return this.storage.tx(() => {
      input.guard(); requireLiveJournalHistory(this.storage, this.history);
      const namespace = this.history.namespace;
      const row = this.storage.db.prepare(`SELECT workspace_id,object_id,lineage_claim_id,owner_user_id,predecessor_activation_id,length(state_bytes) AS state_length,
        json_extract(source_json,'$.replicationEpoch') AS replication_epoch,json_extract(source_json,'$.streamIdentity') AS stream_identity,
        completion_json,retire_requested_at_ms,retire_restore_generation,retire_accepted_cursor,retired_at_ms,retired_boundary_json FROM ${SERVICE_ACTIVATIONS}
        WHERE relay_database_namespace=? AND activation_id=?`).get(namespace, key.activationId);
      if (!row || row.workspace_id !== input.workspaceId || row.object_id !== key.objectId || row.lineage_claim_id !== key.lineageClaimId ||
          row.retire_requested_at_ms === null || row.retire_restore_generation !== key.restoreFenceGeneration || row.retire_accepted_cursor !== key.acceptedThrough) {
        throw new Error("Service activation retirement is unavailable.");
      }
      if (row.retired_at_ms !== null) {
        if (row.retired_boundary_json !== boundaryJson) throw new Error("Service activation retired at another boundary.");
        return {status: "retired", replayed: true};
      }
      const document = parseLiveDocumentKey({workspaceId: input.workspaceId, mainVersionId: "main", objectId: key.objectId, lineageClaimId: key.lineageClaimId});
      const identity = this.storage.getWorkspaceIdentity(document.workspaceId);
      const enrollment = this.storage.db.prepare(`SELECT owner_user_id,replication_epoch,stream_identity FROM ${SERVICE_HOST_ENROLLMENTS} WHERE workspace_id=? AND object_id=?`)
        .get(document.workspaceId, document.objectId);
      if (!this.storage.workspaceIsOwnedBy(document.workspaceId, String(row.owner_user_id)) || !identity || !enrollment || enrollment.owner_user_id !== row.owner_user_id ||
          enrollment.replication_epoch !== identity.replicationEpoch || enrollment.stream_identity !== identity.streamIdentity ||
          row.replication_epoch !== identity.replicationEpoch || row.stream_identity !== identity.streamIdentity) {
        throw new Error("Service activation retirement owner changed.");
      }
      // Stop and a restore refuse each other.
      if (restoreInProgress(this.storage, document.workspaceId, document.objectId)) throw new Error("Service activation retirement overlaps a restore.");
      const current = this.storage.db.prepare(`SELECT lineage_claim_id,restore_fence_generation FROM sync_relay_live_documents
        WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_state='current'`).get(document.workspaceId, document.objectId);
      if (current?.lineage_claim_id !== key.lineageClaimId || current.restore_fence_generation !== key.restoreFenceGeneration) {
        throw new Error("Service activation retirement names another generation.");
      }
      if (!registerLiveHostInTransaction(this.storage, {...input.host, updatedAtMs: input.registeredAtMs, guard: input.guard}).ok) {
        throw new Error("Service activation host is unavailable.");
      }
      this.#requireJournalBoundary(document, boundary, key.acceptedThrough);
      const ownerKey = [namespace, document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId, input.host.hostId];
      const owner = this.storage.db.prepare(`SELECT origin_json,tip_receipt_json FROM ${LIVE_DELIVERY_OWNERS}
        WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND host_id=?`).get(...ownerKey);
      if (owner) {
        // The release keeps exactly what the retiring owner applied.
        if (!boundary || JSON.parse(String(owner.origin_json))?.adoptionId !== key.activationId ||
            !isDeepStrictEqual(JSON.parse(String(owner.tip_receipt_json)), boundary.terminalReceipt)) {
          throw new Error("Retiring owner delivery differs from its release.");
        }
        const archived = this.storage.db.prepare(`INSERT INTO ${LIVE_DELIVERY_OWNER_HISTORY}(relay_database_namespace,activation_id,workspace_id,main_version_id,
            object_id,lineage_claim_id,host_id,origin_json,tip_receipt_json,tip_cursor,tip_sequence,tip_application_sequence,accounted_bytes)
          SELECT relay_database_namespace,?,workspace_id,main_version_id,object_id,lineage_claim_id,host_id,origin_json,tip_receipt_json,
            tip_cursor,tip_sequence,tip_application_sequence,accounted_bytes FROM ${LIVE_DELIVERY_OWNERS}
          WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND host_id=?`).run(key.activationId, ...ownerKey);
        const deleted = this.storage.db.prepare(`DELETE FROM ${LIVE_DELIVERY_OWNERS}
          WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND host_id=?`).run(...ownerKey);
        if (archived.changes !== 1 || deleted.changes !== 1) throw new Error("Retiring owner delivery is damaged.");
      } else {
        // An activation that adopted on another host retires only there.
        const adopted = row.completion_json !== null || this.storage.db.prepare(`SELECT 1 FROM ${LIVE_DELIVERY_OWNERS}
          WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?
            AND json_extract(origin_json,'$.adoptionId')=? LIMIT 1`).get(...ownerKey.slice(0, 5), key.activationId);
        if (adopted) throw new Error("Retiring activation adopted on another host.");
        // A never-adopted release keeps its released chain tail's boundary, or none.
        const inherited = row.predecessor_activation_id === null ? "null" : this.storage.db.prepare(`SELECT retired_boundary_json FROM ${SERVICE_ACTIVATIONS}
          WHERE relay_database_namespace=? AND activation_id=? AND retired_at_ms IS NOT NULL`).get(namespace, row.predecessor_activation_id)?.retired_boundary_json;
        if (boundaryJson !== inherited) throw new Error("Retiring owner delivery is missing.");
      }
      releaseRetiredLiveDelivery(this.storage, document, input.host.hostId);
      // The archived owner row keeps its charge. The boundary replaces the retained state.
      const charge = Buffer.byteLength(boundaryJson) - authorityInteger(row.state_length, 2);
      const retired = this.storage.db.prepare(`UPDATE ${SERVICE_ACTIVATIONS} SET retired_at_ms=?,retired_boundary_json=?,state_bytes=NULL,accounted_bytes=accounted_bytes+?
        WHERE relay_database_namespace=? AND activation_id=? AND retired_at_ms IS NULL`)
        .run(Math.max(nowMs, authorityInteger(row.retire_requested_at_ms)), boundaryJson, charge, namespace, key.activationId);
      const usage = this.storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge, document.workspaceId);
      if (retired.changes !== 1 || usage.changes !== 1) throw new Error("Service activation retirement is damaged.");
      forgetIdleServiceHostUploads(this.storage, document.workspaceId);
      return {status: "retired", replayed: false};
    });
  }

  /**
   * A successor follows its lineage's exact retired chain tail, which the same
   * owner kept under the workspace's current identity from the same verified
   * baseline, while no activation of the document is current or retiring.
   */
  #requireSuccession(document: LiveDocumentKey, source: NativeOwnerActivationSource,
    predecessor: NonNullable<ReturnType<typeof readServiceActivation>>, ownerUserId: string): void {
    const namespace = this.history.namespace;
    const open = this.storage.db.prepare(`SELECT retire_requested_at_ms FROM ${SERVICE_ACTIVATIONS}
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND retired_at_ms IS NULL LIMIT 1`).get(document.workspaceId, document.mainVersionId, document.objectId);
    if (open) throw new Error(open.retire_requested_at_ms === null ? "Service activation already has a current activation." : "Service activation is retiring.");
    const prior = JSON.parse(String(predecessor.source_json)) as NativeOwnerActivationSource, identity = this.storage.getWorkspaceIdentity(document.workspaceId);
    if (predecessor.relay_database_namespace !== namespace || predecessor.owner_user_id !== ownerUserId || !identity ||
        prior.replicationEpoch !== identity.replicationEpoch || prior.streamIdentity !== identity.streamIdentity ||
        source.replicationEpoch !== identity.replicationEpoch || source.streamIdentity !== identity.streamIdentity) {
      throw new Error("Service activation predecessor belongs to another owner or workspace identity.");
    }
    if (prior.baseRelaySeq !== source.baseRelaySeq || prior.baseOriginId !== source.baseOriginId || prior.baseOriginSeq !== source.baseOriginSeq) {
      throw new Error("Service activation successor has another baseline.");
    }
  }

  // The boundary must end the lineage's real accepted history at or before F.
  #requireJournalBoundary(document: LiveDocumentKey, boundary: RetainedPrefixBody | null, acceptedThrough: number): void {
    if (!boundary) return;
    const terminal = boundary.terminalReceipt;
    if (!terminal) {
      if (boundary.eventCount !== 0 || boundary.historyEvidenceDigest !== initialAcceptedHistoryDigest(this.history.namespace, document)) {
        throw new Error("Released boundary differs from the live journal.");
      }
      return;
    }
    const endpoint = this.storage.db.prepare(`SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch,relay_database_namespace,
      accepted_event_count,accepted_evidence_digest FROM ${LIVE_JOURNAL_TABLE}
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND journal_cursor=?`)
      .get(document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId, terminal.journalCursor);
    if (terminal.journalCursor > acceptedThrough || !endpoint || endpoint.relay_database_namespace !== this.history.namespace ||
        endpoint.accepted_event_count !== boundary.eventCount || endpoint.accepted_evidence_digest !== boundary.historyEvidenceDigest ||
        !isDeepStrictEqual({deliveryId: endpoint.delivery_id, updateDigest: endpoint.update_digest, journalCursor: endpoint.journal_cursor,
          acceptingHostEpoch: endpoint.accepting_host_epoch}, terminal)) {
      throw new Error("Released boundary differs from the live journal.");
    }
  }

  read(workspaceId: string, path: string, maxBytes: number) {
    requireLiveJournalHistory(this.storage, this.history);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid service activation read budget.");
    return this.storage.readTx(() => {
    const size = this.storage.db.prepare(`SELECT length(a.state_bytes)+length(d.baseline_bytes)+length(CAST(a.source_json AS BLOB)) AS bytes FROM ${SERVICE_ACTIVATIONS} a
      JOIN sync_relay_live_documents d USING(workspace_id,main_version_id,object_id,lineage_claim_id)
      WHERE a.relay_database_namespace=? AND a.workspace_id=? AND d.current_path=? AND d.lineage_state='current' AND a.retired_at_ms IS NULL`)
      .get(this.history.namespace,workspaceId,path);
    if (!size) return null;
    if (typeof size.bytes !== "number" || size.bytes > maxBytes) throw new Error("Retained service activation exceeds its read budget.");
    const row = this.storage.db.prepare(`SELECT a.*,d.baseline_bytes FROM ${SERVICE_ACTIVATIONS} a
      JOIN sync_relay_live_documents d USING(workspace_id,main_version_id,object_id,lineage_claim_id)
      WHERE a.relay_database_namespace=? AND a.workspace_id=? AND d.current_path=? AND d.lineage_state='current' AND a.retired_at_ms IS NULL`)
      .get(this.history.namespace, workspaceId, path);
    if (!row) return null;
    const source = parseNativeOwnerActivationSource(JSON.parse(String(row.source_json)), JSON.parse(String(row.binding_json)).currentPath, 20_971_520);
    const document = key(source);
    if (source.workspaceId !== workspaceId || source.currentPath !== path || source.relayDatabaseNamespace !== this.history.namespace ||
        !isDeepStrictEqual(document, {workspaceId:row.workspace_id,mainVersionId:row.main_version_id,objectId:row.object_id,lineageClaimId:row.lineage_claim_id}) ||
        !(row.state_bytes instanceof Uint8Array) || row.state_bytes.byteLength !== source.fullStateByteLength ||
        row.state_digest !== source.fullStateDigest || digest(row.state_bytes) !== source.fullStateDigest ||
        !(row.baseline_bytes instanceof Uint8Array) || digest(row.baseline_bytes) !== source.lineageClaimId) {
      throw new Error("Retained service activation is damaged.");
    }
    return {activationId: String(row.activation_id), source, baselineBytes: new Uint8Array(row.baseline_bytes),
      fullState: new Uint8Array(row.state_bytes), binding: parseLiveObjectBinding(JSON.parse(String(row.binding_json))),
      completed: row.completion_json !== null, ownerUserId: String(row.owner_user_id), shareId: String(row.share_id)};
    });
  }

  prepare(input: {
    capture: NativeOwnerActivation; host: LiveHostConnectionCoordinate; shareId: string; registeredAtMs: number; guard(): void;
    validateBaseline: ReturnType<typeof createLiveMarkdownRegistrationValidator>;
    validateHistory: ReturnType<typeof createLiveMarkdownHistoryValidator>;
    bounds: OrdinaryActivationBounds;
  }) {
    input.guard(); requireLiveJournalHistory(this.storage, this.history);
    for(const limit of Object.values(input.bounds))if(!Number.isSafeInteger(limit)||limit<1)throw new Error("Invalid ordinary activation read budget.");
    const capturedBytes=input.capture.baselineBytes.byteLength+input.capture.fullState.byteLength+Buffer.byteLength(JSON.stringify(input.capture.source));
    if(capturedBytes>input.bounds.maxCaptureBytes||input.capture.baselineBytes.byteLength>input.bounds.maxBytesPerDrain){
      throw new Error("Ordinary activation capture exceeds its configured byte budget.");
    }
    const source = parseNativeOwnerActivationSource(input.capture.source, input.capture.source.currentPath, 20_971_520), document = key(source), baselineBytes = new Uint8Array(input.capture.baselineBytes),
      fullState = new Uint8Array(input.capture.fullState), activationId = input.capture.activationId;
    if (!/^ordinary-activation-[0-9a-f]{64}$/.test(activationId) || source.version !== 1 ||
        source.relayDatabaseNamespace !== this.history.namespace || source.fullStateByteLength !== fullState.length ||
        digest(fullState) !== source.fullStateDigest || digest(baselineBytes) !== source.lineageClaimId) {
      throw new Error("Native activation identity differs.");
    }
    const base = input.validateBaseline({document,currentPath:source.currentPath,checkpoint:baselineBytes});
    if (base.kind !== "accepted") {
      throw new Error("Native activation does not match the ordinary source.");
    }
    const sourceJson = JSON.stringify(source);
    return this.storage.tx(() => {
      input.guard(); requireLiveJournalHistory(this.storage, this.history);
      const prior = readServiceActivation(this.storage, document);
      const share = this.storage.getShare(input.shareId);
      if (!share || share.workspaceId !== document.workspaceId || !this.storage.workspaceIsOwnedBy(document.workspaceId, share.granterUserId)) {
        throw new Error("Service activation owner is unavailable.");
      }
      const state = serviceActivationState(prior);
      if (state === "retiring") throw new Error("Service activation is retiring.");
      if (prior && state !== "retired") {
        if (prior.activation_id !== activationId || prior.relay_database_namespace !== this.history.namespace ||
            prior.source_json !== sourceJson || prior.state_digest !== source.fullStateDigest ||
            prior.owner_user_id !== share.granterUserId || prior.share_id !== share.shareId) throw new Error("Service activation already has another retained source.");
        return {document, replayed: true, completed: prior.completion_json !== null};
      }
      // A capture follows the lineage's retired chain tail, or none when the lineage has no activation.
      const predecessor = state === "retired" ? prior! : null;
      if ((source.predecessorActivationId ?? null) !== (predecessor?.activation_id ?? null)) {
        throw new Error("Service activation names another predecessor.");
      }
      if (predecessor) this.#requireSuccession(document, source, predecessor, share.granterUserId);
      const ordinaryCut=verifyOrdinaryActivationCut(this.storage,{source,document,baselineBytes,fullState,baseline:base.evidence,
        validateHistory:input.validateHistory,validateRegistration:input.validateBaseline,bounds:input.bounds});
      if (!registerLiveHostInTransaction(this.storage, {...input.host,updatedAtMs:input.registeredAtMs,guard:input.guard}).ok) throw new Error("Service activation host is unavailable.");
      const registration = registerOrdinaryActivationBaselineInTransaction(this.storage,{host:input.host,registeredAtMs:input.registeredAtMs,baselineBytes,
        evidence:{version:1,document,currentPath:source.currentPath,checkpoint:{updateDigest:source.lineageClaimId,ranges:base.evidence.checkpoint.ranges},
          projectedMarkdownSha256:base.evidence.projectedMarkdownSha256,projectedMarkdownByteLength:base.evidence.projectedMarkdownByteLength}},ordinaryCut);
      // A successor replays the baseline its verified predecessor registered; a first activation registers it.
      if (registration.kind !== "registered" || registration.replayed !== (predecessor !== null)) throw new Error("Service activation requires a new live baseline.");
      const actor = {kind:"owner" as const,userId:share.granterUserId,shareId:share.shareId};
      // The retired predecessor admits nothing, so a successor's binding is authorized below, through its own pending access.
      const current = predecessor ? null : currentLiveDocumentBinding(this.storage,{document,actor});
      const binding = predecessor ? ownerLiveDocumentBinding(this.storage,document,actor) : current?.kind === "current" && isDeepStrictEqual(current.host,input.host) ? current.binding : null;
      if (!binding) throw new Error("Service activation selector is unavailable.");
      const bindingJson = JSON.stringify(binding);
      const charge = fullState.length + Buffer.byteLength(JSON.stringify([this.history.namespace,activationId,sourceJson,bindingJson,
        source.fullStateDigest,share.granterUserId,share.shareId,null,...(predecessor ? [predecessor.activation_id] : [])]));
      assertWorkspaceQuota(this.storage,document.workspaceId,charge);
      this.storage.db.prepare(`INSERT INTO ${SERVICE_ACTIVATIONS}(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
        predecessor_activation_id,source_json,binding_json,state_digest,state_bytes,owner_user_id,share_id,completion_json,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`)
        .run(this.history.namespace,activationId,document.workspaceId,document.mainVersionId,document.objectId,document.lineageClaimId,
          predecessor?.activation_id ?? null,sourceJson,bindingJson,source.fullStateDigest,fullState,share.granterUserId,share.shareId,charge);
      this.storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge,document.workspaceId);
      if (predecessor) {
        // Retirement released the lineage's adoption funding. Quota refuses this Resume, retryably, and leaves the retired tail as Stop left it.
        reserveLiveDeliverySuccessor(this.storage, document, input.host.hostId);
        const pending = currentLiveDocumentBinding(this.storage,{document,actor},serviceActivationAccess(this.storage,activationId,binding,input.host));
        if (pending.kind !== "current" || !isDeepStrictEqual(pending.host,input.host) || !isDeepStrictEqual(pending.binding,binding)) {
          throw new Error("Service activation selector is unavailable.");
        }
      }
      return {document,replayed:false,completed:false};
    });
  }
}
