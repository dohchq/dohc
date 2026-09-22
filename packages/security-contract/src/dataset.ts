import { validateUserWritePath } from "@dohc/workspace-core";
import { classifyEngineFilePath } from "./enginePathFloor";
import {
  parseAppBackendCaller,
  parseAppBackendJson,
  type AppBackendCaller,
  type AppBackendJson,
} from "./appBackend";

export const DATASET_DESCRIPTOR_FILENAME = "dataset.json";
export const DATASET_METADATA_MAX_BYTES = 256 * 1024;
export const DATASET_MAX_TABLES = 64;
export const DATASET_MAX_FIELDS = 128;
export const DATASET_MAX_OPERATIONS = 128;

export type DatasetFieldType = "text" | "number" | "checkbox" | "date" | "select" | "multi-select" | "url" | "relation" | "attachment";
export type DatasetOperationKind = "read" | "create" | "edit" | "delete" | "action";
export interface DatasetRelation {
  datasetId: string;
  tableId: string;
  fieldId: string;
  many: boolean;
}
export interface DatasetField {
  fieldId: string;
  name: string;
  sqlColumn: string;
  type: DatasetFieldType;
  required: boolean;
  unique: boolean;
  default?: AppBackendJson;
  options?: string[];
  relation?: DatasetRelation;
}
export interface DatasetTable {
  tableId: string;
  name: string;
  sqlName: string;
  /** Names a required, unique text or number field. Numeric record keys must be safe integers. */
  primaryKey: string;
  fields: DatasetField[];
}
export interface DatasetOperation {
  operationId: string;
  name: string;
  label: string;
  tableId: string;
  kind: DatasetOperationKind;
  access: "link" | "helper" | "owner";
  readOnly: boolean;
  /** Declared readable or writable fields, according to kind; never a SQL grant. */
  fieldIds: string[];
}
/** Source-visible draft metadata. Parsing or sharing it grants no authority. */
export interface DatasetDefinition {
  formatVersion: 1;
  datasetId: string;
  name: string;
  schemaPath: string;
  operationsPath: string;
  tables: DatasetTable[];
  operations: DatasetOperation[];
}
/** The host verifies the digests and owner approval before using this revision. */
export interface DatasetRevision {
  datasetId: string;
  revision: number;
  revisionSha256: string;
  definitionSha256: string;
  schemaSha256: string;
  operationsSha256: string;
  definition: DatasetDefinition;
}
/** A consumer may request a subset of an approved dataset's operations. */
export interface AppDatasetBinding {
  kind: "dataset";
  datasetId: string;
  revision: number;
  revisionSha256: string;
  operationIds: string[];
}

const ids = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sqlNames = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const operationNames = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const fieldTypes = new Set<DatasetFieldType>(["text", "number", "checkbox", "date", "select", "multi-select", "url", "relation", "attachment"]);
const operationKinds = new Set<DatasetOperationKind>(["read", "create", "edit", "delete", "action"]);
const encoder = new TextEncoder();

