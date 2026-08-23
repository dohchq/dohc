import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasIntactStableCliBin,
  refreshLinuxStableCliBin,
  syncLinuxStableCliBin,
} from "./linuxStableCliBin";

const scratchDirs: string[] = [];
let failLauncherCopy = false;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: (async (...args: Parameters<typeof actual.copyFile>) => {
      if (failLauncherCopy && basename(String(args[0])) === "dohc-mcp") {
        await actual.writeFile(args[1], "partial-launcher");
        throw new Error("launcher copy failed");
      }
      return actual.copyFile(...args);
    }) as typeof actual.copyFile,
  };
});

afterEach(() => {
  failLauncherCopy = false;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("syncLinuxStableCliBin", () => {
  it("copies both launchers, sets the executable mode, and overwrites stale copies", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const resourcesCliBinDir = join(root, "resources", "cli-bin");
    const targetDir = join(root, "state", "cli-bin");
    mkdirSync(resourcesCliBinDir, { recursive: true });
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp"), "launcher-v1");
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");

    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir });
    expect(readFileSync(join(targetDir, "dohc-mcp"), "utf8")).toBe("launcher-v1");
    expect(readFileSync(join(targetDir, "dohc-mcp.mjs"), "utf8")).toBe("module-v1");
    if (process.platform !== "win32") {
      expect(statSync(join(targetDir, "dohc-mcp")).mode & 0o777).toBe(0o755);
    }

    writeFileSync(join(resourcesCliBinDir, "dohc-mcp"), "launcher-v2");
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir });
    expect(readFileSync(join(targetDir, "dohc-mcp"), "utf8")).toBe("launcher-v2");
    expect(readFileSync(join(targetDir, "dohc-mcp.mjs"), "utf8")).toBe("module-v2");
  });

  it("keeps the published launcher intact when its replacement copy fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const resourcesCliBinDir = join(root, "resources", "cli-bin");
    const targetDir = join(root, "state", "cli-bin");
    const targetLauncher = join(targetDir, "dohc-mcp");
    mkdirSync(resourcesCliBinDir, { recursive: true });
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp"), "launcher-v1");
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");

    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir });
    const publishedMode = statSync(targetLauncher).mode & 0o777;
    if (process.platform !== "win32") expect(publishedMode).toBe(0o755);

    writeFileSync(join(resourcesCliBinDir, "dohc-mcp"), "launcher-v2");
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    failLauncherCopy = true;

    await expect(syncLinuxStableCliBin({ resourcesCliBinDir, targetDir })).rejects.toThrow(
      "launcher copy failed",
    );
    expect(readFileSync(targetLauncher, "utf8")).toBe("launcher-v1");
    expect(statSync(targetLauncher).mode & 0o777).toBe(publishedMode);
    expect(readFileSync(join(targetDir, "dohc-mcp.mjs"), "utf8")).toBe("module-v2");
    expect(readdirSync(targetDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});

describe("hasIntactStableCliBin", () => {
  it("is false for a missing directory, a partial pair, or an empty file, true once both files are non-empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const targetDir = join(root, "state", "cli-bin");
    expect(await hasIntactStableCliBin(targetDir)).toBe(false);

    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "dohc-mcp"), "launcher");
    expect(await hasIntactStableCliBin(targetDir)).toBe(false);

    writeFileSync(join(targetDir, "dohc-mcp.mjs"), "");
    expect(await hasIntactStableCliBin(targetDir)).toBe(false);

    writeFileSync(join(targetDir, "dohc-mcp.mjs"), "module");
    expect(await hasIntactStableCliBin(targetDir)).toBe(true);
  });

  it("is false when either name is a directory, even a non-empty one", async () => {
    // Some filesystems (ext4's default block size, for one) report a
    // directory's own stat size as nonzero -- size alone would misread a
    // directory sitting where a file should be as an intact publish.
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const targetDir = join(root, "state", "cli-bin");
    mkdirSync(join(targetDir, "dohc-mcp"), { recursive: true });
    writeFileSync(join(targetDir, "dohc-mcp", "not-the-launcher"), "x");
    mkdirSync(join(targetDir, "dohc-mcp.mjs"), { recursive: true });
    writeFileSync(join(targetDir, "dohc-mcp.mjs", "not-the-module"), "y");

    expect(await hasIntactStableCliBin(targetDir)).toBe(false);
  });
});

describe("refreshLinuxStableCliBin", () => {
  it("resolves to targetDir on a successful sync", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const resourcesCliBinDir = join(root, "resources", "cli-bin");
    const targetDir = join(root, "state", "cli-bin");
    mkdirSync(resourcesCliBinDir, { recursive: true });
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp"), "launcher-v1");
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");

    const onError = vi.fn();
    const result = await refreshLinuxStableCliBin({ resourcesCliBinDir, targetDir, onError });
    expect(result).toBe(targetDir);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps resolving to targetDir when a refresh fails but a previously published pair is intact", async () => {
    // A boot's own refresh can fail for reasons that have nothing to do
    // with whether the LAST successful boot's launcher still works (a full
    // disk, a permissions hiccup) -- the config an already-configured agent
    // is holding must keep pointing at something real either way.
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const resourcesCliBinDir = join(root, "resources", "cli-bin");
    const targetDir = join(root, "state", "cli-bin");
    mkdirSync(resourcesCliBinDir, { recursive: true });
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp"), "launcher-v1");
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");
    await refreshLinuxStableCliBin({ resourcesCliBinDir, targetDir });

    writeFileSync(join(resourcesCliBinDir, "dohc-mcp"), "launcher-v2");
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    failLauncherCopy = true;

    const onError = vi.fn();
    const result = await refreshLinuxStableCliBin({ resourcesCliBinDir, targetDir, onError });
    expect(result).toBe(targetDir);
    expect(onError).toHaveBeenCalledOnce();
    // The stable pair the caller is told to trust is exactly the one on
    // disk -- the previous launcher, not a half-written new one.
    expect(readFileSync(join(targetDir, "dohc-mcp"), "utf8")).toBe("launcher-v1");
  });

  it("resolves to undefined when a refresh fails and nothing was ever published", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    // No resourcesCliBinDir at all: every copy fails from the first sync.
    const resourcesCliBinDir = join(root, "resources", "cli-bin");
    const targetDir = join(root, "state", "cli-bin");

    const onError = vi.fn();
    const result = await refreshLinuxStableCliBin({ resourcesCliBinDir, targetDir, onError });
    expect(result).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
