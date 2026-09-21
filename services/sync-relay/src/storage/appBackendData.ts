import { createHash, randomUUID } from "node:crypto";
import { badRequest, notFound, relayError } from "../errors";
import type { StorageContext } from "./context";
import { assertWorkspaceQuota } from "./workspaces";

const MAX_DATABASE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function authorizeNow(authorize: () => void): void {
  const result: unknown = authorize();
  if (result !== null && (typeof result === "object" || typeof result === "function") &&
      typeof (result as {then?: unknown}).then === "function") throw new TypeError("App authorization must be synchronous.");
}

export interface AppBackendScope { workspaceId: string; dataPath: string }
export interface AppBackendCaller { grantId: string; principalId: string }
export interface AppBackendSnapshot extends AppBackendScope {
  appRoot: string;
  publicationId: string;
  publicationRevision: number;
  schemaSha256: string;
  schemaVersion: number;
  sourceSha256: string;
  source: string;
  capabilityJson: string;
  revision: number;
  database: Uint8Array;
  updatedAtMs: number;
}
export interface ActivateAppBackendInput extends Omit<AppBackendSnapshot, "revision" | "updatedAtMs"> {
  expectedRevision: number | null;
  nowMs: number;
  authorize: () => void;
}
export interface AppBackendReceiptScope extends AppBackendScope {
  caller: AppBackendCaller;
  idempotencyKey: string;
  payloadSha256: string;
}
export interface AppBackendReceipt { revision: number; result: unknown }
export interface CommitAppBackendOperationInput extends AppBackendReceiptScope {
  expectedRevision: number;
  publicationId: string;
  publicationRevision: number;
  schemaSha256: string;
  database: Uint8Array;
  changeset: Uint8Array;
  result: unknown;
  attachedFileIds: readonly string[];
  nowMs: number;
  authorize: () => void;
}
export type CommitAppBackendOperationResult =
  | ({ kind: "committed" | "replayed" } & AppBackendReceipt)
  | { kind: "conflict" };

function identity(scope: AppBackendScope): void {
  for (const value of [scope.workspaceId, scope.dataPath]) {
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4096 || value.includes("\0")) throw badRequest("Invalid app data scope.");
  }
}
function boundedBytes(value: Uint8Array, max: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength > max) throw badRequest("App data exceeds its size limit.");
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw badRequest("Invalid app data timestamp.");
}
function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw badRequest("Invalid app data revision.");
}
function caller(value: AppBackendCaller): void {
  for (const part of [value.grantId, value.principalId]) {
    if (typeof part !== "string" || !part || Buffer.byteLength(part) > 512) throw badRequest("Invalid app caller.");
  }
}
function key(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw badRequest("Invalid app idempotency key.");
}
function digest(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw badRequest("Invalid app digest.");
}
function nextRevision(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) throw relayError("conflict", "App revision exhausted.");
  return value + 1;
}
function rowSnapshot(row: Record<string, unknown>): AppBackendSnapshot {
  return {
    workspaceId: String(row.workspace_id), dataPath: String(row.data_path), appRoot: String(row.app_root),
    publicationId: String(row.publication_id), publicationRevision: Number(row.publication_revision),
    schemaSha256: String(row.schema_sha256), schemaVersion: Number(row.schema_version),
    sourceSha256: String(row.source_sha256), source: String(row.source), capabilityJson: String(row.capability_json),
    revision: Number(row.revision), database: new Uint8Array(row.database as Uint8Array), updatedAtMs: Number(row.updated_at_ms),
  };
}
function snapshotBytes(snapshot: AppBackendSnapshot): number {
  const {database, ...metadata} = snapshot;
  return database.byteLength + size(metadata) + 256;
}

/** Internal read: routes must establish authority before exposing any returned data. */
export function readAppBackendSnapshot(storage: StorageContext, scope: AppBackendScope): AppBackendSnapshot | null {
  identity(scope);
  const row = storage.db.prepare("SELECT * FROM sync_relay_app_backends WHERE workspace_id=? AND data_path=?").get(scope.workspaceId, scope.dataPath);
  return row ? rowSnapshot(row) : null;
}

