import {OwnerAppResponsePage,OwnerAppResponsesRequest,OwnerAppResponsesResult} from "@dohc/cli/app-responses";
import {bulkUndoAppResponses,type AppResponseUndoSelection,type AppResponseUndoResult} from "../workspaces/ownerAppResponseModeration";
import {credentialScopedOperation} from "../workspaces/credentialScopedOperation";
import {shareViewIsPresent} from "../workspaces/shareViewMarker";
import type {CloudCredentials} from "../workspaces/cloudCredentialStore";
import {CHANNELS} from "./channels";

export function createOwnerAppResponsesHandler<Caller,Workspace extends {workspaceId:string;shareView?:unknown},Operation extends {workspace:Workspace;signal:AbortSignal;assertCurrent():void}>(deps:{
  withWorkspaceOperation<T>(caller:Caller,workspaceId:string,work:(operation:Operation)=>Promise<T>):Promise<T>;
  remoteForWorkspace(workspace:Workspace):Promise<{credentials:CloudCredentials;credentialGeneration:number}>;
  currentCredentialGeneration():number;
  relayJson(credentials:CloudCredentials,path:string,init:RequestInit):Promise<unknown>;
  undoAcceptedResponse(workspace:Workspace,input:AppResponseUndoSelection):Promise<Omit<AppResponseUndoResult,"acceptanceId">>;
}) {
  return async(caller:Caller,raw:unknown)=>{
    const input=OwnerAppResponsesRequest.parse(raw);
    return deps.withWorkspaceOperation(caller,input.workspaceId,async operation=>{
      operation.assertCurrent();
      if(shareViewIsPresent(operation.workspace.shareView))throw new Error("Open the original workspace to manage app responses.");
      const remote=await deps.remoteForWorkspace(operation.workspace);
      const session=credentialScopedOperation({assertCurrent:()=>{operation.signal.throwIfAborted();operation.assertCurrent();},capturedGeneration:remote.credentialGeneration,currentGeneration:deps.currentCredentialGeneration});
      const readAcceptances=async(selection: {limit:number;publicPrincipalId?:string;afterAcceptanceId?:string})=>{
          const query=new URLSearchParams({limit:String(selection.limit)});
          if(selection.publicPrincipalId)query.set("publicPrincipalId",selection.publicPrincipalId);
          if(selection.afterAcceptanceId)query.set("afterAcceptanceId",selection.afterAcceptanceId);
          const rawPage=await session.run(()=>deps.relayJson(remote.credentials,`/sync/${encodeURIComponent(input.workspaceId)}/app-responses/${encodeURIComponent(input.grantId)}?${query}`,{signal:operation.signal}));
          const page=OwnerAppResponsePage.parse(rawPage);
          if(page.acceptances.length>selection.limit || page.acceptances.some(row=>selection.publicPrincipalId!==undefined && row.publicPrincipalId!==selection.publicPrincipalId))throw new Error("The response selection changed. Refresh and try again.");
          return page;
      };
      if(input.action==="list")return OwnerAppResponsesResult.parse({action:"list",...await readAcceptances(input)});
      const result=await bulkUndoAppResponses(input,{assertCurrent:session.assertCurrent,
        readAcceptances,
        undoAcceptedResponse:selection=>session.run(()=>deps.undoAcceptedResponse(operation.workspace,selection)),
      });
      return OwnerAppResponsesResult.parse({action:"undo",...result});
    });
  };
}

export function registerOwnerAppResponsesIpc<Sender,Workspace extends {workspaceId:string;shareView?:unknown},Operation extends {workspace:Workspace;signal:AbortSignal;assertCurrent():void}>(deps:Omit<Parameters<typeof createOwnerAppResponsesHandler<Sender,Workspace,Operation>>[0],"withWorkspaceOperation"> & {
  registerHandler(channel:string,handler:(event:{sender:Sender},raw:unknown)=>unknown):void;
  assertTrustedSender(event:{sender:Sender}):void;
  withRendererWorkspaceOperation<T>(sender:Sender,workspaceId:string,message:string,work:(operation:Operation)=>Promise<T>):Promise<T>;
}) {
  const handler=createOwnerAppResponsesHandler<Sender,Workspace,Operation>({...deps,withWorkspaceOperation:(sender,workspaceId,work)=>deps.withRendererWorkspaceOperation(sender,workspaceId,"Removing responses stopped because this window changed workspaces.",work)});
  deps.registerHandler(CHANNELS.ownerAppResponses,(event,raw)=>{deps.assertTrustedSender(event);return handler(event.sender,raw);});
}
