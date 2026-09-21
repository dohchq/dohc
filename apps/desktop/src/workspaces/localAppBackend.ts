import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseAppBackendCapability, parseAppBackendInvokeRequest, parseAppBackendUploadRequest,
  type AppBackendFile } from "@dohc/security-contract/app-backend";
import { parseAppPublicationCandidate, type AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { AppOperationResult, EvaluateAppOperationInput, InitializeAppDatabaseInput, ValidateAppDatabaseInput } from "@dohc/app-backend-runtime";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";
import type { ClosedAppBuild } from "./closedAppCompiler";
import { parseLocalBackendRecovery, recoveryBytes, signLocalBackendRecovery } from "./localAppBackendRecovery";

export interface LocalAppBackendRuntime {
  initializeAppDatabase(input: InitializeAppDatabaseInput): Promise<Uint8Array>;
  evaluateAppOperation(input: EvaluateAppOperationInput): Promise<AppOperationResult>;
  validateAppDatabase(input: ValidateAppDatabaseInput): Promise<void>;
}
type Prepared = { candidate: AppPublicationCandidate; files: ClosedAppBuild["files"] };
type State = { data_path: string; app_root: string; publication_id: string; authority_revision: number;
  revision: number; source: string; capability: string; candidate: string; database: Uint8Array | null; shared_publication: string | null };
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const snapshotBound = 16 * 1024 * 1024;
// Leave room for base64 expansion and recovery metadata in the 128 MiB export.
const storeBound = 64 * 1024 * 1024 - 4096;

/** This store is local authority, not an offline write queue for a shared host. */
export async function createLocalAppBackendHost(options: {
  workspaceId: string; workspaceRoot: string; runtime: LocalAppBackendRuntime;
}) {
  if (!options.workspaceId || options.workspaceId.length > 256) throw new Error("Invalid local workspace identity.");
  const root = await realpath(options.workspaceRoot);
  let directory = root;
  for (const part of [".dohc", "app-backends"]) {
    directory = join(directory, part);
    await mkdir(directory, { recursive: false }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(directory)) !== resolve(directory)) throw new Error("The local app data directory must be inside this workspace.");
  }
  const databasePath = join(directory, "state.sqlite");
  for (const path of [databasePath,`${databasePath}-wal`,`${databasePath}-shm`]) {
    const file = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (file && (!file.isFile() || file.isSymbolicLink())) throw new Error("Invalid local app data file.");
  }
  const { DatabaseSync: Sqlite } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db: DatabaseSync = new Sqlite(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;
    CREATE TABLE IF NOT EXISTS identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),workspace_id TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS apps(data_path TEXT PRIMARY KEY, app_root TEXT NOT NULL, publication_id TEXT UNIQUE NOT NULL,
      authority_revision INTEGER NOT NULL, revision INTEGER NOT NULL, source TEXT NOT NULL, capability TEXT NOT NULL,
      candidate TEXT NOT NULL, database BLOB CHECK(length(database)<=16777216), shared_publication TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS receipts(data_path TEXT NOT NULL REFERENCES apps(data_path), key TEXT NOT NULL,
      payload_hash TEXT NOT NULL, result TEXT NOT NULL, revision INTEGER NOT NULL, recovery TEXT NOT NULL, PRIMARY KEY(data_path,key)) STRICT;
    CREATE TABLE IF NOT EXISTS history(data_path TEXT NOT NULL REFERENCES apps(data_path), revision INTEGER NOT NULL,
      publication_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, changeset BLOB NOT NULL, database_hash TEXT NOT NULL, recovery TEXT NOT NULL,
      PRIMARY KEY(data_path,revision)) STRICT;
    CREATE TABLE IF NOT EXISTS files(data_path TEXT NOT NULL REFERENCES apps(data_path), file_id TEXT NOT NULL,
      key TEXT NOT NULL, metadata TEXT NOT NULL, content BLOB NOT NULL, attached_revision INTEGER, recovery TEXT NOT NULL,
      PRIMARY KEY(data_path,file_id), UNIQUE(data_path,key)) STRICT;
    CREATE TABLE IF NOT EXISTS artifacts(data_path TEXT NOT NULL REFERENCES apps(data_path), path TEXT NOT NULL,
      metadata TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(data_path,path)) STRICT;
    CREATE TABLE IF NOT EXISTS shared_transfers(data_path TEXT PRIMARY KEY REFERENCES apps(data_path),
      confirmed_publication TEXT NOT NULL) STRICT;`);
  db.prepare("INSERT OR IGNORE INTO identity(singleton,workspace_id) VALUES(1,?)").run(options.workspaceId);
  if (db.prepare("SELECT workspace_id FROM identity WHERE singleton=1").get()!.workspace_id !== options.workspaceId) {
    db.close(); throw new Error("This local app store belongs to another workspace.");
  }
  let closed = false;
  const lifetime = new AbortController();
  const actor = {grant_id:"local-owner",principal_id:`local:${options.workspaceId}`};
  const receiptKey = (key: string) => JSON.stringify([actor.grant_id,actor.principal_id,key]);
  function assertCurrent() { if (closed) throw new Error("This local app session ended."); }
  function transaction<T>(work: () => T): T {
    assertCurrent(); db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function byPath(path: string) { return db.prepare("SELECT * FROM apps WHERE data_path=?").get(path) as State | undefined; }
  function state(publicationId: string, authorityRevision?: number, allowSharedRead = false) {
    assertCurrent();
    const row = db.prepare("SELECT * FROM apps WHERE publication_id=?").get(publicationId) as State | undefined;
    if (!row) throw new Error("This local app publication is unavailable. Prepare the app again.");
    if (row.shared_publication && !allowSharedRead) throw new Error("This app uses its shared host. Connect to that host to change its current data.");
    if (authorityRevision !== undefined && row.authority_revision !== authorityRevision) throw new Error("The app approval changed. Reload the app.");
    return row;
  }
  function quota() {
    const bytes = db.prepare(`SELECT
      (SELECT coalesce(sum(coalesce(length(database),0)+length(CAST(source AS BLOB))+length(CAST(candidate AS BLOB))+length(CAST(capability AS BLOB))),0) FROM apps)+
      (SELECT coalesce(sum(length(CAST(result AS BLOB))+length(CAST(recovery AS BLOB))),0) FROM receipts)+
      (SELECT coalesce(sum(length(changeset)+length(CAST(recovery AS BLOB))),0) FROM history)+
      (SELECT coalesce(sum(length(content)+length(CAST(recovery AS BLOB))+length(CAST(metadata AS BLOB))),0) FROM files)+
      (SELECT coalesce(sum(length(content)),0) FROM artifacts) AS bytes`).get()!.bytes as number;
    if (bytes > storeBound) throw new Error("Local app storage is full. Export its data before removing old work.");
    for(const table of ["history","receipts","files"])if(Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)>100000)throw new Error("Local app history is full. Export its data before continuing.");
  }
  function checkSignal(signal?: AbortSignal) { assertCurrent(); signal?.throwIfAborted(); }
  function combinedSignal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal; }
  function fileMetadata(row: { metadata: string }) { return JSON.parse(row.metadata) as AppBackendFile; }
  function readFiles(row: State, input: unknown) {
    const ids = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value)) ids.add(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(input);
    const files: AppBackendFile[] = [];
    for (const id of ids) {
      const found = db.prepare("SELECT metadata,recovery,attached_revision FROM files WHERE data_path=? AND file_id=?").get(row.data_path,id);
      if (found && (found.attached_revision!==null || JSON.parse(String(found.recovery)).expires_at_ms>Date.now())) files.push(fileMetadata(found as {metadata:string}));
    }
    if (files.length > 32) throw new Error("An operation can attach at most 32 files.");
    return files;
  }
  function description(row: State) { return { publicationId: row.publication_id, authorityRevision: row.authority_revision,
    capability: parseAppBackendCapability(JSON.parse(row.capability)), active: !!row.database && !row.shared_publication, revision: row.revision }; }

  function recordHistory(row: State, kind: "activate" | "operation" | "restore", nowMs: number, changeset: Uint8Array) {
    const capability = parseAppBackendCapability(JSON.parse(row.capability));
    const recovery = {workspace_id:options.workspaceId,data_path:row.data_path,revision:row.revision,publication_id:row.publication_id,
      publication_revision:row.authority_revision,source_sha256:capability.backendSha256,kind,
      grant_id:kind === "operation" ? actor.grant_id : "",principal_id:kind === "operation" ? actor.principal_id : "",
      changeset_base64:Buffer.from(changeset).toString("base64"),database_sha256:hash(row.database!),recorded_at_ms:nowMs};
    db.prepare("INSERT INTO history VALUES(?,?,?,?,?,?,?)").run(row.data_path,row.revision,row.publication_id,nowMs,changeset,hash(row.database!),JSON.stringify(recovery));
  }
  function exportData(row: State) {
    if (!row.database) throw new Error("This app has no data to export.");
    const capability = parseAppBackendCapability(JSON.parse(row.capability));
    const history=db.prepare("SELECT recovery FROM history WHERE data_path=? ORDER BY revision").all(row.data_path).map(record=>JSON.parse(String(record.recovery)));
    return signLocalBackendRecovery({formatVersion:1,snapshot:{workspaceId:options.workspaceId,dataPath:row.data_path,appRoot:row.app_root,
      publicationId:row.publication_id,publicationRevision:row.authority_revision-(row.shared_publication ? 1 : 0),schemaSha256:capability.schemaSha256,
      schemaVersion:capability.schemaVersion,sourceSha256:capability.backendSha256,source:row.source,capabilityJson:row.capability,
      revision:row.revision,databaseBase64:Buffer.from(row.database).toString("base64"),updatedAtMs:Number(history.at(-1).recorded_at_ms)},history,
      receipts:db.prepare("SELECT recovery FROM receipts WHERE data_path=? ORDER BY revision,key").all(row.data_path).map(record=>JSON.parse(String(record.recovery))),
      files:db.prepare("SELECT * FROM files WHERE data_path=? AND attached_revision IS NOT NULL ORDER BY file_id").all(row.data_path).map(record=>({
        ...JSON.parse(String(record.recovery)),attached_revision:record.attached_revision,content_base64:Buffer.from(record.content as Uint8Array).toString("base64")})),
    });
  }
  async function restore(publicationId:string,raw:unknown,signal?:AbortSignal) {
    const input=raw as {authorityRevision:number;bundle:unknown};
    if(!Number.isSafeInteger(input?.authorityRevision)||input.authorityRevision<1)throw new Error("Invalid app authority revision.");
    const row=state(publicationId,input.authorityRevision);
    if(row.database)throw new Error("Recovery cannot replace existing app data.");
    const bundle=parseLocalBackendRecovery(input.bundle),snapshot=bundle.snapshot,capability=parseAppBackendCapability(JSON.parse(row.capability));
    if(snapshot.workspaceId!==options.workspaceId || snapshot.dataPath!==row.data_path || snapshot.appRoot!==row.app_root ||
      snapshot.schemaSha256!==capability.schemaSha256 || snapshot.schemaVersion!==capability.schemaVersion || snapshot.sourceSha256!==capability.backendSha256)throw new Error("Recovery scope or source differs from the approved app.");
    const schema=db.prepare("SELECT content FROM artifacts WHERE data_path=? AND path=?").get(row.data_path,capability.schemaPath)?.content as Uint8Array;
    const database=recoveryBytes(snapshot.databaseBase64);
    await options.runtime.validateAppDatabase({database,schemaSql:new TextDecoder("utf-8",{fatal:true}).decode(schema),
      tables:capability.tables.map(table=>table.name),signal:combinedSignal(signal)});
    checkSignal(signal);
    return transaction(()=>{
      checkSignal(signal);const current=state(publicationId,input.authorityRevision);
      if(current.database)throw new Error("App data was initialized during recovery.");
      for(const history of bundle.history) db.prepare("INSERT INTO history VALUES(?,?,?,?,?,?,?)").run(row.data_path,Number(history.revision),String(history.publication_id),
        Number(history.recorded_at_ms),recoveryBytes(history.changeset_base64),String(history.database_sha256),JSON.stringify(history));
      for(const receipt of bundle.receipts) db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(row.data_path,
        JSON.stringify([receipt.grant_id,receipt.principal_id,receipt.idempotency_key]),String(receipt.payload_sha256),String(receipt.result_json),Number(receipt.revision),JSON.stringify(receipt));
      for(const file of bundle.files) {
        const bytes=recoveryBytes(file.content_base64,5*1024*1024),metadata={fileId:file.file_id,name:file.name,contentType:file.content_type,byteLength:bytes.byteLength,sha256:file.sha256};
        const {content_base64:_,attached_revision:__,...recovery}=file;
        db.prepare("INSERT INTO files VALUES(?,?,?,?,?,?,?)").run(row.data_path,String(file.file_id),JSON.stringify([file.grant_id,file.principal_id,file.idempotency_key]),
          JSON.stringify(metadata),bytes,Number(file.attached_revision),JSON.stringify(recovery));
      }
      const revision=snapshot.revision;
      db.prepare("UPDATE apps SET database=?,revision=? WHERE data_path=?").run(database,revision,row.data_path);
      quota();
      return {publicationId,authorityRevision:row.authority_revision,revision};
    });
  }

  async function activate(prepared: Prepared, signal?: AbortSignal, activation: {initialize?:boolean} = {}) {
    checkSignal(signal);
    const candidate = parseAppPublicationCandidate(prepared.candidate, APP_PUBLICATION_LIMITS);
    const rawCapability = candidate.capabilities[0];
    if (!rawCapability || rawCapability.kind !== "app-backend") throw new Error("This app has no declared backend.");
    const capability = parseAppBackendCapability(rawCapability);
    for (const metadata of candidate.files) {
      const content = prepared.files.find(file => file.path === metadata.path);
      if (!content || content.bytes.byteLength !== metadata.byteLength || hash(content.bytes) !== metadata.sha256) throw new Error("The approved app source changed.");
    }
    const source = new TextDecoder("utf-8", {fatal:true}).decode(prepared.files.find(file => file.path === capability.backendPath)!.bytes);
    const schemaSql = new TextDecoder("utf-8", {fatal:true}).decode(prepared.files.find(file => file.path === capability.schemaPath)!.bytes);
    const publicationId = hash(JSON.stringify(["dohc-local-app-v1", options.workspaceId, candidate]));
    const existing = byPath(capability.dataPath);
    if (existing?.shared_publication) throw new Error("This app already uses a shared host. Change its source there.");
    if (existing && existing.app_root !== candidate.appRoot) throw new Error("This app data belongs to another app.");
    if (existing && (JSON.parse(existing.capability).schemaSha256 !== capability.schemaSha256 || JSON.parse(existing.capability).schemaVersion !== capability.schemaVersion)) throw new Error("The app schema changed. An explicit data migration is required.");
    const database = existing?.database ?? (activation.initialize === false ? null : await options.runtime.initializeAppDatabase({schemaSql, tables:capability.tables.map(table=>table.name), signal:combinedSignal(signal)}));
    if (database && database.byteLength > snapshotBound) throw new Error("The app database is too large.");
    checkSignal(signal);
    return transaction(() => {
      checkSignal(signal);
      const current = byPath(capability.dataPath);
      if (current?.shared_publication || current?.revision !== existing?.revision) throw new Error("The app changed while it was prepared. Try again.");
      if (current?.publication_id === publicationId && (!!current.database || !database)) return description(current);
      const revision = database ? (current?.revision ?? 0) + 1 : 0, authorityRevision = (current?.authority_revision ?? 0) + 1;
      db.prepare(`INSERT INTO apps(data_path,app_root,publication_id,authority_revision,revision,source,capability,candidate,database)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(data_path) DO UPDATE SET publication_id=excluded.publication_id,
        authority_revision=excluded.authority_revision,revision=excluded.revision,source=excluded.source,
        capability=excluded.capability,candidate=excluded.candidate,database=excluded.database`).run(capability.dataPath,candidate.appRoot,publicationId,authorityRevision,revision,source,JSON.stringify(capability),JSON.stringify(candidate),database);
      db.prepare("DELETE FROM artifacts WHERE data_path=?").run(capability.dataPath);
      for (const metadata of candidate.files) db.prepare("INSERT INTO artifacts VALUES(?,?,?,?)").run(capability.dataPath,metadata.path,JSON.stringify(metadata),prepared.files.find(file=>file.path===metadata.path)!.bytes);
      if (database) recordHistory(state(publicationId),"activate",Date.now(),new Uint8Array());
      quota(); return description(state(publicationId));
    });
  }

  async function invoke(publicationId: string, raw: unknown, signal?: AbortSignal) {
    const request = parseAppBackendInvokeRequest(raw);
    const nowMs = Date.now(), requestId = randomUUID(), secret = randomBytes(32).toString("base64url");
    for (let attempt = 0; attempt < 3; attempt++) {
      checkSignal(signal);
      const row = state(publicationId,request.authorityRevision,true), capability = parseAppBackendCapability(JSON.parse(row.capability));
      const payloadHash = hash(JSON.stringify(["dohc-app-operation-v1",capability.dataPath,capability.backendSha256,capability.schemaSha256,request.operation,request.input]));
      if (!row.database) throw new Error("Restore the app data before running operations.");
      const operation = capability.operations.find(operation=>operation.name===request.operation);
      if (!operation) throw new Error("This operation was not approved for this app.");
      if (row.shared_publication && !operation.readOnly) throw new Error("This app uses its shared host. Connect to that host to change its current data.");
      const receipt = !operation.readOnly && db.prepare("SELECT * FROM receipts WHERE data_path=? AND key=?").get(row.data_path,receiptKey(request.idempotencyKey));
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new Error("This retry key was already used for another operation.");
        return {result:JSON.parse(String(receipt.result)),revision:receipt.revision,replayed:true};
      }
      let evaluated:AppOperationResult;
      try {
        evaluated = await options.runtime.evaluateAppOperation({source:row.source,operation:operation.name,
          caller:{kind:"owner",userId:`local:${options.workspaceId}`},input:request.input,nowMs,requestId,secret,
          database:row.database,tables:capability.tables.map(table=>table.name),readOnly:operation.readOnly,
          files:readFiles(row,request.input),signal:combinedSignal(signal)});
      } catch(error) {
        const unchanged=transaction(()=>{
          checkSignal(signal);
          return state(publicationId,request.authorityRevision,operation.readOnly).revision===row.revision;
        });
        if(!unchanged)continue;
        throw error;
      }
      checkSignal(signal);
      const result = transaction(() => {
        checkSignal(signal);
        const current = state(publicationId,request.authorityRevision,operation.readOnly);
        if (current.revision !== row.revision) return null;
        if (operation.readOnly) return {result:evaluated.result,revision:row.revision,replayed:false};
        const revision = row.revision + 1;
        if(!Number.isSafeInteger(revision))throw new Error("App history exceeded its revision limit.");
        for (const fileId of evaluated.attachedFileIds) {
          const file=db.prepare("SELECT recovery,attached_revision FROM files WHERE data_path=? AND file_id=?").get(row.data_path,fileId);
          if(!file || (file.attached_revision===null && JSON.parse(String(file.recovery)).expires_at_ms<=Date.now()))throw new Error("The attached file expired. Upload it again.");
          const updated = db.prepare("UPDATE files SET attached_revision=coalesce(attached_revision,?) WHERE data_path=? AND file_id=?").run(revision,row.data_path,fileId);
          if (updated.changes !== 1) throw new Error("The attached file is unavailable.");
        }
        db.prepare("UPDATE apps SET database=?,revision=? WHERE data_path=?").run(evaluated.database,revision,row.data_path);
        const recoveryReceipt={workspace_id:options.workspaceId,data_path:row.data_path,...actor,idempotency_key:request.idempotencyKey,
          payload_sha256:payloadHash,revision,result_json:JSON.stringify(evaluated.result),recorded_at_ms:nowMs};
        db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(row.data_path,receiptKey(request.idempotencyKey),payloadHash,JSON.stringify(evaluated.result),revision,JSON.stringify(recoveryReceipt));
        recordHistory({...row,database:evaluated.database,revision},"operation",nowMs,evaluated.changeset);
        quota(); return {result:evaluated.result,revision,replayed:false};
      });
      if (result) return result;
    }
    throw new Error("The app is busy. Retry with the same request key.");
  }

  async function request(publicationId: string, action: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    checkSignal(signal);
    if (action === "describe") return description(state(publicationId,undefined,true));
    if (action === "invoke") return invoke(publicationId,body,signal);
    if (action === "restore") return restore(publicationId,body,signal);
    const authorityRevision = (body as {authorityRevision?:unknown})?.authorityRevision;
    if (!Number.isSafeInteger(authorityRevision) || (authorityRevision as number) < 1) throw new Error("Invalid app authority revision.");
    return transaction(() => {
      checkSignal(signal);
      const row = state(publicationId,authorityRevision as number, action === "export" || action === "file");
      if (action === "helper") throw new Error("Share the app before adding helpers.");
      if (action === "upload") {
        if (row.shared_publication) throw new Error("This app uses its shared host. Connect to that host to upload files.");
        const input = parseAppBackendUploadRequest(body), bytes = Buffer.from(input.bytesBase64,"base64"), sha256 = hash(bytes);
        if (!row.database) throw new Error("Restore the app data before uploading files.");
        const staged=db.prepare("SELECT file_id,recovery FROM files WHERE data_path=? AND attached_revision IS NULL").all(row.data_path);
        for(const file of staged) if(JSON.parse(String(file.recovery)).expires_at_ms<=Date.now()) db.prepare("DELETE FROM files WHERE data_path=? AND file_id=? AND attached_revision IS NULL").run(row.data_path,String(file.file_id));
        const existing = db.prepare("SELECT * FROM files WHERE data_path=? AND key=?").get(row.data_path,receiptKey(input.idempotencyKey));
        if (existing) {
          const file = fileMetadata(existing as {metadata:string});
          if (file.sha256 !== sha256 || file.name !== input.name || file.contentType !== input.contentType) throw new Error("This retry key was already used for another upload.");
          return {file,replayed:true};
        }
        if(Number(db.prepare("SELECT count(*) AS n FROM files WHERE data_path=? AND attached_revision IS NULL").get(row.data_path)!.n)>=32) throw new Error("Attach or wait for existing uploads before uploading more files.");
        const file: AppBackendFile = {fileId:randomBytes(24).toString("base64url"),name:input.name,contentType:input.contentType,byteLength:bytes.byteLength,sha256};
        const nowMs=Date.now();
        const recovery={workspace_id:options.workspaceId,data_path:row.data_path,...actor,file_id:file.fileId,idempotency_key:input.idempotencyKey,
          name:file.name,content_type:file.contentType,sha256:file.sha256,created_at_ms:nowMs,expires_at_ms:nowMs+86400000};
        db.prepare("INSERT INTO files VALUES(?,?,?,?,?,NULL,?)").run(row.data_path,file.fileId,receiptKey(input.idempotencyKey),JSON.stringify(file),bytes,JSON.stringify(recovery));
        quota(); return {file,replayed:false};
      }
      if (action === "file") {
        const fileId = (body as {fileId?:unknown}).fileId;
        if (typeof fileId !== "string") throw new Error("Invalid app file.");
        const file = db.prepare("SELECT * FROM files WHERE data_path=? AND file_id=?").get(row.data_path,fileId);
        if (!file) throw new Error("This app file is unavailable.");
        return {file:fileMetadata(file as {metadata:string}),bytesBase64:Buffer.from(file.content as Uint8Array).toString("base64")};
      }
      if (action === "export") return exportData(row);
      throw new Error("Unsupported local app backend action.");
    });
  }
  return {
    activate, request, assertCurrent,
    assertBrowserPublication(publicationId:string,authorityRevision:number) {
      assertCurrent();
      const row=db.prepare("SELECT authority_revision,shared_publication,database IS NOT NULL AS initialized FROM apps WHERE publication_id=?").get(publicationId);
      if(!row || row.authority_revision!==authorityRevision || row.shared_publication!==null || row.initialized!==1)throw new Error("This local app approval changed. Open the app again.");
    },
    browserPublication(publicationId:string) {
      return transaction(()=>{
        const row=state(publicationId);if(!row.database)throw new Error("Restore the app data before opening it.");
        const capability=parseAppBackendCapability(JSON.parse(row.capability));
        const candidate=parseAppPublicationCandidate(JSON.parse(row.candidate),APP_PUBLICATION_LIMITS);
        const files=candidate.files.filter(file=>file.path!==capability.backendPath && file.path!==capability.schemaPath).map(file=>{
          const bytes=db.prepare("SELECT content FROM artifacts WHERE data_path=? AND path=?").get(row.data_path,file.path)?.content as Uint8Array|undefined;
          if(!bytes || bytes.byteLength!==file.byteLength || hash(bytes)!==file.sha256)throw new Error("The approved app artifact is unavailable.");
          return {...file,bytes:Uint8Array.from(bytes)};
        });
        return {publicationId,authorityRevision:row.authority_revision,appRoot:row.app_root,files};
      });
    },
    async readBrowserFile(publicationId:string,input:{authorityRevision:number;fileId:string;operation:string;input:unknown},signal?:AbortSignal) {
      if(!/^[A-Za-z0-9_-]{16,128}$/.test(input.fileId))throw new Error("Invalid app file.");
      const before=state(publicationId,input.authorityRevision),capability=parseAppBackendCapability(JSON.parse(before.capability));
      if(!capability.operations.some(operation=>operation.name===input.operation && operation.readOnly))throw new Error("Choose an approved read operation for this file.");
      const evaluated=await invoke(publicationId,{authorityRevision:input.authorityRevision,operation:input.operation,input:input.input,idempotencyKey:randomUUID()},signal);
      return transaction(()=>{
        checkSignal(signal);const current=state(publicationId,input.authorityRevision);
        if(current.revision!==evaluated.revision)throw new Error("The app changed while it read this file. Try again.");
        const result=evaluated.result;
        if(!result || typeof result!=="object" || Array.isArray(result) || Object.keys(result).length!==1 || result.fileId!==input.fileId)throw new Error("This operation did not allow access to the file.");
        const file=db.prepare("SELECT * FROM files WHERE data_path=? AND file_id=? AND attached_revision IS NOT NULL").get(current.data_path,input.fileId);
        if(!file)throw new Error("This app file is unavailable.");
        return {file:fileMetadata(file as {metadata:string}),bytesBase64:Buffer.from(file.content as Uint8Array).toString("base64")};
      });
    },
    has(publicationId: string) { assertCurrent(); return !!db.prepare("SELECT 1 FROM apps WHERE publication_id=?").get(publicationId); },
    findByDataPath(dataPath:string) {
      assertCurrent();const row=byPath(dataPath);
      return row ? {...description(row),appRoot:row.app_root,sourceRevision:JSON.parse(row.candidate).sourceRevision,sharedPublicationId:row.shared_publication,
        sharedTransferConfirmed:!!db.prepare("SELECT 1 FROM shared_transfers WHERE data_path=?").get(dataPath)} : null;
    },
    sharedPublicationFor(publicationId:string) {
      assertCurrent();return (db.prepare("SELECT shared_publication FROM apps WHERE publication_id=?").get(publicationId)?.shared_publication as string | null | undefined) ?? null;
    },
    advanceSharedAuthority(dataPath:string,expectedPublicationId:string,publicationId:string) {
      if(!publicationId || publicationId.length>128)throw new Error("Invalid shared app publication.");
      transaction(()=>{
        const row=byPath(dataPath);
        if(!row || row.shared_publication!==expectedPublicationId)throw new Error("The shared app authority changed. Reload the app.");
        db.prepare("UPDATE apps SET shared_publication=? WHERE data_path=?").run(publicationId,dataPath);
        db.prepare("INSERT INTO shared_transfers VALUES(?,?) ON CONFLICT(data_path) DO UPDATE SET confirmed_publication=excluded.confirmed_publication").run(dataPath,publicationId);
      });
    },
    list(appRoot: string) { assertCurrent(); return db.prepare("SELECT * FROM apps WHERE app_root=? ORDER BY publication_id").all(appRoot).map(record=>{
      const row = record as unknown as State;
      return {...description(row),appRoot:row.app_root,sourceRevision:JSON.parse(row.candidate).sourceRevision,
        backendCapability:JSON.parse(row.capability),sharedPublicationId:row.shared_publication};
    }); },
    setSharedAuthority(dataPath: string, publicationId: string) {
      if (!publicationId || publicationId.length > 128) throw new Error("Invalid shared app publication.");
      transaction(()=>{
        const row = byPath(dataPath);
        if (!row) return;
        if (row.shared_publication && row.shared_publication !== publicationId) throw new Error("This app already has a shared host.");
        if (row.shared_publication === publicationId) return;
        db.prepare("UPDATE apps SET shared_publication=?,authority_revision=authority_revision+1 WHERE data_path=?").run(publicationId,dataPath);
      });
    },
    transfer(dataPath:string,publicationId:string,expectedSharedPublicationId?:string) {
      if(!publicationId || publicationId.length>128)throw new Error("Invalid shared app publication.");
      return transaction(()=>{
        const row=byPath(dataPath);if(!row)throw new Error("This local app data is unavailable.");
        if(row.shared_publication && row.shared_publication!==publicationId &&
          (row.shared_publication!==expectedSharedPublicationId || db.prepare("SELECT 1 FROM shared_transfers WHERE data_path=?").get(dataPath)))throw new Error("This app already has a shared host.");
        const bundle=exportData(row);
        if(!row.shared_publication)db.prepare("UPDATE apps SET shared_publication=?,authority_revision=authority_revision+1 WHERE data_path=?").run(publicationId,dataPath);
        else if(row.shared_publication!==publicationId)db.prepare("UPDATE apps SET shared_publication=? WHERE data_path=?").run(publicationId,dataPath);
        return bundle;
      });
    },
    close() { if (!closed) { closed=true; lifetime.abort(); db.close(); } },
  };
}

export type LocalAppBackendHost = Awaited<ReturnType<typeof createLocalAppBackendHost>>;
