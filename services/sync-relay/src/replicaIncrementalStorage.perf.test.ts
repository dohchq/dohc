import {afterEach,expect,it,vi} from "vitest";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {performance} from "node:perf_hooks";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {decodeReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {openSyncRelayStorage} from "./storage";
import {closeTestStorages,sha256,tempRoot} from "./testing";

const opened=new Set<ReturnType<typeof openSyncRelayStorage>>();
afterEach(async()=>{vi.useRealTimers();for(const storage of opened)storage.close();opened.clear();await closeTestStorages();});
it.skipIf(process.env.DOHC_R2_PERF!=="1")("measures 31 alternating main/patch pairs for R2 and the R1 paths",async()=>{
  const base=process.env.DOHC_R2_PERF_BASE!;
  const baseStorage=await import(`${base}/services/sync-relay/src/storage.ts`);
  const basePrincipal=await import(`${base}/services/sync-relay/src/replicaReadPrincipal.ts`);
  const baseSupervisor=await import(`${base}/services/sync-relay/src/replicaSupervisor.ts`);
  const results:unknown[]=[];
  const selected=process.env.DOHC_R2_PERF_ROWS?.split(",");
  const median=(a:number[])=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)]!;
  function summary(a:number[]) {const sorted=[...a].sort((a,b)=>a-b);return {median:median(a),p95:sorted[Math.ceil(a.length*.95)-1],samples:a};}
  function interval(a:number[]) {
    let seed=2701;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
    const samples=Array.from({length:10_000},()=>median(a.map(()=>a[Math.floor(random()*a.length)]!))).sort((a,b)=>a-b);
    return [samples[249],samples[9749]];
  }
  async function fixture(count:number,patch:boolean) {
    const path=join(await tempRoot("r2-perf"),"relay.sqlite"),open=patch?openSyncRelayStorage:baseStorage.openSyncRelayStorage;
    let storage=open(path);
    opened.add(storage);
    storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
    storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
      grant:{grantId:"g",shareId:"s",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
    const principal=patch?createReplicaReadPrincipal:basePrincipal.createReplicaReadPrincipal;
    let lease=principal(storage).issue("w","perf");storage.bindReplicaCurrentView(lease);
    const body="x".repeat(50_000),texts=Array.from({length:count},(_,i)=>i?`document-${String(i).padStart(6,"0")}`:body);
    let view:ReplicaCurrentView={workspaceId:"w",revision:1,logCursor:0,journalCursor:0,omitted:[],texts:texts.map(text=>({sha256:sha256(text),text})),
      files:texts.map((text,i)=>({versionId:"main",objectId:`o${i}`,path:`docs/${String(i).padStart(6,"0")}.md`,contentKind:"text",sha256:sha256(text),byteLength:Buffer.byteLength(text),lineageClaimId:null,restoreGeneration:null}))};
    storage.storeReplicaCurrentView(lease,view);
    const input={grantId:"g",generation:1,principal:{kind:"user" as const,userId:"reader"}};
    return {patch,input,get storage(){return storage;},get view(){return view;},set view(value){view=value;},
      save(){return storage.storeReplicaCurrentView(lease,view);},
      advance(previous:ReplicaCurrentView){return storage.advanceReplicaCurrentView(lease,view,previous);},
      restart(){storage.close();opened.delete(storage);storage=open(path);opened.add(storage);lease=principal(storage).issue("w","perf");storage.bindReplicaCurrentView(lease);},close(){storage.close();opened.delete(storage);}};
  }
  for(const count of process.env.DOHC_R2_PERF_COUNTS?.split(",").map(Number) ?? [100,20_000]) {
    vi.useFakeTimers({toFake:["Date"]});
    const states=await Promise.all([fixture(count,false),fixture(count,true)]);
    async function pairs(name:string,run:(state:typeof states[number],i:number)=>Promise<number>|number) {
      if(selected && !selected.includes(name))return;
      const samples=[[] as number[],[] as number[]];
      for(let pair=-5;pair<31;pair++)for(const state of pair%2?[...states].reverse():states) {
        const ms=await run(state,pair);if(pair>=0)samples[Number(state.patch)]!.push(ms);
      }
      const differences=samples[1]!.map((ms,i)=>ms-samples[0]![i]!);
      results.push({count,name,main:summary(samples[0]!),patch:summary(samples[1]!),medianPairedDifference:median(differences),paired95:interval(differences)});
      writeFileSync(process.env.DOHC_R2_PERF_OUT!,JSON.stringify({base:process.env.DOHC_R2_PERF_COMMIT,pairs:31,warmupPairs:5,alternating:true,bootstrapResamples:10_000,seed:2701,node:process.version,results},null,2));
      console.log(count,name,JSON.stringify(results.at(-1)));
    }
    const timed=(run:()=>unknown)=>{const start=performance.now();run();return performance.now()-start;};
    try {
      await pairs("rename-save",state=>{
        state.view={...state.view,revision:state.view.revision+1,texts:[],files:[{...state.view.files[0]!,path:`docs/rename-${state.view.revision}.md`},...state.view.files.slice(1)]};
        return timed(()=>state.save());
      });
      await pairs("replacement-save",state=>{
        state.view={...state.view,revision:state.view.revision+1,texts:[],files:state.view.files.map((f,i)=>({...f,path:`docs/replacement-${state.view.revision}/${String(i).padStart(6,"0")}.md`}))};
        return timed(()=>state.save());
      });
      await pairs("unchanged-save",state=>{state.view={...state.view,revision:state.view.revision+1};return timed(()=>state.save());});
      await pairs("position-only-save",state=>{const previous=state.view;state.view={...state.view,revision:state.view.revision+1};return timed(()=>state.advance(previous));});
      await pairs("content-replacement-save",state=>{
        const texts=state.view.files.map((_,i)=>i?`replacement-${state.view.revision}-${i}`:`${state.view.revision}`.padEnd(50_000,"x"));
        state.view={...state.view,revision:state.view.revision+1,texts:texts.map(text=>({sha256:sha256(text),text})),
          files:state.view.files.map((f,i)=>({...f,sha256:sha256(texts[i]!),byteLength:Buffer.byteLength(texts[i]!)}))};
        return timed(()=>state.save());
      });
      await pairs("cold-first-open",state=>{state.restart();return timed(()=>expect(state.storage.readReplicaCurrentViewFile({...state.input,path:state.view.files[0]!.path})).toMatchObject({status:"ready",text:"x".repeat(50_000)}));});
      await pairs("cold-first-list",state=>{state.restart();return timed(()=>{const list=state.storage.listReplicaCurrentViewFiles(state.input);expect(list.status).toBe("ready");expect(list.files).toHaveLength(count);});});
    } finally {for(const state of states)state.close();}
    const live=await Promise.all([fixture(count,false),fixture(count,true)]);
    const supervisors:Array<{state:typeof live[number];supervisor:ReturnType<typeof createReplicaSupervisor>;prepare:(delta:boolean)=>void}>=[];
    // The R1 rows time the relay against the same fake child, with persistence on structural changes.
    for(const state of live) {
      let wire="";
      const make=state.patch?createReplicaSupervisor:baseSupervisor.createReplicaSupervisor;
      const supervisor=make({storage:state.storage,storeRoot:await tempRoot("r2-r1-perf"),idleMs:600_000,
        onError:(_w:string,error:unknown)=>{throw error;},startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>decodeReplicaCurrentView(JSON.parse(wire))})});
      const prepare=(delta:boolean)=>{const {omitted,...view}=state.view;wire=JSON.stringify({...view,files:delta?[view.files[0]]:view.files,delta,removed:[],refusedFiles:omitted,moved:false,nextCursor:null});};
      prepare(false);await supervisor.activate("w");
      expect(state.storage.listReplicaCurrentViewFiles(state.input,supervisor).status).toBe("ready");
      supervisors.push({state,supervisor,prepare});
    }
    const original=states.slice();states.splice(0,2,...live);
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});
    try {
      await pairs("r1-one-edit",async state=>{
        const live=supervisors[Number(state.patch)]!,text=`${state.view.revision}`.padEnd(50_000,"x");
        state.view={...state.view,revision:state.view.revision+1,files:[{...state.view.files[0]!,sha256:sha256(text),byteLength:text.length},...state.view.files.slice(1)],texts:[{sha256:sha256(text),text}]};
        live.prepare(true);const start=performance.eventLoopUtilization();await live.supervisor.activate("w");return performance.eventLoopUtilization(start).active;
      });
      for(const kind of ["open","list"] as const)await pairs(`r1-first-${kind}-after-rename`,async state=>{
        const live=supervisors[Number(state.patch)]!;
        state.view={...state.view,revision:state.view.revision+1,files:[{...state.view.files[0]!,path:`docs/live-${state.view.revision}.md`},...state.view.files.slice(1)],texts:[]};
        live.prepare(true);await live.supervisor.activate("w");
        return timed(()=>expect(kind==="open"?state.storage.readReplicaCurrentViewFile({...state.input,path:state.view.files[0]!.path},live.supervisor):state.storage.listReplicaCurrentViewFiles(state.input,live.supervisor)).toMatchObject({status:"ready"}));
      });
    } finally {for(const live of supervisors)await live.supervisor.close();for(const state of states)state.close();states.splice(0,2,...original);vi.useRealTimers();}
  }
},3_600_000);
