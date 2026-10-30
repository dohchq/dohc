import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { stageEngineReader, requireEngineReader } from "./stage-engine-reader.mjs";
import { readPinnedCompilerNode } from "./stage-app-compiler.mjs";
import { installedReaderConfig } from "../src/workspaces/installedReaderConfig.ts";

const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder/package.json"));
builder("app-builder-lib");
const { getFileMatchers, copyFiles } = builder("app-builder-lib/out/fileMatcher.js");
const { WinPackager } = builder("app-builder-lib/out/winPackager.js");
const desktop = fileURLToPath(new URL("..", import.meta.url));

test("reader generations and staging files stay out of git", () => {
  for (const path of ["resources/engine-reader/selection.json", "resources/engine-reader/.staging-incomplete/node", `resources/engine-reader/${"a".repeat(64)}/reader.cjs`]) {
    assert.equal(execFileSync("git", ["check-ignore", "--no-index", path], { cwd: desktop, encoding: "utf8" }).trim(), path);
  }
});

test("unsupported reader targets leave desktop and self-host preparation available", async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-reader-unsupported-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [platform, arch] of [["darwin", "x64"], ["darwin", "ia32"], ["linux", "arm64"], ["win32", "arm64"], ["freebsd", "x64"]]) {
    assert.deepEqual(await stageEngineReader({ resources: root, platform, arch, selfHost: true }), { supported: false });
    assert.equal(await requireEngineReader(root, platform, arch), undefined);
    assert.deepEqual(await readdir(root), []);
  }
  assert.equal(installedReaderConfig("/absent", "darwin"), undefined);
  assert.equal(installedReaderConfig("/absent", "win32"), undefined);
});

test("Windows signing keeps the pinned OpenJS Node executable unchanged", async () => {
  const config = load(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const packager = { platformSpecificBuildOptions: config.win };
  for (const fallback of [false, true]) {
    assert.equal(WinPackager.prototype.shouldSignFile.call(packager, "C:\\app\\resources\\app-compiler\\node.exe", fallback), false);
    assert.equal(WinPackager.prototype.shouldSignFile.call(packager, "C:\\app\\resources\\workspace-engine\\dohc-workspace-engine.exe", fallback), true);
  }
});

for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"]]) test(`${platform}-${arch} download checksum fails before extraction or execution`, async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-reader-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(stageEngineReader({ resources: root, platform, arch,
    fetchNode: async () => new Response("wrong archive") }), /checksum mismatch/);
});

