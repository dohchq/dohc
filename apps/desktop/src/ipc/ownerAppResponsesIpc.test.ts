import { expect, it, vi } from "vitest";
import { registerOwnerAppResponsesIpc } from "./ownerAppResponsesIpc";

const accepted = {kind:"accepted",acceptanceId:"a",objectId:"o",momentId:"m",publicPrincipalId:"public-a",versionId:"main",collectionPath:"responses",path:"responses/a.json",acceptedAtMs:100};
const selection = {workspaceId:"w",grantId:"g",limit:100};
function harness() {
  const controller = new AbortController();
  const workspace = {workspaceId:"w",shareView:undefined as unknown};
  let current=true, generation=1;
  const relay=vi.fn(async():Promise<unknown>=>({acceptances:[accepted],nextAcceptanceId:null}));
  const undo=vi.fn(async()=>({status:"deleted" as const,momentId:"deleted-m"}));
  let handler!:(event:{sender:number},raw:unknown)=>unknown;
  registerOwnerAppResponsesIpc({
    registerHandler(_channel,fn){handler=fn;},
    assertTrustedSender(event:{sender:number}){if(event.sender!==1)throw new Error("untrusted");},
    async withRendererWorkspaceOperation(_sender,workspaceId,_message,work){
      if(workspaceId!==workspace.workspaceId)throw new Error("wrong workspace");
      return work({workspace,signal:controller.signal,assertCurrent(){if(!current)throw new Error("retired");}});
    },
    remoteForWorkspace:async()=>({credentials:{serverUrl:"https://account.test",relayUrl:"https://relay.test",userId:"owner",token:"test",email:"owner@test.invalid"},credentialGeneration:generation}),
    currentCredentialGeneration:()=>generation,relayJson:relay,undoAcceptedResponse:undo,
  });
  return {workspace,relay,undo,controller,retire(){current=false;},switchCredentials(){generation++;},
    async invoke(input:unknown,sender=1){return handler({sender},input);}};
}

it("lists immutable acceptances without mutation and uses the same owner route for undo",async()=>{
  const h=harness();
  expect(await h.invoke({action:"list",...selection})).toEqual({action:"list",acceptances:[accepted],nextAcceptanceId:null});
  expect(h.undo).not.toHaveBeenCalled();
  expect(await h.invoke({action:"undo",...selection,operationId:"operation-a"})).toEqual({action:"undo",items:[{acceptanceId:"a",status:"deleted",momentId:"deleted-m"}],nextCursor:null});
  expect(h.undo).toHaveBeenCalledOnce();
});

it.each(["sender","workspace","share-view"])("refuses %s access before reading responses",async kind=>{
  const h=harness();
  if(kind==="share-view")h.workspace.shareView={shareId:"s"};
  await expect(h.invoke({action:"list",...selection,workspaceId:kind==="workspace"?"other":"w"},kind==="sender"?2:1)).rejects.toThrow();
  expect(h.relay).not.toHaveBeenCalled();expect(h.undo).not.toHaveBeenCalled();
});

it.each(["retirement","credential","abort"])("refuses a response page returned after %s",async kind=>{
  const h=harness();
  h.relay.mockImplementationOnce(async()=>{if(kind==="retirement")h.retire();else if(kind==="credential")h.switchCredentials();else h.controller.abort();return {acceptances:[accepted],nextAcceptanceId:null};});
  await expect(h.invoke({action:"undo",...selection,operationId:"operation-a"})).rejects.toThrow();
  expect(h.undo).not.toHaveBeenCalled();
});

it("rejects unexpected relay fields and a mismatched holder before deleting",async()=>{
  const h=harness();
  h.relay.mockResolvedValueOnce({acceptances:[{...accepted,privatePrincipalId:"private"}],nextAcceptanceId:null});
  await expect(h.invoke({action:"list",...selection})).rejects.toThrow();
  await expect(h.invoke({action:"undo",...selection,publicPrincipalId:"public-other",operationId:"operation-a"})).rejects.toThrow("selection changed");
  expect(h.undo).not.toHaveBeenCalled();
});