function historyRow(snapshot: AppBackendSnapshot, kind: "activate" | "operation", actor: AppBackendCaller, changeset: Uint8Array) {
  return [snapshot.workspaceId, snapshot.dataPath, snapshot.revision, snapshot.publicationId, snapshot.publicationRevision,
    snapshot.sourceSha256, kind, actor.grantId, actor.principalId, changeset, sha(snapshot.database), snapshot.updatedAtMs] as const;
}
function historyBytes(values: ReturnType<typeof historyRow>): number {
  return size(values.filter(value => !(value instanceof Uint8Array))) + values[9].byteLength + 256;
}
function insertHistory(storage: StorageContext, values: ReturnType<typeof historyRow>): void {
  storage.db.prepare(`INSERT INTO sync_relay_app_backend_history(workspace_id,data_path,revision,publication_id,publication_revision,
    source_sha256,kind,grant_id,principal_id,changeset,database_sha256,recorded_at_ms,storage_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(...values, historyBytes(values));
}

/** Prepared bytes are produced outside the relay writer transaction. */
export function activateAppBackend(storage: StorageContext, input: ActivateAppBackendInput): AppBackendSnapshot {
  identity(input); boundedBytes(input.database, MAX_DATABASE_BYTES); timestamp(input.nowMs);
  positive(input.publicationRevision); positive(input.schemaVersion); digest(input.schemaSha256); digest(input.sourceSha256);
  if (input.expectedRevision !== null) positive(input.expectedRevision);
  if (!input.appRoot || Buffer.byteLength(input.appRoot) > 4096 || !input.publicationId || Buffer.byteLength(input.publicationId) > 512 ||
      Buffer.byteLength(input.source) > 1024 * 1024 || sha(input.source) !== input.sourceSha256 || Buffer.byteLength(input.capabilityJson) > 65536) throw badRequest("Invalid app backend activation.");
  JSON.parse(input.capabilityJson);
  return storage.tx(() => {
    authorizeNow(input.authorize);
    const previous = readAppBackendSnapshot(storage, input);
    if ((previous?.revision ?? null) !== input.expectedRevision) throw relayError("conflict", "App data changed during activation.");
    if (previous && (previous.appRoot !== input.appRoot || previous.schemaSha256 !== input.schemaSha256 || previous.schemaVersion !== input.schemaVersion)) {
      throw relayError("conflict", "App data binding or schema changed; explicit migration is required.");
    }
    const snapshot: AppBackendSnapshot = {
      workspaceId: input.workspaceId, dataPath: input.dataPath, appRoot: input.appRoot,
      publicationId: input.publicationId, publicationRevision: input.publicationRevision,
      schemaSha256: input.schemaSha256, schemaVersion: input.schemaVersion, sourceSha256: input.sourceSha256,
      source: input.source, capabilityJson: input.capabilityJson, database: previous?.database ?? input.database,
      revision: previous ? nextRevision(previous.revision) : 1, updatedAtMs: input.nowMs,
    };
    const bytes = snapshotBytes(snapshot), history = historyRow(snapshot, "activate", {grantId: "", principalId: ""}, new Uint8Array());
    assertWorkspaceQuota(storage, input.workspaceId, bytes - (previous ? snapshotBytes(previous) : 0) + historyBytes(history));
    storage.db.prepare(`INSERT INTO sync_relay_app_backends(workspace_id,data_path,app_root,publication_id,publication_revision,
      schema_sha256,schema_version,source_sha256,source,capability_json,revision,database,updated_at_ms,storage_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id,data_path) DO UPDATE SET publication_id=excluded.publication_id,publication_revision=excluded.publication_revision,
      source_sha256=excluded.source_sha256,source=excluded.source,capability_json=excluded.capability_json,
      revision=excluded.revision,updated_at_ms=excluded.updated_at_ms,storage_bytes=excluded.storage_bytes`)
      .run(snapshot.workspaceId,snapshot.dataPath,snapshot.appRoot,snapshot.publicationId,snapshot.publicationRevision,
        snapshot.schemaSha256,snapshot.schemaVersion,snapshot.sourceSha256,snapshot.source,snapshot.capabilityJson,
        snapshot.revision,snapshot.database,snapshot.updatedAtMs,bytes);
    insertHistory(storage, history);
    return snapshot;
  });
}

/** Authority must be checked before receipt replay, including after restart. */
export function findAppBackendReceipt(storage: StorageContext, input: AppBackendReceiptScope): AppBackendReceipt | null {
  identity(input); caller(input.caller); key(input.idempotencyKey); digest(input.payloadSha256);
  const row = storage.db.prepare(`SELECT revision,payload_sha256,result_json FROM sync_relay_app_backend_receipts
    WHERE workspace_id=? AND data_path=? AND grant_id=? AND principal_id=? AND idempotency_key=?`)
    .get(input.workspaceId,input.dataPath,input.caller.grantId,input.caller.principalId,input.idempotencyKey);
  if (!row) return null;
  if (row.payload_sha256 !== input.payloadSha256) throw relayError("conflict", "App idempotency key already has another payload.");
  return {revision: Number(row.revision), result: JSON.parse(String(row.result_json))};
}

export function commitAppBackendOperation(storage: StorageContext, input: CommitAppBackendOperationInput): CommitAppBackendOperationResult {
  identity(input); caller(input.caller); key(input.idempotencyKey); digest(input.payloadSha256);
  positive(input.expectedRevision); positive(input.publicationRevision); digest(input.schemaSha256); timestamp(input.nowMs);
  boundedBytes(input.database, MAX_DATABASE_BYTES); boundedBytes(input.changeset, MAX_DATABASE_BYTES);
  const resultJson = JSON.stringify(input.result);
  if (resultJson === undefined || Buffer.byteLength(resultJson) > MAX_RESULT_BYTES) throw badRequest("Invalid app operation result.");
  if (input.attachedFileIds.length > 64 || new Set(input.attachedFileIds).size !== input.attachedFileIds.length) throw badRequest("Invalid app attachments.");
  return storage.tx(() => {
    authorizeNow(input.authorize);
    const previous = readAppBackendSnapshot(storage, input);
    if (!previous || previous.publicationId !== input.publicationId || previous.publicationRevision !== input.publicationRevision || previous.schemaSha256 !== input.schemaSha256) return {kind: "conflict"};
    const receipt = findAppBackendReceipt(storage, input);
    if (receipt) return {kind: "replayed", ...receipt};
    if (previous.revision !== input.expectedRevision) return {kind: "conflict"};
    for (const fileId of input.attachedFileIds) {
      const file = storage.db.prepare(`SELECT grant_id,principal_id,expires_at_ms,attached_revision FROM sync_relay_app_backend_files
        WHERE workspace_id=? AND data_path=? AND file_id=?`).get(input.workspaceId,input.dataPath,fileId);
      if (!file || file.grant_id !== input.caller.grantId || file.principal_id !== input.caller.principalId ||
          (file.attached_revision === null && Number(file.expires_at_ms) <= input.nowMs)) throw notFound();
    }
    const snapshot = {...previous, database: input.database, revision: nextRevision(previous.revision), updatedAtMs: input.nowMs};
    const bytes = snapshotBytes(snapshot), history = historyRow(snapshot, "operation", input.caller, input.changeset);
    const receiptBytes = size([input.workspaceId,input.dataPath,input.caller,input.idempotencyKey,input.payloadSha256,resultJson])+256;
    assertWorkspaceQuota(storage,input.workspaceId,bytes-snapshotBytes(previous)+historyBytes(history)+receiptBytes);
    storage.db.prepare(`UPDATE sync_relay_app_backends SET database=?,revision=?,updated_at_ms=?,storage_bytes=? WHERE workspace_id=? AND data_path=?`)
      .run(snapshot.database,snapshot.revision,snapshot.updatedAtMs,bytes,input.workspaceId,input.dataPath);
    insertHistory(storage, history);
    storage.db.prepare(`INSERT INTO sync_relay_app_backend_receipts(workspace_id,data_path,grant_id,principal_id,idempotency_key,payload_sha256,revision,result_json,recorded_at_ms,storage_bytes)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(input.workspaceId,input.dataPath,input.caller.grantId,input.caller.principalId,input.idempotencyKey,input.payloadSha256,snapshot.revision,resultJson,input.nowMs,receiptBytes);
    for (const fileId of input.attachedFileIds) storage.db.prepare(`UPDATE sync_relay_app_backend_files SET attached_revision=? WHERE workspace_id=? AND data_path=? AND file_id=? AND attached_revision IS NULL`)
      .run(snapshot.revision,input.workspaceId,input.dataPath,fileId);
    return {kind: "committed", revision: snapshot.revision, result: JSON.parse(resultJson)};
  });
}

