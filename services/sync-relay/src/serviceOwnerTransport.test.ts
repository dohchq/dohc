import {expect,it,vi} from "vitest";
import type {NativeOwnerActivation} from "@dohc/workspace-engine-client/daemon";
import {serviceOwnerTransport} from "./serviceOwnerTransport";

function fixture(){
  const binding={workspaceId:"workspace",mainVersionId:"main",objectId:"object",lineageClaimId:"b".repeat(64),currentPath:"file.md",selectorPaths:["file.md"],restoreFenceGeneration:1};
  const capture={activationId:`ordinary-activation-${"a".repeat(64)}`,sessionId:"actual-native-session",source:{nativeHeadSequence:2}} as NativeOwnerActivation;
  let adopted=false,changed=false;
  const outbox={state:"active",retryDeliveryId:null as string|null};
  const sendRequest=vi.fn(async(request:{id:number;method:string})=>({id:request.id,result:request.method==="liveApplication.register"?{registrationId:7}:
    request.method==="liveApplication.ownerState"?{adoptionId:adopted?capture.activationId:"native-default-adoption",expectedLocalSequence:2,
      throughCursor:adopted?0:null,outboxId:adopted?"actual-outbox":null,pendingBytes:adopted?12:0,outboxState:adopted?outbox.state:null,
      retryDeliveryId:adopted?outbox.retryDeliveryId:null}:{delivered:true}}));
  const sendLiveOwnerAdoption=vi.fn(async()=>{adopted=true;return {id:3,result:{status:"adopted",adoption:{}}};});
  const transport=serviceOwnerTransport({client:{sendRequest,sendLiveOwnerAdoption} as never,workspace:"native-workspace",capture:async()=>capture,binding,
    nextRequestId:()=>100,assertCurrent(){if(changed)throw new Error("retired");}});
  const request={id:1,workspace:"native-workspace",deadlineMs:1000};
  return {binding,capture,transport,sendRequest,sendLiveOwnerAdoption,request,outbox,retire(){changed=true;}};
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
  expect((await f.transport.client.sendRequest({...f.request,id:4,method:"liveApplication.ownerOutbox",params:{registrationId:7}})).result)
    .toEqual({outboxId:"actual-outbox",pendingBytes:12,state:"active",retryDeliveryId:null});
  // The owner's Try again reaches the drain with the queue's state.
  Object.assign(f.outbox,{state:"quarantined",retryDeliveryId:"delivery-1"});
  expect((await f.transport.client.sendRequest({...f.request,id:4,method:"liveApplication.ownerOutbox",params:{registrationId:7}})).result)
    .toEqual({outboxId:"actual-outbox",pendingBytes:12,state:"quarantined",retryDeliveryId:"delivery-1"});
  await f.transport.client.sendRequest({...f.request,id:5,method:"liveApplication.readOwnerOutbox",params:{registrationId:7,cursor:"chunk"}});
  expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({method:"ydoc.ownerOutbox.readPending",params:{outboxId:"actual-outbox",cursor:"chunk"}}),undefined);
  await f.transport.client.sendRequest({...f.request,id:6,method:"liveApplication.acknowledgeOwnerOutbox",params:{registrationId:7,receipts:[]}});
  expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({method:"ydoc.ownerOutbox.acknowledge",params:{outboxId:"actual-outbox",receipts:[]}}),undefined);
  // A refusal carries the head it refused and its key, so native records it once.
  const refused={deliveryId:"delivery-1",refusalKey:"refusal-1"},refusal={deliveryId:"delivery-1",key:"refusal-1"};
  await f.transport.client.sendRequest({...f.request,id:7,method:"liveApplication.quarantineOwnerOutbox",params:{registrationId:7,reason:"provenance-refused",...refused}});
  expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({method:"ydoc.ownerOutbox.quarantine",params:{outboxId:"actual-outbox",reason:"provenance-refused",refusal}}),undefined);
  for(const reason of ["capacity-refused","invalid-update"]) {
    await f.transport.client.sendRequest({...f.request,id:9,method:"liveApplication.quarantineOwnerOutbox",params:{registrationId:7,reason,...refused}});
    expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({method:"ydoc.ownerOutbox.quarantine",params:{outboxId:"actual-outbox",reason,refusal}}),undefined);
  }
  const quarantines=f.sendRequest.mock.calls.length;
  await expect(f.transport.client.sendRequest({...f.request,id:8,method:"liveApplication.quarantineOwnerOutbox",params:{registrationId:7,reason:"arbitrary",...refused}})).rejects.toThrow();
  for(const params of [{registrationId:7,reason:"invalid-update"},{registrationId:7,reason:"invalid-update",deliveryId:"",refusalKey:"refusal-1"},
    {registrationId:7,reason:"invalid-update",deliveryId:"delivery-1",refusalKey:""}]) {
    await expect(f.transport.client.sendRequest({...f.request,id:13,method:"liveApplication.quarantineOwnerOutbox",params})).rejects.toThrow();
  }
  await expect(f.transport.client.sendRequest({...f.request,id:10,method:"liveApplication.quarantineOwnerOutbox",params:{registrationId:8,reason:"invalid-update",...refused}})).rejects.toThrow("registration changed");
  await expect(f.transport.client.sendRequest({...f.request,id:11,workspace:"other-workspace",method:"liveApplication.quarantineOwnerOutbox",params:{registrationId:7,reason:"invalid-update",...refused}})).rejects.toThrow("workspace changed");
  f.retire();
  await expect(f.transport.client.sendRequest({...f.request,id:12,method:"liveApplication.quarantineOwnerOutbox",params:{registrationId:7,reason:"invalid-update",...refused}})).rejects.toThrow("retired");
  expect(f.sendRequest.mock.calls.length).toBe(quarantines);
});
it("refuses an invalid-update quarantine before the service owner adopted its outbox",async()=>{
  const f=fixture();
  await f.transport.client.sendRequest({...f.request,method:"liveApplication.register",params:{binding:f.binding}});
  const calls=f.sendRequest.mock.calls.length;
  await expect(f.transport.client.sendRequest({...f.request,id:2,method:"liveApplication.quarantineOwnerOutbox",
    params:{registrationId:7,reason:"invalid-update",deliveryId:"delivery-1",refusalKey:"refusal-1"}})).rejects.toThrow("outbox is unavailable");
  expect(f.sendRequest.mock.calls.length).toBe(calls);
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
