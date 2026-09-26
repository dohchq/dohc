import { parseAppBackendJson, type AppBackendJson } from "@dohc/security-contract/app-backend";
import { datasetColumnFields, type DatasetColumnField, type DatasetDescription, type DatasetOperation } from "@dohc/security-contract/dataset";

/** A field the table shows and edits: a column. Buttons come with their own interface. */
export type TransactionalField = Omit<DatasetColumnField, "sqlColumn">;
export function isGeneratedRecordIdField(field: TransactionalField, table: { tableId: string; primaryKeyFieldId?: string }, operations: readonly DatasetOperation[]): boolean {
  return field.fieldId === table.primaryKeyFieldId && field.type === "text" &&
    !operations.some(operation => operation.tableId === table.tableId && operation.kind === "create" && operation.fieldIds.includes(field.fieldId));
}
export interface TransactionalDatasetDescription {
  datasetId: string;
  name: string;
  revision: number;
  revisionSha256: string;
  tables: Array<{ tableId: string; name: string; primaryKeyFieldId?: string; fields: TransactionalField[] }>;
  operations: DatasetOperation[];
}
/** The description's column fields, which the table reads and writes. */
export function transactionalDescription(description: DatasetDescription): TransactionalDatasetDescription {
  return { datasetId: description.datasetId, name: description.name, revision: description.revision, revisionSha256: description.revisionSha256,
    tables: description.tables.map(table => ({ tableId: table.tableId, name: table.name, primaryKeyFieldId: table.primaryKeyFieldId, fields: datasetColumnFields(table) })),
    operations: description.operations };
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
  return field.default ?? (field.type === "checkbox" ? false : field.type === "multi-select" || field.relation?.many ? [] : null);
}
export function inputProblem(field: TransactionalField, value: AppBackendJson): string | null {
  if (value === null || value === "") return field.required ? `Enter ${field.name}.` : null;
  if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return "Enter a number.";
  if (field.type === "attachment" && (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value))) return `Choose a file for ${field.name}.`;
  if (field.type === "relation") {
    const validKey = (key: AppBackendJson) => (typeof key === "string" && key.length > 0 && key.length <= 1024) || (typeof key === "number" && Number.isSafeInteger(key));
    if (field.relation?.many ? !Array.isArray(value) || value.length > 100 || !value.every(validKey) || new Set(value.map(key => JSON.stringify(key))).size !== value.length : !validKey(value)) return `Choose a related record for ${field.name}.`;
  }
  if (field.type === "url") {
    try { if (typeof value !== "string" || !["https:", "http:"].includes(new URL(value).protocol)) return "Enter a web address."; }
    catch { return "Enter a web address."; }
  }
  return null;
}
