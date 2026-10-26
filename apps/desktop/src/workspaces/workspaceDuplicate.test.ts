import { mkdtemp, writeFile, mkdir, rm, copyFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { duplicateWithRecovery } from "./workspaceDuplicateOutcome";
import { duplicateWorkspaceFile } from "./workspaceDuplicate";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import type { WorkspaceEngineCapture, AuthoredPathChanges } from "./workspaceEngineCapture";
import { openedLocalState } from "../testing/preparedLocalState";
import { readLocalStateFrom } from "./workspaceLocalState";
import * as fsPromises from "node:fs/promises";
import { forceStoredNameListing } from "../testing/storedNameListing";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

it.each(["before", "under"])("names Duplicate when the stored identity is unknown %s the hold", async when => {
  const f = await fixture();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  const refuseListing = () => {
    forceStoredNameListing(join(f.rootPath, "source.md"));
    vi.spyOn(fsPromises, "readdir").mockRejectedValue(Object.assign(new Error("unreadable"), { code: "EIO" }));
  };
  if (when === "under") vi.mocked(f.changePathsAs).mockImplementation(async (_paths, _author, work) => {
    refuseListing();
    return work(f.engine);
  });
  else refuseListing();
  try {
    await expect(f.run()).rejects.toThrow("dohc did not duplicate source.md. dohc could not tell which file or folder on disk it is. Check it in your file manager before trying again.");
    expect(f.engine.duplicateFile).not.toHaveBeenCalled();
    expect(f.engine.recordDisk).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", platform);
    vi.restoreAllMocks();
  }
});
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
async function fixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-duplicate-")); roots.push(rootPath);
  await writeFile(join(rootPath, "source.md"), "Before settlement");
  const workspace = {workspaceId: "workspace", rootPath, readOnly: false, shareView: undefined as unknown};
  const operation = {workspace, assertCurrent: vi.fn()};
  await openedLocalState(workspace);
  const events: string[] = [];
  const engine: AuthoredPathChanges = {
    policy: await readWorkspaceEnginePolicy(rootPath), readDuplicate: vi.fn(async () => null as {path: string} | null), hasPath: vi.fn(async () => false),
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

it.each(["placed", "pending-placement", "not-committed"] as const)("reconciles a lost reply before retrying Duplicate, state=%s", async state => {
  const f = await fixture();
  const committed = state !== "not-committed";
  let copyPath = "";
  vi.mocked(f.engine.duplicateFile).mockImplementationOnce(async (_from, to) => {copyPath = to; if (state === "placed") await writeFile(join(f.rootPath, to), "committed"); return duplicateWithRecovery(to, async () => {throw new Error("daemon exited after commit");});});
  await expect(f.run()).rejects.toThrow("check the saved operation");
  const {readdir} = await import("node:fs/promises");
  const directory = join(f.rootPath, ".dohc/local/duplicate-pending");
  const receipt = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), "utf8"));
  expect(receipt).toMatchObject({source:"source.md",path:copyPath,operationId:expect.stringMatching(/^dohc-operation:/)});
  vi.mocked(f.engine.readDuplicate).mockResolvedValue(committed ? {path:copyPath} : null);
  const recovered = await f.run();
  expect(recovered.operationId === receipt.operationId).toBe(committed);
  expect(recovered.materialized).toBe(state !== "pending-placement");
  expect(f.engine.duplicateFile).toHaveBeenCalledTimes(committed ? 1 : 2);
  if (state === "pending-placement") {
    expect(await readdir(directory)).toHaveLength(1);
    expect(await f.run()).toMatchObject({operationId: receipt.operationId, path: copyPath, materialized: false});
    await writeFile(join(f.rootPath, copyPath), "committed");
    expect(await f.run()).toMatchObject({operationId: receipt.operationId, path: copyPath, materialized: true});
    expect(f.engine.duplicateFile).toHaveBeenCalledTimes(1);
  }
  expect(await readdir(directory)).toEqual([]);
});

it.each(["Restart dohc before duplicating this file.", "Undo in progress", "This action is unavailable for shared live files."])(
  "passes definite refusals through: %s", async message => {
    const f = await fixture();
    vi.mocked(f.engine.duplicateFile).mockRejectedValue(new Error(message));
    await expect(f.run()).rejects.toThrow(message);
  },
);
it.each(["undone", "deleted", "renamed", "superseded"])(
  "drops a stale receipt when its copy is %s and makes a new copy", async state => {
    const f = await fixture();
    let oldPath = "";
    vi.mocked(f.engine.duplicateFile).mockImplementationOnce(async (_from, to) => {
      oldPath = to;
      await writeFile(join(f.rootPath, to), "committed");
      return duplicateWithRecovery(to, async () => {throw new Error("lost reply");});
    });
    await expect(f.run()).rejects.toThrow("could not confirm");
    const {readdir} = await import("node:fs/promises");
    const dir = join(f.rootPath, ".dohc/local/duplicate-pending");
    const receipt = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]!), "utf8"));
    if (state !== "superseded") await rm(join(f.rootPath, oldPath));
    vi.mocked(f.engine.readDuplicate).mockResolvedValue(null);
    const next = await f.run();
    expect(next.operationId).not.toBe(receipt.operationId);
    expect(f.engine.duplicateFile).toHaveBeenCalledTimes(2);
    expect(await readFile(join(f.rootPath, next.path), "utf8")).toBe("Settled");
    expect(await readdir(dir)).toEqual([]);
  },
);

