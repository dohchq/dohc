import {
  createDatabaseOperation,
  databaseOpLogPath,
} from "@dohc/workspace-core";
import {
  copyFile,
  link,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorkspaceFileRead } from "./workspaceAssets";
import { readPreparedDatabaseSnapshot } from "./workspaceDatabase";
import {
  DATABASE_MAX_CELL_CHARS,
  DATABASE_MAX_ROWS,
  editDatabaseAtPath,
  readDatabaseSnapshotAtPath,
} from "./workspaceDatabaseCore";
import type {
  DatabaseEdit,
  DatabaseOperationInput,
} from "./workspaceDatabaseTypes";
import {
  createWorkspaceDatabaseWorkerOwner,
  type WorkspaceDatabaseWorkerOwner,
} from "./workspaceDatabaseWorker";
import { createSuiteTestScratchSync, createTestScratch } from "./testTemp";

interface SeedStatement {
  run(...params: unknown[]): unknown;
}

interface SeedDatabase {
  exec(sql: string): void;
  prepare(sql: string): SeedStatement;
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => SeedDatabase;
};

const owners = new Set<WorkspaceDatabaseWorkerOwner>();
const AUTHOR = { kind: "user", userId: "local" } as const;
const UPDATE: DatabaseEdit = {
  table: "items",
  op: "update",
  pkColumn: "id",
  rowId: 1,
  payload: { value: "changed" },
};

const IMPORT_SOURCE = {
  name: "data.csv", mediaType: "text/csv", tableName: "imported data",
  body: 'id,title,amount\nr1,"one,two",4.5\nr2,"line one\nline two",7',
};

function owner(
  options: Parameters<typeof createWorkspaceDatabaseWorkerOwner>[0] = {},
): WorkspaceDatabaseWorkerOwner {
  const created = createWorkspaceDatabaseWorkerOwner(options);
  owners.add(created);
  return created;
}

describe("database import worker", () => {
  it("materializes complete rows and normalized schema without returning a duplicate snapshot", async () => {
    const worker = owner();
    const result = await worker.importData(IMPORT_SOURCE);
    expect(Object.keys(result).sort()).toEqual(["bytes", "rowCount", "tableName"]);
    expect(result).toMatchObject({ rowCount: 2, tableName: "imported_data" });
    const snapshot = await worker.readBytes({ bytes: result.bytes, path: "import.sqlite" });
    expect(snapshot.tables[0]?.rows).toEqual([
      expect.objectContaining({ id: "r1", title: "one,two", amount: 4.5 }),
      expect.objectContaining({ id: "r2", title: "line one\nline two", amount: 7 }),
    ]);
  });

  it("preserves import errors and can handle another request after rejection", async () => {
    const worker = owner();
    await expect(worker.importData({ ...IMPORT_SOURCE, body: "id,title" }))
      .rejects.toThrow("Import failed (empty-import-source): Import source did not contain any rows.");
    await expect(worker.importData(IMPORT_SOURCE)).resolves.toMatchObject({ rowCount: 2 });
  });

  it("cancels an import queued behind another request before it starts", async () => {
    const started: string[] = [];
    const worker = owner({ onRequestStarted: (request) => started.push(request.kind) });
    const first = worker.importData(IMPORT_SOURCE);
    const abort = new AbortController();
    const cancelled = worker.importData(IMPORT_SOURCE, abort.signal);
    abort.abort();
    await expect(cancelled).rejects.toThrow("Database import was cancelled.");
    await first;
    expect(started).toEqual(["import-data"]);
  });

  it("drains a started import on cancellation and remains usable", async () => {
    const abort = new AbortController();
    const worker = owner({ onRequestStarted: () => abort.abort() });
    await expect(worker.importData(IMPORT_SOURCE, abort.signal))
      .rejects.toThrow("Database import was cancelled.");
    await expect(worker.importData(IMPORT_SOURCE)).resolves.toMatchObject({ rowCount: 2 });
  });
});

