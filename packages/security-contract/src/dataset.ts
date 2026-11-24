import { validateUserWritePath } from "@dohc/workspace-core";
import { classifyEngineFilePath } from "./enginePathFloor";
import { parseAppBackendJson, type AppBackendJson } from "./appBackend";
import { uuidv5 } from "./uuidv5";

export const DATASET_DESCRIPTOR_FILENAME = "dataset.json";
export const DATASET_METADATA_MAX_BYTES = 256 * 1024;
export const DATASET_MAX_TABLES = 64;
export const DATASET_MAX_FIELDS = 128;
export const DATASET_MAX_OPERATIONS = 128;
export const APP_DATASET_MAX_BINDINGS = 16;

export { parseDatasetPath } from "@dohc/workspace-contracts/dataset-path";
import { parseDatasetPath } from "@dohc/workspace-contracts/dataset-path";

export type DatasetColumnFieldType =
  | "text"
  | "number"
  | "checkbox"
  | "date"
  | "select"
  | "multi-select"
  | "url"
  | "relation"
  | "attachment";
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
  /** Set by the source generator for its internal record identity. */
  generated?: "record-id";
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
  /**
   * An action's reverse: the name of another action, or this one, in the same
   * dataset. The action returns `{ undo }`, and Undo runs the reverse action
   * with that value as its input. The host refuses to commit a result
   * without a valid `undo` of at most DATASET_UNDO_BYTES.
   */
  reversedBy?: string;
}
/** The largest `undo` value a reversible action may return. */
export const DATASET_UNDO_BYTES = 16 * 1024;
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
/** The approved schema locates the Collection; a generated revision directory does not move it. */
export function datasetBaseFolder({ schemaPath }: Pick<DatasetDefinition, "schemaPath">): string {
  const slash = schemaPath.lastIndexOf("/");
  const folder = slash === -1 ? "" : schemaPath.slice(0, slash);
  const revision = /(?:^|\/)revisions\/[1-9][0-9]*-([^/]+)$/.exec(folder);
  return (revision && ids.test(revision[1]!) ? folder.slice(0, revision.index) : folder) || ".";
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
/**
 * What Review app says an operation does, read from the approved revision: its kind, its label,
 * and the names of the fields it reads or writes. Hosts add it only to what they show.
 * Candidates, digests, and approvals never hold it.
 */
export interface AppDatasetOperationDisplay {
  kind: DatasetOperationKind;
  label: string;
  fields: string[];
  table?: string;
}
/** Public dispatch metadata, derived from the approved revision rather than app source. */
export interface AppDatasetCapability extends AppDatasetBinding {
  alias?: string;
  name: string;
  operations: Array<
    Pick<DatasetOperation, "operationId" | "name" | "access" | "readOnly"> & {
      fields?: Array<{ fieldId: string; name: string }>;
      display?: AppDatasetOperationDisplay;
    }
  >;
}
/** Grant-filtered metadata for Collection controls and agent discovery. */
export interface DatasetDescription {
  /** Present on owner lifecycle discovery; archived data cannot run actions. */
  archived?: boolean;
  datasetId: string;
  name: string;
  revision: number;
  revisionSha256: string;
  tables: Array<{
    tableId: string;
    name: string;
    primaryKeyFieldId?: string;
    fields: DatasetDescribedField[];
  }>;
  operations: DatasetOperation[];
}

const ids = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sqlNames = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const operationNames = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const datasetAliases = /^[a-z][a-z0-9_-]{0,63}$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const fieldTypes = new Set<DatasetColumnFieldType>([
  "text",
  "number",
  "checkbox",
  "date",
  "select",
  "multi-select",
  "url",
  "relation",
  "attachment",
]);
const operationKinds = new Set<DatasetOperationKind>([
  "read",
  "create",
  "edit",
  "delete",
  "action",
]);
const encoder = new TextEncoder();

function fail(reason?: string): never {
  throw new Error(reason ? `Invalid dataset metadata: ${reason}` : "Invalid dataset metadata.");
}
function safeKey(key: string): string {
  return JSON.stringify(key.slice(0, 64).replace(/[\u0000-\u001f\u007f]/gu, ""));
}
function record(
  value: unknown,
  required: string[],
  optional: string[] = [],
  path = "dataset",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${path} must be a JSON object.`);
  const row = value as Record<string, unknown>;
  const missing = required.filter((key) => !Object.hasOwn(row, key));
  if (missing.length > 0) fail(`${path} is missing required field(s): ${missing.join(", ")}.`);
  const unknown = Object.keys(row).filter(
    (key) => !required.includes(key) && !optional.includes(key),
  );
  if (unknown.length > 0)
    fail(
      `${path} has unknown field(s): ${unknown.map(safeKey).join(", ")}. Allowed fields: ${[...required, ...optional].join(", ")}.`,
    );
  return row;
}
function boundedArray(value: unknown, maximum: number, minimum = 0, path = "array"): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array.`);
  if (value.length < minimum) fail(`${path} must contain at least ${minimum} item(s).`);
  if (value.length > maximum) fail(`${path} must contain at most ${maximum} item(s).`);
  return value;
}
function text(value: unknown, maximum = 128, path = "field"): string {
  if (typeof value !== "string") fail(`${path} must be a string.`);
  if (!value.trim()) fail(`${path} must not be empty.`);
  if (value !== value.trim()) fail(`${path} must not have leading or trailing whitespace.`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail(`${path} must not contain control characters.`);
  if (encoder.encode(value).byteLength > maximum)
    fail(`${path} exceeds the ${maximum}-byte limit.`);
  return value;
}
function uuid(value: unknown, path = "id"): string {
  if (typeof value !== "string" || value.length !== 36 || !ids.test(value))
    fail(`${path} must be a lowercase UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).`);
  return value;
}
function sqlName(value: unknown, path = "sqlName"): string {
  const result = text(value, 64, path);
  if (
    !sqlNames.test(result) ||
    forbidden.has(result.toLowerCase()) ||
    /^(sqlite_|dohc_)/i.test(result)
  )
    fail(
      `${path} must be a SQL identifier (1-64 ASCII letters, digits, or underscores, not starting with a digit, sqlite_, or dohc_).`,
    );
  return result;
}
function boolean(value: unknown, path = "field"): boolean {
  if (typeof value !== "boolean") fail(`${path} must be true or false.`);
  return value;
}
function digest(value: unknown, path = "digest"): string {
  if (typeof value !== "string" || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value))
    fail(`${path} must be a 64-character lowercase hex SHA-256 digest.`);
  return value;
}
function revision(value: unknown, path = "revision"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail(`${path} must be a positive integer (>= 1).`);
  return value;
}
function sourcePath(value: unknown, extensions: readonly string[], path = "path"): string {
  const result = text(value, 1024, path);
  const checked = validateUserWritePath(result);
  if (
    !checked.ok ||
    checked.normalized !== result ||
    !extensions.some((extension) => result.endsWith(extension)) ||
    classifyEngineFilePath(result).kind !== "tracked"
  )
    fail(
      `${path} must be a normalized workspace-relative tracked path ending in ${extensions.join(" or ")} (no leading /, .., or .dohc/).`,
    );
  return result;
}
function unique(values: string[], path = "dataset", label = "values"): void {
  if (new Set(values).size !== values.length) fail(`${path} contains duplicate ${label}.`);
}
function date(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function isDatasetColumnField<Field extends { type: DatasetFieldType }>(
  field: Field,
): field is Exclude<Field, DatasetButtonField> {
  return field.type !== "button";
}
/** The fields a table stores: what SQL, CSV, copies, and operations read. */
export function datasetColumnFields<Field extends { type: DatasetFieldType }>(table: {
  fields: readonly Field[];
}): Array<Exclude<Field, DatasetButtonField>> {
  return table.fields.filter(isDatasetColumnField);
}
function validDefault(field: DatasetColumnField, value: AppBackendJson): boolean {
  if (value === null) return !field.required;
  switch (field.type) {
    case "text":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "checkbox":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && date(value);
    case "url": {
      if (typeof value !== "string" || value.trim() !== value || /\s/u.test(value)) return false;
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }
    case "select":
      return typeof value === "string" && field.options!.includes(value);
    case "multi-select":
      return (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "string" && field.options!.includes(entry)) &&
        new Set(value).size === value.length
      );
    // Attachment ownership and referenced records require host validation at write time.
    case "attachment":
      return false;
    case "relation":
      return field.relation?.many !== false && Array.isArray(value) && value.length === 0;
  }
}
function button(value: unknown, path = "field"): DatasetButtonField {
  const row = record(value, ["fieldId", "name", "type"], [], path);
  if (row.type !== "button") fail(`${path}.type must be "button".`);
  return {
    fieldId: uuid(row.fieldId, `${path}.fieldId`),
    name: text(row.name, 128, `${path}.name`),
    type: "button",
  };
}
function isButtonRow(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "button"
  );
}
function field(value: unknown, path = "field"): DatasetField {
  return isButtonRow(value) ? button(value, path) : columnField(value, false, path);
}
function columnField(
  value: unknown,
  allowWithheldRelation = false,
  path = "field",
): DatasetColumnField {
  const row = record(
    value,
    ["fieldId", "name", "sqlColumn", "type", "required", "unique"],
    ["default", "options", "relation", "generated"],
    path,
  );
  if (!fieldTypes.has(row.type as DatasetColumnFieldType))
    fail(
      `${path}.type must be one of: text, number, checkbox, date, select, multi-select, url, relation, attachment, button.`,
    );
  const result: DatasetColumnField = {
    fieldId: uuid(row.fieldId, `${path}.fieldId`),
    name: text(row.name, 128, `${path}.name`),
    sqlColumn: sqlName(row.sqlColumn, `${path}.sqlColumn`),
    type: row.type as DatasetColumnFieldType,
    required: boolean(row.required, `${path}.required`),
    unique: boolean(row.unique, `${path}.unique`),
  };
  if (Object.hasOwn(row, "generated")) {
    if (
      row.generated !== "record-id" ||
      result.type !== "text" ||
      !result.required ||
      !result.unique ||
      Object.hasOwn(row, "default")
    )
      fail(
        `${path}.generated only supports "record-id" on a required, unique text field without a default.`,
      );
    result.generated = "record-id";
  }
  if (result.type === "select" || result.type === "multi-select") {
    result.options = boundedArray(row.options, 100, 1, `${path}.options`).map((entry, index) =>
      text(entry, 200, `${path}.options[${index}]`),
    );
    unique(result.options, `${path}.options`, "options");
  } else if (Object.hasOwn(row, "options"))
    fail(`${path}.options is only allowed on select or multi-select fields.`);
  if (result.type === "relation" && (!allowWithheldRelation || Object.hasOwn(row, "relation"))) {
    const relation = record(
      row.relation,
      ["datasetId", "tableId", "fieldId", "many"],
      [],
      `${path}.relation`,
    );
    result.relation = {
      datasetId: uuid(relation.datasetId, `${path}.relation.datasetId`),
      tableId: uuid(relation.tableId, `${path}.relation.tableId`),
      fieldId: uuid(relation.fieldId, `${path}.relation.fieldId`),
      many: boolean(relation.many, `${path}.relation.many`),
    };
  } else if (result.type !== "relation" && Object.hasOwn(row, "relation"))
    fail(`${path}.relation is only allowed on relation fields.`);
  if (
    result.unique &&
    (result.type === "attachment" || result.type === "multi-select" || result.relation?.many)
  )
    fail(`${path}.unique cannot be true for attachment, multi-select, or many-relation fields.`);
  if (Object.hasOwn(row, "default")) {
    result.default = row.default as AppBackendJson;
    if (!validDefault(result, result.default))
      fail(
        `${path}.default is not a valid default value for type "${result.type}"${result.required ? " (null is disallowed on required fields)" : ""}.`,
      );
  }
  return result;
}
function table(value: unknown, index = 0): DatasetTable {
  const path = `tables[${index}]`;
  const row = record(value, ["tableId", "name", "sqlName", "primaryKey", "fields"], [], path);
  const result: DatasetTable = {
    tableId: uuid(row.tableId, `${path}.tableId`),
    name: text(row.name, 128, `${path}.name`),
    sqlName: sqlName(row.sqlName, `${path}.sqlName`),
    primaryKey: sqlName(row.primaryKey, `${path}.primaryKey`),
    fields: boundedArray(row.fields, DATASET_MAX_FIELDS, 1, `${path}.fields`).map(
      (entry, fieldIndex) => field(entry, `${path}.fields[${fieldIndex}]`),
    ),
  };
  const columns = datasetColumnFields(result);
  unique(
    columns.map((entry) => entry.sqlColumn.toLowerCase()),
    `${path}.fields`,
    "sqlColumn names",
  );
  unique(
    result.fields.map((entry) => entry.name),
    `${path}.fields`,
    "field names",
  );
  const primary = columns.find((entry) => entry.sqlColumn === result.primaryKey);
  if (
    !primary ||
    !["text", "number"].includes(primary.type) ||
    !primary.required ||
    !primary.unique ||
    Object.hasOwn(primary, "default")
  )
    fail(
      `${path}.primaryKey must match a required, unique text or number field's sqlColumn with no default.`,
    );
  if (columns.some((entry) => entry.generated && entry !== primary))
    fail(`${path} only allows generated: "record-id" on the primaryKey field.`);
  return result;
}
function operation(value: unknown, index = 0): DatasetOperation {
  const path = `operations[${index}]`;
  const row = record(
    value,
    ["operationId", "name", "label", "tableId", "kind", "access", "readOnly", "fieldIds"],
    ["reversible", "reversedBy"],
    path,
  );
  const name = text(row.name, 64, `${path}.name`);
  if (!operationNames.test(name) || name.split(".").some((part) => forbidden.has(part)))
    fail(`${path}.name must match [A-Za-z][A-Za-z0-9_.-]{0,63} and must not use reserved names.`);
  const opLabel = `${path} (${name})`;
  if (!operationKinds.has(row.kind as DatasetOperationKind))
    fail(`${opLabel}.kind must be one of: read, create, edit, delete, action.`);
  if (!["link", "helper", "owner"].includes(row.access as string))
    fail(`${opLabel}.access must be one of: link, helper, owner.`);
  const result: DatasetOperation = {
    operationId: uuid(row.operationId, `${opLabel}.operationId`),
    name,
    label: text(row.label, 128, `${opLabel}.label`),
    tableId: uuid(row.tableId, `${opLabel}.tableId`),
    kind: row.kind as DatasetOperationKind,
    access: row.access as DatasetOperation["access"],
    readOnly: boolean(row.readOnly, `${opLabel}.readOnly`),
    fieldIds: boundedArray(row.fieldIds, DATASET_MAX_FIELDS, 0, `${opLabel}.fieldIds`).map(
      (entry, fieldIndex) => uuid(entry, `${opLabel}.fieldIds[${fieldIndex}]`),
    ),
  };
  if (result.kind === "read" && !result.readOnly)
    fail(`${opLabel}: readOnly must be true when kind is "read".`);
  if (["create", "edit", "delete"].includes(result.kind) && result.readOnly)
    fail(`${opLabel}: readOnly must be false when kind is "${result.kind}".`);
  if (result.kind === "delete" && result.fieldIds.length)
    fail(`${opLabel}: fieldIds must be empty ([]) when kind is "delete".`);
  if (Object.hasOwn(row, "reversible")) {
    if (row.reversible !== true || result.kind !== "edit" || result.readOnly)
      fail(`${opLabel}: reversible: true is only allowed on writable "edit" operations.`);
    result.reversible = true;
  }
  if (Object.hasOwn(row, "reversedBy")) {
    const reverse = text(row.reversedBy, 64, `${opLabel}.reversedBy`);
    if (
      result.kind !== "action" ||
      result.readOnly ||
      !operationNames.test(reverse) ||
      reverse.split(".").some((part) => forbidden.has(part))
    )
      fail(
        `${opLabel}.reversedBy is only allowed on writable "action" operations and must name a valid operation.`,
      );
    result.reversedBy = reverse;
  }
  unique(result.fieldIds, `${opLabel}.fieldIds`, "fieldIds");
  return result;
}
function definition(value: unknown): DatasetDefinition {
  const row = record(
    value,
    ["formatVersion", "datasetId", "name", "schemaPath", "operationsPath", "tables", "operations"],
    [],
    "dataset",
  );
  if (row.formatVersion !== 1) fail("dataset.formatVersion must be 1.");
  const result: DatasetDefinition = {
    formatVersion: 1,
    datasetId: uuid(row.datasetId, "dataset.datasetId"),
    name: text(row.name, 128, "dataset.name"),
    schemaPath: sourcePath(row.schemaPath, [".sql"], "dataset.schemaPath"),
    operationsPath: sourcePath(row.operationsPath, [".js", ".ts"], "dataset.operationsPath"),
    tables: boundedArray(row.tables, DATASET_MAX_TABLES, 1, "dataset.tables").map((entry, index) =>
      table(entry, index),
    ),
    operations: boundedArray(row.operations, DATASET_MAX_OPERATIONS, 1, "dataset.operations").map(
      (entry, index) => operation(entry, index),
    ),
  };
  unique(
    [
      result.datasetId,
      ...result.tables.map((entry) => entry.tableId),
      ...result.tables.flatMap((entry) => entry.fields.map((f) => f.fieldId)),
      ...result.operations.map((entry) => entry.operationId),
    ],
    "dataset",
    "UUIDs across datasetId, tableId, fieldId, and operationId",
  );
  unique(
    result.tables.map((entry) => entry.sqlName.toLowerCase()),
    "dataset.tables",
    "sqlName values",
  );
  unique(
    result.tables.map((entry) => entry.name),
    "dataset.tables",
    "table names",
  );
  unique(
    result.operations.map((entry) => entry.name),
    "dataset.operations",
    "operation names",
  );
  const tables = new Map(result.tables.map((entry) => [entry.tableId, entry]));
  for (const [tableIndex, currentTable] of result.tables.entries()) {
    for (const [fieldIndex, currentField] of datasetColumnFields(currentTable).entries()) {
      if (currentField.relation)
        relationTarget(
          tables,
          result.datasetId,
          currentField.relation,
          `tables[${tableIndex}].fields[${fieldIndex}]`,
        );
    }
  }
  for (const [opIndex, currentOp] of result.operations.entries()) {
    const opPath = `operations[${opIndex}] (${currentOp.name})`;
    if (currentOp.reversedBy !== undefined) {
      const reverse = result.operations.find(
        (candidate) => candidate.name === currentOp.reversedBy,
      );
      if (!reverse || reverse.kind !== "action" || reverse.readOnly)
        fail(`${opPath}.reversedBy must name a writable "action" operation in the same dataset.`);
    }
    const currentTable = tables.get(currentOp.tableId);
    if (!currentTable) fail(`${opPath}.tableId does not match any declared table.`);
    const tableColumns = datasetColumnFields(currentTable);
    if (currentOp.fieldIds.some((id) => !tableColumns.some((entry) => entry.fieldId === id)))
      fail(
        `${opPath}.fieldIds references a fieldId that is not a column field on table "${currentTable.name}" (button fields cannot be listed).`,
      );
    if (currentOp.kind === "create") {
      const generatedField = tableColumns.find(
        (entry) => entry.generated && currentOp.fieldIds.includes(entry.fieldId),
      );
      if (generatedField)
        fail(
          `${opPath}.fieldIds must not include generated record-id field "${generatedField.name}" on a "create" operation.`,
        );
    }
    if (currentOp.kind === "edit") {
      const primaryField = tableColumns.find(
        (entry) =>
          entry.sqlColumn === currentTable.primaryKey && currentOp.fieldIds.includes(entry.fieldId),
      );
      if (primaryField)
        fail(
          `${opPath}.fieldIds must not include primaryKey column "${currentTable.primaryKey}" on an "edit" operation.`,
        );
    }
  }
  return result;
}
function relationTarget(
  tables: ReadonlyMap<
    string,
    {
      fields: ReadonlyArray<{
        fieldId: string;
        type: DatasetFieldType;
        unique?: boolean;
        required?: boolean;
      }>;
    }
  >,
  datasetId: string,
  relation: DatasetRelation,
  path = "field",
): void {
  if (relation.datasetId !== datasetId)
    fail(`${path}.relation.datasetId must match this dataset's datasetId.`);
  const target = tables
    .get(relation.tableId)
    ?.fields.find((candidate) => candidate.fieldId === relation.fieldId);
  if (
    !target ||
    target.type === "button" ||
    !target.unique ||
    !target.required ||
    !["text", "number"].includes(target.type)
  )
    fail(
      `${path}.relation must target a required, unique text or number column field in the same dataset.`,
    );
}

