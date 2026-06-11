import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  collectZipEntries,
  copyIntoWorkspace,
  createFile,
  createFolder,
  deletePath,
  importDroppedPaths,
  listFiles,
  movePath,
} from "./workspaceFiles";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-files-"));
});

// One probe instead of process.platform: whether THIS filesystem treats
// case variants as the same file decides which move semantics apply.
async function caseInsensitiveFs(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-case-"));
  await writeFile(join(dir, "probe.md"), "");
  return existsSync(join(dir, "PROBE.md"));
}

const rejectingTrash = async () => {
  throw new Error("g_file_trash: Unable to find or create trash directory");
};

describe("createFile", () => {
  it("creates nested files through validated paths", async () => {
    const path = await createFile(root, "notes/./today.md");
    expect(path).toBe("notes/today.md");
    expect(await readFile(join(root, "notes/today.md"), "utf8")).toBe("");
  });

  it("rejects traversal and reserved paths", async () => {
    await expect(createFile(root, "../escape.md")).rejects.toThrow(/traversal/);
    await expect(createFile(root, ".dohc/x.md")).rejects.toThrow(/reserved/);
  });

  it("never overwrites an existing file", async () => {
    await writeFile(join(root, "keep.md"), "original");
    await createFile(root, "keep.md");
    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
  });

  it("refuses to write through a symlinked directory that escapes the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-outside-"));
    await symlink(outside, join(root, "link"), "dir");
    await expect(createFile(root, "link/evil.md")).rejects.toThrow(/escapes workspace/);
    expect(existsSync(join(outside, "evil.md"))).toBe(false);
  });
});

describe("listFiles", () => {
  it("lists files and folders but skips internal directories", async () => {
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(join(root, ".dohc", "manifest.json"), "{}");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "a.md"), "");
    await writeFile(join(root, "wallet.sqlite"), "");
    const result = await listFiles(root);
    expect(result.files).toEqual([
      { path: "notes/a.md", kind: "file" },
      { path: "wallet.sqlite", kind: "database" },
    ]);
    expect(result.folders).toEqual(["notes"]);
  });

  it("returns EMPTY folders so the tree can render them", async () => {
    await mkdir(join(root, "empty", "nested"), { recursive: true });
    const result = await listFiles(root);
    expect(result.files).toEqual([]);
    expect(result.folders).toEqual(["empty", "empty/nested"]);
  });

  it("does not follow symlinks (file or directory) out of the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-outside-"));
    await writeFile(join(outside, "secret.md"), "leak");
    await mkdir(join(outside, "sub"), { recursive: true });
    await writeFile(join(outside, "sub", "deep.md"), "leak");
    await writeFile(join(root, "real.md"), "");
    await symlink(join(outside, "secret.md"), join(root, "link.md"), "file");
    await symlink(outside, join(root, "linkdir"), "dir");
    const result = await listFiles(root);
    expect(result.files).toEqual([{ path: "real.md", kind: "file" }]);
    expect(result.folders).toEqual([]);
  });
});

describe("createFolder", () => {
  it("creates nested folders and returns the normalized path", async () => {
    const path = await createFolder(root, "projects//alpha/./deep");
    expect(path).toBe("projects/alpha/deep");
    expect((await listFiles(root)).folders).toContain("projects/alpha/deep");
  });

  it("rejects traversal, absolute, and reserved paths", async () => {
    await expect(createFolder(root, "../escape")).rejects.toThrow(/traversal/);
    await expect(createFolder(root, "a/../../escape")).rejects.toThrow(/traversal/);
    await expect(createFolder(root, "%2e%2e%2fescape")).rejects.toThrow(/traversal/);
    await expect(createFolder(root, "/etc/pwned")).rejects.toThrow(/absolute/);
    await expect(createFolder(root, ".dohc/trap")).rejects.toThrow(/reserved/);
    await expect(createFolder(root, "notes/.dohc/trap")).rejects.toThrow(/reserved/);
  });

  it("refuses to create through a symlinked ancestor that escapes the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-outside-"));
    await symlink(outside, join(root, "link"), "dir");
    await expect(createFolder(root, "link/evil")).rejects.toThrow(/escapes workspace/);
    expect(existsSync(join(outside, "evil"))).toBe(false);
  });
});

