import {expect} from "vitest";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {DiscussionActivityHub} from "../discussionActivity";
import {ReplicaWatches} from "../replicaWatches";
import {hashLinkBearer} from "../linkSecurity";
import {createReplicaReadPrincipal} from "../replicaReadPrincipal";
import {inspectDatabase,json,jsonBody,LINK_KEY,request,seedLinkGrant,sha256,storagePath,testHandler,testStorage,type HandlerOverrides} from "./index";
export async function fixture(access: "view"|"comment"|"edit" = "view", enabled = true) {
  const storage=await testStorage(), activity=new DiscussionActivityHub(), watches=new ReplicaWatches(activity);
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner@dohc.test",createdAtMs:1});
  storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"epoch",streamIdentity:"stream"});
  storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner@dohc.test",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
    grant:{grantId:"named",shareId:"s",principalKind:"user",principalUserId:"reader@dohc.test",principalEmail:null,
      access:"edit",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
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
    ...(enabled ? {developmentReplicaReads:source}: {})} as HandlerOverrides;
  const h=testHandler(storage,options);
  const saved=testHandler(storage,{...options,developmentReplicaReads:undefined});
  const exchanged=await json(await h(request(null,"/sync/link-exchange",{...jsonBody({secret}),headers:{"content-type":"application/json","x-dohc-relay-exchange-key":"e".repeat(64)}})));
  expect(exchanged.capabilityToken).toBeTypeOf("string");
  const send=(path:string,signal?:AbortSignal,headers:Record<string,string>={})=>h(request(null,path,{headers:{...headers,authorization:`LinkCapability ${exchanged.capabilityToken}`},signal}));
  function publish(text="live",path="docs/a.md",objectId="object") {
    const previous=latest?.files ?? [];
    latest={workspaceId:"w",revision:++revision,logCursor:0,journalCursor:0,
      files:[{versionId:"main",objectId,path,contentKind:"text",sha256:sha256(text),byteLength:Buffer.byteLength(text),lineageClaimId:null,restoreGeneration:null}],
      texts:[{sha256:sha256(text),text}],omitted:[]};
    for(const listener of listeners)listener("w",latest,[...previous,...latest.files]);
  }
  return {storage,activity,watches,h,send,savedSend:(path:string,headers:Record<string,string>={})=>saved(request(null,path,{headers:{...headers,authorization:`LinkCapability ${exchanged.capabilityToken}`}})),publish,source,get latest(){return latest!;},lease,
    db:inspectDatabase(storagePath(storage)),dispose:()=>watches.dispose()};
}
