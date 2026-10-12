import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {isDeepStrictEqual} from "node:util";
import type {EngineClient,NativeOwnerActivation} from "@dohc/workspace-engine-client/daemon";
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
import type {ServiceOrdinaryReplication} from "./serviceOrdinaryReplication";
import type {LiveRestorePreparation} from "./liveRestorePreparation";

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
type Owner={consumer:OwnerCommittedDelivery;transport:ReturnType<typeof serviceOwnerTransport>;completed:boolean;activationPending:boolean;
  binding:LiveObjectBinding;target:string;actor:{ownerUserId:string;shareId:string}};
const fenced={kind:"pending" as const,reason:"Service binding is fenced or unavailable."};

export class ServiceActivationDriver {
  readonly #store;
  #targets:readonly ServiceActivationTarget[];
  readonly #completedTargets=new Set<string>();
  readonly #restoreConsumers=new Map<string,OwnerCommittedDelivery>();
  readonly #staleLeases=new Map<string,{activationId:string;sessionId:string}>();
  readonly #owners=new Map<string,Owner>();
  // Targets this driver may have loaded into the engine since it started.
  readonly #loaded=new Set<string>();
  // Hosted targets the engine unloaded while idle, with their documents and the
  // owners' last bindings. Passes skip them until they wake.
  readonly #dormant=new Map<string,{document:string;owner?:Pick<Owner,"binding"|"actor">}>();
  constructor(readonly options:{storage:SyncRelayStorage;history:LiveJournalHistoryAuthority;client:EngineClient;host:LiveHostConnectionCoordinate;
    workspaces:ReadonlyMap<string,{handle:string;ordinary:ServiceOrdinaryReplication}>;config:ServiceActivationConfig;
    adoption:{maxBytes:number;maxEvents:number};restore?:LiveRestorePreparation;nextRequestId():number;deadlineMs:number;
    assertCurrent():void;registered():void;
    runDocument<T>(document:LiveDocumentKey,signal:AbortSignal,operation:()=>Promise<T>):Promise<T>;}){
    this.#store=options.storage.createServiceActivationStore(options.history);
    this.#targets=options.config.targets;
  }
  /** The documents activation passes visit, in pass order. */
  get targets(){return this.#targets;}
  /** Adds one document to activation passes, replacing an earlier target at its path. */
  addTarget(target:ServiceActivationTarget){
    this.#targets=[...this.#targets.filter(row=>targetKey(row)!==targetKey(target)),target];
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
  removeTarget(target:ServiceActivationTarget,objectId:string){
    const key=targetKey(target);
    this.#targets=this.#targets.filter(row=>targetKey(row)!==key);
    this.#completedTargets.delete(key);this.#staleLeases.delete(key);this.#loaded.delete(key);this.#dormant.delete(key);
    for(const [document,owner] of this.#owners)if(owner.target===key)this.#owners.delete(document);
    for(const document of this.#restoreConsumers.keys()){
      const restored=parseLiveDocumentKey(JSON.parse(document));
      if(restored.workspaceId===target.workspaceId && restored.objectId===objectId)this.#restoreConsumers.delete(document);
    }
  }
  /**
   * Forgets a document the engine unloaded while it stays a target, and ends
   * its registration. Passes skip it until it wakes, then activate it again
   * from its retained source.
   */
  sleep(target:ServiceActivationTarget,document:LiveDocumentKey){
    const key=JSON.stringify(parseLiveDocumentKey(document)),owner=this.#owners.get(key);
    owner?.consumer.release(document);
    this.removeTarget(target,document.objectId);
    this.#targets=[...this.#targets,target];
    this.#dormant.set(targetKey(target),{document:key,...(owner?{owner:{binding:owner.binding,actor:owner.actor}}:{})});
  }
  dormant(target:ServiceActivationTarget){return this.#dormant.has(targetKey(target));}
  /** Whether the document belongs to a dormant target, which wakes when it is opened. */
  asleep(document:LiveDocumentKey){
    const key=JSON.stringify(parseLiveDocumentKey(document));
    return [...this.#dormant.values()].some(row=>row.document===key);
  }
  wake(target:ServiceActivationTarget){this.#dormant.delete(targetKey(target));}
  hasRetained(){
    return this.#targets.some(target=>this.#store.read(target.workspaceId,target.path,this.options.config.maxCaptureBytes)!==null);
  }
  async restoreConsumer(document:LiveDocumentKey,signal:AbortSignal){
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
    // A dormant document reloads its retained activation into a new native session.
    // Its owner keeps the binding it last held, which a restore fence may have closed.
    const sleeping=this.#dormant.get(targetKey(target))?.owner;
    if(sleeping){
      this.#loaded.add(targetKey(target));
      const capture=await o.client.captureOwnerActivation({id:o.nextRequestId(),workspace:workspace.handle,deadlineMs:o.deadlineMs},
        target.path,o.config.maxCaptureBytes,signal,saved.activationId);
      signal.throwIfAborted();o.assertCurrent();
      if(capture.activationId!==saved.activationId || !isDeepStrictEqual(capture.source,saved.source))throw new Error("Native service activation source changed.");
      const owner=this.#owner(target,capture,{...sleeping,activationPending:false});
      // Passes visit it again and settle the restore work, as for an awake document.
      this.#owners.set(key,owner);this.#dormant.delete(targetKey(target));return owner.consumer;
    }
    // Without that session, as after a restart, only a restore whose old cut
    // already applied can continue, because it does not register again.
    const existing=this.#restoreConsumers.get(key);if(existing)return existing;
    const consumer=new OwnerCommittedDelivery(o.storage,o.history,{client:o.client,workspace:workspace.handle,host:o.host,
      deadlineMs:o.deadlineMs,nextRequestId:o.nextRequestId,bounds:o.adoption,restore:o.restore,
      publishOrdinary:signal=>workspace.ordinary.publish(signal),
      ownerAdmission:{shares:new Map([[target.workspaceId,target.shareId]]),maxEntriesPerDrain:o.config.maxEntriesPerDrain,
        maxBytesPerDrain:o.config.maxBytesPerDrain,validate:o.config.validateAdmission}});
    // Restore work loads the document again, so a dormant target rejoins passes, which settle that work.
    this.#restoreConsumers.set(key,consumer);this.#loaded.add(targetKey(target));this.#dormant.delete(targetKey(target));return consumer;
  }
  workspaceReady(workspaceId:string){
    return this.#targets.filter(target=>target.workspaceId===workspaceId && !this.dormant(target)).every(target=>this.#completedTargets.has(targetKey(target)));
  }
  consumer(value:LiveDocumentKey){
    const document=parseLiveDocumentKey(value),owner=this.#owners.get(JSON.stringify(document));
    if(!owner?.completed || this.#invalidated(owner,document))throw new Error("Service document activation is incomplete.");
    return owner;
  }
  async activate(target:ServiceActivationTarget,signal:AbortSignal,
    settle?:(consumer:OwnerCommittedDelivery,document:LiveDocumentKey,signal:AbortSignal)=>Promise<unknown>){
    const o=this.options,c=o.config,workspace=o.workspaces.get(target.workspaceId);
    if(!workspace)throw new Error("Service activation workspace is not attached.");
    const check=()=>{signal.throwIfAborted();o.assertCurrent();};
    const request=()=>({id:o.nextRequestId(),workspace:workspace.handle,deadlineMs:o.deadlineMs});
    check();
    const key=targetKey(target);
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
    let document=saved?parseLiveDocumentKey({workspaceId:saved.source.workspaceId,mainVersionId:saved.source.mainVersionId,
      objectId:saved.source.objectId,lineageClaimId:saved.source.lineageClaimId}):undefined;
    let owner=document?this.#owners.get(JSON.stringify(document)):undefined;
    if(owner?.completed && document && this.#invalidated(owner,document)){
      // A fenced binding keeps its owner for the restore; another binding activates again.
      owner=this.#owners.get(JSON.stringify(document));
      if(owner)return fenced;
    }
    if(!owner){
      if(!saved){
        const pulled=await workspace.ordinary.pull(signal);check();
        if(pulled.hasMore)return {kind:"pending" as const,reason:"Ordinary replication has more pages."};
      }
      this.#loaded.add(key);
      const capture=await o.client.captureOwnerActivation(request(),target.path,c.maxCaptureBytes,signal,saved?.activationId);check();
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
          return {kind:"pending" as const,reason:"Ordinary replication advanced before activation."};
        }
        o.registered();
        saved=this.#store.read(target.workspaceId,target.path,c.maxCaptureBytes)!;
      }
      document=parseLiveDocumentKey({workspaceId:saved.source.workspaceId,mainVersionId:saved.source.mainVersionId,
        objectId:saved.source.objectId,lineageClaimId:saved.source.lineageClaimId});
      const resumed=this.#store.resume({document,activationId:saved.activationId,host:o.host,registeredAtMs:Date.now(),guard:check});
      o.registered();check();
      owner=this.#owner(target,capture,{binding:resumed.binding,activationPending:!resumed.completed,
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
  #owner(target:ServiceActivationTarget,capture:NativeOwnerActivation,state:Pick<Owner,"binding"|"actor"|"activationPending">,access?:ServiceActivationAccess):Owner{
    const o=this.options,c=o.config,workspace=o.workspaces.get(target.workspaceId)!;
    const transport=serviceOwnerTransport({client:o.client,workspace:workspace.handle,capture,binding:state.binding,
      nextRequestId:o.nextRequestId,assertCurrent:o.assertCurrent});
    const consumer=new OwnerCommittedDelivery(o.storage,o.history,{client:transport.client,workspace:workspace.handle,
      host:o.host,deadlineMs:o.deadlineMs,nextRequestId:o.nextRequestId,bounds:o.adoption,restore:o.restore,
      publishOrdinary:signal=>workspace.ordinary.publish(signal),
      ownerAdmission:{activation:access,shares:new Map([[target.workspaceId,target.shareId]]),
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