export interface DatasetDefinitionOptions {
  /** Workspace-relative path of the dataset.json or revision.json file being read. */
  readonly descriptorPath?: string;
}

function relativeDatasetPath(value: unknown, baseDir: string): string {
  const raw = text(value, 1024);
  if (raw.startsWith("/") || raw.includes("\\")) fail();
  const segments = raw.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) fail();
  return baseDir ? `${baseDir}/${raw}` : raw;
}

function descriptorBaseDir(descriptorPath: string | undefined): string {
  if (descriptorPath === undefined) return "";
  if (descriptorPath.startsWith("/") || descriptorPath.includes("\\")) fail();
  const segments = descriptorPath.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) fail();
  return segments.slice(0, -1).join("/");
}

function validOperationName(value: unknown): string {
  const name = text(value, 64);
  if (!operationNames.test(name) || name.split(".").some((part) => forbidden.has(part))) fail();
  return name;
}

function normalizeV2Definition(
  row: Record<string, unknown>,
  options?: DatasetDefinitionOptions,
): DatasetDefinition {
  const top = record(
    row,
    ["formatVersion", "datasetId", "name", "tables", "operations"],
    ["schemaPath", "operationsPath"],
  );
  if (top.formatVersion !== 2) fail();
  const datasetId = uuid(top.datasetId);
  const baseDir = descriptorBaseDir(options?.descriptorPath);
  const schemaPath = relativeDatasetPath(
    Object.hasOwn(top, "schemaPath") ? top.schemaPath : "schema.sql",
    baseDir,
  );
  if (
    options?.descriptorPath !== undefined &&
    datasetBaseFolder({ schemaPath }) !== (baseDir || ".")
  ) {
    fail();
  }
  const operationsPath = relativeDatasetPath(
    Object.hasOwn(top, "operationsPath") ? top.operationsPath : "operations.js",
    baseDir,
  );

  interface PendingRelation {
    readonly tableIndex: number;
    readonly fieldIndex: number;
    readonly raw: unknown;
  }
  const pendingRelations: PendingRelation[] = [];
  const rawTables = boundedArray(top.tables, DATASET_MAX_TABLES, 1);
  const tables: DatasetTable[] = rawTables.map((entry, tableIndex) => {
    const tableRow = record(entry, ["sqlName", "primaryKey", "fields"], ["tableId", "name"]);
    const tableSqlName = sqlName(tableRow.sqlName);
    const tableKey = tableSqlName.toLowerCase();
    const tableId = Object.hasOwn(tableRow, "tableId")
      ? uuid(tableRow.tableId)
      : uuidv5(datasetId, `table:${tableKey}`);
    const primaryKey = sqlName(tableRow.primaryKey);
    const tableName = Object.hasOwn(tableRow, "name") ? text(tableRow.name) : tableSqlName;
    const rawFields = boundedArray(tableRow.fields, DATASET_MAX_FIELDS, 1);
    const fields: DatasetField[] = rawFields.map((fieldEntry, fieldIndex) => {
      if (isButtonRow(fieldEntry)) {
        const btn = record(fieldEntry, ["name", "type"], ["fieldId"]);
        if (btn.type !== "button") fail();
        const buttonName = text(btn.name);
        return {
          fieldId: Object.hasOwn(btn, "fieldId")
            ? uuid(btn.fieldId)
            : uuidv5(datasetId, `button:${tableKey}:${buttonName}`),
          name: buttonName,
          type: "button",
        };
      }
      const col = record(
        fieldEntry,
        ["sqlColumn", "type"],
        ["fieldId", "name", "required", "unique", "default", "options", "relation", "generated"],
      );
      if (!fieldTypes.has(col.type as DatasetColumnFieldType)) fail();
      const columnName = sqlName(col.sqlColumn);
      const isPk = columnName === primaryKey;
      const normalized: DatasetColumnField = {
        fieldId: Object.hasOwn(col, "fieldId")
          ? uuid(col.fieldId)
          : uuidv5(datasetId, `field:${tableKey}:${columnName.toLowerCase()}`),
        name: Object.hasOwn(col, "name") ? text(col.name) : columnName,
        sqlColumn: columnName,
        type: col.type as DatasetColumnFieldType,
        required: Object.hasOwn(col, "required") ? boolean(col.required) : isPk,
        unique: Object.hasOwn(col, "unique") ? boolean(col.unique) : isPk,
      };
      if (Object.hasOwn(col, "generated")) normalized.generated = col.generated as "record-id";
      if (Object.hasOwn(col, "options")) normalized.options = col.options as string[];
      if (Object.hasOwn(col, "default")) normalized.default = col.default as AppBackendJson;
      if (Object.hasOwn(col, "relation")) {
        pendingRelations.push({ tableIndex, fieldIndex, raw: col.relation });
      }
      return normalized;
    });
    return {
      tableId,
      name: tableName,
      sqlName: tableSqlName,
      primaryKey,
      fields,
    };
  });

  const tablesBySql = new Map<string, DatasetTable>();
  for (const entry of tables) {
    if (tablesBySql.has(entry.sqlName)) fail();
    tablesBySql.set(entry.sqlName, entry);
  }
  const tablesById = new Map<string, DatasetTable>(tables.map((entry) => [entry.tableId, entry]));

  for (const pending of pendingRelations) {
    const field = tables[pending.tableIndex]!.fields[pending.fieldIndex]!;
    if (field.type === "button") fail();
    if (
      pending.raw !== null &&
      typeof pending.raw === "object" &&
      !Array.isArray(pending.raw) &&
      Object.hasOwn(pending.raw, "table")
    ) {
      const rel = record(pending.raw, ["table", "field"], ["many"]);
      const targetTable = tablesBySql.get(sqlName(rel.table));
      if (!targetTable) fail();
      const targetCol = sqlName(rel.field);
      const targetField = datasetColumnFields(targetTable).find(
        (candidate) => candidate.sqlColumn === targetCol,
      );
      if (!targetField) fail();
      field.relation = {
        datasetId,
        tableId: targetTable.tableId,
        fieldId: targetField.fieldId,
        many: Object.hasOwn(rel, "many") ? boolean(rel.many) : false,
      };
    } else {
      field.relation = pending.raw as DatasetRelation;
    }
  }

  const rawOperations = boundedArray(top.operations, DATASET_MAX_OPERATIONS, 1);
  const operations: DatasetOperation[] = rawOperations.map((entry) => {
    const opRow = record(
      entry,
      ["name", "kind"],
      [
        "operationId",
        "label",
        "table",
        "tableId",
        "access",
        "readOnly",
        "fields",
        "fieldIds",
        "reversible",
        "reversedBy",
      ],
    );
    const hasTable = Object.hasOwn(opRow, "table");
    const hasTableId = Object.hasOwn(opRow, "tableId");
    if (hasTable === hasTableId) fail();
    const hasFields = Object.hasOwn(opRow, "fields");
    const hasFieldIds = Object.hasOwn(opRow, "fieldIds");
    if (hasFields && hasFieldIds) fail();

    const opName = validOperationName(opRow.name);
    const resolvedTable = hasTable
      ? tablesBySql.get(sqlName(opRow.table))
      : tablesById.get(uuid(opRow.tableId));
    if (!resolvedTable) fail();

    let fieldIds: string[];
    if (hasFields) {
      const cols = datasetColumnFields(resolvedTable);
      fieldIds = boundedArray(opRow.fields, DATASET_MAX_FIELDS).map((token) => {
        const colName = sqlName(token);
        const matched = cols.find((candidate) => candidate.sqlColumn === colName);
        if (!matched) fail();
        return matched.fieldId;
      });
    } else if (hasFieldIds) {
      fieldIds = boundedArray(opRow.fieldIds, DATASET_MAX_FIELDS).map((entry) => uuid(entry));
    } else {
      fieldIds = [];
    }

    const normalized: DatasetOperation = {
      operationId: Object.hasOwn(opRow, "operationId")
        ? uuid(opRow.operationId)
        : uuidv5(datasetId, `op:${opName}`),
      name: opName,
      label: Object.hasOwn(opRow, "label") ? text(opRow.label) : opName,
      tableId: resolvedTable.tableId,
      kind: opRow.kind as DatasetOperationKind,
      access: Object.hasOwn(opRow, "access")
        ? (opRow.access as DatasetOperation["access"])
        : "owner",
      readOnly: Object.hasOwn(opRow, "readOnly") ? boolean(opRow.readOnly) : opRow.kind === "read",
      fieldIds,
    };
    if (Object.hasOwn(opRow, "reversible")) normalized.reversible = opRow.reversible as true;
    if (Object.hasOwn(opRow, "reversedBy")) normalized.reversedBy = opRow.reversedBy as string;
    return normalized;
  });

  const canonical = definition({
    formatVersion: 1,
    datasetId,
    name: text(top.name),
    schemaPath,
    operationsPath,
    tables,
    operations,
  });
  const canonicalBytes = encoder.encode(JSON.stringify(canonical)).byteLength;
  if (canonicalBytes > DATASET_METADATA_MAX_BYTES) {
    throw new Error(
      `Normalized Collection definition is ${canonicalBytes} bytes, exceeding the ${DATASET_METADATA_MAX_BYTES} byte limit.`,
    );
  }
  return canonical;
}

