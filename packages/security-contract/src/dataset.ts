import { validateUserWritePath } from "@dohc/workspace-core";
import { classifyEngineFilePath } from "./enginePathFloor";
import {
  parseAppBackendJson,
  type AppBackendJson,
} from "./appBackend";

export const DATASET_DESCRIPTOR_FILENAME = "dataset.json";
export const DATASET_METADATA_MAX_BYTES = 256 * 1024;
export const DATASET_MAX_TABLES = 64;
export const DATASET_MAX_FIELDS = 128;
export const DATASET_MAX_OPERATIONS = 128;

export type DatasetColumnFieldType = "text" | "number" | "checkbox" | "date" | "select" | "multi-select" | "url" | "relation" | "attachment";
export type DatasetFieldType = DatasetColumnFieldType | "button";
export type DatasetOperationKind = "read" | "create" | "edit" | "delete" | "action";
export interface DatasetRelation {
  datasetId: string;
  tableId: string;
  fieldId: string;
  many: boolean;
}
/** A field stored in a SQL column. */
export interface DatasetColumnField {
  fieldId: string;
  name: string;
  sqlColumn: string;
  type: DatasetColumnFieldType;
  required: boolean;
  unique: boolean;
  default?: AppBackendJson;
  options?: string[];
  relation?: DatasetRelation;
}
/**
 * A button on each record that runs an automation. It stores nothing, so it
 * has no column, and no operation reads or writes it.
 */
export interface DatasetButtonField {
  fieldId: string;
  name: string;
  type: "button";
}
export type DatasetField = DatasetColumnField | DatasetButtonField;
/** A field as a description shows it: its column stays with the host. */
export type DatasetDescribedField = Omit<DatasetColumnField, "sqlColumn"> | DatasetButtonField;
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
  /** The edit accepts its receipt's priorValues under the same record-version guard. */
  reversible?: true;
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
  /** Generated forms may narrow the writable fields of a create operation. */
  createFields?: Array<{ operationId: string; fieldIds: string[] }>;
  /** Owner-approved reads for this app's link audience, including their exact fields. */
  linkReads?: Array<{ operationId: string; fieldIds: string[] }>;
}
/** Public dispatch metadata, derived from the approved revision rather than app source. */
export interface AppDatasetCapability extends AppDatasetBinding {
  operations: Array<Pick<DatasetOperation, "operationId" | "name" | "access" | "readOnly"> & { fields?: Array<{ fieldId: string; name: string }> }>;
}
/** Grant-filtered metadata for Collection controls and agent discovery. */
export interface DatasetDescription {
  /** Present on owner lifecycle discovery; archived data cannot run actions. */
  archived?: boolean;
  datasetId: string;
  name: string;
  revision: number;
  revisionSha256: string;
  tables: Array<{ tableId: string; name: string; fields: DatasetDescribedField[] }>;
  operations: DatasetOperation[];
}

