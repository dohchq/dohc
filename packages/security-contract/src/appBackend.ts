import { SHA256_HEX_PATTERN } from "./wirePatterns";

export const APP_BACKEND_INPUT_BYTES = 64 * 1024;
export const APP_BACKEND_REQUEST_BYTES = 128 * 1024;
export const APP_BACKEND_RESULT_BYTES = 1024 * 1024;
/** The most journal JSON a change's response carries to the owner's kept copy. */
export const APP_BACKEND_CATCH_UP_BYTES = 1024 * 1024;
/**
 * The owner's kept copy names its cursor, as JSON, in this header of a change.
 * A header, so a server without this ignores it and the copy catches up as before.
 */
export const APP_BACKEND_CATCH_UP_HEADER = "x-dohc-copy-after";
export const APP_BACKEND_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Maximum file metadata entries admitted to one operation by local and shared hosts. */
export const APP_BACKEND_OPERATION_FILES = 32;
export const APP_BACKEND_UPLOAD_REQUEST_BYTES = 28 * 1024 * 1024;
export const APP_BACKEND_REFUSAL_BYTES = 8 * 1024;
export const APP_BACKEND_JSON_MAX_DEPTH = 32;
export const APP_BACKEND_JSON_MAX_NODES = 16_384;
export const APP_BACKEND_BULK_LIMITS = Object.freeze({
  inputBytes: 1024 * 1024,
  requestBytes: 2 * 1024 * 1024,
  resultBytes: 4 * 1024 * 1024,
  jsonNodes: 131_072,
});
export const APP_BACKEND_PROFILE_HEADER = "x-dohc-dataset-profile";

export function appBackendLimit(
  label: string,
  limit: number,
  used: number,
  unit: string,
  partial = false,
): string {
  return `${label} exceeded its limit of ${limit} ${unit}. It used ${partial ? "at least " : ""}${used} ${unit}.`;
}

export class AppBackendLimitError extends Error {
  override name = "AppBackendLimitError";
}

export type AppBackendJson =
  | null
  | boolean
  | number
  | string
  | AppBackendJson[]
  | { [key: string]: AppBackendJson };
/** Constructed by the host from current credentials, never accepted from app input. */
export type AppBackendCaller =
  | { kind: "link"; principalId: string; grantId: string }
  | {
      kind: "named";
      userId: string;
      grantId: string;
      access: "view" | "comment" | "edit";
      helper: boolean;
    }
  | { kind: "owner"; userId: string }
  /**
   * An automation running an operation for its Collection. It is not the
   * owner, so operation code that allows only the owner refuses it.
   * `automationId` is the engine's id, `collection:<collection id>#<id>`.
   */
  | { kind: "automation"; automationId: string };
export interface AppBackendInvokeRequest {
  authorityRevision: number;
  operation: string;
  idempotencyKey: string;
  input: AppBackendJson;
  dataset?: string;
}
export interface AppBackendBinaryUploadMeta {
  authorityRevision: number;
  idempotencyKey: string;
  name: string;
  contentType: string;
  dataset?: string;
}
export interface AppBackendUploadRequest extends AppBackendBinaryUploadMeta {
  bytesBase64: string;
}
export interface AppBackendFile {
  fileId: string;
  name: string;
  contentType: string;
  byteLength: number;
  sha256: string;
}
export interface AppBackendRefusal {
  code: string;
  message: string;
}

export function parseAppBackendRefusal(value: unknown): AppBackendRefusal {
  const row = record(value);
  if (
    Object.keys(row).sort().join() !== "code,message" ||
    typeof row.code !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(row.code) ||
    row.code.includes("\n") ||
    typeof row.message !== "string" ||
    bytes(row.message) > 1024
  )
    throw new Error("Invalid app refusal.");
  return { code: row.code, message: row.message };
}

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const operationPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const datasetAliasPattern = /^[a-z][a-z0-9_-]{0,63}$/;
function bytes(value: string): number {
  let total = value.length;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) continue;
    if (code < 0x800) total += 1;
    else if ((code & 0xfc00) === 0xd800 && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      total += 2;
      index++;
    } else total += 2;
  }
  return total;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid app backend record.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    throw new Error("Invalid app backend record prototype.");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== "string" ||
      forbiddenKeys.has(key) ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new Error("Invalid app backend record property.");
    }
  }
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  const row = record(value);
  const actual = Object.keys(row);
  if (
    keys.some((key) => !Object.hasOwn(row, key)) ||
    actual.some((key) => !keys.includes(key) && !optional.includes(key))
  )
    throw new Error("Unexpected app backend fields.");
  return row;
}
function datasetAlias(value: unknown): string {
  const result = text(value, 64);
  if (!datasetAliasPattern.test(result) || forbiddenKeys.has(result))
    throw new Error("Invalid app backend dataset alias.");
  return result;
}
function text(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maxBytes ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    bytes(value) > maxBytes
  ) {
    throw new Error("Invalid app backend text.");
  }
  return value;
}
function name(value: unknown, pattern = operationPattern): string {
  const result = text(value, 64);
  if (!pattern.test(result) || result.split(".").some((part) => forbiddenKeys.has(part)))
    throw new Error("Invalid app backend name.");
  return result;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || value.length !== 64 || !SHA256_HEX_PATTERN.test(value))
    throw new Error("Invalid app backend digest.");
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid app backend authority revision.");
  return value;
}
function idempotencyKey(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(result)) throw new Error("Invalid app backend idempotency key.");
  return result;
}
function filename(value: unknown): string {
  const result = text(value, 255);
  if (/[\\/]/.test(result) || result === "." || result === "..")
    throw new Error("Invalid app backend filename.");
  return result;
}
function contentType(value: unknown): string {
  const result = text(value, 127);
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(result))
    throw new Error("Invalid app backend content type.");
  return result;
}

