import { databaseOpLogPath } from "@dohc/workspace-core";
import { existsSync } from "node:fs";
import { copyFile, readFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceDatabaseAccess, createWorkspaceDatabaseWorkerOwner } from "./workspaceDatabase";
import type { WorkspaceDatabaseWorkerOwner } from "./workspaceDatabaseWorker";
import type { DatabaseEdit } from "./workspaceDatabaseTypes";
import { prepareWorkspaceFileRead } from "./workspaceAssets";
import { createTestScratch } from "./testTemp";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
};
const owners: WorkspaceDatabaseWorkerOwner[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.dispose())); });
const edit: DatabaseEdit = { table: "items", op: "update", pkColumn: "id", rowId: 1, payload: { value: "changed" } };
const author = { kind: "agent", agentId: "fixture-agent", onBehalfOf: "local", depth: 0 } as const;

async function fixture() {
  const rootPath = await createTestScratch("desktop-database-access-");
  const path = join(rootPath, "data.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES (1, 'first'), (2, 'second');");
  } finally { db.close(); }
  const requests: string[] = [];
  const worker = createWorkspaceDatabaseWorkerOwner({ onRequestStarted: request => { requests.push(request.kind); } });
  owners.push(worker);
  const access = createWorkspaceDatabaseAccess(worker);
  return { rootPath, path, requests, ...access, input: { rootPath, relativePath: "data.sqlite", edit, author, nowMs: 1_700_000_000_000 } };
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
