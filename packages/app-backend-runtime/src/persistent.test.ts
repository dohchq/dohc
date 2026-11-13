import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { openPersistentAppBackend } from "./persistent.ts";
import type { PersistentAppBackend, PersistentOpenInput, PersistentPrepareInput, PersistentRuntimeOptions, PreparedOperation } from "./persistent.ts";
import type { AppRuntimeLauncher } from "./protocol.ts";
import { acquireSupervisorOwnership } from "./worker-ownership.ts";

const hash=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
const initial={revision:0,digest:hash("initial")};
const scope={workspaceId:"workspace",datasetId:"dataset",hostEpoch:"epoch-1",approvedRevisionHash:hash("approved")};
const schemaSql="CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL);";
const source=`globalThis.operations={run(ctx,input){
  if(input.refuse) ctx.refuse('full','No spaces remain.');
  if(input.id) ctx.db.execute('INSERT INTO items VALUES(?,?)',[input.id,input.value]);
  return ctx.db.query('SELECT * FROM items ORDER BY id');
}}`;
function operation(expected=initial,input:PersistentPrepareInput["input"]={}):PersistentPrepareInput {
  return {source,operation:"run",input,caller:{kind:"owner"},nowMs:1000,requestId:"request",expected};
}
function event(prepared:PreparedOperation, previous=initial) {
  return {proposalId:prepared.proposalId,previousDigest:previous.digest,revision:previous.revision+1,digest:hash(previous.digest+prepared.changesetSha256),changesetSha256:prepared.changesetSha256,changeset:prepared.changeset};
}
async function fixture(run:(context:{root:string;open:(input?:Partial<PersistentOpenInput>,launch?:AppRuntimeLauncher,runtime?:Omit<PersistentRuntimeOptions,"launch">)=>Promise<PersistentAppBackend>})=>Promise<void>):Promise<void> {
  const root=await mkdtemp(join(tmpdir(),"dohc-persistent-test-"));
  const workers:PersistentAppBackend[]=[];let sequence=0;
  try {
    await run({root,async open(input={},launch,runtime={}){
      const directory=join(root,String(++sequence));await mkdir(directory);
      const worker=await openPersistentAppBackend({directory,schemaSql,tables:["items"],scope,cursor:initial,...input},{...runtime,launch});
      workers.push(worker);return worker;
    }});
  } finally {
    await Promise.all(workers.map(worker=>worker.close()));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:25});
  }
}
// Runs a stand-in script instead of the worker and reports the signal that ended it.
function scriptLauncher(script:string,ended:(signal:NodeJS.Signals|null)=>void=()=>{}):AppRuntimeLauncher {
  return options=>{
    const child=spawn(process.execPath,["-e",script],{cwd:options.cwd,env:options.env,stdio:["ignore","ignore","ignore","ipc"],windowsHide:true});
    child.on("message",options.onMessage);child.on("error",options.onError);
    child.on("close",(code,signal)=>{ended(signal);options.onExit(code);});
    return {postMessage(message){child.send(message as object);},kill(){child.kill("SIGKILL");}};
  };
}