/** Validate and copy JSON without calling user-defined getters or serialization hooks. */
export function parseAppBackendJson(
  value: unknown,
  maxBytes = APP_BACKEND_RESULT_BYTES,
  profile?: "bulk",
): AppBackendJson {
  const maxNodes =
    profile === "bulk" ? APP_BACKEND_BULK_LIMITS.jsonNodes : APP_BACKEND_JSON_MAX_NODES;
  const ceiling =
    profile === "bulk" ? APP_BACKEND_BULK_LIMITS.resultBytes : APP_BACKEND_RESULT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ceiling)
    throw new Error("Invalid app backend JSON bound.");
  let remaining = maxBytes;
  let nodes = 0;
  const limit = (max: number, used: number, unit: string): never => {
    throw new AppBackendLimitError(
      appBackendLimit("Collection action JSON", max, used, unit, true),
    );
  };
  function charge(value: string): void {
    remaining -= bytes(value);
    if (remaining < 0) limit(maxBytes, maxBytes - remaining, "bytes");
  }
  function visit(value: unknown, depth: number): AppBackendJson {
    if (++nodes > maxNodes) limit(maxNodes, nodes, "JSON nodes");
    if (depth > APP_BACKEND_JSON_MAX_DEPTH)
      limit(APP_BACKEND_JSON_MAX_DEPTH, depth, "levels of nesting");
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "string"
    ) {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("Invalid app backend JSON number.");
      if (typeof value === "string" && value.length > remaining)
        limit(maxBytes, maxBytes - remaining + value.length + 2, "bytes");
      charge(JSON.stringify(value));
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > maxNodes - nodes) limit(maxNodes, nodes + value.length, "JSON nodes");
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
      ) {
        throw new Error("Invalid app backend JSON array.");
      }
      charge("[]" + ",".repeat(Math.max(0, value.length - 1)));
      const result: AppBackendJson[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
          throw new Error("Invalid app backend JSON array item.");
        result.push(visit(descriptor.value, depth + 1));
      }
      return result;
    }
    const row = record(value);
    const keys = Object.keys(row);
    if (keys.length > maxNodes - nodes) limit(maxNodes, nodes + keys.length, "JSON nodes");
    charge("{}" + ",".repeat(Math.max(0, keys.length - 1)));
    const result: { [key: string]: AppBackendJson } = {};
    for (const key of keys) {
      if (key.length > remaining) limit(maxBytes, maxBytes - remaining + key.length + 3, "bytes");
      charge(JSON.stringify(key) + ":");
      result[key] = visit(row[key], depth + 1);
    }
    return result;
  }
  return visit(value, 0);
}

export function parseAppBackendCaller(value: unknown): AppBackendCaller {
  const row = record(value);
  if (row.kind === "owner") {
    exact(row, ["kind", "userId"]);
    return { kind: "owner", userId: text(row.userId, 256) };
  }
  if (row.kind === "link") {
    exact(row, ["kind", "principalId", "grantId"]);
    return {
      kind: "link",
      principalId: text(row.principalId, 256),
      grantId: text(row.grantId, 256),
    };
  }
  if (row.kind === "named") {
    exact(row, ["kind", "userId", "grantId", "access", "helper"]);
    if (
      (row.access !== "view" && row.access !== "comment" && row.access !== "edit") ||
      typeof row.helper !== "boolean"
    )
      throw new Error("Invalid app backend caller access.");
    return {
      kind: "named",
      userId: text(row.userId, 256),
      grantId: text(row.grantId, 256),
      access: row.access,
      helper: row.helper,
    };
  }
  if (row.kind === "automation") {
    exact(row, ["kind", "automationId"]);
    return { kind: "automation", automationId: text(row.automationId, 1024) };
  }
  throw new Error("Invalid app backend caller.");
}

