import { createHash } from "node:crypto";
import { privateFolder } from "./private-folder.test-helper";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDatasetJournal, type DatasetJournal } from "./journal.ts";
import { createDatasetSupervisor, type DatasetInvocation, type DatasetMigration, type DatasetSupervisorOptions } from "./supervisor.ts";
import { DEFAULT_LIMITS, type AppRuntimeLauncher } from "./protocol.ts";

// These waits cover one worker command at the product deadline plus durable journal writes around it.
const workerWait = { timeout: 2 * DEFAULT_LIMITS.deadlineMs };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const schemaSql = "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);";
let emptyCheckpoint: Buffer | undefined;
const source = `globalThis.operations = { run(ctx,input) {
  if(input.refuse) ctx.refuse('full','No spaces remain.');
  if(input.id) ctx.db.execute('INSERT INTO items VALUES(?,?)',[input.id,input.value]);
  if(input.file) ctx.files.attach(input.file);
  return ctx.db.query('SELECT * FROM items ORDER BY id');
}}`;

async function fixture(options: { transform?: (journal: DatasetJournal) => DatasetJournal; launch?: AppRuntimeLauncher; maxWorkers?: number; schemaSql?:string; source?:string; tables?:string[];maintenanceStorage?:DatasetSupervisorOptions["maintenanceStorage"];nowMs?:()=>number; materializationEvents?:number; idleMs?:number; queueMs?:number; onMaintenanceError?:DatasetSupervisorOptions["onMaintenanceError"]; workerRoot?:string } = {}) {
  const approvedSchema=options.schemaSql ?? schemaSql, approvedSource=options.source ?? source;
  const directory = await mkdtemp(join(tmpdir(), "dohc-supervisor-"));
  let seedCheckpoint = approvedSchema === schemaSql ? emptyCheckpoint : undefined;
  if (!seedCheckpoint) {
    const seed = new DatabaseSync(join(directory, "seed.sqlite"));
    try { seed.exec(approvedSchema); } finally { seed.close(); }
    seedCheckpoint = await readFile(join(directory, "seed.sqlite"));
    if (approvedSchema === schemaSql) emptyCheckpoint = seedCheckpoint;
  }
  const checkpoint = seedCheckpoint;
  const db = new DatabaseSync(join(directory, "authority.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE grants(allowed INTEGER); INSERT INTO grants VALUES(1); CREATE TABLE files(attached INTEGER); INSERT INTO files VALUES(0); COMMIT;");
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const journal = createDatasetJournal({ db, transaction });
  const scope = { workspaceId: "workspace", datasetId: "dataset" };
  const authorize = () => { if (db.prepare("SELECT allowed FROM grants").get()!.allowed !== 1) throw Error("denied"); };
  function initialize(datasetId = scope.datasetId) {
    journal.initialize({ scope: { ...scope, datasetId }, hostEpoch: "host", approvedRevisionHash: hash("approved"), source:approvedSource,
      schemaSql:approvedSchema, definitionJson: "{}", checkpoint, authorize });
  }
  initialize();
  const supervisor = await createDatasetSupervisor({ journal: options.transform?.(journal) ?? journal,
    directory: privateFolder(options.workerRoot ?? join(directory, "workers")), runtime: { launch: options.launch }, maxWorkers: options.maxWorkers,maintenanceStorage:options.maintenanceStorage,nowMs:options.nowMs,materializationEvents:options.materializationEvents,idleMs:options.idleMs,queueMs:options.queueMs,onMaintenanceError:options.onMaintenanceError });
  cleanups.push(async () => { await supervisor.close(); db.close(); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); });
  function invoke(input: DatasetInvocation["input"] = {}, overrides: Partial<DatasetInvocation> = {}) {
    return supervisor.invoke({ scope, tables: options.tables ?? ["items"], operation: "run", caller: { kind: "owner" }, callerKey: "owner", input,
      idempotencyKey: "retry", payloadSha256: hash(JSON.stringify(input)), readOnly: false, authorize, ...overrides });
  }
  return { db, journal, supervisor, invoke, scope, authorize, initialize,directory };
}

function migration(f:Awaited<ReturnType<typeof fixture>>,overrides:Partial<DatasetMigration>={}):DatasetMigration {
  return {scope:f.scope,tables:["items"],newTables:["items"],expected:f.journal.head(f.scope,f.authorize).cursor,authorize:f.authorize,
    approvedRevisionHash:hash("approved-migrated"),definitionJson:'{"version":2}',
    schemaSql:"CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');",
    source:source.replace("INSERT INTO items VALUES(?,?)","INSERT INTO items(id,value) VALUES(?,?)"),
    migrationSql:"ALTER TABLE items ADD COLUMN note TEXT NOT NULL DEFAULT ''; UPDATE items SET note='migrated';",...overrides};
}

