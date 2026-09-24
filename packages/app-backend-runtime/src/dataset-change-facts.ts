import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetDefinition, DatasetField, DatasetTable } from "@dohc/security-contract/dataset";

// What one dataset commit changed, record by record, for automation triggers.
//
// A commit's changeset is the SQLite session changeset the host journals with
// the event (ADR 0011). This module reads it without a database: decode the
// changeset into row changes, then map each row's columns to the approved
// definition's fields. It trusts nothing it reads and throws
// DatasetChangeFactsError on anything it cannot read exactly.
//
// The changeset format is SQLite's (sqlite3session.h, "Changeset Format").
// Each table block is the byte 0x54, a varint column count, one byte per column
// that is nonzero for a primary key column, and the NUL-terminated table name.
// Then come its changes: the operation (INSERT 18, UPDATE 23, DELETE 9), an
// "indirect" byte, and the old record (DELETE and UPDATE) and new record
// (INSERT and UPDATE). A record holds one value per column: a type byte, then
// 8 big-endian bytes for an integer or a real, a varint length and bytes for
// text or a blob, and nothing for NULL or "undefined". In an UPDATE, a column
// the change did not touch is undefined, except the old record's primary key
// columns. A session collapses several changes to one row into one, and
// records a change of primary key as a DELETE and an INSERT.

export class DatasetChangeFactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetChangeFactsError";
  }
}

/** A stored SQLite value. Integers are bigints, so none loses precision. */
export type ChangesetValue = null | bigint | number | string | Uint8Array;

export interface ChangesetRow {
  table: string;
  operation: "insert" | "update" | "delete";
  /** Whether the change came from a trigger or foreign key action. */
  indirect: boolean;
  /** Primary key flags, one per column. */
  primaryKey: readonly boolean[];
  /** One entry per column, undefined where the change holds no value. Empty for an INSERT. */
  old: ReadonlyArray<ChangesetValue | undefined>;
  /** One entry per column, undefined where the change holds no value. Empty for a DELETE. */
  new: ReadonlyArray<ChangesetValue | undefined>;
}

export interface DatasetFieldChange {
  fieldId: string;
  /** Null for a record that was added. */
  previous: AppBackendJson;
  /** Null for a record that was removed. */
  next: AppBackendJson;
}

export interface DatasetChangeFact {
  kind: "added" | "changed" | "removed";
  datasetId: string;
  tableId: string;
  recordId: string | number;
  /** The record's version after the change, or before a removal. Null when the change does not state one. */
  version: number | null;
  /** Every field of an added or removed record; only the changed fields of a changed record. */
  fields: DatasetFieldChange[];
}

const TABLE_HEADER = 0x54;
const PATCHSET_HEADER = 0x50;
const OPERATIONS = new Map<number, ChangesetRow["operation"]>([[18, "insert"], [23, "update"], [9, "delete"]]);
// SQLite's own ceiling on columns in a table (SQLITE_MAX_COLUMN).
const MAX_COLUMNS = 32_767;
const VERSION_COLUMN = "_record_version";
const tableNames = new TextDecoder("utf-8", { fatal: true });
const texts = new TextDecoder("utf-8");

function fail(message: string): never {
  throw new DatasetChangeFactsError(message);
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.byteLength;
  }

  byte(): number {
    if (this.done) fail("The changeset ends early.");
    return this.bytes[this.offset++]!;
  }

  take(length: number): Uint8Array {
    if (length > this.bytes.byteLength - this.offset) fail("The changeset ends early.");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  // SQLite's varint: big-endian groups of 7 bits, high bit set on every byte
  // but the last; a ninth byte carries 8 bits. Lengths and counts here fit in
  // a safe integer, and a larger one cannot be real.
  varint(): number {
    let value = 0n;
    for (let index = 0; index < 9; index += 1) {
      const byte = this.byte();
      if (index === 8) return safe((value << 8n) | BigInt(byte));
      value = (value << 7n) | BigInt(byte & 0x7f);
      if ((byte & 0x80) === 0) return safe(value);
    }
    return fail("The changeset holds an unreadable number.");
  }
}

function safe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("The changeset holds a length it cannot have.");
  return Number(value);
}

