import { closeSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, constants } from "node:sqlite";
import { reject } from "./persistent-protocol.js";

const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
type Columns=ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>;

function stageTable(source:DatabaseSync, shadow:DatabaseSync, table:string):string[] {
  const columns=source.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().filter(column=>Number(column.hidden)===0);
  const primary=columns.filter(column=>Number(column.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk));
  const index=source.prepare(`PRAGMA index_list(${quote(table)})`).all().find(index=>index.origin==="pk");
  const keys:Columns=index ? source.prepare(`PRAGMA index_xinfo(${quote(String(index.name))})`).all().filter(key=>key.key===1) : [];
  const withoutRowid=source.prepare("SELECT wr FROM pragma_table_list WHERE schema='main' AND name=?").get(table)?.wr===1;
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
  shadow.exec(`CREATE TABLE ${quote(table)} (${definitions.join(",")})${withoutRowid ? " WITHOUT ROWID" : ""}`);
  const names=columns.map(column=>String(column.name));
  copyRows(source,shadow,table,names);
  return names;
}

function copyRows(source:DatabaseSync, target:DatabaseSync, table:string, columns:string[]):void {
  const select=source.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)}`);
  select.setReadBigInts(true);
  const insert=target.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(()=>"?").join(",")})`);
  for(const row of select.iterate()) insert.run(...columns.map(column=>row[column]));
}

/** Called only after the fast replay transaction rolls back a secondary-constraint conflict. */
export function replayThroughShadow(database:DatabaseSync, input:{directory:string;tables:string[];changeset:Uint8Array;databaseBytes:number}, commit:()=>void):void {
  const path=join(input.directory,`replay-${randomUUID()}.sqlite`);
  closeSync(openSync(path,"wx",0o600));
  let shadow:DatabaseSync | undefined;
  try {
    shadow=new DatabaseSync(path,{allowExtension:false,enableForeignKeyConstraints:false,enableDoubleQuotedStringLiterals:false});
    shadow.exec(`PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=${Math.floor(input.databaseBytes/4096)}; BEGIN IMMEDIATE;`);
    const tables=input.tables.map(name=>({name,columns:stageTable(database,shadow!,name)}));
    let forbidden=false;
    const applied=shadow.applyChangeset(input.changeset,{
      filter:name=>{const allowed=input.tables.includes(name);if(!allowed) forbidden=true;return allowed;},
      onConflict:()=>constants.SQLITE_CHANGESET_ABORT,
    });
    if(!applied || forbidden) reject("invalid_changeset","The committed changeset cannot be replayed.");
    shadow.exec("COMMIT");

    // Canonical CHECK/UNIQUE constraints validate the final rows; generated columns recompute here.
    const triggers=database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    database.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      for(const trigger of triggers) database.exec(`DROP TRIGGER ${quote(String(trigger.name))}`);
      for(const table of tables) database.exec(`DELETE FROM ${quote(table.name)}`);
      for(const table of tables) copyRows(shadow,database,table.name,table.columns);
      if(!database.prepare("PRAGMA foreign_key_check").iterate().next().done) reject("invalid_changeset","The committed changeset violates a foreign-key constraint.");
      for(const trigger of triggers) database.exec(String(trigger.sql));
      commit();database.exec("COMMIT");
    } catch(error) {if(database.isTransaction) database.exec("ROLLBACK");throw error;}
    finally {database.exec("PRAGMA foreign_keys=ON");}
  } finally {
    shadow?.close();
    for(const file of [path,path+"-journal"]) {
      try {unlinkSync(file);} catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
    }
  }
}
