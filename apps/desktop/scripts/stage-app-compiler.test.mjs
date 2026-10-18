import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { load } from "js-yaml";
import { createInstalledAppCompiler } from "../src/workspaces/installedAppCompiler.ts";
import { createInstalledDatasetCompiler } from "../src/workspaces/installedDatasetCompiler.ts";
import { stageAppCompiler, requireAppCompiler, readPinnedCompilerNode, NODE_SHA256 } from "./stage-app-compiler.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const { getFileMatchers, copyFiles } = builderRequire("app-builder-lib/out/fileMatcher.js");

async function packageCompiler(sourceRoot, resourcesRoot) {
  const config = load(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const extraResources = config.extraResources.filter(entry =>
    entry.from === "resources/app-compiler" || entry.from.startsWith("resources/app-compiler/"));
  const matchers = getFileMatchers({ extraResources }, "extraResources", resourcesRoot, {
    defaultSrc: sourceRoot, globalOutDir: resourcesRoot,
    customBuildOptions: {}, macroExpander: value => value,
  });
  await copyFiles(matchers);
}

test("staging refuses an unpinned executable without running it", async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-compiler-bad-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeExecutable = join(root, "node.exe"); await writeFile(nodeExecutable, "not Node");
  await assert.rejects(stageAppCompiler({ platform: "win32", arch: "x64", nodeExecutable, destination: join(root, "staged") }), /official Node/);
  for (const [platform, arch] of [["win32", "arm64"], ["linux", "arm"], ["freebsd", "x64"]]) {
    assert.deepEqual(await stageAppCompiler({ platform, arch }), { supported: false });
  }
  await assert.rejects(requireAppCompiler(root, "win32", "arm64"), /Windows x64/);
  for (const [platform, arch] of [["win32", "x64"], ["linux", "x64"], ["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"]]) {
    await assert.rejects(requireAppCompiler(root, platform, arch), /ENOENT/);
  }
  assert.equal(await requireAppCompiler(root, "linux", "arm"), undefined);
  // Default installs carry only the host's esbuild binary; another target names the install that adds it.
  const foreign = process.platform === "linux" ? "darwin" : "linux";
  await assert.rejects(stageAppCompiler({ platform: foreign, arch: "arm64", destination: join(root, "foreign") }),
    { message: `App compiler requires @esbuild/${foreign}-arm64. Install it with pnpm install --cpu=current --cpu=arm64.` });
});