it("rejects changed owner and stale data and replaces a discarded candidate without leaks",async()=>{
  let balance=0;
  const f=await fixture({maintenanceStorage:{authorize(){},account({bytes}){balance+=bytes;}}});
  await f.invoke({id:"one",value:"original"});
  const candidate=await f.supervisor.prepareMigration({...migration(f),authorityKey:"owner-v1"});
  const access={scope:f.scope,tables:["items"],candidateId:candidate.candidateId,authorityKey:"owner-v1",authorize:f.authorize};
  expect(()=>f.supervisor.migrationPreviewPage({...access,authorityKey:"other"})).toThrow("no longer available");
  await f.invoke({id:"two",value:"changed"},{idempotencyKey:"second"});
  await expect(f.supervisor.approveMigration({...access,checkpointSha256:candidate.checkpointSha256})).rejects.toThrow("The Collection changed");
  const replacement=await f.supervisor.prepareMigration({...migration(f),authorityKey:"owner-v1"});
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toHaveLength(2);
  await f.supervisor.discardMigration({...access,candidateId:replacement.candidateId});expect(balance).toBe(0);
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toEqual([]);
});

function launcher(hook: (command: any, controls: { stop(): void; deliver(): void }) => void, observe?: (message: unknown) => void, pids?: number[], closedPids?: number[]): AppRuntimeLauncher {
  return options => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", options.entryPath], {
      cwd: options.cwd, env: options.env, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", windowsHide: true,
    });
    pids?.push(child.pid!);
    child.on("close",()=>closedPids?.push(child.pid!));
    child.on("error", options.onError); child.on("close", options.onExit); child.on("message", message => { observe?.(message); options.onMessage(message); });
    return { postMessage(message) { hook(message, { stop: () => child.kill("SIGKILL"), deliver: () => child.send(message as object) }); }, kill() { child.kill("SIGKILL"); } };
  };
}

it("retires active and queued operations after permanent deletion without reviving their worker", async () => {
  let entered!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({launch:launcher((command,controls) => {
    if (command.command.kind === "prepare") { entered(); return; }
    controls.deliver();
  })});
  const first = f.invoke({id:"first",value:"private"});
  const firstCheck = expect(first).rejects.toThrow();
  await running;
  const queued = f.invoke({id:"queued",value:"private"},{idempotencyKey:"queued"});
  const queuedCheck = expect(queued).rejects.toThrow("deleted");
  f.journal.destroy({expected:f.journal.head(f.scope,f.authorize).cursor,authorize:f.authorize});
  await f.supervisor.retire(f.scope);
  await Promise.all([firstCheck,queuedCheck]);
  await expect(f.invoke({id:"retry",value:"private"})).rejects.toThrow("deleted");
  expect(f.db.prepare("SELECT count(*) n FROM dohc_dataset_events").get()!.n).toBe(0);
});

it("serializes concurrent writes and reuses a worker without copying the database", async () => {
  let launches = 0;
  const f = await fixture({ launch: launcher((command, controls) => { if (command.command.kind === "open") launches++; controls.deliver(); }) });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.invoke({ id: String(i), value: "saved" }, { idempotencyKey: String(i) })));
  expect(results.map(result => result.revision)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  expect(launches).toBe(1);
  expect((await f.invoke({}, { readOnly: true })).result).toHaveLength(12);
});

it("rejects corrupted checkpoint ranges before starting a worker",async()=>{
  let launches=0;
  const f=await fixture({launch:launcher((_command,controls)=>{launches++;controls.deliver();}),
    transform:journal=>({...journal,exportBlob(input){const bytes=journal.exportBlob(input);bytes[bytes.length-1]^=1;return bytes;}}),
  });
  await expect(f.invoke({}, {readOnly:true})).rejects.toMatchObject({code:"reopen_failed",retryAfterMs:5_000,cause:{message:"This Collection's saved records are damaged."}});
  expect(launches).toBe(0);
  // A checkpoint that fails its check earns a wait like a worker that fails.
  await expect(f.invoke({}, {readOnly:true})).rejects.toMatchObject({code:"dataset_reopen_wait"});
});

