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
import { posixMcpLauncher } from "../../scripts/mcp-launchers.mjs";
import {
  hasIntactStableCliBin,
  refreshLinuxStableCliBin,
  syncLinuxStableCliBin,
} from "./linuxStableCliBin";

const scratchDirs: string[] = [];
let failLauncherPublish = false;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (async (...args: Parameters<typeof actual.writeFile>) => {
      if (failLauncherPublish && /^dohc-mcp\.tmp-/.test(basename(String(args[0])))) {
        await actual.writeFile(args[0], "partial-launcher");
        throw new Error("launcher publish failed");
      }
      return actual.writeFile(...args);
    }) as typeof actual.writeFile,
  };
});

afterEach(() => {
  failLauncherPublish = false;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function referencedModuleName(targetDir: string): string {
  const launcher = readFileSync(join(targetDir, "dohc-mcp"), "utf8");
  const moduleFileName = /exec node "\$\{0%\/\*\}\/([^"]+)" "\$@"/.exec(launcher)?.[1];
  if (!moduleFileName) throw new Error("The launcher does not name its module.");
  return moduleFileName;
}

function publishedModuleNames(targetDir: string): string[] {
  return readdirSync(targetDir)
    .filter((name) => /^dohc-mcp-[a-f0-9]{16}\.mjs$/.test(name))
    .sort();
}

describe("syncLinuxStableCliBin", () => {
  it("publishes a content-addressed module and swaps the executable launcher to it", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const resourcesCliBinDir = join(root, "resources", "cli-bin");
    const targetDir = join(root, "state", "cli-bin");
    mkdirSync(resourcesCliBinDir, { recursive: true });
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");

    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir });
    const firstModule = referencedModuleName(targetDir);
    expect(firstModule).toMatch(/^dohc-mcp-[a-f0-9]{16}\.mjs$/);
    expect(readFileSync(join(targetDir, firstModule), "utf8")).toBe("module-v1");
    expect(readFileSync(join(targetDir, "dohc-mcp"), "utf8")).toBe(
      posixMcpLauncher(firstModule),
    );
    if (process.platform !== "win32") {
      expect(statSync(join(targetDir, "dohc-mcp")).mode & 0o777).toBe(0o755);
    }

    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir });
    const secondModule = referencedModuleName(targetDir);
    expect(secondModule).not.toBe(firstModule);
    expect(readFileSync(join(targetDir, secondModule), "utf8")).toBe("module-v2");
    expect(publishedModuleNames(targetDir)).toEqual([firstModule, secondModule].sort());
  });

  it("keeps the previous launcher and module paired when launcher publication fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const resourcesCliBinDir = join(root, "resources", "cli-bin");
    const targetDir = join(root, "state", "cli-bin");
    const targetLauncher = join(targetDir, "dohc-mcp");
    mkdirSync(resourcesCliBinDir, { recursive: true });
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");

    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir });
    const firstLauncher = readFileSync(targetLauncher, "utf8");
    const firstModule = referencedModuleName(targetDir);
    const publishedMode = statSync(targetLauncher).mode & 0o777;
    if (process.platform !== "win32") expect(publishedMode).toBe(0o755);

    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    failLauncherPublish = true;

    await expect(syncLinuxStableCliBin({ resourcesCliBinDir, targetDir })).rejects.toThrow(
      "launcher publish failed",
    );
    const secondModule = publishedModuleNames(targetDir).find((name) => name !== firstModule);
    expect(secondModule).toBeDefined();
    expect(readFileSync(targetLauncher, "utf8")).toBe(firstLauncher);
    expect(statSync(targetLauncher).mode & 0o777).toBe(publishedMode);
    expect(referencedModuleName(targetDir)).toBe(firstModule);
    expect(referencedModuleName(targetDir)).not.toBe(secondModule);
    expect(readFileSync(join(targetDir, firstModule), "utf8")).toBe("module-v1");
    expect(readFileSync(join(targetDir, secondModule!), "utf8")).toBe("module-v2");
    expect(await hasIntactStableCliBin(targetDir)).toBe(true);
    expect(readdirSync(targetDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});

describe("hasIntactStableCliBin", () => {
  it("requires a non-empty module at the exact path named by the launcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const targetDir = join(root, "state", "cli-bin");
    const moduleFileName = "dohc-mcp-0123456789abcdef.mjs";
    expect(await hasIntactStableCliBin(targetDir)).toBe(false);

    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "dohc-mcp"), posixMcpLauncher(moduleFileName));
    expect(await hasIntactStableCliBin(targetDir)).toBe(false);

    writeFileSync(join(targetDir, moduleFileName), "");
    expect(await hasIntactStableCliBin(targetDir)).toBe(false);

    writeFileSync(join(targetDir, moduleFileName), "module");
    expect(await hasIntactStableCliBin(targetDir)).toBe(true);
  });

  it("rejects a launcher when only a different module survives", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const targetDir = join(root, "state", "cli-bin");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, "dohc-mcp"),
      posixMcpLauncher("dohc-mcp-missing-generation.mjs"),
    );
    writeFileSync(join(targetDir, "dohc-mcp.mjs"), "a different generation");

    expect(await hasIntactStableCliBin(targetDir)).toBe(false);
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
    expect(await hasIntactStableCliBin(targetDir)).toBe(false);

    rmSync(join(targetDir, "dohc-mcp"), { recursive: true });
    const moduleFileName = "dohc-mcp-0123456789abcdef.mjs";
    writeFileSync(join(targetDir, "dohc-mcp"), posixMcpLauncher(moduleFileName));
    mkdirSync(join(targetDir, moduleFileName));
    writeFileSync(join(targetDir, moduleFileName, "not-the-module"), "y");
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
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");
    await refreshLinuxStableCliBin({ resourcesCliBinDir, targetDir });
    const firstLauncher = readFileSync(join(targetDir, "dohc-mcp"), "utf8");
    const firstModule = referencedModuleName(targetDir);

    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    failLauncherPublish = true;

    const onError = vi.fn();
    const result = await refreshLinuxStableCliBin({ resourcesCliBinDir, targetDir, onError });
    expect(result).toBe(targetDir);
    expect(onError).toHaveBeenCalledOnce();
    const secondModule = publishedModuleNames(targetDir).find((name) => name !== firstModule);
    expect(secondModule).toBeDefined();
    expect(await hasIntactStableCliBin(targetDir)).toBe(true);
    expect(readFileSync(join(targetDir, "dohc-mcp"), "utf8")).toBe(firstLauncher);
    expect(referencedModuleName(targetDir)).toBe(firstModule);
    expect(referencedModuleName(targetDir)).not.toBe(secondModule);
    expect(readFileSync(join(targetDir, firstModule), "utf8")).toBe("module-v1");
    expect(readFileSync(join(targetDir, secondModule!), "utf8")).toBe("module-v2");
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
