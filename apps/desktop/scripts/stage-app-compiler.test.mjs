import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { load } from "js-yaml";
import { createInstalledAppCompiler } from "../src/workspaces/installedAppCompiler.ts";
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
  assert.deepEqual(await stageAppCompiler({ platform: "win32", arch: "arm64" }), { supported: false });
  await assert.rejects(requireAppCompiler(root, "win32", "arm64"), /Windows x64/);
  await assert.rejects(requireAppCompiler(root, "win32", "x64"), /ENOENT/);
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
  const bounds = { timeoutMs: 15000, maxMemoryBytes: 256 * 1024 * 1024, maxProcesses: 8, maxInputBytes: 8192, maxOutputBytes: 16384, maxErrorBytes: 8192 };
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
