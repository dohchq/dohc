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
import { currentLiveDocumentMoment, currentLiveDocumentBinding, registerLiveDocumentBaselineInTransaction } from "./liveDocumentAuthority";
import { assertWorkspaceQuota } from "./workspaces";
import { SERVICE_ACTIVATIONS } from "./serviceActivationSchema";
import { readServiceActivation, serviceActivationAccess, type ServiceActivationAccess } from "./serviceActivationAccess";
import { LIVE_JOURNAL_TABLE } from "./schema";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const key = (source: NativeOwnerActivationSource): LiveDocumentKey => parseLiveDocumentKey({workspaceId: source.workspaceId,
  mainVersionId: source.mainVersionId, objectId: source.objectId, lineageClaimId: source.lineageClaimId});

export class ServiceActivationStaleCut extends Error {
  constructor() { super("Ordinary replication advanced before service activation."); }
}

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
      if (current.kind !== "current" || !isDeepStrictEqual(current.host, input.host) ||
          !isDeepStrictEqual(current.binding, JSON.parse(String(row.binding_json)))) {
        throw new Error("Retained service activation authority changed.");
      }
      return {access, completed: row.completion_json !== null};
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
  }) {
    input.guard(); requireLiveJournalHistory(this.storage, this.history);
    const source = parseNativeOwnerActivationSource(input.capture.source, input.capture.source.currentPath, 20_971_520), document = key(source), baselineBytes = new Uint8Array(input.capture.baselineBytes),
      fullState = new Uint8Array(input.capture.fullState), activationId = input.capture.activationId;
    if (!/^ordinary-activation-[0-9a-f]{64}$/.test(activationId) || source.version !== 1 ||
        source.relayDatabaseNamespace !== this.history.namespace || source.fullStateByteLength !== fullState.length ||
        digest(fullState) !== source.fullStateDigest || digest(baselineBytes) !== source.lineageClaimId) {
      throw new Error("Native activation identity differs.");
    }
    const base = input.validateBaseline({document,currentPath:source.currentPath,checkpoint:baselineBytes});
    const state = input.validateJournal({document,currentPath:source.currentPath,checkpoint:baselineBytes,suffix:[],candidate:fullState});
    if (base.kind !== "accepted" || state.kind !== "accepted" ||
        state.evidence.projectedMarkdownSha256 !== source.sourceDigest || state.evidence.projectedMarkdownByteLength !== source.sourceByteLength) {
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
      const current = this.storage.db.prepare("SELECT replication_epoch,stream_identity FROM sync_relay_workspaces WHERE workspace_id=?").get(document.workspaceId);
      const highWater = this.storage.db.prepare("SELECT COALESCE(MAX(relay_seq),0) AS cursor FROM sync_relay_log WHERE workspace_id=?").get(document.workspaceId);
      if (current?.replication_epoch !== source.replicationEpoch || current.stream_identity !== source.streamIdentity ||
          highWater?.cursor !== source.committedCursor || source.baseRelaySeq > source.committedCursor ||
          source.baseRelaySeq <= this.storage.getEpochLogFloor(document.workspaceId)) throw new ServiceActivationStaleCut();
      const baseRow = this.storage.db.prepare(`SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND origin_id=? AND origin_seq=?
        AND relay_seq=? AND op_kind='ydoc.update'`).get(document.workspaceId, source.baseOriginId, source.baseOriginSeq, source.baseRelaySeq);
      const payload = baseRow && JSON.parse(String(baseRow.payload_json)) as Record<string,unknown> | undefined;
      if (!payload || payload.versionId !== document.mainVersionId || payload.objectId !== document.objectId || payload.contentKind !== "richdoc" ||
          payload.isBaseState !== true || payload.lineageClaimId !== document.lineageClaimId || payload.updateBlobSha256 !== document.lineageClaimId) {
        throw new Error("Native activation base coordinate differs from ordinary history.");
      }
      const storedLength = this.storage.db.prepare("SELECT byte_length FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?").get(document.workspaceId,source.lineageClaimId);
      if (storedLength?.byte_length !== baselineBytes.length) throw new Error("Ordinary activation base bytes are unavailable.");
      const ordinaryBase = this.storage.getBlob(document.workspaceId,source.lineageClaimId);
      if (!ordinaryBase || Buffer.compare(Buffer.from(ordinaryBase),Buffer.from(baselineBytes)) !== 0) throw new Error("Ordinary activation base bytes differ.");
      const latest = currentLiveDocumentMoment(this.storage,document,source.currentPath);
      const moment = latest && this.storage.db.prepare("SELECT moment_id FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=?")
        .get(document.workspaceId,document.objectId,latest.relay_seq);
      if (!latest || moment?.moment_id !== source.sourceMomentId || latest.blob_sha256 !== source.sourceDigest || latest.byte_length !== source.sourceByteLength) {
        throw new ServiceActivationStaleCut();
      }
      if (!registerLiveHostInTransaction(this.storage, {...input.host,updatedAtMs:input.registeredAtMs,guard:input.guard}).ok) throw new Error("Service activation host is unavailable.");
      const registration = registerLiveDocumentBaselineInTransaction(this.storage,{host:input.host,registeredAtMs:input.registeredAtMs,baselineBytes,
        evidence:{version:1,document,currentPath:source.currentPath,checkpoint:{updateDigest:source.lineageClaimId,ranges:base.evidence.checkpoint.ranges},
          projectedMarkdownSha256:source.sourceDigest,projectedMarkdownByteLength:source.sourceByteLength}});
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
}
