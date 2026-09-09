import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {isDeepStrictEqual} from "node:util";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import {parseLiveDocumentKey,parseLiveUpdateIdentifier,type LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import {validateUserWritePath} from "@dohc/workspace-core";
import {liveDocumentKindForPath} from "@dohc/workspace-contracts/live-documents";
import {createLiveMarkdownRegistrationValidator,createLiveMarkdownJournalValidator} from "../../../packages/ydoc-projection/src/liveDocumentValidation";
import type {OrderedLiveUpdateCutPolicy} from "../../../packages/ydoc-projection/src/orderedLiveUpdateCut";
import {configRecord} from "./deviceLiveHostConfig";
import {OwnerCommittedDelivery} from "./ownerCommittedDelivery";
import {serviceOwnerTransport} from "./serviceOwnerTransport";
import {ServiceActivationStaleCut} from "./storage/serviceActivation";
import type {SyncRelayStorage,LiveHostConnectionCoordinate} from "./storage";
import type {LiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import type {ServiceOrdinaryReplication} from "./serviceOrdinaryReplication";
import type {LiveRestorePreparation} from "./liveRestorePreparation";

const positive=(value:unknown)=>{
  if(typeof value!=="number" || !Number.isSafeInteger(value) || value<1 || value>2_147_483_647)throw new Error("Invalid service activation budget.");
  return value;
};
export function parseServiceActivationConfig(value:unknown){
  if(value===undefined)return undefined;
  const row=configRecord(value,["targets","validation","maxCaptureBytes","maxEntriesPerDrain","maxBytesPerDrain","maxDocumentsPerPass","pollIntervalMs","passDeadlineMs"]);
  if(!Array.isArray(row.targets) || !row.targets.length || row.targets.length>64)throw new Error("Invalid service activation targets.");
  const targets=row.targets.map(value=>{
    const item=configRecord(value,["workspaceId","path","shareId"]);
    const checked=typeof item.path==="string"?validateUserWritePath(item.path):undefined;
    if(typeof item.path!=="string" || !checked?.ok || checked.normalized!==item.path || liveDocumentKindForPath(item.path)!=="richdoc")throw new Error("Invalid service activation path.");
    return Object.freeze({workspaceId:parseLiveUpdateIdentifier(item.workspaceId),path:item.path,shareId:parseLiveUpdateIdentifier(item.shareId)});
  });
  if(new Set(targets.map(row=>JSON.stringify([row.workspaceId,row.path]))).size!==targets.length)throw new Error("Duplicate service activation target.");
  const policy=configRecord(row.validation,["maxStructVisits","maxValueNodeVisits","maxDecodedPayloadByteVisits","maxStructClientGroupVisits","maxDeleteClientGroupVisits","maxDeleteIntervalVisits","maxIndexOperations"]);
  for(const value of Object.values(policy))positive(value);
  const validation=Object.freeze({...policy}) as unknown as OrderedLiveUpdateCutPolicy;
  return Object.freeze({targets:Object.freeze(targets),validateBaseline:createLiveMarkdownRegistrationValidator(validation),
    validateJournal:createLiveMarkdownJournalValidator(validation),maxCaptureBytes:positive(row.maxCaptureBytes),
    maxEntriesPerDrain:positive(row.maxEntriesPerDrain),maxBytesPerDrain:positive(row.maxBytesPerDrain),
    maxDocumentsPerPass:positive(row.maxDocumentsPerPass),pollIntervalMs:positive(row.pollIntervalMs),passDeadlineMs:positive(row.passDeadlineMs)});
}
export type ServiceActivationConfig=NonNullable<ReturnType<typeof parseServiceActivationConfig>>;

export class ServiceActivationDriver {
  readonly #store;
  readonly #completedTargets=new Set<string>();
  readonly #restoreConsumers=new Map<string,OwnerCommittedDelivery>();
  readonly #staleLeases=new Map<string,{activationId:string;sessionId:string}>();
  readonly #owners=new Map<string,{consumer:OwnerCommittedDelivery;transport:ReturnType<typeof serviceOwnerTransport>;completed:boolean;activationPending:boolean;binding:LiveObjectBinding}>();
  constructor(readonly options:{storage:SyncRelayStorage;history:LiveJournalHistoryAuthority;client:EngineClient;host:LiveHostConnectionCoordinate;
    workspaces:ReadonlyMap<string,{handle:string;ordinary:ServiceOrdinaryReplication}>;config:ServiceActivationConfig;
    adoption:{maxBytes:number;maxEvents:number};restore?:LiveRestorePreparation;nextRequestId():number;deadlineMs:number;
    assertCurrent():void;registered():void;
    runDocument<T>(document:LiveDocumentKey,signal:AbortSignal,operation:()=>Promise<T>):Promise<T>;}){
    this.#store=options.storage.createServiceActivationStore(options.history);
  }
  hasRetained(){
    return this.options.config.targets.some(target=>this.#store.read(target.workspaceId,target.path,this.options.config.maxCaptureBytes)!==null);
  }
  restoreConsumer(document:LiveDocumentKey){
    const o=this.options,key=JSON.stringify(parseLiveDocumentKey(document));
    const existing=this.#restoreConsumers.get(key);if(existing)return existing;
    const target=o.config.targets.find(target=>{
      if(target.workspaceId!==document.workspaceId)return false;
      const saved=this.#store.read(target.workspaceId,target.path,o.config.maxCaptureBytes);
      return saved?.completed && saved.shareId===target.shareId && saved.source.objectId===document.objectId && saved.source.lineageClaimId===document.lineageClaimId;
    });
    const workspace=o.workspaces.get(document.workspaceId);
    if(!target || !workspace)throw new Error("Service restore source is unavailable.");
    const consumer=new OwnerCommittedDelivery(o.storage,o.history,{client:o.client,workspace:workspace.handle,host:o.host,
      deadlineMs:o.deadlineMs,nextRequestId:o.nextRequestId,bounds:o.adoption,restore:o.restore,
      ownerAdmission:{shares:new Map([[target.workspaceId,target.shareId]]),maxEntriesPerDrain:o.config.maxEntriesPerDrain,
        maxBytesPerDrain:o.config.maxBytesPerDrain,validate:o.config.validateJournal}});
    this.#restoreConsumers.set(key,consumer);return consumer;
  }
  workspaceReady(workspaceId:string){
    return this.options.config.targets.filter(target=>target.workspaceId===workspaceId).every(target=>this.#completedTargets.has(JSON.stringify([target.workspaceId,target.path])));
  }
  consumer(document:LiveDocumentKey){
    const owner=this.#owners.get(JSON.stringify(parseLiveDocumentKey(document)));
    if(!owner?.completed)throw new Error("Service document activation is incomplete.");
    return owner;
  }
  async activate(target:ServiceActivationConfig["targets"][number],signal:AbortSignal){
    const o=this.options,c=o.config,workspace=o.workspaces.get(target.workspaceId);
    if(!workspace)throw new Error("Service activation workspace is not attached.");
    const check=()=>{signal.throwIfAborted();o.assertCurrent();};
    const request=()=>({id:o.nextRequestId(),workspace:workspace.handle,deadlineMs:o.deadlineMs});
    check();
    const targetKey=JSON.stringify([target.workspaceId,target.path]);
    const releaseStale=async()=>{
      const lease=this.#staleLeases.get(targetKey);
      if(!lease)return;
      const released=await o.client.sendRequest({...request(),method:"liveApplication.releaseOwnerActivation",params:lease},signal);check();
      if(configRecord(released.result,["released"]).released!==true)throw new Error("Stale native activation lease was not released.");
      this.#staleLeases.delete(targetKey);
    };
    await releaseStale();
    let saved=this.#store.read(target.workspaceId,target.path,c.maxCaptureBytes);
    if(!saved)this.#completedTargets.delete(targetKey);
    if(saved && saved.shareId!==target.shareId)throw new Error("Service activation share changed.");
    let document=saved?parseLiveDocumentKey({workspaceId:saved.source.workspaceId,mainVersionId:saved.source.mainVersionId,
      objectId:saved.source.objectId,lineageClaimId:saved.source.lineageClaimId}):undefined;
    let owner=document?this.#owners.get(JSON.stringify(document)):undefined;
    if(owner?.completed && saved && document){
      const current=o.storage.resolveCurrentLiveDocumentBinding({document,actor:{kind:"owner",userId:saved.ownerUserId,shareId:saved.shareId}});
      if(current.kind!=="current"){
        this.#completedTargets.delete(targetKey);
        return {kind:"pending" as const,reason:"Service binding is fenced or unavailable."};
      }
      if(!isDeepStrictEqual(current.binding,owner.binding)){
        owner.completed=false;this.#completedTargets.delete(targetKey);this.#owners.delete(JSON.stringify(document));owner=undefined;
      }
    }
    if(!owner){
      if(!saved){
        const pulled=await workspace.ordinary.pull(signal);check();
        if(pulled.hasMore)return {kind:"pending" as const,reason:"Ordinary replication has more pages."};
      }
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
          this.#staleLeases.set(targetKey,{activationId:capture.activationId,sessionId:capture.sessionId});
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
      const transport=serviceOwnerTransport({client:o.client,workspace:workspace.handle,capture,binding:resumed.binding,
        nextRequestId:o.nextRequestId,assertCurrent:o.assertCurrent});
      const consumer=new OwnerCommittedDelivery(o.storage,o.history,{client:transport.client,workspace:workspace.handle,
        host:o.host,deadlineMs:o.deadlineMs,nextRequestId:o.nextRequestId,bounds:o.adoption,restore:o.restore,
        ownerAdmission:{activation:resumed.access,shares:new Map([[target.workspaceId,target.shareId]]),
          maxEntriesPerDrain:c.maxEntriesPerDrain,maxBytesPerDrain:c.maxBytesPerDrain,validate:c.validateJournal}});
      owner={consumer,transport,binding:resumed.binding,completed:false,activationPending:!resumed.completed};
      this.#owners.set(JSON.stringify(document),owner);
    }
    const held=owner;
    return o.runDocument(document!,signal,async()=>{
    const outcome=await held.consumer.drain(document!,signal);check();
    if(outcome.kind!=="done")return outcome;
    if(held.activationPending){
      const nativeState=await held.transport.state(request(),signal);check();
      this.#store.complete({document:document!,host:o.host,access:this.#store.pending(document!,o.host),nativeState,guard:check});
      held.activationPending=false;
    }
    held.completed=true;this.#completedTargets.add(targetKey);
    return {kind:"done" as const,document:document!};
    });
  }
}
