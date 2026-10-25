import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { existsSync, type Stats } from "node:fs";
import { classifyPath, hasEngineIgnoredSegment } from "@dohc/workspace-core";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  rename,
  rm,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyEndProbe,
  classifyLadderProbe,
  collectZipEntries,
  couldBeLengthRefusal,
  copyIntoWorkspace,
  createDurableFile,
  createFile,
  createFolder,
  removeEmptyWorkspaceFolder,
  deletePath,
  extractFrontmatterIcon,
  getWorkspaceListingMetadata,
  importDroppedPaths,
  ImportSkips,
  listFiles,
  movePath,
  nameSkip,
  prepareWorkspaceMove,
  prepareWorkspaceDelete,
  screenDroppedPaths,
} from "./workspaceFiles";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import { createTestScratch } from "./testTemp";
import { openedLocalState } from "../testing/preparedLocalState";
import { datalessCandidates, withICloudCheck } from "../testing/iCloudCheck";
import { readLocalStateFrom } from "./workspaceLocalState";
import { WORKSPACE_TEXT_EDITOR_MAX_BYTES } from "./workspaceTextLimits";
import { deferred } from "../testing/deferred";

let root: string;

beforeEach(async () => {
  root = await createTestScratch("dohc-files-");
});

// Steps an import takes on disk, so a test can change the disk between two
// of them as another process could. Each hook is one test's, and runs only
// for the path it names.
const fsHooks: {
  beforeLstat?: (path: string) => Promise<void>;
  lstatResult?: (path: string, stats: Stats) => void;
  beforeOpen?: (path: string) => Promise<void>;
  opened?: (path: string, handle: FileHandle) => FileHandle;
  afterMkdir?: (path: string) => Promise<void>;
} = {};
afterEach(() => {
  delete fsHooks.beforeLstat;
  delete fsHooks.lstatResult;
  delete fsHooks.beforeOpen;
  delete fsHooks.opened;
  delete fsHooks.afterMkdir;
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (async (path: Parameters<typeof actual.lstat>[0], options?: Parameters<typeof actual.lstat>[1]) => {
      await fsHooks.beforeLstat?.(String(path));
      const stats = await actual.lstat(path, options);
      if (!options?.bigint) fsHooks.lstatResult?.(String(path), stats as Stats);
      return stats;
    }) as typeof actual.lstat,
    open: (async (...args: Parameters<typeof actual.open>) => {
      await fsHooks.beforeOpen?.(String(args[0]));
      const handle = await actual.open(...args);
      return fsHooks.opened?.(String(args[0]), handle) ?? handle;
    }) as typeof actual.open,
    mkdir: (async (...args: Parameters<typeof actual.mkdir>) => {
      const made = await actual.mkdir(...args);
      await fsHooks.afterMkdir?.(String(args[0]));
      return made;
    }) as typeof actual.mkdir,
  };
});

// Runs `step` the first time the hook sees `path`.
function once(path: string, step: () => Promise<void>): (seen: string) => Promise<void> {
  let ran = false;
  return async (seen) => {
    if (ran || seen !== path) return;
    ran = true;
    await step();
  };
}

it("refreshes listing metadata without following replacement symlinks or reserved paths", async () => {
  await writeFile(join(root, "note.md"), "---\nicon: local\n---\n");
  expect(await getWorkspaceListingMetadata(root, "note.md")).toMatchObject({ icon: "local" });
  const outside = await createTestScratch("dohc-files-outside-");
  await writeFile(join(outside, "note.md"), "---\nicon: outside\n---\n");
  await symlink(outside, join(root, "linked"), "junction");
  await symlink(join(outside, "note.md"), join(root, "linked.md"), "file");
  await mkdir(join(root, ".dohc"));
  await writeFile(join(root, ".dohc", "note.md"), "---\nicon: reserved\n---\n");
  for (const path of ["linked/note.md", "linked.md", ".dohc/note.md", "../note.md", "missing.md"]) {
    expect(await getWorkspaceListingMetadata(root, path)).toBeUndefined();
  }
});

// One probe instead of process.platform: whether this filesystem treats
// case variants as the same file decides which move semantics apply.
async function caseInsensitiveFs(): Promise<boolean> {
  const dir = await createTestScratch("dohc-case-");
  await writeFile(join(dir, "probe.md"), "");
  return existsSync(join(dir, "PROBE.md"));
}

const rejectingTrash = async () => {
  throw new Error("g_file_trash: Unable to find or create trash directory");
};

type FileListing = Awaited<ReturnType<typeof listFiles>>;

async function listFilesSerialReference(
  rootPath: string,
  platform: NodeJS.Platform,
): Promise<FileListing> {
  const files: FileListing["files"] = [];
  const folders: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (hasEngineIgnoredSegment(rel, platform) || dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        folders.push(rel);
        await walk(join(dir, dirent.name), rel);
      } else if (dirent.isFile()) {
        const kind = classifyPath(rel).kind;
        const entry: FileListing["files"][number] = { path: rel, kind };
        if (kind === "file" && /\.(md|markdown)$/i.test(rel)) {
          const head = await readFile(join(dir, dirent.name)).catch(() => undefined);
          const icon = head
            ? extractFrontmatterIcon(head.subarray(0, 1024).toString("utf8"))
            : undefined;
          if (icon) entry.icon = icon;
        }
        files.push(entry);
      }
    }
  }

  await walk(rootPath, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  folders.sort((a, b) => a.localeCompare(b));
  return { files, folders };
}

function seededIndex(seed: number): (limit: number) => number {
  let state = seed >>> 0;
  return (limit) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % limit;
  };
}

async function populateGeneratedListingTree(
  treeRoot: string,
  seed: number,
): Promise<void> {
  const next = seededIndex(seed);
  const extensions = [".md", ".markdown", ".md", ".txt", ".json", ".sqlite"];

  await mkdir(join(treeRoot, "empty", "nested"), { recursive: true });
  await mkdir(join(treeRoot, `.hidden-${seed}`), { recursive: true });
  await writeFile(
    join(treeRoot, `.hidden-${seed}`, "visible.md"),
    "---\nicon: 👁️\n---\n",
  );

  for (let index = 0; index < 48; index += 1) {
    const depth = index < 12 ? 1 : 1 + next(5);
    const segments = index < 12
      ? ["flat"]
      : Array.from({ length: depth }, (_, level) =>
          `d${level}-${next(5)}`,
        );
    const dir = join(treeRoot, ...segments);
    await mkdir(dir, { recursive: true });
    const extension = extensions[next(extensions.length)] ?? ".md";
    const path = join(dir, `item-${String(index).padStart(2, "0")}${extension}`);
    const iconCase = next(4);
    const contents = /\.(md|markdown)$/i.test(extension)
      ? iconCase === 0
        ? "---\nicon: 🚀\n---\n# Generated\n"
        : iconCase === 1
          ? "---\nicon: \"📄\"\n---\n# Generated\n"
          : iconCase === 2
            ? "---\nicon: 📝 # generated\n---\n# Generated\n"
            : "# No frontmatter\n"
      : `generated-${seed}-${index}\n`;
    await writeFile(path, contents);
  }

  await mkdir(join(treeRoot, ".dohc", "nested"), { recursive: true });
  await writeFile(join(treeRoot, ".dohc", "nested", "ignored.md"), "---\nicon: ❌\n---\n");
  await mkdir(join(treeRoot, ".git"), { recursive: true });
  await writeFile(join(treeRoot, ".git", "ignored.md"), "ignored");
  await mkdir(join(treeRoot, "kept", "node_modules", "pkg"), { recursive: true });
  await writeFile(join(treeRoot, "kept", "node_modules", "pkg", "ignored.md"), "ignored");
  await writeFile(join(treeRoot, ".dohc-write-listing.tmp"), "ignored");
  await mkdir(join(treeRoot, SHARED_WITH_ME_FOLDER, "alex"), { recursive: true });
  await writeFile(
    join(treeRoot, SHARED_WITH_ME_FOLDER, "alex", "brief.md"),
    "---\nicon: 🤝\n---\n",
  );

  const linkTarget = join(treeRoot, "link-target");
  await mkdir(linkTarget, { recursive: true });
  await writeFile(join(linkTarget, "owned.md"), "owned");
  await symlink(linkTarget, join(treeRoot, "linked-directory"), "dir");
  await symlink(
    join(linkTarget, "owned.md"),
    join(treeRoot, "linked-file.md"),
    "file",
  );
}

describe("createFile", () => {
  it("creates nested files through validated paths", async () => {
    const path = await createFile(root, "notes/./today.md", "initial text");
    expect(path).toBe("notes/today.md");
    expect(await readFile(join(root, "notes/today.md"), "utf8")).toBe(
      "initial text",
    );
  });

  it("rejects traversal and reserved paths", async () => {
    await expect(createFile(root, "../escape.md", "")).rejects.toThrow(/traversal/);
    await expect(createFile(root, ".dohc/x.md", "")).rejects.toThrow(/reserved/);
  });

  it("never overwrites an existing file", async () => {
    await writeFile(join(root, "keep.md"), "original");
    await createFile(root, "keep.md", "");
    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
  });

  it("rejects initial text above the editor byte limit before creating a file", async () => {
    const initialText = `\ud83d\udca1`.repeat(
      WORKSPACE_TEXT_EDITOR_MAX_BYTES / 4 + 1,
    );
    await expect(createFile(root, "large.md", initialText)).rejects.toThrow(
      "Workspace text exceeds WORKSPACE_TEXT_EDITOR_MAX_BYTES: " +
        `limit ${WORKSPACE_TEXT_EDITOR_MAX_BYTES} bytes, observed ${WORKSPACE_TEXT_EDITOR_MAX_BYTES + 4} bytes`,
    );
    expect(existsSync(join(root, "large.md"))).toBe(false);
  });

  it("refuses to write through a symlinked directory that escapes the workspace", async () => {
    const outside = await createTestScratch("dohc-outside-");
    await symlink(outside, join(root, "link"), "dir");
    await expect(createFile(root, "link/evil.md", "")).rejects.toThrow(/escapes the workspace/);
    expect(existsSync(join(outside, "evil.md"))).toBe(false);
  });
});

