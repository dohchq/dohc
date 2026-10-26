import {isDeepStrictEqual} from "node:util";
import type {EngineClient, NativeOwnerActivation} from "@dohc/workspace-engine-client/daemon";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {configRecord} from "./deviceLiveHostConfig";
import {authorityInteger} from "./storage/liveDocumentAuthority";

/**
 * Adapts one real imported native session to the existing owner delivery consumer.
 * The session is captured at the first registration, so work that never registers never loads it.
 */
export function serviceOwnerTransport(options: {
  client: EngineClient; workspace: string; capture(signal?: AbortSignal): Promise<NativeOwnerActivation>; binding: LiveObjectBinding;
  nextRequestId(): number; assertCurrent(): void;
}) {
  const {client,workspace,nextRequestId,assertCurrent}=options;
  const binding=parseLiveObjectBinding(options.binding);
  let captured: Pick<NativeOwnerActivation,"activationId"|"sessionId"|"source">|undefined, registrationId: number|undefined, adopted=false, outboxId: string|undefined;
  const check=(signal?:AbortSignal)=>{signal?.throwIfAborted();assertCurrent();};
  const registration=(id:unknown)=>{
    if(registrationId===undefined || id!==registrationId)throw new Error("Service owner registration changed.");
    return registrationId;
  };
  // Registration sets the session before any call that reads it.
  const session=()=>{
    if(!captured)throw new Error("Service owner registration changed.");
    return captured;
  };
  const readState=async(request:Parameters<EngineClient["sendRequest"]>[0],signal?:AbortSignal)=>{
    check(signal);
    const id=registration(configRecord(request.params,["registrationId"]).registrationId),capture=session();
    const response=await client.sendRequest({...request,workspace,method:"liveApplication.ownerState",
      params:{registrationId:id,sessionId:capture.sessionId}},signal);
    check(signal);
    const state=configRecord(response.result,["adoptionId","expectedLocalSequence","throughCursor","outboxId","pendingBytes","outboxState","retryDeliveryId"]);
    const sequence=authorityInteger(state.expectedLocalSequence),pendingBytes=authorityInteger(state.pendingBytes);
    if(state.throughCursor!==null) {
      authorityInteger(state.throughCursor);
      if(state.adoptionId!==capture.activationId || sequence!==capture.source.nativeHeadSequence)throw new Error("Service owner adoption changed.");
      adopted=true;
    } else if(adopted || sequence!==capture.source.nativeHeadSequence)throw new Error("Service owner activation changed.");
    if(state.outboxId!==null && (typeof state.outboxId!=="string" || !state.outboxId))throw new Error("Invalid native owner outbox.");
    outboxId=state.outboxId===null?undefined:String(state.outboxId);
    return {pendingBytes,throughCursor:state.throughCursor===null?null:authorityInteger(state.throughCursor),outboxState:state.outboxState,retryDeliveryId:state.retryDeliveryId};
  };
  const sendRequest:EngineClient["sendRequest"]=async(request,signal)=>{
    check(signal);
    if(request.workspace!==workspace)throw new Error("Service owner workspace changed.");
    if(request.method==="liveApplication.register") {
      const params=configRecord(request.params,["binding"],["resumeAdoptionId"]);
      if(!isDeepStrictEqual(parseLiveObjectBinding(params.binding),binding))throw new Error("Service owner binding changed.");
      if(!captured) {
        const capture=await options.capture(signal);
        check(signal);
        captured={activationId:capture.activationId,sessionId:capture.sessionId,source:{...capture.source}};
      }
      if(params.resumeAdoptionId!==undefined && params.resumeAdoptionId!==captured.activationId)throw new Error("Service owner binding changed.");
      const response=await client.sendRequest({...request,params:{binding:{...binding,selectorPaths:[...binding.selectorPaths]}}},signal);
      check(signal);
      registrationId=authorityInteger(configRecord(response.result,["registrationId"]).registrationId,1);
      if(params.resumeAdoptionId!==undefined) {
        const state=await readState({...request,id:nextRequestId(),params:{registrationId}},signal);
        if(state.throughCursor===null)throw new Error("Retained native adoption is unavailable.");
      }
      return response;
    }
    if(request.method==="liveApplication.ownerState" || request.method==="liveApplication.ownerOutbox") {
      configRecord(request.params,["registrationId"]);
      const state=await readState(request,signal);
      if(request.method==="liveApplication.ownerOutbox") {
        if(!adopted)throw new Error("Native adoption must finish before outbox delivery.");
        return {id:request.id,result:{outboxId:outboxId??null,pendingBytes:state.pendingBytes,state:state.outboxState,retryDeliveryId:state.retryDeliveryId} as never};
      }
      const capture=session();
      return {id:request.id,result:{adoptionId:capture.activationId,expectedLocalSequence:capture.source.nativeHeadSequence,
        throughCursor:state.throughCursor??0,sessionId:capture.sessionId}};
    }
    if(request.method==="liveApplication.quarantineOwnerOutbox") {
      const params=configRecord(request.params,["registrationId","reason","deliveryId","refusalKey"]);
      registration(params.registrationId);
      if(!adopted || !outboxId)throw new Error("Service owner outbox is unavailable.");
      if(params.reason!=="provenance-refused" && params.reason!=="delivery-conflict" && params.reason!=="capacity-refused" && params.reason!=="invalid-update")throw new Error("Invalid owner quarantine reason.");
      if(typeof params.deliveryId!=="string" || !params.deliveryId || typeof params.refusalKey!=="string" || !params.refusalKey)throw new Error("Invalid owner refusal.");
      const response=await client.sendRequest({...request,method:"ydoc.ownerOutbox.quarantine",
        params:{outboxId,reason:params.reason,refusal:{deliveryId:params.deliveryId,key:params.refusalKey}}},signal);
      check(signal);return response;
    }
    if(request.method==="liveApplication.readOwnerOutbox" || request.method==="liveApplication.acknowledgeOwnerOutbox") {
      const reading=request.method==="liveApplication.readOwnerOutbox";
      const params=configRecord(request.params,reading?["registrationId"]:["registrationId","receipts"],reading?["cursor"]:[]);
      registration(params.registrationId);
      if(!adopted || !outboxId)throw new Error("Service owner outbox is unavailable.");
      const response=await client.sendRequest({...request,method:reading?"ydoc.ownerOutbox.readPending":"ydoc.ownerOutbox.acknowledge",
        params:{outboxId,...(reading?(params.cursor===undefined?{}:{cursor:params.cursor as never}):{receipts:params.receipts as never})}},signal);
      check(signal);return response;
    }
    if(request.method!=="liveApplication.settle" && request.method!=="liveApplication.fenceRestore")throw new Error("Unsupported service owner request.");
    if(request.method==="liveApplication.settle")registration(configRecord(request.params,["registrationId","terminalReceipt"]).registrationId);
    const response=await client.sendRequest(request,signal);check(signal);return response;
  };
  const sendLiveOwnerAdoption:EngineClient["sendLiveOwnerAdoption"]=async(request,cut,bounds,signal)=>{
    check(signal);registration(request.registrationId);
    const capture=session();
    if(request.workspace!==workspace || request.sessionId!==capture.sessionId || cut.adoptionId!==capture.activationId ||
      cut.expectedLocalSequence!==capture.source.nativeHeadSequence || cut.events.length!==0 || cut.terminalReceipt!==null) {
      throw new Error("Service owner adoption cut changed.");
    }
    const response=await client.sendLiveOwnerAdoption(request,cut,bounds,signal);
    check(signal);
    if((response.result as {status?:unknown}).status==="adopted")adopted=true;
    return response;
  };
  const facade=new Proxy(client,{get(target,property){
    if(property==="sendRequest")return sendRequest;
    if(property==="sendLiveOwnerAdoption")return sendLiveOwnerAdoption;
    const value=Reflect.get(target,property,target);
    return typeof value==="function"?value.bind(target):value;
  }});
  return {client:facade,async state(request:Omit<Parameters<EngineClient["sendRequest"]>[0],"method"|"params">,signal?:AbortSignal){
    const state=await readState({...request,method:"liveApplication.ownerState",params:{registrationId:registration(registrationId)}},signal);
    if(!adopted)throw new Error("Native service adoption is unavailable.");
    return {adoptionId:session().activationId,pendingBytes:state.pendingBytes};
  }};
}
