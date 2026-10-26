import {describe,expect,it,vi} from "vitest";
import {DaemonRefusalError} from "@dohc/workspace-engine-client";
import {deliverStopRestore} from "./liveRestoreDelivery";

const binding={workspaceId:"workspace",mainVersionId:"main",objectId:"object",lineageClaimId:"b".repeat(64),currentPath:"file.md",selectorPaths:["file.md"],restoreFenceGeneration:0};
const operation={point:{journalCursor:0,receiptDigest:binding.lineageClaimId},operationId:"operation",relayDatabaseNamespace:"relay",oldBinding:binding,hostId:"service",newFence:1,
  origin:{kind:"owner",id:"adoption"},terminal:null,appliedSequence:2};
const receipt={operation,localHeadSequence:2,recordedAtMs:3};
const refused={status:"pending",reason:"publication-pending"};

// The old cut already reached native; only the fence remains.
function restore(answers:unknown[],publishReplica?:(signal?:AbortSignal)=>Promise<unknown>,signal?:AbortSignal){
  const calls:string[]=[];
  const sendRequest=vi.fn(async(request:{method:string})=>{
    calls.push(request.method);
    return {result:answers.shift()};
  });
  const store={openStopRestoreCut:()=>({kind:"applied",receipt:{kind:"owner"}}),closeStopRestoreCut:vi.fn(),
    pendingStopRestoreFence:vi.fn(()=>({operation})),acknowledgeStopRestoreFence:vi.fn((_input:unknown,value:unknown)=>value)};
  const publish=publishReplica && vi.fn(async(signal?:AbortSignal)=>{calls.push("publish");return publishReplica(signal);});
  const stopped=deliverStopRestore({store:store as never,lookup:{workspaceId:"workspace",ownerUserId:"owner",operationId:"operation"},
    deliveryKind:"owner",signal,connection:{client:{sendRequest} as never,workspace:"native-workspace",
      host:{mode:"service",hostId:"service",hostEpoch:1,instanceId:"instance",connectionId:"connection"} as never,deadlineMs:1000,
      nextRequestId:()=>1,...(publish?{publish}:{})}});
  return {stopped,store,calls};
}

it("publishes the old generation once under the same call, then fences",async()=>{
  const f=restore([refused,{status:"fenced",receipt}],async()=>({pushed:2}));
  await expect(f.stopped).resolves.toEqual({kind:"done",receipt});
  expect(f.calls).toEqual(["liveApplication.fenceRestore","publish","liveApplication.fenceRestore"]);
  expect(f.store.acknowledgeStopRestoreFence).toHaveBeenCalledTimes(1);
});

it("leaves the fence pending on a host without ordinary publication",async()=>{
  const f=restore([refused]);
  await expect(f.stopped).resolves.toEqual({kind:"pending",reason:"publication-pending"});
  expect(f.calls).toEqual(["liveApplication.fenceRestore"]);
  expect(f.store.acknowledgeStopRestoreFence).not.toHaveBeenCalled();
});

it.each(["binding-changed","reader-unavailable","source-unavailable","source-too-large","incomplete-witness"])(
  "keeps a typed %s refusal on the existing retry path",async reason=>{
    const f=restore([{status:"refused",refusal:{operation,reason}}],async()=>({pushed:0}));
    await expect(f.stopped).rejects.toThrow();
    expect(f.calls).toEqual(["liveApplication.fenceRestore"]);
    expect(f.store.acknowledgeStopRestoreFence).not.toHaveBeenCalled();
  });

it.each([[{pushed:0,hasMore:true}],[{pushed:1,hasMore:true}]])(
  "asks once more after publication %o, then stays pending without looping",async published=>{
    const f=restore([refused,refused,{status:"fenced",receipt}],async()=>published);
    await expect(f.stopped).resolves.toEqual({kind:"pending",reason:"publication-pending"});
    expect(f.calls).toEqual(["liveApplication.fenceRestore","publish","liveApplication.fenceRestore"]);
    expect(f.store.acknowledgeStopRestoreFence).not.toHaveBeenCalled();
  });

it("keeps a fence held back by an update awaiting its dependency pending, as for publication",async()=>{
  const waiting={status:"pending",reason:"accepted-state-incomplete"};
  const f=restore([waiting,waiting],async()=>({pushed:0}));
  await expect(f.stopped).resolves.toEqual({kind:"pending",reason:"accepted-state-incomplete"});
  expect(f.calls).toEqual(["liveApplication.fenceRestore","publish","liveApplication.fenceRestore"]);
  expect(f.store.acknowledgeStopRestoreFence).not.toHaveBeenCalled();
});