// A receipt lives in `.dohc/local/duplicate-pending`. One left at the old
// `.dohc/duplicate-pending` is not read, so Duplicate makes a new copy.
it("ignores a receipt in the old folder and makes a new copy", async () => {
  const f = await fixture();
  const {createHash} = await import("node:crypto");
  const {readdir, lstat} = await import("node:fs/promises");
  const name = createHash("sha256").update("source.md").digest("hex") + ".json";
  const old = join(f.rootPath, ".dohc/duplicate-pending", name);
  await mkdir(join(f.rootPath, ".dohc/duplicate-pending"), {recursive: true});
  const planted = {workspaceId: "workspace", source: "source.md", path: "planted.md", operationId: "dohc-operation:11111111-1111-4111-8111-111111111111"};
  await writeFile(old, JSON.stringify(planted));
  vi.mocked(f.engine.readDuplicate).mockResolvedValue({path: "planted.md"});
  const copied = await f.run();
  expect(copied.operationId).not.toBe(planted.operationId);
  expect(f.engine.readDuplicate).not.toHaveBeenCalled();
  expect(await readFile(join(f.rootPath, copied.path), "utf8")).toBe("Settled");
  expect(await readdir(join(f.rootPath, ".dohc/local/duplicate-pending"))).toEqual([]);
  expect(JSON.parse(await readFile(old, "utf8"))).toEqual(planted);
  if (process.platform !== "win32") expect((await lstat(join(f.rootPath, ".dohc/local/duplicate-pending"))).mode & 0o777).toBe(0o700);
});

// The receipt is what lets a retry find a copy whose reply was lost. Only a
// missing one means no copy is pending; one dohc can't use refuses the retry
// before it makes a second copy or replaces the receipt.
it.each(["corrupt", "not JSON for a Duplicate", "writable by others", "hard-linked", "a folder"] as const)(
  "refuses a retry whose pending Duplicate is %s, and makes no second copy", async kind => {
    if (process.platform === "win32" && kind === "writable by others") return;
    const f = await fixture();
    vi.mocked(f.engine.duplicateFile).mockImplementationOnce(async (_from, to) => {
      await writeFile(join(f.rootPath, to), "committed");
      return duplicateWithRecovery(to, async () => {throw new Error("lost reply");});
    });
    await expect(f.run()).rejects.toThrow("dohc will check the saved operation before making another copy");
    const {chmod, link, readdir, rm: remove} = await import("node:fs/promises");
    const directory = join(f.rootPath, ".dohc/local/duplicate-pending");
    const [name] = await readdir(directory);
    const receipt = join(directory, name!);
    if (kind === "corrupt") await writeFile(receipt, "{");
    if (kind === "not JSON for a Duplicate") await writeFile(receipt, JSON.stringify({path: "elsewhere.md"}));
    if (kind === "writable by others") await chmod(receipt, 0o666);
    if (kind === "hard-linked") await link(receipt, join(f.rootPath, "second-name.json"));
    if (kind === "a folder") { await remove(receipt); await mkdir(receipt); }
    const before = kind === "a folder" ? null : await readFile(receipt, "utf8");
    await expect(f.run()).rejects.toThrow(`dohc did not duplicate source.md because it can't use the pending Duplicate at .dohc/local/duplicate-pending/${name}. Check History for an earlier copy. Then remove that file and try again.`);
    expect(f.engine.duplicateFile).toHaveBeenCalledOnce();
    if (before !== null) expect(await readFile(receipt, "utf8")).toBe(before);
    // The way out the words give works.
    await remove(receipt, {recursive: true});
    expect((await f.run()).operationId).toMatch(/^dohc-operation:/);
    expect(f.engine.duplicateFile).toHaveBeenCalledTimes(2);
  },
);

it.each([
  ["not-opened", null, "dohc did not duplicate this file because the workspace has not finished opening. Try again when it opens."],
  ["not-excluded", false, "dohc did not duplicate this file because it can't keep this workspace's .dohc/local out of iCloud Drive. Restart dohc to try again."],
] as const)("refuses Duplicate before the workspace's open prepares .dohc/local (%s)", async (_refusal, ready, words) => {
  const f = await fixture();
  readLocalStateFrom(ready === null ? null : {currentBinding: () => ({localStateReady: ready}), localStateOpenAt: async () => ({ current: () => true })});
  await expect(f.run()).rejects.toThrow(words);
  expect(f.changePathsAs).not.toHaveBeenCalled();
  const {readdir} = await import("node:fs/promises");
  expect(await readdir(join(f.rootPath, ".dohc/local"))).toEqual([]);
});