afterEach(async () => {
  await Promise.all([...owners].map((created) => created.dispose()));
  owners.clear();
});

function seedDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        value TEXT,
        amount REAL,
        optional TEXT,
        payload BLOB
      );
      CREATE TABLE labels (id TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
    `);
    db.prepare(
      "INSERT INTO items (id, value, amount, optional, payload) VALUES (?, ?, ?, ?, ?)",
    ).run(
      1,
      "start",
      12.5,
      null,
      new Uint8Array([1, 2, 3, 4]),
    );
    db.prepare(
      "INSERT INTO items (id, value, amount, optional, payload) VALUES (?, ?, ?, ?, ?)",
    ).run(2, "x".repeat(DATABASE_MAX_CELL_CHARS + 20), 7, "present", null);
    db.prepare("INSERT INTO labels (id, value) VALUES (?, ?)").run(
      "label-1",
      "without rowid",
    );
  } finally {
    db.close();
  }
}

function seedPagedDatabase(path: string, rows: number, wide: boolean): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT);
      WITH RECURSIVE sequence(value) AS (
        VALUES(1)
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < ${rows}
      )
      INSERT INTO items (id, a, b, c)
      SELECT value,
             ${wide ? "printf('%.*c', 4096, 'x')" : "'a'"},
             ${wide ? "printf('%.*c', 4096, 'y')" : "'b'"},
             ${wide ? "printf('%.*c', 4096, 'z')" : "'c'"}
      FROM sequence;
    `);
  } finally {
    db.close();
  }
}

let wideDatabaseSeed: string | undefined;
async function copyWideDatabaseSeed(path: string): Promise<void> {
  if (!wideDatabaseSeed) {
    const seed = join(createSuiteTestScratchSync("dohc-db-worker-seed-"), "wide.sqlite");
    seedPagedDatabase(seed, 1000, true);
    wideDatabaseSeed = seed;
  }
  await copyFile(wideDatabaseSeed, path);
}

function operation(
  operationId: string,
  edit: DatabaseEdit = UPDATE,
): DatabaseOperationInput {
  return {
    operationId,
    databasePath: "data.sqlite",
    table: edit.table,
    op: edit.op,
    rowId: String(edit.rowId),
    payload: edit.payload ?? {},
    appliedAt: 1_700_000_000_000,
    author: AUTHOR,
  };
}

function editPaths(root: string) {
  const logPath = join(root, databaseOpLogPath("data.sqlite"));
  return {
    logPath,
    statePath: join(dirname(logPath), "state.sqlite"),
  };
}

