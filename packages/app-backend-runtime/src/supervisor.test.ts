import { createHash, randomUUID } from "node:crypto";
import { privateFolder } from "./private-folder.test-helper";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDatasetJournal, type DatasetJournal } from "./journal.ts";
import { createDatasetSupervisor, DatasetReopenWaitError, type DatasetInvocation, type DatasetMigration, type DatasetSupervisorOptions } from "./supervisor.ts";
import { DEFAULT_LIMITS, type AppRuntimeLauncher } from "./protocol.ts";
import { replayConstraintLauncher } from "./replay-constraint.test-helper.ts";

// These waits cover one worker command at the product deadline plus durable journal writes around it.
const workerWait = { timeout: 2 * DEFAULT_LIMITS.deadlineMs };
it.each([
  [1, "1 second"], [5000, "5 seconds"], [59999, "60 seconds"],
  [60000, "1 minute"], [60001, "2 minutes"], [1800000, "30 minutes"],
] as const)("describes a reopen wait of %i ms without claiming recovery failed", (milliseconds, duration) => {
  expect(new DatasetReopenWaitError(milliseconds).message).toBe(`This Collection is waiting to reopen. Try again in ${duration}.`);
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const schemaSql = "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);";
const source = `globalThis.operations = { run(ctx,input) {
  if(input.refuse) ctx.refuse('full','No spaces remain.');
  if(input.id) ctx.db.execute('INSERT INTO items VALUES(?,?)',[input.id,input.value]);
  if(input.file) ctx.files.attach(input.file);
  return ctx.db.query('SELECT * FROM items ORDER BY id');
}}`;

async function fixture(options: { transform?: (journal: DatasetJournal) => DatasetJournal; launch?: AppRuntimeLauncher; maxWorkers?: number; schemaSql?:string; source?:string; tables?:string[];maintenanceStorage?:DatasetSupervisorOptions["maintenanceStorage"];nowMs?:()=>number; materializationEvents?:number; idleMs?:number; queueMs?:number; onMaintenanceError?:DatasetSupervisorOptions["onMaintenanceError"]; workerRoot?:string } = {}) {
  const approvedSchema=options.schemaSql ?? schemaSql, approvedSource=options.source ?? source;
  const directory = await mkdtemp(join(tmpdir(), "dohc-supervisor-"));
  const seed = new DatabaseSync(join(directory, "seed.sqlite")); seed.exec(approvedSchema); seed.close();
  const checkpoint = await readFile(join(directory, "seed.sqlite"));
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

it("previews actual changed values and approves the exact candidate without running SQL twice",async()=>{
  let executions=0,reserved=0;
  const f=await fixture({maintenanceStorage:{authorize(){},account({bytes}){reserved+=bytes;}},launch:launcher((command,controls)=>{if(command.command.kind==="migrateCheckpoint")executions++;controls.deliver();})});
  await f.invoke({id:"one",value:"original"});
  const input=migration(f,{migrationSql:"ALTER TABLE items ADD COLUMN note TEXT NOT NULL DEFAULT ''; UPDATE items SET value=lower(hex(randomblob(12))),note='previewed';"});
  const candidate=await f.supervisor.prepareMigration({...input,authorityKey:"owner-v1"});
  expect(reserved).toBeGreaterThan(128*1024*1024);
  expect(candidate.preview.tables).toEqual([{table:"items",beforeRows:1,afterRows:1,changedRows:1}]);
  const change=candidate.preview.firstPage.changes[0]!;
  expect(change.before).toEqual({id:"one",value:"original"});expect(change.after).toMatchObject({id:"one",note:"previewed"});
  expect((await f.invoke({}, {readOnly:true})).result).toEqual([{id:"one",value:"original"}]);
  const access={scope:f.scope,tables:["items"],candidateId:candidate.candidateId,authorityKey:"owner-v1",authorize:f.authorize};
  expect(f.supervisor.migrationPreviewPage(access)).toEqual(candidate.preview.firstPage);
  await f.supervisor.approveMigration({...access,checkpointSha256:candidate.checkpointSha256});
  expect(executions).toBe(1);expect(reserved).toBe(0);
  expect((await f.invoke({}, {readOnly:true})).result).toEqual([change.after]);
  expect(()=>f.supervisor.migrationPreviewPage(access)).toThrow("no longer available");
});

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

it("refuses an expired preview and releases its reservation on explicit discard",async()=>{
  let now=100,balance=0;
  const f=await fixture({nowMs:()=>now,maintenanceStorage:{authorize(){},account({bytes}){balance+=bytes;}}});
  const candidate=await f.supervisor.prepareMigration({...migration(f),authorityKey:"owner"});now=candidate.expiresAtMs;
  const access={scope:f.scope,tables:["items"],candidateId:candidate.candidateId,authorityKey:"owner",authorize:f.authorize};
  expect(()=>f.supervisor.migrationPreviewPage(access)).toThrow("expired");
  await f.supervisor.discardMigration(access);expect(balance).toBe(0);
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

it("deletes migration candidates and reservations with their dataset without a second refund",async()=>{
  const account=vi.fn();const f=await fixture({maintenanceStorage:{authorize(){},account}});
  const candidate=await f.supervisor.prepareMigration({...migration(f),authorityKey:"owner"});
  expect(account).toHaveBeenCalledTimes(2);
  expect((await readdir(join(f.directory,"workers"))).filter(name=>name.startsWith("worker-"))).toHaveLength(2);
  f.journal.destroy({expected:f.journal.head(f.scope,f.authorize).cursor,authorize:f.authorize});
  await f.supervisor.retire(f.scope);
  expect(account).toHaveBeenCalledTimes(2);
  expect((await readdir(join(f.directory,"workers"))).filter(name=>name.startsWith("worker-"))).toEqual([]);
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toEqual([]);
  expect(()=>f.supervisor.migrationPreviewPage({scope:f.scope,tables:["items"],candidateId:candidate.candidateId,authorityKey:"owner",authorize:f.authorize})).toThrow("no longer available");
});

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

it("materializes large checkpoints through bounded verified ranges",async()=>{
  const lengths:number[]=[];
  const f=await fixture({schemaSql:schemaSql+"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1500) INSERT INTO items SELECT CAST(i AS TEXT),printf('%01024d',i) FROM n;",
    source:"globalThis.operations={run(ctx){return ctx.db.query('SELECT count(*) AS count FROM items')}}",
    transform:journal=>({...journal,checkpoint(){throw Error("Unbounded checkpoint read");},exportBlob(input){const bytes=journal.exportBlob(input);lengths.push(bytes.byteLength);return bytes;}}),
  });
  expect((await f.invoke({}, {readOnly:true})).result).toEqual([{count:1500}]);
  expect(lengths.length).toBeGreaterThan(1);expect(Math.max(...lengths)).toBeLessThanOrEqual(1024*1024);
});

it("stages migration chunks with quota credit and leaves no unused stage",async()=>{
  const chunks:number[]=[];let reserved=0,credited=0;
  const f=await fixture({schemaSql:schemaSql+"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1500) INSERT INTO items SELECT CAST(i AS TEXT),printf('%01024d',i) FROM n;",
    transform:journal=>({...journal,appendCheckpointChunk(input){chunks.push(input.bytes.byteLength);journal.appendCheckpointChunk(input);}}),
  });
  await f.supervisor.migrate(migration(f,{schemaSql,migrationSql:'SELECT 1;',source,
    accountStage:allocation=>{reserved+=allocation.bytes;},account:allocation=>{credited=allocation.stagedCreditBytes;},
  }));
  expect(chunks.length).toBeGreaterThan(1);expect(Math.max(...chunks)).toBeLessThanOrEqual(1024*1024);
  expect(reserved).toBeGreaterThan(1024*1024);expect(credited).toBe(reserved);
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toEqual([]);
});

it("returns a staged reservation when migration activation fails",async()=>{
  let reserved=0;
  const f=await fixture();
  await expect(f.supervisor.migrate(migration(f,{accountStage:allocation=>{reserved+=allocation.bytes;},account(){throw Error('quota full');}}))).rejects.toThrow('quota full');
  expect(reserved).toBe(0);
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toEqual([]);
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

it("preserves a revoked migration stage for authorized owner cleanup",async()=>{
  let reserved=0;
  const f=await fixture({transform:journal=>({...journal,sealCheckpoint(input){const result=journal.sealCheckpoint(input);revoke();return result;}})});
  const revoke=()=>f.db.exec('UPDATE grants SET allowed=0');
  await expect(f.supervisor.migrate(migration(f,{accountStage:allocation=>{reserved+=allocation.bytes;},account(){}}))).rejects.toThrow('denied');
  expect(reserved).toBeGreaterThan(0);f.db.exec('UPDATE grants SET allowed=1');
  const stages=f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize});expect(stages).toHaveLength(1);
  f.journal.discardCheckpoint({stage:stages[0],authorize:f.authorize,account:allocation=>{reserved+=allocation.bytes;}});expect(reserved).toBe(0);
});

it("journals only operations whose deferred foreign keys can commit",async()=>{
  const f=await fixture({tables:["items","parents"],
    schemaSql:"CREATE TABLE parents(id TEXT PRIMARY KEY NOT NULL); CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,parent_id TEXT NOT NULL REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);",
    source:`globalThis.operations={run(ctx,input){
      ctx.db.execute("INSERT INTO items VALUES('child','parent')");
      if(input.parent) ctx.db.execute("INSERT INTO parents VALUES('parent')");
      return ctx.db.query('SELECT * FROM items');
    }}`,
  });
  await expect(f.invoke({parent:false})).rejects.toThrow("foreign key");
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_events").get()!.n).toBe(0);
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_receipts").get()!.n).toBe(0);
  const valid=await f.invoke({parent:true},{idempotencyKey:"valid"});
  expect(valid).toMatchObject({revision:1,result:[{id:"child",parent_id:"parent"}]});
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_events").get()!.n).toBe(1);
});

it("refuses a caught rollback conflict before later statements can autocommit",async()=>{
  const f=await fixture({source:`globalThis.operations={run(ctx,input){
    if(input.conflict){
      ctx.db.execute("INSERT INTO items VALUES('same','first')");
      try {ctx.db.execute("INSERT OR ROLLBACK INTO items VALUES('same','duplicate')");}catch{}
      try {ctx.db.execute("INSERT INTO items VALUES('escaped','autocommit')");}catch{}
      return 'caught';
    }
    return ctx.db.query('SELECT * FROM items');
  }}`});
  await expect(f.invoke({conflict:true})).rejects.toThrow("transaction ended");
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_events").get()!.n).toBe(0);
  expect(f.db.prepare("SELECT count(*) AS n FROM dohc_dataset_receipts").get()!.n).toBe(0);
  expect((await f.invoke({}, {readOnly:true})).result).toEqual([]);
});

it("migrates an approved dataset through the real worker and recovers its new schema",async()=>{
  let launches=0;
  const f=await fixture({launch:launcher((command,controls)=>{if(command.command.kind==="open")launches++;controls.deliver();})});
  await f.invoke({id:"before",value:"saved"});const input=migration(f);
  const migrated=await f.supervisor.migrate(input);expect(migrated.revision).toBe(2);expect(migrated.approvedRevisionHash).toBe(input.approvedRevisionHash);
  expect((await f.invoke({}, {readOnly:true})).result).toEqual([{id:"before",value:"saved",note:"migrated"}]);expect(launches).toBe(2);
  expect((await f.invoke({id:"after",value:"new"},{idempotencyKey:"after"})).revision).toBe(3);
  expect((await f.invoke({id:"before",value:"saved"})).replayed).toBe(true);
});
it.each([125, 153])("migrates records in a long workspace folder (%i characters)",async length=>{
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
it("refuses migration after another queued write advances the approved preview",async()=>{
  const f=await fixture(),input=migration(f);
  const write=f.invoke({id:"new",value:"saved"});const change=f.supervisor.migrate(input);
  await write;await expect(change).rejects.toThrow("Preview it again");
  expect((await f.invoke({}, {readOnly:true})).result).toEqual([{id:"new",value:"saved"}]);
});
it("keeps the previous schema and quota after catalog activation fails",async()=>{
  const f=await fixture();await f.invoke({id:"before",value:"saved"});
  await expect(f.supervisor.migrate(migration(f,{accountStage:()=>{},account:()=>{f.db.exec("UPDATE files SET attached=1");throw Error("quota full");}}))).rejects.toThrow("quota full");
  expect(f.db.prepare("SELECT attached FROM files").get()!.attached).toBe(0);
  expect((await f.invoke({}, {readOnly:true})).result).toEqual([{id:"before",value:"saved"}]);
});
it("does not activate a migration whose owner was revoked during worker execution",async()=>{
  let revoke=()=>{};
  const f=await fixture({launch:launcher((command,controls)=>{if(command.command.kind==="migrateCheckpoint")revoke();controls.deliver();})});
  revoke=()=>f.db.exec("UPDATE grants SET allowed=0");
  await expect(f.supervisor.migrate(migration(f))).rejects.toThrow("denied");expect(f.db.prepare("SELECT revision FROM dohc_dataset_journals").get()!.revision).toBe(0);
});
it("recovers a committed migration after its host acknowledgment is lost without rerunning SQL",async()=>{
  const f=await fixture({transform:journal=>({...journal,transitionCheckpoint(input){const result=journal.transitionCheckpoint(input);throw Error(`lost migration acknowledgment ${result.revision}`);}})});
  const input=migration(f);await expect(f.supervisor.migrate(input)).rejects.toThrow("lost migration acknowledgment");
  expect(f.journal.head(f.scope,f.authorize).cursor.revision).toBe(1);
  await expect(f.supervisor.migrate(input)).rejects.toThrow("Preview it again");
  expect((await f.invoke({id:"after",value:"saved"},{idempotencyKey:"after"})).result).toEqual([{id:"after",value:"saved",note:""}]);
});
it("withholds migrated state if owner access is revoked after the journal commits",async()=>{
  let revoke=()=>{};
  const f=await fixture({transform:journal=>({...journal,transitionCheckpoint(input){const result=journal.transitionCheckpoint(input);revoke();return result;}})});
  revoke=()=>f.db.exec("UPDATE grants SET allowed=0");
  await expect(f.supervisor.migrate(migration(f))).rejects.toThrow("denied");
  expect(f.db.prepare("SELECT revision FROM dohc_dataset_journals").get()!.revision).toBe(1);
  await expect(f.invoke({}, {readOnly:true})).rejects.toThrow("denied");
});
it("preserves the old dataset when the migration worker dies",async()=>{
  const f=await fixture({launch:launcher((command,controls)=>{if(command.command.kind==="migrateCheckpoint")controls.stop();else controls.deliver();})});
  await f.invoke({id:"before",value:"saved"});
  await expect(f.supervisor.migrate(migration(f))).rejects.toThrow("stopped");
  expect((await f.invoke({}, {readOnly:true})).result).toEqual([{id:"before",value:"saved"}]);
});

it("recovers a host commit whose acknowledgment was lost and returns its receipt exactly once", async () => {
  let fail = true;
  const f = await fixture({ transform: journal => ({ ...journal, commitOperation(input) {
    const result = journal.commitOperation(input);
    if (fail) { fail = false; throw Error("lost host acknowledgment"); }
    return result;
  } }) });
  await expect(f.invoke({ id: "once", value: "saved" })).rejects.toThrow("lost host acknowledgment");
  expect(await f.invoke({ id: "once", value: "saved" })).toMatchObject({ revision: 1, replayed: true, result: [{ id: "once", value: "saved" }] });
  await expect(f.invoke({ id: "once", value: "changed" })).rejects.toThrow("already used for different values");
  expect((await f.invoke({}, { readOnly: true })).result).toHaveLength(1);
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

it("rechecks authority before returning a structured refusal", async () => {
  let revoke = () => {};
  const f = await fixture({ launch: launcher((command, controls) => {
    if (command.command.kind === "prepare") revoke();
    controls.deliver();
  }) });
  revoke = () => f.db.exec("UPDATE grants SET allowed=0");
  await expect(f.invoke({ refuse: true })).rejects.toThrow("denied");
});

it.each(["abort","close"] as const)("stops a worker that is still starting on %s",async(kind)=>{
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
    if(kind==="abort")controller.abort(new Error("Request cancelled."));else void f.supervisor.close();
    await expect(invocation).rejects.toThrow(kind==="abort" ? "Request cancelled." : "dohc closed this workspace's Collections");
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

it("caches a replay that rebuilt the dataset so the next reopen does not repeat it",async()=>{
  const swapSource=`globalThis.operations={run(ctx,input){
    if(input.swap){ctx.db.execute("UPDATE items SET value='temp' WHERE id='a'");ctx.db.execute("UPDATE items SET value='x' WHERE id='b'");ctx.db.execute("UPDATE items SET value='y' WHERE id='a'");}
    else if(input.id) ctx.db.execute('INSERT INTO items VALUES(?,?)',[input.id,input.value]);
    return ctx.db.query('SELECT * FROM items ORDER BY id');
  }}`;
  const storage={authorize(){},account(){}};
  const f=await fixture({schemaSql:"CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL UNIQUE);",source:swapSource,maintenanceStorage:storage});
  // Seed real SQLite changesets without opening a worker just to prepare history.
  const seed=new DatabaseSync(':memory:');
  seed.exec("CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL UNIQUE);");
  try {
    for(const [key,input,sql] of [
      ['a',{id:'a',value:'x'},"INSERT INTO items VALUES('a','x')"],
      ['b',{id:'b',value:'y'},"INSERT INTO items VALUES('b','y')"],
      ['swap',{swap:true},"UPDATE items SET value='temp' WHERE id='a'; UPDATE items SET value='x' WHERE id='b'; UPDATE items SET value='y' WHERE id='a';"],
    ] as const) {
      const session=seed.createSession();
      let changeset:Uint8Array;
      try {seed.exec(sql);changeset=session.changeset();}finally{session.close();}
      const resultJson=JSON.stringify(seed.prepare('SELECT * FROM items ORDER BY id').all());
      expect(f.journal.commitOperation({expected:f.journal.head(f.scope,f.authorize).cursor,proposalId:randomUUID(),operation:'run',
        callerKey:'owner',idempotencyKey:key,payloadSha256:hash(JSON.stringify(input)),resultJson,changeset,
        changesetSha256:createHash('sha256').update(changeset).digest('hex'),attachedFileIds:[],authorize:f.authorize}).kind).toBe('committed');
    }
  } finally {seed.close();}
  await f.supervisor.close();
  // Keep all three events in one worker batch, then make only its final cache eligible.
  const replayCacheMs=60_000;
  let elapsed=0;
  const time=vi.spyOn(performance,'now').mockImplementation(()=>elapsed);
  cleanups.push(async()=>{time.mockRestore();});
  const opened:number[]=[],replyRevisions:number[]=[],steps:string[]=[],batchInputs:number[][]=[];
  let batchId:number|undefined,snapshots=0;
  const launch=replayConstraintLauncher(launcher((command,controls)=>{
    if(command.command.kind==="open")opened.push(command.command.input.cursor.revision);
    if(command.command.kind==="applyBatch"){
      batchInputs.push(command.command.input.map((event:{revision:number})=>event.revision));
      batchId=command.id;
    }
    if(command.command.kind==='snapshot')snapshots++;
    controls.deliver();
  },message=>{
    const reply=message as {id:number;ok?:boolean;result?:{revision:number};progress?:unknown};
    if(typeof reply.progress==="string")steps.push(reply.progress);
    if(reply.ok&&reply.id===batchId){replyRevisions.push(reply.result!.revision);batchId=undefined;elapsed+=replayCacheMs;}
  }),2);
  const read={scope:f.scope,tables:["items"],operation:"run",caller:{kind:"owner"},callerKey:"owner",input:{},idempotencyKey:"read",payloadSha256:hash("{}"),readOnly:true,authorize:f.authorize};
  const swapped=[{id:"a",value:"y"},{id:"b",value:"x"}];
  for(const round of [1,2]) {
    const supervisor=await createDatasetSupervisor({journal:f.journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},maintenanceStorage:storage,replayCacheMs});
    try {
      expect((await supervisor.invoke(read)).result).toEqual(swapped);
      // The request returns only once the replay's cache is installed.
      if(round===1) expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})?.cursor.revision).toBe(3);
    } finally {await supervisor.close();}
  }
  expect(steps).toContain("rebuilding the dataset from the replay copy");
  expect(opened).toEqual([0,3]);expect(replyRevisions).toEqual([3]);
  expect(batchInputs).toEqual([[1,2,3]]);expect(snapshots).toBe(1);
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

it("reopens at once after a failed replay when the host turns the wait off",async()=>{
  const {state,read}=await failingReopens({reopenWaitCapMs:0});
  await expect(read()).rejects.toMatchObject({code:"worker_budget"});
  await expect(read()).rejects.toMatchObject({code:"worker_budget"});
  expect(state.replayed).toEqual([1,1]);
});

it("waits to reopen when the worker stops during a replay without saying why",async()=>{
  // A budget kill whose marker could not be written, for example on a full disk.
  const {state,read}=await failingReopens({});
  state.marker=false;
  await expect(read()).rejects.toMatchObject({code:"worker_stopped",retryAfterMs:5_000});
  await expect(read()).rejects.toMatchObject({code:"dataset_reopen_wait"});
  expect(state.replayed).toEqual([1]);
});

it.each(["quota","seal"] as const)("waits to reopen when a mandatory replay checkpoint fails at its %s",async(stage)=>{
  const replayed:number[]=[];
  const launch=launcher((command,controls)=>{
    if(command.command.kind==="applyBatch")replayed.push(...command.command.input.map((event:{revision:number})=>event.revision));
    controls.deliver();
  });
  const f=await fixture();
  await f.invoke({id:"one",value:"saved"});
  await f.invoke({id:"two",value:"saved"},{idempotencyKey:"two"});
  await f.supervisor.close();
  const journal={...f.journal,
    events(input:Parameters<DatasetJournal["events"]>[0]){return f.journal.events({...input,limit:1});},
    ...(stage==="seal"?{async sealMaterializationCheckpoint():Promise<never>{throw new Error("disk full");}}:{}),
  };
  const supervisor=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},replayCacheMs:0,onMaintenanceError(){},
    maintenanceStorage:{authorize(){},account(){if(stage==="quota")throw new Error("quota full");}}});
  cleanups.push(()=>supervisor.close());
  const read={scope:f.scope,tables:["items"],operation:"run",caller:{kind:"owner"},callerKey:"owner",input:{},idempotencyKey:"read",payloadSha256:hash("{}"),readOnly:true,authorize:f.authorize};
  await expect(supervisor.invoke(read)).rejects.toMatchObject({code:"replay_not_saved",retryAfterMs:5_000});
  await expect(supervisor.invoke(read)).rejects.toMatchObject({code:"dataset_reopen_wait"});
  expect(replayed).toEqual([1]);
});

it("waits to reopen when a mandatory replay checkpoint cannot be saved",async()=>{
  const replayed:number[]=[];
  const launch=launcher((command,controls)=>{
    if(command.command.kind==="applyBatch")replayed.push(...command.command.input.map((event:{revision:number})=>event.revision));
    // The snapshot for the replay's cache stops, as on a full disk.
    if(command.command.kind==="snapshot"){controls.stop();return;}
    controls.deliver();
  });
  const f=await fixture();
  await f.invoke({id:"one",value:"saved"});
  await f.invoke({id:"two",value:"saved"},{idempotencyKey:"two"});
  await f.supervisor.close();
  const journal={...f.journal,events(input:Parameters<DatasetJournal["events"]>[0]){return f.journal.events({...input,limit:1});}};
  const supervisor=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},
    maintenanceStorage:{authorize(){},account(){}},replayCacheMs:0,onMaintenanceError(){}});
  cleanups.push(()=>supervisor.close());
  const read={scope:f.scope,tables:["items"],operation:"run",caller:{kind:"owner"},callerKey:"owner",input:{},idempotencyKey:"read",payloadSha256:hash("{}"),readOnly:true,authorize:f.authorize};
  await expect(supervisor.invoke(read)).rejects.toMatchObject({code:"replay_not_saved"});
  await expect(supervisor.invoke(read)).rejects.toMatchObject({code:"dataset_reopen_wait"});
  expect(replayed).toEqual([1]);
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

it.each(["close","retire"] as const)("drains captured maintenance on %s and refunds its independent files",async(kind)=>{
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

it("acknowledges a committed write before cache maintenance and serializes snapshot capture",async()=>{
  let release:(()=>void)|undefined;
  const storage={authorize(){},account(){}};
  const f=await fixture({materializationEvents:1,maintenanceStorage:storage,launch:launcher((command,controls)=>{
    if(command.command.kind==="snapshot"){release=controls.deliver;return;}controls.deliver();
  })});
  expect((await f.invoke({id:"one",value:"saved"})).revision).toBe(1);
  await vi.waitFor(()=>expect(release).toBeTypeOf("function"),workerWait);
  let completed=false;
  const read=f.invoke({}, {readOnly:true}).then(result=>{completed=true;return result;});
  await new Promise<void>(resolve=>setImmediate(resolve));expect(completed).toBe(false);
  release!();expect((await read).result).toHaveLength(1);
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

it("creates threshold caches with host authority after the request credential expires",async()=>{
  let cached!:()=>void;
  const installed=new Promise<void>(resolve=>cached=resolve);
  const f=await fixture({materializationEvents:1,maintenanceStorage:{authorize(){},account(){}},transform:journal=>({...journal,cacheMaterialization(input){const value=journal.cacheMaterialization(input);cached();return value;}})});
  await f.invoke({id:"one",value:"saved"});
  f.db.prepare("UPDATE grants SET allowed=0").run();
  await installed;
  expect(f.journal.materialization({scope:f.scope,authorize(){}})?.cursor.revision).toBe(1);
  expect(f.journal.head(f.scope,()=>{}).cursor.revision).toBe(1);
});

it("evicts an idle worker without snapshotting a single event below the cache threshold",async()=>{
  let closed!:()=>void,snapshots=0;
  const idleClosed=new Promise<void>(resolve=>closed=resolve);
  const f=await fixture({idleMs:10,maintenanceStorage:{authorize(){},account(){}},launch:launcher((command,controls)=>{
    if(command.command.kind==="snapshot")snapshots++;
    if(command.command.kind==="close")closed();
    controls.deliver();
  })});
  await f.invoke({id:"one",value:"saved"});
  await idleClosed;
  expect(snapshots).toBe(0);
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toBeNull();
  expect((await f.invoke({}, {readOnly:true})).result).toEqual([{id:"one",value:"saved"}]);
  expect(snapshots).toBe(0);
});


it.each(["chunk", "full hash", "missing marker", "wrong marker", "schema"])("falls back to authoritative history for a cache with damaged %s",async(damage)=>{
  const f=await fixture({materializationEvents:1,maintenanceStorage:{authorize(){},account(){}}});
  await f.invoke({id:"one",value:"saved"});
  await f.invoke({}, {readOnly:true});
  await vi.waitFor(()=>expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).not.toBeNull(),workerWait);
  const cache=f.journal.materialization({scope:f.scope,authorize:f.authorize})!;
  await f.supervisor.close();
  const bytes=f.journal.materializationBlob({scope:f.scope,cache,offset:0,authorize:f.authorize})!;
  if(damage==="chunk"||damage==="full hash") {
    const corrupted=Uint8Array.from(bytes);corrupted[corrupted.length-1]^=1;
    f.db.prepare("UPDATE dohc_dataset_checkpoint_chunks SET bytes=? WHERE stage_id=?").run(corrupted,cache.checkpointId);
    if(damage==="full hash")f.db.prepare("UPDATE dohc_dataset_checkpoint_chunks SET sha256=? WHERE stage_id=?").run(createHash("sha256").update(corrupted).digest("hex"),cache.checkpointId);
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

it("replaces a rejected cache after a costly replay, so the next reopen does not replay again",async()=>{
  const storage={authorize(){},account(){}};
  const f=await fixture({materializationEvents:1,maintenanceStorage:storage});
  await f.invoke({id:"one",value:"saved"});
  await f.invoke({}, {readOnly:true});
  await vi.waitFor(()=>expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).not.toBeNull());
  const cache=f.journal.materialization({scope:f.scope,authorize:f.authorize})!;
  await f.supervisor.close();
  // A cache at the head whose contents fail validation at reopen.
  const path=join(f.directory,"damaged.sqlite");
  await writeFile(path,f.journal.materializationBlob({scope:f.scope,cache,offset:0,authorize:f.authorize})!);
  const damaged=new DatabaseSync(path);damaged.exec("DROP TABLE dohc_applied");damaged.close();
  const bytes=await readFile(path);
  let stage=f.journal.stageCheckpoint({scope:f.scope,expectedBytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),authorize:f.authorize});
  f.journal.appendCheckpointChunk({stage,index:0,bytes,authorize:f.authorize});
  stage=f.journal.sealCheckpoint({stage,authorize:f.authorize});
  f.journal.cacheMaterialization({expected:cache.cursor,checkpoint:stage,authorize:f.authorize,account(){}});
  const replayed:number[]=[];
  const launch=launcher((command,controls)=>{
    if(command.command.kind==="applyBatch")replayed.push(...command.command.input.map((event:{revision:number})=>event.revision));controls.deliver();
  });
  const read={scope:f.scope,tables:["items"],operation:"run",caller:{kind:"owner"},callerKey:"owner",input:{},idempotencyKey:"read",payloadSha256:hash("{}"),readOnly:true,authorize:f.authorize};
  for(let round=0;round<2;round++) {
    const reopened=await createDatasetSupervisor({journal:f.journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},maintenanceStorage:storage,replayCacheMs:0,onMaintenanceError(){}});
    try {expect((await reopened.invoke(read)).result).toEqual([{id:"one",value:"saved"}]);}
    finally {await reopened.close();}
  }
  expect(replayed).toEqual([1]);
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})!.sha256).not.toBe(createHash("sha256").update(bytes).digest("hex"));
});

it("leaves restart-reclaimable reservations when closing during a snapshot",async()=>{
  let entered!:()=>void;
  const snapshot=new Promise<void>(resolve=>entered=resolve);
  const f=await fixture({materializationEvents:1,maintenanceStorage:{authorize(){},account(){}},launch:launcher((command,controls)=>{
    if(command.command.kind==="snapshot"){entered();return;}controls.deliver();
  })});
  expect((await f.invoke({id:"one",value:"saved"})).revision).toBe(1);
  await snapshot;
  await f.supervisor.close();
  expect(f.journal.head(f.scope,f.authorize).cursor.revision).toBe(1);
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toBeNull();
  const stages=f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize});
  expect(stages.length).toBeLessThanOrEqual(1);
  expect((await readdir(join(f.directory,"workers"))).filter(name=>name.startsWith("worker-"))).toHaveLength(0);
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


it("stages and restores a large materialization through bounded chunks",async()=>{
  const staged:number[]=[],restored:number[]=[];
  const f=await fixture({materializationEvents:1,maintenanceStorage:{authorize(){},account(){}},
    schemaSql:schemaSql+"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1500) INSERT INTO items SELECT CAST(i AS TEXT),printf('%01024d',i) FROM n;",
    source:"globalThis.operations={run(ctx,input){if(input.id)ctx.db.execute('INSERT INTO items VALUES(?,?)',[input.id,'saved']);return ctx.db.query('SELECT count(*) AS count FROM items')}}",
    transform:journal=>({...journal,appendCheckpointChunk(input){staged.push(input.bytes.byteLength);return journal.appendCheckpointChunk(input);}})});
  await f.invoke({id:"new"});await f.invoke({}, {readOnly:true});
  await vi.waitFor(()=>expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).not.toBeNull(),workerWait);await f.supervisor.close();
  const journal={...f.journal,materializationBlob(input:Parameters<DatasetJournal["materializationBlob"]>[0]){const bytes=f.journal.materializationBlob(input);if(bytes)restored.push(bytes.byteLength);return bytes;}};
  const reopened=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers"))});cleanups.push(()=>reopened.close());
  expect((await reopened.invoke({scope:f.scope,tables:["items"],operation:"run",caller:{kind:"owner"},callerKey:"owner",input:{},idempotencyKey:"read",payloadSha256:hash("{}"),readOnly:true,authorize:f.authorize})).result).toEqual([{count:1501}]);
  expect(staged.length).toBeGreaterThan(1);expect(restored.length).toBeGreaterThan(1);
  expect(Math.max(...staged,...restored)).toBeLessThanOrEqual(1024*1024);
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

it("waits for post-response cache work before reclaiming its worker slot",async()=>{
  let entered!:()=>void,release:(()=>void)|undefined;
  const snapshot=new Promise<void>(resolve=>entered=resolve);
  const f=await fixture({maxWorkers:1,materializationEvents:1,maintenanceStorage:{authorize(){},account(){}},launch:launcher((command,controls)=>{
    if(command.command.kind==="snapshot"&&!release){release=controls.deliver;entered();return;}controls.deliver();
  })});
  f.initialize("second");await f.invoke({id:"one",value:"saved"});await snapshot;
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

it.each(["abort","revoke","delete","close"])("rechecks %s while waiting for a retiring worker",async(kind)=>{
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

it("counts retiring-worker waiters against the shared 128-request admission limit",async()=>{
  const f=await heldIdleRetirement(),controllers:AbortController[]=[],pending:Promise<unknown>[]=[];
  try {
    for(let index=0;index<128;index++){
      const datasetId=`waiting-${index}`;f.initialize(datasetId);const controller=new AbortController();controllers.push(controller);
      pending.push(f.invoke({}, {scope:{...f.scope,datasetId},readOnly:true,signal:controller.signal}).catch(error=>error));
    }
    f.initialize("over-limit");
    await expect(f.invoke({}, {scope:{...f.scope,datasetId:"over-limit"},readOnly:true})).rejects.toThrow("too much Collection work waiting");
  }finally{for(const controller of controllers)controller.abort(new Error("cancelled"));await Promise.all(pending);f.release();}
});

it("does not restart the original queue deadline when worker capacity is pending",async()=>{
  const f=await heldIdleRetirement();f.initialize("second");
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","performance"]});
  try {
    let outcome:unknown;
    const pending=f.invoke({}, {scope:{...f.scope,datasetId:"second"},readOnly:true}).catch(error=>{outcome=error;return error;});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outcome).toBeInstanceOf(Error);expect((await pending).message).toContain("stopped waiting");
  }finally{vi.useRealTimers();f.release();}
});


it.each(["abort","deadline"])("settles %s promptly when its own old worker is being evicted",async(kind)=>{
  let entered!:()=>void,release:(()=>void)|undefined;
  const stopping=new Promise<void>(resolve=>entered=resolve);
  const f=await fixture({maxWorkers:1,launch:launcher((command,controls)=>{
    if(command.command.kind==="close"&&!release){release=controls.deliver;entered();return;}controls.deliver();
  })});
  f.initialize("second");await f.invoke({}, {readOnly:true});
  const other=f.invoke({}, {scope:{...f.scope,datasetId:"second"},readOnly:true}).catch(error=>error);await stopping;
  const controller=new AbortController();let outcome:unknown;
  if(kind==="deadline")vi.useFakeTimers({toFake:["setTimeout","clearTimeout","performance"]});
  const pending=f.invoke({}, {readOnly:true,signal:controller.signal}).catch(error=>{outcome=error;return error;});
  try {
    if(kind==="abort"){controller.abort(new Error("cancelled"));await new Promise<void>(resolve=>setImmediate(resolve));}
    else await vi.advanceTimersByTimeAsync(30_000);
    expect(outcome).toBeInstanceOf(Error);
    expect((await pending).message).toContain(kind==="abort"?"cancelled":"stopped waiting");
  }finally{vi.useRealTimers();release!();await other;await pending;}
});


// Test allowance for 128 seed/replay steps and six worker lifetimes (seed, four replay workers, reopen).
it("checkpoints a hostile 64-swap replay before each later worker failure and resumes without repeating saved work",{timeout: 2*64*DEFAULT_LIMITS.evaluationMs+6*DEFAULT_LIMITS.deadlineMs},async()=>{
  const swapSchema="CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL UNIQUE); INSERT INTO items VALUES(1,'left'),(2,'right');";
  const swapSource=`globalThis.operations={run(ctx,input){
    if(input.swap){const rows=ctx.db.query('SELECT value FROM items ORDER BY id');
      ctx.db.execute('UPDATE items SET value=? WHERE id=1',['temporary']);
      ctx.db.execute('UPDATE items SET value=? WHERE id=2',[rows[0].value]);
      ctx.db.execute('UPDATE items SET value=? WHERE id=1',[rows[1].value]);}
    return ctx.db.query('SELECT * FROM items ORDER BY id');
  }}`;
  const f=await fixture({schemaSql:swapSchema,source:swapSource});
  for(let index=0;index<64;index++)await f.invoke({swap:true},{idempotencyKey:String(index)});
  await f.supervisor.close();
  // Faults stay at saved boundaries; adaptive checkpoint cost has its own test.
  const time=vi.spyOn(performance,'now').mockReturnValue(0);
  cleanups.push(async()=>{time.mockRestore();});
  const saved:number[]=[],applied:number[]=[],pids:number[]=[],closedPids:number[]=[];
  const journal={...f.journal,cacheMaterialization(input:Parameters<DatasetJournal['cacheMaterialization']>[0]){
    const result=f.journal.cacheMaterialization(input);saved.push(result.cursor.revision);return result;
  }};
  let clock=0,attempt=0,inAttempt=0;
  const launch:AppRuntimeLauncher=options=>{
    const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',options.entryPath],{cwd:options.cwd,env:options.env,stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',windowsHide:true});
    pids.push(child.pid!);
    child.on('close',()=>closedPids.push(child.pid!));
    const batches=new Set<number>();
    child.on('error',options.onError);child.on('close',options.onExit);
    child.on('message',message=>{
      const reply=message as {id:number;ok?:boolean;result?:{revision:number}};
      if(reply.ok&&batches.delete(reply.id)){applied.push(reply.result!.revision);inAttempt++;}
      options.onMessage(message);
    });
    return {postMessage(message){const request=message as {id:number;command:{kind:string}};
      if(request.command.kind==='applyBatch'){
        // Stop at an admitted chunk boundary after sixteen completed chunks.
        if(inAttempt===16&&attempt<4){child.kill('SIGKILL');return;}
        batches.add(request.id);
      }
      child.send(message as object);
    },kill(){child.kill('SIGKILL');}};
  };
  const supervisor=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},nowMs:()=>clock,
    replayCacheMs:0,maintenanceStorage:{authorize(){},account(){}}});
  cleanups.push(()=>supervisor.close());
  const read={scope:f.scope,tables:['items'],operation:'run',caller:{kind:'owner'},callerKey:'owner',input:{},idempotencyKey:'read',payloadSha256:hash('{}'),readOnly:true,authorize:f.authorize};
  for(attempt=1;attempt<=4;attempt++){
    inAttempt=0;
    if(attempt<4){
      const error=await supervisor.invoke(read).catch(error=>error);
      // Each successful prefix cache resets the wait before the later worker failure.
      expect(error).toMatchObject({code:'worker_stopped',retryAfterMs:5000});
      expect(saved.at(-1)).toBe(attempt*16);
      await expect(supervisor.invoke(read)).rejects.toMatchObject({code:'dataset_reopen_wait'});
      clock+=error.retryAfterMs;
    }else expect((await supervisor.invoke(read)).result).toEqual([{id:1,value:'left'},{id:2,value:'right'}]);
  }
  expect(applied).toEqual(Array.from({length:64},(_,index)=>index+1));
  expect(saved).toEqual(applied);
  await supervisor.close();
  const reopened=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch}});
  try{expect((await reopened.invoke(read)).revision).toBe(64);expect(applied).toHaveLength(64);}
  finally{await reopened.close();}
  expect(closedPids.sort()).toEqual(pids.sort());
});

it.each([
  {events:1,interval:100,completed:true,afterCheckpoint:false},
  {events:2,interval:200,completed:true,afterCheckpoint:false},
  {events:2,interval:100,completed:false,afterCheckpoint:false},
  {events:3,interval:100,completed:true,afterCheckpoint:true},
])("handles occupied maintenance slots for $events events with a $interval ms interval afterCheckpoint=$afterCheckpoint",async({events,interval,completed,afterCheckpoint})=>{
  const pids:number[]=[],closedPids:number[]=[];
  cleanups.push(async()=>{expect(closedPids.sort()).toEqual(pids.sort());});
  const f=await fixture({launch:launcher((_request,controls)=>controls.deliver(),undefined,pids,closedPids)});
  for(let index=1;index<=events;index++)await f.invoke({id:String(index),value:'saved'},{idempotencyKey:String(index)});
  f.initialize('second');f.initialize('third');
  await f.supervisor.close();
  let elapsed=0,release!:()=>void,occupied=0,entered!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);
  const time=vi.spyOn(performance,'now').mockImplementation(()=>elapsed);
  cleanups.push(async()=>{time.mockRestore();});
  const applied:number[]=[];
  let occupying:Promise<void>|undefined;
  const launch:AppRuntimeLauncher=options=>{
    const pending=new Set<number>();
    return launcher((request,controls)=>{
      if(request.command.kind==='applyBatch'){
        pending.add(request.id);
        if(afterCheckpoint&&request.command.input[0].revision===2){void ready.then(controls.deliver);return;}
      }
      controls.deliver();
    },message=>{const reply=message as {id:number;ok?:boolean;result?:{revision:number}};
      if(reply.ok&&pending.delete(reply.id)){applied.push(reply.result!.revision);elapsed+=100;}
    },pids,closedPids)(options);
  };
  const journal={...f.journal,
    events(input:Parameters<DatasetJournal['events']>[0]){return f.journal.events({...input,limit:1});},
    async sealMaterializationCheckpoint(input:Parameters<DatasetJournal['sealMaterializationCheckpoint']>[0]){
      if(input.stage.scope.datasetId!==f.scope.datasetId){if(++occupied===2)entered();await held;}
      else if(afterCheckpoint)elapsed+=200;
      return f.journal.sealMaterializationCheckpoint(input);
    },
    cacheMaterialization(input:Parameters<DatasetJournal['cacheMaterialization']>[0]){
      const cached=f.journal.cacheMaterialization(input);
      if(afterCheckpoint&&input.expected.datasetId===f.scope.datasetId)occupying=occupySlots();
      return cached;
    },
  };
  const supervisor=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},maxWorkers:2,replayCacheMs:interval,
    materializationEvents:1,maintenanceStorage:{authorize(){},account(){}}});
  cleanups.push(()=>supervisor.close());
  const read={scope:f.scope,tables:['items'],operation:'run',caller:{kind:'owner'},callerKey:'owner',input:{},idempotencyKey:'read',payloadSha256:hash('{}'),readOnly:true,authorize:f.authorize};
  async function occupySlots(){
    for(const datasetId of ['second','third']){
      const input={id:datasetId,value:'other'};
      await supervisor.invoke({...read,scope:{...f.scope,datasetId},input,readOnly:false,payloadSha256:hash(JSON.stringify(input))});
    }
    await ready;
  }
  try {
    if(!afterCheckpoint)await occupySlots();
    const target=f.journal.head(f.scope,f.authorize).cursor;
    if(completed){
      const result=await supervisor.invoke(read);
      expect(result.revision).toBe(target.revision);
      expect(result.result).toEqual(Array.from({length:events},(_,index)=>({id:String(index+1),value:'saved'})));
      expect(applied).toEqual(Array.from({length:events},(_,index)=>index+1));
    }else{
      await expect(supervisor.invoke(read)).rejects.toMatchObject({code:'replay_not_saved',retryAfterMs:5000});
      expect(applied).toEqual([1]);
    }
    expect(f.journal.head(f.scope,f.authorize).cursor).toEqual(target);
    const cached=f.journal.materialization({scope:f.scope,authorize:f.authorize});
    if(afterCheckpoint)expect(cached?.cursor.revision).toBe(1);else expect(cached).toBeNull();
    expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize}).every(stage=>stage.scope.datasetId!==f.scope.datasetId)).toBe(true);
  } finally {release();await occupying;await supervisor.close();time.mockRestore();}
  const reopened=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch}});
  try {
    const result=await reopened.invoke(read);
    expect(result.revision).toBe(events);
    expect(result.result).toEqual(Array.from({length:events},(_,index)=>({id:String(index+1),value:'saved'})));
    expect(applied).toEqual([...(completed?Array.from({length:events},(_,index)=>index+1):[1]),...Array.from({length:events-(afterCheckpoint?1:0)},(_,index)=>index+1+(afterCheckpoint?1:0))]);
  } finally {await reopened.close();}
});