const ids = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sqlNames = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const operationNames = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const fieldTypes = new Set<DatasetColumnFieldType>(["text", "number", "checkbox", "date", "select", "multi-select", "url", "relation", "attachment"]);
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
export function isDatasetColumnField<Field extends { type: DatasetFieldType }>(field: Field): field is Exclude<Field, DatasetButtonField> {
  return field.type !== "button";
}
/** The fields a table stores: what SQL, CSV, copies, and operations read. */
export function datasetColumnFields<Field extends { type: DatasetFieldType }>(table: { fields: readonly Field[] }): Array<Exclude<Field, DatasetButtonField>> {
  return table.fields.filter(isDatasetColumnField);
}
function validDefault(field: DatasetColumnField, value: AppBackendJson): boolean {
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
    case "relation": return field.relation?.many !== false && Array.isArray(value) && value.length === 0;
  }
}
function button(value: unknown): DatasetButtonField {
  const row = record(value, ["fieldId", "name", "type"]);
  if (row.type !== "button") fail();
  return { fieldId: uuid(row.fieldId), name: text(row.name), type: "button" };
}
function isButtonRow(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).type === "button";
}
function field(value: unknown): DatasetField {
  return isButtonRow(value) ? button(value) : columnField(value);
}
function columnField(value: unknown, allowWithheldRelation = false): DatasetColumnField {
  const row = record(value, ["fieldId", "name", "sqlColumn", "type", "required", "unique"], ["default", "options", "relation"]);
  if (!fieldTypes.has(row.type as DatasetColumnFieldType)) fail();
  const result: DatasetColumnField = { fieldId: uuid(row.fieldId), name: text(row.name), sqlColumn: sqlName(row.sqlColumn), type: row.type as DatasetColumnFieldType,
    required: boolean(row.required), unique: boolean(row.unique) };
  if (result.type === "select" || result.type === "multi-select") {
    result.options = boundedArray(row.options, 100, 1).map(value => text(value, 200));
    unique(result.options);
  } else if (Object.hasOwn(row, "options")) fail();
  if (result.type === "relation" && (!allowWithheldRelation || Object.hasOwn(row, "relation"))) {
    const relation = record(row.relation, ["datasetId", "tableId", "fieldId", "many"]);
    result.relation = { datasetId: uuid(relation.datasetId), tableId: uuid(relation.tableId), fieldId: uuid(relation.fieldId), many: boolean(relation.many) };
  } else if (result.type !== "relation" && Object.hasOwn(row, "relation")) fail();
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
  const columns = datasetColumnFields(result);
  unique(columns.map(field => field.sqlColumn.toLowerCase()));
  unique(result.fields.map(field => field.name));
  const primary = columns.find(field => field.sqlColumn === result.primaryKey);
  if (!primary || !["text", "number"].includes(primary.type) || !primary.required || !primary.unique || Object.hasOwn(primary, "default")) fail();
  return result;
}
function operation(value: unknown): DatasetOperation {
  const row = record(value, ["operationId", "name", "label", "tableId", "kind", "access", "readOnly", "fieldIds"], ["reversible"]);
  const name = text(row.name, 64);
  if (!operationNames.test(name) || name.split(".").some(part => forbidden.has(part)) || !operationKinds.has(row.kind as DatasetOperationKind) || !["link", "helper", "owner"].includes(row.access as string)) fail();
  const result: DatasetOperation = { operationId: uuid(row.operationId), name, label: text(row.label), tableId: uuid(row.tableId),
    kind: row.kind as DatasetOperationKind, access: row.access as DatasetOperation["access"], readOnly: boolean(row.readOnly),
    fieldIds: boundedArray(row.fieldIds, DATASET_MAX_FIELDS).map(uuid) };
  if ((result.kind === "read" && !result.readOnly) || (["create", "edit", "delete"].includes(result.kind) && result.readOnly)) fail();
  if (result.kind === "delete" && result.fieldIds.length) fail();
  if (Object.hasOwn(row, "reversible")) {
    if (row.reversible !== true || result.kind !== "edit" || result.readOnly) fail();
    result.reversible = true;
  }
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
    for (const field of datasetColumnFields(table)) {
      if (field.relation) relationTarget(tables, result.datasetId, field.relation);
    }
  }
  for (const operation of result.operations) {
    const table = tables.get(operation.tableId);
    // An operation reads and writes columns. A button has none.
    if (!table || operation.fieldIds.some(id => !datasetColumnFields(table).some(field => field.fieldId === id))) fail();
    if (operation.kind === "edit" && operation.fieldIds.some(id => datasetColumnFields(table).some(field => field.fieldId === id && field.sqlColumn === table.primaryKey))) fail();
  }
  return result;
}
// A relation names a required, unique text or number column in this dataset.
function relationTarget(tables: ReadonlyMap<string, { fields: ReadonlyArray<{ fieldId: string; type: DatasetFieldType; unique?: boolean; required?: boolean }> }>,
  datasetId: string, relation: DatasetRelation): void {
  const target = tables.get(relation.tableId)?.fields.find(candidate => candidate.fieldId === relation.fieldId);
  if (relation.datasetId !== datasetId || !target || target.type === "button" || !target.unique || !target.required || !["text", "number"].includes(target.type)) fail();
}

export function parseDatasetDefinition(value: unknown): DatasetDefinition {
  return definition(parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES));
}

