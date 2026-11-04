import {spawn,execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {Duplex} from "node:stream";
import {DatabaseSync} from "node:sqlite";
import {writeFileSync} from "node:fs";
import {afterEach,expect,it} from "vitest";
import {EngineClient,DuplexEngineClientConnection,decodeReplicaCurrentView,type ReplicaCurrentViewPage} from "@dohc/workspace-engine-client/daemon";
import {requireEngineBinaryOrSkip} from "../../../apps/desktop/src/testing/engineBinary";
import {tempRoot,closeTestStorages} from "./testing";

const binary=requireEngineBinaryOrSkip();
afterEach(closeTestStorages);
async function open(root:string,passive=true) {
  const child=spawn(binary.require(),passive?["--store-role","passive"]:[],{windowsHide:true,stdio:["pipe","pipe","pipe"],env:{DOHC_ENGINE_AUTH_TOKEN:"view-test",SystemRoot:process.env.SystemRoot}});
  const termination=new Promise<void>(resolve=>child.once("close",()=>resolve()));
  const client=new EngineClient(new DuplexEngineClientConnection(Duplex.from({readable:child.stdout,writable:child.stdin})),{authToken:"view-test",protocolVersion:2,capabilities:["blobs"]},()=>child.kill("SIGKILL"),termination);
  child.on("close",(code,signal)=>client.notifyProcessExit(code,signal));child.stderr.resume();let id=1,workspace:string|undefined;
  const request=async(method:string,params:Record<string,unknown>={})=>(await client.sendRequest({id:id++,method,workspace,deadlineMs:120_000,params:(method==="replica.cut"?{incarnation:"native",...params}:params) as never})).result as any;
  await client.ready();workspace=(await request("workspace.open",{rootDir:root,workspaceId:"w",captureMode:"none",...(passive?{storeMode:"passive"}:{})})).workspace;
  const readText=async(sha256:string)=>{let finish!:(bytes:Uint8Array)=>void;const bytes=new Promise<Uint8Array>(resolve=>{finish=resolve;});const off=client.onBlob(blob=>{if(blob.sha256===sha256)finish(blob.bytes);});try{const result=await request("versionedText.readBlob",{workspaceId:"w",sha256});return Buffer.from(typeof result.bytesBase64==="string"?Buffer.from(result.bytesBase64,"base64"):await bytes).toString();}finally{off();}};
  const close=async()=>{client.close();child.kill("SIGKILL");await termination;};return {request,close,readText,pid:child.pid!};
}
async function seed(count:number,size:number,extra=false) {
  const root=await tempRoot("view-native"),initial=await open(root);await initial.close();
  const db=new DatabaseSync(join(root,".dohc/engine/engine.db"));
  try {db.exec("BEGIN");
    const blob=db.prepare("INSERT OR IGNORE INTO blobs VALUES(?,?,?)"),object=db.prepare("INSERT INTO file_objects VALUES('w',?,0)"),alias=db.prepare("INSERT INTO path_aliases VALUES('w','main',?,?)"),snapshot=db.prepare("INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES('w','main',?,?,?,0,'m','test')");
    const put=(id:string,path:string,text:string)=>{const sha=createHash("sha256").update(text).digest("hex");blob.run(sha,Buffer.byteLength(text),text);object.run(id);alias.run(path,id);snapshot.run(id,path,sha);};
    for(let i=0;i<count;i++)put(`object-${i}`,`docs/${String(i).padStart(6,"0")}.md`,size?String(i).padStart(8,"0")+"x".repeat(size-8):"");
    if(extra) {put("secret",".env","secret");put("outside","other/a.md","outside");put("ignored","node_modules/a.md","ignored");put("huge","docs/huge.md","x".repeat(15_000_000));put("alone","docs/alone.md","x".repeat(9_000_000));}
    db.exec("COMMIT");
  }finally{db.close();}return {root,engine:await open(root)};
}
async function collect(engine:Awaited<ReturnType<typeof open>>,known:string[]=[]){
  let cursor:ReplicaCurrentViewPage["nextCursor"]=null,position:Record<string,number>|null=null;const pages:ReplicaCurrentViewPage[]=[];const start=performance.now();
  do {const page=decodeReplicaCurrentView(await engine.request("replica.cut",{selectors:[{versionId:"main",paths:["docs"]}],knownTextShas:[...new Set(known)].join(""),cursor,position}));expect(page.moved).toBe(false);if(process.env.DOHC_REPLICA_MEASURE!=="1"){expect(Buffer.byteLength(JSON.stringify(page))+256).toBeLessThan(14*1024*1024);if(page.files.length>1)expect(Buffer.byteLength(JSON.stringify(page))+256).toBeLessThan(8*1024*1024);}pages.push(page);known.push(...page.texts.map(t=>t.sha256));position??={revision:page.revision,logCursor:page.logCursor,journalCursor:page.journalCursor};cursor=page.nextCursor;}while(cursor);
  return {pages,wallMs:performance.now()-start};
}
it.skipIf(binary.missing)("round4: a null-version empty selector has no native heads",async()=>{
  const f=await seed(1,32);
  try {const page=await f.engine.request("replica.cut",{selectors:[{versionId:null,paths:[]}]});expect(page.files).toEqual([]);expect(page.texts).toEqual([]);}
  finally{await f.engine.close();}
});
it.skipIf(binary.missing)("round4: an alias never borrows a snapshot from another path",async()=>{
  const f=await seed(1,32);
  try {
    const db=new DatabaseSync(join(f.root,".dohc/engine/engine.db"));db.exec("UPDATE snapshots SET path='docs/other.md'");db.close();
    expect((await collect(f.engine)).pages.flatMap(p=>p.files)).toEqual([]);
  } finally{await f.engine.close();}
});
it.skipIf(binary.missing)("round4: pages follow the version and path primary key",async()=>{
  const f=await seed(1,32);
  try {
    const db=new DatabaseSync(join(f.root,".dohc/engine/engine.db"));
    db.exec("INSERT INTO versions VALUES('w','z','draft','Z',0,NULL,NULL); INSERT INTO path_aliases VALUES('w','z','a.md','object-0'); INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) SELECT workspace_id,'z',object_id,'a.md',blob_sha256,0,'m','test' FROM snapshots WHERE version_id='main'");db.close();
    const page=await f.engine.request("replica.cut",{selectors:[{versionId:"main",paths:[]},{versionId:"z",paths:[]}]});
    expect(page.files.map((f:any)=>f.versionId)).toEqual(["main","z"]);
  } finally {await f.engine.close();}
});
it.skipIf(binary.missing)("round4: an oversized omission retains its content digest",async()=>{
  const f=await seed(0,0,true);
  try {const omitted=(await collect(f.engine)).pages.flatMap(p=>p.refusedFiles).find(f=>f.objectId==="huge") as any;
    expect(omitted.sha256).toBe(createHash("sha256").update("x".repeat(15_000_000)).digest("hex"));
  } finally{await f.engine.close();}
},180_000);
it.skipIf(binary.missing)("pages fifteen distinct megabyte texts, matches reads, and omits private and frame-sized heads",async()=>{
  const f=await seed(15,1_000_000,true);
  try {const result=await collect(f.engine),files=result.pages.flatMap(p=>p.files),texts=new Map(result.pages.flatMap(p=>p.texts).map(t=>[t.sha256,t.text]));
    expect(files).toHaveLength(16);expect(result.pages.flatMap(p=>p.refusedFiles)).toEqual([{versionId:"main",objectId:"huge",path:"docs/huge.md",sha256:createHash("sha256").update("x".repeat(15_000_000)).digest("hex"),reason:"text-frame-limit"}]);
    for(const file of files){const read=await f.engine.request("versionedText.read",{versionId:file.versionId,path:file.path});for(const key of ["versionId","objectId","path","sha256","byteLength","contentKind"] as const)expect(file[key]).toEqual(read[key]);expect(texts.get(file.sha256)).toBe(read.text??await f.engine.readText(file.sha256));}
    const repeat=await collect(f.engine,[...texts.keys()]);expect(repeat.pages.flatMap(p=>p.texts)).toEqual([]);
  }finally{await f.engine.close();}
},180_000);
it.skipIf(binary.missing)("refuses a continuation when the applied position moved",async()=>{
  const f=await seed(15,1_000_000);
  try {const first=decodeReplicaCurrentView(await f.engine.request("replica.cut",{selectors:[{versionId:"main",paths:[]}]}));expect(first.nextCursor).not.toBeNull();
    const db=new DatabaseSync(join(f.root,".dohc/engine/engine.db"));db.exec("INSERT INTO replica_frontiers VALUES('w',1,1,0)");db.close();
    const moved=decodeReplicaCurrentView(await f.engine.request("replica.cut",{selectors:[{versionId:"main",paths:[]}],cursor:first.nextCursor,position:{revision:first.revision,logCursor:first.logCursor,journalCursor:first.journalCursor}}));expect(moved.moved).toBe(true);expect(moved.files).toEqual([]);expect(moved.texts).toEqual([]);
  }finally{await f.engine.close();}
},180_000);
it.skipIf(binary.missing)("an owner refuses collection",async()=>{const engine=await open(await tempRoot("view-owner"),false);try{await expect(engine.request("replica.cut",{selectors:[]})).rejects.toMatchObject({wireError:{code:"FORBIDDEN"}});}finally{await engine.close();}});
it.skipIf(binary.missing||process.env.DOHC_REPLICA_MEASURE!=="1")("measures first and text-free follow-up paging",async()=>{
  const measurements=[];
  for(const [count,size] of [[15,1_000_000],[100,1_000_000],[20_000,0]]) {const f=await seed(count!,size!);try{const first=await collect(f.engine);expect(first.pages.flatMap(p=>p.files)).toHaveLength(count!);const known=first.pages.flatMap(p=>p.texts).map(t=>t.sha256),repeat=await collect(f.engine,known);expect(repeat.pages.flatMap(p=>p.texts)).toEqual([]);const result={count,size,firstPages:first.pages.length,firstMs:first.wallMs,followupPages:repeat.pages.length,followupMs:repeat.wallMs};measurements.push(result);console.log("PAGING",JSON.stringify(result));
    if(count===20_000 && process.platform==="win32") {
      const cpu=()=>Number(execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",`(Get-Process -Id ${f.engine.pid}).CPU`],{encoding:"utf8",windowsHide:true}).trim())*1000;
      const samples=[];
      for(let i=0;i<21;i++){const before=cpu(),measured=await collect(f.engine,known),after=cpu();expect(measured.pages.flatMap(p=>p.texts)).toEqual([]);samples.push({wallMs:measured.wallMs,replicaCpuMs:after-before});}
      console.log("MANIFEST",JSON.stringify(samples));if(process.env.DOHC_REPLICA_MEASURE_OUT)writeFileSync(`${process.env.DOHC_REPLICA_MEASURE_OUT}.manifest.json`,JSON.stringify(samples));
    }
    if(process.env.DOHC_REPLICA_MEASURE_OUT)writeFileSync(`${process.env.DOHC_REPLICA_MEASURE_OUT}.paging.json`,JSON.stringify(measurements));}finally{await f.engine.close();}}
},600_000);