export function parseDatasetDefinition(
  value: unknown,
  options?: DatasetDefinitionOptions,
): DatasetDefinition {
  const bounded = parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES);
  if (
    bounded !== null &&
    typeof bounded === "object" &&
    !Array.isArray(bounded) &&
    (bounded as Record<string, unknown>).formatVersion === 2
  ) {
    return normalizeV2Definition(bounded as Record<string, unknown>, options);
  }
  return definition(bounded);
}

export function parseDatasetDescription(value: unknown): DatasetDescription {
  const row = record(
    parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES),
    ["datasetId", "name", "revision", "revisionSha256", "tables", "operations"],
    ["archived"],
    "description",
  );
  if (row.archived !== undefined && typeof row.archived !== "boolean")
    fail("description.archived must be true or false.");
  const result: DatasetDescription = {
    ...(row.archived === undefined ? {} : { archived: row.archived }),
    datasetId: uuid(row.datasetId, "description.datasetId"),
    name: text(row.name, 128, "description.name"),
    revision: revision(row.revision, "description.revision"),
    revisionSha256: digest(row.revisionSha256, "description.revisionSha256"),
    tables: boundedArray(row.tables, DATASET_MAX_TABLES, 0, "description.tables").map(
      (entry, tableIndex) => {
        const tablePath = `description.tables[${tableIndex}]`;
        const currentTable = record(
          entry,
          ["tableId", "name", "fields"],
          ["primaryKeyFieldId"],
          tablePath,
        );
        const fields = boundedArray(
          currentTable.fields,
          DATASET_MAX_FIELDS,
          0,
          `${tablePath}.fields`,
        ).map((item, fieldIndex): DatasetDescribedField => {
          const fieldPath = `${tablePath}.fields[${fieldIndex}]`;
          if (isButtonRow(item)) return button(item, fieldPath);
          const metadata = record(
            item,
            ["fieldId", "name", "type", "required", "unique"],
            ["default", "options", "relation", "generated"],
            fieldPath,
          );
          const { sqlColumn: _column, ...parsed } = columnField(
            { ...metadata, sqlColumn: "field" },
            true,
            fieldPath,
          );
          return parsed;
        });
        unique(
          fields.map((entry) => entry.name),
          `${tablePath}.fields`,
          "field names",
        );
        const primaryKeyFieldId =
          currentTable.primaryKeyFieldId === undefined
            ? undefined
            : uuid(currentTable.primaryKeyFieldId, `${tablePath}.primaryKeyFieldId`);
        if (
          primaryKeyFieldId !== undefined &&
          !fields.some(
            (entry) =>
              entry.fieldId === primaryKeyFieldId &&
              entry.type !== "button" &&
              entry.required &&
              entry.unique,
          )
        )
          fail(`${tablePath}.primaryKeyFieldId must match a required, unique column field.`);
        if (
          fields.some(
            (entry) =>
              entry.type !== "button" && entry.generated && entry.fieldId !== primaryKeyFieldId,
          )
        )
          fail(`${tablePath} only allows generated: "record-id" on the primaryKeyFieldId field.`);
        return {
          tableId: uuid(currentTable.tableId, `${tablePath}.tableId`),
          name: text(currentTable.name, 128, `${tablePath}.name`),
          fields,
          ...(primaryKeyFieldId === undefined ? {} : { primaryKeyFieldId }),
        };
      },
    ),
    operations: boundedArray(
      row.operations,
      DATASET_MAX_OPERATIONS,
      0,
      "description.operations",
    ).map((entry, index) => operation(entry, index)),
  };
  unique(
    [
      result.datasetId,
      ...result.tables.map((entry) => entry.tableId),
      ...result.tables.flatMap((entry) => entry.fields.map((f) => f.fieldId)),
      ...result.operations.map((entry) => entry.operationId),
    ],
    "description",
    "UUIDs",
  );
  unique(
    result.tables.map((entry) => entry.name),
    "description.tables",
    "table names",
  );
  unique(
    result.operations.map((entry) => entry.name),
    "description.operations",
    "operation names",
  );
  const tables = new Map(result.tables.map((entry) => [entry.tableId, entry]));
  for (const [opIndex, currentOp] of result.operations.entries()) {
    const currentTable = tables.get(currentOp.tableId);
    if (
      !currentTable ||
      currentOp.fieldIds.some(
        (id) => !datasetColumnFields(currentTable).some((entry) => entry.fieldId === id),
      )
    )
      fail(
        `description.operations[${opIndex}] (${currentOp.name}) references an unknown tableId or non-column fieldId.`,
      );
  }
  for (const [tableIndex, currentTable] of result.tables.entries()) {
    const archivedMetadata = result.archived === true && result.operations.length === 0;
    if (
      !archivedMetadata &&
      !result.operations.some((entry) => entry.tableId === currentTable.tableId)
    )
      fail(`description.tables[${tableIndex}] is not referenced by any described operation.`);
    for (const currentField of datasetColumnFields(currentTable)) {
      if (
        !archivedMetadata &&
        !result.operations.some(
          (entry) =>
            entry.tableId === currentTable.tableId && entry.fieldIds.includes(currentField.fieldId),
        )
      )
        fail(
          `description.tables[${tableIndex}] field "${currentField.name}" is not referenced by any described operation.`,
        );
      if (currentField.relation)
        relationTarget(
          tables,
          result.datasetId,
          currentField.relation,
          `description.tables[${tableIndex}]`,
        );
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
export function describeApprovedDataset(
  approved: DatasetRevision,
  operations: DatasetOperation[],
): DatasetDescription {
  const fields = new Set(operations.flatMap((operation) => operation.fieldIds));
  const tables = new Set(operations.map((operation) => operation.tableId));
  return {
    datasetId: approved.datasetId,
    name: approved.definition.name,
    revision: approved.revision,
    revisionSha256: approved.revisionSha256,
    tables: approved.definition.tables
      .filter((table) => tables.has(table.tableId))
      .map((table) => {
        const primary = datasetColumnFields(table).find(
          (field) => field.sqlColumn === table.primaryKey && fields.has(field.fieldId),
        );
        return {
          tableId: table.tableId,
          name: table.name,
          ...(primary ? { primaryKeyFieldId: primary.fieldId } : {}),
          fields: table.fields
            .filter((field) => field.type === "button" || fields.has(field.fieldId))
            .map((field): DatasetDescribedField => {
              if (field.type === "button")
                return { fieldId: field.fieldId, name: field.name, type: "button" };
              const { sqlColumn: _sqlColumn, ...description } = field;
              if (description.relation && !fields.has(description.relation.fieldId))
                delete description.relation;
              return description;
            }),
        };
      }),
    operations,
  };
}
export function parseDatasetRevision(value: unknown): DatasetRevision {
  const row = record(
    parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES),
    [
      "datasetId",
      "revision",
      "revisionSha256",
      "definitionSha256",
      "schemaSha256",
      "operationsSha256",
      "definition",
    ],
    [],
    "revision",
  );
  const result: DatasetRevision = {
    datasetId: uuid(row.datasetId, "revision.datasetId"),
    revision: revision(row.revision, "revision.revision"),
    revisionSha256: digest(row.revisionSha256, "revision.revisionSha256"),
    definitionSha256: digest(row.definitionSha256, "revision.definitionSha256"),
    schemaSha256: digest(row.schemaSha256, "revision.schemaSha256"),
    operationsSha256: digest(row.operationsSha256, "revision.operationsSha256"),
    definition: definition(row.definition),
  };
  if (result.datasetId !== result.definition.datasetId)
    fail("revision.datasetId must match revision.definition.datasetId.");
  return result;
}
/** Syntax validation only. A reference is not an owner approval or an invocation grant. */
export function parseDatasetBindingReference(value: unknown): AppDatasetBinding {
  const row = record(
    parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES),
    ["kind", "datasetId", "revision", "revisionSha256", "operationIds"],
    ["createFields", "linkReads"],
    "dataset",
  );
  if (row.kind !== "dataset") fail('dataset.kind must be "dataset".');
  return { ...parseBindingFields(row), datasetId: uuid(row.datasetId, "dataset.datasetId") };
}

