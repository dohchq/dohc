import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
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
  await restoreRead(join(root, "locked"), 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

// Access denial is chmod 0o000 on POSIX and an explicit NTFS deny-read ACE on
// Windows (POSIX modes do not exist there). The denied operation surfaces as
// EACCES on POSIX and EPERM on Windows; the scan behavior under test — skip,
// keep scanning, report — is identical.
const deniedReadCode = process.platform === "win32" ? "EPERM" : "EACCES";

async function denyRead(absolute: string, kind: "dir" | "file"): Promise<void> {
  if (process.platform === "win32") {
    const user = userInfo().username;
    const ace = kind === "dir" ? `${user}:(OI)(CI)(R)` : `${user}:(R)`;
    execFileSync("icacls", [absolute, "/inheritance:r", "/deny", ace], { stdio: "pipe" });
    return;
  }
  await chmod(absolute, 0o000);
}

async function restoreRead(absolute: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    const user = userInfo().username;
    try {
      execFileSync("icacls", [absolute, "/remove:d", user], { stdio: "pipe" });
      execFileSync("icacls", [absolute, "/inheritance:e"], { stdio: "pipe" });
    } catch {
      // Fixture may not exist or never got the deny ACE; cleanup is best-effort.
    }
    return;
  }
  await chmod(absolute, mode);
}

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
    await denyRead(join(root, "locked"), "dir");
    try {
      const scan = await scanWorkspaceFilesTolerant(root);
      expect(scan.files.map((file) => file.path)).toEqual([
        "docs/deep/nested.md",
        "notes/keep.md",
      ]);
      expect(scan.failures).toEqual([
        { path: "locked", reason: expect.stringContaining(deniedReadCode) },
      ]);

      // The strict default is unchanged: the same tree still throws.
      await expect(scanWorkspaceFiles(root)).rejects.toThrow(new RegExp(deniedReadCode));
    } finally {
      await restoreRead(join(root, "locked"), 0o755);
    }
  });

  itNonRoot("skips an unreadable file without dropping its siblings", async () => {
    await writeFixture("notes/readable.md", "# Fine\n");
    await writeFixture("notes/sealed.md", "# Sealed\n");
    await denyRead(join(root, "notes/sealed.md"), "file");
    try {
      const scan = await scanWorkspaceFilesTolerant(root);
      expect(scan.files.map((file) => file.path)).toEqual(["notes/readable.md"]);
      expect(scan.failures).toEqual([
        { path: "notes/sealed.md", reason: expect.stringContaining(deniedReadCode) },
      ]);
    } finally {
      await restoreRead(join(root, "notes/sealed.md"), 0o644);
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
