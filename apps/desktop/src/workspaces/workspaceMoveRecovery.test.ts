import { DaemonRefusalError } from "@dohc/workspace-engine-client";
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
import { resumeWorkspaceLinkRewrites } from "./workspaceLinkRewrites";
import { listMoveRecoveries, readMoveRecovery } from "./workspaceMoveRecovery";
import { openedLocalState } from "../testing/preparedLocalState";
import { readOwnedLocalStateFolder, readLocalStateFrom } from "./workspaceLocalState";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
afterEach(() => vi.restoreAllMocks());
const person = { kind: "human", humanId: "local:move-owner" } as const;
const agent = { kind: "agent", agentId: "move-agent", onBehalfOf: "local:move-owner" } as const;
const id = "dohc-operation:11111111-1111-4111-8111-111111111111";
// A refused Undo whose cause main cannot name.
const refused = (reason: string) => ({ ok: false, reason, refusal: { code: "unexplained" } });
const linkReceipt = {documents: 3, links: 3, unchecked: ["adopted.md"], uncheckedCount: 1, complete: true};
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
const cancelledPassError = () => new DaemonRefusalError({code: "CANCELLED", message: "Cancelled", retry: "no"}, undefined);
async function fixture(rewriteHistoryLinks?: NonNullable<OperationHistory["rewriteHistoryLinks"]>) {
  const rootPath = await createTestScratch("move-undo-");
  const write = async (path: string, text = path) => { await mkdir(dirname(join(rootPath, path)), { recursive: true }); await writeFile(join(rootPath, path), text); };
  const retirement = new AbortController();
  const operation = { workspace: { rootPath, workspaceId: "move-test", attachmentId: Symbol("move-test"), readOnly: false, shareView: undefined as unknown },
    signal: retirement.signal, state: {}, assertCurrent: vi.fn() };
  await openedLocalState(operation.workspace);
  const members: { path: string; beforePath: string; operation: "rename" | "write"; momentId: string; objectId?: string }[] = [];
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
        if (member.operation !== "rename") continue;
        await mkdir(dirname(join(rootPath, member.beforePath)), { recursive: true });
        await rename(join(rootPath, member.path), join(rootPath, member.beforePath));
        objects.set(member.beforePath, objects.get(member.path)!); objects.delete(member.path);
      }
      placed = true;
    }
    return { operationId: input.operationId, versionId: "main", notRestored: [], compensationOperationId: id, momentCount: members.length, deduped, materialized: !restoring };
  });
  const resolveFiles = vi.fn<OperationHistory["resolveFiles"]>(async input => ({versionId: "main", results: input.targets.map(target => {
    const path = [...objects].find(([, id]) => "objectId" in target && id === target.objectId)?.[0];
    return path ? {status: "found" as const, objectId: "objectId" in target ? target.objectId : "", path} : {status: "absent" as const};
  })}));
  const history = { resolveFiles, readHistoryOperation: vi.fn(async (input: {operationId: string}) => ({operationId: input.operationId, versionId: "main", momentCount: 0, kind: null})), readHistoryPage, undoHistoryOperation, ...(rewriteHistoryLinks ? {rewriteHistoryLinks} : {}) };
  const options = { capture, requestId: "move", trashItem: async () => { throw new Error("OS trash refused"); }, markDeleted: vi.fn(),
    ...(rewriteHistoryLinks ? {linkRewrites: {workspaceId: "move-test", signal: retirement.signal, history: {rewriteHistoryLinks}}} : {}) };
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