export function parseDatasetDescription(value: unknown): DatasetDescription {
  const row = record(parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES), ["datasetId", "name", "revision", "revisionSha256", "tables", "operations"], ["archived"]);
  if (row.archived !== undefined && typeof row.archived !== "boolean") fail();
  const result: DatasetDescription = {
    ...(row.archived === undefined ? {} : { archived: row.archived }),
    datasetId: uuid(row.datasetId), name: text(row.name), revision: revision(row.revision), revisionSha256: digest(row.revisionSha256),
    tables: boundedArray(row.tables, DATASET_MAX_TABLES).map(value => {
      const table = record(value, ["tableId", "name", "fields"]);
      const fields = boundedArray(table.fields, DATASET_MAX_FIELDS).map((value): DatasetDescribedField => {
        if (isButtonRow(value)) return button(value);
        const metadata = record(value, ["fieldId", "name", "type", "required", "unique"], ["default", "options", "relation"]);
        const { sqlColumn: _column, ...parsed } = columnField({ ...metadata, sqlColumn: "field" }, true);
        return parsed;
      });
      unique(fields.map(field => field.name));
      return { tableId: uuid(table.tableId), name: text(table.name), fields };
    }),
    operations: boundedArray(row.operations, DATASET_MAX_OPERATIONS).map(operation),
  };
  unique([result.datasetId, ...result.tables.map(table => table.tableId), ...result.tables.flatMap(table => table.fields.map(field => field.fieldId)), ...result.operations.map(operation => operation.operationId)]);
  unique(result.tables.map(table => table.name));
  unique(result.operations.map(operation => operation.name));
  const tables = new Map(result.tables.map(table => [table.tableId, table]));
  for (const operation of result.operations) {
    const table = tables.get(operation.tableId);
    if (!table || operation.fieldIds.some(id => !datasetColumnFields(table).some(field => field.fieldId === id))) fail();
  }
  for (const table of result.tables) {
    const archivedMetadata = result.archived === true && result.operations.length === 0;
    if (!archivedMetadata && !result.operations.some(operation => operation.tableId === table.tableId)) fail();
    // A described column belongs to a described operation. A button belongs to none.
    for (const field of datasetColumnFields(table)) {
      if (!archivedMetadata && !result.operations.some(operation => operation.tableId === table.tableId && operation.fieldIds.includes(field.fieldId))) fail();
      if (field.relation) relationTarget(tables, result.datasetId, field.relation);
    }
  }
  return result;
}
/**
 * What a caller holding `operations` may see of an approved revision: each
 * table an operation uses, the columns the operations list, and the table's
 * buttons. A button grants nothing: pressing one checks the operations its
 * automation's steps invoke. A relation to a column the caller cannot see
 * is left out.
 */
