import { closeSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, constants } from "node:sqlite";
import { databaseBytes, HEARTBEAT_ROWS, reject, unbudgeted } from "./persistent-protocol.js";
import type { CpuBudgets } from "./persistent-protocol.js";

const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
type Columns=ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>;

function stageTable(source:DatabaseSync, shadow:DatabaseSync, table:string, heartbeat:()=>void):string[] {
  const columns=source.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().filter(column=>Number(column.hidden)===0);
  const primary=columns.filter(column=>Number(column.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk));
  const index=source.prepare(`PRAGMA index_list(${quote(table)})`).all().find(index=>index.origin==="pk");
  const keys:Columns=index ? source.prepare(`PRAGMA index_xinfo(${quote(String(index.name))})`).all().filter(key=>key.key===1) : [];
  const tableOptions=source.prepare("SELECT wr,strict FROM pragma_table_list WHERE schema='main' AND name=?").get(table);
  const withoutRowid=tableOptions?.wr===1, strict=tableOptions?.strict===1;
  const alias=!index && primary.length===1 && String(primary[0].type).toUpperCase()==="INTEGER";
  const nonAliasInteger=!withoutRowid && !!index && primary.length===1 && String(primary[0].type).toUpperCase()==="INTEGER";
  const definitions=columns.map(column=>{
    const key=keys.find(key=>key.name===column.name);
    return `${quote(String(column.name))} ${column.type ? quote(String(column.type)) : ""}${key ? ` COLLATE ${quote(String(key.coll))}` : ""}`+
      (Number(column.pk)>0 && alias ? " PRIMARY KEY" : Number(column.pk)>0 && nonAliasInteger ? " PRIMARY KEY DESC NOT NULL" : Number(column.pk)>0 ? " NOT NULL" : "");
  });
  if(!alias && !nonAliasInteger) definitions.push(`PRIMARY KEY (${primary.map(column=>{
    const key=keys.find(key=>key.name===column.name);
    return `${quote(String(column.name))}${key ? ` COLLATE ${quote(String(key.coll))}${key.desc===1 ? " DESC" : ""}` : ""}`;
  }).join(",")})`);
  const suffix=[withoutRowid ? "WITHOUT ROWID" : "",strict ? "STRICT" : ""].filter(Boolean).join(", ");
  shadow.exec(`CREATE TABLE ${quote(table)} (${definitions.join(",")})${suffix ? " "+suffix : ""}`);
  const names=columns.map(column=>String(column.name));
  copyRows(source,shadow,table,names,heartbeat);
  return names;
}

function copyRows(source:DatabaseSync, target:DatabaseSync, table:string, columns:string[], heartbeat:()=>void):void {
  const select=source.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)}`);
  select.setReadBigInts(true);
  const insert=target.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(()=>"?").join(",")})`);
  let rows=0;
  for(const row of select.iterate()) {
    insert.run(...columns.map(column=>row[column]));
    if(++rows%HEARTBEAT_ROWS===0) heartbeat();
  }
}

/** Called only after the fast replay transaction rolls back a secondary-constraint conflict. */
// `steps` reports each phase to the host. Copying and rebuilding every row runs
// the app's indexes and generated columns, so each runs as a dataset check.
export function replayThroughShadow(database:DatabaseSync, input:{directory:string;tables:string[];changeset:Uint8Array;databaseBytes:number}, commit:()=>void,
  steps:{progress(step:string):void;datasetCheck:CpuBudgets["datasetCheck"]}={progress(){},datasetCheck:unbudgeted.datasetCheck}):void {
  const path=join(input.directory,`replay-${randomUUID()}.sqlite`);
  closeSync(openSync(path,"wx",0o600));
  let shadow:DatabaseSync | undefined;
  // The replayed dataset holds at most the current rows and the changeset's.
  const bytes=databaseBytes(database)+input.changeset.byteLength;
  const staging="copying the dataset for the replay", rebuilding="rebuilding the dataset from the replay copy";
  try {
    steps.progress(staging);
    shadow=new DatabaseSync(path,{allowExtension:false,enableForeignKeyConstraints:false,enableDoubleQuotedStringLiterals:false});
    shadow.exec(`PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=${Math.floor(input.databaseBytes/4096)}; BEGIN IMMEDIATE;`);
    const tables=steps.datasetCheck(bytes,()=>{
      const staged=input.tables.map(name=>({name,columns:stageTable(database,shadow!,name,()=>steps.progress(staging))}));
      let forbidden=false;
      const applied=shadow!.applyChangeset(input.changeset,{
        filter:name=>{const allowed=input.tables.includes(name);if(!allowed) forbidden=true;return allowed;},
        onConflict:()=>constants.SQLITE_CHANGESET_ABORT,
      });
      if(!applied || forbidden) reject("invalid_changeset","dohc cannot reapply this saved change to the Collection.");
      return staged;
    });
    steps.progress("saving the reapplied records");
    shadow.exec("COMMIT");

    // Replay restores accepted predicates; structural constraints and generated columns still apply.
    const triggers=database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    database.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON; BEGIN IMMEDIATE");
    try {
      steps.progress(rebuilding);
      for(const trigger of triggers) database.exec(`DROP TRIGGER ${quote(String(trigger.name))}`);
      const intact=steps.datasetCheck(bytes,()=>{
        for(const table of tables) database.exec(`DELETE FROM ${quote(table.name)}`);
        for(const table of tables) copyRows(shadow!,database,table.name,table.columns,()=>steps.progress(rebuilding));
        return database.prepare("PRAGMA foreign_key_check").iterate().next().done;
      });
      if(!intact) reject("invalid_changeset","The saved change breaks a foreign key between records.");
      for(const trigger of triggers) database.exec(String(trigger.sql));
      steps.progress("saving the rebuilt Collection");
      commit();database.exec("COMMIT");
    } catch(error) {if(database.isTransaction) database.exec("ROLLBACK");throw error;}
    finally {database.exec("PRAGMA foreign_keys=ON; PRAGMA ignore_check_constraints=OFF");}
  } finally {
    shadow?.close();
    for(const file of [path,path+"-journal"]) {
      try {unlinkSync(file);} catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
    }
  }
}
