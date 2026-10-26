import * as filesystem from "node:fs/promises";
import { mkdir, rm, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { deleteWorkspacePathByHand, moveWorkspacePathByHand } from "./workspaceFileMoves";
import { readWorkspaceHistoryOperation, undoWorkspaceHistoryOperation, type OperationHistory } from "./workspaceHistoryOperations";
import { withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";
import { deferred } from "../testing/deferred";
import { readDeleteRecovery } from "./workspaceDeleteRecovery";
import { readMoveRecovery } from "./workspaceMoveRecovery";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import type { PathChangeOptions } from "./workspaceFileMoves";
import { openedLocalState } from "../testing/preparedLocalState";
import { readLocalStateFrom } from "./workspaceLocalState";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
const person = { kind: "human", humanId: "local:owner" } as const;
const agent = { kind: "agent", agentId: "test-agent", onBehalfOf: "local:owner" } as const;
const otherId = "dohc-operation:11111111-1111-4111-8111-111111111111";
const missingMove = "Cannot undo the rename. Its recovery record is missing or expired. Rename it back yourself.";
// A refused Undo whose cause main cannot name.
const refused = (reason: string) => ({ ok: false, reason, refusal: { code: "unexplained" } });
async function fixture(trackedPaths = ["folder/tracked.txt"]) {
  const rootPath = await createTestScratch("history-operation-floor-");
  const write = async (path: string, body = "bytes") => { await mkdir(join(rootPath, path, ".."), { recursive: true }); await writeFile(join(rootPath, path), body); };
  await mkdir(join(rootPath, ".dohc"));
  await write("folder/tracked.txt");
  await write("folder/assets/plain.txt");
  const operation = { workspace: { workspaceId: "owner", rootPath, shareView: undefined as unknown, readOnly: false }, signal: new AbortController().signal, assertCurrent: vi.fn() };
  await openedLocalState(operation.workspace);
  const capture: PathChangeOptions["capture"] = { changePathsAs: async (_paths, _authored, work) => work({
    policy: await readWorkspaceEnginePolicy(rootPath), recordDisk: async () => trackedPaths, delete: vi.fn(async () => "delete-moment"),
  } as never) };
  const readHistoryPage = vi.fn<OperationHistory["readHistoryPage"]>(async input => {
    const offset = input.cursor?.text?.momentOrder ?? 0, end = Math.min(offset + 50, trackedPaths.length);
    return { moments: trackedPaths.slice(offset, end).map((path, index) => ({
      momentId: offset + index === 0 ? "delete-moment" : `delete-moment-${offset + index}`, operation: "delete", path, beforePath: path,
    })), protectedMoments: [], nextCursor: end < trackedPaths.length ? {
      format: 1, engineUuid: "fixture", workspaceId: "owner", versionId: "main", objectId: null, operationId: input.operationId,
      textFence: trackedPaths.length, protectedFence: -1, markerFence: -1, text: { recordedAtMs: 0, momentOrder: end }, protected: null, marker: null,
    } : null } as never;
  });
  const undoHistoryOperation = vi.fn<OperationHistory["undoHistoryOperation"]>(async input => {
    for (let start = 0; start < trackedPaths.length; start += 100) await Promise.all(trackedPaths.slice(start, start + 100).map(path => write(path)));
    return { operationId: input.operationId, versionId: "main", momentCount: 1, notRestored: [], compensationOperationId: otherId, deduped: false, materialized: true };
  });
  const history = { readHistoryOperation: vi.fn(async (input: {operationId: string}) => ({operationId: input.operationId, versionId: "main", momentCount: 0, kind: null})), readHistoryPage, undoHistoryOperation };
  const remove = async () => {
    const result = await deleteWorkspacePathByHand(operation, "folder", person, { capture, requestId: "delete", trashItem: async () => { throw new Error("OS refused"); }, markDeleted: vi.fn() });
    expect(result.undo).toEqual({ available: true }); return result.operationId!;
  };
  const undo = (operationId: string, byAgent = false) => undoWorkspaceHistoryOperation(operation, { operationId }, byAgent ? agent : person, { history, agent: byAgent });
  return { rootPath, write, operation, history, remove, undo };
}
it.each([".env", ".git/config", "node_modules/pkg/index.js", "link"])("refuses the entire agent Undo when staged descendants contain %s", async hidden => {
  const f = await fixture();
  if (hidden === "link") {
    const outside = await createTestScratch("history-link-destination-");
    await symlink(outside, join(f.rootPath, "folder/assets/link"), process.platform === "win32" ? "junction" : "dir");
  } else await f.write(`folder/assets/${hidden}`);
  const id = await f.remove();
  const sidecar = join(f.rootPath, ".dohc/local/trash", (await readdir(join(f.rootPath, ".dohc/local/trash"))).find(name => name.endsWith(".json"))!);
  const before = await readFile(sidecar, "utf8");
  const result = await f.undo(id, true);
  expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("contains a link or a reserved, secret, or excluded path") });
  expect(JSON.stringify(result)).not.toContain(`folder/assets/${hidden}`);
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  expect(await readFile(sidecar, "utf8")).toBe(before);
  await expect(stat(join(f.rootPath, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("checks the current policy before replaying a person's completed Undo", async () => {
  const f = await fixture(); const id = await f.remove();
  expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/assets"] });
  await f.write(".dohc/files.toml", '[[rule]]\npath = "folder/assets/**"\ntracked = false\n');
  expect((await readWorkspaceEnginePolicy(f.rootPath)).errors).toEqual([]);
  f.history.undoHistoryOperation.mockClear();
  expect(await f.undo(id, true)).toMatchObject({ ok: false });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it("restores a person's link and node_modules while the agent refuses their saved replay", async () => {
  const f = await fixture(); const outside = await createTestScratch("history-person-link-");
  await f.write("folder/node_modules/pkg/index.js");
  await symlink(outside, join(f.rootPath, "folder/assets/link"), process.platform === "win32" ? "junction" : "dir");
  const id = await f.remove(); expect(await f.undo(id)).toMatchObject({ ok: true, remaining: [] });
  expect(await readFile(join(f.rootPath, "folder/node_modules/pkg/index.js"), "utf8")).toBe("bytes");
  f.history.undoHistoryOperation.mockClear(); expect(await f.undo(id, true)).toMatchObject({ ok: false });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it("checks beforePath on later History pages before Undo", async () => {
  const f = await fixture(); const id = await f.remove();
  const cursor = { workspaceId: "owner", operationId: id, objectId: null, versionId: "main" };
  f.history.readHistoryPage.mockResolvedValueOnce({ moments: [], protectedMoments: [], nextCursor: cursor } as never)
    .mockResolvedValueOnce({ moments: [{ momentId: "hidden", operation: "delete", path: "folder/tracked.txt", beforePath: ".env" }], protectedMoments: [], nextCursor: null } as never);
  expect(await f.undo(id, true)).toMatchObject({ ok: false });
  expect(f.history.readHistoryPage).toHaveBeenCalledTimes(2); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it("refuses unknown ids and invalid ids without an engine Undo or record creation", async () => {
  const f = await fixture();
  f.history.readHistoryPage.mockResolvedValue({ moments: [], nextCursor: null } as never);
  expect(await f.undo(otherId)).toEqual(refused("This operation is not in History."));
  expect(await f.undo("11111111-1111-4111-8111-111111111111")).toMatchObject({ ok: false });
  expect(f.history.readHistoryPage).toHaveBeenCalledOnce(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  expect(await readdir(join(f.rootPath, ".dohc/local"))).toEqual([]);
});
it("reads a move's references without contents and scopes its cursor", async () => {
  const f = await fixture();
  f.history.readHistoryPage.mockResolvedValue({ moments: [{ momentId: "move", operation: "rename", path: "folder/after.txt", beforePath: "folder/before.txt", body: "never return this" }], protectedMoments: [], nextCursor: null } as never);
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: otherId }, f.history)).toEqual({ ok: true, operationId: otherId, members: [{ momentId: "move", operation: "rename", path: "folder/after.txt", beforePath: "folder/before.txt" }], nextCursor: null });
  f.history.readHistoryPage.mockClear();
  const cursor = Buffer.from(JSON.stringify({ workspaceId: "other", operationId: otherId })).toString("base64url");
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: otherId, cursor }, f.history)).toMatchObject({ ok: false });
  expect(f.history.readHistoryPage).not.toHaveBeenCalled();
});
it.each(["readOnly", "shareView"] as const)("refuses both operations in %s workspaces before engine calls", async kind => {
  const f = await fixture(); if (kind === "readOnly") f.operation.workspace.readOnly = true; else f.operation.workspace.shareView = {};
  expect(await f.undo(otherId)).toMatchObject({ ok: false, reason: "History operations require the owning workspace. Open it to continue." });
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: otherId }, f.history)).toMatchObject({ ok: false });
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it("passes a different author's lost-reply refusal through unchanged", async () => {
  const f = await fixture(); const id = await f.remove();
  f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("The idempotency key belongs to another author."));
  expect(await f.undo(id, true)).toEqual(refused("The idempotency key belongs to another author."));
  expect(f.history.undoHistoryOperation).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "owner", author: agent, requestId: `delete-undo:${id}` }));
});

it.each(["/x", "/", ...(process.platform === "win32" ? ["C:x"] : []), "C:/", "//host/share", "//host/share/x", "\\\\host\\share\\x"])("refuses hostile recovery paths before walking (%s)", async hostile => {
  const f = await fixture(); const id = await f.remove();
  const sidecar = join(f.rootPath, ".dohc/local/trash", (await readdir(join(f.rootPath, ".dohc/local/trash"))).find(name => name.endsWith(".json"))!);
  const original = JSON.parse(await readFile(sidecar, "utf8"));
  for (const patch of [{ base: hostile }, { paths: [hostile] }, { emptyFolders: [hostile] },
    { copies: [{ path: hostile, dev: 0, ino: 0, birthtimeMs: 0, size: 0 }] },
    { result: { ok: true, tracked: { state: "restored", momentCount: 1 }, restored: [hostile], remaining: [] } }]) {
    const body = JSON.stringify({ ...original, ...patch });
    await writeFile(sidecar, body);
    expect(await f.undo(id, true)).toEqual(refused("Cannot undo the delete. Its recovery paths are invalid."));
    expect(await readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history)).toEqual({ ok: false, reason: "Cannot read this operation. Its recovery paths are invalid." });
    expect(await readFile(sidecar, "utf8")).toBe(body);
  }
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it.each(["{", "null", "{}", "directory", "wrong id", "invalid staged"])("never exposes corrupt sidecar parser errors (%s)", async body => {
  const f = await fixture(); const id = await f.remove();
  const sidecar = join(f.rootPath, ".dohc/local/trash", (await readdir(join(f.rootPath, ".dohc/local/trash"))).find(name => name.endsWith(".json"))!);
  if (body === "directory") { await rm(sidecar); await mkdir(sidecar); }
  else if (body === "wrong id" || body === "invalid staged") {
    const record = JSON.parse(await readFile(sidecar, "utf8"));
    await writeFile(sidecar, JSON.stringify({ ...record, ...(body === "wrong id" ? { operationId: otherId } : { staged: "nested/staged" }) }));
  } else await writeFile(sidecar, body);
  expect(await f.undo(id, true)).toEqual(refused("Cannot undo the delete. Its recovery record is invalid. Restore files from History, the system trash, or .dohc/local/trash."));
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history)).toEqual({ ok: false, reason: "Cannot read this operation. Its recovery record is invalid." });
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it.each(["!", Buffer.from("null").toString("base64url"), Buffer.from("{}").toString("base64url")])("refuses malformed cursors without parser text (%s)", async cursor => {
  const f = await fixture();
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: otherId, cursor }, f.history)).toEqual({
    ok: false, reason: "Cannot read this operation page. Use the cursor from the previous page.",
  });
  expect(f.history.readHistoryPage).not.toHaveBeenCalled();
});
it("lets the engine reject a cursor from an inactive version", async () => {
  const f = await fixture();
  const cursor = { workspaceId: "owner", operationId: otherId, objectId: null, versionId: "inactive" };
  f.history.readHistoryPage.mockImplementation(async input => {
    expect(input).not.toHaveProperty("versionId");
    expect(input.cursor).toEqual(cursor);
    throw new Error("This History cursor belongs to another version.");
  });
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: otherId, cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url") }, f.history))
    .toEqual({ ok: false, reason: "This History cursor belongs to another version." });
});
it.each([SyntaxError, TypeError])("does not expose %s messages from History decoding", async ErrorType => {
  const f = await fixture(); f.history.readHistoryPage.mockRejectedValue(new ErrorType("raw parser detail"));
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: otherId }, f.history)).toEqual({
    ok: false, reason: "dohc could not read this operation. Check the workspace, then try again.",
  });
});
it("reports missing recovery for a delete and unsupported for another operation", async () => {
  const f = await fixture();
  expect(await f.undo(otherId)).toEqual(refused("Cannot undo the delete. Its recovery record is missing or expired. Restore files from History, the system trash, or .dohc/local/trash."));
  f.history.readHistoryPage.mockResolvedValue({ moments: [{ operation: "rename", path: "folder/a.txt", beforePath: "folder/b.txt" }], nextCursor: null } as never);
  expect(await f.undo(otherId)).toEqual(refused(missingMove));
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it.runIf(process.env.DOHC_OPERATION_TIMING === "1").each(["mixed", "tracked"])("times agent read, Undo and replay for 5,000 files (%s)", async mode => {
  const reads: number[] = [], undos: number[] = [], replays: number[] = [], subsequentPages: number[] = [];
  const files = ["folder/tracked.txt", "folder/assets/plain.txt", ...Array.from({ length: 4998 }, (_, i) => "folder/assets/file-" + i + ".txt")];
  for (let run = 0; run < 3; run++) {
    const f = await fixture(mode === "tracked" ? files : undefined);
    for (let start = 2; start < files.length; start += 100) await Promise.all(files.slice(start, start + 100).map(path => f.write(path)));
    const id = await f.remove();
    console.log("TIMING_RUN " + mode + " " + run + " deleted 5000 files");
    let start = performance.now();
    let page = await readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history);
    expect(page.ok).toBe(true);
    reads.push(performance.now() - start);
    let pages = 1, members = page.ok ? page.members.length : 0;
    while (page.ok && page.nextCursor) {
      start = performance.now();
      page = await readWorkspaceHistoryOperation(f.operation, { operationId: id, cursor: page.nextCursor }, f.history);
      subsequentPages.push(performance.now() - start);
      expect(page.ok).toBe(true); pages++; members += page.ok ? page.members.length : 0;
    }
    expect(pages).toBe(mode === "tracked" ? 100 : 1); expect(members).toBe(mode === "tracked" ? 5000 : 1);
    start = performance.now();
    const result = await f.undo(id, true);
    expect(result).toMatchObject({ ok: true, remaining: [] }); undos.push(performance.now() - start);
    start = performance.now();
    expect(await f.undo(id, true)).toEqual(result); replays.push(performance.now() - start);
    expect(f.history.undoHistoryOperation).toHaveBeenCalledOnce();
    console.log("TIMING_MS " + JSON.stringify({ mode, run, read: reads.at(-1), undo: undos.at(-1), replay: replays.at(-1), pages }));
  }
  const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { runs: values, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] }; };
  const timings = { read: stats(reads), undo: stats(undos), replay: stats(replays), subsequentPage: stats(subsequentPages) };
  if (process.env.DOHC_OPERATION_TIMING_OUTPUT) await writeFile(process.env.DOHC_OPERATION_TIMING_OUTPUT + "." + mode + ".json", JSON.stringify(timings, null, 2));
  console.log("OPERATION_TIMING_MS " + mode + " " + JSON.stringify(timings));
}, 900_000);