async function unsavedTailFixture(mode:"busy"|"blocked") {
  const pids:number[]=[],closedPids:number[]=[];
  cleanups.push(async()=>{expect(closedPids.sort()).toEqual(pids.sort());});
  const f=await fixture({launch:launcher((_request,controls)=>controls.deliver(),undefined,pids,closedPids)});
  await f.invoke({id:'one',value:'saved'});
  f.initialize('other');
  await f.supervisor.close();
  const time=vi.spyOn(performance,'now').mockReturnValue(0);
  cleanups.push(async()=>{time.mockRestore();});
  const state={clock:0,applied:[] as number[]};
  let faults=mode==='blocked',release=()=>{},entered=()=>{},held=Promise.resolve(),occupations=0;
  const onMaintenanceError=vi.fn();
  const journal={...f.journal,
    async sealMaterializationCheckpoint(input:Parameters<DatasetJournal['sealMaterializationCheckpoint']>[0]){
      if(input.stage.scope.datasetId==='other'){entered();await held;}
      else if(faults)throw Error('seal failed');
      return f.journal.sealMaterializationCheckpoint(input);
    },
    discardCheckpoint(input:Parameters<DatasetJournal['discardCheckpoint']>[0]){
      if(faults&&input.stage.scope.datasetId===f.scope.datasetId)throw Error('cleanup blocked');
      return f.journal.discardCheckpoint(input);
    },
  };
  const launch:AppRuntimeLauncher=options=>{
    let directory='';
    return launcher((request,controls)=>{
      if(request.command.kind==='open')directory=request.command.input.directory;
      if(request.command.kind==='applyBatch')state.applied.push(...request.command.input.map((event:{revision:number})=>event.revision));
      if(request.command.kind==='prepare'&&JSON.parse(request.command.guest.inputJson).killWorker){
        void writeFile(join(directory,'cpu-budget-exceeded-app-5000'),'').then(controls.stop);return;
      }
      controls.deliver();
    },undefined,pids,closedPids)(options);
  };
  const supervisor=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},maxWorkers:1,
    replayCacheMs:0,materializationEvents:1,nowMs:()=>state.clock,maintenanceStorage:{authorize(){},account(){}},onMaintenanceError});
  cleanups.push(async()=>{release();await supervisor.close();});
  const readInput={scope:f.scope,tables:['items'],operation:'run',caller:{kind:'owner'},callerKey:'owner',input:{},idempotencyKey:'read',payloadSha256:hash('{}'),readOnly:true,authorize:f.authorize};
  const read=()=>supervisor.invoke(readInput);
  const kill=()=>supervisor.invoke({...readInput,input:{killWorker:true},payloadSha256:hash('{"killWorker":true}')});
  async function occupy(){
    const ready=new Promise<void>(resolve=>entered=resolve);
    held=new Promise<void>(resolve=>release=resolve);
    const id=String(++occupations),input={id,value:'busy'};
    await supervisor.invoke({...readInput,scope:{...f.scope,datasetId:'other'},input,readOnly:false,idempotencyKey:id,payloadSha256:hash(JSON.stringify(input))});
    await ready;
  }
  if(mode==='busy')await occupy();
  else {
    expect(await read()).toMatchObject({revision:1,result:[{id:'one',value:'saved'}]});
    expect(onMaintenanceError).toHaveBeenCalledTimes(1);
    await expect(kill()).rejects.toMatchObject({code:'worker_budget'});
    faults=false;state.clock=5000;
  }
  return {...f,supervisor,state,read,kill,occupy,release:()=>release(),readInput};
}