describe("movePath", () => {
  it("renames a file in place (one engine for rename and move)", async () => {
    await writeFile(join(root, "draft.md"), "body");
    const path = await movePath(root, "draft.md", "final.md");
    expect(path).toBe("final.md");
    expect(await readFile(join(root, "final.md"), "utf8")).toBe("body");
    expect(existsSync(join(root, "draft.md"))).toBe(false);
  });

  it("moves a file into a folder, creating the destination parent", async () => {
    await writeFile(join(root, "loose.md"), "x");
    const path = await movePath(root, "loose.md", "notes/deep/loose.md");
    expect(path).toBe("notes/deep/loose.md");
    expect(await readFile(join(root, "notes/deep/loose.md"), "utf8")).toBe("x");
  });

  it("moves a folder with everything inside it", async () => {
    await mkdir(join(root, "team"), { recursive: true });
    await writeFile(join(root, "team", "anna.md"), "a");
    await movePath(root, "team", "org/team");
    expect(await readFile(join(root, "org/team/anna.md"), "utf8")).toBe("a");
    expect(existsSync(join(root, "team"))).toBe(false);
  });

  it("rejects traversal/absolute/reserved on BOTH sides", async () => {
    await writeFile(join(root, "a.md"), "");
    await expect(movePath(root, "../a.md", "b.md")).rejects.toThrow(/traversal/);
    await expect(movePath(root, "a.md", "../../b.md")).rejects.toThrow(/traversal/);
    await expect(movePath(root, "a.md", "..%252fb.md")).rejects.toThrow(/traversal/);
    await expect(movePath(root, "/etc/passwd", "b.md")).rejects.toThrow(/absolute/);
    await expect(movePath(root, "a.md", "C:\\evil.md")).rejects.toThrow(/absolute/);
    await expect(movePath(root, ".dohc/ui-state.json", "b.md")).rejects.toThrow(/reserved/);
    await expect(movePath(root, "a.md", ".dohc/b.md")).rejects.toThrow(/reserved/);
    await expect(movePath(root, "a.md", "notes/.dohc/b.md")).rejects.toThrow(/reserved/);
    await expect(movePath(root, "a.md", ".DOHC./b.md")).rejects.toThrow(/reserved/);
    await expect(movePath(root, "a.md", ".dohc /b.md")).rejects.toThrow(/reserved/);
  });

  it("refuses overwriting an existing destination (file and folder)", async () => {
    await writeFile(join(root, "a.md"), "A");
    await writeFile(join(root, "b.md"), "B");
    await expect(movePath(root, "a.md", "b.md")).rejects.toThrow(/already exists/);
    expect(await readFile(join(root, "b.md"), "utf8")).toBe("B");
    // No merge semantics: dir-onto-dir with the same name refuses too.
    await mkdir(join(root, "x"), { recursive: true });
    await mkdir(join(root, "y/x"), { recursive: true });
    await expect(movePath(root, "x", "y/x")).rejects.toThrow(/already exists/);
  });

  it("allows a case-only rename / refuses a distinct case-colliding file (fs-probed)", async () => {
    await writeFile(join(root, "readme.md"), "body");
    if (await caseInsensitiveFs()) {
      // Case-insensitive fs: README.md "exists" because it IS readme.md —
      // the realpath-equality carve-out must let the rename through.
      const path = await movePath(root, "readme.md", "README.md");
      expect(path).toBe("README.md");
      const names = await readdir(root);
      expect(names).toContain("README.md");
    } else {
      // Case-sensitive fs: README.md is a DISTINCT file; creating it first
      // must refuse the move (realpaths differ — no carve-out).
      await writeFile(join(root, "README.md"), "other");
      await expect(movePath(root, "readme.md", "README.md")).rejects.toThrow(
        /already exists/,
      );
      expect(await readFile(join(root, "README.md"), "utf8")).toBe("other");
    }
  });

  it("refuses moving a folder into itself or its own descendant", async () => {
    await mkdir(join(root, "team/leads"), { recursive: true });
    await expect(movePath(root, "team", "team")).rejects.toThrow(/into itself/);
    await expect(movePath(root, "team", "team/leads/team")).rejects.toThrow(
      /into itself/,
    );
  });

  it("refuses a symlink source and a symlinked-ancestor escape", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-outside-"));
    await writeFile(join(outside, "real.md"), "outside");
    await symlink(join(outside, "real.md"), join(root, "link.md"), "file");
    await expect(movePath(root, "link.md", "stolen.md")).rejects.toThrow(/symlink/);
    // Source under a symlinked dir: the parent's realpath escapes the root.
    await symlink(outside, join(root, "linkdir"), "dir");
    await expect(movePath(root, "linkdir/real.md", "stolen.md")).rejects.toThrow(
      /escapes workspace/,
    );
    // Destination under a symlinked dir: existingAncestor escapes the root.
    await writeFile(join(root, "mine.md"), "");
    await expect(movePath(root, "mine.md", "linkdir/mine.md")).rejects.toThrow(
      /escapes workspace/,
    );
    expect(existsSync(join(outside, "mine.md"))).toBe(false);
  });
});

