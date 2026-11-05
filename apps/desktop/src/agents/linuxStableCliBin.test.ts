import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledPosixLauncher, posixMcpLauncher } from "../../scripts/mcp-launchers.mjs";
import {
  hasIntactStableCliBin,
  refreshLinuxStableCliBin,
  syncLinuxStableCliBin,
} from "./linuxStableCliBin";

const scratchDirs: string[] = [];
let failLauncherPublish = false;
let failNextLauncherRead = false;
const pinned = vi.hoisted(() => ({ sha256: "" }));
// Flushes and renames, in order, with temp names shortened to "<name>.tmp".
const fsEvents = vi.hoisted((): string[] => []);

vi.mock("../../scripts/pinned-node.mjs", () => ({
  PINNED_NODE: { "linux-x64": { get sha256() { return pinned.sha256; } } },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const shortName = (path: unknown) => basename(String(path)).replace(/\.tmp-.*$/, ".tmp");
  return {
    ...actual,
    writeFile: (async (...args: Parameters<typeof actual.writeFile>) => {
      if (failLauncherPublish && /^dohc-mcp\.tmp-/.test(basename(String(args[0])))) {
        await actual.writeFile(args[0], "partial-launcher");
        throw new Error("launcher publish failed");
      }
      return actual.writeFile(...args);
    }) as typeof actual.writeFile,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (failNextLauncherRead && basename(String(args[0])) === "dohc-mcp") {
        failNextLauncherRead = false;
        throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      }
      return actual.readFile(...args);
    }) as typeof actual.readFile,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        fsEvents.push(`flush ${shortName(args[0])}`);
        await sync();
      };
      return handle;
    }) as typeof actual.open,
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      fsEvents.push(`rename ${shortName(args[1])}`);
      await actual.rename(...args);
    }) as typeof actual.rename,
  };
});

