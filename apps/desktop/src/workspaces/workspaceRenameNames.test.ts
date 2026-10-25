import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { moveWorkspacePathByHand } from "./workspaceFileMoves";
import { createFile, createFolder, normalizeWorkspaceMovePaths } from "./workspaceFiles";

describe.skipIf(process.platform !== "win32")("Windows tree naming", () => {
  it("lets a person shorten an existing path beyond the engine limit", async () => {
    const rootPath = await createTestScratch("rename-names-");
    const fromPath = `${"folder/".repeat(150)}source.md`;
    await mkdir(join(rootPath, "folder/".repeat(150)), { recursive: true });
    await writeFile(join(rootPath, fromPath), "keep this");
    const beginFileRename = vi.fn();
    const changePathsAs = vi.fn();
    const operation = { workspace: { workspaceId: "names", rootPath }, assertCurrent: vi.fn() };
    await moveWorkspacePathByHand(operation, { fromPath, toPath: "short.md" },
      { kind: "human", humanId: "local:test" }, {
        capture: { beginFileRename, changePathsAs }, requestId: "names",
        markDeleted: vi.fn(), trashItem: vi.fn(),
      });
    expect(changePathsAs).not.toHaveBeenCalled();
    expect(beginFileRename).toHaveBeenCalledWith(fromPath, "short.md");
    expect(await readFile(join(rootPath, "short.md"), "utf8")).toBe("keep this");
  });

  it("explains a?b.md before Windows can report a misleading changed path", async () => {
    const rootPath = await createTestScratch("rename-names-");
    await writeFile(join(rootPath, "source.md"), "keep this");
    const operation = { workspace: { workspaceId: "names", rootPath }, assertCurrent: vi.fn() };
    await expect(moveWorkspacePathByHand(operation, { fromPath: "source.md", toPath: "a?b.md" },
      { kind: "human", humanId: "local:test" }, {
        capture: null, requestId: "names",
        markDeleted: vi.fn(), trashItem: vi.fn(),
      })).rejects.toThrow("A name cannot contain a question mark (?). Remove it.");
    expect(await readFile(join(rootPath, "source.md"), "utf8")).toBe("keep this");
  });

  it.each(["a?b.md", "a*b.md", 'a"b.md', "a<b.md", "a>b.md", "a|b.md", "a:b.md", "CON.md", "NUL", "tail.", "tail ", "a".repeat(256)])("refuses %s at create and move sinks", async name => {
    const rootPath = await createTestScratch("rename-names-");
    expect(() => normalizeWorkspaceMovePaths("source.md", name)).toThrow();
    await expect(createFile(rootPath, name, "")).rejects.toThrow();
    await expect(createFolder(rootPath, name)).rejects.toThrow();
  });
});

it.skipIf(process.platform !== "win32")("refuses a path beyond the engine limit before falling back to a disk-only move", async () => {
  const rootPath = await createTestScratch("rename-names-");
  await writeFile(join(rootPath, "source.md"), "keep this");
  const toPath = `${"folder/".repeat(150)}target.md`;
  const beginFileRename = vi.fn();
  const operation = { workspace: { workspaceId: "names", rootPath }, assertCurrent: vi.fn() };
  await expect(moveWorkspacePathByHand(operation, { fromPath: "source.md", toPath },
    { kind: "human", humanId: "local:test" }, {
      capture: { beginFileRename, changePathsAs: vi.fn() }, requestId: "names",
      markDeleted: vi.fn(), trashItem: vi.fn(),
    })).rejects.toThrow("This path is too long for dohc. Shorten the name or use fewer folders.");
  expect(beginFileRename).not.toHaveBeenCalled();
  expect(await readFile(join(rootPath, "source.md"), "utf8")).toBe("keep this");
});