function fail(): never { throw new Error("Invalid dataset metadata."); }
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) fail();
  return row;
}
function boundedArray(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail();
  return value;
}
function text(value: unknown, maximum = 128): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || encoder.encode(value).byteLength > maximum) fail();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || !ids.test(value)) fail();
  return value;
}
function sqlName(value: unknown): string {
  const result = text(value, 64);
  if (!sqlNames.test(result) || forbidden.has(result.toLowerCase()) || /^(sqlite_|dohc_)/i.test(result)) fail();
  return result;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) fail();
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail();
  return value;
}
function sourcePath(value: unknown, extensions: readonly string[]): string {
  const result = text(value, 1024);
  const checked = validateUserWritePath(result);
  if (!checked.ok || checked.normalized !== result || !extensions.some(extension => result.endsWith(extension)) || classifyEngineFilePath(result).kind !== "tracked") fail();
  return result;
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) fail();
}
function date(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validDefault(field: DatasetField, value: AppBackendJson): boolean {
  if (value === null) return !field.required;
  switch (field.type) {
    case "text": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "checkbox": return typeof value === "boolean";
    case "date": return typeof value === "string" && date(value);
    case "url": {
      if (typeof value !== "string" || value.trim() !== value || /\s/u.test(value)) return false;
      try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
    }
    case "select": return typeof value === "string" && field.options!.includes(value);
    case "multi-select": return Array.isArray(value) && value.every(entry => typeof entry === "string" && field.options!.includes(entry)) && new Set(value).size === value.length;
    // Attachment ownership and referenced records require host validation at write time.
    case "attachment": return false;
    case "relation": return field.relation!.many && Array.isArray(value) && value.length === 0;
  }
}
function field(value: unknown): DatasetField {
  const row = record(value, ["fieldId", "name", "sqlColumn", "type", "required", "unique"], ["default", "options", "relation"]);
  if (!fieldTypes.has(row.type as DatasetFieldType)) fail();
  const result: DatasetField = { fieldId: uuid(row.fieldId), name: text(row.name), sqlColumn: sqlName(row.sqlColumn), type: row.type as DatasetFieldType,
    required: boolean(row.required), unique: boolean(row.unique) };
  if (result.type === "select" || result.type === "multi-select") {
    result.options = boundedArray(row.options, 100, 1).map(value => text(value, 200));
    unique(result.options);
  } else if (Object.hasOwn(row, "options")) fail();
  if (result.type === "relation") {
    const relation = record(row.relation, ["datasetId", "tableId", "fieldId", "many"]);
    result.relation = { datasetId: uuid(relation.datasetId), tableId: uuid(relation.tableId), fieldId: uuid(relation.fieldId), many: boolean(relation.many) };
  } else if (Object.hasOwn(row, "relation")) fail();
  if (result.unique && (result.type === "attachment" || result.type === "multi-select" || result.relation?.many)) fail();
  if (Object.hasOwn(row, "default")) {
    result.default = row.default as AppBackendJson;
    if (!validDefault(result, result.default)) fail();
  }
  return result;
}
function table(value: unknown): DatasetTable {
  const row = record(value, ["tableId", "name", "sqlName", "primaryKey", "fields"]);
  const result: DatasetTable = { tableId: uuid(row.tableId), name: text(row.name), sqlName: sqlName(row.sqlName), primaryKey: sqlName(row.primaryKey),
    fields: boundedArray(row.fields, DATASET_MAX_FIELDS, 1).map(field) };
  unique(result.fields.map(field => field.sqlColumn.toLowerCase()));
  unique(result.fields.map(field => field.name));
  const primary = result.fields.find(field => field.sqlColumn === result.primaryKey);
  if (!primary || !["text", "number"].includes(primary.type) || !primary.required || !primary.unique || Object.hasOwn(primary, "default")) fail();
  return result;
}
function operation(value: unknown): DatasetOperation {
  const row = record(value, ["operationId", "name", "label", "tableId", "kind", "access", "readOnly", "fieldIds"]);
  const name = text(row.name, 64);
  if (!operationNames.test(name) || name.split(".").some(part => forbidden.has(part)) || !operationKinds.has(row.kind as DatasetOperationKind) || !["link", "helper", "owner"].includes(row.access as string)) fail();
  const result: DatasetOperation = { operationId: uuid(row.operationId), name, label: text(row.label), tableId: uuid(row.tableId),
    kind: row.kind as DatasetOperationKind, access: row.access as DatasetOperation["access"], readOnly: boolean(row.readOnly),
    fieldIds: boundedArray(row.fieldIds, DATASET_MAX_FIELDS).map(uuid) };
  if ((result.kind === "read" && !result.readOnly) || (["create", "edit", "delete"].includes(result.kind) && result.readOnly)) fail();
  if (result.kind === "delete" && result.fieldIds.length) fail();
  unique(result.fieldIds);
  return result;
}
function definition(value: unknown): DatasetDefinition {
  const row = record(value, ["formatVersion", "datasetId", "name", "schemaPath", "operationsPath", "tables", "operations"]);
  if (row.formatVersion !== 1) fail();
  const result: DatasetDefinition = { formatVersion: 1, datasetId: uuid(row.datasetId), name: text(row.name),
    schemaPath: sourcePath(row.schemaPath, [".sql"]), operationsPath: sourcePath(row.operationsPath, [".js", ".ts"]),
    tables: boundedArray(row.tables, DATASET_MAX_TABLES, 1).map(table), operations: boundedArray(row.operations, DATASET_MAX_OPERATIONS, 1).map(operation) };
  unique([result.datasetId, ...result.tables.map(table => table.tableId), ...result.tables.flatMap(table => table.fields.map(field => field.fieldId)), ...result.operations.map(operation => operation.operationId)]);
  unique(result.tables.map(table => table.sqlName.toLowerCase()));
  unique(result.tables.map(table => table.name));
  unique(result.operations.map(operation => operation.name));
  const tables = new Map(result.tables.map(table => [table.tableId, table]));
  for (const table of result.tables) {
    for (const field of table.fields) {
      if (!field.relation) continue;
      const target = tables.get(field.relation.tableId)?.fields.find(candidate => candidate.fieldId === field.relation!.fieldId);
      if (field.relation.datasetId !== result.datasetId || !target || !target.unique || !target.required || !["text", "number"].includes(target.type)) fail();
    }
  }
  for (const operation of result.operations) {
    const table = tables.get(operation.tableId);
    if (!table || operation.fieldIds.some(id => !table.fields.some(field => field.fieldId === id))) fail();
    if (operation.kind === "edit" && operation.fieldIds.some(id => table.fields.some(field => field.fieldId === id && field.sqlColumn === table.primaryKey))) fail();
  }
  return result;
}

export function parseDatasetDefinition(value: unknown): DatasetDefinition {
  return definition(parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES));
}
export function parseDatasetRevision(value: unknown): DatasetRevision {
  const row = record(parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES), ["datasetId", "revision", "revisionSha256", "definitionSha256", "schemaSha256", "operationsSha256", "definition"]);
  const result: DatasetRevision = { datasetId: uuid(row.datasetId), revision: revision(row.revision), revisionSha256: digest(row.revisionSha256),
    definitionSha256: digest(row.definitionSha256), schemaSha256: digest(row.schemaSha256), operationsSha256: digest(row.operationsSha256), definition: definition(row.definition) };
  if (result.datasetId !== result.definition.datasetId) fail();
  return result;
}
export function parseDatasetBinding(value: unknown, approvedRevision: DatasetRevision): AppDatasetBinding {
  const approved = parseDatasetRevision(approvedRevision);
  const row = record(parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES), ["kind", "datasetId", "revision", "revisionSha256", "operationIds"]);
  if (row.kind !== "dataset") fail();
  const result: AppDatasetBinding = { kind: "dataset", datasetId: uuid(row.datasetId), revision: revision(row.revision), revisionSha256: digest(row.revisionSha256),
    operationIds: boundedArray(row.operationIds, DATASET_MAX_OPERATIONS, 1).map(uuid) };
  if (result.datasetId !== approved.datasetId || result.revision !== approved.revision || result.revisionSha256 !== approved.revisionSha256) fail();
  unique(result.operationIds);
  const operations = new Set(approved.definition.operations.map(operation => operation.operationId));
  if (result.operationIds.some(id => !operations.has(id))) fail();
  return result;
}

