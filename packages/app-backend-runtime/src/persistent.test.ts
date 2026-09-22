import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openPersistentAppBackend } from "./persistent.ts";
import type { PersistentAppBackend, PersistentOpenInput, PersistentPrepareInput, PreparedOperation } from "./persistent.ts";
import type { AppRuntimeLauncher } from "./protocol.ts";
import { acquireSupervisorOwnership } from "./worker-ownership.ts";

const hash=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
// These tests start real processes; process deadlines remain enforced independently.
vi.setConfig({testTimeout:30_000});
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
async function fixture(run:(context:{root:string;open:(input?:Partial<PersistentOpenInput>,launch?:AppRuntimeLauncher)=>Promise<PersistentAppBackend>})=>Promise<void>):Promise<void> {
  const root=await mkdtemp(join(tmpdir(),"dohc-persistent-test-"));
  const workers:PersistentAppBackend[]=[];let sequence=0;
  try {
    await run({root,async open(input={},launch){
      const directory=join(root,String(++sequence));await mkdir(directory);
      const worker=await openPersistentAppBackend({directory,schemaSql,tables:["items"],scope,cursor:initial,...input},{launch});
      workers.push(worker);return worker;
    }});
  } finally {
    await Promise.all(workers.map(worker=>worker.close()));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:25});
  }
}

describe("persistent dataset worker",()=>{
  it("holds its owned-directory lease until worker close and refuses expired ownership",async()=>{
    await fixture(async({root,open})=>{
      const owner=await acquireSupervisorOwnership(root);
      try {
        const directory=await owner.createDirectory();
        const worker=await open({directory,ownership:{root:owner.root,session:owner.session}});
        await expect(owner.removeDirectory(directory)).rejects.toThrow("ownership is busy");
        await worker.close();
        await owner.removeDirectory(directory);
        const next=await owner.createDirectory();
        await expect(open({directory:next,ownership:{root:owner.root,session:"00000000-0000-0000-0000-000000000000"}})).rejects.toThrow("expired host session");
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
  it("commits only after host finalization and restores checkpoint scope/cursor",async()=>{
    await fixture(async({root,open})=>{
      const worker=await open();
      const prepared=await worker.prepare(operation(initial,{id:1,value:"saved"}));
      expect(prepared.result).toEqual([{id:1,value:"saved"}]);
      await expect(worker.prepare(operation())).rejects.toMatchObject({code:"pending_operation"});
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
  },15_000);

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

  it("kills a migration that exceeds its native SQL deadline without changing the live database",async()=>{
    await fixture(async({root,open})=>{
      const worker=await open({limits:{deadlineMs:1000}});
      await expect(worker.migrateCheckpoint({path:join(root,"timeout.sqlite"),schemaSql,tables:["items"],
        migrationSql:"INSERT INTO items VALUES(1,'copy only'); WITH RECURSIVE count(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM count WHERE x<1000000000) SELECT sum(x) FROM count;"}))
        .rejects.toMatchObject({code:"worker_deadline"});
      await worker.close();
      const live=new DatabaseSync(join(root,"1","app.sqlite"));
      try {
        expect(live.prepare("SELECT * FROM items").all()).toEqual([]);
        expect(live.prepare("SELECT revision FROM dohc_applied").get()?.revision).toBe(0);
      }finally{live.close();}
      await expect(readFile(join(root,"timeout.sqlite"))).rejects.toMatchObject({code:"ENOENT"});
    });
  },15_000);

  it("kills native SQL at its deadline and requires journal recovery instead of silently restarting",async()=>{
    await fixture(async({open})=>{
      const worker=await open({limits:{deadlineMs:1000,evaluationMs:100}});
      const expensive={...operation(),readOnly:true,source:`globalThis.operations={run(ctx){return ctx.db.query('WITH RECURSIVE count(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM count WHERE x<1000000000) SELECT sum(x) FROM count')}}`};
      await expect(worker.prepare(expensive)).rejects.toMatchObject({code:"worker_deadline"});
      await expect(worker.prepare({...operation(),readOnly:true})).rejects.toMatchObject({code:"worker_deadline"});
      await worker.close();
      const recovered=await open();
      expect((await recovered.prepare({...operation(),readOnly:true})).result).toEqual([]);
    });
  });

  it("bounds queued work and expires queued operations without consuming their execution budget",async()=>{
    await fixture(async({open})=>{
      const worker=await open({limits:{deadlineMs:1000},queueDeadlineMs:40});
      for(let index=0;index<70;index++) await expect(worker.prepare(operation(initial,{value:"x".repeat(70_000)}))).rejects.toThrow();
      const active=worker.prepare({...operation(),readOnly:true,source:`globalThis.operations={run(ctx){return ctx.db.query('WITH RECURSIVE count(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM count WHERE x<1000000000) SELECT sum(x) FROM count')}}`}).catch(error=>error);
      const queued=Array.from({length:64},()=>worker.prepare({...operation(),readOnly:true}).catch(error=>error));
      const results=await Promise.all(queued);
      expect(results.filter(result=>result.code==="queue_full")).toHaveLength(1);
      expect(results.filter(result=>result.code==="queue_deadline")).toHaveLength(63);
      expect(await active).toMatchObject({code:"worker_deadline"});
    });
  });

  it("recovers a commit whose acknowledgement was lost",async()=>{
    await fixture(async({root,open})=>{
      let finalizeId:number|undefined;
      const launch:AppRuntimeLauncher=options=>{
        const child=spawn(process.execPath,[options.entryPath],{cwd:options.cwd,env:options.env,stdio:["ignore","ignore","ignore","ipc"],serialization:"advanced",windowsHide:true});
        child.on("message",message=>{
          if((message as {id:number}).id===finalizeId) child.kill("SIGKILL");
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