export function parseAppBackendInvokeRequest(
  value: unknown,
  profile?: "bulk",
): AppBackendInvokeRequest {
  const inputBytes =
    profile === "bulk" ? APP_BACKEND_BULK_LIMITS.inputBytes : APP_BACKEND_INPUT_BYTES;
  const requestBytes =
    profile === "bulk" ? APP_BACKEND_BULK_LIMITS.requestBytes : APP_BACKEND_REQUEST_BYTES;
  const row = exact(
    value,
    ["authorityRevision", "operation", "idempotencyKey", "input"],
    ["dataset"],
  );
  const request: AppBackendInvokeRequest = {
    authorityRevision: revision(row.authorityRevision),
    operation: name(row.operation),
    idempotencyKey: idempotencyKey(row.idempotencyKey),
    input: parseAppBackendJson(row.input, inputBytes, profile),
    ...(Object.hasOwn(row, "dataset") ? { dataset: datasetAlias(row.dataset) } : {}),
  };
  const used = bytes(JSON.stringify(request));
  if (used > requestBytes)
    throw new AppBackendLimitError(
      appBackendLimit("Collection action request", requestBytes, used, "bytes"),
    );
  return request;
}

export function assertAppBackendUploadBytes(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1)
    throw new Error("Attachment upload cannot be empty.");
  if (byteLength > APP_BACKEND_UPLOAD_BYTES)
    throw new AppBackendLimitError(
      appBackendLimit("Attachment upload", APP_BACKEND_UPLOAD_BYTES, byteLength, "bytes"),
    );
}

export function parseAppBackendUploadMeta(value: unknown): AppBackendBinaryUploadMeta {
  const row = exact(
    value,
    ["authorityRevision", "idempotencyKey", "name", "contentType"],
    ["dataset"],
  );
  return {
    authorityRevision: revision(row.authorityRevision),
    idempotencyKey: idempotencyKey(row.idempotencyKey),
    name: filename(row.name),
    contentType: contentType(row.contentType),
    ...(Object.hasOwn(row, "dataset") ? { dataset: datasetAlias(row.dataset) } : {}),
  };
}

export function parseAppBackendUploadRequest(value: unknown): AppBackendUploadRequest {
  const row = exact(
    value,
    ["authorityRevision", "idempotencyKey", "name", "contentType", "bytesBase64"],
    ["dataset"],
  );
  const encoded = row.bytesBase64;
  if (typeof encoded !== "string" || !encoded.length)
    throw new Error("Invalid app backend upload encoding.");
  const maxEncoded = 4 * Math.ceil(APP_BACKEND_UPLOAD_BYTES / 3);
  if (encoded.length > maxEncoded) {
    throw new AppBackendLimitError(
      appBackendLimit(
        "Attachment upload",
        APP_BACKEND_UPLOAD_BYTES,
        Math.floor((encoded.length * 3) / 4),
        "bytes",
        true,
      ),
    );
  }
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error("Invalid app backend upload encoding.");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const byteLength = (encoded.length / 4) * 3 - padding;
  assertAppBackendUploadBytes(byteLength);
  const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(
    encoded[encoded.length - padding - 1]!,
  );
  if (last < 0 || (padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0))
    throw new Error("Invalid app backend upload size or padding.");
  const request: AppBackendUploadRequest = {
    authorityRevision: revision(row.authorityRevision),
    idempotencyKey: idempotencyKey(row.idempotencyKey),
    name: filename(row.name),
    contentType: contentType(row.contentType),
    bytesBase64: encoded,
    ...(Object.hasOwn(row, "dataset") ? { dataset: datasetAlias(row.dataset) } : {}),
  };
  const used = bytes(JSON.stringify(request));
  if (used > APP_BACKEND_UPLOAD_REQUEST_BYTES)
    throw new AppBackendLimitError(
      appBackendLimit("Attachment upload request", APP_BACKEND_UPLOAD_REQUEST_BYTES, used, "bytes"),
    );
  return request;
}

/** Check known binary signatures after validating the upload's nominal MIME type. */
export function appBackendFileSignatureMatches(contentType: string, content: Uint8Array): boolean {
  const starts = (expected: number[]) => expected.every((value, index) => content[index] === value);
  if (contentType === "image/png") return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (contentType === "image/jpeg") return starts([255, 216, 255]);
  if (contentType === "application/pdf") return starts([37, 80, 68, 70, 45]);
  return true;
}

export function parseAppBackendFile(value: unknown): AppBackendFile {
  const row = exact(value, ["fileId", "name", "contentType", "byteLength", "sha256"]);
  const fileId = text(row.fileId, 128);
  if (
    !/^[A-Za-z0-9_-]{16,128}$/.test(fileId) ||
    typeof row.byteLength !== "number" ||
    !Number.isSafeInteger(row.byteLength) ||
    row.byteLength < 1
  )
    throw new Error("Invalid app backend file.");
  if (row.byteLength > APP_BACKEND_UPLOAD_BYTES)
    throw new AppBackendLimitError(
      appBackendLimit("Attachment file", APP_BACKEND_UPLOAD_BYTES, row.byteLength, "bytes"),
    );
  return {
    fileId,
    name: filename(row.name),
    contentType: contentType(row.contentType),
    byteLength: row.byteLength,
    sha256: hash(row.sha256),
  };
}