it("does not ask again for the fence after failed publication",async()=>{
  const f=restore([refused],async()=>{throw new Error("the relay stopped answering");});
  await expect(f.stopped).rejects.toThrow("stopped answering");
  expect(f.calls).toEqual(["liveApplication.fenceRestore","publish"]);
  expect(f.store.acknowledgeStopRestoreFence).not.toHaveBeenCalled();
});

type CutReceipt={deliveryId:string;updateDigest:string;journalCursor:number;acceptingHostEpoch:number};
const declaration={agentId:"trip-agent-hosted",onBehalfOf:null,depth:0};
const cutReceipt=(cursor:number):CutReceipt=>({deliveryId:`delivery-${cursor}`,updateDigest:"c".repeat(64),journalCursor:cursor,acceptingHostEpoch:1});
const cutEvent=(cursor:number)=>({metadata:{accepted:{receipt:cutReceipt(cursor),binding},authorSnapshot:[{kind:"agent",agentId:declaration.agentId,depth:declaration.depth}]}});

// The old cut still holds `events` declared changes; the host refuses the
// chosen application calls as settlement-required.
function cut(kind:"owner"|"bootstrap",events:number,refusals:(call:number)=>boolean,
  {materialized=true,failure,overloaded,reason="settlement-required"}:{materialized?:boolean;failure?:Error;overloaded?:Error;reason?:string}={}){
  let applied:CutReceipt|null=null,calls=0;
  const requests:{method:string;params?:unknown}[]=[];
  const sendRequest=vi.fn(async({method,params}:{method:string;params?:unknown})=>{
    requests.push({method,params});
    if(method==="liveApplication.register")return {result:{registrationId:9}};
    if(method==="liveApplication.fenceRestore")return {result:{status:"fenced",receipt}};
    expect(method).toBe("liveApplication.settle");
    if(failure)throw failure;
    const terminal=(params as {terminalReceipt:CutReceipt|null}).terminalReceipt;
    return {result:{status:"settled",settlement:{settlementId:`settlement-${requests.length}`,previousCursor:0,terminalCursor:terminal?.journalCursor??0,
      applicationCount:terminal?1:0,localYDocSequence:1,momentId:"moment-1",markdownDigest:"d".repeat(64),materialized,collectionReconcileRequired:false}}};
  });
  const sendLiveApplication=vi.fn(async(_native:unknown,admitted:ReturnType<typeof cutEvent>)=>{
    calls++;
    if(overloaded&&admitted.metadata.accepted.receipt.journalCursor===2)throw overloaded;
    return refusals(calls)?{result:{status:"pending",reason}}
      :{result:{status:"applied",ack:{...admitted.metadata.accepted.receipt,localYDocSequence:calls,applicationReplayed:false}}};
  });
  const store={
    openStopRestoreCut:()=>({kind:"ready",capture:{deliveryKind:kind,binding,resumeAdoptionId:kind==="owner"?"adoption":null}}),
    nextStopRestoreCut:vi.fn(()=>{
      const cursor=(applied?.journalCursor??0)+1;
      return cursor>events?{kind:"done",terminalReceipt:applied}:{kind:"next",admitted:cutEvent(cursor),predecessor:applied};
    }),
    acknowledgeStopRestoreApplication:vi.fn((_capture:unknown,predecessor:CutReceipt|null,ack:CutReceipt)=>{
      expect(predecessor).toEqual(applied);
      applied=cutReceipt(ack.journalCursor);
    }),
    completeStopRestoreCut:vi.fn(),closeStopRestoreCut:vi.fn(),
    pendingStopRestoreFence:vi.fn(()=>({operation})),acknowledgeStopRestoreFence:vi.fn((_input:unknown,value:unknown)=>value),
  };
  const stopped=deliverStopRestore({store:store as never,lookup:{workspaceId:"workspace",ownerUserId:"owner",operationId:"operation"},
    deliveryKind:kind,connection:{client:{sendRequest,sendLiveApplication} as never,workspace:"native-workspace",
      host:{mode:"service",hostId:"service",hostEpoch:1,instanceId:"instance",connectionId:"connection"} as never,deadlineMs:1000,nextRequestId:()=>1}});
  const settles=()=>requests.filter(request=>request.method==="liveApplication.settle").map(request=>request.params);
  const fenced=()=>requests.some(request=>request.method==="liveApplication.fenceRestore");
  const offered=()=>sendLiveApplication.mock.calls.map(([,event])=>event);
  return {stopped,store,settles,fenced,offered};
}

