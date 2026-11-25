import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createDatasetJournal } from "./journal.ts";
import { createDatasetSupervisor } from "./supervisor.ts";
import { createDatasetHost } from "./dataset-host.ts";
import { createDatasetReplica, type DatasetReplicaSource } from "./replica.ts";
import { createDatasetReplicaHost } from "./replica-host.ts";
import { privateFolder } from "./private-folder.test-helper";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const schemaSql =
  "CREATE TABLE ledger(id TEXT PRIMARY KEY NOT NULL, memo TEXT NOT NULL, cents INTEGER NOT NULL) STRICT; CREATE INDEX idx_ledger_cents ON ledger(cents);";
const operationSource = `globalThis.operations = {
  addEntry(ctx, input) {
    if (input.cents === 0) ctx.refuse("zero_amount", "Amount must not be zero.");
    ctx.db.execute("INSERT INTO ledger(id, memo, cents) VALUES(?, ?, ?)", [input.id, input.memo, input.cents]);
    return { id: input.id };
  },
  listEntries(ctx) {
    return ctx.db.query("SELECT id, memo, cents FROM ledger ORDER BY id");
  }
};`;

const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: id(10),
  name: "Ledger",
  schemaPath: "ledger/schema.sql",
  operationsPath: "ledger/operations.js",
  tables: [
    {
      tableId: id(11),
      name: "Ledger",
      sqlName: "ledger",
      primaryKey: "id",
      fields: [
        {
          fieldId: id(12),
          name: "ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
        },
        {
          fieldId: id(13),
          name: "Memo",
          sqlColumn: "memo",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: id(14),
          name: "Cents",
          sqlColumn: "cents",
          type: "number",
          required: true,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: id(15),
      name: "addEntry",
      label: "Add entry",
      tableId: id(11),
      kind: "create",
      access: "owner",
      readOnly: false,
      fieldIds: [id(12), id(13), id(14)],
    },
    {
      operationId: id(16),
      name: "listEntries",
      label: "List entries",
      tableId: id(11),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [id(12), id(13), id(14)],
    },
  ],
};

async function setupHost() {
  const dir = await mkdtemp(join(tmpdir(), "dohc-inspector-"));
  const db = new DatabaseSync(join(dir, "host.sqlite"));
  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  };
  const journal = createDatasetJournal({ db, transaction });
  const supervisor = await createDatasetSupervisor({
    journal,
    directory: privateFolder(join(dir, "workers")),
    reopenWaitCapMs: 0,
  });
  const host = createDatasetHost<"owner" | "guest">({
    db,
    transaction,
    journal,
    supervisor,
    resolveAuthority(context) {
      if (context === "owner")
        return { caller: { kind: "owner", userId: "u1" }, principalKey: "u1" };
      return { caller: { kind: "link", principalId: "p1", grantId: "g1" }, principalKey: "p1" };
    },
  });
  cleanups.push(async () => {
    await supervisor.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const rev = describeDatasetRevision({
    definition,
    revision: 1,
    schemaSql,
    operationSource,
  });
  await host.activate("owner", {
    workspaceId: "ws1",
    revision: rev,
    schemaSql,
    operationSource,
  });
  return { dir, db, journal, host, rev };
}

describe("dataset inspector SQL and trace", () => {
  it("runs owner read-only SELECT and EXPLAIN QUERY PLAN, refuses writes/PRAGMAs/internal tables, and enforces limits", async () => {
    const { host, rev } = await setupHost();
    for (let i = 1; i <= 5; i++) {
      await host.invoke("owner", {
        workspaceId: "ws1",
        datasetId: rev.datasetId,
        revision: rev.revision,
        revisionSha256: rev.revisionSha256,
        operationId: id(15),
        input: { id: `e${i}`, memo: `Item ${i}`, cents: i * 100 },
        idempotencyKey: `add-${i}`,
      });
    }

    const queried = await host.querySql("owner", {
      workspaceId: "ws1",
      datasetId: rev.datasetId,
      sql: "SELECT id, memo, cents FROM ledger WHERE cents >= ? ORDER BY cents",
      params: [300],
    });
    expect(queried.explain).toBe(false);
    expect(queried.truncated).toBe(false);
    expect(queried.revision).toBe(5);
    expect(queried.columns).toEqual(["id", "memo", "cents"]);
    expect(queried.rows).toEqual([
      ["e3", "Item 3", 300],
      ["e4", "Item 4", 400],
      ["e5", "Item 5", 500],
    ]);

    const joined = await host.querySql("owner", {
      workspaceId: "ws1",
      datasetId: rev.datasetId,
      sql: "SELECT a.id, b.id, 9007199254740993 AS big FROM ledger a JOIN ledger b ON b.cents = a.cents + 100 WHERE a.id = 'e1'",
    });
    expect(joined.columns).toEqual(["id", "id", "big"]);
    expect(joined.rows).toEqual([["e1", "e2", "9007199254740993"]]);

    const limited = await host.querySql("owner", {
      workspaceId: "ws1",
      datasetId: rev.datasetId,
      sql: "SELECT id FROM ledger ORDER BY id",
      limit: 2,
    });
    expect(limited.rows).toEqual([["e1"], ["e2"]]);
    expect(limited.truncated).toBe(true);

    const plan = await host.querySql("owner", {
      workspaceId: "ws1",
      datasetId: rev.datasetId,
      sql: "SELECT id FROM ledger WHERE cents = ?",
      params: [300],
      explain: true,
    });
    expect(plan.explain).toBe(true);
    const detail = plan.columns.indexOf("detail");
    expect(plan.rows.some((row) => /SEARCH|SCAN/i.test(String(row[detail])))).toBe(true);

    for (const forbidden of [
      "DELETE FROM ledger",
      "INSERT INTO ledger VALUES('x','y',1)",
      "UPDATE ledger SET cents = 0",
      "DROP TABLE ledger",
      "PRAGMA table_info(ledger)",
      "PRAGMA journal_mode",
      "SELECT * FROM dohc_applied",
      "SELECT * FROM sqlite_schema",
      "SELECT * FROM sqlite_master",
    ]) {
      await expect(
        host.querySql("owner", { workspaceId: "ws1", datasetId: rev.datasetId, sql: forbidden }),
      ).rejects.toThrow(/Only read-only SELECT queries/);
    }

    await expect(
      host.querySql("owner", {
        workspaceId: "ws1",
        datasetId: rev.datasetId,
        sql: "SELECT 1; DELETE FROM ledger",
      }),
    ).rejects.toThrow(/one SQL statement/);

    await expect(
      host.querySql("owner", {
        workspaceId: "ws1",
        datasetId: rev.datasetId,
        sql: "EXPLAIN SELECT * FROM ledger",
      }),
    ).rejects.toThrow(/explain: true/);

    await expect(
      host.querySql("guest", {
        workspaceId: "ws1",
        datasetId: rev.datasetId,
        sql: "SELECT * FROM ledger",
      }),
    ).rejects.toThrow();

    expect(() => host.trace("guest", { workspaceId: "ws1", datasetId: rev.datasetId })).toThrow(
      /do not have access/,
    );

    const after = await host.querySql("owner", {
      workspaceId: "ws1",
      datasetId: rev.datasetId,
      sql: "SELECT count(*) AS n FROM ledger",
    });
    expect(after.rows).toEqual([[5]]);
  }, 30_000);

  it("bounds the in-memory trace ring buffer to 200 entries with metrics and refusal codes", async () => {
    const { dir, host, rev } = await setupHost();
    const filesBefore = await readdir(dir);

    await host.invoke("owner", {
      workspaceId: "ws1",
      datasetId: rev.datasetId,
      revision: rev.revision,
      revisionSha256: rev.revisionSha256,
      operationId: id(15),
      input: { id: "e1", memo: "First", cents: 250 },
      idempotencyKey: "write-1",
    });

    await expect(
      host.invoke("owner", {
        workspaceId: "ws1",
        datasetId: rev.datasetId,
        revision: rev.revision,
        revisionSha256: rev.revisionSha256,
        operationId: id(15),
        input: { id: "e2", memo: "Zero", cents: 0 },
        idempotencyKey: "write-zero",
      }),
    ).rejects.toThrow(/Amount must not be zero/);

    for (let i = 0; i < 205; i++) {
      await host.invoke("owner", {
        workspaceId: "ws1",
        datasetId: rev.datasetId,
        revision: rev.revision,
        revisionSha256: rev.revisionSha256,
        operationId: id(16),
        input: {},
        idempotencyKey: `read-${i}`,
      });
    }

    const full = host.trace("owner", { workspaceId: "ws1", datasetId: rev.datasetId, limit: 200 });
    expect(full.entries).toHaveLength(200);
    expect(full.entries[0]).toMatchObject({
      operation: "listEntries",
      statementCount: 1,
      rowsRead: 1,
      changesetBytes: 0,
      callerKind: "owner",
      revision: 1,
      status: "ok",
      refusalCode: null,
    });

    await expect(
      host.invoke("owner", {
        workspaceId: "ws1",
        datasetId: rev.datasetId,
        revision: rev.revision,
        revisionSha256: rev.revisionSha256,
        operationId: id(15),
        input: { id: "e3", memo: "Bad", cents: 0 },
        idempotencyKey: "write-zero-2",
      }),
    ).rejects.toThrow();

    await host.invoke("owner", {
      workspaceId: "ws1",
      datasetId: rev.datasetId,
      revision: rev.revision,
      revisionSha256: rev.revisionSha256,
      operationId: id(15),
      input: { id: "e4", memo: "Second", cents: 500 },
      idempotencyKey: "write-4",
    });

    const latest = host.trace("owner", { workspaceId: "ws1", datasetId: rev.datasetId, limit: 3 });
    expect(latest.entries[0]).toMatchObject({
      operation: "addEntry",
      statementCount: 1,
      callerKind: "owner",
      revision: 2,
      status: "ok",
      refusalCode: null,
    });
    expect(latest.entries[0]!.changesetBytes).toBeGreaterThan(0);
    expect(latest.entries[1]).toMatchObject({
      operation: "addEntry",
      status: "refused",
      refusalCode: "zero_amount",
      revision: null,
    });

    const filesAfter = await readdir(dir);
    expect(filesAfter.filter((name) => /trace/i.test(name))).toEqual([]);
    expect(filesBefore.filter((name) => /trace/i.test(name))).toEqual([]);
  }, 60_000);

  it("supports read-only SQL and EXPLAIN on a synced DatasetReplica copy", async () => {
    const { dir, journal, host, rev } = await setupHost();
    await host.invoke("owner", {
      workspaceId: "ws1",
      datasetId: rev.datasetId,
      revision: rev.revision,
      revisionSha256: rev.revisionSha256,
      operationId: id(15),
      input: { id: "r1", memo: "Synced", cents: 999 },
      idempotencyKey: "sync-1",
    });

    const replicaHost = createDatasetReplicaHost({ journal, owner: () => "u1" });
    const scope = { workspaceId: "ws1", datasetId: rev.datasetId };
    const source: DatasetReplicaSource = {
      capture: async () => replicaHost.replicaCapture("owner", scope),
      page: async ({ through, after, limit }) =>
        replicaHost.replicaPage("owner", { ...scope, through, after, limit }),
      blob: async ({ record, offset, length }) =>
        replicaHost.replicaBlob("owner", { ...scope, record, offset, length }),
    };
    const replicaDir = await mkdtemp(join(dir, "replica-"));
    const replica = await createDatasetReplica({
      directory: replicaDir,
      scope,
      ownerKey: "u1",
      origin: "https://sync.example.test",
      assertOwner: () => {},
    });
    cleanups.push(() => replica.close());

    await replica.catchUp(source);

    const queried = await replica.querySql({
      sql: "SELECT id, memo, cents FROM ledger WHERE cents = ?",
      params: [999],
    });
    expect(queried.rows).toEqual([["r1", "Synced", 999]]);
    expect(queried.revision).toBe(1);

    const plan = await replica.querySql({
      sql: "SELECT id FROM ledger WHERE cents = ?",
      params: [999],
      explain: true,
    });
    expect(plan.explain).toBe(true);
    expect(plan.rows.length).toBeGreaterThan(0);

    await expect(replica.querySql({ sql: "DELETE FROM ledger" })).rejects.toThrow(
      /Only read-only SELECT queries/,
    );
    await expect(replica.querySql({ sql: "SELECT * FROM dohc_applied" })).rejects.toThrow(
      /Only read-only SELECT queries/,
    );
    const stillWarm = await replica.querySql({ sql: "SELECT count(*) AS n FROM ledger" });
    expect(stillWarm.rows).toEqual([[1]]);
  }, 30_000);
});
