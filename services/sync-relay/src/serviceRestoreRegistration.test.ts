import {expect,it,vi} from "vitest";
import type {NativeOwnerActivation} from "@dohc/workspace-engine-client/daemon";
import {deliverStopRestore} from "./liveRestoreDelivery";
import {serviceOwnerTransport} from "./serviceOwnerTransport";

const binding={workspaceId:"workspace",mainVersionId:"main",objectId:"object",lineageClaimId:"b".repeat(64),currentPath:"file.md",selectorPaths:["file.md"],restoreFenceGeneration:1};
const capture={activationId:`ordinary-activation-${"a".repeat(64)}`,sessionId:"actual-native-session",source:{nativeHeadSequence:2}} as NativeOwnerActivation;
const fenced={kind:"owner"} as never;

// Native registration accepts exactly the binding. Owner state needs the activation's own session.
function nativeHost(adopted:boolean){
  return vi.fn(async(request:{id:number;method:string;params:Record<string,unknown>})=>{
    if(request.method==="liveApplication.register"){
      if(Object.keys(request.params).join()!=="binding")throw new Error("INVALID_PARAMS: invalid-live-registration");
      return {id:request.id,result:{registrationId:7}};
    }
    if(request.method==="liveApplication.ownerState" && request.params.sessionId===capture.sessionId){
      return {id:request.id,result:{adoptionId:adopted?capture.activationId:"native-default-adoption",expectedLocalSequence:2,
        throughCursor:adopted?0:null,outboxId:null,pendingBytes:0,outboxState:null,retryDeliveryId:null}};
    }
    throw new Error(`Unexpected native request ${request.method}.`);
  });
}

// The relay's retained stop cut for an activated service owner: register, no events, fence already recorded.
function stopAccess(client:unknown){
  const store={openStopRestoreCut:()=>({kind:"ready",capture:{binding,deliveryKind:"owner",resumeAdoptionId:capture.activationId}}),
    nextStopRestoreCut:()=>({kind:"done",terminalReceipt:null}),completeStopRestoreCut:vi.fn(),closeStopRestoreCut:vi.fn(),
    pendingStopRestoreFence:vi.fn(()=>({receipt:fenced}))};
  const stopped=deliverStopRestore({store:store as never,lookup:{workspaceId:"workspace",ownerUserId:"owner",operationId:"operation"},
    deliveryKind:"owner",connection:{client:client as never,workspace:"native-workspace",
      host:{mode:"service",hostId:"service",hostEpoch:1,instanceId:"instance",connectionId:"connection"} as never,deadlineMs:1000,nextRequestId:()=>1}});
  return {stopped,store};
}

const verified=(native:ReturnType<typeof nativeHost>)=>serviceOwnerTransport({client:{sendRequest:native} as never,
  workspace:"native-workspace",capture:async()=>capture,binding,nextRequestId:()=>2,assertCurrent(){}}).client;

it("stops a retained service owner through its verified session, sending native only the binding",async()=>{
  const native=nativeHost(true);
  await expect(stopAccess({sendRequest:native}).stopped).rejects.toThrow("invalid-live-registration");
  native.mockClear();
  await expect(stopAccess(verified(native)).stopped).resolves.toEqual({kind:"done",receipt:fenced});
  expect(native.mock.calls.map(([request])=>[request.method,request.params])).toEqual([
    ["liveApplication.register",{binding}],
    ["liveApplication.ownerState",{registrationId:7,sessionId:capture.sessionId}],
  ]);
});

it("refuses to stop a service owner whose retained native adoption is missing",async()=>{
  const {stopped,store}=stopAccess(verified(nativeHost(false)));
  await expect(stopped).rejects.toThrow("Retained native adoption is unavailable.");
  expect(store.pendingStopRestoreFence).not.toHaveBeenCalled();
});
