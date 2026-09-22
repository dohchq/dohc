import { parseAppBackendJson, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetField, DatasetOperation } from "@dohc/security-contract/dataset";

export type TransactionalField = Omit<DatasetField, "sqlColumn">;
export interface TransactionalDatasetDescription {
  datasetId: string;
  name: string;
  revision: number;
  revisionSha256: string;
  tables: Array<{ tableId: string; name: string; fields: TransactionalField[] }>;
  operations: DatasetOperation[];
}
export interface TransactionalRow { id: string | number; version: number; values: Record<string, AppBackendJson> }
export interface TransactionalCursor { id: string | number; value: AppBackendJson }
export interface TransactionalPage { rows: TransactionalRow[]; nextCursor: TransactionalCursor | null }

export function object(value: AppBackendJson): Record<string, AppBackendJson> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("The collection returned an invalid result.");
  return value;
}
function key(value: AppBackendJson | undefined): string | number {
  if ((typeof value === "string" && value.length > 0 && value.length <= 1024) || (typeof value === "number" && Number.isSafeInteger(value))) return value;
  throw new Error("The collection returned an invalid record identity.");
}
export function parsePage(value: unknown, allowedFields: readonly string[]): TransactionalPage {
  const result = object(parseAppBackendJson(value));
  if (!Array.isArray(result.rows) || result.rows.length > 50 || !Object.hasOwn(result, "nextCursor")) throw new Error("The collection returned an invalid page.");
  const ids = new Set<string>();
  const rows = result.rows.map(value => {
    const row = object(value);
    const id = key(row.id);
    const encoded = JSON.stringify(id);
    if (ids.has(encoded) || typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error("The collection returned an invalid record.");
    ids.add(encoded);
    const values = object(row.values!);
    return { id, version: row.version, values: Object.fromEntries(Object.entries(values).filter(([fieldId]) => allowedFields.includes(fieldId))) };
  });
  let nextCursor: TransactionalCursor | null = null;
  if (result.nextCursor !== null) {
    const cursor = object(result.nextCursor!);
    if (!Object.hasOwn(cursor, "value")) throw new Error("The collection returned an invalid cursor.");
    nextCursor = { id: key(cursor.id), value: cursor.value! };
  }
  return { rows, nextCursor };
}
export function display(value: AppBackendJson | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(display).join(", ");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
export function supportsInput(field: TransactionalField): boolean { return field.type !== "relation" && field.type !== "attachment"; }
export function supportsSort(field: TransactionalField): boolean {
  return field.type !== "attachment" && field.type !== "multi-select" && !field.relation?.many;
}
export function initialValue(field: TransactionalField): AppBackendJson {
  return field.default ?? (field.type === "checkbox" ? false : field.type === "multi-select" ? [] : null);
}
export function inputProblem(field: TransactionalField, value: AppBackendJson): string | null {
  if (value === null || value === "") return field.required ? `Enter ${field.name}.` : null;
  if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return "Enter a number.";
  if (field.type === "url") {
    try { if (typeof value !== "string" || !["https:", "http:"].includes(new URL(value).protocol)) return "Enter a web address."; }
    catch { return "Enter a web address."; }
  }
  return null;
}
