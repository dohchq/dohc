import { readDeleteRecovery } from "./workspaceDeleteRecovery";
import { undoWorkspaceHistoryOperation } from "./workspaceHistoryOperations";
import { chmod, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { deleteWorkspacePathByHand, prepareDeleteWorkspacePathAs, type PathChangeOptions } from "./workspaceFileMoves";
import { openedLocalState } from "../testing/preparedLocalState";

const faults = vi.hoisted(() => ({
  openError: "", opened: [] as string[], recordSaves: 0, failRecord: false,
  copyOnly: false, failFlush: false, failCopy: "", copyModes: [] as number[],
  copyTarget: "", beforeResume: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      if (faults.copyOnly) throw Object.assign(new Error("cross-volume link"), { code: "EXDEV" });
      return actual.link(from, to);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]) === faults.copyTarget && (args[1] === "r+" || args[1] === "r")) {
        faults.opened.push(String(args[1]));
        if (faults.openError) throw Object.assign(new Error("directory link"), { code: faults.openError });
      }
      const copying = args[1] === "wx" && !basename(String(args[0])).startsWith("delete-");
      const file = await actual.open(...args);
      if (args[1] === "r+") await faults.beforeResume?.();
      if (copying) {
        const write = file.writeFile.bind(file), changeMode = file.chmod.bind(file);
        file.writeFile = async (...input) => {
          if (faults.failCopy === "write" && String(args[0]) === faults.copyTarget) {
            await write("not ");
            throw new Error("disk full");
          }
          return write(...input);
        };
        file.chmod = async mode => { faults.copyModes.push(Number(mode)); return changeMode(mode); };
        const sync = file.sync.bind(file);
        file.sync = async () => {
          if (faults.failFlush) throw new Error("flush failed");
          return sync();
        };
      }
      return file;
    },
    rename: async (from: string, to: string) => {
      if (to.endsWith(".json")) faults.recordSaves++;
      if (faults.failRecord && to.endsWith(".json")) {
        faults.failRecord = false;
        throw new Error("recovery save refused");
      }
      return actual.rename(from, to);
    },
  };
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
// A copy of the 12-byte "not retained" that stopped partway holds what it
// wrote, zeros to byte 12, and Undo's 16-byte tag past the end.
async function copyBytes(): Promise<{ text: string; tagged: boolean }> {
  const bytes = await readFile(faults.copyTarget);
  const tagged = bytes.length === 12 + 16;
  return { text: (tagged ? bytes.subarray(0, 12) : bytes).toString("utf8").replace(/\0+$/u, ""), tagged };
}
async function deleted(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.remove();
  expect(result.undo).toEqual({ available: true });
  return result.operationId!;
}

describe("delete recovery failures", () => {
  it("resumes a lost engine receipt with a fresh caller id", async () => {
    const f = await fixture();
    const id = await deleted(f);
    f.history.undoHistoryOperation.mockImplementationOnce(async () => { faults.failRecord = true; return {
      operationId: id, versionId: "main", momentCount: 1, notRestored: [], compensationOperationId: "undo", deduped: false, materialized: false,
    }; });
    expect(await f.undo(id)).toMatchObject({ ok: false });
    expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/rowless.txt"] });
  });
  it.each([false])("a save failure during system trash preserves the completed delete (hand=%s)", async hand => {
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
});

describe("delete recovery placement and receipts", () => {
  it.each(["EISDIR"])("rejects a replay link before opening it (%s)", async openError => {
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
  it.each(["write", "flush"])("retries an interrupted owned copy (%s)", async failure => {
    const f = await fixture();
    const id = await deleted(f);
    faults.copyOnly = true; faults.failCopy = failure; faults.failFlush = failure === "flush";
    try {
      expect(await f.undo(id)).toMatchObject({ restored: [], remaining: [{ path: "folder/rowless.txt" }] });
      expect(await copyBytes()).toEqual(failure === "write"
        ? { text: "not ", tagged: true } : { text: "not retained", tagged: false });
      const trash = join(f.root, ".dohc/local/trash");
      const record = JSON.parse(await readFile(join(trash, (await readdir(trash)).find(name => name.endsWith(".json"))!), "utf8"));
      expect(record.result).toBeUndefined();
      expect(record.copies.find((copy: { path: string }) => copy.path === "folder/rowless.txt")).toMatchObject({ ino: (await stat(faults.copyTarget)).ino, size: 12 });
      faults.failCopy = ""; faults.failFlush = false;
      expect(await f.undo(id)).toMatchObject({ restored: ["folder/rowless.txt"], remaining: [] });
      expect(await readFile(faults.copyTarget, "utf8")).toBe("not retained");
    } finally { faults.copyOnly = false; faults.failCopy = ""; faults.failFlush = false; }
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
  it("records a person's delete without capture and restores every file", async () => {
    const f = await fixture();
    const result = await deleteWorkspacePathByHand(f.operation, "folder", person, { ...f.options, capture: null });
    expect(result.undo).toEqual({ available: true });
    expect(await f.undo(result.operationId!)).toMatchObject({ ok: true, restored: ["folder"] });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
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
  it.each([false])("names a missing staged source before engine commit (whole folder=%s)", async whole => {
    const f = await fixture();
    const id = await deleted(f);
    const trash = join(f.root, ".dohc/local/trash");
    const staged = (await readdir(trash)).find(name => name.endsWith("-folder"))!;
    await rm(whole ? join(trash, staged) : join(trash, staged, "rowless.txt"), { recursive: true });
    expect(await f.undo(id)).toMatchObject({ ok: false, reason: expect.stringContaining(`is no longer in .dohc/local/trash, and History has no copy of it. Check the system trash.`) });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  });
});
