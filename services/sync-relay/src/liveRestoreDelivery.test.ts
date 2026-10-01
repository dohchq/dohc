import {expect,it,vi} from "vitest";
import {deliverStopRestore} from "./liveRestoreDelivery";

const binding={workspaceId:"workspace",mainVersionId:"main",objectId:"object",lineageClaimId:"b".repeat(64),currentPath:"file.md",selectorPaths:["file.md"],restoreFenceGeneration:0};
const operation={operationId:"operation",relayDatabaseNamespace:"relay",oldBinding:binding,hostId:"service",newFence:1,
  origin:{kind:"owner",id:"adoption"},terminal:null,appliedSequence:2};
const receipt={operation,localHeadSequence:2,recordedAtMs:3};
const refused={status:"pending",reason:"publication-pending"};

// The old cut already reached native; only the fence remains.
function restore(answers:unknown[],publishOrdinary?:(signal?:AbortSignal)=>Promise<unknown>,signal?:AbortSignal){
  const calls:string[]=[];
  const sendRequest=vi.fn(async(request:{method:string})=>{
    calls.push(request.method);
    return {result:answers.shift()};
  });
  const store={openStopRestoreCut:()=>({kind:"applied",receipt:{kind:"owner"}}),closeStopRestoreCut:vi.fn(),
    pendingStopRestoreFence:vi.fn(()=>({operation})),acknowledgeStopRestoreFence:vi.fn((_input:unknown,value:unknown)=>value)};
  const publish=publishOrdinary && vi.fn(async(signal?:AbortSignal)=>{calls.push("publish");return publishOrdinary(signal);});
  const stopped=deliverStopRestore({store:store as never,lookup:{workspaceId:"workspace",ownerUserId:"owner",operationId:"operation"},
    deliveryKind:"owner",signal,connection:{client:{sendRequest} as never,workspace:"native-workspace",
      host:{mode:"service",hostId:"service",hostEpoch:1,instanceId:"instance",connectionId:"connection"} as never,deadlineMs:1000,
      nextRequestId:()=>1,...(publish?{publishOrdinary:publish}:{})}});
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

it.each([[{pushed:0,hasMore:true}],[{pushed:1,hasMore:true}]])(
  "asks once more after publication %o, then stays pending without looping",async published=>{
    const f=restore([refused,refused,{status:"fenced",receipt}],async()=>published);
    await expect(f.stopped).resolves.toEqual({kind:"pending",reason:"publication-pending"});
    expect(f.calls).toEqual(["liveApplication.fenceRestore","publish","liveApplication.fenceRestore"]);
    expect(f.store.acknowledgeStopRestoreFence).not.toHaveBeenCalled();
  });

it("does not ask again for the fence after failed publication",async()=>{
  const f=restore([refused],async()=>{throw new Error("the relay stopped answering");});
  await expect(f.stopped).rejects.toThrow("stopped answering");
  expect(f.calls).toEqual(["liveApplication.fenceRestore","publish"]);
  expect(f.store.acknowledgeStopRestoreFence).not.toHaveBeenCalled();
});

it("does not ask again for the fence once the caller cancels during publication",async()=>{
  const caller=new AbortController();
  const f=restore([refused,{status:"fenced",receipt}],async()=>{caller.abort(new Error("caller left"));return {pushed:1};},caller.signal);
  await expect(f.stopped).rejects.toThrow("caller left");
  expect(f.calls).toEqual(["liveApplication.fenceRestore","publish"]);
  expect(f.store.acknowledgeStopRestoreFence).not.toHaveBeenCalled();
});