it.each(['busy','blocked'] as const)("serves completed uncached replays with growing waits before reopening when maintenance is %s",async(mode)=>{
  const f=await unsavedTailFixture(mode);
  const result={revision:1,result:[{id:'one',value:'saved'}]};
  expect(await f.read()).toMatchObject(result);
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toBeNull();
  const firstWait=mode==='busy'?5000:10000;
  for(const delay of [firstWait,firstWait*2,firstWait*4]){
    // Reading the recovered worker neither replays nor clears its next-reopen wait.
    const applied=[...f.state.applied];
    expect(await f.read()).toMatchObject(result);
    await expect(f.kill()).rejects.toMatchObject({code:'worker_budget'});
    await expect(f.read()).rejects.toMatchObject({code:'dataset_reopen_wait',retryAfterMs:delay});
    expect(f.state.applied).toEqual(applied);
    f.state.clock+=delay;
    expect(await f.read()).toMatchObject(result);
    expect(f.state.applied).toEqual([...applied,1]);
    expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toBeNull();
  }
});

it("resets the uncached replay wait after a successful cache save",async()=>{
  const f=await unsavedTailFixture('busy');
  expect((await f.read()).revision).toBe(1);
  f.release();
  await vi.waitFor(()=>expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toEqual([]),workerWait);
  const input={id:'two',value:'saved'};
  await f.supervisor.invoke({...f.readInput,input,readOnly:false,idempotencyKey:'two',payloadSha256:hash(JSON.stringify(input))});
  await vi.waitFor(()=>{
    expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})?.cursor.revision).toBe(2);
    expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toEqual([]);
  },workerWait);
  await f.occupy();
  const tail={id:'three',value:'saved'};
  await f.supervisor.invoke({...f.readInput,input:tail,readOnly:false,idempotencyKey:'three',payloadSha256:hash(JSON.stringify(tail))});
  await expect(f.kill()).rejects.toMatchObject({code:'worker_budget'});
  expect(await f.read()).toMatchObject({revision:3,result:[{id:'one',value:'saved'},{id:'three',value:'saved'},{id:'two',value:'saved'}]});
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})?.cursor.revision).toBe(2);
  await expect(f.kill()).rejects.toMatchObject({code:'worker_budget'});
  const applied=[...f.state.applied];
  await expect(f.read()).rejects.toMatchObject({code:'dataset_reopen_wait',retryAfterMs:5000});
  expect(f.state.applied).toEqual(applied);
  f.state.clock+=5000;
  expect((await f.read()).revision).toBe(3);
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