async function logOperations(logPath: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(logPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("workspace database worker", () => {
  it("round-trips the old in-process read and edit results through the actual worker", async () => {
    const root = await createTestScratch("dohc-db-worker-differential-");
    const directPath = join(root, "direct.sqlite");
    const workerPath = join(root, "worker.sqlite");
    seedDatabase(directPath);
    await copyFile(directPath, workerPath);
    const expected = readDatabaseSnapshotAtPath(directPath, "data.sqlite");
    const databaseWorker = owner();

    const actual = await databaseWorker.readPath({
      absolutePath: workerPath,
      path: "data.sqlite",
    });
    const actualFromBytes = await databaseWorker.readBytes({
      bytes: await readFile(workerPath),
      path: "data.sqlite",
    });

    expect(actual).toEqual(expected);
    expect(actualFromBytes).toEqual(expected);
    expect(actual.tables[0]?.rows[0]).toMatchObject({
      __dohc_rowid: 1,
      payload: "<blob 4 bytes>",
      optional: null,
    });
    expect(String(actual.tables[0]?.rows[1]?.value)).toHaveLength(
      DATABASE_MAX_CELL_CHARS + 1,
    );
    expect(actual.tables[1]?.rows[0]).not.toHaveProperty("__dohc_rowid");

    const directRoot = join(root, "direct-state");
    const workerRoot = join(root, "worker-state");
    const directState = editPaths(directRoot);
    const workerState = editPaths(workerRoot);
    const expectedEdit = await editDatabaseAtPath({
      absolutePath: directPath,
      resultPath: "data.sqlite",
      ...directState,
      edit: UPDATE,
      operation: operation("op-differential"),
      pageOffset: 0,
    });
    const actualEdit = await databaseWorker.editPath({
      absolutePath: workerPath,
      path: "data.sqlite",
      ...workerState,
      edit: UPDATE,
      operation: operation("op-differential"),
    });

    expect(actualEdit).toEqual(expectedEdit);
    expect(readDatabaseSnapshotAtPath(workerPath, "data.sqlite")).toEqual(
      readDatabaseSnapshotAtPath(directPath, "data.sqlite"),
    );
    expect(await logOperations(workerState.logPath)).toEqual(
      await logOperations(directState.logPath),
    );
  });

  it("serializes concurrent edits in submission order", async () => {
    const root = await createTestScratch("dohc-db-worker-order-");
    const databasePath = join(root, "data.sqlite");
    seedDatabase(databasePath);
    const paths = editPaths(root);
    const databaseWorker = owner();
    const values = Array.from({ length: 12 }, (_, index) => `value-${index + 1}`);

    const results = await Promise.all(
      values.map((value, index) => {
        const edit = { ...UPDATE, payload: { value } };
        return databaseWorker.editPath({
          absolutePath: databasePath,
          path: "data.sqlite",
          ...paths,
          edit,
          operation: operation(`op-${index + 1}`, edit),
        });
      }),
    );

    expect(results.map((result) => result.version)).toEqual(
      values.map((_, index) => index + 1),
    );
    const logged = await logOperations(paths.logPath);
    expect(logged.map((entry) => entry.version)).toEqual(
      values.map((_, index) => index + 1),
    );
    expect(logged.map((entry) => entry.payload)).toEqual(
      values.map((value) => ({ value })),
    );
    expect(
      readDatabaseSnapshotAtPath(databasePath, "data.sqlite").tables[0]?.rows[0]
        ?.value,
    ).toBe(values.at(-1));
  });

  it("preserves operation validation and JSONL field order", async () => {
    const root = await createTestScratch("dohc-db-worker-operation-");
    const databasePath = join(root, "data.sqlite");
    seedDatabase(databasePath);
    const paths = editPaths(root);
    const databaseWorker = owner();
    const validOperation = operation("op-field-order");

    await databaseWorker.editPath({
      absolutePath: databasePath,
      path: "data.sqlite",
      ...paths,
      edit: UPDATE,
      operation: validOperation,
    });

    const [logged] = await logOperations(paths.logPath);
    expect(Object.keys(logged!)).toEqual([
      "operationId",
      "databasePath",
      "table",
      "op",
      "rowId",
      "payload",
      "version",
      "appliedAt",
      "author",
    ]);

    const invalidOperations = [
      { ...operation(" ") },
      { ...operation("op-invalid-path"), databasePath: "" },
      { ...operation("op-invalid-table"), table: "\t" },
      { ...operation("op-invalid-row"), rowId: "" },
      { ...operation("op-invalid-time"), appliedAt: Number.NaN },
    ];
    for (const invalidOperation of invalidOperations) {
      let expectedError: unknown;
      try {
        createDatabaseOperation({ ...invalidOperation, version: 2 });
      } catch (error) {
        expectedError = error;
      }
      await expect(
        databaseWorker.editPath({
          absolutePath: databasePath,
          path: "data.sqlite",
          ...paths,
          edit: UPDATE,
          operation: invalidOperation,
        }),
      ).rejects.toThrow((expectedError as Error).message);
    }
    expect(await logOperations(paths.logPath)).toHaveLength(1);
  });

  it("surfaces a crash for the active request and lazily restarts on the next request", async () => {
    const root = await createTestScratch("dohc-db-worker-crash-");
    const databasePath = join(root, "large.sqlite");
    await copyWideDatabaseSeed(databasePath);
    const workers: Worker[] = [];
    const started = Promise.withResolvers<void>();
    const databaseWorker = owner({
      workerFactory(url) {
        const worker = new Worker(url);
        workers.push(worker);
        return worker;
      },
      onRequestStarted() {
        started.resolve();
      },
    });
    const pending = databaseWorker.readPath({
      absolutePath: databasePath,
      path: "large.sqlite",
    });
    await started.promise;
    await workers[0]!.terminate();

    await expect(pending).rejects.toThrow(/worker stopped unexpectedly/i);
    await expect(
      databaseWorker.readPath({
        absolutePath: databasePath,
        path: "large.sqlite",
      }),
    ).resolves.toMatchObject({ path: "large.sqlite" });
    expect(workers).toHaveLength(2);
  });

  it("migrates the old nonblank-line version once and keeps the counter across restart", async () => {
    const root = await createTestScratch("dohc-db-worker-migration-");
    const databasePath = join(root, "data.sqlite");
    seedDatabase(databasePath);
    const paths = editPaths(root);
    await mkdir(dirname(paths.logPath), { recursive: true });
    await writeFile(
      paths.logPath,
      `${JSON.stringify({ version: 40, old: 1 })}\n\n${JSON.stringify({ version: 99, old: 2 })}\n`,
    );
    const firstOwner = owner();

    const first = await firstOwner.editPath({
      absolutePath: databasePath,
      path: "data.sqlite",
      ...paths,
      edit: UPDATE,
      operation: operation("op-migrated"),
    });
    expect(first.version).toBe(3);
    await firstOwner.dispose();
    owners.delete(firstOwner);

    const secondEdit = {
      ...UPDATE,
      payload: { value: { text: "x".repeat(300_000) } },
    };
    const secondOwner = owner();
    const second = await secondOwner.editPath({
      absolutePath: databasePath,
      path: "data.sqlite",
      ...paths,
      edit: secondEdit,
      operation: operation("op-after-restart", secondEdit),
    });
    expect(second.version).toBe(4);
    await secondOwner.dispose();
    owners.delete(secondOwner);

    const thirdEdit = { ...UPDATE, payload: { value: "after second restart" } };
    const third = await owner().editPath({
      absolutePath: databasePath,
      path: "data.sqlite",
      ...paths,
      edit: thirdEdit,
      operation: operation("op-after-second-restart", thirdEdit),
    });
    expect(third.version).toBe(5);
    expect((await logOperations(paths.logPath)).map((entry) => entry.version)).toEqual([
      40,
      99,
      3,
      4,
      5,
    ]);
  });

  it("pages at the row limit and at the serialized byte budget", async () => {
    const root = await createTestScratch("dohc-db-worker-page-");
    const rowBoundPath = join(root, "rows.sqlite");
    const byteBoundPath = join(root, "bytes.sqlite");
    seedPagedDatabase(rowBoundPath, 1205, false);
    await copyWideDatabaseSeed(byteBoundPath);
    const databaseWorker = owner();

    const snapshot = await databaseWorker.readPath({
      absolutePath: rowBoundPath,
      path: "rows.sqlite",
    });
    expect(snapshot.tables[0]?.rows).toHaveLength(DATABASE_MAX_ROWS);
    expect(snapshot.tables[0]?.nextOffset).toBe(DATABASE_MAX_ROWS);
    const second = await databaseWorker.readPagePath({
      absolutePath: rowBoundPath,
      path: "rows.sqlite",
      table: "items",
      offset: DATABASE_MAX_ROWS,
    });
    expect(second.rows).toHaveLength(205);
    expect(second.nextOffset).toBeNull();

    const byteBound = await databaseWorker.readPath({
      absolutePath: byteBoundPath,
      path: "bytes.sqlite",
    });
    expect(byteBound.tables[0]!.rows.length).toBeGreaterThan(0);
    expect(byteBound.tables[0]!.rows.length).toBeLessThan(DATABASE_MAX_ROWS);
    expect(byteBound.tables[0]!.nextOffset).toBe(
      byteBound.tables[0]!.rows.length,
    );
  });

  it("cancels a queued edit before it can mutate or log", async () => {
    const root = await createTestScratch("dohc-db-worker-cancel-");
    const largePath = join(root, "large.sqlite");
    const editPath = join(root, "data.sqlite");
    await copyWideDatabaseSeed(largePath);
    seedDatabase(editPath);
    const paths = editPaths(root);
    const databaseWorker = owner();
    const activeRead = databaseWorker.readPath({
      absolutePath: largePath,
      path: "large.sqlite",
    });
    const abort = new AbortController();
    const cancelled = databaseWorker.editPath({
      absolutePath: editPath,
      path: "data.sqlite",
      ...paths,
      edit: UPDATE,
      operation: operation("op-cancelled"),
      signal: abort.signal,
    });
    abort.abort();

    await expect(cancelled).rejects.toThrow("Database edit was cancelled.");
    await activeRead;
    expect(
      readDatabaseSnapshotAtPath(editPath, "data.sqlite").tables[0]?.rows[0]
        ?.value,
    ).toBe("start");
    await expect(readFile(paths.logPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("holds prepared file identity while a read waits for the worker", async () => {
    const root = await createTestScratch("dohc-db-worker-identity-");
    const largePath = join(root, "large.sqlite");
    const databasePath = join(root, "data.sqlite");
    const projectionPath = join(root, "projection.sqlite");
    await copyWideDatabaseSeed(largePath);
    seedDatabase(databasePath);
    await link(databasePath, projectionPath);
    const prepared = await prepareWorkspaceFileRead(root, "data.sqlite");
    const databaseWorker = owner();
    const queued = Promise.withResolvers<void>();
    const observedWorker: WorkspaceDatabaseWorkerOwner = {
      ...databaseWorker,
      readPath(input) {
        queued.resolve();
        return databaseWorker.readPath(input);
      },
    };
    const activeRead = databaseWorker.readPath({
      absolutePath: largePath,
      path: "large.sqlite",
    });
    const preparedRead = readPreparedDatabaseSnapshot(
      "data.sqlite",
      prepared,
      { worker: observedWorker },
    );
    const outcome = preparedRead.then(
      () => null,
      (error: unknown) => error,
    );

    await queued.promise;
    await rm(databasePath);
    await symlink(projectionPath, databasePath);
    await activeRead;

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/file changed/i);
  });

  it("waits for a started edit to become durable before rejecting cancellation", async () => {
    const root = await createTestScratch("dohc-db-worker-started-cancel-");
    const databasePath = join(root, "data.sqlite");
    seedDatabase(databasePath);
    const paths = editPaths(root);
    const abort = new AbortController();
    const databaseWorker = owner({
      onRequestStarted(request) {
        if (request.kind === "edit-path") abort.abort();
      },
    });

    await expect(
      databaseWorker.editPath({
        absolutePath: databasePath,
        path: "data.sqlite",
        ...paths,
        edit: UPDATE,
        operation: operation("op-started-cancel"),
        signal: abort.signal,
      }),
    ).rejects.toThrow("Database edit was cancelled.");

    expect(
      readDatabaseSnapshotAtPath(databasePath, "data.sqlite").tables[0]?.rows[0]
        ?.value,
    ).toBe("changed");
    expect(await logOperations(paths.logPath)).toHaveLength(1);
  });

  it("keeps the event loop responsive after a large read starts", async () => {
    const root = await createTestScratch("dohc-db-worker-responsive-");
    const databasePath = join(root, "large.sqlite");
    await copyWideDatabaseSeed(databasePath);
    const started = Promise.withResolvers<void>();
    let readSettled = false;
    const databaseWorker = owner({
      onRequestStarted() {
        started.resolve();
      },
    });
    const read = databaseWorker
      .readPath({ absolutePath: databasePath, path: "large.sqlite" })
      .finally(() => {
        readSettled = true;
      });

    await started.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readSettled).toBe(false);
    await read;
  });
});
