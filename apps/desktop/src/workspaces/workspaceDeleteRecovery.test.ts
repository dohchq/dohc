import { mkdir, readFile, rename, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { HistoryUndoResult } from "@dohc/workspace-contracts/engine";
import { createTestScratch } from "./testTemp";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { deleteWorkspacePathByHand, prepareDeleteWorkspacePathAs, undoWorkspaceDelete, type PathChangeOptions } from "./workspaceFileMoves";

const faults = vi.hoisted(() => ({ beforeLink: undefined as undefined | ((to: string) => Promise<void>), failRecord: false }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    link: async (from: string, to: string) => { await faults.beforeLink?.(to); return actual.link(from, to); },
    rename: async (from: string, to: string) => {
      if (faults.failRecord && to.endsWith(".json")) { faults.failRecord = false; throw new Error("Interrupted after engine commit"); }
      return actual.rename(from, to);
    },
  };
});
const person = { kind: "human", humanId: "local:test" } as const;
async function fixture(tracked = ["folder/tracked.txt"], systemAccepts = false) {
  const root = await createTestScratch("delete-recovery-");
  const os = await createTestScratch("delete-recovery-os-");
  await mkdir(join(root, ".dohc"));
  const write = async (path: string, body: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), body); };
  await write("folder/tracked.txt", "tracked");
  await write("folder/rowless.txt", "not retained");
  const operation = { workspace: { rootPath: root, attachmentId: Symbol(), readOnly: false, shareView: undefined as unknown }, state: {},
    signal: new AbortController().signal, assertCurrent: vi.fn() };
  const groups: string[] = [];
  const recordDisk = vi.fn(async () => tracked);
  const capture: PathChangeOptions["capture"] = { changePathsAs: async (_paths, authored, work) => {
    groups.push(authored.operationId);
    return work({ policy: await readWorkspaceEnginePolicy(root), recordDisk, delete: vi.fn(async () => "moment") } as never);
  } };
  const trashItem = vi.fn(async (path: string) => { if (!systemAccepts) throw new Error("OS refuses"); await rename(path, join(os, basename(path))); });
  const options = { capture, requestId: "caller-request", trashItem, markDeleted: vi.fn() };
  let committed: HistoryUndoResult | undefined;
  let releasePlacement!: () => void;
  const placementGate = new Promise<void>(resolve => { releasePlacement = resolve; });
  let placement: Promise<void> | undefined;
  let interrupted = false;
  let refuse: string | undefined;
  const history = { undoHistoryOperation: vi.fn(async (input: { operationId: string; requestId: string }) => {
    if (refuse) throw new Error(refuse);
    if (!committed) placement = placementGate.then(async () => { for (const path of tracked) await write(path, "tracked"); });
    committed ??= { operationId: input.operationId, versionId: "main", momentCount: tracked.length,
      compensationOperationId: "dohc-operation:undo:one", deduped: false, materialized: false };
    if (interrupted) { interrupted = false; faults.failRecord = true; }
    return committed;
  }) };
  const remove = async (hand = false) => hand ? deleteWorkspacePathByHand(operation, "folder", person, options)
    : (await prepareDeleteWorkspacePathAs(operation, "folder", person, options))();
  const undo = (id: string, requestId = "undo-request") => undoWorkspaceDelete(operation, { operationId: id, requestId }, person, { workspaceId: "test", history });
  return { root, write, remove, undo, history, groups, operation, recordDisk,
    interrupt: () => { interrupted = true; }, refuse: (message: string) => { refuse = message; },
    placeTracked: async () => { expect(placement).toBeDefined(); releasePlacement(); await placement; },
  };
}
function recovery(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["remove"]>>) {
  expect(result).toMatchObject({ operationId: expect.stringMatching(/^dohc-operation:/), undo: { available: true } });
  if (!result.operationId) throw new Error("Delete did not return its operation id");
  return result.operationId;
}

