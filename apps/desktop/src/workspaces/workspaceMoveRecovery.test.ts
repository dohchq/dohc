import * as assets from "./workspaceAssets";
import { withSharedWorkspaceOperation, withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";
import * as filesystem from "node:fs/promises";
import * as recovery from "./workspaceDeleteRecovery";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { moveWorkspacePathByHand, placeBack, prepareMoveWorkspacePathAs, type PathChangeOptions } from "./workspaceFileMoves";
import { createWorkspaceFileMutationOwner } from "./workspaceFileMutationOwner";
import { readWorkspaceHistoryOperation, undoWorkspaceHistoryOperation, type OperationHistory } from "./workspaceHistoryOperations";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { deferred } from "../testing/deferred";
import { openedLocalState } from "../testing/preparedLocalState";
import { readLocalStateFrom } from "./workspaceLocalState";

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
  await openedLocalState(operation.workspace);
  const members: { path: string; beforePath: string; operation: "rename"; momentId: string }[] = [];
  const objects = new Map<string, string>();
  let activeOperationId = "", compensationCount = 0, placed = false, restoring = false;
  const capture: PathChangeOptions["capture"] & Pick<import("./workspaceEngineCapture").WorkspaceEngineCapture, "beginFileRename"> = { beginFileRename: async () => async () => undefined, changePathsAs: async (_paths, authored, work) => {
    activeOperationId = authored.operationId;
    return work({ policy: await readWorkspaceEnginePolicy(rootPath),
      readDuplicate: async () => null, hasPath: async () => false,
      duplicateFile: async () => { throw new Error("unexpected Duplicate"); },
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
    return { operationId: input.operationId, versionId: "main", notRestored: [], compensationOperationId: id, momentCount: members.length, deduped, materialized: !restoring };
  });
  const history = { readHistoryOperation: vi.fn(async (input: {operationId: string}) => ({operationId: input.operationId, versionId: "main", momentCount: 0, kind: null})), readHistoryPage, undoHistoryOperation };
  const options = { capture, requestId: "move", trashItem: async () => { throw new Error("OS trash refused"); }, markDeleted: vi.fn() };
  const logError = vi.fn();
  let afterMutation = () => {};
  const owner = createWorkspaceFileMutationOwner({ historyFor: () => history, assertTrustedSender: () => undefined,
    withRendererWorkspaceOperation: async (_event, _id, work) => { const result = await work({ ...operation, authorityId: Symbol.for("move-owner"), capture,
      yDocSessions: { withDocumentUnowned: async (_id, _path, work) => work(), markDeletedUnderPath: vi.fn() } }); afterMutation(); return result; },
    shareViewFiles: { change: async () => { throw new Error("Unexpected share change"); } }, localPerson: async () => person,
    trashItem: options.trashItem, notifyRenderer: vi.fn(), shareViewEdited: vi.fn(), logError,
  });
  const move = (fromPath: string, toPath: string) => owner.movePath({}, { workspaceId: "move-test", fromPath, toPath });
  const undo = (operationId = activeOperationId, byAgent = false) => undoWorkspaceHistoryOperation(operation, { operationId }, byAgent ? agent : person, { history, agent: byAgent });
  const recordPath = () => join(rootPath, ".dohc/local/trash", `move-${createHash("sha256").update(activeOperationId).digest("hex")}.json`);
  const moveAsAgent = async (fromPath: string, toPath: string) => {
    const result = await (await prepareMoveWorkspacePathAs(operation, { fromPath, toPath }, agent, options))();
    if (!result.ok) throw new Error(result.reason);
    return { ...result, path: result.toPath };
  };
  return { rootPath, write, operation, retirement, options, capture, members, objects, history, move, moveAsAgent, undo, recordPath, logError, afterMutation: (work: () => void) => { afterMutation = work; },
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
it("finishes a case-only folder rename as true when the post-rename spelling is unknown", async (context) => {
  const f = await fixture();
  await f.write("docs/plans/a.md", "body");
  const plans = join(f.rootPath, "docs", "plans");
  const renamed = join(f.rootPath, "docs", "Plans");
  if (!(await lstat(renamed).then(() => true, () => false))) context.skip("this disk keeps case apart");
  f.objects.set("docs/plans/a.md", "object-a");
  const finishRename = vi.fn(async (moved: boolean) => {
    if (moved) {
      f.objects.delete("docs/plans/a.md");
      f.objects.set("docs/Plans/a.md", "object-a");
    }
  });
  f.capture.beginFileRename = vi.fn(async () => finishRename);
  const listing = vi.spyOn(filesystem, "readdir");
  const originalRename = filesystem.rename.bind(filesystem);
  let postRenameListingFailed = false;
  vi.spyOn(filesystem, "rename").mockImplementation(async (from, to) => {
    await originalRename(from, to);
    if (String(from) === plans && String(to) === renamed) {
      listing.mockImplementationOnce(async () => {
        postRenameListingFailed = true;
        throw Object.assign(new Error("listing unavailable after rename"), { code: "EIO" });
      });
    }
  });
  await expect(moveWorkspacePathByHand(f.operation, { fromPath: "docs/plans", toPath: "docs/Plans" }, person, f.options)).resolves.toMatchObject({ path: "docs/Plans" });
  expect(postRenameListingFailed).toBe(true);
  expect(finishRename.mock.calls).toEqual([[true]]);
  expect(f.objects).toEqual(new Map([["docs/Plans/a.md", "object-a"]]));
  expect(await readdir(join(f.rootPath, "docs"))).toEqual(["Plans"]);
  expect(await readFile(join(renamed, "a.md"), "utf8")).toBe("body");
});
it("finishes a silent case-only folder rename as false and keeps the engine paths", async (context) => {
  const f = await fixture();
  await f.write("docs/plans/a.md", "body");
  if (!(await lstat(join(f.rootPath, "docs", "Plans")).then(() => true, () => false))) context.skip("this disk keeps case apart");
  f.objects.set("docs/plans/a.md", "object-a");
  const finishRename = vi.fn(async (moved: boolean) => {
    if (moved) {
      f.objects.delete("docs/plans/a.md");
      f.objects.set("docs/Plans/a.md", "object-a");
    }
  });
  const beginRename = vi.fn(async () => finishRename);
  f.capture.beginFileRename = beginRename;
  const noOp = vi.spyOn(filesystem, "rename").mockResolvedValue(undefined);
  await expect(moveWorkspacePathByHand(f.operation, { fromPath: "docs/plans", toPath: "docs/Plans" }, person, f.options)).rejects.toThrow("This disk kept the old capitals");
  expect(finishRename.mock.calls).toEqual([[false]]);
  expect(f.objects).toEqual(new Map([["docs/plans/a.md", "object-a"]]));
  expect(await readdir(join(f.rootPath, "docs"))).toEqual(["plans"]);
  expect(await readFile(join(f.rootPath, "docs", "plans", "a.md"), "utf8")).toBe("body");
  noOp.mockRestore();
});
it("keeps a skipped rename at its current path and replays the remaining result", async () => {
  const f = await fixture(); await f.write("a.txt");
  await f.move("a.txt", "b.txt");
  f.history.undoHistoryOperation.mockResolvedValue({ operationId: id, versionId: "main", notRestored: ["b.txt"],
    compensationOperationId: id, momentCount: 0, deduped: false, materialized: true });
  const result = await f.undo();
  expect(result).toMatchObject({ ok: true, restored: [], remaining: [{ path: "b.txt", retry: false }] });
  expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("a.txt");
  expect(await f.undo()).toEqual(result);
});
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
  await expect(readdir(join(f.rootPath, ".dohc/local/trash"))).rejects.toMatchObject({ code: "ENOENT" });
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
// A retry of a saved Undo still restoring saves what History says, so it
// waits for the open as a first Undo does.
it("checks readiness before a retried move Undo asks History to finish restoring", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveAsAgent("folder/tracked.txt", "archive/tracked.txt");
  f.restoring(true); expect(await f.undo()).toMatchObject({ ok: true, tracked: { state: "restoring" } });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledOnce();
  f.restoring(false);
  readLocalStateFrom({ currentBinding: () => ({ localStateReady: false }), localStateOpenAt: async () => ({ current: () => true }) });
  expect(await f.undo()).toEqual({ ok: false,
    reason: "dohc did not undo the move because it can't keep this workspace's trash out of iCloud Drive. Restart dohc to try again." });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledOnce();
  await openedLocalState(f.operation.workspace);
  expect(await f.undo()).toMatchObject({ ok: true, tracked: { state: "restored" } });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(f.recordPath(), "utf8"))).toMatchObject({ result: { tracked: { state: "restored" } } });
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
  expect(result).toMatchObject({ ok: true, undo: { available: false, reason: "Cannot undo the rename. It replaced the old b.txt. Rename it back yourself. Restore the old b.txt from History, the system trash, or .dohc/local/trash." } });
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

it("passes the engine's deleted-member refusal through with only the requested marker", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveAsAgent("folder/tracked.txt", "archive/tracked.txt");
  await f.write("archive/tracked.txt", "replacement"); const before = await readFile(f.recordPath(), "utf8");
  f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("Undo refused: object moved or removed: archive/tracked.txt"));
  expect(await f.undo()).toEqual({ ok: false, reason: "Undo refused: object moved or removed: archive/tracked.txt" });
  expect(JSON.parse(await readFile(f.recordPath(), "utf8"))).toEqual({ ...JSON.parse(before), engine: { requested: true } });
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

it("invalidates queued work only when Undo changes disk, never on finished replay", async () => {
  const f = await fixture(); await f.write("a.txt"); await f.move("a.txt", "b.txt");
  const queued = () => queuedUndo(f);
  await f.write("a.txt", "occupant");
  expect(await queued()).toMatchObject({ result: { ok: false }, follower: "current" });
  await rm(join(f.rootPath, "a.txt"));
  expect(await queued()).toMatchObject({ result: { ok: true }, follower: "WorkspaceOperationSupersededError" });
  const saving = vi.spyOn(recovery, "saveRecoveryRecord");
  f.history.undoHistoryOperation.mockClear();
  expect(await queued()).toMatchObject({ result: { ok: true }, follower: "current" });
  expect(saving).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
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

 it.each([false, true])("reaches engine replay after a committed Undo loses its reply, other author=%s", async otherAuthor => {
  const f = await fixture(); await f.write("a.txt"); const moved = await f.move("a.txt", "b.txt"); await recovery.waitForRecovery(moved.operationId!);
  const engine = f.history.undoHistoryOperation.getMockImplementation()!;
  f.history.undoHistoryOperation.mockImplementationOnce(async input => { await engine(input); throw new Error("reply lost after placement"); });
  expect(await f.undo()).toEqual({ ok: false, reason: "reply lost after placement" });
  expect(await readFile(join(f.rootPath, "a.txt"), "utf8")).toBe("a.txt");
  if (otherAuthor) f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("The idempotency key belongs to another author."));
  expect(await f.undo(undefined, otherAuthor)).toMatchObject(otherAuthor
    ? { ok: false, reason: "The idempotency key belongs to another author." }
    : { ok: true, tracked: { state: "restored" } });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledTimes(2); expect(f.compensationCount()).toBe(1);
 });
 it("returns saved restoring progress when replay cannot reach the engine", async () => {
  const f = await fixture(); await f.write("a.txt"); await f.moveAsAgent("a.txt", "b.txt"); f.restoring(true);
  const saved = await f.undo(); expect(f.history.undoHistoryOperation).toHaveBeenCalledTimes(1);
  const saving = vi.spyOn(recovery, "saveRecoveryRecord");
  f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("engine offline"));
  expect(await f.undo()).toEqual(saved); expect(saving).not.toHaveBeenCalled();
 });
 it.each([".env", "excluded/config.txt"])("moves a person's file to %s without a History rename", async to => {
  const f = await fixture(); await f.write("config.txt", "configuration");
  await f.write(".dohc/files.toml", '[[rule]]\npath = "excluded/**"\ntracked = false\n');
  const moved = await f.move("config.txt", to); await recovery.waitForRecovery(moved.operationId!);
  expect(f.members).toEqual([]);
  expect(JSON.parse(await readFile(f.recordPath(), "utf8"))).toMatchObject({ entries: ["config.txt"], tracked: false });
  expect(await readFile(join(f.rootPath, to), "utf8")).toBe("configuration");
  expect(await f.undo(moved.operationId)).toMatchObject({ ok: true, restored: ["config.txt"] });
 });
 it("returns a completed rename if retirement happens during capture finalization", async () => {
  const f = await fixture(); await f.write("a.txt");
  const capture = f.capture.changePathsAs;
  vi.spyOn(f.capture, "changePathsAs").mockImplementation(async (...args) => {
    const result = await capture(...args); f.retirement.abort();
    f.operation.assertCurrent.mockImplementation(() => { throw new Error("workspace closed"); }); return result;
  });
  const moved = await f.move("a.txt", "b.txt"); expect(moved).toMatchObject({ path: "b.txt", undo: { available: true } });
  await assets.withSharedWorkspaceOperation(f.rootPath, async () => undefined);
  expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("a.txt");
 });

it("resumes a rowless hard link left before source removal", async () => {
  const f = await fixture(); await f.write("oversized.bin"); await f.moveAsAgent("oversized.bin", "archive/oversized.bin");
  const record = JSON.parse(await readFile(f.recordPath(), "utf8"));
  await writeFile(f.recordPath(), JSON.stringify({ ...record, engine: { materialized: true, momentCount: 0 }, pending: record.entries }));
  await filesystem.link(join(f.rootPath, "archive/oversized.bin"), join(f.rootPath, "oversized.bin"));
  expect(await f.undo()).toMatchObject({ ok: true, restored: ["oversized.bin"], remaining: [] });
  await expect(filesystem.lstat(join(f.rootPath, "archive/oversized.bin"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("keeps the visible source when rowless Undo cannot hard link it", async () => {
  const f = await fixture(); await f.write("oversized.bin", "kept"); await f.moveAsAgent("oversized.bin", "archive/oversized.bin");
  vi.spyOn(filesystem, "link").mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: "ENOTSUP", syscall: "link" }));
  const copying = vi.spyOn(filesystem, "copyFile");
  expect(await f.undo()).toMatchObject({ ok: true, remaining: [{ path: "oversized.bin", retry: true }] });
  expect(copying).not.toHaveBeenCalled();
  expect(await readFile(join(f.rootPath, "archive/oversized.bin"), "utf8")).toBe("kept");
});

// macOS limits whole paths to 1,024 bytes. Windows refuses these destinations before mutation.
const overLimitDestination = Array.from({ length: 11 }, () => "a".repeat(95)).join("/") + "/moved.txt";
const unaddressable: [string, string, boolean][] = [
  ["exceeds the engine path limit", overLimitDestination, process.platform === "linux"],
  ["holds a control character", "moved\u0001.txt", process.platform !== "win32"],
];
for (const [scenario, to, supported] of unaddressable) {
  it.skipIf(!supported)(`uses the live-session and debt fence when the person's destination ${scenario}`, async () => {
    const f = await fixture(); await f.write("a.txt");
    const finish = vi.fn(async () => undefined), begin = vi.spyOn(f.capture, "beginFileRename").mockResolvedValue(finish);
    const authored = vi.spyOn(f.capture, "changePathsAs");
    const moved = await moveWorkspacePathByHand(f.operation, { fromPath: "a.txt", toPath: to }, person, f.options);
    expect(begin).toHaveBeenCalledWith("a.txt", to); expect(finish).toHaveBeenCalledWith(true); expect(authored).not.toHaveBeenCalled();
    expect(await readFile(join(f.rootPath, to), "utf8")).toBe("a.txt");
    expect(await f.undo(moved.operationId)).toMatchObject({ ok: true, restored: ["a.txt"] });
  });
}

it.runIf(process.platform === "win32")("refuses the over-limit destination without changing the disk", async () => {
  const f = await fixture(); await f.write("a.txt");
  const before = await readdir(f.rootPath, { recursive: true });
  const begin = vi.spyOn(f.capture, "beginFileRename");
  const authored = vi.spyOn(f.capture, "changePathsAs");
  await expect(moveWorkspacePathByHand(f.operation, { fromPath: "a.txt", toPath: overLimitDestination }, person, f.options))
    .rejects.toThrow("This path is too long for dohc. Shorten the name or use fewer folders.");
  expect(begin).not.toHaveBeenCalled(); expect(authored).not.toHaveBeenCalled();
  expect(await readFile(join(f.rootPath, "a.txt"), "utf8")).toBe("a.txt");
  expect(await readdir(f.rootPath, { recursive: true })).toEqual(before);
});

it("logs a recording failure after the committed move result was published", async () => {
  const f = await fixture(); await f.write("a.txt");
  const failure = new Error("authority retired after recording"); f.afterMutation(() => { throw failure; });
  expect(await f.move("a.txt", "b.txt")).toMatchObject({ path: "b.txt", undo: { available: true } });
  await expect.poll(() => f.logError.mock.calls).toEqual([["Could not finish recording the file move", failure]]);
  expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("a.txt");
});

it("keeps a private source if flushing its fallback copy fails", async () => {
  const f = await fixture(); await f.write(".dohc/local/trash/staged.txt", "kept");
  vi.spyOn(filesystem, "link").mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: "ENOTSUP", syscall: "link" }));
  const open = filesystem.open;
  const sync = vi.fn(async () => { throw new Error("flush failed"); });
  vi.spyOn(filesystem, "open").mockImplementationOnce(async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await open(...args); vi.spyOn(handle, "sync").mockImplementation(sync); return handle;
  });
  expect(await placeBack(f.rootPath, join(f.rootPath, ".dohc/local/trash/staged.txt"), join(f.rootPath, "placed.txt"))).toEqual([""]);
  expect(sync).toHaveBeenCalledOnce();
  expect(await readFile(join(f.rootPath, ".dohc/local/trash/staged.txt"), "utf8")).toBe("kept");
});

it("refuses a rowless person's Undo through a replaced parent link", async () => {
  const f = await fixture(); await f.write("docs/oversized.bin", "original");
  const moved = await f.move("docs/oversized.bin", "archive/oversized.bin"); await recovery.waitForRecovery(moved.operationId!);
  await rename(join(f.rootPath, "archive"), join(f.rootPath, "saved")); await f.write("other/oversized.bin", "unrelated");
  await filesystem.symlink(join(f.rootPath, "other"), join(f.rootPath, "archive"), "junction");
  expect(await f.undo()).toEqual({ ok: false, reason: "Cannot undo the move. archive/oversized.bin now leads somewhere else." });
  expect(await readFile(join(f.rootPath, "other/oversized.bin"), "utf8")).toBe("unrelated");
  await expect(filesystem.lstat(join(f.rootPath, "docs/oversized.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it("supersedes queued work when engine Undo replies before placement", async () => {
  const f = await fixture(); await f.write("a.txt"); await f.moveAsAgent("a.txt", "b.txt"); f.restoring(true);
  expect(await queuedUndo(f)).toMatchObject({ result: { ok: true, tracked: { state: "restoring" } }, follower: "WorkspaceOperationSupersededError" });
  await expect(filesystem.lstat(join(f.rootPath, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await queuedUndo(f)).toMatchObject({ result: { ok: true }, follower: "current" });
});
it.each([false, true])("distinguishes rowless file identities without rounded ids or unequal sizes, size=%s", async differentSize => {
  const f = await fixture(); await f.write("moved.bin", "moved"); await f.write("old.bin", "other");
  const stat = filesystem.lstat;
  vi.spyOn(filesystem, "lstat").mockImplementation((async (path, options) => {
    const value = await stat(path, options);
    if (path === join(f.rootPath, "moved.bin") || path === join(f.rootPath, "old.bin")) {
      const old = path === join(f.rootPath, "old.bin");
      const ino = 9007199254740992n + (old && !differentSize ? 1n : 0n);
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: options?.bigint ? ino : Number(ino),
        size: options?.bigint ? BigInt(old && differentSize ? 6 : 5) : old && differentSize ? 6 : 5 });
    }
    return value;
  }) as typeof filesystem.lstat);
  expect(await placeBack(f.rootPath, join(f.rootPath, "moved.bin"), join(f.rootPath, "old.bin"), "", true)).toEqual([""]);
  expect(await readFile(join(f.rootPath, "moved.bin"), "utf8")).toBe("moved");
  expect(await readFile(join(f.rootPath, "old.bin"), "utf8")).toBe("other");
});
it("reports a restored hard link whose moved name is still open, then finishes on retry", async () => {
  const f = await fixture(); await f.write("oversized.bin"); await f.moveAsAgent("oversized.bin", "archive/oversized.bin");
  const unlink = filesystem.unlink;
  vi.spyOn(filesystem, "unlink").mockImplementation(async path => {
    if (path === join(f.rootPath, "archive/oversized.bin")) throw Object.assign(new Error("open file"), { code: "EPERM" });
    return unlink(path);
  });
  expect(await f.undo()).toMatchObject({ ok: true, remaining: [{ path: "oversized.bin", retry: true,
    reason: "oversized.bin is back, but dohc could not remove its moved name at archive/oversized.bin. Close apps using the file, then Undo again to finish." }] });
  expect(await readFile(join(f.rootPath, "oversized.bin"), "utf8")).toBe("oversized.bin");
  vi.mocked(filesystem.unlink).mockRestore();
  expect(await f.undo()).toMatchObject({ ok: true, restored: ["oversized.bin"], remaining: [] });
  await expect(filesystem.lstat(join(f.rootPath, "archive/oversized.bin"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("does not save an engine intent for rowless Undo before placement", async () => {
  const f = await fixture(); await f.write("oversized.bin"); await f.moveAsAgent("oversized.bin", "archive/oversized.bin");
  const save = recovery.saveRecoveryRecord;
  vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async (...args) => { await save(...args); throw new Error("crash after save"); });
  expect(await f.undo()).toEqual({ ok: false, reason: "crash after save" });
  const record = JSON.parse(await readFile(f.recordPath(), "utf8"));
  expect(record.engine).not.toHaveProperty("requested");
  expect(record.engine).toEqual({ materialized: true, momentCount: 0, notRestored: [] });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
