import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { stageEngineReader, requireEngineReader } from "./stage-engine-reader.mjs";
import { readPinnedCompilerNode } from "./stage-app-compiler.mjs";
import { installedReaderConfig } from "../src/workspaces/installedReaderConfig.ts";

const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder/package.json"));
const { getFileMatchers, copyFiles } = builder("app-builder-lib/out/fileMatcher.js");
const desktop = fileURLToPath(new URL("..", import.meta.url));

test("macOS has no reader and unsupported architectures fail preparation", async () => {
  assert.deepEqual(await stageEngineReader({ platform: "darwin" }), { supported: false });
  await assert.rejects(stageEngineReader({ platform: "linux", arch: "arm64" }), /x64/);
  assert.equal(installedReaderConfig("/absent", "darwin"), undefined);
  assert.equal(installedReaderConfig("/absent", "win32"), undefined);
});

test("Linux download checksum fails before extraction or execution", async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-reader-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(stageEngineReader({ resources: root, platform: "linux", arch: "x64",
    fetchNode: async () => new Response("wrong archive") }), /checksum mismatch/);
});

for (const platform of ["win32", "linux"]) test(`${platform} packaged resources contain the verified reader closure`,
  { timeout: 180000, skip: process.platform !== "win32" && platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-reader-layout-"));
  t.after(async () => {
    // Generations are read-only; only their trusted owner removes retired builds.
    for (const path of [join(root, "source/resources/engine-reader"), join(root, "packaged/engine-reader")]) {
      const { readdir } = await import("node:fs/promises");
      for (const entry of await readdir(path).catch(() => [])) await chmod(join(path, entry), 0o700).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  const resources = join(root, "source/resources");
  if (platform === "win32") {
    await mkdir(join(resources, "app-compiler"), { recursive: true });
    await writeFile(join(resources, "app-compiler/node.exe"), await readPinnedCompilerNode({ stagedNodePath: join(desktop, "resources/app-compiler/node.exe") }));
  }
  const staged = await stageEngineReader({ resources, platform, arch: "x64" });
  const before = await stat(staged.bundle);
  assert.deepEqual(await stageEngineReader({ resources, platform, arch: "x64" }), staged);
  assert.equal((await stat(staged.bundle)).mtimeMs, before.mtimeMs);
  const config = load(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const extraResources = config.extraResources.filter(e => e.from === "resources/engine-reader" || e.from === "resources/app-compiler");
  assert.equal(extraResources.length, 2);
  const packaged = join(root, "packaged");
  await copyFiles(getFileMatchers({ extraResources }, "extraResources", packaged, {
    defaultSrc: join(root, "source"), globalOutDir: packaged, customBuildOptions: {}, macroExpander: x => x,
  }));
  await chmod(join(resources, "engine-reader", staged.generation), 0o700);
  await rm(join(root, "source"), { recursive: true, force: true });
  const installed = await requireEngineReader(packaged, platform, "x64");
  assert.deepEqual(JSON.parse(installedReaderConfig(packaged, platform)), installed);
  assert.equal(installed.node, platform === "win32" ? join(packaged, "app-compiler/node.exe") : join(packaged, "engine-reader", staged.generation, "node"));
  // Every packaged asset fails closed before engine launch.
  for (const key of ["bundle", "node", "manifest"]) {
    const file = installed[key], backup = `${file}.saved`;
    await rename(file, backup);
    await assert.rejects(requireEngineReader(packaged, platform, "x64"), /ENOENT/);
    await mkdir(file);
    await assert.rejects(requireEngineReader(packaged, platform, "x64"), /regular file/);
    await rm(file, { recursive: true });
    await writeFile(file, "changed");
    await assert.rejects(requireEngineReader(packaged, platform, "x64"));
    await rm(file);
    await rename(backup, file);
  }
  const manifest = JSON.parse(await readFile(installed.manifest, "utf8"));
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.runtime).filter(([key]) => key !== "sha256")),
    { version: "24.16.0", platform, arch: "x64", unicode: "17.0", icu: "78.3" });
  for (const key of ["version", "unicode", "icu"]) {
    const changed = structuredClone(manifest);
    changed.runtime[key] = "wrong";
    const { sources, buildSha256, ...identity } = changed;
    changed.buildSha256 = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const oldRoot = join(packaged, "engine-reader", staged.generation);
    const newRoot = join(packaged, "engine-reader", changed.buildSha256);
    await chmod(oldRoot, 0o700);
    await chmod(installed.manifest, 0o600);
    await writeFile(installed.manifest, JSON.stringify(changed));
    await rename(oldRoot, newRoot);
    await writeFile(join(packaged, "engine-reader/selection.json"), JSON.stringify({ generation: changed.buildSha256 }));
    await assert.rejects(requireEngineReader(packaged, platform, "x64"), /identity mismatch/);
    await rename(newRoot, oldRoot);
    await writeFile(installed.manifest, JSON.stringify(manifest));
    await chmod(installed.manifest, 0o444);
    await chmod(oldRoot, 0o555);
    await writeFile(join(packaged, "engine-reader/selection.json"), JSON.stringify({ generation: staged.generation }));
  }
  // Preserve an optional, task-owned layout for native engine integration.
  if (process.env.DOHC_READER_TEST_LAYOUT) {
    const { cp } = await import("node:fs/promises");
    await cp(packaged, join(process.env.DOHC_READER_TEST_LAYOUT, platform), { recursive: true });
  }
});
