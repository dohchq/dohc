import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { openPersistentAppBackend } from "./persistent.ts";
import type { PersistentAppBackend, PersistentOpenInput, PersistentPrepareInput, PersistentRuntimeOptions, PreparedOperation } from "./persistent.ts";
import type { AppRuntimeLauncher } from "./protocol.ts";
import { acquireSupervisorOwnership } from "./worker-ownership.ts";
import { armBudget, BUDGET_STATE_SLOTS, disarmBudget } from "./budget-watch.ts";

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
  it("keeps an over-budget step armed when it finishes before the watch polls",()=>{
    const state=new BigInt64Array(new SharedArrayBuffer(BUDGET_STATE_SLOTS*8));
    const section=armBudget(state,1n,10_000n,1_000n);
    expect(disarmBudget(state,section,12_000n)).toBe(false);
    expect(Atomics.load(state,0)).toBe(section);
  });
  it("fails the open when the worker exits before it is ready",async()=>{
    await fixture(async({open})=>{
      await expect(open({},scriptLauncher("process.exit(1)"))).rejects.toMatchObject({code:"worker_stopped"});
    });
  });
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
  it("releases its private directory before the closed worker process exits",async()=>{
    await fixture(async({root,open})=>{
      const directory=join(root,"removable");await mkdir(directory);
      let removed=false,removalError:unknown;
      const launch:AppRuntimeLauncher=options=>{
        let closeId:number|undefined;
        const child=spawn(process.execPath,[options.entryPath],{cwd:options.cwd,env:options.env,stdio:["ignore","ignore","ignore","ipc"],serialization:"advanced",windowsHide:true});
        child.on("message",message=>{
          const reply=message as {id:number;ok:boolean};
          if(reply.id!==closeId||!reply.ok){options.onMessage(message);return;}
          // The worker has closed SQLite and its lease, but still owns its process cwd until the parent kills it.
          expect(child.exitCode).toBeNull();
          void rm(directory,{recursive:true,force:true}).then(()=>{removed=true;options.onMessage(message);},error=>{removalError=error;options.onError(error);});
        });
        child.on("error",options.onError);child.on("close",options.onExit);
        return {postMessage(message){const request=message as {id:number;command:{kind:string}};if(request.command.kind==="close")closeId=request.id;child.send(message as object);},kill(){child.kill("SIGKILL");}};
      };
      const worker=await open({directory},launch);
      await worker.close();
      expect(removalError).toBeUndefined();
      expect(removed).toBe(true);
    });
  });
  it("preserves an existing migration report destination when exclusive creation fails",async()=>{
    await fixture(async({root,open})=>{
      const worker=await open(),reportPath=join(root,"existing.jsonl");await writeFile(reportPath,"preserve this");
      await expect(worker.migrateCheckpoint({path:join(root,"output.sqlite"),reportPath,schemaSql,tables:["items"],migrationSql:"SELECT 1;"})).rejects.toThrow();
      expect(await readFile(reportPath,"utf8")).toBe("preserve this");
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
  it("refuses AUTOINCREMENT state that SQLite changesets cannot replay",async()=>{
    await fixture(async({open})=>{
      await expect(open({schemaSql:"CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT NOT NULL);"})).rejects.toMatchObject({code:"invalid_schema",message:expect.stringContaining("AUTOINCREMENT")});
    });
  });
  it("denies implicit rowid aliases but retains declared INTEGER PRIMARY KEY identity",async()=>{
    await fixture(async({open})=>{
      const worker=await open({schemaSql:"CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT); INSERT INTO items VALUES('id','value');"});
      for(const alias of ["rowid","_rowid_","oid"]) {
        await expect(worker.prepare({...operation(),readOnly:true,source:`globalThis.operations={run(ctx){return ctx.db.query('SELECT ${alias} FROM items')}}`})).rejects.toThrow();
        await expect(worker.prepare({...operation(),source:`globalThis.operations={run(ctx){return ctx.db.execute(\"INSERT INTO items(${alias},id,value) VALUES(100,'new','value')\")}}`})).rejects.toThrow();
      }
      await expect(open({schemaSql:"CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,ROWID TEXT);"})).rejects.toMatchObject({code:"invalid_schema"});
      await expect(open({schemaSql:"CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT CHECK(rowid<2 OR value=''));"})).rejects.toMatchObject({code:"invalid_schema"});
      const literal=await open({schemaSql:"CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT CHECK(value!='rowid') DEFAULT 'oid');"});
      expect((await literal.prepare({...operation(),readOnly:true})).result).toEqual([]);
      await expect(open({schemaSql:"CREATE TABLE Items(id INTEGER PRIMARY KEY,value TEXT);"})).rejects.toMatchObject({code:"invalid_schema"});
      await expect(open({schemaSql:"CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT); CREATE TRIGGER hidden_row AFTER INSERT ON items BEGIN INSERT INTO items(rowid,id,value) VALUES(100,'other','value'); END;"})).rejects.toMatchObject({code:"invalid_schema"});
      const captured=await open({schemaSql:"CREATE TABLE items(ROWID INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(42,'value');"});
      expect((await captured.prepare({...operation(),readOnly:true,source:"globalThis.operations={run(ctx){return ctx.db.query('SELECT oid AS id FROM items')}}"})).result).toEqual([{id:42}]);
      const explicit=await captured.prepare({...operation(),source:"globalThis.operations={run(ctx){return ctx.db.execute(\"INSERT INTO items(ROWID,value) VALUES(43,'next')\")}}"});
      expect(explicit.result).toEqual({changes:1});await captured.discard(explicit.proposalId);
      for(const sql of [
        "WITH c AS (SELECT 1) INSERT OR IGNORE INTO main.items AS target (\"rowid\",id,value) VALUES(100,'new','value')",
        "REPLACE INTO 'items' ('oid',id,value) VALUES(100,'new','value')",
        "INSERT/**/INTO [items] (`_rowid_`,id,value) VALUES(100,'new','value')",
        "UPDATE items SET rowid=100 WHERE id='id'",
      ]) await expect(worker.prepare({...operation(),source:`globalThis.operations={run(ctx){return ctx.db.execute(${JSON.stringify(sql)})}}`})).rejects.toThrow();
    });
  });
  it.each(["rowid","\"oid\"","[_rowid_]","items.'rowid'","items./* alias */'oid'","items.'_rowid_'"])("rejects implicit %s in schema predicates without matching literal text",async alias=>{
    await fixture(async({open})=>{
      await expect(open({schemaSql:`CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT CHECK((${alias} < 2) OR value='rowid'));`})).rejects.toMatchObject({code:"invalid_schema"});
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

  it("replays committed changesets without evaluating source and refuses out-of-order events",async()=>{
    await fixture(async({open})=>{
      const writer=await open(),recovered=await open();
      const prepared=await writer.prepare(operation(initial,{id:1,value:"journal"}));
      const committed=event(prepared);
      await writer.discard(prepared.proposalId);
      await expect(recovered.apply({...committed,revision:2})).rejects.toMatchObject({code:"stale_revision"});
      const cursor=await recovered.apply(committed);
      await expect(recovered.apply(committed)).rejects.toMatchObject({code:"stale_revision"});
      expect((await recovered.prepare({...operation(cursor),readOnly:true})).result).toEqual([{id:1,value:"journal"}]);
    });
  });

  it("replays a bounded batch in order and retains constraints for later writes",async()=>{
    await fixture(async({open})=>{
      const writer=await open(),recovered=await open();
      const first=event(await writer.prepare(operation(initial,{id:1,value:'first'})));await writer.finalize(first);
      const second=event(await writer.prepare(operation(first,{id:2,value:'second'})),first);await writer.finalize(second);
      expect(await recovered.applyBatch([first,second])).toEqual({revision:2,digest:second.digest});
      expect((await recovered.prepare({...operation(second),readOnly:true})).result).toEqual([{id:1,value:'first'},{id:2,value:'second'}]);
      const third=await recovered.prepare(operation(second,{id:3,value:'third'}));
      expect(third.result).toHaveLength(3);await recovered.discard(third.proposalId);
      await expect(recovered.applyBatch([])).rejects.toMatchObject({code:'invalid_input'});
      await expect(recovered.applyBatch(Array(65).fill(second))).rejects.toMatchObject({code:'invalid_input'});
      await expect(recovered.applyBatch([second,first])).rejects.toMatchObject({code:'invalid_input'});
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

  it("refuses SQL with no statement, which would crash the worker process",async()=>{
    await fixture(async({open})=>{
      // node:sqlite in Node 24.16 crashes the process after it prepares text with no statement between failed prepares.
      let exited!:(status:[number|null,NodeJS.Signals|null])=>void;
      const exit=new Promise<[number|null,NodeJS.Signals|null]>(resolve=>{exited=resolve;});
      const launch:AppRuntimeLauncher=options=>{
        const child=spawn(process.execPath,[options.entryPath],{cwd:options.cwd,env:options.env,stdio:["ignore","ignore","ignore","ipc"],serialization:"advanced",windowsHide:true});
        child.on("message",options.onMessage);child.on("error",options.onError);
        child.on("close",(code,signal)=>{exited([code,signal]);options.onExit(code);});
        return {postMessage(message){child.send(message as object);},kill(){child.kill("SIGKILL");}};
      };
      const worker=await open({},launch);
      const empty=["", " \t\r\n", ";", " ; ;", "-- note", "-- note\rSELECT 1", "/* note */", "/* unfinished", "\0SELECT 1",
        "\uFEFF", "\uFEFF;-- note", " \uFEFF/* note */;\uFEFF"];
      // Each input's own outcome, so one that reaches SQLite shows. Five rounds of 24 queries stay under the 128-statement limit.
      const source=`globalThis.operations={run(ctx){
        const inputs=${JSON.stringify(empty)}, outcomes=inputs.map(()=>[]);
        for(let round=0;round<5;round++) inputs.forEach((sql,index)=>{
          try { (round%2 ? ctx.db.execute : ctx.db.query)(sql); outcomes[index].push('prepared'); }
          catch (error) { outcomes[index].push(error.message); }
          try { ctx.db.query('SELECT missing FROM items'); } catch {}
        });
        return outcomes;
      }}`;
      const results=[];
      for(let round=0;round<4;round++) results.push((await worker.prepare({...operation(),source,readOnly:true})).result);
      await worker.close();
      const [code,signal]=await exit;
      // The host ends a closed worker. A crash ends it with an access violation or SIGSEGV instead.
      expect({ended:code===0||signal==="SIGKILL",code,signal}).toMatchObject({ended:true});
      const refused=Array.from({length:5},()=>"SQL statement is empty.");
      expect(results).toEqual(Array.from({length:4},()=>empty.map(()=>refused)));
    });
  });

  it("replays captured trigger effects exactly once",async()=>{
    await fixture(async({open})=>{
      const config={schemaSql:schemaSql+`CREATE TABLE audit(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id));
        CREATE TRIGGER item_added AFTER INSERT ON items BEGIN INSERT INTO audit(item_id) VALUES(new.id); END;`,tables:["items","audit"]};
      const writer=await open(config),recovered=await open(config);
      const prepared=await writer.prepare(operation(initial,{id:1,value:"trigger"}));
      const committed=event(prepared);
      await writer.discard(prepared.proposalId);
      const cursor=await recovered.apply(committed);
      const read=await recovered.prepare({...operation(cursor),readOnly:true,source:"globalThis.operations={run(ctx){return ctx.db.query('SELECT * FROM audit')}}"});
      expect(read.result).toEqual([{id:1,item_id:1}]);
    });
  });

  it("replays a valid unique-value swap through a constraint-free shadow",async()=>{
    await fixture(async({open})=>{
      const config={schemaSql:"CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL UNIQUE); INSERT INTO items VALUES(1,'a'),(2,'b'); CREATE TABLE unrelated(id ANY PRIMARY KEY NOT NULL,value ANY) STRICT, WITHOUT ROWID; INSERT INTO unrelated VALUES('000456','000123');",tables:["items","unrelated"]};
      const writer=await open(config),recovered=await open(config);
      const prepared=await writer.prepare({...operation(),source:"globalThis.operations={run(ctx){ctx.db.execute(\"UPDATE items SET value='temp' WHERE id=1\");ctx.db.execute(\"UPDATE items SET value='a' WHERE id=2\");ctx.db.execute(\"UPDATE items SET value='b' WHERE id=1\");return true}}"});
      const committed=event(prepared);await writer.discard(prepared.proposalId);
      const cursor=await recovered.apply(committed);
      const read=await recovered.prepare({...operation(cursor),readOnly:true,source:"globalThis.operations={run(ctx){return ctx.db.query('SELECT * FROM items ORDER BY id')}}"});
      expect(read.result).toEqual([{id:1,value:"b"},{id:2,value:"a"}]);
      const unrelated=await recovered.prepare({...operation(cursor),readOnly:true,source:"globalThis.operations={run(ctx){return ctx.db.query('SELECT id,value,typeof(id) AS idType,typeof(value) AS valueType FROM unrelated')}}"});
      expect(unrelated.result).toEqual([{id:"000456",value:"000123",idType:"text",valueType:"text"}]);
    });
  });

  it("preserves generated columns, bigint values and primary-key semantics during shadow replay",async()=>{
    await fixture(async({open})=>{
      for(const [primary,keyA,keyB] of [
        ["INTEGER PRIMARY KEY","9223372036854775806","9223372036854775807"],
        ["INTEGER PRIMARY KEY DESC NOT NULL","1","2"],
        ["TEXT COLLATE NOCASE PRIMARY KEY NOT NULL","'A'","'B'"],
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

  it("replays foreign-key cascades and preserves constraints for the next operation",async()=>{
    await fixture(async({open})=>{
      const config={schemaSql:schemaSql+`CREATE TABLE children(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON UPDATE CASCADE ON DELETE CASCADE);
        INSERT INTO items VALUES(1,'parent'); INSERT INTO children VALUES(1,1);`,tables:["items","children"]};
      const writer=await open(config),recovered=await open(config);
      const prepared=await writer.prepare({...operation(),source:"globalThis.operations={run(ctx){return ctx.db.execute('UPDATE items SET id=2 WHERE id=1')}}"});
      const cursor=await recovered.apply(event(prepared));
      const read=await recovered.prepare({...operation(cursor),readOnly:true,source:"globalThis.operations={run(ctx){return ctx.db.query('SELECT * FROM children')}}"});
      expect(read.result).toEqual([{id:1,item_id:2}]);
      await expect(recovered.prepare({...operation(cursor),source:"globalThis.operations={run(ctx){return ctx.db.execute('INSERT INTO children VALUES(2,99)')}}"})).rejects.toThrow();
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

  it("opens a dataset above the old snapshot cap within its separate reservation",async()=>{
    await fixture(async({root,open})=>{
      const worker=await open({schemaSql:schemaSql+"INSERT INTO items VALUES(1,hex(zeroblob(9*1024*1024)));"});
      expect((await worker.prepare({...operation(),readOnly:true,source:"globalThis.operations={run(ctx){return ctx.db.query('SELECT length(value) AS bytes FROM items')}}"})).result).toEqual([{bytes:18*1024*1024}]);
      const checkpointPath=join(root,"large.sqlite");
      await worker.snapshot(checkpointPath);
      await expect(open({checkpointPath,databaseBytes:16*1024*1024})).rejects.toMatchObject({code:"invalid_checkpoint"});
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

  it("normalizes a checkpoint without changing its rows or live cursor",async()=>{
    await fixture(async({root,open})=>{
      const worker=await open();const path=join(root,"normalized.sqlite");
      const result=await worker.migrateCheckpoint({path,schemaSql,tables:["items"],migrationSql:""});
      expect(result.cursor).toEqual(initial);
      const next=await open({checkpointPath:path,scope:{...scope,hostEpoch:"epoch-2"}});
      expect((await next.prepare({...operation(),readOnly:true})).result).toEqual([]);
    });
  });

  it("reopens an accepted connection-dependent CHECK without rerunning its decision",async()=>{
    await fixture(async({root,open})=>{
      const schemaSql="CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL CHECK(total_changes()=1));";
      const writer=await open({schemaSql});
      const prepared=await writer.prepare(operation(initial,{id:1,value:"accepted"}));
      const cursor=await writer.finalize(event(prepared));
      const checkpointPath=join(root,"accepted-check.sqlite");await writer.snapshot(checkpointPath);
      const recovered=await open({schemaSql,cursor,checkpointPath});
      expect((await recovered.prepare({...operation(cursor),readOnly:true})).result).toEqual([{id:1,value:"accepted"}]);
      await expect(recovered.prepare(operation(cursor,{id:2,value:"next"}))).rejects.toThrow();
    });
  });

  it.each([
    "ATTACH DATABASE ':memory:' AS escape",
    "PRAGMA writable_schema=ON",
    "SELECT load_extension('escape')",
    "CREATE TEMP TRIGGER escape AFTER INSERT ON main.items BEGIN DELETE FROM items; END",
    "CREATE VIEW escape AS SELECT * FROM items",
    "CREATE TABLE dohc_applied(id INTEGER PRIMARY KEY)",
    "DROP TABLE items",
    "UPDATE items SET value='changed'; CREATE TABLE escape(id INTEGER PRIMARY KEY)",
    "CREATE TABLE migration_00000000000000000000000000000000 AS SELECT * FROM items",
    "SELECT * FROM migration_00000000000000000000000000000000",
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

  it("admits leading-underscore table identifiers through schema, guest and migration",async()=>{
    await fixture(async({root,open})=>{
      const schemaSql="CREATE TABLE _items(id INTEGER PRIMARY KEY, value TEXT NOT NULL);";
      const worker=await open({schemaSql,tables:["_items"]});
      const prepared=await worker.prepare({...operation(),source:"globalThis.operations={run(ctx){return ctx.db.execute(\"INSERT INTO _items VALUES(1,'value')\")}}"});
      const cursor=await worker.finalize(event(prepared));
      const path=join(root,"underscore.sqlite");
      await worker.migrateCheckpoint({path,schemaSql,tables:["_items"],migrationSql:"UPDATE _items SET value='updated'"});
      const next=await open({schemaSql,tables:["_items"],checkpointPath:path,cursor});
      const read=await next.prepare({...operation(cursor),readOnly:true,source:"globalThis.operations={run(ctx){return ctx.db.query('SELECT * FROM _items')}}"});
      expect(read.result).toEqual([{id:1,value:"updated"}]);
    });
  });

  it("ends a migration whose native SQL exceeds its CPU budget without changing the live database",async()=>{
    await fixture(async({root,open})=>{
      const worker=await open({limits:{cpuBudgetMs:1000}});
      await expect(worker.migrateCheckpoint({path:join(root,"timeout.sqlite"),schemaSql,tables:["items"],
        migrationSql:"INSERT INTO items VALUES(1,'copy only'); WITH RECURSIVE count(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM count WHERE x<1000000000) SELECT sum(x) FROM count;"}))
        .rejects.toMatchObject({code:"worker_budget"});
      await worker.close();
      const live=new DatabaseSync(join(root,"1","app.sqlite"));
      try {
        expect(live.prepare("SELECT * FROM items").all()).toEqual([]);
        expect(live.prepare("SELECT revision FROM dohc_applied").get()?.revision).toBe(0);
      }finally{live.close();}
      await expect(readFile(join(root,"timeout.sqlite"))).rejects.toMatchObject({code:"ENOENT"});
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

  it("bounds queued work and expires queued operations without consuming their execution budget",async()=>{
    await fixture(async({open})=>{
      const worker=await open({limits:{cpuBudgetMs:1000},queueDeadlineMs:40});
      for(let index=0;index<70;index++) await expect(worker.prepare(operation(initial,{value:"x".repeat(70_000)}))).rejects.toThrow();
      const active=worker.prepare({...operation(),readOnly:true,source:`globalThis.operations={run(ctx){return ctx.db.query('WITH RECURSIVE count(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM count WHERE x<1000000000) SELECT sum(x) FROM count')}}`}).catch(error=>error);
      const queued=Array.from({length:64},()=>worker.prepare({...operation(),readOnly:true}).catch(error=>error));
      const results=await Promise.all(queued);
      expect(results.filter(result=>result.code==="queue_full")).toHaveLength(1);
      expect(results.filter(result=>result.code==="queue_deadline")).toHaveLength(63);
      expect(await active).toMatchObject({code:"worker_budget"});
    });
  });

  // Short SQLite work can register zero CPU ticks on a loaded Windows host.
  // Compute a costly index per row so replay and integrity checks exceed that granularity.
  const cpuBudgetSchema="CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE INDEX items_heavy ON items(length(printf('%.200000c',value)));";

  it("charges a journal replay's app work to the CPU budget",async()=>{
    await fixture(async({open})=>{
      const writer=await open({schemaSql:cpuBudgetSchema});
      const prepared=await writer.prepare({...operation(),source:insertRows(1,20_000)});
      const committed=event(prepared);
      await expect((await open({schemaSql:cpuBudgetSchema,limits:{cpuBudgetMs:1}})).apply(committed)).rejects.toMatchObject({code:"worker_budget",
        message:"The app's code ran too long: it used more than 1 ms of CPU time while reapplying a saved change. Try again."});
      await expect((await open({schemaSql:cpuBudgetSchema})).apply(committed)).resolves.toMatchObject({revision:1});
    });
  },60_000);

  // Each row costs this index about 10 µs of CPU to compute.
  const heavySchema="CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE INDEX items_heavy ON items(length(printf('%.20000c',value)));";
  const insertRows=(from:number,to:number)=>`globalThis.operations={run(ctx){
    ctx.db.execute("INSERT INTO items SELECT x, 'value' FROM (WITH RECURSIVE n(x) AS (VALUES(${from}) UNION ALL SELECT x+1 FROM n WHERE x<${to}) SELECT x FROM n)");return 1}}`;

  it("ends a dataset check at its own CPU budget and names it",async()=>{
    await fixture(async({root,open})=>{
      const writer=await open({schemaSql:cpuBudgetSchema});
      const cursor=await writer.finalize(event(await writer.prepare({...operation(),source:insertRows(1,20_000)})));
      const checkpointPath=join(root,"heavy.sqlite");await writer.snapshot(checkpointPath);
      // The integrity check at open computes the index for every row.
      await expect(open({schemaSql:cpuBudgetSchema,checkpointPath,cursor,limits:{datasetCheckCpuMs:1,datasetCheckCpuMsPerMiB:1}})).rejects.toMatchObject({code:"worker_budget",
        message:expect.stringMatching(/^dohc's checks of this Collection ran too long: they used more than \d+ ms of CPU time while checking the tables\. Try again\.$/)});
      await expect(open({schemaSql:cpuBudgetSchema,checkpointPath,cursor})).resolves.toBeDefined();
    });
  },60_000);

  it("gives each replayed event of a batch the whole CPU budget",async()=>{
    await fixture(async({open})=>{
      // An event costs about a tenth of the budget below, and the batch's
      // sixteen events together exceed it.
      const writer=await open({schemaSql:heavySchema});
      const events=[];let cursor=initial;
      for(let index=0;index<16;index++) {
        const committed=event(await writer.prepare({...operation(cursor),source:insertRows(index*10_000+1,(index+1)*10_000)}),cursor);cursor=await writer.finalize(committed);events.push(committed);
      }
      await expect((await open({schemaSql:heavySchema,limits:{cpuBudgetMs:1000}})).applyBatch(events)).resolves.toMatchObject({revision:16});
    });
  },60_000);

  it("keeps a dataset check's quiet window through its row reports",async()=>{
    await fixture(async({root,open})=>{
      const uniqueSchema="CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE);";
      const writer=await open({schemaSql:uniqueSchema});
      const filled=await writer.finalize(event(await writer.prepare({...operation(),source:`globalThis.operations={run(ctx){
        ctx.db.execute("INSERT INTO items SELECT x, 'v'||x FROM (WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2500) SELECT x FROM n)");return 1}}`})));
      const checkpointPath=join(root,"filled.sqlite");await writer.snapshot(checkpointPath);
      // Swapping two unique values replays through the shadow copy, which rebuilds every row.
      const swap=event(await writer.prepare({...operation(filled),source:`globalThis.operations={run(ctx){
        ctx.db.execute("UPDATE items SET value='temp' WHERE id=1");ctx.db.execute("UPDATE items SET value='v1' WHERE id=2");ctx.db.execute("UPDATE items SET value='v2' WHERE id=1");return 1}}`}),filled);
      await writer.finalize(swap);
      const reports:{progress:string;cpuBudgetMs?:number}[]=[];
      const launch:AppRuntimeLauncher=options=>{
        const child=spawn(process.execPath,[options.entryPath],{cwd:options.cwd,env:options.env,stdio:["ignore","ignore","ignore","ipc"],serialization:"advanced",windowsHide:true});
        child.on("message",message=>{
          const report=message as {progress?:unknown;cpuBudgetMs?:number};
          if(typeof report.progress==="string") reports.push({progress:report.progress,cpuBudgetMs:report.cpuBudgetMs});
          options.onMessage(message);
        });
        child.on("error",options.onError);child.on("close",options.onExit);
        return {postMessage(message){child.send(message as object);},kill(){child.kill("SIGKILL");}};
      };
      await (await open({schemaSql:uniqueSchema,checkpointPath,cursor:filled},launch)).apply(swap);
      const rebuilding=reports.filter(report=>report.progress==="rebuilding the dataset from the replay copy");
      // The step starts, its check starts, rows 1,000 and 2,000 report, and the check ends.
      expect(rebuilding.map(report=>report.cpuBudgetMs===undefined)).toEqual([true,false,false,false,true]);
    });
  },60_000);

  it("does not charge the app for time its worker spends stopped inside app code",async()=>{
    // Windows has no stop signal. PowerShell compiles its calls before the
    // operation starts, so each later request lands in milliseconds.
    const suspender=process.platform==="win32" ? spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",
      `Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);';
      [Console]::Out.WriteLine('ready'); while(($line=[Console]::In.ReadLine()) -ne $null){ $verb,$id=$line.Split(' '); $handle=(Get-Process -Id $id).Handle;
      if($verb -eq 'Suspend'){[void][W.P]::NtSuspendProcess($handle)}else{[void][W.P]::NtResumeProcess($handle)}; [Console]::Out.WriteLine('done') }`],
    {windowsHide:true,stdio:["pipe","pipe","ignore"]}) : undefined;
    const lines=suspender ? createInterface({input:suspender.stdout!})[Symbol.asyncIterator]() : undefined;
    const answer=async(expected:string)=>{const line=await lines!.next();if(line.value!==expected) throw new Error(`The suspender said ${String(line.value)}.`);};
    try {
      if(suspender) await answer("ready");
      await fixture(async({open})=>{
        let pid=0,stall:Promise<void>|undefined,suspendedAt=0,resumedAt=0,repliedAt=0;
        const signal=async(verb:"Suspend"|"Resume")=>{
          if(!suspender){process.kill(pid,verb==="Suspend"?"SIGSTOP":"SIGCONT");return;}
          suspender.stdin!.write(`${verb} ${pid}\n`);await answer("done");
        };
        const launch:AppRuntimeLauncher=options=>{
          const child=spawn(process.execPath,[options.entryPath],{cwd:options.cwd,env:options.env,stdio:["ignore","ignore","ignore","ipc"],serialization:"advanced",windowsHide:true});
          pid=child.pid!;
          child.on("message",message=>{
            const reply=message as {progress?:string;ok?:boolean};
            // The app code section starts right after this report: stop the worker inside it.
            if(reply.progress==="running the Collection action" && !stall) stall=(async()=>{
              await signal("Suspend");suspendedAt=performance.now();
              await new Promise(resolve=>setTimeout(resolve,6_000));
              resumedAt=performance.now();await signal("Resume");
            })();
            if(typeof reply.ok==="boolean") repliedAt=performance.now();
            options.onMessage(message);
          });
          child.on("error",options.onError);child.on("close",options.onExit);
          return {postMessage(message){child.send(message as object);},kill(){child.kill("SIGKILL");}};
        };
        // This test is about the CPU budget, not the silence watchdog: under a loaded gate the 6 s stop plus the
        // query can pass 30 s without a progress report. 50 s stays inside the test's 60 s limit, so a real stall still fails.
        const worker=await open({limits:{cpuBudgetMs:5_000}},launch,{silenceMs:50_000});
        // A fraction of a second of CPU even under heavy load, well inside the budget.
        const prepared=await worker.prepare({...operation(),source:"globalThis.operations={run(ctx){return ctx.db.query('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000000) SELECT sum(x) AS total FROM n')}}"});
        await stall;
        expect(prepared.result).toEqual([{total:2000001000000}]);
        // Stopped for 6 s inside a 5 s budget, and not charged for it.
        expect(suspendedAt).toBeGreaterThan(0);
        expect(repliedAt).toBeGreaterThan(resumedAt);
      });
    } finally {suspender?.stdin!.end();}
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