it("starts no wait when a replay fails because the caller lost access",async()=>{
  const f=await fixture();
  await f.invoke({id:"one",value:"saved"});
  await f.supervisor.close();
  let revoke=true;
  const launch=launcher((command,controls)=>{
    if(command.command.kind==="applyBatch"&&revoke){revoke=false;f.db.prepare("UPDATE grants SET allowed=0").run();}
    controls.deliver();
  });
  const supervisor=await createDatasetSupervisor({journal:f.journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch}});
  cleanups.push(()=>supervisor.close());
  const read={scope:f.scope,tables:["items"],operation:"run",caller:{kind:"owner"},callerKey:"owner",input:{},idempotencyKey:"read",payloadSha256:hash("{}"),readOnly:true,authorize:f.authorize};
  await expect(supervisor.invoke(read)).rejects.toThrow("denied");
  f.db.prepare("UPDATE grants SET allowed=1").run();
  expect((await supervisor.invoke(read)).result).toEqual([{id:"one",value:"saved"}]);
});

it.each([153])("migrates records in a long workspace folder (%i characters)",async length=>{
  const parent=await mkdtemp(join(tmpdir(),"dohc-migration-"));
  cleanups.push(()=>rm(parent,{recursive:true,force:true}));
  const workspaceRoot=join(parent,"w".repeat(length-parent.length-1));
  expect(workspaceRoot).toHaveLength(length);
  const f=await fixture({workerRoot:join(workspaceRoot,".dohc","local","datasets","workers")});
  await f.invoke({id:"before",value:"saved"});
  const migrated=await f.supervisor.migrate(migration(f));
  expect(migrated.revision).toBe(2);
  expect((await f.invoke({}, {readOnly:true})).result).toEqual([{id:"before",value:"saved",note:"migrated"}]);
  expect((await f.invoke({id:"after",value:"new"},{idempotencyKey:"after"})).revision).toBe(3);
});

it("recovers committed data after the worker dies before finalization", async () => {
  let killed = false;
  const f = await fixture({ launch: launcher((command, controls) => {
    if (command.command.kind === "finalize" && !killed) { killed = true; controls.stop(); } else controls.deliver();
  }) });
  await expect(f.invoke({ id: "once", value: "saved" })).rejects.toThrow("stopped");
  expect(await f.invoke({ id: "once", value: "saved" })).toMatchObject({ replayed: true, revision: 1 });
  expect((await f.invoke({}, { readOnly: true })).result).toEqual([{ id: "once", value: "saved" }]);
});

it("does not commit a prepared write after revocation", async () => {
  let revoke = () => {};
  const f = await fixture({ launch: launcher((command, controls) => {
    if (command.command.kind === "prepare") revoke();
    controls.deliver();
  }) });
  revoke = () => f.db.exec("UPDATE grants SET allowed=0");
  await expect(f.invoke({ id: "blocked", value: "private" })).rejects.toThrow("denied");
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_events").get()!.n).toBe(0);
});

it("withholds committed results and receipts when authority is revoked before disclosure", async () => {
  let revoke = () => {};
  const f = await fixture({ launch: launcher((command, controls) => {
    if (command.command.kind === "finalize") revoke();
    controls.deliver();
  }) });
  revoke = () => f.db.exec("UPDATE grants SET allowed=0");
  await expect(f.invoke({ id: "saved", value: "private" })).rejects.toThrow("denied");
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_events").get()!.n).toBe(1);
  await expect(f.invoke({ id: "saved", value: "private" })).rejects.toThrow("denied");
});

it("rolls back file associations and data together when accounting refuses", async () => {
  const f = await fixture();
  const fileId = "receipt_file_0001";
  await expect(f.invoke({ id: "blocked", value: "private", file: fileId }, {
    files: [{ fileId, name: "receipt.png", contentType: "image/png", byteLength: 10, sha256: hash("file") }],
    accountAndAttach(allocation) { expect(allocation.attachedFileIds).toEqual([fileId]); f.db.exec("UPDATE files SET attached=1"); throw Error("quota full"); },
  })).rejects.toThrow("quota full");
  expect(f.db.prepare("SELECT attached FROM files").get()!.attached).toBe(0);
  expect((await f.invoke({}, { readOnly: true })).result).toEqual([]);
});

