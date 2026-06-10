import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyDatabaseEdit, importToDatabase, readDatabaseSnapshot } from "./workspaceDatabase";

let root: string;
const AUTHOR = { kind: "user", userId: "local" } as const;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-db-"));
  await mkdir(join(root, ".dohc"), { recursive: true });
  await mkdir(join(root, "imports"), { recursive: true });
  await writeFile(
    join(root, "imports", "wallet.csv"),
    "id,amount,category\ntxn_001,42,Food\ntxn_002,10,Transport\n",
  );
});

describe("importToDatabase", () => {
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
      join(root, ".dohc", "databases", "finance_wallet.sqlite", "operations.jsonl"),
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