export interface AppDatasetNamedCreateFields {
  operation: string;
  fields: string[];
}
export type AppDatasetReference =
  | {
      kind: "dataset";
      datasetPath: string;
      revision?: number;
      revisionSha256?: string;
      operationIds: string[];
      createFields?: Array<{ operationId: string; fieldIds: string[] }>;
      linkReads?: Array<{ operationId: string; fieldIds: string[] }>;
    }
  | {
      kind: "dataset";
      datasetPath: string;
      revision?: number;
      revisionSha256?: string;
      operations: string[];
      createFields?: AppDatasetNamedCreateFields[];
    };
export type AppDatasetRevisionLookup = Pick<AppDatasetBinding, "datasetId"> &
  Partial<Omit<AppDatasetBinding, "datasetId">>;

export function parseAppDatasetReference(value: unknown): AppDatasetReference {
  const row = record(
    parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES),
    ["kind", "datasetPath"],
    ["revision", "revisionSha256", "operationIds", "operations", "createFields", "linkReads"],
    "dataset",
  );
  if (row.kind !== "dataset") fail('dataset.kind must be "dataset".');
  const datasetPath = parseDatasetPath(row.datasetPath);
  const hasRev = Object.hasOwn(row, "revision");
  const hasSha = Object.hasOwn(row, "revisionSha256");
  if (hasRev !== hasSha)
    fail("dataset.revision and dataset.revisionSha256 must be provided together.");
  const pin = hasRev
    ? {
        revision: revision(row.revision, "dataset.revision"),
        revisionSha256: digest(row.revisionSha256, "dataset.revisionSha256"),
      }
    : {};
  const hasIds = Object.hasOwn(row, "operationIds");
  const hasNames = Object.hasOwn(row, "operations");
  if (hasIds === hasNames) fail("dataset must specify either operationIds or operations.");

  if (hasIds) {
    const operationIds = boundedArray(
      row.operationIds,
      DATASET_MAX_OPERATIONS,
      1,
      "dataset.operationIds",
    ).map((entry, index) => uuid(entry, `dataset.operationIds[${index}]`));
    unique(operationIds, "dataset.operationIds", "operationIds");
    const result: Extract<AppDatasetReference, { operationIds: string[] }> = {
      kind: "dataset",
      datasetPath,
      ...pin,
      operationIds,
    };
    if (Object.hasOwn(row, "linkReads")) {
      result.linkReads = parseLinkReads(row.linkReads, operationIds);
    }
    if (Object.hasOwn(row, "createFields")) {
      result.createFields = parseCreateFieldsById(row.createFields, operationIds);
    }
    return result;
  }

  if (Object.hasOwn(row, "linkReads"))
    fail("dataset.linkReads requires operationIds rather than named operations.");
  const operations = boundedArray(
    row.operations,
    DATASET_MAX_OPERATIONS,
    1,
    "dataset.operations",
  ).map(validOperationName);
  unique(operations, "dataset.operations", "operations");
  const result: Extract<AppDatasetReference, { operations: string[] }> = {
    kind: "dataset",
    datasetPath,
    ...pin,
    operations,
  };
  if (Object.hasOwn(row, "createFields")) {
    const createFields = boundedArray(
      row.createFields,
      DATASET_MAX_OPERATIONS,
      1,
      "dataset.createFields",
    )
      .map((entry, index) => {
        const entryPath = `dataset.createFields[${index}]`;
        const item = record(entry, ["operation", "fields"], [], entryPath);
        const operation = validOperationName(item.operation);
        if (!operations.includes(operation))
          fail(`${entryPath}.operation must also be listed in dataset.operations.`);
        const fields = boundedArray(item.fields, DATASET_MAX_FIELDS, 0, `${entryPath}.fields`)
          .map((fieldName, fieldIndex) => {
            const val = text(fieldName, 128, `${entryPath}.fields[${fieldIndex}]`);
            if (val === "*") fail(`${entryPath}.fields cannot use "*".`);
            return val;
          })
          .sort();
        unique(fields, `${entryPath}.fields`, "fields");
        return { operation, fields };
      })
      .sort((a, b) => (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0));
    unique(
      createFields.map((entry) => entry.operation),
      "dataset.createFields",
      "operations",
    );
    result.createFields = createFields;
  }
  return result;
}

