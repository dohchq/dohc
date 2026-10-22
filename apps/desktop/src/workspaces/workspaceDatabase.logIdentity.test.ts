import * as fs from "node:fs/promises";
import { renameSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { editDatabaseAtPath, readDatabaseSnapshotAtPath } from "./workspaceDatabaseCore";
import { createTestScratch } from "./testTemp";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fs.lstat).mockReset(); vi.mocked(fs.open).mockReset(); });

it.each(["before open", "after open"])("refuses a log replaced %s before appending any edit", async (when) => {
  const root = await createTestScratch("dohc-database-log-identity-");
  const absolutePath = join(root, "data.sqlite");
  const db = new DatabaseSync(absolutePath);
  try {
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES (1, 'before')");
  } finally { db.close(); }
  const logPath = join(root, "operations.jsonl");
  const replacement = join(root, "replacement.jsonl");
  const parked = join(root, "original.jsonl");
  await fs.writeFile(logPath, "");
  await fs.writeFile(replacement, "replacement\n");
  const open = fs.open;
  vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const swap = async () => {
      await fs.rename(logPath, parked);
      await fs.rename(replacement, logPath);
    };
    if (when === "before open") await swap();
    const handle = await open(...args);
    if (when === "after open") await swap();
    return handle;
  });
  const edit = { table: "items", op: "update", pkColumn: "id", rowId: 1, payload: { value: "changed" } } as const;
  await expect(editDatabaseAtPath({
    absolutePath, resultPath: "data.sqlite", logPath, statePath: join(root, "state.sqlite"), edit, pageOffset: 0,
    storageIdentity: await fs.lstat(root, { bigint: true }),
    operation: {
      operationId: "swap", databasePath: "data.sqlite", table: "items", op: "update", rowId: "1",
      payload: edit.payload, appliedAt: 1, author: { kind: "user", userId: "local" },
    },
  })).rejects.toThrow(/changed while dohc opened it.*Stop other programs.*Then retry\./);
  expect(await fs.readFile(logPath, "utf8")).toBe("replacement\n");
  expect(await fs.readFile(parked, "utf8")).toBe("");
  expect(readDatabaseSnapshotAtPath(absolutePath, "data.sqlite").tables[0]?.rows[0]?.value).toBe("before");
}, 30_000);

async function editFixture() {
  const root = await createTestScratch("dohc-database-log-open-");
  const absolutePath = join(root, "data.sqlite");
  const db = new DatabaseSync(absolutePath);
  try {
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES (1, 'before')");
  } finally { db.close(); }
  const directory = join(root, "storage");
  await fs.mkdir(directory);
  const logPath = join(directory, "operations.jsonl");
  await fs.writeFile(logPath, "");
  const edit = { table: "items", op: "update", pkColumn: "id", rowId: 1, payload: { value: "changed" } } as const;
  return {
    root, directory,
    input: {
      absolutePath, resultPath: "data.sqlite", logPath, statePath: join(directory, "state.sqlite"), edit, pageOffset: 0,
      storageIdentity: await fs.lstat(directory, { bigint: true }),
      operation: {
        operationId: "open", databasePath: "data.sqlite", table: "items", op: "update", rowId: "1",
        payload: edit.payload, appliedAt: 1, author: { kind: "user", userId: "local" },
      } as const,
    },
  };
}

