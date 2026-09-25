import { DatabaseSync, constants } from "node:sqlite";
import { getQuickJS } from "quickjs-emscripten";
import { AppBackendRuntimeError, boundedText } from "./protocol.js";
import type { AppOperationRefusal, ChildRequest } from "./protocol.js";

export type GuestRequest = Omit<Extract<ChildRequest, { kind: "evaluate" }>, "kind" | "directory" | "database">;

export interface GuestOptions {
  // Reused connections retain counters from prior operations and host metadata writes.
  persistentConnection?: boolean;
}

interface AuthorizationOptions extends GuestOptions {
  initializing?: boolean;
  sessionIntrospection?: boolean;
}

const connectionCounters = new Set(["changes", "total_changes", "last_insert_rowid"]);
const unsafeFunctions = new Set(["load_extension", "readfile", "writefile", "edit", "fts3_tokenizer"]);
const persistentRowidTables=new WeakMap<DatabaseSync,ReadonlySet<string>>();
export function sqlTokens(sql:string):Array<{value:string;quoted:boolean;literal:boolean}> {
  const tokens:Array<{value:string;quoted:boolean;literal:boolean}>=[];
  const pattern=/--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*|[^\s]/g;
  for(const match of sql.matchAll(pattern)) {
    const raw=match[0];if(raw.startsWith("--")||raw.startsWith("/*"))continue;
    const quote=raw[0],quoted="'\"`[".includes(quote);
    const value=quoted ? raw.slice(1,-1).replaceAll(quote+quote,quote) : raw;
    tokens.push({value:value.toLowerCase(),quoted,literal:quote==="'"});
  }
  return tokens;
}
/**
 * Whether SQLite would prepare a statement from `sql`. SQLite skips whitespace, comments, and semicolons, and
 * Node's binding passes the text up to its first NUL. Node 24.16's `node:sqlite` can crash the process after
 * preparing text with no statement, so a caller refuses such text before `prepare`.
 */
export function hasStatement(sql:string):boolean {
  for(let index=0;index<sql.length;) {
    const char=sql[index];
    if(char==="\0") return false;
    if(char===";" || " \t\n\v\f\r".includes(char)) index++;
    else if(sql.startsWith("--",index)) { const end=sql.indexOf("\n",index); if(end<0) return false; index=end+1; }
    else if(sql.startsWith("/*",index)) { const end=sql.indexOf("*/",index+2); if(end<0) return false; index=end+2; }
    else return true;
  }
  return false;
}
export function insertsImplicitRowid(sql:string, capturedTables:ReadonlySet<string>):boolean {
  // SQLite's authorizer reports INSERT at table granularity, without its column list.
  const tokens=sqlTokens(sql);
  const keyword=(index:number,value:string)=>tokens[index]?.value===value&&!tokens[index].quoted;
  for(let index=0;index<tokens.length;index++) {
    if(!keyword(index,"insert")&&!keyword(index,"replace"))continue;
    let next=index+1;
    if(keyword(next,"or"))next+=2;
    if(keyword(next,"into"))next++;
    let table=tokens[next++]?.value;
    if(tokens[next]?.value==="."){next++;table=tokens[next++]?.value;}
    if(!table||capturedTables.has(table))continue;
    if(keyword(next,"as"))next+=2;
    if(tokens[next++]?.value!=="(")continue;
    while(next<tokens.length&&tokens[next].value!==")") {
      if(["rowid","oid","_rowid_"].includes(tokens[next].value))return true;
      next++;
    }
  }
  return false;
}

