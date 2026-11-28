import type { DatasetColumnFieldType } from "@dohc/security-contract/dataset";
import { accountOperations, each, isFields, okAnswer, segment, text } from "./api";
import type { ServerClient } from "./client";

// The account operations for a workspace's transactional Collections (the relay's phoneCollections.ts): reads, a
// change to one field of a record, and a new record or a deletion.

export interface CollectionRelation {
  readonly many: boolean;
}

export interface CollectionField {
  readonly fieldId: string;
  readonly name: string;
  readonly type: DatasetColumnFieldType;
  /** A select's or a multi-select's choices, in order; empty for any other type. */
  readonly options: readonly string[];
  readonly relation?: CollectionRelation;
  readonly editable: boolean;
  readonly reversible: boolean;
}

export interface CreateCollectionField {
  readonly fieldId: string;
  readonly name: string;
  readonly type: DatasetColumnFieldType;
  readonly required: boolean;
  readonly default?: RecordValue;
  readonly options: readonly string[];
  readonly relation?: CollectionRelation;
}

export interface CollectionTable {
  readonly tableId: string;
  readonly name: string;
  /** The field that names a record, or null when it's one the phone doesn't show. */
  readonly primaryFieldId: string | null;
  readonly fields: readonly CollectionField[];
  readonly createFields: readonly CreateCollectionField[];
  readonly canCreate: boolean;
  readonly canDelete: boolean;
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

export interface RecordCreate extends RulesStamp {
  readonly datasetId: string;
  readonly tableId: string;
  readonly idempotencyKey: string;
  readonly values?: Readonly<Record<string, RecordValue>>;
}

export interface RecordDelete extends Omit<RecordCreate, "values"> {
  readonly recordId: RecordId;
  readonly expectedVersion: number;
}

export interface AttachmentUpload extends RulesStamp {
  readonly datasetId: string;
  readonly tableId: string;
  readonly fieldId: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly contentType: string;
  readonly bytesBase64: string;
}

export interface UploadedAttachment {
  readonly fileId: string;
  readonly name: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export type UploadAnswer =
  | { readonly kind: "uploaded"; readonly file: UploadedAttachment; readonly replayed: boolean }
  | WriteRefusal;

export interface RecordSort {
  readonly fieldId: string;
  readonly direction: "asc" | "desc";
}

export interface RelationOption {
  readonly value: RecordId;
  readonly label: string;
}

export type RelationLabels = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface RelationOptionsPage {
  readonly options: readonly RelationOption[];
  readonly next: RecordCursor | null;
  readonly searchUnsupported: boolean;
}

/** Why a write didn't save. */
export type WriteRefusal =
  /** The Collection's operation refused it, as `stale_record` for a record changed since the phone read it. */
  | { readonly kind: "refused"; readonly code: string; readonly message: string }
  /** It named rules the Collection has replaced, so it never ran. */
  | { readonly kind: "rulesChanged" };

export type ChangeAnswer =
  /** `priorValue` is absent when the edit gave none, so nothing can undo it. */
  | {
      readonly kind: "saved";
      readonly version: number;
      readonly priorValue?: RecordValue;
    }
  | WriteRefusal;

/** The new record's ID, which the phone reads the record by. */
export type CreateAnswer = { readonly kind: "saved"; readonly id: RecordId } | WriteRefusal;
export type DeleteAnswer = { readonly kind: "saved" } | WriteRefusal;

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
      readonly files: Readonly<Record<string, string>>;
      readonly relations: RelationLabels;
    }
  | { readonly status: "refused" }
  | { readonly status: "unsupported-query" };

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

function readBaseField(item: unknown) {
  if (
    !isFields(item) ||
    !text(item.fieldId, 64) ||
    !text(item.name, 1024) ||
    typeof item.type !== "string" ||
    !TYPES.has(item.type)
  )
    return null;
  const type = item.type as DatasetColumnFieldType;
  const choices = type === "select" || type === "multi-select";
  const options = choices ? each(item.options, (option) => (text(option) ? option : null)) : [];
  if (!options) return null;
  let relation: CollectionRelation | undefined;
  if (type === "relation" && item.relation !== undefined) {
    if (!isFields(item.relation) || typeof item.relation.many !== "boolean") return null;
    relation = { many: item.relation.many };
  }
  return {
    fieldId: item.fieldId,
    name: item.name,
    type,
    options,
    ...(relation ? { relation } : {}),
  };
}

function readField(item: unknown): CollectionField | null {
  const base = readBaseField(item);
  if (
    !base ||
    !isFields(item) ||
    typeof item.editable !== "boolean" ||
    typeof item.reversible !== "boolean"
  )
    return null;
  return { ...base, editable: item.editable, reversible: item.editable && item.reversible };
}

function readCreateField(item: unknown): CreateCollectionField | null {
  const base = readBaseField(item);
  if (!base || !isFields(item) || typeof item.required !== "boolean") return null;
  if (base.type === "relation" && !base.relation) return null;
  return {
    ...base,
    required: item.required,
    ...(Object.hasOwn(item, "default") ? { default: item.default as RecordValue } : {}),
  };
}

function readTable(item: unknown): CollectionTable | null {
  if (
    !isFields(item) ||
    !text(item.tableId, 64) ||
    !text(item.name, 1024) ||
    typeof item.canCreate !== "boolean" ||
    typeof item.canDelete !== "boolean"
  )
    return null;
  const fields = each(item.fields, readField);
  const createFields = each(item.createFields, readCreateField);
  const primary = item.primaryFieldId;
  if (
    !fields ||
    !createFields ||
    (primary !== null && !fields.some((field) => field.fieldId === primary))
  )
    return null;
  return {
    tableId: item.tableId,
    name: item.name,
    primaryFieldId: primary as string | null,
    fields,
    createFields,
    canCreate: item.canCreate,
    canDelete: item.canDelete,
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

/** A write's answer: its refusal, or what `readSaved` makes of what it saved. */
function readWrite<T>(
  result: unknown,
  readSaved: (saved: Readonly<Record<string, unknown>>) => T | null,
): T | WriteRefusal | null {
  if (!isFields(result)) return null;
  const { saved, refused } = result;
  if (result.rulesChanged === true) return { kind: "rulesChanged" };
  if (isFields(refused))
    return text(refused.code, 64) && text(refused.message, 1024)
      ? { kind: "refused", code: refused.code, message: refused.message }
      : null;
  return isFields(saved) ? readSaved(saved) : null;
}

export const readChangeAnswer = (result: unknown): ChangeAnswer | null =>
  readWrite(result, (saved) =>
    isCount(saved.version)
      ? {
          kind: "saved" as const,
          version: saved.version,
          ...(Object.hasOwn(saved, "priorValue")
            ? { priorValue: saved.priorValue as RecordValue }
            : {}),
        }
      : null,
  );

export const readCreateAnswer = (result: unknown): CreateAnswer | null =>
  readWrite(result, (saved) =>
    recordId(saved.id) && isCount(saved.version) ? { kind: "saved" as const, id: saved.id } : null,
  );

export const readDeleteAnswer = (result: unknown): DeleteAnswer | null =>
  readWrite(result, () => ({ kind: "saved" as const }));

export function readUploadAnswer(result: unknown): UploadAnswer | null {
  if (!isFields(result)) return null;
  if (result.rulesChanged === true) return { kind: "rulesChanged" };
  if (isFields(result.refused))
    return text(result.refused.code, 64) && text(result.refused.message, 1024)
      ? { kind: "refused", code: result.refused.code, message: result.refused.message }
      : null;
  const f = result.file;
  if (
    !isFields(f) ||
    !text(f.fileId, 128) ||
    !text(f.name, 255) ||
    !text(f.contentType, 127) ||
    !isCount(f.byteLength) ||
    !text(f.sha256, 64) ||
    typeof result.replayed !== "boolean"
  )
    return null;
  return {
    kind: "uploaded",
    file: {
      fileId: f.fileId,
      name: f.name,
      contentType: f.contentType,
      byteLength: f.byteLength,
      sha256: f.sha256,
    },
    replayed: result.replayed,
  };
}

const readCursor = (cursor: unknown): RecordCursor | null | undefined =>
  cursor === null
    ? null
    : isFields(cursor) && recordId(cursor.id) && Object.hasOwn(cursor, "value")
      ? { id: cursor.id, value: cursor.value as RecordValue }
      : undefined;

function readRelationLabels(value: unknown): RelationLabels | null {
  if (!isFields(value)) return null;
  const out: Record<string, Record<string, string>> = {};
  for (const [fieldId, entries] of Object.entries(value)) {
    if (!text(fieldId, 64) || !isFields(entries)) return null;
    const map: Record<string, string> = {};
    for (const [key, label] of Object.entries(entries)) if (text(label, 2000)) map[key] = label;
    out[fieldId] = map;
  }
  return out;
}

/** A page of a table's records, each keeping only the fields the table describes. */
export function readPage(result: unknown, table: CollectionTable): RecordPage | null {
  if (!isFields(result)) return null;
  if (result.status === "refused")
    return result.reason === "no-read"
      ? { status: "refused" }
      : result.reason === "unsupported-query"
        ? { status: "unsupported-query" }
        : null;
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
  const next = readCursor(result.nextCursor);
  const files: Record<string, string> = {};
  for (const [fileId, name] of Object.entries(result.files))
    if (text(name, 1024)) files[fileId] = name;
  const relations = readRelationLabels(result.relations);
  return rows && next !== undefined && relations
    ? { status: "ready", rows, next, files, relations }
    : null;
}

export const isRelationKey = (value: unknown): value is RecordId =>
  text(value, 1024) || (typeof value === "number" && Number.isFinite(value));

export function readRelationOptions(result: unknown): RelationOptionsPage | null {
  if (!isFields(result) || !Array.isArray(result.options) || result.options.length > PAGE)
    return null;
  const seen = new Set<string>();
  const options = each(result.options, (item): RelationOption | null => {
    if (!isFields(item) || !isRelationKey(item.value) || !text(item.label, 2000)) return null;
    const key = JSON.stringify(item.value);
    if (seen.has(key)) return null;
    seen.add(key);
    return { value: item.value, label: item.label };
  });
  const next = readCursor(result.nextCursor);
  if (
    !options ||
    next === undefined ||
    (result.searchUnsupported !== undefined && typeof result.searchUnsupported !== "boolean")
  )
    return null;
  return { options, next, searchUnsupported: result.searchUnsupported === true };
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

    records: (
      datasetId: string,
      table: CollectionTable,
      after: RecordCursor | null,
      query?: { readonly search?: string; readonly sort?: RecordSort | null },
    ) =>
      run(
        "collectionRecords",
        {
          datasetId,
          tableId: table.tableId,
          ...(after ? { after } : {}),
          ...(query?.search ? { search: query.search } : {}),
          ...(query?.sort ? { sort: query.sort } : {}),
        },
        (result) => readPage(result, table),
      ),

    /** One record, read again by its key, with its files' names and relation labels, or null when it is gone. */
    record: (datasetId: string, table: CollectionTable, id: RecordId) =>
      run(
        "collectionRecords",
        { datasetId, tableId: table.tableId, recordId: id },
        (
          result,
        ): {
          record: CollectionRecord | null;
          files: Readonly<Record<string, string>>;
          relations: RelationLabels;
        } | null => {
          const page = readPage(result, table);
          if (page?.status !== "ready" || page.rows.length > 1) return null;
          const record = page.rows[0];
          return {
            record: record && record.id === id ? record : null,
            files: page.files,
            relations: page.relations,
          };
        },
      ),

    relationOptions: (
      datasetId: string,
      tableId: string,
      fieldId: string,
      search: string,
      after: RecordCursor | null,
      requestSignal?: AbortSignal,
    ) =>
      run(
        "collectionRelationOptions",
        { datasetId, tableId, fieldId, ...(search ? { search } : {}), ...(after ? { after } : {}) },
        readRelationOptions,
        requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
      ),

    change: (change: FieldChange) => run("collectionEdit", change, readChangeAnswer),

    create: (create: RecordCreate) => run("collectionCreate", create, readCreateAnswer),

    remove: (remove: RecordDelete) => run("collectionDelete", remove, readDeleteAnswer),

    uploadAttachment: (upload: AttachmentUpload, requestSignal?: AbortSignal) =>
      client.send(
        "POST",
        `/sync/${segment(workspaceId)}/ops/collectionAttachmentUpload`,
        (body) => {
          const answer = okAnswer(body);
          return answer ? readUploadAnswer(answer.result) : null;
        },
        upload,
        {
          signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
          timeoutMs: 60_000,
        },
      ),
  };
}

export type CollectionOperations = ReturnType<typeof collectionOperations>;
