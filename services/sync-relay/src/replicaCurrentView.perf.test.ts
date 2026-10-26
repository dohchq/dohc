import {it,expect,afterEach,vi} from "vitest";
import {spawn,execFileSync} from "node:child_process";
import {Duplex} from "node:stream";
import {EngineClient,DuplexEngineClientConnection,decodeReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {createHash} from "node:crypto";
import {statSync,writeFileSync,appendFileSync} from "node:fs";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {closeTestStorages,tempRoot} from "./testing";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {requireEngineBinaryOrSkip} from "../../../apps/desktop/src/testing/engineBinary";
import {initializeRelayDeployment,openRelayDeployment} from "./relayDeployment";
import type {SyncRelayStorage} from "./storage";
import type {RelayWriteOwner} from "./storage/writeOwner";
import type {StorageContext} from "./storage/context";
import {nextShareDiscussionRevision} from "./storage/discussion";
import {openEngineYdocProviderSession} from "../../../packages/workspace-engine-client/src/ydoc/ydocProviderSession";

const binary=requireEngineBinaryOrSkip();
const deployments:SyncRelayStorage[]=[];
afterEach(async()=>{for(const storage of deployments.splice(0))storage.close();await closeTestStorages();});
const measurements=new WeakMap<SyncRelayStorage,{path:string;sidePath:string;confirmations:number[]}>();
const hash=(text: string)=>createHash("sha256").update(text).digest("hex");

it.skipIf(process.env.DOHC_REPLICA_MEASURE!=="1")("round4 measures distinct-file persistence and discussion writes",async()=>{
  const storage=await fixture(),context=storage as unknown as StorageContext;
  const lease=createReplicaReadPrincipal(storage).issue("w","distinct");storage.bindReplicaCurrentView(lease);
  const texts=Array.from({length:20_000},(_,i)=>{const text=`document-${String(i).padStart(6,"0")}`;return {sha256:hash(text),text};});
  const files=texts.map((t,i)=>({versionId:"main",objectId:`o${i}`,path:`docs/${String(i).padStart(6,"0")}.md`,contentKind:"text" as const,sha256:t.sha256,byteLength:Buffer.byteLength(t.text),lineageClaimId:null,restoreGeneration:null}));
  const measured=measurements.get(storage)!;measured.confirmations.length=0;
  const start=performance.now();storage.storeReplicaCurrentView(lease,{workspaceId:"w",omitted:[],revision:1,logCursor:0,journalCursor:0,files,texts});
  const freshMs=performance.now()-start,freshStamps=measured.confirmations.length;
  measured.confirmations.length=0;const repeat=performance.now();
  storage.storeReplicaCurrentView(lease,{workspaceId:"w",omitted:[],revision:2,logCursor:0,journalCursor:0,files,texts});
  const unchangedMs=performance.now()-repeat,unchangedStamps=measured.confirmations.length;
  const before:number[]=[];for(let i=0;i<21;i++){const t=performance.now();context.tx(()=>nextShareDiscussionRevision(context,"s"));before.push(performance.now()-t);}
  context.db.exec("BEGIN");
  try {
    const workspace=context.db.prepare("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity) VALUES (?,'owner',1,'epoch','stream')");
    const share=context.db.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner','{\"paths\":[],\"versionId\":\"main\"}',1)");
    const grant=context.db.prepare("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,access,generation,status,created_at_ms) VALUES (?,?,'user','reader','view',1,'active',1)");
    const header=context.db.prepare("INSERT INTO sync_relay_replica_cuts(workspace_id,replication_epoch,stream_identity,incarnation,cut_seq,revision,log_cursor,journal_cursor) VALUES (?,'epoch','stream','test',1,0,0,0)");
    for(let i=1;i<1000;i++){const id=`wide-${i}`;workspace.run(id);share.run(id,id);grant.run(id,id);header.run(id);}
    context.db.exec("COMMIT");
  }catch(e){context.db.exec("ROLLBACK");throw e;}
  const discussion:number[]=[];
  for(let i=0;i<21;i++){const t=performance.now();context.tx(()=>nextShareDiscussionRevision(context,"s"));discussion.push(performance.now()-t);}
  expect(context.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cuts").get()!.n).toBe(1000);
  expect(context.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_files").get()!.n).toBe(20000);
  output("distinct-writes",{freshMs,freshStamps,unchangedMs,unchangedStamps,distinctFiles:20000,logicalBytes:texts.reduce((n,t)=>n+Buffer.byteLength(t.text),0),discussion:{views:1000,p50:quantile(discussion,.5),p95:quantile(discussion,.95)},oneViewDiscussion:{p50:quantile(before,.5),p95:quantile(before,.95)}});
},600_000);
it.skipIf(process.env.DOHC_REPLICA_MEASURE!=="1")("round4 measures accepted discussion messages with one thousand views",async()=>{
  const storage=await fixture(),context=storage as unknown as StorageContext,measured=measurements.get(storage)!;
  const text="stored",sha=hash(text);
  context.db.exec("BEGIN");
  try {
    const workspace=context.db.prepare("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity) VALUES (?,'owner',1,'epoch','stream')");
    const share=context.db.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner','{\"paths\":[\"docs\"],\"versionId\":null}',1)");
    const grant=context.db.prepare("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,access,generation,status,created_at_ms) VALUES (?,?,'user','reader','view',1,'active',1)");
    const header=context.db.prepare("INSERT INTO sync_relay_replica_cuts(workspace_id,replication_epoch,stream_identity,incarnation,cut_seq,revision,log_cursor,journal_cursor) VALUES (?,'epoch','stream','test',1,0,0,0)");
    const file=context.db.prepare("INSERT INTO sync_relay_replica_cut_files VALUES (?,'main','a','docs/a.txt','text',?,6,NULL,NULL)");
    const blob=context.db.prepare("INSERT INTO sync_relay_replica_cut_texts VALUES (?,?,0,?)");
    const reference=context.db.prepare("INSERT INTO sync_relay_replica_cut_text_refs VALUES (?,?,1)");
    for(let i=0;i<1000;i++){const id=i?`message-${i}`:"w";if(i){workspace.run(id);share.run(id,id);grant.run(id,id);}header.run(id);file.run(id,sha);blob.run(id,sha,Buffer.from(text));reference.run(id,sha);}
    context.db.exec("COMMIT");
  }catch(e){context.db.exec("ROLLBACK");throw e;}
  const samples:number[]=[];measured.confirmations.length=0;const cpu=process.cpuUsage();
  const guard=()=>{expect(storage.workspaceIsOwnedBy("w","owner")).toBe(true);return "owner" as const;};
  for(let i=0;i<21;i++) {
    const started=performance.now();
    const result=storage.appendAuthenticatedDiscussionMessage({shareId:"s",authorUserId:"owner",displayName:"Owner",body:`Message ${i}`,idempotencyKey:`message-${i}`,createdAtMs:10+i,readGuard:guard,appendGuard:guard});
    samples.push(performance.now()-started);expect(result.ok).toBe(true);
  }
  const used=process.cpuUsage(cpu);
  expect(context.db.prepare("SELECT count(*) AS n FROM sync_relay_share_discussion_messages").get()!.n).toBe(21);
  expect(context.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cuts").get()!.n).toBe(1000);
  output("discussion-messages",{views:1000,messages:21,p50:quantile(samples,.5),p95:quantile(samples,.95),cpuMsPerMessage:(used.user+used.system)/1000/21,stampConfirmations:measured.confirmations.length,samples});
},120_000);
const quantile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*q)]!;
const output=(name:string,data:unknown)=>{console.log(name,JSON.stringify(data));if(process.env.DOHC_REPLICA_MEASURE_OUT)writeFileSync(`${process.env.DOHC_REPLICA_MEASURE_OUT}.${name}.json`,JSON.stringify(data));};
async function fixture() {
  const root=await tempRoot("configured-view-perf"),configPath=join(root,"deployment.json"),path=join(root,"volume","relay.sqlite");
  initializeRelayDeployment({configPath,relayPath:path,continuityDirectory:join(root,"continuity")});
  const {storage}=openRelayDeployment(configPath);deployments.push(storage);
  const confirmations:number[]=[],continuity=(storage as unknown as {owner:RelayWriteOwner}).owner.continuity!;
  const confirm=continuity.confirm.bind(continuity);
  continuity.confirm=(stamp,nonce,previousNonce)=>{const start=performance.now();try{confirm(stamp,nonce,previousNonce);}finally{confirmations.push(performance.now()-start);}};
  measurements.set(storage,{path,sidePath:join(root,"continuity","continuity.sqlite"),confirmations});
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
  storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"epoch",streamIdentity:"stream"});
  storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
    grant:{grantId:"g",shareId:"s",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
  return storage;
}
it.skipIf(process.platform!=="linux"||binary.missing||process.env.DOHC_REPLICA_MEASURE!=="1")("pairs owner push costs with cuts enabled and disabled",async()=>{
  const results=[],revisions=Number(process.env.DOHC_REPLICA_MEASURE_REVISIONS??100),hz=Number(process.env.DOHC_REPLICA_MEASURE_HZ??10);
  for(const bytes of process.env.DOHC_REPLICA_MEASURE_BYTES?[Number(process.env.DOHC_REPLICA_MEASURE_BYTES)]:[50_000,1_000_000])for(let pair=Number(process.env.DOHC_REPLICA_MEASURE_PAIR_START??0);pair<Number(process.env.DOHC_REPLICA_MEASURE_PAIRS??8);pair++)for(const enabled of process.env.DOHC_REPLICA_OFF_ONLY==="1"?[false]:process.env.DOHC_REPLICA_ON_ONLY==="1"?[true]:pair%2?[true,false]:[false,true]) {
    const root=await tempRoot("view-perf-relay");
    const relay=spawn(process.execPath,["--import","tsx",new URL("./testing/replicaViewPerf.fixture.ts",import.meta.url).pathname.replace(/^\/(\w:)/,"$1"),JSON.stringify({root,binary:binary.require(),enabled,profile:process.env.DOHC_REPLICA_PROFILE==="1",profileName:`${bytes}-${pair}-${enabled}`})],{windowsHide:true,stdio:["ignore","pipe","pipe","ipc"]});
    const relayExit=new Promise<void>(resolve=>relay.once("close",()=>resolve()));
    relay.stdout!.resume();relay.stderr!.on("data",bytes=>process.stderr.write(bytes));
    const ready=await new Promise<{baseUrl:string}>(resolve=>relay.once("message",message=>resolve(message as {baseUrl:string})));
    let commandId=0;
    const command=(command:string)=>new Promise<any>((resolve,reject)=>{const id=++commandId;const receive=(message:any)=>{if(message.id!==id)return;relay.off("message",receive);message.error?reject(Error(message.error)):resolve(message.result);};relay.on("message",receive);relay.send({id,command});});
    const ownerDir=await tempRoot("view-perf-owner"),token="view-perf-owner";
    const processChild=spawn(binary.require(),[],{windowsHide:true,stdio:["pipe","pipe","pipe"],env:{DOHC_ENGINE_AUTH_TOKEN:token,SystemRoot:process.env.SystemRoot}});
    const exited=new Promise<void>(resolve=>processChild.once("close",()=>resolve()));
    const client=new EngineClient(new DuplexEngineClientConnection(Duplex.from({readable:processChild.stdout,writable:processChild.stdin})),{authToken:token,protocolVersion:2,capabilities:["blobs"]},()=>processChild.kill("SIGKILL"),exited);
    processChild.on("close",(code,signal)=>client.notifyProcessExit(code,signal));processChild.stderr.resume();await client.ready();let requestId=1,workspace:string|undefined;
    const rpc=async(method:string,params:Record<string,unknown>={})=>(await client.sendRequest({id:requestId++,method,workspace,deadlineMs:120_000,params:params as never})).result as any;
    let previous:string|null=null;
    const nativePush=async(index:number)=>{
      const text=String(index).padStart(8,"0");
      await rpc("versionedText.writeBlob",{versionId:"main",path:"docs/a.txt",sha256:hash(text),bytesBase64:Buffer.from(text).toString("base64"),momentId:`revision-${index}`,origin:"api",publish:true});
      const started=performance.now();let page;do{page=await rpc("sync.push",{workspaceId:"w"});expect(page.status).toBe("complete");}while(page.hasMore);
      previous=text;return performance.now()-started;
    };
    try {
      workspace=(await rpc("workspace.open",{rootDir:ownerDir,workspaceId:"w",captureMode:"none",relay:{baseUrl:ready.baseUrl,bearerToken:"user:owner",allowInsecureLoopbackForTests:true}})).workspace;
      await rpc("sync.adoptJoinIdentity",{workspaceId:"w",replicationEpoch:"epoch",streamIdentity:"stream"});await rpc("versions.ensureMain",{workspaceId:"w"});
      await nativePush(0);
      const provider=await openEngineYdocProviderSession({transport:client,workspace:workspace!,versionId:"main",path:"docs/a.txt",contentKind:"plaintext",onRemoteUpdate(){}});
      for(let remaining=bytes-8;remaining>0;remaining-=40_000){let update!:Uint8Array;provider.doc.once("update",delta=>{update=delta;});const body=provider.doc.getText("plainText");body.insert(body.length,"x".repeat(Math.min(40_000,remaining)));await provider.applyLocalUpdate(update,{armSettle:false});}
      previous="00000000"+"x".repeat(bytes-8);
      let opening;do{opening=await rpc("sync.push",{workspaceId:"w"});expect(opening.status).toBe("complete");}while(opening.hasMore);
      const activation=await command("activate");expect(activation.failures).toEqual([]);output("fixture-path",{passiveDir:activation.passiveDir});
      if(process.env.DOHC_REPLICA_MEASURE_OUT)appendFileSync(`${process.env.DOHC_REPLICA_MEASURE_OUT}.processes.jsonl`,JSON.stringify({relay:relay.pid,owner:processChild.pid,replica:activation.enginePid,root})+"\n");
      const {DatabaseSync}=await import("node:sqlite");const verified=await command("verify");expect(verified.refused).toBe(0);expect(verified.failures).toEqual([]);expect(verified.text).toBe(previous);
      output("replay-accepted",{bytes,pair,enabled,initial:true});
      const prepared:Array<{originId:string;ops:any[];text:string;blobs:Array<{sha:string;bytes:Uint8Array}>}>=[];
      const sourceDb=new DatabaseSync(`${ownerDir}/.dohc/engine/engine.db`,{readOnly:true});
      let lastRow=Number(sourceDb.prepare("SELECT max(rowid) AS n FROM replication_log").get()!.n);
      try {for(let index=1;index<=revisions;index++) {
        const text=String(index).padStart(8,"0")+"x".repeat(bytes-8);
        let update!:Uint8Array;provider.doc.once("update",delta=>{update=delta;});
        provider.doc.transact(()=>{const body=provider.doc.getText("plainText");body.delete(0,8);body.insert(0,String(index).padStart(8,"0"));});
        await provider.applyLocalUpdate(update,{armSettle:false});
        const rows=sourceDb.prepare("SELECT rowid,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms FROM replication_log WHERE rowid>? ORDER BY rowid").all(lastRow);
        expect(rows.length).toBeGreaterThan(0);expect(new Set(rows.map(r=>r.origin_id)).size).toBe(1);
        const ops=rows.map(r=>({originSeq:r.origin_seq,opKind:r.op_kind,payload:JSON.parse(String(r.payload_json)),recordedAtMs:r.recorded_at_ms}));
        expect(ops.every(op=>op.opKind==="ydoc.update")).toBe(true);
        const blobs=[...new Set(ops.map(op=>String(op.payload.updateBlobSha256)))].map(sha=>({sha,bytes:sourceDb.prepare("SELECT bytes FROM binary_blobs WHERE sha256=?").get(sha)!.bytes as Uint8Array}));
        prepared.push({originId:String(rows[0]!.origin_id),text,ops,blobs});lastRow=Number(rows.at(-1)!.rowid);
      }}finally{sourceDb.close();}
      await provider.close();
      client.close();processChild.kill("SIGKILL");await exited;
      const push=async(index:number,previousPush:Promise<unknown>)=>{
        const revision=prepared[index-1]!,started=performance.now();
        try {
        // Fresh owner sockets avoid Node's idle-socket reset after a stalled relay thread.
        for(const blob of revision.blobs){const uploaded=await fetch(`${ready.baseUrl}/sync/w/blobs/${blob.sha}`,{method:"PUT",headers:{authorization:"Bearer user:owner",connection:"close"},body:Buffer.from(blob.bytes)});expect(uploaded.status).toBe(200);await uploaded.arrayBuffer();}
        await previousPush;
        const pushed=await fetch(`${ready.baseUrl}/sync/w/log`,{method:"POST",headers:{authorization:"Bearer user:owner","content-type":"application/json",connection:"close"},body:JSON.stringify({originId:revision.originId,replicationEpoch:"epoch",streamIdentity:"stream",ops:revision.ops})});expect(pushed.status).toBe(200);await pushed.arrayBuffer();previous=revision.text;return performance.now()-started;
        } catch(error) {throw new Error(`Owner replay failed: bytes=${bytes}, pair=${pair}, views=${enabled}, revision=${index}, elapsedMs=${performance.now()-started}`,{cause:error});}
      };
      await command("start");const start=performance.now(),pending:Promise<number>[]=[],dispatched:number[]=[];
      for(let index=1;index<=revisions;index++) {const deadline=start+(index-1)*1000/hz;await delay(Math.max(0,deadline-performance.now()));dispatched.push(performance.now()-start);const pushed=push(index,pending.at(-1)??Promise.resolve());void pushed.catch(()=>{});pending.push(pushed);}
      const samples=await Promise.all(pending);
      const elapsed=performance.now()-start;
      const pushMetrics=await command("sample");
      const final=await command("verify");expect(final.refused).toBe(0);expect(final.failures).toEqual([]);expect(final.text).toBe(previous);
      const metrics=await command("metrics");if(enabled){expect(metrics.collections).toBeGreaterThan(0);if(revisions/hz>32)expect(metrics.flips.length).toBeGreaterThan(0);}
      const offeredHz=(revisions-1)/(dispatched.at(-1)!-dispatched[0]!)*1000;
      const result={bytes,pair,enabled,hz,pushP50:quantile(samples,.5),pushP95:quantile(samples,.95),earlyPushP50:quantile(samples.slice(0,Math.floor(revisions/2)),.5),latePushP50:quantile(samples.slice(Math.floor(revisions/2)),.5),...metrics,drainMetrics:metrics,cpuMs:pushMetrics.cpuMs,cpuPercent:pushMetrics.cpuPercent,eventLoopP99:pushMetrics.eventLoopP99,pushMetrics,relayIntervalMs:pushMetrics.elapsed,elapsed,offeredHz,achievedHz:revisions/elapsed*1000};
      results.push(result);output("pairs",results);output("replay-accepted",{bytes,pair,enabled,initial:true,final:true});
      if(revisions>=20){expect(offeredHz).toBeGreaterThan(hz*.96);expect(offeredHz).toBeLessThan(hz*1.04);}
      if((!enabled || process.env.DOHC_REPLICA_REQUIRE_SUSTAINED==="1") && revisions>=20)expect(revisions/elapsed*1000).toBeGreaterThan(hz*.95);
      if(enabled)expect(pushMetrics.collections).toBeGreaterThan(0);
    }finally{client.close();processChild.kill("SIGKILL");await exited;await command("close");await relayExit;await closeTestStorages();}
  }
},3_600_000);
it.skipIf(process.env.DOHC_REPLICA_MEASURE!=="1")("measures relay parse, stage checks and flip writes",async()=>{
  const results=[];
  for(const size of [50_000,1_000_000]) {
    const storage=await fixture(),lease=createReplicaReadPrincipal(storage).issue("w","perf");storage.bindReplicaCurrentView(lease);
    const samples:Array<{parse:number;stage:number;stageChecks:number;flip:number}>=[];let logical=0;const measured=measurements.get(storage)!,wal=`${measured.path}-wal`,sideWal=`${measured.sidePath}-wal`;
    // Disable checkpointing only in this disposable measurement database.
    const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(measured.path);db.exec("PRAGMA wal_autocheckpoint=0");
    (storage as unknown as {db:{exec(sql:string):void}}).db.exec("PRAGMA wal_autocheckpoint=0");
    let transactionMs=0;
    const context=storage as unknown as StorageContext,transaction=context.replicaViewTx.bind(context);
    context.replicaViewTx=run=>{const started=performance.now();try{return transaction(run);}finally{transactionMs+=performance.now()-started;}};
    measured.confirmations.length=0;
    const walBefore=statSync(wal).size,sideBefore=statSync(sideWal).size;
    try {for(let i=0;i<21;i++) {
      const text=String(i).padStart(8,"0")+"x".repeat(size-8),sha256=hash(text),wire=JSON.stringify({workspaceId:"w",revision:i,logCursor:0,journalCursor:0,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[],
        files:[{versionId:"main",objectId:"a",path:"docs/a.md",contentKind:"text",sha256,byteLength:size,lineageClaimId:hash("measurement-lineage"),restoreGeneration:1}],texts:[{sha256,text}]});
      transactionMs=0;
      const start=performance.now(),view=decodeReplicaCurrentView(JSON.parse(wire)),parsed=performance.now();const staged=storage.stageReplicaCurrentView(lease,{...view,omitted:[]}),checked=performance.now(),stageChecks=checked-parsed-transactionMs;
      storage.flipReplicaCurrentView(lease,staged);const flipped=performance.now();samples.push({parse:parsed-start,stage:checked-parsed,stageChecks,flip:flipped-checked});logical+=size;
    }
    const written=statSync(wal).size-walBefore;const summarize=(field:keyof typeof samples[number])=>({p50:quantile(samples.map(s=>s[field]),.5),p95:quantile(samples.map(s=>s[field]),.95)});
    results.push({size,samples:21,parse:summarize("parse"),stage:summarize("stage"),stageChecks:summarize("stageChecks"),flip:summarize("flip"),logicalPerRevision:logical/21,walGrowthPerRevision:written/21,sideWalGrowthPerRevision:(statSync(sideWal).size-sideBefore)/21,
      stampConfirmationsPerRevision:measured.confirmations.length/21,stampMs:{p50:quantile(measured.confirmations,.5),p95:quantile(measured.confirmations,.95)},
      stampConfirmationsPerHourAt30Seconds:measured.confirmations.length/21*120,stampConfirmationsPerHourAt4Hz:measured.confirmations.length/21*14400,
      stampMsPerHourAt30Seconds:measured.confirmations.reduce((a,b)=>a+b,0)/21*120,stampMsPerHourAt4Hz:measured.confirmations.reduce((a,b)=>a+b,0)/21*14400,
      logicalPerHourAt30Seconds:size*120,logicalPerHourAt4Hz:size*14400,walPerHourAt30Seconds:written/21*120,walPerHourAt4Hz:written/21*14400});
    }finally{db.close();storage.close();deployments.splice(deployments.indexOf(storage),1);await closeTestStorages();}
  }output("relay-phases",results);
},120_000);

it.skipIf(process.env.DOHC_REPLICA_MEASURE!=="1")("measures main-cadence staging and ceiling persistence",async()=>{
  const results=[];
  for(const size of [50_000,1_000_000]) {
    const storage=await fixture(),measured=measurements.get(storage)!,context=storage as unknown as StorageContext;
    context.db.exec("PRAGMA wal_autocheckpoint=0");
    const page=(revision:number)=>{const text=String(revision).padStart(8,"0")+"x".repeat(size-8),sha256=hash(text);return {workspaceId:"w",omitted:[],revision,logCursor:0,journalCursor:0,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[],
      files:[{versionId:"main",objectId:"a",path:"docs/a.md",contentKind:"text" as const,sha256,byteLength:size,lineageClaimId:hash("measurement-lineage"),restoreGeneration:1}],texts:[{sha256,text}]};};
    let latest=page(0);
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});
    const supervisor=createReplicaSupervisor({storage,storeRoot:await tempRoot("cadence-view"),idleMs:120_000,
      startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>latest})});
    try {
      await supervisor.activate("w");measured.confirmations.length=0;
      const wal=`${measured.path}-wal`,sideWal=`${measured.sidePath}-wal`,before=statSync(wal).size,sideBefore=statSync(sideWal).size;
      for(let revision=1;revision<=60;revision++) {latest=page(revision);await supervisor.activate("w");await vi.advanceTimersByTimeAsync(1000);}
      const written=statSync(wal).size-before,sideWritten=statSync(sideWal).size-sideBefore;
      const header=context.db.prepare("SELECT cut_seq FROM sync_relay_replica_cuts").get()!;
      expect(header.cut_seq).toBe(3);
      results.push({size,simulatedSeconds:60,captures:60,persistences:2,confirmations:measured.confirmations.length,
        relayWalPerHour:written*60,sideWalPerHour:sideWritten*60,logicalStagingPerHour:size*(Number(header.cut_seq)-1)*60,
        stampConfirmationsPerHour:measured.confirmations.length*60,stampMsPerHour:measured.confirmations.reduce((a,b)=>a+b,0)*60,
        stampMs:{p50:quantile(measured.confirmations,.5),p95:quantile(measured.confirmations,.95)}});
    } finally {await supervisor.close();vi.useRealTimers();storage.close();deployments.splice(deployments.indexOf(storage),1);await closeTestStorages();}
  }
  output("main-cadence",results);
},120_000);