it.each(['quota','seal'] as const)("returns a completed replay when its final cache fails at %s and waits before replaying again",async(stage)=>{
  const f=await fixture();
  await f.invoke({id:'1',value:'saved'});
  f.initialize('other');
  await f.supervisor.close();
  const time=vi.spyOn(performance,'now').mockReturnValue(0);
  cleanups.push(async()=>{time.mockRestore();});
  const journal=stage==='seal'?{...f.journal,async sealMaterializationCheckpoint(){throw Error('disk full');}}:f.journal;
  const onMaintenanceError=vi.fn();
  const supervisor=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers")),replayCacheMs:0,maxWorkers:1,nowMs:()=>0,
    maintenanceStorage:{authorize(){},account(){if(stage==='quota')throw Error('quota full');}},onMaintenanceError});
  cleanups.push(()=>supervisor.close());
  const read={scope:f.scope,tables:['items'],operation:'run',caller:{kind:'owner'},callerKey:'owner',input:{},idempotencyKey:'read',payloadSha256:hash('{}'),readOnly:true,authorize:f.authorize};
  expect(await supervisor.invoke(read)).toMatchObject({revision:1,result:[{id:'1',value:'saved'}]});
  expect(onMaintenanceError).toHaveBeenCalledTimes(1);
  expect(f.journal.materialization({scope:f.scope,authorize:f.authorize})).toBeNull();
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toEqual([]);
  await supervisor.invoke({...read,scope:{...f.scope,datasetId:'other'}});
  await expect(supervisor.invoke(read)).rejects.toMatchObject({code:'dataset_reopen_wait',retryAfterMs:5000});
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

