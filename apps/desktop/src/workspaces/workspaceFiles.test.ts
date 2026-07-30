import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// collectZipEntries tests write thousands of real files; 5s is an I/O budget,
// not a logic budget (#372).
vi.setConfig({ testTimeout: 15_000 });
import {
  collectZipEntries,
  copyIntoWorkspace,
  createFile,
  createFolder,
  deletePath,
  extractFrontmatterIcon,
  importDroppedPaths,
  listFiles,
  movePath,
} from "./workspaceFiles";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import { nativeTmpdir } from "./testTemp";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(nativeTmpdir(), "dohc-files-"));
});

// One probe instead of process.platform: whether THIS filesystem treats
// case variants as the same file decides which move semantics apply.
async function caseInsensitiveFs(): Promise<boolean> {
  const dir = await mkdtemp(join(nativeTmpdir(), "dohc-case-"));
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
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-outside-"));
    await symlink(outside, join(root, "link"), "dir");
    await expect(createFile(root, "link/evil.md")).rejects.toThrow(/escapes workspace/);
    expect(existsSync(join(outside, "evil.md"))).toBe(false);
  });
});

describe("extractFrontmatterIcon", () => {
  it("reads a plain icon scalar from a leading frontmatter block", () => {
    expect(
      extractFrontmatterIcon("---\nid: n1\ntitle: Plan\nicon: 🚀\n---\n# Body\n"),
    ).toBe("🚀");
  });

  it("strips surrounding quotes and inline comments", () => {
    expect(extractFrontmatterIcon('---\nicon: "📄"\n---\n')).toBe("📄");
    expect(extractFrontmatterIcon("---\nicon: 📝 # my note\n---\n")).toBe("📝");
  });

  it("returns undefined without frontmatter, before an icon, or when empty", () => {
    expect(extractFrontmatterIcon("# No frontmatter\nicon: 🚀\n")).toBeUndefined();
    expect(extractFrontmatterIcon("---\ntitle: Plan\n---\nicon: 🚀\n")).toBeUndefined();
    expect(extractFrontmatterIcon("---\nicon:\n---\n")).toBeUndefined();
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

  it("surfaces a markdown page's icon frontmatter for the tree glyph", async () => {
    await writeFile(
      join(root, "plan.md"),
      "---\nid: n1\ntitle: Plan\nicon: 🚀\n---\n\n# Plan\n",
    );
    await writeFile(join(root, "plain.md"), "# No frontmatter\n");
    const result = await listFiles(root);
    expect(result.files).toEqual([
      { path: "plain.md", kind: "file" },
      { path: "plan.md", kind: "file", icon: "🚀" },
    ]);
  });

  it("returns EMPTY folders so the tree can render them", async () => {
    await mkdir(join(root, "empty", "nested"), { recursive: true });
    const result = await listFiles(root);
    expect(result.files).toEqual([]);
    expect(result.folders).toEqual(["empty", "empty/nested"]);
  });

  it("keeps shared-with-me visible as local workspace data", async () => {
    await mkdir(join(root, SHARED_WITH_ME_FOLDER, "alex"), { recursive: true });
    await writeFile(join(root, SHARED_WITH_ME_FOLDER, "alex", "brief.md"), "shared");

    const result = await listFiles(root);
    expect(result.files).toContainEqual({
      path: `${SHARED_WITH_ME_FOLDER}/alex/brief.md`,
      kind: "file",
    });
    expect(result.folders).toEqual([SHARED_WITH_ME_FOLDER, `${SHARED_WITH_ME_FOLDER}/alex`]);
  });

  it("does not follow symlinks (file or directory) out of the workspace", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-outside-"));
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

  it("reuses a cached icon (skips re-reading the file) while mtime+size are unchanged", async () => {
    const path = join(root, "plan.md");
    const withRocket = "---\nicon: 🚀\n---\n\n# Plan\n";
    const withNote = "---\nicon: 📝\n---\n\n# Plan\n";
    // Both emoji are 4-byte UTF-8 sequences, so swapping them leaves the
    // file's byte size unchanged — the only lever left to prove a cache hit
    // (vs. a fresh read) is forcing mtime back to what the cache last saw.
    expect(Buffer.byteLength(withNote, "utf8")).toBe(Buffer.byteLength(withRocket, "utf8"));

    await writeFile(path, withRocket);
    const first = await listFiles(root);
    expect(first.files).toEqual([{ path: "plan.md", kind: "file", icon: "🚀" }]);

    const original = await stat(path);
    await writeFile(path, withNote);
    // Restore the original mtime so size+mtime look identical to the cache
    // even though the on-disk bytes changed underneath.
    await utimes(path, original.atime, original.mtime);

    const second = await listFiles(root);
    expect(second.files).toEqual([{ path: "plan.md", kind: "file", icon: "🚀" }]);
  });

  it("invalidates the icon cache when a markdown file's mtime changes", async () => {
    const path = join(root, "plan.md");
    await writeFile(path, "---\nicon: 🚀\n---\n\n# Plan\n");
    const first = await listFiles(root);
    expect(first.files).toEqual([{ path: "plan.md", kind: "file", icon: "🚀" }]);

    const before = await stat(path);
    await writeFile(path, "---\nicon: 📝\n---\n\n# Plan\n");
    // Force a strictly newer mtime regardless of filesystem timestamp
    // resolution (some filesystems only tick every ~1s).
    const bumped = new Date(before.mtime.getTime() + 1000);
    await utimes(path, bumped, bumped);

    const second = await listFiles(root);
    expect(second.files).toEqual([{ path: "plan.md", kind: "file", icon: "📝" }]);
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
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-outside-"));
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

  it("refuses a case-fold descendant move on a case-insensitive fs (realpath guard)", async () => {
    await mkdir(join(root, "Team", "leads"), { recursive: true });
    await writeFile(join(root, "Team", "leads", "x.md"), "x");
    if (await caseInsensitiveFs()) {
      // "team/leads/sub" IS inside "Team" (same inode), but the lexical
      // self/descendant refusal is case-SENSITIVE and misses it — the realpath
      // descendant guard is what catches this and prevents the corruption.
      await expect(movePath(root, "Team", "team/leads/sub")).rejects.toThrow(/into itself/);
      expect(await readFile(join(root, "Team", "leads", "x.md"), "utf8")).toBe("x");
    } else {
      // Case-sensitive fs: the same-case descendant is still refused lexically.
      await expect(movePath(root, "Team", "Team/leads/sub")).rejects.toThrow(/into itself/);
    }
  });

  it("refuses a symlink source and a symlinked-ancestor escape", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-outside-"));
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
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-attacker-"));
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

  it("rejects traversal, reserved paths, the root, and symlinked-ancestor escapes", async () => {
    await expect(deletePath(root, "../x", rejectingTrash)).rejects.toThrow(/traversal/);
    await expect(deletePath(root, ".dohc/trash", rejectingTrash)).rejects.toThrow(
      /reserved/,
    );
    await expect(deletePath(root, ".", rejectingTrash)).rejects.toThrow(/invalid/);
    // A regular file reached THROUGH a symlinked ancestor still escapes: lstat
    // follows the ancestor link, realpath of the leaf resolves outside the
    // root, and containment refuses it.
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-outside-"));
    await writeFile(join(outside, "victim.md"), "keep");
    await symlink(outside, join(root, "linkdir"), "dir");
    await expect(deletePath(root, "linkdir/victim.md", rejectingTrash)).rejects.toThrow(
      /escapes workspace/,
    );
    expect(await readFile(join(outside, "victim.md"), "utf8")).toBe("keep");
  });

  it("trashes a symlink as the LINK, never following it to harm the target", async () => {
    // The finding: realpath-ing a symlink target meant deleting a link trashed
    // whatever it pointed at. lstat-first trashes the LINK itself; the external
    // target is untouched. (The tree never lists symlinks, so this only fires
    // via a direct/forged IPC — but it must never delete an outside file.)
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-outside-"));
    await writeFile(join(outside, "victim.md"), "keep");
    await symlink(join(outside, "victim.md"), join(root, "link.md"), "file");
    const result = await deletePath(root, "link.md", rejectingTrash);
    expect(result).toEqual({ trashed: false });
    // The LINK left the tree, the target is untouched, and the trash holds the
    // link (never the target's bytes).
    expect(existsSync(join(root, "link.md"))).toBe(false);
    expect(await readFile(join(outside, "victim.md"), "utf8")).toBe("keep");
    const trashNames = await readdir(join(root, ".dohc", "trash"));
    expect(trashNames).toHaveLength(1);
    expect(trashNames[0]).toMatch(/link\.md$/);
  });

  it("fits the trash name within NAME_MAX for a very long basename", async () => {
    // prefix (timestamp + uuid, ~50 bytes) + a ~250-char basename would exceed
    // the 255-byte NAME_MAX and ENAMETOOLONG. The decorative basename truncates
    // to fit; the uuid keeps the entry unique and the bytes recoverable.
    const longBase = `${"x".repeat(246)}.md`; // 249 chars — legal to create
    await writeFile(join(root, longBase), "recover me");
    const result = await deletePath(root, longBase, rejectingTrash);
    expect(result).toEqual({ trashed: false });
    const trashNames = await readdir(join(root, ".dohc", "trash"));
    expect(trashNames).toHaveLength(1);
    expect(Buffer.byteLength(trashNames[0]!, "utf8")).toBeLessThanOrEqual(255);
    expect(
      await readFile(join(root, ".dohc", "trash", trashNames[0]!), "utf8"),
    ).toBe("recover me");
  });
});

describe("collectZipEntries", () => {
  it("exports the workspace excluding ignored segments and symlinks", async () => {
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(join(root, ".dohc", "manifest.json"), "{}");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "a.md"), "alpha");
    await writeFile(join(root, "b.md"), "beta");
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-outside-"));
    await writeFile(join(outside, "secret.md"), "leak");
    await symlink(join(outside, "secret.md"), join(root, "leak.md"), "file");

    const { entries } = await collectZipEntries(root);
    expect(entries.map((entry) => entry.path).sort()).toEqual(["b.md", "notes/a.md"]);
    // The fd-based bounded read returns the FULL bytes (not a truncated/empty
    // buffer) — guards the open→fstat→read loop against an off-by-one.
    const byPath = new Map(
      entries.map((entry) => [entry.path, Buffer.from(entry.data).toString("utf8")]),
    );
    expect(byPath.get("b.md")).toBe("beta");
    expect(byPath.get("notes/a.md")).toBe("alpha");
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
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-outside-"));
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

  it("exports mounted-share paths (read surface, not a write)", async () => {
    await mkdir(join(root, SHARED_WITH_ME_FOLDER, "alex", "docs"), { recursive: true });
    await writeFile(
      join(root, SHARED_WITH_ME_FOLDER, "alex", "docs", "brief.md"),
      "shared",
    );
    const { entries, baseName } = await collectZipEntries(
      root,
      `${SHARED_WITH_ME_FOLDER}/alex`,
    );
    expect(baseName).toBe("alex");
    expect(entries.map((entry) => entry.path)).toEqual(["alex/docs/brief.md"]);
  });

  it("keeps secret-classified files out of archives (codex P2)", async () => {
    await writeFile(join(root, "notes.md"), "fine");
    await writeFile(join(root, ".env"), "API_KEY=hunter2");
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "prod.env"), "DB=secret");
    const { entries } = await collectZipEntries(root);
    expect(entries.map((entry) => entry.path).sort()).toEqual(["notes.md"]);
  });

  it("keeps secrets out of MOUNTED-share exports too (read-aware floor)", async () => {
    await mkdir(join(root, SHARED_WITH_ME_FOLDER, "alex"), { recursive: true });
    await writeFile(join(root, SHARED_WITH_ME_FOLDER, "alex", "brief.md"), "fine");
    await writeFile(join(root, SHARED_WITH_ME_FOLDER, "alex", ".env"), "API_KEY=x");
    const { entries } = await collectZipEntries(root, `${SHARED_WITH_ME_FOLDER}/alex`);
    expect(entries.map((entry) => entry.path)).toEqual(["alex/brief.md"]);
    await expect(
      collectZipEntries(root, `${SHARED_WITH_ME_FOLDER}/alex/.env`),
    ).rejects.toThrow(/Secret files never leave the workspace/);
  });

  it("keeps secrets out of SUBFOLDER exports and refuses an explicit secret target", async () => {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "app.md"), "fine");
    await writeFile(join(root, "config", "prod.env"), "DB=secret");
    const { entries } = await collectZipEntries(root, "config");
    expect(entries.map((entry) => entry.path)).toEqual(["config/app.md"]);
    await expect(collectZipEntries(root, "config/prod.env")).rejects.toThrow(
      /Secret files never leave the workspace/,
    );
  });
});

describe("copyIntoWorkspace", () => {
  it("copies external files into the workspace root by basename", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-import-"));
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    const outcome = await copyIntoWorkspace(root, [join(outside, "receipt.png")]);
    expect(outcome).toEqual({ imported: ["receipt.png"], skipped: 0 });
    expect(await readFile(join(root, "receipt.png"), "utf8")).toBe("png-bytes");
  });

  it("renames on collision instead of overwriting or dropping the file", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-import-"));
    await writeFile(join(outside, "notes.md"), "incoming");
    await writeFile(join(root, "notes.md"), "existing");
    const outcome = await copyIntoWorkspace(root, [join(outside, "notes.md")]);
    expect(outcome).toEqual({ imported: ["notes (2).md"], skipped: 0 });
    // The existing file is untouched; the import landed beside it.
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("existing");
    expect(await readFile(join(root, "notes (2).md"), "utf8")).toBe("incoming");
  });

  it("fits collision variants within NAME_MAX for near-limit basenames (codex P2)", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-import-"));
    // 251 chars + ".md" = 254 bytes — legal, but stem + " (2)" would exceed
    // NAME_MAX without truncation and abort the batch with ENAMETOOLONG.
    const longName = `${"a".repeat(251)}.md`;
    await writeFile(join(outside, longName), "incoming");
    await writeFile(join(root, longName), "existing");
    const outcome = await copyIntoWorkspace(root, [join(outside, longName)]);
    expect(outcome.skipped).toBe(0);
    expect(outcome.imported).toHaveLength(1);
    const landed = outcome.imported[0]!;
    expect(Buffer.byteLength(landed, "utf8")).toBeLessThanOrEqual(255);
    expect(landed.endsWith(" (2).md")).toBe(true);
    expect(await readFile(join(root, landed), "utf8")).toBe("incoming");
  });

  it("keeps counting up when collision variants exist too", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-import-"));
    await writeFile(join(outside, "notes.md"), "third");
    await writeFile(join(root, "notes.md"), "first");
    await writeFile(join(root, "notes (2).md"), "second");
    const outcome = await copyIntoWorkspace(root, [join(outside, "notes.md")]);
    expect(outcome.imported).toEqual(["notes (3).md"]);
    expect(await readFile(join(root, "notes (3).md"), "utf8")).toBe("third");
  });

  it("imports into a target folder when one is given", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-import-"));
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    await mkdir(join(root, "inbox"), { recursive: true });
    const outcome = await copyIntoWorkspace(
      root,
      [join(outside, "receipt.png")],
      "inbox",
    );
    expect(outcome).toEqual({ imported: ["inbox/receipt.png"], skipped: 0 });
    expect(await readFile(join(root, "inbox", "receipt.png"), "utf8")).toBe(
      "png-bytes",
    );
  });

  it("refuses a traversal target folder", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-import-"));
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    await expect(
      copyIntoWorkspace(root, [join(outside, "receipt.png")], "../elsewhere"),
    ).rejects.toThrow(/Invalid import destination/);
  });

  it("refuses a reserved target folder (shared-with-me)", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-import-"));
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    await mkdir(join(root, SHARED_WITH_ME_FOLDER), { recursive: true });
    await expect(
      copyIntoWorkspace(root, [join(outside, "receipt.png")], SHARED_WITH_ME_FOLDER),
    ).rejects.toThrow(/Invalid import destination/);
  });

  it("refuses a target folder that does not exist (imports never mkdir)", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-import-"));
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    await expect(
      copyIntoWorkspace(root, [join(outside, "receipt.png")], "missing"),
    ).rejects.toThrow(/not a workspace folder/);
  });

  it("refuses a symlinked ANCESTOR in the target folder (reserved-space smuggle, codex P2)", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-import-"));
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    // link -> shared-with-me resolves INSIDE the workspace, so realpath
    // containment alone would pass while the copy lands in reserved space.
    await mkdir(join(root, SHARED_WITH_ME_FOLDER, "alex"), { recursive: true });
    await symlink(join(root, SHARED_WITH_ME_FOLDER), join(root, "link"), "dir");
    await expect(
      copyIntoWorkspace(root, [join(outside, "receipt.png")], "link/alex"),
    ).rejects.toThrow(/not a workspace folder/);
    expect(existsSync(join(root, SHARED_WITH_ME_FOLDER, "alex", "receipt.png"))).toBe(
      false,
    );
  });

  it("accepts an explicit empty-string target as the root", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-import-"));
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    const outcome = await copyIntoWorkspace(root, [join(outside, "receipt.png")], "");
    expect(outcome).toEqual({ imported: ["receipt.png"], skipped: 0 });
  });

  it("refuses a symlinked target folder (must not teleport the import)", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-import-"));
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    const elsewhere = await mkdtemp(join(nativeTmpdir(), "dohc-elsewhere-"));
    await symlink(elsewhere, join(root, "linked"), "dir");
    await expect(
      copyIntoWorkspace(root, [join(outside, "receipt.png")], "linked"),
    ).rejects.toThrow(/not a workspace folder/);
    expect(existsSync(join(elsewhere, "receipt.png"))).toBe(false);
  });
});

