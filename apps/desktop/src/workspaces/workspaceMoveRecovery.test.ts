import * as assets from "./workspaceAssets";
import { withSharedWorkspaceOperation, withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";
import * as filesystem from "node:fs/promises";
import * as recovery from "./workspaceDeleteRecovery";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { moveWorkspacePathByHand, prepareMoveWorkspacePathAs, type PathChangeOptions } from "./workspaceFileMoves";
import { createWorkspaceFileMutationOwner } from "./workspaceFileMutationOwner";
import { readWorkspaceHistoryOperation, undoWorkspaceHistoryOperation, type OperationHistory } from "./workspaceHistoryOperations";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { deferred } from "../testing/deferred";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
afterEach(() => vi.restoreAllMocks());
const person = { kind: "human", humanId: "local:move-owner" } as const;
const agent = { kind: "agent", agentId: "move-agent", onBehalfOf: "local:move-owner" } as const;
const id = "dohc-operation:11111111-1111-4111-8111-111111111111";
async function fixture() {
  const rootPath = await createTestScratch("move-undo-");
  const write = async (path: string, text = path) => { await mkdir(dirname(join(rootPath, path)), { recursive: true }); await writeFile(join(rootPath, path), text); };
  const retirement = new AbortController();
  const operation = { workspace: { rootPath, workspaceId: "move-test", attachmentId: Symbol("move-test"), readOnly: false, shareView: undefined as unknown },
    signal: retirement.signal, state: {}, assertCurrent: vi.fn() };
  const members: { path: string; beforePath: string; operation: "rename"; momentId: string }[] = [];
  const objects = new Map<string, string>();
  let activeOperationId = "", compensationCount = 0, placed = false, restoring = false;
  const capture: PathChangeOptions["capture"] & Pick<import("./workspaceEngineCapture").WorkspaceEngineCapture, "beginFileRename"> = { beginFileRename: async () => async () => undefined, changePathsAs: async (_paths, authored, work) => {
    activeOperationId = authored.operationId;
    return work({ policy: await readWorkspaceEnginePolicy(rootPath),
      recordDisk: async (_base, files) => files.filter(path => !path.endsWith("oversized.bin")),
      rename: async (from, to) => {
        objects.set(to, objects.get(from) ?? `object:${from}`); objects.delete(from);
        members.push({ path: to, beforePath: from, operation: "rename", momentId: `moment:${from}` });
      }, moveFile: async () => false, delete: async () => "deleted", undoDelete: async () => undefined });
  } };
  const readHistoryPage = vi.fn<OperationHistory["readHistoryPage"]>(async input => ({ moments: input.operationId === activeOperationId ? members : [], nextCursor: null }) as never);
  const undoHistoryOperation = vi.fn<OperationHistory["undoHistoryOperation"]>(async input => {
    const deduped = compensationCount > 0;
    if (!deduped) compensationCount++;
    if (!restoring && !placed) {
      for (const member of members) {
        await mkdir(dirname(join(rootPath, member.beforePath)), { recursive: true });
        await rename(join(rootPath, member.path), join(rootPath, member.beforePath));
        objects.set(member.beforePath, objects.get(member.path)!); objects.delete(member.path);
      }
      placed = true;
    }
    return { operationId: input.operationId, versionId: "main", compensationOperationId: id, momentCount: members.length, deduped, materialized: !restoring };
  });
  const history = { readHistoryPage, undoHistoryOperation };
  const options = { capture, requestId: "move", trashItem: async () => { throw new Error("OS trash refused"); }, markDeleted: vi.fn() };
  const owner = createWorkspaceFileMutationOwner({ historyFor: () => history, assertTrustedSender: () => undefined,
    withRendererWorkspaceOperation: async (_event, _id, work) => work({ ...operation, authorityId: Symbol.for("move-owner"), capture,
      yDocSessions: { withDocumentUnowned: async (_id, _path, work) => work(), markDeletedUnderPath: vi.fn() } }),
    shareViewFiles: { change: async () => { throw new Error("Unexpected share change"); } }, localPerson: async () => person,
    trashItem: options.trashItem, notifyRenderer: vi.fn(), shareViewEdited: vi.fn(), logError: vi.fn(),
  });
  const move = (fromPath: string, toPath: string) => owner.movePath({}, { workspaceId: "move-test", fromPath, toPath });
  const undo = (operationId = activeOperationId, byAgent = false) => undoWorkspaceHistoryOperation(operation, { operationId }, byAgent ? agent : person, { history, agent: byAgent });
  const recordPath = () => join(rootPath, ".dohc/trash", `move-${createHash("sha256").update(activeOperationId).digest("hex")}.json`);
  const moveFolder = async (fromPath: string, toPath: string) => {
    const result = await (await prepareMoveWorkspacePathAs(operation, { fromPath, toPath }, agent, options))();
    if (!result.ok) throw new Error(result.reason);
    return { ...result, path: result.toPath };
  };
  return { rootPath, write, operation, retirement, options, capture, members, objects, history, move, moveFolder, undo, recordPath,
    compensationCount: () => compensationCount, restoring: (value: boolean) => { restoring = value; } };
}
it.each([false, true])("returns a person's rename operation through IPC and keeps later typing through agent=%s Undo", async byAgent => {
  const f = await fixture(); await f.write("a.txt", "before");
  const moved = await f.move("a.txt", "b.txt");
  expect(moved).toMatchObject({ path: "b.txt", operationId: expect.stringMatching(/^dohc-operation:/), undo: { available: true } });
  const object = f.objects.get("b.txt"); await f.write("b.txt", "typed after rename");
  expect(await f.undo(undefined, byAgent)).toMatchObject({ ok: true, tracked: { state: "restored", momentCount: 1 }, remaining: [] });
  expect(await readFile(join(f.rootPath, "a.txt"), "utf8")).toBe("typed after rename");
  expect(f.objects.get("a.txt")).toBe(object);
});
it.each([false, true])("keeps a person's folder on the base capture path with unavailable Undo, rename=%s", async renameOnly => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.write("folder/node_modules/pkg/index.js");
  const finished = vi.fn(async () => undefined);
  const begin = vi.fn(async () => finished);
  Object.assign(f.capture, { beginFileRename: begin });
  const authored = vi.spyOn(f.capture, "changePathsAs");
  const moved = await f.move("folder", renameOnly ? "renamed" : "archive/folder");
  expect(moved).toEqual({ path: renameOnly ? "renamed" : "archive/folder", undo: { available: false, paths: [],
    reason: `Undo for a folder ${renameOnly ? "rename" : "move"} isn't available yet. ${renameOnly ? "Rename" : "Move"} it back yourself.` } });
  expect(begin).toHaveBeenCalledWith("folder", renameOnly ? "renamed" : "archive/folder");
  expect(finished).toHaveBeenCalledWith(true); expect(authored).not.toHaveBeenCalled();
  await expect(readdir(join(f.rootPath, ".dohc/trash"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("puts an agent's folder and oversized entry back with each object and removes the destination", async () => {
  const f = await fixture();
  for (const path of ["folder/tracked.txt", "folder/oversized.bin", "folder/rowless/oversized.bin"]) await f.write(path);
  await f.moveFolder("folder", "archive/folder"); const object = f.objects.get("archive/folder/tracked.txt");
  const record = JSON.parse(await readFile(f.recordPath(), "utf8"));
  expect(record.entries.sort()).toEqual(["folder/oversized.bin", "folder/rowless"]);
  await f.write("archive/folder/rowless/new.txt", "added inside a rowless entry");
  expect(await f.undo(undefined, true)).toMatchObject({ ok: true, remaining: [] });
  expect(await readFile(join(f.rootPath, "folder/oversized.bin"), "utf8")).toBe("folder/oversized.bin");
  expect(await readFile(join(f.rootPath, "folder/rowless/new.txt"), "utf8")).toBe("added inside a rowless entry");
  expect(f.objects.get("folder/tracked.txt")).toBe(object);
  await expect(filesystem.lstat(join(f.rootPath, "archive/folder"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([".env", "node_modules/pkg/index.js", "link"])("refuses an agent's Undo before any engine call when a moved folder contains %s", async hidden => {
  const f = await fixture(); await f.write("folder/tracked.txt");
  await f.moveFolder("folder", "archive/folder");
  if (hidden === "link") { const outside = await createTestScratch("agent-move-link-"); await symlink(outside, join(f.rootPath, "archive/folder/link"), process.platform === "win32" ? "junction" : "dir"); }
  else await f.write(`archive/folder/${hidden}`);
  const before = await readFile(f.recordPath(), "utf8");
  f.history.readHistoryPage.mockClear();
  const refused = await f.undo(undefined, true);
  expect(refused).toMatchObject({ ok: false }); expect(JSON.stringify(refused)).not.toContain(`folder/${hidden}`);
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  expect(await readFile(f.recordPath(), "utf8")).toBe(before);
});
it.each(["old path", "added file"])("refuses %s without changing disk, the record, History or generation", async kind => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveFolder("folder", "archive/folder");
  await f.write(kind === "old path" ? "folder/occupant.txt" : "archive/folder/added.txt");
  const before = await readFile(f.recordPath(), "utf8");
  expect(await f.undo()).toMatchObject({ ok: false, reason: expect.stringContaining(kind === "old path" ? "occupies the old path" : "The move did not bring archive/folder/added.txt") });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled(); expect(await readFile(f.recordPath(), "utf8")).toBe(before);
});
it("refuses a case-only Undo before the floor walks to or calls the engine", async () => {
  const f = await fixture(); await f.write("folder/a.txt"); const moved = await f.moveFolder("folder", "Folder"); await f.write("Folder/.env");
  expect(moved.operationId).toBeDefined(); const before = await readFile(f.recordPath(), "utf8");
  f.history.readHistoryPage.mockClear(); vi.mocked(filesystem.readdir).mockClear();
  expect(await f.undo(undefined, true)).toEqual({ ok: false, reason: "Cannot undo the rename. It changed only the letter case. Rename it back yourself." });
  expect(vi.mocked(filesystem.readdir).mock.calls.some(([path]) => String(path) === join(f.rootPath, "Folder"))).toBe(false); expect(f.history.readHistoryPage).not.toHaveBeenCalled();
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled(); expect(await readFile(f.recordPath(), "utf8")).toBe(before);
});
it("saves the record inside the move lock before a queued Undo can enter", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt");
  const entered = deferred<void>(), release = deferred<void>();
  const actual = recovery.saveRecoveryRecord;
  vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; await actual(...args); });
  const moving = f.moveFolder("folder", "archive/folder"); await entered.promise;
  const undoing = f.undo(); release.resolve();
  await moving; expect(await undoing).toMatchObject({ ok: true, remaining: [] });
});
it("replays one compensation across person and agent doors, and refreshes restoring placement", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveFolder("folder", "archive/folder");
  f.restoring(true); expect(await f.undo()).toMatchObject({ ok: true, tracked: { state: "restoring" } });
  f.restoring(false); expect(await f.undo(undefined, true)).toMatchObject({ ok: true, tracked: { state: "restored" } });
  expect(await f.undo()).toMatchObject({ ok: true, tracked: { state: "restored" } }); expect(f.compensationCount()).toBe(1);
  expect(f.history.undoHistoryOperation.mock.calls.every(([input]) => input.requestId.startsWith("move-undo:dohc-operation:"))).toBe(true);
});
it("resumes rowless entries after the engine receipt was saved before a crash", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.write("folder/oversized.bin"); await f.moveFolder("folder", "archive/folder");
  const actual = recovery.saveRecoveryRecord;
  vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async (...args) => { await actual(...args); throw new Error("crash after receipt"); });
  expect(await f.undo()).toEqual({ ok: false, reason: "crash after receipt" });
  expect(await f.undo(undefined, true)).toMatchObject({ ok: true, restored: ["folder/oversized.bin"], remaining: [] });
  expect(f.compensationCount()).toBe(1); expect(f.history.undoHistoryOperation).toHaveBeenCalledOnce();
});
it("returns no Undo for an overwrite and refuses it with the replaced words", async () => {
  const f = await fixture(); await f.write("a.txt"); await f.write("b.txt");
  const result = await (await prepareMoveWorkspacePathAs(f.operation, { fromPath: "a.txt", toPath: "b.txt", overwrite: true }, agent, f.options))();
  expect(result).toMatchObject({ ok: true, undo: { available: false, reason: "Cannot undo the rename. It replaced the old b.txt. Rename it back yourself. Restore the old b.txt from History or the trash." } });
  expect(await f.undo()).toMatchObject({ ok: false, reason: expect.stringContaining("It replaced the old b.txt") });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it("records a move without capture as rowless and undoes it", async () => {
  const f = await fixture(); await f.write("plain.txt");
  const result = await moveWorkspacePathByHand(f.operation, { fromPath: "plain.txt", toPath: "moved.txt" }, person, { ...f.options, capture: null });
  expect(result.undo).toEqual({ available: true });
  expect(await f.undo(result.operationId)).toMatchObject({ ok: true, tracked: { momentCount: 0 }, restored: ["plain.txt"], remaining: [] });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it("retries a rowless entry that became occupied after the engine receipt without another compensation", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.write("folder/oversized.bin", "original binary"); await f.moveFolder("folder", "archive/folder");
  const undo = f.history.undoHistoryOperation.getMockImplementation()!;
  f.history.undoHistoryOperation.mockImplementationOnce(async input => { const result = await undo(input); await f.write("folder/oversized.bin", "occupant"); return result; });
  expect(await f.undo()).toMatchObject({ ok: true, remaining: [{ path: "folder/oversized.bin", retry: true,
    reason: "folder/oversized.bin now occupies the old path. Move it first. The moved file stays at archive/folder/oversized.bin." }] });
  expect(await readFile(join(f.rootPath, "folder/oversized.bin"), "utf8")).toBe("occupant");
  await rename(join(f.rootPath, "folder/oversized.bin"), join(f.rootPath, "occupant.bin"));
  expect(await f.undo()).toMatchObject({ ok: true, restored: ["folder/oversized.bin"], remaining: [] });
  expect(await readFile(join(f.rootPath, "folder/oversized.bin"), "utf8")).toBe("original binary");
  expect(f.history.undoHistoryOperation).toHaveBeenCalledOnce(); expect(f.compensationCount()).toBe(1);
});
it("passes the engine's deleted-member refusal through without saving progress", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveFolder("folder", "archive/folder");
  await rm(join(f.rootPath, "archive/folder/tracked.txt")); const before = await readFile(f.recordPath(), "utf8");
  f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("Undo refused: object moved or removed: archive/folder/tracked.txt"));
  expect(await f.undo()).toEqual({ ok: false, reason: "Undo refused: object moved or removed: archive/folder/tracked.txt" });
  expect(await readFile(f.recordPath(), "utf8")).toBe(before);
});
it("distinguishes a missing move record from an unknown operation and refuses corrupt records", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveFolder("folder", "archive/folder");
  const record = await readFile(f.recordPath(), "utf8"); await rm(f.recordPath());
  expect(await f.undo()).toEqual({ ok: false, reason: "Cannot undo the move. Its recovery record is missing or expired. Move it back yourself." });
  expect(await f.undo(id)).toEqual({ ok: false, reason: "This operation is not in History." });
  await writeFile(f.recordPath(), "{");
  expect(await f.undo()).toEqual({ ok: false, reason: "Cannot undo the move. Its recovery record is invalid. Move it back yourself." });
  await writeFile(f.recordPath(), JSON.stringify({ ...JSON.parse(record), entries: ["../outside"] }));
  expect(await f.undo()).toEqual({ ok: false, reason: "Cannot undo the move. Its recovery paths are invalid." });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it("keeps a completed move when the record save fails and returns no Undo information", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt");
  vi.spyOn(recovery, "saveRecoveryRecord").mockRejectedValueOnce(new Error("full disk"));
  const moved = await f.moveFolder("folder", "archive/folder");
  expect(moved).toMatchObject({ path: "archive/folder", operationId: expect.any(String), undo: { available: false, paths: [],
    reason: "Move finished. dohc could not save Undo information. Move it back yourself." } });
  expect(await readFile(join(f.rootPath, "archive/folder/tracked.txt"), "utf8")).toBe("folder/tracked.txt");
});
it("passes a different author's lost engine reply refusal through", async () => {
  const f = await fixture(); await f.write("a.txt"); await f.move("a.txt", "b.txt");
  f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("The idempotency key belongs to another author."));
  expect(await f.undo(undefined, true)).toEqual({ ok: false, reason: "The idempotency key belongs to another author." });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledWith(expect.objectContaining({ author: agent, requestId: expect.stringMatching(/^move-undo:dohc-operation:/) }));
});

it("keeps queued work current after refusal and invalidates it after completed Undo and replay", async () => {
  const f = await fixture(); await f.write("a.txt"); await f.move("a.txt", "b.txt");
  const queued = async () => {
    const entered = deferred<void>(), release = deferred<void>(), exclusiveQueued = deferred<void>();
    const actual = assets.withExclusiveWorkspaceOperation;
    const spy = vi.spyOn(assets, "withExclusiveWorkspaceOperation").mockImplementation((...args) => { const result = actual(...args); exclusiveQueued.resolve(); return result; });
    const holding = withSharedWorkspaceOperation(f.rootPath, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const undoing = f.undo(); await exclusiveQueued.promise; spy.mockRestore();
    const follower = withStaleSensitiveWorkspaceOperation(f.rootPath, async () => "current").then(value => value, error => (error as Error).name);
    release.resolve(); await holding;
    return { result: await undoing, follower: await follower };
  };
  await f.write("a.txt", "occupant");
  expect(await queued()).toMatchObject({ result: { ok: false }, follower: "current" });
  await rm(join(f.rootPath, "a.txt"));
  expect(await queued()).toMatchObject({ result: { ok: true }, follower: "WorkspaceOperationSupersededError" });
  expect(await queued()).toMatchObject({ result: { ok: true }, follower: "WorkspaceOperationSupersededError" });
});

it("reports a placement failure without inventing an occupant and retries it", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.write("folder/oversized.bin"); await f.moveFolder("folder", "archive/folder");
  const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
  vi.spyOn(filesystem, "link").mockRejectedValueOnce(denied);
  vi.spyOn(filesystem, "copyFile").mockRejectedValueOnce(denied);
  expect(await f.undo()).toMatchObject({ ok: true, remaining: [{ path: "folder/oversized.bin", retry: true,
    reason: "dohc could not put folder/oversized.bin back. It stays at archive/folder/oversized.bin." }] });
  expect(await f.undo()).toMatchObject({ ok: true, restored: ["folder/oversized.bin"], remaining: [] });
  expect(f.compensationCount()).toBe(1);
});

it("returns a committed person rename while its record saves, with read and Undo outside the queue", async () => {
  const f = await fixture(); await f.write("a.txt");
  const entered = deferred<void>(), release = deferred<void>();
  const actual = recovery.saveRecoveryRecord;
  vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; await actual(...args); });
  const moved = await f.move("a.txt", "b.txt"); await entered.promise;
  expect(f.members).toEqual([expect.objectContaining({ operation: "rename", path: "b.txt", beforePath: "a.txt" })]);
  expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("a.txt");
  const shared = vi.spyOn(assets, "withSharedWorkspaceOperation"), exclusive = vi.spyOn(assets, "withExclusiveWorkspaceOperation");
  const waiting = vi.spyOn(recovery, "waitForRecovery");
  const reading = readWorkspaceHistoryOperation(f.operation, { operationId: moved.operationId! }, f.history);
  const undoing = f.undo();
  expect(waiting).toHaveBeenCalledTimes(2); expect(shared).not.toHaveBeenCalled(); expect(exclusive).not.toHaveBeenCalled();
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  release.resolve();
  expect(await reading).toMatchObject({ ok: true, members: [expect.objectContaining({ operation: "rename" })] });
  expect(await undoing).toMatchObject({ ok: true, tracked: { state: "restored" } });
});

it("releases pending record waiters on retirement before they take the workspace queue", async () => {
  const f = await fixture(); await f.write("a.txt");
  const entered = deferred<void>(), release = deferred<void>();
  vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error("retired"); });
  const moved = await f.move("a.txt", "b.txt"); await entered.promise;
  const shared = vi.spyOn(assets, "withSharedWorkspaceOperation"), exclusive = vi.spyOn(assets, "withExclusiveWorkspaceOperation");
  const reading = readWorkspaceHistoryOperation(f.operation, { operationId: moved.operationId! }, f.history);
  const undoing = f.undo().catch(error => error.message);
  f.retirement.abort();
  expect(await reading).toEqual({ ok: false, reason: "This workspace was closed. Open it again." });
  expect(await undoing).toBe("This workspace was closed. Open it again.");
  await recovery.waitForRecovery(moved.operationId!);
  expect(shared).not.toHaveBeenCalled(); expect(exclusive).not.toHaveBeenCalled();
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  release.resolve();
  await assets.withSharedWorkspaceOperation(f.rootPath, async () => undefined);
});