/** Resolves an app.publish.json dataset declaration into a canonical, pinned AppDatasetBinding. */
export function resolveAppDatasetReferenceBinding(
  reference: AppDatasetReference,
  datasetId: string,
  approvedRevision: DatasetRevision,
): AppDatasetBinding {
  const approved = parseDatasetRevision(approvedRevision);
  if (uuid(datasetId, "datasetId") !== approved.datasetId)
    fail("datasetId does not match the approved revision.");
  if (
    reference.revision !== undefined &&
    (approved.revision !== reference.revision ||
      approved.revisionSha256 !== reference.revisionSha256)
  ) {
    throw new Error(
      "Collection rules changed. Remove revision and revisionSha256 from app.publish.json (or update them) and prepare the app again.",
    );
  }

  if ("operationIds" in reference) {
    return parseDatasetBindingReference({
      kind: "dataset",
      datasetId,
      revision: approved.revision,
      revisionSha256: approved.revisionSha256,
      operationIds: reference.operationIds,
      ...(reference.createFields ? { createFields: reference.createFields } : {}),
      ...(reference.linkReads ? { linkReads: reference.linkReads } : {}),
    });
  }

  const byName = new Map(approved.definition.operations.map((op) => [op.name, op]));
  const operationIds = reference.operations.map((name) => {
    const matched = byName.get(name);
    if (!matched) {
      throw new Error(`Collection "${approved.definition.name}" has no operation named "${name}".`);
    }
    return matched.operationId;
  });

  const createFields = reference.createFields?.map((entry) => {
    const op = byName.get(entry.operation);
    if (!op) {
      throw new Error(
        `Collection "${approved.definition.name}" has no operation named "${entry.operation}".`,
      );
    }
    const opTable = approved.definition.tables.find((table) => table.tableId === op.tableId);
    if (!opTable) fail();
    const columns = datasetColumnFields(opTable);
    const fieldIds = entry.fields.map((token) => {
      const matched = columns.filter((col) => col.sqlColumn === token || col.name === token);
      if (matched.length === 1) return matched[0]!.fieldId;
      if (matched.length > 1) {
        throw new Error(
          `Collection "${approved.definition.name}" table "${opTable.name}" has an ambiguous field name "${token}".`,
        );
      }
      throw new Error(
        `Collection "${approved.definition.name}" table "${opTable.name}" has no field named "${token}".`,
      );
    });
    return { operationId: op.operationId, fieldIds };
  });

  return parseDatasetBindingReference({
    kind: "dataset",
    datasetId,
    revision: approved.revision,
    revisionSha256: approved.revisionSha256,
    operationIds,
    ...(createFields ? { createFields } : {}),
  });
}

