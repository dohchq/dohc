import type { CollectionValue } from "./collection";

type DocumentCollectionRef = { kind: "document"; path: string };
type TransactionalCollectionRef = { kind: "transactional"; datasetId: string; tableId: string };
export type CollectionRef = DocumentCollectionRef | TransactionalCollectionRef;
export type CollectionRecordRef =
  | { collection: DocumentCollectionRef; recordId: string }
  | { collection: TransactionalCollectionRef; recordId: string | number };

/** Field keys are document property names or transactional field UUIDs. */
export interface CollectionDataQuery {
  collection: CollectionRef;
  limit?: number;
  after?: { id: string | number; value: CollectionValue };
  sort?: { fieldId: string; direction: "asc" | "desc" };
  search?: string;
  filters?: Array<{ fieldId: string; value: CollectionValue }>;
}
/** An edit payload remains input to an approved operation, never a generic write grant. */
export interface CollectionDataEditInput {
  id: string | number;
  expectedVersion: number;
  values: Record<string, CollectionValue>;
}
export type CollectionDataAction =
  | { kind: "document"; action: "create"; collection: DocumentCollectionRef; name: string; fields?: Record<string, CollectionValue> }
  | { kind: "document"; action: "setFields"; record: Extract<CollectionRecordRef, { collection: DocumentCollectionRef }>; fields: Record<string, CollectionValue> }
  | { kind: "transactional"; action: "operation"; collection: TransactionalCollectionRef; operationId: string; input: CollectionValue; revision: number; revisionSha256: string; idempotencyKey: string };

const MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const recordPattern = /^rec_[a-z2-7]{26}$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function fail(): never { throw new Error("Invalid collection data contract."); }

/** Copy first so accessors, inherited properties, and unbounded values cannot enter a request. */
function copy(input: unknown, allowBigInt: boolean): CollectionValue {
  let budget = MAX_BYTES;
  let nodes = 0;
  function charge(text: string): void {
    budget -= encoder.encode(text).byteLength;
    if (budget < 0) fail();
  }
  function visit(value: unknown, depth: number): CollectionValue {
    if (depth > 16 || ++nodes > 4096) fail();
    if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) fail();
      if (typeof value === "string" && value.length > MAX_BYTES) fail();
      charge(JSON.stringify(value));
      return value;
    }
    if (typeof value === "bigint" && allowBigInt) { charge(value.toString()); return value; }
    if (Array.isArray(value)) {
      if (value.length > 4096 || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail();
      charge("[]" + ",".repeat(value.length));
      return Array.from({ length: value.length }, (_, index) => {
        const entry = Object.getOwnPropertyDescriptor(value, String(index));
        if (!entry || !entry.enumerable || !("value" in entry)) fail();
        return visit(entry.value, depth + 1);
      });
    }
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    const keys = Reflect.ownKeys(value);
    const result: Record<string, CollectionValue> = {};
    charge("{}");
    for (const key of keys) {
      const entry = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || forbidden.has(key) || !entry.enumerable || !("value" in entry)) fail();
      charge(JSON.stringify(key) + ":,");
      result[key] = visit(entry.value, depth + 1);
    }
    return result;
  }
  return visit(input, 0);
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail();
  return input as Record<string, unknown>;
}
function exact(input: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  const row = object(input);
  if (Object.keys(row).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(row, key))) fail();
  return row;
}
function text(input: unknown, maximum = 128, empty = false): string {
  if (typeof input !== "string" || (!empty && !input.length) || encoder.encode(input).byteLength > maximum || /[\u0000-\u001f\u007f]/u.test(input)) fail();
  return input;
}
function uuid(input: unknown): string {
  if (typeof input !== "string" || input.length !== 36 || !uuidPattern.test(input)) fail();
  return input;
}
function positive(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) fail();
  return input;
}
function recordId(input: unknown, kind: CollectionRef["kind"]): string | number {
  if (kind === "document") {
    if (typeof input !== "string" || input.length !== 30 || !recordPattern.test(input)) fail();
    return input;
  }
  if (typeof input === "number") { if (!Number.isSafeInteger(input)) fail(); return input; }
  return text(input, 1024);
}
function ref(input: unknown): CollectionRef {
  const kind = object(input).kind;
  if (kind === "document") {
    const row = exact(input, ["kind", "path"]);
    const path = text(row.path, 4096);
    if (/[\\:%]/u.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".dohc")) fail();
    return { kind, path };
  }
  if (kind === "transactional") {
    const row = exact(input, ["kind", "datasetId", "tableId"]);
    return { kind, datasetId: uuid(row.datasetId), tableId: uuid(row.tableId) };
  }
  fail();
}
function recordRef(input: unknown): CollectionRecordRef {
  const row = exact(input, ["collection", "recordId"]);
  const collection = ref(row.collection);
  return { collection, recordId: recordId(row.recordId, collection.kind) } as CollectionRecordRef;
}
function fieldKey(input: unknown, kind: CollectionRef["kind"]): string {
  return kind === "transactional" ? uuid(input) : text(input);
}
function fields(input: unknown, kind: CollectionRef["kind"]): Record<string, CollectionValue> {
  const row = object(input);
  if (Object.keys(row).length > 128) fail();
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [fieldKey(key, kind), value as CollectionValue]));
}

