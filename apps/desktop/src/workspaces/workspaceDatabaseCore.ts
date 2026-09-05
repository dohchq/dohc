import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  DatabaseColumnView,
  DatabaseEdit,
  DatabaseEditResult,
  DatabaseOperationInput,
  DatabasePageView,
  DatabaseSnapshotView,
} from "./workspaceDatabaseTypes.ts";

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
}

const requireFromHere = createRequire(import.meta.url);

function nodeSqlite(): SqliteModule {
  return requireFromHere("node:sqlite") as SqliteModule;
}

export const DATABASE_MAX_ROWS = 1000;
const DATABASE_MAX_TABLES = 200;
export const DATABASE_MAX_CELL_CHARS = 4096;
const DATABASE_PAGE_MAX_BYTES = 8 * 1024 * 1024;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sanitizeCell(value: unknown): unknown {
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  if (typeof value === "string" && value.length > DATABASE_MAX_CELL_CHARS) {
    return `${value.slice(0, DATABASE_MAX_CELL_CHARS)}…`;
  }
  return value;
}

function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, sanitizeCell(value)]),
  );
}

function displayedValueBytes(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number") return 8;
  if (typeof value === "bigint") return Buffer.byteLength(String(value), "utf8");
  if (typeof value === "boolean") return value ? 4 : 5;
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function displayedRowBytes(row: Record<string, unknown>): number {
  let bytes = 2;
  for (const [key, value] of Object.entries(row)) {
    bytes += Buffer.byteLength(key, "utf8") + displayedValueBytes(value) + 4;
  }
  return bytes;
}

function bindable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string"
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function tableColumns(db: SqliteDb, table: string): DatabaseColumnView[] {
  return db
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all()
    .map((column) => ({
      name: String(column.name),
      type: String(column.type ?? "").toLowerCase() || "text",
      primaryKey: Number(column.pk) > 0,
      nullable: Number(column.notnull) === 0,
    }));
}

function rawTableRows(
  db: SqliteDb,
  table: string,
  offset: number,
): Array<Record<string, unknown>> {
  try {
    return db
      .prepare(
        `SELECT rowid AS __dohc_rowid, * FROM ${quoteIdent(table)} LIMIT ${DATABASE_MAX_ROWS} OFFSET ?`,
      )
      .all(offset);
  } catch {
    return db
      .prepare(
        `SELECT * FROM ${quoteIdent(table)} LIMIT ${DATABASE_MAX_ROWS} OFFSET ?`,
      )
      .all(offset);
  }
}

function hasTableRowAtOffset(
  db: SqliteDb,
  table: string,
  offset: number,
): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM ${quoteIdent(table)} LIMIT 1 OFFSET ?`).get(offset),
  );
}

function tablePage(
  db: SqliteDb,
  resultPath: string,
  table: string,
  offset: number,
): DatabasePageView {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Database page offset must be a non-negative integer.");
  }
  const rawRows = rawTableRows(db, table, offset);
  const rows: Array<Record<string, unknown>> = [];
  let bytes = 0;
  for (const rawRow of rawRows) {
    const row = sanitizeRow(rawRow);
    const rowBytes = displayedRowBytes(row);
    if (rows.length > 0 && bytes + rowBytes > DATABASE_PAGE_MAX_BYTES) break;
    rows.push(row);
    bytes += rowBytes;
  }
  const hasMore =
    rows.length < rawRows.length ||
    (rawRows.length === DATABASE_MAX_ROWS &&
      hasTableRowAtOffset(db, table, offset + rows.length));
  return {
    path: resultPath,
    table,
    offset,
    rows,
    nextOffset: hasMore ? offset + rows.length : null,
  };
}

export function readDatabaseSnapshotAtPath(
  absolutePath: string,
  resultPath: string,
): DatabaseSnapshotView {
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(absolutePath, { readOnly: true });
  try {
    const tableNames = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ${DATABASE_MAX_TABLES}`,
      )
      .all()
      .map((row) => String(row.name));
    return {
      path: resultPath,
      tables: tableNames.map((name) => {
        const page = tablePage(db, resultPath, name, 0);
        return {
          name,
          columns: tableColumns(db, name),
          rows: page.rows,
          nextOffset: page.nextOffset,
        };
      }),
    };
  } finally {
    db.close();
  }
}

export function readDatabasePageAtPath(input: {
  absolutePath: string;
  resultPath: string;
  table: string;
  offset: number;
}): DatabasePageView {
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(input.absolutePath, { readOnly: true });
  try {
    return tablePage(db, input.resultPath, input.table, input.offset);
  } finally {
    db.close();
  }
}

