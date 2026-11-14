import { databaseFolderName, databaseOpLogPath } from "@dohc/workspace-core";
import { lstatSync, mkdirSync } from "node:fs";
import { copyFile, link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorkspaceFileRead } from "./workspaceAssets";
import { readPreparedDatabaseSnapshot } from "./workspaceDatabase";
import {
  DATABASE_MAX_CELL_CHARS,
  editDatabaseAtPath,
  readDatabaseSnapshotAtPath,
} from "./workspaceDatabaseCore";
import type { DatabaseEdit, DatabaseOperationInput } from "./workspaceDatabaseTypes";
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

function owner(
  options: Parameters<typeof createWorkspaceDatabaseWorkerOwner>[0] = {},
): WorkspaceDatabaseWorkerOwner {
  const created = createWorkspaceDatabaseWorkerOwner(options);
  owners.add(created);
  return created;
}

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
    ).run(1, "start", 12.5, null, new Uint8Array([1, 2, 3, 4]));
    db.prepare(
      "INSERT INTO items (id, value, amount, optional, payload) VALUES (?, ?, ?, ?, ?)",
    ).run(2, "x".repeat(DATABASE_MAX_CELL_CHARS + 20), 7, "present", null);
    db.prepare("INSERT INTO labels (id, value) VALUES (?, ?)").run("label-1", "without rowid");
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

function operation(operationId: string, edit: DatabaseEdit = UPDATE): DatabaseOperationInput {
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

// The desktop prepares both storage folders before dispatching an edit.
function editPaths(root: string) {
  const logPath = join(root, databaseOpLogPath("data.sqlite"));
  mkdirSync(dirname(logPath), { recursive: true });
  const counterFolder = join(
    root,
    ".dohc",
    "local",
    "databases",
    databaseFolderName("data.sqlite"),
  );
  mkdirSync(counterFolder, { recursive: true });
  return {
    logPath,
    storageIdentity: lstatSync(dirname(logPath), { bigint: true }),
    statePath: join(counterFolder, "state.sqlite"),
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
    expect(String(actual.tables[0]?.rows[1]?.value)).toHaveLength(DATABASE_MAX_CELL_CHARS + 1);
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
    const values = Array.from({ length: 3 }, (_, index) => `value-${index + 1}`);

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

    expect(results.map((result) => result.version)).toEqual(values.map((_, index) => index + 1));
    const logged = await logOperations(paths.logPath);
    expect(logged.map((entry) => entry.version)).toEqual(values.map((_, index) => index + 1));
    expect(logged.map((entry) => entry.payload)).toEqual(values.map((value) => ({ value })));
    expect(readDatabaseSnapshotAtPath(databasePath, "data.sqlite").tables[0]?.rows[0]?.value).toBe(
      values.at(-1),
    );
  });

  it("surfaces a crash for the active request and lazily restarts on the next request", async () => {
    const root = await createTestScratch("dohc-db-worker-crash-");
    const databasePath = join(root, "data.sqlite");
    seedDatabase(databasePath);
    const workers: Worker[] = [];
    const started = Promise.withResolvers<void>();
    const databaseWorker = owner({
      workerFactory(url) {
        // The crash fixture starts the request but cannot finish before termination.
        const worker =
          workers.length === 0
            ? new Worker(
                `
              const { parentPort } = require("node:worker_threads");
              parentPort.on("message", ({ id }) => {
                parentPort.postMessage({ id, kind: "started" });
              });
            `,
                { eval: true },
              )
            : new Worker(url);
        workers.push(worker);
        return worker;
      },
      onRequestStarted() {
        started.resolve();
      },
    });
    const pending = databaseWorker.readPath({
      absolutePath: databasePath,
      path: "data.sqlite",
    });
    const rejected = expect(pending).rejects.toThrow(/worker stopped unexpectedly/i);
    await started.promise;
    await workers[0]!.terminate();

    await rejected;
    expect(workers).toHaveLength(1);
    await expect(
      databaseWorker.readPath({
        absolutePath: databasePath,
        path: "data.sqlite",
      }),
    ).resolves.toMatchObject({ path: "data.sqlite" });
    expect(workers).toHaveLength(2);
  });

  it("starts a missing counter after the log's highest number, not its line count, and keeps it across restart", async () => {
    const root = await createTestScratch("dohc-db-worker-migration-");
    const databasePath = join(root, "data.sqlite");
    seedDatabase(databasePath);
    const paths = editPaths(root);
    await mkdir(dirname(paths.logPath), { recursive: true });
    // Two operations whose numbers are past the line count: numbers reserved
    // for edits that failed, or written by an earlier counter.
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
    expect(first.version).toBe(100);
    await firstOwner.dispose();
    owners.delete(firstOwner);

    const secondEdit = {
      ...UPDATE,
      payload: { value: { text: "x".repeat(8) } },
    };
    const secondOwner = owner();
    const second = await secondOwner.editPath({
      absolutePath: databasePath,
      path: "data.sqlite",
      ...paths,
      edit: secondEdit,
      operation: operation("op-after-restart", secondEdit),
    });
    expect(second.version).toBe(101);
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
    expect(third.version).toBe(102);
    expect((await logOperations(paths.logPath)).map((entry) => entry.version)).toEqual([
      40, 99, 100, 101, 102,
    ]);
  });

  it("refuses while the log holds a version past the safe range, with or without a counter", async () => {
    const root = await createTestScratch("dohc-db-worker-uncountable-");
    const databasePath = join(root, "data.sqlite");
    seedDatabase(databasePath);
    const paths = editPaths(root);
    await mkdir(dirname(paths.logPath), { recursive: true });
    // An earlier dohc wrote 9007199254740992. A text version and a line that
    // does not parse name no number, as before.
    const kept = '{"version":1}\n{"version":"12"}\nnot json\n';
    await writeFile(paths.logPath, `${kept}{"version":9007199254740992}\n`);
    const before = await readFile(databasePath);
    const databaseWorker = owner();
    const edit = () =>
      databaseWorker.editPath({
        absolutePath: databasePath,
        path: "data.sqlite",
        ...paths,
        edit: UPDATE,
        operation: operation("op-uncountable"),
      });

    await expect(edit()).rejects.toMatchObject({ code: "uncountable-log-version" });
    const counter = new DatabaseSync(paths.statePath);
    try {
      counter.exec("INSERT INTO database_operation_state VALUES ('last_version', 5);");
    } finally {
      counter.close();
    }
    await expect(edit()).rejects.toMatchObject({ code: "uncountable-log-version" });
    expect(await readFile(databasePath)).toEqual(before);
    expect(await readFile(paths.logPath, "utf8")).toBe(`${kept}{"version":9007199254740992}\n`);

    await writeFile(paths.logPath, kept);
    expect((await edit()).version).toBe(6);
  });

  it("cancels a queued edit before it can mutate or log", async () => {
    const root = await createTestScratch("dohc-db-worker-cancel-");
    const largePath = join(root, "large.sqlite");
    const editPath = join(root, "data.sqlite");
    seedDatabase(largePath);
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
    expect(readDatabaseSnapshotAtPath(editPath, "data.sqlite").tables[0]?.rows[0]?.value).toBe(
      "start",
    );
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
    const preparedRead = readPreparedDatabaseSnapshot("data.sqlite", prepared, {
      worker: observedWorker,
    });
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

    expect(readDatabaseSnapshotAtPath(databasePath, "data.sqlite").tables[0]?.rows[0]?.value).toBe(
      "changed",
    );
    expect(await logOperations(paths.logPath)).toHaveLength(1);
  });
});
