import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
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
import { bundledPosixLauncher, posixMcpLauncher } from "../../scripts/mcp-launchers.mjs";
import {
  hasIntactStableCliBin,
  refreshLinuxStableCliBin,
  syncLinuxStableCliBin,
} from "./linuxStableCliBin";

const scratchDirs: string[] = [];
let failLauncherPublish = false;
let failCopy: "node" | "module" | undefined;
const pin = vi.hoisted(() => ({ sha256: "", nodeVersion: "24.16.0" }));
vi.mock("../../scripts/pinned-node.mjs", () => ({
  NODE_VERSION: pin.nodeVersion,
  PINNED_NODE: { "linux-x64": { get sha256() { return pin.sha256; } } },
}));

function x64Fixture() {
  const root = mkdtempSync(join(tmpdir(), "dohc-linux-x64-"));
  scratchDirs.push(root);
  const resourcesCliBinDir = join(root, "resources", "cli-bin");
  const targetDir = join(root, "state", "cli-bin");
  const compiler = join(root, "resources", "app-compiler");
  mkdirSync(resourcesCliBinDir, { recursive: true });
  mkdirSync(compiler);
  const node = join(compiler, "node");
  function runtime(bytes = "runtime-v1") {
    writeFileSync(node, bytes, { mode: 0o755 });
    writeManifest(createHash("sha256").update(bytes).digest("hex"));
  }
  function writeManifest(hash: string) {
    pin.sha256 = hash;
    writeFileSync(join(compiler, "manifest.json"), JSON.stringify({ platform: "linux", arch: "x64", nodeVersion: pin.nodeVersion, nodeSha256: pin.sha256, files: { node: pin.sha256 } }));
  }
  async function manifest() {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(node)) hash.update(bytes);
    writeManifest(hash.digest("hex"));
  }
  runtime();
  writeFileSync(join(resourcesCliBinDir, "dohc-mcp.mjs"), "module-v1");
  return { root, node, compiler, targetDir, resourcesCliBinDir, runtime, manifest, arch: "x64" };
}

function x64Names(targetDir: string) {
  const launcher = readFileSync(join(targetDir, "dohc-mcp"), "utf8");
  const node = /\/(node-[a-f0-9]{64})"/.exec(launcher)?.[1];
  const module = /\/(dohc-mcp-[a-f0-9]{16}\.mjs)"/.exec(launcher)?.[1];
  if (!node || !module) throw new Error("No immutable runtime and module in launcher");
  return { node, module, launcher };
}

