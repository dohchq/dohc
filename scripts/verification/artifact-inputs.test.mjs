import test from "node:test";
import assert from "node:assert/strict";
import childProcess, {execFileSync} from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {pathToFileURL} from "node:url";
import {artifactSourceFingerprint, directoryFingerprint, sourceFingerprint} from "./build.mjs";
import {createPrepareFixture} from "./prepare-fixture.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dohc-artifact-inputs-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), value);
  };
  execFileSync("git", ["init"], {cwd: root, stdio: "ignore"});
  put("package.json", '{"type":"module"}');
  put("apps/desktop/package.json", JSON.stringify({name: "@dohc/desktop", dependencies: {"@dohc/consumer": "workspace:*"}}));
  put("packages/consumer/package.json", JSON.stringify({name: "@dohc/consumer", dependencies: {"@dohc/security-contract": "workspace:*"}}));
  put("packages/security-contract/package.json", '{"name":"@dohc/security-contract","type":"module"}');
  put("packages/security-contract/src/index.mjs", "export const permission = 'read';");
  put("packages/consumer/src/index.mjs", "export {permission} from '../../security-contract/src/index.mjs';");
  put("apps/desktop/src/main.mjs", "export {permission} from '../../../packages/consumer/src/index.mjs';");
  return {root, put};
}

test("production receipts ignore unconsumed tests while verification still checks them", t => {
  const {root, put} = fixture(t);
  put("apps/desktop/src/main.test.mjs", "const test = 1;");
  put("scripts/verification/other.mjs", "export const check = 1;");
  const artifact = artifactSourceFingerprint("desktop", root);
  const provenance = sourceFingerprint("desktop", root);
  put("apps/desktop/src/main.test.mjs", "const test = 2;");
  put("scripts/verification/other.mjs", "export const check = 2;");
  assert.equal(artifactSourceFingerprint("desktop", root), artifact);
  assert.notEqual(sourceFingerprint("desktop", root), provenance);
});

test("receipts track the actual Git reader and Windows build relay", t => {
  const {root, put} = fixture(t);
  const gitReader = "tools/rust-engine-program/git-read.mjs";
  const relay = "scripts/verification/windows-command.mjs";
  const gitSource = readFileSync(new URL("../../tools/rust-engine-program/git-read.mjs", import.meta.url), "utf8");
  const relaySource = readFileSync(new URL("./windows-command.mjs", import.meta.url), "utf8");
  put(gitReader, gitSource);
  put(relay, relaySource);
  const readGit = () => execFileSync(process.execPath, ["--input-type=module", "-e",
    `import {readGit} from ${JSON.stringify(pathToFileURL(join(root, gitReader)).href)};console.log(readGit(['rev-parse','--show-toplevel'],${JSON.stringify(root)}));`], {encoding: "utf8"});
  const runRelay = () => execFileSync(process.execPath, [join(root, relay)], {
    encoding: "utf8", input: JSON.stringify({nodeOptions: null, payload: Buffer.from(JSON.stringify({
      command: process.execPath, args: ["--input-type=module", "-e", "console.log(process.env.DOHC_TEST_RELAY_VALUE ?? 'original');"],
    })).toString("base64")}),
  });
  const exec = childProcess.execFileSync;
  childProcess.execFileSync = (command, ...args) => command === "rustc" ? Buffer.from("fixture compiler") : exec(command, ...args);
  syncBuiltinESMExports();
  try {
    const fingerprints = () => Object.fromEntries(["engine", "desktop", "runtime"].map(kind => [kind, artifactSourceFingerprint(kind, root)]));
    const beforeGit = fingerprints();
    assert.doesNotMatch(readGit(), /changed-reader/);
    put(gitReader, gitSource.replace("return result.stdout;", "return 'changed-reader:' + result.stdout;"));
    assert.match(readGit(), /changed-reader/);
    const beforeRelay = fingerprints();
    for (const kind of Object.keys(beforeGit)) assert.notEqual(beforeRelay[kind], beforeGit[kind], `${kind} Git reader`);
    assert.equal(runRelay().trim(), "original");
    put(relay, relaySource.replace("const env = { ...process.env };", "const env = { ...process.env, DOHC_TEST_RELAY_VALUE: 'changed-relay' };"));
    assert.equal(runRelay().trim(), "changed-relay");
    const afterRelay = fingerprints();
    for (const kind of Object.keys(beforeRelay)) assert.notEqual(afterRelay[kind], beforeRelay[kind], `${kind} build relay`);
  } finally { childProcess.execFileSync = exec; syncBuiltinESMExports(); }
});