function parseLinkReads(
  raw: unknown,
  operationIds: readonly string[],
): Array<{ operationId: string; fieldIds: string[] }> {
  const linkReads = boundedArray(raw, DATASET_MAX_OPERATIONS, 0, "dataset.linkReads")
    .map((entry, index) => {
      const entryPath = `dataset.linkReads[${index}]`;
      const item = record(entry, ["operationId", "fieldIds"], [], entryPath);
      const read = {
        operationId: uuid(item.operationId, `${entryPath}.operationId`),
        fieldIds: boundedArray(item.fieldIds, DATASET_MAX_FIELDS, 0, `${entryPath}.fieldIds`)
          .map((fieldId, fieldIndex) => uuid(fieldId, `${entryPath}.fieldIds[${fieldIndex}]`))
          .sort(),
      };
      if (!operationIds.includes(read.operationId))
        fail(`${entryPath}.operationId must also be listed in dataset.operationIds.`);
      unique(read.fieldIds, `${entryPath}.fieldIds`, "fieldIds");
      return read;
    })
    .sort((a, b) => a.operationId.localeCompare(b.operationId));
  unique(
    linkReads.map((read) => read.operationId),
    "dataset.linkReads",
    "operationIds",
  );
  return linkReads;
}

function parseCreateFieldsById(
  raw: unknown,
  operationIds: readonly string[],
): Array<{ operationId: string; fieldIds: string[] }> {
  const createFields = boundedArray(raw, DATASET_MAX_OPERATIONS, 1, "dataset.createFields")
    .map((entry, index) => {
      const entryPath = `dataset.createFields[${index}]`;
      const item = record(entry, ["operationId", "fieldIds"], [], entryPath);
      const restriction = {
        operationId: uuid(item.operationId, `${entryPath}.operationId`),
        fieldIds: boundedArray(item.fieldIds, DATASET_MAX_FIELDS, 0, `${entryPath}.fieldIds`)
          .map((fieldId, fieldIndex) => uuid(fieldId, `${entryPath}.fieldIds[${fieldIndex}]`))
          .sort(),
      };
      if (!operationIds.includes(restriction.operationId))
        fail(`${entryPath}.operationId must also be listed in dataset.operationIds.`);
      unique(restriction.fieldIds, `${entryPath}.fieldIds`, "fieldIds");
      return restriction;
    })
    .sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
  unique(
    createFields.map((entry) => entry.operationId),
    "dataset.createFields",
    "operationIds",
  );
  return createFields;
}

