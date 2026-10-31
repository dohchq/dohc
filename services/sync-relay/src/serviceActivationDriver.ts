import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import type {OwnerOutboxAdmission} from "./ownerOutboxDelivery";
import {OwnerKnownRefusals} from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import {isDeepStrictEqual} from "node:util";
import {EngineRequestError,isHostedDocumentUnready,isLiveDocumentWithoutLineage,type EngineClient,type NativeOwnerActivation,type RetainedPrefixBody} from "@dohc/workspace-engine-client/daemon";
import type {JsonValue} from "@dohc/workspace-engine-client";
import {hostedWindowCovers,type HostedWindow} from "@dohc/workspace-engine-client/relay-wire";
import {parseLiveDocumentKey,parseLiveUpdateIdentifier,type LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import {validateUserWritePath} from "@dohc/workspace-core";
import {liveDocumentKindForPath} from "@dohc/workspace-contracts/live-documents";
import type {OrderedLiveUpdateCutPolicy} from "../../../packages/ydoc-projection/src/orderedLiveUpdateCut";
import {configRecord} from "./deviceLiveHostConfig";
import {OwnerCommittedDelivery} from "./ownerCommittedDelivery";
import {settlementResponse,settlementPending,type CommittedSettlement} from "./liveSettlement";
import {authorityInteger} from "./storage/liveDocumentAuthority";
import {liveValidation} from "./liveValidation.js";
import {serviceOwnerTransport} from "./serviceOwnerTransport";
import {ServiceActivationBusy,ServiceActivationStaleCut,ServiceActivationTooLarge,type ServiceActivationStore} from "./storage/serviceActivation";
import type {ServiceActivationAccess} from "./storage/serviceActivationAccess";
import type {SyncRelayStorage,LiveHostConnectionCoordinate} from "./storage";
import type {DepartedOwnerDelivery} from "./storage/liveCommittedDelivery";
import type {LiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import type {LiveRestorePreparation} from "./liveRestorePreparation";
import type {StopRestoreLookup} from "./storage/liveRestoreOperation";
import type {ServiceHostedHold,ServiceHostedPullPage} from "./serviceHostedReplication";
import type {ServiceKeptEditsIdentity} from "./storage/serviceKeptEdits";
import type {RetirableServiceActivation} from "./storage/serviceActivationRetirement";

const positive=(value:unknown)=>{
  if(typeof value!=="number" || !Number.isSafeInteger(value) || value<1 || value>2_147_483_647)throw new Error("Invalid service activation budget.");
  return value;
};
export function parseServiceActivationTarget(value:unknown){
  const item=configRecord(value,["workspaceId","path","shareId"]);
  const checked=typeof item.path==="string"?validateUserWritePath(item.path):undefined;
  if(typeof item.path!=="string" || !checked?.ok || checked.normalized!==item.path || liveDocumentKindForPath(item.path)!=="richdoc")throw new Error("Invalid service activation path.");
  return Object.freeze({workspaceId:parseLiveUpdateIdentifier(item.workspaceId),path:item.path,shareId:parseLiveUpdateIdentifier(item.shareId)});
}
export type ServiceActivationTarget=ReturnType<typeof parseServiceActivationTarget>;
const targetKey=(target:ServiceActivationTarget)=>JSON.stringify([target.workspaceId,target.path]);
// A moved document's target is keyed by its object too, so a document now at its old path keeps its own state.
const movedKey=(target:ServiceActivationTarget,objectId:string)=>JSON.stringify([target.workspaceId,target.path,objectId]);
/** A host can start with no targets; the self-hosted supervisor adds them as documents are shared. */
export function parseServiceActivationConfig(value:unknown){
  if(value===undefined)return undefined;
  const row=configRecord(value,["targets","validation","maxCaptureBytes","maxEntriesPerDrain","maxBytesPerDrain","maxDocumentsPerPass","pollIntervalMs","passDeadlineMs","idleUnloadMs","idleRetryMs"]);
  if(!Array.isArray(row.targets) || row.targets.length>64)throw new Error("Invalid service activation targets.");
  const targets=row.targets.map(parseServiceActivationTarget);
  if(new Set(targets.map(targetKey)).size!==targets.length)throw new Error("Duplicate service activation target.");
  const policy=configRecord(row.validation,["maxStructVisits","maxValueNodeVisits","maxDecodedPayloadByteVisits","maxStructClientGroupVisits","maxDeleteClientGroupVisits","maxDeleteIntervalVisits","maxIndexOperations"]);
  for(const value of Object.values(policy))positive(value);
  const validation=Object.freeze({...policy}) as unknown as OrderedLiveUpdateCutPolicy;
  return Object.freeze({targets:Object.freeze(targets),validateActivation:liveValidation.ordinaryActivation(validation),
    validateAdmission:liveValidation.validator(validation),maxCaptureBytes:positive(row.maxCaptureBytes),
    maxEntriesPerDrain:positive(row.maxEntriesPerDrain),maxBytesPerDrain:positive(row.maxBytesPerDrain),
    maxDocumentsPerPass:positive(row.maxDocumentsPerPass),pollIntervalMs:positive(row.pollIntervalMs),passDeadlineMs:positive(row.passDeadlineMs),
    idleUnloadMs:positive(row.idleUnloadMs),idleRetryMs:positive(row.idleRetryMs)});
}
export type ServiceActivationConfig=NonNullable<ReturnType<typeof parseServiceActivationConfig>>;
/**
 * Why a document waits for its owner: the engine refused it or its capture ran validation out of memory,
 * its copy here is missing an owner edit, or it has no Y.Doc lineage to activate.
 */
export type ServiceActivationBlock="refused"|"live-edit-unadmitted"|"without-lineage";
type Owner={consumer:OwnerCommittedDelivery;transport:ReturnType<typeof serviceOwnerTransport>;completed:boolean;activationPending:boolean;
  binding:LiveObjectBinding;target:string;actor:{ownerUserId:string;shareId:string}};
const fenced={kind:"pending" as const,reason:"Service binding is fenced or unavailable."};
/** How a departed document's settlement ended. The engine refuses an `unready` document's registration, as once it parked. */
export type DepartedSettlement={kind:"settled";settlement:CommittedSettlement}|{kind:"pending";reason:string}|{kind:"unready"};
/** A workspace's hosted replica, as activation uses it. */
export interface ServiceActivationReplica {
  pull(signal:AbortSignal):Promise<{hasMore:boolean}>;
  publish(signal?:AbortSignal):Promise<{pushed:number;hasMore:boolean}>;
}
/** One activation pass's catch-up pull of each workspace, with the relay log head it started at. */
export type ServiceCatchUp=Map<string,Promise<{head:number;hasMore:boolean}>>;
/** What the document's hosted replica confirmed of it since it began departing. */
export interface RetirementScope {
  /** A pull confirmed the document left the hosted scope. */
  departed():boolean;
  /** A pull confirmed it parked: it is no longer departed. */
  parked():boolean;
}
/**
 * How one retirement pass ended. Held: the journal proved what the engine asked, and a refused
 * adoption seed it cannot abandon still holds the retirement, which no later pass changes by itself.
 */
export type RetirementStep={kind:"retired"}|{kind:"held"}|{kind:"pending";reason:string};
const RETIREMENT_ROUNDS=4;
const retiring={kind:"pending" as const,reason:"Service activation is retiring."};
// The engine's answer for its `status`, with exactly that status's keys.
function answer(value:unknown,statuses:Record<string,readonly string[]>):Record<string,unknown>&{status:string}{
  const status=value && typeof value==="object"?(value as {status?:unknown}).status:undefined;
  if(typeof status!=="string" || !Object.hasOwn(statuses,status))throw new Error("Invalid live retirement response.");
  return {...configRecord(value,["status",...statuses[status]!]),status};
}

export class ServiceActivationDriver {
  readonly #store;
  readonly #delivery;
  #targets:readonly ServiceActivationTarget[];
  readonly #completedTargets=new Set<string>();
  readonly #staleLeases=new Map<string,{activationId:string;sessionId:string}>();
  readonly #owners=new Map<string,Owner>();
  // Targets this driver may have loaded into the engine since it started.
  readonly #loaded=new Set<string>();
  // Hosted targets the engine unloaded while idle, with their documents. Passes skip them until they wake.
  readonly #dormant=new Map<string,string>();
  // Targets a hosted pass left held, with the reason, until the engine captures them again.
  readonly #held=new Map<string,ServiceHostedHold["reason"]>();
  // Targets that cannot progress, with why. Each failed its one capture; passes skip it until `unblock` allows one more.
  // One without lineage also tries once more when the relay holds a Y.Doc update for its document newer than `update`, the latest before that capture's pull.
  // One held for released retained work never captures: only the resolution of the binding whose digest it keeps clears it.
  readonly #blocked=new Map<string,{reason:"refused"|"live-edit-unadmitted"}|{reason:"without-lineage";update:number}|
    {reason:"released-lineage-unsettled";digest:string}>();
  // Each target's document, once known, so a hold applies before the target has an owner, as after a restart.
  readonly #objects=new Map<string,string>();
  // How often each target's activation began to retire. An activation that started before then never becomes ready.
  readonly #retirements=new Map<string,number>();
  // Each enrolled target's document, from `addTarget`. Its activation reads name it, so they never read another document's activation at the same path.
  readonly #enrolled=new Map<string,string>();
  // Owner refusals received but not yet recorded, kept across every owner this driver replaces.
  readonly #refusals=new OwnerKnownRefusals();
  constructor(readonly options:{trustedAccount: OwnerOutboxAdmission["trustedAccount"];storage:SyncRelayStorage;history:LiveJournalHistoryAuthority;client:EngineClient;host:LiveHostConnectionCoordinate;
    /** An attached workspace whose replica checked its origin. Activation, restore and departures reach no other. */
    workspace(workspaceId:string):{handle:string;replica:ServiceActivationReplica;identity:ServiceKeptEditsIdentity}|undefined;config:ServiceActivationConfig;
    adoption:{maxBytes:number;maxEvents:number};restore?:LiveRestorePreparation;nextRequestId():number;deadlineMs:number;
    /** The engine's settlement bound, which also bounds a retirement's applications. Configuration admission requires it. */
    maxApplications?:number;
    assertCurrent():void;registered():void;
    runDocument<T>(document:LiveDocumentKey,signal:AbortSignal,operation:()=>Promise<T>):Promise<T>;}){
    this.#store=options.storage.createServiceActivationStore(options.history);
    this.#delivery=options.storage.createLiveCommittedDeliveryStore(options.history);
    this.#targets=options.config.targets;
  }
  /** The documents activation passes visit, in pass order. */
  get targets(){return this.#targets;}
  /** Adds one document to activation passes, replacing an earlier target at its path. */
  addTarget(target:ServiceActivationTarget,objectId:string){
    this.#targets=[...this.#targets.filter(row=>targetKey(row)!==targetKey(target)),target];
    this.#objects.set(targetKey(target),objectId);this.#enrolled.set(targetKey(target),objectId);
  }
  /** Whether this driver may have loaded the document into the engine. */
  loaded(target:ServiceActivationTarget){return this.#loaded.has(targetKey(target));}
  /** Whether the target's last pass delivered and settled it. */
  completed(target:ServiceActivationTarget){return this.#completedTargets.has(targetKey(target));}
  /** The document a target's owner delivery holds, if one does. */
  ownerDocument(target:ServiceActivationTarget){
    for(const [document,owner] of this.#owners)if(owner.target===targetKey(target))return parseLiveDocumentKey(JSON.parse(document));
    return undefined;
  }
  /** Forgets a document the engine no longer holds, so a later pass activates it from its retained source. */
  removeTarget(target:ServiceActivationTarget){this.#forget(targetKey(target));}
  /** The document and consumer of the owner a restore step built through a moved document's route, if one did. */
  movedOwner(target:ServiceActivationTarget,objectId:string){
    const slot=movedKey(target,objectId);
    for(const [document,owner] of this.#owners)if(owner.target===slot)return {document:parseLiveDocumentKey(JSON.parse(document)),consumer:owner.consumer};
    return undefined;
  }
  /** Forgets the target of a moved document's restore, which `restoreConsumer` and `retire` were given as moved. */
  forgetMoved(target:ServiceActivationTarget,objectId:string){this.#forget(movedKey(target,objectId));}
  #forget(key:string){
    this.#targets=this.#targets.filter(row=>targetKey(row)!==key);
    this.#completedTargets.delete(key);this.#staleLeases.delete(key);this.#loaded.delete(key);this.#dormant.delete(key);this.#held.delete(key);this.#blocked.delete(key);this.#objects.delete(key);this.#enrolled.delete(key);
    for(const [document,owner] of this.#owners)if(owner.target===key)this.#owners.delete(document);
  }
  /**
   * Clears readiness of documents a hosted pass left held. The engine has
   * already ended their sessions; each activates again once its capture
   * succeeds. Until then they do not hold back their workspace's pulls,
   * which bring what they wait for. `holds` is every document the pass left
   * held within `window`, so one there it no longer holds for released
   * retained work is free of that hold. Past the window, only the documents
   * in `newlyHeld`, which the pass moved from ready to held, become held at
   * once; that list frees nothing. While it may leave some out, every other
   * owner past the window is dropped too, and activates again on a later
   * pass, where the engine refuses it if it is held. Returns how many owners
   * it dropped that way.
   */
  hold(workspaceId:string,holds:readonly ServiceHostedHold[],window:HostedWindow,newlyHeld:ServiceHostedPullPage["newlyHeld"]){
    let dropped=0;
    for(const [key,objectId] of this.#objects){
      if(JSON.parse(key)[0]!==workspaceId)continue;
      const covered=hostedWindowCovers(window,objectId);
      const hold=covered?holds.find(row=>row.objectId===objectId):newlyHeld.listed.find(row=>row.objectId===objectId);
      if(covered && hold?.reason!=="released-lineage-unsettled" && this.#blocked.get(key)?.reason==="released-lineage-unsettled")this.#blocked.delete(key);
      if(!hold){
        if(!covered && !newlyHeld.complete && this.#drop(key))dropped++;
        continue;
      }
      this.#drop(key);this.#dormant.delete(key);this.#held.set(key,hold.reason);
      // A fresh binding replaces the one held before; that resolves nothing.
      if(hold.reason==="released-lineage-unsettled")this.#blocked.set(key,{reason:hold.reason,digest:hold.bindingDigest});
    }
    return dropped;
  }
  // Ends the target's readiness and its owner, if it has one. Returns whether it had one.
  #drop(key:string){
    this.#completedTargets.delete(key);
    let owned=false;
    for(const [document,owner] of this.#owners)if(owner.target===key){owner.completed=false;this.#owners.delete(document);owned=true;}
    return owned;
  }
  /** Why the target failed the one capture it gets while it cannot progress, if it did. Activation skips it. */
  blocked(target:ServiceActivationTarget):ServiceActivationBlock|undefined{
    const block=this.#blocked.get(targetKey(target));
    return block?.reason==="released-lineage-unsettled"?undefined:block?.reason;
  }
  /** Why the hosted pass left this target held, until a capture succeeds. */
  holdReason(target:ServiceActivationTarget):ServiceHostedHold["reason"]|undefined{return this.#held.get(targetKey(target));}
  /** Allows a blocked target one more capture. Returns whether it was blocked. A hold for released retained work stays. */
  unblock(target:ServiceActivationTarget){return this.#unblock(targetKey(target));}
  #unblock(key:string){return this.#blocked.get(key)?.reason!=="released-lineage-unsettled" && this.#blocked.delete(key);}
  /** The digest of the binding the target is held with for released retained work, if it is. Activation skips it. */
  releasedHold(target:ServiceActivationTarget){
    const block=this.#blocked.get(targetKey(target));
    return block?.reason==="released-lineage-unsettled"?block.digest:undefined;
  }
  /** Ends the target's hold for released retained work once the binding `digest` names is resolved. Returns whether it did. */
  clearResolvedHold(target:ServiceActivationTarget,digest:string){
    return this.releasedHold(target)===digest && this.#blocked.delete(targetKey(target));
  }
  // Keeps the target's hold for released retained work through `clear`.
  #keepReleasedHold(key:string,clear:()=>void){
    const block=this.#blocked.get(key);
    clear();
    if(block?.reason==="released-lineage-unsettled")this.#blocked.set(key,block);
  }
  // A document with no Y.Doc lineage has nothing to activate until one reaches the relay, a held
  // document whose live edit was never admitted cannot become ready, and a retained activation
  // the engine refuses as diverged cannot resume. Each blocks after its failed capture. A document
  // that is only not ready, or whose first capture met another conflict, waits.
  #refused(key:string,resuming:boolean,update:number,error:unknown){
    const diverged=resuming && error instanceof EngineRequestError && error.wireError?.code==="CONFLICT" && !isHostedDocumentUnready(error);
    // A pull during this capture may have held it for released retained work.
    if(this.#blocked.get(key)?.reason==="released-lineage-unsettled")return;
    if(isLiveDocumentWithoutLineage(error))this.#blocked.set(key,{reason:"without-lineage",update});
    else if(this.#held.get(key)==="hosted-live-edit-unadmitted")this.#blocked.set(key,{reason:"live-edit-unadmitted"});
    else if(diverged)this.#blocked.set(key,{reason:"refused"});
    else this.#blocked.delete(key);
  }
  // The relay sequence of the latest Y.Doc update for the target's document, or 0 while it has none.
  #latestUpdate(target:ServiceActivationTarget){
    const storage=this.options.storage,objectId=this.#objects.get(targetKey(target)) ??
      storage.objectIdAtPathInVersion({workspaceId:target.workspaceId,versionId:"main",path:target.path});
    return objectId===undefined?0:storage.latestServiceHostDocumentUpdate({workspaceId:target.workspaceId,objectId});
  }
  /**
   * Forgets a document the engine unloaded while it stays a target, and ends
   * its registration. Passes skip it until it wakes, then activate it again
   * from its retained source.
   */
  sleep(target:ServiceActivationTarget,document:LiveDocumentKey){
    const key=JSON.stringify(parseLiveDocumentKey(document)),owner=this.#owners.get(key);
    owner?.consumer.release(document);
    this.#keepReleasedHold(targetKey(target),()=>{this.removeTarget(target);this.addTarget(target,document.objectId);});
    this.#dormant.set(targetKey(target),key);
  }
  dormant(target:ServiceActivationTarget){return this.#dormant.has(targetKey(target));}
  /** Whether the document belongs to a dormant target, which wakes when it is opened. */
  asleep(document:LiveDocumentKey){
    const key=JSON.stringify(parseLiveDocumentKey(document));
    return [...this.#dormant.values()].includes(key);
  }
  wake(target:ServiceActivationTarget){this.#dormant.delete(targetKey(target));}
  hasRetained(){
    return this.#targets.some(target=>this.retained(target));
  }
  /** Whether the relay retains an activation of the document at the target's path. `objectId` is as for `activationId`. */
  retained(target:ServiceActivationTarget,objectId?:string){
    return this.activationId(target,objectId)!==undefined;
  }
  /**
   * The activation the relay retains at the target's path, which an unload of its document names.
   * A host that holds a document without its target, or removed the target while the document parks,
   * names that document as `objectId`.
   */
  activationId(target:ServiceActivationTarget,objectId?:string){
    return this.#read(target,objectId)?.activationId;
  }
  /** The activation retained at the target's path, its enrolled document's when the target has one. A static target reads by path alone. */
  #read(target:ServiceActivationTarget,objectId=this.#enrolled.get(targetKey(target))){
    return this.#store.read(target.workspaceId,target.path,this.options.config.maxCaptureBytes,objectId);
  }
  /**
   * The owner through which a restore step reaches the document. `moved` is the
   * frozen target of a document that left its enrolled path, whose unfinished
   * restore continues there although it is no longer a target. Either way only
   * the document's own activation is read, and a target at the same path that
   * holds another document is passed over.
   */
  restoreConsumer(document:LiveDocumentKey,lookup:StopRestoreLookup,moved?:ServiceActivationTarget){
    const o=this.options,key=JSON.stringify(parseLiveDocumentKey(document));
    let target:ServiceActivationTarget|undefined,saved:ReturnType<ServiceActivationStore["read"]>=null;
    for(const row of moved?[moved]:this.#targets){
      const object=moved?undefined:this.#objects.get(targetKey(row));
      if(row.workspaceId!==document.workspaceId || (object!==undefined && object!==document.objectId))continue;
      const read=this.#store.read(row.workspaceId,row.path,o.config.maxCaptureBytes,document.objectId);
      if(read?.completed && read.shareId===row.shareId && read.source.objectId===document.objectId && read.source.lineageClaimId===document.lineageClaimId){
        target=row;saved=read;break;
      }
    }
    const workspace=o.workspace(document.workspaceId);
    if(!target || !saved || !workspace)throw new Error("Service restore source is unavailable.");
    // Stopping access re-registers the retained owner. Only the activated session's
    // verified transport can check that adoption.
    const activated=this.#owners.get(key);
    if(activated && !activated.activationPending)return activated.consumer;
    // Without that session, as for a dormant document or after a restart, the
    // owner takes the operation's binding, whose adoption must be that activation.
    // Only a step that registers reloads the retained activation into a new native session.
    const operation=o.storage.readStopRestore(lookup),origin=operation?.basis.ownerOrigin;
    if(!operation || operation.intent.deliveryKind!=="owner" || !isDeepStrictEqual(operation.intent.document,parseLiveDocumentKey(document)) ||
      operation.intent.shareId!==saved.shareId || operation.intent.ownerUserId!==saved.ownerUserId || !origin ||
      JSON.parse(origin)?.adoptionId!==saved.activationId)throw new Error("Service restore owner adoption is unavailable.");
    const slot=moved?movedKey(target,document.objectId):targetKey(target);
    const owner:Owner=this.#owner(target,async signal=>{
      const sleeping=this.#dormant.get(slot);
      // Once sent, the capture may load the session whatever its reply, so a dormant target
      // rejoins passes, which settle it and resume its session as for an awake document.
      // Only the engine's refusal, which loads nothing, leaves it dormant.
      this.#loaded.add(slot);this.#dormant.delete(slot);
      let capture:NativeOwnerActivation;
      try{
        capture=await o.client.captureOwnerActivation({id:o.nextRequestId(),workspace:workspace.handle,deadlineMs:o.deadlineMs},
          target.path,o.config.maxCaptureBytes,signal,saved.activationId);
      }catch(error){
        if(sleeping!==undefined && error instanceof EngineRequestError && error.wireError?.code==="INVALID_PARAMS")this.#dormant.set(slot,sleeping);
        throw error;
      }
      signal?.throwIfAborted();o.assertCurrent();this.#held.delete(slot);this.#objects.set(slot,document.objectId);
      if(capture.activationId!==saved.activationId || !isDeepStrictEqual(capture.source,saved.source))throw new Error("Native service activation source changed.");
      this.#owners.set(key,owner);
      return capture;
    },{binding:operation.basis.ownerBinding,activationPending:false,actor:{ownerUserId:saved.ownerUserId,shareId:saved.shareId}},undefined,slot);
    return owner.consumer;
  }
  workspaceReady(workspaceId:string){
    return this.#targets.filter(target=>target.workspaceId===workspaceId && !this.dormant(target) && !this.#held.has(targetKey(target)) &&
      !this.#blocked.has(targetKey(target))).every(target=>this.#completedTargets.has(targetKey(target)));
  }
  consumer(value:LiveDocumentKey){
    const document=parseLiveDocumentKey(value),owner=this.#owners.get(JSON.stringify(document));
    if(!owner?.completed || this.#invalidated(owner,document))throw new Error("Service document activation is incomplete.");
    return owner;
  }
  /**
   * The document of the activation the relay retains at the target's path,
   * once this connection has standing for it, whatever its owner's authority.
   * Undefined when it retains none. `objectId` is as for `activationId`.
   */
  departing(target:ServiceActivationTarget,signal:AbortSignal,objectId?:string){
    const o=this.options,saved=this.#read(target,objectId);
    if(!saved)return undefined;
    if(saved.shareId!==target.shareId)throw new Error("Service activation share changed.");
    const document=parseLiveDocumentKey({workspaceId:saved.source.workspaceId,mainVersionId:saved.source.mainVersionId,
      objectId:saved.source.objectId,lineageClaimId:saved.source.lineageClaimId});
    const check=()=>{signal.throwIfAborted();o.assertCurrent();};
    this.#store.departing({document,activationId:saved.activationId,host:o.host,registeredAtMs:Date.now(),guard:check});
    o.registered();check();
    return document;
  }
  /**
   * Settles what the host applied of a document whose owner lost live
   * authority, as after Stop or the loss of its last Edit grant, from durable
   * state alone: the relay's journal and owner tip, and the engine's record of
   * what it applied. It registers through the engine client itself, so it
   * captures no session, and it sends no application, so it accepts nothing.
   * Runs in the work of the document `departing` returned. Null when nothing
   * was adopted here.
   */
  async settleDeparted(target:ServiceActivationTarget,value:LiveDocumentKey,signal:AbortSignal):Promise<DepartedSettlement|null>{
    const reconciled=await this.#reconcile(target,value,signal,false);
    if(reconciled?.kind!=="reconciled")return reconciled;
    const o=this.options,{registrationId,tip}=reconciled;
    const settled=await settlementResponse(o.client.sendRequest({id:o.nextRequestId(),workspace:o.workspace(target.workspaceId)!.handle,deadlineMs:o.deadlineMs,
      method:"liveApplication.settle",params:{registrationId,terminalReceipt:tip?{...tip}:null}},signal),tip);
    signal.throwIfAborted();o.assertCurrent();
    if(settlementPending(settled))return settled;
    return {kind:"settled",settlement:settled};
  }
  /**
   * Records what the engine applied of a document whose owner lost live
   * authority while it stays hosted, as between Stop and its departure or
   * after a Resume while its activation retires. The relay holds the engine's
   * output for a row past the owner tip, and every row the workspace publishes
   * after it, so this runs before anything publishes. It does nothing once the
   * owner applied every accepted row. Runs in the work of the document
   * `departing` returned.
   */
  reconcileDeparted(target:ServiceActivationTarget,value:LiveDocumentKey,signal:AbortSignal){
    return this.#reconcile(target,value,signal,true);
  }
  // Registers the departed document through the engine client and records
  // each accepted row the engine applied, with this connection's standing.
  // Null when nothing was adopted here or, with `behind`, nothing is past the tip.
  async #reconcile(target:ServiceActivationTarget,value:LiveDocumentKey,signal:AbortSignal,behind:boolean):
    Promise<{kind:"reconciled";registrationId:number;tip:DepartedOwnerDelivery["tip"]}|Exclude<DepartedSettlement,{kind:"settled"}>|null>{
    const o=this.options,workspace=o.workspace(target.workspaceId);
    if(!workspace)throw new Error("Service activation workspace is not attached.");
    const check=()=>{signal.throwIfAborted();o.assertCurrent();};
    const request=()=>({id:o.nextRequestId(),workspace:workspace.handle,deadlineMs:o.deadlineMs});
    const document=parseLiveDocumentKey(value),saved=this.#store.read(target.workspaceId,target.path,o.config.maxCaptureBytes,document.objectId);
    if(!saved || saved.shareId!==target.shareId || saved.source.objectId!==document.objectId || saved.source.lineageClaimId!==document.lineageClaimId) {
      throw new Error("Retained service activation changed.");
    }
    check();
    const input={host:o.host,document,adoptionId:saved.activationId};
    let delivery=this.#delivery.departedOwnerDelivery(input);
    if(!delivery || (behind && !delivery.next))return null;
    // Registering retires the engine registration a cached owner holds. That owner
    // registers again, and the document is ready again, only if it returns.
    const owner=this.#owners.get(JSON.stringify(document));
    if(owner){owner.consumer.release(document);owner.completed=false;}
    this.#completedTargets.delete(targetKey(target));
    let registered;
    try{
      registered=await o.client.sendRequest({...request(),method:"liveApplication.register",
        params:{binding:{...delivery.binding,selectorPaths:[...delivery.binding.selectorPaths]},activationId:saved.activationId}},signal);
    }catch(error){
      // A parked document, or one its replica's scope still holds but not ready.
      if(isHostedDocumentUnready(error))return {kind:"unready"};
      throw error;
    }
    check();
    const registrationId=authorityInteger(configRecord(registered.result,["registrationId"]).registrationId,1);
    // Record each accepted row the engine applied. One it did not apply stays unapplied, and so do those after it.
    for(let read=0;delivery.next;read++){
      if(read===o.adoption.maxEvents)return {kind:"pending",reason:"Departed document reconciliation reached its work budget."};
      const ack=await o.client.readLiveApplicationAck({...request(),registrationId},delivery.next,signal);
      check();
      if(!ack)break;
      delivery=this.#delivery.recordDepartedApplication({...input,binding:delivery.binding},ack);
    }
    return {kind:"reconciled",registrationId,tip:delivery.tip};
  }
  /**
   * Asks the engine, through the workspace `handle`, to refuse new local edits
   * of the activation once nothing of it waits for delivery or holds a Try
   * again. False while something does; nothing is blocked then. The block
   * ends at its release, once the engine begins the activation's retirement,
   * or with this connection.
   */
  async prepareRetirement(handle:string,objectId:string,activation:RetirableServiceActivation,signal:AbortSignal):Promise<boolean>{
    const o=this.options;
    const response=await o.client.sendRequest({id:o.nextRequestId(),workspace:handle,deadlineMs:o.deadlineMs,
      method:"liveApplication.prepareRetirement",params:{objectId,...activation}},signal);
    const reply=answer(response.result,{prepared:[],pending:["reason"]});
    if(reply.status==="pending" && reply.reason!=="native-pending" && reply.reason!=="retry-outstanding")throw new Error("Invalid live retirement response.");
    return reply.status==="prepared";
  }
  /** Ends the block `prepareRetirement` set, if it stands. */
  async releaseRetirementPreparation(handle:string,objectId:string,activation:RetirableServiceActivation,signal:AbortSignal){
    const o=this.options;
    const response=await o.client.sendRequest({id:o.nextRequestId(),workspace:handle,deadlineMs:o.deadlineMs,
      method:"liveApplication.releaseRetirementPreparation",params:{objectId,...activation}},signal);
    if(typeof configRecord(response.result,["released"]).released!=="boolean")throw new Error("Invalid live retirement response.");
  }
  /**
   * Moves the document's open retirement as far as it can. The engine proves
   * what the retiring activation delivered and applied, and the relay records
   * it; what it applied settles and publishes. Once a pull confirms the
   * document left its hosted scope, the engine releases the activation and the
   * relay retires it. Its target then leaves activation, which captures its
   * successor once the document is hosted again. Undefined while none is open.
   * It needs no document work: it reaches only the activation the obligation
   * names, which the engine no longer registers or opens. A `moved` target, as
   * `restoreConsumer` takes it, is forgotten instead, and no target at its path
   * changes.
   */
  async retire(target:ServiceActivationTarget,objectId:string,signal:AbortSignal,scope:RetirementScope,moved=false):Promise<RetirementStep|undefined>{
    const o=this.options,open=o.storage.serviceActivationRetirement({workspaceId:target.workspaceId,objectId});
    if(!open)return undefined;
    const slot=moved?movedKey(target,objectId):targetKey(target);
    // An unfinished restore moves the generation the key names and continues through the
    // document's owner and target, so nothing retires, or leaves activation, until it ends.
    if(o.storage.serviceRestoreInProgress(open))return {kind:"pending",reason:"Waiting for its restore to finish."};
    const workspace=o.workspace(target.workspaceId),maxApplications=o.maxApplications;
    if(!workspace)throw new Error("Service activation workspace is not attached.");
    if(maxApplications===undefined)throw new Error("Service activation retirement requires live settlement.");
    const check=()=>{signal.throwIfAborted();o.assertCurrent();};
    const send=async(method:string,params:JsonValue)=>{
      const response=await o.client.sendRequest({id:o.nextRequestId(),workspace:workspace.handle,deadlineMs:o.deadlineMs,method,params},signal);
      check();
      return response.result;
    };
    this.#retirements.set(slot,(this.#retirements.get(slot)??0)+1);
    this.#drop(slot);this.#dormant.delete(slot);this.#targets=this.#targets.filter(row=>targetKey(row)!==slot);
    const document=parseLiveDocumentKey({workspaceId:open.workspaceId,mainVersionId:"main",objectId:open.objectId,lineageClaimId:open.lineageClaimId});
    const key={objectId:open.objectId,lineageClaimId:open.lineageClaimId,activationId:open.activationId,
      restoreFenceGeneration:open.restoreFenceGeneration,acceptedThrough:open.acceptedThrough};
    const input={host:o.host,document,adoptionId:open.activationId};
    this.#store.departing({document,activationId:open.activationId,host:o.host,registeredAtMs:Date.now(),guard:check});
    o.registered();check();
    // Each round answers what the engine asked for last.
    let journal:JsonValue|undefined,settle=false;
    for(let round=0;;round++){
      if(round===RETIREMENT_ROUNDS)return {kind:"pending",reason:"Retirement reconciliation reached its work budget."};
      let owned=this.#delivery.departedOwnerDelivery(input);
      const tip=owned?.tip ?? null;
      const reply=answer(await send("liveApplication.reconcileActivation",{...key,afterReceipt:tip && {...tip},maxApplications,...(journal?{journal}:{})}),
        {pending:["reason","deliveries"],reconciled:["adoption","applications","hasMoreApplications","settle"]});
      const proved=journal!==undefined;
      journal=undefined;
      if(reply.status==="pending"){
        if(proved && reply.reason==="seed-quarantined")return {kind:"held"};
        if(!Array.isArray(reply.deliveries) || !reply.deliveries.every(id=>typeof id==="string"))throw new Error("Invalid live retirement response.");
        const evidence=o.storage.retirementJournalEvidence(open,reply.deliveries);
        journal={receipts:evidence.receipts.map(receipt=>({...receipt})),absent:evidence.absent};
        continue;
      }
      if(reply.adoption!==null && !owned){
        // The engine adopted the activation, but its ACK never reached the relay.
        const adoption=configRecord(reply.adoption,["adoptionId","localYDocSequence","terminalCursor","adoptionReplayed"]);
        const cut=this.#delivery.captureOwnerCut({...input,expectedLocalSequence:authorityInteger(adoption.localYDocSequence),
          maxBytes:o.adoption.maxBytes,maxEvents:o.adoption.maxEvents,throughCursor:authorityInteger(adoption.terminalCursor)});
        this.#delivery.acknowledgeOwnerAdoption(cut,adoption);
        continue;
      }
      if(!Array.isArray(reply.applications) || typeof reply.hasMoreApplications!=="boolean" || typeof reply.settle!=="boolean")throw new Error("Invalid live retirement response.");
      if((reply.adoption===null)!==(owned===null))throw new Error("Retiring activation's adoption differs from the engine's.");
      for(const ack of reply.applications)owned=this.#delivery.recordDepartedApplication({...input,binding:owned!.binding},ack);
      settle=reply.settle;
      if(!reply.hasMoreApplications)break;
    }
    const owned=this.#delivery.departedOwnerDelivery(input),tip=owned?.tip ?? null;
    if(settle){
      const settled=await settlementResponse(send("liveApplication.settle",{retirement:key,terminalReceipt:tip && {...tip}}).then(result=>({result})),tip);
      if(settlementPending(settled))return settled;
      if(!settled.materialized)return {kind:"pending",reason:"Settlement has not reached the file."};
    }
    // Retained output publishes whether or not this pass settled any.
    if((await workspace.replica.publish(signal)).hasMore){check();return {kind:"pending",reason:"Hosted publication has more pages."};}
    check();
    if(!scope.departed())return {kind:"pending",reason:"Waiting for its hosted replica to confirm the document left."};
    const released=answer(await send("liveApplication.releaseActivation",{...key}),{pending:["reason"],released:["replayed","boundary"]});
    if(released.status==="pending"){
      if(released.reason==="parking")return {kind:"pending",reason:"Waiting for its hosted replica to confirm the document parked."};
      if(released.reason==="reconciliation")return {kind:"pending",reason:"Retirement reconciliation is unfinished."};
      throw new Error("Invalid live retirement response.");
    }
    // An activation that never adopted may release before its document parks; it retires only once it has.
    if(!owned && !scope.parked())return {kind:"pending",reason:"Waiting for its hosted replica to confirm the document parked."};
    // A key at a restore's accepted row waits for that restore's settlement to publish; the next pass replays the release.
    if(this.#store.completeRetirement({workspaceId:open.workspaceId,key,boundary:released.boundary as RetainedPrefixBody|null,
      host:o.host,registeredAtMs:Date.now(),nowMs:Date.now(),guard:check}).status==="pending"){
      return {kind:"pending",reason:"Waiting for its restore to finish."};
    }
    o.registered();check();
    if(moved)this.#forget(slot);
    else this.#keepReleasedHold(slot,()=>this.removeTarget(target));
    return {kind:"retired"};
  }
  /**
   * Activates the target and drains it. A target with no owner here first pulls
   * its workspace, which also tells this driver whether the engine holds it.
   * The targets of one pass share `catchUp`, so each workspace pulls once for all of them.
   * Without it, a retained activation resumes without that pull: its
   * caller pulled already, or the document left the hosted set, and a pull
   * would adopt the scope it left, after which the engine no longer captures it.
   * `objectId` is as for `activationId`.
   */
  async activate(target:ServiceActivationTarget,signal:AbortSignal,
    settle?:(consumer:OwnerCommittedDelivery,document:LiveDocumentKey,signal:AbortSignal)=>Promise<unknown>,catchUp?:ServiceCatchUp,objectId?:string){
    const o=this.options,c=o.config,workspace=o.workspace(target.workspaceId);
    if(!workspace)throw new Error("Service activation workspace is not attached.");
    const check=()=>{signal.throwIfAborted();o.assertCurrent();};
    const request=()=>({id:o.nextRequestId(),workspace:workspace.handle,deadlineMs:o.deadlineMs});
    check();
    const key=targetKey(target),generation=this.#retirements.get(key);
    // A retirement that began while this pass waited keeps the activation from becoming ready.
    const retired=()=>this.#retirements.get(key)!==generation;
    const releaseStale=async()=>{
      const lease=this.#staleLeases.get(key);
      if(!lease)return;
      const released=await o.client.sendRequest({...request(),method:"liveApplication.releaseOwnerActivation",params:lease},signal);check();
      if(configRecord(released.result,["released"]).released!==true)throw new Error("Stale native activation lease was not released.");
      this.#staleLeases.delete(key);
    };
    // A blocked target still releases the lease its failed capture left.
    await releaseStale();
    const block=this.#blocked.get(key);
    if(block?.reason==="released-lineage-unsettled"){
      return {kind:"pending" as const,reason:"Hosted document is held until its retained work is resolved."};
    }
    if(block && !(block.reason==="without-lineage" && this.#latestUpdate(target)>block.update)){
      return {kind:"pending" as const,reason:"Hosted document is blocked until the owner tries again."};
    }
    let saved=this.#read(target,objectId);
    if(!saved)this.#completedTargets.delete(key);
    if(saved && saved.shareId!==target.shareId)throw new Error("Service activation share changed.");
    if(saved)this.#objects.set(key,saved.source.objectId);
    // An activation whose retirement is open leaves only through `retire`, even once Resume hosts its document again.
    if(saved && o.storage.serviceActivationRetirement({workspaceId:target.workspaceId,objectId:saved.source.objectId}))return retiring;
    let document=saved?parseLiveDocumentKey({workspaceId:saved.source.workspaceId,mainVersionId:saved.source.mainVersionId,
      objectId:saved.source.objectId,lineageClaimId:saved.source.lineageClaimId}):undefined;
    let owner=document?this.#owners.get(JSON.stringify(document)):undefined;
    if(owner?.completed && document && this.#invalidated(owner,document)){
      // A fenced binding keeps its owner for the restore; another binding activates again.
      owner=this.#owners.get(JSON.stringify(document));
      if(owner)return fenced;
    }
    if(!owner){
      let update=this.#latestUpdate(target);
      if(catchUp || !saved){
        let pulling=catchUp?.get(target.workspaceId);
        if(!pulling){
          // Read first: the pull brings every update through the head, so the capture has seen them all.
          const head=o.storage.automationWorkspaceLogHead(target.workspaceId);
          pulling=workspace.replica.pull(signal).then(({hasMore})=>({head,hasMore}));
          catchUp?.set(target.workspaceId,pulling);
        }
        const pulled=await pulling;check();
        if(pulled.hasMore)return {kind:"pending" as const,reason:"Hosted replication has more pages."};
        // An update after the head is one the capture may not have seen.
        update=Math.min(this.#latestUpdate(target),pulled.head);
      }
      this.#loaded.add(key);
      let capture:NativeOwnerActivation;
      try{capture=await o.client.captureOwnerActivation(request(),target.path,c.maxCaptureBytes,signal,saved?.activationId);}
      catch(error){this.#refused(key,saved!==null,update,error);throw error;}
      // A fresh capture's lease stays recorded until the relay retains it, so a pass releases it after any failure, as at the pass deadline.
      if(!saved)this.#staleLeases.set(key,{activationId:capture.activationId,sessionId:capture.sessionId});
      check();
      this.#unblock(key);this.#held.delete(key);this.#objects.set(key,capture.source.objectId);
      if(capture.source.workspaceId!==target.workspaceId || capture.source.relayDatabaseNamespace!==o.history.namespace ||
        (saved && (capture.activationId!==saved.activationId || !isDeepStrictEqual(capture.source,saved.source)))) {
        throw new Error("Native service activation source changed.");
      }
      if(!saved){
        try{
          await this.#store.prepare({capture,host:o.host,shareId:target.shareId,registeredAtMs:Date.now(),guard:check,signal,
            validate:c.validateActivation,bounds:{maxCaptureBytes:c.maxCaptureBytes,
              maxEntriesPerDrain:c.maxEntriesPerDrain,maxBytesPerDrain:c.maxBytesPerDrain}});
        }catch(error){
          const tooLarge=error instanceof ServiceActivationTooLarge;
          if(!(error instanceof ServiceActivationStaleCut) && !(error instanceof ServiceActivationBusy) && !tooLarge)throw error;
          // The same capture would run its validation out of memory again, so it waits for its owner.
          if(tooLarge)this.#blocked.set(key,{reason:"refused"});
          await releaseStale();
          return {kind:"pending" as const,reason:error instanceof ServiceActivationStaleCut?"Hosted replication advanced before activation.":error.message};
        }
        this.#staleLeases.delete(key);
        o.registered();
        saved=this.#read(target,objectId)!;
      }
      document=parseLiveDocumentKey({workspaceId:saved.source.workspaceId,mainVersionId:saved.source.mainVersionId,
        objectId:saved.source.objectId,lineageClaimId:saved.source.lineageClaimId});
      const resumed=this.#store.resume({document,activationId:saved.activationId,host:o.host,registeredAtMs:Date.now(),guard:check});
      o.registered();check();
      owner=this.#owner(target,async()=>capture,{binding:resumed.binding,activationPending:!resumed.completed,
        actor:{ownerUserId:saved.ownerUserId,shareId:saved.shareId}},resumed.access);
      if(retired())return retiring;
      this.#owners.set(JSON.stringify(document),owner);
    }
    const held=owner;
    return o.runDocument(document!,signal,async()=>{
    // A restore can fence the binding while this pass waits for the document
    // or for the engine. Readiness waits until the exact binding opens again;
    // another binding reactivates on a later pass.
    if(!held.activationPending && this.#invalidated(held,document!))return fenced;
    try{
      // The consumer materializes any retained handover cut before draining edits.
      const outcome=await held.consumer.drain(document!,signal);check();
      if(outcome.kind!=="done")return outcome;
      if(held.activationPending){
        const nativeState=await held.transport.state(request(),signal);check();
        this.#store.complete({document:document!,host:o.host,access:this.#store.pending(document!,o.host),nativeState,guard:check});
        held.activationPending=false;
      }
      if(settle)await settle(held.consumer,document!,signal);
    }catch(error){
      // Storage refuses delivery on a fenced binding. Only that is pending;
      // cancellation, lost standing, and damage on the same binding still fail.
      check();
      if(!held.activationPending && this.#invalidated(held,document!))return fenced;
      throw error;
    }
    check();
    if(retired())return retiring;
    if(this.#invalidated(held,document!))return fenced;
    held.completed=true;this.#completedTargets.add(key);
    return {kind:"done" as const,document:document!};
    });
  }
  // Owner delivery through the native session's verified transport.
  #owner(target:ServiceActivationTarget,capture:(signal?:AbortSignal)=>Promise<NativeOwnerActivation>,state:Pick<Owner,"binding"|"actor"|"activationPending">,
    access?:ServiceActivationAccess,slot=targetKey(target)):Owner{
    const o=this.options,c=o.config,workspace=o.workspace(target.workspaceId)!;
    const transport=serviceOwnerTransport({client:o.client,workspace:workspace.handle,capture,binding:state.binding,
      storage:o.storage,host:o.host,nextRequestId:o.nextRequestId,assertCurrent:o.assertCurrent});
    const consumer=new OwnerCommittedDelivery(o.storage,o.history,{client:transport.client,workspace:workspace.handle,
      host:o.host,deadlineMs:o.deadlineMs,nextRequestId:o.nextRequestId,bounds:o.adoption,restore:o.restore,
      publish:signal=>workspace.replica.publish(signal),seedDelivery:transport.seedDelivery,
      ownerAdmission:{trustedAccount:o.trustedAccount,activation:access,shares:new Map([[target.workspaceId,target.shareId]]),
        maxEntriesPerDrain:c.maxEntriesPerDrain,maxBytesPerDrain:c.maxBytesPerDrain,refusals:this.#refusals,keptOnServer:workspace.identity,validate:c.validateAdmission}});
    return {consumer,transport,completed:false,target:slot,...state};
  }
  // Clears readiness when the owner may no longer use its exact binding.
  #invalidated(owner:Owner,document:LiveDocumentKey){
    const current=this.#currentBinding(document,owner.actor);
    if(isDeepStrictEqual(current,owner.binding))return false;
    owner.completed=false;this.#completedTargets.delete(owner.target);
    const key=JSON.stringify(document);
    if(current && this.#owners.get(key)===owner)this.#owners.delete(key);
    return true;
  }
  // The exact binding the owner may use now, or null while it is fenced or unavailable.
  #currentBinding(document:LiveDocumentKey,saved:{ownerUserId:string;shareId:string}){
    const current=this.options.storage.resolveCurrentLiveDocumentBinding({document,actor:{kind:"owner",userId:saved.ownerUserId,shareId:saved.shareId}});
    return current.kind==="current"?current.binding:null;
  }
}