it("admits new files and folders while reading without superseding their writes", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  const page = { moments: [{ momentId: "m", operation: "delete", path: "folder/tracked.txt" }], nextCursor: null };
  f.history.readHistoryPage.mockImplementation(async () => { entered.resolve(); await release.promise; return page as never; });
  const reading = readWorkspaceHistoryOperation(f.operation, { operationId: otherId }, f.history);
  await entered.promise;
  let writes = 0;
  const writing = withStaleSensitiveWorkspaceOperation(f.rootPath, async () => {
    await f.write("new-file.txt"); await mkdir(join(f.rootPath, "new-folder")); writes++;
  });
  // Observe rejection immediately too, so a failing lock regression cannot leak it.
  const outcome = writing.then(() => "written", error => error.message);
  try { await vi.waitFor(() => expect(writes).toBe(1)); }
  finally { release.resolve(); await reading; }
  expect(await outcome).toBe("written");
});
it("checks recovery only on the first read page and still checks later members", async () => {
  const f = await fixture(), id = await f.remove();
  const cursor = Buffer.from(JSON.stringify({ workspaceId: "owner", operationId: id, objectId: null, versionId: "main" })).toString("base64url");
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history)).toMatchObject({ ok: true, withoutHistory: ["folder/assets"] });
  const sidecar = join(f.rootPath, ".dohc/local/trash", (await readdir(join(f.rootPath, ".dohc/local/trash"))).find(name => name.endsWith(".json"))!);
  await writeFile(sidecar, "{");
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: id, cursor }, f.history)).toEqual({
    ok: true, operationId: id, members: [{ momentId: "delete-moment", operation: "delete", path: "folder/tracked.txt", beforePath: "folder/tracked.txt" }], nextCursor: null,
  });
  f.history.readHistoryPage.mockResolvedValue({ moments: [{ momentId: "hidden", operation: "delete", path: ".env" }], nextCursor: null } as never);
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: id, cursor }, f.history)).toMatchObject({ ok: false });
});
it("rechecks a saved Undo's named paths without walking restored directories", async () => {
  const f = await fixture(), id = await f.remove();
  const result = await f.undo(id, true);
  expect(result).toMatchObject({ ok: true });
  const listing = vi.spyOn(filesystem, "readdir").mockClear();
  try {
    expect(await f.undo(id, true)).toEqual(result);
    expect(listing.mock.calls.filter(([path]) => String(path).startsWith(join(f.rootPath, "folder")))).toEqual([]);
  } finally { listing.mockRestore(); }
  expect(f.history.undoHistoryOperation).toHaveBeenCalledOnce();
  await rename(join(f.rootPath, "folder/assets"), join(f.rootPath, "saved-assets"));
  const outside = await createTestScratch("replay-link-");
  await symlink(outside, join(f.rootPath, "folder/assets"), process.platform === "win32" ? "junction" : "dir");
  expect(await f.undo(id, true)).toMatchObject({ ok: false });
});
it.each(["delete", "rename"])("uses the settled person refusal without checking live paths for a missing record (%s)", async kind => {
  const f = await fixture();
  await rename(join(f.rootPath, "folder"), join(f.rootPath, "saved-folder"));
  const outside = await createTestScratch("missing-record-link-");
  await symlink(outside, join(f.rootPath, "folder"), process.platform === "win32" ? "junction" : "dir");
  f.history.readHistoryPage.mockResolvedValue({ moments: [{ operation: kind, path: "folder/tracked.txt" }], nextCursor: null } as never);
  expect(await f.undo(otherId)).toEqual(refused(kind === "delete"
    ? "Cannot undo the delete. Its recovery record is missing or expired. Restore files from History, the system trash, or .dohc/local/trash." : missingMove));
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});

