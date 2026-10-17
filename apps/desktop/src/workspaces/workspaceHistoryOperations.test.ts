import { mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { deleteWorkspacePathByHand } from "./workspaceFileMoves";
import { readWorkspaceHistoryOperation, undoWorkspaceHistoryOperation, type OperationHistory } from "./workspaceHistoryOperations";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import type { PathChangeOptions } from "./workspaceFileMoves";

const person = { kind: "human", humanId: "local:owner" } as const;
const agent = { kind: "agent", agentId: "test-agent", onBehalfOf: "local:owner" } as const;
const otherId = "dohc-operation:11111111-1111-4111-8111-111111111111";
const unsupported = "Cannot undo this change yet. Only a delete can be undone.";
async function fixture() {
  const rootPath = await createTestScratch("history-operation-floor-");
  const write = async (path: string, body = "bytes") => { await mkdir(join(rootPath, path, ".."), { recursive: true }); await writeFile(join(rootPath, path), body); };
  await mkdir(join(rootPath, ".dohc"));
  await write("folder/tracked.txt");
  await write("folder/assets/plain.txt");
  const operation = { workspace: { workspaceId: "owner", rootPath, shareView: undefined as unknown, readOnly: false }, assertCurrent: vi.fn() };
  const capture: PathChangeOptions["capture"] = { changePathsAs: async (_paths, _authored, work) => work({
    policy: await readWorkspaceEnginePolicy(rootPath), recordDisk: async () => ["folder/tracked.txt"], delete: vi.fn(async () => "delete-moment"),
  } as never) };
  const readHistoryPage = vi.fn<OperationHistory["readHistoryPage"]>(async () => ({ moments: [
    { momentId: "delete-moment", operation: "delete", path: "folder/tracked.txt", beforePath: "folder/tracked.txt" },
  ], protectedMoments: [], nextCursor: null }) as never);
  const undoHistoryOperation = vi.fn<OperationHistory["undoHistoryOperation"]>(async input => {
    await write("folder/tracked.txt");
    return { operationId: input.operationId, versionId: "main", momentCount: 1, compensationOperationId: otherId, deduped: false, materialized: true };
  });
  const history = { readHistoryPage, undoHistoryOperation };
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
  const sidecar = join(f.rootPath, ".dohc/trash", (await readdir(join(f.rootPath, ".dohc/trash"))).find(name => name.endsWith(".json"))!);
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
it("refuses moves, unknown ids and invalid ids without an engine Undo or record creation", async () => {
  const f = await fixture();
  f.history.readHistoryPage.mockResolvedValue({ moments: [], nextCursor: null } as never);
  expect(await f.undo(otherId)).toEqual({ ok: false, reason: unsupported });
  expect(await f.undo("11111111-1111-4111-8111-111111111111")).toMatchObject({ ok: false });
  expect(f.history.readHistoryPage).toHaveBeenCalledOnce(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
  expect(await readdir(join(f.rootPath, ".dohc"))).toEqual([]);
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
  expect(await f.undo(id, true)).toEqual({ ok: false, reason: "The idempotency key belongs to another author." });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "owner", author: agent, requestId: `delete-undo:${id}` }));
});

it.each(["/x", "/", "C:x", "C:/", "//host/share", "//host/share/x", "\\\\host\\share\\x"])("refuses hostile recovery paths before walking (%s)", async hostile => {
  const f = await fixture(); const id = await f.remove();
  const sidecar = join(f.rootPath, ".dohc/trash", (await readdir(join(f.rootPath, ".dohc/trash"))).find(name => name.endsWith(".json"))!);
  const original = JSON.parse(await readFile(sidecar, "utf8"));
  for (const patch of [{ base: hostile }, { paths: [hostile] }, { emptyFolders: [hostile] },
    { copies: [{ path: hostile, dev: 0, ino: 0, birthtimeMs: 0, size: 0 }] },
    { result: { ok: true, tracked: { state: "restored", momentCount: 1 }, restored: [hostile], remaining: [] } }]) {
    const body = JSON.stringify({ ...original, ...patch });
    await writeFile(sidecar, body);
    expect(await f.undo(id, true)).toEqual({ ok: false, reason: "Cannot undo the delete. Its recovery paths are invalid." });
    expect(await readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history)).toEqual({ ok: false, reason: "Cannot undo the delete. Its recovery paths are invalid." });
    expect(await readFile(sidecar, "utf8")).toBe(body);
  }
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it.each(["{", "null", "{}"])("never exposes corrupt sidecar parser errors (%s)", async body => {
  const f = await fixture(); const id = await f.remove();
  const sidecar = join(f.rootPath, ".dohc/trash", (await readdir(join(f.rootPath, ".dohc/trash"))).find(name => name.endsWith(".json"))!);
  await writeFile(sidecar, body);
  const refusal = { ok: false, reason: "Cannot undo the delete. Its recovery record is invalid. Restore files from History or the trash." };
  expect(await f.undo(id, true)).toEqual(refusal);
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history)).toEqual(refusal);
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
  expect(await f.undo(otherId)).toEqual({ ok: false, reason: "Cannot undo the delete. Its recovery record is missing or expired. Restore files from History or the trash." });
  f.history.readHistoryPage.mockResolvedValue({ moments: [{ operation: "rename", path: "folder/a.txt", beforePath: "folder/b.txt" }], nextCursor: null } as never);
  expect(await f.undo(otherId)).toEqual({ ok: false, reason: unsupported });
  expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it.runIf(process.env.DOHC_OPERATION_TIMING === "1")("times agent reads and Undo for a deleted folder of 5,000 files", async () => {
  const reads: number[] = [], undos: number[] = [];
  for (let run = 0; run < 3; run++) {
    const f = await fixture();
    for (let start = 0; start < 4998; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, 4998 - start) }, (_, i) => writeFile(join(f.rootPath, "folder/assets/file-" + (start + i) + ".txt"), "bytes")));
    }
    const id = await f.remove();
    console.log("TIMING_RUN " + run + " deleted 5000 files");
    let start = performance.now();
    expect(await readWorkspaceHistoryOperation(f.operation, { operationId: id }, f.history)).toMatchObject({ ok: true });
    reads.push(performance.now() - start);
    console.log("TIMING_READ_MS " + reads.at(-1));
    start = performance.now();
    expect(await f.undo(id, true)).toMatchObject({ ok: true, remaining: [] });
    undos.push(performance.now() - start);
    console.log("TIMING_UNDO_MS " + undos.at(-1));
  }
  const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { runs: values, p50: sorted[1], p95: sorted[2] }; };
  const timings = { read: stats(reads), undo: stats(undos) };
  if (process.env.DOHC_OPERATION_TIMING_OUTPUT) await writeFile(process.env.DOHC_OPERATION_TIMING_OUTPUT, JSON.stringify(timings, null, 2));
  console.log("OPERATION_TIMING_MS " + JSON.stringify(timings));
}, 900_000);