describe("createDurableFile", () => {
  // The process stops halfway through writing: the final name must not hold a cut-off file.
  it("keeps the final name empty until the complete bytes are linked there", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const halfWritten = deferred(), stopped = deferred();
    const open = async (path: string, flags: string, mode?: number) => {
      const handle = await actual.open(path, flags, mode);
      if (flags !== "wx") return handle;
      return {
        writeFile: async (data: string) => {
          await handle.writeFile(data.slice(0, data.length / 2));
          halfWritten.resolve();
          await stopped.promise;
          throw new Error("dohc stopped");
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    };
    const creating = createDurableFile(root, "notes/kept.md", "complete recovery text", { open });
    await halfWritten.promise;
    expect(existsSync(join(root, "notes/kept.md"))).toBe(false);
    const [temporary, ...others] = await readdir(join(root, "notes"));
    expect(others).toEqual([]);
    expect(hasEngineIgnoredSegment(`notes/${temporary}`, process.platform)).toBe(true);
    stopped.resolve();
    await expect(creating).rejects.toThrow("dohc stopped");
    expect(await readdir(join(root, "notes"))).toEqual([]);
  });

  it("refuses on a drive without hard links and never writes the final name directly", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const opened: string[] = [];
    const open = async (path: string, flags: string, mode?: number) => {opened.push(path); return actual.open(path, flags, mode);};
    const link = async () => {throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });};
    await expect(createDurableFile(root, "notes/kept.md", "complete recovery text", { open, link }))
      .rejects.toThrow("This drive can't save a recovery copy safely, so dohc saved nothing. Your kept edits stay on this computer.");
    expect(opened.filter((path) => basename(path) === "kept.md")).toEqual([]);
    expect(await readdir(join(root, "notes"))).toEqual([]);
  });

  it("writes a new file of any size and never replaces an existing one", async () => {
    const text = "x".repeat(WORKSPACE_TEXT_EDITOR_MAX_BYTES + 1);
    expect(await createDurableFile(root, "notes/./large.md", text)).toBe("notes/large.md");
    expect(await readFile(join(root, "notes/large.md"), "utf8")).toBe(text);
    await writeFile(join(root, "keep.md"), "original");
    await expect(createDurableFile(root, "keep.md", "replacement")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
    expect((await readdir(root)).filter((name) => hasEngineIgnoredSegment(name, process.platform))).toEqual([]);
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
  it("matches the serial walker byte-for-byte across generated trees", async () => {
    for (const seed of [1, 7, 19, 41, 73, 101]) {
      const treeRoot = join(root, `generated-${seed}`);
      await mkdir(treeRoot, { recursive: true });
      await populateGeneratedListingTree(treeRoot, seed);

      const expected = await listFilesSerialReference(treeRoot, "linux");
      const actual = await listFiles(treeRoot, { platform: "linux" });

      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    }
  });

  it("keeps serial ordering across concurrent walks of a deep tree", async () => {
    for (const branch of ["z", "a", "m", "b", "y", "c", "x", "d"]) {
      let dir = join(root, branch);
      for (let depth = 0; depth < 12; depth += 1) {
        dir = join(dir, `d${String(depth).padStart(2, "0")}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `z-${depth}.txt`), "text");
        await writeFile(
          join(dir, `a-${depth}.md`),
          `---\nicon: ${depth % 2 === 0 ? "🌲" : "🌿"}\n---\n`,
        );
      }
      await mkdir(join(dir, "empty"), { recursive: true });
    }

    const expected = JSON.stringify(await listFilesSerialReference(root, "linux"));
    const listings = await Promise.all(
      Array.from({ length: 4 }, () => listFiles(root, { platform: "linux" })),
    );

    for (const listing of listings) {
      expect(JSON.stringify(listing)).toBe(expected);
    }
  });

  it("lists files and folders but skips internal directories", async () => {
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(join(root, ".dohc", "manifest.json"), "{}");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "index"), "internal");
    await mkdir(join(root, "notes"), { recursive: true });
    await mkdir(join(root, "notes", "node_modules"), { recursive: true });
    await writeFile(join(root, "notes", "node_modules", "cache.js"), "internal");
    await writeFile(join(root, ".dohc-write-listing.tmp"), "internal");
    await writeFile(join(root, "notes", "a.md"), "");
    await writeFile(join(root, "wallet.sqlite"), "");
    const result = await listFiles(root);
    expect(result.files).toEqual([
      { path: "notes/a.md", kind: "file" },
      { path: "wallet.sqlite", kind: "database" },
    ]);
    expect(result.folders).toEqual(["notes"]);
  });

  it("excludes reserved case variants from the POSIX listing", async () => {
    await mkdir(join(root, ".GIT"), { recursive: true });
    await writeFile(join(root, ".GIT", "file.md"), "owned");

    const result = await listFiles(root, { platform: "linux" });

    expect(result.files).toEqual([]);
    expect(result.folders).toEqual([]);
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

  it("includes private Markdown content identity only when requested", async () => {
    await writeFile(join(root, "plan.md"), "# Plan\n");

    const ordinary = await listFiles(root);
    expect(ordinary.files[0]).not.toHaveProperty("contentIdentity");

    const indexed = await listFiles(root, { includeContentIdentity: true });
    expect(indexed.files[0]).toHaveProperty(
      "contentIdentity",
      expect.stringMatching(/^disk:\d+:7$/),
    );
  });

  it("returns empty folders so the tree can render them", async () => {
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

  it("does not treat a hash-shaped Excalidraw folder name as ownership proof", async () => {
    const owner = "a".repeat(64);
    await mkdir(join(root, "assets", "excalidraw", owner), { recursive: true });
    await writeFile(join(root, "assets", "excalidraw", owner, `${"b".repeat(64)}.png`), "managed");
    await mkdir(join(root, "assets", "excalidraw", "user"), { recursive: true });
    await writeFile(join(root, "assets", "excalidraw", "user", "keep.png"), "user");

    const result = await listFiles(root);
    expect(result.files).toEqual([
      {
        path: `assets/excalidraw/${owner}/${"b".repeat(64)}.png`,
        kind: "file",
      },
      { path: "assets/excalidraw/user/keep.png", kind: "file" },
    ]);
    expect(result.folders).toEqual([
      "assets",
      "assets/excalidraw",
      `assets/excalidraw/${owner}`,
      "assets/excalidraw/user",
    ]);
  });

  it("does not follow symlinks (file or directory) out of the workspace", async () => {
    const outside = await createTestScratch("dohc-outside-");
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
  it("creates exclusively without making parents or reusing an existing folder", async () => {
    await expect(createFolder(root, "missing/child", { exclusive: true })).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(join(root, "missing"))).toBe(false);
    await expect(createFolder(root, "app", { exclusive: true })).resolves.toBe("app");
    await expect(createFolder(root, "app", { exclusive: true })).rejects.toMatchObject({ code: "EEXIST" });
  });

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
    const outside = await createTestScratch("dohc-outside-");
    await symlink(outside, join(root, "link"), "dir");
    await expect(createFolder(root, "link/evil")).rejects.toThrow(/escapes the workspace/);
    expect(existsSync(join(outside, "evil"))).toBe(false);
  });
});

describe("movePath", () => {
  it("refuses a case-only rename when the disk silently keeps the old capitals", async (context) => {
    await mkdir(join(root, "docs", "plans"), { recursive: true });
    await writeFile(join(root, "docs", "plans", "a.md"), "body");
    if (!(await lstat(join(root, "docs", "Plans")).then(() => true, () => false))) context.skip("this disk keeps case apart");
    const noOp = vi.spyOn(fsPromises, "rename").mockResolvedValue(undefined);
    try {
      await expect(movePath(root, "docs/plans", "docs/Plans")).rejects.toThrow(
        "dohc did not rename docs/plans to docs/Plans. This disk kept the old capitals. Rename it to another name first, then to Plans.",
      );
      expect(await readdir(join(root, "docs"))).toEqual(["plans"]);
      expect(await readFile(join(root, "docs", "plans", "a.md"), "utf8")).toBe("body");
    } finally {
      noOp.mockRestore();
    }
  });

  it("prepares and commits an ordinary move without listing folders", async () => {
    await mkdir(join(root, "docs", "drafts"), { recursive: true });
    await writeFile(join(root, "docs", "drafts", "a.md"), "body");
    const listing = vi.spyOn(fsPromises, "readdir");
    try {
      await prepareWorkspaceMove(root, "docs/drafts/a.md", "archive/deep/a.md");
      await expect(movePath(root, "docs/drafts/a.md", "archive/deep/a.md")).resolves.toBe("archive/deep/a.md");
      expect(listing).not.toHaveBeenCalled();
      expect(await readFile(join(root, "archive", "deep", "a.md"), "utf8")).toBe("body");
    } finally {
      listing.mockRestore();
    }
  });

  it("uses equal realpaths without listing folders until checking the renamed leaf", async (context) => {
    await mkdir(join(root, "docs", "plans"), { recursive: true });
    await writeFile(join(root, "docs", "plans", "a.md"), "body");
    if (!(await lstat(join(root, "docs", "Plans")).then(() => true, () => false))) context.skip("this disk keeps case apart");
    const listing = vi.spyOn(fsPromises, "readdir");
    const originalRename = fsPromises.rename.bind(fsPromises);
    let listingsBeforeRename: number | undefined;
    const renaming = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      listingsBeforeRename = listing.mock.calls.length;
      return originalRename(from, to);
    });
    try {
      await prepareWorkspaceMove(root, "docs/plans", "docs/Plans");
      await expect(movePath(root, "docs/plans", "docs/Plans")).resolves.toBe("docs/Plans");
      expect(listingsBeforeRename).toBe(0);
      expect(listing).toHaveBeenCalledTimes(2);
      expect(await readFile(join(root, "docs", "Plans", "a.md"), "utf8")).toBe("body");
    } finally {
      renaming.mockRestore();
      listing.mockRestore();
    }
  });

  for (const stage of ["prepare", "commit"] as const) {
    it(`maps an unknown destination identity to the move refusal during ${stage}`, async (context) => {
      await mkdir(join(root, "docs", "plans"), { recursive: true });
      await writeFile(join(root, "docs", "plans", "a.md"), "body");
      if (!(await lstat(join(root, "docs", "Plans")).then(() => true, () => false))) context.skip("this disk keeps case apart");
      const original = fsPromises.realpath.bind(fsPromises);
      const lookup = vi.spyOn(fsPromises, "realpath").mockImplementation(async (path) => {
        const resolved = await original(path);
        return String(path).startsWith(`${root}${sep}`) ? String(path) : resolved;
      });
      const listing = vi.spyOn(fsPromises, "readdir");
      if (stage === "prepare") listing.mockResolvedValue([]);
      else fsHooks.afterMkdir = async (path) => {
        if (path === join(root, "docs")) listing.mockResolvedValue([]);
      };
      try {
        const operation = stage === "prepare" ? prepareWorkspaceMove : movePath;
        await expect(operation(root, "docs/plans", "docs/Plans")).rejects.toThrow(
          "dohc did not move docs/plans to docs/Plans. dohc could not tell which files or folders on disk they are. Check both paths in your file manager before trying again.",
        );
        expect(await readFile(join(root, "docs", "plans", "a.md"), "utf8")).toBe("body");
      } finally {
        listing.mockRestore();
        lookup.mockRestore();
      }
    });
  }

  it("maps an unknown case-alias descendant identity to the move refusal", async (context) => {
    await mkdir(join(root, "Team", "leads"), { recursive: true });
    await writeFile(join(root, "Team", "leads", "a.md"), "body");
    if (!(await lstat(join(root, "team")).then(() => true, () => false))) context.skip("this disk keeps case apart");
    const original = fsPromises.realpath.bind(fsPromises);
    const lookup = vi.spyOn(fsPromises, "realpath").mockImplementation(async (path) => {
      const resolved = await original(path);
      return String(path).startsWith(`${root}${sep}`) ? String(path) : resolved;
    });
    const listing = vi.spyOn(fsPromises, "readdir").mockResolvedValue([]);
    try {
      await expect(prepareWorkspaceMove(root, "Team", "team/leads/sub")).rejects.toThrow(
        "dohc did not move Team to team/leads/sub. dohc could not tell which files or folders on disk they are. Check both paths in your file manager before trying again.",
      );
      expect(await readFile(join(root, "Team", "leads", "a.md"), "utf8")).toBe("body");
    } finally {
      listing.mockRestore();
      lookup.mockRestore();
    }
  });

  it("renames a case-only folder when realpath keeps lookup case", async (context) => {
    await mkdir(join(root, "docs", "plans"), { recursive: true });
    await writeFile(join(root, "docs", "plans", "a.md"), "body");
    if (!(await lstat(join(root, "docs", "Plans")).then(() => true, () => false))) context.skip("this disk keeps case apart");
    const original = fsPromises.realpath.bind(fsPromises);
    const lookup = vi.spyOn(fsPromises, "realpath").mockImplementation(async (path) => {
      const resolved = await original(path);
      return String(path).startsWith(`${root}${sep}`) ? String(path) : resolved;
    });
    try {
      await expect(movePath(root, "docs/plans", "docs/Plans")).resolves.toBe("docs/Plans");
      expect(await readdir(join(root, "docs"))).toEqual(["Plans"]);
      expect(await readFile(join(root, "docs", "Plans", "a.md"), "utf8")).toBe("body");
    } finally {
      lookup.mockRestore();
    }
  });

  it("refuses a case-alias descendant when realpath keeps lookup case", async (context) => {
    await mkdir(join(root, "Team", "leads"), { recursive: true });
    await writeFile(join(root, "Team", "leads", "a.md"), "body");
    if (!(await lstat(join(root, "team")).then(() => true, () => false))) context.skip("this disk keeps case apart");
    const original = fsPromises.realpath.bind(fsPromises);
    const lookup = vi.spyOn(fsPromises, "realpath").mockImplementation(async (path) => {
      const resolved = await original(path);
      return String(path).startsWith(`${root}${sep}`) ? String(path) : resolved;
    });
    try {
      await expect(movePath(root, "Team", "team/leads/sub")).rejects.toThrow("Cannot move a path into itself");
      expect(await readFile(join(root, "Team", "leads", "a.md"), "utf8")).toBe("body");
    } finally {
      lookup.mockRestore();
    }
  });

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

  it("rejects traversal/absolute/reserved on both sides", async () => {
    await writeFile(join(root, "a.md"), "");
    await expect(movePath(root, "../a.md", "b.md")).rejects.toThrow(/traversal/);
    await expect(movePath(root, "a.md", "../../b.md")).rejects.toThrow(/traversal/);
    await expect(movePath(root, "a.md", "..%252fb.md")).rejects.toThrow(/traversal/);
    await expect(movePath(root, "/etc/passwd", "b.md")).rejects.toThrow(/absolute/);
    await expect(movePath(root, "a.md", "C:\\evil.md")).rejects.toThrow(/absolute/);
    await expect(movePath(root, ".dohc/local/ui-state.json", "b.md")).rejects.toThrow(/reserved/);
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
      // Case-sensitive fs: README.md is a distinct file; creating it first
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
    const outside = await createTestScratch("dohc-outside-");
    await writeFile(join(outside, "real.md"), "outside");
    await symlink(join(outside, "real.md"), join(root, "link.md"), "file");
    await expect(movePath(root, "link.md", "stolen.md")).rejects.toThrow(/symlink/);
    // Source under a symlinked dir: the parent's realpath escapes the root.
    await symlink(outside, join(root, "linkdir"), "dir");
    await expect(movePath(root, "linkdir/real.md", "stolen.md")).rejects.toThrow(
      /escapes the workspace/,
    );
    // Destination under a symlinked dir: existingAncestor escapes the root.
    await writeFile(join(root, "mine.md"), "");
    await expect(movePath(root, "mine.md", "linkdir/mine.md")).rejects.toThrow(
      /escapes the workspace/,
    );
    expect(existsSync(join(outside, "mine.md"))).toBe(false);
  });
});

describe("prepareWorkspaceDelete", () => {
  it("returns the physical entry spelling without following a symlink leaf", async () => {
    await mkdir(join(root, "Notes"), { recursive: true });
    await writeFile(join(root, "Notes", "A.md"), "upper");

    if (await caseInsensitiveFs()) {
      await expect(prepareWorkspaceDelete(root, "notes/a.md")).resolves.toBe(
        "Notes/A.md",
      );
    } else {
      await writeFile(join(root, "Notes", "a.md"), "lower");
      await expect(prepareWorkspaceDelete(root, "Notes/A.md")).resolves.toBe(
        "Notes/A.md",
      );
      await expect(prepareWorkspaceDelete(root, "Notes/a.md")).resolves.toBe(
        "Notes/a.md",
      );
    }

    await symlink(join(root, "Notes", "A.md"), join(root, "alias.md"));
    await expect(prepareWorkspaceDelete(root, "alias.md")).resolves.toBe(
      "alias.md",
    );
  });
});

describe("deletePath", () => {
  // The engine's open of the workspace prepared `.dohc/local`, where the
  // workspace trash is.
  const workspace = () => ({ workspaceId: "delete-path", rootPath: root });
  beforeEach(() => openedLocalState(workspace()));

  it("hands the resolved real path to the OS trash", async () => {
    await writeFile(join(root, "junk.md"), "x");
    const trashed: string[] = [];
    const result = await deletePath(workspace(), "junk.md", async (p) => {
      trashed.push(p);
    });
    expect(result).toEqual({ trashed: true });
    expect(trashed).toHaveLength(1);
    expect(trashed[0]!.endsWith("junk.md")).toBe(true);
  });

  it("falls back to .dohc/local/trash when the OS trash rejects (cross-filesystem), never .dohc/trash", async () => {
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "junk.md"), "recover me");
    await mkdir(join(root, ".dohc", "trash"));
    const result = await deletePath(workspace(), "notes/junk.md", rejectingTrash);
    expect(result).toEqual({ trashed: false });
    expect(await readdir(join(root, ".dohc", "trash"))).toEqual([]);
    expect(existsSync(join(root, "notes", "junk.md"))).toBe(false);
    const trashNames = await readdir(join(root, ".dohc", "local", "trash"));
    expect(trashNames).toHaveLength(1);
    expect(trashNames[0]).toMatch(/^\d+-[0-9a-f-]+-junk\.md$/);
    // Recoverable: the bytes survive, never a hard delete.
    expect(
      await readFile(join(root, ".dohc", "local", "trash", trashNames[0]!), "utf8"),
    ).toBe("recover me");
  });

  it("trashes folders (recursively recoverable)", async () => {
    await mkdir(join(root, "team"), { recursive: true });
    await writeFile(join(root, "team", "anna.md"), "a");
    const result = await deletePath(workspace(), "team", rejectingTrash);
    expect(result).toEqual({ trashed: false });
    const trashNames = await readdir(join(root, ".dohc", "local", "trash"));
    expect(trashNames[0]).toMatch(/^\d+-[0-9a-f-]+-team$/);
    expect(
      await readFile(join(root, ".dohc", "local", "trash", trashNames[0]!, "anna.md"), "utf8"),
    ).toBe("a");
  });

  it("keeps both same-basename files when fallback deletes share a timestamp tick", async () => {
    // Multi-select delete of a/readme.md + b/readme.md runs back-to-back —
    // the same Date.now() tick — and POSIX rename silently clobbers. The
    // collision-resistant trash name must keep both recoverable.
    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "b"), { recursive: true });
    await writeFile(join(root, "a", "readme.md"), "first bytes");
    await writeFile(join(root, "b", "readme.md"), "second bytes");
    await deletePath(workspace(), "a/readme.md", rejectingTrash);
    await deletePath(workspace(), "b/readme.md", rejectingTrash);
    const trashDir = join(root, ".dohc", "local", "trash");
    const names = await readdir(trashDir);
    expect(names).toHaveLength(2);
    const bodies = await Promise.all(
      names.map((name) => readFile(join(trashDir, name), "utf8")),
    );
    expect(bodies.sort()).toEqual(["first bytes", "second bytes"]);
  });

  it("refuses a symlinked .dohc/local/trash — fallback never relocates outside the workspace", async () => {
    // The resolveWorkspaceMetadataDir threat two levels deeper: a real
    // .dohc/local carrying `trash -> <outside>`. mkdir no-ops on the existing
    // symlink-to-dir, so only the post-mkdir lstat check can catch it.
    const outside = await createTestScratch("dohc-attacker-");
    await symlink(outside, join(root, ".dohc", "local", "trash"), "dir");
    await writeFile(join(root, "secret-notes.md"), "private");
    await expect(deletePath(workspace(), "secret-notes.md", rejectingTrash)).rejects.toThrow(
      /A link is at \.dohc\/local\/trash, which must be a real folder/,
    );
    // The file stayed put; nothing landed in the attacker directory.
    expect(await readFile(join(root, "secret-notes.md"), "utf8")).toBe("private");
    expect(await readdir(outside)).toEqual([]);
  });

  it("names the squatter when a FILE sits at .dohc/local/trash — never a raw errno", async () => {
    // A plain file at the trash made mkdir{recursive} throw raw
    // "EEXIST: file already exists, mkdir …": no constraint, no next
    // step, on the very path dohc advertises as the recovery location. The
    // refusal must name .dohc/local/trash, what squats it, and the way out.
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(join(root, ".dohc", "local", "trash"), "squatting");
    await writeFile(join(root, "junk.md"), "keep me");
    await expect(deletePath(workspace(), "junk.md", rejectingTrash)).rejects.toThrow(
      "dohc could not move this to the workspace trash. A file is at .dohc/local/trash, which must be a real folder. Remove or rename that file. Then retry.",
    );
    // The target stayed put and the squatter was not touched.
    expect(await readFile(join(root, "junk.md"), "utf8")).toBe("keep me");
    expect(await readFile(join(root, ".dohc", "local", "trash"), "utf8")).toBe("squatting");
  });

  it.skipIf(process.platform === "win32")("refuses a trash folder another user can change", async () => {
    await mkdir(join(root, ".dohc", "local", "trash"));
    await chmod(join(root, ".dohc", "local", "trash"), 0o777);
    await writeFile(join(root, "junk.md"), "keep me");
    await expect(deletePath(workspace(), "junk.md", rejectingTrash)).rejects.toThrow(
      "dohc could not move this to the workspace trash. Another user can change .dohc/local/trash. Make it a folder only you can change. Then retry.",
    );
    expect(await readFile(join(root, "junk.md"), "utf8")).toBe("keep me");
    expect(await readdir(join(root, ".dohc", "local", "trash"))).toEqual([]);
  });

  it.each([
    ["not-opened", null, "because the workspace has not finished opening. Try again when it opens."],
    ["not-excluded", false, "because it can't keep this workspace's trash out of iCloud Drive. Restart dohc to try again."],
  ] as const)("moves nothing when the OS trash rejects before the open prepares .dohc/local (%s)", async (_refusal, ready, because) => {
    readLocalStateFrom(ready === null ? null : { currentBinding: () => ({ localStateReady: ready }), localStateOpenAt: async () => ({ current: () => true }) });
    await writeFile(join(root, "junk.md"), "keep me");
    await expect(deletePath(workspace(), "junk.md", rejectingTrash)).rejects.toThrow(
      `dohc did not move junk.md to the workspace trash ${because}`,
    );
    expect(await readFile(join(root, "junk.md"), "utf8")).toBe("keep me");
    expect(existsSync(join(root, ".dohc", "local", "trash"))).toBe(false);
    // The OS trash needs nothing from `.dohc/local`.
    expect(await deletePath(workspace(), "junk.md", async () => undefined)).toEqual({ trashed: true });
  });

  // A local sparse file has a size and no blocks, as a file only in iCloud
  // Drive does. Its dataless flag is clear, so it moves like any other.
  it.runIf(process.platform === "darwin")("moves a local sparse file and a folder holding one into the workspace trash", async () => {
    await writeFile(join(root, "sparse.bin"), "");
    await truncate(join(root, "sparse.bin"), 4096);
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder", "sparse.bin"), "");
    await truncate(join(root, "folder", "sparse.bin"), 4096);
    expect((await stat(join(root, "sparse.bin"))).blocks).toBe(0);
    expect(await deletePath(workspace(), "sparse.bin", rejectingTrash)).toEqual({ trashed: false });
    expect(await deletePath(workspace(), "folder", rejectingTrash)).toEqual({ trashed: false });
    expect(existsSync(join(root, "sparse.bin"))).toBe(false);
    expect(await readdir(join(root, ".dohc", "local", "trash"))).toHaveLength(2);
  });

  // With Optimize Mac Storage, iCloud Drive can leave a file's bytes only in
  // iCloud. Moved into .dohc/local, which iCloud Drive skips, they could be
  // lost. A sparse file is the candidate, and the flags it reports decide.
  describe("a file only in iCloud Drive", () => {
    const sparse = async (path: string) => { await writeFile(join(root, path), ""); await truncate(join(root, path), 4096); };
    const evicted = async () => {
      await sparse("evicted.md");
      await mkdir(join(root, "folder", "inner"), { recursive: true });
      await writeFile(join(root, "folder", "kept.md"), "here");
      await sparse("folder/inner/evicted.md");
    };
    const untouched = async () => {
      expect((await stat(join(root, "evicted.md"))).size).toBe(4096);
      expect(await readFile(join(root, "folder", "kept.md"), "utf8")).toBe("here");
      expect(await readdir(join(root, ".dohc", "local", "trash"))).toEqual([]);
    };

    it.skipIf(process.platform === "win32")("moves nothing into the workspace trash when its dataless flag is set", async () => {
      await evicted();
      await withICloudCheck(datalessCandidates, async () => {
        await expect(deletePath(workspace(), "evicted.md", rejectingTrash)).rejects.toThrow(
          "dohc did not move evicted.md to the workspace trash because it is only in iCloud Drive. Download it, then try again.",
        );
        await expect(deletePath(workspace(), "folder", rejectingTrash)).rejects.toThrow(
          "dohc did not move folder to the workspace trash because some of it is only in iCloud Drive. Download it, then try again.",
        );
        await untouched();
        // An empty file has no bytes to lose, and the system trash takes the rest.
        await writeFile(join(root, "empty.md"), "");
        expect(await deletePath(workspace(), "empty.md", rejectingTrash)).toEqual({ trashed: false });
        const system: string[] = [];
        expect(await deletePath(workspace(), "folder", async (path) => { system.push(path); })).toEqual({ trashed: true });
        expect(system).toEqual([join(await realpath(root), "folder")]);
      });
    });

    it.skipIf(process.platform === "win32")("moves nothing when it can't read the flags", async () => {
      await evicted();
      await withICloudCheck({ applies: true, readFlags: async () => { throw new Error("stat: evicted.md: No such file or directory"); } }, async () => {
        await expect(deletePath(workspace(), "folder", rejectingTrash)).rejects.toThrow(
          "dohc did not move folder to the workspace trash because dohc could not check for files only in iCloud Drive. Try again.",
        );
      });
      await untouched();
    });

    // An empty folder lists no entry, so the bound is checked before each
    // folder the walk opens, and once more before it answers. A bound
    // already past stands in for one that runs out among empty folders. Past
    // it, the walk opens nothing more: a folder it can't open would fail.
    it.skipIf(process.platform === "win32")("checks its time bound before each folder it opens and before it answers", async () => {
      await mkdir(join(root, "empty"));
      await mkdir(join(root, "locked"));
      await chmod(join(root, "locked"), 0o000);
      await writeFile(join(root, "local.md"), "here");
      try {
        await withICloudCheck({ applies: true, maxMs: -1 }, async () => {
          for (const folder of ["empty", "locked"]) {
            await expect(deletePath(workspace(), folder, rejectingTrash)).rejects.toThrow(
              `dohc did not move ${folder} to the workspace trash because it holds too many files to check. Delete it in smaller parts.`,
            );
          }
          await expect(deletePath(workspace(), "local.md", rejectingTrash)).rejects.toThrow(
            "dohc did not move local.md to the workspace trash because dohc could not check for files only in iCloud Drive. Try again.",
          );
        });
      } finally {
        await chmod(join(root, "locked"), 0o755);
      }
      expect(existsSync(join(root, "empty"))).toBe(true);
      expect(existsSync(join(root, "locked"))).toBe(true);
      expect(await readFile(join(root, "local.md"), "utf8")).toBe("here");
      expect(await readdir(join(root, ".dohc", "local", "trash"))).toEqual([]);
    });

    it.skipIf(process.platform === "win32")("moves nothing from a folder too large to check in its bounds", async () => {
      await evicted();
      for (const n of [1, 2, 3]) await writeFile(join(root, "folder", `${n}.md`), String(n));
      const words = "dohc did not move folder to the workspace trash because it holds too many files to check. Delete it in smaller parts.";
      await withICloudCheck({ applies: true, maxEntries: 3 }, async () => {
        await expect(deletePath(workspace(), "folder", rejectingTrash)).rejects.toThrow(words);
      });
      await withICloudCheck({ applies: true, maxMs: 0 }, async () => {
        await expect(deletePath(workspace(), "folder", rejectingTrash)).rejects.toThrow(words);
      });
      await untouched();
      // Within its bounds the same folder moves.
      await withICloudCheck({ applies: true, maxEntries: 7, readFlags: async (paths) => paths.map(() => 0) }, async () => {
        expect(await deletePath(workspace(), "folder", rejectingTrash)).toEqual({ trashed: false });
      });
    });
  });

  it("rejects traversal, reserved paths, the root, and symlinked-ancestor escapes", async () => {
    await expect(deletePath(workspace(), "../x", rejectingTrash)).rejects.toThrow(/traversal/);
    await expect(deletePath(workspace(), ".dohc/local/trash", rejectingTrash)).rejects.toThrow(
      /reserved/,
    );
    await expect(deletePath(workspace(), ".", rejectingTrash)).rejects.toThrow(/invalid/);
    // A regular file reached through a symlinked ancestor still escapes: lstat
    // follows the ancestor link, realpath of the leaf resolves outside the
    // root, and containment refuses it.
    const outside = await createTestScratch("dohc-outside-");
    await writeFile(join(outside, "victim.md"), "keep");
    await symlink(outside, join(root, "linkdir"), "dir");
    await expect(deletePath(workspace(), "linkdir/victim.md", rejectingTrash)).rejects.toThrow(
      /escapes the workspace/,
    );
    expect(await readFile(join(outside, "victim.md"), "utf8")).toBe("keep");
  });

  it("trashes a symlink as the LINK, never following it to harm the target", async () => {
    // The finding: realpath-ing a symlink target meant deleting a link trashed
    // whatever it pointed at. lstat-first trashes the LINK itself; the external
    // target is untouched. (The tree never lists symlinks, so this only fires
    // via a direct/forged IPC — but it must never delete an outside file.)
    const outside = await createTestScratch("dohc-outside-");
    await writeFile(join(outside, "victim.md"), "keep");
    await symlink(join(outside, "victim.md"), join(root, "link.md"), "file");
    const result = await deletePath(workspace(), "link.md", rejectingTrash);
    expect(result).toEqual({ trashed: false });
    // The LINK left the tree, the target is untouched, and the trash holds the
    // link (never the target's bytes).
    expect(existsSync(join(root, "link.md"))).toBe(false);
    expect(await readFile(join(outside, "victim.md"), "utf8")).toBe("keep");
    const trashNames = await readdir(join(root, ".dohc", "local", "trash"));
    expect(trashNames).toHaveLength(1);
    expect(trashNames[0]).toMatch(/link\.md$/);
  });

  it("fits the trash name within NAME_MAX for a very long basename", async () => {
    // prefix (timestamp + uuid, ~50 bytes) + a ~250-char basename would exceed
    // the 255-byte NAME_MAX and ENAMETOOLONG. The decorative basename truncates
    // to fit; the uuid keeps the entry unique and the bytes recoverable.
    const longBase = `${"x".repeat(246)}.md`; // 249 chars — legal to create
    await writeFile(join(root, longBase), "recover me");
    const result = await deletePath(workspace(), longBase, rejectingTrash);
    expect(result).toEqual({ trashed: false });
    const trashNames = await readdir(join(root, ".dohc", "local", "trash"));
    expect(trashNames).toHaveLength(1);
    expect(Buffer.byteLength(trashNames[0]!, "utf8")).toBeLessThanOrEqual(255);
    expect(
      await readFile(join(root, ".dohc", "local", "trash", trashNames[0]!), "utf8"),
    ).toBe("recover me");
  });
});

describe("collectZipEntries", () => {
  it("exports the workspace excluding ignored segments and symlinks", async () => {
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(join(root, ".dohc", "manifest.json"), "{}");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "index"), "internal");
    await mkdir(join(root, "notes"), { recursive: true });
    await mkdir(join(root, "notes", "node_modules"), { recursive: true });
    await writeFile(join(root, "notes", "node_modules", "cache.js"), "internal");
    await writeFile(join(root, "notes", "a.md"), "alpha");
    await writeFile(join(root, ".dohc-write-export.tmp"), "internal");
    await writeFile(join(root, "b.md"), "beta");
    const outside = await createTestScratch("dohc-outside-");
    await writeFile(join(outside, "secret.md"), "leak");
    await symlink(join(outside, "secret.md"), join(root, "leak.md"), "file");

    const { entries } = await collectZipEntries(root);
    expect(entries.map((entry) => entry.path).sort()).toEqual(["b.md", "notes/a.md"]);
    // The fd-based bounded read returns the full bytes (not a truncated/empty
    // buffer) — guards the open→fstat→read loop against an off-by-one.
    const byPath = new Map(
      entries.map((entry) => [entry.path, Buffer.from(entry.data).toString("utf8")]),
    );
    expect(byPath.get("b.md")).toBe("beta");
    expect(byPath.get("notes/a.md")).toBe("alpha");
  });

  it("excludes reserved case variants from POSIX zip exports", async () => {
    await mkdir(join(root, ".GIT"), { recursive: true });
    await writeFile(join(root, ".GIT", "file.md"), "owned");

    const { entries } = await collectZipEntries(root, undefined, {
      platform: "linux",
    });

    expect(entries.map((entry) => entry.path)).toEqual([]);
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
    const outside = await createTestScratch("dohc-outside-");
    await symlink(outside, join(root, "linkdir"), "dir");
    await expect(collectZipEntries(root, "linkdir")).rejects.toThrow(
      /escapes the workspace/,
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
    await expect(
      collectZipEntries(root, "many", {
        includeArchivePath: () => false,
      }),
      "excluded projection files are buffered before owner replacement",
    ).resolves.toMatchObject({ entries: [] });
    // 30s because this one writes 2001 real files — an I/O budget, not a logic
    // budget. Scoped to this test: the other 58 in this file measured
    // under 1s on a loaded box, and a file-wide bump would multiply how long a
    // genuine hang takes to surface. The old 15s bound was measured from
    // inside: 13.0s on a 24-process load, 2026-08-03.
  }, 30_000);

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

  it("keeps secret-classified files out of archives", async () => {
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
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    const outcome = await copyIntoWorkspace(root, [join(outside, "receipt.png")]);
    expect(outcome).toEqual({ imported: ["receipt.png"], skipped: 0 });
    expect(await readFile(join(root, "receipt.png"), "utf8")).toBe("png-bytes");
  });

  it("renames on collision instead of overwriting or dropping the file", async () => {
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "notes.md"), "incoming");
    await writeFile(join(root, "notes.md"), "existing");
    const outcome = await copyIntoWorkspace(root, [join(outside, "notes.md")]);
    expect(outcome).toEqual({ imported: ["notes (2).md"], skipped: 0 });
    // The existing file is untouched; the import landed beside it.
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("existing");
    expect(await readFile(join(root, "notes (2).md"), "utf8")).toBe("incoming");
  });

  // What a retry after a partial import meets: the files that already landed
  // are imported again beside themselves, not skipped. The shell names what
  // landed so the person can pick only the rest.
  it("imports a repeated batch again under collision names", async () => {
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "one.md"), "one");
    await writeFile(join(outside, "two.md"), "two");
    const batch = [join(outside, "one.md"), join(outside, "two.md")];

    expect(await copyIntoWorkspace(root, batch)).toEqual({ imported: ["one.md", "two.md"], skipped: 0 });
    expect(await copyIntoWorkspace(root, batch)).toEqual({
      imported: ["one (2).md", "two (2).md"],
      skipped: 0,
    });
  });

  // A failed copy stops the import and says which file and why. Files that
  // landed first come back too, so the shell can name them instead of
  // letting a retry copy them again.
  it("returns what landed and which file stopped the import", async () => {
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "one.md"), "one");
    const missing = join(outside, "gone.md");

    const outcome = await copyIntoWorkspace(root, [join(outside, "one.md"), missing]);
    expect(outcome).toMatchObject({ imported: ["one.md"], skipped: 0, interrupted: true });
    expect(outcome.stop).toMatchObject({ file: "gone.md", code: "ENOENT" });
    expect(outcome.stop?.detail).toContain("gone.md");
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("one");

    const first = await copyIntoWorkspace(root, [missing]);
    expect(first).toMatchObject({ imported: [], skipped: 0, stop: { file: "gone.md", code: "ENOENT" } });
    expect(first.interrupted).toBeUndefined();
  });

  it("fits collision variants within NAME_MAX for near-limit basenames", async () => {
    const outside = await createTestScratch("dohc-import-");
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
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "notes.md"), "third");
    await writeFile(join(root, "notes.md"), "first");
    await writeFile(join(root, "notes (2).md"), "second");
    const outcome = await copyIntoWorkspace(root, [join(outside, "notes.md")]);
    expect(outcome.imported).toEqual(["notes (3).md"]);
    expect(await readFile(join(root, "notes (3).md"), "utf8")).toBe("third");
  });

  it("imports into a target folder when one is given", async () => {
    const outside = await createTestScratch("dohc-import-");
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
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    await expect(
      copyIntoWorkspace(root, [join(outside, "receipt.png")], "../elsewhere"),
    ).rejects.toThrow(/Invalid import destination/);
  });

  it("refuses a reserved target folder (shared-with-me)", async () => {
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    await mkdir(join(root, SHARED_WITH_ME_FOLDER), { recursive: true });
    await expect(
      copyIntoWorkspace(root, [join(outside, "receipt.png")], SHARED_WITH_ME_FOLDER),
    ).rejects.toThrow(/Invalid import destination/);
  });

  it("refuses a target folder that does not exist (imports never mkdir)", async () => {
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    await expect(
      copyIntoWorkspace(root, [join(outside, "receipt.png")], "missing"),
    ).rejects.toThrow(/not a workspace folder/);
  });

  it("refuses a symlinked ANCESTOR in the target folder", async () => {
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    // link -> shared-with-me resolves inside the workspace, so realpath
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
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    const outcome = await copyIntoWorkspace(root, [join(outside, "receipt.png")], "");
    expect(outcome).toEqual({ imported: ["receipt.png"], skipped: 0 });
  });

  it("refuses a symlinked target folder (must not teleport the import)", async () => {
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    const elsewhere = await createTestScratch("dohc-elsewhere-");
    await symlink(elsewhere, join(root, "linked"), "dir");
    await expect(
      copyIntoWorkspace(root, [join(outside, "receipt.png")], "linked"),
    ).rejects.toThrow(/not a workspace folder/);
    expect(existsSync(join(elsewhere, "receipt.png"))).toBe(false);
  });
});

describe("importDroppedPaths", () => {
  it("imports regular files and folders, and skips symlinks and relative paths", async () => {
    const outside = await createTestScratch("dohc-drop-");
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
    // The symlink (refused before it follows to target.md) and the relative
    // path are skipped, and the outcome says which and why instead of the
    // batch silently shrinking. The empty folder lands, and the outcome
    // names it.
    expect(outcome).toEqual({
      imported: ["doc.md"],
      skipped: 2,
      skippedSources: [{ path: "alias.md", reason: "link" }, { path: "relative.md", reason: "unreadable" }],
      folders: ["folder"],
    });
    expect((await stat(join(root, "folder"))).isDirectory()).toBe(true);
    expect(existsSync(join(root, "target.md"))).toBe(false);
  });

  // Finder drags a folder, or a bundle document such as .rtfd, as one item.
  it("copies a dropped folder whole, leaving OS files behind and skipping links", async () => {
    const outside = await createTestScratch("dohc-drop-");
    const secrets = await createTestScratch("dohc-secrets-");
    await writeFile(join(secrets, "id_rsa"), "PRIVATE KEY");
    const trip = join(outside, "Trip");
    await mkdir(join(trip, "photos"), { recursive: true });
    await mkdir(join(trip, "empty"), { recursive: true });
    await mkdir(join(trip, "Report.rtfd"), { recursive: true });
    await mkdir(join(trip, ".git"), { recursive: true });
    await writeFile(join(trip, "plan.md"), "# Plan");
    await writeFile(join(trip, "photos", "beach.jpg"), "jpg-bytes");
    await writeFile(join(trip, "photos", ".DS_Store"), "finder");
    await writeFile(join(trip, "Report.rtfd", "TXT.rtf"), "{\\rtf1}");
    await writeFile(join(trip, ".git", "config"), "[core]");
    await symlink(join(secrets, "id_rsa"), join(trip, "key.txt"), "file");
    await symlink(secrets, join(trip, "linked"), "dir");

    const outcome = await importDroppedPaths(root, [trip], [root]);
    // Two links skipped; .DS_Store and .git are not workspace files at all.
    // The walk reads each folder in the order the disk lists it.
    const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
    expect({
      ...outcome,
      imported: outcome.imported.sort(),
      skippedSources: outcome.skippedSources?.sort(byPath),
    }).toEqual({
      imported: ["Trip/Report.rtfd/TXT.rtf", "Trip/photos/beach.jpg", "Trip/plan.md"],
      skipped: 2,
      skippedSources: [{ path: "Trip/key.txt", reason: "link" }, { path: "Trip/linked", reason: "link" }],
      folders: ["Trip"],
    });
    expect(await readFile(join(root, "Trip", "photos", "beach.jpg"), "utf8")).toBe("jpg-bytes");
    expect((await readdir(join(root, "Trip"))).sort()).toEqual(["Report.rtfd", "empty", "photos", "plan.md"]);
    expect(await readdir(join(root, "Trip", "photos"))).toEqual(["beach.jpg"]);
  });

  // Inside a folder these are left behind without a word. Dropped on their
  // own, the person handed them over, so each is named with its reason.
  it("names each item a drop leaves out on its own, and why", async () => {
    const outside = await createTestScratch("dohc-drop-");
    await writeFile(join(outside, "ok.md"), "ok");
    await writeFile(join(outside, ".DS_Store"), "finder");
    await mkdir(join(outside, "node_modules"));
    await mkdir(join(outside, ".dohc"));

    const dropped = ["ok.md", ".DS_Store", "node_modules", ".dohc"].map((name) => join(outside, name));
    expect(await importDroppedPaths(root, dropped, [root])).toEqual({
      imported: ["ok.md"],
      skipped: 3,
      skippedSources: [
        { path: ".DS_Store", reason: "system-file" },
        { path: "node_modules", reason: "left-out" },
        { path: ".dohc", reason: "dohc-name" },
      ],
    });
  });

  // The validator reads these as .git, .dohc and .DS_Store, but the file is
  // named with the encoded spelling, so renaming it is the fix.
  it("says an encoded spelling of a reserved name can't be saved", () => {
    expect(nameSkip("cfg%2f.git")).toBe("name");
    expect(nameSkip("%2edohc")).toBe("name");
    expect(nameSkip("Trip/%2eDS_Store")).toBe("name");
    expect(nameSkip("Trip/.git")).toBe("left-out");
  });

  it.runIf(process.platform === "win32")("says which names Windows can't use", () => {
    expect(nameSkip("Trip/CON.md")).toBe("windows-name");
    expect(nameSkip("Trip/a:b.md")).toBe("windows-name");
    expect(nameSkip("Trip/plan.md")).toBeNull();
  });

  it("lists the first 100 skips and counts them all", () => {
    const skips = new ImportSkips();
    for (let i = 0; i < 101; i += 1) skips.add(`f-${i}.md`, "link");
    const outcome = skips.outcome();
    expect(outcome.skipped).toBe(101);
    expect(outcome.skippedSources).toHaveLength(100);
    expect(outcome.skippedSources?.at(-1)).toEqual({ path: "f-99.md", reason: "link" });
  });

  it("lands a dropped folder beside one with its name, as a file would", async () => {
    const outside = await createTestScratch("dohc-drop-");
    await mkdir(join(outside, "Trip"), { recursive: true });
    await writeFile(join(outside, "Trip", "plan.md"), "incoming");
    await mkdir(join(outside, "Report.rtfd"), { recursive: true });
    await writeFile(join(outside, "Report.rtfd", "TXT.rtf"), "incoming");
    await mkdir(join(root, "inbox", "Trip"), { recursive: true });
    await writeFile(join(root, "inbox", "Trip", "plan.md"), "existing");
    await mkdir(join(root, "inbox", "Report.rtfd"), { recursive: true });

    const outcome = await importDroppedPaths(
      root,
      [join(outside, "Trip"), join(outside, "Report.rtfd")],
      [root],
      "inbox",
    );
    expect(outcome).toEqual({
      imported: ["inbox/Trip (2)/plan.md", "inbox/Report (2).rtfd/TXT.rtf"],
      skipped: 0,
      folders: ["inbox/Trip (2)", "inbox/Report (2).rtfd"],
    });
    expect(await readFile(join(root, "inbox", "Trip", "plan.md"), "utf8")).toBe("existing");
    expect(await readFile(join(root, "inbox", "Trip (2)", "plan.md"), "utf8")).toBe("incoming");
  });

  // The screen checks each entry and its folder again, about 16 ms an entry on the shared
  // Windows host, and this test screens about 2,000. That takes 20 to 30 s on a quiet host.
  it("takes 1,000 files and folders from a drop with folders, and refuses the whole drop past that", async () => {
    const outside = await createTestScratch("dohc-many-");
    const fits = join(outside, "fits");
    await mkdir(join(fits, "inner"), { recursive: true });
    // The two folders and 998 files make 1,000.
    await Promise.all(Array.from({ length: 998 }, (_, i) => writeFile(join(fits, "inner", `f-${i}.md`), "x")));
    const landed = await importDroppedPaths(root, [fits], [root]);
    expect([landed.imported.length, landed.folders]).toEqual([998, ["fits"]]);

    const over = join(outside, "over");
    await mkdir(over, { recursive: true });
    await writeFile(join(outside, "loose.md"), "x");
    await Promise.all(Array.from({ length: 999 }, (_, i) => writeFile(join(over, `f-${i}.md`), "x")));
    // A file, the folder, and its 999 files make 1,001: nothing lands.
    await expect(importDroppedPaths(root, [join(outside, "loose.md"), over], [root]))
      .rejects.toThrow("dohc imports up to 1,000 files and folders from one drop. Drop fewer folders at a time.");
    expect(await readdir(root)).toEqual(["fits"]);
  }, 120_000);

  it("refuses a symlink pointing at a secret outside the workspace (exfil vector)", async () => {
    // A compromised renderer forging droppedPaths could plant a symlink to a
    // secret and rely on realpath-then-isFile to copy the SECRET's bytes into
    // the (possibly cloud-synced) workspace. lstat-ing the original source
    // refuses the link before it ever resolves to the target.
    const secrets = await createTestScratch("dohc-secrets-");
    await writeFile(join(secrets, "id_rsa"), "PRIVATE KEY");
    const stage = await createTestScratch("dohc-stage-");
    await symlink(join(secrets, "id_rsa"), join(stage, "innocent.txt"), "file");
    const outcome = await importDroppedPaths(root, [join(stage, "innocent.txt")], [root]);
    expect(outcome).toEqual({ imported: [], skipped: 1, skippedSources: [{ path: "innocent.txt", reason: "link" }] });
    expect(existsSync(join(root, "innocent.txt"))).toBe(false);
    // Nothing landed in the workspace — the secret never left its directory.
    expect(await readdir(root)).toEqual([]);
  });

  it("caps the dropped-path count at the handler, not just the schema", async () => {
    const outside = await createTestScratch("dohc-many-");
    const paths = await Promise.all(
      Array.from({ length: 101 }, async (_, i) => {
        const p = join(outside, `f-${i}.md`);
        await writeFile(p, "x");
        return p;
      }),
    );
    await expect(importDroppedPaths(root, paths, [root]))
      .rejects.toThrow("dohc imports up to 100 dropped items at once. Drop fewer at a time.");
  });

  // The validator decodes %2f and reads \ as a separator, so these names
  // would land as cfg/evil, through the link cfg, outside the workspace.
  it("refuses a name the destination would rewrite, which would land through a link", async () => {
    const outside = await createTestScratch("dohc-drop-");
    const elsewhere = await createTestScratch("dohc-elsewhere-");
    await symlink(elsewhere, join(root, "cfg"), "dir");
    const encodedFile = join(outside, "cfg%2fevil");
    await writeFile(encodedFile, "file");
    const encodedFolder = join(outside, "cfg%2Fdeep");
    await mkdir(encodedFolder);
    await writeFile(join(encodedFolder, "a.md"), "folder");
    const trip = join(outside, "Trip");
    await mkdir(trip);
    await writeFile(join(trip, "x%2fy.md"), "nested");
    await writeFile(join(trip, "ok.md"), "ok");
    const dropped = [encodedFile, encodedFolder, trip];
    if (process.platform !== "win32") {
      const backslashed = join(outside, "cfg\\evil2");
      await mkdir(backslashed);
      await writeFile(join(backslashed, "a.md"), "backslash");
      dropped.push(backslashed);
    }

    const outcome = await importDroppedPaths(root, dropped, [root]);
    expect(outcome).toEqual({
      imported: ["Trip/ok.md"],
      skipped: dropped.length,
      skippedSources: expect.arrayContaining([
        { path: "cfg%2fevil", reason: "name" },
        { path: "cfg%2Fdeep", reason: "name" },
        { path: "Trip/x%2fy.md", reason: "name" },
      ]),
      folders: ["Trip"],
    });
    expect(await readdir(elsewhere)).toEqual([]);
    // The file dialog's path takes the same check.
    expect(await copyIntoWorkspace(root, [encodedFile]))
      .toEqual({ imported: [], skipped: 1, skippedSources: [{ path: "cfg%2fevil", reason: "name" }] });
    expect(await readdir(elsewhere)).toEqual([]);
  });

  // A nested name is checked where it lands: only the workspace root reserves
  // shared-with-me.
  it("checks each name where it lands, so only the root reserves shared-with-me", async () => {
    const outside = await createTestScratch("dohc-drop-");
    await mkdir(join(outside, "Trip", SHARED_WITH_ME_FOLDER), { recursive: true });
    await writeFile(join(outside, "Trip", SHARED_WITH_ME_FOLDER, "notes.md"), "notes");
    await mkdir(join(outside, SHARED_WITH_ME_FOLDER));
    await writeFile(join(outside, SHARED_WITH_ME_FOLDER, "plan.md"), "plan");
    await mkdir(join(root, "docs"));

    expect(await importDroppedPaths(root, [join(outside, "Trip"), join(outside, SHARED_WITH_ME_FOLDER)], [root]))
      .toEqual({
        imported: [`Trip/${SHARED_WITH_ME_FOLDER}/notes.md`],
        skipped: 1,
        skippedSources: [{ path: SHARED_WITH_ME_FOLDER, reason: "dohc-name" }],
        folders: ["Trip"],
      });
    expect(await importDroppedPaths(root, [join(outside, SHARED_WITH_ME_FOLDER)], [root], "docs"))
      .toEqual({ imported: [`docs/${SHARED_WITH_ME_FOLDER}/plan.md`], skipped: 0, folders: [`docs/${SHARED_WITH_ME_FOLDER}`] });
  });

  // Another process that can write the dropped folder, but not read the
  // secret, swaps what the screen saw for a link before the copy.
  it.each(["file", "folder"] as const)("never copies a %s swapped for a link after the screen", async (swapped) => {
    const outside = await createTestScratch("dohc-drop-");
    const secrets = await createTestScratch("dohc-secrets-");
    await writeFile(join(secrets, "a.md"), "SECRET");
    const trip = join(outside, "Trip");
    await mkdir(join(trip, "notes"), { recursive: true });
    await writeFile(join(trip, "notes", "a.md"), "notes");

    const screened = await screenDroppedPaths([trip], [root], "");
    if (swapped === "file") {
      await rm(join(trip, "notes", "a.md"));
      await symlink(join(secrets, "a.md"), join(trip, "notes", "a.md"), "file");
    } else {
      await rm(join(trip, "notes"), { recursive: true });
      await symlink(secrets, join(trip, "notes"), "dir");
    }
    const outcome = await copyIntoWorkspace(root, screened.usable);
    expect(outcome.imported).toEqual([]);
    expect(outcome.stop).toMatchObject({
      file: swapped === "file" ? "Trip/notes/a.md" : "Trip/notes",
      refusal: "changed",
    });
    expect(existsSync(join(root, "Trip", "notes", "a.md"))).toBe(false);
  });

  // Folders that landed are progress: the same drop again would land as
  // Trip (2), so the result says the import stopped partway.
  it("never copies a dropped file swapped for a link after the screen", async () => {
    const outside = await createTestScratch("dohc-drop-");
    const secrets = await createTestScratch("dohc-secrets-");
    await writeFile(join(secrets, "id_rsa"), "SECRET");
    await writeFile(join(outside, "notes.md"), "notes");

    const screened = await screenDroppedPaths([join(outside, "notes.md")], [root], "");
    await rm(join(outside, "notes.md"));
    await symlink(join(secrets, "id_rsa"), join(outside, "notes.md"), "file");
    expect(await copyIntoWorkspace(root, screened.usable)).toMatchObject({
      imported: [],
      stop: { file: "notes.md", refusal: "changed" },
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("reports folders that landed before a stop as an interrupted import", async () => {
    const outside = await createTestScratch("dohc-drop-");
    const trip = join(outside, "Trip");
    await mkdir(join(trip, "sub"), { recursive: true });
    await writeFile(join(trip, "sub", "a.md"), "a");
    const screened = await screenDroppedPaths([trip], [root], "");
    // Written beside it first, so the replacement can't reuse a.md's inode.
    await writeFile(join(trip, "sub", "a.md.new"), "replaced");
    await rename(join(trip, "sub", "a.md.new"), join(trip, "sub", "a.md"));

    expect(await copyIntoWorkspace(root, screened.usable)).toMatchObject({
      imported: [],
      interrupted: true,
      folders: ["Trip"],
      stop: { file: "Trip/sub/a.md", refusal: "changed" },
    });
  });

  it("refuses a drop whose folders hold more than 10,000 entries it leaves out", async () => {
    const outside = await createTestScratch("dohc-many-");
    const trip = join(outside, "Trip");
    await mkdir(trip);
    await writeFile(join(trip, "plan.md"), "plan");
    // In batches: 10,000 files open at once run out of handles on Windows.
    for (let start = 0; start < 10_000; start += 500) {
      await Promise.all(Array.from({ length: 500 }, (_, i) => writeFile(join(trip, `._${start + i}`), "")));
    }
    expect((await importDroppedPaths(root, [trip], [root])).imported).toEqual(["Trip/plan.md"]);

    await writeFile(join(trip, "._10000"), "");
    await expect(importDroppedPaths(root, [trip], [root], "Trip")).rejects.toThrow(
      "dohc reads up to 10,000 files it leaves out, such as .DS_Store, in one drop. Drop fewer folders at a time.",
    );
    expect(await readdir(join(root, "Trip"))).toEqual(["plan.md"]);
  });

  // A folder swapped for a link while the screen reads it, and put back
  // before the copy, would have the screen record the link target's files.
  it("refuses an entry seen through a folder swapped for a link during the screen", async () => {
    const outside = await createTestScratch("dohc-drop-");
    const secrets = await createTestScratch("dohc-secrets-");
    await writeFile(join(secrets, "a.md"), "SECRET");
    const trip = join(outside, "Trip");
    await mkdir(join(trip, "sub"), { recursive: true });
    await writeFile(join(trip, "sub", "a.md"), "a");
    fsHooks.beforeLstat = once(join(trip, "sub", "a.md"), async () => {
      await rename(join(trip, "sub"), join(outside, "real-sub"));
      await symlink(secrets, join(trip, "sub"), "dir");
    });

    await expect(screenDroppedPaths([trip], [root], "")).rejects.toThrow("sub changed after dohc checked it.");
  });

  // The forged identity stands for a screen that recorded the link target's
  // file. The folder check after the open still refuses the read.
  it("checks the file's folder again after opening it", async () => {
    const outside = await createTestScratch("dohc-drop-");
    const secrets = await createTestScratch("dohc-secrets-");
    await writeFile(join(secrets, "a.md"), "SECRET");
    const trip = join(outside, "Trip");
    await mkdir(join(trip, "sub"), { recursive: true });
    await writeFile(join(trip, "sub", "a.md"), "a");
    const [screened] = (await screenDroppedPaths([trip], [root], "")).usable;
    const secret = await lstat(join(secrets, "a.md"), { bigint: true });
    const entry = screened!.entries!.find((candidate) => candidate.path === "sub/a.md")!;
    entry.identity = { dev: secret.dev, ino: secret.ino };
    fsHooks.beforeOpen = once(join(trip, "sub", "a.md"), async () => {
      await rename(join(trip, "sub"), join(outside, "real-sub"));
      await symlink(secrets, join(trip, "sub"), "dir");
    });

    expect(await copyIntoWorkspace(root, [screened!])).toMatchObject({
      imported: [],
      stop: { file: "Trip/sub/a.md", refusal: "changed" },
    });
    expect(existsSync(join(root, "Trip", "sub", "a.md"))).toBe(false);
  });

  // A process that can write the workspace, such as an agent, swaps a folder
  // the import just made for a link out of the workspace.
  it("never creates through a destination folder swapped for a link", async () => {
    const outside = await createTestScratch("dohc-drop-");
    const elsewhere = await createTestScratch("dohc-elsewhere-");
    const trip = join(outside, "Trip");
    await mkdir(join(trip, "sub"), { recursive: true });
    await writeFile(join(trip, "sub", "a.md"), "a");
    fsHooks.afterMkdir = once(join(root, "Trip", "sub"), async () => {
      await rm(join(root, "Trip", "sub"), { recursive: true });
      await symlink(elsewhere, join(root, "Trip", "sub"), "dir");
    });

    expect(await importDroppedPaths(root, [trip], [root])).toMatchObject({
      imported: [],
      interrupted: true,
      stop: { file: "Trip/sub/a.md", refusal: "changed" },
    });
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("removes a file whose copy failed, and reports the failure", async () => {
    const outside = await createTestScratch("dohc-drop-");
    const trip = join(outside, "Trip");
    await mkdir(trip);
    await writeFile(join(trip, "a.md"), "a".repeat(64));
    const target = join(root, "Trip", "a.md");
    fsHooks.opened = (path, handle) => path !== target ? handle : new Proxy(handle, {
      get(real, property) {
        if (property === "write") {
          return async () => {
            throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
          };
        }
        const value: unknown = Reflect.get(real, property, real);
        return typeof value === "function" ? value.bind(real) : value;
      },
    });

    expect(await importDroppedPaths(root, [trip], [root])).toMatchObject({
      imported: [],
      interrupted: true,
      stop: { file: "Trip/a.md", code: "EIO", detail: "EIO: i/o error, write" },
    });
    expect(await readdir(join(root, "Trip"))).toEqual([]);
  });

  // Another user owns /Users/Shared/evil and swaps proj for a link to this
  // user's home while the drop of evil/proj/Documents is screened. Making a
  // link another uid owns takes root, so the test reports that owner for the
  // link it made.
  it.skipIf(process.platform === "win32")("refuses a drop reached through a link another user owns", async () => {
    const outside = await createTestScratch("dohc-drop-");
    const home = await createTestScratch("dohc-home-");
    await mkdir(join(home, "Documents"));
    await writeFile(join(home, "Documents", "tax.md"), "SECRET");
    await mkdir(join(outside, "evil"));
    const link = join(outside, "evil", "proj");
    await symlink(home, link, "dir");
    fsHooks.lstatResult = (path, stats) => {
      if (path === link) stats.uid = process.getuid!() + 1;
    };

    await expect(importDroppedPaths(root, [join(link, "Documents")], [root])).rejects.toThrow(
      "dohc did not import Documents, because a link another user owns leads to it. Drop it from a folder you own.",
    );
    expect(await readdir(root)).toEqual([]);
    // The same link is this user's own choice when this user owns it.
    delete fsHooks.lstatResult;
    expect((await importDroppedPaths(root, [join(link, "Documents")], [root])).imported).toEqual(["Documents/tax.md"]);
  });

  // HFS+ stores names decomposed, so the folder made for Café reads back as
  // Cafe plus a combining accent, and its files must still land.
  it.skipIf(process.platform !== "darwin")("imports a folder with a composed name onto an HFS+ volume", async () => {
    const scratch = await createTestScratch("dohc-hfs-");
    const image = join(scratch, "hfs.dmg");
    const mount = join(scratch, "mnt");
    await mkdir(mount);
    try {
      execFileSync("hdiutil", ["create", "-quiet", "-size", "20m", "-fs", "HFS+", "-volname", "DOHCHFS", image]);
      execFileSync("hdiutil", ["attach", "-quiet", "-nobrowse", "-mountpoint", mount, image]);
    } catch {
      console.warn("SKIP: hdiutil could not attach an HFS+ image here");
      return;
    }
    try {
      const workspace = join(mount, "ws");
      await mkdir(workspace);
      const outside = await createTestScratch("dohc-drop-");
      const cafe = join(outside, "Caf\u00e9");
      await mkdir(join(cafe, "Cr\u00e8me"), { recursive: true });
      await writeFile(join(cafe, "a.md"), "a");
      await writeFile(join(cafe, "Cr\u00e8me", "b.md"), "b");

      const outcome = await importDroppedPaths(workspace, [cafe], [workspace]);
      expect({ ...outcome, imported: outcome.imported.sort() }).toEqual({
        imported: ["Caf\u00e9/Cr\u00e8me/b.md", "Caf\u00e9/a.md"],
        skipped: 0,
        folders: ["Caf\u00e9"],
      });
      expect(await readFile(join(workspace, "Caf\u00e9", "Cr\u00e8me", "b.md"), "utf8")).toBe("b");
    } finally {
      execFileSync("hdiutil", ["detach", "-quiet", "-force", mount]);
    }
  });

  it("refuses sources inside any registered workspace's .dohc", async () => {
    const otherRoot = await createTestScratch("dohc-other-");
    await mkdir(join(otherRoot, ".dohc"), { recursive: true });
    await writeFile(join(otherRoot, ".dohc", "credentials.json"), "secret");
    const outcome = await importDroppedPaths(
      root,
      [join(otherRoot, ".dohc", "credentials.json")],
      [root, otherRoot],
    );
    expect(outcome).toEqual({
      imported: [],
      skipped: 1,
      skippedSources: [{ path: "credentials.json", reason: "workspace-data" }],
    });
    expect(existsSync(join(root, "credentials.json"))).toBe(false);
  });

  it("still refuses a .dohc source reached through a symlinked ANCESTOR (canonical containment)", async () => {
    // The accepted ancestor-symlink residual (a real leaf under a symlinked dir
    // imports) must not defeat the one location gate we DO enforce: the.dohc
    // refusal runs on realpath(source), so an ancestor alias to another
    // workspace's metadata is still canonicalized and refused.
    const otherRoot = await createTestScratch("dohc-other-");
    await mkdir(join(otherRoot, ".dohc"), { recursive: true });
    await writeFile(join(otherRoot, ".dohc", "credentials.json"), "secret");
    const stage = await createTestScratch("dohc-stage-");
    await symlink(join(otherRoot, ".dohc"), join(stage, "alias"), "dir");
    const outcome = await importDroppedPaths(
      root,
      [join(stage, "alias", "credentials.json")],
      [root, otherRoot],
    );
    expect(outcome).toEqual({
      imported: [],
      skipped: 1,
      skippedSources: [{ path: "credentials.json", reason: "workspace-data" }],
    });
    expect(existsSync(join(root, "credentials.json"))).toBe(false);
  });

  it("drops into the target folder the user aimed at", async () => {
    const outside = await createTestScratch("dohc-drop-");
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

// The trash ladder is several renames, and it re-checks the source between
// them. This is the decision it makes, separated from the I/O because an
// EACCES on that second look is not arrangeable here -- and it is the case
// that carried the defect: a check that failed was reported as a change.
describe("trash ladder stop classification", () => {
  const entry = { ino: 7n, dev: 3n };

  it("carries on only when the entry is provably the same", () => {
    expect(classifyLadderProbe(entry, { looked: true, now: { ino: 7n, dev: 3n } })).toBeNull();
  });

  it("stops on a replacement", () => {
    expect(classifyLadderProbe(entry, { looked: true, now: { ino: 8n, dev: 3n } })).toBe(
      "replaced",
    );
    expect(classifyLadderProbe(entry, { looked: true, now: { ino: 7n, dev: 4n } })).toBe(
      "replaced",
    );
  });

  it("reports a path that is gone as gone, not as a replacement", () => {
    expect(classifyLadderProbe(entry, { looked: false, code: "ENOENT" })).toBe("gone");
  });

  // The finding: EACCES, EIO and friends establish nothing about the path.
  // They establish that dohc could not look, which is a different sentence.
  it("says it could not check when the look itself failed", () => {
    for (const code of ["EACCES", "EIO", "EPERM", undefined]) {
      expect(classifyLadderProbe(entry, { looked: false, code }), code).toBe("unchecked");
    }
  });

  it("says it could not check when there was no starting identity", () => {
    expect(classifyLadderProbe(null, { looked: true, now: entry })).toBe("unchecked");
  });

  // A filesystem with no inode to give proves neither sameness nor difference.
  it("says it could not check when the filesystem gives no inode", () => {
    expect(classifyLadderProbe({ ino: 0n, dev: 3n }, { looked: true, now: entry })).toBe(
      "unchecked",
    );
  });
});

// A copy that fails has to say which thing failed: the name being too long for
// this filesystem, or the source not being there. Both answer ENOENT on
// Windows, and a missing source answers ENOENT everywhere -- so reading the
// second as the first silently skips a source that should abort the batch.
describe("copy length-refusal classification", () => {
  // What entryCharBudget answers for a Windows folder, and for every other
  // platform, respectively.
  const WINDOWS_BUDGET = 68;
  const NO_LIMIT = Number.POSITIVE_INFINITY;

  it("takes ENAMETOOLONG at its word on any platform", () => {
    expect(couldBeLengthRefusal("ENAMETOOLONG", "short.md", NO_LIMIT)).toBe(true);
    expect(couldBeLengthRefusal("ENAMETOOLONG", "short.md", WINDOWS_BUDGET)).toBe(true);
  });

  it("reads ENOENT as length only when this name exceeds the budget", () => {
    expect(couldBeLengthRefusal("ENOENT", "n".repeat(WINDOWS_BUDGET + 1), WINDOWS_BUDGET)).toBe(
      true,
    );
    expect(couldBeLengthRefusal("ENOENT", "n".repeat(WINDOWS_BUDGET), WINDOWS_BUDGET)).toBe(
      false,
    );
  });

  // The finding. Off Windows the budget is Infinity, so a 259-plus-character
  // path is ordinary and an ENOENT can only mean the source is gone.
  it("never reads ENOENT as length where no composed limit applies", () => {
    expect(couldBeLengthRefusal("ENOENT", "n".repeat(300), NO_LIMIT)).toBe(false);
    expect(couldBeLengthRefusal("ENOENT", "n".repeat(5000), NO_LIMIT)).toBe(false);
  });

  it("leaves every other failure to abort the batch", () => {
    for (const code of ["EACCES", "EPERM", "EIO", "EXDEV", undefined]) {
      expect(couldBeLengthRefusal(code, "n".repeat(5000), WINDOWS_BUDGET), code).toBe(false);
    }
  });
});

// Before the copy loop may call a link dangling, something has to establish
// that the target is ABSENT. A probe that failed establishes nothing --
// separated from the I/O because an EACCES or an EIO stat is not arrangeable
// here, and it is the case that carries the defect: a link to an unreachable
// network path would be reported to the user as a link to a missing file.
describe("copy end-probe classification", () => {
  it("reads a stat that answered as the end being there", () => {
    expect(classifyEndProbe({ looked: true })).toBe("there");
  });

  it("takes only ENOENT and ENOTDIR as absence", () => {
    expect(classifyEndProbe({ looked: false, code: "ENOENT" })).toBe("absent");
    expect(classifyEndProbe({ looked: false, code: "ENOTDIR" })).toBe("absent");
  });

  // The finding. The same distinction the trash ladder draws above.
  it("says it could not check when the probe itself failed", () => {
    for (const code of ["EACCES", "EIO", "EPERM", "ELOOP", "ETIMEDOUT", undefined]) {
      expect(classifyEndProbe({ looked: false, code }), code).toBe("unknown");
    }
  });
});

// Arithmetic says an over-budget name could be refused for length; it cannot
// say it WAS. On a long-path-aware host the budget is not the real limit -- a
// 300-character path works -- so an ENOENT there means something vanished.
// Predicting from the budget silently counted that as `skipped`, and nobody
// reads a skipped line.
describe("import surfaces a vanished source instead of skipping it", () => {
  it("stops at a vanished source rather than skipping it in a deep folder", async () => {
    const base = await mkdtemp(join(tmpdir(), "dohc-vanished-"));
    try {
      const root = join(
        base,
        ...Array.from({ length: 8 }, (_, index) => `nested-folder-${index}`),
      );
      await mkdir(root, { recursive: true });
      // Over the legacy budget for this folder, which is what used to make an
      // ENOENT read as "too long" rather than "not there".
      const name = `${"n".repeat(120)}.md`;
      expect(name.length).toBeGreaterThan(259 - root.length - 1);
      const missing = join(base, name); // validated by the dialog, then gone

      expect(await copyIntoWorkspace(root, [missing])).toMatchObject({
        imported: [],
        skipped: 0,
        stop: { code: "ENOENT" },
      });
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(
        () => undefined,
      );
    }
  });

  // The narrowest instance of the same defect: the check and the copy
  // disagreed about what "exists" means. `copyFile` Follows the source link and
  // answered ENOENT for a link whose target is gone; the guard asked `lstat`,
  // which answers about the LINK, said the source was still there, and let the
  // ladder shorten the name until the source counted as skipped.
  //
  // Mutation: ask `lstat` for the source again and this test fails with a bare
  // ENOENT that names a path the user can plainly see. No deep folder is
  // needed for it: every ENOENT is probed before the length arithmetic, so the
  // over-budget case is the length ladder's own test, not this one.
  it("names a dangling symbolic link instead of skipping it", async () => {
    const base = await mkdtemp(join(tmpdir(), "dohc-dangling-"));
    try {
      const root = join(base, "ws");
      await mkdir(root, { recursive: true });
      const source = join(base, "link.md");
      await symlink(join(base, "never-existed.md"), source, "file");
      // The link itself is right there -- that is why lstat got it wrong.
      expect((await lstat(source)).isSymbolicLink()).toBe(true);

      // The reason and the instruction come before the name: this renders in a
      // one-line truncate span, and a basename runs to 255 characters, so
      // leading with it truncates away everything the user needs.
      expect(await copyIntoWorkspace(root, [source])).toEqual({
        imported: [],
        skipped: 0,
        stop: {
          file: "link.md",
          refusal: "dangling-link",
          detail: "The symbolic link link.md points to a missing file.",
        },
      });
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(
        () => undefined,
      );
    }
  });

  // A link whose target IS there is an ordinary source: the dialog path
  // deliberately follows it, so it still imports and still gets shortened.
  it("still imports through a symbolic link whose target exists", async () => {
    const base = await mkdtemp(join(tmpdir(), "dohc-livelink-"));
    try {
      const root = join(base, "ws");
      await mkdir(root, { recursive: true });
      const name = `${"n".repeat(120)}.md`;
      const target = join(base, "target.md");
      await writeFile(target, "keep me");
      const source = join(base, name);
      await symlink(target, source, "file");
      // A collision forces the variant path, where the ladder lives.
      await writeFile(join(root, name), "already here");

      const outcome = await copyIntoWorkspace(root, [source]);
      expect(outcome.skipped).toBe(0);
      expect(outcome.imported).toHaveLength(1);
      // What landed is the TARGET's bytes, under a collision variant, and the
      // file that was already there is untouched. The outcome shape alone would
      // still pass if the copy had overwritten it.
      const landed = outcome.imported[0];
      expect(landed).not.toBe(name);
      expect(await readFile(join(root, landed), "utf8")).toBe("keep me");
      expect(await readFile(join(root, name), "utf8")).toBe("already here");
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(
        () => undefined,
      );
    }
  });

  // The converse still holds: a source that IS there, with a name this path
  // cannot hold, is still shortened rather than failing the batch.
  it("still shortens a real name that the path cannot hold", async () => {
    const base = await mkdtemp(join(tmpdir(), "dohc-longname-"));
    try {
      const root = join(base, "ws");
      await mkdir(root, { recursive: true });
      const name = `${"n".repeat(120)}.md`;
      const source = join(base, name);
      await writeFile(source, "keep me");
      // A collision forces the variant path, where the ladder lives.
      await writeFile(join(root, name), "already here");

      const outcome = await copyIntoWorkspace(root, [source]);
      expect(outcome.skipped).toBe(0);
      expect(outcome.imported).toHaveLength(1);
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(
        () => undefined,
      );
    }
  });
});

describe("containment of '..'-prefixed names", () => {
  it("creates a file under a directory whose NAME starts with '..'", async () => {
    const path = await createFile(root, "..cache/today.md", "cached text");
    expect(path, "..-segment: a bare '..-prefix' isInside refuses this real contained name.").toBe("..cache/today.md");
    expect(await readFile(join(root, "..cache", "today.md"), "utf8")).toBe("cached text");
  });
});


describe("empty folder rollback", () => {
  it("removes empty folders and preserves another writer's descendants", async () => {
    await mkdir(join(root, "empty"));
    await expect(removeEmptyWorkspaceFolder(root, "empty")).resolves.toBe(true);
    await mkdir(join(root, "occupied"));
    await writeFile(join(root, "occupied/agent.txt"), "agent work");
    await expect(removeEmptyWorkspaceFolder(root, "occupied")).resolves.toBe(false);
    expect(await readFile(join(root, "occupied/agent.txt"), "utf8")).toBe("agent work");
  });
  it("preserves files and refuses reserved paths, traversal, and escaping ancestors", async () => {
    await writeFile(join(root, "agent.txt"), "agent work");
    await expect(removeEmptyWorkspaceFolder(root, "agent.txt")).resolves.toBe(false);
    expect(await readFile(join(root, "agent.txt"), "utf8")).toBe("agent work");
    await expect(removeEmptyWorkspaceFolder(root, "../escape")).rejects.toThrow(/traversal/);
    await expect(removeEmptyWorkspaceFolder(root, ".dohc/empty")).rejects.toThrow(/reserved/);
    const outside = await createTestScratch("dohc-empty-outside-");
    await mkdir(join(outside, "keep"));
    await symlink(outside, join(root, "link"), "dir");
    await expect(removeEmptyWorkspaceFolder(root, "link/keep")).rejects.toThrow(/escapes the workspace/);
    expect(existsSync(join(outside, "keep"))).toBe(true);
  });
});
