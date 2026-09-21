import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, constants } from "node:sqlite";
import { getQuickJS } from "quickjs-emscripten";
import { AppBackendRuntimeError, boundedText } from "./protocol.js";
import type { AppOperationRefusal, ChildReply, ChildRequest } from "./protocol.js";

const unsafeFunctions = new Set(["load_extension", "readfile", "writefile", "edit", "fts3_tokenizer"]);

function authorize(db: DatabaseSync, request: ChildRequest, initializing: boolean, sessionIntrospection = false): void {
  const tables = new Set(request.tables.map(name => name.toLowerCase()));
  const schemaTables = new Set(["sqlite_master", "sqlite_schema"]);
  const writable = initializing || (request.kind === "evaluate" && !request.readOnly);
  db.setAuthorizer((action, first, second, database) => {
    if (database !== null && database !== "main") return constants.SQLITE_DENY;
    const table = first?.toLowerCase() ?? "";
    if (action === constants.SQLITE_SELECT || action === constants.SQLITE_RECURSIVE) return constants.SQLITE_OK;
    if (action === constants.SQLITE_FUNCTION) return unsafeFunctions.has((second ?? "").toLowerCase()) ? constants.SQLITE_DENY : constants.SQLITE_OK;
    // SQLite's session extension reads table metadata while an admitted statement runs.
    if (sessionIntrospection && action === constants.SQLITE_PRAGMA && first === "table_xinfo" && tables.has((second ?? "").toLowerCase())) return constants.SQLITE_OK;
    if (action === constants.SQLITE_READ) return tables.has(table) || (initializing && schemaTables.has(table)) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    if ([constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE].includes(action)) {
      return writable && (tables.has(table) || (initializing && schemaTables.has(table))) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    }
    if (initializing) {
      if (action === constants.SQLITE_CREATE_TABLE) return tables.has(table) ? constants.SQLITE_OK : constants.SQLITE_DENY;
      if (action === constants.SQLITE_CREATE_INDEX || action === constants.SQLITE_CREATE_TRIGGER) return tables.has((second ?? "").toLowerCase()) ? constants.SQLITE_OK : constants.SQLITE_DENY;
    }
    return constants.SQLITE_DENY;
  });
}

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

async function evaluate(db: DatabaseSync, request: Extract<ChildRequest, {kind: "evaluate"}>): Promise<{resultJson: string; attachedFileIds: string[]}> {
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
      if (++statements > request.limits.statements || performance.now() >= deadline) throw new Error("App database operation limit exceeded.");
      if (vm.typeof(sqlValue) !== "string" || vm.typeof(paramsValue) !== "string") throw new Error("Invalid database arguments.");
      const sql = boundedText(vm.getString(sqlValue), request.limits.sourceBytes, "SQL statement");
      const paramsJson = boundedText(vm.getString(paramsValue), request.limits.inputBytes, "SQL parameters");
      const params: unknown = JSON.parse(paramsJson);
      if (!Array.isArray(params) || params.length > 128 || params.some(value => value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)))) throw new Error("SQL parameters must be scalar values.");
      if (!write) authorize(db, { ...request, readOnly: true }, false);
      let output: string;
      try {
        const statement = db.prepare(sql);
        if (write) {
          authorize(db, request, false, true);
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
        authorize(db, request, false);
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

async function handle(request: ChildRequest): Promise<ChildReply> {
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
      authorize(db, request, true);
      db.exec(request.schemaSql);
      db.setAuthorizer(null);
      verifySchema(db, request);
    } else if (request.kind === "validate") {
      verifySchema(db,request);
      const expected = new DatabaseSync(join(request.directory,"expected.sqlite"),{allowExtension:false,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false});
      try {
        expected.exec(`PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=${Math.floor(request.limits.databaseBytes / 4096)}`);
        authorize(expected,request,true);
        expected.exec(request.schemaSql);
        expected.setAuthorizer(null);
        verifySchema(expected,request);
        const schema="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
        if (JSON.stringify(db.prepare(schema).all()) !== JSON.stringify(expected.prepare(schema).all())) throw new Error("App database does not match its approved schema.");
        const integrity=db.prepare("PRAGMA integrity_check(1)").get();
        if (integrity?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").iterate().next().done !== true) throw new Error("App database integrity check failed.");
      } finally { expected.close(); }
    } else {
      verifySchema(db, request);
      const session = db.createSession();
      try {
        authorize(db, request, false);
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

process.once("message", (request: ChildRequest) => {
  void handle(request).then(reply => process.send!(reply, () => process.disconnect()), () => process.exit(1));
});