it("refuses a junction swapped in while opening the log before opening state SQLite", async () => {
  const { root, directory, input } = await editFixture();
  const outside = join(root, "outside");
  await fs.mkdir(outside);
  await fs.unlink(input.logPath);
  const open = fs.open;
  vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    await fs.rename(directory, `${directory}-parked`);
    await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
    return open(...args);
  });
  await expect(editDatabaseAtPath(input)).rejects.toThrow(/link.*must be a real folder/);
  expect(await fs.readdir(outside)).toEqual(["operations.jsonl"]);
  expect(await fs.readFile(join(outside, "operations.jsonl"), "utf8")).toBe("");
  expect(await fs.readdir(`${directory}-parked`)).toEqual([]);
  await expect(fs.lstat(join(`${directory}-parked`, "state.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(readDatabaseSnapshotAtPath(input.absolutePath, "data.sqlite").tables[0]?.rows[0]?.value).toBe("before");
});

it("refuses a hard-linked log in the worker without relying on the main-process guard", async () => {
  const { root, input } = await editFixture();
  const target = join(root, "other-log.jsonl");
  await fs.link(input.logPath, target);
  await expect(editDatabaseAtPath(input)).rejects.toThrow(/has another link/);
  expect(await fs.readFile(target, "utf8")).toBe("");
  await expect(fs.lstat(input.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(readDatabaseSnapshotAtPath(input.absolutePath, "data.sqlite").tables[0]?.rows[0]?.value).toBe("before");
});

it("counts through the checked log handle when its name becomes a link before reading", async () => {
  const { root, input } = await editFixture();
  const target = join(root, "outside.jsonl");
  const parked = join(root, "parked.jsonl");
  await fs.writeFile(input.logPath, '{"version":40}\n');
  await fs.writeFile(target, '{"version":999}\n');
  const open = vi.mocked(fs.open).getMockImplementation()!;
  vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const readLines = handle.readLines.bind(handle);
    vi.spyOn(handle, "readLines").mockImplementationOnce((options) => {
      renameSync(input.logPath, parked);
      symlinkSync(target, input.logPath, "file");
      return readLines(options);
    });
    return handle;
  });
  await expect(editDatabaseAtPath(input)).rejects.toThrow(/link.*must be a file/);
  expect(fs.open).toHaveBeenCalledTimes(1);
  const counter = new DatabaseSync(input.statePath);
  try {
    expect(counter.prepare("SELECT value FROM database_operation_state WHERE key = 'last_version'").get()?.value).toBe(41);
  } finally { counter.close(); }
  expect(await fs.readFile(target, "utf8")).toBe('{"version":999}\n');
  expect(await fs.readFile(parked, "utf8")).toBe('{"version":40}\n');
  expect(readDatabaseSnapshotAtPath(input.absolutePath, "data.sqlite").tables[0]?.rows[0]?.value).toBe("before");
});

it("accepts a log on a volume that reports zero links", async () => {
  const { input } = await editFixture();
  const lstat = vi.mocked(fs.lstat).getMockImplementation()!;
  vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const stats = await lstat(...args);
    return Object.assign(Object.create(stats), { nlink: typeof stats.nlink === "bigint" ? 0n : 0 });
  }) as typeof fs.lstat);
  const open = fs.open;
  vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const stats = await handle.stat({ bigint: true });
    vi.spyOn(handle, "stat").mockResolvedValueOnce(Object.assign(Object.create(stats), { nlink: 0n }));
    return handle;
  });
  await expect(editDatabaseAtPath(input)).resolves.toMatchObject({ version: 1 });
});

it("commits the row and matching log line when close fails after a successful sync", async () => {
  const { input } = await editFixture();
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const closeError = new Error("log close failed");
  let synced = false;
  const open = fs.open;
  vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
      await sync();
      synced = true;
    });
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      expect(synced).toBe(true);
      await close();
      throw closeError;
    });
    return handle;
  });
  const result = await editDatabaseAtPath(input);
  expect(result.version).toBe(1);
  expect(result.page.rows[0]?.value).toBe("changed");
  expect(readDatabaseSnapshotAtPath(input.absolutePath, "data.sqlite").tables[0]?.rows[0]?.value).toBe("changed");
  const lines = (await fs.readFile(input.logPath, "utf8")).trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({ ...input.operation, version: result.version });
  expect(reported).toHaveBeenCalledExactlyOnceWith("[desktop] database operation log close failed after sync:", closeError);
  await expect(editDatabaseAtPath(input)).resolves.toMatchObject({ version: 2 });
});

it.each(["edit", "sync"])("preserves rollback and the %s error when log close also fails", async (failure) => {
  const { input } = await editFixture();
  const open = fs.open;
  vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (failure === "sync") vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("log sync failed"));
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      await close();
      throw new Error("log close failed");
    });
    return handle;
  });
  await expect(editDatabaseAtPath({
    ...input, edit: { ...input.edit, table: failure === "edit" ? "missing" : "items" },
  })).rejects.toThrow(failure === "edit" ? /no such table: missing/ : /log sync failed/);
  expect(readDatabaseSnapshotAtPath(input.absolutePath, "data.sqlite").tables[0]?.rows[0]?.value).toBe("before");
});