describe("deletePath", () => {
  it("hands the resolved real path to the OS trash", async () => {
    await writeFile(join(root, "junk.md"), "x");
    const trashed: string[] = [];
    const result = await deletePath(root, "junk.md", async (p) => {
      trashed.push(p);
    });
    expect(result).toEqual({ trashed: true });
    expect(trashed).toHaveLength(1);
    expect(trashed[0]!.endsWith("junk.md")).toBe(true);
  });

  it("falls back to .dohc/trash when the OS trash rejects (cross-filesystem)", async () => {
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "junk.md"), "recover me");
    const result = await deletePath(root, "notes/junk.md", rejectingTrash);
    expect(result).toEqual({ trashed: false });
    expect(existsSync(join(root, "notes", "junk.md"))).toBe(false);
    const trashNames = await readdir(join(root, ".dohc", "trash"));
    expect(trashNames).toHaveLength(1);
    expect(trashNames[0]).toMatch(/^\d+-[0-9a-f-]+-junk\.md$/);
    // Recoverable: the bytes survive, never a hard delete.
    expect(
      await readFile(join(root, ".dohc", "trash", trashNames[0]!), "utf8"),
    ).toBe("recover me");
  });

  it("trashes folders (recursively recoverable)", async () => {
    await mkdir(join(root, "team"), { recursive: true });
    await writeFile(join(root, "team", "anna.md"), "a");
    const result = await deletePath(root, "team", rejectingTrash);
    expect(result).toEqual({ trashed: false });
    const trashNames = await readdir(join(root, ".dohc", "trash"));
    expect(trashNames[0]).toMatch(/^\d+-[0-9a-f-]+-team$/);
    expect(
      await readFile(join(root, ".dohc", "trash", trashNames[0]!, "anna.md"), "utf8"),
    ).toBe("a");
  });

  it("keeps BOTH same-basename files when fallback deletes share a timestamp tick", async () => {
    // Multi-select delete of a/readme.md + b/readme.md runs back-to-back —
    // the same Date.now() tick — and POSIX rename silently clobbers. The
    // collision-resistant trash name must keep both recoverable.
    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "b"), { recursive: true });
    await writeFile(join(root, "a", "readme.md"), "first bytes");
    await writeFile(join(root, "b", "readme.md"), "second bytes");
    await deletePath(root, "a/readme.md", rejectingTrash);
    await deletePath(root, "b/readme.md", rejectingTrash);
    const trashDir = join(root, ".dohc", "trash");
    const names = await readdir(trashDir);
    expect(names).toHaveLength(2);
    const bodies = await Promise.all(
      names.map((name) => readFile(join(trashDir, name), "utf8")),
    );
    expect(bodies.sort()).toEqual(["first bytes", "second bytes"]);
  });

  it("refuses a symlinked .dohc/trash — fallback never relocates outside the workspace", async () => {
    // The resolveWorkspaceMetadataDir threat one level deeper: a REAL .dohc
    // carrying `trash -> <outside>`. mkdir{recursive} no-ops on the existing
    // symlink-to-dir, so only the post-mkdir lstat check can catch it.
    const outside = await mkdtemp(join(tmpdir(), "dohc-attacker-"));
    await mkdir(join(root, ".dohc"), { recursive: true });
    await symlink(outside, join(root, ".dohc", "trash"), "dir");
    await writeFile(join(root, "secret-notes.md"), "private");
    await expect(deletePath(root, "secret-notes.md", rejectingTrash)).rejects.toThrow(
      /\.dohc\/trash must be a real directory/,
    );
    // The file stayed put; nothing landed in the attacker directory.
    expect(await readFile(join(root, "secret-notes.md"), "utf8")).toBe("private");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects traversal, reserved paths, the root, and symlink escapes", async () => {
    await expect(deletePath(root, "../x", rejectingTrash)).rejects.toThrow(/traversal/);
    await expect(deletePath(root, ".dohc/trash", rejectingTrash)).rejects.toThrow(
      /reserved/,
    );
    await expect(deletePath(root, ".", rejectingTrash)).rejects.toThrow(/invalid/);
    const outside = await mkdtemp(join(tmpdir(), "dohc-outside-"));
    await writeFile(join(outside, "victim.md"), "keep");
    await symlink(join(outside, "victim.md"), join(root, "link.md"), "file");
    await expect(deletePath(root, "link.md", rejectingTrash)).rejects.toThrow(
      /escapes workspace/,
    );
    expect(await readFile(join(outside, "victim.md"), "utf8")).toBe("keep");
  });
});

