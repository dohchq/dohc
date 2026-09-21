import { describe, expect, it } from "vitest";
import { AppBackendRuntimeError, evaluateAppOperation, initializeAppDatabase, validateAppDatabase } from "./index.ts";
import type { EvaluateAppOperationInput } from "./index.ts";

const tables = ["stock", "orders"];
const schemaSql = `CREATE TABLE stock(id TEXT PRIMARY KEY NOT NULL, remaining INTEGER NOT NULL CHECK(remaining>=0));
CREATE TABLE orders(id TEXT PRIMARY KEY NOT NULL, quantity INTEGER NOT NULL);
INSERT INTO stock VALUES('item',1);`;
const source = `globalThis.operations = {
  reserve(ctx,input) {
    const count=ctx.db.execute('UPDATE stock SET remaining=remaining-? WHERE id=? AND remaining>=?', [input.quantity,'item',input.quantity]).changes;
    if(count!==1) throw Error('Insufficient stock');
    ctx.db.execute('INSERT INTO orders VALUES(?,?)',[ctx.requestId,input.quantity]);
    return {id:ctx.requestId,quantity:input.quantity};
  },
  inspect(ctx) { return ctx.db.query('SELECT * FROM stock'); }
};`;

async function request(overrides: Partial<EvaluateAppOperationInput> = {}): Promise<EvaluateAppOperationInput> {
  return { tables, database: await initializeAppDatabase({ tables, schemaSql }), source, operation: "reserve",
    input: {quantity:1}, caller: {kind:"public",id:"verified"}, requestId:"request-1", nowMs:1000, ...overrides };
}

