import { mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { deleteWorkspacePathByHand, prepareDeleteWorkspacePathAs, undoWorkspaceDelete, type PathChangeOptions } from "./workspaceFileMoves";

const faults = vi.hoisted(() => ({ failRecord: false, copyOnly: false, failFlush: false, flushed: [] as string[] }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    link: async (from: string, to: string) => {
      if (faults.copyOnly) throw Object.assign(new Error("no links"), { code: "EXDEV" });
      return actual.link(from, to);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
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
  const root = await createTestScratch("delete-review-");
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

describe("review regressions", () => {
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
  it("a healthy OS trash does not require healthy workspace trash", async () => {
    const f = await fixture(true);
    await writeFile(join(f.root, ".dohc/trash"), "unavailable");
    expect(await f.remove(true)).toMatchObject({ trashed: true, undo: { available: false } });
    expect(f.recordDelete).toHaveBeenCalledWith("folder/tracked.txt");
    expect(existsSync(join(f.root, "folder"))).toBe(false);
  });
  it("removes orphaned records and crash temps without removing fallback bytes", async () => {
    const f = await fixture();
    await deleted(f);
    const trash = join(f.root, ".dohc/trash");
    const names = await readdir(trash);
    const record = names.find(name => name.endsWith(".json"))!;
    const staged = names.find(name => name.endsWith("-folder"))!;
    const temp = `${record}.00000000-0000-4000-8000-000000000000.tmp`;
    await writeFile(join(trash, temp), "crash");
    await utimes(join(trash, temp), new Date(0), new Date(0));
    await rm(join(trash, staged), { recursive: true });
    await f.write("folder/tracked.txt", "tracked");
    await f.write("folder/rowless.txt", "new fallback");
    await deleted(f);
    expect(await readdir(trash)).not.toContain(record);
    expect(await readdir(trash)).not.toContain(temp);
    const remaining = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    expect(await readFile(join(trash, remaining, "rowless.txt"), "utf8")).toBe("new fallback");
  });
  it("restores through a noncanonical workspace root", async () => {
    const f = await fixture();
    const aliasParent = await createTestScratch("delete-review-alias-");
    const alias = join(aliasParent, "workspace");
    await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
    f.operation.workspace.rootPath = alias;
    const id = await deleted(f);
    expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/rowless.txt"], remaining: [] });
    expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("not retained");
  });
});


describe("review details", () => {
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
      expect(result).toMatchObject(failFlush ? { restored: [], remaining: [{ path: "folder/rowless.txt" }] } : { restored: ["folder/rowless.txt"], remaining: [] });
    } finally { faults.copyOnly = false; faults.failFlush = false; }
  });
  it("reports placed children when a rowless folder is only partly placed", async () => {
    const f = await fixture(false, []);
    const id = await deleted(f);
    faults.failFlush = true;
    try {
      const result = await f.undo(id);
      expect(result).toMatchObject({ ok: true, restored: ["folder/tracked.txt"], remaining: [{ path: "folder/rowless.txt" }] });
      const trash = join(f.root, ".dohc/trash");
      const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
      expect(existsSync(join(trash, staged, "tracked.txt"))).toBe(false);
      expect(existsSync(join(trash, staged, "rowless.txt"))).toBe(true);
    } finally { faults.failFlush = false; }
  });
  it("recreates an empty folder after OS trash accepts", async () => {
    const f = await fixture(true, []);
    await rm(join(f.root, "folder"), { recursive: true });
    await mkdir(join(f.root, "folder"));
    const result = await f.remove(true);
    expect(result.undo).toEqual({ available: true });
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
  it("refreshes the tracked placement status on replay", async () => {
    const f = await fixture();
    const id = await deleted(f);
    expect(await f.undo(id)).toMatchObject({ tracked: { state: "restoring", momentCount: 1 } });
    f.history.undoHistoryOperation.mockResolvedValueOnce({ operationId: id, versionId: "main", momentCount: 1,
      compensationOperationId: "undo", deduped: true, materialized: true });
    expect(await f.undo(id, "next")).toMatchObject({ tracked: { state: "restored", momentCount: 1 } });
  });
  it("names a missing staged source before engine commit", async () => {
    const f = await fixture();
    const id = await deleted(f);
    const trash = join(f.root, ".dohc/trash");
    const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    await rm(join(trash, staged, "rowless.txt"));
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
    const outside = await createTestScratch("delete-review-link-");
    await symlink(outside, join(f.root, "folder/link"), process.platform === "win32" ? "junction" : "dir");
    const result = await f.remove(true);
    expect(result.undo).toEqual({ available: true });
    expect(await f.undo(result.operationId!)).toMatchObject({ ok: true, remaining: [] });
    await writeFile(join(outside, "original.txt"), "original target");
    expect(await readFile(join(f.root, "folder/link/original.txt"), "utf8")).toBe("original target");
  });
});
