import { createHash, randomUUID } from "node:crypto";
import { badRequest, notFound, relayError } from "../errors";
import type { StorageContext } from "./context";
import { assertWorkspaceQuota } from "./workspaces";

const MAX_DATABASE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PENDING_FILES_PER_CALLER = 32;
const MAX_RESULT_BYTES = 1024 * 1024;
export const APP_BACKEND_RECOVERY_BYTES = 128 * 1024 * 1024;
export const APP_BACKEND_RECOVERABLE_STORAGE_BYTES = (APP_BACKEND_RECOVERY_BYTES - 4096) / 2;
export const APP_BACKEND_RECOVERY_ROWS = 100000;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function assertRecoverableAppQuota(storage: StorageContext, scope: AppBackendScope, addedBytes: number,
  added: {history?:number;receipts?:number;files?:number} = {}): void {
  const usage = storage.db.prepare("SELECT * FROM sync_relay_app_backend_usage WHERE workspace_id=? AND data_path=?").get(scope.workspaceId,scope.dataPath);
  // Each stored row reserves 256 bytes beyond its JSON-escaped values. Doubling
  // covers field names, framing, numeric metadata, and base64's 4/3 expansion.
  if (Number(usage?.storage_bytes ?? 0)+addedBytes > APP_BACKEND_RECOVERABLE_STORAGE_BYTES ||
      Number(usage?.history_rows ?? 0)+(added.history ?? 0) > APP_BACKEND_RECOVERY_ROWS ||
      Number(usage?.receipt_rows ?? 0)+(added.receipts ?? 0) > APP_BACKEND_RECOVERY_ROWS ||
      Number(usage?.file_rows ?? 0)+(added.files ?? 0) > APP_BACKEND_RECOVERY_ROWS) {
    throw relayError("quota_exceeded","App recovery capacity reached. This app cannot accept more data.");
  }
}

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

