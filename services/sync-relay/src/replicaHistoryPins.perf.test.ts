import {afterEach, expect, it, vi} from "vitest";
import {monitorEventLoopDelay} from "node:perf_hooks";
import {writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {setTimeout as pace} from "node:timers/promises";
import * as Y from "yjs";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createSyncRelayHandler} from "./server";
import {initializeRelayDeployment,openRelayDeployment} from "./relayDeployment";
import type {StorageContext} from "./storage/context";
import {closeTestStorages,sha256,tempRoot,testStorage} from "./testing";

const arm=vi.hoisted(()=>({enabled:true}));
vi.mock("./storage/replicaHistoryPins",async original=>{
  const real=await original<typeof import("./storage/replicaHistoryPins")>();
  return {...real,pinReplicaHistory:(...args: Parameters<typeof real.pinReplicaHistory>)=>{
    if (arm.enabled) return real.pinReplicaHistory(...args);
  }};
});
afterEach(async()=>{vi.restoreAllMocks();await closeTestStorages();});
const quantile=(values: number[],q: number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))] ?? 0;

it.skipIf(process.env.DOHC_HISTORY_PERF !== "1")("pairs relay ingestion at 25 Hz with accelerated pin flips",async()=>{
  const results=[];
  const ticks=Number(process.env.DOHC_HISTORY_PERF_TICKS ?? 100);
  for (const bytes of [50_000,1_000_000]) for (let pair=0;pair<8;pair++) for (const enabled of pair%2 ? [true,false] : [false,true]) {
    arm.enabled=enabled;
    const root=await tempRoot("history-perf"),configPath=join(root,"deployment.json");
    initializeRelayDeployment({configPath,relayPath:join(root,"volume","relay.sqlite"),continuityDirectory:join(root,"continuity")});
    const {storage}=openRelayDeployment(configPath),context=storage as StorageContext;
    storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
    storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
    storage.createShare({share:{shareId:"g",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
      grant:{grantId:"g",shareId:"g",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
    const handler=createSyncRelayHandler({storage,resolveActor:()=>({workspaceId:"w",userId:"owner"})});
    const lease=createReplicaReadPrincipal(storage).issue("w","perf");storage.bindReplicaCurrentView(lease);
    let logical=100_000,revision=0;
    const clock=vi.spyOn(Date,"now").mockImplementation(()=>logical);
    const doc=new Y.Doc(),body=doc.getText("plainText");body.insert(0,"00000000"+"x".repeat(bytes-8));
    const save=(firstChangedAtMs: number)=>{
      const text=body.toString(),sha=sha256(text);
      storage.storeReplicaCurrentView(lease,{workspaceId:"w",revision:++revision,logCursor:storage.readReplicaStanding("w")!.logSeq,journalCursor:0,omitted:[],
        files:[{versionId:"main",objectId:"object",path:"docs/a.txt",contentKind:"text",sha256:sha,byteLength:bytes,lineageClaimId:null,restoreGeneration:null}],
        texts:[{sha256:sha,text}]},[{versionId:"main",objectId:"object",firstChangedAtMs,changedAtMs:logical}]);
    };
    save(logical);
    const lag=monitorEventLoopDelay({resolution:1}),pushes: number[]=[],scheduledPushes: number[]=[],flips: number[]=[];
    lag.enable(); const cpu=process.cpuUsage(),started=performance.now();
    let firstChange=logical+12_000;
    try {
      for (let tick=1;tick<=ticks;tick++) {
        const deadline=started+(tick-1)*40;
        await pace(Math.max(0,deadline-performance.now()));
        logical=100_000+tick*12_000;
        let update!: Uint8Array;doc.once("update",delta=>{update=delta;});
        doc.transact(()=>{body.delete(0,8);body.insert(0,String(tick).padStart(8,"0"));});
        const digest=createHash("sha256").update(update).digest("hex");
        const pushStart=performance.now();
        const uploaded=await handler(new Request(`https://relay.test/sync/w/blobs/${digest}`,{method:"PUT",body:Buffer.from(update)}));
        expect(uploaded.status).toBe(200);
        const pushed=await handler(new Request("https://relay.test/sync/w/log",{method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({originId:"owner",replicationEpoch:"e",streamIdentity:"s",ops:[{originSeq:tick-1,opKind:"ydoc.update",recordedAtMs:logical,
            payload:{versionId:"main",objectId:"object",path:"docs/a.txt",contentKind:"plaintext",updateBlobSha256:digest,isBaseState:false}}]})}));
        if (pushed.status !== 200) throw Error(`${digest}: ${pushed.status}: ${await pushed.text()}`);
        pushes.push(performance.now()-pushStart);scheduledPushes.push(performance.now()-deadline);
        if (tick%25 === 0) {const start=performance.now();save(firstChange);flips.push(performance.now()-start);firstChange=logical+12_000;}
      }
      const elapsed=performance.now()-started,used=process.cpuUsage(cpu);lag.disable();
      const retained=context.db.prepare("SELECT count(*) AS pins,coalesce(sum(byte_length),0) AS bytes FROM sync_relay_history_pins").get();
      results.push({bytes,pair,enabled,pushP50:quantile(pushes,.5),pushP95:quantile(pushes,.95),scheduledP95:quantile(scheduledPushes,.95),
        eventLoopP99:lag.percentile(99)/1e6,cpuMs:(used.user+used.system)/1000,cpuPercent:(used.user+used.system)/1000/elapsed*100,
        flipP50:quantile(flips,.5),flipP95:quantile(flips,.95),flips,retained,elapsed,achievedHz:ticks/elapsed*1000});
      if (enabled && ticks>=100) expect(Number(retained!.pins)).toBeGreaterThan(0);
      if (process.env.DOHC_HISTORY_PERF_OUT) writeFileSync(process.env.DOHC_HISTORY_PERF_OUT,JSON.stringify(results,null,2)+"\n");
    } finally {lag.disable();clock.mockRestore();doc.destroy();storage.close();}
  }
},600_000);

it.skipIf(process.env.DOHC_HISTORY_PERF !== "1")("measures retained pin text for one hour of main-cadence edits",async()=>{
  arm.enabled=true;const results=[];
  for (const bytes of [50_000,1_000_000]) {
    const storage=await testStorage(),context=storage as StorageContext;
    storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
    storage.createShare({share:{shareId:"g",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
      grant:{grantId:"g",shareId:"g",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
    const lease=createReplicaReadPrincipal(storage).issue("w","cadence");storage.bindReplicaCurrentView(lease);
    let logical=100_000;const clock=vi.spyOn(Date,"now").mockImplementation(()=>logical);
    try {
      for (let i=0;i<=120;i++) {
        logical=100_000+i*30_000;const text=String(i).padStart(8,"0")+"x".repeat(bytes-8),sha=sha256(text);
        storage.storeReplicaCurrentView(lease,{workspaceId:"w",revision:i,logCursor:0,journalCursor:0,omitted:[],
          files:[{versionId:"main",objectId:"object",path:"docs/a.txt",contentKind:"text",sha256:sha,byteLength:bytes,lineageClaimId:null,restoreGeneration:null}],texts:[{sha256:sha,text}]},
          [{versionId:"main",objectId:"object",firstChangedAtMs:i ? logical-29_960 : logical,changedAtMs:logical}]);
      }
      results.push({bytes,pins:context.db.prepare("SELECT count(*) AS n,sum(byte_length) AS bytes FROM sync_relay_history_pins").get(),
        retainedPinTextBytes:context.db.prepare(`SELECT coalesce(sum(length(bytes)),0) AS bytes FROM sync_relay_replica_cut_texts t WHERE workspace_id='w'
          AND EXISTS (SELECT 1 FROM sync_relay_history_pins p WHERE p.workspace_id=t.workspace_id AND p.sha256=t.sha256)` ).get()});
    } finally {clock.mockRestore();}
  }
  if (process.env.DOHC_HISTORY_PERF_OUT) writeFileSync(`${process.env.DOHC_HISTORY_PERF_OUT}.cadence.json`,JSON.stringify(results,null,2)+"\n");
},120_000);
