import { databaseOpLogPath } from "@dohc/workspace-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyDatabaseEdit, importToDatabase, readDatabaseSnapshot } from "./workspaceDatabase";
import { createTestScratch } from "./testTemp";

let root: string;
const AUTHOR = { kind: "user", userId: "local" } as const;

beforeEach(async () => {
  root = await createTestScratch("dohc-db-");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await mkdir(join(root, "imports"), { recursive: true });
  await writeFile(
    join(root, "imports", "wallet.csv"),
    "id,amount,category\ntxn_001,42,Food\ntxn_002,10,Transport\n",
  );
});

describe("importToDatabase", () => {
  it("refuses to replace an existing database (edits are never silently dropped)", async () => {
    await importToDatabase(root, "imports/wallet.csv", "finance/wallet.sqlite", "transactions");
    await applyDatabaseEdit(
      root,
      "finance/wallet.sqlite",
      { table: "transactions", op: "update", pkColumn: "id", rowId: "txn_001", payload: { category: "Edited" } },
      AUTHOR,
      1_700_000_000_000,
    );
    // Re-importing the same CSV over the canonical, user-edited file must fail…
    await expect(
      importToDatabase(root, "imports/wallet.csv", "finance/wallet.sqlite", "transactions"),
    ).rejects.toThrow(/already exists/i);
    // …and the user's edit survives untouched.
    const snapshot = await readDatabaseSnapshot(root, "finance/wallet.sqlite");
    const row = snapshot.tables[0]?.rows.find((r) => String(r.id) === "txn_001");
    expect(row?.category).toBe("Edited");
  });

  it("materializes a visible SQLite file from a CSV and makes it queryable", async () => {
    const result = await importToDatabase(
      root,
      "imports/wallet.csv",
      "finance/wallet.sqlite",
      "transactions",
    );
    expect(result.path).toBe("finance/wallet.sqlite");
    expect(result.rowCount).toBe(2);

    const snapshot = await readDatabaseSnapshot(root, "finance/wallet.sqlite");
    const table = snapshot.tables.find((t) => t.name === "transactions");
    expect(table).toBeTruthy();
    expect(table?.rows).toHaveLength(2);
    expect(table?.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["id", "amount", "category"]),
    );
    expect(table?.rows.find((r) => String(r.id) === "txn_001")?.category).toBe("Food");
  });
});

describe("applyDatabaseEdit", () => {
  it("edits a row in place and records the edit in an inspectable op log", async () => {
    await importToDatabase(root, "imports/wallet.csv", "finance/wallet.sqlite", "transactions");

    const after = await applyDatabaseEdit(
      root,
      "finance/wallet.sqlite",
      { table: "transactions", op: "update", pkColumn: "id", rowId: "txn_001", payload: { category: "Groceries" } },
      AUTHOR,
      1_700_000_000_000,
    );
    expect(after.tables.find((t) => t.name === "transactions")?.rows.find((r) => String(r.id) === "txn_001")?.category)
      .toBe("Groceries");

    // The structured edit is recorded as inspectable JSONL under .dohc — raw
    // bytes are never the sync unit; this op log is.
    const log = await readFile(
      join(root, databaseOpLogPath("finance/wallet.sqlite")),
      "utf8",
    );
    const ops = log.trim().split("\n").map((l) => JSON.parse(l));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      databasePath: "finance/wallet.sqlite",
      table: "transactions",
      op: "update",
      rowId: "txn_001",
      version: 1,
      payload: { category: "Groceries" },
    });
  });

  it("stamps the persisted operationId from an injected createId seam", async () => {
    await importToDatabase(root, "imports/wallet.csv", "finance/wallet.sqlite", "transactions");
    await applyDatabaseEdit(
      root,
      "finance/wallet.sqlite",
      { table: "transactions", op: "update", pkColumn: "id", rowId: "txn_001", payload: { category: "Groceries" } },
      AUTHOR,
      1_700_000_000_000,
      { createId: () => "op_fixed_0001" },
    );
    const log = await readFile(join(root, databaseOpLogPath("finance/wallet.sqlite")), "utf8");
    const ops = log.trim().split("\n").map((l) => JSON.parse(l));
    // Both the injected id and the injected clock are deterministic in the log.
    expect(ops[0]).toMatchObject({ operationId: "op_fixed_0001", appliedAt: 1_700_000_000_000 });
  });

  it("edits exactly one row via rowid even when a guessed id column is duplicated", async () => {
    // An externally-created database where "id" is an ordinary, non-unique
    // column (imports declare id as a pk, but arbitrary user dbs don't).
    // createRequire because vite's resolver mishandles import("node:sqlite").
    const { createRequire } = await import("node:module");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): unknown };
        close(): void;
      };
    };
    await mkdir(join(root, "finance"), { recursive: true });
    const seed = new DatabaseSync(join(root, "finance", "dups.sqlite"));
    seed.exec("CREATE TABLE rows (id TEXT, amount INTEGER)");
    seed.prepare("INSERT INTO rows VALUES ('x', 1)").run();
    seed.prepare("INSERT INTO rows VALUES ('x', 2)").run();
    seed.close();

    const before = await readDatabaseSnapshot(root, "finance/dups.sqlite");
    const rows = before.tables[0]?.rows ?? [];
    expect(rows).toHaveLength(2);
    // Every row carries a unique SQLite rowid for edit identity.
    const rowids = rows.map((r) => r.__dohc_rowid);
    expect(new Set(rowids).size).toBe(2);

    const second = rows.find((r) => String(r.amount) === "2");
    await applyDatabaseEdit(
      root,
      "finance/dups.sqlite",
      { table: "rows", op: "update", pkColumn: "rowid", rowId: Number(second?.__dohc_rowid), payload: { amount: 99 } },
      AUTHOR,
      1_700_000_000_002,
    );

    // Only the targeted row changed — a WHERE on the duplicated "id" column
    // would have updated both.
    const after = await readDatabaseSnapshot(root, "finance/dups.sqlite");
    const amounts = (after.tables[0]?.rows ?? []).map((r) => String(r.amount)).sort();
    expect(amounts).toEqual(["1", "99"]);
  });

  it("persists edits across reopen (the on-disk file is canonical)", async () => {
    await importToDatabase(root, "imports/wallet.csv", "finance/wallet.sqlite", "transactions");
    await applyDatabaseEdit(
      root,
      "finance/wallet.sqlite",
      { table: "transactions", op: "delete", pkColumn: "id", rowId: "txn_002" },
      AUTHOR,
      1_700_000_000_001,
    );
    // Fresh read = fresh open of the file.
    const reopened = await readDatabaseSnapshot(root, "finance/wallet.sqlite");
    expect(reopened.tables.find((t) => t.name === "transactions")?.rows).toHaveLength(1);
  });
});