it("measures benign 64-event recovery including a fully installed checkpoint",async()=>{
  const f=await fixture({
    schemaSql:schemaSql+"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<256) INSERT INTO items SELECT CAST(i AS TEXT),printf('%04096d',i) FROM n;",
    source:`globalThis.operations={run(ctx,input){if(input.write)ctx.db.execute('UPDATE items SET value=? WHERE id=?',['changed',String(input.write)]);return ctx.db.query('SELECT count(*) AS count FROM items');}}`,
  });
  for(let index=1;index<=64;index++)await f.invoke({write:index},{idempotencyKey:String(index)});
  await f.supervisor.close();
  const batches:number[]=[],snapshots:number[]=[];
  const pending=new Map<number,number>();let elapsed=0,checkpointStarted=0,checkpointMs=0;
  const realNow=performance.now.bind(performance);
  // Make the cache eligible without a wall-clock sleep or artificial CPU load.
  // The worker uses its real clock and still applies benign events in one chunk.
  const time=vi.spyOn(performance,'now').mockImplementation(()=>realNow()+elapsed);
  const launch=launcher((request,controls)=>{
    if(request.command.kind==='applyBatch'){batches.push(request.command.input.length);elapsed+=1000;}
    if(request.command.kind==='snapshot'){checkpointStarted=Date.now();pending.set(request.id,checkpointStarted);}
    controls.deliver();
  },message=>{const reply=message as {id:number;ok?:boolean};if(reply.ok&&pending.has(reply.id)){snapshots.push(Date.now()-pending.get(reply.id)!);pending.delete(reply.id);}});
  const journal={...f.journal,cacheMaterialization(input:Parameters<DatasetJournal['cacheMaterialization']>[0]){
    const result=f.journal.cacheMaterialization(input);checkpointMs=Date.now()-checkpointStarted;return result;
  }};
  const supervisor=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},replayCacheMs:1000,
    maintenanceStorage:{authorize(){},account(){}}});
  const started=Date.now();
  try{
    const result=await supervisor.invoke({scope:f.scope,tables:['items'],operation:'run',caller:{kind:'owner'},callerKey:'owner',input:{},idempotencyKey:'read',payloadSha256:hash('{}'),readOnly:true,authorize:f.authorize});
    const totalMs=Date.now()-started;
    const cached=f.journal.materialization({scope:f.scope,authorize:f.authorize})!;
    expect(result.result).toEqual([{count:256}]);expect(cached.cursor.revision).toBe(64);
    expect(batches).toEqual([64]);expect(snapshots).toHaveLength(1);
    const measurement=JSON.stringify({scenario:'benign-64-recovery',totalMs,checkpointMs,snapshotMs:snapshots[0],checkpointBytes:cached.byteLength,batches,includes:'open, replay, foreign-key check, snapshot, hashing, staging, verification, installation, read',cacheEligibility:'host clock advanced 1000 ms; worker and measured wall clock unchanged'});
    if(process.env.DOHC_RECOVERY_MEASUREMENT_PATH)await writeFile(process.env.DOHC_RECOVERY_MEASUREMENT_PATH,measurement+'\n');
  }finally{time.mockRestore();await supervisor.close();}
});