const posixTarget = ["darwin", "linux"].includes(process.platform) && ["arm64", "x64"].includes(process.arch);
test("installed macOS and Linux Collection compiler runs electron-builder resources after relocation", { skip: !posixTarget, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-installed-dataset-compiler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  const staged = join(sourceRoot, "resources/app-compiler");
  await stageAppCompiler({ destination: staged });
  assert.equal((await stageAppCompiler({ destination: staged })).changed, false);
  const resourcesRoot = join(root, "packaged/resources");
  await packageCompiler(sourceRoot, resourcesRoot);
  await rm(sourceRoot, { recursive: true, force: true });
  const destination = join(resourcesRoot, "app-compiler");
  await requireAppCompiler(destination);
  // Packaging for the other architecture needs that architecture's binary.
  await assert.rejects(requireAppCompiler(destination, process.platform, process.arch === "x64" ? "arm64" : "x64"), /does not match/);
  const binary = join(destination, `node_modules/@esbuild/${process.platform}-${process.arch}/bin/esbuild`);
  assert.equal((await stat(binary)).mode & 0o111, 0o111, "every user can run the packaged binary");
  await build({ entryPoints: [fileURLToPath(new URL("../../../packages/app-backend-runtime/src/dataset-compiler.ts", import.meta.url))],
    outfile: join(resourcesRoot, "app-backend-runtime/dataset-compiler.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const compile = await createInstalledDatasetCompiler(resourcesRoot);
  assert.match(await compile("const answer: number = 42; globalThis.answer = answer;", "actions.ts", AbortSignal.timeout(10000)), /answer = 42/);
  await writeFile(binary, "changed");
  await assert.rejects(requireAppCompiler(destination), /asset changed/);
});

test("installed compiler runs electron-builder resources after relocation and checks packaging identities", { skip: process.platform !== "win32" || process.arch !== "x64", timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-installed-compiler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  const staged = join(sourceRoot, "resources/app-compiler");
  await stageAppCompiler({ destination: staged });
  assert.equal((await stageAppCompiler({ destination: staged })).changed, false);
  const resourcesRoot = join(root, "packaged/resources");
  await packageCompiler(sourceRoot, resourcesRoot);
  await rm(sourceRoot, { recursive: true, force: true });
  const destination = join(resourcesRoot, "app-compiler");
  assert.equal(createHash("sha256").update(await readFile(join(destination, "node.exe"))).digest("hex"), NODE_SHA256);
  await requireAppCompiler(destination);
  const compile = await createInstalledAppCompiler(resourcesRoot);
  const bytes = Buffer.from("import './style.css'; document.body.textContent = 'installed';");
  const style = Buffer.from("body { color: green }");
  const file = (path, bytes) => ({ path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  const request = { entryPath: "main.ts", inputs: [file("main.ts", bytes), file("style.css", style)], bounds: { maxInputFiles: 8, maxInputBytes: 4096, maxOutputBytes: 8192 } };
  // A loaded gate took 17.6 s to start a compiler owner and worker.
  const bounds = { timeoutMs: 20000, maxMemoryBytes: 256 * 1024 * 1024, maxProcesses: 8, maxInputBytes: 8192, maxOutputBytes: 16384, maxErrorBytes: 8192 };
  const environmentKeys = ["PATH", "NODE_PATH", "NODE_OPTIONS", "ESBUILD_BINARY_PATH"];
  const original = new Map(environmentKeys.map(key => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  process.env.PATH = "";
  try {
    const pending = compile(request, bounds);
    bytes.fill(0); bounds.maxOutputBytes = 1;
    const result = await pending;
    assert.deepEqual(result.files.map(file => file.path), ["bundle.css", "bundle.js"]);
    assert.match(Buffer.from(result.files[1].bytes).toString(), /installed/);
    await assert.rejects(compile(request, bounds, AbortSignal.abort()), { reason: "cancelled" });
    const pageBounds = { ...bounds, maxOutputBytes: 16384 };
    const page = await compile({ ...request, entryPath: "index.html", inputs: [file("index.html", Buffer.from('<!doctype html><link rel="stylesheet" href="style.css"><p>page</p>')), file("style.css", style)] }, pageBounds);
    assert.deepEqual(page.files.map(file => file.path), ["bundle.js", "page.json"]);
    const record = JSON.parse(Buffer.from(page.files[1].bytes).toString());
    assert.equal(record.body, "<body><p>page</p></body>");
    assert.match(record.head, /^<style>[\s\S]*color: green[\s\S]*<\/style>$/);
    await assert.rejects(compile({ ...request, entryPath: "index.html", inputs: [file("index.html", Buffer.from('<!doctype html><script src="missing.js"></script>'))] }, pageBounds),
      { message: "index.html links missing.js, which is not in the app. Add the file or fix the link." });
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  await writeFile(join(destination, "worker.mjs"), "changed");
  await assert.rejects(requireAppCompiler(destination), /asset changed/);
});

test("build Node version does not control the pinned runtime and downloads remain bounded", async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-compiler-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentNodeExecutable = join(root, "different-node.exe");
  await writeFile(currentNodeExecutable, "different supported build Node");
  await assert.rejects(readPinnedCompilerNode({ currentNodeExecutable, fetchNode: async url => {
    assert.equal(url, "https://nodejs.org/dist/v24.16.0/win-x64/node.exe"); return new Response("wrong binary");
  } }), /checksum/);
  await assert.rejects(readPinnedCompilerNode({ currentNodeExecutable, fetchNode: async () => new Response("", { headers: { "content-length": String(129 * 1024 * 1024) } }) }), /size bound/);
  // Other platforms exercise refusal paths without downloading a Windows binary.
  if (process.platform !== "win32" || process.arch !== "x64") return;
  const pinned = await readPinnedCompilerNode();
  const stagedNodePath = join(root, "pinned-node.exe"); await writeFile(stagedNodePath, pinned);
  const reused = await readPinnedCompilerNode({ stagedNodePath, currentNodeExecutable, fetchNode: () => { throw new Error("must reuse staged Node"); } });
  assert.equal(createHash("sha256").update(reused).digest("hex"), NODE_SHA256);
  const downloaded = await readPinnedCompilerNode({ currentNodeExecutable, fetchNode: async () => new Response(pinned) });
  assert.equal(createHash("sha256").update(downloaded).digest("hex"), NODE_SHA256);
});