it("keeps the committed file and History after a stop loses the pending recovery save", async () => {
  const f = await fixture(); await f.write("a.txt", "kept");
  const entered = deferred<void>(), release = deferred<void>();
  vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error("process stopped before save"); });
  const moved = await f.move("a.txt", "b.txt"); await entered.promise;
  expect(f.members).toHaveLength(1); // The visible result already includes the engine commit.
  release.resolve(); await recovery.waitForRecovery(moved.operationId!);
  expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("kept");
  await expect(readFile(f.recordPath())).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.undo()).toEqual({ ok: false, reason: "Cannot undo the rename. Its recovery record is missing or expired. Rename it back yourself." });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});

it("does not publish a person rename before the engine and capture finish", async () => {
  const f = await fixture(); await f.write("a.txt");
  const entered = deferred<void>(), release = deferred<void>();
  const actual = f.capture.changePathsAs;
  vi.spyOn(f.capture, "changePathsAs").mockImplementation(async (...args) => {
    const changed = await actual(...args); entered.resolve(); await release.promise; return changed;
  });
  const settled = vi.fn(); const moving = f.move("a.txt", "b.txt").then(value => { settled(); return value; });
  await entered.promise; expect(f.members).toHaveLength(1); expect(settled).not.toHaveBeenCalled();
  release.resolve(); const moved = await moving; await recovery.waitForRecovery(moved.operationId!);
  expect(settled).toHaveBeenCalledOnce();
});
