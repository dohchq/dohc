import { databaseOpLogPath } from "@dohc/workspace-core";
import { lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDatabaseEdit, createWorkspaceDatabaseAccess } from "./workspaceDatabase";
import { readDatabaseSnapshotAtPath } from "./workspaceDatabaseCore";
import { createWorkspaceDatabaseWorkerOwner, type WorkspaceDatabaseWorkerOwner } from "./workspaceDatabaseWorker";
import { createTestScratch } from "./testTemp";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const AUTHOR = { kind: "user", userId: "local" } as const;
const EDIT = { table: "items", op: "update", pkColumn: "id", rowId: 1, payload: { value: "changed" } } as const;
let base: string;
let root: string;
let worker: WorkspaceDatabaseWorkerOwner;

beforeEach(async () => {
  base = await createTestScratch("dohc-database-links-");
  root = join(base, "workspace");
  await mkdir(root);
  const db = new DatabaseSync(join(root, "data.sqlite"));
  try {
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES (1, 'before')");
  } finally { db.close(); }
  worker = createWorkspaceDatabaseWorkerOwner();
}, 30_000);
afterEach(async () => { await worker.dispose(); });

const entryPoints = [
  { name: "direct edit", run: (rootPath: string) => applyDatabaseEdit(rootPath, "data.sqlite", EDIT, AUTHOR, 1, { worker }) },
  { name: "workspace access", run: (rootPath: string) => createWorkspaceDatabaseAccess(worker).editWorkspaceDatabaseInWorker({
    rootPath, relativePath: "data.sqlite", edit: EDIT, author: AUTHOR, nowMs: 1,
  }) },
];

async function tree(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await readdir(path, { recursive: true })) {
    const child = join(path, name);
    if ((await lstat(child)).isFile()) result[name] = (await readFile(child)).toString("hex");
    else result[name] = "directory";
  }
  return result;
}

function rowValue(): unknown {
  return readDatabaseSnapshotAtPath(join(root, "data.sqlite"), "data.sqlite").tables[0]?.rows[0]?.value;
}

describe.each(entryPoints)("$name metadata custody", ({ run }) => {
  describe.each(["operations.jsonl", "state.sqlite", "state.sqlite-journal", "state.sqlite-wal", "state.sqlite-shm"])("%s", (file) => {
    it.each([false, true])("refuses a file link without touching its target (exists: %s)", async (exists) => {
      const logPath = join(root, databaseOpLogPath("data.sqlite"));
      const path = join(dirname(logPath), file);
      const outside = join(base, "outside");
      const target = join(outside, file);
      await mkdir(dirname(path), { recursive: true });
      await mkdir(outside);
      if (exists) {
        if (file === "state.sqlite") new DatabaseSync(target).close();
        else await writeFile(target, "original\n");
      }
      await symlink(target, path, "file");
      const link = await readlink(path);
      const before = await tree(outside);
      const outcome = await run(root).then(() => null, (error: unknown) => error);
      expect(await tree(outside)).toEqual(before);
      expect(rowValue()).toBe("before");
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
      expect(await readlink(path)).toBe(link);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(file);
      expect((outcome as Error).message).toMatch(/regular file.*Replace/);
      if (file === "operations.jsonl") {
        await expect(lstat(join(dirname(path), "state.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });

  it.each([".dohc", ".dohc/databases", "slug"])("refuses a junction at %s before creating any target folders", async (ancestor) => {
    const logPath = join(root, databaseOpLogPath("data.sqlite"));
    const path = ancestor === "slug" ? dirname(logPath) : join(root, ancestor);
    const outside = join(base, "outside");
    await mkdir(dirname(path), { recursive: true });
    await mkdir(outside);
    await symlink(outside, path, process.platform === "win32" ? "junction" : "dir");
    const outcome = await run(root).then(() => null, (error: unknown) => error);
    expect(await readdir(outside)).toEqual([]);
    expect(rowValue()).toBe("before");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(relative(root, path));
    expect((outcome as Error).message).toMatch(/link.*Replace/);
  });

  it("refuses a slug redirected to another directory inside the workspace", async () => {
    const logPath = join(root, databaseOpLogPath("data.sqlite"));
    const target = join(root, "other");
    await mkdir(dirname(dirname(logPath)), { recursive: true });
    await mkdir(target);
    await symlink(target, dirname(logPath), process.platform === "win32" ? "junction" : "dir");
    await expect(run(root)).rejects.toThrow(/link/);
    expect(await readdir(target)).toEqual([]);
    expect(rowValue()).toBe("before");
  });

  it.each(["operations.jsonl", "state.sqlite"])("refuses a directory at %s before making any edit", async (file) => {
    const logPath = join(root, databaseOpLogPath("data.sqlite"));
    await mkdir(join(dirname(logPath), file), { recursive: true });
    await expect(run(root)).rejects.toThrow(/regular file/);
    expect(rowValue()).toBe("before");
  });

  it("edits and reopens through a workspace alias with increasing log versions", async () => {
    const alias = join(base, "alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    expect((await run(alias)).version).toBe(1);
    await worker.dispose();
    worker = createWorkspaceDatabaseWorkerOwner();
    expect((await run(alias)).version).toBe(2);
    expect(rowValue()).toBe("changed");
    const log = await readFile(join(root, databaseOpLogPath("data.sqlite")), "utf8");
    const operations = log.trim().split("\n").map((line) => JSON.parse(line));
    expect(operations.map((operation) => operation.version)).toEqual([1, 2]);
    expect(operations.map((operation) => operation.payload.value).at(-1)).toBe(rowValue());
  });
});