test("production receipts follow a real transitive security consumer", async t => {
  const {root, put} = fixture(t);
  const before = artifactSourceFingerprint("desktop", root);
  const entry = pathToFileURL(join(root, "apps/desktop/src/main.mjs")).href;
  assert.equal((await import(entry)).permission, "read");
  put("packages/security-contract/src/index.mjs", "export const permission = 'write';");
  assert.notEqual(artifactSourceFingerprint("desktop", root), before);
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `console.log((await import(${JSON.stringify(entry)})).permission)`], {encoding: "utf8"});
  assert.equal(result.trim(), "write");
});

test("a production import retains a test-named resource", async t => {
  const {root, put} = fixture(t);
  put("apps/desktop/tests/fixture.mjs", "export const answer = 42;");
  put("apps/desktop/src/main.mjs", "export {answer} from '../tests/fixture.mjs';");
  assert.equal((await import(pathToFileURL(join(root, "apps/desktop/src/main.mjs")).href)).answer, 42);
  const before = artifactSourceFingerprint("desktop", root);
  put("apps/desktop/tests/fixture.mjs", "export const answer = 43;");
  assert.notEqual(artifactSourceFingerprint("desktop", root), before);
});

test("build globs retain tests that the production builder consumes", t => {
  const {root, put} = fixture(t);
  put("apps/desktop/package.json", '{"name":"@dohc/desktop","scripts":{"build":"node scripts/build.mjs"}}');
  put("apps/desktop/scripts/build.mjs", "import {globSync} from 'node:fs'; console.log(globSync('src/**/*.ts'));");
  put("apps/desktop/src/included.test.ts", "export const value = 1;");
  const matches = execFileSync(process.execPath, ["scripts/build.mjs"], {cwd: join(root, "apps/desktop"), encoding: "utf8"});
  assert.match(matches, /included\.test\.ts/);
  const before = artifactSourceFingerprint("desktop", root);
  put("apps/desktop/src/included.test.ts", "export const value = 2;");
  assert.notEqual(artifactSourceFingerprint("desktop", root), before);
});

test("receipts cover new configuration, manifests, lockfiles, Cargo and vendor inputs", t => {
  const {root, put} = fixture(t);
  const exec = childProcess.execFileSync;
  childProcess.execFileSync = (command, ...args) => command === "rustc" ? Buffer.from("fixture compiler") : exec(command, ...args);
  syncBuiltinESMExports();
  try {
    for (const [kind, paths] of Object.entries({desktop: ["apps/desktop/new.config.mjs", "packages/security-contract/package.json", "pnpm-lock.yaml", "apps/desktop/.env.production.local"],
      engine: ["Cargo.toml", "Cargo.lock", "rust-toolchain", ".cargo/config.toml", "vendor/library/src/lib.rs"]})) {
      for (const path of paths) {
        const before = artifactSourceFingerprint(kind, root);
        put(path, path.endsWith("package.json") ? '{"name":"@dohc/security-contract","changed":true}' : "changed input");
        assert.notEqual(artifactSourceFingerprint(kind, root), before, path);
      }
    }
  } finally { childProcess.execFileSync = exec; syncBuiltinESMExports(); }
});

