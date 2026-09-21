import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseAppBackendCapability, parseAppBackendInvokeRequest, parseAppBackendUploadRequest,
  type AppBackendFile } from "@dohc/security-contract/app-backend";
import { parseAppPublicationCandidate, type AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { AppOperationResult, EvaluateAppOperationInput, InitializeAppDatabaseInput } from "@dohc/app-backend-runtime";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";
import type { ClosedAppBuild } from "./closedAppCompiler";

export interface LocalAppBackendRuntime {
  initializeAppDatabase(input: InitializeAppDatabaseInput): Promise<Uint8Array>;
  evaluateAppOperation(input: EvaluateAppOperationInput): Promise<AppOperationResult>;
}
type Prepared = { candidate: AppPublicationCandidate; files: ClosedAppBuild["files"] };
type State = { data_path: string; app_root: string; publication_id: string; authority_revision: number;
  revision: number; source: string; capability: string; candidate: string; database: Uint8Array; shared_publication: string | null };
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const snapshotBound = 16 * 1024 * 1024;
const storeBound = 128 * 1024 * 1024;

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
  const file = await lstat(databasePath).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  if (file && (!file.isFile() || file.isSymbolicLink())) throw new Error("Invalid local app data file.");
  const { DatabaseSync: Sqlite } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db: DatabaseSync = new Sqlite(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS identity(workspace_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS apps(data_path TEXT PRIMARY KEY, app_root TEXT NOT NULL, publication_id TEXT UNIQUE NOT NULL,
      authority_revision INTEGER NOT NULL, revision INTEGER NOT NULL, source TEXT NOT NULL, capability TEXT NOT NULL,
      candidate TEXT NOT NULL, database BLOB NOT NULL CHECK(length(database)<=16777216), shared_publication TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS receipts(data_path TEXT NOT NULL REFERENCES apps(data_path), key TEXT NOT NULL,
      payload_hash TEXT NOT NULL, result TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(data_path,key)) STRICT;
    CREATE TABLE IF NOT EXISTS history(data_path TEXT NOT NULL REFERENCES apps(data_path), revision INTEGER NOT NULL,
      publication_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, changeset BLOB NOT NULL, database_hash TEXT NOT NULL,
      PRIMARY KEY(data_path,revision)) STRICT;
    CREATE TABLE IF NOT EXISTS files(data_path TEXT NOT NULL REFERENCES apps(data_path), file_id TEXT NOT NULL,
      key TEXT NOT NULL, metadata TEXT NOT NULL, content BLOB NOT NULL, attached_revision INTEGER,
      PRIMARY KEY(data_path,file_id), UNIQUE(data_path,key)) STRICT;
    CREATE TABLE IF NOT EXISTS artifacts(data_path TEXT NOT NULL REFERENCES apps(data_path), path TEXT NOT NULL,
      metadata TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(data_path,path)) STRICT;`);
  const identity = db.prepare("SELECT workspace_id FROM identity").get();
  if (identity && identity.workspace_id !== options.workspaceId) { db.close(); throw new Error("This local app store belongs to another workspace."); }
  db.prepare("INSERT OR IGNORE INTO identity(workspace_id) VALUES(?)").run(options.workspaceId);
  let closed = false;
  const lifetime = new AbortController();
  function assertCurrent() { if (closed) throw new Error("This local app session ended."); }
  function transaction<T>(work: () => T): T {
    assertCurrent(); db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function byPath(path: string) { return db.prepare("SELECT * FROM apps WHERE data_path=?").get(path) as State | undefined; }
  function state(publicationId: string, authorityRevision?: number) {
    assertCurrent();
    const row = db.prepare("SELECT * FROM apps WHERE publication_id=?").get(publicationId) as State | undefined;
    if (!row) throw new Error("This local app publication is unavailable. Prepare the app again.");
    if (row.shared_publication) throw new Error("This app uses its shared host. Connect to that host to read or change its current data.");
    if (authorityRevision !== undefined && row.authority_revision !== authorityRevision) throw new Error("The app approval changed. Reload the app.");
    return row;
  }
  function quota() {
    const bytes = db.prepare(`SELECT
      (SELECT coalesce(sum(length(database)+length(source)+length(candidate)+length(capability)),0) FROM apps)+
      (SELECT coalesce(sum(length(result)),0) FROM receipts)+
      (SELECT coalesce(sum(length(changeset)),0) FROM history)+
      (SELECT coalesce(sum(length(content)),0) FROM files)+
      (SELECT coalesce(sum(length(content)),0) FROM artifacts) AS bytes`).get()!.bytes as number;
    if (bytes > storeBound) throw new Error("Local app storage is full. Export its data before removing old work.");
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
      const found = db.prepare("SELECT metadata FROM files WHERE data_path=? AND file_id=?").get(row.data_path,id);
      if (found) files.push(fileMetadata(found as {metadata:string}));
    }
    if (files.length > 32) throw new Error("An operation can attach at most 32 files.");
    return files;
  }
  function description(row: State) { return { publicationId: row.publication_id, authorityRevision: row.authority_revision,
    capability: parseAppBackendCapability(JSON.parse(row.capability)), active: true, revision: row.revision }; }

  async function activate(prepared: Prepared, signal?: AbortSignal) {
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
    if (existing && JSON.parse(existing.capability).schemaSha256 !== capability.schemaSha256) throw new Error("The app schema changed. An explicit data migration is required.");
    const database = existing?.database ?? await options.runtime.initializeAppDatabase({schemaSql, tables:capability.tables.map(table=>table.name), signal:combinedSignal(signal)});
    if (database.byteLength > snapshotBound) throw new Error("The app database is too large.");
    checkSignal(signal);
    return transaction(() => {
      checkSignal(signal);
      const current = byPath(capability.dataPath);
      if (current?.shared_publication || current?.revision !== existing?.revision) throw new Error("The app changed while it was prepared. Try again.");
      if (current?.publication_id === publicationId) return description(current);
      const revision = (current?.revision ?? 0) + 1, authorityRevision = (current?.authority_revision ?? 0) + 1;
      db.prepare(`INSERT INTO apps(data_path,app_root,publication_id,authority_revision,revision,source,capability,candidate,database)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(data_path) DO UPDATE SET publication_id=excluded.publication_id,
        authority_revision=excluded.authority_revision,revision=excluded.revision,source=excluded.source,
        capability=excluded.capability,candidate=excluded.candidate`).run(capability.dataPath,candidate.appRoot,publicationId,authorityRevision,revision,source,JSON.stringify(capability),JSON.stringify(candidate),database);
      db.prepare("DELETE FROM artifacts WHERE data_path=?").run(capability.dataPath);
      for (const metadata of candidate.files) db.prepare("INSERT INTO artifacts VALUES(?,?,?,?)").run(capability.dataPath,metadata.path,JSON.stringify(metadata),prepared.files.find(file=>file.path===metadata.path)!.bytes);
      db.prepare("INSERT INTO history VALUES(?,?,?,?,?,?)").run(capability.dataPath,revision,publicationId,Date.now(),new Uint8Array(),hash(database));
      quota(); return description(state(publicationId));
    });
  }

  async function invoke(publicationId: string, raw: unknown, signal?: AbortSignal) {
    const request = parseAppBackendInvokeRequest(raw);
    const nowMs = Date.now(), requestId = randomUUID(), secret = randomBytes(32).toString("base64url");
    const payloadHash = hash(JSON.stringify([request.operation, request.input]));
    for (let attempt = 0; attempt < 3; attempt++) {
      checkSignal(signal);
      const row = state(publicationId,request.authorityRevision), capability = parseAppBackendCapability(JSON.parse(row.capability));
      const operation = capability.operations.find(operation=>operation.name===request.operation);
      if (!operation) throw new Error("This operation was not approved for this app.");
      const receipt = !operation.readOnly && db.prepare("SELECT * FROM receipts WHERE data_path=? AND key=?").get(row.data_path,request.idempotencyKey);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new Error("This retry key was already used for another operation.");
        return {result:JSON.parse(String(receipt.result)),revision:receipt.revision,replayed:true};
      }
      const evaluated = await options.runtime.evaluateAppOperation({source:row.source,operation:operation.name,
        caller:{kind:"owner",userId:`local:${options.workspaceId}`},input:request.input,nowMs,requestId,secret,
        database:row.database,tables:capability.tables.map(table=>table.name),readOnly:operation.readOnly,
        files:readFiles(row,request.input),signal:combinedSignal(signal)});
      checkSignal(signal);
      const result = transaction(() => {
        checkSignal(signal);
        const current = state(publicationId,request.authorityRevision);
        if (current.revision !== row.revision) return null;
        if (operation.readOnly) return {result:evaluated.result,revision:row.revision,replayed:false};
        const revision = row.revision + 1;
        for (const fileId of evaluated.attachedFileIds) {
          const updated = db.prepare("UPDATE files SET attached_revision=coalesce(attached_revision,?) WHERE data_path=? AND file_id=?").run(revision,row.data_path,fileId);
          if (updated.changes !== 1) throw new Error("The attached file is unavailable.");
        }
        db.prepare("UPDATE apps SET database=?,revision=? WHERE data_path=?").run(evaluated.database,revision,row.data_path);
        db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?)").run(row.data_path,request.idempotencyKey,payloadHash,JSON.stringify(evaluated.result),revision);
        db.prepare("INSERT INTO history VALUES(?,?,?,?,?,?)").run(row.data_path,revision,publicationId,nowMs,evaluated.changeset,hash(evaluated.database));
        quota(); return {result:evaluated.result,revision,replayed:false};
      });
      if (result) return result;
    }
    throw new Error("The app is busy. Retry with the same request key.");
  }

  async function request(publicationId: string, action: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    checkSignal(signal);
    if (action === "describe") return description(state(publicationId));
    if (action === "invoke") return invoke(publicationId,body,signal);
    const authorityRevision = (body as {authorityRevision?:unknown})?.authorityRevision;
    if (!Number.isSafeInteger(authorityRevision) || (authorityRevision as number) < 1) throw new Error("Invalid app authority revision.");
    return transaction(() => {
      checkSignal(signal);
      const row = state(publicationId,authorityRevision as number);
      if (action === "helper") throw new Error("Share the app before adding helpers.");
      if (action === "upload") {
        const input = parseAppBackendUploadRequest(body), bytes = Buffer.from(input.bytesBase64,"base64"), sha256 = hash(bytes);
        const existing = db.prepare("SELECT * FROM files WHERE data_path=? AND key=?").get(row.data_path,input.idempotencyKey);
        if (existing) {
          const file = fileMetadata(existing as {metadata:string});
          if (file.sha256 !== sha256 || file.name !== input.name || file.contentType !== input.contentType) throw new Error("This retry key was already used for another upload.");
          return {file,replayed:true};
        }
        const file: AppBackendFile = {fileId:randomBytes(24).toString("base64url"),name:input.name,contentType:input.contentType,byteLength:bytes.byteLength,sha256};
        db.prepare("INSERT INTO files VALUES(?,?,?,?,?,NULL)").run(row.data_path,file.fileId,input.idempotencyKey,JSON.stringify(file),bytes);
        quota(); return {file,replayed:false};
      }
      if (action === "file") {
        const fileId = (body as {fileId?:unknown}).fileId;
        if (typeof fileId !== "string") throw new Error("Invalid app file.");
        const file = db.prepare("SELECT * FROM files WHERE data_path=? AND file_id=?").get(row.data_path,fileId);
        if (!file) throw new Error("This app file is unavailable.");
        return {file:fileMetadata(file as {metadata:string}),bytesBase64:Buffer.from(file.content as Uint8Array).toString("base64")};
      }
      if (action === "export") return {format:"dohc-local-app-backend-v1",workspaceId:options.workspaceId,dataPath:row.data_path,
        candidate:JSON.parse(row.candidate),revision:row.revision,databaseBase64:Buffer.from(row.database).toString("base64"),
        receipts:db.prepare("SELECT key,payload_hash,result,revision FROM receipts WHERE data_path=? ORDER BY revision,key").all(row.data_path),
        history:db.prepare("SELECT * FROM history WHERE data_path=? ORDER BY revision").all(row.data_path).map(record=>({...record,changeset:Buffer.from(record.changeset as Uint8Array).toString("base64")})),
        files:db.prepare("SELECT * FROM files WHERE data_path=? ORDER BY file_id").all(row.data_path).map(record=>({...record,content:Buffer.from(record.content as Uint8Array).toString("base64")})),
        artifacts:db.prepare("SELECT * FROM artifacts WHERE data_path=? ORDER BY path").all(row.data_path).map(record=>({...record,content:Buffer.from(record.content as Uint8Array).toString("base64")}))};
      throw new Error("Unsupported local app backend action.");
    });
  }
  return {
    activate, request, assertCurrent,
    has(publicationId: string) { assertCurrent(); return !!db.prepare("SELECT 1 FROM apps WHERE publication_id=?").get(publicationId); },
    list(appRoot: string) { assertCurrent(); return db.prepare("SELECT * FROM apps WHERE app_root=? ORDER BY publication_id").all(appRoot).map(record=>{
      const row = record as unknown as State;
      return {...description(row),appRoot:row.app_root,backendCapability:JSON.parse(row.capability),sharedPublicationId:row.shared_publication};
    }); },
    setSharedAuthority(dataPath: string, publicationId: string) {
      if (!publicationId || publicationId.length > 128) throw new Error("Invalid shared app publication.");
      transaction(()=>{
        const row = byPath(dataPath);
        if (!row) return;
        if (row.shared_publication && row.shared_publication !== publicationId) throw new Error("This app already has a shared host.");
        db.prepare("UPDATE apps SET shared_publication=?,authority_revision=authority_revision+1 WHERE data_path=?").run(publicationId,dataPath);
      });
    },
    close() { if (!closed) { closed=true; lifetime.abort(); db.close(); } },
  };
}

export type LocalAppBackendHost = Awaited<ReturnType<typeof createLocalAppBackendHost>>;
