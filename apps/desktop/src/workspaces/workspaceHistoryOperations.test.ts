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
it("refuses moves, unknown ids and invalid ids before any engine call or record creation", async () => {
  const f = await fixture();
  expect(await f.undo(otherId)).toEqual({ ok: false, reason: unsupported });
  expect(await f.undo("11111111-1111-4111-8111-111111111111")).toMatchObject({ ok: false });
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
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
  expect(await f.undo(otherId)).toMatchObject({ ok: false, reason: "This workspace is read-only. Change files in the owning workspace." });
  expect(await readWorkspaceHistoryOperation(f.operation, { operationId: otherId }, f.history)).toMatchObject({ ok: false });
  expect(f.history.readHistoryPage).not.toHaveBeenCalled(); expect(f.history.undoHistoryOperation).not.toHaveBeenCalled();
});
it("passes a different author's lost-reply refusal through unchanged", async () => {
  const f = await fixture(); const id = await f.remove();
  f.history.undoHistoryOperation.mockRejectedValueOnce(new Error("The idempotency key belongs to another author."));
  expect(await f.undo(id, true)).toEqual({ ok: false, reason: "The idempotency key belongs to another author." });
  expect(f.history.undoHistoryOperation).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "owner", author: agent, requestId: `delete-undo:${id}` }));
});
