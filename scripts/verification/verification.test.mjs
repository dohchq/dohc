import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildEnvironment, directoryFingerprint, engineArtifactMatches, hashFile, repairOwnedEngineExecutable, sourceFingerprint } from "./build.mjs";
import { changedFiles, postgres, selectedGates, readSelfHostNativeProof } from "./verify.mjs";
import { repoRoot, run } from "./process.mjs";
import { requireE2eEngine } from "../../apps/desktop/scripts/require-e2e-engine.mjs";
import { createPrepareFixture } from "./prepare-fixture.mjs";
import { runEarlyCloseDebugFixture } from "./debug-fixture.mjs";

test("native proof evidence rejects skips, wrong binaries, and incomplete delivery", () => {
  const output = mkdtempSync(join(tmpdir(), "dohc-native-proof-verdict-"));
  const executable = join(output, "engine"), sha256 = "a".repeat(64), path = join(output, "self-host-live-fixture");
  mkdirSync(path);
  const tests = {success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0};
  const proof = {verdict: "PASS", executable, sha256, results: {ownerDelivery: {restartPreservedDraft: true, concurrentOwnerAndNamedEditsMerged: true,
    idleOwnerPulledRecipientEdit: true}, settledAndPublished: {ordinaryOwnerReadMatched: true}}};
  const write = (report = tests, evidence = proof) => {
    writeFileSync(join(output, "vitest.json"), JSON.stringify(report));
    writeFileSync(join(path, "result.json"), JSON.stringify(evidence));
  };
  try {
    write(); assert.equal(readSelfHostNativeProof(output, executable, sha256).sha256, sha256);
    for (const delta of [{numPendingTests: 1}, {numTotalTests: 0, numPassedTests: 0}, {success: false}, {numTodoTests: 1}]) {
      write({...tests, ...delta}); assert.throws(() => readSelfHostNativeProof(output, executable, sha256), /mandatory test/);
    }
    for (const delta of [{sha256: "b".repeat(64)}, {executable: join(output, "different")}, {results: {}}, {acceptance: "diagnostic only"}]) {
      write(tests, {...proof, ...delta}); assert.throws(() => readSelfHostNativeProof(output, executable, sha256), /prepared engine/);
    }
    write(); rmSync(join(path, "result.json")); assert.throws(() => readSelfHostNativeProof(output, executable, sha256), /ENOENT/);
  } finally { rmSync(output, {recursive: true, force: true}); }
});

