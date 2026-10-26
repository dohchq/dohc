import {afterEach,expect,it,vi} from "vitest";
import {performance} from "node:perf_hooks";
import {writeFileSync} from "node:fs";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {decodeReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {listReplicaCurrentViewFiles,readReplicaCurrentViewFile} from "./replicaCurrentViewReads";
import {closeTestStorages,sha256,tempRoot,testStorage} from "./testing";
import type {StorageContext} from "./storage/context";
import {forgetReplicaCurrentViewStoredCache} from "./storage/replicaCurrentViews";

afterEach(async()=>{vi.useRealTimers();await closeTestStorages();});
it.skipIf(process.env.DOHC_R1_PERF!=="1")("measures 31 alternating base/patch relay revisions and first reads after rename",async()=>{
  const baseDir=process.env.DOHC_R1_PERF_BASE!;
  const baseSupervisor=await import(`${baseDir}/replicaSupervisor.ts`);
  const baseReads=await import(`${baseDir}/replicaCurrentViewReads.ts`);
  const results:unknown[]=[];
  const summary=(a:number[])=>{const s=[...a].sort((a,b)=>a-b);return {median:s[Math.floor(s.length/2)],p95:s[Math.ceil(s.length*.95)-1],samples:a};};
  for(const count of [100,20_000]) {
    const states=[];
    for(const patch of [false,true]) {
      const storage=await testStorage();storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
      storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},grant:{grantId:"g",shareId:"s",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
      const files=Array.from({length:count},(_,i)=>({versionId:"main",objectId:`o${i}`,path:`docs/${String(i).padStart(6,"0")}.md`,contentKind:"text",sha256:sha256(""),byteLength:0,lineageClaimId:null,restoreGeneration:null}));
      let revision=1,wires:string[]=[],fallback=false;
      const prepare=(delta:boolean,text:string)=>{
        const selected=delta?[files[0]!]:files;
        wires=[];for(let offset=0;offset<selected.length;offset+=10_000) {const rows=selected.slice(offset,offset+10_000);wires.push(JSON.stringify({workspaceId:"w",revision,logCursor:0,journalCursor:0,delta,removed:[],files:rows,texts:offset?[]:[...new Set(["",text])].map(text=>({sha256:sha256(text),text})),refusedFiles:[],moved:false,nextCursor:offset+rows.length<selected.length?{versionId:"main",objectId:rows.at(-1)!.objectId,path:rows.at(-1)!.path}:null}));}
      };
      prepare(false,"");const failures:unknown[]=[];
      const make=patch?createReplicaSupervisor:baseSupervisor.createReplicaSupervisor;
      const supervisor=make({storage,storeRoot:await tempRoot("r1-perf"),idleMs:600_000,onError:(_w:string,e:unknown)=>failures.push(String(e)),startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async(_s:unknown,known:string[],_p:unknown,cursor:unknown)=>{const page=JSON.parse(wires[cursor?1:0]!);if(fallback){expect(known).toContain(files[0]!.sha256);page.texts=page.texts.filter((t:{sha256:string})=>!known.includes(t.sha256));}return decodeReplicaCurrentView(page);}})});
      await supervisor.activate("w");
      const input={grantId:"g",generation:1,principal:{kind:"user" as const,userId:"reader"}};
      const read=patch?readReplicaCurrentViewFile:baseReads.readReplicaCurrentViewFile,list=patch?listReplicaCurrentViewFiles:baseReads.listReplicaCurrentViewFiles;
      expect(list(storage as StorageContext,input,supervisor).status).toBe("ready");
      const samples={revision:[] as number[],revisionWall:[] as number[],open:[] as number[],list:[] as number[],fallback:[] as number[],replacement:[] as number[],restart:[] as number[]};
      states.push({patch,storage,supervisor,samples,failures,async fullFallback(){fallback=true;revision++;prepare(false,"edit 30");const active=performance.eventLoopUtilization();await supervisor.activate("w");samples.fallback.push(performance.eventLoopUtilization(active).active);},async replacement(i:number){fallback=true;for(let j=0;j<files.length;j++)files[j]={...files[j],path:`docs/replacement-${i}/${j}.md`};revision++;prepare(false,"edit 30");const active=performance.eventLoopUtilization();await supervisor.activate("w");const value=list(storage as StorageContext,input,supervisor);samples.replacement.push(performance.eventLoopUtilization(active).active);expect(value.status).toBe("ready");if(value.status==="ready")expect(value.files).toHaveLength(count);},async restart(){await supervisor.evict("w");forgetReplicaCurrentViewStoredCache(storage as unknown as StorageContext,"w");fallback=false;revision++;prepare(false,"edit 30");const active=performance.eventLoopUtilization();await supervisor.activate("w");samples.restart.push(performance.eventLoopUtilization(active).active);},async edit(i:number){const text=`edit ${i}`;files[0]={...files[0]!,sha256:sha256(text),byteLength:text.length};revision++;prepare(patch,text);const active=performance.eventLoopUtilization(),start=performance.now();await supervisor.activate("w");samples.revisionWall.push(performance.now()-start);samples.revision.push(performance.eventLoopUtilization(active).active);},async rename(i:number,kind:"open"|"list"){files[0]={...files[0]!,path:`docs/renamed-${i}-${kind}.md`};revision++;prepare(patch,`edit ${30}`);await supervisor.activate("w");const start=performance.now();const value=kind==="open"?read(storage as StorageContext,{...input,path:files[0]!.path},supervisor):list(storage as StorageContext,input,supervisor);samples[kind].push(performance.now()-start);expect(value.status).toBe("ready");if(kind==="list")expect(value.files).toHaveLength(count);}});
    }
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});
    try {
      for(let pair=-5;pair<31;pair++) {
        if(pair===0)for(const state of states)state.samples.revision.length=state.samples.revisionWall.length=0;
        for(const state of pair%2?[...states].reverse():states)await state.edit(pair);
      }
      for(let pair=-5;pair<31;pair++) {
        if(pair===0)for(const state of states)state.samples.open.length=state.samples.list.length=0;
        for(const state of pair%2?[...states].reverse():states){await state.rename(pair,"open");await state.rename(pair,"list");}
      }
      for(let pair=-5;pair<31;pair++) {
        if(pair===0)for(const state of states)state.samples.fallback.length=0;
        for(const state of pair%2?[...states].reverse():states)await state.fullFallback();
      }
      for(let pair=-5;pair<31;pair++) {
        if(pair===0)for(const state of states)state.samples.replacement.length=state.samples.restart.length=0;
        for(const state of pair%2?[...states].reverse():states)await state.replacement(pair);
      }
      for(let pair=-5;pair<31;pair++) {
        if(pair===0)for(const state of states)state.samples.restart.length=0;
        for(const state of pair%2?[...states].reverse():states)await state.restart();
      }
      for(const state of states){expect(state.failures).toEqual([]);results.push({count,patch:state.patch,mainThreadPerRevision:summary(state.samples.revision),wallPerRevision:summary(state.samples.revisionWall),firstOpen:summary(state.samples.open),firstList:summary(state.samples.list),fullFallback:summary(state.samples.fallback),replacementFallback:summary(state.samples.replacement),restartFallback:summary(state.samples.restart)});}
      writeFileSync(process.env.DOHC_R1_PERF_OUT!,JSON.stringify({pairs:31,warmupPairs:5,alternating:true,node:process.version,results},null,2));
    } finally {for(const state of states)await state.supervisor.close();vi.useRealTimers();}
  }
},3_600_000);
