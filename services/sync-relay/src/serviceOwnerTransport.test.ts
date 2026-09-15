import {expect,it,vi} from "vitest";
import type {NativeOwnerActivation} from "@dohc/workspace-engine-client/daemon";
import {serviceOwnerTransport} from "./serviceOwnerTransport";

function fixture(){
  const binding={workspaceId:"workspace",mainVersionId:"main",objectId:"object",lineageClaimId:"b".repeat(64),currentPath:"file.md",selectorPaths:["file.md"],restoreFenceGeneration:1};
  const capture={activationId:`ordinary-activation-${"a".repeat(64)}`,sessionId:"actual-native-session",source:{nativeHeadSequence:2}} as NativeOwnerActivation;
  let adopted=false,changed=false;
  const sendRequest=vi.fn(async(request:{id:number;method:string})=>({id:request.id,result:request.method==="liveApplication.register"?{registrationId:7}:
    request.method==="liveApplication.ownerState"?{adoptionId:adopted?capture.activationId:"native-default-adoption",expectedLocalSequence:2,
      throughCursor:adopted?0:null,outboxId:adopted?"actual-outbox":null,pendingBytes:adopted?12:0,outboxState:adopted?"active":null}:{delivered:true}}));
  const sendLiveOwnerAdoption=vi.fn(async()=>{adopted=true;return {id:3,result:{status:"adopted",adoption:{}}};});
  const transport=serviceOwnerTransport({client:{sendRequest,sendLiveOwnerAdoption} as never,workspace:"native-workspace",capture,binding,
    nextRequestId:()=>100,assertCurrent(){if(changed)throw new Error("retired");}});
  const request={id:1,workspace:"native-workspace",deadlineMs:1000};
  return {binding,capture,transport,sendRequest,sendLiveOwnerAdoption,request,retire(){changed=true;}};
}
it("uses the captured native session and translates owner outbox calls to its native outbox",async()=>{
  const f=fixture();
  await f.transport.client.sendRequest({...f.request,method:"liveApplication.register",params:{binding:f.binding}});
  const state=await f.transport.client.sendRequest({...f.request,id:2,method:"liveApplication.ownerState",params:{registrationId:7}});
  expect(state.result).toEqual({adoptionId:f.capture.activationId,expectedLocalSequence:2,throughCursor:0,sessionId:"actual-native-session"});
  expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({params:{registrationId:7,sessionId:"actual-native-session"}}),undefined);
  await f.transport.client.sendLiveOwnerAdoption({...f.request,id:3,registrationId:7,sessionId:f.capture.sessionId},
    {adoptionId:f.capture.activationId,expectedLocalSequence:2,events:[],terminalReceipt:null} as never,{maxBytes:1000,maxEvents:2});
  expect(f.sendLiveOwnerAdoption).toHaveBeenCalledWith(expect.objectContaining({sessionId:"actual-native-session"}),expect.anything(),expect.anything(),undefined);
  await f.transport.client.sendRequest({...f.request,id:4,method:"liveApplication.ownerOutbox",params:{registrationId:7}});
  await f.transport.client.sendRequest({...f.request,id:5,method:"liveApplication.readOwnerOutbox",params:{registrationId:7,cursor:"chunk"}});
  expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({method:"ydoc.ownerOutbox.readPending",params:{outboxId:"actual-outbox",cursor:"chunk"}}),undefined);
  await f.transport.client.sendRequest({...f.request,id:6,method:"liveApplication.acknowledgeOwnerOutbox",params:{registrationId:7,receipts:[]}});
  expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({method:"ydoc.ownerOutbox.acknowledge",params:{outboxId:"actual-outbox",receipts:[]}}),undefined);
});
it("refuses foreign bindings, sessions, and retirement without invoking native adoption",async()=>{
  const f=fixture();
  await expect(f.transport.client.sendRequest({...f.request,method:"liveApplication.register",params:{binding:{...f.binding,objectId:"other"}}})).rejects.toThrow("binding changed");
  expect(f.sendRequest).not.toHaveBeenCalled();
  await f.transport.client.sendRequest({...f.request,method:"liveApplication.register",params:{binding:f.binding}});
  await expect(f.transport.client.sendLiveOwnerAdoption({...f.request,registrationId:7,sessionId:"invented"},
    {adoptionId:f.capture.activationId,expectedLocalSequence:2,events:[],terminalReceipt:null} as never,{maxBytes:1000,maxEvents:2})).rejects.toThrow("cut changed");
  expect(f.sendLiveOwnerAdoption).not.toHaveBeenCalled();
  f.retire();
  await expect(f.transport.client.sendRequest({...f.request,method:"liveApplication.ownerState",params:{registrationId:7}})).rejects.toThrow("retired");
});