describe("app operation runtime", () => {
  it("validates recovery snapshots against the exact approved schema in isolation", async () => {
    const input=await request();
    const candidate=await evaluateAppOperation(input);
    await expect(validateAppDatabase({database:candidate.database,tables,schemaSql})).resolves.toBeUndefined();
    await expect(validateAppDatabase({database:candidate.database,tables,schemaSql:schemaSql.replace("CHECK(remaining>=0)","CHECK(remaining>=-1)")})).rejects.toThrow("approved schema");
    const corrupt=Uint8Array.from(candidate.database);corrupt.fill(0,0,100);
    await expect(validateAppDatabase({database:corrupt,tables,schemaSql})).rejects.toThrow();
  });
  it("returns an isolated candidate and changeset, without modifying its baseline", async () => {
    const input = await request();
    const baseline = Buffer.from(input.database);
    const [first, second] = await Promise.all([evaluateAppOperation(input),evaluateAppOperation(input)]);
    expect(first.result).toEqual({id:"request-1",quantity:1});
    expect(first.changed).toBe(true);
    expect(first.changeset.length).toBeGreaterThan(0);
    expect(Buffer.from(first.database)).toEqual(Buffer.from(second.database));
    expect(Buffer.from(first.changeset)).toEqual(Buffer.from(second.changeset));
    expect(Buffer.from(input.database)).toEqual(baseline);
    const read = await evaluateAppOperation({...input,database:first.database,operation:"inspect",readOnly:true});
    expect(read.result).toEqual([{id:"item",remaining:0}]);
    expect(read.changed).toBe(false);
    await expect(evaluateAppOperation({...input,database:first.database,requestId:"request-2"})).rejects.toThrow();
  });

  it("offers no host capabilities and freezes the verified context", async () => {
    const input = await request({operation:"inspect",source:`globalThis.operations={inspect(ctx,input){
      ctx.caller.id='forged'; input.quantity=42;
      return [typeof process,typeof require,typeof fetch,typeof WebAssembly,typeof __query,ctx.caller.id,input.quantity,Object.isFrozen(ctx.db)];
    }};`});
    expect((await evaluateAppOperation(input)).result).toEqual(["undefined","undefined","undefined","undefined","undefined","verified",1,true]);
    await expect(evaluateAppOperation({...input,source:`import fs from 'node:fs'; globalThis.operations={inspect(){return true}};`})).rejects.toThrow();
  });

  it.each([
    "ATTACH DATABASE '/tmp/escape.db' AS other",
    "PRAGMA user_version=1",
    "COMMIT",
    "CREATE TABLE intruder(id INTEGER PRIMARY KEY)",
    "SELECT load_extension('escape')",
    "SELECT * FROM sqlite_schema",
    "DROP TABLE stock",
  ])("rejects SQL outside approved data: %s", async sql => {
    const input = await request({source:`globalThis.operations={reserve(ctx){return ctx.db.execute(${JSON.stringify(sql)})}};`});
    await expect(evaluateAppOperation(input)).rejects.toThrow();
  });

  it("refuses writes from reads, and rolls back candidates after exceptions", async () => {
    const input = await request({readOnly:true});
    await expect(evaluateAppOperation(input)).rejects.toThrow();
    await expect(evaluateAppOperation({...input,readOnly:false,source:`globalThis.operations={reserve(ctx){ctx.db.query('DELETE FROM stock RETURNING id');return true}}`})).rejects.toThrow();
    const read = await evaluateAppOperation({...input,operation:"inspect"});
    expect(read.result).toEqual([{id:"item",remaining:1}]);
  });

  it.each([
    "while(true){}",
    "return {get value(){while(true){}}}",
    "return {toJSON(){while(true){}}}",
    "const rows=[];while(true)rows.push('x'.repeat(10000));",
  ])("bounds guest execution and serialization: %s", async body => {
    const input = await request({source:`globalThis.operations={reserve(){${body}}}`,limits:{evaluationMs:100,memoryBytes:2*1024*1024}});
    await expect(evaluateAppOperation(input)).rejects.toThrow();
  });

  it("kills a native SQL runaway and accepts a following operation", async () => {
    const input = await request({source:`globalThis.operations={reserve(ctx){return ctx.db.query('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n')}}`, limits:{deadlineMs:1500,evaluationMs:100}});
    await expect(evaluateAppOperation(input)).rejects.toThrow("deadline");
    expect((await evaluateAppOperation({...input,source,operation:"inspect",limits:undefined})).result).toEqual([{id:"item",remaining:1}]);
  });

  it("cancels queued and running operations", async () => {
    const input=await request();
    await expect(evaluateAppOperation({...input,signal:AbortSignal.abort()})).rejects.toThrow("cancelled");
    const controller=new AbortController();
    const pending=evaluateAppOperation({...input,signal:controller.signal,source:"globalThis.operations={reserve(){while(true){}}}"});
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("uses the supplied request secret without exposing it to unrelated results", async () => {
    const input=await request({secret:"a".repeat(43),source:"globalThis.operations={reserve(ctx){return ctx.secret}}"});
    expect((await evaluateAppOperation(input)).result).toBe("a".repeat(43));
  });

  it("bounds rows, statements, and returned JSON", async () => {
    const input = await request();
    for(const [body,limits] of [
      ["return ctx.db.query('SELECT 1 UNION ALL SELECT 2')",{queryRows:1}],
      ["ctx.db.query('SELECT 1');return ctx.db.query('SELECT 2')",{statements:1}],
      ["return 'x'.repeat(1000)",{resultBytes:10}],
    ] as const) await expect(evaluateAppOperation({...input,source:`globalThis.operations={reserve(ctx){${body}}}`,limits})).rejects.toThrow();
  });

  it("preserves a structured refusal even if guest code catches it", async () => {
    const input=await request({source:`globalThis.operations={reserve(ctx){
      ctx.db.execute('DELETE FROM stock');
      try {ctx.refuse('capacity_full','This session is full.')}catch{}
      return {ok:true};
    }}`});
    await expect(evaluateAppOperation(input)).rejects.toMatchObject({name:"AppBackendRuntimeError",code:"operation_refused",refusal:{code:"capacity_full",message:"This session is full."}});
    expect(AppBackendRuntimeError.prototype).toBeInstanceOf(Error);
    const read=await evaluateAppOperation({...input,source,operation:"inspect"});
    expect(read.result).toEqual([{id:"item",remaining:1}]);
  });

  it("attaches only admitted file metadata, without exposing file bytes", async () => {
    const file={fileId:"receipt-1",name:"receipt.png",contentType:"image/png",byteLength:123,sha256:"a".repeat(64)};
    const input=await request({files:[file],source:`globalThis.operations={reserve(ctx){const file=ctx.files.attach('receipt-1');return {file,frozen:Object.isFrozen(file)}}}`});
    const result=await evaluateAppOperation(input);
    expect(result.result).toEqual({file,frozen:true});
    expect(result.attachedFileIds).toEqual(["receipt-1"]);
    await expect(evaluateAppOperation({...input,files:[]})).rejects.toThrow();
    await expect(evaluateAppOperation({...input,readOnly:true})).rejects.toThrow();
  });

  it("requires declared tables and primary keys, while supporting constraints and triggers", async () => {
    await expect(initializeAppDatabase({tables:["items"],schemaSql:"CREATE TABLE items(value TEXT)"})).rejects.toThrow("primary key");
    await expect(initializeAppDatabase({tables:["items"],schemaSql:"CREATE TABLE items(id TEXT PRIMARY KEY)"})).rejects.toThrow("non-null");
    await expect(initializeAppDatabase({tables:["items"],schemaSql:"CREATE TABLE items(a INTEGER,b INTEGER,PRIMARY KEY(a,b))"})).rejects.toThrow("non-null");
    await expect(initializeAppDatabase({tables:["items"],schemaSql:"CREATE TABLE other(id INTEGER PRIMARY KEY)"})).rejects.toThrow();
    const database=await initializeAppDatabase({tables:["items"],schemaSql:`CREATE TABLE items(id INTEGER PRIMARY KEY, amount INTEGER CHECK(amount>=0)); CREATE TRIGGER bounded BEFORE INSERT ON items WHEN new.amount>5 BEGIN SELECT RAISE(ABORT,'limit'); END;`});
    const input=await request({tables:["items"],database,source:`globalThis.operations={reserve(ctx){ctx.db.execute('INSERT INTO items VALUES(1,6)');return true}}`});
    await expect(evaluateAppOperation(input)).rejects.toThrow();
  });
});