it("keeps independent datasets isolated while evicting idle workers", async () => {
  const f = await fixture({ maxWorkers: 1 }); f.initialize("other");
  await f.invoke({ id: "first", value: "private" });
  expect((await f.invoke({}, { scope: { ...f.scope, datasetId: "other" }, readOnly: true })).result).toEqual([]);
  expect((await f.invoke({}, { readOnly: true })).result).toEqual([{ id: "first", value: "private" }]);
});

it("stops a worker that is still starting on close",async()=>{
  let launched!:()=>void,ended!:(signal:NodeJS.Signals|null)=>void;
  const starting=new Promise<void>(resolve=>{launched=resolve;}),exit=new Promise<NodeJS.Signals|null>(resolve=>{ended=resolve;});
  // A stand-in worker that never sends ready.
  const f=await fixture({launch:options=>{
    const child=spawn(process.execPath,["-e","setInterval(()=>{},60_000)"],{cwd:options.cwd,env:options.env,stdio:["ignore","ignore","ignore","ipc"],windowsHide:true});
    child.on("error",options.onError);child.on("close",(code,signal)=>{ended(signal);options.onExit(code);});
    child.on("spawn",launched);
    return {postMessage(message){child.send(message as object);},kill(){child.kill("SIGKILL");}};
  }});
  const controller=new AbortController();
  // Frozen timers keep the 30 s startup limit from ending the open, so only the cancellation can.
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
  try {
    const invocation=f.invoke({},{signal:controller.signal});
    await starting;
    void f.supervisor.close();
    await expect(invocation).rejects.toThrow("dohc closed this workspace's Collections");
    expect(await exit).toBe("SIGKILL");
  } finally { vi.useRealTimers(); }
});

it("recovers from a materialization cache and replays only its tail while retaining old retries",async()=>{
  const opened:number[]=[],replayed:number[]=[];
  let balance=0;
  const launch=launcher((command,controls)=>{
    if(command.command.kind==="open")opened.push(command.command.input.cursor.revision);
    if(command.command.kind==="applyBatch")replayed.push(...command.command.input.map((event:{revision:number})=>event.revision));
    controls.deliver();
  });
  const storage={authorize(){},account({bytes}:{bytes:number}){balance+=bytes;}};
  const f=await fixture({launch,maintenanceStorage:storage,materializationEvents:2});
  for(let n=1;n<=3;n++)await f.invoke({id:String(n),value:"saved"},{idempotencyKey:String(n)});
  await f.invoke({}, {readOnly:true});
  await vi.waitFor(()=>expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toHaveLength(0),workerWait);
  const cached=f.journal.materialization({scope:f.scope,authorize:f.authorize})!;
  expect(cached.cursor.revision).toBe(2);
  expect(f.journal.head(f.scope,f.authorize).cursor.revision).toBe(3);
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_events").get()!.n).toBe(3);
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toHaveLength(0);
  expect(balance).toBe(f.db.prepare("SELECT storage_bytes FROM dohc_dataset_materializations").get()!.storage_bytes);
  await f.supervisor.close();
  const reopened=await createDatasetSupervisor({journal:f.journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},maintenanceStorage:storage,materializationEvents:2});
  cleanups.push(()=>reopened.close());
  const input={scope:f.scope,tables:["items"],operation:"run",caller:{kind:"owner"},callerKey:"owner",input:{},idempotencyKey:"read",payloadSha256:hash("{}"),readOnly:true,authorize:f.authorize};
  expect((await reopened.invoke(input)).result).toHaveLength(3);
  expect(opened).toEqual([0,2]);expect(replayed).toEqual([3]);
  const original={id:"1",value:"saved"};
  expect(await reopened.invoke({...input,input:original,idempotencyKey:"1",payloadSha256:hash(JSON.stringify(original)),readOnly:false})).toMatchObject({revision:1,replayed:true});
});

// A dataset with one committed event, reopened by a supervisor whose worker
// runs out of CPU in the chosen command.
async function failingReopens(options:Partial<DatasetSupervisorOptions>) {
  const state={now:1_000_000,failing:"applyBatch" as string|undefined,marker:true,replayed:[] as number[]};
  let directory="";
  const launch=launcher((command,controls)=>{
    if(command.command.kind==="open")directory=command.command.input.directory;
    if(command.command.kind==="applyBatch")state.replayed.push(...command.command.input.map((event:{revision:number})=>event.revision));
    // The worker's CPU budget watch leaves this marker, then ends the worker.
    if(command.command.kind===state.failing){
      if(state.marker)void writeFile(join(directory,"cpu-budget-exceeded-app-5000"),"").then(controls.stop);else controls.stop();
      return;
    }
    controls.deliver();
  });
  const f=await fixture();
  await f.invoke({id:"one",value:"saved"});
  await f.supervisor.close();
  const supervisor=await createDatasetSupervisor({journal:f.journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},nowMs:()=>state.now,...options});
  cleanups.push(()=>supervisor.close());
  const read=()=>supervisor.invoke({scope:f.scope,tables:["items"],operation:"run",caller:{kind:"owner"},callerKey:"owner",input:{},idempotencyKey:"read",payloadSha256:hash("{}"),readOnly:true,authorize:f.authorize});
  return {state,read};
}

