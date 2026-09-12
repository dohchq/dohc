import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstalledAppCompiler } from "../src/workspaces/installedAppCompiler.ts";
import { stageAppCompiler, requireAppCompiler, readPinnedCompilerNode, NODE_SHA256 } from "./stage-app-compiler.mjs";

test("staging refuses an unpinned executable without running it", async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-compiler-bad-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeExecutable = join(root, "node.exe"); await writeFile(nodeExecutable, "not Node");
  await assert.rejects(stageAppCompiler({ platform: "win32", arch: "x64", nodeExecutable, destination: join(root, "staged") }), /official Node/);
  assert.deepEqual(await stageAppCompiler({ platform: "win32", arch: "arm64" }), { supported: false });
  await assert.rejects(requireAppCompiler(root, "win32", "arm64"), /Windows x64/);
  await assert.rejects(requireAppCompiler(root, "win32", "x64"), /ENOENT/);
});

test("installed compiler runs only staged resources after relocation and checks packaging identities", { skip: process.platform !== "win32" || process.arch !== "x64", timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-installed-compiler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "app-compiler");
  await stageAppCompiler({ destination });
  assert.equal(createHash("sha256").update(await readFile(join(destination, "node.exe"))).digest("hex"), NODE_SHA256);
  assert.equal((await stageAppCompiler({ destination })).changed, false);
  await requireAppCompiler(destination);
  const compile = await createInstalledAppCompiler(root);
  const bytes = Buffer.from("import './style.css'; document.body.textContent = 'installed';");
  const style = Buffer.from("body { color: green }");
  const file = (path, bytes) => ({ path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  const request = { entryPath: "main.ts", inputs: [file("main.ts", bytes), file("style.css", style)], bounds: { maxInputFiles: 8, maxInputBytes: 4096, maxOutputBytes: 8192 } };
  const bounds = { timeoutMs: 15000, maxMemoryBytes: 256 * 1024 * 1024, maxProcesses: 8, maxInputBytes: 8192, maxOutputBytes: 16384, maxErrorBytes: 8192 };
  const original = process.env.PATH;
  process.env.PATH = "";
  try {
    const pending = compile(request, bounds);
    bytes.fill(0); bounds.maxOutputBytes = 1;
    const result = await pending;
    assert.deepEqual(result.files.map(file => file.path), ["bundle.css", "bundle.js"]);
    assert.match(Buffer.from(result.files[1].bytes).toString(), /installed/);
    await assert.rejects(compile(request, bounds, AbortSignal.abort()), { reason: "cancelled" });
  } finally { if (original === undefined) delete process.env.PATH; else process.env.PATH = original; }
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
