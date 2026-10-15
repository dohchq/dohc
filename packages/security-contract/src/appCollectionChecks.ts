import { isRecordId, parseCollectionRecordFields, parseCollectionSchema, validateFieldValue } from "@dohc/workspace-contracts/collection-values";
import { collectionVersionError, type CollectionSchema } from "@dohc/workspace-contracts/collection";
import { APP_COLLECTION_CURSOR_BYTES, APP_COLLECTION_FIELDS_BYTES, APP_COLLECTION_PAGE_BYTES, type AppCollectionCapability, type AppCollectionPage } from "./appCollection";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const APP_COLLECTION_MAX_SCHEMA_BYTES = 65_536;
export const APP_COLLECTION_MAX_RECORD_BYTES = 16_384;
export type AppCollectionCheck<T> = {ok: true; value: T} | {ok: false; message: string};

export function narrowsAppCollectionCapability(requested: AppCollectionCapability, approved: AppCollectionCapability): boolean {
  return requested.collectionPath === approved.collectionPath && requested.schemaSha256 === approved.schemaSha256 &&
    approved.allowedFields.every(name => requested.allowedFields.includes(name)) && requested.requiredFields.every(name => approved.requiredFields.includes(name)) &&
    approved.readFields.every(name => requested.readFields.includes(name));
}
export function exposesAppCollectionSubmittedFields(capability: AppCollectionCapability): boolean {
  return capability.allowedFields.every(name => capability.readFields.includes(name));
}
export function validateAppCollectionSchema(text: string, capability: AppCollectionCapability, reader: "dohc" | "sync service"): AppCollectionCheck<CollectionSchema> {
  const parsed = parseCollectionSchema(text);
  const versionError = collectionVersionError(parsed.reasons, `${capability.collectionPath}/collection.yaml`, reader);
  if (versionError) return {ok: false, message: versionError};
  if (parsed.status !== "valid" || [...capability.allowedFields, ...capability.readFields].some(name => !parsed.schema.fields.some(field => field.name === name))) return {ok: false, message: "Collection schema does not match approval."};
  return {ok: true, value: parsed.schema};
}

export function validateAppCollectionCreateFields(value: unknown, capability: AppCollectionCapability, schema: CollectionSchema): AppCollectionCheck<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 32) return {ok: false, message: "Invalid collection response."};
  const record = value as Record<string, unknown>, entries = Object.entries(record).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
  if (capability.requiredFields.some(name => !Object.hasOwn(record,name) || record[name] == null)) return {ok: false, message: "Required collection field is missing."};
  for (const [name, value] of entries) {
    const field = schema.fields.find(field => field.name === name);
    if (!capability.allowedFields.includes(name) || !field || validateFieldValue(field,value).status !== "valid") return {ok: false, message: "Invalid collection response field."};
    // Only JSON scalar and scalar-array values are needed by the collection schema.
    const valid = (entry: unknown) => entry === null || typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry));
    if (!(valid(value) || (Array.isArray(value) && value.every(valid)))) return {ok: false, message: "Invalid collection response value."};
  }
  const result = Object.fromEntries(entries);
  if (bytes(result) > APP_COLLECTION_FIELDS_BYTES) return {ok: false, message: "Collection response is too large."};
  return {ok: true, value: result};
}

export function isAppCollectionPageRequest(limit: unknown, afterPath: unknown): boolean {
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 &&
    (afterPath === undefined || (typeof afterPath === "string" && new TextEncoder().encode(afterPath).byteLength <= APP_COLLECTION_CURSOR_BYTES));
}
/** Matches the relay's SQL filter on normalized workspace paths. Reject raw Windows names and NUL. */
export function isAppCollectionRecordPath(collectionPath: string, path: string): boolean {
  const prefix = `${collectionPath}/`;
  return !collectionPath.includes("\0") && !collectionPath.includes("\\") && !path.includes("\0") && !path.includes("\\") && path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && path.slice(-3).toLowerCase() === ".md" &&
    new TextEncoder().encode(path).byteLength <= APP_COLLECTION_CURSOR_BYTES;
}
/** Compare paths and cursors by UTF-8 bytes, matching SQLite BINARY ordering. */
export function compareAppCollectionPaths(a: string, b: string): number {
  const encoder = new TextEncoder(), left = encoder.encode(a), right = encoder.encode(b);
  for (let index = 0; index < Math.min(left.length,right.length); index++) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length - right.length;
}
export function projectAppCollectionRecord(path: string, blob: Uint8Array, capability: AppCollectionCapability, schema: CollectionSchema): AppCollectionPage["records"][number] | null {
  if (blob.byteLength > APP_COLLECTION_MAX_RECORD_BYTES) return null;
  let value: Record<string, unknown> | null;
  try {value = parseCollectionRecordFields(new TextDecoder("utf-8", {fatal: true}).decode(blob));}
  catch {return null;}
  if (!value) return null;
  const selected = Object.fromEntries(capability.readFields.filter(name => Object.hasOwn(value,name)).map(name => [name,value[name]]));
  if (Object.keys(selected).length === 0) return null;
  if (Object.entries(selected).some(([name,value]) => {
    const field = schema.fields.find(field => field.name === name);
    return !field || validateFieldValue(field,value).status !== "valid";
  })) return null;
  return {path,recordId:typeof value.id === "string" && isRecordId(value.id) ? value.id : null,fields:selected};
}
/** Consume the already ordered scan window lazily, stopping before the first overflowing record. */
export function pageAppCollectionRecords(rows: Iterable<{path: string; record: AppCollectionPage["records"][number] | null}>, hasMore: boolean): AppCollectionPage {
  const records: AppCollectionPage["records"] = [];
  let pageBytes = 0, scannedPath: string | null = null;
  for (const {path, record} of rows) {
    if (!record) {scannedPath=path;continue;}
    const size = bytes(record);
    if (size > APP_COLLECTION_PAGE_BYTES) {scannedPath=record.path;continue;}
    if (pageBytes + size > APP_COLLECTION_PAGE_BYTES && records.length) return {records,nextPath:scannedPath};
    pageBytes += size;records.push(record);scannedPath=record.path;
  }
  return {records,nextPath:hasMore ? scannedPath : null};
}
