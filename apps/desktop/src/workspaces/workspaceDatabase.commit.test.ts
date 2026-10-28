import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { editDatabaseAtPath } from "./workspaceDatabaseCore";
import type { DatabaseOperationInput } from "./workspaceDatabaseTypes";
import { createTestScratch } from "./testTemp";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockReset();
});

async function fixture() {
  const root = await createTestScratch("dohc-database-commit-");
  const absolutePath = join(root, "data.sqlite");
  const db = new DatabaseSync(absolutePath);
  try {
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)");
  } finally { db.close(); }
  const logPath = join(root, "operations.jsonl");
  const storageIdentity = await fs.lstat(root, { bigint: true });
  const inputFor = (rowId: number) => ({
    absolutePath, resultPath: "data.sqlite", logPath, statePath: join(root, "state.sqlite"),
    storageIdentity, pageOffset: 0,
    edit: { table: "items", op: "insert", pkColumn: "id", rowId, payload: { value: `café ${rowId}` } } as const,
    operation: {
      operationId: `insert-${rowId}`, databasePath: "data.sqlite", table: "items", op: "insert", rowId: String(rowId),
      payload: { value: `café ${rowId}` }, appliedAt: rowId, author: { kind: "user", userId: "local" },
    } as const,
  });
  await editDatabaseAtPath(inputFor(1));
  await editDatabaseAtPath(inputFor(2));
  const prefix = await fs.readFile(logPath, "utf8");
  const rows = () => {
    const reader = new DatabaseSync(absolutePath, { readOnly: true });
    try { return reader.prepare("SELECT * FROM items ORDER BY id").all(); }
    finally { reader.close(); }
  };
  return { input: inputFor(3), inputFor, prefix, rows };
}

const committedRows = [{ id: 1, value: "café 1" }, { id: 2, value: "café 2" }];

async function expectAppended(logPath: string, prefix: string, operation: DatabaseOperationInput, version: number) {
  const log = await fs.readFile(logPath, "utf8");
  expect(log.slice(0, prefix.length)).toBe(prefix);
  expect(JSON.parse(log.slice(prefix.length))).toEqual({ ...operation, version });
}

it("removes a real busy-COMMIT append, keeps committed lines, and gives the next edit v+1", async () => {
  const { input, inputFor, prefix, rows } = await fixture();
  const reader = new DatabaseSync(input.absolutePath);
  try {
    reader.exec("BEGIN");
    expect(reader.prepare("SELECT * FROM items ORDER BY id").all()).toEqual(committedRows);
    await expect(editDatabaseAtPath(input)).rejects.toThrow(/database is locked/);
    reader.exec("ROLLBACK");
    expect(rows()).toEqual(committedRows);
    expect(await fs.readFile(input.logPath, "utf8")).toBe(prefix);

    const later = inputFor(4);
    const result = await editDatabaseAtPath(later);
    expect(result.version).toBe(4);
    expect(rows()).toEqual([...committedRows, { id: 4, value: "café 4" }]);
    await expectAppended(input.logPath, prefix, later.operation, 4);
  } finally {
    reader.close();
  }
});

it.each(["append", "partial append", "sync", "edit"])("restores the committed prefix after an %s failure", async (failure) => {
  const { input, prefix, rows } = await fixture();
  const originalError = new Error(`${failure} failed`);
  const open = fs.open;
  vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (failure === "sync") vi.spyOn(handle, "sync").mockRejectedValueOnce(originalError);
    if (failure === "append" || failure === "partial append") {
      const append = handle.appendFile.bind(handle);
      vi.spyOn(handle, "appendFile").mockImplementationOnce(async (line) => {
        // Cut inside the multibyte payload to exercise byte-based tail matching.
        if (failure === "partial append") {
          const bytes = Buffer.from(String(line));
          await append(bytes.subarray(0, bytes.indexOf(Buffer.from("é")) + 1));
        }
        throw originalError;
      });
    }
    return handle;
  });
  const editInput = failure === "edit" ? { ...input, edit: { ...input.edit, table: "missing" } } : input;
  const result = expect(editDatabaseAtPath(editInput)).rejects;
  if (failure === "edit") await result.toThrow(/no such table: missing/);
  else await result.toBe(originalError);
  expect(rows()).toEqual(committedRows);
  expect(await fs.readFile(input.logPath, "utf8")).toBe(prefix);
});

