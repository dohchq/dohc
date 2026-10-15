import {afterEach, expect, it} from "vitest";
import {writeFileSync} from "node:fs";
import {Session} from "node:inspector/promises";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {authorizeShareGrantAction} from "./shareAuthorization";
import {createAccountlessPathProjection} from "./accountlessPathProjection";
import {createShareReadQueries} from "./shareReadQueries";
import {fileSideOf} from "./shareFilter";
import type {StorageContext} from "./storage/context";
import {closeTestStorages, moment, seedLinkGrant, sha256, tempRoot, testStorage} from "./testing";

afterEach(closeTestStorages);
it.skipIf(process.env.DOHC_REPLICA_READ_PERF !== "1")("measures authorized current-view and existing link reads", async () => {
  const storage = await testStorage(), context = storage as StorageContext;
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
  storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"epoch",streamIdentity:"stream"});
  storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["private/docs"],"versionId":null}',createdAtMs:1},
    grant:{grantId:"named",shareId:"s",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
  seedLinkGrant(storage,{grantId:"link",shareId:"s",secretHash:"hash"});
  const input = {grantId:"link",generation:1,principal:{kind:"link" as const}};
  const contents = ["", "a".repeat(50_000), "b".repeat(1_000_000)];
  for (const content of contents) storage.putBlob({workspaceId:"w",sha256:sha256(content),content:Buffer.from(content),createdAtMs:1});
  const files = Array.from({length:20_000},(_,i) => {
    const text = contents[i === 0 ? 1 : i === 1 ? 2 : 0]!;
    return {versionId:"main",objectId:`o-${i}`,path:`private/docs/${String(i).padStart(6,"0")}.md`,contentKind:"text" as const,
      sha256:sha256(text),byteLength:Buffer.byteLength(text),lineageClaimId:null,restoreGeneration:null};
  });
  for (let start=0;start<files.length;start+=500) storage.appendLogBatch({workspaceId:"w",originId:"o",ops:files.slice(start,start+500).map((f,i)=>{
    const op = moment(f.path,contents[start+i === 0 ? 1 : start+i === 1 ? 2 : 0]!,{originSeq:start+i,objectId:f.objectId});
    return {originSeq:op.originSeq,opKind:op.opKind,payloadJson:JSON.stringify(op.payload),recordedAtMs:op.recordedAtMs};
  })});
  const lease = createReplicaReadPrincipal(storage).issue("w","perf"); storage.bindReplicaCurrentView(lease);
  const view = {workspaceId:"w",revision:1,logCursor:storage.readReplicaStanding("w")!.logSeq,journalCursor:0,files,
    texts:contents.map(text=>({sha256:sha256(text),text})),omitted:[]};
  storage.storeReplicaCurrentView(lease,view);
  const supervisor = createReplicaSupervisor({storage,storeRoot:await tempRoot("read-perf"),startChild:async()=>({
    pull:async()=>{},close:async()=>{},currentView:async()=>({...view,moved:false,nextCursor:null,refusedFiles:[]})})});
  const queries = createShareReadQueries(storage,500);
  const authorize = () => {
    const result = authorizeShareGrantAction({storage,...input,action:"read"});
    if (!result.ok) throw Error("grant denied");
    const selector = fileSideOf(result.effectiveSelector); if (!selector) throw Error("no files"); return selector;
  };
  const existingList = () => {
    const selector = authorize();
    const state = storage.readCurrentFileState({workspaceId:"w",versionId:"main",selectorPaths:selector.paths,limit:20_001});
    const freshness = queries.newestFilteredOpFreshness("w",selector,state.epochLogFloor);
    const projection = createAccountlessPathProjection(authorize());
    return {files:state.files.map(f=>({...f,path:projection.projectPath(f.path)})),freshness};
  };
  const existingText = (index: number) => context.readTx(() => {
    const selector = authorize(), row = files[index]!;
    const size = storage.currentFileBlobByteLength({workspaceId:"w",versionId:"main",selectorPaths:selector.paths,sha256:row.sha256,epochLogFloor:0});
    if (size !== row.byteLength) throw Error("missing bytes");
    const bytes = storage.getBlob("w",row.sha256); authorize(); return bytes;
  });
  const results: Record<string, unknown> = {};
  const summarize = (samples: number[]) => {
    const sorted=[...samples].sort((a,b)=>a-b);
    return {p50Ms:sorted[Math.floor(samples.length/2)],p95Ms:sorted[Math.ceil(samples.length*.95)-1],
      minMs:sorted[0],maxMs:sorted.at(-1),mainThreadOccupiedMeanMs:samples.reduce((a,b)=>a+b,0)/samples.length,samples};
  };
  const validateList = (value: any) => {expect(value.status).toBe("ready");expect(value.files).toHaveLength(20_000);};
  const pair = (name: string, baseline: () => unknown, read: () => unknown, validate: (value: any) => void) => {
    for(let i=0;i<5;i++) {baseline();validate(read());}
    const link: number[]=[],replica: number[]=[],deltas: number[]=[];
    const timed = (fn:()=>unknown,samples:number[]) => {const start=performance.now();const value=fn();samples.push(performance.now()-start);return value;};
    for(let i=0;i<31;i++) {
      let result: unknown, prior: any;
      if(i%2===0) {prior=timed(baseline,link);result=timed(read,replica);}
      else {result=timed(read,replica);prior=timed(baseline,link);}
      validate(result);
      if(name.includes("list")) expect(prior.files).toHaveLength(20_000);
      else expect(prior).toEqual(Buffer.from((result as any).text));
      deltas.push(replica[i]!-link[i]!);
    }
    results[name]={link:summarize(link),replica:summarize(replica),pairedDelta:summarize(deltas)};
    console.log(name,JSON.stringify(results[name]));
  };
  try {
    const start=performance.now();validateList(storage.listReplicaCurrentViewFiles(input));
    results["stored-first-list-after-flip"]={mainThreadOccupiedMs:performance.now()-start};
    const profiler = process.env.DOHC_REPLICA_READ_PROFILE === "1" ? new Session() : undefined;
    if(profiler) {profiler.connect();await profiler.post("Profiler.enable");await profiler.post("Profiler.start");}
    pair("stored-list-20000",existingList,()=>storage.listReplicaCurrentViewFiles(input),validateList);
    if(profiler) {const profile=await profiler.post("Profiler.stop");writeFileSync(`${process.env.DOHC_REPLICA_READ_PERF_OUT}.cpuprofile`,JSON.stringify(profile.profile));profiler.disconnect();}
    for(const index of [0,1]) {
      const path=`docs/${String(index).padStart(6,"0")}.md`;
      pair(`stored-text-${files[index]!.byteLength}`,()=>existingText(index),()=>storage.readReplicaCurrentViewFile({...input,path}),
        value=>{expect(value.status).toBe("ready");expect(value.text).toBe(contents[index+1]);});
    }
    await supervisor.activate("w");
    const coldSamples: number[] = [];
    for(let i=0;i<8;i++) {
      await supervisor.activate("w"); const start=performance.now();
      const result=storage.readReplicaCurrentViewFile({...input,path:"docs/000000.md"},supervisor);
      coldSamples.push(performance.now()-start);expect(result).toMatchObject({status:"ready",text:contents[1]});
    }
    results["live-first-open-after-view-50000"]=summarize(coldSamples);
    pair("live-list-20000",existingList,()=>storage.listReplicaCurrentViewFiles(input,supervisor),validateList);
    for(const index of [0,1]) pair(`live-text-${files[index]!.byteLength}`,()=>existingText(index),
      ()=>storage.readReplicaCurrentViewFile({...input,path:`docs/${String(index).padStart(6,"0")}.md`},supervisor),
      value=>{expect(value.status).toBe("ready");expect(value.text).toBe(contents[index+1]);});
    if (process.env.DOHC_REPLICA_READ_PERF_OUT) writeFileSync(process.env.DOHC_REPLICA_READ_PERF_OUT,JSON.stringify({node:process.version,pairs:31,alternating:true,warmups:5,files:20_000,results},null,2));
    } finally {await supervisor.close();}
},300_000);
