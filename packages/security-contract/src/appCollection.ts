import { validateUserWritePath } from "@dohc/workspace-core";
import { classifyEngineFilePath } from "./enginePathFloor";
import { SHA256_HEX_PATTERN } from "./wirePatterns";

export interface AppCollectionCapability {
  kind: "collection-create";
  collectionPath: string;
  schemaSha256: string;
  allowedFields: string[];
  requiredFields: string[];
  /** Fields returned by the app API. Shared response files remain readable in full. */
  readFields: string[];
}
export const APP_COLLECTION_SERVER_FIELDS = ["id", "created_at", "created_by", "grant_id", "idempotency_key", "acceptance_id"] as const;
const reserved = new Set<string>(APP_COLLECTION_SERVER_FIELDS);
export const APP_COLLECTION_REQUEST_BYTES = 16_384;
export const APP_COLLECTION_FIELDS_BYTES = 8_192;
export const APP_COLLECTION_CURSOR_BYTES = 8_192;
export const APP_COLLECTION_PAGE_BYTES = 65_536;
// JSON can escape each cursor byte to six bytes, plus the page envelope.
export const APP_COLLECTION_RESPONSE_BYTES = APP_COLLECTION_PAGE_BYTES + APP_COLLECTION_CURSOR_BYTES * 6 + 1_024;
export interface AppCollectionCreateRequest {authorityRevision:number;idempotencyKey:string;fields:Record<string,unknown>}
export interface AppCollectionReadRequest {authorityRevision:number;limit:number;afterPath?:string}
export interface AppCollectionReceipt {kind:"accepted";acceptanceId:string;objectId:string;path:string;momentId:string;acceptedAtMs:number}
export interface AppCollectionPage {records:{path:string;recordId:string|null;fields:Record<string,unknown>}[];nextPath:string|null}
const revision = (value:unknown):number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid collection authority revision.");
  return value;
};
export function parseAppCollectionCreateRequest(value:unknown):AppCollectionCreateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid collection request.");
  const row=value as Record<string,unknown>;
  if (Object.keys(row).sort().join() !== "authorityRevision,fields,idempotencyKey" || typeof row.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(row.idempotencyKey) || !row.fields || typeof row.fields !== "object" || Array.isArray(row.fields)) throw new Error("Invalid collection request.");
  if (Object.keys(row.fields).length > 32 || new TextEncoder().encode(JSON.stringify(row.fields)).byteLength > APP_COLLECTION_FIELDS_BYTES) throw new Error("Collection fields are too large.");
  return {authorityRevision:revision(row.authorityRevision),idempotencyKey:row.idempotencyKey,fields:row.fields as Record<string,unknown>};
}
export function parseAppCollectionReadQuery(query:URLSearchParams):AppCollectionReadRequest {
  if ([...query.keys()].some(key=>!["authorityRevision","limit","afterPath"].includes(key)) || ["authorityRevision","limit","afterPath"].some(key=>query.getAll(key).length>1)) throw new Error("Invalid collection query.");
  const rawRevision=query.get("authorityRevision"),rawLimit=query.get("limit")??"50",afterPath=query.get("afterPath");
  if (!rawRevision || !/^[1-9]\d*$/.test(rawRevision) || !/^[1-9]\d*$/.test(rawLimit)) throw new Error("Invalid collection query.");
  const authorityRevision=revision(Number(rawRevision)),limit=Number(rawLimit);
  if (!Number.isSafeInteger(limit)||limit>100) throw new Error("Invalid collection page limit.");
  if (afterPath !== null) {
    const path=validateUserWritePath(afterPath);
    if (!afterPath || new TextEncoder().encode(afterPath).byteLength>APP_COLLECTION_CURSOR_BYTES || !path.ok || path.normalized!==afterPath) throw new Error("Invalid collection page cursor.");
  }
  return {authorityRevision,limit,...(afterPath===null?{}:{afterPath})};
}
export function parseAppCollectionCapability(value: unknown): AppCollectionCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid collection capability.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== ["kind", "collectionPath", "schemaSha256", "allowedFields", "requiredFields", "readFields"].sort().join() || row.kind !== "collection-create") throw new Error("Invalid collection capability.");
  if (typeof row.collectionPath !== "string" || row.collectionPath.length > 1024) throw new Error("Invalid collection path.");
  const checked = validateUserWritePath(row.collectionPath);
  if (!checked.ok || checked.normalized !== row.collectionPath || classifyEngineFilePath(row.collectionPath).kind !== "tracked") throw new Error("Invalid collection path.");
  if (typeof row.schemaSha256 !== "string" || !SHA256_HEX_PATTERN.test(row.schemaSha256)) throw new Error("Invalid collection schema digest.");
  const fields = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 32 || value.some(name => typeof name !== "string" || !name || new TextEncoder().encode(name).byteLength > 128 || /[\u0000-\u001f]/.test(name) || reserved.has(name.toLowerCase()) || ["__proto__", "prototype", "constructor"].includes(name))) throw new Error("Invalid collection fields.");
    if (new Set(value).size !== value.length) throw new Error("Duplicate collection field.");
    return [...value].sort();
  };
  const allowedFields = fields(row.allowedFields), requiredFields = fields(row.requiredFields), readFields = fields(row.readFields);
  if (!allowedFields.length || requiredFields.some(name => !allowedFields.includes(name))) throw new Error("Invalid required collection fields.");
  return {kind: "collection-create", collectionPath: row.collectionPath, schemaSha256: row.schemaSha256, allowedFields, requiredFields, readFields};
}
