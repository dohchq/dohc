import {randomBytes} from "node:crypto";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {createReceivedIdentity} from "./receivedIdentity";
import {createAccountlessPathProjection} from "./accountlessPathProjection";
import {withReplicaCurrentView, type ReplicaCurrentViewSource, type ReplicaCurrentViewReadInput} from "./replicaCurrentViewReads";
import type {StorageContext} from "./storage/context";
import type {ReplicaWatches} from "./replicaWatches";
import type {DiscussionActivityHub} from "./discussionActivity";
import {notFound} from "./errors";
import {fileSideOf} from "./shareFilter";
import type {createShareReadQueries} from "./shareReadQueries";

export type ReplicaChangedObject = {versionId:string;objectId:string;path:string};
export type ReplicaReadChangeListener = (workspace:string,view:ReplicaCurrentView,changed:ReplicaChangedObject[],reset?:boolean)=>void;
export interface DevelopmentReplicaReads extends ReplicaCurrentViewSource {
  subscribeReadChanges(listener:ReplicaReadChangeListener):()=>void;
  activate?(workspace:string):Promise<void>;
}
type Change = {seq:number;object:ReplicaChangedObject};
type Window = {revision:number;head:number;floor:number;ceiling:number;changes:Change[]};

/** One bounded, process-local window. It retains identities, never bytes or authority. */
export function createReplicaLinkReadService(storage:StorageContext, source:DevelopmentReplicaReads,
  watches:Pick<ReplicaWatches,"holdReader">,activity:Pick<DiscussionActivityHub,"wakeLog">,
  newestFilteredOpFreshness:ReturnType<typeof createShareReadQueries>["newestFilteredOpFreshness"],key?:string|Uint8Array) {
  const windows=new Map<string,Window>(), identity=createReceivedIdentity(key);
  // Reserve most watch capacity for named readers. Admission never affects output.
  const links=new Map<string,{owner:string;until:number}>(),activations=new Map<string,number>();
  const hold=(authorized:Snapshot["authorized"])=>{
    const now=Date.now();
    for(const [workspace,held] of links)if(held.until<=now)links.delete(workspace);
    const workspace=authorized.share.workspaceId,owner=authorized.share.granterUserId;
    if(!links.has(workspace) && (links.size>=256 || [...links.values()].filter(h=>h.owner===owner).length>=8))return;
    links.set(workspace,{owner,until:now+35_000});
    watches.holdReader(authorized);
  };
  const stride=2**20;
  function cursorBase() {
    let base:number;
    do {base=randomBytes(4).readUInt32BE()*stride;}
    while([...windows.values()].some(state=>Math.floor(state.head/stride)===base/stride));
    return base;
  }
  function resetWindow(state:Window) {
    const base=cursorBase();state.changes=[];state.floor=state.head=base;state.ceiling=base+stride-1;
  }
  function window(workspace:string,revision:number) {
    let state=windows.get(workspace);
    if(!state) {
      const base=cursorBase();
      state={revision,head:base,floor:base,ceiling:base+stride-1,changes:[]};windows.set(workspace,state);
      if(windows.size>64)windows.delete(windows.keys().next().value!);
    }
    return state;
  }
  const unsubscribe=source.subscribeReadChanges((workspace,view,changed,reset)=>{
    const state=window(workspace,view.revision);
    if(reset || view.revision<state.revision)resetWindow(state);
    state.revision=view.revision;
    for(const object of new Map(changed.map(row=>[JSON.stringify([row.versionId,row.objectId,row.path]),row])).values()) {
      if(state.head===state.ceiling)resetWindow(state);
      state.changes.push({seq:++state.head,object:{versionId:object.versionId,objectId:object.objectId,path:object.path}});
    }
    while(state.changes.length>1024)state.floor=state.changes.shift()!.seq;
    activity.wakeLog(workspace);
  });
  const close=()=>{unsubscribe();windows.clear();links.clear();activations.clear();storage.unavailable.removeEventListener("abort",close);};
  storage.unavailable.addEventListener("abort",close,{once:true});
  type Snapshot=Parameters<Parameters<typeof withReplicaCurrentView>[3]>[0];
  const file=(s:Snapshot,path:string)=>{
    const row=s.rows.get(path), metadata=s.files.find(f=>f.path===path);
    if(!row || metadata?.status!=="ready")throw notFound();
    return {path,objectId:identity.object(["link",s.authorized.grant.grantId],s.workspace,row.objectId),
      blobSha256:row.sha256,contentKind:row.contentKind};
  };
  function read<T>(input:ReplicaCurrentViewReadInput,fresh:()=>unknown,run:(s:Snapshot)=>T) {
    const result=withReplicaCurrentView(storage,input,source,run,undefined,true,{onAuthorized:authorized=>{
      fresh();hold(authorized);
      const workspace=authorized.share.workspaceId,now=Date.now();
      if(source.activate && (activations.get(workspace) ?? 0)<=now) {
        activations.delete(workspace);activations.set(workspace,now+30_000);
        if(activations.size>64)activations.delete(activations.keys().next().value!);
        queueMicrotask(()=>{void source.activate!(workspace).catch(()=>{});});
      }
    }});
    if(result && typeof result==="object" && "status" in result)throw notFound();
    return result as T;
  }
  return {
    close,
    inventory(input:ReplicaCurrentViewReadInput,fresh:()=>unknown,requestedFolder?:string|null) {
      return read(input,fresh,s=>{
        if(s.files.some(f=>f.status!=="ready"))throw notFound();
        const state=window(s.workspace,s.view.revision);
        const selector=fileSideOf(s.authorized.effectiveSelector)!;
        const epochLogFloor=storage.getEpochLogFloor(s.workspace);
        if(selector.access==="edit" && s.view.logCursor<epochLogFloor)throw notFound();
        return {ok:true,effectiveSelector:createAccountlessPathProjection(selector).selector,
          access:selector.access,subjectName:storage.getShareLabels(s.authorized.share.shareId).subjectName,
          files:s.files.map(f=>{
            const current=file(s,f.path),row=s.rows.get(f.path)!;
            const folder=row.path.slice(0,-"/automations.yaml".length);
            return {...current,...(requestedFolder!=null && f.path===`${requestedFolder}/automations.yaml` ? {
              automationSwitchable:selector.access==="edit" && selector.versionId===null
                && selector.paths.some(root=>folder===root || row.path.startsWith(`${root}/`))
                && storage.automationSwitchableFolder(s.workspace,folder)} : {})};
          }),nextCursor:selector.access==="edit" ? s.view.logCursor : state.head,epochLogFloor,
          ...newestFilteredOpFreshness(s.workspace,s.authorized.effectiveSelector,epochLogFloor)};
      });
    },
    feed(input:ReplicaCurrentViewReadInput,fresh:()=>unknown,since:number,limit:number) {
      return read(input,fresh,s=>{
        const state=window(s.workspace,s.view.revision);
        const epochLogFloor=storage.getEpochLogFloor(s.workspace);
        const reset=()=>{const nextCursor=Math.max(since+1,state.head);
          if(!Number.isSafeInteger(nextCursor))throw notFound();
          return {ops:[{relaySeq:nextCursor,opKind:"files.reset",payload:{}}],nextCursor,hasMore:false,epochLogFloor};};
        if(since<state.floor || since>state.head || since!==state.floor && since!==state.head && !state.changes.some(c=>c.seq===since)
          || state.revision!==s.view.revision || s.files.some(f=>f.status!=="ready"))return reset();
        const changes=state.changes.filter(c=>c.seq>since);
        const ops:Array<{relaySeq:number;opKind:string;payload:unknown}>=[];
        let nextCursor=since;
        for(const change of changes) {
          nextCursor=change.seq;
          const path=s.visiblePath(change.object.versionId,change.object.path);
          if(path===null)continue;
          const current=[...s.rows].find(([,row])=>row.versionId===change.object.versionId && row.objectId===change.object.objectId);
          if(current && s.files.find(f=>f.path===current[0])?.status!=="ready")return reset();
          ops.push({relaySeq:change.seq,opKind:"file.current",payload:{
            objectId:identity.object(["link",input.grantId],s.workspace,change.object.objectId),file:current ? file(s,current[0]) : null}});
          if(ops.length>=limit)break;
        }
        return {ops,nextCursor:changes.length ? nextCursor : state.head,hasMore:nextCursor<state.head,epochLogFloor};
      });
    },
    blob(input:ReplicaCurrentViewReadInput,fresh:()=>unknown,sha:string,includeBytes=true) {
      return read(input,fresh,s=>{
        const row=[...s.rows.values()].find(row=>row.sha256===sha);
        if(!row)return null;
        const path=[...s.rows].find(([,value])=>value===row)![0];
        if(s.files.find(f=>f.path===path)?.status!=="ready")throw notFound();
        if(!includeBytes)return {byteLength:row.byteLength,bytes:null};
        const text=row.contentKind==="text" ? s.readText(row) : null;
        if(row.contentKind==="text" && text===null)throw notFound();
        const bytes=row.contentKind==="text" ? Buffer.from(text!) : storage.getBlob(s.workspace,sha);
        if(!bytes || bytes.byteLength!==row.byteLength)throw notFound();
        return {byteLength:row.byteLength,bytes};
      });
    },
  };
}