export function authorize(
  db: DatabaseSync,
  request: { tables: string[]; readOnly?: boolean },
  { initializing = false, sessionIntrospection = false, persistentConnection = false }: AuthorizationOptions = {},
): void {
  const tables = new Set(request.tables.map(name => name.toLowerCase()));
  const schemaTables = new Set(["sqlite_master", "sqlite_schema"]);
  const admittedIndexes = new Set<string>();
  const writable = initializing || request.readOnly === false;
  db.setAuthorizer((action, first, second, database) => {
    if (database !== null && database !== "main") return constants.SQLITE_DENY;
    const table = first?.toLowerCase() ?? "";
    if (action === constants.SQLITE_SELECT || action === constants.SQLITE_RECURSIVE) return constants.SQLITE_OK;
    if (action === constants.SQLITE_FUNCTION) {
      const name = (second ?? "").toLowerCase();
      return unsafeFunctions.has(name) || (persistentConnection && connectionCounters.has(name)) ? constants.SQLITE_DENY : constants.SQLITE_OK;
    }
    // SQLite's session extension reads table metadata while an admitted statement runs.
    if (sessionIntrospection && action === constants.SQLITE_PRAGMA && first === "table_xinfo" && tables.has((second ?? "").toLowerCase())) return constants.SQLITE_OK;
    if (action === constants.SQLITE_READ) {
      if(persistentConnection && second?.toUpperCase()==="ROWID" && !persistentRowidTables.get(db)?.has(table)) return constants.SQLITE_DENY;
      return tables.has(table) || (initializing && schemaTables.has(table)) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    }
    if ([constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE].includes(action)) {
      if(persistentConnection && action===constants.SQLITE_UPDATE && second?.toUpperCase()==="ROWID" && !persistentRowidTables.get(db)?.has(table)) return constants.SQLITE_DENY;
      return writable && (tables.has(table) || (initializing && schemaTables.has(table))) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    }
    if (initializing) {
      if (action === constants.SQLITE_CREATE_TABLE) return tables.has(table) ? constants.SQLITE_OK : constants.SQLITE_DENY;
      if (action === constants.SQLITE_CREATE_INDEX && tables.has((second ?? "").toLowerCase())) {
        admittedIndexes.add(table);
        return constants.SQLITE_OK;
      }
      if (action === constants.SQLITE_REINDEX) return admittedIndexes.has(table) ? constants.SQLITE_OK : constants.SQLITE_DENY;
      if (action === constants.SQLITE_CREATE_TRIGGER) return tables.has((second ?? "").toLowerCase()) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    }
    return constants.SQLITE_DENY;
  });
}