it("waits longer before each reopen of a dataset whose replay ran out of CPU",async()=>{
  const {state,read}=await failingReopens({reopenWaitCapMs:20_000});
  await expect(read()).rejects.toMatchObject({code:"worker_budget",retryAfterMs:5_000});
  await expect(read()).rejects.toMatchObject({code:"dataset_reopen_wait",retryAfterMs:5_000,
    message:"This Collection is waiting to reopen. Try again in 5 seconds."});
  expect(state.replayed).toEqual([1]);
  // Each failure right after a wait ends doubles the wait, up to its cap.
  for(const [elapsed,wait] of [[5_000,10_000],[10_000,20_000],[20_000,20_000]]) {
    state.now+=elapsed;
    await expect(read()).rejects.toMatchObject({code:"worker_budget"});
    await expect(read()).rejects.toMatchObject({retryAfterMs:wait});
  }
  expect(state.replayed).toEqual([1,1,1,1]);
  // The count starts over once the longest wait has passed since the last wait ended.
  state.now+=40_000;
  await expect(read()).rejects.toMatchObject({code:"worker_budget"});
  await expect(read()).rejects.toMatchObject({retryAfterMs:5_000});
  state.now+=5_000;state.failing=undefined;
  expect((await read()).result).toEqual([{id:"one",value:"saved"}]);
  // An operation that runs out of CPU leaves a cheap reopen, so the next request does not wait.
  state.failing="prepare";
  await expect(read()).rejects.toMatchObject({code:"worker_budget"});
  state.failing=undefined;
  expect((await read()).result).toEqual([{id:"one",value:"saved"}]);
});

it("serves committed reads and writes while a captured cache is being sealed",async()=>{
  let entered!:()=>void,release!:()=>void,installed!:()=>void;
  const sealing=new Promise<void>(resolve=>entered=resolve),resume=new Promise<void>(resolve=>release=resolve),cached=new Promise<void>(resolve=>installed=resolve);
  const f=await fixture({materializationEvents:1,maintenanceStorage:{authorize(){},account(){}},transform:journal=>({...journal,
    async sealMaterializationCheckpoint(input){entered();await resume;return journal.sealMaterializationCheckpoint(input);},
    cacheMaterialization(input){const result=journal.cacheMaterialization(input);installed();return result;},
  })});
  await f.invoke({id:"one",value:"saved"});await sealing;
  let result:unknown;
  const foreground=(async()=>{await f.invoke({id:"two",value:"new"},{idempotencyKey:"second"});result=(await f.invoke({}, {readOnly:true})).result;})();
  try{await vi.waitFor(()=>expect(result).toEqual([{id:"one",value:"saved"},{id:"two",value:"new"}]),workerWait);}
  finally{release();await foreground;}
  await cached;
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})?.cursor.revision).toBe(1);
  expect(f.journal.head(f.scope,f.authorize).cursor.revision).toBe(2);
  expect((await f.invoke({id:"one",value:"saved"})).replayed).toBe(true);
});

it.each(["close"] as const)("drains captured maintenance on %s and refunds its independent files",async(kind)=>{
  let entered!:()=>void,release!:()=>void,reserved=0;
  const sealing=new Promise<void>(resolve=>entered=resolve),resume=new Promise<void>(resolve=>release=resolve);
  const f=await fixture({materializationEvents:1,maintenanceStorage:{authorize(){},account({bytes}){reserved+=bytes;}},transform:journal=>({...journal,
    async sealMaterializationCheckpoint(input){entered();await resume;return journal.sealMaterializationCheckpoint(input);},
  })});
  await f.invoke({id:"one",value:"saved"});await sealing;
  expect(reserved).toBeGreaterThan(0);
  expect((await readdir(join(f.directory,"workers"))).filter(name=>name.startsWith("worker-"))).toHaveLength(2);
  let completed=false;
  const ending=(kind==="close"?f.supervisor.close():f.supervisor.retire(f.scope)).then(()=>{completed=true;});
  try{await new Promise<void>(resolve=>setImmediate(resolve));expect(completed).toBe(false);}
  finally{release();await ending;}
  expect(reserved).toBe(0);
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toHaveLength(0);
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toBeNull();
  expect((await readdir(join(f.directory,"workers"))).filter(name=>name.startsWith("worker-"))).toHaveLength(0);
  expect(f.journal.head(f.scope,f.authorize).cursor.revision).toBe(1);
});