export interface AppBackendFile {
  fileId: string; name: string; contentType: string; byteLength: number; sha256: string;
}
export interface StageAppBackendFileInput extends AppBackendScope {
  caller: AppBackendCaller; idempotencyKey: string; name: string; contentType: string;
  content: Uint8Array; nowMs: number; expiresAtMs: number; authorize: () => void;
}
function fileMetadata(row: Record<string, unknown>): AppBackendFile {
  return {fileId:String(row.file_id),name:String(row.name),contentType:String(row.content_type),byteLength:(row.content as Uint8Array).byteLength,sha256:String(row.sha256)};
}
export function stageAppBackendFile(storage: StorageContext, input: StageAppBackendFileInput): {file: AppBackendFile; replayed: boolean} {
  identity(input); caller(input.caller); key(input.idempotencyKey); timestamp(input.nowMs); timestamp(input.expiresAtMs);
  boundedBytes(input.content, MAX_FILE_BYTES);
  if (input.content.byteLength === 0 || input.expiresAtMs <= input.nowMs || input.expiresAtMs-input.nowMs > 86400000 ||
      !input.name || Buffer.byteLength(input.name) > 256 || /[\x00-\x1f\x7f]/.test(input.name) ||
      !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(input.contentType) || input.contentType.length > 128) throw badRequest("Invalid app upload.");
  const hash = sha(input.content);
  return storage.tx(() => {
    authorizeNow(input.authorize);
    if (!readAppBackendSnapshot(storage,input)) throw notFound();
    const previous = storage.db.prepare(`SELECT * FROM sync_relay_app_backend_files WHERE workspace_id=? AND data_path=? AND grant_id=? AND principal_id=? AND idempotency_key=?`)
      .get(input.workspaceId,input.dataPath,input.caller.grantId,input.caller.principalId,input.idempotencyKey);
    if (previous) {
      if (previous.sha256 !== hash || previous.name !== input.name || previous.content_type !== input.contentType) throw relayError("conflict","App upload key already has another payload.");
      if (previous.attached_revision === null && Number(previous.expires_at_ms) <= input.nowMs) throw relayError("conflict","App upload expired.");
      return {file: fileMetadata(previous), replayed: true};
    }
    const fileId = randomUUID();
    const bytes = input.content.byteLength+size([input.workspaceId,input.dataPath,input.caller,input.idempotencyKey,input.name,input.contentType,fileId,hash])+256;
    assertWorkspaceQuota(storage,input.workspaceId,bytes);
    storage.db.prepare(`INSERT INTO sync_relay_app_backend_files(workspace_id,data_path,file_id,grant_id,principal_id,idempotency_key,name,content_type,sha256,content,created_at_ms,expires_at_ms,attached_revision,storage_bytes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`).run(input.workspaceId,input.dataPath,fileId,input.caller.grantId,input.caller.principalId,input.idempotencyKey,input.name,input.contentType,hash,input.content,input.nowMs,input.expiresAtMs,bytes);
    return {file: {fileId,name:input.name,contentType:input.contentType,byteLength:input.content.byteLength,sha256:hash}, replayed: false};
  });
}

