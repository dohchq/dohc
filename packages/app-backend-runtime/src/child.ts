import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppBackendRuntimeError } from "./protocol.js";
import type { ChildReply, ChildRequest } from "./protocol.js";
import { authorize, evaluate } from "./guest.js";
import { assertReplayableSchema, verifyDatasetSchema } from "./migration.js";

function verifySchema(db: DatabaseSync, request: ChildRequest): void {
  const actual = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  const tables = actual.filter(row => row.type === "table");
  if (actual.some(row => !["table", "index", "trigger"].includes(String(row.type))) ||
    tables.length !== request.tables.length || tables.some(row => !request.tables.includes(String(row.name)))) throw new Error("App database has undeclared schema objects.");
  for (const table of request.tables) {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
    const primary = columns.filter(column => Number(column.pk) > 0);
    if (!primary.length) throw new Error("Every app table requires a primary key.");
    const rowidAlias = primary.length === 1 && String(primary[0].type).toUpperCase() === "INTEGER" &&
      !db.prepare(`PRAGMA index_list("${table}")`).all().some(index=>index.origin === "pk");
    if (!rowidAlias && primary.some(column => Number(column.notnull) !== 1)) {
      throw new Error("App primary keys must be non-null.");
    }
  }
}

async function handle(request: ChildRequest): Promise<ChildReply> {
  if(request.kind!=="evaluate" && request.journaled) {
    try {assertReplayableSchema(request.schemaSql);}catch(error){return {ok:false,error:error instanceof Error ? error.message : "Invalid journaled schema."};}
  }
  const path = join(request.directory, "app.sqlite");
  if (request.kind !== "initialize") writeFileSync(path, request.database, { flag: "wx", mode: 0o600 });
  const db = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
  let transaction = false;
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA hard_heap_limit=67108864;");
    const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
    db.exec(`PRAGMA max_page_count=${Math.floor(request.limits.databaseBytes / pageSize)}`);
    db.exec("BEGIN IMMEDIATE"); transaction = true;
    let resultJson = "null", changeset = new Uint8Array(), attachedFileIds: string[] = [];
    if (request.kind === "initialize") {
      authorize(db, request, { initializing: true });
      db.exec(request.schemaSql);
      db.setAuthorizer(null);
      verifySchema(db, request);
      if(request.journaled) verifyDatasetSchema(db,request.schemaSql,request.tables,request.limits);
    } else if (request.kind === "validate") {
      verifySchema(db,request);
      if(request.journaled) verifyDatasetSchema(db,request.schemaSql,request.tables,request.limits);
      else {
      const expected = new DatabaseSync(join(request.directory,"expected.sqlite"),{allowExtension:false,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false});
      try {
        expected.exec(`PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=${Math.floor(request.limits.databaseBytes / 4096)}`);
        authorize(expected, request, { initializing: true });
        expected.exec(request.schemaSql);
        expected.setAuthorizer(null);
        verifySchema(expected,request);
        const schema="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
        if (JSON.stringify(db.prepare(schema).all()) !== JSON.stringify(expected.prepare(schema).all())) throw new Error("App database does not match its approved schema.");
        const integrity=db.prepare("PRAGMA integrity_check(1)").get();
        if (integrity?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").iterate().next().done !== true) throw new Error("App database integrity check failed.");
      } finally { expected.close(); }
      }
    } else {
      verifySchema(db, request);
      const session = db.createSession();
      try {
        ({resultJson,attachedFileIds} = await evaluate(db, request));
        db.setAuthorizer(null);
        changeset = session.changeset();
        if (changeset.byteLength > request.limits.databaseBytes) throw new Error("App changeset exceeds the runtime limit.");
      } finally { session.close(); }
    }
    db.exec("COMMIT"); transaction = false;
    db.close();
    const database = readFileSync(path);
    if (database.byteLength > request.limits.databaseBytes) throw new Error("App database exceeds the runtime limit.");
    return { ok: true, resultJson, database, changeset, attachedFileIds, changed: changeset.byteLength > 0 };
  } catch (error) {
    try { db.setAuthorizer(null); if (transaction) db.exec("ROLLBACK"); db.close(); } catch { /* Preserve the operation failure. */ }
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 1024) : "App operation failed.", ...(error instanceof AppBackendRuntimeError ? {refusal:error.refusal} : {}) };
  }
}

const parentPort = (process as unknown as {parentPort?: {on(event:"message",callback:(event:{data:ChildRequest | {kind:"close"}})=>void):void;postMessage(message:ChildReply):void}}).parentPort;
if (parentPort) {
  let started = false, completed = false;
  parentPort.on("message", ({data}) => {
    if (data.kind === "close") { if(completed) process.exit(0); return; }
    if (started) return;
    started = true;
    void handle(data).then(reply => { completed=true;parentPort.postMessage(reply); }, () => process.exit(1));
  });
} else {
  process.once("message", (request: ChildRequest) => {
    void handle(request).then(reply => process.send!(reply, () => process.disconnect()), () => process.exit(1));
  });
}