for (const [platform, arch] of [["win32", "x64"], ["linux", "x64"], ["darwin", "arm64"]]) test(`${platform}-${arch} packaged resources contain the verified reader closure`,
  { timeout: 180000, skip: process.platform !== "win32" && platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-reader-layout-"));
  t.after(async () => {
    // Permit cleanup after a test injects a protected retired generation.
    for (const path of [join(root, "source/resources/engine-reader"), join(root, "packaged/engine-reader"), join(root, "dohc.app/Contents/Resources/engine-reader")]) {
      const { readdir } = await import("node:fs/promises");
      for (const entry of await readdir(path).catch(() => [])) await chmod(join(path, entry), 0o700).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  const resources = join(root, "source/resources");
  if (platform === "win32") {
    await mkdir(join(resources, "app-compiler"), { recursive: true });
    await writeFile(join(resources, "app-compiler/node.exe"), await readPinnedCompilerNode({ stagedNodePaths: [join(desktop, "resources/app-compiler/node.exe")] }));
  }
  const staged = await stageEngineReader({ resources, platform, arch });
  assert.equal(staged.supported, true);
  if (process.platform === "win32") assert.ok((await stat(dirname(staged.bundle))).mode & 0o200, "a Windows generation folder stays removable");
  const before = await stat(staged.bundle);
  assert.deepEqual(await stageEngineReader({ resources, platform, arch }), staged);
  assert.equal((await stat(staged.bundle)).mtimeMs, before.mtimeMs);
  if (platform !== "win32") {
    assert.deepEqual(await stageEngineReader({ resources, platform, arch, fetchNode: () => { throw Error("must reuse selected closure"); } }), staged);
  }
  const base = join(resources, "engine-reader");
  await t.test("preparation preserves another run's recent staging and generation", async () => {
    const names = ["b".repeat(64), ".staging-active", ".selection-active.json"];
    for (const name of names.slice(0, 2)) await mkdir(join(base, name));
    await writeFile(join(base, names[2]), "in progress");
    await stageEngineReader({ resources, platform, arch });
    for (const name of names) await stat(join(base, name));
    for (const name of names) await rm(join(base, name), { recursive: true });
  });
  await t.test("preparation removes old generations and interrupted staging files", async () => {
    for (const name of ["a".repeat(64), ".staging-abandoned"]) {
      await mkdir(join(base, name));
      await writeFile(join(base, name, "leftover"), "unused");
      await chmod(join(base, name), 0o555);
      await utimes(join(base, name), 1, 1);
    }
    await writeFile(join(base, ".selection-old.json"), "unused");
    await utimes(join(base, ".selection-old.json"), 1, 1);
    await stageEngineReader({ resources, platform, arch });
    assert.deepEqual((await readdir(base)).sort(), [staged.generation, "selection.json"].sort());
  });
  await t.test("preparation repairs a corrupt existing generation before selecting it", async () => {
    await writeFile(staged.bundle, "corrupt existing bundle");
    assert.deepEqual(await stageEngineReader({ resources, platform, arch }), staged);
    await requireEngineReader(resources, platform, arch);
  });
  const config = load(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const extraResources = config.extraResources.filter(e => e.from === "resources/engine-reader" || e.from === "resources/app-compiler");
  assert.equal(extraResources.length, 2);
  const packaged = join(root, "packaged");
  await copyFiles(getFileMatchers({ extraResources }, "extraResources", packaged, {
    defaultSrc: join(root, "source"), globalOutDir: packaged, customBuildOptions: {}, macroExpander: x => x,
  }));
  // Updaters replace every packaged file, and macOS ShipIt cannot clear quarantine from a read-only one.
  for (const entry of await readdir(join(packaged, "engine-reader"), { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile()) assert.ok((await stat(path)).mode & 0o200, `${path} is owner-writable`);
  }
  await t.test("plain rm deletes the staged layout without mode repair", async () => {
    await rm(join(root, "source"), { recursive: true, force: true });
  });
  const installed = await requireEngineReader(packaged, platform, arch);
  assert.deepEqual(JSON.parse(installedReaderConfig(packaged, platform, arch)), installed);
  assert.equal(installedReaderConfig(packaged, platform, "ia32"), undefined);
  assert.equal(installed.node, platform === "win32" ? join(packaged, "app-compiler/node.exe") : join(packaged, "engine-reader", staged.generation, "node"));
  // Every packaged asset fails closed before engine launch.
  for (const key of ["bundle", "node", "manifest"]) {
    const file = installed[key], backup = `${file}.saved`;
    await rename(file, backup);
    await assert.rejects(requireEngineReader(packaged, platform, arch), /ENOENT/);
    await mkdir(file);
    await assert.rejects(requireEngineReader(packaged, platform, arch), /regular file/);
    await rm(file, { recursive: true });
    await writeFile(file, "changed");
    await assert.rejects(requireEngineReader(packaged, platform, arch));
    await rm(file);
    await rename(backup, file);
  }
  const manifest = JSON.parse(await readFile(installed.manifest, "utf8"));
  assert.ok(manifest.sources.some(source => source.path === "packages/ydoc-projection/scripts/build-engine-reader.mjs"));
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.runtime).filter(([key]) => key !== "sha256")),
    { version: "24.16.0", platform, arch, unicode: "17.0", icu: "78.3" });
  for (const key of ["version", "platform", "arch", "unicode", "icu"]) {
    const changed = structuredClone(manifest);
    changed.runtime[key] = "wrong";
    const { sources, buildSha256, ...identity } = changed;
    changed.buildSha256 = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const oldRoot = join(packaged, "engine-reader", staged.generation);
    const newRoot = join(packaged, "engine-reader", changed.buildSha256);
    await chmod(oldRoot, 0o700);
    await writeFile(installed.manifest, JSON.stringify(changed));
    await rename(oldRoot, newRoot);
    await writeFile(join(packaged, "engine-reader/selection.json"), JSON.stringify({ generation: changed.buildSha256 }));
    await assert.rejects(requireEngineReader(packaged, platform, arch), /identity mismatch/);
    await rename(newRoot, oldRoot);
    await writeFile(installed.manifest, JSON.stringify(manifest));
    await chmod(oldRoot, 0o755);
    await writeFile(join(packaged, "engine-reader/selection.json"), JSON.stringify({ generation: staged.generation }));
  }
  // Preserve an optional, task-owned layout for native engine integration.
  if (process.env.DOHC_READER_TEST_LAYOUT) {
    const { cp } = await import("node:fs/promises");
    await cp(packaged, join(process.env.DOHC_READER_TEST_LAYOUT, platform === "darwin" ? `${platform}-${arch}` : platform), { recursive: true });
  }
  await t.test("plain rm deletes the packaged layout without mode repair", async () => {
    await rm(packaged, { recursive: true, force: true });
  });
});

test("macOS signing uses the reader hook without enabling Electron Node mode", async () => {
  const config = load(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  assert.equal(config.mac.sign, "scripts/sign-engine-reader-macos.mjs");
  assert.equal(config.electronFuses.runAsNode, false);
  await builder("app-builder-lib/out/util/config/config.js").validateConfiguration(config);
  const hook = await builder("app-builder-lib/out/util/resolve.js").resolveFunction("module", join(desktop, config.mac.sign), "sign", desktop);
  assert.equal(typeof hook, "function");
});

test("the reader has no Intel Mac runtime pin", async () => {
  const { PINNED_NODE } = await import("./pinned-node.mjs");
  assert.equal(PINNED_NODE["darwin-x64"], undefined);
});
