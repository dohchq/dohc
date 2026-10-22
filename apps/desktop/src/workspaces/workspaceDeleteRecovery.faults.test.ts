import { readDeleteRecovery, undoDeleteRecovery } from "./workspaceDeleteRecovery";
import { undoWorkspaceHistoryOperation } from "./workspaceHistoryOperations";
import { chmod, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { createTestScratch } from "./testTemp";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { executeCli } from "@dohc/cli";
import { undoOperation } from "@dohc/mcp/tools";
import { createWorkspaceFileMutationOwner } from "./workspaceFileMutationOwner";
import { deleteWorkspacePathByHand, prepareDeleteWorkspacePathAs, type PathChangeOptions } from "./workspaceFileMoves";
import { openedLocalState } from "../testing/preparedLocalState";

const faults = vi.hoisted(() => ({ removeAfterStat: "", openError: "", opened: [] as string[], reads: [] as string[], recordSaves: 0, failRecord: false, copyOnly: false, failFlush: false, failCopy: "", readOnly: false, failPlace: false, pruneAttempts: 0, blockedPrune: "", visited: [] as string[], flushed: [] as string[], copyModes: [] as number[], exposed: false, beforePublish: undefined as undefined | ((target: string) => Promise<void>), copyTemps: [] as string[], copyTarget: "", sourceLimit: false, failRemove: false, beforeResume: undefined as undefined | (() => Promise<void>), modeCalls: [] as string[] }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    chmod: async (path: string, mode: number) => { faults.modeCalls.push(String(path)); return actual.chmod(path, mode); },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (faults.failRemove && (String(args[0]) === faults.copyTarget || basename(String(args[0])).startsWith(".dohc-undo-"))) throw new Error("scanner holds copy");
      if (String(args[0]) === faults.blockedPrune) { faults.pruneAttempts++; throw Object.assign(new Error("record held open"), { code: "EPERM" }); }
      // Node can clear a Windows read-only flag before unlinking the staged hard link.
      if (process.platform === "win32" && faults.readOnly && (!faults.copyOnly || faults.copyTemps.includes(String(args[0])))) {
        await actual.chmod(String(args[0]), 0o666).catch(() => undefined);
      }
      return actual.rm(...args);
    },
    lstat: async (path: string) => { const entry = await actual.lstat(path); if (String(path) === faults.removeAfterStat) await actual.rm(path); faults.visited.push(String(path)); return entry; },
    unlink: async (path: string) => {
      if (String(path) === faults.blockedPrune) { faults.pruneAttempts++; throw Object.assign(new Error("record held open"), { code: "EPERM" }); }
      return actual.unlink(path);
    },
    link: async (from: string, to: string) => {
      if (faults.failPlace && to.endsWith("rowless.txt")) throw new Error("placement refused");
      if (faults.sourceLimit && String(to) === faults.copyTarget && !faults.copyTemps.includes(String(from))) throw Object.assign(new Error("link count limit"), { code: "EMLINK" });
      if (faults.copyOnly) throw Object.assign(new Error("cross-volume link"), { code: "EXDEV" });
      if (faults.copyTemps.includes(String(from))) await faults.beforePublish?.(to);
      return actual.link(from, to);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]) === faults.copyTarget && (args[1] === "r+" || args[1] === "r")) {
        faults.opened.push(String(args[1]));
        if (faults.openError) throw Object.assign(new Error("directory link"), { code: faults.openError });
      }
      const copying = args[1] === "wx" && !basename(String(args[0])).startsWith("delete-");
      if (copying) await faults.beforePublish?.(String(args[0]));
      if (faults.failPlace && String(args[0]).includes("rowless.txt")) throw new Error("placement refused");
      if (faults.readOnly && String(args[0]).endsWith("rowless.txt") && args[1] === "r+" && ((await actual.stat(args[0])).mode & 0o222) === 0) {
        throw Object.assign(new Error("read-only file"), { code: "EPERM" });
      }
      const file = await actual.open(...args);
      if (args[1] === "r+") await faults.beforeResume?.();
      if (copying) {
        faults.copyTemps.push(String(args[0]));
        const write = file.writeFile.bind(file), close = file.close.bind(file), changeMode = file.chmod.bind(file);
        file.writeFile = async (...input) => {
          if (faults.failCopy === "write" && String(args[0]) === faults.copyTarget) { await write("not "); throw new Error("disk full"); }
          await write(...input);
          faults.exposed = existsSync(faults.copyTarget);
        };
        file.chmod = async mode => { faults.copyModes.push(Number(mode)); return changeMode(mode); };
        file.close = async () => { await close(); if (faults.failCopy === "close") throw new Error("close failed"); };
      }
      const sync = file.sync.bind(file);
      file.sync = async () => {
        if (copying) {
          faults.flushed.push(String(args[0]));
          if (faults.failFlush) throw new Error("flush failed");
        }
        return sync();
      };
      return file;
    }, rename: async (from: string, to: string) => {
    if (to.endsWith(".json")) faults.recordSaves++;
    if (faults.failRecord && to.endsWith(".json")) { faults.failRecord = false; throw new Error("recovery save refused"); }
    if (faults.copyTemps.includes(String(from))) await faults.beforePublish?.(to);
    return actual.rename(from, to);
  } };
});
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
    faults.reads.push(String(args[0]));
    return actual.createReadStream(...args);
  } };
});
const person = { kind: "human", humanId: "local:test" } as const;
async function fixture(systemAccepts = false, tracked = ["folder/tracked.txt"]) {
  const root = await createTestScratch("delete-recovery-faults-");
  const os = await createTestScratch("delete-recovery-faults-os-");
  faults.copyTarget = join(root, "folder/rowless.txt");
  await mkdir(join(root, ".dohc"));
  const write = async (path: string, body: string) => { await mkdir(join(root, "folder"), { recursive: true }); await writeFile(join(root, path), body); };
  await write("folder/tracked.txt", "tracked");
  await write("folder/rowless.txt", "not retained");
  const operation = { state: {}, signal: new AbortController().signal, workspace: { workspaceId: "test", attachmentId: Symbol(), rootPath: root, readOnly: false, shareView: undefined as unknown }, assertCurrent: vi.fn() };
  await openedLocalState(operation.workspace);
  const recordDelete = vi.fn(async () => "moment");
  const capture: PathChangeOptions["capture"] = { changePathsAs: async (_paths, _author, work) =>
    work({ policy: await readWorkspaceEnginePolicy(root), recordDisk: async () => tracked, delete: recordDelete } as never) };
  const options = { capture, requestId: "caller-request", markDeleted: vi.fn(), trashItem: async (path: string) => {
    if (!systemAccepts) throw new Error("OS refuses");
    await rename(path, join(os, basename(path)));
  } };
  const history = { resolveFiles: vi.fn(async () => ({versionId: "main", results: []})),readHistoryOperation: vi.fn(async (input: {operationId: string}) => ({operationId: input.operationId, versionId: "main", momentCount: 0, kind: null})),  readHistoryPage: vi.fn(async () => ({ moments: tracked.map(path => ({ operation: "delete", path })), protectedMoments: [], nextCursor: null }) as never), undoHistoryOperation: vi.fn(async () => ({ operationId: "unused", versionId: "main", momentCount: 1,
    notRestored: [], compensationOperationId: "undo", deduped: false, materialized: false })) };
  const remove = (hand = false) => hand ? deleteWorkspacePathByHand(operation, "folder", person, options)
    : prepareDeleteWorkspacePathAs(operation, "folder", person, options).then(finish => finish());
  const undo = (id: string) => undoWorkspaceHistoryOperation(operation, { operationId: id }, person, { agent: false, history });
  return { root, os, write, remove, undo, operation, recordDelete, history, options };
}
async function deleted(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.remove();
  expect(result.undo).toEqual({ available: true });
  return result.operationId!;
}

