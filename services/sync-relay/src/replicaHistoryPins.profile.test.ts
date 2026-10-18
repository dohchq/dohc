import {afterEach,expect,it,vi} from "vitest";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {initializeRelayDeployment,openRelayDeployment} from "./relayDeployment";
import type {StorageContext} from "./storage/context";
import {RelayWriteOwner} from "./storage/writeOwner";
import {closeTestStorages,sha256,tempRoot} from "./testing";

const arm=vi.hoisted(()=>({enabled:true}));
vi.mock("./storage/replicaHistoryPins",async original=>{
  const real=await original<typeof import("./storage/replicaHistoryPins")>();
  return {...real,pinReplicaHistory:(...args:Parameters<typeof real.pinReplicaHistory>)=>arm.enabled?real.pinReplicaHistory(...args):undefined};
});
afterEach(async()=>{vi.restoreAllMocks();await closeTestStorages();});
it.skipIf(process.env.DOHC_HISTORY_PROFILE!=="1")("profiles one flip after thirty retained pins",async()=>{
  const results:unknown[]=[];
  const evidenceRows=Number(process.env.DOHC_HISTORY_PROFILE_ROWS??0);
  const totals=new Map<string,{count:number;ms:number;exclusiveMs:number}>(),sql=new Map<string,{prepares:number;prepareMs:number;calls:number;ms:number;changes:number}>();
  const stack:Array<{label:string;child:number}>=[];
  let active=false;
  const measure=<T>(label:string,run:()=>T):T=>{
    if(!active)return run();
    const frame={label,child:0},start=performance.now();stack.push(frame);
    try{return run();}finally{
      const elapsed=performance.now()-start;stack.pop();if(stack.length)stack.at(-1)!.child+=elapsed;
      const prior=totals.get(label)??{count:0,ms:0,exclusiveMs:0};prior.count++;prior.ms+=elapsed;prior.exclusiveMs+=elapsed-frame.child;totals.set(label,prior);
    }
  };
  (globalThis as any).__historyProfile={measure};
  for(const bytes of [50_000,1_000_000])for(const enabled of [false,true]){
    arm.enabled=enabled;const root=await tempRoot("history-profile"),configPath=join(root,"deployment.json");
    const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;
    const owner=RelayWriteOwner.prototype as unknown as {mutationState():string},mutationState=owner.mutationState;
    vi.spyOn(owner,"mutationState").mockImplementation(function(this:typeof owner){return measure("durableStateFingerprint",()=>mutationState.call(this));});
    vi.spyOn(DatabaseSync.prototype,"prepare").mockImplementation(function(this:DatabaseSync,query){
      const entry=sql.get(query)??{prepares:0,prepareMs:0,calls:0,ms:0,changes:0};sql.set(query,entry);
      const before=performance.now(),statement=prepare.call(this,query);if(active){entry.prepares++;entry.prepareMs+=performance.now()-before;}
      return new Proxy(statement,{get(target,key){
        const value=Reflect.get(target,key,target);if(typeof value!=="function")return value;
        return (...args:unknown[])=>{
          if(!active)return value.apply(target,args);
          const start=performance.now();try{return measure(`sql:${query}`,()=>{const result=value.apply(target,args);if(key==="run")entry.changes+=Number(result.changes);return result;});}finally{entry.calls++;entry.ms+=performance.now()-start;}
        };
      }});
    });
    vi.spyOn(DatabaseSync.prototype,"exec").mockImplementation(function(this:DatabaseSync,query){
      if(!active)return exec.call(this,query);const start=performance.now();
      try{return measure(`sql:${query}`,()=>exec.call(this,query));}finally{const entry=sql.get(query)??{prepares:0,prepareMs:0,calls:0,ms:0,changes:0};entry.calls++;entry.ms+=performance.now()-start;sql.set(query,entry);}
    });
    initializeRelayDeployment({configPath,relayPath:join(root,"volume","relay.sqlite"),continuityDirectory:join(root,"continuity")});
    const {storage}=openRelayDeployment(configPath),context=storage as StorageContext;
    storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
    storage.createShare({share:{shareId:"g",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
      grant:{grantId:"g",shareId:"g",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
    const lease=createReplicaReadPrincipal(storage).issue("w","profile");storage.bindReplicaCurrentView(lease);
    let logical=100_000;const clock=vi.spyOn(Date,"now").mockImplementation(()=>logical);
    const make=(i:number)=>{const text=String(i).padStart(8,"0")+"x".repeat(bytes-8),sha=sha256(text);return {workspaceId:"w",revision:i,logCursor:0,journalCursor:0,omitted:[],
      files:[{versionId:"main",objectId:"object",path:"docs/a.txt",contentKind:"text" as const,sha256:sha,byteLength:bytes,lineageClaimId:null,restoreGeneration:null}],texts:[{sha256:sha,text}]};};
    try{
      storage.storeReplicaCurrentView(lease,make(0));
      for(let i=1;i<=30;i++){
        logical+=300_000;storage.storeReplicaCurrentView(lease,make(i),[{versionId:"main",objectId:"object",firstChangedAtMs:logical-300_000,changedAtMs:logical}]);
      }
      if(evidenceRows){
        context.db.exec("BEGIN");
        const insert=context.db.prepare(`INSERT INTO sync_relay_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,admitted_author_snapshot_json)
          VALUES ('w','owner',?,'ydoc.update','{"objectId":"object","versionId":"main"}',1,'[{"kind":"human","humanId":"owner","humanName":"Owner"}]')`);
        for(let row=1;row<=evidenceRows;row++)insert.run(row);
        context.db.exec("COMMIT");
      }
      logical+=300_000;const view={...make(31),logCursor:evidenceRows},staged=storage.stageReplicaCurrentView(lease,view,[{versionId:"main",objectId:"object",firstChangedAtMs:logical-300_000,changedAtMs:logical}]);
      totals.clear();for(const entry of sql.values()){entry.calls=entry.ms=entry.prepares=entry.prepareMs=entry.changes=0;}active=true;
      const start=performance.now();storage.flipReplicaCurrentView(lease,staged);const flipMs=performance.now()-start;active=false;
      const phases=Object.fromEntries(totals),statements=[...sql].filter(([,v])=>v.calls||v.prepares).map(([query,metrics])=>({query,...metrics}));
      results.push({bytes,enabled,evidenceRows,flipMs,phases,statements,pins:context.db.prepare("SELECT count(*) AS n FROM sync_relay_history_pins").get()});
      expect(statements.length).toBeGreaterThan(0);
    }finally{active=false;clock.mockRestore();storage.close();vi.restoreAllMocks();}
  }
  writeFileSync(process.env.DOHC_HISTORY_PROFILE_OUT!,JSON.stringify(results,null,2)+"\n");
},180_000);