it("keeps disk and engine paths when a file renamed by hand silently keeps its old name", async (context) => {
  const f = await fixture();
  await f.write("notes.md", "body");
  if (!(await lstat(join(f.rootPath, "Notes.md")).then(() => true, () => false))) context.skip("this disk keeps case apart");
  f.objects.set("notes.md", "object-a");
  const engineCalls: unknown[][][] = [];
  const actualCapture = f.capture.changePathsAs;
  vi.spyOn(f.capture, "changePathsAs").mockImplementation(async (...args) => {
    const work = args[2];
    args[2] = async (engine) => {
      for (const method of ["rename", "delete", "undoDelete", "moveFile"] as const) {
        engineCalls.push(vi.spyOn(engine, method).mock.calls);
      }
      return work(engine);
    };
    return actualCapture(...args);
  });
  const noOp = vi.spyOn(filesystem, "rename").mockResolvedValue(undefined);
  await expect(moveWorkspacePathByHand(f.operation, { fromPath: "notes.md", toPath: "Notes.md" }, person, f.options)).rejects.toThrow("This disk kept the name notes.md");
  expect(noOp.mock.calls).toEqual([[join(f.rootPath, "notes.md"), join(f.rootPath, "Notes.md")]]);
  expect(f.members).toEqual([]);
  expect(engineCalls).toEqual([[], [], [], []]);
  expect(f.objects).toEqual(new Map([["notes.md", "object-a"]]));
  expect((await readdir(f.rootPath)).filter((name) => !name.startsWith("."))).toEqual(["notes.md"]);
  expect(await readFile(join(f.rootPath, "notes.md"), "utf8")).toBe("body");
});

it.each([false, true])("cancels the in-flight pass and waits for its last committed member before floors and Undo, receipt=%s", async completed => {
  const started = deferred<void>(), cancelled = deferred<void>(), ended = deferred<typeof linkReceipt>();
  const rewrite = vi.fn<NonNullable<OperationHistory["rewriteHistoryLinks"]>>(async input => {
    input.cancelSignal!.addEventListener("abort", () => cancelled.resolve(), {once: true});
    started.resolve(); return ended.promise;
  });
  const f = await fixture(rewrite); await f.write("old.md");
  const moved = await f.move("old.md", "new.md"); await started.promise;
  f.history.readHistoryPage.mockClear();
  const lock = vi.spyOn(assets, "withExclusiveWorkspaceOperation");
  const undoing = f.undo(); await cancelled.promise; await nextTurn();
  expect(lock).not.toHaveBeenCalled();
  expect(f.history.readHistoryPage).not.toHaveBeenCalled();
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  f.members.push({path: "last.md", beforePath: "last.md", operation: "write", momentId: "last"});
  if (completed) ended.resolve(linkReceipt); else ended.reject(cancelledPassError());
  expect(await undoing).toMatchObject({ok: true, tracked: {momentCount: 2}});
  expect(await readWorkspaceHistoryOperation(f.operation, {operationId: moved.operationId!}, f.history, {agent: true})).not.toHaveProperty("links");
  expect(f.history.readHistoryPage).toHaveBeenCalled();
  expect(rewrite).toHaveBeenCalledTimes(1);
  await resumeWorkspaceLinkRewrites(f.operation.workspace, f.options.linkRewrites!);
  await nextTurn(); expect(rewrite).toHaveBeenCalledTimes(1);
  expect(await readMoveRecovery(f.rootPath, moved.operationId!)).toHaveProperty("engine");
  f.retirement.abort();
});

it("refuses an agent floor before every inverse and resumes with the same key and mover", async () => {
  const started = deferred<void>(), cancelled = deferred<void>(), ended = deferred<never>(), resumed = deferred<void>(), receipt = deferred<typeof linkReceipt>();
  const rewrite = vi.fn<NonNullable<OperationHistory["rewriteHistoryLinks"]>>(async input => {
    if (rewrite.mock.calls.length === 1) {
      input.cancelSignal!.addEventListener("abort", () => cancelled.resolve(), {once: true});
      started.resolve(); return ended.promise;
    }
    resumed.resolve(); return receipt.promise;
  });
  const f = await fixture(rewrite); await f.write("old.md");
  const moved = await f.moveAsAgent("old.md", "new.md"); await started.promise;
  const undoing = f.undo(undefined, true); await cancelled.promise;
  f.members.push({path: "private/.env", beforePath: "private/.env", operation: "write", momentId: "secret"});
  ended.reject(cancelledPassError());
  expect(await undoing).toMatchObject({ok: false, reason: expect.stringContaining("private contains a link or a reserved, secret, or excluded path")});
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  await resumed.promise;
  const [first, second] = rewrite.mock.calls.map(call => call[0]);
  expect(second).toMatchObject({requestId: first!.requestId, author: agent});
  expect(await readMoveRecovery(f.rootPath, moved.operationId!)).toHaveProperty("links.state", "updating");
  receipt.resolve(linkReceipt);
  await vi.waitFor(async () => expect(await readWorkspaceHistoryOperation(f.operation, {operationId: moved.operationId!}, f.history, {agent: false})).toMatchObject({ok: true, links: {state: "done"}}), {timeout: 30_000});
  f.retirement.abort();
});

