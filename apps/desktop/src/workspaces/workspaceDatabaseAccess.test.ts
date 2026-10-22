import { databaseFolderName, databaseOpLogPath } from "@dohc/workspace-core";
import { existsSync } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceDatabaseAccess, createWorkspaceDatabaseWorkerOwner } from "./workspaceDatabase";
import type { WorkspaceDatabaseWorkerOwner } from "./workspaceDatabaseWorker";
import type { DatabaseEdit } from "./workspaceDatabaseTypes";
import { prepareWorkspaceFileRead } from "./workspaceAssets";
import { createTestScratch } from "./testTemp";
import { fakeLocalStateOpens, openedLocalState } from "../testing/preparedLocalState";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { get(): Record<string, unknown> | undefined };
    close(): void;
  };
};
const owners: WorkspaceDatabaseWorkerOwner[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.dispose())); });
const edit: DatabaseEdit = { table: "items", op: "update", pkColumn: "id", rowId: 1, payload: { value: "changed" } };
const author = { kind: "agent", agentId: "fixture-agent", onBehalfOf: "local", depth: 0 } as const;

async function fixture(options: { opened?: boolean } = {}) {
  const rootPath = await createTestScratch("desktop-database-access-");
  const workspace = { workspaceId: "workspace-a", rootPath };
  const path = join(rootPath, "data.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES (1, 'first'), (2, 'second');");
  } finally { db.close(); }
  if (options.opened !== false) await openedLocalState(workspace);
  const requests: string[] = [];
  const worker = createWorkspaceDatabaseWorkerOwner({ onRequestStarted: request => { requests.push(request.kind); } });
  owners.push(worker);
  const access = createWorkspaceDatabaseAccess(worker);
  const folder = databaseFolderName("data.sqlite");
  return {
    rootPath, workspace, path, requests, ...access,
    input: { workspace, relativePath: "data.sqlite", edit, author, nowMs: 1_700_000_000_000 },
    logPath: join(rootPath, databaseOpLogPath("data.sqlite")),
    counterFolder: join(rootPath, ".dohc", "local", "databases", folder),
    counterShown: `.dohc/local/databases/${folder}`,
  };
}

/** A counter as dohc writes it, whose last number is `last`. */
async function writeCounter(folder: string, last: number) {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(folder, "state.sqlite"));
  try {
    db.exec(`CREATE TABLE database_operation_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO database_operation_state VALUES ('last_version', ${last});`);
  } finally { db.close(); }
}

function lastNumber(folder: string) {
  const db = new DatabaseSync(join(folder, "state.sqlite"));
  try {
    return db.prepare("SELECT value FROM database_operation_state WHERE key = 'last_version'").get()?.value;
  } finally { db.close(); }
}

async function loggedNumbers(logPath: string) {
  return (await readFile(logPath, "utf8")).trim().split("\n").map(line => (JSON.parse(line) as { version: number }).version);
}