it("keeps committed writes successful when materialization quota is exhausted",async()=>{
  const failures:unknown[]=[];
  const f=await fixture({materializationEvents:1,maintenanceStorage:{authorize(){},account(){throw Error("quota full");}},onMaintenanceError:(_scope,error)=>failures.push(error)});
  expect((await f.invoke({id:"one",value:"saved"})).revision).toBe(1);
  expect((await f.invoke({}, {readOnly:true})).result).toHaveLength(1);
  expect(failures).toHaveLength(1);
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toBeNull();
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toHaveLength(0);
});

it.each(["full hash", "schema"])("falls back to authoritative history for a cache with damaged %s",async(damage)=>{
  const f=await fixture({materializationEvents:1,maintenanceStorage:{authorize(){},account(){}}});
  await f.invoke({id:"one",value:"saved"});
  await f.invoke({}, {readOnly:true});
  await vi.waitFor(()=>expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).not.toBeNull(),workerWait);
  const cache=f.journal.materialization({scope:f.scope,authorize:f.authorize})!;
  await f.supervisor.close();
  const bytes=f.journal.materializationBlob({scope:f.scope,cache,offset:0,authorize:f.authorize})!;
  if(damage==="full hash") {
    const corrupted=Uint8Array.from(bytes);corrupted[corrupted.length-1]^=1;
    f.db.prepare("UPDATE dohc_dataset_checkpoint_chunks SET bytes=? WHERE stage_id=?").run(corrupted,cache.checkpointId);
    f.db.prepare("UPDATE dohc_dataset_checkpoint_chunks SET sha256=? WHERE stage_id=?").run(createHash("sha256").update(corrupted).digest("hex"),cache.checkpointId);
  } else {
    const path=join(f.directory,"damaged.sqlite");await writeFile(path,bytes);
    const db=new DatabaseSync(path);
    if(damage==="missing marker")db.exec("DROP TABLE dohc_applied");
    else if(damage==="wrong marker")db.exec("UPDATE dohc_applied SET revision=99");
    else db.exec("ALTER TABLE items ADD COLUMN unexpected TEXT");
    db.close();
    const damaged=await readFile(path),sha256=createHash("sha256").update(damaged).digest("hex");
    let stage=f.journal.stageCheckpoint({scope:f.scope,expectedBytes:damaged.length,sha256,authorize:f.authorize});
    f.journal.appendCheckpointChunk({stage,index:0,bytes:damaged,authorize:f.authorize});
    stage=f.journal.sealCheckpoint({stage,authorize:f.authorize});
    f.journal.cacheMaterialization({expected:cache.cursor,checkpoint:stage,authorize:f.authorize,account(){}});
  }
  const replayed:number[]=[],errors:unknown[]=[];
  const reopened=await createDatasetSupervisor({journal:f.journal,directory: privateFolder(join(f.directory, "workers")),onMaintenanceError:(_scope,error)=>errors.push(error),runtime:{launch:launcher((command,controls)=>{
    if(command.command.kind==="applyBatch")replayed.push(...command.command.input.map((event:{revision:number})=>event.revision));controls.deliver();
  })}});
  cleanups.push(()=>reopened.close());
  const result=await reopened.invoke({scope:f.scope,tables:["items"],operation:"run",caller:{kind:"owner"},callerKey:"owner",input:{},idempotencyKey:"read",payloadSha256:hash("{}"),readOnly:true,authorize:f.authorize});
  expect(result.result).toEqual([{id:"one",value:"saved"}]);expect(replayed).toEqual([1]);expect(errors).toHaveLength(1);
});

