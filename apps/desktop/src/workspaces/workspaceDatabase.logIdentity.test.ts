import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { editDatabaseAtPath, readDatabaseSnapshotAtPath } from "./workspaceDatabaseCore";
import { createTestScratch } from "./testTemp";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
afterEach(() => { vi.restoreAllMocks(); });

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
    operation: {
      operationId: "swap", databasePath: "data.sqlite", table: "items", op: "update", rowId: "1",
      payload: edit.payload, appliedAt: 1, author: { kind: "user", userId: "local" },
    },
  })).rejects.toThrow(/changed while dohc opened it.*Stop other programs.*Then retry\./);
  expect(await fs.readFile(logPath, "utf8")).toBe("replacement\n");
  expect(await fs.readFile(parked, "utf8")).toBe("");
  expect(readDatabaseSnapshotAtPath(absolutePath, "data.sqlite").tables[0]?.rows[0]?.value).toBe("before");
}, 30_000);