describe("delete recovery failures", () => {
  it("names the deleted folder when a resumed restore finds a file at its path", async () => {
    const f = await fixture(false, []);
    const id = await deleted(f);
    const record = (await readDeleteRecovery(f.root, id))!;
    record.engine = { materialized: true, momentCount: 0 };
    await writeFile(join(f.root, "folder"), "occupant");
    const result = await undoDeleteRecovery(f.operation.workspace, record, person, f.history, "test", () => undefined, () => undefined);
    expect(result).toMatchObject({ ok: true, restored: [], remaining: [{ path: "folder", retry: false,
      reason: `folder now occupies the old path. The deleted folder stays at .dohc/local/trash/${record.staged}.` }] });
    expect(await readFile(join(f.root, "folder"), "utf8")).toBe("occupant");
    expect(await readFile(join(f.root, ".dohc/local/trash", record.staged!, "rowless.txt"), "utf8")).toBe("not retained");
    expect(await f.undo(id)).toEqual(result);
  });
  it("reports a missing trash copy when a folder occupies an interrupted copy's path", async () => {
    const f = await fixture(); const id = await deleted(f);
    faults.copyOnly = true; faults.failCopy = "write";
    try {
      expect(await f.undo(id)).toMatchObject({ remaining: [{ retry: true }] });
      faults.failCopy = "";
      await rm(faults.copyTarget); await mkdir(faults.copyTarget);
      const record = (await readDeleteRecovery(f.root, id))!;
      faults.removeAfterStat = join(f.root, ".dohc/local/trash", record.staged!, "rowless.txt");
      const result = await undoDeleteRecovery(f.operation.workspace, record, person, f.history, "test", () => undefined, () => undefined);
      expect(result).toMatchObject({ restored: [], remaining: [{ path: "folder/rowless.txt", retry: false,
        reason: "folder/rowless.txt now occupies the old path. Its trash copy is gone." }] });
      expect(await f.undo(id)).toEqual(result);
      expect((await stat(faults.copyTarget)).isDirectory()).toBe(true);
    } finally { faults.copyOnly = false; faults.failCopy = ""; faults.removeAfterStat = ""; }
  });
  it.each([false, true])("restores a read-only rowless file without reopening it for writing (copy=%s)", async copyOnly => {
    const f = await fixture();
    await chmod(join(f.root, "folder/rowless.txt"), 0o444);
    const id = await deleted(f);
    faults.readOnly = true; faults.copyOnly = copyOnly;
    try {
      expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/rowless.txt"], remaining: [] });
      expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("not retained");
      expect((await stat(join(f.root, "folder/rowless.txt"))).mode & 0o222).toBe(0);
    } finally { faults.readOnly = false; faults.copyOnly = false; }
  });
  it("keeps a delete's Undo when an expired record cannot be pruned", async () => {
    const f = await fixture();
    const trash = join(f.root, ".dohc/local/trash");
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
    expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/rowless.txt"] });
    const calls = f.history.undoHistoryOperation.mock.calls as unknown as [{ requestId: string }][];
    expect(calls.map(([input]) => input.requestId)).toEqual([`delete-undo:${id}`, `delete-undo:${id}`]);
  });
  it("resumes a lost engine receipt with a fresh caller id", async () => {
    const f = await fixture();
    const id = await deleted(f);
    f.history.undoHistoryOperation.mockImplementationOnce(async () => { faults.failRecord = true; return {
      operationId: id, versionId: "main", momentCount: 1, notRestored: [], compensationOperationId: "undo", deduped: false, materialized: false,
    }; });
    expect(await f.undo(id)).toMatchObject({ ok: false });
    expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/rowless.txt"] });
  });
  it.each([false, true])("a failed recovery save does not fail a completed delete (hand=%s)", async hand => {
    const f = await fixture();
    faults.failRecord = true;
    try {
      const result = await f.remove(hand);
      // The files stayed in the workspace trash, so the words name it.
      expect(result).toMatchObject({ trashed: false, undo: { available: false,
        reason: "Delete finished. dohc could not save Undo information. Restore files from History or .dohc/local/trash." } });
      if (!hand) expect(result).toMatchObject({ ok: true, trashPath: expect.stringContaining(".dohc/local/trash/") });
      expect(f.recordDelete).toHaveBeenCalledWith("folder/tracked.txt");
      expect(existsSync(join(f.root, "folder"))).toBe(false);
    } finally { faults.failRecord = false; }
  });
  it.each([false, true])("a save failure during system trash preserves the completed delete (hand=%s)", async hand => {
    const f = await fixture(true, ["folder/tracked.txt", "folder/rowless.txt"]);
    const trash = f.options.trashItem;
    const saves = faults.recordSaves;
    f.options.trashItem = async path => { await trash(path); faults.failRecord = true; };
    try {
      const result = await f.remove(hand);
      expect(result).toMatchObject({ trashed: true, undo: { available: false,
        reason: "Delete finished. dohc could not save Undo information. Restore files from History or the system trash." } });
      if (!hand) expect(result).toMatchObject({ ok: true });
      expect(faults.recordSaves - saves).toBe(hand ? 1 : 2);
      expect(faults.failRecord).toBe(false);
      expect(f.recordDelete).toHaveBeenCalledWith("folder/tracked.txt");
      expect(existsSync(join(f.root, "folder"))).toBe(false);
      if (!hand) {
        const record = await readDeleteRecovery(f.root, result.operationId!);
        expect(record?.staged).toBeDefined();
        expect(existsSync(join(f.root, ".dohc/local/trash", record!.staged!))).toBe(false);
        expect(await readFile(join(f.os, record!.staged!, "rowless.txt"), "utf8")).toBe("not retained");
        expect(await f.undo(result.operationId!)).toMatchObject({ ok: true });
      }
    } finally { faults.failRecord = false; }
  });
  it("points to system trash when the final record save fails after an accepted move", async () => {
    const f = await fixture(true, []);
    const trash = f.options.trashItem;
    f.options.trashItem = async path => { await trash(path); faults.failRecord = true; };
    try {
      const result = await f.remove();
      expect(result).toMatchObject({ ok: true, trashed: true, undo: { available: false,
        reason: `Cannot undo the delete. folder is in the ${process.platform === "win32" ? "Recycle Bin" : "Trash"}. Restore it there.` } });
      expect(faults.failRecord).toBe(false);
      const record = await readDeleteRecovery(f.root, result.operationId!);
      expect(record?.staged).toBeDefined();
      expect(existsSync(join(f.root, ".dohc/local/trash", record!.staged!))).toBe(false);
      expect(await readFile(join(f.os, record!.staged!, "rowless.txt"), "utf8")).toBe("not retained");
      expect(await f.undo(result.operationId!)).toEqual({ ok: false,
        reason: `Cannot undo the delete. folder is no longer in .dohc/local/trash, and History has no copy of it. Check the ${process.platform === "win32" ? "Recycle Bin" : "Trash"}.` });
      expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
    } finally { faults.failRecord = false; }
  });
  it("a healthy OS trash does not require healthy workspace trash", async () => {
    const f = await fixture(true);
    await writeFile(join(f.root, ".dohc/local/trash"), "unavailable");
    expect(await f.remove(true)).toMatchObject({ trashed: true, undo: { available: false, reason: expect.stringMatching(/in the (Recycle Bin|Trash)\. Restore it there\.$/) } });
    expect(f.recordDelete).toHaveBeenCalledWith("folder/tracked.txt");
    expect(existsSync(join(f.root, "folder"))).toBe(false);
  });
  it("prunes expired metadata once without reading records or removing fallback bytes", async () => {
    const f = await fixture();
    const trash = join(f.root, ".dohc/local/trash");
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
    await openedLocalState(f.operation.workspace);
    const id = await deleted(f);
    expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/rowless.txt"], remaining: [] });
    expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("not retained");
  });
});