it("refuses cache installation after authority transfers during the snapshot",async()=>{
  let release:(()=>void)|undefined;
  const errors:unknown[]=[];
  const f=await fixture({materializationEvents:1,maintenanceStorage:{authorize(){},account(){}},onMaintenanceError:(_scope,error)=>errors.push(error),launch:launcher((command,controls)=>{
    if(command.command.kind==="snapshot"){release=controls.deliver;return;}controls.deliver();
  })});
  const result=await f.invoke({id:"one",value:"saved"});expect(result.revision).toBe(1);
  await vi.waitFor(()=>expect(release).toBeTypeOf("function"),workerWait);
  f.journal.fence({expected:f.journal.head(f.scope,f.authorize).cursor,authorize:f.authorize});
  const after=f.invoke({}, {readOnly:true});const check=expect(after).rejects.toThrow("stopped accepting changes to this Collection");
  release!();await check;
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_materializations").get()!.n).toBe(0);
  await vi.waitFor(()=>expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toHaveLength(0),workerWait);
  expect(errors.length).toBeGreaterThan(0);
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_events").get()!.n).toBe(1);
});

it("waits for idle worker retirement instead of reporting false pool saturation",async()=>{
  let entered!:()=>void,release:(()=>void)|undefined;
  const retiring=new Promise<void>(resolve=>entered=resolve);
  const f=await fixture({maxWorkers:1,idleMs:1,launch:launcher((command,controls)=>{
    if(command.command.kind==="close"&&!release){release=controls.deliver;entered();return;}controls.deliver();
  })});
  f.initialize("second");await f.invoke({}, {readOnly:true});await retiring;
  let outcome:unknown;
  const next=f.invoke({}, {scope:{...f.scope,datasetId:"second"},readOnly:true}).then(value=>{outcome=value;return value;},error=>{outcome=error;return error;});
  try {await new Promise<void>(resolve=>setImmediate(resolve));expect(outcome).toBeUndefined();}
  finally {release!();}
  expect(await next).toMatchObject({result:[]});
});

async function heldIdleRetirement() {
  let entered!:()=>void,release:(()=>void)|undefined;
  const retiring=new Promise<void>(resolve=>entered=resolve);
  const f=await fixture({maxWorkers:1,idleMs:1,launch:launcher((command,controls)=>{
    if(command.command.kind==="close"&&!release){release=controls.deliver;entered();return;}controls.deliver();
  })});
  await f.invoke({}, {readOnly:true});await retiring;
  return {...f,release(){release!();}};
}

it.each(["revoke"])("rechecks %s while waiting for a retiring worker",async(kind)=>{
  const f=await heldIdleRetirement();f.initialize("second");
  const scope={...f.scope,datasetId:"second"},controller=new AbortController();
  let outcome:unknown;
  const pending=f.invoke({}, {scope,readOnly:true,signal:controller.signal}).then(value=>{outcome=value;return value;},error=>{outcome=error;return error;});
  await new Promise<void>(resolve=>setImmediate(resolve));expect(outcome).toBeUndefined();
  let finished:Promise<void>|undefined;
  if(kind==="abort")controller.abort(new Error("cancelled"));
  if(kind==="revoke")f.db.exec("UPDATE grants SET allowed=0");
  if(kind==="delete"){
    f.journal.destroy({expected:f.journal.head(scope,f.authorize).cursor,authorize:f.authorize});
    finished=f.supervisor.retire(scope);
  }
  if(kind==="close")finished=f.supervisor.close();
  if(kind==="revoke")f.release();
  try {expect(await pending).toBeInstanceOf(Error);}
  finally {if(kind!=="revoke")f.release();await finished;}
});

it("keeps genuine active-user saturation as an immediate overload",async()=>{
  let entered!:()=>void,release:(()=>void)|undefined;
  const preparing=new Promise<void>(resolve=>entered=resolve);
  const f=await fixture({maxWorkers:1,launch:launcher((command,controls)=>{
    if(command.command.kind==="prepare"&&!release){release=controls.deliver;entered();return;}controls.deliver();
  })});
  f.initialize("second");const active=f.invoke({}, {readOnly:true});await preparing;
  try {await expect(f.invoke({}, {scope:{...f.scope,datasetId:"second"},readOnly:true})).rejects.toThrow("busy with other Collections");}
  finally {release!();await active;}
});