export function listAppBackendCallerFiles(storage: StorageContext, input: AppBackendScope & {
  caller: AppBackendCaller; nowMs: number;
}): AppBackendFile[] {
  identity(input); caller(input.caller); timestamp(input.nowMs);
  return storage.db.prepare(`SELECT file_id,name,content_type,sha256,length(content) AS byte_length FROM sync_relay_app_backend_files
    WHERE workspace_id=? AND data_path=? AND grant_id=? AND principal_id=? AND (attached_revision IS NOT NULL OR expires_at_ms>?)
    ORDER BY created_at_ms DESC,file_id LIMIT 64`).all(input.workspaceId,input.dataPath,input.caller.grantId,input.caller.principalId,input.nowMs)
    .map(row => ({fileId:String(row.file_id),name:String(row.name),contentType:String(row.content_type),sha256:String(row.sha256),byteLength:Number(row.byte_length)}));
}

export function readAppBackendFile(storage: StorageContext, input: AppBackendScope & {
  fileId: string; authorize: () => void;
}): (AppBackendFile & {content: Uint8Array}) | null {
  return storage.readTx(() => readAppBackendFileInTransaction(storage,input));
}

export function readAppBackendFileInTransaction(storage: StorageContext, input: AppBackendScope & {
  fileId: string; authorize: () => void;
}): (AppBackendFile & {content: Uint8Array}) | null {
  authorizeNow(input.authorize);
  const row = storage.db.prepare(`SELECT * FROM sync_relay_app_backend_files WHERE workspace_id=? AND data_path=? AND file_id=? AND attached_revision IS NOT NULL`)
    .get(input.workspaceId,input.dataPath,input.fileId);
  return row ? {...fileMetadata(row),content:new Uint8Array(row.content as Uint8Array)} : null;
}

