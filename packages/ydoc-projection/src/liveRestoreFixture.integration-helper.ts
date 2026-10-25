import {registered, host} from "./liveCommittedDeliveryTestSupport.js";
import {createLiveJournalHistoryAuthority} from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import {beginStopRestore, advanceStopRestoreFence, type StopRestoreIntent} from "../../../services/sync-relay/src/storage/liveRestoreOperation.js";
import type {StorageContext} from "../../../services/sync-relay/src/storage/context.js";
import type {CommittedBootstrap} from "../../../services/sync-relay/src/storage/liveCommittedDelivery.js";

export function fixture(kind: "bootstrap" | "owner" = "bootstrap",mode: "service" | "device" = "device", baselineBytes?: Uint8Array, readerArtifact?: import("./liveRestoreValidation.js").RestoreArtifact) {
  const coordinate = {...host,mode}, f = registered({host: coordinate, baselineBytes,readerArtifact}), context = f.storage as StorageContext;
  const history = createLiveJournalHistoryAuthority({namespace: "restore-test",reconciled: true});
  const store = f.storage.createLiveCommittedDeliveryStore(history), document = f.input.evidence.document;
  const intent: StopRestoreIntent = {deliveryKind: kind,operationId: "restore",ownerUserId: "owner",document,
    shareId: "share",grantId: "grant",expectedGrantGeneration: 4,expectedDependentGrantIds: [],expectedFence: 1,
    restorePointCursor: 0,restorePointReceiptDigest: document.lineageClaimId};
  const lookup = {operationId: "restore",workspaceId: "workspace",ownerUserId: "owner",host: coordinate};
  const add = (id: string) => {const result=f.storage.commitLiveUpdateJournal(f.capture(f.update(id,id),id)).result; if(result.kind!=="accepted")throw Error(result.kind); return result.receipt;};
  const fence = () => {beginStopRestore(context,intent,40); return advanceStopRestoreFence(context,lookup,50);};
  const open = () => {const result=store.openStopRestoreCut(lookup); if(result.kind!=="ready")throw Error(result.kind);return result.capture;};
  // The service host adopts the document's service activation, when it has one.
  const adopt = () => {
    const activation = context.db.prepare("SELECT activation_id FROM sync_relay_service_activations WHERE workspace_id=? AND object_id=?").get(document.workspaceId,document.objectId);
    const adoptionId = activation ? String(activation.activation_id) : "adoption";
    const cut=store.captureOwnerCut({host: coordinate,document,actor: f.actor,adoptionId,expectedLocalSequence: 0,maxBytes: 1_000_000,maxEvents: 10});
    store.acknowledgeOwnerAdoption(cut,{adoptionId,localYDocSequence: 0,terminalCursor: cut.cut.terminalReceipt?.journalCursor ?? 0,adoptionReplayed: false});
  };
  return {...f,journalCapture:f.capture,coordinate,context,history,store,document,intent,lookup,add,fence,open,adopt};
}
export const bootstrapAck=(b: CommittedBootstrap)=>({bootstrapId:b.bootstrapId,bootstrapMomentId:b.bootstrapMomentId,
  baselineDigest:b.baselineDigest,baselineMomentRelaySequence:b.baselineMomentRelaySequence,localYDocSequence:0,bootstrapReplayed:false});
export const applicationAck=(receipt: ReturnType<ReturnType<typeof fixture>["add"]>,sequence=1)=>({...receipt,localYDocSequence:sequence,applicationReplayed:false});