it.each(["local", "hardlink"])("resumes only owned, current local move records: %s", async location => {
  const f = await fixture(); await f.write("old.md");
  const moved = await f.move("old.md", "new.md");
  await recovery.waitForRecovery(moved.operationId!);
  const path = f.recordPath();
  if (location === "hardlink") await filesystem.link(path, join(f.rootPath, "another-record.json"));
  expect(await listMoveRecoveries(f.rootPath)).toEqual(location === "local" ? [moved.operationId] : []);
  f.retirement.abort();
});

it("does not enumerate or resume move records when local trash is unusable", async () => {
  const rewrite = vi.fn<NonNullable<OperationHistory["rewriteHistoryLinks"]>>(async () => linkReceipt);
  const f = await fixture(); await f.write("old.md");
  const moved = await f.moveAsAgent("old.md", "new.md");
  const record = await readMoveRecovery(f.rootPath, moved.operationId!);
  if (!record || "noUndo" in record) throw new Error("missing file record");
  record.links = {state: "updating"}; record.linkRewrite = {requestId: "original-key", author: agent};
  await recovery.saveRecoveryRecord(f.operation.workspace, record, "move");
  expect(await listMoveRecoveries(f.rootPath)).toEqual([moved.operationId]);
  const trash = join(f.rootPath, ".dohc/local/trash"), saved = join(f.rootPath, "saved-trash");
  await rename(trash, saved);
  await filesystem.symlink(saved, trash, "junction");
  expect(await readOwnedLocalStateFolder(f.rootPath, "trash", async dir => dir)).toBe("unusable");
  expect(await listMoveRecoveries(f.rootPath)).toEqual([]);
  const exclusive = vi.spyOn(assets, "withExclusiveWorkspaceOperation");
  await resumeWorkspaceLinkRewrites(f.operation.workspace, {workspaceId: "move-test", signal: f.retirement.signal, history: {rewriteHistoryLinks: rewrite}});
  await nextTurn();
  expect(exclusive).not.toHaveBeenCalled();
  expect(rewrite).not.toHaveBeenCalled();
  f.retirement.abort();
});

it("floors a linking write's current path before an agent inverse", async () => {
  const f = await fixture(); await f.write("old.md"); await f.moveAsAgent("old.md", "new.md");
  await f.write(".dohc/files.toml", '[[rule]]\npath = "excluded/**"\ntracked = false\n');
  f.members.push({path: "source.md", beforePath: "source.md", operation: "write", momentId: "link", objectId: "source-object"});
  f.history.resolveFiles.mockResolvedValue({versionId: "main", results: [{status: "found", objectId: "source-object", path: "excluded/source.md"}]});
  expect(await f.undo(undefined, true)).toMatchObject({ok: false, reason: expect.stringContaining("contains a link or a reserved, secret, or excluded path")});
  expect(f.history.resolveFiles).toHaveBeenCalledWith(expect.objectContaining({targets: [{objectId: "source-object"}]}));
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  expect(await readFile(join(f.rootPath, "new.md"), "utf8")).toBe("old.md");
});

it.each([false, true])("filters unchecked paths using the reader's floor, agent=%s", async agent => {
  const f = await fixture(); await f.write("old.md"); const moved = await f.moveAsAgent("old.md", "new.md");
  await f.write(".dohc/files.toml", '[[rule]]\npath = "excluded/**"\ntracked = false\n');
  const record = await readMoveRecovery(f.rootPath, moved.operationId!);
  if (!record || "noUndo" in record) throw new Error("missing record");
  record.links = {state: "done", documents: 2, unchecked: ["visible.md", "excluded/source.md"], uncheckedCount: 2};
  await recovery.saveRecoveryRecord(f.operation.workspace, record, "move");
  expect(await readWorkspaceHistoryOperation(f.operation, {operationId: moved.operationId!}, f.history, {agent})).toMatchObject({ok: true,
    links: {state: "done", unchecked: agent ? ["visible.md"] : ["visible.md", "excluded/source.md"], uncheckedCount: 2}});
});