// The trusted caller owns the transaction and clears authorization before host metadata writes.
export async function evaluate(db: DatabaseSync, request: GuestRequest, options: GuestOptions = {}): Promise<{resultJson: string; attachedFileIds: string[]}> {
  if(options.persistentConnection && !persistentRowidTables.has(db)) {
    db.setAuthorizer(null);
    const tables=new Set<string>();
    for(const table of request.tables) {
      const primary=db.prepare(`PRAGMA table_info("${table}")`).all().filter(column=>Number(column.pk)>0);
      if(primary.length===1 && String(primary[0].type).toUpperCase()==="INTEGER" && !db.prepare(`PRAGMA index_list("${table}")`).all().some(index=>index.origin==="pk")) tables.add(table.toLowerCase());
    }
    persistentRowidTables.set(db,tables);
  }
  authorize(db, request, options);
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(request.limits.memoryBytes);
  runtime.setMaxStackSize(request.limits.stackBytes);
  const deadline = performance.now() + request.limits.evaluationMs;
  runtime.setInterruptHandler(() => performance.now() >= deadline);
  runtime.removeModuleLoader();
  const vm = runtime.newContext();
  let statements = 0;
  let refusal: AppOperationRefusal | undefined;
  const attachedFileIds = new Set<string>();
  const callback = (write: boolean) => vm.newFunction(write ? "execute" : "query", (sqlValue, paramsValue) => {
    try {
      if (options.persistentConnection && !db.isTransaction) throw new Error("The app operation transaction ended.");
      if (++statements > request.limits.statements || performance.now() >= deadline) throw new Error("App database operation limit exceeded.");
      if (vm.typeof(sqlValue) !== "string" || vm.typeof(paramsValue) !== "string") throw new Error("Invalid database arguments.");
      const sql = boundedText(vm.getString(sqlValue), request.limits.sourceBytes, "SQL statement");
      if (!hasStatement(sql)) throw new Error("SQL statement is empty.");
      if(options.persistentConnection && write && insertsImplicitRowid(sql,persistentRowidTables.get(db)!)) throw new Error("Implicit rowid access is unavailable for journaled datasets.");
      const paramsJson = boundedText(vm.getString(paramsValue), request.limits.inputBytes, "SQL parameters");
      const params: unknown = JSON.parse(paramsJson);
      if (!Array.isArray(params) || params.length > 128 || params.some(value => value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)))) throw new Error("SQL parameters must be scalar values.");
      if (!write) authorize(db, { ...request, readOnly: true }, options);
      let output: string;
      try {
        const statement = db.prepare(sql);
        if (write) {
          authorize(db, request, { ...options, sessionIntrospection: true });
          const result = statement.run(...params);
          output = JSON.stringify({ changes: Number(result.changes) });
        } else {
          const rows = [];
          let bytes = 2;
          for (const row of statement.iterate(...params)) {
            if (Object.values(row).some(value => typeof value === "bigint" || value instanceof Uint8Array)) throw new Error("Query results must contain JSON scalars.");
            bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
            if (rows.length >= request.limits.queryRows || bytes > request.limits.queryBytes) throw new Error("App query result limit exceeded.");
            rows.push(row);
          }
          output = JSON.stringify(rows);
        }
      } finally {
        authorize(db, request, options);
      }
      return vm.newString(output);
    } catch (error) {
      return { error: vm.newError(error instanceof Error ? error.message.slice(0, 1024) : "App database operation failed.") };
    }
  });
  try {
    const query = callback(false), execute = callback(true);
    vm.setProp(vm.global, "__query", query);
    vm.setProp(vm.global, "__execute", execute);
    query.dispose(); execute.dispose();
    const refuse = vm.newFunction("refuse", (code, message) => {
      if (vm.typeof(code) !== "string" || vm.typeof(message) !== "string") return {error: vm.newError("Invalid refusal.")};
      const copiedCode = vm.getString(code), copiedMessage = vm.getString(message);
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(copiedCode) || Buffer.byteLength(copiedMessage) > 1024) return {error:vm.newError("Invalid refusal.")};
      refusal ??= {code:copiedCode,message:copiedMessage};
      return {error:vm.newError("App operation refused.")};
    });
    const attach = vm.newFunction("attach", fileId => {
      if (request.readOnly || vm.typeof(fileId) !== "string") return {error:vm.newError("File attachment is unavailable.")};
      const id=vm.getString(fileId), file=request.files.find(file=>file.fileId===id);
      if (!file) return {error:vm.newError("Unknown app file.")};
      attachedFileIds.add(id);
      return vm.newString(JSON.stringify(file));
    });
    vm.setProp(vm.global,"__refuse",refuse); vm.setProp(vm.global,"__attach",attach);
    refuse.dispose(); attach.dispose();
    const bootstrap = `(() => {
      const parse = JSON.parse, stringify = JSON.stringify, freeze = Object.freeze;
      const q = globalThis.__query, e = globalThis.__execute, refuse=globalThis.__refuse, attach=globalThis.__attach;
      delete globalThis.__query; delete globalThis.__execute; delete globalThis.__refuse; delete globalThis.__attach;
      const deepFreeze = value => { if (value && typeof value === 'object') { for (const key of Object.keys(value)) deepFreeze(value[key]); freeze(value); } return value; };
      const caller = deepFreeze(parse(${JSON.stringify(request.callerJson)}));
      const input = deepFreeze(parse(${JSON.stringify(request.inputJson)}));
      const db = freeze({ query: (sql, params = []) => parse(q(sql, stringify(params))), execute: (sql, params = []) => parse(e(sql, stringify(params))) });
      const ctx = freeze({ caller, db, refuse, files:freeze({attach:id=>deepFreeze(parse(attach(id)))}), nowMs: ${request.nowMs}, requestId: ${JSON.stringify(request.requestId)}, secret: ${JSON.stringify(request.secret)} });
      const hasOwn = Object.hasOwn;
      globalThis.__invokeOperation = () => {
        const operations = globalThis.operations;
        if (!operations || !hasOwn(operations, ${JSON.stringify(request.operation)}) || typeof operations[${JSON.stringify(request.operation)}] !== 'function') throw Error('Unknown app operation.');
        const result = operations[${JSON.stringify(request.operation)}](ctx, input);
        if (result && typeof result.then === 'function') throw Error('App operations must be synchronous.');
        const output = stringify(result);
        if (typeof output !== 'string') throw Error('App operation must return JSON.');
        return output;
      };
    })();`;
    const boot = vm.evalCode(bootstrap);
    if (boot.error) { boot.error.dispose(); throw new Error("App operation context could not be initialized."); }
    boot.value.dispose();
    const invoke = vm.getProp(vm.global, "__invokeOperation");
    const removed = vm.evalCode("delete globalThis.__invokeOperation;");
    removed.dispose();
    try {
      const loaded = vm.evalCode(request.source, "app-backend.js");
      if (loaded.error) { loaded.error.dispose(); throw new Error("App operation source failed."); }
      loaded.value.dispose();
      const result = vm.callFunction(invoke, vm.undefined);
      if (refusal) { result.dispose(); throw new AppBackendRuntimeError(refusal); }
      if (result.error) {
        // No guest getters or coercion run while formatting an exception.
        result.error.dispose();
        throw new Error("App operation failed.");
      }
      try {
        if (vm.typeof(result.value) !== "string") throw new Error("App operation must return JSON.");
        return {resultJson:boundedText(vm.getString(result.value), request.limits.resultBytes, "Operation result"),attachedFileIds:[...attachedFileIds]};
      } finally { result.value.dispose(); }
    } finally { invoke.dispose(); }
  } finally {
    vm.dispose(); runtime.dispose();
  }
}