describe.each(["owner","bootstrap"] as const)("%s restore cut on a full author interval",kind=>{
  it("settles once through the last applied change, offers the identical declared change, then fences",async()=>{
    const f=cut(kind,2,call=>call===2);
    await expect(f.stopped).resolves.toEqual({kind:"done",receipt});
    // Only the registration and the applied terminal: no owner draft or authority is named.
    expect(f.settles()).toEqual([{registrationId:9,terminalReceipt:cutReceipt(1)}]);
    expect(f.offered()).toEqual([cutEvent(1),cutEvent(2),cutEvent(2)]);
    expect(f.store.completeStopRestoreCut).toHaveBeenCalledTimes(1);
    expect(f.store.closeStopRestoreCut).toHaveBeenCalledTimes(1);
  });

  it("settles with no terminal when the first change of the cut fills the interval",async()=>{
    const f=cut(kind,1,call=>call===1);
    await expect(f.stopped).resolves.toEqual({kind:"done",receipt});
    expect(f.settles()).toEqual([{registrationId:9,terminalReceipt:null}]);
    expect(f.offered()).toEqual([cutEvent(1),cutEvent(1)]);
  });

  it("settles again once a later change applied",async()=>{
    const f=cut(kind,3,call=>call===2||call===4);
    await expect(f.stopped).resolves.toEqual({kind:"done",receipt});
    expect(f.settles()).toEqual([{registrationId:9,terminalReceipt:cutReceipt(1)},{registrationId:9,terminalReceipt:cutReceipt(2)}]);
  });

  it("fails when the host still requires settlement after settling everything it applied",async()=>{
    const f=cut(kind,2,call=>call>=2);
    await expect(f.stopped).rejects.toThrow("The host still requires settlement after settling everything it applied.");
    expect(f.settles()).toHaveLength(1);
    expect(f.offered()).toEqual([cutEvent(1),cutEvent(2),cutEvent(2)]);
    expect(f.fenced()).toBe(false);
    expect(f.store.closeStopRestoreCut).toHaveBeenCalledTimes(1);
  });

  it("waits without fencing when the settlement's file write has not landed",async()=>{
    const f=cut(kind,2,call=>call===2,{materialized:false});
    await expect(f.stopped).resolves.toEqual({kind:"pending",reason:"settlement-materialization-pending"});
    expect(f.offered()).toEqual([cutEvent(1),cutEvent(2)]);
    expect(f.fenced()).toBe(false);
    expect(f.store.completeStopRestoreCut).not.toHaveBeenCalled();
  });

  it("propagates a failed settlement without fencing",async()=>{
    const failure=new Error("settle failed");
    const f=cut(kind,2,call=>call===2,{failure});
    await expect(f.stopped).rejects.toBe(failure);
    expect(f.fenced()).toBe(false);
  });

  it("leaves an earlier unresolved file write to backoff without settling",async()=>{
    const overloaded=new DaemonRefusalError({code:"OVERLOADED",message:"settlement-materialization-pending",retry:"afterBackoff"},undefined);
    const f=cut(kind,2,()=>false,{overloaded});
    await expect(f.stopped).rejects.toBe(overloaded);
    expect(f.settles()).toEqual([]);
    expect(f.fenced()).toBe(false);
  });

  it("keeps any other pending reason as it was, without settling",async()=>{
    const f=cut(kind,2,call=>call===2,{reason:"dependencies-unresolved"});
    await expect(f.stopped).resolves.toEqual({kind:"pending",reason:"dependencies-unresolved"});
    expect(f.settles()).toEqual([]);
    expect(f.fenced()).toBe(false);
  });
});

it("does not ask again for the fence once the caller cancels during publication",async()=>{
  const caller=new AbortController();
  const f=restore([refused,{status:"fenced",receipt}],async()=>{caller.abort(new Error("caller left"));return {pushed:1};},caller.signal);
  await expect(f.stopped).rejects.toThrow("caller left");
  expect(f.calls).toEqual(["liveApplication.fenceRestore","publish"]);
  expect(f.store.acknowledgeStopRestoreFence).not.toHaveBeenCalled();
});