it("refuses an occupied old file path without changing disk, the record or History", async () => {
  const f = await fixture(); await f.write("a.txt"); const moved = await f.move("a.txt", "b.txt"); await recovery.waitForRecovery(moved.operationId!);
  await f.write("a.txt", "occupant"); const before = await readFile(f.recordPath(), "utf8");
  expect(await f.undo()).toEqual({ ok: false, reason: "Cannot undo the rename. a.txt now occupies the old path. Move it first.",
    refusal: { code: "old-path-occupied", path: "a.txt" } });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled(); expect(await readFile(f.recordPath(), "utf8")).toBe(before);
});

it("checks readiness before a retried move Undo asks History to finish restoring", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveAsAgent("folder/tracked.txt", "archive/tracked.txt");
  f.restoring(true); expect(await f.undo()).toMatchObject({ ok: true, tracked: { state: "restoring" } });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledOnce();
  f.restoring(false);
  readLocalStateFrom({ currentBinding: () => ({ localStateReady: false }), localStateOpenAt: async () => ({ current: () => true }) });
  expect(await f.undo()).toEqual(
    refused("dohc did not undo the move because it can't keep this workspace's trash out of iCloud Drive. Restart dohc to try again."));
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
  expect(await f.undo()).toEqual(refused("crash after receipt"));
  expect(await f.undo(undefined, true)).toMatchObject({ ok: true, restored: ["oversized.bin"], remaining: [] });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});

it("distinguishes a missing move record from an unknown operation and refuses corrupt records", async () => {
  const f = await fixture(); await f.write("folder/tracked.txt"); await f.moveAsAgent("folder/tracked.txt", "archive/tracked.txt");
  const record = await readFile(f.recordPath(), "utf8"); await rm(f.recordPath());
  expect(await f.undo()).toEqual(refused("Cannot undo the move. Its recovery record is missing or expired. Move it back yourself."));
  expect(await f.undo(id)).toEqual(refused("This operation is not in History."));
  await writeFile(f.recordPath(), "{");
  expect(await f.undo()).toEqual(refused("Cannot undo the move. Its recovery record is invalid. Move it back yourself."));
  await writeFile(f.recordPath(), JSON.stringify({ ...JSON.parse(record), entries: ["../outside"] }));
  expect(await f.undo()).toEqual(refused("Cannot undo the move. Its recovery paths are invalid."));
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
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

it("keeps the committed file and History after a stop loses the pending recovery save", async () => {
  const f = await fixture(); await f.write("a.txt", "kept");
  const entered = deferred<void>(), release = deferred<void>();
  vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error("process stopped before save"); });
  const moved = await f.move("a.txt", "b.txt"); await entered.promise;
  expect(f.members).toHaveLength(1); // The visible result already includes the engine commit.
  release.resolve(); await recovery.waitForRecovery(moved.operationId!);
  expect(await readFile(join(f.rootPath, "b.txt"), "utf8")).toBe("kept");
  await expect(readFile(f.recordPath())).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.undo()).toEqual(refused("Cannot undo the rename. Its recovery record is missing or expired. Rename it back yourself."));
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});

 it.each([false, true])("reaches engine replay after a committed Undo loses its reply, other author=%s", async otherAuthor => {
  const f = await fixture(); await f.write("a.txt"); const moved = await f.move("a.txt", "b.txt"); await recovery.waitForRecovery(moved.operationId!);
  const engine = f.history.undoHistoryOperation.getMockImplementation()!;
  f.history.undoHistoryOperation.mockImplementationOnce(async input => { await engine(input); throw new Error("reply lost after placement"); });
  expect(await f.undo()).toEqual(refused("reply lost after placement"));
  expect(await readFile(join(f.rootPath, "a.txt"), "utf8")).toBe("a.txt");
  if (otherAuthor) f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("The idempotency key belongs to another author."));
  expect(await f.undo(undefined, otherAuthor)).toMatchObject(otherAuthor
    ? { ok: false, reason: "The idempotency key belongs to another author." }
    : { ok: true, tracked: { state: "restored" } });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledTimes(2); expect(f.compensationCount()).toBe(1);
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
  expect(await f.undo()).toEqual(refused("Cannot undo the move. archive/oversized.bin now leads somewhere else."));
  expect(await readFile(join(f.rootPath, "other/oversized.bin"), "utf8")).toBe("unrelated");
  await expect(filesystem.lstat(join(f.rootPath, "docs/oversized.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
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