function readValue(reader: Reader): ChangesetValue | undefined {
  const type = reader.byte();
  switch (type) {
    case 0:
      return undefined;
    case 1:
    case 2: {
      const bytes = reader.take(8);
      const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
      return type === 1 ? view.getBigInt64(0) : view.getFloat64(0);
    }
    case 3:
      return texts.decode(reader.take(reader.varint()));
    case 4:
      return reader.take(reader.varint()).slice();
    case 5:
      return null;
    default:
      return fail("The changeset holds a value of an unknown type.");
  }
}

function readRecord(reader: Reader, columns: number, defined: boolean): Array<ChangesetValue | undefined> {
  const values: Array<ChangesetValue | undefined> = [];
  for (let column = 0; column < columns; column += 1) {
    const value = readValue(reader);
    if (defined && value === undefined) fail("An inserted or deleted row lacks a value.");
    values.push(value);
  }
  return values;
}

/** Every change in a changeset, in order. Stops at the first thing it cannot read. */
export function* decodeChangeset(bytes: Uint8Array): Generator<ChangesetRow> {
  const reader = new Reader(bytes);
  while (!reader.done) {
    const header = reader.byte();
    if (header === PATCHSET_HEADER) fail("A patchset is not a changeset.");
    if (header !== TABLE_HEADER) fail("The changeset lacks a table header.");
    const columns = reader.varint();
    if (columns < 1 || columns > MAX_COLUMNS) fail("The changeset names a table with an impossible column count.");
    const primaryKey = [...reader.take(columns)].map((flag) => flag !== 0);
    if (!primaryKey.includes(true)) fail("The changeset names a table without a primary key.");
    const end = reader.bytes.indexOf(0, reader.offset);
    if (end < 0) fail("The changeset ends early.");
    let table: string;
    try {
      table = tableNames.decode(reader.take(end - reader.offset));
    } catch {
      return fail("The changeset names a table that is not UTF-8.");
    }
    reader.byte();
    if (table.length === 0) fail("The changeset names a table without a name.");
    // A session never writes a table without a change to it.
    const nextHeader = () => reader.bytes[reader.offset] === TABLE_HEADER || reader.bytes[reader.offset] === PATCHSET_HEADER;
    if (reader.done || nextHeader()) fail("The changeset names a table without changes.");
    while (!reader.done && !nextHeader()) {
      const operation = OPERATIONS.get(reader.byte());
      if (operation === undefined) fail("The changeset holds an unknown operation.");
      const indirect = reader.byte();
      if (indirect > 1) fail("The changeset holds an unreadable change.");
      const old = operation === "insert" ? [] : readRecord(reader, columns, operation === "delete");
      const next = operation === "delete" ? [] : readRecord(reader, columns, operation === "insert");
      if (operation === "update") checkUpdate(primaryKey, old, next);
      yield { table, operation, indirect: indirect === 1, primaryKey, old, new: next };
    }
  }
}

// An UPDATE keeps each primary key column in its old record only, and holds
// both values of every column it changed.
function checkUpdate(
  primaryKey: readonly boolean[],
  old: ReadonlyArray<ChangesetValue | undefined>,
  next: ReadonlyArray<ChangesetValue | undefined>,
): void {
  primaryKey.forEach((key, column) => {
    const readable = key
      ? old[column] !== undefined && next[column] === undefined
      : (old[column] === undefined) === (next[column] === undefined);
    if (!readable) fail("The changeset holds an unreadable update.");
  });
}

/** The names of the tables a changeset changes, in order. */
export function changesetTables(bytes: Uint8Array): string[] {
  const tables = new Set<string>();
  for (const row of decodeChangeset(bytes)) tables.add(row.table);
  return [...tables];
}

interface TableMap {
  table: DatasetTable;
  primaryKey: number;
  version: number | null;
  fields: Array<{ field: DatasetField; column: number }>;
}

function columnIndex(columns: readonly string[], name: string): number {
  const lower = name.toLowerCase();
  return columns.findIndex((column) => column.toLowerCase() === lower);
}

