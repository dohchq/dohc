import {createServer} from "node:http";
import {join} from "node:path";
import {monitorEventLoopDelay} from "node:perf_hooks";
import {createHash} from "node:crypto";
import {initializeRelayDeployment,openRelayDeployment} from "../relayDeployment";
import {createSyncRelayHandler} from "../server";
import {createReplicaReadPrincipal} from "../replicaReadPrincipal";
import type {SyncRelayStorage} from "../storage";
import type {StorageContext} from "../storage/context";

let storage:SyncRelayStorage|undefined,handler:ReturnType<typeof createSyncRelayHandler>|undefined;
let lease:ReturnType<ReturnType<typeof createReplicaReadPrincipal>["issue"]>,bytes=0,revision=0;
let logical=100_000;const realNow=Date.now;Date.now=()=>logical;
const lag=monitorEventLoopDelay({resolution:1});
let cpu=process.cpuUsage(),started=0;
let flips:number[]=[],stages:number[]=[],initialPins=0;
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
const save=(index:number,logCursor=0)=>{
  const text=String(index).padStart(8,"0")+"x".repeat(bytes-8),sha256=sha(text);
  const view={workspaceId:"w",revision:revision++,logCursor,journalCursor:0,omitted:[],files:[{versionId:"main",objectId:"object",path:"docs/a.txt",contentKind:"text" as const,sha256,byteLength:bytes,lineageClaimId:null,restoreGeneration:null}],texts:[{sha256,text}]};
  const begin=performance.now(),staged=storage!.stageReplicaCurrentView(lease,view,[{versionId:"main",objectId:"object",firstChangedAtMs:logical-300_000,changedAtMs:logical}]);
  const stagedAt=performance.now();storage!.flipReplicaCurrentView(lease,staged);stages.push(stagedAt-begin);flips.push(performance.now()-stagedAt);
};
const server=createServer(async(incoming,outgoing)=>{try{
  const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));
  const request=new Request(`http://127.0.0.1${incoming.url}`,{method:incoming.method,headers:incoming.headers as Record<string,string>,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
  const response=await handler!(request);outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
}catch(error){outgoing.writeHead(500);outgoing.end(String(error));}});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const address=server.address();if(!address||typeof address==="string")throw Error("port");
process.send!({ready:true,baseUrl:`http://127.0.0.1:${address.port}`,pid:process.pid});
let closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{lag.disable();storage?.close();storage=undefined;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));Date.now=realNow;})();
process.on("disconnect",()=>{void close();});
process.on("message",async message=>{
  const {id,command,...input}=message as {id:number;command:string;root:string;bytes:number;enabled:boolean;index:number};
  try{
    let result:unknown;
    if(command==="open"){
      storage?.close();storage=undefined;bytes=input.bytes;logical=100_000;revision=0;(globalThis as any).__historyPinsEnabled=input.enabled;
      const configPath=join(input.root,"deployment.json");initializeRelayDeployment({configPath,relayPath:join(input.root,"volume","relay.sqlite"),continuityDirectory:join(input.root,"continuity")});
      storage=openRelayDeployment(configPath).storage;
      storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
      storage.createShare({share:{shareId:"g",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},grant:{grantId:"g",shareId:"g",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
      handler=createSyncRelayHandler({storage,resolveActor:()=>({workspaceId:"w",userId:"owner"})});lease=createReplicaReadPrincipal(storage).issue("w","perf");storage.bindReplicaCurrentView(lease);
      save(-5);for(let i=-4;i<=0;i++){logical+=300_000;save(i);}
    }
    if(command==="start"){
      initialPins=Number((storage as StorageContext).db.prepare("SELECT count(*) AS n FROM sync_relay_history_pins").get()!.n);
      flips=[];stages=[];lag.reset();lag.enable();cpu=process.cpuUsage();started=performance.now();
    }
    if(command==="flip"){logical+=300_000;save(input.index,input.index);}
    if(command==="metrics"){
      const elapsed=performance.now()-started,used=process.cpuUsage(cpu);lag.disable();
      const pins=Number((storage as StorageContext).db.prepare("SELECT count(*) AS n FROM sync_relay_history_pins").get()!.n);
      result={elapsed,cpuMs:(used.user+used.system)/1000,cpuPercent:(used.user+used.system)/1000/elapsed*100,eventLoopP99:lag.percentile(99)/1e6,flips,stages,pins,pinsAdded:pins-initialPins};
    }
    if(command==="end"){storage!.close();storage=undefined;}
    if(command==="close")await close();
    process.send!({id,result});if(command==="close")process.disconnect();
  }catch(error){process.send!({id,error:String(error)});}
});