afterEach(() => {
  failLauncherPublish = false;
  failNextLauncherRead = false;
  fsEvents.length = 0;
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

    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir, arch: "arm64" });
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
    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir, arch: "arm64" });
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

    await syncLinuxStableCliBin({ resourcesCliBinDir, targetDir, arch: "arm64" });
    const firstLauncher = readFileSync(targetLauncher, "utf8");
    const firstModule = referencedModuleName(targetDir);
    const publishedMode = statSync(targetLauncher).mode & 0o777;
    if (process.platform !== "win32") expect(publishedMode).toBe(0o755);

    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    failLauncherPublish = true;

    await expect(syncLinuxStableCliBin({ resourcesCliBinDir, targetDir, arch: "arm64" })).rejects.toThrow(
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

// A stand-in for dohc's Node.js that prints its arguments, so the launcher
// can run with no Node.js on PATH.
const RUNTIME = "#!/bin/sh\necho \"runtime $*\"\n";

function x64Fixture(runtime = RUNTIME) {
  const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
  scratchDirs.push(root);
  const resourcesCliBinDir = join(root, "resources", "cli-bin");
  const targetDir = join(root, "state", "cli-bin");
  mkdirSync(resourcesCliBinDir, { recursive: true });
  mkdirSync(join(root, "resources", "app-compiler"));
  writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");
  writeFileSync(join(root, "resources", "app-compiler", "node"), runtime, { mode: 0o755 });
  pinned.sha256 = createHash("sha256").update(runtime).digest("hex");
  return { resourcesCliBinDir, targetDir, arch: "x64", nodeFileName: `node-${pinned.sha256}` };
}

describe("syncLinuxStableCliBin on Linux x64", () => {
  it("publishes dohc's Node.js beside the module, and the launcher runs it with no Node.js on PATH", async () => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    const moduleFileName = publishedModuleNames(f.targetDir)[0]!;
    expect(readFileSync(join(f.targetDir, "dohc-mcp"), "utf8")).toBe(bundledPosixLauncher(moduleFileName, f.nodeFileName));
    expect(readFileSync(join(f.targetDir, f.nodeFileName), "utf8")).toBe(RUNTIME);
    expect(await hasIntactStableCliBin(f.targetDir)).toBe(true);
    if (process.platform === "win32") return;
    const run = spawnSync(join(f.targetDir, "dohc-mcp"), ["--workspace", "/w"], { env: { PATH: "" }, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`runtime ${join(f.targetDir, moduleFileName)} --workspace /w\n`);
  });

  it("copies dohc's Node.js once per release", async () => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    const published = statSync(join(f.targetDir, f.nodeFileName));
    writeFileSync(join(f.resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    await syncLinuxStableCliBin(f);
    expect(statSync(join(f.targetDir, f.nodeFileName)).ino).toBe(published.ino);
    expect(publishedModuleNames(f.targetDir)).toHaveLength(2);
  });

  it("refuses a Node.js that doesn't match its pinned release, and keeps the previous launcher", async () => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    const launcher = readFileSync(join(f.targetDir, "dohc-mcp"), "utf8");
    const changed = `${RUNTIME}# changed\n`;
    writeFileSync(join(f.resourcesCliBinDir, "..", "app-compiler", "node"), changed);
    pinned.sha256 = createHash("sha256").update("the pinned release").digest("hex");

    await expect(syncLinuxStableCliBin(f)).rejects.toThrow("dohc's Node.js does not match its pinned release.");
    expect(readFileSync(join(f.targetDir, "dohc-mcp"), "utf8")).toBe(launcher);
    expect(readdirSync(f.targetDir).filter((name) => name.startsWith("node-"))).toEqual([f.nodeFileName]);
    expect(readdirSync(f.targetDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(await refreshLinuxStableCliBin({ ...f, onError: () => {} })).toBe(f.targetDir);
  });

  it("keeps the Node.js its launcher names when the launcher can't be read, so a failed refresh still has it", async () => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    const launcher = readFileSync(join(f.targetDir, "dohc-mcp"), "utf8");
    writeFileSync(join(f.resourcesCliBinDir, "..", "app-compiler", "node"), `${RUNTIME}# changed\n`);
    pinned.sha256 = createHash("sha256").update("the pinned release").digest("hex");
    failNextLauncherRead = true;
    const onError = vi.fn();

    const result = await refreshLinuxStableCliBin({ ...f, onError });
    expect(failNextLauncherRead, "the launcher read failed with EIO").toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "dohc's Node.js does not match its pinned release." }));
    expect(result, "after EIO and a failed publish, the previous launcher still works").toBe(f.targetDir);
    expect(readFileSync(join(f.targetDir, "dohc-mcp"), "utf8")).toBe(launcher);
    expect(readdirSync(f.targetDir).filter((name) => name.startsWith("node-"))).toEqual([f.nodeFileName]);
  });

  it("is not intact when the Node.js its launcher names is missing", async () => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    rmSync(join(f.targetDir, f.nodeFileName));
    expect(await hasIntactStableCliBin(f.targetDir)).toBe(false);
  });

  it("removes a cut-short copy and an earlier release's Node.js, but not the one the launcher names", async () => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    writeFileSync(join(f.targetDir, `${f.nodeFileName}.tmp-1-cut`), "partial");
    const next = `${RUNTIME}# next release\n`;
    writeFileSync(join(f.resourcesCliBinDir, "..", "app-compiler", "node"), next);
    pinned.sha256 = createHash("sha256").update(next).digest("hex");
    const nodeFiles = () => readdirSync(f.targetDir).filter((name) => name.startsWith("node-")).sort();

    await syncLinuxStableCliBin(f);
    // The launcher still named the first release's Node.js when this refresh began.
    expect(nodeFiles()).toEqual([f.nodeFileName, `node-${pinned.sha256}`].sort());
    await syncLinuxStableCliBin(f);
    expect(nodeFiles()).toEqual([`node-${pinned.sha256}`]);
  });

  it("is not intact when the Node.js its launcher names was cut short", async () => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    truncateSync(join(f.targetDir, f.nodeFileName), 1);
    expect(await hasIntactStableCliBin(f.targetDir)).toBe(false);
  });

  it("flushes each file and its folder before the next rename, and publishes the launcher last", async () => {
    if (process.platform === "win32") return; // Node can't open a folder to flush it on Windows.
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    const moduleFileName = publishedModuleNames(f.targetDir)[0]!;
    expect(fsEvents).toEqual([
      `flush ${moduleFileName}.tmp`, `rename ${moduleFileName}`, "flush cli-bin",
      `flush ${f.nodeFileName}.tmp`, `rename ${f.nodeFileName}`, "flush cli-bin",
      "flush dohc-mcp.tmp", "rename dohc-mcp", "flush cli-bin",
    ]);
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
    const result = await refreshLinuxStableCliBin({ resourcesCliBinDir, targetDir, arch: "arm64", onError });
    expect(result).toBe(targetDir);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps resolving to targetDir when a refresh fails but a previously published pair is intact", async () => {
    // A boot's own refresh can fail for reasons that have nothing to do
    // with whether the last successful boot's launcher still works (a full
    // disk, a permissions hiccup) -- the config an already-configured agent
    // is holding must keep pointing at something real either way.
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const resourcesCliBinDir = join(root, "resources", "cli-bin");
    const targetDir = join(root, "state", "cli-bin");
    mkdirSync(resourcesCliBinDir, { recursive: true });
    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");
    await refreshLinuxStableCliBin({ resourcesCliBinDir, targetDir, arch: "arm64" });
    const firstLauncher = readFileSync(join(targetDir, "dohc-mcp"), "utf8");
    const firstModule = referencedModuleName(targetDir);

    writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    failLauncherPublish = true;

    const onError = vi.fn();
    const result = await refreshLinuxStableCliBin({ resourcesCliBinDir, targetDir, arch: "arm64", onError });
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
    const result = await refreshLinuxStableCliBin({ resourcesCliBinDir, targetDir, arch: "arm64", onError });
    expect(result).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