function parseBindingFields(row: Record<string, unknown>): Omit<AppDatasetBinding, "datasetId"> {
  const result: Omit<AppDatasetBinding, "datasetId"> = {
    kind: "dataset",
    revision: revision(row.revision, "dataset.revision"),
    revisionSha256: digest(row.revisionSha256, "dataset.revisionSha256"),
    operationIds: boundedArray(
      row.operationIds,
      DATASET_MAX_OPERATIONS,
      1,
      "dataset.operationIds",
    ).map((entry, index) => uuid(entry, `dataset.operationIds[${index}]`)),
  };
  unique(result.operationIds, "dataset.operationIds", "operationIds");
  if (Object.hasOwn(row, "linkReads")) {
    result.linkReads = parseLinkReads(row.linkReads, result.operationIds);
  }
  if (Object.hasOwn(row, "createFields")) {
    result.createFields = parseCreateFieldsById(row.createFields, result.operationIds);
  }
  return result;
}
function operationDisplay(value: unknown, path = "display"): AppDatasetOperationDisplay {
  const row = record(value, ["kind", "label", "fields"], ["table"], path);
  if (!operationKinds.has(row.kind as DatasetOperationKind))
    fail(`${path}.kind must be one of: read, create, edit, delete, action.`);
  return {
    kind: row.kind as DatasetOperationKind,
    label: text(row.label, 128, `${path}.label`),
    fields: boundedArray(row.fields, DATASET_MAX_FIELDS, 0, `${path}.fields`).map((entry, index) =>
      text(entry, 128, `${path}.fields[${index}]`),
    ),
    ...(row.table === undefined ? {} : { table: text(row.table, 128, `${path}.table`) }),
  };
}
export function parseDatasetAlias(value: unknown): string {
  const result = text(value, 64);
  if (!datasetAliases.test(result) || forbidden.has(result)) fail();
  return result;
}
/** Parse transport metadata. The host must verify it against its approved catalog. */
export function parseAppDatasetCapability(value: unknown): AppDatasetCapability {
  const row = record(
    parseAppBackendJson(value, DATASET_METADATA_MAX_BYTES),
    ["kind", "datasetId", "revision", "revisionSha256", "operationIds", "operations", "name"],
    ["alias", "createFields", "linkReads"],
    "capability",
  );
  const { operations: values, name, alias, ...reference } = row;
  const parsedAlias = alias === undefined ? undefined : parseDatasetAlias(alias);
  const binding = parseDatasetBindingReference(reference);
  const operations = boundedArray(values, DATASET_MAX_OPERATIONS, 1, "capability.operations")
    .map((entry, index) => {
      const opPath = `capability.operations[${index}]`;
      const item = record(
        entry,
        ["operationId", "name", "access", "readOnly"],
        ["fields", "display"],
        opPath,
      );
      const opName = text(item.name, 64, `${opPath}.name`);
      if (
        !operationNames.test(opName) ||
        opName.split(".").some((part) => forbidden.has(part)) ||
        !["link", "helper", "owner"].includes(item.access as string)
      )
        fail(`${opPath} has an invalid operation name or access level.`);
      const fields =
        item.fields === undefined
          ? undefined
          : boundedArray(item.fields, DATASET_MAX_FIELDS, 0, `${opPath}.fields`).map(
              (fieldEntry, fieldIndex) => {
                const fPath = `${opPath}.fields[${fieldIndex}]`;
                const currentField = record(fieldEntry, ["fieldId", "name"], [], fPath);
                return {
                  fieldId: uuid(currentField.fieldId, `${fPath}.fieldId`),
                  name: text(currentField.name, 128, `${fPath}.name`),
                };
              },
            );
      const display =
        item.display === undefined
          ? undefined
          : operationDisplay(item.display, `${opPath}.display`);
      return {
        operationId: uuid(item.operationId, `${opPath}.operationId`),
        name: opName,
        access: item.access as DatasetOperation["access"],
        readOnly: boolean(item.readOnly, `${opPath}.readOnly`),
        ...(fields ? { fields } : {}),
        ...(display ? { display } : {}),
      };
    })
    .sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
  unique(
    operations.map((entry) => entry.operationId),
    "capability.operations",
    "operationIds",
  );
  unique(
    operations.map((entry) => entry.name),
    "capability.operations",
    "operation names",
  );
  if (
    operations.length !== binding.operationIds.length ||
    operations.some((entry) => !binding.operationIds.includes(entry.operationId))
  )
    fail("capability.operations must match capability.operationIds.");
  return {
    ...binding,
    ...(parsedAlias === undefined ? {} : { alias: parsedAlias }),
    name: text(name, 128, "capability.name"),
    operationIds: [...binding.operationIds].sort(),
    operations,
  };
}