async function withTemporaryDatabase<T>(
  bytes: Uint8Array,
  run: (absolutePath: string) => T,
): Promise<T> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "dohc-database-worker-snapshot-"),
  );
  try {
    const absolutePath = join(temporaryRoot, `${randomUUID()}.sqlite`);
    await writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
    return run(absolutePath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function readDatabaseSnapshotFromBytesInWorker(
  bytes: Uint8Array,
  resultPath: string,
): Promise<DatabaseSnapshotView> {
  return withTemporaryDatabase(bytes, (absolutePath) =>
    readDatabaseSnapshotAtPath(absolutePath, resultPath),
  );
}

export function readDatabasePageFromBytesInWorker(input: {
  bytes: Uint8Array;
  resultPath: string;
  table: string;
  offset: number;
}): Promise<DatabasePageView> {
  return withTemporaryDatabase(input.bytes, (absolutePath) =>
    readDatabasePageAtPath({ ...input, absolutePath }),
  );
}

function runEdit(db: SqliteDb, edit: DatabaseEdit): void {
  const table = quoteIdent(edit.table);
  const primaryKey = quoteIdent(edit.pkColumn);
  if (edit.op === "delete") {
    db.prepare(`DELETE FROM ${table} WHERE ${primaryKey} = ?`).run(
      bindable(edit.rowId),
    );
    return;
  }
  const payload = edit.payload ?? {};
  if (edit.op === "update") {
    const columns = Object.keys(payload);
    if (columns.length === 0) return;
    const setClause = columns
      .map((column) => `${quoteIdent(column)} = ?`)
      .join(", ");
    db.prepare(`UPDATE ${table} SET ${setClause} WHERE ${primaryKey} = ?`).run(
      ...columns.map((column) => bindable(payload[column])),
      bindable(edit.rowId),
    );
    return;
  }
  const columns =
    edit.pkColumn in payload
      ? Object.keys(payload)
      : [edit.pkColumn, ...Object.keys(payload)];
  const values = columns.map((column) =>
    bindable(
      column === edit.pkColumn && !(column in payload)
        ? edit.rowId
        : payload[column],
    ),
  );
  const verb = edit.op === "upsert" ? "INSERT OR REPLACE" : "INSERT";
  db.prepare(
    `${verb} INTO ${table} (${columns.map(quoteIdent).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...values);
}

async function countLegacyOperations(logPath: string): Promise<number> {
  try {
    const text = await readFile(logPath, "utf8");
    return text.split("\n").filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function openCounter(statePath: string): SqliteDb {
  const { DatabaseSync } = nodeSqlite();
  const state = new DatabaseSync(statePath);
  state.exec("PRAGMA synchronous=FULL");
  state.exec(
    "CREATE TABLE IF NOT EXISTS database_operation_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
  );
  return state;
}

async function reserveOperationVersion(input: {
  logPath: string;
  statePath: string;
}): Promise<number> {
  const state = openCounter(input.statePath);
  let transactionOpen = false;
  try {
    state.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const row = state
      .prepare(
        "SELECT value FROM database_operation_state WHERE key = 'last_version'",
      )
      .get();
    const currentVersion = row
      ? Number(row.value)
      : await countLegacyOperations(input.logPath);
    const version = currentVersion + 1;
    if (!Number.isInteger(version) || version < 0) {
      throw new Error("Database operation version must be a non-negative integer");
    }
    state
      .prepare(
        "INSERT INTO database_operation_state (key, value) VALUES ('last_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(version);
    state.exec("COMMIT");
    transactionOpen = false;
    return version;
  } catch (error) {
    if (transactionOpen) {
      try {
        state.exec("ROLLBACK");
      } catch {
        // Preserve the error that made the counter transaction fail.
      }
    }
    throw error;
  } finally {
    state.close();
  }
}

async function appendOperationDurably(
  logPath: string,
  operation: DatabaseOperationInput & { version: number },
): Promise<void> {
  const handle = await open(logPath, "a", 0o600);
  try {
    await handle.appendFile(`${JSON.stringify(operation)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertNonEmptyOperationString(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Database operation ${field} must be a non-empty string`);
  }
}

function validateOperationInput(input: DatabaseOperationInput): void {
  assertNonEmptyOperationString(input.operationId, "operationId");
  assertNonEmptyOperationString(input.databasePath, "databasePath");
  assertNonEmptyOperationString(input.table, "table");
  assertNonEmptyOperationString(input.rowId, "rowId");
  if (!Number.isFinite(input.appliedAt) || input.appliedAt < 0) {
    throw new Error("Database operation appliedAt must be a valid timestamp");
  }
}

function createValidatedOperation(
  input: DatabaseOperationInput,
  version: number,
): DatabaseOperationInput & { version: number } {
  validateOperationInput(input);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error("Database operation version must be a non-negative integer");
  }
  return {
    operationId: input.operationId,
    databasePath: input.databasePath,
    table: input.table,
    op: input.op,
    rowId: input.rowId,
    payload: input.payload ?? {},
    version,
    appliedAt: input.appliedAt,
    author: input.author,
  };
}

export async function editDatabaseAtPath(input: {
  absolutePath: string;
  resultPath: string;
  logPath: string;
  statePath: string;
  edit: DatabaseEdit;
  operation: DatabaseOperationInput;
  pageOffset: number;
}): Promise<DatabaseEditResult> {
  validateOperationInput(input.operation);
  await mkdir(dirname(input.logPath), { recursive: true });
  await mkdir(dirname(input.statePath), { recursive: true });
  const version = await reserveOperationVersion(input);
  const operation = createValidatedOperation(input.operation, version);
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(input.absolutePath);
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    runEdit(db, input.edit);
    await appendOperationDurably(input.logPath, operation);
    db.exec("COMMIT");
    transactionOpen = false;
    const page = tablePage(
      db,
      input.resultPath,
      input.edit.table,
      input.pageOffset,
    );
    return {
      path: input.resultPath,
      table: input.edit.table,
      page: {
        offset: page.offset,
        rows: page.rows,
        nextOffset: page.nextOffset,
      },
      version,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original edit or durable-log failure.
      }
    }
    throw error;
  } finally {
    db.close();
  }
}