/** Caller must be derived from current host credentials, never request JSON. */
export function effectiveDatasetOperations(binding: unknown, approvedRevision: DatasetRevision, caller: AppBackendCaller): DatasetOperation[] {
  const approved = parseDatasetRevision(approvedRevision);
  const parsed = parseDatasetBinding(binding, approved);
  const principal = parseAppBackendCaller(caller);
  const allowed = new Set(parsed.operationIds);
  return approved.definition.operations.filter(operation => allowed.has(operation.operationId) && (
    principal.kind === "owner" || operation.access === "link" ||
    (operation.access === "helper" && principal.kind === "named" && principal.helper)
  ));
}

/** Stable inventory ordering and fixed member ordering for definition hashing. */
export function datasetDefinitionDigestContent(value: DatasetDefinition): string {
  const parsed = parseDatasetDefinition(value);
  const byId = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  parsed.tables.sort((left, right) => byId(left.tableId, right.tableId));
  for (const table of parsed.tables) table.fields.sort((left, right) => byId(left.fieldId, right.fieldId));
  parsed.operations.sort((left, right) => byId(left.operationId, right.operationId));
  for (const operation of parsed.operations) operation.fieldIds.sort(byId);
  return JSON.stringify(parsed);
}

/** Hash this UTF-8 content when approving/verifying a revision; the digest is not an approval. */
export function datasetRevisionDigestContent(value: DatasetRevision): string {
  const parsed = parseDatasetRevision(value);
  return JSON.stringify({ datasetId: parsed.datasetId, revision: parsed.revision, definitionSha256: parsed.definitionSha256,
    schemaSha256: parsed.schemaSha256, operationsSha256: parsed.operationsSha256 });
}
