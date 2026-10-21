import * as fs from "node:fs/promises";
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

it.each([false, true])("preserves rollback and the edit error when log close fails (invalid edit: %s)", async (invalid) => {
  const { input } = await editFixture();
  const open = fs.open;
  vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      await close();
      throw new Error("log close failed");
    });
    return handle;
  });
  await expect(editDatabaseAtPath({
    ...input, edit: { ...input.edit, table: invalid ? "missing" : "items" },
  })).rejects.toThrow(invalid ? /no such table: missing/ : /log close failed/);
  expect(readDatabaseSnapshotAtPath(input.absolutePath, "data.sqlite").tables[0]?.rows[0]?.value).toBe("before");
});
