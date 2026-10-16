import { chmod, mkdir, readFile, readdir, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { deleteWorkspacePathByHand, prepareDeleteWorkspacePathAs, undoWorkspaceDelete, type PathChangeOptions } from "./workspaceFileMoves";

const faults = vi.hoisted(() => ({ failRecord: false, copyOnly: false, failFlush: false, readOnly: false, failPlace: false, pruneAttempts: 0, blockedPrune: "", visited: [] as string[], flushed: [] as string[] }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    lstat: async (path: string) => { faults.visited.push(String(path)); return actual.lstat(path); },
    unlink: async (path: string) => {
      if (String(path) === faults.blockedPrune) { faults.pruneAttempts++; throw Object.assign(new Error("record held open"), { code: "EPERM" }); }
      return actual.unlink(path);
    },
    link: async (from: string, to: string) => {
      if (faults.failPlace && to.endsWith("rowless.txt")) throw new Error("placement refused");
      if (faults.copyOnly) throw Object.assign(new Error("no links"), { code: "EXDEV" });
      return actual.link(from, to);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (faults.failPlace && String(args[0]).endsWith("rowless.txt")) throw new Error("placement refused");
      if (faults.readOnly && String(args[0]).endsWith("rowless.txt") && args[1] === "r+") {
        throw Object.assign(new Error("read-only file"), { code: "EPERM" });
      }
      const file = await actual.open(...args);
      const sync = file.sync.bind(file);
      file.sync = async () => {
        if (String(args[0]).endsWith("rowless.txt")) {
          faults.flushed.push(String(args[0]));
          if (faults.failFlush) throw new Error("flush failed");
        }
        return sync();
      };
      return file;
    }, rename: async (from: string, to: string) => {
    if (faults.failRecord && to.endsWith(".json")) { faults.failRecord = false; throw new Error("recovery save refused"); }
    return actual.rename(from, to);
  } };
});
const person = { kind: "human", humanId: "local:test" } as const;
async function fixture(systemAccepts = false, tracked = ["folder/tracked.txt"]) {
  const root = await createTestScratch("delete-recovery-faults-");
  await mkdir(join(root, ".dohc"));
  const write = async (path: string, body: string) => { await mkdir(join(root, "folder"), { recursive: true }); await writeFile(join(root, path), body); };
  await write("folder/tracked.txt", "tracked");
  await write("folder/rowless.txt", "not retained");
  const operation = { state: {}, signal: new AbortController().signal, workspace: { attachmentId: Symbol(), rootPath: root, readOnly: false, shareView: undefined as unknown }, assertCurrent: vi.fn() };
  const recordDelete = vi.fn(async () => "moment");
  const capture: PathChangeOptions["capture"] = { changePathsAs: async (_paths, _author, work) =>
    work({ policy: await readWorkspaceEnginePolicy(root), recordDisk: async () => tracked, delete: recordDelete } as never) };
  const options = { capture, requestId: "caller-request", markDeleted: vi.fn(), trashItem: async (path: string) => {
    if (!systemAccepts) throw new Error("OS refuses");
    await rm(path, { recursive: true });
  } };
  const history = { undoHistoryOperation: vi.fn(async () => ({ operationId: "unused", versionId: "main", momentCount: 1,
    compensationOperationId: "undo", deduped: false, materialized: false })) };
  const remove = (hand = false) => hand ? deleteWorkspacePathByHand(operation, "folder", person, options)
    : prepareDeleteWorkspacePathAs(operation, "folder", person, options).then(finish => finish());
  const undo = (id: string, requestId = "first") => undoWorkspaceDelete(operation, { operationId: id, requestId }, person, { workspaceId: "test", history });
  return { root, write, remove, undo, operation, recordDelete, history, options };
}
async function deleted(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.remove();
  expect(result.undo).toEqual({ available: true });
  return result.operationId!;
}