it.skipIf(process.platform!=="win32"||process.env.DOHC_REPLICA_MEASURE!=="1")("measures configured write bytes with normal checkpoints",async()=>{
  const results=[];
  const writtenBytes=()=>Number(execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",`(Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}').WriteTransferCount`],{encoding:"utf8",windowsHide:true}).trim());
  for(const size of [50_000,1_000_000])for(const mode of ["main","forced-4Hz"]) {
    const storage=await fixture(),context=storage as unknown as StorageContext;
    const checkpoint=context.db.prepare("PRAGMA wal_autocheckpoint").get();
    const view=(revision:number)=>{const text=String(revision).padStart(8,"0")+"x".repeat(size-8),sha256=hash(text);return {workspaceId:"w",omitted:[],revision,logCursor:0,journalCursor:0,
      files:[{versionId:"main",objectId:"a",path:"docs/a.md",contentKind:"text" as const,sha256,byteLength:size,lineageClaimId:hash("measurement-lineage"),restoreGeneration:1}],texts:[{sha256,text}]};};
    let supervisor:ReturnType<typeof createReplicaSupervisor>|undefined;
    try {
      let latest=view(0);
      if(mode==="main") {
        vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});
        supervisor=createReplicaSupervisor({storage,storeRoot:await tempRoot("physical-view"),idleMs:120_000,
          startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
        await supervisor.activate("w");
      }
      const lease=mode==="forced-4Hz"?createReplicaReadPrincipal(storage).issue("w","physical"):undefined;
      if(lease){storage.bindReplicaCurrentView(lease);storage.storeReplicaCurrentView(lease,latest);}
      const before=writtenBytes(),start=performance.now();expect(Number.isSafeInteger(before)).toBe(true);
      const captures=mode==="main"?60:240;
      for(let revision=1;revision<=captures;revision++) {
        latest=view(revision);
        if(supervisor){await supervisor.activate("w");await vi.advanceTimersByTimeAsync(1000);}
        else storage.storeReplicaCurrentView(lease!,latest);
      }
      const after=writtenBytes();expect(after).toBeGreaterThan(before);
      results.push({size,mode,captures,simulatedSeconds:60,actualWallMs:performance.now()-start,walAutocheckpoint:checkpoint,
        processWriteBytes:after-before,processWriteBytesPerHour:(after-before)*60});
    }finally{await supervisor?.close();vi.useRealTimers();storage.close();deployments.splice(deployments.indexOf(storage),1);await closeTestStorages();}
  }
  output("configured-write-bytes",results);
},180_000);

it.skipIf(process.env.DOHC_REPLICA_MEASURE!=="1")("measures twenty-thousand-file relay collection and persistence",async()=>{
  const storage=await fixture(),lease=createReplicaReadPrincipal(storage).issue("w","wide");storage.bindReplicaCurrentView(lease);
  const files=Array.from({length:20_000},(_,i)=>({versionId:"main",objectId:`object-${i}`,path:`docs/${String(i).padStart(6,"0")}.md`,contentKind:"text" as const,sha256:hash(""),byteLength:0,lineageClaimId:null,restoreGeneration:null}));
  const view={workspaceId:"w",omitted:[],revision:1,logCursor:0,journalCursor:0,files,texts:[{sha256:hash(""),text:""}]};
  let latest=view,parseMs=0;
  const wires=()=>[0,10_000].map(offset=>JSON.stringify({workspaceId:latest.workspaceId,revision:latest.revision,logCursor:latest.logCursor,journalCursor:latest.journalCursor,files:latest.files.slice(offset,offset+10_000),texts:offset?[]:latest.texts,delta:false,removed:[],moved:false,refusedFiles:[],nextCursor:offset?null:{path:files[9999]!.path,objectId:files[9999]!.objectId,versionId:"main"}}));
  let pages=wires();const samples:number[]=[],parses:number[]=[],persists:number[]=[];
  const store=storage.storeReplicaCurrentView.bind(storage);storage.storeReplicaCurrentView=(...args)=>{const start=performance.now();try{return store(...args);}finally{persists.push(performance.now()-start);}};
  const supervisor=createReplicaSupervisor({storage,storeRoot:await tempRoot("wide-view"),startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async(_s,_k,_p,cursor)=>{
    const start=performance.now(),page=decodeReplicaCurrentView(JSON.parse(pages[cursor?1:0]!));parseMs+=performance.now()-start;return page;
  }})});
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});
  try {
    await supervisor.activate("w");persists.length=0;
    for(let revision=2;revision<=22;revision++) {
      const text=String(revision),sha256=hash(text);latest={...view,revision,files:[{...files[0]!,sha256,byteLength:text.length},...files.slice(1)],texts:[{sha256:hash(""),text:""},{sha256,text}]};pages=wires();parseMs=0;
      const start=performance.now();await supervisor.activate("w");samples.push(performance.now()-start);parses.push(parseMs);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(2000);expect(persists).toHaveLength(1);
    const summary=(values:number[])=>({p50:quantile(values,.5),p95:quantile(values,.95)});
    output("wide-relay",{files:20_000,pages:2,samples:21,parseAndSchema:summary(parses),collectionMainThread:summary(samples),persistMs:persists[0]});
  }finally{await supervisor.close();vi.useRealTimers();storage.close();deployments.splice(deployments.indexOf(storage),1);await closeTestStorages();}
},180_000);