it.each(["linux", "darwin"])("accepts colon names in recovery records on %s", async platform => {
  const f = await fixture(), id = await f.remove();
  const sidecar = join(f.rootPath, ".dohc/local/trash", (await readdir(join(f.rootPath, ".dohc/local/trash"))).find(name => name.endsWith(".json"))!);
  const record = JSON.parse(await readFile(sidecar, "utf8"));
  record.base = "a:notes"; record.paths = ["a:notes/file.txt"]; record.emptyFolders = [];
  await writeFile(sidecar, JSON.stringify(record));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: platform });
    expect(await readDeleteRecovery(f.rootPath, id)).toEqual(record);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
it.each([".", "..", "/root", "nested/name", "nested\\name"])("refuses a staged name that is not one safe path component (%s)", async staged => {
  const f = await fixture(), id = await f.remove();
  const sidecar = join(f.rootPath, ".dohc/local/trash", (await readdir(join(f.rootPath, ".dohc/local/trash"))).find(name => name.endsWith(".json"))!);
  const record = JSON.parse(await readFile(sidecar, "utf8"));
  await writeFile(sidecar, JSON.stringify({ ...record, staged }));
  expect(await f.undo(id)).toEqual(refused("Cannot undo the delete. Its recovery record is invalid. Restore files from History, the system trash, or .dohc/local/trash."));
});