describe("importDroppedPaths", () => {
  it("imports regular files and skips directories, symlinks, and relative paths", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-drop-"));
    await writeFile(join(outside, "doc.md"), "dropped");
    await mkdir(join(outside, "folder"), { recursive: true });
    await writeFile(join(outside, "target.md"), "via-link");
    await symlink(join(outside, "target.md"), join(outside, "alias.md"), "file");
    const outcome = await importDroppedPaths(
      root,
      [
        join(outside, "doc.md"),
        join(outside, "folder"),
        join(outside, "alias.md"),
        "relative.md",
      ],
      [root],
    );
    // Only the real regular file imports. The directory, the symlink (refused
    // BEFORE it follows to target.md), and the relative path are all skipped —
    // and the skip count says so instead of the batch silently shrinking.
    expect(outcome).toEqual({ imported: ["doc.md"], skipped: 3 });
    expect(existsSync(join(root, "target.md"))).toBe(false);
  });

  it("refuses a symlink pointing at a secret OUTSIDE the workspace (exfil vector)", async () => {
    // A compromised renderer forging droppedPaths could plant a symlink to a
    // secret and rely on realpath-then-isFile to copy the SECRET's bytes into
    // the (possibly cloud-synced) workspace. lstat-ing the ORIGINAL source
    // refuses the link before it ever resolves to the target.
    const secrets = await mkdtemp(join(nativeTmpdir(), "dohc-secrets-"));
    await writeFile(join(secrets, "id_rsa"), "PRIVATE KEY");
    const stage = await mkdtemp(join(nativeTmpdir(), "dohc-stage-"));
    await symlink(join(secrets, "id_rsa"), join(stage, "innocent.txt"), "file");
    const outcome = await importDroppedPaths(root, [join(stage, "innocent.txt")], [root]);
    expect(outcome).toEqual({ imported: [], skipped: 1 });
    expect(existsSync(join(root, "innocent.txt"))).toBe(false);
    // Nothing landed in the workspace — the secret never left its directory.
    expect(await readdir(root)).toEqual([]);
  });

  it("caps the dropped-path count at the handler, not just the schema", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-many-"));
    const paths = await Promise.all(
      Array.from({ length: 101 }, async (_, i) => {
        const p = join(outside, `f-${i}.md`);
        await writeFile(p, "x");
        return p;
      }),
    );
    await expect(importDroppedPaths(root, paths, [root])).rejects.toThrow(/Too many/);
  });

  it("refuses sources inside any registered workspace's .dohc", async () => {
    const otherRoot = await mkdtemp(join(nativeTmpdir(), "dohc-other-"));
    await mkdir(join(otherRoot, ".dohc"), { recursive: true });
    await writeFile(join(otherRoot, ".dohc", "credentials.json"), "secret");
    const outcome = await importDroppedPaths(
      root,
      [join(otherRoot, ".dohc", "credentials.json")],
      [root, otherRoot],
    );
    expect(outcome).toEqual({ imported: [], skipped: 1 });
    expect(existsSync(join(root, "credentials.json"))).toBe(false);
  });

  it("still refuses a .dohc source reached through a symlinked ANCESTOR (canonical containment)", async () => {
    // The accepted ancestor-symlink residual (a real leaf under a symlinked dir
    // imports) must NOT defeat the one location gate we DO enforce: the .dohc
    // refusal runs on realpath(source), so an ancestor alias to another
    // workspace's metadata is still canonicalized and refused.
    const otherRoot = await mkdtemp(join(nativeTmpdir(), "dohc-other-"));
    await mkdir(join(otherRoot, ".dohc"), { recursive: true });
    await writeFile(join(otherRoot, ".dohc", "credentials.json"), "secret");
    const stage = await mkdtemp(join(nativeTmpdir(), "dohc-stage-"));
    await symlink(join(otherRoot, ".dohc"), join(stage, "alias"), "dir");
    const outcome = await importDroppedPaths(
      root,
      [join(stage, "alias", "credentials.json")],
      [root, otherRoot],
    );
    expect(outcome).toEqual({ imported: [], skipped: 1 });
    expect(existsSync(join(root, "credentials.json"))).toBe(false);
  });

  it("drops into the target folder the user aimed at", async () => {
    const outside = await mkdtemp(join(nativeTmpdir(), "dohc-drop-"));
    await writeFile(join(outside, "doc.md"), "dropped");
    await mkdir(join(root, "notes"), { recursive: true });
    const outcome = await importDroppedPaths(
      root,
      [join(outside, "doc.md")],
      [root],
      "notes",
    );
    expect(outcome).toEqual({ imported: ["notes/doc.md"], skipped: 0 });
    expect(await readFile(join(root, "notes", "doc.md"), "utf8")).toBe("dropped");
  });
});
