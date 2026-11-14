import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { existsSync, type Stats } from "node:fs";
import { hasEngineIgnoredSegment } from "@dohc/workspace-core";
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
  screenPickedPaths,
} from "./workspaceFiles";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import { createTestScratch } from "./testTemp";
import { openedLocalState } from "../testing/preparedLocalState";
import { datalessCandidates, withICloudCheck } from "../testing/iCloudCheck";
import { WORKSPACE_TEXT_EDITOR_MAX_BYTES } from "./workspaceTextLimits";
import { deferred } from "../testing/deferred";

let root: string;

beforeEach(async () => {
  root = await createTestScratch("dohc-files-");
});

const fsHooks: {
  lstatResult?: (path: string, stats: Stats) => void;
  beforeOpen?: (path: string) => Promise<void>;
  opened?: (path: string, handle: FileHandle) => FileHandle;
  afterMkdir?: (path: string) => Promise<void>;
} = {};
afterEach(() => {
  delete fsHooks.lstatResult;
  delete fsHooks.beforeOpen;
  delete fsHooks.opened;
  delete fsHooks.afterMkdir;
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (async (
      path: Parameters<typeof actual.lstat>[0],
      options?: Parameters<typeof actual.lstat>[1],
    ) => {
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

describe("createFile", () => {
  it("creates nested files through validated paths", async () => {
    const path = await createFile(root, "notes/./today.md", "initial text");
    expect(path).toBe("notes/today.md");
    expect(await readFile(join(root, "notes/today.md"), "utf8")).toBe("initial text");
  });

  it("never overwrites an existing file", async () => {
    await writeFile(join(root, "keep.md"), "original");
    await createFile(root, "keep.md", "");
    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
  });

  it("rejects initial text above the editor byte limit before creating a file", async () => {
    const initialText = `\ud83d\udca1`.repeat(WORKSPACE_TEXT_EDITOR_MAX_BYTES / 4 + 1);
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
  it("keeps the final name empty until the complete bytes are linked there", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const halfWritten = deferred(),
      stopped = deferred();
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
    const open = async (path: string, flags: string, mode?: number) => {
      opened.push(path);
      return actual.open(path, flags, mode);
    };
    const link = async () => {
      throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
    };
    await expect(
      createDurableFile(root, "notes/kept.md", "complete recovery text", { open, link }),
    ).rejects.toThrow(
      "This drive can't save a recovery copy safely, so dohc saved nothing. Your kept edits stay on this computer.",
    );
    expect(opened.filter((path) => basename(path) === "kept.md")).toEqual([]);
    expect(await readdir(join(root, "notes"))).toEqual([]);
  });

  it("writes a new file of any size and never replaces an existing one", async () => {
    const text = "x".repeat(WORKSPACE_TEXT_EDITOR_MAX_BYTES + 1);
    expect(await createDurableFile(root, "notes/./large.md", text)).toBe("notes/large.md");
    expect(await readFile(join(root, "notes/large.md"), "utf8")).toBe(text);
    await writeFile(join(root, "keep.md"), "original");
    await expect(createDurableFile(root, "keep.md", "replacement")).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
    expect(
      (await readdir(root)).filter((name) => hasEngineIgnoredSegment(name, process.platform)),
    ).toEqual([]);
  });
});

describe("extractFrontmatterIcon", () => {
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
    await expect(createFolder(root, "missing/child", { exclusive: true })).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(existsSync(join(root, "missing"))).toBe(false);
    await expect(createFolder(root, "app", { exclusive: true })).resolves.toBe("app");
    await expect(createFolder(root, "app", { exclusive: true })).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("rejects traversal, absolute, and reserved paths", async () => {
    await expect(createFolder(root, "../escape")).rejects.toThrow(/traversal/);
    await expect(createFolder(root, "a/../../escape")).rejects.toThrow(/traversal/);
    await expect(createFolder(root, "%2e%2e%2fescape")).rejects.toThrow(/traversal/);
    await expect(createFolder(root, "/etc/pwned")).rejects.toThrow(/absolute/);
    await expect(createFolder(root, ".dohc/trap")).rejects.toThrow(/reserved/);
    await expect(createFolder(root, "notes/.dohc/trap")).rejects.toThrow(/reserved/);
  });
});

describe("movePath", () => {
  describe("stored move and delete names", () => {
    const platform = process.platform;
    let ignoresCase: boolean;
    beforeEach(async () => {
      ignoresCase = await caseInsensitiveFs();
      Object.defineProperty(process, "platform", { value: "linux" });
      const original = fsPromises.realpath.bind(fsPromises);
      vi.spyOn(fsPromises, "realpath").mockImplementation(async (path) => {
        const resolved = await original(path);
        return String(path).startsWith(`${root}${sep}`) ? String(path) : resolved;
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      Object.defineProperty(process, "platform", { value: platform });
    });

    it("keeps the stored parent for a case-only rename through an alias parent", async (context) => {
      await mkdir(join(root, "Docs"));
      await writeFile(join(root, "Docs", "notes.md"), "body");
      if (!ignoresCase) context.skip("this disk keeps case apart");
      expect(await prepareWorkspaceMove(root, "docs/notes.md", "docs/Notes.md")).toMatchObject({
        physicalFromPath: "Docs/notes.md",
        physicalToPath: "Docs/Notes.md",
        visibleResultPath: "docs/Notes.md",
      });
      await expect(movePath(root, "docs/notes.md", "docs/Notes.md")).resolves.toBe("docs/Notes.md");
      expect(await readdir(join(root, "Docs"))).toEqual(["Notes.md"]);
    });

    for (const destination of ["docs/a.md", "docs/b.md"]) {
      for (const native of [false, true]) {
        it(`refuses a parent case change to ${destination} with ${native ? "native" : "Linux"} realpath`, async (context) => {
          await mkdir(join(root, "Docs"));
          await writeFile(join(root, "Docs", "a.md"), "body");
          if (!ignoresCase) context.skip("this disk keeps case apart");
          if (native) {
            vi.restoreAllMocks();
            Object.defineProperty(process, "platform", { value: platform });
          }
          const mutation = vi.spyOn(fsPromises, "rename");
          const message = `dohc did not move Docs/a.md to ${destination}. The folder is named Docs, not docs. Use that name, or rename the folder first.`;
          await expect(prepareWorkspaceMove(root, "Docs/a.md", destination)).rejects.toThrow(
            message,
          );
          await expect(movePath(root, "Docs/a.md", destination)).rejects.toThrow(message);
          expect(mutation).not.toHaveBeenCalled();
        });
      }
    }

    it("refuses an unknown parent identity before making a local move", async (context) => {
      await mkdir(join(root, "Docs"));
      await writeFile(join(root, "Docs", "a.md"), "body");
      if (!ignoresCase) context.skip("this disk keeps case apart");
      vi.spyOn(fsPromises, "readdir").mockRejectedValue(
        Object.assign(new Error("unreadable"), { code: "EIO" }),
      );
      const mutation = vi.spyOn(fsPromises, "rename");
      await expect(movePath(root, "Docs/a.md", "docs/b.md")).rejects.toThrow(
        "dohc could not tell which files or folders on disk",
      );
      expect(mutation).not.toHaveBeenCalled();
    });

    it("allows a new distinct parent when this disk keeps case apart", async (context) => {
      if (ignoresCase) context.skip("this disk ignores case");
      await mkdir(join(root, "Docs"));
      await writeFile(join(root, "Docs", "a.md"), "body");
      await expect(movePath(root, "Docs/a.md", "docs/b.md")).resolves.toBe("docs/b.md");
      expect(await readFile(join(root, "docs", "b.md"), "utf8")).toBe("body");
    });
  });

  it("refuses a case-only rename when the disk silently keeps the old capitals", async (context) => {
    await mkdir(join(root, "docs", "plans"), { recursive: true });
    await writeFile(join(root, "docs", "plans", "a.md"), "body");
    if (
      !(await lstat(join(root, "docs", "Plans")).then(
        () => true,
        () => false,
      ))
    )
      context.skip("this disk keeps case apart");
    const noOp = vi.spyOn(fsPromises, "rename").mockResolvedValue(undefined);
    try {
      await expect(movePath(root, "docs/plans", "docs/Plans")).rejects.toThrow(
        "dohc did not rename docs/plans to docs/Plans. This disk kept the name plans. Rename it to another name first, then to Plans.",
      );
      expect(await readdir(join(root, "docs"))).toEqual(["plans"]);
      expect(await readFile(join(root, "docs", "plans", "a.md"), "utf8")).toBe("body");
    } finally {
      noOp.mockRestore();
    }
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
      await expect(movePath(root, "readme.md", "README.md")).rejects.toThrow(/already exists/);
      expect(await readFile(join(root, "README.md"), "utf8")).toBe("other");
    }
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
      await expect(prepareWorkspaceDelete(root, "notes/a.md")).resolves.toBe("Notes/A.md");
    } else {
      await writeFile(join(root, "Notes", "a.md"), "lower");
      await expect(prepareWorkspaceDelete(root, "Notes/A.md")).resolves.toBe("Notes/A.md");
      await expect(prepareWorkspaceDelete(root, "Notes/a.md")).resolves.toBe("Notes/a.md");
    }

    await symlink(join(root, "Notes", "A.md"), join(root, "alias.md"));
    await expect(prepareWorkspaceDelete(root, "alias.md")).resolves.toBe("alias.md");
  });
});

describe("deletePath", () => {
  // The engine's open of the workspace prepared `.dohc/local`, where the
  // workspace trash is.
  const workspace = () => ({ workspaceId: "delete-path", rootPath: root });
  beforeEach(() => openedLocalState(workspace()));

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
    expect(await readFile(join(root, ".dohc", "local", "trash", trashNames[0]!), "utf8")).toBe(
      "recover me",
    );
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
    const bodies = await Promise.all(names.map((name) => readFile(join(trashDir, name), "utf8")));
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
    expect(await readFile(join(root, "secret-notes.md"), "utf8")).toBe("private");
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a trash folder another user can change",
    async () => {
      await mkdir(join(root, ".dohc", "local", "trash"));
      await chmod(join(root, ".dohc", "local", "trash"), 0o777);
      await writeFile(join(root, "junk.md"), "keep me");
      await expect(deletePath(workspace(), "junk.md", rejectingTrash)).rejects.toThrow(
        "dohc could not move this to the workspace trash. Another user can change .dohc/local/trash. Make it a folder only you can change. Then retry.",
      );
      expect(await readFile(join(root, "junk.md"), "utf8")).toBe("keep me");
      expect(await readdir(join(root, ".dohc", "local", "trash"))).toEqual([]);
    },
  );

  // A local sparse file has a size and no blocks, as a file only in iCloud
  // Drive does. Its dataless flag is clear, so it moves like any other.

  // With Optimize Mac Storage, iCloud Drive can leave a file's bytes only in
  // iCloud. Moved into .dohc/local, which iCloud Drive skips, they could be
  // lost. A sparse file is the candidate, and the flags it reports decide.
  describe("a file only in iCloud Drive", () => {
    const sparse = async (path: string) => {
      await writeFile(join(root, path), "");
      await truncate(join(root, path), 4096);
    };
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

    it.skipIf(process.platform === "win32")(
      "moves nothing into the workspace trash when its dataless flag is set",
      async () => {
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
          expect(await deletePath(workspace(), "empty.md", rejectingTrash)).toEqual({
            trashed: false,
          });
          const system: string[] = [];
          expect(
            await deletePath(workspace(), "folder", async (path) => {
              system.push(path);
            }),
          ).toEqual({ trashed: true });
          expect(system).toEqual([join(await realpath(root), "folder")]);
        });
      },
    );

    it.skipIf(process.platform === "win32")(
      "moves nothing when it can't read the flags",
      async () => {
        await evicted();
        await withICloudCheck(
          {
            applies: true,
            readFlags: async () => {
              throw new Error("stat: evicted.md: No such file or directory");
            },
          },
          async () => {
            await expect(deletePath(workspace(), "folder", rejectingTrash)).rejects.toThrow(
              "dohc did not move folder to the workspace trash because dohc could not check for files only in iCloud Drive. Try again.",
            );
          },
        );
        await untouched();
      },
    );

    it.skipIf(process.platform === "win32")(
      "moves nothing from a folder too large to check in its bounds",
      async () => {
        await evicted();
        for (const n of [1, 2, 3]) await writeFile(join(root, "folder", `${n}.md`), String(n));
        const words =
          "dohc did not move folder to the workspace trash because it holds too many files to check. Delete it in smaller parts.";
        await withICloudCheck({ applies: true, maxEntries: 3 }, async () => {
          await expect(deletePath(workspace(), "folder", rejectingTrash)).rejects.toThrow(words);
        });
        await withICloudCheck({ applies: true, maxMs: 0 }, async () => {
          await expect(deletePath(workspace(), "folder", rejectingTrash)).rejects.toThrow(words);
        });
        await untouched();
        await withICloudCheck(
          { applies: true, maxEntries: 7, readFlags: async (paths) => paths.map(() => 0) },
          async () => {
            expect(await deletePath(workspace(), "folder", rejectingTrash)).toEqual({
              trashed: false,
            });
          },
        );
      },
    );
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
    expect(existsSync(join(root, "link.md"))).toBe(false);
    expect(await readFile(join(outside, "victim.md"), "utf8")).toBe("keep");
    const trashNames = await readdir(join(root, ".dohc", "local", "trash"));
    expect(trashNames).toHaveLength(1);
    expect(trashNames[0]).toMatch(/link\.md$/);
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
    const byPath = new Map(
      entries.map((entry) => [entry.path, Buffer.from(entry.data).toString("utf8")]),
    );
    expect(byPath.get("b.md")).toBe("beta");
    expect(byPath.get("notes/a.md")).toBe("alpha");
  });

  it("rejects traversal/reserved paths and symlink escapes", async () => {
    await expect(collectZipEntries(root, "../x")).rejects.toThrow(/traversal/);
    await expect(collectZipEntries(root, ".dohc")).rejects.toThrow(/reserved/);
    const outside = await createTestScratch("dohc-outside-");
    await symlink(outside, join(root, "linkdir"), "dir");
    await expect(collectZipEntries(root, "linkdir")).rejects.toThrow(/escapes the workspace/);
  });

  it("refuses an oversized export instead of buffering it", async () => {
    // 3 x 100MB sparse-ish writes would be slow; instead lower the bar by
    // exceeding the ENTRY cap with many tiny files in one directory tree.
    await mkdir(join(root, "many"), { recursive: true });
    await Promise.all(
      Array.from({ length: 2001 }, (_, i) => writeFile(join(root, "many", `f-${i}.md`), "x")),
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

  it("keeps secrets out of MOUNTED-share exports too (read-aware floor)", async () => {
    await mkdir(join(root, SHARED_WITH_ME_FOLDER, "alex"), { recursive: true });
    await writeFile(join(root, SHARED_WITH_ME_FOLDER, "alex", "brief.md"), "fine");
    await writeFile(join(root, SHARED_WITH_ME_FOLDER, "alex", ".env"), "API_KEY=x");
    const { entries } = await collectZipEntries(root, `${SHARED_WITH_ME_FOLDER}/alex`);
    expect(entries.map((entry) => entry.path)).toEqual(["alex/brief.md"]);
    await expect(collectZipEntries(root, `${SHARED_WITH_ME_FOLDER}/alex/.env`)).rejects.toThrow(
      /Secret files never leave the workspace/,
    );
  });
});

describe("copyIntoWorkspace", () => {
  it("renames on collision instead of overwriting or dropping the file", async () => {
    const outside = await createTestScratch("dohc-import-");
    await writeFile(join(outside, "notes.md"), "incoming");
    await writeFile(join(root, "notes.md"), "existing");
    const outcome = await copyIntoWorkspace(root, [join(outside, "notes.md")]);
    expect(outcome).toEqual({ imported: ["notes (2).md"], skipped: 0 });
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("existing");
    expect(await readFile(join(root, "notes (2).md"), "utf8")).toBe("incoming");
  });

  // What a retry after a partial import meets: the files that already landed
  // are imported again beside themselves, not skipped. The shell names what
  // landed so the person can pick only the rest.

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
    expect(first).toMatchObject({
      imported: [],
      skipped: 0,
      stop: { file: "gone.md", code: "ENOENT" },
    });
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
    expect(existsSync(join(root, SHARED_WITH_ME_FOLDER, "alex", "receipt.png"))).toBe(false);
  });
});

describe("screenPickedPaths", () => {
  it("leaves a picked file inside any .dohc folder out of the import, also through a link", async () => {
    const work = join(root, "Other");
    const kept = join(work, ".dohc", "local", "protected-copies");
    await mkdir(kept, { recursive: true });
    await writeFile(join(kept, "copy.json"), '{"text":"SECRET"}');
    const link = join(root, "alias");
    await symlink(kept, link, "junction");
    await writeFile(join(root, "plain.md"), "plain");
    const target = join(root, "target");
    await mkdir(target);

    const picked = await screenPickedPaths([
      join(kept, "copy.json"),
      join(link, "copy.json"),
      join(root, "plain.md"),
    ]);
    expect(picked.usable).toEqual([join(root, "plain.md")]);
    const outcome = await copyIntoWorkspace(target, picked.usable, undefined, picked.skips);

    expect(outcome).toEqual({
      imported: ["plain.md"],
      skipped: 2,
      skippedSources: [
        { path: "copy.json", reason: "workspace-data" },
        { path: "copy.json", reason: "workspace-data" },
      ],
    });
    expect(existsSync(join(target, "copy.json"))).toBe(false);
  });
});

describe("importDroppedPaths", () => {
  it("leaves a file dropped from a .dohc folder no registered workspace owns out as workspace data", async () => {
    const kept = join(root, "Removed", ".dohc", "local", "protected-copies");
    await mkdir(kept, { recursive: true });
    await writeFile(join(kept, "copy.json"), '{"text":"SECRET"}');
    await writeFile(join(root, "plain.md"), "plain");
    const registered = join(root, "Registered");
    await mkdir(join(registered, ".dohc"), { recursive: true });
    const target = join(root, "target");
    await mkdir(target);

    const outcome = await importDroppedPaths(
      target,
      [join(kept, "copy.json"), join(root, "plain.md")],
      [registered],
    );

    expect(outcome).toEqual({
      imported: ["plain.md"],
      skipped: 1,
      skippedSources: [{ path: "copy.json", reason: "workspace-data" }],
    });
    expect(existsSync(join(target, "copy.json"))).toBe(false);
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
      skippedSources: [
        { path: "Trip/key.txt", reason: "link" },
        { path: "Trip/linked", reason: "link" },
      ],
      folders: ["Trip"],
    });
    expect(await readFile(join(root, "Trip", "photos", "beach.jpg"), "utf8")).toBe("jpg-bytes");
    expect((await readdir(join(root, "Trip"))).sort()).toEqual([
      "Report.rtfd",
      "empty",
      "photos",
      "plan.md",
    ]);
    expect(await readdir(join(root, "Trip", "photos"))).toEqual(["beach.jpg"]);
  });

  it("names each item a drop leaves out on its own, and why", async () => {
    const outside = await createTestScratch("dohc-drop-");
    await writeFile(join(outside, "ok.md"), "ok");
    await writeFile(join(outside, ".DS_Store"), "finder");
    await mkdir(join(outside, "node_modules"));
    await mkdir(join(outside, ".dohc"));

    const dropped = ["ok.md", ".DS_Store", "node_modules", ".dohc"].map((name) =>
      join(outside, name),
    );
    expect(await importDroppedPaths(root, dropped, [root])).toEqual({
      imported: ["ok.md"],
      skipped: 3,
      skippedSources: [
        { path: ".DS_Store", reason: "system-file" },
        { path: "node_modules", reason: "left-out" },
        { path: ".dohc", reason: "workspace-data" },
      ],
    });
  });

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

  // The validator decodes %2f and reads \ as a separator, so these names
  // would land as cfg/evil, through the link cfg, outside the workspace.

  it("takes 1,000 files and folders from a drop with folders, and refuses the whole drop past that", async () => {
    const outside = await createTestScratch("dohc-many-");
    const fits = join(outside, "fits");
    await mkdir(join(fits, "inner"), { recursive: true });
    await Promise.all(
      Array.from({ length: 998 }, (_, i) => writeFile(join(fits, "inner", `f-${i}.md`), "x")),
    );
    const landed = await importDroppedPaths(root, [fits], [root]);
    expect([landed.imported.length, landed.folders]).toEqual([998, ["fits"]]);

    const over = join(outside, "over");
    await mkdir(over, { recursive: true });
    await writeFile(join(outside, "loose.md"), "x");
    await Promise.all(
      Array.from({ length: 999 }, (_, i) => writeFile(join(over, `f-${i}.md`), "x")),
    );
    await expect(
      importDroppedPaths(root, [join(outside, "loose.md"), over], [root]),
    ).rejects.toThrow(
      "dohc imports up to 1,000 files and folders from one drop. Drop fewer folders at a time.",
    );
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
    expect(outcome).toEqual({
      imported: [],
      skipped: 1,
      skippedSources: [{ path: "innocent.txt", reason: "link" }],
    });
    expect(existsSync(join(root, "innocent.txt"))).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

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
    expect(await copyIntoWorkspace(root, [encodedFile])).toEqual({
      imported: [],
      skipped: 1,
      skippedSources: [{ path: "cfg%2fevil", reason: "name" }],
    });
    expect(await readdir(elsewhere)).toEqual([]);
  });

  // Another process that can write the dropped folder, but not read the
  // secret, swaps what the screen saw for a link before the copy.
  it.each(["file", "folder"] as const)(
    "never copies a %s swapped for a link after the screen",
    async (swapped) => {
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
    },
  );

  // A folder swapped for a link while the screen reads it, and put back
  // before the copy, would have the screen record the link target's files.

  it("refuses a drop whose folders hold more than 10,000 entries it leaves out", async () => {
    const outside = await createTestScratch("dohc-many-");
    const trip = join(outside, "Trip");
    await mkdir(trip);
    await writeFile(join(trip, "plan.md"), "plan");
    // In batches: 10,000 files open at once run out of handles on Windows.
    for (let start = 0; start < 10_000; start += 500) {
      await Promise.all(
        Array.from({ length: 500 }, (_, i) => writeFile(join(trip, `._${start + i}`), "")),
      );
    }
    expect((await importDroppedPaths(root, [trip], [root])).imported).toEqual(["Trip/plan.md"]);

    await writeFile(join(trip, "._10000"), "");
    await expect(importDroppedPaths(root, [trip], [root], "Trip")).rejects.toThrow(
      "dohc reads up to 10,000 files it leaves out, such as .DS_Store, in one drop. Drop fewer folders at a time.",
    );
    expect(await readdir(join(root, "Trip"))).toEqual(["plan.md"]);
  });

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
    fsHooks.opened = (path, handle) =>
      path !== target
        ? handle
        : new Proxy(handle, {
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
  it.skipIf(process.platform === "win32")(
    "refuses a drop reached through a link another user owns",
    async () => {
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
      expect((await importDroppedPaths(root, [join(link, "Documents")], [root])).imported).toEqual([
        "Documents/tax.md",
      ]);
    },
  );

  // HFS+ stores names decomposed, so the folder made for Café reads back as
  // Cafe plus a combining accent, and its files must still land.
  it.skipIf(process.platform !== "darwin")(
    "imports a folder with a composed name onto an HFS+ volume",
    async () => {
      const scratch = await createTestScratch("dohc-hfs-");
      const image = join(scratch, "hfs.dmg");
      const mount = join(scratch, "mnt");
      await mkdir(mount);
      try {
        execFileSync("hdiutil", [
          "create",
          "-quiet",
          "-size",
          "20m",
          "-fs",
          "HFS+",
          "-volname",
          "DOHCHFS",
          image,
        ]);
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
        expect(await readFile(join(workspace, "Caf\u00e9", "Cr\u00e8me", "b.md"), "utf8")).toBe(
          "b",
        );
      } finally {
        execFileSync("hdiutil", ["detach", "-quiet", "-force", mount]);
      }
    },
  );
});

// The trash ladder is several renames, and it re-checks the source between
// them. This is the decision it makes, separated from the I/O because an
// EACCES on that second look is not arrangeable here -- and it is the case
// that carried the defect: a check that failed was reported as a change.
describe("trash ladder stop classification", () => {
  const entry = { ino: 7n, dev: 3n };

  it("says it could not check when the look itself failed", () => {
    for (const code of ["EACCES", "EIO", "EPERM", undefined]) {
      expect(classifyLadderProbe(entry, { looked: false, code }), code).toBe("unchecked");
    }
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

  it("reads ENOENT as length only when this name exceeds the budget", () => {
    expect(couldBeLengthRefusal("ENOENT", "n".repeat(WINDOWS_BUDGET + 1), WINDOWS_BUDGET)).toBe(
      true,
    );
    expect(couldBeLengthRefusal("ENOENT", "n".repeat(WINDOWS_BUDGET), WINDOWS_BUDGET)).toBe(false);
  });

  // The finding. Off Windows the budget is Infinity, so a 259-plus-character
  // path is ordinary and an ENOENT can only mean the source is gone.
  it("never reads ENOENT as length where no composed limit applies", () => {
    expect(couldBeLengthRefusal("ENOENT", "n".repeat(300), NO_LIMIT)).toBe(false);
    expect(couldBeLengthRefusal("ENOENT", "n".repeat(5000), NO_LIMIT)).toBe(false);
  });
});

// Before the copy loop may call a link dangling, something has to establish
// that the target is ABSENT. A probe that failed establishes nothing --
// separated from the I/O because an EACCES or an EIO stat is not arrangeable
// here, and it is the case that carries the defect: a link to an unreachable
// network path would be reported to the user as a link to a missing file.
describe("copy end-probe classification", () => {
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
  it("names a dangling symbolic link instead of skipping it", async () => {
    const base = await mkdtemp(join(tmpdir(), "dohc-dangling-"));
    try {
      const root = join(base, "ws");
      await mkdir(root, { recursive: true });
      const source = join(base, "link.md");
      await symlink(join(base, "never-existed.md"), source, "file");
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
      await rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  });

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
      const landed = outcome.imported[0];
      expect(landed).not.toBe(name);
      expect(await readFile(join(root, landed), "utf8")).toBe("keep me");
      expect(await readFile(join(root, name), "utf8")).toBe("already here");
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
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
    await expect(removeEmptyWorkspaceFolder(root, "link/keep")).rejects.toThrow(
      /escapes the workspace/,
    );
    expect(existsSync(join(outside, "keep"))).toBe(true);
  });
});
