import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import type { CollectionRecord, CollectionSchema } from "@dohc/workspace-contracts/collection";
import type { DohcDesktopBridge, QueryCollectionRecordsPayload } from "../ipc/bridgeContract";
import type { CsvTable } from "./datasetCsv";

/** Limits shared by source adapters. They keep a read-only source copy bounded. */
export const SOURCE_IMPORT_MAX_ROWS = 10_000;
export const SOURCE_IMPORT_MAX_BYTES = 4 * 1024 * 1024;

const encoder = new TextEncoder();
export type SourceImportReader = Pick<DohcDesktopBridge, "getCollection" | "queryCollectionRecords" | "readWorkspaceDatabase" | "readWorkspaceDatabasePage">;

function jsonValue(value: unknown, depth = 0): AppBackendJson {
  if (depth > 8) throw Error("This value is nested too deeply.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw Error("This value is not a finite number.");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw Error("This integer is too large to copy safely.");
    return value;
  }
  if (typeof value === "bigint") throw Error("Big integer values need a lossless source export.");
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) throw Error("Binary values need a file upload or lossless source export.");
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, depth + 1)]));
  }
  throw Error("This source value cannot be imported.");
}

function displayCell(value: AppBackendJson | undefined): string {
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function tableFromRows(headers: string[], rows: Array<Record<string, unknown>>, rowErrors: string[], cellErrors: string[][] = []): CsvTable {
  if (!headers.length || headers.length > 128) throw Error("Choose a source with 1 to 128 fields.");
  const literalValues: Array<Array<AppBackendJson | undefined>> = [];
  const cells: string[][] = [];
  let bytes = encoder.encode(JSON.stringify(headers)).byteLength;
  for (const row of rows) {
    if (cells.length >= SOURCE_IMPORT_MAX_ROWS) throw Error("Import at most 10,000 rows at a time.");
    const literals: Array<AppBackendJson | undefined> = [];
    const values = headers.map((header, column) => {
      const raw = row[header];
      if (raw === undefined) { literals.push(undefined); return ""; }
      try {
        const value = jsonValue(raw);
        literals.push(value);
        return displayCell(value);
      } catch (error) {
        literals.push(undefined);
        (cellErrors[cells.length] ??= [])[column] ||= error instanceof Error ? error.message : "This value cannot be imported.";
        return "";
      }
    });
    bytes += encoder.encode(JSON.stringify(values)).byteLength;
    if (bytes > SOURCE_IMPORT_MAX_BYTES) throw Error("Choose a source with fewer than 4 MB of imported values.");
    cells.push(values);
    literalValues.push(literals);
  }
  return { headers, rows: cells, literalValues, rowErrors, cellErrors };
}

/** Converts indexed document properties. Markdown bodies and frontmatter outside the schema are excluded. */
export function collectionRecordsToCsv(schema: CollectionSchema, records: readonly CollectionRecord[]): CsvTable {
  const headers = schema.fields.map(field => field.name);
  const errors: string[] = [];
  const cellErrors: string[][] = [];
  const rows = records.map((record, index) => {
    if (record.conflicted) errors[index] = "This document has a conflict. Resolve it before importing.";
    cellErrors[index] = schema.fields.map(field => {
      const value = record.values.find(value => value.field === field.name);
      if (value?.validation.status === "flagged") return `Correct ${field.name} in the source document first.`;
      if (field.type === "relation" && value?.value != null) return `Skip ${field.name}. Document relations need new target record keys.`;
      return "";
    });
    const values = Object.fromEntries(record.values.map(value => [value.field, value.value]));
    return values;
  });
  return tableFromRows(headers, rows, errors, cellErrors);
}

export interface DatabaseTableSource {
  name: string;
  columns: readonly { name: string }[];
  rows: readonly Record<string, unknown>[];
  nextOffset: number | null;
}

/** Converts one read-only SQLite table page. The caller owns pagination and source snapshot policy. */
export function databasePageToCsv(page: DatabaseTableSource): CsvTable {
  const headers = page.columns.map(column => column.name);
  const errors = page.rows.map(row => headers.map(header => {
    const value = row[header];
    // The database viewer projects binary cells and long text into display strings.
    if (typeof value === "string" && (/^<blob \d+ bytes>$/.test(value) || value.length > 4096)) return `Skip ${header}. Use a lossless export for binary or long text values.`;
    return "";
  }));
  return tableFromRows(headers, [...page.rows], [], errors);
}

export interface ReadDatabasePage {
  (table: string, offset: number, signal: AbortSignal): Promise<DatabaseTableSource>;
}

/** Reads a table through the existing read-only IPC. It rejects repeated or non-advancing pages. */
export async function readDatabaseTableToCsv(table: DatabaseTableSource, readPage: ReadDatabasePage, signal: AbortSignal): Promise<CsvTable> {
  const headers = table.columns.map(column => column.name);
  const rows: Record<string, unknown>[] = [...table.rows];
  let offset = table.nextOffset;
  const offsets = new Set<number>();
  while (offset !== null) {
    signal.throwIfAborted();
    if (offsets.has(offset)) throw Error("The SQLite source returned a repeated page. Start again.");
    offsets.add(offset);
    const page = await readPage(table.name, offset, signal);
    signal.throwIfAborted();
    if (page.name !== table.name || page.columns.map(column => column.name).join("\0") !== headers.join("\0") || page.rows.length === 0 && page.nextOffset !== null) {
      throw Error("The SQLite source changed while it was being read. Start again.");
    }
    rows.push(...page.rows);
    // Check the aggregate bounds before requesting another page.
    databasePageToCsv({ ...table, rows });
    if (page.nextOffset !== null && page.nextOffset <= offset) throw Error("The SQLite source returned a repeated page. Start again.");
    offset = page.nextOffset;
  }
  signal.throwIfAborted();
  return databasePageToCsv({ ...table, rows });
}

export async function readDocumentCollectionToCsv(reader: SourceImportReader, workspaceId: string, collectionPath: string, signal: AbortSignal): Promise<CsvTable> {
  signal.throwIfAborted();
  const details = await reader.getCollection({ workspaceId, collectionPath });
  signal.throwIfAborted();
  if (details.status !== "valid") throw Error("Correct the source Collection schema before importing.");
  const records: CollectionRecord[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: QueryCollectionRecordsPayload["cursor"];
  do {
    const page = await reader.queryCollectionRecords({ workspaceId, collectionPath, limit: 500, resolveRelations: false, ...(cursor ? { cursor } : {}) });
    signal.throwIfAborted();
    for (const record of page.records) {
      if (ids.has(record.id)) throw Error("The source Collection changed while it was being read. Start again.");
      ids.add(record.id); records.push(record);
    }
    collectionRecordsToCsv(details.schema, records);
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      const key = JSON.stringify(cursor, (_, value: unknown) => typeof value === "bigint" ? String(value) : value);
      if (!page.records.length || cursors.has(key)) throw Error("The source Collection returned a repeated page. Start again.");
      cursors.add(key);
    }
  } while (cursor);
  return collectionRecordsToCsv(details.schema, records);
}