describe("delete recovery failures", () => {
  it.each([false, true])("restores a read-only rowless file without reopening it for writing (copy=%s)", async copyOnly => {
    const f = await fixture();
    await chmod(join(f.root, "folder/rowless.txt"), 0o444);
    const id = await deleted(f);
    faults.readOnly = true; faults.copyOnly = copyOnly;
    try {
      expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/rowless.txt"], remaining: [] });
      expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("not retained");
    } finally { faults.readOnly = false; faults.copyOnly = false; }
  });
  it("keeps a delete's Undo when an expired record cannot be pruned", async () => {
    const f = await fixture();
    const trash = join(f.root, ".dohc/trash");
    await mkdir(trash);
    const expired = join(trash, `delete-${"a".repeat(64)}.json`);
    await writeFile(expired, "old record");
    await utimes(expired, new Date(0), new Date(0));
    faults.pruneAttempts = 0;
    faults.blockedPrune = expired;
    try {
      const id = await deleted(f);
      await vi.waitFor(() => expect(faults.pruneAttempts).toBe(1));
      expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/rowless.txt"], remaining: [] });
      await f.write("folder/tracked.txt", "new");
      await f.write("folder/rowless.txt", "new");
      await deleted(f);
      expect(faults.pruneAttempts).toBe(1);
    } finally { faults.blockedPrune = ""; }
  });
  it("does not walk a rowless subtree during a person's delete", async () => {
    const f = await fixture(true);
    await mkdir(join(f.root, "folder/node_modules/package"), { recursive: true });
    await writeFile(join(f.root, "folder/node_modules/package/index.js"), "dependency");
    faults.visited = [];
    expect(await f.remove(true)).toMatchObject({ trashed: true });
    expect(faults.visited.filter(path => path.includes("node_modules") && path.endsWith("index.js"))).toEqual([]);
  });
  it("retries a refused engine Undo with a fresh caller id", async () => {
    const f = await fixture();
    const id = await deleted(f);
    f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("old tracked path occupied"));
    expect(await f.undo(id)).toEqual({ ok: false, reason: "old tracked path occupied" });
    expect(await f.undo(id, "second")).toMatchObject({ ok: true, restored: ["folder/rowless.txt"] });
    const calls = f.history.undoHistoryOperation.mock.calls as unknown as [{ requestId: string }][];
    expect(calls.map(([input]) => input.requestId)).toEqual([`delete-undo:${id}`, `delete-undo:${id}`]);
  });
  it("resumes a lost engine receipt with a fresh caller id", async () => {
    const f = await fixture();
    const id = await deleted(f);
    f.history.undoHistoryOperation.mockImplementationOnce(async () => { faults.failRecord = true; return {
      operationId: id, versionId: "main", momentCount: 1, compensationOperationId: "undo", deduped: false, materialized: false,
    }; });
    expect(await f.undo(id)).toMatchObject({ ok: false });
    expect(await f.undo(id, "second")).toMatchObject({ ok: true, restored: ["folder/rowless.txt"] });
  });
  it.each([false, true])("a failed recovery save does not fail a completed delete (hand=%s)", async hand => {
    const f = await fixture();
    faults.failRecord = true;
    try {
      const result = await f.remove(hand);
      expect(result).toMatchObject({ trashed: false, undo: { available: false, reason: expect.stringContaining("Delete finished") } });
      if (!hand) expect(result).toMatchObject({ ok: true, trashPath: expect.stringContaining(".dohc/trash/") });
      expect(f.recordDelete).toHaveBeenCalledWith("folder/tracked.txt");
      expect(existsSync(join(f.root, "folder"))).toBe(false);
    } finally { faults.failRecord = false; }
  });
  it.each([false, true])("a save failure after bytes moved preserves the completed delete (hand=%s)", async hand => {
    const f = await fixture();
    const trash = f.options.trashItem;
    f.options.trashItem = async path => { faults.failRecord = true; await trash(path); };
    try {
      const result = await f.remove(hand);
      expect(result).toMatchObject({ trashed: false, undo: { available: false } });
      if (!hand) expect(result).toMatchObject({ ok: true, trashPath: expect.stringContaining(".dohc/trash/") });
      expect(f.recordDelete).toHaveBeenCalledWith("folder/tracked.txt");
      expect(existsSync(join(f.root, "folder"))).toBe(false);
    } finally { faults.failRecord = false; }
  });
  it("a healthy OS trash does not require healthy workspace trash", async () => {
    const f = await fixture(true);
    await writeFile(join(f.root, ".dohc/trash"), "unavailable");
    expect(await f.remove(true)).toMatchObject({ trashed: true, undo: { available: false, reason: expect.stringMatching(/in the (Recycle Bin|Trash)\. Restore it there\.$/) } });
    expect(f.recordDelete).toHaveBeenCalledWith("folder/tracked.txt");
    expect(existsSync(join(f.root, "folder"))).toBe(false);
  });
  it("prunes expired metadata once without reading records or removing fallback bytes", async () => {
    const f = await fixture();
    const trash = join(f.root, ".dohc/trash");
    await mkdir(trash);
    const record = `delete-${"b".repeat(64)}.json`;
    const temp = `${record}.00000000-0000-4000-8000-000000000000.tmp`;
    await writeFile(join(trash, record), "invalid old record");
    await writeFile(join(trash, temp), "crash");
    await writeFile(join(trash, "fallback.txt"), "fallback bytes");
    for (const name of [record, temp]) await utimes(join(trash, name), new Date(0), new Date(0));
    await deleted(f);
    await vi.waitFor(async () => {
      expect(await readdir(trash)).not.toContain(record);
      expect(await readdir(trash)).not.toContain(temp);
    });
    expect(await readFile(join(trash, "fallback.txt"), "utf8")).toBe("fallback bytes");
  });
  it("restores through a noncanonical workspace root", async () => {
    const f = await fixture();
    const aliasParent = await createTestScratch("delete-recovery-faults-alias-");
    const alias = join(aliasParent, "workspace");
    await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
    f.operation.workspace.rootPath = alias;
    const id = await deleted(f);
    expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/rowless.txt"], remaining: [] });
    expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("not retained");
  });
});


