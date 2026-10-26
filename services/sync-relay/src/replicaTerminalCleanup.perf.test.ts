import {afterEach,expect,it} from "vitest";
import {copyFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {performance} from "node:perf_hooks";
import {openSyncRelayStorage} from "./storage";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import * as deletion from "./storage/accountDeletion";
import type {StorageContext} from "./storage/context";
import {closeTestStorages,sha256,tempRoot} from "./testing";

afterEach(closeTestStorages);
it.skipIf(process.env.DOHC_R2_REVOKE_PERF!=="1")("measures revoke and terminal-cleanup writer holds against main in 31 alternating pairs",async()=>{
  const base=process.env.DOHC_R2_PERF_BASE!,key="r2-revoke-perf-deletion-key-32-bytes";
  const mainStorage=await import(`${base}/services/sync-relay/src/storage.ts`);
  const mainPrincipal=await import(`${base}/services/sync-relay/src/replicaReadPrincipal.ts`);
  const mainDeletion=await import(`${base}/services/sync-relay/src/storage/accountDeletion.ts`);
  const count=20_000,results:unknown[]=[];
  const median=(a:number[])=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)]!;
  const summary=(a:number[])=>({median:median(a),p95:[...a].sort((a,b)=>a-b)[Math.ceil(a.length*.95)-1],samples:a});
  const interval=(a:number[])=>{let seed=2701;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
    const values=Array.from({length:10_000},()=>median(a.map(()=>a[Math.floor(random()*a.length)]!))).sort((a,b)=>a-b);return [values[249],values[9749]];};
  const selected=process.env.DOHC_R2_REVOKE_ROWS?.split(",");
  for(const journey of ["narrowing-revoke","unchanged-union-revoke","owner-deletion-eight-shares","last-share-revoke"].filter(row=>!selected || selected.includes(row))) {
    const arms=[];
    for(const patch of [false,true]) {
      const root=await tempRoot("r2-terminal-perf"),template=join(root,"template.sqlite"),path=join(root,"sample.sqlite");
      const open=patch?openSyncRelayStorage:mainStorage.openSyncRelayStorage;
      const account=patch?deletion:mainDeletion;
      const storage=open(template) as StorageContext;
      try {
        account.initializeAccountDeletion(storage,key);
        storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
        storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
        const share=(id:string,paths:string[],reader:string)=>storage.createShare({share:{shareId:id,workspaceId:"w",granterUserId:"owner",selectorJson:JSON.stringify({paths,versionId:null}),createdAtMs:1},
          grant:{grantId:id,shareId:id,principalKind:"user",principalUserId:reader,principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
        share("docs",journey==="last-share-revoke"?["docs","other"]:["docs"],"reader");
        if(journey!=="last-share-revoke")share("other",["other"],"survivor");
        if(journey==="unchanged-union-revoke")share("duplicate",["docs"],"survivor");
        if(journey.includes("eight-shares"))for(let n=2;n<8;n++)share(`share-${n}`,[n%2?"other":"docs"],"survivor");
        const lease=(patch?createReplicaReadPrincipal:mainPrincipal.createReplicaReadPrincipal)(storage).issue("w","perf");storage.bindReplicaCurrentView(lease);
        const texts=Array.from({length:count},(_,i)=>`document-${i}`);
        const files=texts.map((text,i)=>({versionId:"main",objectId:`o${i}`,path:`${i<count/2?"docs":"other"}/${String(i).padStart(6,"0")}.md`,contentKind:"text" as const,sha256:sha256(text),byteLength:text.length,lineageClaimId:null,restoreGeneration:null}));
        const view={workspaceId:"w",revision:1,logCursor:0,journalCursor:0,omitted:[],files,texts:texts.map(text=>({sha256:sha256(text),text}))};
        storage.storeReplicaCurrentView(lease,view);
        storage.storeReplicaCurrentView(lease,{...view,revision:2,texts:[],files:files.map(f=>({...f,path:f.path.replace(".md","-renamed.md")}))});
        expect(storage.db.prepare("SELECT count(*) AS n FROM sync_relay_history_pins").get()!.n).toBe(1024);
        storage.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {storage.close();}
      arms.push({patch,template,path,open,account});
    }
    const elapsed=[[] as number[],[] as number[]],holds=[[] as number[],[] as number[]];
    for(let pair=-5;pair<31;pair++)for(const arm of pair%2?[...arms].reverse():arms) {
      copyFileSync(arm.template,arm.path);
      const storage=arm.open(arm.path) as StorageContext;
      let hold=0,begin=0;
      const exec=storage.db.exec.bind(storage.db);
      storage.db.exec=(sql:string)=>{const result=exec(sql);if(sql==="BEGIN IMMEDIATE")begin=performance.now();if(sql==="COMMIT")hold+=performance.now()-begin;return result;};
      try {
        const start=performance.now();
        if(journey.includes("deletion"))arm.account.fenceAccount(storage,key,"owner","owner@test");
        else storage.revokeShare("docs",Date.now());
        const ms=performance.now()-start;
        if(pair>=0){elapsed[Number(arm.patch)]!.push(ms);holds[Number(arm.patch)]!.push(hold);}
        const remaining=storage.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_files").get()!.n;
        const terminal=journey.startsWith("owner")||journey==="last-share-revoke";
        expect(remaining).toBe(terminal?0:count);
        expect(storage.db.prepare("SELECT count(*) AS n FROM sync_relay_history_pins").get()!.n).toBe(terminal?0:1024);
        if(terminal)for(const table of ["sync_relay_replica_cuts","sync_relay_replica_cut_texts","sync_relay_replica_cut_text_refs","sync_relay_history_clocks"])
          expect(storage.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
      } finally {storage.close();}
    }
    for(const [metric,samples] of [["elapsed",elapsed],["writer-hold",holds]] as const) {
      const differences=samples[1].map((ms,i)=>ms-samples[0][i]!);
      results.push({journey,metric,count,pins:1024,main:summary(samples[0]),patch:summary(samples[1]),medianPairedDifference:median(differences),paired95:interval(differences)});
    }
    writeFileSync(process.env.DOHC_R2_PERF_OUT!,JSON.stringify({base:process.env.DOHC_R2_PERF_COMMIT,pairs:31,warmupPairs:5,alternating:true,bootstrapResamples:10_000,seed:2701,node:process.version,results},null,2));
    console.log(journey,JSON.stringify(results.slice(-2)));
  }
},3_600_000);
