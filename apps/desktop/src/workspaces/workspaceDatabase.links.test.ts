import { databaseFolderName, databaseOpLogPath } from "@dohc/workspace-core";
import * as fs from "node:fs/promises";
import { link, lstat, mkdir, readFile, readdir, readlink, rename, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceDatabaseAccess } from "./workspaceDatabase";
import { readDatabaseSnapshotAtPath } from "./workspaceDatabaseCore";
import { createWorkspaceDatabaseWorkerOwner, type WorkspaceDatabaseWorkerOwner } from "./workspaceDatabaseWorker";
import { createTestScratch } from "./testTemp";
import { openedLocalState } from "../testing/preparedLocalState";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

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
  await openedLocalState({ workspaceId: "links", rootPath: root });
  const db = new DatabaseSync(join(root, "data.sqlite"));
  try {
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES (1, 'before')");
  } finally { db.close(); }
  worker = createWorkspaceDatabaseWorkerOwner();
}, 30_000);
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(fs.lstat).mockReset(); await worker.dispose(); });

const entryPoints = [
  { name: "workspace access", run: (rootPath: string) => createWorkspaceDatabaseAccess(worker).editWorkspaceDatabaseInWorker({
    workspace: { workspaceId: "links", rootPath }, relativePath: "data.sqlite", edit: EDIT, author: AUTHOR, nowMs: 1,
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

function counterPath(rootPath = root): string {
  return join(rootPath, ".dohc", "local", "databases", databaseFolderName("data.sqlite"), "state.sqlite");
}

function storageFile(file: string): string {
  return file === "operations.jsonl" ? join(root, databaseOpLogPath("data.sqlite")) : `${counterPath()}${file.slice("state.sqlite".length)}`;
}

function rowValue(): unknown {
  return readDatabaseSnapshotAtPath(join(root, "data.sqlite"), "data.sqlite").tables[0]?.rows[0]?.value;
}

describe.each(entryPoints)("$name metadata custody", ({ run }) => {
  it("accepts state files on a volume that reports zero links", async () => {
    await run(root);
    const original = vi.mocked(fs.lstat).getMockImplementation()!;
    vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const stats = await original(...args);
      return Object.assign(Object.create(stats), { nlink: typeof stats.nlink === "bigint" ? 0n : 0 });
    }) as typeof fs.lstat);
    await expect(run(root)).resolves.toMatchObject({ version: 2 });
  });

  it.each(["junction", "folder"])("refuses a slug replaced with a %s after the guard and before the worker runs", async (replacement) => {
    const directory = dirname(join(root, databaseOpLogPath("data.sqlite")));
    const outside = join(base, "outside");
    await mkdir(outside);
    const editPath = worker.editPath.bind(worker);
    vi.spyOn(worker, "editPath").mockImplementationOnce(async (input) => {
      await rename(directory, `${directory}-parked`);
      if (replacement === "junction") {
        await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
      } else {
        await mkdir(directory);
      }
      return editPath(input);
    });
    await expect(run(root)).rejects.toThrow(replacement === "junction" ? /must be a real folder/ : /folder.*changed before/);
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(replacement === "junction" ? outside : directory)).toEqual([]);
    expect(rowValue()).toBe("before");
  });

  describe.each(["operations.jsonl", "state.sqlite", "state.sqlite-journal"])("%s", (file) => {
    it.each([false, true])("refuses a file link without touching its target (exists: %s)", async (exists) => {
      const logPath = join(root, databaseOpLogPath("data.sqlite"));
      const path = storageFile(file);
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
      expect((outcome as Error).message).toMatch(file === "operations.jsonl"
        ? /A link is at .*must be a file\. Remove or rename that link\. Then retry\./
        : /dohc can't trust a file in .dohc\/local\/databases\/.*Remove that folder, then try again\./);
      if (file === "operations.jsonl") {
        expect((outcome as Error).message).toContain(file);
        await expect(lstat(counterPath())).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });

  it.each([".dohc", ".dohc/databases", "slug", ".dohc/local", ".dohc/local/databases", "local slug"])("refuses a junction at %s before creating any target folders", async (ancestor) => {
    const logPath = join(root, databaseOpLogPath("data.sqlite"));
    const path = ancestor === "slug" ? dirname(logPath) : ancestor === "local slug" ? dirname(counterPath()) : join(root, ancestor);
    const existing = await lstat(path).catch(() => null);
    if (existing) await rename(path, `${path}-parked`);
    const outside = join(base, "outside");
    await mkdir(dirname(path), { recursive: true });
    await mkdir(outside);
    await symlink(outside, path, process.platform === "win32" ? "junction" : "dir");
    const outcome = await run(root).then(() => null, (error: unknown) => error);
    expect(await readdir(outside)).toEqual([]);
    expect(rowValue()).toBe("before");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(relative(root, path).replaceAll("\\", "/"));
    expect((outcome as Error).message).toMatch(ancestor === ".dohc" || ancestor === ".dohc/local"
      ? /is a link\. Put what it links to in its place, then try again\./
      : /A link is at .*must be a real folder\. Remove or rename that link\. Then retry\./);
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

  it.each(["operations.jsonl", "state.sqlite"])("names the refusal for a directory at %s", async (file) => {
    await mkdir(storageFile(file), { recursive: true });
    await expect(run(root)).rejects.toThrow(file === "operations.jsonl"
      ? /An item is at .*must be a file\. Remove or rename that item\. Then retry\./
      : /dohc can't trust a file in .*Remove that folder, then try again\./);
    expect(rowValue()).toBe("before");
  });

  it.each(["operations.jsonl", "state.sqlite"])("refuses a hard-linked %s without changing either name", async (file) => {
    const path = storageFile(file);
    const target = join(base, `outside-${file}`);
    await mkdir(dirname(path), { recursive: true });
    if (file === "state.sqlite") new DatabaseSync(target).close();
    else await writeFile(target, "original\n");
    await link(target, path);
    const before = await readFile(target);
    const dispatch = vi.spyOn(worker, "editPath");
    await expect(run(root)).rejects.toThrow(file === "operations.jsonl"
      ? /has another link.*Remove or rename this file\. Then retry\./
      : /dohc can't trust a file in .*Remove that folder, then try again\./);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(before);
    expect(await readFile(path)).toEqual(before);
    expect((await lstat(path)).nlink).toBe(2);
    expect(rowValue()).toBe("before");
  });

  it("edits and reopens through a workspace alias with increasing log versions", async () => {
    const alias = join(base, "alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    await openedLocalState({ workspaceId: "links", rootPath: alias });
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
