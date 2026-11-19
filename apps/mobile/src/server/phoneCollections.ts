import type { DatasetColumnFieldType } from "@dohc/security-contract/dataset";
import { accountOperations, each, isFields, text } from "./api";
import type { ServerClient } from "./client";

// The account operations for a workspace's transactional Collections (the relay's phoneCollections.ts): reads, and a
// change to one field of a record.

export interface CollectionField {
  readonly fieldId: string;
  readonly name: string;
  readonly type: DatasetColumnFieldType;
  /** A select's or a multi-select's choices, in order; empty for any other type. */
  readonly options: readonly string[];
  readonly editable: boolean;
  readonly reversible: boolean;
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

/** The rules a description is of. A change names them, and a retry names the same. */
export interface RulesStamp {
  readonly revision: number;
  readonly revisionSha256: string;
}

export interface CollectionDescription extends PhoneCollection, RulesStamp {
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
  /** What a change to it must name, or null when the read gave none, so the phone can't change it. */
  readonly version: number | null;
  readonly values: Readonly<Record<string, RecordValue>>;
}

export interface FieldChange extends RulesStamp {
  readonly datasetId: string;
  readonly tableId: string;
  readonly recordId: RecordId;
  readonly fieldId: string;
  readonly value: RecordValue;
  readonly expectedVersion: number;
  /** A random UUID, the same on every try. */
  readonly idempotencyKey: string;
}

export type ChangeAnswer =
  /** `priorValue` is absent when the edit gave none, so nothing can undo it. */
  | {
      readonly kind: "saved";
      readonly version: number;
      readonly priorValue?: RecordValue;
    }
  /** The Collection's operation refused it, as `stale_record` for a record changed since the phone read it. */
  | { readonly kind: "refused"; readonly code: string; readonly message: string }
  /** It named rules the Collection has replaced, so it never ran. */
  | { readonly kind: "rulesChanged" };

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

const TYPES: ReadonlySet<string> = new Set<DatasetColumnFieldType>([
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

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

function readField(item: unknown): CollectionField | null {
  if (
    !isFields(item) ||
    !text(item.fieldId, 64) ||
    !text(item.name, 1024) ||
    typeof item.type !== "string" ||
    !TYPES.has(item.type) ||
    typeof item.editable !== "boolean" ||
    typeof item.reversible !== "boolean"
  )
    return null;
  const type = item.type as DatasetColumnFieldType;
  const choices = type === "select" || type === "multi-select";
  const options = choices ? each(item.options, (option) => (text(option) ? option : null)) : [];
  if (!options) return null;
  return {
    fieldId: item.fieldId,
    name: item.name,
    type,
    options,
    editable: item.editable,
    reversible: item.editable && item.reversible,
  };
}

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
  if (!collection || !isFields(result) || collection.datasetId !== datasetId) return null;
  const tables = each(result.tables, readTable);
  const { revision, revisionSha256 } = result;
  return tables &&
    isCount(revision) &&
    text(revisionSha256, 64) &&
    /^[0-9a-f]{64}$/.test(revisionSha256)
    ? { ...collection, revision, revisionSha256, tables }
    : null;
}

export function readChangeAnswer(result: unknown): ChangeAnswer | null {
  if (!isFields(result)) return null;
  const { saved, refused } = result;
  if (result.rulesChanged === true) return { kind: "rulesChanged" };
  if (isFields(refused))
    return text(refused.code, 64) && text(refused.message, 1024)
      ? { kind: "refused", code: refused.code, message: refused.message }
      : null;
  if (!isFields(saved) || !isCount(saved.version)) return null;
  return {
    kind: "saved",
    version: saved.version,
    ...(Object.hasOwn(saved, "priorValue") ? { priorValue: saved.priorValue as RecordValue } : {}),
  };
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
    return { id: row.id, version: isCount(row.version) ? row.version : null, values };
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

    /** One record, read again by its key, with its files' names, or null when it is gone. */
    record: (datasetId: string, table: CollectionTable, id: RecordId) =>
      run(
        "collectionRecords",
        { datasetId, tableId: table.tableId, recordId: id },
        (
          result,
        ): {
          record: CollectionRecord | null;
          files: Readonly<Record<string, string>>;
        } | null => {
          const page = readPage(result, table);
          if (page?.status !== "ready" || page.rows.length > 1) return null;
          const record = page.rows[0];
          return { record: record && record.id === id ? record : null, files: page.files };
        },
      ),

    change: (change: FieldChange) => run("collectionEdit", change, readChangeAnswer),
  };
}

export type CollectionOperations = ReturnType<typeof collectionOperations>;
