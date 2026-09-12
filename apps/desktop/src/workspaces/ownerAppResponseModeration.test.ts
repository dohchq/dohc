import {expect,it,vi} from "vitest";
import {bulkUndoAppResponses,type AppResponseAcceptance,type AppResponseUndoSelection} from "./ownerAppResponseModeration";
const input={workspaceId:"workspace",grantId:"grant",operationId:"operation",limit:100};
const accepted:AppResponseAcceptance={acceptanceId:"accepted-a",objectId:"object",momentId:"moment",publicPrincipalId:"public-a",versionId:"main",collectionPath:"responses",path:"responses/accepted-a.md"};

it("uses the same durable per-item key after restart or a lost reply",async()=>{
  const calls:string[]=[];
  const deps={assertCurrent(){},readAcceptances:async()=>({acceptances:[accepted],nextAcceptanceId:null}),undoAcceptedResponse:vi.fn(async(selection:AppResponseUndoSelection)=>{
    calls.push(selection.requestId);return {status:"deleted" as const,momentId:"delete-moment"};
  })};
  expect((await bulkUndoAppResponses(input,deps)).items[0]).toEqual({acceptanceId:"accepted-a",status:"deleted",momentId:"delete-moment"});
  await bulkUndoAppResponses(input,{...deps});
  expect(calls[0]).toBe(calls[1]);
  await bulkUndoAppResponses({...input,operationId:"next-operation"},deps);
  expect(calls[2]).not.toBe(calls[0]);
});

it("reports partial completion and keeps the relay pagination cursor",async()=>{
  const items=[accepted,{...accepted,acceptanceId:"accepted-b"},{...accepted,acceptanceId:"accepted-c"}];
  const result=await bulkUndoAppResponses(input,{assertCurrent(){},readAcceptances:async()=>({acceptances:items,nextAcceptanceId:"accepted-c"}),undoAcceptedResponse:async x=>{
    if(x.acceptanceId==="accepted-a")return {status:"already-absent"};
    if(x.acceptanceId==="accepted-b")return {status:"conflict"};
    throw new Error("write interrupted");
  }});
  expect(result).toEqual({items:[{acceptanceId:"accepted-a",status:"already-absent"},{acceptanceId:"accepted-b",status:"conflict"},{acceptanceId:"accepted-c",status:"failed"}],nextCursor:"accepted-c"});
});

it("stops after workspace invalidation and refuses foreign principal selections",async()=>{
  let current=true;
  const undo=vi.fn(async()=>{current=false;return {status:"deleted" as const,momentId:"deleted"};});
  await expect(bulkUndoAppResponses(input,{assertCurrent(){if(!current)throw new Error("workspace changed");},readAcceptances:async()=>({acceptances:[accepted,{...accepted,acceptanceId:"accepted-b"}],nextAcceptanceId:null}),undoAcceptedResponse:undo})).rejects.toThrow("workspace changed");
  expect(undo).toHaveBeenCalledTimes(1);
  await expect(bulkUndoAppResponses({...input,publicPrincipalId:"public-other"},{assertCurrent(){},readAcceptances:async()=>({acceptances:[accepted],nextAcceptanceId:null}),undoAcceptedResponse:undo})).rejects.toThrow("selection changed");
  expect(undo).toHaveBeenCalledTimes(1);
});