it.each(["different tail", "extended tail"])("keeps another program's %s on rollback", async (failure) => {
  const { input, prefix, rows } = await fixture();
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const originalError = new Error("append interrupted by external writer");
  let externalTail = "";
  const open = fs.open;
  vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const append = handle.appendFile.bind(handle);
    vi.spyOn(handle, "appendFile").mockImplementationOnce(async (line) => {
      externalTail = failure === "different tail" ? "external\n" : `${String(line)}external\n`;
      await append(externalTail);
      throw originalError;
    });
    return handle;
  });
  await expect(editDatabaseAtPath(input)).rejects.toBe(originalError);
  expect(rows()).toEqual(committedRows);
  expect(await fs.readFile(input.logPath, "utf8")).toBe(prefix + externalTail);
  expect(reported).toHaveBeenCalledExactlyOnceWith("[desktop] database operation log restore failed:", expect.any(Error));
});

it.each(["truncate", "sync"] as const)("reports a restore %s failure and preserves the original error", async (failure) => {
  const { input, prefix, rows } = await fixture();
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const originalError = new Error("append sync failed");
  const restoreError = new Error(`restore ${failure} failed`);
  const open = vi.mocked(fs.open).getMockImplementation()!;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[1] === "a+") vi.spyOn(handle, "sync").mockRejectedValueOnce(originalError);
    if (args[1] === "r+") vi.spyOn(handle, failure).mockRejectedValueOnce(restoreError);
    return handle;
  });
  await expect(editDatabaseAtPath(input)).rejects.toBe(originalError);
  expect(rows()).toEqual(committedRows);
  if (failure === "truncate") await expectAppended(input.logPath, prefix, input.operation, 3);
  else expect(await fs.readFile(input.logPath, "utf8")).toBe(prefix);
  expect(reported).toHaveBeenCalledExactlyOnceWith("[desktop] database operation log restore failed:", restoreError);
});

it("keeps the line when COMMIT ends the transaction and then throws", async () => {
  const { input, prefix, rows } = await fixture();
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const originalError = new Error("COMMIT failed after ending the transaction");
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
    exec.call(this, sql);
    if (sql === "COMMIT" && this.prepare("SELECT name FROM sqlite_master WHERE name = 'items'").get()) {
      expect(this.isTransaction).toBe(false);
      throw originalError;
    }
  });
  await expect(editDatabaseAtPath(input)).rejects.toBe(originalError);
  expect(rows()).toEqual([...committedRows, { id: 3, value: "café 3" }]);
  await expectAppended(input.logPath, prefix, input.operation, 3);
  expect(reported).toHaveBeenCalledExactlyOnceWith("[desktop] database operation log restore failed:", expect.any(Error));
});

it("keeps the committed row and line when reading the result page fails", async () => {
  const { input, prefix, rows } = await fixture();
  const originalError = new Error("result page failed");
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
    if (sql.startsWith("SELECT rowid AS") || sql.startsWith('SELECT * FROM "items" LIMIT')) throw originalError;
    return prepare.call(this, sql);
  });
  await expect(editDatabaseAtPath(input)).rejects.toBe(originalError);
  expect(rows()).toEqual([...committedRows, { id: 3, value: "café 3" }]);
  await expectAppended(input.logPath, prefix, input.operation, 3);
});

it("keeps the committed row and line when closing SQLite fails", async () => {
  const { input, prefix, rows } = await fixture();
  const originalError = new Error("database close failed");
  const close = DatabaseSync.prototype.close;
  vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: InstanceType<typeof DatabaseSync>) {
    const edited = this.prepare("SELECT name FROM sqlite_master WHERE name = 'items'").get();
    close.call(this);
    if (edited) throw originalError;
  });
  await expect(editDatabaseAtPath(input)).rejects.toBe(originalError);
  vi.restoreAllMocks();
  expect(rows()).toEqual([...committedRows, { id: 3, value: "café 3" }]);
  await expectAppended(input.logPath, prefix, input.operation, 3);
});