describe("Linux x64 immutable runtime publication", () => {
  it("publishes the matching set and never recopies an unchanged Node", async () => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    const first = x64Names(f.targetDir);
    const before = statSync(join(f.targetDir, first.node));
    failCopy = "node";
    await syncLinuxStableCliBin(f);
    failCopy = undefined;
    const after = statSync(join(f.targetDir, first.node));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await hasIntactStableCliBin(f.targetDir, "x64")).toBe(true);
    f.runtime("runtime-v2");
    writeFileSync(join(f.resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    await syncLinuxStableCliBin(f);
    const next = x64Names(f.targetDir);
    expect(next.node).not.toBe(first.node);
    expect(next.module).not.toBe(first.module);
    expect(readFileSync(join(f.targetDir, first.node), "utf8")).toBe("runtime-v1");
    expect(readFileSync(join(f.targetDir, next.node), "utf8")).toBe("runtime-v2");
  });

  it.each(["node", "module", "launcher"] as const)("keeps the previous complete set after %s publication fails", async (stage) => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    const first = x64Names(f.targetDir);
    f.runtime("runtime-v2");
    writeFileSync(join(f.resourcesCliBinDir, "dohc-mcp.mjs"), "module-v2");
    if (stage === "launcher") failLauncherPublish = true;
    else failCopy = stage;
    expect(await refreshLinuxStableCliBin(f)).toBe(f.targetDir);
    expect(x64Names(f.targetDir)).toEqual(first);
    expect(await hasIntactStableCliBin(f.targetDir, "x64")).toBe(true);
    expect(readdirSync(f.targetDir).filter(name => name.includes(".tmp-"))).toEqual([]);
    const names = readdirSync(f.targetDir);
    expect(names.includes(`node-${pin.sha256}`)).toBe(stage !== "node");
    const newModules = names.filter(name => name.endsWith(".mjs") && name !== first.module);
    expect(newModules.length).toBe(stage === "launcher" ? 1 : 0);
  });

  it("does not adopt an old PATH pair after an x64 refresh fails", async () => {
    const f = x64Fixture();
    await syncLinuxStableCliBin({ ...f, arch: "arm64" });
    failCopy = "node";
    expect(await refreshLinuxStableCliBin(f)).toBeUndefined();
    expect(await hasIntactStableCliBin(f.targetDir, "x64")).toBe(false);
    expect(await hasIntactStableCliBin(f.targetDir, "arm64")).toBe(true);
  });

  it.each(["version", "pin", "file", "target"])("refuses a compiler manifest with the wrong %s", async (field) => {
    const f = x64Fixture();
    const manifest = JSON.parse(readFileSync(join(f.compiler, "manifest.json"), "utf8"));
    if (field === "version") manifest.nodeVersion = "0.0.0";
    if (field === "pin") manifest.nodeSha256 = "0".repeat(64);
    if (field === "file") manifest.files.node = "0".repeat(64);
    if (field === "target") manifest.arch = "arm64";
    writeFileSync(join(f.compiler, "manifest.json"), JSON.stringify(manifest));
    await expect(syncLinuxStableCliBin(f)).rejects.toThrow();
    expect(existsSync(join(f.targetDir, "dohc-mcp"))).toBe(false);
  });

  it.each(["tampered", "empty", "directory"])("refuses a %s installed runtime even with a valid manifest", async (damage) => {
    const f = x64Fixture();
    if (damage === "tampered") appendFileSync(f.node, "changed");
    if (damage === "empty") writeFileSync(f.node, "");
    if (damage === "directory") { rmSync(f.node); mkdirSync(f.node); }
    await expect(syncLinuxStableCliBin(f)).rejects.toThrow();
    expect(existsSync(join(f.targetDir, "dohc-mcp"))).toBe(false);
  });

  it.each(["node", "module", "directory", "empty", "traversal", "absolute", "extra"])("intactness rejects %s damage", async (damage) => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    const names = x64Names(f.targetDir);
    if (damage === "node") writeFileSync(join(f.targetDir, names.node), "corrupt");
    if (damage === "module") writeFileSync(join(f.targetDir, names.module), "corrupt");
    if (damage === "empty") writeFileSync(join(f.targetDir, names.node), "");
    if (damage === "directory") {
      rmSync(join(f.targetDir, names.node));
      mkdirSync(join(f.targetDir, names.node));
    }
    if (damage === "traversal") writeFileSync(join(f.targetDir, "dohc-mcp"), bundledPosixLauncher(`../${names.module}`, names.node));
    if (damage === "absolute") writeFileSync(join(f.targetDir, "dohc-mcp"), bundledPosixLauncher(names.module, "/tmp/node"));
    if (damage === "extra") appendFileSync(join(f.targetDir, "dohc-mcp"), "echo surprise\n");
    expect(await hasIntactStableCliBin(f.targetDir, "x64")).toBe(false);
  });

  it("missing Node prevents fallback to a previously published set", async () => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    rmSync(join(f.targetDir, x64Names(f.targetDir).node));
    renameSync(join(f.root, "resources"), join(f.root, "unmounted-resources"));
    expect(await refreshLinuxStableCliBin(f)).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("intactness requires executable Node and launcher files", async () => {
    const f = x64Fixture();
    await syncLinuxStableCliBin(f);
    const names = x64Names(f.targetDir);
    chmodSync(join(f.targetDir, names.node), 0o600);
    expect(await hasIntactStableCliBin(f.targetDir, "x64")).toBe(false);
    chmodSync(join(f.targetDir, names.node), 0o755);
    chmodSync(join(f.targetDir, "dohc-mcp"), 0o600);
    expect(await hasIntactStableCliBin(f.targetDir, "x64")).toBe(false);
  });

  it("the real stable launcher runs after unmount and adopts a matching updated runtime/module", async () => {
    const f = x64Fixture();
    const sh = process.platform === "win32" ? "C:/Program Files/Git/bin/sh.exe" : "/bin/sh";
    copyFileSync(process.execPath, f.node);
    await f.manifest();
    const moduleText = (generation: number) => `console.log(JSON.stringify({generation:${generation},execPath:process.execPath}));`;
    writeFileSync(join(f.resourcesCliBinDir, "dohc-mcp.mjs"), moduleText(1));
    await syncLinuxStableCliBin(f);
    const first = x64Names(f.targetDir);
    renameSync(join(f.root, "resources"), join(f.root, "unmounted"));
    const run = () => {
      const result = spawnSync(sh, [join(f.targetDir, "dohc-mcp").replaceAll("\\", "/")], { env: { ...process.env, PATH: f.targetDir, Path: f.targetDir, NODE_OPTIONS: "" }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    expect(run()).toEqual({ generation: 1, execPath: join(f.targetDir, first.node) });
    renameSync(join(f.root, "unmounted"), join(f.root, "resources"));
    appendFileSync(f.node, "\0fixture-generation-2");
    await f.manifest();
    writeFileSync(join(f.resourcesCliBinDir, "dohc-mcp.mjs"), moduleText(2));
    await syncLinuxStableCliBin(f);
    const second = x64Names(f.targetDir);
    expect(second.node).not.toBe(first.node);
    renameSync(join(f.root, "resources"), join(f.root, "unmounted"));
    expect(run()).toEqual({ generation: 2, execPath: join(f.targetDir, second.node) });
    expect(existsSync(join(f.targetDir, first.node))).toBe(true);
  });
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: (async (...args: Parameters<typeof actual.copyFile>) => {
      const source = String(args[0]);
      if (failCopy === "node" && basename(source) === "node" || failCopy === "module" && source.endsWith("dohc-mcp.mjs")) {
        await actual.writeFile(String(args[1]), "partial-copy");
        throw new Error(`${failCopy} publish failed`);
      }
      return actual.copyFile(...args);
    }) as typeof actual.copyFile,
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
  failCopy = undefined;
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
    expect(await hasIntactStableCliBin(targetDir, "arm64")).toBe(true);
    expect(readdirSync(targetDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});

describe("hasIntactStableCliBin", () => {
  it("requires a non-empty module at the exact path named by the launcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-linux-cli-bin-"));
    scratchDirs.push(root);
    const targetDir = join(root, "state", "cli-bin");
    const moduleFileName = `dohc-mcp-${createHash("sha256").update("module").digest("hex").slice(0, 16)}.mjs`;
    expect(await hasIntactStableCliBin(targetDir, "arm64")).toBe(false);

    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "dohc-mcp"), posixMcpLauncher(moduleFileName));
    expect(await hasIntactStableCliBin(targetDir, "arm64")).toBe(false);

    writeFileSync(join(targetDir, moduleFileName), "");
    expect(await hasIntactStableCliBin(targetDir, "arm64")).toBe(false);

    writeFileSync(join(targetDir, moduleFileName), "module");
    expect(await hasIntactStableCliBin(targetDir, "arm64")).toBe(true);
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

    expect(await hasIntactStableCliBin(targetDir, "arm64")).toBe(false);
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
    expect(await hasIntactStableCliBin(targetDir, "arm64")).toBe(false);

    rmSync(join(targetDir, "dohc-mcp"), { recursive: true });
    const moduleFileName = "dohc-mcp-0123456789abcdef.mjs";
    writeFileSync(join(targetDir, "dohc-mcp"), posixMcpLauncher(moduleFileName));
    mkdirSync(join(targetDir, moduleFileName));
    writeFileSync(join(targetDir, moduleFileName, "not-the-module"), "y");
    expect(await hasIntactStableCliBin(targetDir, "arm64")).toBe(false);
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
    expect(await hasIntactStableCliBin(targetDir, "arm64")).toBe(true);
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