it.each([{nextCost:50,replayMs:100,saved:[1,9,11]},{nextCost:20,replayMs:100,saved:[1,9,10,11]},{nextCost:100,replayMs:100,saved:[1,9,11]},{nextCost:100,replayMs:9,saved:[]}])("spaces recovery checkpoints with $replayMs ms batches and a $nextCost ms next checkpoint",async({nextCost,replayMs,saved:expected})=>{
  const f=await fixture();
  for(let index=1;index<=11;index++)await f.invoke({id:String(index),value:'saved'},{idempotencyKey:String(index)});
  await f.supervisor.close();
  let elapsed=0,seals=0;
  const saved:number[]=[],pending=new Set<number>();
  const time=vi.spyOn(performance,'now').mockImplementation(()=>elapsed);
  cleanups.push(async()=>{time.mockRestore();});
  const launch=launcher((request,controls)=>{
    if(request.command.kind==='applyBatch')pending.add(request.id);
    controls.deliver();
  },message=>{const reply=message as {id:number;ok?:boolean};if(reply.ok&&pending.delete(reply.id))elapsed+=replayMs;});
  const journal={...f.journal,
    events(input:Parameters<DatasetJournal['events']>[0]){return f.journal.events({...input,limit:1});},
    async sealMaterializationCheckpoint(input:Parameters<DatasetJournal['sealMaterializationCheckpoint']>[0]){
      const value=await f.journal.sealMaterializationCheckpoint(input);
      elapsed+=++seals===1 ? 200 : nextCost;
      return value;
    },
    cacheMaterialization(input:Parameters<DatasetJournal['cacheMaterialization']>[0]){
      const value=f.journal.cacheMaterialization(input);saved.push(value.cursor.revision);return value;
    },
  };
  const supervisor=await createDatasetSupervisor({journal,directory: privateFolder(join(f.directory, "workers")),runtime:{launch},replayCacheMs:100,
    maintenanceStorage:{authorize(){},account(){}}});
  cleanups.push(()=>supervisor.close());
  const result=await supervisor.invoke({scope:f.scope,tables:['items'],operation:'run',caller:{kind:'owner'},callerKey:'owner',input:{},idempotencyKey:'read',payloadSha256:hash('{}'),readOnly:true,authorize:f.authorize});
  expect(result.revision).toBe(11);expect(result.result).toHaveLength(11);
  // After a 200 ms checkpoint, wait 800 ms of replay between saves.
  // Cheaper checkpoints lower that interval, bounded by replayCacheMs.
  // Save a costly replay's final tail; a 99 ms whole replay stays uncached.
  expect(saved).toEqual(expected);
});

