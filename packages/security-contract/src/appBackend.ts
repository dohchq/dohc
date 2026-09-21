import { validateUserWritePath } from "@dohc/workspace-core";
import { classifyEngineFilePath } from "./enginePathFloor";
import { SHA256_HEX_PATTERN } from "./wirePatterns";

export const APP_BACKEND_MAX_OPERATIONS = 128;
export const APP_BACKEND_MAX_TABLES = 64;
export const APP_BACKEND_MAX_DATABASE_BYTES = 16 * 1024 * 1024;
export const APP_BACKEND_CAPABILITY_BYTES = 64 * 1024;
export const APP_BACKEND_INPUT_BYTES = 64 * 1024;
export const APP_BACKEND_REQUEST_BYTES = 128 * 1024;
export const APP_BACKEND_RESULT_BYTES = 1024 * 1024;
export const APP_BACKEND_UPLOAD_BYTES = 5 * 1024 * 1024;
export const APP_BACKEND_UPLOAD_REQUEST_BYTES = 8 * 1024 * 1024;
export const APP_BACKEND_JSON_MAX_DEPTH = 32;
export const APP_BACKEND_JSON_MAX_NODES = 16_384;

export type AppBackendJson = null | boolean | number | string | AppBackendJson[] | { [key: string]: AppBackendJson };
export interface AppBackendOperation {
  name: string;
  access: "link" | "helper" | "owner";
  readOnly: boolean;
}
export interface AppBackendTable {
  name: string;
  primaryKey: string;
  readOperation: string;
  writeOperation: string | null;
}
export interface AppBackendCapability {
  kind: "app-backend";
  /** Stable workspace database identity. This path grants no file-selector access. */
  dataPath: string;
  backendPath: string;
  schemaPath: string;
  backendSha256: string;
  schemaSha256: string;
  schemaVersion: number;
  operations: AppBackendOperation[];
  tables: AppBackendTable[];
}
/** Constructed by the host from current credentials, never accepted from app input. */
export type AppBackendCaller =
  | { kind: "link"; principalId: string; grantId: string }
  | { kind: "named"; userId: string; grantId: string; access: "view" | "comment" | "edit"; helper: boolean }
  | { kind: "owner"; userId: string };
export interface AppBackendInvokeRequest {
  authorityRevision: number;
  operation: string;
  idempotencyKey: string;
  input: AppBackendJson;
}
export interface AppBackendUploadRequest {
  authorityRevision: number;
  idempotencyKey: string;
  name: string;
  contentType: string;
  bytesBase64: string;
}
export interface AppBackendFile {
  fileId: string;
  name: string;
  contentType: string;
  byteLength: number;
  sha256: string;
}

const encoder = new TextEncoder();
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const operationPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const bytes = (value: string) => encoder.encode(value).byteLength;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid app backend record.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new Error("Invalid app backend record prototype.");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || forbiddenKeys.has(key) || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("Invalid app backend record property.");
    }
  }
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const row = record(value);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("Unexpected app backend fields.");
  return row;
}
function text(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || !value || value.length > maxBytes || /[\u0000-\u001f\u007f]/.test(value) || bytes(value) > maxBytes) {
    throw new Error("Invalid app backend text.");
  }
  return value;
}
function name(value: unknown, pattern = operationPattern): string {
  const result = text(value, 64);
  if (!pattern.test(result) || result.split(".").some(part => forbiddenKeys.has(part))) throw new Error("Invalid app backend name.");
  return result;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || value.length !== 64 || !SHA256_HEX_PATTERN.test(value)) throw new Error("Invalid app backend digest.");
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid app backend authority revision.");
  return value;
}
function idempotencyKey(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(result)) throw new Error("Invalid app backend idempotency key.");
  return result;
}
function filename(value: unknown): string {
  const result = text(value, 255);
  if (/[\\/]/.test(result) || result === "." || result === "..") throw new Error("Invalid app backend filename.");
  return result;
}
function contentType(value: unknown): string {
  const result = text(value, 127);
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(result)) throw new Error("Invalid app backend content type.");
  return result;
}