describe("delete recovery placement and receipts", () => {
  it.each(["EISDIR", "EPERM", "EACCES"])("rejects a replay link before opening it (%s)", async openError => {
    const f = await fixture();
    const id = await deleted(f);
    faults.copyOnly = true; faults.failCopy = "write";
    try {
      await f.undo(id);
      faults.failCopy = "";
      await rm(faults.copyTarget);
      const destination = join(f.root, ".dohc/local/trash");
      await symlink(destination, faults.copyTarget, process.platform === "win32" ? "junction" : "dir");
      faults.openError = openError; faults.opened = [];
      expect(await f.undo(id)).toMatchObject({ restored: [], remaining: [{
        path: "folder/rowless.txt", reason: expect.stringContaining("now occupies"),
      }] });
      expect(faults.opened).toEqual([]);
      expect(await readlink(faults.copyTarget)).toContain("trash");
    } finally { faults.copyOnly = false; faults.failCopy = ""; faults.openError = ""; }
  });
  it("classifies an EISDIR open race as an occupant on every host", async () => {
    const f = await fixture();
    const id = await deleted(f);
    faults.copyOnly = true; faults.failCopy = "write";
    try {
      await f.undo(id);
      faults.failCopy = ""; faults.openError = "EISDIR"; faults.opened = [];
      expect(await f.undo(id)).toMatchObject({ remaining: [{
        path: "folder/rowless.txt", reason: expect.stringContaining("now occupies"),
      }] });
      expect(faults.opened).toEqual(["r+"]);
      expect(await readFile(faults.copyTarget, "utf8")).toBe("not ");
    } finally { faults.copyOnly = false; faults.failCopy = ""; faults.openError = ""; }
  });
  it("offers another Undo and a trash path after an interrupted copy", async () => {
    const f = await fixture();
    const id = await deleted(f);
    faults.copyOnly = true; faults.failCopy = "write";
    try {
      expect(await f.undo(id)).toMatchObject({ remaining: [{ path: "folder/rowless.txt",
        reason: expect.stringMatching(/folder\/rowless.txt may be incomplete\. Undo again to retry, or restore it from \.dohc\/local\/trash\//),
      }] });
      expect(await readFile(faults.copyTarget, "utf8")).toBe("not ");
      faults.failCopy = "";
      expect(await f.undo(id)).toMatchObject({ remaining: [] });
      expect(await readFile(faults.copyTarget, "utf8")).toBe("not retained");
    } finally { faults.copyOnly = false; faults.failCopy = ""; }
  });
  it.each(["parent", "source", "parent link", "fresh open"])("gives actionable recovery advice when retry cannot finish (%s)", async change => {
    const f = await fixture();
    const id = await deleted(f);
    const trash = join(f.root, ".dohc/local/trash");
    const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    faults.copyOnly = true; faults.failCopy = "write";
    try {
      await f.undo(id);
      faults.failCopy = "";
      if (change === "source") await rm(join(trash, staged, "rowless.txt"));
      else if (change === "fresh open") {
        await rm(faults.copyTarget);
        faults.failPlace = true;
      } else {
        await rm(join(f.root, "folder"), { recursive: true });
        if (change === "parent link") await symlink(trash, join(f.root, "folder"), process.platform === "win32" ? "junction" : "dir");
      }
      const result = await f.undo(id);
      if (change === "parent link") {
        expect(result).toEqual({ ok: false, reason: "Cannot undo the delete. folder/rowless.txt now leads somewhere else." });
        return;
      }
      expect(result).toMatchObject({ restored: [], remaining: [{ path: "folder/rowless.txt", retry: change !== "source",
        reason: change === "source"
          ? "folder/rowless.txt may be incomplete. Its trash copy is gone."
          : `dohc could not put folder/rowless.txt back. It stays at .dohc/local/trash/${staged}/rowless.txt.`,
      }] });
      if (change === "source") expect(await f.undo(id)).toEqual(result);
      expect(existsSync(faults.copyTarget)).toBe(change === "source");
      if (change !== "source") expect(await readFile(join(trash, staged, "rowless.txt"), "utf8")).toBe("not retained");
    } finally { faults.copyOnly = false; faults.failCopy = ""; faults.failPlace = false; }
  });
  it.each([false, true])("cleans up staged empty folders without removing new contents (occupied=%s)", async occupied => {
    const f = await fixture();
    await mkdir(join(f.root, "folder/empty"));
    const id = await deleted(f);
    const trash = join(f.root, ".dohc/local/trash");
    const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    const source = join(trash, staged, "empty");
    if (occupied) await writeFile(join(source, "keep.txt"), "new contents");
    expect(await f.undo(id)).toMatchObject({ restored: ["folder/rowless.txt", "folder/empty"], remaining: [] });
    expect((await stat(join(f.root, "folder/empty"))).isDirectory()).toBe(true);
    expect(existsSync(source)).toBe(occupied);
    if (occupied) expect(await readFile(join(source, "keep.txt"), "utf8")).toBe("new contents");
    expect(await readFile(join(trash, staged, "tracked.txt"), "utf8")).toBe("tracked");
  });
  it("removes empty nested staging folders after a split retry without removing retained bytes", async () => {
    const f = await fixture(false, []);
    await mkdir(join(f.root, "folder/nested"));
    await writeFile(join(f.root, "folder/nested/child.txt"), "nested");
    const id = await deleted(f);
    const trash = join(f.root, ".dohc/local/trash");
    const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    faults.copyOnly = true; faults.failCopy = "write";
    try {
      expect(await f.undo(id)).toMatchObject({ remaining: [{ path: "folder/rowless.txt" }] });
      expect(existsSync(join(trash, staged, "nested"))).toBe(false);
      expect(await readFile(join(trash, staged, "rowless.txt"), "utf8")).toBe("not retained");
      faults.failCopy = "";
      expect(await f.undo(id)).toMatchObject({ remaining: [] });
      expect(existsSync(join(trash, staged))).toBe(false);
      expect(await readFile(join(f.root, "folder/nested/child.txt"), "utf8")).toBe("nested");
    } finally { faults.copyOnly = false; faults.failCopy = ""; }
  });
  it.each([0, 32])("reads fresh fallback bytes once while retaining ownership saves (%s package files)", async count => {
    const f = await fixture();
    await mkdir(join(f.root, "folder/node_modules/pkg"), { recursive: true });
    for (let index = 0; index < count; index++) {
      await writeFile(join(f.root, `folder/node_modules/pkg/${index}.js`), "x".repeat(64 * 1024));
    }
    const removed = await f.remove(true);
    expect(removed.undo).toEqual({ available: true });
    const id = removed.operationId!;
    faults.copyOnly = true; faults.reads = []; faults.recordSaves = 0;
    try {
      expect(await f.undo(id)).toMatchObject({ remaining: [] });
      expect(faults.reads).toHaveLength(count + 1);
      expect(faults.reads[0]).toContain("trash");
      expect(faults.recordSaves).toBe(count + 3); // Engine receipt, ownership per file, completed result.
      expect(await readFile(faults.copyTarget, "utf8")).toBe("not retained");
    } finally { faults.copyOnly = false; }
  });
  it.each([false, true])("releases completed sources and retries only pending paths (copy siblings=%s)", async copySiblings => {
    const f = await fixture(false, []);
    const id = await deleted(f);
    faults.copyOnly = copySiblings; faults.failCopy = "write";
    // Only the failing path needs the fallback in the hard-link sibling case.
    faults.sourceLimit = !copySiblings;
    try {
      expect(await f.undo(id)).toMatchObject({ restored: ["folder/tracked.txt"], remaining: [{ path: "folder/rowless.txt" }] });
      const trash = join(f.root, ".dohc/local/trash");
      const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
      expect(existsSync(join(trash, staged, "tracked.txt"))).toBe(false);
      await rm(join(f.root, "folder/tracked.txt"));
      faults.failCopy = "";
      expect(await f.undo(id)).toMatchObject({ restored: ["folder/tracked.txt", "folder/rowless.txt"], remaining: [] });
      expect(existsSync(join(f.root, "folder/tracked.txt"))).toBe(false);
      expect(existsSync(join(trash, staged))).toBe(false);
      expect(await readFile(faults.copyTarget, "utf8")).toBe("not retained");
    } finally { faults.copyOnly = false; faults.sourceLimit = false; faults.failCopy = ""; }
  });
  it.runIf(process.platform === "win32")("does not chmod writable hard-linked files again", async () => {
    const f = await fixture();
    const id = await deleted(f);
    faults.modeCalls = [];
    expect(await f.undo(id)).toMatchObject({ remaining: [] });
    expect(faults.modeCalls).toEqual([]);
  });
  it("leaves no shared copy link when temp removal would fail", async () => {
    const f = await fixture();
    await chmod(join(f.root, "folder/rowless.txt"), 0o444);
    const id = await deleted(f);
    faults.sourceLimit = true; faults.failRemove = true; faults.readOnly = true; faults.copyTemps = [];
    try {
      expect(await f.undo(id)).toMatchObject({ remaining: [] });
      expect((await readdir(join(f.root, ".dohc/local/trash"))).filter(name => name.startsWith(".dohc-undo-"))).toEqual([]);
      expect(await f.undo(id)).toMatchObject({ remaining: [] });
      expect((await stat(faults.copyTarget)).mode & 0o222).toBe(0);
    } finally { faults.sourceLimit = false; faults.failRemove = false; faults.readOnly = false; }
  });
  it.each(["write", "flush", "close", "readonly", "readonly-write"])("retries an interrupted owned copy (%s)", async failure => {
    const f = await fixture();
    if (failure === "readonly-write") await chmod(faults.copyTarget, 0o444);
    const id = await deleted(f);
    faults.copyOnly = true; faults.failCopy = failure === "readonly" ? "close" : failure === "readonly-write" ? "write" : failure; faults.failFlush = failure === "flush";
    try {
      expect(await f.undo(id)).toMatchObject({ restored: [], remaining: [{ path: "folder/rowless.txt" }] });
      expect(await readFile(faults.copyTarget, "utf8")).toBe(failure === "write" || failure === "readonly-write" ? "not " : "not retained");
      const trash = join(f.root, ".dohc/local/trash");
      const record = JSON.parse(await readFile(join(trash, (await readdir(trash)).find(name => name.endsWith(".json"))!), "utf8"));
      expect(record.result).toBeUndefined();
      expect(record.copies.find((copy: { path: string }) => copy.path === "folder/rowless.txt")).toMatchObject({ ino: (await stat(faults.copyTarget)).ino, size: 12 });
      faults.failCopy = ""; faults.failFlush = false;
      if (failure === "readonly" || failure === "readonly-write") { await chmod(faults.copyTarget, 0o444); faults.readOnly = true; }
      expect(await f.undo(id)).toMatchObject({ restored: ["folder/rowless.txt"], remaining: [] });
      expect(await readFile(faults.copyTarget, "utf8")).toBe("not retained");
    } finally { faults.copyOnly = false; faults.failCopy = ""; faults.failFlush = false; faults.failRemove = false; faults.readOnly = false; }
  });

  it("does not overwrite an occupant swapped after opening a partial copy for replay", async () => {
    const f = await fixture();
    const id = await deleted(f);
    faults.copyOnly = true; faults.failCopy = "write";
    try {
      await f.undo(id);
      faults.failCopy = "";
      faults.beforeResume = async () => {
        await rm(faults.copyTarget);
        await writeFile(faults.copyTarget, "racing replacement");
      };
      expect(await f.undo(id)).toMatchObject({ restored: [], remaining: [{ path: "folder/rowless.txt" }] });
      expect(await readFile(faults.copyTarget, "utf8")).toBe("racing replacement");
    } finally { faults.copyOnly = false; faults.failCopy = ""; faults.beforeResume = undefined; }
  });
  it.each(["edit", "replace", "grow", "link"])("never removes an occupant that differs from the interrupted copy (%s)", async change => {
    const f = await fixture();
    const id = await deleted(f);
    faults.copyOnly = true; faults.failCopy = "write"; faults.failRemove = true;
    try {
      await f.undo(id);
      faults.failCopy = ""; faults.failRemove = false;
      if (change === "replace" || change === "link") await rm(faults.copyTarget);
      if (change === "link") await symlink(join(f.root, ".dohc/local/trash"), faults.copyTarget, process.platform === "win32" ? "junction" : "dir");
      else await writeFile(faults.copyTarget, change === "edit" ? "edit" : change === "grow" ? "not retained plus a later edit" : "not ");
      const before = await stat(faults.copyTarget);
      expect(await f.undo(id)).toMatchObject({ restored: [], remaining: [{ path: "folder/rowless.txt", reason: expect.stringContaining("now occupies") }] });
      expect((await stat(faults.copyTarget)).ino).toBe(before.ino);
      if (change === "link") expect(await readlink(faults.copyTarget)).toContain("trash");
      else expect(await readFile(faults.copyTarget, "utf8")).toBe(change === "edit" ? "edit" : change === "grow" ? "not retained plus a later edit" : "not ");
    } finally { faults.copyOnly = false; faults.failCopy = ""; faults.failRemove = false; }
  });

  it("creates only the original file name, with bookkeeping excluded from capture", async () => {
    const f = await fixture();
    const id = await deleted(f);
    faults.copyOnly = true; faults.copyTemps = [];
    try {
      expect(await f.undo(id)).toMatchObject({ restored: ["folder/rowless.txt"], remaining: [] });
      expect(faults.copyTemps).toEqual([faults.copyTarget]);
      expect(await readdir(join(f.root, "folder"))).toEqual(["rowless.txt"]);
      expect(classifyEngineFilePath(".dohc/local/trash/delete-record.json")).toEqual({ kind: "ignored" });
    } finally { faults.copyOnly = false; }
  });
  it("keeps a racing occupant and names the retained trash source when publishing a copy", async () => {
    const f = await fixture();
    const id = await deleted(f);
    faults.copyOnly = true;
    faults.beforePublish = target => writeFile(target, "raced occupant");
    try {
      const result = await f.undo(id);
      expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("raced occupant");
      const trash = join(f.root, ".dohc/local/trash");
      const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
      expect(result).toMatchObject({ restored: [], remaining: [{ path: "folder/rowless.txt",
        retry: false, reason: `folder/rowless.txt now occupies the old path. The deleted file stays at .dohc/local/trash/${staged}/rowless.txt.` }] });
      expect(await readFile(join(trash, staged, "rowless.txt"), "utf8")).toBe("not retained");
    } finally { faults.copyOnly = false; faults.beforePublish = undefined; }
  });
  it("restores files without History when every hard link fails with EXDEV", async () => {
    const f = await fixture();
    const id = await deleted(f);
    faults.copyOnly = true;
    try {
      expect(await f.undo(id)).toMatchObject({ restored: ["folder/rowless.txt"], remaining: [] });
      expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("not retained");
    } finally { faults.copyOnly = false; }
  });
  it.each(["", "write", "flush", "close"])("reports failed copies as in progress until replay completes (failure=%s)", async failure => {
    const f = await fixture();
    if (failure === "flush") await chmod(join(f.root, "folder/rowless.txt"), 0o444);
    const id = await deleted(f);
    const trash = join(f.root, ".dohc/local/trash");
    const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    faults.copyOnly = true; faults.failFlush = failure === "flush"; faults.failCopy = failure; faults.flushed = []; faults.exposed = false;
    try {
      const result = await f.undo(id);
      expect(existsSync(join(f.root, "folder/rowless.txt"))).toBe(true);
      expect(await readdir(join(f.root, "folder"))).toEqual(["rowless.txt"]);
      expect(existsSync(join(trash, staged, "rowless.txt"))).toBe(!!failure);
      expect(result).toMatchObject(failure ? { restored: [], remaining: [{ path: "folder/rowless.txt" }] }
        : { restored: ["folder/rowless.txt"], remaining: [] });
      if (!failure) { expect(faults.flushed).toHaveLength(1); expect(faults.exposed).toBe(true); }
    } finally { faults.copyOnly = false; faults.failFlush = false; faults.failCopy = ""; }
  });
  it("copies the source mode exactly before flushing, independent of umask", async () => {
    const f = await fixture();
    await chmod(join(f.root, "folder/rowless.txt"), 0o664);
    const mode = (await stat(join(f.root, "folder/rowless.txt"))).mode & 0o7777;
    const id = await deleted(f);
    faults.copyOnly = true; faults.copyModes = [];
    try {
      expect(await f.undo(id)).toMatchObject({ restored: ["folder/rowless.txt"], remaining: [] });
      expect(faults.copyModes).toEqual([mode]);
      expect((await stat(join(f.root, "folder/rowless.txt"))).mode & 0o7777).toBe(mode);
    } finally { faults.copyOnly = false; }
  });
  it("reports placed children when a rowless folder is only partly placed", async () => {
    const f = await fixture(false, []);
    const id = await deleted(f);
    faults.failPlace = true;
    try {
      const result = await f.undo(id);
      expect(result).toMatchObject({ ok: true, restored: ["folder/tracked.txt"], remaining: [{ path: "folder/rowless.txt" }] });
      const trash = join(f.root, ".dohc/local/trash");
      const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
      expect(existsSync(join(trash, staged, "tracked.txt"))).toBe(false);
      expect(existsSync(join(trash, staged, "rowless.txt"))).toBe(true);
    } finally { faults.failPlace = false; }
  });
  it.each([false, true])("recreates an empty folder after OS trash accepts (already exists=%s)", async exists => {
    const f = await fixture(true, []);
    await rm(join(f.root, "folder"), { recursive: true });
    await mkdir(join(f.root, "folder"));
    const result = await f.remove(true);
    expect(result.undo).toEqual({ available: true });
    if (exists) await mkdir(join(f.root, "folder"));
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
    expect(await f.undo(id)).toEqual(first);
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
      notRestored: [], compensationOperationId: "undo", deduped: true, materialized: true });
    expect(await f.undo(id)).toMatchObject({ tracked: { state: "restored", momentCount: 1 } });
  });
  it.each([false, true])("names a missing staged source before engine commit (whole folder=%s)", async whole => {
    const f = await fixture();
    const id = await deleted(f);
    const trash = join(f.root, ".dohc/local/trash");
    const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    await rm(whole ? join(trash, staged) : join(trash, staged, "rowless.txt"), { recursive: true });
    expect(await f.undo(id)).toMatchObject({ ok: false, reason: expect.stringContaining(`is no longer in .dohc/local/trash, and History has no copy of it. Check the ${process.platform === "win32" ? "Recycle Bin" : "Trash"}.`) });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  });
  it("expires metadata without deleting fallback bytes", async () => {
    const f = await fixture();
    const id = await deleted(f);
    const trash = join(f.root, ".dohc/local/trash");
    const record = (await readdir(trash)).find(name => name.endsWith(".json"))!;
    const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    await vi.waitFor(() => expect(faults.visited).toContain(join(trash, record)));
    await utimes(join(trash, record), new Date(0), new Date(0));
    expect(await f.undo(id)).toMatchObject({ ok: false, reason: "Cannot undo the delete. Its recovery record is missing or expired. Restore files from History, the system trash, or .dohc/local/trash." });
    await f.write("folder/tracked.txt", "new");
    await f.write("folder/rowless.txt", "new");
    await f.remove();
    expect(await readdir(trash)).toContain(record);
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

it.each(["ipc", "cli", "mcp"] as const)("shows an occupied pending copy and retries it through %s", async door => {
  const f = await fixture(); const id = await deleted(f);
  faults.copyOnly = true; faults.failCopy = "write";
  try {
    expect(await f.undo(id)).toMatchObject({ remaining: [{ retry: true }] });
    faults.failCopy = ""; await rm(faults.copyTarget); await writeFile(faults.copyTarget, "occupant");
    const owner = createWorkspaceFileMutationOwner({
      historyFor: () => f.history, assertTrustedSender: () => undefined,
      withRendererWorkspaceOperation: async (_event, _id, work) => work({ workspace: f.operation.workspace, signal: f.operation.signal,
        authorityId: f.operation.workspace.attachmentId, capture: null,
        yDocSessions: { withDocumentUnowned: async (_id, _path, work) => work(), markDeletedUnderPath: () => undefined }, assertCurrent: () => undefined }),
      shareViewFiles: { change: async () => { throw new Error("No share writes"); } }, trashItem: async () => undefined,
      localPerson: async () => person, notifyRenderer: () => undefined, shareViewEdited: () => undefined, logError: () => undefined,
    });
    const call = async () => {
      if (door === "ipc") return owner.undoHistoryOperation({}, { workspaceId: "test", operationId: id });
      if (door === "mcp") return undoOperation({ root: f.root, home: f.root, request: async () => f.undo(id) }, { operationId: id });
      return executeCli({ argv: ["history", "undo", id], cwd: f.root, request: async () => f.undo(id) });
    };
    const recordBefore = (await readDeleteRecovery(f.root, id))!;
    const reason = `folder/rowless.txt now occupies the old path. Move it first. The deleted file stays at .dohc/local/trash/${recordBefore.staged}/rowless.txt.`;
    const occupied = await call();
    if (door === "cli") expect(occupied).toMatchObject({ exitCode: 1, stdout: expect.stringContaining(reason) });
    else expect(occupied).toMatchObject({ ok: true, remaining: [{ retry: true, reason }] });
    expect(await readFile(faults.copyTarget, "utf8")).toBe("occupant");
    await rename(faults.copyTarget, faults.copyTarget + ".occupant");
    const finished = await call();
    if (door === "cli") expect(finished).toMatchObject({ exitCode: 0 }); else expect(finished).toMatchObject({ ok: true, remaining: [] });
    expect(await readFile(faults.copyTarget, "utf8")).toBe("not retained");
    const record = JSON.parse(await readFile(join(f.root, ".dohc/local/trash", (await readdir(join(f.root, ".dohc/local/trash"))).find(name => name.endsWith(".json"))!), "utf8"));
    expect(JSON.stringify(record)).not.toContain('"retry"');
  } finally { faults.copyOnly = false; faults.failCopy = ""; }
});