// Maps a changed table's columns, in the order the worker reported them, to
// the approved definition's fields. The worker reads the order from the
// database, because a migration can reorder columns.
function tableMap(definition: DatasetDefinition, table: string, columns: readonly string[] | undefined, count: number): TableMap {
  const approved = definition.tables.find((candidate) => candidate.sqlName.toLowerCase() === table.toLowerCase());
  if (!approved) fail(`The changeset changes ${table}, which the approved dataset does not have.`);
  if (!Array.isArray(columns) || columns.length !== count || columns.some((column) => typeof column !== "string" || column.length === 0) ||
    new Set(columns.map((column) => column.toLowerCase())).size !== columns.length) {
    fail(`The columns reported for ${table} do not match its changes.`);
  }
  const primaryKey = columnIndex(columns, approved.primaryKey);
  const fields = approved.fields.map((field) => ({ field, column: columnIndex(columns, field.sqlColumn) }));
  if (primaryKey < 0 || fields.some(({ column }) => column < 0)) fail(`The columns reported for ${table} lack an approved field.`);
  const version = columnIndex(columns, VERSION_COLUMN);
  return { table: approved, primaryKey, version: version < 0 ? null : version, fields };
}

// A stored value as the field's type reads it, the way generated operations
// decode rows: a checkbox is 0 or 1, and a multi-select or a to-many relation
// is a JSON array in text.
function fieldValue(field: DatasetField, value: ChangesetValue): AppBackendJson {
  if (value === null) return null;
  if (value instanceof Uint8Array) fail(`${field.name} holds bytes, which no field type can hold.`);
  const number = typeof value === "bigint" ? integer(value, field.name) : value;
  if (typeof number === "number" && !Number.isFinite(number)) fail(`${field.name} holds a number JSON cannot hold.`);
  if (field.type === "checkbox" && (number === 0 || number === 1)) return number === 1;
  if ((field.type === "multi-select" || field.relation?.many) && typeof number === "string") {
    try {
      const parsed: unknown = JSON.parse(number);
      if (Array.isArray(parsed)) return parsed as AppBackendJson[];
    } catch {
      // Stored text that is not an array stays text.
    }
  }
  return number;
}

function integer(value: bigint, name: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    fail(`${name} holds an integer JSON cannot hold exactly.`);
  }
  return Number(value);
}

function recordId(map: TableMap, value: ChangesetValue | undefined): string | number {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "bigint") return integer(value, map.table.name);
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return fail(`A changed record in ${map.table.name} has no readable id.`);
}

function version(map: TableMap, value: ChangesetValue | undefined): number | null {
  if (map.version === null || value === undefined) return null;
  const number = typeof value === "bigint" ? integer(value, VERSION_COLUMN) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    fail(`A changed record in ${map.table.name} has an unreadable version.`);
  }
  return number;
}

/**
 * What a committed changeset did to each record, as change facts. `columns`
 * names each changed table's columns in database order, from the worker's
 * prepare result. A changed record whose change touched no approved field,
 * such as one that only raised its version, yields nothing.
 */
export function* datasetChangeFacts(input: {
  definition: DatasetDefinition;
  changeset: Uint8Array;
  columns: Readonly<Record<string, readonly string[]>>;
}): Generator<DatasetChangeFact> {
  const maps = new Map<string, TableMap>();
  for (const row of decodeChangeset(input.changeset)) {
    let map = maps.get(row.table);
    if (!map) {
      map = tableMap(input.definition, row.table, Object.hasOwn(input.columns, row.table) ? input.columns[row.table] : undefined,
        row.primaryKey.length);
      maps.set(row.table, map);
    }
    const base = { datasetId: input.definition.datasetId, tableId: map.table.tableId };
    if (row.operation === "insert" || row.operation === "delete") {
      const values = row.operation === "insert" ? row.new : row.old;
      yield {
        kind: row.operation === "insert" ? "added" : "removed",
        ...base,
        recordId: recordId(map, values[map.primaryKey]),
        version: version(map, values[map.version ?? -1]),
        fields: map.fields.map(({ field, column }) => {
          const value = fieldValue(field, values[column]!);
          return { fieldId: field.fieldId, previous: row.operation === "insert" ? null : value, next: row.operation === "insert" ? value : null };
        }),
      };
      continue;
    }
    const fields = map.fields.flatMap(({ field, column }) => {
      const next = row.new[column];
      return next === undefined ? [] : [{ fieldId: field.fieldId, previous: fieldValue(field, row.old[column]!), next: fieldValue(field, next) }];
    });
    if (fields.length === 0) continue;
    yield {
      kind: "changed",
      ...base,
      recordId: recordId(map, row.old[map.primaryKey]),
      version: version(map, map.version === null ? undefined : row.new[map.version]),
      fields,
    };
  }
}
