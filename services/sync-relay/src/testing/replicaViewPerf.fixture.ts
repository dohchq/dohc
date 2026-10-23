import {createServer} from "node:http";
import {join} from "node:path";
import {monitorEventLoopDelay} from "node:perf_hooks";
import {DatabaseSync} from "node:sqlite";
import {initializeRelayDeployment,openRelayDeployment} from "../relayDeployment";
import {createSyncRelayHandler} from "../server";
import {createReplicaSupervisor} from "../replicaSupervisor";
import {createReplicaEngineStarter} from "../replicaEngine";
import type {RelayWriteOwner} from "../storage/writeOwner";
import {Session} from "node:inspector/promises";
import {writeFileSync} from "node:fs";

const {root,binary,enabled,profile,profileName}=JSON.parse(process.argv[2]!) as {root:string;binary:string;enabled:boolean;profile?:boolean;profileName?:string};
const profiler=profile?new Session():undefined;
profiler?.connect();
const configPath=join(root,"deployment.json"),relayPath=join(root,"volume","relay.sqlite");
initializeRelayDeployment({configPath,relayPath,continuityDirectory:join(root,"continuity")});
const {storage}=openRelayDeployment(configPath);
storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"epoch",streamIdentity:"stream"});
storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
  grant:{grantId:"g",shareId:"s",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
const owner=createSyncRelayHandler({storage,resolveActor:(_request,workspaceId)=>({workspaceId,userId:"owner"})});
const failures:string[]=[],confirmations:number[]=[],stages:number[]=[],flips:number[]=[];
const jsonParses:number[]=[],collectWalls:number[]=[];
if(profile) {
  const parse=JSON.parse;
  JSON.parse=(...args:Parameters<typeof JSON.parse>)=>{const start=performance.now(),value=parse(...args),elapsed=performance.now()-start;
    if(typeof args[0]==="string" && args[0].includes('"refusedFiles"'))jsonParses.push(elapsed);return value;};
}
const continuity=(storage as unknown as {owner:RelayWriteOwner}).owner.continuity!,confirm=continuity.confirm.bind(continuity);
continuity.confirm=(stamp,nonce,previousNonce)=>{const start=performance.now();try{confirm(stamp,nonce,previousNonce);}finally{confirmations.push(performance.now()-start);}};
const stage=storage.stageReplicaCurrentView.bind(storage),flip=storage.flipReplicaCurrentView.bind(storage);
storage.stageReplicaCurrentView=(...args)=>{const start=performance.now();try{return stage(...args);}finally{stages.push(performance.now()-start);}};
storage.flipReplicaCurrentView=(...args)=>{const start=performance.now();try{return flip(...args);}finally{flips.push(performance.now()-start);}};
let passiveDir="",enginePid:number|undefined;
let collections=0;
const server=createServer(async(incoming,outgoing)=>{try {
  const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));
  const request=new Request(`http://127.0.0.1${incoming.url}`,{method:incoming.method,headers:incoming.headers as Record<string,string>,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
  const response=await owner(request);
  outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
}catch(error){outgoing.writeHead(500);outgoing.end(String(error));}});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const address=server.address();if(!address||typeof address==="string")throw Error("port");
const baseUrl=`http://127.0.0.1:${address.port}`;
const start=createReplicaEngineStarter({engineExecutable:binary,allowDevelopment:true});
const supervisor=createReplicaSupervisor({storage,onError:(_workspace,error)=>failures.push(String(error)),storeRoot:join(root,"replicas"),startChild:async input=>{
  passiveDir=input.storeDir;const child=await start(input);enginePid=child.pid;if(enabled)return {...child,currentView:async(...args)=>{
    collections++;const start=performance.now(),page=await child.currentView(...args);
    if(profile)collectWalls.push(performance.now()-start);return page;
  }};
  return {...child,currentView:async()=>({workspaceId:"w",revision:0,logCursor:0,journalCursor:0,files:[],texts:[],delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})};
}});
const lag=monitorEventLoopDelay({resolution:1});let cpu=process.cpuUsage(),started=0;
let closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{await supervisor.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));storage.close();})();
process.on("disconnect",()=>{void close().catch(error=>process.stderr.write(String(error)));});
process.send!({ready:true,baseUrl,pid:process.pid});
process.on("message",async message=>{
  const {id,command}=message as {id:number;command:string};
  try {
    let result:unknown;
    if(command==="activate") {await supervisor.activate("w");result={passiveDir,enginePid,failures};}
    if(command==="start") {if(profiler){await profiler.post("Profiler.enable");await profiler.post("Profiler.setSamplingInterval",{interval:1000});await profiler.post("Profiler.start");}collections=0;confirmations.length=stages.length=flips.length=jsonParses.length=collectWalls.length=0;lag.reset();lag.enable();cpu=process.cpuUsage();started=performance.now();}
    if(command==="metrics"||command==="sample") {const elapsed=performance.now()-started,used=process.cpuUsage(cpu);if(command==="metrics")lag.disable();let cpuProfile:string|undefined;
      if(command==="metrics"&&profiler){const captured=await profiler.post("Profiler.stop");cpuProfile=`${process.env.DOHC_REPLICA_MEASURE_OUT}.cpu-${profileName}.json`;writeFileSync(cpuProfile,JSON.stringify(captured.profile));profiler.disconnect();}
      result={elapsed,collections,cpuMs:(used.user+used.system)/1000,cpuPercent:(used.user+used.system)/1000/elapsed*100,eventLoopP99:lag.percentile(99)/1e6,confirmations,stages,flips,jsonParses,collectWalls,cpuProfile};}
    if(command==="verify") {await supervisor.settled("w");const db=new DatabaseSync(join(passiveDir,".dohc/engine/engine.db"),{readOnly:true});try{result={failures,refused:db.prepare("SELECT count(*) AS n FROM replication_log WHERE apply_disposition='refused'").get()!.n,text:db.prepare("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.path='docs/a.txt'").get()!.text};}finally{db.close();}}
    if(command==="close") await close();
    process.send!({id,result});
    if(command==="close")process.disconnect();
  }catch(error){process.send!({id,error:String(error)});}
});