it("backs off when a final replay cache failure stops its worker before capture",async()=>{
  const f=await fixture();
  await f.invoke({id:'one',value:'saved'});
  await f.supervisor.close();
  let broken=true,clock=0;
  const applied:number[]=[],pids:number[]=[],closedPids:number[]=[];
  cleanups.push(async()=>{expect(closedPids.sort()).toEqual(pids.sort());});
  const launch=launcher((request,controls)=>{
    if(request.command.kind==='applyBatch')applied.push(...request.command.input.map((event:{revision:number})=>event.revision));
    if(request.command.kind==='snapshot'&&broken){controls.stop();return;}
    controls.deliver();
  },undefined,pids,closedPids);
  const onMaintenanceError=vi.fn();
  const supervisor=await createDatasetSupervisor({journal:f.journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},
    replayCacheMs:0,nowMs:()=>clock,maintenanceStorage:{authorize(){},account(){}},onMaintenanceError});
  cleanups.push(()=>supervisor.close());
  const read={scope:f.scope,tables:['items'],operation:'run',caller:{kind:'owner'},callerKey:'owner',input:{},idempotencyKey:'read',payloadSha256:hash('{}'),readOnly:true,authorize:f.authorize};
  await expect(supervisor.invoke(read)).rejects.toMatchObject({code:'replay_not_saved',retryAfterMs:5000});
  expect(onMaintenanceError).toHaveBeenCalledTimes(1);
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toBeNull();
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toEqual([]);
  await expect(supervisor.invoke(read)).rejects.toMatchObject({code:'dataset_reopen_wait',retryAfterMs:5000});
  expect(applied).toEqual([1]);
  broken=false;clock=5000;
  expect(await supervisor.invoke(read)).toMatchObject({revision:1,result:[{id:'one',value:'saved'}]});
  expect(applied).toEqual([1,1]);
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})?.cursor.revision).toBe(1);
});

it("retains an earlier recovery checkpoint when a later chunk cannot be sealed",async()=>{
  const f=await fixture();
  for(let index=1;index<=3;index++)await f.invoke({id:String(index),value:'saved'},{idempotencyKey:String(index)});
  await f.supervisor.close();
  const time=vi.spyOn(performance,'now').mockReturnValue(0);
  cleanups.push(async()=>{time.mockRestore();});
  let seals=0,broken=true,clock=0;
  const applied:number[]=[],commands=new Map<number,number>();
  const launch=launcher((request,controls)=>{
    if(request.command.kind==='applyBatch')commands.set(request.id,request.command.input[0].revision);
    controls.deliver();
  },message=>{const reply=message as {id:number;ok?:boolean;result?:{revision:number}};
    if(reply.ok&&commands.delete(reply.id))applied.push(reply.result!.revision);
  });
  const journal={...f.journal,async sealMaterializationCheckpoint(input:Parameters<DatasetJournal['sealMaterializationCheckpoint']>[0]){
    if(++seals===2&&broken)throw Error('disk full');return f.journal.sealMaterializationCheckpoint(input);
  }};
  const supervisor=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},nowMs:()=>clock,replayCacheMs:0,
    maintenanceStorage:{authorize(){},account(){}},onMaintenanceError(){}});
  cleanups.push(()=>supervisor.close());
  const read={scope:f.scope,tables:['items'],operation:'run',caller:{kind:'owner'},callerKey:'owner',input:{},idempotencyKey:'read',payloadSha256:hash('{}'),readOnly:true,authorize:f.authorize};
  await expect(supervisor.invoke(read)).rejects.toMatchObject({code:'replay_not_saved',retryAfterMs:5000});
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})!.cursor.revision).toBe(1);
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toHaveLength(0);
  broken=false;clock=5000;
  expect((await supervisor.invoke(read)).revision).toBe(3);
  expect(applied).toEqual([1,2,2,3]);
});

it("holds its folder, and runs startup maintenance, before a first preview reserves anything",async()=>{
  const f=await fixture(),root=join(f.directory,"later");let ready=false,balance=0;
  const storage={authorize(){},account({bytes}:{bytes:number}){balance+=bytes;}};
  const supervisor=await createDatasetSupervisor({journal:f.journal,maintenanceStorage:storage,
    directory:async()=>{if(!ready)throw new Error("The host has not prepared this folder.");await mkdir(root,{recursive:true});return root;},
    // What a host's exclusive startup does: reclaim every stage nothing retains.
    startup(){f.journal.reclaimCheckpointStages({authorize:f.authorize,account:storage.account,retain:()=>false});}});
  cleanups.push(()=>supervisor.close());
  ready=true;
  const candidate=await supervisor.prepareMigration({...migration(f),authorityKey:"owner"});
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toHaveLength(2);
  await supervisor.discardMigration({scope:f.scope,tables:["items"],candidateId:candidate.candidateId,authorityKey:"owner",authorize:f.authorize});
  expect(balance).toBe(0);
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toEqual([]);
});
