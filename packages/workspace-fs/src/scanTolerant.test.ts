import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanWorkspaceFiles, scanWorkspaceFilesTolerant } from "./scan";

// Deterministic "file deleted mid-scan" simulation: readdir lists the entry,
// then its stat (the first per-file touch) fails ENOENT — exactly the window
// a real racy delete hits. Everything else passes through to the real fs so
// fixture setup/cleanup in this file is unaffected.
const midScanDelete = vi.hoisted(() => ({ suffix: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (async (path: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
      if (midScanDelete.suffix && String(path).endsWith(midScanDelete.suffix)) {
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, stat '${String(path)}'`),
          { code: "ENOENT" },
        );
      }
      return (actual.stat as (...args: unknown[]) => ReturnType<typeof actual.stat>)(
        path,
        ...rest,
      );
    }) as typeof actual.stat,
  };
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-scan-tolerant-"));
});

afterEach(async () => {
  midScanDelete.suffix = null;
  // A fixture may have left an unreadable directory behind; restore modes so
  // the recursive cleanup can see it.
  await chmod(join(root, "locked"), 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

async function writeFixture(path: string, text = "content\n") {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
}

// chmod-based fixtures cannot make a path unreadable for root (root ignores
// file modes), so those tests skip gracefully under uid 0 (e.g. CI containers).
const itNonRoot = process.getuid?.() === 0 ? it.skip : it;

describe("scanWorkspaceFilesTolerant", () => {
  itNonRoot("skips an unreadable subdirectory, keeps scanning, and reports the failure", async () => {
    await writeFixture("notes/keep.md", "# Keep\n");
    await writeFixture("docs/deep/nested.md", "# Nested\n");
    await writeFixture("locked/secret.md", "# Locked away\n");
    await chmod(join(root, "locked"), 0o000);
    try {
      const scan = await scanWorkspaceFilesTolerant(root);
      expect(scan.files.map((file) => file.path)).toEqual([
        "docs/deep/nested.md",
        "notes/keep.md",
      ]);
      expect(scan.failures).toEqual([
        { path: "locked", reason: expect.stringContaining("EACCES") },
      ]);

      // The strict default is unchanged: the same tree still throws.
      await expect(scanWorkspaceFiles(root)).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(join(root, "locked"), 0o755);
    }
  });

  itNonRoot("skips an unreadable file without dropping its siblings", async () => {
    await writeFixture("notes/readable.md", "# Fine\n");
    await writeFixture("notes/sealed.md", "# Sealed\n");
    await chmod(join(root, "notes/sealed.md"), 0o000);
    try {
      const scan = await scanWorkspaceFilesTolerant(root);
      expect(scan.files.map((file) => file.path)).toEqual(["notes/readable.md"]);
      expect(scan.failures).toEqual([
        { path: "notes/sealed.md", reason: expect.stringContaining("EACCES") },
      ]);
    } finally {
      await chmod(join(root, "notes/sealed.md"), 0o644);
    }
  });

  it("collects a file deleted mid-scan as a failure and keeps the rest of the tree", async () => {
    await writeFixture("notes/stays.md", "# Stays\n");
    await writeFixture("notes/ghost.md", "# About to vanish\n");
    await writeFixture("docs/other.md", "# Other\n");
    midScanDelete.suffix = join("notes", "ghost.md");
    try {
      const scan = await scanWorkspaceFilesTolerant(root);
      expect(scan.files.map((file) => file.path)).toEqual([
        "docs/other.md",
        "notes/stays.md",
      ]);
      expect(scan.failures).toEqual([
        { path: "notes/ghost.md", reason: expect.stringContaining("ENOENT") },
      ]);

      // Strict mode still surfaces the race as a thrown scan.
      await expect(scanWorkspaceFiles(root)).rejects.toThrow(/ENOENT/);
    } finally {
      midScanDelete.suffix = null;
    }
  });

  it("returns an empty listing plus a root failure when the root itself is gone", async () => {
    const missing = join(root, "never-created");
    const scan = await scanWorkspaceFilesTolerant(missing);
    expect(scan.files).toEqual([]);
    expect(scan.failures).toEqual([
      { path: ".", reason: expect.stringContaining("ENOENT") },
    ]);
  });
});
