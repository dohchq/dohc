import { validateUserWritePath } from "@dohc/workspace-core";
import { classifyEngineFilePath } from "./enginePathFloor";
import { SHA256_HEX_PATTERN } from "./wirePatterns";

export interface AppCollectionCapability {
  kind: "collection-create";
  collectionPath: string;
  schemaSha256: string;
  allowedFields: string[];
  requiredFields: string[];
  readFields: string[];
}
export const APP_COLLECTION_SERVER_FIELDS = ["id", "created_at", "created_by", "grant_id", "idempotency_key", "acceptance_id"] as const;
const reserved = new Set<string>(APP_COLLECTION_SERVER_FIELDS);
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
