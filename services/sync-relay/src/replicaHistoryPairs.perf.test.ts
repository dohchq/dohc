import {afterEach,expect,it} from "vitest";
import {spawn} from "node:child_process";
import {writeFileSync,readFileSync,mkdirSync,rmSync} from "node:fs";
import {cpus,freemem} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createRequire} from "node:module";
import {setTimeout as pace} from "node:timers/promises";
import {createHash} from "node:crypto";
import {build} from "esbuild";
import * as Y from "yjs";
import {closeTestStorages,tempRoot} from "./testing";

afterEach(closeTestStorages);
const quantile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))]??0;
const host=()=>{const cores=cpus();return {idle:cores.reduce((sum,c)=>sum+c.times.idle,0),total:cores.reduce((sum,c)=>sum+Object.values(c.times).reduce((a,b)=>a+b,0),0),cores:cores.length,freeMemory:freemem()};};
it.skipIf(process.env.DOHC_HISTORY_FIX1!=="1")("pairs final relay flips and socket ingestion with thirty-one pairs per size",async()=>{
  const output=process.env.DOHC_HISTORY_FIX1_OUT!,directory=resolve("node_modules/.cache/history-fix1"),bundle=join(directory,"relay.mjs");
  mkdirSync(directory,{recursive:true});
  await build({entryPoints:[fileURLToPath(new URL("./testing/replicaHistoryPerf.fixture.ts",import.meta.url))],outfile:bundle,bundle:true,platform:"node",format:"esm",target:"node24",packages:"external",
    plugins:[{name:"test-pin-switch",setup(builder){
      builder.onResolve({filter:/^lib0\//},args=>({path:pathToFileURL(createRequire(args.importer).resolve(args.path)).href,external:true}));
      builder.onLoad({filter:/[/\\]storage[/\\]replicaHistoryPins\.ts$/},args=>{
      const source=readFileSync(args.path,"utf8"),needle="  const workspace = view.workspaceId, now = Date.now();";
      if(!source.includes(needle))throw Error("Pin switch location moved");
      return {loader:"ts",contents:source.replace(needle,`  if ((globalThis as any).__historyPinsEnabled === false) return new Map<string,number>();\n${needle}`)};
    });}}]});
  const relay=spawn(process.execPath,["--import","tsx",bundle],{windowsHide:true,stdio:["ignore","pipe","pipe","ipc"]});
  const exited=new Promise<void>(resolve=>relay.once("close",()=>resolve()));let failure="";relay.stdout!.resume();relay.stderr!.on("data",data=>{failure+=String(data);});
  const ready=await new Promise<{baseUrl:string;pid:number}>((resolve,reject)=>{relay.once("message",message=>resolve(message as any));relay.once("close",()=>reject(Error(failure)));}).catch(error=>{rmSync(directory,{recursive:true,force:true});throw error;});
  writeFileSync(`${output}.process.json`,JSON.stringify({pid:ready.pid,command:[process.execPath,"--import","tsx",bundle],cwd:process.cwd()},null,2)+"\n");
  let commandId=0;
  const command=(command:string,input={})=>new Promise<any>((resolve,reject)=>{
    const id=++commandId;
    const closed=()=>{relay.off("message",receive);reject(Error(failure||"Relay exited"));};
    const receive=(message:any)=>{if(message.id!==id)return;relay.off("message",receive);relay.off("close",closed);message.error?reject(Error(message.error)):resolve(message.result);};
    relay.on("message",receive);relay.once("close",closed);relay.send({id,command,...input});
  });
  const samples:unknown[]=[],pilots:any[]=[];
  const arm=async(bytes:number,enabled:boolean,hz:number,pair:number,pilot:boolean)=>{
    const root=await tempRoot("history-fix1"),ticks=40;
    await command("open",{root,bytes,enabled});
    const doc=new Y.Doc(),body=doc.getText("plainText");body.insert(0,"00000000"+"x".repeat(bytes-8));
    const updates=Array.from({length:ticks},(_,i)=>{let delta!:Uint8Array;doc.once("update",update=>{delta=update;});doc.transact(()=>{body.delete(0,8);body.insert(0,String(i+1).padStart(8,"0"));});return {delta:Buffer.from(delta),digest:createHash("sha256").update(delta).digest("hex")};});doc.destroy();
    await command("start");const hostBefore=host(),started=performance.now(),at=new Date().toISOString(),pushes:number[]=[],pending:Promise<void>[]=[],flips:Promise<unknown>[]=[];
    let previousLog=Promise.resolve();
    for(let index=1;index<=ticks;index++){
      const deadline=started+(index-1)*1000/hz;await pace(Math.max(0,deadline-performance.now()));
      const previous=previousLog,update=updates[index-1]!,begin=performance.now();
      const push=(async()=>{
        const uploaded=await fetch(`${ready.baseUrl}/sync/w/blobs/${update.digest}`,{method:"PUT",body:update.delta,headers:{connection:"close"}});if(uploaded.status!==200)throw Error(await uploaded.text());await uploaded.arrayBuffer();
        await previous;
        const pushed=await fetch(`${ready.baseUrl}/sync/w/log`,{method:"POST",headers:{"content-type":"application/json",connection:"close"},body:JSON.stringify({originId:"owner",replicationEpoch:"e",streamIdentity:"s",ops:[{originSeq:index-1,opKind:"ydoc.update",recordedAtMs:100_000+index*300_000,payload:{versionId:"main",objectId:"object",path:"docs/a.txt",contentKind:"plaintext",updateBlobSha256:update.digest,isBaseState:false}}]})});
        if(pushed.status!==200)throw Error(await pushed.text());await pushed.arrayBuffer();pushes.push(performance.now()-begin);flips.push(command("flip",{index}));
      })();void push.catch(()=>{});pending.push(push);previousLog=push;
    }
    await Promise.all(pending);await Promise.all(flips);const elapsed=performance.now()-started,metrics=await command("metrics"),hostAfter=host();
    await command("end");await closeTestStorages();
    expect(metrics.flips).toHaveLength(ticks);
    expect(metrics.pinsAdded).toBe(enabled?ticks:0);
    const result={bytes,enabled,hz,pair,pilot,at,elapsed,achievedHz:ticks/elapsed*1000,pushP50:quantile(pushes,.5),pushP95:quantile(pushes,.95),flipP50:quantile(metrics.flips,.5),flipP95:quantile(metrics.flips,.95),stageP50:quantile(metrics.stages,.5),stageP95:quantile(metrics.stages,.95),...metrics,host:{logicalProcessors:hostBefore.cores,cpuPercent:100*(1-(hostAfter.idle-hostBefore.idle)/(hostAfter.total-hostBefore.total)),freeMemoryBefore:hostBefore.freeMemory,freeMemoryAfter:hostAfter.freeMemory}};
    return result;
  };
  try{
    let hz=25;
    for(const candidate of [25,20,15,10,5,2,1]){
      const trial=[];for(const bytes of [50_000,1_000_000])for(const enabled of [false,true])trial.push(await arm(bytes,enabled,candidate,-1,true));
      pilots.push(...trial);writeFileSync(`${output}.pilot.json`,JSON.stringify(pilots,null,2)+"\n");
      if(trial.every(row=>row.achievedHz>=candidate*.95)){hz=candidate;break;}
      if(candidate===1)throw Error("The host cannot sustain even one offered push/flip per second in both arms");
    }
    const pairs=Number(process.env.DOHC_HISTORY_FIX1_PAIRS??31);
    for(const bytes of [50_000,1_000_000])for(let pair=0;pair<pairs;pair++)for(const enabled of pair%2?[true,false]:[false,true]){
      samples.push(await arm(bytes,enabled,hz,pair,false));writeFileSync(output,JSON.stringify(samples,null,2)+"\n");
    }
  }finally{await command("close");await exited;rmSync(directory,{recursive:true,force:true});}
},7_200_000);