describe("delete recovery", () => {
  it.each([false, true])("restores tracked and rowless files after OS refusal (hand=%s)", async hand => {
    const f = await fixture();
    const id = recovery(await f.remove(hand));
    const result = await f.undo(id);
    expect(result).toMatchObject({ ok: true, tracked: { state: "restoring", count: 1 }, restored: ["folder/rowless.txt"], remaining: [] });
    expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("not retained");
    expect(existsSync(join(f.root, "folder/tracked.txt"))).toBe(false);
    await f.placeTracked();
    expect(await readFile(join(f.root, "folder/tracked.txt"), "utf8")).toBe("tracked");
  });
  it.each([false, true])("offers no partial Undo when the OS accepts rowless files (hand=%s)", async hand => {
    const f = await fixture(undefined, true);
    const result = await f.remove(hand);
    const where = process.platform === "win32" ? "in the Recycle Bin" : "in the Trash";
    expect(result).toMatchObject({ undo: { available: false, paths: ["folder/rowless.txt"],
      reason: `Cannot undo this delete. folder/rowless.txt is ${where}. Restore it there.` } });
    expect(await f.undo(result.operationId!)).toMatchObject({ ok: false, reason: expect.stringContaining(where) });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  });
  it("offers Undo for tracked-only files even after OS trash accepts", async () => {
    const f = await fixture(["folder/tracked.txt", "folder/rowless.txt"], true);
    const id = recovery(await f.remove());
    expect(await f.undo(id)).toMatchObject({ ok: true, tracked: { state: "restoring", count: 2 }, restored: [] });
    await f.placeTracked();
    expect(await readFile(join(f.root, "folder/tracked.txt"), "utf8")).toBe("tracked");
  });
  it("refuses the whole Undo before engine commit when an old path is occupied", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    await f.write("folder/rowless.txt", "occupant");
    expect(await f.undo(id)).toEqual({ ok: false, reason: "Cannot undo the delete. folder/rowless.txt now occupies the old path. Move it first." });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("occupant");
    expect(existsSync(join(f.root, "folder/tracked.txt"))).toBe(false);
  });
  it("replays the first result without undoing or moving twice", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    const first = await f.undo(id);
    await f.write("folder/rowless.txt", "later edit");
    expect(await f.undo(id)).toEqual(first);
    expect(f.history.undoHistoryOperation).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("later edit");
  });
  it("finishes moves after interruption between engine commit and the recovery receipt", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    f.interrupt();
    expect(await f.undo(id)).toEqual({ ok: false, reason: "Interrupted after engine commit" });
    expect(existsSync(join(f.root, "folder/rowless.txt"))).toBe(false);
    expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/rowless.txt"] });
    expect(f.history.undoHistoryOperation).toHaveBeenCalledTimes(2);
    expect(f.history.undoHistoryOperation.mock.calls.map(([input]) => input.requestId)).toEqual(["undo-request", "undo-request"]);
  });
  it("groups the delete with the minted id, never the caller request id", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    expect(f.groups).toEqual([id]);
    expect(id).not.toBe("caller-request");
    expect(await f.undo(id)).toMatchObject({ ok: true });
    expect(f.history.undoHistoryOperation).toHaveBeenCalledWith(expect.objectContaining({ operationId: id, requestId: "undo-request" }));
  });
  it("moves nothing when the engine refuses, retaining its words", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    f.refuse("Cannot undo: tracked.txt occupies the old path");
    expect(await f.undo(id)).toEqual({ ok: false, reason: "Cannot undo: tracked.txt occupies the old path" });
    expect(existsSync(join(f.root, "folder/rowless.txt"))).toBe(false);
  });
  it("keeps a raced file in trash without replacing its new occupant", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    faults.beforeLink = async to => { await writeFile(to, "raced occupant"); };
    try {
      const result = await f.undo(id);
      expect(result).toMatchObject({ ok: true, restored: [], remaining: [{ path: "folder/rowless.txt", reason: expect.stringContaining("now occupies") }] });
      expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("raced occupant");
      const entry = (await readdir(join(f.root, ".dohc/trash"))).find(name => name.endsWith("-folder"))!;
      expect(await readFile(join(f.root, ".dohc/trash", entry, "rowless.txt"), "utf8")).toBe("not retained");
    } finally { faults.beforeLink = undefined; }
  });
});


describe("recovery durability and path authority", () => {
  it("restores rowless-only deletes without inventing a History operation", async () => {
    const f = await fixture([]);
    const id = recovery(await f.remove());
    expect(await f.undo(id)).toMatchObject({ ok: true, tracked: { state: "restored", count: 0 }, restored: ["folder"] });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("not retained");
  });
  it("recovers an excluded subtree without retaining a spare copy", async () => {
    const f = await fixture();
    await f.write("folder/node_modules/nested/file.txt", "excluded bytes");
    const id = recovery(await f.remove(true));
    expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/node_modules", "folder/rowless.txt"], remaining: [] });
    expect(await readFile(join(f.root, "folder/node_modules/nested/file.txt"), "utf8")).toBe("excluded bytes");
    const entry = (await readdir(join(f.root, ".dohc/trash"))).find(name => name.endsWith("-folder"))!;
    expect(existsSync(join(f.root, ".dohc/trash", entry, "node_modules"))).toBe(false);
  });
  it("replays a placement completed before its final receipt reached disk", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    faults.beforeLink = async () => { faults.failRecord = true; };
    try {
      expect(await f.undo(id)).toEqual({ ok: false, reason: "Interrupted after engine commit" });
      expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("not retained");
      faults.beforeLink = async () => { throw new Error("A replay tried to place twice"); };
      expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/rowless.txt"] });
      expect(f.history.undoHistoryOperation).toHaveBeenCalledTimes(1);
    } finally { faults.beforeLink = undefined; faults.failRecord = false; }
  });
  it("refuses recovery into a redirected old parent before engine commit", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    const outside = await createTestScratch("delete-recovery-outside-");
    await symlink(outside, join(f.root, "folder"), process.platform === "win32" ? "junction" : "dir");
    expect(await f.undo(id)).toMatchObject({ ok: false, reason: expect.stringContaining("now leads somewhere else") });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
  });
  it("refuses a read-only workspace before touching History", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    f.operation.workspace.readOnly = true;
    expect(await f.undo(id)).toEqual({ ok: false, reason: "This workspace is read-only. Change files in the owning workspace." });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  });
});
