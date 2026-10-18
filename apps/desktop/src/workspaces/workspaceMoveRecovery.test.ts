import * as assets from "./workspaceAssets";
import { withSharedWorkspaceOperation, withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";
import * as filesystem from "node:fs/promises";
import * as recovery from "./workspaceDeleteRecovery";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
  const moveAsAgent = async (fromPath: string, toPath: string) => {
    const result = await (await prepareMoveWorkspacePathAs(operation, { fromPath, toPath }, agent, options))();
    if (!result.ok) throw new Error(result.reason);
    return { ...result, path: result.toPath };
  };
  return { rootPath, write, operation, retirement, options, capture, members, objects, history, move, moveAsAgent, undo, recordPath,
    compensationCount: () => compensationCount, restoring: (value: boolean) => { restoring = value; } };
}
async function queuedUndo(f: Awaited<ReturnType<typeof fixture>>, byAgent = false) {
    const entered = deferred<void>(), release = deferred<void>(), exclusiveQueued = deferred<void>();
    const actual = assets.withExclusiveWorkspaceOperation;
    const spy = vi.spyOn(assets, "withExclusiveWorkspaceOperation").mockImplementation((...args) => { const result = actual(...args); exclusiveQueued.resolve(); return result; });
    const holding = withSharedWorkspaceOperation(f.rootPath, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const undoing = f.undo(undefined, byAgent); await exclusiveQueued.promise; spy.mockRestore();
    const follower = withStaleSensitiveWorkspaceOperation(f.rootPath, async () => "current").then(value => value, error => (error as Error).name);
    release.resolve(); await holding;
    return { result: await undoing, follower: await follower };
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
it.each([false, true])("records only an agent folder kind and refuses both authors without engine work, rename=%s", async renameOnly => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.write("folder/oversized.bin");
  const to = renameOnly ? "renamed" : "archive/folder";
  const reason = `Undo for a folder ${renameOnly ? "rename" : "move"} isn't available yet. ${renameOnly ? "Rename" : "Move"} it back yourself.`;
  const staging = vi.spyOn(recovery, "stageDeleteRecovery");
  const moved = await f.moveAsAgent("folder", to);
  expect(moved).toMatchObject({ operationId: expect.any(String), undo: { available: false, reason, paths: [] } });
  expect(staging).not.toHaveBeenCalled();
  const before = await readFile(f.recordPath(), "utf8");
  expect(JSON.parse(before)).toEqual({ operationId: moved.operationId, from: "folder", to, kind: "folder", noUndo: reason });
  expect(f.members).toEqual([expect.objectContaining({ path: `${to}/tracked.txt`, beforePath: "folder/tracked.txt" })]);
  await f.write(`${to}/.env`); f.history.readHistoryPage.mockClear();
  const saving = vi.spyOn(recovery, "saveRecoveryRecord");
  for (const byAgent of [false, true]) {
    expect(await queuedUndo(f, byAgent)).toEqual({ result: { ok: false, reason }, follower: "current" });
  }
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  expect(saving).not.toHaveBeenCalled(); expect(await readFile(f.recordPath(), "utf8")).toBe(before);
  expect(await readFile(join(f.rootPath, to, "tracked.txt"), "utf8")).toBe("folder/tracked.txt");
  await expect(filesystem.lstat(join(f.rootPath, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("saves an empty agent folder kind inside the lock before queued Undo enters", async () => {
  const f = await fixture(); await mkdir(join(f.rootPath, "empty"));
  const entered = deferred<void>(), release = deferred<void>();
  const actual = recovery.saveRecoveryRecord;
  vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; await actual(...args); });
  const moving = f.moveAsAgent("empty", "archive/empty"); await entered.promise;
  const undoing = f.undo(undefined, true); release.resolve();
  expect(await moving).toMatchObject({ undo: { available: false } });
  expect(await undoing).toEqual({ ok: false, reason: "Undo for a folder move isn't available yet. Move it back yourself." });
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it("rejects a corrupt folder-kind record without consulting History", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveAsAgent("folder", "renamed");
  const record = JSON.parse(await readFile(f.recordPath(), "utf8"));
  await writeFile(f.recordPath(), JSON.stringify({ ...record, noUndo: "wrong reason" }));
  expect(await f.undo()).toEqual({ ok: false, reason: "Cannot undo the rename. Its recovery record is invalid. Rename it back yourself." });
  f.history.readHistoryPage.mockClear();
  await writeFile(f.recordPath(), JSON.stringify({ ...record, entries: ["folder/tracked.txt"] }));
  expect(await f.undo()).toMatchObject({ ok: false, reason: expect.stringContaining("recovery record is invalid") });
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it.each(["failed", "missing", "expired"])("uses folder words for the result and missing-record words when its kind record is %s", async state => {
  const f = await fixture(); await f.write("folder/tracked.txt");
  if (state === "failed") vi.spyOn(recovery, "saveRecoveryRecord").mockRejectedValueOnce(new Error("full disk"));
  expect(await f.moveAsAgent("folder", "archive/folder")).toMatchObject({ undo: { available: false,
    reason: "Undo for a folder move isn't available yet. Move it back yourself.", paths: [] } });
  if (state === "missing") await rm(f.recordPath());
  if (state === "expired") { const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); await filesystem.utimes(f.recordPath(), old, old); }
  expect(await f.undo()).toEqual({ ok: false, reason: "Cannot undo the move. Its recovery record is missing or expired. Move it back yourself." });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});

it("refuses an occupied old file path without changing disk, the record or History", async () => {
  const f = await fixture(); await f.write("a.txt"); const moved = await f.move("a.txt", "b.txt"); await recovery.waitForRecovery(moved.operationId!);
  await f.write("a.txt", "occupant"); const before = await readFile(f.recordPath(), "utf8");
  expect(await f.undo()).toEqual({ ok: false, reason: "Cannot undo the rename. a.txt now occupies the old path. Move it first." });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled(); expect(await readFile(f.recordPath(), "utf8")).toBe(before);
});

it.each([false, true])("refuses a file destination replaced with a folder, agent=%s", async byAgent => {
  const f = await fixture(); await f.write("a.txt"); await f.moveAsAgent("a.txt", "b.txt");
  await rm(join(f.rootPath, "b.txt")); await f.write("b.txt/added.txt", "new content");
  const before = await readFile(f.recordPath(), "utf8");
  expect(await f.undo(undefined, byAgent)).toEqual({ ok: false, reason: "Cannot undo the rename. b.txt is now a folder. Move it first." });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled(); expect(await readFile(f.recordPath(), "utf8")).toBe(before);
  expect(await readFile(join(f.rootPath, "b.txt/added.txt"), "utf8")).toBe("new content");
});
it("refuses a case-only file Undo before reading History or calling the engine", async () => {
  const f = await fixture(); await f.write("a.txt"); const moved = await f.moveAsAgent("a.txt", "A.txt");
  expect(moved.operationId).toBeDefined(); const before = await readFile(f.recordPath(), "utf8");
  f.history.readHistoryPage.mockClear();
  expect(await f.undo(undefined, true)).toEqual({ ok: false, reason: "Cannot undo the rename. It changed only the letter case. Rename it back yourself." });
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  expect(await readFile(f.recordPath(), "utf8")).toBe(before);
});

it("saves the record inside the move lock before a queued Undo can enter", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt");
  const entered = deferred<void>(), release = deferred<void>();
  const actual = recovery.saveRecoveryRecord;
  vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; await actual(...args); });
  const moving = f.moveAsAgent("folder/tracked.txt", "archive/tracked.txt"); await entered.promise;
  const undoing = f.undo(); release.resolve();
  await moving; expect(await undoing).toMatchObject({ ok: true, remaining: [] });
});
it("replays one compensation across person and agent doors, and refreshes restoring placement", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveAsAgent("folder/tracked.txt", "archive/tracked.txt");
  f.restoring(true); expect(await f.undo()).toMatchObject({ ok: true, tracked: { state: "restoring" } });
  f.restoring(false); expect(await f.undo(undefined, true)).toMatchObject({ ok: true, tracked: { state: "restored" } });
  expect(await f.undo()).toMatchObject({ ok: true, tracked: { state: "restored" } }); expect(f.compensationCount()).toBe(1);
  expect(f.history.undoHistoryOperation.mock.calls.every(([input]) => input.requestId.startsWith("move-undo:dohc-operation:"))).toBe(true);
});
it("resumes a rowless file after the engine receipt was saved before a crash", async () => {
  const f = await fixture(); await f.write("oversized.bin"); await f.moveAsAgent("oversized.bin", "archive/oversized.bin");
  const actual = recovery.saveRecoveryRecord;
  vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async (...args) => { await actual(...args); throw new Error("crash after receipt"); });
  expect(await f.undo()).toEqual({ ok: false, reason: "crash after receipt" });
  expect(await f.undo(undefined, true)).toMatchObject({ ok: true, restored: ["oversized.bin"], remaining: [] });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
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
it("retries a rowless file occupied after the receipt without engine work", async () => {
  const f = await fixture(); await f.write("oversized.bin", "original binary"); await f.moveAsAgent("oversized.bin", "archive/oversized.bin");
  const actual = recovery.saveRecoveryRecord;
  vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async (...args) => { await actual(...args); await f.write("oversized.bin", "occupant"); });
  expect(await f.undo()).toMatchObject({ ok: true, remaining: [{ path: "oversized.bin", retry: true,
    reason: "oversized.bin now occupies the old path. Move it first. The moved file stays at archive/oversized.bin." }] });
  expect(await readFile(join(f.rootPath, "oversized.bin"), "utf8")).toBe("occupant");
  await rename(join(f.rootPath, "oversized.bin"), join(f.rootPath, "occupant.bin"));
  expect(await f.undo()).toMatchObject({ ok: true, restored: ["oversized.bin"], remaining: [] });
  expect(await readFile(join(f.rootPath, "oversized.bin"), "utf8")).toBe("original binary");
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});

it("passes the engine's deleted-member refusal through without saving progress", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveAsAgent("folder/tracked.txt", "archive/tracked.txt");
  await f.write("archive/tracked.txt", "replacement"); const before = await readFile(f.recordPath(), "utf8");
  f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("Undo refused: object moved or removed: archive/tracked.txt"));
  expect(await f.undo()).toEqual({ ok: false, reason: "Undo refused: object moved or removed: archive/tracked.txt" });
  expect(await readFile(f.recordPath(), "utf8")).toBe(before);
});
it("distinguishes a missing move record from an unknown operation and refuses corrupt records", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveAsAgent("folder/tracked.txt", "archive/tracked.txt");
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
  const moved = await f.moveAsAgent("folder/tracked.txt", "archive/tracked.txt");
  expect(moved).toMatchObject({ path: "archive/tracked.txt", operationId: expect.any(String), undo: { available: false, paths: [],
    reason: "Move finished. dohc could not save Undo information. Move it back yourself." } });
  expect(await readFile(join(f.rootPath, "archive/tracked.txt"), "utf8")).toBe("folder/tracked.txt");
});
it("passes a different author's lost engine reply refusal through", async () => {
  const f = await fixture(); await f.write("a.txt"); await f.move("a.txt", "b.txt");
  f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("The idempotency key belongs to another author."));
  expect(await f.undo(undefined, true)).toEqual({ ok: false, reason: "The idempotency key belongs to another author." });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledWith(expect.objectContaining({ author: agent, requestId: expect.stringMatching(/^move-undo:dohc-operation:/) }));
});

