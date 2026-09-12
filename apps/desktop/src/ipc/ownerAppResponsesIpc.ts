import {z} from "zod";
import {OwnerAppResponsesRequest,OwnerAppResponsesResult} from "@dohc/cli/app-responses";
import {bulkUndoAppResponses,type AppResponseUndoSelection,type AppResponseUndoResult} from "../workspaces/ownerAppResponseModeration";
import {credentialScopedOperation} from "../workspaces/credentialScopedOperation";
import {shareViewIsPresent} from "../workspaces/shareViewMarker";
import type {CloudCredentials} from "../workspaces/cloudCredentialStore";
import {CHANNELS} from "./channels";

const id=z.string().min(1).max(512);
const acceptance=z.object({kind:z.literal("accepted"),acceptanceId:id,objectId:id,momentId:id,publicPrincipalId:id,versionId:id,collectionPath:z.string().min(1).max(4096),path:z.string().min(1).max(4096),acceptedAtMs:z.number().int().nonnegative()}).strict();
const pageSchema=z.object({acceptances:z.array(acceptance).max(100),nextAcceptanceId:id.nullable()}).strict();

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
      if(shareViewIsPresent(operation.workspace.shareView))throw new Error("Open the original workspace to remove app responses.");
      const remote=await deps.remoteForWorkspace(operation.workspace);
      const session=credentialScopedOperation({assertCurrent:()=>{operation.signal.throwIfAborted();operation.assertCurrent();},capturedGeneration:remote.credentialGeneration,currentGeneration:deps.currentCredentialGeneration});
      const result=await bulkUndoAppResponses(input,{assertCurrent:session.assertCurrent,
        readAcceptances:async selection=>{
          const query=new URLSearchParams({limit:String(selection.limit)});
          if(selection.publicPrincipalId)query.set("publicPrincipalId",selection.publicPrincipalId);
          if(selection.afterAcceptanceId)query.set("afterAcceptanceId",selection.afterAcceptanceId);
          const rawPage=await session.run(()=>deps.relayJson(remote.credentials,`/sync/${encodeURIComponent(input.workspaceId)}/app-responses/${encodeURIComponent(input.grantId)}?${query}`,{signal:operation.signal}));
          return pageSchema.parse(rawPage);
        },
        undoAcceptedResponse:selection=>session.run(()=>deps.undoAcceptedResponse(operation.workspace,selection)),
      });
      return OwnerAppResponsesResult.parse(result);
    });
  };
}

export function registerOwnerAppResponsesIpc<Sender,Workspace extends {workspaceId:string;shareView?:unknown},Operation extends {workspace:Workspace;signal:AbortSignal;assertCurrent():void}>(deps:Omit<Parameters<typeof createOwnerAppResponsesHandler<Sender,Workspace,Operation>>[0],"withWorkspaceOperation"> & {
  registerHandler(channel:string,handler:(event:{sender:Sender},raw:unknown)=>unknown):void;
  assertTrustedSender(event:{sender:Sender}):void;
  withRendererWorkspaceOperation<T>(sender:Sender,workspaceId:string,message:string,work:(operation:Operation)=>Promise<T>):Promise<T>;
}) {
  const handler=createOwnerAppResponsesHandler<Sender,Workspace,Operation>({...deps,withWorkspaceOperation:(sender,workspaceId,work)=>deps.withRendererWorkspaceOperation(sender,workspaceId,"Removing responses stopped because this window changed workspaces.",work)});
  deps.registerHandler(CHANNELS.bulkUndoAppResponses,(event,raw)=>{deps.assertTrustedSender(event);return handler(event.sender,raw);});
}