export function parseCollectionRef(input: unknown): CollectionRef { return ref(copy(input, false)); }
export function parseCollectionRecordRef(input: unknown): CollectionRecordRef { return recordRef(copy(input, false)); }

export function parseCollectionDataQuery(input: unknown): CollectionDataQuery {
  const row = exact(copy(input, true), ["collection"], ["limit", "after", "sort", "search", "filters"]);
  const collection = ref(row.collection);
  if (collection.kind === "transactional") copy(row, false);
  const result: CollectionDataQuery = { collection };
  if (Object.hasOwn(row, "limit")) { result.limit = positive(row.limit); if (result.limit > 1000) fail(); }
  if (Object.hasOwn(row, "after")) {
    const after = exact(row.after, ["id", "value"]);
    result.after = { id: recordId(after.id, collection.kind), value: after.value as CollectionValue };
  }
  if (Object.hasOwn(row, "sort")) {
    const sort = exact(row.sort, ["fieldId", "direction"]);
    if (sort.direction !== "asc" && sort.direction !== "desc") fail();
    result.sort = { fieldId: fieldKey(sort.fieldId, collection.kind), direction: sort.direction };
  }
  if (Object.hasOwn(row, "search")) result.search = text(row.search, 256, true);
  if (Object.hasOwn(row, "filters")) {
    if (!Array.isArray(row.filters) || row.filters.length > 32) fail();
    result.filters = row.filters.map(input => {
      const filter = exact(input, ["fieldId", "value"]);
      return { fieldId: fieldKey(filter.fieldId, collection.kind), value: filter.value as CollectionValue };
    });
    if (new Set(result.filters.map(filter => filter.fieldId)).size !== result.filters.length) fail();
  }
  return result;
}

export function parseCollectionDataEditInput(input: unknown): CollectionDataEditInput {
  const row = exact(copy(input, false), ["id", "expectedVersion", "values"]);
  return { id: recordId(row.id, "transactional"), expectedVersion: positive(row.expectedVersion), values: fields(row.values, "transactional") };
}

export function parseCollectionDataAction(input: unknown): CollectionDataAction {
  const row = object(copy(input, true));
  if (row.kind === "document" && row.action === "create") {
    exact(row, ["kind", "action", "collection", "name"], ["fields"]);
    const collection = ref(row.collection);
    if (collection.kind !== "document") fail();
    const name = text(row.name, 255);
    if (/[\\/:]/u.test(name) || name === "." || name === "..") fail();
    return { kind: "document", action: "create", collection, name, ...(Object.hasOwn(row, "fields") ? { fields: fields(row.fields, collection.kind) } : {}) };
  }
  if (row.kind === "document" && row.action === "setFields") {
    exact(row, ["kind", "action", "record", "fields"]);
    const record = recordRef(row.record);
    if (record.collection.kind !== "document") fail();
    return { kind: "document", action: "setFields", record: record as Extract<CollectionRecordRef, { collection: DocumentCollectionRef }>, fields: fields(row.fields, record.collection.kind) };
  }
  if (row.kind === "transactional" && row.action === "operation") {
    copy(row, false);
    exact(row, ["kind", "action", "collection", "operationId", "input", "revision", "revisionSha256", "idempotencyKey"]);
    const collection = ref(row.collection);
    if (collection.kind !== "transactional") fail();
    const revisionSha256 = text(row.revisionSha256, 64);
    if (!/^[0-9a-f]{64}$/.test(revisionSha256)) fail();
    const idempotencyKey = text(row.idempotencyKey, 128);
    if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) fail();
    return { kind: "transactional", action: "operation", collection, operationId: uuid(row.operationId), input: row.input as CollectionValue,
      revision: positive(row.revision), revisionSha256, idempotencyKey };
  }
  fail();
}

/** Stable UI/cache keys retain numeric versus text record identity. */
export function collectionRefKey(input: CollectionRef): string { return JSON.stringify(parseCollectionRef(input)); }
export function collectionRecordRefKey(input: CollectionRecordRef): string { return JSON.stringify(parseCollectionRecordRef(input)); }