it("keeps queued work current after refusal and invalidates it after completed Undo and replay", async () => {
  const f = await fixture(); await f.write("a.txt"); await f.move("a.txt", "b.txt");
  const queued = () => queuedUndo(f);
  await f.write("a.txt", "occupant");
  expect(await queued()).toMatchObject({ result: { ok: false }, follower: "current" });
  await rm(join(f.rootPath, "a.txt"));
  expect(await queued()).toMatchObject({ result: { ok: true }, follower: "WorkspaceOperationSupersededError" });
  expect(await queued()).toMatchObject({ result: { ok: true }, follower: "WorkspaceOperationSupersededError" });
});

it("reports a rowless file placement failure without inventing an occupant and retries it", async () => {
  const f = await fixture(); await f.write("oversized.bin"); await f.moveAsAgent("oversized.bin", "archive/oversized.bin");
  const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
  vi.spyOn(filesystem, "link").mockRejectedValueOnce(denied); vi.spyOn(filesystem, "copyFile").mockRejectedValueOnce(denied);
  expect(await f.undo()).toMatchObject({ ok: true, remaining: [{ path: "oversized.bin", retry: true,
    reason: "dohc could not put oversized.bin back. It stays at archive/oversized.bin." }] });
  expect(await f.undo()).toMatchObject({ ok: true, restored: ["oversized.bin"], remaining: [] });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
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