it("holds no folder until its host gives one, then takes it once for every worker",async()=>{
  const f=await fixture(),root=join(f.directory,"later");let ready=false,asked=0,startups=0;
  const supervisor=await createDatasetSupervisor({journal:f.journal,
    directory:async()=>{asked++;if(!ready)throw new Error("The host has not prepared this folder.");await mkdir(root,{recursive:true});return root;},
    startup(){startups++;}});
  cleanups.push(()=>supervisor.close());
  expect(startups).toBe(0);
  const read={scope:f.scope,tables:["items"],operation:"run",caller:{kind:"owner" as const},callerKey:"owner",input:{},idempotencyKey:"read",payloadSha256:hash("{}"),readOnly:true,authorize:f.authorize};
  // The host's own words, with no reopen wait counted against the Collection.
  await expect(supervisor.invoke(read)).rejects.toThrow("The host has not prepared this folder.");
  await expect(supervisor.invoke(read)).rejects.toThrow("The host has not prepared this folder.");
  expect(await readdir(f.directory)).not.toContain("later");
  ready=true;await supervisor.invoke(read);await supervisor.invoke({...read,idempotencyKey:"again"});
  expect(startups).toBe(1);expect(asked).toBe(4);
  expect(await readdir(root)).toEqual(expect.arrayContaining([".dohc-worker-lock.sqlite",".dohc-worker-session.json"]));
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