/** Validate and copy JSON without calling user-defined getters or serialization hooks. */
export function parseAppBackendJson(value: unknown, maxBytes = APP_BACKEND_RESULT_BYTES): AppBackendJson {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > APP_BACKEND_RESULT_BYTES) throw new Error("Invalid app backend JSON bound.");
  let remaining = maxBytes;
  let nodes = 0;
  function charge(value: string): void {
    remaining -= bytes(value);
    if (remaining < 0) throw new Error("App backend JSON exceeds its byte bound.");
  }
  function visit(value: unknown, depth: number): AppBackendJson {
    if (++nodes > APP_BACKEND_JSON_MAX_NODES || depth > APP_BACKEND_JSON_MAX_DEPTH) throw new Error("App backend JSON exceeds its structural bound.");
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid app backend JSON number.");
      if (typeof value === "string" && value.length > remaining) throw new Error("App backend JSON exceeds its byte bound.");
      charge(JSON.stringify(value));
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > APP_BACKEND_JSON_MAX_NODES || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
        throw new Error("Invalid app backend JSON array.");
      }
      charge("[]" + ",".repeat(Math.max(0, value.length - 1)));
      const result: AppBackendJson[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Invalid app backend JSON array item.");
        result.push(visit(descriptor.value, depth + 1));
      }
      return result;
    }
    const row = record(value);
    const keys = Object.keys(row);
    if (keys.length > APP_BACKEND_JSON_MAX_NODES) throw new Error("App backend JSON exceeds its structural bound.");
    charge("{}" + ",".repeat(Math.max(0, keys.length - 1)));
    const result: { [key: string]: AppBackendJson } = {};
    for (const key of keys) {
      if (key.length > remaining) throw new Error("App backend JSON exceeds its byte bound.");
      charge(JSON.stringify(key) + ":");
      result[key] = visit(row[key], depth + 1);
    }
    return result;
  }
  return visit(value, 0);
}

export function parseAppBackendCapability(value: unknown): AppBackendCapability {
  const row = exact(parseAppBackendJson(value, APP_BACKEND_CAPABILITY_BYTES), ["kind", "dataPath", "backendPath", "schemaPath", "backendSha256", "schemaSha256", "schemaVersion", "operations", "tables"]);
  if (row.kind !== "app-backend" || row.backendPath !== "backend.js" || row.schemaPath !== "schema.sql") throw new Error("Invalid app backend artifacts.");
  const dataPath = text(row.dataPath, 1024);
  const checked = validateUserWritePath(dataPath);
  if (!checked.ok || checked.normalized !== dataPath || classifyEngineFilePath(dataPath).kind !== "tracked") throw new Error("Invalid app backend data path.");
  if (!Array.isArray(row.operations) || !row.operations.length || row.operations.length > APP_BACKEND_MAX_OPERATIONS ||
      !Array.isArray(row.tables) || row.tables.length > APP_BACKEND_MAX_TABLES) throw new Error("Invalid app backend inventory.");
  const operations: AppBackendOperation[] = row.operations.map(value => {
    const operation = exact(value, ["name", "access", "readOnly"]);
    if (!["link", "helper", "owner"].includes(operation.access as string) || typeof operation.readOnly !== "boolean") throw new Error("Invalid app backend operation.");
    return { name: name(operation.name), access: operation.access as AppBackendOperation["access"], readOnly: operation.readOnly };
  }).sort((a, b) => compare(a.name, b.name));
  const byName = new Map(operations.map(operation => [operation.name, operation]));
  if (byName.size !== operations.length) throw new Error("Duplicate app backend operation.");
  const tables: AppBackendTable[] = row.tables.map(value => {
    const table = exact(value, ["name", "primaryKey", "readOperation", "writeOperation"]);
    const readOperation = name(table.readOperation);
    const writeOperation = table.writeOperation === null ? null : name(table.writeOperation);
    if (byName.get(readOperation)?.readOnly !== true || (writeOperation !== null && byName.get(writeOperation)?.readOnly !== false)) {
      throw new Error("Invalid app backend table operation.");
    }
    return { name: name(table.name, identifierPattern), primaryKey: name(table.primaryKey, identifierPattern), readOperation, writeOperation };
  }).sort((a, b) => compare(a.name, b.name));
  if (new Set(tables.map(table => table.name.toLowerCase())).size !== tables.length) throw new Error("Duplicate app backend table.");
  const capability: AppBackendCapability = {
    kind: "app-backend", dataPath, backendPath: "backend.js", schemaPath: "schema.sql",
    backendSha256: hash(row.backendSha256), schemaSha256: hash(row.schemaSha256), schemaVersion: revision(row.schemaVersion), operations, tables,
  };
  if (bytes(JSON.stringify(capability)) > APP_BACKEND_CAPABILITY_BYTES) throw new Error("App backend capability exceeds its byte bound.");
  return capability;
}