/** Stable inventory ordering and fixed member ordering for definition hashing. */
export function datasetDefinitionDigestContent(value: DatasetDefinition): string {
  const parsed = parseDatasetDefinition(value);
  const byId = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  parsed.tables.sort((left, right) => byId(left.tableId, right.tableId));
  for (const table of parsed.tables)
    table.fields.sort((left, right) => byId(left.fieldId, right.fieldId));
  parsed.operations.sort((left, right) => byId(left.operationId, right.operationId));
  for (const operation of parsed.operations) operation.fieldIds.sort(byId);
  return JSON.stringify(parsed);
}

/** Hash this UTF-8 content when approving/verifying a revision; the digest is not an approval. */
export function datasetRevisionDigestContent(value: DatasetRevision): string {
  const parsed = parseDatasetRevision(value);
  return JSON.stringify({
    datasetId: parsed.datasetId,
    revision: parsed.revision,
    definitionSha256: parsed.definitionSha256,
    schemaSha256: parsed.schemaSha256,
    operationsSha256: parsed.operationsSha256,
  });
}

/** Compare host-approved revisions without widening any executable or access contract. */
export function datasetRevisionsPreserveAccess(
  previous: DatasetRevision,
  current: DatasetRevision,
): boolean {
  if (
    previous.datasetId !== current.datasetId ||
    previous.schemaSha256 !== current.schemaSha256 ||
    previous.operationsSha256 !== current.operationsSha256
  )
    return false;
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
