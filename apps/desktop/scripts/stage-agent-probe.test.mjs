import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load } from "js-yaml";
import { runProbeProcess, windowsProbeOwner } from "../src/agents/agentProbeProcess.ts";
import { resolveSpawnCommand } from "../src/process/windowsSpawn.ts";
import { readPinnedCompilerNode } from "./stage-app-compiler.mjs";
import { requireAgentProbe, stageAgentProbe } from "./stage-agent-probe.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const { getFileMatchers, copyFiles } = builderRequire("app-builder-lib/out/fileMatcher.js");
const desktopRoot = fileURLToPath(new URL("..", import.meta.url));

async function packageResources(sourceRoot, resourcesRoot) {
  const config = load(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const extraResources = config.extraResources.filter(entry => entry.from === "resources/agent-probe" || entry.from === "resources/app-compiler");
  assert.equal(extraResources.length, 2);
  await copyFiles(getFileMatchers({ extraResources }, "extraResources", resourcesRoot, {
    defaultSrc: sourceRoot, globalOutDir: resourcesRoot, customBuildOptions: {}, macroExpander: value => value,
  }));
}

test("agent probe staging refuses unsupported targets and incomplete closures", async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-agent-probe-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await stageAgentProbe({ platform: "win32", arch: "arm64" }), { supported: false });
  assert.deepEqual(await stageAgentProbe({ platform: "linux", arch: "x64" }), { supported: false });
  await requireAgentProbe(root, root, "linux", "x64");
  await assert.rejects(requireAgentProbe(root, root, "win32", "arm64"), /Windows x64/);
  await assert.rejects(requireAgentProbe(root, root, "win32", "x64"), /ENOENT/);
});

test("packaged agent probe runs on the compiler's pinned Node and checks its closure",
  { skip: process.platform !== "win32" || process.arch !== "x64", timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-agent-probe-packaged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  const compilerRoot = join(sourceRoot, "resources/app-compiler");
  await mkdir(compilerRoot, { recursive: true });
  await writeFile(join(compilerRoot, "node.exe"), await readPinnedCompilerNode({ platform: "win32", arch: "x64", stagedNodePaths: [join(desktopRoot, "resources/app-compiler/node.exe")] }));
  const staged = join(sourceRoot, "resources/agent-probe");
  assert.equal((await stageAgentProbe({ destination: staged, compilerRoot })).changed, true);
  assert.equal((await stageAgentProbe({ destination: staged, compilerRoot })).changed, false);
  const resourcesRoot = join(root, "packaged/resources");
  await packageResources(sourceRoot, resourcesRoot);
  await rm(sourceRoot, { recursive: true, force: true });
  const probeRoot = join(resourcesRoot, "agent-probe"), packagedCompiler = join(resourcesRoot, "app-compiler");
  await requireAgentProbe(probeRoot, packagedCompiler);
  const owner = windowsProbeOwner(resourcesRoot);
  assert.equal(owner.node, join(packagedCompiler, "node.exe"));
  const tool = join(root, "tool.cmd");
  await writeFile(tool, "@echo off\r\necho tool 9.8.7\r\n");
  const result = await runProbeProcess(resolveSpawnCommand(tool, ["--version"], { cwd: homedir() }), new AbortController().signal, owner);
  assert.deepEqual(result, { exitCode: 0, stdout: "tool 9.8.7\r\n", stderr: "" });
  const relayPath = join(probeRoot, "agentProbeRelay.mjs"), relay = await readFile(relayPath);
  await writeFile(relayPath, "changed");
  await assert.rejects(requireAgentProbe(probeRoot, packagedCompiler), /asset changed/);
  await writeFile(relayPath, relay);
  await writeFile(join(packagedCompiler, "node.exe"), "not Node");
  await assert.rejects(requireAgentProbe(probeRoot, packagedCompiler), /Node identity/);
  await rm(join(packagedCompiler, "node.exe"));
  assert.throws(() => windowsProbeOwner(resourcesRoot), /missing/);
});

test("agent probe staging recompiles when only its compile recipe changes",
  { skip: process.platform !== "win32" || process.arch !== "x64", timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-agent-probe-recipe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compilerRoot = join(root, "app-compiler"), destination = join(root, "agent-probe");
  await mkdir(compilerRoot, { recursive: true });
  await writeFile(join(compilerRoot, "node.exe"), await readPinnedCompilerNode({ platform: "win32", arch: "x64", stagedNodePaths: [join(desktopRoot, "resources/app-compiler/node.exe")] }));
  // Copies of the real stager read the C# and relay bytes from desktopRoot, so only the recipe differs.
  const stager = (await readFile(new URL("./stage-agent-probe.mjs", import.meta.url), "utf8"))
    .replace("\"./pinned-node.mjs\"", JSON.stringify(new URL("./pinned-node.mjs", import.meta.url).href));
  const unoptimized = stager.replace("\"/optimize+\"", "\"/optimize-\"");
  assert.notEqual(unoptimized, stager);
  const loadStager = async (name, text) => {
    await writeFile(join(root, name), text);
    const { stageAgentProbe } = await import(pathToFileURL(join(root, name)).href);
    return () => stageAgentProbe({ destination, compilerRoot, desktopRoot });
  };
  const stageOptimized = await loadStager("optimized.mjs", stager);
  assert.equal((await stageOptimized()).changed, true);
  assert.equal((await stageOptimized()).changed, false);
  const stageUnoptimized = await loadStager("unoptimized.mjs", unoptimized);
  assert.equal((await stageUnoptimized()).changed, true);
  assert.equal((await stageUnoptimized()).changed, false);
  await requireAgentProbe(destination, compilerRoot);
});