test("Windows setup uses pnpm.cmd and stops after failed or missing installation", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-setup-windows-"));
  const put = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  try {
    put("apps/desktop/package.json", "{}");
    for (const name of ["setup.mjs", "process.mjs", "windows-command.mjs", "windows-job.ps1"]) {
      mkdirSync(join(root, "scripts/verification"), { recursive: true });
      copyFileSync(new URL(`./${name}`, import.meta.url), join(root, "scripts/verification", name));
    }
    put("apps/desktop/scripts/ensure-electron-installed.mjs", "import {writeFileSync} from 'node:fs';writeFileSync('electron-ran', 'yes');");
    put("scripts/verification/doctor.mjs", "import {writeFileSync} from 'node:fs';writeFileSync('doctor-ran', 'yes');");
    put("bin/pnpm.ps1", "throw 'Setup must use the command shim, not the PowerShell shim.'");
    const pwsh = execFileSync("where.exe", ["pwsh.exe"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.PATH = [join(root, "bin"), dirname(pwsh), join(process.env.SystemRoot, "System32"), join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0")].join(";");
    for (const exitCode of [0, 23, null]) {
      for (const path of ["electron-ran", "doctor-ran", "install-args", "bin/pnpm.cmd"]) rmSync(join(root, path), { force: true });
      if (exitCode !== null) put("bin/pnpm.cmd", `@echo off\r\necho %* > install-args\r\nexit /b ${exitCode}\r\n`);
      const result = spawnSync(process.execPath, ["scripts/verification/setup.mjs"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, exitCode === 0 ? 0 : 1, result.stdout + result.stderr);
      assert.equal(existsSync(join(root, "electron-ran")), exitCode === 0);
      assert.equal(existsSync(join(root, "doctor-ran")), exitCode === 0);
      if (exitCode !== null) assert.equal(readFileSync(join(root, "install-args"), "utf8").trim(), "install --frozen-lockfile");
      if (exitCode === 23) assert.match(result.stderr, /failed \(23\)/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor requires a disk measurement only when a build budget is configured", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-doctor-disk-"));
  const put = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  try {
    put("package.json", '{"type":"module","engines":{"pnpm":"11.20.0"}}');
    put("apps/desktop/package.json", "{}");
    put("scripts/verification/build.mjs", "export const preparedStatus=()=>true;");
    put("scripts/verification/process.mjs", "import {resolve} from 'node:path';export const repoRoot=resolve(import.meta.dirname,'../..');export const git=args=>args[0]==='rev-parse'?'fixture-commit':'';");
    put("node_modules/pnpm/index.js", "exports.version='11.20.0';");
    for (const name of ["electron", "playwright"]) put(`node_modules/${name}/package.json`, '{"version":"fixture"}');
    put("node_modules/electron/path.txt", "fixture-runtime");
    put("node_modules/electron/dist/fixture-runtime", "fixture");
    copyFileSync(new URL("./doctor.mjs", import.meta.url), join(root, "scripts/verification/doctor.mjs"));
    mkdirSync(join(root, "tools/rust-engine-program"), { recursive: true });
    copyFileSync(new URL("../../tools/rust-engine-program/build-slot.mjs", import.meta.url), join(root, "tools/rust-engine-program/build-slot.mjs"));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import cp from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      let measurement;
      fs.statfsSync=()=>{
        if(measurement===null)throw new Error('fixture disk probe unavailable');
        return {bsize:1024**3,bavail:measurement};
      };
      cp.execFileSync=(command)=>{
        assert.ok(['pwsh.exe','rustc','cargo'].includes(command),'unexpected external probe: '+command);
        return command==='pwsh.exe'?'7.6.5':'fixture-toolchain';
      };
      syncBuiltinESMExports();
      const {doctor}=await import('./scripts/verification/doctor.mjs');
      process.env.CI='true';
      for(const [floor,free,expected] of [[null,null,'PENDING'],[40,null,'FAIL'],[0,null,'FAIL'],[40,39,'FAIL'],[40,41,'PASS']]) {
        if(floor===null) {delete process.env.DOHC_BUILD_SLOT_ROOT;delete process.env.DOHC_GATE_DISK_FLOOR_GB;}
        else {process.env.DOHC_BUILD_SLOT_ROOT='fixture-slots';process.env.DOHC_GATE_DISK_FLOOR_GB=String(floor);}
        measurement=free;
        const result=doctor();
        assert.equal(result.checks.find(check=>check.name==='disk').state,expected,JSON.stringify({floor,free}));
        assert.ok(result.checks.filter(check=>check.name!=='disk').every(check=>check.state==='PASS'));
      }
      cp.execFileSync=command=>{assert.equal(command,'pwsh.exe','unrelated native tool probe');return '7.6.5';};
      syncBuiltinESMExports();
      measurement=1;
      fs.rmSync('node_modules/electron',{recursive:true,force:true});
      fs.rmSync('node_modules/playwright',{recursive:true,force:true});
      const selective=doctor({engine:false,desktop:false,browser:false});
      assert.ok(selective.checks.every(check=>check.state!=='FAIL'));
      assert.ok(!selective.checks.some(check=>['rustc','cargo','electron','playwright','engine build','desktop build'].includes(check.name)));
    `], { cwd: root, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine-only readiness validates the native artifact without requiring a desktop build", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-engine-only-ready-"));
  try {
    createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import {writeFileSync} from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const exec=cp.execFileSync;
      cp.execFileSync=(command,...args)=>command==='rustc'?Buffer.from('fixture rustc'):exec(command,...args);
      syncBuiltinESMExports();
      const {prepare,assertPrepared,enginePath}=await import('./scripts/verification/build.mjs');
      await prepare({engineOnly:true});
      assert.ok(assertPrepared({engineOnly:true}).engine.artifact);
      assert.throws(()=>assertPrepared(),/does not match/);
      writeFileSync(enginePath,'changed artifact');
      assert.throws(()=>assertPrepared({engineOnly:true}),/does not match/);
    `], {cwd:root,encoding:"utf8",timeout:20_000});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`queued preparation ${signal} removes its lock without touching occupied slots`, () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-prepare-queue-"));
    try {
      createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
      copyFileSync(new URL("../../tools/rust-engine-program/build-slot.mjs", import.meta.url), join(root, "tools/rust-engine-program/build-slot.mjs"));
      const slots = join(root, ".dohc-dev/slots");
      const owner = JSON.stringify({ pid: process.pid, start: new Date().toISOString() });
      for (let index = 1; index <= 4; index++) {
        const slot = join(slots, `build-slot-${index}`);
        mkdirSync(slot, { recursive: true });
        writeFileSync(join(slot, "owner.json"), owner);
      }
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import cp from 'node:child_process';
        import {syncBuiltinESMExports} from 'node:module';
        const exec=cp.execFileSync;
        cp.execFileSync=(command,...args)=>command==='rustc'?Buffer.from('fixture rustc'):exec(command,...args);
        syncBuiltinESMExports();
        const log=console.log;
        console.log=(...args)=>{
          log(...args);
          if (String(args[0]).includes('waiting for a build slot:')) {
            queueMicrotask(()=>{
              if (process.platform === 'win32') {
                // Node cannot deliver a native catchable signal to itself on Windows.
                // Emit the event, and emulate default termination only when unhandled.
                if (!process.emit('${signal}')) process.exit(${status});
              } else process.kill(process.pid, '${signal}');
            });
          }
        };
        try { await (await import('./scripts/verification/build.mjs')).prepare(); }
        catch (error) { console.error(error.message); }
      `], { cwd: root, encoding: "utf8", timeout: 20_000,
        env: { ...process.env, DOHC_BUILD_SLOT_ROOT: slots, DOHC_GATE_DISK_FLOOR_GB: "0" } });
      assert.equal(result.error, undefined);
      assert.match(result.stdout, /waiting for a build slot:/);
      assert.equal(existsSync(join(root, ".dohc-dev/verification/build.json.lock")), false, result.stderr);
      assert.equal(result.status, status, result.stderr);
      const calls = readFileSync(join(root, ".dohc-dev/calls.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
      assert.deepEqual(calls.map(({ command }) => command), ["pnpm"]);
      for (let index = 1; index <= 4; index++) {
        assert.equal(readFileSync(join(slots, `build-slot-${index}`, "owner.json"), "utf8"), owner);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("command text decodes UTF-8 across pipe chunks while retaining raw log bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-utf8-pipes-"));
  try {
    const log = join(root, "output.log");
    const result = await run(process.execPath, ["-e", `process.stdout.write(JSON.stringify({path:'雪/😀'}));process.stderr.write('é診断');`], {
      log, quietStdout: true, timeoutMs: 20_000,
      onSpawn: (child) => {
        for (const stream of [child.stdout, child.stderr]) {
          const emit = stream.emit;
          stream.emit = function (event, ...args) {
            if (event !== "data") return emit.call(this, event, ...args);
            for (const byte of args[0]) emit.call(this, "data", Buffer.from([byte]));
            return true;
          };
        }
      },
    });
    assert.deepEqual(JSON.parse(result.stdout), { path: "雪/😀" });
    assert.equal(result.stderr, "é診断");
    const bytes = readFileSync(log);
    assert.equal(bytes.includes(Buffer.from(result.stdout)), true);
    assert.equal(bytes.includes(Buffer.from(result.stderr)), true);
    assert.equal(bytes.includes(Buffer.from("�")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("command decoders flush incomplete final UTF-8 without altering log bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-utf8-flush-"));
  try {
    const log = join(root, "output.log");
    const result = await run(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xe2,0x82]));process.stderr.write(Buffer.from([0xc3]));"], {
      log, quietStdout: true, timeoutMs: 20_000,
    });
    assert.equal(result.stdout, "�");
    assert.equal(result.stderr, "�");
    const bytes = readFileSync(log);
    assert.equal(bytes.length, 3);
    assert.equal(bytes.includes(Buffer.from([0xe2, 0x82])), true);
    assert.equal(bytes.includes(0xc3), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("debug retains evidence when the app or child closes during startup", () => {
  for (const closed of ["app", "child"]) {
    const result = runEarlyCloseDebugFixture(new URL("./debug.mjs", import.meta.url), closed);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Evidence retained at/);
    assert.deepEqual(result.files.sort(), ["desktop.jsonl", "instance.json", "last-screen.png", "trace.zip"]);
  }
});

test("standalone preparation installs frozen dependencies before building, sealing, or reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-prepare-install-"));
  try {
    const invoke = createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
    mkdirSync(join(root, "apps/desktop/resources/cli-bin"), { recursive: true });
    for (const name of ["dohc", "dohc-mcp"]) writeFileSync(join(root, "apps/desktop/resources/cli-bin", name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const output = join(root, ".dohc-dev/verification");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "install.log"), "verifier install output");
    const first = invoke();
    assert.equal(first.error, undefined);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(output, "install.log"), "utf8"), "verifier install output");
    assert.equal(readFileSync(join(output, "prepare-install.log"), "utf8"), "preparation install output");
    assert.match(first.stdout, /"desktopPrepared":true/);
    assert.equal(readFileSync(join(root, "apps/desktop/dist/built.txt"), "utf8"), "new-lock");
    const calls = () => readFileSync(join(root, ".dohc-dev/calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls().map(({ command, args }) => [command, args[0]]), [["pnpm", "install"], ["cargo", "build"], ["pnpm", "--filter"], ["pnpm", "--filter"]]);
    writeFileSync(join(root, "node_modules/installed.txt"), "stale-again");
    const reused = invoke();
    assert.equal(reused.status, 0, reused.stderr);
    assert.match(reused.stdout, /reuse desktop/);
    assert.equal(readFileSync(join(root, "node_modules/installed.txt"), "utf8"), "new-lock");
    assert.equal(calls().length, 5);
    assert.deepEqual(calls().at(-1), { command: "pnpm", args: ["install", "--frozen-lockfile"] });
    const installed = invoke({ install: false });
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /reuse desktop/);
    assert.equal(calls().length, 5, "the canonical verifier can reuse its completed frozen install");
    rmSync(join(root, ".dohc-dev/verification/build.json"));
    const failed = invoke({ failInstall: true });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /frozen install rejected/);
    assert.equal(calls().length, 6);
    assert.equal(existsSync(join(root, ".dohc-dev/verification/build.json")), false);
    assert.equal(existsSync(join(root, ".dohc-dev/verification/build.json.lock")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparation builds and reuses the share viewer, rebuilding missing or stale assets", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-prepare-viewer-"));
  try {
    const invoke = createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
    mkdirSync(join(root, "apps/desktop/resources/cli-bin"), { recursive: true });
    for (const name of ["dohc", "dohc-mcp"]) writeFileSync(join(root, "apps/desktop/resources/cli-bin", name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const viewer = join(root, "services/share-web/viewer");
    const calls = () => readFileSync(join(root, ".dohc-dev/calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
      .filter(({ args }) => args[1] === "@dohc/share-web");
    const prepare = () => {
      const result = invoke();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /"desktopPrepared":true/);
      assert.equal(readFileSync(join(viewer, "dist/index.html"), "utf8"), "viewer");
      assert.equal(readFileSync(join(viewer, "dist/assets/viewer.js"), "utf8"), "viewer script");
    };
    prepare();
    assert.equal(calls().length, 1);
    prepare();
    assert.equal(calls().length, 1, "unchanged viewer is reused");
    rmSync(join(viewer, "dist/index.html"));
    prepare();
    assert.equal(calls().length, 2, "missing entry point is rebuilt");
    writeFileSync(join(viewer, "dist/assets/viewer.js"), "stale script");
    prepare();
    assert.equal(calls().length, 3, "changed assets are rebuilt");
    writeFileSync(join(viewer, "main.ts"), "changed viewer source");
    prepare();
    assert.equal(calls().length, 4, "changed viewer source is rebuilt");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("vendored native edits invalidate preparation and rebuild the engine", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-prepare-vendor-"));
  try {
    const invoke = createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
    mkdirSync(join(root, "vendor/yrs/src"), { recursive: true });
    const vendor = join(root, "vendor/yrs/src/lib.rs");
    writeFileSync(vendor, "original native source");
    execFileSync("git", ["add", "vendor"], { cwd: root });
    const run = options => {
      const result = invoke(options);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    };
    // This fixture has no POSIX CLI launchers.
    const options = { platform: "win32" };
    assert.equal(run(options).enginePrepared, true);
    const original = JSON.parse(readFileSync(join(root, ".dohc-dev/verification/build.json"), "utf8")).engine.source;
    writeFileSync(vendor, "changed native source");
    assert.equal(run({ ...options, statusOnly: true }).enginePrepared, false);
    assert.equal(run(options).enginePrepared, true);
    const updated = JSON.parse(readFileSync(join(root, ".dohc-dev/verification/build.json"), "utf8")).engine.source;
    assert.notEqual(updated, original);
    const calls = readFileSync(join(root, ".dohc-dev/calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter(({ command }) => command === "cargo").length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepared desktop checks staged compiler bytes only on Windows x64", () => {
  for (const [platform, arch] of [["win32", "x64"], ["win32", "arm64"], ["linux", "x64"]]) {
    const supported = platform === "win32" && arch === "x64";
    const root = mkdtempSync(join(tmpdir(), "dohc-prepare-compiler-"));
    try {
      const invoke = createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
      mkdirSync(join(root, "apps/desktop/resources/cli-bin"), { recursive: true });
      for (const name of ["dohc", "dohc-mcp"]) writeFileSync(join(root, "apps/desktop/resources/cli-bin", name), "launcher", { mode: 0o755 });
      const run = options => {
        const result = invoke({ platform, arch, ...options });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
      };
      assert.equal(run().desktopPrepared, true);
      const compiler = join(root, "apps/desktop/resources/app-compiler");
      mkdirSync(compiler, { recursive: true });
      writeFileSync(join(compiler, "built.txt"), "changed compiler");
      assert.equal(run({ statusOnly: true }).desktopPrepared, !supported, `${platform}/${arch} changed compiler`);
      rmSync(compiler, { recursive: true });
      assert.equal(run({ statusOnly: true }).desktopPrepared, !supported, `${platform}/${arch} missing compiler`);
      assert.equal(run().desktopPrepared, true);
      const calls = readFileSync(join(root, ".dohc-dev/calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.filter(({ command, args }) => command === "pnpm" && args[0] === "--filter" && args[1] === "@dohc/desktop").length, supported ? 2 : 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("verification selects packages and proofs and prepares the engine after Rust", async (t) => {
  for (const [mode, job, fault, changed = "pnpm-lock.yaml", full = false] of [
    ["pr", null, null], ["pr", "rust", null], ["pr", "js", null],
    ["smoke", null, null], ["e2e", null, null],
    ["pr", null, "rust-verdict"], ["pr", "rust", "cargo-version"], ["pr", null, "source"],
    ["pr", null, "rust"], ["pr", null, "rust-and-js"], ["pr", "rust", "rust"], ["pr", "js", "js"],
    ["pr", null, "rust-source"], ["pr", null, "rust-cancel"],
    ["pr", "js", "accounts-skipped"], ["pr", "js", "desktop-skipped"], ["pr", "js", "onboarding-missing"],
    ["pr", null, null, "packages/fixture/src/index.ts"],
    ["pr", null, null, "packages/mcp/src/index.ts"],
    ["pr", null, null, "services/workspace-api/src/index.ts"],
    ["pr", null, null, null, true], ["pr", "js", null, null, true], ["pr", "rust", null, null, true],
    ["pr", "js", null, null],
  ]) await t.test([mode, job, fault, changed ?? "empty diff", full ? "full" : ""].filter(Boolean).join(" "), () => {
    const rust = mode === "pr" && job !== "js" && (full || job === "rust" || changed === "pnpm-lock.yaml");
    const js = mode === "pr" && job !== "rust";
    const selected = changed === "packages/fixture/src/index.ts" ? ["@dohc/fixture"]
      : changed === "packages/mcp/src/index.ts" ? ["@dohc/mcp", "@dohc/share-web"]
      : changed === "services/workspace-api/src/index.ts" ? ["@dohc/desktop", "@dohc/workspace-api"]
      : ["@dohc/desktop", "@dohc/fixture", "@dohc/mcp", "@dohc/share-web", "@dohc/unrelated", "@dohc/workspace-api"];
    const desktop = mode !== "pr" || js && selected.includes("@dohc/desktop");
    const nativeProof = js && selected.includes("@dohc/share-web");
    const accounts = js && selected.includes("@dohc/workspace-api");
    const prepare = desktop || nativeProof;
    const database = js && (desktop || nativeProof || accounts);
    const browser = js && (desktop || accounts);
    const root = mkdtempSync(join(tmpdir(), "dohc-verify-build-order-"));
    const put = (path, contents) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    };
    const git = (args) => execFileSync("git", ["-c", `core.hooksPath=${join(root, "no-hooks")}`,
      "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: root, encoding: "utf8" }).trim();
    try {
      createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
      git(["config", "core.logAllRefUpdates", "true"]);
      mkdirSync(join(root, ".dohc-dev"), { recursive: true });
      for (const path of ["scripts/verification/verify.mjs", "scripts/verification/js-tests.mjs", "scripts/verification/selection.mjs", "scripts/verification/timing.mjs", "tools/rust-engine-program/tree-provenance.mjs",
        "apps/desktop/scripts/require-e2e-engine.mjs", ".github/workflows/pr-checks.yml"]) {
        put(path, readFileSync(join(repoRoot, path)));
      }
      put(".gitignore", readFileSync(join(root, ".gitignore"), "utf8") + ".agent-artifacts/\napps/desktop/.env.local\n");
      put("apps/desktop/package.json", '{"name":"@dohc/desktop"}');
      for (const name of ["fixture", "mcp", "share-web", "unrelated", "workspace-api"]) {
        const path = `${name === "workspace-api" ? "services" : "packages"}/${name}`;
        put(`${path}/package.json`, JSON.stringify({name:`@dohc/${name}`,scripts:{test:"vitest run"}}));
        put(`${path}/src/index.ts`, "export const value = 1;\n");
      }
      put("pnpm-workspace.yaml", 'packages: ["apps/*", "packages/*", "services/*"]\n');
      for (const name of ["dohc", "dohc-mcp"]) {
        put(`apps/desktop/resources/cli-bin/${name}`, "fixture launcher");
        chmodSync(join(root, "apps/desktop/resources/cli-bin", name), 0o755);
      }
      put("scripts/verification/doctor.mjs", `
        import assert from 'node:assert/strict';
        import {readFileSync} from 'node:fs';
        export function doctor(options) {
          assert.deepEqual(options,${JSON.stringify({engine:rust || prepare,desktop,browser:desktop || accounts})});
          if(process.env.FIXTURE_MODE==='pr' && readFileSync('node_modules/installed.txt','utf8')!==readFileSync('pnpm-lock.yaml','utf8'))
            throw Error('doctor ran before verifier installation');
          return {checks:[]};
        }
      `);
      const adapterPath = "scripts/verification/process.mjs";
      put(adapterPath, readFileSync(join(root, adapterPath), "utf8").replace("export async function run(", "async function prepareRun(") + `
        export async function run(command,args,options={}) {
          const {enginePath,assertPrepared,hashFile}=await import('./build.mjs');
          appendFileSync(join(repoRoot,'.dohc-dev/all-calls.jsonl'),JSON.stringify({command,args})+'\\n');
          if(command==='cargo' && !${rust || prepare})throw Error('Native tools unavailable for this JavaScript change');
          if(command==='pnpm' && args[1]==='@dohc/desktop' && args.includes('build') && !${desktop})throw Error('Electron unavailable for this change');
          if(command==='pnpm' && args[1]==='@dohc/app-backend-runtime') {
            assert.deepEqual(args,['--filter','@dohc/app-backend-runtime','build']);
            return {stdout:'compiled runtime'};
          }
          if(command==='pnpm' && args[0]==='install' && !existsSync(join(repoRoot,'.dohc-dev/verification/build.json.lock'))) {
            assert.deepEqual(args,['install','--frozen-lockfile']);
            writeFileSync(join(repoRoot,'node_modules/installed.txt'),readFileSync(join(repoRoot,'pnpm-lock.yaml')));
            return {stdout:''};
          }
          if(command==='cargo' && args[1]==='--version') {
            const {createRequire}=await import('node:module');
            const pins=createRequire(import.meta.url)('js-yaml').load(readFileSync(join(repoRoot,'.github/workflows/pr-checks.yml'),'utf8')).env;
            if(process.env.FIXTURE_FAULT==='cargo-version' && args[0]==='deny')return {stdout:'cargo-deny 0.0.0'};
            return {stdout:'cargo-'+args[0]+' '+pins['CARGO_'+args[0].toUpperCase()+'_VERSION']};
          }
          if(args[0]==='tools/rust-engine-program/run-rust-checks.mjs') {
            mkdirSync(dirname(enginePath),{recursive:true});writeFileSync(enginePath,'workspace engine');chmodSync(enginePath,0o755);
            if(['source','rust-source'].includes(process.env.FIXTURE_FAULT))writeFileSync(join(repoRoot,'apps/desktop/.env.local'),'VITE_CHANGED=during-Rust');
            if(process.env.FIXTURE_FAULT==='rust-cancel')process.emit('SIGTERM');
            if(['rust','rust-and-js','rust-source','rust-cancel'].includes(process.env.FIXTURE_FAULT))throw Error('fixture Rust failed');
            return {stdout:'fixture Rust'};
          }
          if(args[0]==='tools/rust-engine-program/require-ci-pass-verdict.mjs') {
            if(process.env.FIXTURE_FAULT==='rust-verdict')throw Error('fixture Rust verdict rejected');
            return {stdout:'PASS'};
          }
          if(command==='docker') {
            if(!${database})throw Error('Docker unavailable for this change');
            if(args[0]==='run'){writeFileSync(join(repoRoot,'.dohc-dev/database-started'),'yes');return {stdout:'a'.repeat(64)};}
            if(args[0]==='inspect')return {stdout:'healthy'};
            if(args[0]==='port')return {stdout:'127.0.0.1:1234'};
            assert.deepEqual(args,['rm','--force','a'.repeat(64)]);
            writeFileSync(join(repoRoot,'.dohc-dev/database-stopped'),'yes');return {stdout:''};
          }
          if(command==='pnpm' && args[0]==='run') {
            assert.ok(['typecheck','test:repo'].includes(args[1]));
            if(args[1]==='typecheck' && ['js','rust-and-js'].includes(process.env.FIXTURE_FAULT))throw Error('fixture JS failed');
            for(const flag of ['DOHC_REQUIRE_POSTGRES','DOHC_REQUIRE_ENGINE_E2E'])assert.equal(options.env[flag],'1');
            return {stdout:''};
          }
          if(command==='pnpm' && args.includes('list')) {
            return {stdout:JSON.stringify([
              {name:'@dohc/desktop',path:join(repoRoot,'apps/desktop')},
              ...['fixture','mcp','share-web','unrelated','workspace-api'].map(name=>({name:'@dohc/'+name,path:join(repoRoot,name==='workspace-api'?'services':'packages',name)}))
            ])};
          }
          if(command==='pnpm' && args[2]==='run' && args[3]==='test') {
            assert.deepEqual(args,['--filter',args[1],'run','test','--maxWorkers=4']);
            assert.ok(${JSON.stringify(selected)}.includes(args[1]),'Unselected package executed: '+args[1]);
            assert.equal(options.env.POSTGRES_URL,${JSON.stringify(database ? "postgres://dohc:dohc@127.0.0.1:1234/dohc" : "")});
            for(const flag of ['DOHC_REQUIRE_POSTGRES','DOHC_REQUIRE_ENGINE_E2E'])assert.equal(options.env[flag],'1');
            return {stdout:''};
          }
          if(command==='pnpm' && args[0]==='exec') {
            if(!${browser})throw Error('Browser tools unavailable for this change');
            assert.deepEqual(args,['exec','playwright','install',...(process.platform==='linux'?['--with-deps']:[]),'chromium']);
            assert.equal(options.env.DOHC_REQUIRE_POSTGRES,'1');
            writeFileSync(join(repoRoot,'.dohc-dev/browser-installed'),'yes');
            return {stdout:''};
          }
          if(command==='pnpm' && args.includes('vitest.self-host-native.config.ts')) {
            assert.ok(${nativeProof},'Unselected native proof');
            assertPrepared({engineOnly:!${desktop}});
            assert.equal(options.env.DOHC_SERVICE_HOST_PROOF_BINARY,enginePath);
            assert.equal(options.env.DOHC_SERVICE_HOST_PROOF_SHA256,hashFile(enginePath));
            assert.equal(options.env.DOHC_REQUIRE_POSTGRES,'1');
            const output=options.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
            mkdirSync(join(output,'self-host-live-fixture'),{recursive:true});
            writeFileSync(join(output,'vitest.json'),JSON.stringify({success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0}));
            writeFileSync(join(output,'self-host-live-fixture/result.json'),JSON.stringify({verdict:'PASS',executable:enginePath,sha256:hashFile(enginePath),results:{ownerDelivery:{restartPreservedDraft:true,concurrentOwnerAndNamedEditsMerged:true,idleOwnerPulledRecipientEdit:true},settledAndPublished:{ordinaryOwnerReadMatched:true}}}));
            return {stdout:''};
          }
          if(args[0]==='apps/desktop/scripts/run-playwright.mjs') {
            if(!${desktop || accounts})throw Error('Browser tools unavailable for this change');
            if(${desktop})assertPrepared();
            const pr=process.env.FIXTURE_MODE==='pr';
            if(pr) {
              assert.equal(options.env.POSTGRES_URL,'postgres://dohc:dohc@127.0.0.1:1234/dohc');
              assert.equal(options.env.DOHC_REQUIRE_POSTGRES,'1');
              assert.equal(existsSync(join(repoRoot,'.dohc-dev/database-started')),true);
              assert.equal(existsSync(join(repoRoot,'.dohc-dev/database-stopped')),false);
              assert.equal(existsSync(join(repoRoot,'.dohc-dev/browser-installed')),true);
            }
            if(args.includes('services/workspace-api/playwright.config.ts')) {
              assert.ok(${accounts},'Unselected account proof');
              assert.ok(pr);
              writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME,JSON.stringify({stats:{expected:2,unexpected:0,flaky:0,skipped:process.env.FIXTURE_FAULT==='accounts-skipped'?1:0}}));
              return {stdout:''};
            }
            assert.ok(${desktop},'Unselected desktop proof');
            const expected=process.env.FIXTURE_MODE==='e2e'?['--project','fixture']:['--grep',pr?'@verification-smoke|@self-host-onboarding':'@verification-smoke'];
            assert.ok(args.some((arg,index)=>arg===expected[0] && args[index+1]===expected[1]));
            const titles=['@verification-smoke persistence',...(pr?[process.env.FIXTURE_FAULT==='onboarding-missing'?'@verification-smoke another persistence':'@self-host-onboarding account and sync']:[])];
            writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME,JSON.stringify({
              stats:{expected:pr?2:1,unexpected:0,flaky:0,skipped:process.env.FIXTURE_FAULT==='desktop-skipped'?1:0},
              suites:[{suites:[{specs:titles.map(title=>({title,ok:true,tests:[{results:[{status:'passed'}]}]}))}]}],
            }));
            return {stdout:''};
          }
          return prepareRun(command,args,options);
        }
      `);
      git(["add", "."]); git(["commit", "-m", "Verification fixture"]);
      const base = git(["rev-parse", "HEAD"]);
      if (changed) {
        put(changed, changed === "pnpm-lock.yaml" ? "gate-lock" : "export const value = 2;\n");
        git(["add", "."]); git(["commit", "-m", "Change fixture input"]);
      }
      const args = mode === "pr" ? [mode, "--base", base, ...(job ? ["--job", job] : []), ...(full ? ["--full"] : [])]
        : mode === "e2e" ? [mode, "--", "--project", "fixture"] : [mode];
      const require = createRequire(join(repoRoot, "apps/desktop/package.json"));
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import cp from 'node:child_process';
        import {syncBuiltinESMExports} from 'node:module';
        import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
        const exec=cp.execFileSync;
        cp.execFileSync=(command,...args)=>{
          if(command==='rustc') {
            if(!${rust || prepare})throw Error('Native tools unavailable for this JavaScript change');
            return Buffer.from('fixture rustc');
          }
          return exec(command,...args);
        };
        syncBuiltinESMExports();
        const {verify}=await import('./scripts/verification/verify.mjs');
        try {
          await verify(process.argv.slice(1));
        }
        catch(error) {console.error(error.message);process.exitCode ||= 1;}
        finally {
          const output='.agent-artifacts/verification';
          writeFileSync('.dohc-dev/report.json',readFileSync(output+'/'+readdirSync(output)[0]+'/result.json'));
        }
      `, ...args], { cwd: root, encoding: "utf8", timeout: 120_000, env: { ...process.env,
        NODE_PATH: dirname(dirname(require.resolve("js-yaml/package.json"))), FIXTURE_MODE: mode, FIXTURE_FAULT: fault ?? "",
        POSTGRES_URL:"postgres://must-not-use-inherited-database/foreign" } });
      assert.equal(result.error, undefined, result.stderr);
      const report = JSON.parse(readFileSync(join(root, ".dohc-dev/report.json"), "utf8"));
      if (fault) {
        assert.equal(result.status, fault === "rust-cancel" ? 143 : 1, result.stderr);
        assert.equal(report.verdict, "FAIL");
        assert.ok(report.steps.every(step => ["PASS", "FAIL"].includes(step.verdict)));
        const messages = {
          source: /Source changed during verification/,
          "rust-source": /Source changed during verification/,
          "rust-cancel": /Verification interrupted by SIGTERM/,
          rust: /fixture Rust failed/,
          "rust-and-js": /fixture JS failed/,
          js: /fixture JS failed/,
          "rust-verdict": /fixture Rust verdict rejected/,
          "cargo-version": /Install cargo-deny .* to match the workflow/,
          "accounts-skipped": /Account browser verification did not complete without failures or skips/,
          "desktop-skipped": /A mandatory desktop smoke test was skipped/,
          "onboarding-missing": /did not pass both persistence and self-host onboarding proofs/,
        };
        assert.match(result.stderr, messages[fault]);
        const ranJs = js && ["rust", "rust-verdict", "rust-and-js", "js", "accounts-skipped", "desktop-skipped", "onboarding-missing"].includes(fault);
        assert.equal(existsSync(join(root, ".dohc-dev/verification/build.json")), ranJs);
        assert.equal(existsSync(join(root, ".dohc-dev/database-stopped")), ranJs);
        assert.equal(report.steps.some(step => step.name === "typecheck"), ranJs);
        if (["rust", "rust-verdict", "rust-and-js"].includes(fault)) {
          const failedStep = fault === "rust-verdict" ? "rust-verdict" : "rust";
          assert.equal(report.steps.find(step => step.name === failedStep).verdict, "FAIL");
          if (js) {
            const typecheck = report.steps.find(step => step.name === "typecheck");
            assert.equal(typecheck.verdict, fault === "rust-and-js" ? "FAIL" : "PASS");
            assert.ok(report.steps.findIndex(step => step.name === failedStep) < report.steps.indexOf(typecheck));
            if (fault !== "rust-and-js") assert.equal(report.steps.find(step => step.name === "tests").verdict, "PASS");
          }
        }
        if (fault === "js") {
          assert.equal(report.steps.find(step => step.name === "typecheck").verdict, "FAIL");
          assert.equal(report.steps.some(step => step.name === "rust"), false);
        }
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(report.steps.map(({name})=>name), [
          ...(mode === "pr" ? ["install"] : []),
          "app-backend-runtime",
          ...(rust ? ["cargo-deny-version", "cargo-audit-version", "cargo-nextest-version", "rust", "rust-verdict"] : []),
          ...(js ? ["typecheck", "tests"] : []),
          ...(nativeProof ? ["self-host-native"] : []), ...(browser ? ["browser-install"] : []),
          ...(accounts ? ["accounts"] : []), ...(desktop ? ["desktop"] : []),
        ]);
        assert.equal(report.verdict, "PASS");
        assert.ok(report.seconds >= 0 && report.startedAt && report.finishedAt);
        assert.ok(report.steps.every(step => step.startedAt && step.finishedAt && step.seconds >= 0));
        assert.ok(report.timings.every(phase => phase.startedAt && phase.finishedAt && phase.seconds >= 0));
        assert.equal(report.timings.some(phase => phase.name === "prepare"), prepare);
        assert.equal(report.timings.some(phase => phase.name === "postgres-start"), database);
        assert.equal(report.timings.some(phase => phase.name === "postgres-stop"), database);
        assert.equal(report.provenance.status, "PASS");
        assert.equal(Boolean(report.build), prepare);
        assert.equal(existsSync(join(root, ".dohc-dev/database-stopped")), database);
        assert.deepEqual(report.gates,{rust,js});
        assert.equal(report.full,full);
        if (js) {
          assert.deepEqual(report.javascript.packages,selected);
          assert.deepEqual(report.javascript.proofs,{accounts,selfHostNative:nativeProof,desktop});
          const tests=JSON.parse(readFileSync(report.jsTests,"utf8"));
          assert.deepEqual(tests.selectedPackages,selected);
          assert.deepEqual(tests.packages.map(pkg=>pkg.name).sort(),selected.filter(name=>name!=="@dohc/desktop"));
          const calls=readFileSync(join(root,".dohc-dev/all-calls.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
          assert.deepEqual(calls.filter(({args})=>args[2]==="run" && args[3]==="test").map(({args})=>args[1]).sort(),tests.packages.map(pkg=>pkg.name).sort());
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("POSIX prepared desktop rejects CLI execute drift and restages unchanged launcher bytes", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-cli-mode-"));
  try {
    createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
    const directory = join(root, "apps/desktop/resources/cli-bin");
    mkdirSync(directory, { recursive: true });
    for (const name of ["dohc", "dohc-mcp"]) writeFileSync(join(directory, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // The adapter models build-cli-bin.mjs's explicit chmod on both generated launchers.
    const adapter = join(root, "scripts/verification/process.mjs");
    const source = readFileSync(adapter, "utf8");
    assert.ok(source.includes("export async function run("));
    writeFileSync(adapter, source.replace("export async function run(", "async function fixtureRun(") + `
      export async function run(command,args,options) {
        const result=await fixtureRun(command,args,options);
        if(command==='pnpm' && args[0]==='--filter')
          for(const name of ['dohc','dohc-mcp']) chmodSync(join(repoRoot,'apps/desktop/resources/cli-bin',name),0o755);
        return result;
      }
    `);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import {chmodSync,readFileSync} from 'node:fs';
      import {join} from 'node:path';
      import {syncBuiltinESMExports} from 'node:module';
      const exec=cp.execFileSync;
      cp.execFileSync=(command,...args)=>command==='rustc'?Buffer.from('fixture rustc'):exec(command,...args);
      syncBuiltinESMExports();
      const {prepare,preparedStatus,hashFile,receiptPath}=await import('./scripts/verification/build.mjs');
      await prepare();
      assert.equal(preparedStatus('desktop'),true);
      for(const name of ['dohc','dohc-mcp']) {
        const launcher=join(process.cwd(),'apps/desktop/resources/cli-bin',name);
        const bytes=hashFile(launcher);
        const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
        assert.equal(cp.spawnSync(launcher).status,0);
        chmodSync(launcher,0o644);
        assert.equal(hashFile(launcher),bytes);
        assert.equal(cp.spawnSync(launcher).error?.code,'EACCES');
        assert.equal(preparedStatus('desktop',receipt),false,name+' must not be reusable');
        await prepare();
        assert.equal(cp.spawnSync(launcher).status,0);
        assert.equal(hashFile(launcher),bytes);
        assert.equal(preparedStatus('desktop'),true);
        assert.equal(JSON.parse(readFileSync(receiptPath,'utf8')).desktop.artifact,receipt.desktop.artifact);
      }
    `], { cwd: root, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source fingerprints follow the host's environment key casing", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-env-key-"));
  try {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {sourceFingerprint} from ${JSON.stringify(new URL("./build.mjs", import.meta.url).href)};
      const root=process.argv[1];
      const upper='CARGO_PROFILE_DEV_OPT_LEVEL';
      const mixed='Cargo_Profile_Dev_Opt_Level';
      delete process.env[upper]; delete process.env[mixed];
      process.env[mixed]='0';
      const before=sourceFingerprint('engine',root);
      process.env[mixed]='1';
      const after=sourceFingerprint('engine',root);
      if(process.platform==='win32') {
        assert.equal(process.env[upper],'1');
        assert.notEqual(before,after);
        delete process.env[mixed]; process.env[upper]='1';
        assert.equal(sourceFingerprint('engine',root),after);
      } else {
        assert.equal(before,after);
        process.env[upper]='1';
        assert.notEqual(sourceFingerprint('engine',root),after);
      }
    `, root], { encoding: "utf8", timeout: 20_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const kind of ["engine", "desktop"]) test(`${kind} source identity scopes environment settings to its build`, () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-env-kind-"));
  try {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {sourceFingerprint} from ${JSON.stringify(new URL("./build.mjs", import.meta.url).href)};
      const root=process.argv[1];
      const kind=process.argv[2];
      const settings={
        engine:['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','CARGO_BUILD_JOBS','CARGO_PROFILE_DEV_DEBUG',
          'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS','CARGO_INCREMENTAL','RUSTC_WRAPPER','RUSTDOCFLAGS',
          'CC','CXX','AR','CFLAGS','CXXFLAGS'],
        desktop:['VITE_FIXTURE','NODE_ENV','ESBUILD_BINARY_PATH'],
      };
      for(const [owner,names] of Object.entries(settings)) for(const name of names) {
        delete process.env[name];
        const absent=sourceFingerprint(kind,root);
        process.env[name]='fixture-one';
        const created=sourceFingerprint(kind,root);
        assert.equal(created!==absent,kind===owner,name+' creation for '+kind);
        process.env[name]='fixture-two';
        const edited=sourceFingerprint(kind,root);
        assert.equal(edited!==created,kind===owner,name+' edit for '+kind);
        delete process.env[name];
        assert.equal(sourceFingerprint(kind,root),absent,name+' removal for '+kind);
        if(process.platform==='win32' && ['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','ESBUILD_BINARY_PATH'].includes(name)) {
          const mixed=name.toLowerCase();
          process.env[mixed]='fixture-one';
          assert.equal(sourceFingerprint(kind,root),created,mixed+' normalized casing');
          delete process.env[mixed];
        }
      }
    `, root, kind], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source identity changes for dirty, untracked, deleted, and ignored build configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-provenance-"));
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git(["init"]);
    mkdirSync(join(root, "apps/desktop"), { recursive: true });
    const source = join(root, "apps/desktop/main.ts");
    writeFileSync(join(root, ".gitignore"), ".env.local\n");
    writeFileSync(source, "original"); git(["add", "."]);
    const original = sourceFingerprint("desktop", root);
    writeFileSync(source, "changed"); assert.notEqual(sourceFingerprint("desktop", root), original);
    writeFileSync(source, "original"); assert.equal(sourceFingerprint("desktop", root), original);
    const added = join(root, "apps/desktop/extra.ts");
    writeFileSync(added, "new import"); assert.notEqual(sourceFingerprint("desktop", root), original);
    rmSync(added); rmSync(source); assert.notEqual(sourceFingerprint("desktop", root), original);
    writeFileSync(source, "original");
    writeFileSync(join(root, "apps/desktop/.env.local"), "VITE_FIXTURE=one");
    git(["check-ignore", "apps/desktop/.env.local"]);
    const configured = sourceFingerprint("desktop", root);
    writeFileSync(join(root, "apps/desktop/.env.local"), "VITE_FIXTURE=two");
    assert.notEqual(sourceFingerprint("desktop", root), configured);
    const previousDebug = process.env.VITE_FIXTURE_DEBUG;
    try {
      process.env.VITE_FIXTURE_DEBUG = "0";
      const withoutDebug = sourceFingerprint("desktop", root);
      process.env.VITE_FIXTURE_DEBUG = "2";
      assert.notEqual(sourceFingerprint("desktop", root), withoutDebug);
    } finally {
      if (previousDebug === undefined) delete process.env.VITE_FIXTURE_DEBUG;
      else process.env.VITE_FIXTURE_DEBUG = previousDebug;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [kind, configurations] of Object.entries({
  desktop: [
    [".npmrc", "shared-workspace-lockfile=true\n", "shared-workspace-lockfile=false\n"],
    [".pnpmfile.cjs", "module.exports = {};\n", "module.exports = { hooks: {} };\n"],
    [".pnpmfile.mjs", "export default {};\n", "export default { hooks: {} };\n"],
    ...[".env", ".env.local", ".env.production", ".env.production.local"].map((name) => [
      `apps/desktop/${name}`, "VITE_FIXTURE=one\n", "VITE_FIXTURE=two\n",
    ]),
    ...[".env", ".env.local", ".env.production", ".env.production.local"].map((name) => [
      `services/share-web/viewer/${name}`, "VITE_FIXTURE=one\n", "VITE_FIXTURE=two\n",
    ]),
  ],
  engine: [
    [".cargo/config", "[build]\njobs = 1\n", "[build]\njobs = 2\n"],
    [".cargo/config.toml", "[build]\njobs = 1\n", "[build]\njobs = 2\n"],
  ],
})) test(`${kind} source identity tracks tool configuration regardless of Git state`, () => {
  for (const ignored of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "dohc-build-config-"));
    const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
      git(["init"]);
      mkdirSync(join(root, ".cargo"));
      mkdirSync(join(root, "apps/desktop"), { recursive: true });
      const excludes = join(root, ".git/info/exclude");
      writeFileSync(excludes, ignored ? configurations.map(([name]) => name).join("\n") + "\n" : "");
      git(["config", "core.excludesFile", excludes]);
      for (const [name, first, second] of configurations) {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        const fingerprint = () => sourceFingerprint(kind, root);
        const absent = fingerprint();
        writeFileSync(path, first);
        if (ignored) git(["check-ignore", name]);
        else assert.equal(git(["ls-files", "--others", "--exclude-standard", "--", name]), name);
        const created = fingerprint();
        assert.notEqual(created, absent, `${name} creation (ignored=${ignored})`);
        writeFileSync(path, second);
        const edited = fingerprint();
        assert.notEqual(edited, created, `${name} edit (ignored=${ignored})`);
        rmSync(path);
        assert.equal(fingerprint(), absent, `${name} disappearance (ignored=${ignored})`);

        writeFileSync(path, first);
        git(["add", "--force", "--", name]);
        assert.equal(fingerprint(), created, `${name} staged creation (ignored=${ignored})`);
        writeFileSync(path, second);
        assert.equal(fingerprint(), edited, `${name} unstaged edit (ignored=${ignored})`);
        git(["add", "--force", "--", name]);
        assert.equal(fingerprint(), edited, `${name} staged edit (ignored=${ignored})`);
        rmSync(path);
        assert.equal(fingerprint(), absent, `${name} unstaged deletion (ignored=${ignored})`);
        git(["add", "--update", "--", name]);
        assert.equal(fingerprint(), absent, `${name} staged deletion (ignored=${ignored})`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("source identity excludes unused environment files from preparation", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-env-scope-"));
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const unused = [
    ".env", ".env.local", ".env.production", ".env.production.local",
    ".env.self-host", ".env.self-host.example",
    "apps/desktop/.env.self-host", "apps/desktop/.env.development", "apps/desktop/.env.development.local",
  ];
  try {
    git(["init"]);
    mkdirSync(join(root, "apps/desktop"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".env\n.env.*\n");
    git(["add", ".gitignore"]);
    const baseline = Object.fromEntries(["engine", "desktop"].map((kind) => [kind, sourceFingerprint(kind, root)]));
    for (const name of unused) writeFileSync(join(root, name), "VITE_FIXTURE=one\n");
    // The repository's self-host example is tracked; local deployment files are ignored.
    git(["add", "--force", ".env.self-host.example"]);
    for (const kind of ["engine", "desktop"]) assert.equal(sourceFingerprint(kind, root), baseline[kind], `${kind} unused env creation`);
    for (const name of unused) writeFileSync(join(root, name), "VITE_FIXTURE=two\n");
    for (const kind of ["engine", "desktop"]) assert.equal(sourceFingerprint(kind, root), baseline[kind], `${kind} unused env edit`);
    for (const name of unused) rmSync(join(root, name));
    for (const kind of ["engine", "desktop"]) assert.equal(sourceFingerprint(kind, root), baseline[kind], `${kind} unused env removal`);
    for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
      writeFileSync(join(root, "apps/desktop", name), "VITE_FIXTURE=three\n");
    }
    assert.equal(sourceFingerprint("engine", root), baseline.engine, "Cargo does not load desktop env files");
    assert.notEqual(sourceFingerprint("desktop", root), baseline.desktop, "desktop production env remains an input");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine source identity tracks ancestor and Cargo home configuration outside Git", () => {
  const fixture = mkdtempSync(join(tmpdir(), "dohc-cargo-ancestors-"));
  const parent = join(fixture, "parent");
  const root = join(parent, "checkout");
  const cargoHome = join(fixture, "cargo-home");
  const previousCargoHome = process.env.CARGO_HOME;
  try {
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    process.env.CARGO_HOME = cargoHome;
    for (const directory of [join(parent, ".cargo"), join(fixture, ".cargo"), cargoHome]) {
      mkdirSync(directory, { recursive: true });
      for (const name of ["config", "config.toml"]) {
        const path = join(directory, name);
        const fingerprint = () => sourceFingerprint("engine", root);
        const absent = fingerprint();
        writeFileSync(path, '[build]\nrustflags = ["--cfg", "fixture_one"]\n');
        const created = fingerprint();
        assert.match(created, /^[a-f0-9]{64}$/);
        assert.notEqual(created, absent, `${path} creation`);
        writeFileSync(path, '[build]\nrustflags = ["--cfg", "fixture_two"]\n');
        assert.notEqual(fingerprint(), created, `${path} edit`);
        rmSync(path);
        assert.equal(fingerprint(), absent, `${path} removal`);
        assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
      }
    }
  } finally {
    if (previousCargoHome === undefined) delete process.env.CARGO_HOME;
    else process.env.CARGO_HOME = previousCargoHome;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("artifact identity includes nested file bytes and names", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-artifact-"));
  try {
    mkdirSync(join(root, "nested"));
    const file = join(root, "nested/bundle.js");
    writeFileSync(file, "one"); const original = directoryFingerprint(root);
    writeFileSync(file, "two"); assert.notEqual(directoryFingerprint(root), original);
    writeFileSync(file, "one"); assert.equal(directoryFingerprint(root), original);
    writeFileSync(join(root, "injected.js"), "extra"); assert.notEqual(directoryFingerprint(root), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("gate selection covers root self-host deployment inputs", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/pr-checks.yml"), "utf8");
  for (const file of ["docker-compose.self-host.yml", ".env.self-host.example", ".dockerignore"]) {
    assert.deepEqual(selectedGates([file], workflow), { rust: false, js: true }, file);
  }
});

test("gate selection follows workflow inputs, including shared and gate implementation files", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/pr-checks.yml"), "utf8");
  assert.deepEqual(selectedGates(["docs/guide.md"], workflow), { rust: false, js: false });
  assert.deepEqual(selectedGates(["apps/desktop/src/main.ts"], workflow), { rust: false, js: true });
  assert.deepEqual(selectedGates(["patches/prosemirror-view@1.42.2.patch"], workflow), { rust: true, js: true });
  assert.deepEqual(selectedGates([".config/nextest.toml"], workflow), { rust: true, js: false });
  for (const file of ["examples/fundraiser/backend.ts", "examples/stock-orders/schema.sql"]) {
    assert.deepEqual(selectedGates([file], workflow), { rust: false, js: true }, file);
  }
  for (const file of ["crates/example/src/lib.rs", "pnpm-lock.yaml", ".github/workflows/pr-checks.yml", ".gitignore", "tools/rust-engine-program/build-slot.mjs", "scripts/verification/verify.mjs", ".cargo/config.toml", "package.json", "pnpm-workspace.yaml", ".npmrc", "packages/security-contract/src/effectivePolicy.ts", "packages/workspace-contracts/src/collections.ts", "packages/workspace-core/src/paths.ts", "packages/workspace-auth/src/session.ts", "packages/service-http/src/runtime.ts", "packages/app-backend-runtime/src/child.ts", "examples/fundraiser/package.json", "examples/stock-orders/tsconfig.json", "apps/desktop/package.json", "tsconfig.base.json"]) {
    assert.deepEqual(selectedGates([file], workflow), { rust: true, js: true }, file);
  }
});

test("gate selection includes the old path of committed, staged, and unstaged renames", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-gate-rename-"));
  const git = (args) => execFileSync("git", [
    "-c", `core.hooksPath=${join(root, "no-hooks")}`, "-c", "commit.gpgsign=false",
    "-c", "user.name=Verification Fixture", "-c", "user.email=fixture@example.invalid", ...args,
  ], { cwd: root, encoding: "utf8" }).trim();
  try {
    git(["init"]);
    mkdirSync(join(root, "crates"));
    mkdirSync(join(root, "docs"));
    const oldPath = "crates/renamed fixture.rs";
    const newPath = process.platform === "win32" ? "docs/renamed fixture.rs" : "docs/renamed\nfixture.rs";
    writeFileSync(join(root, oldPath), "fn main() {}\n");
    git(["add", "."]); git(["commit", "-m", "Fixture base"]);
    const base = git(["rev-parse", "HEAD"]);
    const workflow = readFileSync(join(repoRoot, ".github/workflows/pr-checks.yml"), "utf8");
    const assertRenameGates = (files) => {
      assert.deepEqual(new Set(files), new Set([oldPath, newPath]));
      assert.deepEqual(selectedGates(files, workflow), { rust: true, js: true });
    };
    renameSync(join(root, oldPath), join(root, newPath));
    assert.deepEqual(changedFiles(base, false, root), []);
    assertRenameGates(changedFiles(base, true, root));
    git(["add", "-A"]);
    assertRenameGates(changedFiles(base, true, root));
    git(["commit", "-m", "Move fixture outside code filters"]);
    assertRenameGates(changedFiles(base, false, root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a docs-only PR records clean provenance without code tools, while dirty heads and forced gates still fail", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-no-code-gate-"));
  const git = (args) => execFileSync("git", [
    "-c", `core.hooksPath=${join(root, "no-hooks")}`, "-c", "commit.gpgsign=false",
    "-c", "user.name=Verification Fixture", "-c", "user.email=fixture@example.invalid", ...args,
  ], { cwd: root, encoding: "utf8" }).trim();
  try {
    for (const file of [
      "scripts/verification/verify.mjs", "scripts/verification/timing.mjs", "scripts/verification/build.mjs", "scripts/verification/process.mjs", "scripts/verification/doctor.mjs",
      "scripts/verification/cancellation.mjs", "scripts/verification/js-tests.mjs", "scripts/verification/selection.mjs",
      "tools/rust-engine-program/build-slot.mjs", "tools/rust-engine-program/tree-provenance.mjs",
      "apps/desktop/scripts/require-e2e-engine.mjs", ".github/workflows/pr-checks.yml",
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(repoRoot, file), join(root, file));
    }
    writeFileSync(join(root, ".gitignore"), ".agent-artifacts/\n");
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(root, "apps/desktop/package.json"), '{}\n');
    git(["init"]); git(["config", "core.logAllRefUpdates", "true"]);
    git(["add", "."]); git(["commit", "-m", "Fixture base"]);
    const base = git(["rev-parse", "HEAD"]);
    mkdirSync(join(root, "docs"));
    const document = join(root, "docs/guide.md");
    writeFileSync(document, "Documentation only.\n");
    git(["add", "."]); git(["commit", "-m", "Document the fixture"]);
    const head = git(["rev-parse", "HEAD"]);
    const require = createRequire(join(repoRoot, "apps/desktop/package.json"));
    const childScript = `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const exec = childProcess.execFileSync;
      childProcess.execFileSync = (command, ...args) => {
        if (command !== "git") throw new Error("Unavailable code tool: " + command);
        return exec(command, ...args);
      };
      childProcess.spawn = command => { throw new Error("Unavailable code tool: " + command); };
      syncBuiltinESMExports();
      const { verify } = await import("./scripts/verification/verify.mjs");
      const report = await verify(process.argv.slice(1));
      console.log(JSON.stringify(report));
    `;
    const invoke = (extra = []) => spawnSync(process.execPath, ["--input-type=module", "-e", childScript, "pr", "--base", base, ...extra], {
      cwd: root, encoding: "utf8", timeout: 20_000,
      env: { ...process.env, NODE_PATH: dirname(dirname(require.resolve("js-yaml/package.json"))) },
    });
    const clean = invoke();
    assert.equal(clean.error, undefined);
    assert.equal(clean.status, 0, clean.stderr);
    const report = JSON.parse(clean.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(report.verdict, "PASS");
    assert.equal(report.commit, head);
    assert.equal(report.provenance.status, "PASS");
    assert.equal(report.dirty, false);
    assert.deepEqual(report.gates, { rust: false, js: false });
    assert.deepEqual(report.steps, []);
    assert.ok(report.seconds >= 0 && report.startedAt && report.finishedAt);
    assert.deepEqual(report.timings.map(phase => phase.name), ["selection", "source-check:finish"]);
    assert.equal(report.doctor, undefined);
    assert.equal(report.build, undefined);
    assert.match(report.reason, /No code gate applies/);

    writeFileSync(document, "Dirty documentation.\n");
    const dirty = invoke();
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /Commit the worktree/);
    writeFileSync(document, "Documentation only.\n");
    const forced = invoke(["--job", "rust"]);
    assert.notEqual(forced.status, 0);
    assert.match(forced.stderr, /Unavailable code tool: rustc/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Postgres startup rejection cleans its created container and preserves startup and cleanup failures", async () => {
  for (const cleanupFails of [false, true]) {
    const startupError = new Error("docker run timed out after creating its container");
    const calls = [];
    const containers = new Set();
    let ownedName;
    const command = async (executable, args, options) => {
      assert.equal(executable, "docker");
      calls.push({ args, options });
      if (args[0] === "run") {
        assert.equal(args[args.indexOf("--health-cmd") + 1], "pg_isready -h 127.0.0.1 -U dohc -d dohc");
        assert.equal(args[args.indexOf("--health-start-period") + 1], "90s");
        assert.equal(args[args.indexOf("--health-start-interval") + 1], "1s");
        ownedName = args[args.indexOf("--name") + 1];
        containers.add(ownedName);
        throw startupError;
      }
      assert.deepEqual(args, ["rm", "--force", ownedName]);
      if (cleanupFails) throw new Error("Docker cleanup is unavailable");
      containers.delete(ownedName);
      return { stdout: ownedName };
    };
    await assert.rejects(postgres("unused-output", command), (error) => {
      assert.equal(error, startupError);
      if (cleanupFails) assert.match(error.cleanupError, /Could not remove verification Postgres.*Docker cleanup is unavailable/);
      else assert.equal(error.cleanupError, undefined);
      return true;
    });
    assert.match(ownedName, /^dohc-verify-[a-f0-9-]+$/);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.timeoutMs, 30_000);
    assert.match(calls[1].options.log, /postgres-stop\.log$/);
    assert.equal(containers.has(ownedName), cleanupFails);
  }
});

test("POSIX engine permission loss rejects unchanged bytes and repairs only owned artifacts", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-engine-permission-"));
  try {
    const source = join(root, "dohc-workspace-engine");
    const stagedDirectory = join(root, "staged");
    mkdirSync(stagedDirectory);
    const staged = join(stagedDirectory, "dohc-workspace-engine");
    writeFileSync(source, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    copyFileSync(source, staged);
    const expectedHash = hashFile(source);
    assert.equal(engineArtifactMatches(source, expectedHash), true);
    assert.equal(engineArtifactMatches(staged, expectedHash), true);

    chmodSync(source, 0o644);
    assert.equal(hashFile(source), expectedHash);
    assert.equal(engineArtifactMatches(source, expectedHash), false);
    repairOwnedEngineExecutable(source);
    assert.equal(engineArtifactMatches(source, expectedHash), true);

    chmodSync(staged, 0o644);
    assert.equal(hashFile(staged), expectedHash);
    assert.equal(engineArtifactMatches(staged, expectedHash), false);
    requireE2eEngine({ override: source, desktopTargetDir: stagedDirectory, platform: "linux" });
    assert.equal(engineArtifactMatches(staged, expectedHash), true);

    const external = join(root, "external-engine");
    const link = join(root, "linked-engine");
    writeFileSync(external, "foreign artifact", { mode: 0o644 });
    symlinkSync(external, link);
    assert.throws(() => repairOwnedEngineExecutable(link), /unowned engine artifact/);
    assert.equal(statSync(external).mode & 0o777, 0o644);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("build children use owned output paths and cannot expand the compiler budget", () => {
  for (const requested of ["-1", "0", "default", "invalid", "1", "999"]) {
    const source = { CARGO_BUILD_JOBS: requested, Cargo_Target_Dir: "foreign", CARGO_BUILD_BUILD_DIR: "foreign", CARGO_BUILD_TARGET: "other-host", PATH: "retained" };
    const env = buildEnvironment(8, source);
    assert.equal(env.CARGO_BUILD_JOBS, requested === "1" ? "1" : "8");
    for (const key of ["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CARGO_BUILD_BUILD_DIR"]) assert.equal(env[key], join(repoRoot, "target"));
    assert.equal(env.Cargo_Target_Dir, undefined);
    assert.equal(env.CARGO_BUILD_TARGET, undefined);
    assert.equal(env.PATH, "retained");
    assert.equal(source.Cargo_Target_Dir, "foreign");
  }
});

test("failed commands retain their output and reject instead of reporting success", async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-command-"));
  const log = join(root, "failure.log");
  try {
    await assert.rejects(run(process.execPath, ["-e", "console.error('failure-evidence');process.exit(7)"], { log }), /failed \(7\)/);
    assert.match(readFileSync(log, "utf8"), /failure-evidence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stalled command times out, stops its process, and retains its output", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dohc-command-timeout-"));
  const log = join(root, "timeout.log");
  let child;
  const timeoutMs = 1000;
  // The mocked deadline expires only once the command has printed, so a loaded
  // host cannot time it out before the output the test checks for exists.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { if (child?.exitCode === null && child.signalCode === null) child.kill(); });
  try {
    await assert.rejects(run(process.execPath, ["-e", "console.log('waiting-for-service');setInterval(() => {}, 1000)"], {
      log, timeoutMs, onSpawn: (spawned) => {
        child = spawned;
        let stdout = "";
        spawned.stdout.on("data", function ready(chunk) {
          stdout += chunk;
          if (!stdout.includes("waiting-for-service")) return;
          spawned.stdout.off("data", ready);
          t.mock.timers.tick(timeoutMs);
        });
      },
    }), new RegExp(`timed out after ${timeoutMs}ms`));
    assert.ok(child.exitCode !== null || child.signalCode !== null, "the timed-out process must have exited");
    assert.match(readFileSync(log, "utf8"), /waiting-for-service/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