describe("collectZipEntries", () => {
  it("exports the workspace excluding ignored segments and symlinks", async () => {
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(join(root, ".dohc", "manifest.json"), "{}");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "a.md"), "alpha");
    await writeFile(join(root, "b.md"), "beta");
    const outside = await mkdtemp(join(tmpdir(), "dohc-outside-"));
    await writeFile(join(outside, "secret.md"), "leak");
    await symlink(join(outside, "secret.md"), join(root, "leak.md"), "file");

    const { entries } = await collectZipEntries(root);
    expect(entries.map((entry) => entry.path).sort()).toEqual(["b.md", "notes/a.md"]);
  });

  it("exports a single folder under its own top-level name", async () => {
    await mkdir(join(root, "notes/deep"), { recursive: true });
    await writeFile(join(root, "notes", "a.md"), "alpha");
    await writeFile(join(root, "notes", "deep", "b.md"), "beta");
    const { entries, baseName } = await collectZipEntries(root, "notes");
    expect(baseName).toBe("notes");
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      "notes/a.md",
      "notes/deep/b.md",
    ]);
  });

  it("rejects traversal/reserved paths and symlink escapes", async () => {
    await expect(collectZipEntries(root, "../x")).rejects.toThrow(/traversal/);
    await expect(collectZipEntries(root, ".dohc")).rejects.toThrow(/reserved/);
    const outside = await mkdtemp(join(tmpdir(), "dohc-outside-"));
    await symlink(outside, join(root, "linkdir"), "dir");
    await expect(collectZipEntries(root, "linkdir")).rejects.toThrow(
      /escapes workspace/,
    );
  });

  it("refuses an oversized export instead of buffering it", async () => {
    // 3 x 100MB sparse-ish writes would be slow; instead lower the bar by
    // exceeding the ENTRY cap with many tiny files in one directory tree.
    await mkdir(join(root, "many"), { recursive: true });
    await Promise.all(
      Array.from({ length: 2001 }, (_, i) =>
        writeFile(join(root, "many", `f-${i}.md`), "x"),
      ),
    );
    await expect(collectZipEntries(root, "many")).rejects.toThrow(/Export too large/);
  });
});

describe("copyIntoWorkspace", () => {
  it("copies external files into the workspace root by basename", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    const imported = await copyIntoWorkspace(root, [join(outside, "receipt.png")]);
    expect(imported).toEqual(["receipt.png"]);
    expect(await readFile(join(root, "receipt.png"), "utf8")).toBe("png-bytes");
  });

  it("skips files that already exist instead of overwriting", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
    await writeFile(join(outside, "notes.md"), "incoming");
    await writeFile(join(root, "notes.md"), "existing");
    const imported = await copyIntoWorkspace(root, [join(outside, "notes.md")]);
    expect(imported).toEqual([]);
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("existing");
  });
});

describe("importDroppedPaths", () => {
  it("imports regular files and skips directories, symlinks, and relative paths", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-drop-"));
    await writeFile(join(outside, "doc.md"), "dropped");
    await mkdir(join(outside, "folder"), { recursive: true });
    await writeFile(join(outside, "target.md"), "via-link");
    await symlink(join(outside, "target.md"), join(outside, "alias.md"), "file");
    const imported = await importDroppedPaths(
      root,
      [join(outside, "doc.md"), join(outside, "folder"), "relative.md"],
      [root],
    );
    expect(imported).toEqual(["doc.md"]);
    // A symlink source resolves to its real file — still a regular file, so
    // the copy is of real bytes, never a dangling link.
    const linked = await importDroppedPaths(root, [join(outside, "alias.md")], [root]);
    expect(linked).toEqual(["target.md"]);
  });

  it("refuses sources inside any registered workspace's .dohc", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "dohc-other-"));
    await mkdir(join(otherRoot, ".dohc"), { recursive: true });
    await writeFile(join(otherRoot, ".dohc", "credentials.json"), "secret");
    const imported = await importDroppedPaths(
      root,
      [join(otherRoot, ".dohc", "credentials.json")],
      [root, otherRoot],
    );
    expect(imported).toEqual([]);
    expect(existsSync(join(root, "credentials.json"))).toBe(false);
  });
});