export function parseAppBackendCaller(value: unknown): AppBackendCaller {
  const row = record(value);
  if (row.kind === "owner") {
    exact(row, ["kind", "userId"]);
    return { kind: "owner", userId: text(row.userId, 256) };
  }
  if (row.kind === "link") {
    exact(row, ["kind", "principalId", "grantId"]);
    return { kind: "link", principalId: text(row.principalId, 256), grantId: text(row.grantId, 256) };
  }
  if (row.kind === "named") {
    exact(row, ["kind", "userId", "grantId", "access", "helper"]);
    if ((row.access !== "view" && row.access !== "comment" && row.access !== "edit") || typeof row.helper !== "boolean") throw new Error("Invalid app backend caller access.");
    return { kind: "named", userId: text(row.userId, 256), grantId: text(row.grantId, 256), access: row.access, helper: row.helper };
  }
  throw new Error("Invalid app backend caller.");
}

export function canInvokeAppBackendOperation(caller: AppBackendCaller, operation: AppBackendOperation): boolean {
  if (caller.kind === "owner") return true;
  return operation.access === "link" || (operation.access === "helper" && caller.kind === "named" && caller.access === "edit" && caller.helper === true);
}

export function parseAppBackendInvokeRequest(value: unknown): AppBackendInvokeRequest {
  const row = exact(value, ["authorityRevision", "operation", "idempotencyKey", "input"]);
  const request = {
    authorityRevision: revision(row.authorityRevision), operation: name(row.operation),
    idempotencyKey: idempotencyKey(row.idempotencyKey), input: parseAppBackendJson(row.input, APP_BACKEND_INPUT_BYTES),
  };
  if (bytes(JSON.stringify(request)) > APP_BACKEND_REQUEST_BYTES) throw new Error("App backend request exceeds its byte bound.");
  return request;
}

export function parseAppBackendUploadRequest(value: unknown): AppBackendUploadRequest {
  const row = exact(value, ["authorityRevision", "idempotencyKey", "name", "contentType", "bytesBase64"]);
  const encoded = row.bytesBase64;
  if (typeof encoded !== "string" || !encoded.length || encoded.length > 4 * Math.ceil(APP_BACKEND_UPLOAD_BYTES / 3) ||
      encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Invalid app backend upload encoding.");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const byteLength = encoded.length / 4 * 3 - padding;
  const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(encoded[encoded.length - padding - 1]!);
  if (byteLength > APP_BACKEND_UPLOAD_BYTES || last < 0 || (padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) {
    throw new Error("Invalid app backend upload size or padding.");
  }
  const request = {
    authorityRevision: revision(row.authorityRevision), idempotencyKey: idempotencyKey(row.idempotencyKey),
    name: filename(row.name), contentType: contentType(row.contentType), bytesBase64: encoded,
  };
  if (bytes(JSON.stringify(request)) > APP_BACKEND_UPLOAD_REQUEST_BYTES) throw new Error("App backend upload request exceeds its byte bound.");
  return request;
}

export function parseAppBackendFile(value: unknown): AppBackendFile {
  const row = exact(value, ["fileId", "name", "contentType", "byteLength", "sha256"]);
  const fileId = text(row.fileId, 128);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(fileId) || typeof row.byteLength !== "number" || !Number.isSafeInteger(row.byteLength) ||
      row.byteLength < 1 || row.byteLength > APP_BACKEND_UPLOAD_BYTES) throw new Error("Invalid app backend file.");
  return { fileId, name: filename(row.name), contentType: contentType(row.contentType), byteLength: row.byteLength, sha256: hash(row.sha256) };
}
