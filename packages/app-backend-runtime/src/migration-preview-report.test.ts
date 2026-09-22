import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createMigrationPreviewReport, readMigrationPreviewReportPage } from "./migration-preview-report.ts";
import type { MigrationPreviewChange } from "./migration-preview-report.ts";

const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();});
function fixture(beforeSql:string,afterSql:string){
  const directory=mkdtempSync(join(tmpdir(),"dohc-migration-report-"));
  const before=new DatabaseSync(":memory:"),after=new DatabaseSync(":memory:");
  cleanups.push(()=>{before.close();after.close();rmSync(directory,{recursive:true,force:true});});
  before.exec(beforeSql);after.exec(afterSql);
  return {before,after,path:join(directory,"report.jsonl"),maxBytes:1024*1024};
}
const integer=(value:string)=>({type:"integer" as const,value});

it("reports inserted, updated, deleted, and unchanged rows without exposing other tables",()=>{
  const input=fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(1,'same'),(2,'old'),(3,'gone'); CREATE TABLE secret(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO secret VALUES(1,'hidden');","CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(1,'same'),(2,'new'),(4,'added');");
  const report=createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"]});
  expect(report.tables).toEqual([{table:"items",beforeRows:3,afterRows:3,changedRows:3}]);
  expect(report.bytes).toBe(readFileSync(input.path).length);
  expect(readMigrationPreviewReportPage({path:input.path})).toEqual({changes:[
    {table:"items",kind:"update",key:{id:integer("2")},before:{id:integer("2"),value:"old"},after:{id:integer("2"),value:"new"}},
    {table:"items",kind:"delete",key:{id:integer("3")},before:{id:integer("3"),value:"gone"},after:null},
    {table:"items",kind:"insert",key:{id:integer("4")},before:null,after:{id:integer("4"),value:"added"}},
  ],nextCursor:null});
});

it("includes added and dropped tables and every value of added and dropped columns",()=>{
  const input=fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,removed TEXT); INSERT INTO items VALUES(1,'old'); CREATE TABLE removed(id INTEGER PRIMARY KEY); INSERT INTO removed VALUES(9); CREATE TABLE empty_removed(id INTEGER PRIMARY KEY);","CREATE TABLE items(id INTEGER PRIMARY KEY,added TEXT); INSERT INTO items VALUES(1,'new'); CREATE TABLE added(id INTEGER PRIMARY KEY); INSERT INTO added VALUES(8); CREATE TABLE empty_added(id INTEGER PRIMARY KEY);");
  const report=createMigrationPreviewReport({...input,beforeTables:["items","removed","empty_removed"],afterTables:["items","added","empty_added"]});
  expect(report.tables).toEqual([
    {table:"items",beforeRows:1,afterRows:1,changedRows:1},{table:"removed",beforeRows:1,afterRows:0,changedRows:1},
    {table:"empty_removed",beforeRows:0,afterRows:0,changedRows:0},{table:"added",beforeRows:0,afterRows:1,changedRows:1},
    {table:"empty_added",beforeRows:0,afterRows:0,changedRows:0},
  ]);
  expect(readMigrationPreviewReportPage({path:input.path}).changes).toMatchObject([
    {table:"items",kind:"update",before:{id:integer("1"),removed:"old"},after:{id:integer("1"),added:"new"}},
    {table:"removed",kind:"delete"},{table:"added",kind:"insert"},
  ]);
});

it("matches WITHOUT ROWID composite primary keys and includes generated values",()=>{
  const schema='CREATE TABLE "odd table"("first key" TEXT NOT NULL,second INTEGER NOT NULL,value TEXT,computed TEXT GENERATED ALWAYS AS (value || \'!\') VIRTUAL,PRIMARY KEY("first key",second)) WITHOUT ROWID;';
  const input=fixture(schema+"INSERT INTO 'odd table' VALUES('a',1,'old'),('a',2,'same');",schema+"INSERT INTO 'odd table' VALUES('a',1,'new'),('a',2,'same');");
  createMigrationPreviewReport({...input,beforeTables:["odd table"],afterTables:["odd table"]});
  expect(readMigrationPreviewReportPage({path:input.path}).changes).toEqual([{table:"odd table",kind:"update",key:{"first key":"a",second:integer("1")},before:{"first key":"a",second:integer("1"),value:"old",computed:"old!"},after:{"first key":"a",second:integer("1"),value:"new",computed:"new!"}}]);
});