describe("desktop database access", () => {
  it("reads admitted paths and shared bytes through the actual worker, including page offsets", async () => {
    const f = await fixture(); const reader = f.workerDatabaseReader();
    const prepared = await prepareWorkspaceFileRead(f.rootPath, "data.sqlite");
    const bytes = await readFile(f.path);
    const fromPath = await reader.readPrepared("data.sqlite", prepared);
    const fromBytes = await reader.readBytes("shared/data.sqlite", bytes);
    expect(fromPath.tables[0]?.rows.map(row => row.value)).toEqual(["first", "second"]);
    expect(fromBytes).toEqual({ ...fromPath, path: "shared/data.sqlite" });
    const pathPage = await reader.readPagePrepared("data.sqlite", prepared, "items", 1);
    expect(pathPage).toMatchObject({ path: "data.sqlite", table: "items", offset: 1, rows: [{ id: 2, value: "second" }] });
    expect(await reader.readPageBytes("shared/data.sqlite", bytes, "items", 1)).toEqual({ ...pathPage, path: "shared/data.sqlite" });
  });

  it("refuses a prepared file replaced before a worker read", async () => {
    const f = await fixture();
    const prepared = await prepareWorkspaceFileRead(f.rootPath, "data.sqlite");
    await rename(f.path, join(f.rootPath, "original.sqlite"));
    await copyFile(join(f.rootPath, "original.sqlite"), f.path);
    await expect(f.workerDatabaseReader().readPrepared("data.sqlite", prepared)).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });

  it.each(["snapshot-path", "snapshot-bytes", "page-path", "page-bytes"] as const)("cancels %s before it reaches the worker", async kind => {
    const f = await fixture();
    const prepared = await prepareWorkspaceFileRead(f.rootPath, "data.sqlite");
    const bytes = await readFile(f.path);
    const reader = f.workerDatabaseReader(AbortSignal.abort());
    const pending = kind === "snapshot-path" ? reader.readPrepared("data.sqlite", prepared)
      : kind === "snapshot-bytes" ? reader.readBytes("data.sqlite", bytes)
        : kind === "page-path" ? reader.readPagePrepared("data.sqlite", prepared, "items", 0)
          : reader.readPageBytes("data.sqlite", bytes, "items", 0);
    await expect(pending).rejects.toThrow("Database read was cancelled.");
    expect(f.requests).toEqual([]);
  });

  it("persists the supplied operation identity and author with the real database edit", async () => {
    const f = await fixture();
    const result = await f.editWorkspaceDatabaseInWorker({ ...f.input, relativePath: "./data.sqlite", operationId: "operation-a" });
    expect(result).toMatchObject({ path: "data.sqlite", table: "items", page: { rows: [{ id: 1, value: "changed" }, { id: 2, value: "second" }] } });
    const operations = (await readFile(join(f.rootPath, databaseOpLogPath("data.sqlite")), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(operations).toEqual([expect.objectContaining({ operationId: "operation-a", databasePath: "data.sqlite", table: "items", op: "update", rowId: "1", payload: { value: "changed" }, appliedAt: f.input.nowMs, author })]);
    expect((await f.workerDatabaseReader().readPageBytes("data.sqlite", await readFile(f.path), "items", 0)).rows[0]?.value).toBe("changed");
  });

  it("generates an operation ID when none is supplied", async () => {
    const f = await fixture();
    await f.editWorkspaceDatabaseInWorker(f.input);
    const operation = JSON.parse((await readFile(join(f.rootPath, databaseOpLogPath("data.sqlite")), "utf8")).trim());
    expect(operation.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("leaves the database and operation log unchanged after cancellation", async () => {
    const f = await fixture(); const before = await readFile(f.path);
    await expect(f.editWorkspaceDatabaseInWorker({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow("Database edit was cancelled.");
    expect(await readFile(f.path)).toEqual(before);
    expect(existsSync(join(f.rootPath, databaseOpLogPath("data.sqlite")))).toBe(false);
    expect(f.requests).toEqual([]);
  });

  it.each(["../data.sqlite", ".dohc/data.sqlite"])("refuses edit path %s before worker admission", async relativePath => {
    const f = await fixture();
    await expect(f.editWorkspaceDatabaseInWorker({ ...f.input, relativePath })).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });
});

// Each computer numbers a database's operations with its own counter, in
// `.dohc/local`, which iCloud Drive skips. The operations log stays in
// `.dohc/databases`, which syncs.
describe("this computer's operation counter", () => {
  it("lives in .dohc/local/databases, leaves the log in .dohc/databases, and ignores an old counter and the Collections", async () => {
    const f = await fixture();
    // What an earlier build left beside the log, and the Collections database, which stays put.
    const oldFolder = join(f.rootPath, ".dohc", "databases", databaseFolderName("data.sqlite"));
    await writeCounter(oldFolder, 50);
    const collections = join(f.rootPath, ".dohc", "local", "datasets", "state.sqlite");
    await mkdir(join(f.rootPath, ".dohc", "local", "datasets"), { recursive: true });
    await writeFile(collections, "the Collections");

    expect(await f.editWorkspaceDatabaseInWorker(f.input)).toMatchObject({ version: 1 });

    expect(await readdir(join(f.rootPath, ".dohc", "local", "databases"))).toEqual([databaseFolderName("data.sqlite")]);
    expect(await readdir(f.counterFolder)).toEqual(["state.sqlite"]);
    expect(lastNumber(f.counterFolder)).toBe(1);
    if (process.platform !== "win32") {
      for (const folder of [join(f.counterFolder, ".."), f.counterFolder]) expect((await lstat(folder)).mode & 0o777).toBe(0o700);
    }
    expect(f.logPath).toBe(join(oldFolder, "operations.jsonl"));
    expect(await loggedNumbers(f.logPath)).toEqual([1]);
    expect((await readdir(oldFolder)).sort()).toEqual(["operations.jsonl", "state.sqlite"]);
    expect(lastNumber(oldFolder)).toBe(50);
    expect(await readdir(join(f.rootPath, ".dohc", "local", "datasets"))).toEqual(["state.sqlite"]);
    expect(await readFile(collections, "utf8")).toBe("the Collections");
  });

  it("starts a new counter after the highest number in the log, so a gap never makes a number repeat", async () => {
    const f = await fixture();
    await mkdir(join(f.logPath, ".."), { recursive: true });
    // Number 3 went to an edit that failed. Another computer wrote 7.
    await writeFile(f.logPath, [1, 2, 4, 7].map(version => `${JSON.stringify({ version })}\n`).join(""));

    expect(await f.editWorkspaceDatabaseInWorker(f.input)).toMatchObject({ version: 8 });
    expect(await f.editWorkspaceDatabaseInWorker(f.input)).toMatchObject({ version: 9 });
    expect(await loggedNumbers(f.logPath)).toEqual([1, 2, 4, 7, 8, 9]);
  });

  // The desktop waits for an open under way before it takes the workspace
  // lease, so the edit itself only refuses.
  it("refuses until the engine's open prepares .dohc/local, without waiting, and writes nothing before", async () => {
    const f = await fixture({ opened: false });
    const opens = fakeLocalStateOpens();
    const before = await readFile(f.path);

    await expect(f.editWorkspaceDatabaseInWorker(f.input)).rejects.toThrow("dohc has not finished opening this workspace. Try again when it opens.");
    // Reads don't need the counter.
    const prepared = await prepareWorkspaceFileRead(f.rootPath, "data.sqlite");
    expect((await f.workerDatabaseReader().readPrepared("data.sqlite", prepared)).tables[0]?.rows).toHaveLength(2);
    const opening = opens.start(f.workspace);
    await expect(f.editWorkspaceDatabaseInWorker(f.input)).rejects.toThrow("dohc has not finished opening this workspace. Try again when it opens.");
    expect(opens.waits()).toBe(0);
    expect(await readdir(f.rootPath)).toEqual(["data.sqlite"]);
    expect(await readFile(f.path)).toEqual(before);
    expect(f.requests).toEqual(["read-path"]);

    await opening.finish();
    await expect(f.editWorkspaceDatabaseInWorker(f.input)).resolves.toMatchObject({ version: 1 });
    expect(lastNumber(f.counterFolder)).toBe(1);
  });

  it("refuses, naming the log, while it holds a version dohc can't count past", async () => {
    const f = await fixture();
    await mkdir(join(f.logPath, ".."), { recursive: true });
    await writeFile(f.logPath, '{"version":1}\n{"version":9007199254740992}\n');
    const before = await readFile(f.path);

    await expect(f.editWorkspaceDatabaseInWorker(f.input)).rejects.toThrow(
      `A line in ${databaseOpLogPath("data.sqlite")} has a version dohc can't count past. Remove that line, then try again.`);
    expect(await readFile(f.path)).toEqual(before);
    expect(await loggedNumbers(f.logPath)).toEqual([1, 9007199254740992]);
  });

  it("refuses while .dohc/local can't be kept out of iCloud Drive, and writes nothing", async () => {
    const f = await fixture({ opened: false });
    await fakeLocalStateOpens().open(f.workspace, false);
    const before = await readFile(f.path);

    await expect(f.editWorkspaceDatabaseInWorker(f.input)).rejects.toThrow(
      "dohc could not keep this workspace's .dohc/local out of iCloud Drive, so it saves nothing there. Restart dohc to try again.");
    expect(await readdir(join(f.rootPath, ".dohc"))).toEqual(["local"]);
    expect(await readdir(join(f.rootPath, ".dohc", "local"))).toEqual([]);
    expect(await readFile(f.path)).toEqual(before);
    expect(f.requests).toEqual([]);
  });

  // A counter planted at 2 would give out number 3, which the log already holds.
  const untrusted = [
    ["others can write", "file"],
    ["with a second name", "file"],
    ["whose journal others can write", "file"],
    ["in another user's .dohc", ".dohc"],
    ["under a linked .dohc/local", ".dohc/local"],
  ] as const;
  it.skipIf(process.platform === "win32").each(untrusted)("refuses a counter %s, gives out no number, and leaves it in place", async (kind, refused) => {
    const f = await fixture();
    await mkdir(join(f.logPath, ".."), { recursive: true });
    await writeFile(f.logPath, [1, 2, 3, 4, 5].map(version => `${JSON.stringify({ version })}\n`).join(""));
    await writeCounter(f.counterFolder, 2);
    const counter = join(f.counterFolder, "state.sqlite");
    const elsewhere = await createTestScratch("desktop-database-untrusted-");
    const before = await readFile(f.path);
    let uid: ReturnType<typeof vi.spyOn> | undefined;
    if (kind === "others can write") await chmod(counter, 0o666);
    if (kind === "with a second name") await link(counter, join(elsewhere, "second-name.sqlite"));
    if (kind === "whose journal others can write") {
      await writeFile(`${counter}-journal`, "");
      await chmod(`${counter}-journal`, 0o666);
    }
    if (kind === "in another user's .dohc") uid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    const local = join(f.rootPath, ".dohc", "local");
    if (kind === "under a linked .dohc/local") {
      await rename(local, join(elsewhere, "local"));
      await symlink(join(elsewhere, "local"), local, "dir");
    }

    try {
      await expect(f.editWorkspaceDatabaseInWorker(f.input)).rejects.toThrow(
        refused === "file" ? `dohc can't trust a file in ${f.counterShown}. Remove that folder, then try again.`
          : refused === ".dohc" ? "This workspace's .dohc belongs to another user. Make it and everything in it yours again, then try again."
            : "This workspace's .dohc/local is a link. Put what it links to in its place, then try again.");
    } finally { uid?.mockRestore(); }

    expect(f.requests).toEqual([]);
    expect(await loggedNumbers(f.logPath)).toEqual([1, 2, 3, 4, 5]);
    expect(await readFile(f.path)).toEqual(before);
    if (kind === "under a linked .dohc/local") {
      await rm(local);
      await rename(join(elsewhere, "local"), local);
    }
    expect(lastNumber(f.counterFolder)).toBe(2);
    // Once the person removes the folder, the next edit starts after the log.
    await rm(f.counterFolder, { recursive: true });
    expect(await f.editWorkspaceDatabaseInWorker(f.input)).toMatchObject({ version: 6 });
  });
});
