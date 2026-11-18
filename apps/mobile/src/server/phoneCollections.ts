import { accountOperations, each, isFields, text } from "./api";
import type { ServerClient } from "./client";

// The account operations for a workspace's transactional Collections (the relay's phoneCollections.ts). They only read.

export type CollectionFieldType =
  | "text"
  | "number"
  | "checkbox"
  | "date"
  | "select"
  | "multi-select"
  | "url"
  | "relation"
  | "attachment";

export interface CollectionField {
  readonly fieldId: string;
  readonly name: string;
  readonly type: CollectionFieldType;
}

export interface CollectionTable {
  readonly tableId: string;
  readonly name: string;
  /** The field that names a record, or null when it's one the phone doesn't show. */
  readonly primaryFieldId: string | null;
  readonly fields: readonly CollectionField[];
}

export interface PhoneCollection {
  readonly datasetId: string;
  readonly name: string;
}

export interface CollectionDescription extends PhoneCollection {
  readonly tables: readonly CollectionTable[];
}

export type RecordValue =
  | null
  | boolean
  | number
  | string
  | readonly RecordValue[]
  | { readonly [key: string]: RecordValue };

export type RecordId = string | number;

export interface CollectionRecord {
  readonly id: RecordId;
  readonly values: Readonly<Record<string, RecordValue>>;
}

/** Where the next page starts: the last record's ID and its sort value, as the read gave them. */
export interface RecordCursor {
  readonly id: RecordId;
  readonly value: RecordValue;
}

export type RecordPage =
  | {
      readonly status: "ready";
      readonly rows: readonly CollectionRecord[];
      readonly next: RecordCursor | null;
      /** Attached files' names, by file ID. */
      readonly files: Readonly<Record<string, string>>;
    }
  /** Nothing in the Collection reads this table. */
  | { readonly status: "refused" };

const TYPES: ReadonlySet<string> = new Set<CollectionFieldType>([
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
const PAGE = 50;
/** A list read gives up past this many pages, as failed. */
const LIST_PAGES = 200;

const recordId = (value: unknown): value is RecordId =>
  text(value, 1024) || (typeof value === "number" && Number.isSafeInteger(value));

const readCollection = (item: unknown): PhoneCollection | null =>
  isFields(item) && text(item.datasetId, 64) && text(item.name, 1024)
    ? { datasetId: item.datasetId, name: item.name }
    : null;

const readField = (item: unknown): CollectionField | null =>
  isFields(item) &&
  text(item.fieldId, 64) &&
  text(item.name, 1024) &&
  typeof item.type === "string" &&
  TYPES.has(item.type)
    ? { fieldId: item.fieldId, name: item.name, type: item.type as CollectionFieldType }
    : null;

function readTable(item: unknown): CollectionTable | null {
  if (!isFields(item) || !text(item.tableId, 64) || !text(item.name, 1024)) return null;
  const fields = each(item.fields, readField);
  const primary = item.primaryFieldId;
  if (!fields || (primary !== null && !fields.some((field) => field.fieldId === primary)))
    return null;
  return {
    tableId: item.tableId,
    name: item.name,
    primaryFieldId: primary as string | null,
    fields,
  };
}

export function readDescription(result: unknown, datasetId: string): CollectionDescription | null {
  const collection = readCollection(result);
  const tables = isFields(result) ? each(result.tables, readTable) : null;
  return collection && collection.datasetId === datasetId && tables
    ? { ...collection, tables }
    : null;
}

/** A page of a table's records, each keeping only the fields the table describes. */
export function readPage(result: unknown, table: CollectionTable): RecordPage | null {
  if (!isFields(result)) return null;
  if (result.status === "refused")
    return result.reason === "no-read" ? { status: "refused" } : null;
  if (
    result.status !== "ready" ||
    !Array.isArray(result.rows) ||
    result.rows.length > PAGE ||
    !isFields(result.files)
  )
    return null;
  const seen = new Set<string>();
  const rows = each(result.rows, (row): CollectionRecord | null => {
    if (!isFields(row) || !recordId(row.id) || !isFields(row.values)) return null;
    const key = JSON.stringify(row.id);
    if (seen.has(key)) return null;
    seen.add(key);
    const values: Record<string, RecordValue> = {};
    for (const field of table.fields)
      if (Object.hasOwn(row.values, field.fieldId))
        values[field.fieldId] = row.values[field.fieldId] as RecordValue;
    return { id: row.id, values };
  });
  const cursor = result.nextCursor;
  const next =
    cursor === null
      ? null
      : isFields(cursor) && recordId(cursor.id) && Object.hasOwn(cursor, "value")
        ? { id: cursor.id, value: cursor.value as RecordValue }
        : undefined;
  const files: Record<string, string> = {};
  for (const [fileId, name] of Object.entries(result.files))
    if (text(name, 1024)) files[fileId] = name;
  return rows && next !== undefined ? { status: "ready", rows, next, files } : null;
}

/** One workspace's Collection reads, for one sign-in's client. Each request ends when `signal` aborts. */
export function collectionOperations(
  client: ServerClient,
  workspaceId: string,
  signal: AbortSignal,
) {
  const { run, all } = accountOperations(client, workspaceId, signal);
  return {
    list: (): Promise<readonly PhoneCollection[]> =>
      all("collections", LIST_PAGES, readCollection, (next) => text(next, 64)),

    describe: (datasetId: string) =>
      run("collection", { datasetId }, (result) => readDescription(result, datasetId)),

    records: (datasetId: string, table: CollectionTable, after: RecordCursor | null) =>
      run(
        "collectionRecords",
        { datasetId, tableId: table.tableId, ...(after ? { after } : {}) },
        (result) => readPage(result, table),
      ),
  };
}

export type CollectionOperations = ReturnType<typeof collectionOperations>;
