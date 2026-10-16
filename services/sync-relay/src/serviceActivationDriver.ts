import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import type {OwnerOutboxAdmission} from "./ownerOutboxDelivery";
import {isDeepStrictEqual} from "node:util";
import {EngineRequestError,isHostedDocumentUnready,isLiveDocumentWithoutLineage,type EngineClient,type NativeOwnerActivation} from "@dohc/workspace-engine-client/daemon";
import {parseLiveDocumentKey,parseLiveUpdateIdentifier,type LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import {validateUserWritePath} from "@dohc/workspace-core";
import {liveDocumentKindForPath} from "@dohc/workspace-contracts/live-documents";
import {createLiveMarkdownRegistrationValidator,createLiveMarkdownJournalValidator} from "../../../packages/ydoc-projection/src/liveDocumentValidation";
import type {OrderedLiveUpdateCutPolicy} from "../../../packages/ydoc-projection/src/orderedLiveUpdateCut";
import {configRecord} from "./deviceLiveHostConfig";
import {OwnerCommittedDelivery} from "./ownerCommittedDelivery";
import {liveValidation} from "./liveValidation.js";
import {serviceOwnerTransport} from "./serviceOwnerTransport";
import {ServiceActivationStaleCut,type ServiceActivationStore} from "./storage/serviceActivation";
import type {ServiceActivationAccess} from "./storage/serviceActivationAccess";
import type {SyncRelayStorage,LiveHostConnectionCoordinate} from "./storage";
import type {LiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import type {LiveRestorePreparation} from "./liveRestorePreparation";
import type {StopRestoreLookup} from "./storage/liveRestoreOperation";
import type {ServiceHostedHold} from "./serviceHostedReplication";

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
  return Object.freeze({targets:Object.freeze(targets),validateBaseline:createLiveMarkdownRegistrationValidator(validation),
    validateJournal:createLiveMarkdownJournalValidator(validation),validateAdmission:liveValidation.validator(validation),maxCaptureBytes:positive(row.maxCaptureBytes),
    maxEntriesPerDrain:positive(row.maxEntriesPerDrain),maxBytesPerDrain:positive(row.maxBytesPerDrain),
    maxDocumentsPerPass:positive(row.maxDocumentsPerPass),pollIntervalMs:positive(row.pollIntervalMs),passDeadlineMs:positive(row.passDeadlineMs),
    idleUnloadMs:positive(row.idleUnloadMs),idleRetryMs:positive(row.idleRetryMs)});
}
export type ServiceActivationConfig=NonNullable<ReturnType<typeof parseServiceActivationConfig>>;
/** Why a document waits for its owner: the engine refused it, or it has no Y.Doc lineage to activate. */
export type ServiceActivationBlock="refused"|"without-lineage";
type Owner={consumer:OwnerCommittedDelivery;transport:ReturnType<typeof serviceOwnerTransport>;completed:boolean;activationPending:boolean;
  binding:LiveObjectBinding;target:string;actor:{ownerUserId:string;shareId:string}};
const fenced={kind:"pending" as const,reason:"Service binding is fenced or unavailable."};
/** A workspace's hosted replica, as activation uses it. */
export interface ServiceActivationReplica {
  pull(signal:AbortSignal):Promise<{hasMore:boolean}>;
  publish(signal?:AbortSignal):Promise<{pushed:number;hasMore:boolean}>;
}

export class ServiceActivationDriver {
  readonly #store;
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
  readonly #blocked=new Map<string,ServiceActivationBlock>();
  // Each target's document, once known, so a hold applies before the target has an owner, as after a restart.
  readonly #objects=new Map<string,string>();
  constructor(readonly options:{trustedAccount: OwnerOutboxAdmission["trustedAccount"];storage:SyncRelayStorage;history:LiveJournalHistoryAuthority;client:EngineClient;host:LiveHostConnectionCoordinate;
    workspaces:ReadonlyMap<string,{handle:string;replica:ServiceActivationReplica}>;config:ServiceActivationConfig;
    adoption:{maxBytes:number;maxEvents:number};restore?:LiveRestorePreparation;nextRequestId():number;deadlineMs:number;
    assertCurrent():void;registered():void;
    runDocument<T>(document:LiveDocumentKey,signal:AbortSignal,operation:()=>Promise<T>):Promise<T>;}){
    this.#store=options.storage.createServiceActivationStore(options.history);
    this.#targets=options.config.targets;
  }
  /** The documents activation passes visit, in pass order. */
  get targets(){return this.#targets;}
  /** Adds one document to activation passes, replacing an earlier target at its path. */
  addTarget(target:ServiceActivationTarget,objectId:string){
    this.#targets=[...this.#targets.filter(row=>targetKey(row)!==targetKey(target)),target];
    this.#objects.set(targetKey(target),objectId);
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
  removeTarget(target:ServiceActivationTarget){
    const key=targetKey(target);
    this.#targets=this.#targets.filter(row=>targetKey(row)!==key);
    this.#completedTargets.delete(key);this.#staleLeases.delete(key);this.#loaded.delete(key);this.#dormant.delete(key);this.#held.delete(key);this.#blocked.delete(key);this.#objects.delete(key);
    for(const [document,owner] of this.#owners)if(owner.target===key)this.#owners.delete(document);
  }
  /**
   * Clears readiness of documents a hosted pass left held. The engine has
   * already ended their sessions; each activates again once its capture
   * succeeds. Until then they do not hold back their workspace's pulls,
   * which bring what they wait for.
   */
  hold(workspaceId:string,holds:readonly ServiceHostedHold[]){
    for(const [key,objectId] of this.#objects){
      const hold=JSON.parse(key)[0]===workspaceId?holds.find(row=>row.objectId===objectId):undefined;
      if(!hold)continue;
      this.#completedTargets.delete(key);this.#dormant.delete(key);this.#held.set(key,hold.reason);
      for(const [document,owner] of this.#owners)if(owner.target===key){owner.completed=false;this.#owners.delete(document);}
    }
  }
  /** Why the target failed the one capture it gets while it cannot progress, if it did. Activation skips it. */
  blocked(target:ServiceActivationTarget){return this.#blocked.get(targetKey(target));}
  /** Allows a blocked target one more capture. Returns whether it was blocked. */
  unblock(target:ServiceActivationTarget){return this.#blocked.delete(targetKey(target));}
  // A document with no Y.Doc lineage has nothing to activate, a held document whose live
  // edit was never admitted cannot become ready, and a retained activation the engine
  // refuses as diverged cannot resume. Each blocks after its failed capture. A document
  // that is only not ready, or whose first capture met another conflict, waits.
  #refused(key:string,resuming:boolean,error:unknown){
    const diverged=resuming && error instanceof EngineRequestError && error.wireError?.code==="CONFLICT" && !isHostedDocumentUnready(error);
    if(isLiveDocumentWithoutLineage(error))this.#blocked.set(key,"without-lineage");
    else if(diverged || this.#held.get(key)==="hosted-live-edit-unadmitted")this.#blocked.set(key,"refused");
  }
  /**
   * Forgets a document the engine unloaded while it stays a target, and ends
   * its registration. Passes skip it until it wakes, then activate it again
   * from its retained source.
   */
  sleep(target:ServiceActivationTarget,document:LiveDocumentKey){
    const key=JSON.stringify(parseLiveDocumentKey(document)),owner=this.#owners.get(key);
    owner?.consumer.release(document);
    this.removeTarget(target);
    this.addTarget(target,document.objectId);
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
  /** Whether the relay retains an activation of the document at the target's path. */
  retained(target:ServiceActivationTarget){
    return this.#store.read(target.workspaceId,target.path,this.options.config.maxCaptureBytes)!==null;
  }
  restoreConsumer(document:LiveDocumentKey,lookup:StopRestoreLookup){
    const o=this.options,key=JSON.stringify(parseLiveDocumentKey(document));
    let target:ServiceActivationTarget|undefined,saved:ReturnType<ServiceActivationStore["read"]>=null;
    for(const row of this.#targets){
      if(row.workspaceId!==document.workspaceId)continue;
      const read=this.#store.read(row.workspaceId,row.path,o.config.maxCaptureBytes);
      if(read?.completed && read.shareId===row.shareId && read.source.objectId===document.objectId && read.source.lineageClaimId===document.lineageClaimId){
        target=row;saved=read;break;
      }
    }
    const workspace=o.workspaces.get(document.workspaceId);
    if(!target || !saved || !workspace)throw new Error("Service restore source is unavailable.");
    // Stopping access re-registers the retained owner. Only the activated session's
    // verified transport can check that adoption; native registration takes the binding alone.
    const activated=this.#owners.get(key);
    if(activated && !activated.activationPending)return activated.consumer;
    // Without that session, as for a dormant document or after a restart, the
    // owner takes the operation's binding, whose adoption must be that activation.
    // Only a step that registers reloads the retained activation into a new native session.
    const operation=o.storage.readStopRestore(lookup),origin=operation?.basis.ownerOrigin;
    if(!operation || operation.intent.deliveryKind!=="owner" || !isDeepStrictEqual(operation.intent.document,parseLiveDocumentKey(document)) ||
      operation.intent.shareId!==saved.shareId || operation.intent.ownerUserId!==saved.ownerUserId || !origin ||
      JSON.parse(origin)?.adoptionId!==saved.activationId)throw new Error("Service restore owner adoption is unavailable.");
    const owner:Owner=this.#owner(target,async signal=>{
      const slot=targetKey(target),sleeping=this.#dormant.get(slot);
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
    },{binding:operation.basis.ownerBinding,activationPending:false,actor:{ownerUserId:saved.ownerUserId,shareId:saved.shareId}});
    return owner.consumer;
  }
  workspaceReady(workspaceId:string){
    return this.#targets.filter(target=>target.workspaceId===workspaceId && !this.dormant(target) && !this.#held.has(targetKey(target)) && !this.blocked(target))
      .every(target=>this.#completedTargets.has(targetKey(target)));
  }
  consumer(value:LiveDocumentKey){
    const document=parseLiveDocumentKey(value),owner=this.#owners.get(JSON.stringify(document));
    if(!owner?.completed || this.#invalidated(owner,document))throw new Error("Service document activation is incomplete.");
    return owner;
  }
  /** Settles what the host already applied of an owned document, as once Stop fenced it. Null when nothing was adopted to settle. */
  settleApplied(value:LiveDocumentKey,signal:AbortSignal){
    const document=parseLiveDocumentKey(value),owner=this.#owners.get(JSON.stringify(document));
    return owner?owner.consumer.settleApplied(document,signal):Promise.resolve(null);
  }
  /**
   * Activates the target and drains it. A target with no owner here first pulls
   * its workspace, which also tells this driver whether the engine holds it.
   * Without `catchUp`, a retained activation resumes without that pull: its
   * caller pulled already, or the document left the hosted set, and a pull
   * would adopt the scope it left, after which the engine no longer captures it.
   */
  async activate(target:ServiceActivationTarget,signal:AbortSignal,
    settle?:(consumer:OwnerCommittedDelivery,document:LiveDocumentKey,signal:AbortSignal)=>Promise<unknown>,catchUp=true){
    const o=this.options,c=o.config,workspace=o.workspaces.get(target.workspaceId);
    if(!workspace)throw new Error("Service activation workspace is not attached.");
    const check=()=>{signal.throwIfAborted();o.assertCurrent();};
    const request=()=>({id:o.nextRequestId(),workspace:workspace.handle,deadlineMs:o.deadlineMs});
    check();
    const key=targetKey(target);
    if(this.#blocked.has(key))return {kind:"pending" as const,reason:"Hosted document is blocked until the owner tries again."};
    const releaseStale=async()=>{
      const lease=this.#staleLeases.get(key);
      if(!lease)return;
      const released=await o.client.sendRequest({...request(),method:"liveApplication.releaseOwnerActivation",params:lease},signal);check();
      if(configRecord(released.result,["released"]).released!==true)throw new Error("Stale native activation lease was not released.");
      this.#staleLeases.delete(key);
    };
    await releaseStale();
    let saved=this.#store.read(target.workspaceId,target.path,c.maxCaptureBytes);
    if(!saved)this.#completedTargets.delete(key);
    if(saved && saved.shareId!==target.shareId)throw new Error("Service activation share changed.");
    if(saved)this.#objects.set(key,saved.source.objectId);
    let document=saved?parseLiveDocumentKey({workspaceId:saved.source.workspaceId,mainVersionId:saved.source.mainVersionId,
      objectId:saved.source.objectId,lineageClaimId:saved.source.lineageClaimId}):undefined;
    let owner=document?this.#owners.get(JSON.stringify(document)):undefined;
    if(owner?.completed && document && this.#invalidated(owner,document)){
      // A fenced binding keeps its owner for the restore; another binding activates again.
      owner=this.#owners.get(JSON.stringify(document));
      if(owner)return fenced;
    }
    if(!owner){
      if(catchUp || !saved){
        const pulled=await workspace.replica.pull(signal);check();
        if(pulled.hasMore)return {kind:"pending" as const,reason:"Hosted replication has more pages."};
      }
      this.#loaded.add(key);
      let capture:NativeOwnerActivation;
      try{capture=await o.client.captureOwnerActivation(request(),target.path,c.maxCaptureBytes,signal,saved?.activationId);}
      catch(error){this.#refused(key,saved!==null,error);throw error;}
      check();
      this.#held.delete(key);this.#objects.set(key,capture.source.objectId);
      if(capture.source.workspaceId!==target.workspaceId || capture.source.relayDatabaseNamespace!==o.history.namespace ||
        (saved && (capture.activationId!==saved.activationId || !isDeepStrictEqual(capture.source,saved.source)))) {
        throw new Error("Native service activation source changed.");
      }
      if(!saved){
        try{
          this.#store.prepare({capture,host:o.host,shareId:target.shareId,registeredAtMs:Date.now(),guard:check,
            validateBaseline:c.validateBaseline,validateJournal:c.validateJournal,bounds:{maxCaptureBytes:c.maxCaptureBytes,
              maxEntriesPerDrain:c.maxEntriesPerDrain,maxBytesPerDrain:c.maxBytesPerDrain}});
        }catch(error){
          if(!(error instanceof ServiceActivationStaleCut))throw error;
          this.#staleLeases.set(key,{activationId:capture.activationId,sessionId:capture.sessionId});
          await releaseStale();
          return {kind:"pending" as const,reason:"Hosted replication advanced before activation."};
        }
        o.registered();
        saved=this.#store.read(target.workspaceId,target.path,c.maxCaptureBytes)!;
      }
      document=parseLiveDocumentKey({workspaceId:saved.source.workspaceId,mainVersionId:saved.source.mainVersionId,
        objectId:saved.source.objectId,lineageClaimId:saved.source.lineageClaimId});
      const resumed=this.#store.resume({document,activationId:saved.activationId,host:o.host,registeredAtMs:Date.now(),guard:check});
      o.registered();check();
      owner=this.#owner(target,async()=>capture,{binding:resumed.binding,activationPending:!resumed.completed,
        actor:{ownerUserId:saved.ownerUserId,shareId:saved.shareId}},resumed.access);
      this.#owners.set(JSON.stringify(document),owner);
    }
    const held=owner;
    return o.runDocument(document!,signal,async()=>{
    // A restore can fence the binding while this pass waits for the document
    // or for the engine. Readiness waits until the exact binding opens again;
    // another binding reactivates on a later pass.
    if(!held.activationPending && this.#invalidated(held,document!))return fenced;
    try{
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
    if(this.#invalidated(held,document!))return fenced;
    held.completed=true;this.#completedTargets.add(key);
    return {kind:"done" as const,document:document!};
    });
  }
  // Owner delivery through the native session's verified transport.
  #owner(target:ServiceActivationTarget,capture:(signal?:AbortSignal)=>Promise<NativeOwnerActivation>,state:Pick<Owner,"binding"|"actor"|"activationPending">,access?:ServiceActivationAccess):Owner{
    const o=this.options,c=o.config,workspace=o.workspaces.get(target.workspaceId)!;
    const transport=serviceOwnerTransport({client:o.client,workspace:workspace.handle,capture,binding:state.binding,
      nextRequestId:o.nextRequestId,assertCurrent:o.assertCurrent});
    const consumer=new OwnerCommittedDelivery(o.storage,o.history,{client:transport.client,workspace:workspace.handle,
      host:o.host,deadlineMs:o.deadlineMs,nextRequestId:o.nextRequestId,bounds:o.adoption,restore:o.restore,
      publish:signal=>workspace.replica.publish(signal),
      ownerAdmission:{trustedAccount:o.trustedAccount,activation:access,shares:new Map([[target.workspaceId,target.shareId]]),
        maxEntriesPerDrain:c.maxEntriesPerDrain,maxBytesPerDrain:c.maxBytesPerDrain,validate:c.validateAdmission}});
    return {consumer,transport,completed:false,target:targetKey(target),...state};
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