describe("persistent dataset worker",()=>{

  it("kills a worker that is still starting when opening is cancelled",async()=>{
    await fixture(async({open})=>{
      const controller=new AbortController();
      let ended!:(signal:NodeJS.Signals|null)=>void;
      const exit=new Promise<NodeJS.Signals|null>(resolve=>{ended=resolve;});
      const launch=scriptLauncher("setInterval(()=>{},60_000)",ended);
      // The stand-in never sends ready, so only the cancellation can end this open before the 30 s startup limit.
      const opening=open({signal:controller.signal},options=>{const child=launch(options);setImmediate(()=>controller.abort(new Error("Opening was cancelled.")));return child;});
      await expect(opening).rejects.toThrow("Opening was cancelled.");
      expect(await exit).toBe("SIGKILL");
    });
  });

  it("holds its owned-directory lease until worker close and refuses expired ownership",async()=>{
    await fixture(async({root,open})=>{
      const owner=await acquireSupervisorOwnership(root);
      try {
        const directory=await owner.createDirectory();
        const worker=await open({directory,ownership:{root:owner.root,session:owner.session}});
        await expect(owner.removeDirectory(directory)).rejects.toThrow("Another copy of dohc is using this Collection folder");
        await worker.close();
        await owner.removeDirectory(directory);
        const next=await owner.createDirectory();
        await expect(open({directory:next,ownership:{root:owner.root,session:"00000000-0000-0000-0000-000000000000"}})).rejects.toThrow("earlier dohc session");
        await owner.removeDirectory(next);
      }finally{owner.close();}
    });
  });

  it("commits only after host finalization and restores checkpoint scope/cursor",async()=>{
    await fixture(async({root,open})=>{
      const worker=await open();
      const prepared=await worker.prepare(operation(initial,{id:1,value:"saved"}));
      expect(prepared.result).toEqual([{id:1,value:"saved"}]);
      await expect(worker.prepare(operation())).rejects.toMatchObject({code:"pending_operation"});
      await expect(worker.snapshot(join(root,"pending.sqlite"))).rejects.toMatchObject({code:"pending_operation"});
      const committed=event(prepared);
      await expect(worker.finalize({...committed,previousDigest:hash("wrong")})).rejects.toMatchObject({code:"stale_revision"});
      await expect(worker.finalize({...committed,changesetSha256:hash("wrong")})).rejects.toMatchObject({code:"invalid_input"});
      const cursor=await worker.finalize(committed);
      expect(cursor).toEqual({revision:1,digest:committed.digest});
      const checkpointPath=join(root,"checkpoint.sqlite");
      expect(await worker.snapshot(checkpointPath)).toEqual({path:checkpointPath,cursor});
      await expect(worker.snapshot(checkpointPath)).rejects.toThrow();
      const restored=await open({checkpointPath,cursor});
      expect((await restored.prepare({...operation(cursor),readOnly:true})).result).toEqual([{id:1,value:"saved"}]);
      await expect(open({checkpointPath,cursor,scope:{...scope,datasetId:"other"}})).rejects.toMatchObject({code:"invalid_checkpoint"});
      await expect(open({checkpointPath,cursor:{revision:2,digest:cursor.digest}})).rejects.toMatchObject({code:"invalid_checkpoint"});
    });
  });

  it("discards speculative writes and preserves structured refusal and fresh guest contexts",async()=>{
    await fixture(async({open})=>{
      const worker=await open();
      const prepared=await worker.prepare(operation(initial,{id:1,value:"discard"}));
      await worker.discard(prepared.proposalId);
      await expect(worker.prepare(operation(initial,{refuse:true}))).rejects.toMatchObject({refusal:{code:"full",message:"No spaces remain."}});
      const read=await worker.prepare({...operation(),readOnly:true});
      expect(read.readOnly).toBe(true);expect(read.result).toEqual([]);
      expect((await worker.prepare({...operation(),readOnly:true})).result).toEqual([]);
    });
  });

  it("stops an operation at its memory limit and keeps serving the dataset",async()=>{
    await fixture(async({open})=>{
      const worker=await open();
      const hoard="globalThis.operations={run(){const held=[];for(let i=0;i<64;i++)held.push(new Uint8Array(1<<20));return held.length}}";
      await expect(worker.prepare({...operation(),source:hoard})).rejects.toThrow("App operation needed more than its 24 MiB memory limit, so it stopped.");
      expect((await worker.prepare(operation(initial,{id:1,value:"after"}))).result).toEqual([{id:1,value:"after"}]);
    });
  });

  it("checks foreign keys before returning a timed prefix and closes a failed copy",async()=>{
    await fixture(async({root,open})=>{
      const sql='CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL,parent INTEGER REFERENCES parents(id));';
      const raw=new DatabaseSync(join(root,'raw.sqlite'),{enableForeignKeyConstraints:false});raw.exec(sql);
      let session=raw.createSession();raw.exec("INSERT INTO items VALUES(1,'child',1)");
      const firstChanges=session.changeset();session.close();
      session=raw.createSession();raw.exec('INSERT INTO parents VALUES(1)');
      const secondChanges=session.changeset();session.close();raw.close();
      const first={revision:1,digest:hash('first'),previousDigest:initial.digest,changeset:firstChanges,changesetSha256:hash(firstChanges)};
      const second={revision:2,digest:hash('second'),previousDigest:first.digest,changeset:secondChanges,changesetSha256:hash(secondChanges)};
      const input={schemaSql:sql,tables:['parents','items']};
      const complete=await open(input);expect(await complete.applyBatch([first,second])).toMatchObject({revision:2});
      const chunked=await open(input);
      await expect(chunked.applyBatch([first,second],0)).rejects.toMatchObject({code:'invalid_changeset'});
      await expect(chunked.snapshot(join(root,'invalid.sqlite'))).rejects.toThrow();
    });
  });

  it("kills a partially applied batch and recovers again from the authority checkpoint",async()=>{
    await fixture(async({open})=>{
      const writer=await open(),recovered=await open();
      const first=event(await writer.prepare(operation(initial,{id:1,value:'first'})));await writer.finalize(first);
      const second=event(await writer.prepare(operation(first,{id:2,value:'second'})),first);await writer.finalize(second);
      const conflict={...second,changeset:first.changeset,changesetSha256:first.changesetSha256};
      await expect(recovered.applyBatch([first,conflict])).rejects.toMatchObject({code:'invalid_changeset'});
      await expect(recovered.prepare({...operation(second),readOnly:true})).rejects.toThrow();
      const reopened=await open();await reopened.applyBatch([first,second]);
      expect((await reopened.prepare({...operation(second),readOnly:true})).result).toEqual([{id:1,value:'first'},{id:2,value:'second'}]);
    });
  });

  it("rejects internal-table changesets without partially applying admitted rows",async()=>{
    await fixture(async({open})=>{
      const worker=await open();
      const untrusted=new DatabaseSync(":memory:");
      try {
        untrusted.exec(schemaSql+"CREATE TABLE dohc_applied(id INTEGER PRIMARY KEY, scope TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL);");
        const session=untrusted.createSession();
        try {
          untrusted.exec("INSERT INTO items VALUES(1,'untrusted'); INSERT INTO dohc_applied VALUES(2,'wrong',9,'wrong')");
          const changeset=session.changeset();
          await expect(worker.apply({revision:1,previousDigest:initial.digest,digest:hash("bad"),changeset,changesetSha256:hash(changeset)})).rejects.toMatchObject({code:"invalid_changeset"});
        } finally {session.close();}
      } finally {untrusted.close();}
      expect((await worker.prepare({...operation(),readOnly:true})).result).toEqual([]);
    });
  });

  it("preserves generated columns, bigint values and primary-key semantics during shadow replay",async()=>{
    await fixture(async({open})=>{
      for(const [primary,keyA,keyB] of [
        ["INTEGER PRIMARY KEY","9223372036854775806","9223372036854775807"],
      ]) {
        const schemaSql=`CREATE TABLE items(id ${primary}, generated TEXT GENERATED ALWAYS AS (value || '!') STORED,value TEXT NOT NULL UNIQUE,large INTEGER NOT NULL);
          INSERT INTO items(id,value,large) VALUES(${keyA},'a',9223372036854775806),(${keyB},'b',9223372036854775807);`;
        const writer=await open({schemaSql}),recovered=await open({schemaSql});
        const prepared=await writer.prepare({...operation(),source:`globalThis.operations={run(ctx){
          ctx.db.execute("UPDATE items SET value='temp' WHERE id=${keyA}");
          ctx.db.execute("UPDATE items SET value='a' WHERE id=${keyB}");
          ctx.db.execute("UPDATE items SET value='b' WHERE id=${keyA}");return true;}}`});
        const cursor=await recovered.apply(event(prepared));
        const read=await recovered.prepare({...operation(cursor),readOnly:true,source:"globalThis.operations={run(ctx){return ctx.db.query('SELECT CAST(id AS TEXT) AS id,value,generated,CAST(large AS TEXT) AS large FROM items ORDER BY id')}}"});
        expect(read.result).toEqual([
          {id:keyA.replaceAll("'",""),value:"b",generated:"b!",large:"9223372036854775806"},
          {id:keyB.replaceAll("'",""),value:"a",generated:"a!",large:"9223372036854775807"},
        ]);
      }
    });
  });

  it("aborts a prepared transaction and waits for process exit before cleanup",async()=>{
    await fixture(async({root,open})=>{
      const worker=await open();
      await worker.prepare(operation(initial,{id:1,value:"not committed"}));
      await worker.abort("Authority revoked.");
      await expect(worker.prepare(operation())).rejects.toMatchObject({code:"worker_aborted"});
      const database=new DatabaseSync(join(root,"1","app.sqlite"));
      try {
        expect(database.prepare("SELECT * FROM items").all()).toEqual([]);
        expect(database.prepare("SELECT revision FROM dohc_applied").get()?.revision).toBe(0);
      } finally {database.close();}
    });
  });

  it("migrates a disposable copy and opens its marker-free checkpoint under a new approved revision",async()=>{
    await fixture(async({root,open})=>{
      const worker=await open();
      const prepared=await worker.prepare(operation(initial,{id:1,value:"existing"}));
      const cursor=await worker.finalize(event(prepared));
      const nextSchema="CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new');";
      const path=join(root,"migrated.sqlite");
      expect(await worker.migrateCheckpoint({path,schemaSql:nextSchema,tables:["items"],migrationSql:"ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'new';"})).toEqual({path,cursor});
      const checkpoint=new DatabaseSync(path);
      try {expect(checkpoint.prepare("SELECT name FROM sqlite_schema WHERE name='dohc_applied'").all()).toEqual([]);}finally{checkpoint.close();}
      expect((await worker.prepare({...operation(cursor),readOnly:true})).result).toEqual([{id:1,value:"existing"}]);
      const nextCursor={revision:cursor.revision+1,digest:hash("transition")};
      const next=await open({checkpointPath:path,cursor:nextCursor,schemaSql:nextSchema,scope:{...scope,hostEpoch:"epoch-2",approvedRevisionHash:hash(nextSchema)}});
      expect((await next.prepare({...operation(nextCursor),readOnly:true})).result).toEqual([{id:1,value:"existing",status:"new"}]);
    });
  });

  it.each([
    "ATTACH DATABASE ':memory:' AS escape",
    "DROP TABLE items",
    "UPDATE items SET value='changed'; CREATE TABLE escape(id INTEGER PRIMARY KEY)",
  ])("refuses unsafe or mismatched migration without changing live data: %s",async migrationSql=>{
    await fixture(async({root,open})=>{
      const worker=await open();
      const prepared=await worker.prepare(operation(initial,{id:1,value:"original"}));const cursor=await worker.finalize(event(prepared));
      const path=join(root,"refused.sqlite");
      await expect(worker.migrateCheckpoint({path,schemaSql,tables:["items"],migrationSql})).rejects.toThrow();
      await expect(readFile(path)).rejects.toMatchObject({code:"ENOENT"});
      expect((await worker.prepare({...operation(cursor),readOnly:true})).result).toEqual([{id:1,value:"original"}]);
    });
  });

  it("ends native SQL at its CPU budget and requires journal recovery instead of silently restarting",async()=>{
    await fixture(async({open})=>{
      const worker=await open({limits:{cpuBudgetMs:1000,evaluationMs:100}});
      const expensive={...operation(),readOnly:true,source:`globalThis.operations={run(ctx){return ctx.db.query('WITH RECURSIVE count(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM count WHERE x<1000000000) SELECT sum(x) FROM count')}}`};
      await expect(worker.prepare(expensive)).rejects.toMatchObject({code:"worker_budget",
        message:"The app's code ran too long: it used more than 1 s of CPU time while running the Collection action. Try again."});
      await expect(worker.prepare({...operation(),readOnly:true})).rejects.toMatchObject({code:"worker_budget"});
      await worker.close();
      const recovered=await open();
      expect((await recovered.prepare({...operation(),readOnly:true})).result).toEqual([]);
    });
  });

  // Short SQLite work can register zero CPU ticks on a loaded Windows host.
  // Compute a costly index per row so replay and integrity checks exceed that granularity.
  const cpuBudgetSchema="CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE INDEX items_heavy ON items(length(printf('%.200000c',value)));";

  const insertRows=(from:number,to:number)=>`globalThis.operations={run(ctx){
    ctx.db.execute("INSERT INTO items SELECT x, 'value' FROM (WITH RECURSIVE n(x) AS (VALUES(${from}) UNION ALL SELECT x+1 FROM n WHERE x<${to}) SELECT x FROM n)");return 1}}`;

  it("ends a dataset check at its own CPU budget and names it",async()=>{
    await fixture(async({root,open})=>{
      const writer=await open({schemaSql:cpuBudgetSchema});
      const cursor=await writer.finalize(event(await writer.prepare({...operation(),source:insertRows(1,1_000)})));
      const checkpointPath=join(root,"heavy.sqlite");await writer.snapshot(checkpointPath);
      // The integrity check at open computes the index for every row.
      await expect(open({schemaSql:cpuBudgetSchema,checkpointPath,cursor,limits:{datasetCheckCpuMs:1,datasetCheckCpuMsPerMiB:1}})).rejects.toMatchObject({code:"worker_budget",
        message:expect.stringMatching(/^dohc's checks of this Collection ran too long: they used more than \d+ ms of CPU time while checking the tables\. Try again\.$/)});
      await expect(open({schemaSql:cpuBudgetSchema,checkpointPath,cursor})).resolves.toBeDefined();
    });
  },60_000);

  it("recovers a commit whose acknowledgement was lost",async()=>{
    await fixture(async({root,open})=>{
      let finalizeId:number|undefined;
      const launch:AppRuntimeLauncher=options=>{
        const child=spawn(process.execPath,[options.entryPath],{cwd:options.cwd,env:options.env,stdio:["ignore","ignore","ignore","ipc"],serialization:"advanced",windowsHide:true});
        child.on("message",message=>{
          if(finalizeId!==undefined && (message as {id?:number}).id===finalizeId) child.kill("SIGKILL");
          else options.onMessage(message);
        });
        child.on("error",options.onError);child.on("close",options.onExit);
        return {postMessage(message){const request=message as {id:number;command:{kind:string}};if(request.command.kind==="finalize") finalizeId=request.id;child.send(message as object);},kill(){child.kill("SIGKILL");}};
      };
      const worker=await open({},launch);
      const checkpointPath=join(root,"before.sqlite");await worker.snapshot(checkpointPath);
      const prepared=await worker.prepare(operation(initial,{id:1,value:"committed"}));
      const committed=event(prepared);
      await expect(worker.finalize(committed)).rejects.toMatchObject({code:"worker_stopped"});
      const recovered=await open({checkpointPath});
      const cursor=await recovered.apply(committed);
      expect((await recovered.prepare({...operation(cursor),readOnly:true})).result).toEqual([{id:1,value:"committed"}]);
      expect((await readFile(checkpointPath)).byteLength).toBeGreaterThan(100);
    });
  });
});

it("bounds each operation's SQL tables while retaining the full schema for recovery", async () => {
  await fixture(async ({ open }) => {
    const worker = await open({ schemaSql: schemaSql + " CREATE TABLE other(ROWID INTEGER PRIMARY KEY,value TEXT NOT NULL);", tables: ["items", "other"] });
    const read = { ...operation(), readOnly: true, tables: ["items"], source: "globalThis.operations={run(ctx,input){return ctx.db.query(input.sql);}}" };
    await expect(worker.prepare({ ...read, input: { sql: "SELECT * FROM other" } })).rejects.toThrow();
    await expect(worker.prepare({ ...read, input: { sql: "SELECT * FROM items" } })).resolves.toMatchObject({ result: [] });
    await expect(worker.prepare({ ...read, tables: ["items", "other"], input: { sql: "SELECT ROWID,value FROM other" } })).resolves.toMatchObject({ result: [] });
    await expect(worker.prepare({ ...read, tables: ["missing"], input: {} })).rejects.toThrow("exceed");
  });
});
