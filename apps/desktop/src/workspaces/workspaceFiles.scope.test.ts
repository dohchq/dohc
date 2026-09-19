import {
  mkdir,
  open,
  readdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { listFiles } from "./workspaceFiles";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: vi.fn(fs.open),
    readdir: vi.fn(fs.readdir),
    stat: vi.fn(fs.stat),
  };
});

let root: string;

beforeEach(async () => {
  root = await createTestScratch("dohc-scoped-listing-");
  for (const path of [
    "root.md", "notes/a.md", "notes/z.mdx", "notes/wallet.sqlite",
    "notes/deep/b.markdown", "notes/deep/deeper/c.md", "notes-other/d.md",
    "other/e.md", "[notes]/literal.md", ".dohc/hidden.md",
    "notes/node_modules/hidden.md",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "---\nicon: 🚀\n---\n# Page\n");
  }
  await mkdir(join(root, "notes/empty"));
  vi.clearAllMocks();
});

describe("scoped file listings", () => {
  it.each([
    { path: ".", recursive: true },
    { path: ".", recursive: false },
    { path: "notes", recursive: true },
    { path: "notes", recursive: false },
    { path: "notes/deep", recursive: false },
    { path: "notes/a.md", recursive: true },
    { path: "notes/a.md", recursive: false },
    { path: "notes/empty", recursive: true },
    { path: "notes/missing", recursive: true },
    { path: "Notes", recursive: true },
    { path: "[notes]", recursive: true },
    { path: ".dohc", recursive: true },
    { path: "notes/node_modules", recursive: true },
  ])("matches the complete listing filtered by the original SDK rules: %j", async (scope) => {
    const complete = await listFiles(root, { includeContentIdentity: true });
    const matches = (path: string) => {
      if (scope.path !== "." && path !== scope.path && !path.startsWith(`${scope.path}/`)) {
        return false;
      }
      const remainder = scope.path === "." ? path : path.slice(scope.path.length + 1);
      return scope.recursive || !remainder.includes("/");
    };
    const scoped = await listFiles(root, { ...scope, includeContentIdentity: true });
    expect(scoped).toEqual({
      files: complete.files.filter((file) => matches(file.path)),
      folders: complete.folders.filter(matches),
    });
  });

  it("reads only ancestors and direct file metadata for a shallow folder request", async () => {
    const listed = await listFiles(root, {
      path: "notes", recursive: false, includeContentIdentity: true,
    });
    expect(listed.files.map((file) => file.path)).toEqual([
      "notes/a.md", "notes/wallet.sqlite", "notes/z.mdx",
    ]);
    expect(vi.mocked(readdir).mock.calls.map(([path]) => path)).toEqual([
      root, join(root, "notes"),
    ]);
    expect(vi.mocked(stat).mock.calls.map(([path]) => path).sort()).toEqual([
      join(root, "notes/a.md"), join(root, "notes/z.mdx"),
    ].sort());
    expect(vi.mocked(open).mock.calls.map(([path]) => path)).toEqual([
      join(root, "notes/a.md"),
    ]);
  });

  it("reads no descendant directory or metadata for a shallow root request", async () => {
    expect((await listFiles(root, { recursive: false })).files).toEqual([
      { path: "root.md", kind: "file", icon: "🚀" },
    ]);
    expect(readdir).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not descend through a requested file or directory symlink", async () => {
    const outside = await createTestScratch("dohc-scoped-outside-");
    await writeFile(join(outside, "secret.md"), "---\nicon: 🔒\n---\n");
    await symlink(outside, join(root, "linked"), "dir");
    await symlink(join(outside, "secret.md"), join(root, "linked.md"), "file");
    for (const path of ["linked", "linked/secret.md", "linked.md"]) {
      vi.clearAllMocks();
      expect(await listFiles(root, { path })).toEqual({ files: [], folders: [] });
      expect(readdir).toHaveBeenCalledTimes(1);
      expect(stat).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    }
  });

  it("refreshes scoped file metadata after an edit", async () => {
    const options = { path: "notes/a.md", includeContentIdentity: true };
    const before = await listFiles(root, options);
    const absolute = join(root, options.path);
    const previous = await stat(absolute);
    await writeFile(absolute, "# No icon\n");
    const modified = new Date(previous.mtimeMs + 1000);
    await utimes(absolute, modified, modified);
    const after = await listFiles(root, options);
    expect(before.files[0]).toMatchObject({ icon: "🚀" });
    expect(after.files[0]).not.toHaveProperty("icon");
    expect(after.files[0]).toHaveProperty("contentIdentity");
    expect(after.files[0]).not.toEqual(before.files[0]);
  });
});