export function describeApprovedDataset(approved: DatasetRevision, operations: DatasetOperation[]): DatasetDescription {
  const fields = new Set(operations.flatMap(operation => operation.fieldIds));
  const tables = new Set(operations.map(operation => operation.tableId));
  return { datasetId: approved.datasetId, name: approved.definition.name, revision: approved.revision, revisionSha256: approved.revisionSha256,
    tables: approved.definition.tables.filter(table => tables.has(table.tableId)).map(table => ({ tableId: table.tableId, name: table.name,
      fields: table.fields.filter(field => field.type === "button" || fields.has(field.fieldId)).map((field): DatasetDescribedField => {
        if (field.type === "button") return { fieldId: field.fieldId, name: field.name, type: "button" };
        const { sqlColumn: _sqlColumn, ...description } = field;
        if (description.relation && !fields.has(description.relation.fieldId)) delete description.relation;
        return description;
      }) })), operations };
}
export function parseDatasetRevision(value: unknown): DatasetRevision {
  const row = record(parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES), ["datasetId", "revision", "revisionSha256", "definitionSha256", "schemaSha256", "operationsSha256", "definition"]);
  const result: DatasetRevision = { datasetId: uuid(row.datasetId), revision: revision(row.revision), revisionSha256: digest(row.revisionSha256),
    definitionSha256: digest(row.definitionSha256), schemaSha256: digest(row.schemaSha256), operationsSha256: digest(row.operationsSha256), definition: definition(row.definition) };
  if (result.datasetId !== result.definition.datasetId) fail();
  return result;
}
/** Syntax validation only. A reference is not an owner approval or an invocation grant. */
export function parseDatasetBindingReference(value: unknown): AppDatasetBinding {
  const row = record(parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES), ["kind", "datasetId", "revision", "revisionSha256", "operationIds"], ["createFields", "linkReads"]);
  if (row.kind !== "dataset") fail();
  const result: AppDatasetBinding = { kind: "dataset", datasetId: uuid(row.datasetId), revision: revision(row.revision), revisionSha256: digest(row.revisionSha256),
    operationIds: boundedArray(row.operationIds, DATASET_MAX_OPERATIONS, 1).map(uuid) };
  unique(result.operationIds);
  if (Object.hasOwn(row, "linkReads")) {
    result.linkReads = boundedArray(row.linkReads, DATASET_MAX_OPERATIONS).map(value => {
      const entry = record(value, ["operationId", "fieldIds"]);
      const read = { operationId: uuid(entry.operationId), fieldIds: boundedArray(entry.fieldIds, DATASET_MAX_FIELDS).map(uuid).sort() };
      if (!result.operationIds.includes(read.operationId)) fail();
      unique(read.fieldIds);
      return read;
    }).sort((a, b) => a.operationId.localeCompare(b.operationId));
    unique(result.linkReads.map(read => read.operationId));
  }
  if (Object.hasOwn(row, "createFields")) {
    result.createFields = boundedArray(row.createFields, DATASET_MAX_OPERATIONS, 1).map(value => {
      const entry = record(value, ["operationId", "fieldIds"]);
      const restriction = { operationId: uuid(entry.operationId), fieldIds: boundedArray(entry.fieldIds, DATASET_MAX_FIELDS).map(uuid).sort() };
      if (!result.operationIds.includes(restriction.operationId)) fail();
      unique(restriction.fieldIds); return restriction;
    }).sort((a,b) => a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0);
    unique(result.createFields.map(entry => entry.operationId));
  }
  return result;
}
/** Parse transport metadata. The host must verify it against its approved catalog. */
export function parseAppDatasetCapability(value: unknown): AppDatasetCapability {
  const row = record(parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES), ["kind", "datasetId", "revision", "revisionSha256", "operationIds", "operations"], ["createFields", "linkReads"]);
  const { operations: values, ...reference } = row;
  const binding = parseDatasetBindingReference(reference);
  const operations = boundedArray(values, DATASET_MAX_OPERATIONS, 1).map(value => {
    const item = record(value, ["operationId", "name", "access", "readOnly"], ["fields"]);
    const name = text(item.name, 64);
    if (!operationNames.test(name) || name.split(".").some(part => forbidden.has(part)) || !["link", "helper", "owner"].includes(item.access as string)) fail();
    const fields = item.fields === undefined ? undefined : boundedArray(item.fields, DATASET_MAX_FIELDS).map(value => {
      const field = record(value, ["fieldId", "name"]);
      return { fieldId: uuid(field.fieldId), name: text(field.name) };
    });
    return { operationId: uuid(item.operationId), name, access: item.access as DatasetOperation["access"], readOnly: boolean(item.readOnly), ...(fields ? { fields } : {}) };
  }).sort((a, b) => a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0);
  unique(operations.map(operation => operation.operationId));
  unique(operations.map(operation => operation.name));
  if (operations.length !== binding.operationIds.length || operations.some(operation => !binding.operationIds.includes(operation.operationId))) fail();
  return { ...binding, operationIds: [...binding.operationIds].sort(), operations };
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

/** Compare host-approved revisions without widening any executable or access contract. */
export function datasetRevisionsPreserveAccess(previous: DatasetRevision, current: DatasetRevision): boolean {
  if (previous.datasetId !== current.datasetId || previous.schemaSha256 !== current.schemaSha256 || previous.operationsSha256 !== current.operationsSha256) return false;
  const contract = (revision: DatasetRevision) => {
    const definition = parseDatasetDefinition(revision.definition);
    definition.name = "Display name";
    definition.schemaPath = "schema.sql";
    definition.operationsPath = "operations.js";
    for (const table of definition.tables) {
      table.name = table.tableId;
      // No operation reads or writes a button, so buttons do not change access.
      table.fields = datasetColumnFields(table);
      for (const field of table.fields) field.name = field.fieldId;
    }
    return datasetDefinitionDigestContent(definition);
  };
  return contract(previous) === contract(current);
}
