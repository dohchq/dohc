import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDatasetJournal, type DatasetJournal } from "./journal.ts";
import { createDatasetSupervisor, type DatasetInvocation, type DatasetMigration, type DatasetSupervisorOptions } from "./supervisor.ts";
import type { AppRuntimeLauncher } from "./protocol.ts";

vi.setConfig({ testTimeout: 30_000 });
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

async function fixture(options: { transform?: (journal: DatasetJournal) => DatasetJournal; launch?: AppRuntimeLauncher; maxWorkers?: number; schemaSql?:string; source?:string; tables?:string[];migrationStorage?:DatasetSupervisorOptions["migrationStorage"];nowMs?:()=>number } = {}) {
  const approvedSchema=options.schemaSql ?? schemaSql, approvedSource=options.source ?? source;
  const directory = await mkdtemp(join(tmpdir(), "dohc-supervisor-"));
  const seed = new DatabaseSync(join(directory, "seed.sqlite")); seed.exec(approvedSchema); seed.close();
  const checkpoint = await readFile(join(directory, "seed.sqlite"));
  const db = new DatabaseSync(join(directory, "authority.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE grants(allowed INTEGER); INSERT INTO grants VALUES(1); CREATE TABLE files(attached INTEGER); INSERT INTO files VALUES(0);");
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
    directory: join(directory, "workers"), runtime: { launch: options.launch }, maxWorkers: options.maxWorkers,migrationStorage:options.migrationStorage,nowMs:options.nowMs });
  cleanups.push(async () => { await supervisor.close(); db.close(); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); });
  function invoke(input: DatasetInvocation["input"] = {}, overrides: Partial<DatasetInvocation> = {}) {
    return supervisor.invoke({ scope, tables: options.tables ?? ["items"], operation: "run", caller: { kind: "owner" }, callerKey: "owner", input,
      idempotencyKey: "retry", payloadSha256: hash(JSON.stringify(input)), readOnly: false, authorize, ...overrides });
  }
  return { db, journal, supervisor, invoke, scope, authorize, initialize };
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
  const f=await fixture({migrationStorage:{authorize(){},account({bytes}){reserved+=bytes;}},launch:launcher((command,controls)=>{if(command.command.kind==="migrateCheckpoint")executions++;controls.deliver();})});
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
  expect(()=>f.supervisor.migrationPreviewPage(access)).toThrow("unavailable");
});

it("rejects changed owner and stale data and replaces a discarded candidate without leaks",async()=>{
  let balance=0;
  const f=await fixture({migrationStorage:{authorize(){},account({bytes}){balance+=bytes;}}});
  await f.invoke({id:"one",value:"original"});
  const candidate=await f.supervisor.prepareMigration({...migration(f),authorityKey:"owner-v1"});
  const access={scope:f.scope,tables:["items"],candidateId:candidate.candidateId,authorityKey:"owner-v1",authorize:f.authorize};
  expect(()=>f.supervisor.migrationPreviewPage({...access,authorityKey:"other"})).toThrow("unavailable");
  await f.invoke({id:"two",value:"changed"},{idempotencyKey:"second"});
  await expect(f.supervisor.approveMigration({...access,checkpointSha256:candidate.checkpointSha256})).rejects.toThrow("Dataset changed");
  const replacement=await f.supervisor.prepareMigration({...migration(f),authorityKey:"owner-v1"});
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toHaveLength(2);
  await f.supervisor.discardMigration({...access,candidateId:replacement.candidateId});expect(balance).toBe(0);
  expect(f.journal.checkpointStages({workspaceId:f.scope.workspaceId,authorize:f.authorize})).toEqual([]);
});

it("refuses an expired preview and releases its reservation on explicit discard",async()=>{
  let now=100,balance=0;
  const f=await fixture({nowMs:()=>now,migrationStorage:{authorize(){},account({bytes}){balance+=bytes;}}});
  const candidate=await f.supervisor.prepareMigration({...migration(f),authorityKey:"owner"});now=candidate.expiresAtMs;
  const access={scope:f.scope,tables:["items"],candidateId:candidate.candidateId,authorityKey:"owner",authorize:f.authorize};
  expect(()=>f.supervisor.migrationPreviewPage(access)).toThrow("expired");
  await f.supervisor.discardMigration(access);expect(balance).toBe(0);
});

function launcher(hook: (command: any, controls: { stop(): void; deliver(): void }) => void): AppRuntimeLauncher {
  return options => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", options.entryPath], {
      cwd: options.cwd, env: options.env, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", windowsHide: true,
    });
    child.on("error", options.onError); child.on("close", options.onExit); child.on("message", options.onMessage);
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
  await expect(f.invoke({}, {readOnly:true})).rejects.toThrow('checkpoint is invalid');expect(launches).toBe(0);
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
  await expect(f.invoke({parent:false})).rejects.toThrow("foreign-key");
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
  await expect(f.invoke({ id: "once", value: "changed" })).rejects.toThrow("another payload");
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
