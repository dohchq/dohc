import { closeSync, fstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";
import { HEARTBEAT_ROWS, reject } from "./persistent-protocol.js";

export type MigrationPreviewValue = null | string | number | {type:"integer";value:string} | {type:"blob";base64:string};
export interface MigrationPreviewChange {
  table:string;
  kind:"insert"|"update"|"delete";
  key:Record<string,MigrationPreviewValue>;
  before:Record<string,MigrationPreviewValue>|null;
  after:Record<string,MigrationPreviewValue>|null;
}
export interface MigrationPreviewTableSummary {table:string;beforeRows:number;afterRows:number;changedRows:number}
export interface MigrationPreviewReportPage {changes:MigrationPreviewChange[];nextCursor:string|null}
const rowBytes=256*1024;
const reportBytes=512*1024*1024;
// Keep the largest value SQLite materializes for a report row below this bound.
// JSON encoding (in particular base64 blobs) is checked separately below.
const rawRowBytes=128*1024;
const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;
type Row=Record<string,SQLOutputValue>;
interface Table {columns:string[];primary:string[];identity:string}

function tableInfo(db:DatabaseSync,table:string):Table {
  const columns=db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all();
  const primary=columns.filter(column=>Number(column.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk));
  if(!columns.length||!primary.length)reject("invalid_schema","Migration previews require tables with declared primary keys.");
  const index=db.prepare(`PRAGMA index_list(${quote(table)})`).all().find(row=>row.origin==="pk");
  const identity=JSON.stringify({
    columns:primary.map(column=>({name:column.name,type:String(column.type).toUpperCase(),notnull:column.notnull})),
    index:index?db.prepare(`PRAGMA index_xinfo(${quote(String(index.name))})`).all().filter(row=>Number(row.key)===1).map(row=>({name:row.name,coll:row.coll,desc:row.desc})):null,
  });
  return {columns:columns.filter(column=>Number(column.hidden)!==1).map(column=>String(column.name)),primary:primary.map(column=>String(column.name)),identity};
}
function statement(db:DatabaseSync,sql:string):StatementSync {
  const result=db.prepare(sql);result.setReadBigInts(true);return result;
}
function select(table:string,info:Table):string {return `SELECT ${info.columns.map(quote).join(",")} FROM ${quote(table)}`;}
function lookup(db:DatabaseSync,table:string,info:Table):StatementSync {
  return statement(db,`${select(table,info)} WHERE ${info.primary.map(name=>`${quote(name)} IS ?`).join(" AND ")}`);
}
function assertRowsBound(db:DatabaseSync,table:string,info:Table):void {
  // SQLite evaluates length() inside the connection and returns only a boolean.
  // Do this before iterating full rows so a hostile text/blob cell cannot be
  // copied into a JavaScript value before we enforce the report row limit.
  const bytes=info.columns.map(name=>`COALESCE(length(CAST(${quote(name)} AS BLOB)),0)`).join("+") || "0";
  if(statement(db,`SELECT 1 FROM ${quote(table)} WHERE (${bytes}) > ? LIMIT 1`).get(rawRowBytes))
    reject("resource_limit","A migration preview source row exceeds 128 KiB. No values were omitted.");
}
function equalValue(a:SQLOutputValue,b:SQLOutputValue):boolean {
  if(a instanceof Uint8Array&&b instanceof Uint8Array)return Buffer.from(a.buffer,a.byteOffset,a.byteLength).equals(b);
  return Object.is(a,b);
}
function find(stmt:StatementSync,info:Table,row:Row):Row|undefined {
  const match=stmt.get(...info.primary.map(name=>row[name] as SQLInputValue));
  // A collation can match different stored values. Their primary keys still changed.
  return match&&info.primary.every(name=>equalValue(row[name],match[name]))?match:undefined;
}
function values(row:Row,names:string[]):Record<string,MigrationPreviewValue> {
  return Object.fromEntries(names.map(name=>{
    const value=row[name];
    if(typeof value==="bigint")return [name,{type:"integer",value:value.toString()}];
    if(value instanceof Uint8Array)return [name,{type:"blob",base64:Buffer.from(value).toString("base64")}];
    if(typeof value==="number"&&!Number.isFinite(value))reject("resource_limit","Migration previews cannot represent non-finite numbers.");
    return [name,value];
  }));
}

/** The caller holds exclusive ownership of both immutable snapshots and supplies the dataset's report allowance. */
export function createMigrationPreviewReport(input:{before:DatabaseSync;after:DatabaseSync;beforeTables:string[];afterTables:string[];path:string;maxBytes:number;heartbeat?:()=>void}):{tables:MigrationPreviewTableSummary[];bytes:number} {
  if(!Number.isSafeInteger(input.maxBytes)||input.maxBytes<1||input.maxBytes>reportBytes)reject("invalid_input","Invalid migration preview byte allowance.");
  const descriptor=openSync(input.path,"wx",0o600);
  let bytes=0,complete=false,rows=0;
  const counted=()=>{if(++rows%HEARTBEAT_ROWS===0) input.heartbeat?.();};
  const tables:MigrationPreviewTableSummary[]=[];
  try {
    for(const table of new Set([...input.beforeTables,...input.afterTables])) {
      const before=input.beforeTables.includes(table)?tableInfo(input.before,table):undefined;
      const after=input.afterTables.includes(table)?tableInfo(input.after,table):undefined;
      const comparable=before&&after&&before.identity===after.identity;
      const getBefore=comparable?lookup(input.before,table,before):undefined;
      const getAfter=comparable?lookup(input.after,table,after):undefined;
      const summary={table,beforeRows:0,afterRows:0,changedRows:0};
      if(before)assertRowsBound(input.before,table,before);
      if(after)assertRowsBound(input.after,table,after);
      const append=(kind:MigrationPreviewChange["kind"],oldRow:Row|undefined,newRow:Row|undefined)=>{
        const change:MigrationPreviewChange={table,kind,key:values((newRow??oldRow)!,newRow?after!.primary:before!.primary),before:oldRow?values(oldRow,before!.columns):null,after:newRow?values(newRow,after!.columns):null};
        const encoded=Buffer.from(`${JSON.stringify(change)}\n`);
        if(encoded.length>rowBytes)reject("resource_limit","A migration preview row exceeds 256 KiB. No values were omitted.");
        if(bytes+encoded.length>input.maxBytes)reject("resource_limit","The migration preview exceeds its byte allowance. No changes were omitted.");
        let written=0;
        while(written<encoded.length)written+=writeSync(descriptor,encoded,written,encoded.length-written);
        bytes+=encoded.length;summary.changedRows++;
      };
      if(before)for(const row of statement(input.before,select(table,before)).iterate()) {
        summary.beforeRows++;counted();
        const match=getAfter?find(getAfter,after!,row):undefined;
        if(!match)append("delete",row,undefined);
        else if(before.columns.length!==after!.columns.length||before.columns.some(name=>!after!.columns.includes(name)||!equalValue(row[name],match[name])))append("update",row,match);
      }
      if(after)for(const row of statement(input.after,select(table,after)).iterate()) {
        summary.afterRows++;counted();
        if(!getBefore||!find(getBefore,before!,row))append("insert",undefined,row);
      }
      tables.push(summary);
    }
    complete=true;return {tables,bytes};
  } finally {
    closeSync(descriptor);
    if(!complete)unlinkSync(input.path);
  }
}

/** Cursors are offsets in an immutable JSONL report owned by the host. */
export function readMigrationPreviewReportPage(input:{path:string;after?:string;limit?:number}):MigrationPreviewReportPage {
  const limit=input.limit??100;
  if(!Number.isInteger(limit)||limit<1||limit>100)reject("invalid_input","Migration preview pages allow 1 to 100 rows.");
  if(input.after!==undefined&&(typeof input.after!=="string"||!/^(0|[1-9][0-9]*)$/.test(input.after)))reject("invalid_input","Invalid migration preview cursor.");
  const offset=Number(input.after??0);
  const descriptor=openSync(input.path,"r");
  try {
    const size=fstatSync(descriptor).size;
    if(!Number.isSafeInteger(offset)||offset>size)reject("invalid_input","Invalid migration preview cursor.");
    if(offset>0){const boundary=Buffer.alloc(1);readSync(descriptor,boundary,0,1,offset-1);if(boundary[0]!==10)reject("invalid_input","Invalid migration preview cursor.");}
    const buffer=Buffer.alloc(Math.min(rowBytes,size-offset));
    let loaded=0;
    while(loaded<buffer.length){const count=readSync(descriptor,buffer,loaded,buffer.length-loaded,offset+loaded);if(!count)break;loaded+=count;}
    const changes:MigrationPreviewChange[]=[];
    let consumed=0;
    while(changes.length<limit){
      const end=buffer.indexOf(10,consumed);
      if(end<0||end>=loaded)break;
      changes.push(JSON.parse(buffer.toString("utf8",consumed,end)) as MigrationPreviewChange);consumed=end+1;
      if(consumed===loaded)break;
    }
    if(loaded&&!consumed)reject("resource_limit","Invalid or oversized migration preview row.");
    if(offset+loaded===size&&consumed<loaded&&changes.length<limit)reject("invalid_input","Incomplete migration preview report.");
    return {changes,nextCursor:offset+consumed<size?String(offset+consumed):null};
  }finally{closeSync(descriptor);}
}
