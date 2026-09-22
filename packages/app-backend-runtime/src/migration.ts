import { DatabaseSync, constants } from "node:sqlite";
import { authorize, insertsImplicitRowid, sqlTokens } from "./guest.js";
import { reject } from "./persistent-protocol.js";
import type { RuntimeLimits } from "./protocol.js";

export const datasetSchema="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name != 'dohc_applied' ORDER BY type,name";
const options={allowExtension:false,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false};
const unsafeFunctions=new Set(["load_extension","readfile","writefile","edit","fts3_tokenizer"]);

function predicatesReadRowid(sql:string):boolean {
  const tokens=sqlTokens(sql);
  for(let index=0;index<tokens.length;index++) {
    const token=tokens[index];
    if(token.quoted || !["check","default","as"].includes(token.value)) continue;
    let depth=0;
    for(let next=index+1;next<tokens.length;next++) {
      const expression=tokens[next];
      const identifier=!expression.literal || tokens[next-1]?.value===".";
      if(identifier && ["rowid","oid","_rowid_"].includes(expression.value)) return true;
      if(expression.value==="("&&!expression.quoted)depth++;
      else if(expression.value===")"&&!expression.quoted){depth--;if(depth<=0)break;}
      else if(depth===0)break;
    }
  }
  return false;
}

export function assertReplayableSchema(schemaSql:string):void {
  // Ignore quoted identifiers, literals, and comments when finding the SQL keyword.
  const code=schemaSql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\//g," ");
  if (/\bAUTOINCREMENT\b/i.test(code)) reject("invalid_schema","AUTOINCREMENT is unavailable for journaled datasets. Use an INTEGER PRIMARY KEY or an explicit ID.");
}

export function verifyDatasetSchema(db:DatabaseSync, schemaSql:string, tables:string[], limits:RuntimeLimits, validateNewPredicates=false):void {
  assertReplayableSchema(schemaSql);
  const expected=new DatabaseSync(":memory:",options);
  try {
    expected.exec(`PRAGMA trusted_schema=OFF; PRAGMA ignore_check_constraints=ON; PRAGMA max_page_count=${Math.floor(limits.databaseBytes/4096)}`);
    authorize(expected,{tables},{initializing:true});
    expected.exec(schemaSql);expected.setAuthorizer(null);
    if (expected.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'").get()) reject("invalid_schema","AUTOINCREMENT is unavailable for journaled datasets. Use an INTEGER PRIMARY KEY or an explicit ID.");
    const schema=expected.prepare(datasetSchema).all();
    const declaredTables=schema.filter(row=>row.type==="table");
    if (declaredTables.length!==tables.length || declaredTables.some(row=>!tables.includes(String(row.name))) || schema.some(row=>!["table","index","trigger"].includes(String(row.type)))) reject("invalid_schema","Invalid dataset schema.");
    const capturedRowidTables=new Set<string>();
    for (const table of tables) {
      const columns=expected.prepare(`PRAGMA table_info("${table}")`).all();
      const primary=columns.filter(column=>Number(column.pk)>0);
      const rowid=primary.length===1 && String(primary[0].type).toUpperCase()==="INTEGER" && !expected.prepare(`PRAGMA index_list("${table}")`).all().some(index=>index.origin==="pk");
      if (!primary.length || (!rowid && primary.some(column=>Number(column.notnull)!==1))) reject("invalid_schema","Dataset tables require non-null primary keys.");
      if(rowid) capturedRowidTables.add(table.toLowerCase());
      if(!rowid && predicatesReadRowid(String(declaredTables.find(row=>row.name===table)!.sql))) reject("invalid_schema","Dataset predicates must use a declared primary key, not an implicit rowid.");
      if(columns.some(column=>/^(rowid|oid|_rowid_)$/i.test(String(column.name)) && !(rowid && column.name===primary[0].name))) reject("invalid_schema","Rowid aliases are reserved unless they name the INTEGER PRIMARY KEY.");
    }
    if(schema.some(row=>row.type==="trigger" && insertsImplicitRowid(String(row.sql),capturedRowidTables))) reject("invalid_schema","Triggers cannot insert implicit rowid values into journaled datasets.");
    if (JSON.stringify(db.prepare(datasetSchema).all())!==JSON.stringify(schema)) reject("invalid_checkpoint","Checkpoint schema does not match the approved dataset.");
  } finally {expected.close();}
  // Trusted host checkpoints contain previously accepted predicates, including time-dependent CHECKs.
  db.exec(validateNewPredicates ? "PRAGMA ignore_check_constraints=OFF" : "PRAGMA ignore_check_constraints=ON");
  try {
    if (db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check!=="ok" || !db.prepare("PRAGMA foreign_key_check").iterate().next().done) reject("invalid_checkpoint","Checkpoint integrity check failed.");
  } finally {db.exec("PRAGMA ignore_check_constraints=OFF");}
}

export function authorizeMigration(db:DatabaseSync, approved:string[]):void {
  const tables=new Set(approved.map(table=>table.toLowerCase()));
  const schemaTables=new Set(["sqlite_schema","sqlite_master"]);
  const safeObject=(name:string)=>!/^(dohc|sqlite)_/i.test(name);
  db.setAuthorizer((action,first,second,database)=>{
    const name=first?.toLowerCase() ?? "", parent=second?.toLowerCase() ?? "";
    // SQLite ALTER TABLE inspects the empty temp schema while rewriting references.
    if(database==="temp" && action===constants.SQLITE_READ && ["sqlite_temp_master","sqlite_temp_schema"].includes(name)) return constants.SQLITE_OK;
    if(database!==null && database!=="main") return constants.SQLITE_DENY;
    if(action===constants.SQLITE_SELECT || action===constants.SQLITE_RECURSIVE) return constants.SQLITE_OK;
    // SQLite validates ALTER ADD constraints through its table-valued quick_check pragma.
    if(action===constants.SQLITE_READ && name==="pragma_quick_check" && parent==="quick_check") return constants.SQLITE_OK;
    if(action===constants.SQLITE_PRAGMA && name==="quick_check" && tables.has(parent)) return constants.SQLITE_OK;
    if(action===constants.SQLITE_FUNCTION) return unsafeFunctions.has(parent) ? constants.SQLITE_DENY : constants.SQLITE_OK;
    if([constants.SQLITE_READ,constants.SQLITE_INSERT,constants.SQLITE_UPDATE,constants.SQLITE_DELETE].includes(action)) return tables.has(name) || schemaTables.has(name) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    if([constants.SQLITE_CREATE_TABLE,constants.SQLITE_DROP_TABLE].includes(action)) return tables.has(name) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    if(action===constants.SQLITE_ALTER_TABLE) return name==="main" && tables.has(parent) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    if([constants.SQLITE_CREATE_INDEX,constants.SQLITE_DROP_INDEX,constants.SQLITE_CREATE_TRIGGER,constants.SQLITE_DROP_TRIGGER].includes(action)) return tables.has(parent) && (safeObject(name) || name.startsWith("sqlite_autoindex_")) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    if(action===constants.SQLITE_REINDEX) return safeObject(name) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    return constants.SQLITE_DENY;
  });
}
