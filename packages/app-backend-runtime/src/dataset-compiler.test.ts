import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { compileDatasetOperations } from "./dataset-compiler";

const require = createRequire(import.meta.url);
const esbuildRequire = createRequire(require.resolve("esbuild"));
const executablePath = esbuildRequire.resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`);
describe("shared dataset compiler", () => {
  it("emits identical approved bytes through installed and packaged executable selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-dataset-compiler-"));
    try {
      const packaged = join(root, process.platform === "win32" ? "esbuild.exe" : "esbuild");
      await cp(executablePath, packaged);
      await cp(new URL("../dist/dataset-compiler.mjs", import.meta.url), join(root, "compiler.mjs"));
      await writeFile(join(root, "run.mjs"), `import {readFile} from 'node:fs/promises';import {compileDatasetOperations} from './compiler.mjs';const input=JSON.parse(await readFile(new URL('./input.json',import.meta.url),'utf8'));process.stdout.write(await compileDatasetOperations(input.source,input.path,{executablePath:process.argv[2]}));`);
    for (const [source, path] of [
      ["globalThis.operations={read(){return {value:1};}};", "data/operations.js"],
      [await readFile(new URL("../../../examples/fundraiser/backend.ts", import.meta.url), "utf8"), "fundraiser/backend.ts"],
    ]) {
      await writeFile(join(root, "input.json"), JSON.stringify({ source, path }));
      const { stdout } = await promisify(execFile)(process.execPath, [join(root, "run.mjs"), packaged], { windowsHide: true, encoding: "utf8" });
      expect(stdout).toBe(await compileDatasetOperations(source!, path!));
    }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([
    'import value from "./private";globalThis.operations={read(){return value;}};',
    'globalThis.operations={read(){return import("https://example.com/source.js");}};',
    'const load=require;globalThis.operations={read(){return load("fs");}};',
    'globalThis.operations={read(){return require("node:fs");}};',
  ])("refuses module loading without resolving any filesystem dependency", async source => {
    await expect(compileDatasetOperations(source, "data/operations.ts")).rejects.toThrow();
  });
  it("honors cancellation before spawning", async () => {
    const signal = AbortSignal.abort();
    await expect(compileDatasetOperations("globalThis.operations={};", "data/operations.js", { signal })).rejects.toThrow();
  });
});