test("preparation reuses artifacts after a verification-only edit", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-prepare-artifact-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const prepare = createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
  const first = prepare();
  assert.equal(first.status, 0, first.stderr);
  writeFileSync(join(root, "scripts/verification/extra.test.mjs"), "new test");
  const second = prepare();
  assert.equal(second.status, 0, second.stderr);
  const builds = readFileSync(join(root, ".dohc-dev/calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(call => call.command === "cargo" || call.args.at(-1) === "build");
  assert.equal(builds.length, 3);
});

test("configured compiler bytes remain production inputs at the same path", t => {
  const {root, put} = fixture(t);
  const prior = process.env.ESBUILD_BINARY_PATH;
  try {
    put(".gitignore", "compiler.bin\n");
    put("compiler.bin", "compiler one");
    process.env.ESBUILD_BINARY_PATH = join(root, "compiler.bin");
    const before = artifactSourceFingerprint("desktop", root);
    put("compiler.bin", "compiler two");
    assert.notEqual(artifactSourceFingerprint("desktop", root), before);
  } finally {
    if (prior === undefined) delete process.env.ESBUILD_BINARY_PATH;
    else process.env.ESBUILD_BINARY_PATH = prior;
  }
});

test("runtime builds work without Git or desktop QA sources", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-runtime-export-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const runtime = join(root, "packages/app-backend-runtime");
  mkdirSync(join(runtime, "scripts"), {recursive: true});
  copyFileSync(new URL("../../packages/app-backend-runtime/scripts/build.mjs", import.meta.url), join(runtime, "scripts/build.mjs"));
  const esbuild = join(runtime, "node_modules/esbuild");
  mkdirSync(esbuild, {recursive: true});
  writeFileSync(join(esbuild, "package.json"), '{"type":"module","exports":"./index.mjs"}');
  writeFileSync(join(esbuild, "index.mjs"), "import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';export async function build(options){mkdirSync(options.outdir,{recursive:true});writeFileSync(join(options.outdir,'index.mjs'),'built');}");
  const result = execFileSync(process.execPath, [join(runtime, "scripts/build.mjs")], {encoding: "utf8"});
  assert.equal(result, "");
  assert.equal(readFileSync(join(runtime, "dist/index.mjs"), "utf8"), "built");
  assert.match(directoryFingerprint(join(runtime, "dist")), /^[a-f0-9]{64}$/);
});

test("runtime receipts reuse exact outputs and reject source, output and environment drift", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-runtime-receipt-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
  writeFileSync(join(root, ".gitignore"), readFileSync(join(root, ".gitignore"), "utf8") + "packages/app-backend-runtime/dist/\n");
  const runtime = join(root, "packages/app-backend-runtime");
  mkdirSync(join(runtime, "scripts"), {recursive: true});
  mkdirSync(join(runtime, "src"));
  writeFileSync(join(runtime, "package.json"), '{"name":"@dohc/app-backend-runtime","type":"module","scripts":{"build":"node scripts/build.mjs"}}');
  writeFileSync(join(runtime, "src/index.ts"), "original source");
  copyFileSync(new URL("../../packages/app-backend-runtime/scripts/build.mjs", import.meta.url), join(runtime, "scripts/build.mjs"));
  const esbuild = join(runtime, "node_modules/esbuild");
  mkdirSync(esbuild, {recursive: true});
  writeFileSync(join(esbuild, "package.json"), '{"type":"module","exports":"./index.mjs"}');
  writeFileSync(join(esbuild, "index.mjs"), `import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';export async function build(options){mkdirSync(options.outdir,{recursive:true});writeFileSync(join(options.outdir,'index.mjs'),readFileSync(options.entryPoints.index));appendFileSync(${JSON.stringify(join(root, ".dohc-dev/runtime-calls"))},${JSON.stringify("build\n")});}`);
  const run = env => execFileSync(process.execPath, [join(runtime, "scripts/build.mjs")], {env: {...process.env, ...env}, encoding: "utf8"});
  run();
  assert.match(run(), /reuse prepared bundle/);
  assert.equal(readFileSync(join(root, ".dohc-dev/runtime-calls"), "utf8"), "build\n");
  writeFileSync(join(runtime, "dist/index.mjs"), "stale dist");
  assert.doesNotMatch(run(), /reuse/);
  writeFileSync(join(runtime, "src/index.ts"), "changed source");
  assert.doesNotMatch(run(), /reuse/);
  assert.equal(readFileSync(join(runtime, "dist/index.mjs"), "utf8"), "changed source");
  assert.doesNotMatch(run({ESBUILD_BINARY_PATH: "changed-compiler"}), /reuse/);
  assert.equal(readFileSync(join(root, ".dohc-dev/runtime-calls"), "utf8"), "build\n".repeat(4));
});