it("stops a person missing-record lookup at the first delete page", async () => {
  const f = await fixture();
  f.history.readHistoryPage.mockResolvedValueOnce({ moments: [{ operation: "delete", path: "folder/tracked.txt" }], nextCursor: { workspaceId: "owner", operationId: otherId, objectId: null, versionId: "main" } } as never);
  expect(await f.undo(otherId)).toEqual(refused("Cannot undo the delete. Its recovery record is missing or expired. Restore files from History, the system trash, or .dohc/local/trash."));
  expect(f.history.readHistoryPage).toHaveBeenCalledOnce(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});

it("successfully undoes a saved file move through operation History", async () => {
  const f = await fixture([]); await f.write("before.txt", "kept edits");
  const moved = await moveWorkspacePathByHand(f.operation, { fromPath: "before.txt", toPath: "after.txt" }, person,
    { capture: null, requestId: "move", trashItem: async () => undefined, markDeleted: vi.fn() });
  expect(await f.undo(moved.operationId!)).toMatchObject({ ok: true, restored: ["before.txt"], remaining: [] });
  expect(await readFile(join(f.rootPath, "before.txt"), "utf8")).toBe("kept edits");
});

it.each([false, true])("undoes Duplicate through the engine ledger with a stable request, agent=%s", async byAgent => {
  const f = await fixture();
  f.history.readHistoryOperation.mockResolvedValue({operationId: otherId, versionId: "main", momentCount: 1, kind: "file-duplicate"} as never);
  f.history.readHistoryPage.mockResolvedValue({moments: [{momentId: "copy", operation: "write", path: "folder/tracked.txt"}], nextCursor: null} as never);
  f.history.undoHistoryOperation.mockResolvedValue({operationId: otherId, versionId: "main", momentCount: 1, notRestored: [], compensationOperationId: otherId, deduped: false, materialized: true});
  expect(await f.undo(otherId, byAgent)).toMatchObject({ok: true, tracked: {state: "restored"}, remaining: []});
  expect(await f.undo(otherId, byAgent)).toMatchObject({ok: true});
  expect(f.history.undoHistoryOperation.mock.calls.map(([input]) => input.requestId)).toEqual(["duplicate-undo:" + otherId, "duplicate-undo:" + otherId]);
  f.history.undoHistoryOperation.mockRejectedValue(new Error("Cannot undo folder/tracked.txt: copy changed after Duplicate"));
  expect(await f.undo(otherId, byAgent)).toMatchObject({ok: false, reason: expect.stringContaining("folder/tracked.txt")});
});

it("does not treat an unrelated single write as Duplicate", async () => {
  const f = await fixture();
  f.history.readHistoryPage.mockResolvedValue({moments:[{operation:"write",path:"folder/tracked.txt"}],nextCursor:null} as never);
  expect(await f.undo(otherId)).toMatchObject({ok:false,reason:"This operation is not in History."});
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});

// A recovery record decides where Undo writes and what it puts back, so dohc
// reads it only from `.dohc/local/trash`, and only as a file of this user's
// that no one else can change. Anything else reads as an invalid record or a
// folder to fix: Undo refuses with words and changes nothing.
const untrustedRecords = [
  ["writable by others", "Cannot undo the delete. Its recovery record is invalid. Restore files from History, the system trash, or .dohc/local/trash."],
  ["hard-linked", "Cannot undo the delete. Its recovery record is invalid. Restore files from History, the system trash, or .dohc/local/trash."],
  ["another user's", "Cannot undo the delete. This workspace's .dohc belongs to another user. Make it and everything in it yours again, then try again."],
  ["under a linked .dohc/local", "Cannot undo the delete. This workspace's .dohc/local is a link. Put what it links to in its place, then try again."],
  ["under a linked trash", "Cannot undo the delete. Its recovery record is invalid. Restore files from History, the system trash, or .dohc/local/trash."],
] as const;
it.skipIf(process.platform === "win32").each(untrustedRecords)("refuses a recovery record %s and changes nothing", async (kind, reason) => {
  const f = await fixture(), id = await f.remove();
  const trash = join(f.rootPath, ".dohc/local/trash");
  const sidecar = join(trash, (await readdir(trash)).find(name => name.endsWith(".json"))!);
  const elsewhere = await createTestScratch("history-untrusted-record-");
  let uid: ReturnType<typeof vi.spyOn> | undefined;
  if (kind === "writable by others") await filesystem.chmod(sidecar, 0o666);
  if (kind === "hard-linked") await filesystem.link(sidecar, join(elsewhere, "second-name.json"));
  if (kind === "another user's") uid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
  const moved = kind === "under a linked .dohc/local" ? join(f.rootPath, ".dohc/local") : kind === "under a linked trash" ? trash : undefined;
  if (moved) {
    await rename(moved, join(elsewhere, "moved"));
    await symlink(join(elsewhere, "moved"), moved, "dir");
  }
  const before = await readdir(elsewhere, { recursive: true });
  try {
    expect(await f.undo(id)).toEqual(refused(reason));
    expect(await readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history))
      .toEqual({ ok: false, reason: reason.replace("Cannot undo the delete.", "Cannot read this operation.").replace(" Restore files from History, the system trash, or .dohc/local/trash.", "") });
  } finally { uid?.mockRestore(); }
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  await expect(stat(join(f.rootPath, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(elsewhere, { recursive: true })).toEqual(before);
});

// A trash dohc can't look into may hold the record, so Undo names the folder
// instead of calling the record missing. chmod can't hide a folder from root,
// and Windows has no such mode.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses Undo when it can't look into .dohc, and changes nothing", async () => {
  const f = await fixture(), id = await f.remove();
  const dohc = join(f.rootPath, ".dohc");
  await filesystem.chmod(dohc, 0o600);
  try {
    expect(await f.undo(id)).toEqual(
      refused("Cannot undo the delete. This workspace's .dohc/local can't be read. Make sure you can open it, then try again."));
  } finally { await filesystem.chmod(dohc, 0o700); }
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  await expect(stat(join(f.rootPath, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("reads delete and move records only from .dohc/local/trash, never an old .dohc/trash", async () => {
  const f = await fixture(), id = await f.remove();
  await f.write("before.txt", "kept edits");
  const moved = await moveWorkspacePathByHand(f.operation, { fromPath: "before.txt", toPath: "after.txt" }, person,
    { capture: null, requestId: "move", trashItem: async () => undefined, markDeleted: vi.fn() });
  expect(await readMoveRecovery(f.rootPath, moved.operationId!)).toMatchObject({ from: "before.txt", to: "after.txt" });
  await rename(join(f.rootPath, ".dohc/local/trash"), join(f.rootPath, ".dohc/trash"));
  expect(await readDeleteRecovery(f.rootPath, id)).toBeUndefined();
  expect(await readMoveRecovery(f.rootPath, moved.operationId!)).toBeUndefined();
  expect(await f.undo(id)).toEqual(refused("Cannot undo the delete. Its recovery record is missing or expired. Restore files from History, the system trash, or .dohc/local/trash."));
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  await expect(stat(join(f.rootPath, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses Undo of a delete or rename before the workspace's open prepares .dohc/local, and changes nothing", async () => {
  const f = await fixture(), id = await f.remove();
  await f.write("before.txt", "kept edits");
  const moved = await moveWorkspacePathByHand(f.operation, { fromPath: "before.txt", toPath: "after.txt" }, person,
    { capture: null, requestId: "move", trashItem: async () => undefined, markDeleted: vi.fn() });
  readLocalStateFrom(null);
  // On Windows nothing in `.dohc/local` is read before the open holds it, so
  // dohc can't yet tell what it would undo.
  const notOpened = (what: string) => process.platform === "win32"
    ? "dohc has not finished opening this workspace. Try again when it opens."
    : `dohc did not undo the ${what} because the workspace has not finished opening. Try again when it opens.`;
  expect(await f.undo(id)).toEqual(refused(notOpened("delete")));
  expect(await f.undo(moved.operationId!)).toEqual(refused(notOpened("rename")));
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  await expect(stat(join(f.rootPath, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.rootPath, "after.txt"), "utf8")).toBe("kept edits");
  // Elsewhere reading needs no open, and the records wait for the next one.
  const read = await readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history);
  expect(read).toMatchObject(process.platform === "win32" ? { ok: false } : { ok: true, withoutHistory: ["folder/assets"] });
  await openedLocalState(f.operation.workspace);
  expect(await f.undo(id)).toMatchObject({ ok: true, restored: ["folder/assets"], remaining: [] });
  expect(await f.undo(moved.operationId!)).toMatchObject({ ok: true, restored: ["before.txt"], remaining: [] });
  expect(await readFile(join(f.rootPath, "before.txt"), "utf8")).toBe("kept edits");
});

// A saved Undo still restoring asks History again on each retry, and saves
// what it learns, so the retry waits for the open as a first Undo does.
it("checks readiness before a retried delete Undo asks History to finish restoring", async () => {
  const f = await fixture(), id = await f.remove();
  f.history.undoHistoryOperation.mockImplementationOnce(async input => ({ operationId: input.operationId, versionId: "main", momentCount: 1,
    notRestored: [], compensationOperationId: otherId, deduped: false, materialized: false }));
  expect(await f.undo(id)).toMatchObject({ ok: true, tracked: { state: "restoring" } });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledOnce();
  readLocalStateFrom({ currentBinding: () => ({ localStateReady: false }), localStateOpenAt: async () => ({ current: () => true }) });
  expect(await f.undo(id)).toEqual(
    refused("dohc did not undo the delete because it can't keep this workspace's trash out of iCloud Drive. Restart dohc to try again."));
  expect(f.history.undoHistoryOperation).toHaveBeenCalledOnce();
  await openedLocalState(f.operation.workspace);
  expect(await f.undo(id)).toMatchObject({ ok: true, tracked: { state: "restored" } });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledTimes(2);
  expect(await readDeleteRecovery(f.rootPath, id)).toMatchObject({ result: { tracked: { state: "restored" } } });
});
