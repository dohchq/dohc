import { requireResumedBinding } from "./liveRestoreLifecycleStorage";
import { parseNativeOwnerActivationSource } from "@dohc/workspace-engine-client/daemon";
import { registerLiveHostInTransaction } from "./hostControl";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { NativeOwnerActivation, NativeOwnerActivationSource } from "@dohc/workspace-engine-client/daemon";
import { parseLiveDocumentKey, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { createLiveMarkdownRegistrationValidator, createLiveMarkdownJournalValidator } from "../../../../packages/ydoc-projection/src/liveDocumentValidation";
import type { StorageContext } from "./context";
import type { LiveHostConnectionCoordinate } from "./types";
import { attachLiveJournalHistory, requireLiveJournalHistory, type LiveJournalHistoryAuthority } from "./liveJournalHistory";
import { currentLiveDocumentBinding, registerOrdinaryActivationBaselineInTransaction } from "./liveDocumentAuthority";
import {currentCut,verifyOrdinaryActivationCut,type OrdinaryActivationBounds} from "./ordinaryActivationSource";
export {ServiceActivationStaleCut} from "./ordinaryActivationSource";
import { assertWorkspaceQuota } from "./workspaces";
import { SERVICE_ACTIVATIONS, SERVICE_ACTIVATION_HANDOFFS } from "./serviceActivationSchema";
import { chargeServiceActivationUsage, readServiceActivation, readStagedServiceActivationHandoff, serviceActivationAccess, serviceActivationCharge,
  serviceActivationHandoffCharge, type ServiceActivationAccess } from "./serviceActivationAccess";
import { LIVE_JOURNAL_TABLE } from "./schema";
import { LIVE_DELIVERY_OWNERS } from "./liveCommittedDeliverySchema";
import { LIVE_RESTORE_OPERATIONS } from "./liveRestoreOperationSchema";

const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const key = (source: NativeOwnerActivationSource): LiveDocumentKey => parseLiveDocumentKey({workspaceId: source.workspaceId,
  mainVersionId: source.mainVersionId, objectId: source.objectId, lineageClaimId: source.lineageClaimId});
const documentParams = (document: LiveDocumentKey) => [document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId];

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
      const origin = JSON.parse(String(owner.origin_json));
      if (origin.adoptionId !== row.activation_id || origin.expectedLocalSequence !== source.nativeHeadSequence ||
          origin.sourceMomentId !== source.sourceMomentId || origin.sourceDigest !== source.sourceDigest || origin.originEventCount !== 0) {
        throw new Error("Native adoption acknowledgement differs from activation.");
      }
      const events = this.storage.db.prepare(`SELECT delivery_id,update_digest,journal_cursor FROM ${LIVE_JOURNAL_TABLE}
        WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? ORDER BY journal_cursor LIMIT 2`)
        .all(input.document.workspaceId,input.document.mainVersionId,input.document.objectId,input.document.lineageClaimId);
      if (events.length > 1 || (events.length === 0 ? owner.tip_cursor !== 0 :
          events[0]!.update_digest !== row.state_digest || owner.tip_cursor !== events[0]!.journal_cursor)) {
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

  read(workspaceId: string, path: string, maxBytes: number) {
    requireLiveJournalHistory(this.storage, this.history);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid service activation read budget.");
    return this.storage.readTx(() => {
    const size = this.storage.db.prepare(`SELECT length(a.state_bytes)+length(d.baseline_bytes)+length(CAST(a.source_json AS BLOB)) AS bytes FROM ${SERVICE_ACTIVATIONS} a
      JOIN sync_relay_live_documents d USING(workspace_id,main_version_id,object_id,lineage_claim_id)
      WHERE a.relay_database_namespace=? AND a.workspace_id=? AND d.current_path=? AND d.lineage_state='current'`)
      .get(this.history.namespace,workspaceId,path);
    if (!size) return null;
    if (typeof size.bytes !== "number" || size.bytes > maxBytes) throw new Error("Retained service activation exceeds its read budget.");
    const row = this.storage.db.prepare(`SELECT a.*,d.baseline_bytes FROM ${SERVICE_ACTIVATIONS} a
      JOIN sync_relay_live_documents d USING(workspace_id,main_version_id,object_id,lineage_claim_id)
      WHERE a.relay_database_namespace=? AND a.workspace_id=? AND d.current_path=? AND d.lineage_state='current'`)
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
    validateJournal: ReturnType<typeof createLiveMarkdownJournalValidator>;
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
      if (prior) {
        if (prior.activation_id !== activationId || prior.relay_database_namespace !== this.history.namespace ||
            prior.source_json !== sourceJson || prior.state_digest !== source.fullStateDigest ||
            prior.owner_user_id !== share.granterUserId || prior.share_id !== share.shareId) throw new Error("Service activation already has another retained source.");
        return {document, replayed: true, completed: prior.completion_json !== null};
      }
      const ordinaryCut=verifyOrdinaryActivationCut(this.storage,{source,document,baselineBytes,fullState,baseline:base.evidence,
        validateJournal:input.validateJournal,validateRegistration:input.validateBaseline,bounds:input.bounds});
      if (!registerLiveHostInTransaction(this.storage, {...input.host,updatedAtMs:input.registeredAtMs,guard:input.guard}).ok) throw new Error("Service activation host is unavailable.");
      const registration = registerOrdinaryActivationBaselineInTransaction(this.storage,{host:input.host,registeredAtMs:input.registeredAtMs,baselineBytes,
        evidence:{version:1,document,currentPath:source.currentPath,checkpoint:{updateDigest:source.lineageClaimId,ranges:base.evidence.checkpoint.ranges},
          projectedMarkdownSha256:base.evidence.projectedMarkdownSha256,projectedMarkdownByteLength:base.evidence.projectedMarkdownByteLength}},ordinaryCut);
      if (registration.kind !== "registered" || registration.replayed) throw new Error("Service activation requires a new live baseline.");
      const binding = currentLiveDocumentBinding(this.storage,{document,actor:{kind:"owner",userId:share.granterUserId,shareId:share.shareId}});
      if (binding.kind !== "current" || !isDeepStrictEqual(binding.host,input.host)) throw new Error("Service activation selector is unavailable.");
      const bindingJson = JSON.stringify(binding.binding);
      const charge = fullState.length + Buffer.byteLength(JSON.stringify([this.history.namespace,activationId,sourceJson,bindingJson,
        source.fullStateDigest,share.granterUserId,share.shareId,null]));
      assertWorkspaceQuota(this.storage,document.workspaceId,charge);
      this.storage.db.prepare(`INSERT INTO ${SERVICE_ACTIVATIONS}(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
        source_json,binding_json,state_digest,state_bytes,owner_user_id,share_id,completion_json,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`)
        .run(this.history.namespace,activationId,document.workspaceId,document.mainVersionId,document.objectId,document.lineageClaimId,
          sourceJson,bindingJson,source.fullStateDigest,fullState,share.granterUserId,share.shareId,charge);
      this.storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?").run(charge,document.workspaceId);
      return {document,replayed:false,completed:false};
    });
  }

  /** The successor a handoff staged for the document, which the next pass resumes instead of the retained activation. */
  staged(document: LiveDocumentKey) {
    requireLiveJournalHistory(this.storage, this.history);
    return this.storage.readTx(() => {
      const row = readStagedServiceActivationHandoff(this.storage, document);
      if (!row || row.relay_database_namespace !== this.history.namespace) return null;
      const retained = readServiceActivation(this.storage, document);
      if (!retained) throw new Error("Service activation handoff is damaged.");
      const source = parseNativeOwnerActivationSource(JSON.parse(String(row.successor_source_json)),
        JSON.parse(String(retained.binding_json)).currentPath, 20_971_520);
      return {activationId: String(row.successor_activation_id), source, throughCursor: Number(row.cut_cursor)};
    });
  }

  /**
   * Stages a successor after the host store lost the retained activation's
   * source. The successor keeps the document's baseline and lineage and adopts
   * at the predecessor's owner tip C, which its native adoption proves equals
   * the baseline plus the journal through C. A completed activation is replaced
   * when that adoption's ACK installs it. A pending one that delivered nothing
   * is replaced now, since no owner tip depends on it.
   */
  stageHandoff(input: {document: LiveDocumentKey; activationId: string; capture: NativeOwnerActivation; host: LiveHostConnectionCoordinate;
    shareId: string; registeredAtMs: number; maxCaptureBytes: number; guard(): void}) {
    input.guard(); requireLiveJournalHistory(this.storage, this.history);
    const {capture} = input, fullState = new Uint8Array(capture.fullState), baselineBytes = new Uint8Array(capture.baselineBytes);
    if (baselineBytes.byteLength + fullState.byteLength + Buffer.byteLength(JSON.stringify(capture.source)) > input.maxCaptureBytes) {
      throw new Error("Ordinary activation capture exceeds its configured byte budget.");
    }
    const source = parseNativeOwnerActivationSource(capture.source, capture.source.currentPath, 20_971_520);
    if (!/^ordinary-activation-[0-9a-f]{64}$/.test(capture.activationId) || source.version !== 1 ||
        source.relayDatabaseNamespace !== this.history.namespace || source.fullStateByteLength !== fullState.length ||
        digest(fullState) !== source.fullStateDigest || digest(baselineBytes) !== source.lineageClaimId ||
        !isDeepStrictEqual(key(source), parseLiveDocumentKey(input.document))) {
      throw new Error("Native activation identity differs.");
    }
    const document = key(source), sourceJson = JSON.stringify(source);
    return this.storage.tx(() => {
      input.guard(); requireLiveJournalHistory(this.storage, this.history);
      const row = readServiceActivation(this.storage, document);
      if (!row || row.activation_id !== input.activationId || row.relay_database_namespace !== this.history.namespace) {
        throw new Error("Retained service activation is unavailable.");
      }
      const share = this.storage.getShare(input.shareId);
      if (row.share_id !== input.shareId || !share || share.workspaceId !== document.workspaceId || share.granterUserId !== row.owner_user_id ||
          !this.storage.workspaceIsOwnedBy(document.workspaceId, share.granterUserId)) {
        throw new Error("Service activation share or owner changed.");
      }
      const prior = parseNativeOwnerActivationSource(JSON.parse(String(row.source_json)), JSON.parse(String(row.binding_json)).currentPath, 20_971_520);
      if (source.currentPath !== prior.currentPath || source.baseRelaySeq !== prior.baseRelaySeq ||
          source.baseOriginId !== prior.baseOriginId || source.baseOriginSeq !== prior.baseOriginSeq) {
        throw new Error("Native activation does not continue the retained lineage.");
      }
      currentCut(this.storage, source);
      if (!registerLiveHostInTransaction(this.storage, {...input.host, updatedAtMs: input.registeredAtMs, guard: input.guard}).ok) {
        throw new Error("Service activation host is unavailable.");
      }
      const completed = row.completion_json !== null, original = parseLiveObjectBinding(JSON.parse(String(row.binding_json)));
      const access = completed ? undefined : this.pending(document, input.host);
      const current = currentLiveDocumentBinding(this.storage, {document, actor: {kind: "owner", userId: String(row.owner_user_id), shareId: String(row.share_id)}}, access);
      if (current.kind !== "current" || !isDeepStrictEqual(current.host, input.host) || (!completed && !isDeepStrictEqual(current.binding, original))) {
        throw new Error("Retained service activation authority changed.");
      }
      requireResumedBinding(this.storage.db, this.history.namespace, original, current.binding);
      if (this.storage.db.prepare(`SELECT 1 FROM ${LIVE_RESTORE_OPERATIONS} WHERE workspace_id=? AND main_version_id=? AND object_id=? AND phase<>'resumed'`)
        .get(document.workspaceId, document.mainVersionId, document.objectId)) throw new Error("Service activation handoff waits for an unfinished restore.");
      const owner = this.storage.db.prepare(`SELECT origin_json,tip_cursor FROM ${LIVE_DELIVERY_OWNERS}
        WHERE relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND host_id=?`)
        .get(this.history.namespace, ...documentParams(document), input.host.hostId);
      const originDigest = owner ? digest(String(owner.origin_json)) : null;
      const staged = readStagedServiceActivationHandoff(this.storage, document);
      // A restaged handoff keeps the predecessor whose owner tip it replaces.
      const predecessorId = staged ? String(staged.predecessor_activation_id) : String(row.activation_id);
      if (staged ? staged.relay_database_namespace !== this.history.namespace || staged.predecessor_origin_digest !== originDigest ||
            String(completed ? staged.predecessor_activation_id : staged.successor_activation_id) !== row.activation_id
          : owner && JSON.parse(String(owner.origin_json)).adoptionId !== row.activation_id) {
        throw new Error("Service activation handoff is damaged.");
      }
      if (completed && !owner) throw new Error("Service activation handoff is damaged.");
      if (staged?.successor_activation_id === capture.activationId) {
        if (staged.successor_source_json !== sourceJson) throw new Error("Service activation handoff already has another successor.");
        return {replayed: true, throughCursor: Number(staged.cut_cursor)};
      }
      const delivered = this.storage.db.prepare(`SELECT count(*) AS count FROM ${LIVE_JOURNAL_TABLE}
        WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`).get(...documentParams(document))!;
      // A pending activation's only journal entry is its own seed, which its replacement could never complete with.
      if (!completed && Number(delivered.count) !== 0) throw new Error("A pending service activation that delivered its seed cannot be handed off.");
      const cutCursor = owner ? Number(owner.tip_cursor) : 0;
      let delta = 0;
      if (staged) {
        this.storage.db.prepare(`DELETE FROM ${SERVICE_ACTIVATION_HANDOFFS} WHERE relay_database_namespace=? AND successor_activation_id=? AND state='staged'`)
          .run(this.history.namespace, staged.successor_activation_id);
        delta -= Number(staged.accounted_bytes);
      }
      // Only a completed activation keeps the successor's state here until installation.
      const state = completed || owner ? "staged" : "installed", heldState = completed ? fullState : null;
      const handoffCharge = serviceActivationHandoffCharge({namespace: this.history.namespace, successorId: capture.activationId, predecessorId,
        document, originDigest, sourceJson, stateDigest: source.fullStateDigest, cutCursor, stateBytes: heldState?.length ?? 0});
      this.storage.db.prepare(`INSERT INTO ${SERVICE_ACTIVATION_HANDOFFS}(relay_database_namespace,successor_activation_id,predecessor_activation_id,
        workspace_id,main_version_id,object_id,lineage_claim_id,predecessor_origin_digest,successor_source_json,successor_state_digest,successor_state_bytes,
        cut_cursor,state,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(this.history.namespace, capture.activationId, predecessorId,
        ...documentParams(document), originDigest, sourceJson, source.fullStateDigest, heldState, cutCursor, state, handoffCharge);
      delta += handoffCharge;
      if (!completed) {
        const charge = serviceActivationCharge({namespace: this.history.namespace, activationId: capture.activationId, sourceJson,
          bindingJson: String(row.binding_json), stateDigest: source.fullStateDigest, stateBytes: fullState.length,
          ownerUserId: String(row.owner_user_id), shareId: String(row.share_id), completion: null});
        const replaced = this.storage.db.prepare(`UPDATE ${SERVICE_ACTIVATIONS} SET activation_id=?,source_json=?,state_digest=?,state_bytes=?,accounted_bytes=?
          WHERE relay_database_namespace=? AND activation_id=? AND completion_json IS NULL`)
          .run(capture.activationId, sourceJson, source.fullStateDigest, fullState, charge, this.history.namespace, row.activation_id);
        if (replaced.changes !== 1) throw new Error("Service activation handoff is damaged.");
        delta += charge - Number(row.accounted_bytes);
      }
      chargeServiceActivationUsage(this.storage, document.workspaceId, delta);
      return {replayed: false, throughCursor: cutCursor};
    });
  }
}