describe("delete recovery placement and receipts", () => {
  it.each([false, true])("flushes copied bytes before removing the private source (flush refuses=%s)", async failFlush => {
    const f = await fixture();
    const id = await deleted(f);
    const trash = join(f.root, ".dohc/trash");
    const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    faults.copyOnly = true; faults.failFlush = failFlush; faults.flushed = [];
    try {
      const result = await f.undo(id);
      expect(faults.flushed).toEqual([join(f.root, "folder/rowless.txt")]);
      expect(existsSync(join(trash, staged, "rowless.txt"))).toBe(failFlush);
      expect(result).toMatchObject({ restored: ["folder/rowless.txt"], remaining: [] });
    } finally { faults.copyOnly = false; faults.failFlush = false; }
  });
  it("reports placed children when a rowless folder is only partly placed", async () => {
    const f = await fixture(false, []);
    const id = await deleted(f);
    faults.failPlace = true;
    try {
      const result = await f.undo(id);
      expect(result).toMatchObject({ ok: true, restored: ["folder/tracked.txt"], remaining: [{ path: "folder/rowless.txt" }] });
      const trash = join(f.root, ".dohc/trash");
      const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
      expect(existsSync(join(trash, staged, "tracked.txt"))).toBe(false);
      expect(existsSync(join(trash, staged, "rowless.txt"))).toBe(true);
    } finally { faults.failPlace = false; }
  });
  it("recreates an empty folder after OS trash accepts", async () => {
    const f = await fixture(true, []);
    await rm(join(f.root, "folder"), { recursive: true });
    await mkdir(join(f.root, "folder"));
    const result = await f.remove(true);
    expect(result.undo).toEqual({ available: true });
    await mkdir(join(f.root, "folder"));
    expect(await f.undo(result.operationId!)).toMatchObject({ ok: true, restored: ["folder"], remaining: [] });
    expect(await readdir(join(f.root, "folder"))).toEqual([]);
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  });
  it("records a person's delete without capture and restores every file", async () => {
    const f = await fixture();
    const result = await deleteWorkspacePathByHand(f.operation, "folder", person, { ...f.options, capture: null });
    expect(result.undo).toEqual({ available: true });
    expect(await f.undo(result.operationId!)).toMatchObject({ ok: true, restored: ["folder"] });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  });
  it("uses plural No Undo copy", async () => {
    const f = await fixture(true);
    await f.write("folder/another.txt", "rowless");
    const result = await f.remove(true);
    expect(result.undo).toMatchObject({ available: false, reason: expect.stringMatching(/another\.txt, folder\/rowless\.txt are in the (Recycle Bin|Trash)\. Restore them there\.$/) });
  });
  it("replays the saved result when the engine cannot refresh it", async () => {
    const f = await fixture();
    const id = await deleted(f);
    const first = await f.undo(id);
    f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("engine down or author mismatch"));
    expect(await f.undo(id, "next")).toEqual(first);
  });
  it("restores a relative directory link from its original location", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "destination"));
    await writeFile(join(f.root, "destination/original.txt"), "original target");
    await symlink("../destination", join(f.root, "folder/link"), "dir");
    const destination = await readlink(join(f.root, "folder/link"));
    const removed = await f.remove(true);
    expect(removed.undo).toEqual({ available: true });
    const id = removed.operationId!;
    expect(await f.undo(id)).toMatchObject({ ok: true, remaining: [] });
    expect(await readlink(join(f.root, "folder/link"))).toBe(destination);
    expect(await readFile(join(f.root, "folder/link/original.txt"), "utf8")).toBe("original target");
  });
  it("refreshes the tracked placement status on replay", async () => {
    const f = await fixture();
    const id = await deleted(f);
    expect(await f.undo(id)).toMatchObject({ tracked: { state: "restoring", momentCount: 1 } });
    f.history.undoHistoryOperation.mockResolvedValueOnce({ operationId: id, versionId: "main", momentCount: 1,
      compensationOperationId: "undo", deduped: true, materialized: true });
    expect(await f.undo(id, "next")).toMatchObject({ tracked: { state: "restored", momentCount: 1 } });
  });
  it.each([false, true])("names a missing staged source before engine commit (whole folder=%s)", async whole => {
    const f = await fixture();
    const id = await deleted(f);
    const trash = join(f.root, ".dohc/trash");
    const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    await rm(whole ? join(trash, staged) : join(trash, staged, "rowless.txt"), { recursive: true });
    expect(await f.undo(id)).toMatchObject({ ok: false, reason: expect.stringContaining("no longer in the workspace trash") });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  });
  it("expires metadata without deleting fallback bytes", async () => {
    const f = await fixture();
    const id = await deleted(f);
    const trash = join(f.root, ".dohc/trash");
    const record = (await readdir(trash)).find(name => name.endsWith(".json"))!;
    const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    await utimes(join(trash, record), new Date(0), new Date(0));
    expect(await f.undo(id)).toMatchObject({ ok: false, reason: expect.stringContaining("missing or expired") });
    await f.write("folder/tracked.txt", "new");
    await f.write("folder/rowless.txt", "new");
    await f.remove();
    expect(await readdir(trash)).not.toContain(record);
    expect(await readFile(join(trash, staged, "rowless.txt"), "utf8")).toBe("not retained");
  });
  it.runIf(process.platform === "win32")("offers no Undo for an 8.3-shaped name", async () => {
    const f = await fixture();
    await f.write("folder/report~1.pdf", "short-shaped");
    const result = await f.remove(true);
    expect(result.undo).toMatchObject({ available: false, reason: expect.stringContaining("Invalid recovery path: folder/report~1.pdf") });
  });
  it("restores a directory link with its original destination", async () => {
    const f = await fixture();
    const outside = await createTestScratch("delete-recovery-faults-link-");
    await symlink(outside, join(f.root, "folder/link"), process.platform === "win32" ? "junction" : "dir");
    const result = await f.remove(true);
    expect(result.undo).toEqual({ available: true });
    expect(await f.undo(result.operationId!)).toMatchObject({ ok: true, remaining: [] });
    await writeFile(join(outside, "original.txt"), "original target");
    expect(await readFile(join(f.root, "folder/link/original.txt"), "utf8")).toBe("original target");
  });
});
