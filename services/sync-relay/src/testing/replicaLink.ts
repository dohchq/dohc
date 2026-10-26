import {expect} from "vitest";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {DiscussionActivityHub} from "../discussionActivity";
import {ReplicaWatches} from "../replicaWatches";
import {hashLinkBearer} from "../linkSecurity";
import {createReplicaReadPrincipal} from "../replicaReadPrincipal";
import {inspectDatabase,json,jsonBody,LINK_KEY,request,seedLinkGrant,sha256,storagePath,testHandler,testStorage,type HandlerOverrides} from "./index";
export async function fixture(access: "view"|"comment"|"edit"|"read-only"|"read-write" = "view", enabled = true, overrides:HandlerOverrides={}) {
  const storage=await testStorage(), activity=new DiscussionActivityHub(), watches=new ReplicaWatches(activity);
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner@dohc.test",createdAtMs:1});
  storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"epoch",streamIdentity:"stream"});
  const group=access === "read-only" || access === "read-write";
  if(group) storage.appendLogBatch({workspaceId:"w",originId:"owner",ops:[{originSeq:0,opKind:"chat.channel.create",recordedAtMs:1,
    payloadJson:JSON.stringify({wireId:"channel",channelId:"channel",kind:"channel",name:"Group",slug:"group",createdAtMs:1})}]});
  storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner@dohc.test",selectorJson:JSON.stringify(group ?
    {kind:"group",channelWireId:"channel",paths:["private/docs"],versionId:null} : {paths:["docs"],versionId:null}),createdAtMs:1},
    grant:{grantId:"named",shareId:"s",principalKind:"user",principalUserId:"reader@dohc.test",principalEmail:null,
      access:group ? "read-write" : "edit",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
  const secret="a".repeat(43);
  seedLinkGrant(storage,{shareId:"s",grantId:"link",secretHash:hashLinkBearer(secret,LINK_KEY),access,createdAtMs:1});
  const lease=createReplicaReadPrincipal(storage).issue("w","test");storage.bindReplicaCurrentView(lease);
  let latest:ReplicaCurrentView|undefined,revision=0;
  type Listener=(workspace:string,view:ReplicaCurrentView,changed:Array<{versionId:string;objectId:string;path:string}>,reset?:boolean)=>void;
  const listeners=new Set<Listener>();
  const source={currentReadView:()=>latest ? {view:latest} : null,
    subscribeReadChanges:(listener:Listener)=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const options={discussionActivity:activity,replicaWatches:watches,publicEditRelease:{version:1},
    shareWebOrigin:"https://viewer.dohc.test",relayExchangeKey:"e".repeat(64),
    namedBrowserSessionLimits:{maxSessions:8,retentionMs:60_000,maxPendingRequests:4,maxRequestBytes:8192,maxResponseBytes:16384,timeoutMs:1000},
    ...(enabled ? {developmentReplicaReads:source}: {}),...overrides} as HandlerOverrides;
  const h=testHandler(storage,options);
  const saved=testHandler(storage,{...options,developmentReplicaReads:undefined});
  const exchanged=await json(await h(request(null,"/sync/link-exchange",{...jsonBody({secret}),headers:{"content-type":"application/json","x-dohc-relay-exchange-key":"e".repeat(64)}})));
  expect(exchanged.capabilityToken).toBeTypeOf("string");
  const send=(path:string,signal?:AbortSignal,headers:Record<string,string>={})=>h(request(null,path,{headers:{...headers,authorization:`LinkCapability ${exchanged.capabilityToken}`},signal}));
  function publish(text="live",path=group ? "private/docs/a.md" : "docs/a.md",objectId="object") {
    const previous=latest?.files ?? [];
    latest={workspaceId:"w",revision:++revision,logCursor:storage.readReplicaStanding("w")!.logSeq,journalCursor:0,
      files:[{versionId:"main",objectId,path,contentKind:"text",sha256:sha256(text),byteLength:Buffer.byteLength(text),lineageClaimId:null,restoreGeneration:null}],
      texts:[{sha256:sha256(text),text}],omitted:[]};
    for(const listener of listeners)listener("w",latest,[...previous,...latest.files]);
  }
  const retire=()=>{const old=latest;latest=undefined;if(old)for(const listener of listeners)listener("w",old,[],true);};
  return {storage,activity,watches,h,send,options,secret,capabilityToken:String(exchanged.capabilityToken),savedSend:(path:string,headers:Record<string,string>={})=>saved(request(null,path,{headers:{...headers,authorization:`LinkCapability ${exchanged.capabilityToken}`}})),publish,source,retire,get latest(){return latest!;},omit(){latest={...latest!,revision:++revision,omitted:[{versionId:"main",objectId:"large",path:"docs/large.md",sha256:sha256("large"),reason:"text-frame-limit"}]};},lease,
    db:inspectDatabase(storagePath(storage)),dispose:()=>{h.dispose();saved.dispose();watches.dispose();}};
}

export const transientReplicaStates=["restore fence","frame limit","retirement","epoch floor"] as const;
export function blockReplica(f:Awaited<ReturnType<typeof fixture>>,kind:typeof transientReplicaStates[number]) {
  if(kind==="restore fence")f.db.prepare(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,baseline_moment_relay_seq,
    baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes,
    lineage_state,admission_state,restore_fence_generation,registered_at_ms)
    VALUES('w','main','fenced',?,'docs/fenced.md',1,?,0,?,x'01','current','closed',2,1)`)
    .run(sha256("fence"),sha256(""),sha256("fence"));
  if(kind==="frame limit")f.omit();
  if(kind==="retirement")f.retire();
  if(kind==="epoch floor")f.db.exec("UPDATE sync_relay_workspaces SET epoch_log_floor=1 WHERE workspace_id='w'");
  return ()=>{f.db.exec("DELETE FROM sync_relay_live_documents; UPDATE sync_relay_workspaces SET epoch_log_floor=0 WHERE workspace_id='w'");f.publish("recovered");};
}