it("preserves integers, blobs, floating numbers, nulls, and unusual column names",()=>{
  const schema='CREATE TABLE items(id INTEGER PRIMARY KEY,blob BLOB,number REAL,empty TEXT,"__proto__" TEXT);';
  const input=fixture(schema,schema+"INSERT INTO items VALUES(9223372036854775807,x'00ff8001',1.25,NULL,'safe');");
  createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"]});
  const row=readMigrationPreviewReportPage({path:input.path}).changes[0];
  expect(row.key.id).toEqual(integer("9223372036854775807"));
  expect(row.after).toEqual(JSON.parse('{"id":{"type":"integer","value":"9223372036854775807"},"blob":{"type":"blob","base64":"AP+AAQ=="},"number":1.25,"empty":null,"__proto__":"safe"}'));
});

it("reports changed primary key definitions and collation-equivalent key values as deletion and insertion",()=>{
  for(const [beforeSql,afterSql] of [
    ["CREATE TABLE items(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO items VALUES(1,2)","CREATE TABLE items(id INTEGER,value INTEGER PRIMARY KEY); INSERT INTO items VALUES(1,2)"],
    ["CREATE TABLE items(id TEXT NOT NULL PRIMARY KEY COLLATE NOCASE); INSERT INTO items VALUES('A')","CREATE TABLE items(id TEXT NOT NULL PRIMARY KEY COLLATE NOCASE); INSERT INTO items VALUES('a')"],
    ["CREATE TABLE items(id TEXT NOT NULL PRIMARY KEY COLLATE BINARY); INSERT INTO items VALUES('a')","CREATE TABLE items(id TEXT NOT NULL PRIMARY KEY COLLATE NOCASE); INSERT INTO items VALUES('a')"],
  ]){
    const input=fixture(beforeSql,afterSql);
    createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"]});
    expect(readMigrationPreviewReportPage({path:input.path}).changes.map(row=>row.kind)).toEqual(["delete","insert"]);
  }
});

it("pages by validated byte offsets without losing multibyte text or reading beyond the page byte limit",()=>{
  const schema="CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);";
  const input=fixture(schema,schema);
  const insert=input.after.prepare("INSERT INTO items VALUES(?,?)");
  for(let index=0;index<205;index++)insert.run(index,"🐈".repeat(500));
  createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"]});
  const changes:MigrationPreviewChange[]=[];
  let after:string|undefined;
  do{
    const page=readMigrationPreviewReportPage({path:input.path,after});
    expect(page.changes.length).toBeLessThanOrEqual(100);
    if(page.nextCursor)expect(Number(page.nextCursor)-Number(after??0)).toBeLessThanOrEqual(256*1024);
    changes.push(...page.changes);after=page.nextCursor??undefined;
  }while(after);
  expect(changes).toHaveLength(205);expect(changes[204].after?.value).toBe("🐈".repeat(500));
  const first=readMigrationPreviewReportPage({path:input.path,limit:1});
  expect(first.changes).toHaveLength(1);
  expect(readMigrationPreviewReportPage({path:input.path,after:first.nextCursor!,limit:1}).changes[0].key.id).toEqual(integer("1"));
  for(const cursor of ["-1","1","01","1.5","9007199254740992",String(readFileSync(input.path).length+1)])expect(()=>readMigrationPreviewReportPage({path:input.path,after:cursor})).toThrow("cursor");
  for(const limit of [0,101,1.5])expect(()=>readMigrationPreviewReportPage({path:input.path,limit})).toThrow("1 to 100");
});