export function collectExpiredAppBackendFiles(storage: StorageContext, nowMs: number): number {
  timestamp(nowMs);
  return storage.tx(() => storage.db.prepare("DELETE FROM sync_relay_app_backend_files WHERE attached_revision IS NULL AND expires_at_ms<=?").run(nowMs).changes);
}

export function setAppBackendHelper(storage: StorageContext, input: AppBackendScope & {
  grantId: string; enabled: boolean; authorize: () => void; nowMs: number;
}): void {
  identity(input); timestamp(input.nowMs);
  if (!input.grantId || input.grantId.length > 512) throw badRequest("Invalid app helper.");
  storage.tx(() => {
    authorizeNow(input.authorize);
    if (!readAppBackendSnapshot(storage,input)) throw notFound();
    if (input.enabled) {
      if (isAppBackendHelper(storage,input)) return;
      const bytes = size([input.workspaceId,input.dataPath,input.grantId])+128;
      assertWorkspaceQuota(storage,input.workspaceId,bytes);
      storage.db.prepare("INSERT INTO sync_relay_app_backend_helpers(workspace_id,data_path,grant_id,created_at_ms,storage_bytes) VALUES(?,?,?,?,?)")
        .run(input.workspaceId,input.dataPath,input.grantId,input.nowMs,bytes);
    } else storage.db.prepare("DELETE FROM sync_relay_app_backend_helpers WHERE workspace_id=? AND data_path=? AND grant_id=?").run(input.workspaceId,input.dataPath,input.grantId);
  });
}
export function isAppBackendHelper(storage: StorageContext, scope: AppBackendScope & {grantId: string}): boolean {
  return !!storage.db.prepare("SELECT 1 FROM sync_relay_app_backend_helpers WHERE workspace_id=? AND data_path=? AND grant_id=?").get(scope.workspaceId,scope.dataPath,scope.grantId);
}

/** Private recovery export: authorization and all rows share one read snapshot. */
export function exportAppBackend(storage: StorageContext, input: AppBackendScope & {authorize: () => void}) {
  return storage.readTx(() => {
    authorizeNow(input.authorize);
    const snapshot = readAppBackendSnapshot(storage,input);
    if (!snapshot) throw notFound();
    const rows = (table: string, order: string) => storage.db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND data_path=? ORDER BY ${order}`).all(input.workspaceId,input.dataPath);
    return {snapshot, history: rows("sync_relay_app_backend_history","revision"), receipts: rows("sync_relay_app_backend_receipts","revision,grant_id,principal_id,idempotency_key"),
      files: rows("sync_relay_app_backend_files","file_id"), helpers: rows("sync_relay_app_backend_helpers","grant_id")};
  });
}