export function readAppBackendMetadata(storage: StorageContext, scope: AppBackendScope): Omit<AppBackendSnapshot,"database"> | null {
  identity(scope);
  const row=storage.db.prepare(`SELECT workspace_id,data_path,app_root,publication_id,publication_revision,schema_sha256,schema_version,
    source_sha256,source,capability_json,revision,updated_at_ms FROM sync_relay_app_backends WHERE workspace_id=? AND data_path=?`)
    .get(scope.workspaceId,scope.dataPath);
  if (!row) return null;
  const {database: _database,...metadata}=rowSnapshot({...row,database:new Uint8Array()});
  return metadata;
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
    assertRecoverableAppQuota(storage,input,bytes-(previous ? snapshotBytes(previous) : 0)+historyBytes(history),{history:1});
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
    assertRecoverableAppQuota(storage,input,bytes-snapshotBytes(previous)+historyBytes(history)+receiptBytes,{history:1,receipts:1});
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
  storage.tx(() => {
    authorizeNow(input.authorize);
    if (!readAppBackendMetadata(storage,input)) throw notFound();
    storage.db.prepare(`DELETE FROM sync_relay_app_backend_files WHERE workspace_id=? AND data_path=? AND file_id IN (
      SELECT file_id FROM sync_relay_app_backend_files WHERE workspace_id=? AND data_path=?
      AND attached_revision IS NULL AND expires_at_ms<=? ORDER BY expires_at_ms LIMIT 128)`)
      .run(input.workspaceId,input.dataPath,input.workspaceId,input.dataPath,input.nowMs);
  });
  return storage.tx(() => {
    authorizeNow(input.authorize);
    if (!readAppBackendMetadata(storage,input)) throw notFound();
    const previous = storage.db.prepare(`SELECT * FROM sync_relay_app_backend_files WHERE workspace_id=? AND data_path=? AND grant_id=? AND principal_id=? AND idempotency_key=?`)
      .get(input.workspaceId,input.dataPath,input.caller.grantId,input.caller.principalId,input.idempotencyKey);
    if (previous) {
      if (previous.sha256 !== hash || previous.name !== input.name || previous.content_type !== input.contentType) throw relayError("conflict","App upload key already has another payload.");
      if (previous.attached_revision === null && Number(previous.expires_at_ms) <= input.nowMs) throw relayError("conflict","App upload expired.");
      return {file: fileMetadata(previous), replayed: true};
    }
    const pending = storage.db.prepare(`SELECT COUNT(*) AS n FROM sync_relay_app_backend_files
      WHERE workspace_id=? AND data_path=? AND grant_id=? AND principal_id=? AND attached_revision IS NULL AND expires_at_ms>?`)
      .get(input.workspaceId,input.dataPath,input.caller.grantId,input.caller.principalId,input.nowMs);
    if (Number(pending?.n) >= MAX_PENDING_FILES_PER_CALLER) throw relayError("quota_exceeded", "Submit pending uploads before uploading more files.");
    const fileId = randomUUID();
    const bytes = input.content.byteLength+size([input.workspaceId,input.dataPath,input.caller,input.idempotencyKey,input.name,input.contentType,fileId,hash])+256;
    assertRecoverableAppQuota(storage,input,bytes,{files:1});
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
    WHERE workspace_id=? AND data_path=? AND grant_id=? AND principal_id=? AND attached_revision IS NULL AND expires_at_ms>?
    ORDER BY created_at_ms DESC,file_id LIMIT ?`).all(input.workspaceId,input.dataPath,input.caller.grantId,input.caller.principalId,input.nowMs,MAX_PENDING_FILES_PER_CALLER)
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
      assertRecoverableAppQuota(storage,input,bytes);
      assertWorkspaceQuota(storage,input.workspaceId,bytes);
      storage.db.prepare("INSERT INTO sync_relay_app_backend_helpers(workspace_id,data_path,grant_id,created_at_ms,storage_bytes) VALUES(?,?,?,?,?)")
        .run(input.workspaceId,input.dataPath,input.grantId,input.nowMs,bytes);
    } else storage.db.prepare("DELETE FROM sync_relay_app_backend_helpers WHERE workspace_id=? AND data_path=? AND grant_id=?").run(input.workspaceId,input.dataPath,input.grantId);
  });
}
export function isAppBackendHelper(storage: StorageContext, scope: AppBackendScope & {grantId: string}): boolean {
  return !!storage.db.prepare("SELECT 1 FROM sync_relay_app_backend_helpers WHERE workspace_id=? AND data_path=? AND grant_id=?").get(scope.workspaceId,scope.dataPath,scope.grantId);
}

export interface AppBackendRecoveryBundle {
  formatVersion: 1;
  integritySha256: string;
  snapshot: Omit<AppBackendSnapshot,"database"> & {databaseBase64: string};
  history: Record<string,unknown>[];
  receipts: Record<string,unknown>[];
  files: Record<string,unknown>[];
}
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw badRequest("Recovery JSON is nested too deeply.");
  if (Array.isArray(value)) return `[${value.map(entry=>canonicalJson(entry,depth+1)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonicalJson(v,depth+1)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw badRequest("Invalid recovery JSON.");
  return encoded;
}
function recoveryIntegrity(bundle: Omit<AppBackendRecoveryBundle,"integritySha256">): string {
  const canonical = canonicalJson(bundle);
  if (Buffer.byteLength(canonical) > APP_BACKEND_RECOVERY_BYTES) throw badRequest("App recovery bundle exceeds its size limit.");
  return sha(canonical);
}
function recoveryBinary(value: unknown, max: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(max/3)*4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw badRequest("Invalid recovery bytes.");
  const decoded = Buffer.from(value,"base64");
  if (decoded.byteLength > max || decoded.toString("base64") !== value) throw badRequest("Invalid recovery bytes.");
  return decoded;
}
function recoveryText(row: Record<string,unknown>, name: string, max = 512): string {
  const value = row[name];
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > max || value.includes("\0")) throw badRequest("Invalid recovery metadata.");
  return value;
}
function recoveryInteger(row: Record<string,unknown>, name: string, minimum = 0): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw badRequest("Invalid recovery integer.");
  return value;
}
function recoveryRows(value: unknown): Record<string,unknown>[] {
  if (!Array.isArray(value) || value.length > APP_BACKEND_RECOVERY_ROWS || value.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw badRequest("Invalid recovery rows.");
  return value;
}

/** Private, portable export. Helper grants and unattached uploads are not transferable. */
export function exportAppBackend(storage: StorageContext, input: AppBackendScope & {authorize: () => void}): AppBackendRecoveryBundle {
  return storage.readTx(() => {
    authorizeNow(input.authorize);
    const snapshot = readAppBackendSnapshot(storage,input);
    if (!snapshot) throw notFound();
    const storedBytes = ["sync_relay_app_backends","sync_relay_app_backend_history","sync_relay_app_backend_receipts","sync_relay_app_backend_files"]
      .reduce((sum,table)=>sum+Number(storage.db.prepare(`SELECT COALESCE(SUM(storage_bytes),0) AS n FROM ${table} WHERE workspace_id=? AND data_path=?`).get(input.workspaceId,input.dataPath)?.n),0);
    if (storedBytes > APP_BACKEND_RECOVERY_BYTES) throw badRequest("App recovery bundle exceeds its size limit.");
    const rows = (table: string, order: string, where = "") => {
      const count = Number(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=? AND data_path=? ${where}`).get(input.workspaceId,input.dataPath)?.n);
      if (count > APP_BACKEND_RECOVERY_ROWS) throw badRequest("App recovery bundle exceeds its row limit.");
      return storage.db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND data_path=? ${where} ORDER BY ${order}`).all(input.workspaceId,input.dataPath)
        .map(({storage_bytes: _storageBytes, ...row}) => row);
    };
    const {database, ...metadata} = snapshot;
    const bundle = {formatVersion:1 as const,snapshot:{...metadata,databaseBase64:Buffer.from(database).toString("base64")},
      history:rows("sync_relay_app_backend_history","revision").map(({changeset,...row}) => ({...row,changeset_base64:Buffer.from(changeset as Uint8Array).toString("base64")})),
      receipts:rows("sync_relay_app_backend_receipts","revision,grant_id,principal_id,idempotency_key"),
      files:rows("sync_relay_app_backend_files","file_id","AND attached_revision IS NOT NULL").map(({content,...row}) => ({...row,content_base64:Buffer.from(content as Uint8Array).toString("base64")}))};
    return {...bundle,integritySha256:recoveryIntegrity(bundle)};
  });
}

export interface RestoreAppBackendInput extends Omit<ActivateAppBackendInput,"database"> {
  bundle: AppBackendRecoveryBundle;
  validateDatabase: (database: Uint8Array) => Promise<void>;
}

/** Recovery into an absent store only. Existing data cannot be rewound past accepted receipts. */
export async function restoreAppBackend(storage: StorageContext, input: RestoreAppBackendInput): Promise<Pick<AppBackendSnapshot,"workspaceId"|"dataPath"|"revision"|"updatedAtMs">> {
  input = {...input};
  identity(input); timestamp(input.nowMs); positive(input.publicationRevision); positive(input.schemaVersion);
  digest(input.schemaSha256); digest(input.sourceSha256);
  if (input.expectedRevision !== null) throw relayError("conflict","Recovery requires an absent app data store.");
  const encoded = JSON.stringify(input.bundle);
  if (!encoded || Buffer.byteLength(encoded) > APP_BACKEND_RECOVERY_BYTES) throw badRequest("App recovery bundle exceeds its size limit.");
  const bundle = JSON.parse(encoded) as AppBackendRecoveryBundle;
  if (!bundle || bundle.formatVersion !== 1 || !bundle.snapshot) throw badRequest("Unsupported app recovery bundle.");
  const {integritySha256,...payload} = bundle;
  digest(integritySha256);
  if (recoveryIntegrity(payload) !== integritySha256) throw badRequest("App recovery integrity check failed.");
  const replay = () => {
    const row = storage.db.prepare("SELECT * FROM sync_relay_app_backend_recoveries WHERE workspace_id=? AND data_path=?")
      .get(input.workspaceId,input.dataPath);
    if (!row) return null;
    if (row.integrity_sha256 !== integritySha256 || row.publication_id !== input.publicationId || row.publication_revision !== input.publicationRevision) {
      throw relayError("conflict","Recovery cannot replace existing app data.");
    }
    return {workspaceId:input.workspaceId,dataPath:input.dataPath,revision:Number(row.revision),updatedAtMs:Number(row.updated_at_ms)};
  };
  const previousRecovery = storage.readTx(() => { authorizeNow(input.authorize); return replay(); });
  if (previousRecovery) return previousRecovery;
  const previous = bundle.snapshot;
  if (previous.workspaceId !== input.workspaceId || previous.dataPath !== input.dataPath || previous.appRoot !== input.appRoot ||
      previous.schemaSha256 !== input.schemaSha256 || previous.schemaVersion !== input.schemaVersion || previous.sourceSha256 !== input.sourceSha256) throw relayError("conflict","Recovery scope, source, or schema differs from the approved app.");
  positive(previous.revision); positive(previous.publicationRevision); timestamp(previous.updatedAtMs);
  digest(previous.sourceSha256);
  if (typeof previous.source !== "string" || sha(previous.source) !== previous.sourceSha256 ||
      typeof input.source !== "string" || sha(input.source) !== input.sourceSha256 || Buffer.byteLength(input.source) > 1024*1024 ||
      typeof input.capabilityJson !== "string" || Buffer.byteLength(input.capabilityJson)>65536) throw badRequest("Invalid recovery app source.");
  JSON.parse(input.capabilityJson);
  const database = recoveryBinary(previous.databaseBase64,MAX_DATABASE_BYTES);
  const histories = recoveryRows(bundle.history), receipts = recoveryRows(bundle.receipts), files = recoveryRows(bundle.files);
  const scopeRow = (row:Record<string,unknown>) => {
    if (row.workspace_id !== input.workspaceId || row.data_path !== input.dataPath) throw badRequest("Recovery row belongs to another app.");
  };
  const historyKinds = new Map<number,string>();
  const history = histories.map((row,index) => {
    scopeRow(row);
    const revision=recoveryInteger(row,"revision",1), pubRevision=recoveryInteger(row,"publication_revision",1);
    if (revision !== index+1 || revision > previous.revision || !["activate","operation"].includes(String(row.kind))) throw badRequest("Recovery history is incomplete.");
    const sourceHash=recoveryText(row,"source_sha256"), databaseHash=recoveryText(row,"database_sha256"); digest(sourceHash); digest(databaseHash);
    const actor={grantId:row.grant_id as string,principalId:row.principal_id as string};
    if (row.kind === "operation") caller(actor);
    else if (row.grant_id !== "" || row.principal_id !== "") throw badRequest("Invalid recovery activation identity.");
    const changeset=recoveryBinary(row.changeset_base64,MAX_DATABASE_BYTES);
    if (row.kind !== "operation" && changeset.byteLength !== 0) throw badRequest("Invalid recovery activation changeset.");
    historyKinds.set(revision,String(row.kind));
    const values=[input.workspaceId,input.dataPath,revision,recoveryText(row,"publication_id"),pubRevision,sourceHash,row.kind as "activate"|"operation",actor.grantId,actor.principalId,changeset,databaseHash,recoveryInteger(row,"recorded_at_ms")] as const;
    return values;
  });
  const latestHistory=history.at(-1);
  // History retains the original host's publication authority; the snapshot
  // binds the recovered data to the currently approved publication.
  if (history.length !== previous.revision || latestHistory?.[10] !== sha(database) ||
      latestHistory?.[5] !== previous.sourceSha256 || latestHistory?.[11] !== previous.updatedAtMs) throw badRequest("Recovery snapshot does not match its history.");
  const receiptKeys=new Set<string>(), receiptRevisions=new Set<number>();
  const receiptRows=receipts.map(row => {
    scopeRow(row);
    const actor={grantId:recoveryText(row,"grant_id"),principalId:recoveryText(row,"principal_id")}; caller(actor);
    const idempotencyKey=recoveryText(row,"idempotency_key"), payloadHash=recoveryText(row,"payload_sha256"); key(idempotencyKey); digest(payloadHash);
    const revision=recoveryInteger(row,"revision",1), resultJson=recoveryText(row,"result_json",MAX_RESULT_BYTES), recordedAt=recoveryInteger(row,"recorded_at_ms"); JSON.parse(resultJson);
    const receiptKey=JSON.stringify([actor,idempotencyKey]);
    if (receiptKeys.has(receiptKey) || receiptRevisions.has(revision) || historyKinds.get(revision)!=="operation" ||
        history[revision-1]?.[7]!==actor.grantId || history[revision-1]?.[8]!==actor.principalId) throw badRequest("Invalid recovery receipt history.");
    receiptKeys.add(receiptKey); receiptRevisions.add(revision);
    const values=[input.workspaceId,input.dataPath,actor.grantId,actor.principalId,idempotencyKey,payloadHash,revision,resultJson,recordedAt] as const;
    return {values,bytes:size([input.workspaceId,input.dataPath,actor,idempotencyKey,payloadHash,resultJson])+256};
  });
  if (history.filter(row=>row[6]==="operation").length!==receiptRevisions.size) throw badRequest("Recovery receipts are incomplete.");
  const fileIds=new Set<string>(), uploadKeys=new Set<string>();
  const fileRows=files.map(row=>{
    scopeRow(row);
    const actor={grantId:recoveryText(row,"grant_id"),principalId:recoveryText(row,"principal_id")}; caller(actor);
    const fileId=recoveryText(row,"file_id"), idempotencyKey=recoveryText(row,"idempotency_key"), name=recoveryText(row,"name",256), contentType=recoveryText(row,"content_type",128), hash=recoveryText(row,"sha256");
    key(idempotencyKey); digest(hash);
    const content=recoveryBinary(row.content_base64,MAX_FILE_BYTES), created=recoveryInteger(row,"created_at_ms"), expires=recoveryInteger(row,"expires_at_ms"), attached=recoveryInteger(row,"attached_revision",1);
    const uploadKey=JSON.stringify([actor,idempotencyKey]);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(fileId) || !content.byteLength || sha(content)!==hash || fileIds.has(fileId) || uploadKeys.has(uploadKey) || historyKinds.get(attached)!=="operation" ||
        history[attached-1]?.[7]!==actor.grantId || history[attached-1]?.[8]!==actor.principalId || expires<=created ||
        /[\x00-\x1f\x7f]/.test(name) || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(contentType)) throw badRequest("Invalid recovery attachment.");
    fileIds.add(fileId); uploadKeys.add(uploadKey);
    return {values:[input.workspaceId,input.dataPath,fileId,actor.grantId,actor.principalId,idempotencyKey,name,contentType,hash,content,created,expires,attached] as const,
      bytes:content.byteLength+size([input.workspaceId,input.dataPath,actor,idempotencyKey,name,contentType,fileId,hash])+256};
  });
  authorizeNow(input.authorize);
  if (readAppBackendSnapshot(storage,input)) throw relayError("conflict","Recovery cannot replace existing app data.");
  await input.validateDatabase(new Uint8Array(database));
  return storage.tx(()=>{
    authorizeNow(input.authorize);
    const recovered = replay();
    if (recovered) return recovered;
    if (readAppBackendSnapshot(storage,input)) throw relayError("conflict","App data was initialized during recovery.");
    const snapshot:AppBackendSnapshot={workspaceId:input.workspaceId,dataPath:input.dataPath,appRoot:input.appRoot,publicationId:input.publicationId,
      publicationRevision:input.publicationRevision,schemaSha256:input.schemaSha256,schemaVersion:input.schemaVersion,sourceSha256:input.sourceSha256,
      source:input.source,capabilityJson:input.capabilityJson,revision:previous.revision,database,updatedAtMs:previous.updatedAtMs};
    const bytes=snapshotBytes(snapshot), totalBytes=bytes+history.reduce((sum,row)=>sum+historyBytes(row),0)+receiptRows.reduce((sum,row)=>sum+row.bytes,0)+fileRows.reduce((sum,row)=>sum+row.bytes,0);
    assertRecoverableAppQuota(storage,input,totalBytes,{history:history.length,receipts:receiptRows.length,files:fileRows.length});
    const recoveryBytes=size([input.workspaceId,input.dataPath,integritySha256,previous.revision,input.publicationId,input.publicationRevision])+128;
    assertWorkspaceQuota(storage,input.workspaceId,totalBytes+recoveryBytes);
    storage.db.prepare(`INSERT INTO sync_relay_app_backends(workspace_id,data_path,app_root,publication_id,publication_revision,schema_sha256,schema_version,source_sha256,source,capability_json,revision,database,updated_at_ms,storage_bytes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.workspaceId,snapshot.dataPath,snapshot.appRoot,snapshot.publicationId,snapshot.publicationRevision,snapshot.schemaSha256,snapshot.schemaVersion,snapshot.sourceSha256,snapshot.source,snapshot.capabilityJson,snapshot.revision,snapshot.database,snapshot.updatedAtMs,bytes);
    for(const row of history) insertHistory(storage,row);
    for(const row of receiptRows) storage.db.prepare(`INSERT INTO sync_relay_app_backend_receipts(workspace_id,data_path,grant_id,principal_id,idempotency_key,payload_sha256,revision,result_json,recorded_at_ms,storage_bytes) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(...row.values,row.bytes);
    for(const row of fileRows) storage.db.prepare(`INSERT INTO sync_relay_app_backend_files(workspace_id,data_path,file_id,grant_id,principal_id,idempotency_key,name,content_type,sha256,content,created_at_ms,expires_at_ms,attached_revision,storage_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...row.values,row.bytes);
    storage.db.prepare("INSERT INTO sync_relay_app_backend_recoveries(workspace_id,data_path,integrity_sha256,revision,publication_id,publication_revision,updated_at_ms,storage_bytes) VALUES(?,?,?,?,?,?,?,?)")
      .run(input.workspaceId,input.dataPath,integritySha256,snapshot.revision,input.publicationId,input.publicationRevision,snapshot.updatedAtMs,recoveryBytes);
    return snapshot;
  });
}
