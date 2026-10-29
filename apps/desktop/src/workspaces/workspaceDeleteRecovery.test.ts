import { readWorkspaceHistoryOperation, undoWorkspaceHistoryOperation } from "./workspaceHistoryOperations";
import { mkdir, readFile, rename, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { HistoryUndoResult } from "@dohc/workspace-contracts/engine";
import { createTestScratch } from "./testTemp";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { deleteWorkspacePathByHand, prepareDeleteWorkspacePathAs, type PathChangeOptions } from "./workspaceFileMoves";
import { deferred } from "../testing/deferred";
import { readDeleteRecovery } from "./workspaceDeleteRecovery";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import { openedLocalState } from "../testing/preparedLocalState";

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
const agent = { kind: "agent", agentId: "test-agent", onBehalfOf: "local:test" } as const;
async function fixture(tracked = ["folder/tracked.txt"], systemAccepts = false) {
  const root = await createTestScratch("delete-recovery-");
  const os = await createTestScratch("delete-recovery-os-");
  await mkdir(join(root, ".dohc"));
  const write = async (path: string, body: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), body); };
  await write("folder/tracked.txt", "tracked");
  await write("folder/rowless.txt", "not retained");
  const operation = { workspace: { workspaceId: "test", rootPath: root, attachmentId: Symbol(), readOnly: false, shareView: undefined as unknown }, state: {},
    signal: new AbortController().signal, assertCurrent: vi.fn() };
  await openedLocalState(operation.workspace);
  const groups: string[] = [];
  let afterCommit: ((id: string) => void) | undefined;
  const recordDisk = vi.fn(async () => tracked);
  const capture: PathChangeOptions["capture"] = { changePathsAs: async (_paths, authored, work) => {
    groups.push(authored.operationId);
    const result = await work({ policy: await readWorkspaceEnginePolicy(root), recordDisk, delete: vi.fn(async () => "moment") } as never);
    afterCommit?.(authored.operationId);
    return result;
  } };
  const trashItem = vi.fn(async (path: string) => { if (!systemAccepts) throw new Error("OS refuses"); await rename(path, join(os, basename(path))); });
  const options = { capture, requestId: "caller-request", trashItem, markDeleted: vi.fn() };
  let committed: HistoryUndoResult | undefined;
  let releasePlacement!: () => void;
  const placementGate = new Promise<void>(resolve => { releasePlacement = resolve; });
  let placement: Promise<void> | undefined;
  let interrupted = false;
  let refuse: string | undefined;
  const history = { resolveFiles: vi.fn(async () => ({versionId: "main", results: []})),readHistoryOperation: vi.fn(async (input: {operationId: string}) => ({operationId: input.operationId, versionId: "main", momentCount: 0, kind: null})),  readHistoryPage: vi.fn(async () => ({ moments: tracked.map(path => ({ operation: "delete", path })), protectedMoments: [], nextCursor: null }) as never), undoHistoryOperation: vi.fn(async (input: { operationId: string; requestId: string }) => {
    if (refuse) throw new Error(refuse);
    if (!committed) placement = placementGate.then(async () => { for (const path of tracked) await write(path, "tracked"); });
    committed ??= { operationId: input.operationId, versionId: "main", momentCount: tracked.length,
      notRestored: [], compensationOperationId: "dohc-operation:undo:one", deduped: false, materialized: false };
    if (interrupted) { interrupted = false; faults.failRecord = true; }
    return committed;
  }) };
  const remove = async (hand = false) => hand ? deleteWorkspacePathByHand(operation, "folder", person, options)
    : (await prepareDeleteWorkspacePathAs(operation, "folder", agent, options))();
  const undo = (id: string) => undoWorkspaceHistoryOperation(operation, { operationId: id }, person, { agent: false, history });
  return { root, write, remove, undo, history, groups, operation, recordDisk,
    options, afterCommit: (work: (id: string) => void) => { afterCommit = work; },
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
  it("reports skipped tracked members even when they have no manual trash entry", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    f.history.undoHistoryOperation.mockResolvedValue({ operationId: id, versionId: "main", notRestored: ["folder/tracked.txt"],
      compensationOperationId: "dohc-operation:undo:one", momentCount: 0, deduped: false, materialized: true });
    const result = await f.undo(id);
    expect(result).toMatchObject({ ok: true, remaining: [{ path: "folder/tracked.txt", retry: false }] });
    expect(await f.undo(id)).toEqual(result);
  });
  it.each([false, true])("keeps History readable and the invalid-path Undo refusal (system accepts=%s)", async accepts => {
    const f = await fixture(undefined, accepts);
    await f.write("folder/.dohc", "untracked");
    const result = await f.remove(true);
    expect(result).toMatchObject({ undo: { available: false,
      reason: "Cannot undo the delete. Invalid recovery path: folder/.dohc. Restore it from the trash." } });
    expect(await readDeleteRecovery(f.root, result.operationId!)).toBeUndefined();
    expect(await readWorkspaceHistoryOperation(f.operation, { operationId: result.operationId! }, f.history, {agent: true}))
      .toMatchObject({ ok: true, members: [{ operation: "delete", path: "folder/tracked.txt" }] });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  });

  it.each(["read", "undo"] as const)("an agent delete saves recovery before %s queued at History commit", async action => {
    const f = await fixture();
    let queued: Promise<unknown> | undefined;
    f.afterCommit(id => {
      queued = action === "read" ? readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history, {agent: true}) : f.undo(id);
    });
    const finish = await prepareDeleteWorkspacePathAs(f.operation, "folder", agent, f.options);
    expect(queued).toBeDefined();
    expect(await readDeleteRecovery(f.root, f.groups[0]!)).toMatchObject({ paths: ["folder/rowless.txt"] });
    expect(f.options.trashItem).not.toHaveBeenCalled();
    expect(await finish()).toMatchObject({ ok: true, undo: { available: true } });
    expect(await queued).toMatchObject(action === "read"
      ? { ok: true, withoutHistory: ["folder/rowless.txt"] }
      : { ok: true, restored: ["folder/rowless.txt"], remaining: [] });
  });

  it.each([false, true])("keeps an Undo receipt when slow system trash finishes (accepts=%s)", async accepts => {
    const f = await fixture(["folder/tracked.txt", "folder/rowless.txt"], accepts);
    const started = deferred<void>(), release = deferred<void>();
    const trash = f.options.trashItem.getMockImplementation()!;
    f.options.trashItem.mockImplementationOnce(async path => {
      started.resolve();
      await release.promise;
      await trash(path);
    });
    const pending = f.remove();
    try {
      await started.promise;
      const id = f.groups[0]!;
      const undo = f.undo(id);
      expect(await readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history, {agent: true})).toMatchObject({ ok: true });
      expect((await readDeleteRecovery(f.root, id))?.engine).toBeUndefined();
      release.resolve();
      expect(await pending).toMatchObject({ ok: true, trashed: accepts, undo: { available: true } });
      const result = await undo;
      expect(result).toMatchObject({ ok: true });
      const record = await readDeleteRecovery(f.root, id);
      expect(record?.result).toBeDefined();
      expect(await f.undo(id)).toEqual(result);
      expect(await readDeleteRecovery(f.root, id)).toEqual(record);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("finishes recovery without waiting for another workspace exclusive operation", async () => {
    const f = await fixture(["folder/tracked.txt", "folder/rowless.txt"], true);
    const trashStarted = deferred<void>(), releaseTrash = deferred<void>();
    const exclusiveStarted = deferred<void>(), releaseExclusive = deferred<void>();
    const trash = f.options.trashItem.getMockImplementation()!;
    f.options.trashItem.mockImplementationOnce(async path => {
      trashStarted.resolve();
      await releaseTrash.promise;
      await trash(path);
    });
    let finished = false;
    const pending = f.remove().then(result => { finished = true; return result; });
    let exclusive: Promise<void> | undefined;
    try {
      await trashStarted.promise;
      exclusive = withExclusiveWorkspaceOperation(f.root, async () => {
        exclusiveStarted.resolve();
        await releaseExclusive.promise;
      });
      await exclusiveStarted.promise;
      releaseTrash.resolve();
      await expect.poll(() => finished).toBe(true);
      expect(await pending).toMatchObject({ ok: true, trashed: true, undo: { available: true } });
      expect((await readDeleteRecovery(f.root, f.groups[0]!))?.staged).toBeUndefined();
    } finally {
      releaseTrash.resolve();
      releaseExclusive.resolve();
      await exclusive;
      await pending;
    }
  });

  it("waits for an accepted system-trash move before undoing a rowless delete", async () => {
    const f = await fixture(undefined, true);
    const started = deferred<void>(), release = deferred<void>();
    const trash = f.options.trashItem.getMockImplementation()!;
    f.options.trashItem.mockImplementationOnce(async path => {
      started.resolve();
      await release.promise;
      await trash(path);
    });
    const pending = f.remove();
    let undo: ReturnType<typeof f.undo> | undefined;
    try {
      await started.promise;
      const id = f.groups[0]!;
      undo = f.undo(id);
      // A shared read drains any Undo already admitted to the workspace queue.
      expect(await readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history, {agent: true}))
        .toMatchObject({ ok: true, withoutHistory: ["folder/rowless.txt"] });
      expect((await readDeleteRecovery(f.root, id))?.engine).toBeUndefined();
      release.resolve();
      expect(await pending).toMatchObject({ ok: true, trashed: true, undo: { available: false } });
      const reason = `Cannot undo the delete. folder/rowless.txt is in the ${process.platform === "win32" ? "Recycle Bin" : "Trash"}. Restore it there.`;
      expect(await undo).toEqual({ ok: false, reason });
      expect(await readDeleteRecovery(f.root, id)).toMatchObject({ noUndo: reason });
      expect((await readDeleteRecovery(f.root, id))?.staged).toBeUndefined();
      expect(await f.undo(id)).toEqual({ ok: false, reason });
      expect(existsSync(join(f.root, "folder"))).toBe(false);
      expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
      await undo;
    }
  });

  it.each([false, true])("restores tracked and rowless files after OS refusal (hand=%s)", async hand => {
    const f = await fixture();
    const id = recovery(await f.remove(hand));
    const result = await f.undo(id);
    expect(result).toMatchObject({ ok: true, tracked: { state: "restoring", momentCount: 1 }, restored: ["folder/rowless.txt"], remaining: [] });
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
      reason: `Cannot undo the delete. folder/rowless.txt is ${where}. Restore it there.` } });
    expect(await f.undo(result.operationId!)).toEqual({ ok: false, reason: `Cannot undo the delete. folder/rowless.txt is ${where}. Restore it there.` });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  });
  it("offers Undo for tracked-only files even after OS trash accepts", async () => {
    const f = await fixture(["folder/tracked.txt", "folder/rowless.txt"], true);
    const id = recovery(await f.remove());
    expect(await f.undo(id)).toMatchObject({ ok: true, tracked: { state: "restoring", momentCount: 2 }, restored: [] });
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
    expect(f.history.undoHistoryOperation).toHaveBeenCalledTimes(2);
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
    expect(f.history.undoHistoryOperation.mock.calls.map(([input]) => input.requestId)).toEqual([`delete-undo:${id}`, `delete-undo:${id}`]);
  });
  it("groups the delete with the minted id, never the caller request id", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    expect(f.groups).toEqual([id]);
    expect(id).not.toBe("caller-request");
    expect(await f.undo(id)).toMatchObject({ ok: true });
    expect(f.history.undoHistoryOperation).toHaveBeenCalledWith(expect.objectContaining({ operationId: id, requestId: `delete-undo:${id}` }));
  });
  it("moves nothing when the engine refuses, retaining its words", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    f.refuse("Cannot undo: tracked.txt occupies the old path");
    expect(await f.undo(id)).toEqual({ ok: false, reason: "Cannot undo: tracked.txt occupies the old path" });
    expect(existsSync(join(f.root, "folder/rowless.txt"))).toBe(false);
  });
  it.each(["not retained", "different bytes"])("keeps an occupant created after engine Undo in place (%s)", async body => {
    const f = await fixture();
    const id = recovery(await f.remove());
    const undo = f.history.undoHistoryOperation.getMockImplementation()!;
    f.history.undoHistoryOperation.mockImplementationOnce(async input => {
      const result = await undo(input);
      await f.write("folder/rowless.txt", body);
      return result;
    });
    expect(await f.undo(id)).toMatchObject({ ok: true, restored: [], remaining: [{ path: "folder/rowless.txt", reason: expect.stringContaining("now occupies") }] });
    expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe(body);
    const entry = (await readdir(join(f.root, ".dohc/local/trash"))).find(name => name.endsWith("-folder"))!;
    expect(await readFile(join(f.root, ".dohc/local/trash", entry, "rowless.txt"), "utf8")).toBe("not retained");
  });
  it("keeps a raced file in trash without replacing its new occupant", async () => {
    const f = await fixture();
    const id = recovery(await f.remove());
    faults.beforeLink = async to => { await writeFile(to, "raced occupant"); };
    try {
      const result = await f.undo(id);
      expect(result).toMatchObject({ ok: true, restored: [], remaining: [{ path: "folder/rowless.txt", reason: expect.stringContaining("now occupies") }] });
      expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("raced occupant");
      const entry = (await readdir(join(f.root, ".dohc/local/trash"))).find(name => name.endsWith("-folder"))!;
      expect(await readFile(join(f.root, ".dohc/local/trash", entry, "rowless.txt"), "utf8")).toBe("not retained");
    } finally { faults.beforeLink = undefined; }
  });
});


describe("recovery durability and path authority", () => {
  it("restores rowless-only deletes without inventing a History operation", async () => {
    const f = await fixture([]);
    const id = recovery(await f.remove());
    expect(await f.undo(id)).toMatchObject({ ok: true, tracked: { state: "restored", momentCount: 0 }, restored: ["folder"] });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, "folder/rowless.txt"), "utf8")).toBe("not retained");
  });
  it("recovers an excluded subtree without retaining a spare copy", async () => {
    const f = await fixture();
    await f.write("folder/node_modules/nested/file.txt", "excluded bytes");
    const id = recovery(await f.remove(true));
    expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/node_modules", "folder/rowless.txt"], remaining: [] });
    expect(await readFile(join(f.root, "folder/node_modules/nested/file.txt"), "utf8")).toBe("excluded bytes");
    const entry = (await readdir(join(f.root, ".dohc/local/trash"))).find(name => name.endsWith("-folder"))!;
    expect(existsSync(join(f.root, ".dohc/local/trash", entry, "node_modules"))).toBe(false);
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
    expect(await f.undo(id)).toEqual({ ok: false, reason: "History operations require the owning workspace. Open it to continue." });
    expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  });
});
