import {expect,it,vi} from "vitest";
import type {NativeOwnerActivation} from "@dohc/workspace-engine-client/daemon";
import {receiptFirstSeed,serviceOwnerTransport} from "./serviceOwnerTransport";

function fixture(predecessorActivationId?:string){
  const binding={workspaceId:"workspace",mainVersionId:"main",objectId:"object",lineageClaimId:"b".repeat(64),currentPath:"file.md",selectorPaths:["file.md"],restoreFenceGeneration:1};
  const capture={activationId:`ordinary-activation-${"a".repeat(64)}`,sessionId:"actual-native-session",
    source:{nativeHeadSequence:2,fullStateDigest:"c".repeat(64),...(predecessorActivationId===undefined?{}:{predecessorActivationId})}} as NativeOwnerActivation;
  const storage={},host={mode:"service",hostId:"service",hostEpoch:1,instanceId:"instance",connectionId:"connection"} as never;
  let adopted=false,changed=false;
  const sendRequest=vi.fn(async(request:{id:number;method:string})=>({id:request.id,result:request.method==="liveApplication.register"?{registrationId:7}:
    request.method==="liveApplication.ownerState"?{adoptionId:adopted?capture.activationId:"native-default-adoption",expectedLocalSequence:2,
      throughCursor:adopted?0:null,outboxId:adopted?"actual-outbox":null,pendingBytes:adopted?12:0,outboxState:adopted?"active":null}:{delivered:true}}));
  const sendLiveOwnerAdoption=vi.fn(async()=>{adopted=true;return {id:3,result:{status:"adopted",adoption:{}}};});
  const transport=serviceOwnerTransport({client:{sendRequest,sendLiveOwnerAdoption} as never,workspace:"native-workspace",capture:async()=>capture,binding,
    storage,host,nextRequestId:()=>100,assertCurrent(){if(changed)throw new Error("retired");}});
  const request={id:1,workspace:"native-workspace",deadlineMs:1000};
  return {binding,capture,storage,host,transport,sendRequest,sendLiveOwnerAdoption,request,retire(){changed=true;}};
}
it("derives the seed's delivery from the outbox the engine reports, as native does",async()=>{
  const f=fixture();
  await f.transport.client.sendRequest({...f.request,method:"liveApplication.register",params:{binding:f.binding}});
  await f.transport.client.sendLiveOwnerAdoption({...f.request,id:3,registrationId:7,sessionId:f.capture.sessionId},
    {adoptionId:f.capture.activationId,expectedLocalSequence:2,events:[],terminalReceipt:null,retainedPrefix:null} as never,{maxBytes:1000,maxEvents:2});
  await f.transport.client.sendRequest({...f.request,id:4,method:"liveApplication.ownerOutbox",params:{registrationId:7}});
  const seed=receiptFirstSeed(f.transport.seedDelivery(),{storage:f.storage,transport:f.transport.client,activationId:f.capture.activationId,binding:f.binding,host:f.host});
  // The Rust test a_successors_later_edit_is_delivered_from_its_outbox pins the same vector natively.
  expect(seed?.deliveryId(2)).toBe("owner-delivery-c9d123ecd57e191bbb1f55a3eb45488d05a36bbef55727702cffb5711ed7a37b");
});
it("uses the captured native session and translates owner outbox calls to its native outbox",async()=>{
  const f=fixture();
  await f.transport.client.sendRequest({...f.request,method:"liveApplication.register",params:{binding:f.binding}});
  // Native registration names the captured activation, so its retirement ends this registration.
  expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({method:"liveApplication.register",
    params:{binding:f.binding,activationId:f.capture.activationId}}),undefined);
  const state=await f.transport.client.sendRequest({...f.request,id:2,method:"liveApplication.ownerState",params:{registrationId:7}});
  expect(state.result).toEqual({adoptionId:f.capture.activationId,expectedLocalSequence:2,throughCursor:0,sessionId:"actual-native-session"});
  expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({params:{registrationId:7,sessionId:"actual-native-session"}}),undefined);
  await f.transport.client.sendLiveOwnerAdoption({...f.request,id:3,registrationId:7,sessionId:f.capture.sessionId},
    {adoptionId:f.capture.activationId,expectedLocalSequence:2,events:[],terminalReceipt:null,retainedPrefix:null} as never,{maxBytes:1000,maxEvents:2});
  expect(f.sendLiveOwnerAdoption).toHaveBeenCalledWith(expect.objectContaining({sessionId:"actual-native-session"}),expect.anything(),expect.anything(),undefined);
  await f.transport.client.sendRequest({...f.request,id:4,method:"liveApplication.ownerOutbox",params:{registrationId:7}});
  await f.transport.client.sendRequest({...f.request,id:5,method:"liveApplication.readOwnerOutbox",params:{registrationId:7,cursor:"chunk"}});
  expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({method:"ydoc.ownerOutbox.readPending",params:{outboxId:"actual-outbox",cursor:"chunk"}}),undefined);
  await f.transport.client.sendRequest({...f.request,id:6,method:"liveApplication.acknowledgeOwnerOutbox",params:{registrationId:7,receipts:[]}});
  expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({method:"ydoc.ownerOutbox.acknowledge",params:{outboxId:"actual-outbox",receipts:[]}}),undefined);
  await f.transport.client.sendRequest({...f.request,id:7,method:"liveApplication.quarantineOwnerOutbox",params:{registrationId:7,reason:"provenance-refused"}});
  expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({method:"ydoc.ownerOutbox.quarantine",params:{outboxId:"actual-outbox",reason:"provenance-refused"}}),undefined);
  await expect(f.transport.client.sendRequest({...f.request,id:8,method:"liveApplication.quarantineOwnerOutbox",params:{registrationId:7,reason:"arbitrary"}})).rejects.toThrow();
});
it("refuses foreign bindings, sessions, and retirement without invoking native adoption",async()=>{
  const f=fixture();
  await expect(f.transport.client.sendRequest({...f.request,method:"liveApplication.register",params:{binding:{...f.binding,objectId:"other"}}})).rejects.toThrow("binding changed");
  expect(f.sendRequest).not.toHaveBeenCalled();
  await f.transport.client.sendRequest({...f.request,method:"liveApplication.register",params:{binding:f.binding}});
  await expect(f.transport.client.sendLiveOwnerAdoption({...f.request,registrationId:7,sessionId:"invented"},
    {adoptionId:f.capture.activationId,expectedLocalSequence:2,events:[],terminalReceipt:null,retainedPrefix:null} as never,{maxBytes:1000,maxEvents:2})).rejects.toThrow("cut changed");
  expect(f.sendLiveOwnerAdoption).not.toHaveBeenCalled();
  f.retire();
  await expect(f.transport.client.sendRequest({...f.request,method:"liveApplication.ownerState",params:{registrationId:7}})).rejects.toThrow("retired");
});
it("adopts a successor only at the boundary its captured predecessor released",async()=>{
  const predecessor=`ordinary-activation-${"d".repeat(64)}`,f=fixture(predecessor);
  await f.transport.client.sendRequest({...f.request,method:"liveApplication.register",params:{binding:f.binding}});
  const terminalReceipt={deliveryId:"seed",updateDigest:"e".repeat(64),journalCursor:1,acceptingHostEpoch:1};
  const prefix={terminalReceipt,eventCount:1,historyEvidenceDigest:"f".repeat(64),predecessorActivationId:predecessor};
  const adopt=(cut:object)=>f.transport.client.sendLiveOwnerAdoption({...f.request,id:3,registrationId:7,sessionId:f.capture.sessionId},
    {adoptionId:f.capture.activationId,expectedLocalSequence:2,events:[],terminalReceipt,retainedPrefix:prefix,...cut} as never,{maxBytes:1000,maxEvents:2});
  await expect(adopt({retainedPrefix:{...prefix,predecessorActivationId:`ordinary-activation-${"9".repeat(64)}`}})).rejects.toThrow("cut changed");
  await expect(adopt({terminalReceipt:{...terminalReceipt,journalCursor:2}})).rejects.toThrow("cut changed");
  await expect(adopt({events:[{}]})).rejects.toThrow("cut changed");
  expect(f.sendLiveOwnerAdoption).not.toHaveBeenCalled();
  await adopt({});
  expect(f.sendLiveOwnerAdoption).toHaveBeenCalledOnce();
});