it("rejects oversized rows or reports and removes incomplete output without replacing an existing file",()=>{
  const schema="CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);";
  const input=fixture(schema,schema);
  input.after.prepare("INSERT INTO items VALUES(1,?)").run("x".repeat(256*1024));
  expect(()=>createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"]})).toThrow("row exceeds");
  expect(existsSync(input.path)).toBe(false);
  input.after.exec("UPDATE items SET value='small'");
  expect(()=>createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"],maxBytes:1})).toThrow("byte allowance");
  expect(existsSync(input.path)).toBe(false);
  expect(()=>createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"],maxBytes:512*1024*1024+1})).toThrow("byte allowance");
  writeFileSync(input.path,"preserved");
  expect(()=>createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"]})).toThrow();
  expect(readFileSync(input.path,"utf8")).toBe("preserved");
});

it("rejects an oversized source value before JavaScript materializes the row",()=>{
  const schema="CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);";
  const input=fixture(schema,schema);
  input.after.prepare("INSERT INTO items VALUES(1,?)").run("x".repeat(128*1024+1));
  expect(()=>createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"]})).toThrow("source row exceeds 128 KiB");
  expect(existsSync(input.path)).toBe(false);
  input.before.prepare("INSERT INTO items VALUES(1,?)").run("x".repeat(128*1024+1));
  expect(()=>createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"]})).toThrow("source row exceeds 128 KiB");
  expect(existsSync(input.path)).toBe(false);
  const combined=fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,a BLOB,b BLOB)","CREATE TABLE items(id INTEGER PRIMARY KEY,a BLOB,b BLOB); INSERT INTO items VALUES(1,zeroblob(65536),zeroblob(65536))");
  expect(()=>createMigrationPreviewReport({...combined,beforeTables:["items"],afterTables:["items"]})).toThrow("source row exceeds 128 KiB");
});

it("reads an empty report and rejects truncated JSONL instead of silently omitting its last row",()=>{
  const input=fixture("CREATE TABLE items(id INTEGER PRIMARY KEY)","CREATE TABLE items(id INTEGER PRIMARY KEY)");
  expect(createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"]}).bytes).toBe(0);
  expect(readMigrationPreviewReportPage({path:input.path})).toEqual({changes:[],nextCursor:null});
  writeFileSync(input.path,'{}\n{"unfinished":');
  expect(()=>readMigrationPreviewReportPage({path:input.path})).toThrow("Incomplete");
});

it("allows a record exactly at the page byte limit and continues at its following record",()=>{
  const schema="CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);";
  const input=fixture(schema,schema);
  const empty:MigrationPreviewChange={table:"items",kind:"insert",key:{id:integer("1")},before:null,after:{id:integer("1"),value:""}};
  const encodedBytes=256*1024-Buffer.byteLength(`${JSON.stringify(empty)}\n`);
  const payload="\0".repeat(Math.floor(encodedBytes/6))+"x".repeat(encodedBytes%6);
  input.after.prepare("INSERT INTO items VALUES(?,?)").run(1,payload);
  input.after.prepare("INSERT INTO items VALUES(?,?)").run(2,"next");
  createMigrationPreviewReport({...input,beforeTables:["items"],afterTables:["items"]});
  const first=readMigrationPreviewReportPage({path:input.path});
  expect(first.changes).toHaveLength(1);expect(first.nextCursor).toBe(String(256*1024));
  const second=readMigrationPreviewReportPage({path:input.path,after:first.nextCursor!});
  expect(second.changes[0].after?.value).toBe("next");expect(second.nextCursor).toBeNull();
});

it("rejects implicit row identities and values that JSON cannot preserve",()=>{
  const noPrimary=fixture("CREATE TABLE items(value TEXT)","CREATE TABLE items(value TEXT)");
  expect(()=>createMigrationPreviewReport({...noPrimary,beforeTables:["items"],afterTables:["items"]})).toThrow("declared primary keys");
  expect(existsSync(noPrimary.path)).toBe(false);
  const infinite=fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,value REAL)","CREATE TABLE items(id INTEGER PRIMARY KEY,value REAL); INSERT INTO items VALUES(1,1e999)");
  expect(()=>createMigrationPreviewReport({...infinite,beforeTables:["items"],afterTables:["items"]})).toThrow("non-finite");
  expect(existsSync(infinite.path)).toBe(false);
});
