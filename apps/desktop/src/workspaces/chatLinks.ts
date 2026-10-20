import { createHash, randomUUID } from "node:crypto";
import { ChatLinksInput, ChatLinksPage } from "@dohc/workspace-contracts/chat-links";
import type { ChatMessage } from "@dohc/workspace-contracts/engine";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { visibleSharePath } from "@dohc/security-contract/share-selector";
import type { ChatScope } from "../ipc/chatScope";
import type { RegistryEntry } from "./registryStore";
import type { EngineFileResolver } from "./resolveEngineFiles";
import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import type { createActorPresentationRequest } from "./actorPresentation";
import { recordedShareSelector } from "./shareViewRecords";
import { workspaceFileRefs } from "./workspaceFileReferenceScopes";

export function createChatLinksReader(deps: {
 requireChatScope(workspaceId:string):Promise<ChatScope>;
 syncWorkspaceSharedChannels(workspaceId:string):Promise<number>;
 readWorkspace(workspaceId:string):RegistryEntry|null;
 principalGeneration():number;
 currentAttachment(workspaceId:string):symbol;
 resolveEngineFiles:EngineFileResolver<EngineWorkspace>;
 presentationRequest(scope:ChatScope,check:()=>void):Promise<ReturnType<typeof createActorPresentationRequest>>;
}) {
 const attachments=new Map<string,{id:symbol;key:string}>();
 const binding=(workspace:RegistryEntry)=>{
  const id=deps.currentAttachment(workspace.workspaceId);
  let attachment=attachments.get(workspace.workspaceId);
  if(attachment?.id!==id){attachment={id,key:randomUUID()};attachments.set(workspace.workspaceId,attachment);}
  return createHash("sha256").update(JSON.stringify([
   attachment.key,workspace.workspaceId,workspace.rootPath,
   workspace.shareView===undefined?["owned"]:["share",workspace.shareView],
   workspace.sharedChannels??[],workspace.shareMounts??[],workspace.remote??null,
   workspace.pausedRemote??null,deps.principalGeneration(),
  ])).digest("hex");
 };
 return async (workspaceId:string,input:ChatLinksInput,assertCurrent:()=>void=()=>{}):Promise<ChatLinksPage>=>{
  const parsed=ChatLinksInput.parse(input);
  let uncovered=0;
  for(let attempt=0;;attempt++){
   const scope=await deps.requireChatScope(workspaceId);assertCurrent();
   const {workspace,store}=scope,key=binding(workspace);
   const check=()=>{
    assertCurrent();
    const current=deps.readWorkspace(workspaceId);
    if(!current||binding(current)!==key)throw new Error("chat-mention-access-changed");
   };
   check();
   const selector=recordedShareSelector(workspace.shareView?.grantedSelector);
   if(scope.kind==="share"&&(!selector||scope.access===null))throw new Error("chat-mention-access-changed");
   if(scope.kind==="workspace"&&!parsed.cursor&&attempt===0){
    uncovered=await deps.syncWorkspaceSharedChannels(workspaceId);assertCurrent();
    const current=deps.readWorkspace(workspaceId);
    if(current&&binding(current)!==key)continue;
   }
   check();
   const read=async():Promise<ChatLinksPage>=>{
    const channels=await store.listChannels({workspaceId});check();
    let admitted=false;
    for(const channel of channels){
     const wire=await store.getChannelWireId({workspaceId,channelId:channel.id});check();
     if(wire===parsed.channelWireId){admitted=true;break;}
    }
    if(!admitted)return null;
    const page=await store.linksPage({workspaceId,...parsed,scope:key,sharedChannelRowsUncovered:uncovered});check();
    if(!page)return null;
    const entries:NonNullable<ChatLinksPage>["entries"]=[];
    let present:Awaited<ReturnType<typeof deps.presentationRequest>>|undefined;
    for(const row of page.entries){
     const refs=workspaceFileRefs(workspace,row.file.objectId);
     if(!refs.length)continue;
     const resolved=await deps.resolveEngineFiles(workspace,refs);check();
     const index=resolved.findIndex(file=>file.status==="found"&&file.objectId===row.file.objectId);
     const file=resolved[index],ref=refs[index];
     if(!file||file.status!=="found"||!ref)continue;
     if(classifyEngineFilePath(file.path).kind!=="tracked"||
      (scope.kind==="share"&&(!selector||visibleSharePath(selector,file.path)===null)))continue;
     if(!present){present=await deps.presentationRequest(scope,check);check();}
     const author=row.author;
     const message:Pick<ChatMessage,"author"|"authorUserId"|"authorActorKey">={
      author:{kind:author.authorKind,displayName:author.authorDisplayName},
      ...(author.authorUserId===undefined?{}:{authorUserId:author.authorUserId}),
      ...(author.authorActorKey===undefined?{}:{authorActorKey:author.authorActorKey}),
     };
     const presentation=await present(message,row.threadId);check();
     entries.push({
      file:{objectId:file.objectId,path:file.path,folder:file.path.includes("/")?file.path.slice(0,file.path.lastIndexOf("/")):"",
       ...("receivedSource" in ref.source?{receivedSource:ref.source.receivedSource}:{})},
      threadId:row.threadId,messageId:row.messageId,mentionedAtMs:row.mentionedAtMs,
      author:{kind:author.authorKind,displayName:author.authorDisplayName,presentation,
       ...(author.authorOwnerDisplayName===undefined?{}:{ownerDisplayName:author.authorOwnerDisplayName})},
     });
    }
    check();
    return ChatLinksPage.parse({...page,entries,unchecked:[],
     complete:scope.kind==="workspace"&&page.complete,mountsCovered:!workspace.shareMounts?.length});
   };
   return scope.kind==="share"?scope.withAuthority(read):read();
  }
 };
}
