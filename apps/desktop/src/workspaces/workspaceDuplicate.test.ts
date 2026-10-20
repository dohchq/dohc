import { mkdtemp, writeFile, mkdir, rm, copyFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { duplicateWorkspaceFile } from "./workspaceDuplicate";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import type { WorkspaceEngineCapture, AuthoredPathChanges } from "./workspaceEngineCapture";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
async function fixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-duplicate-")); roots.push(rootPath);
  await writeFile(join(rootPath, "source.md"), "Before settlement");
  const workspace = {workspaceId: "workspace", rootPath, readOnly: false, shareView: undefined as unknown};
  const operation = {workspace, assertCurrent: vi.fn()};
  const events: string[] = [];
  const engine: AuthoredPathChanges = {
    policy: await readWorkspaceEnginePolicy(rootPath), hasPath: vi.fn(async () => false),
    recordDisk: vi.fn(async (path, files) => { events.push("record"); return [...files]; }),
    duplicateFile: vi.fn(async (from, to) => { events.push("commit"); await copyFile(join(rootPath, from), join(rootPath, to)); return {path: to, materialized: true}; }),
    moveFile: async () => false, rename: async () => undefined, delete: async () => "moment", undoDelete: async () => undefined,
  };
  const changePathsAs = vi.fn<WorkspaceEngineCapture["changePathsAs"]>(async (_paths, _author, work) => {
    events.push("settle"); await writeFile(join(rootPath, "source.md"), "Settled"); return await work(engine);
  }) as WorkspaceEngineCapture["changePathsAs"] & {mock: {calls: unknown[][]}};
  const run = (path = "source.md") => duplicateWorkspaceFile(operation, path, {kind: "human", humanId: "person"}, {changePathsAs});
  return {rootPath, workspace, operation, engine, changePathsAs, events, run};
}
it("settles before retaining content, mints the id, and chooses the next name on disk and in History", async () => {
  const f = await fixture();
  const suffix = process.platform === "win32" ? " - Copy" : process.platform === "darwin" ? " copy" : " (copy)";
  const second = process.platform === "win32" ? " - Copy (2)" : process.platform === "darwin" ? " copy 2" : " (copy 2)";
  await writeFile(join(f.rootPath, "source" + suffix + ".md"), "Keep");
  vi.mocked(f.engine.hasPath).mockImplementation(async path => path === "source" + second + ".md");
  const result = await f.run();
  expect(result.operationId).toMatch(/^dohc-operation:[0-9a-f-]{36}$/);
  expect(result.undo).toEqual({available: true});
  expect(await readFile(join(f.rootPath, result.path), "utf8")).toBe("Settled");
  expect(f.events).toEqual(["settle", "record", "commit"]);
  expect(f.changePathsAs.mock.calls[0]![1]).toMatchObject({operation: "duplicate", operationId: result.operationId, author: {kind: "human"}});
  expect(result.path).not.toContain(second + ".md");
  expect(await readFile(join(f.rootPath, "source" + suffix + ".md"), "utf8")).toBe("Keep");
});
it.each(["readOnly", "shareView"] as const)("refuses %s before capture", async kind => {
  const f = await fixture(); if (kind === "readOnly") f.workspace.readOnly = true; else f.workspace.shareView = {};
  await expect(f.run()).rejects.toThrow("owning workspace"); expect(f.changePathsAs).not.toHaveBeenCalled();
});
it.each(["../outside.md", ".dohc/secret.md", ".env", "node_modules/file.md"])("refuses reserved and escaping path %s", async path => {
  const f = await fixture(); await expect(f.run(path)).rejects.toThrow(); expect(f.engine.duplicateFile).not.toHaveBeenCalled();
});
it("refuses folders, links, excluded files, and unretained files", async () => {
  const f = await fixture(); await mkdir(join(f.rootPath, "folder"));
  await expect(f.run("folder")).rejects.toThrow("regular file");
  await symlink(join(f.rootPath, "source.md"), join(f.rootPath, "link.md"));
  await expect(f.run("link.md")).rejects.toThrow("regular file");
  vi.mocked(f.engine.recordDisk).mockResolvedValue([]);
  await expect(f.run()).rejects.toThrow("retain");
  expect(f.engine.duplicateFile).not.toHaveBeenCalled();
});
