import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildEnvironment, directoryFingerprint, engineArtifactMatches, hashFile, repairOwnedEngineExecutable, sourceFingerprint } from "./build.mjs";
import { changedFiles, postgres, selectedGates } from "./verify.mjs";
import { repoRoot, run } from "./process.mjs";
import { requireE2eEngine } from "../../apps/desktop/scripts/require-e2e-engine.mjs";
import { createPrepareFixture } from "./prepare-fixture.mjs";
import { runEarlyCloseDebugFixture } from "./debug-fixture.mjs";

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
    `], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
      `], { cwd: root, encoding: "utf8", timeout: 10_000,
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
      log, quietStdout: true, timeoutMs: 5000,
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
      log, quietStdout: true, timeoutMs: 5000,
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
    assert.deepEqual(calls().map(({ command, args }) => [command, args[0]]), [["pnpm", "install"], ["cargo", "build"], ["pnpm", "--filter"]]);
    writeFileSync(join(root, "node_modules/installed.txt"), "stale-again");
    const reused = invoke();
    assert.equal(reused.status, 0, reused.stderr);
    assert.match(reused.stdout, /reuse desktop/);
    assert.equal(readFileSync(join(root, "node_modules/installed.txt"), "utf8"), "new-lock");
    assert.equal(calls().length, 4);
    assert.deepEqual(calls().at(-1), { command: "pnpm", args: ["install", "--frozen-lockfile"] });
    rmSync(join(root, ".dohc-dev/verification/build.json"));
    const failed = invoke({ failInstall: true });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /frozen install rejected/);
    assert.equal(calls().length, 5);
    assert.equal(existsSync(join(root, ".dohc-dev/verification/build.json")), false);
    assert.equal(existsSync(join(root, ".dohc-dev/verification/build.json.lock")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    `], { cwd: root, encoding: "utf8", timeout: 10_000 });
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
    `, root], { encoding: "utf8", timeout: 10_000 });
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
        desktop:['VITE_FIXTURE','NODE_ENV'],
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
        if(process.platform==='win32' && ['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS'].includes(name)) {
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

test("gate selection follows workflow inputs, including shared and gate implementation files", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/pr-checks.yml"), "utf8");
  assert.deepEqual(selectedGates(["docs/guide.md"], workflow), { rust: false, js: false });
  assert.deepEqual(selectedGates(["apps/desktop/src/main.ts"], workflow), { rust: false, js: true });
  for (const file of ["crates/example/src/lib.rs", "pnpm-lock.yaml", ".github/workflows/pr-checks.yml", ".gitignore", "tools/rust-engine-program/build-slot.mjs", ".cargo/config.toml", "package.json", "pnpm-workspace.yaml", ".npmrc", "packages/security-contract/src/effectivePolicy.ts", "packages/workspace-contracts/src/collections.ts", "packages/workspace-core/src/paths.ts", "apps/desktop/package.json", "tsconfig.base.json"]) {
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
      "scripts/verification/verify.mjs", "scripts/verification/build.mjs", "scripts/verification/process.mjs", "scripts/verification/doctor.mjs",
      "scripts/verification/cancellation.mjs",
      "tools/rust-engine-program/build-slot.mjs", "tools/rust-engine-program/tree-provenance.mjs",
      "apps/desktop/scripts/require-e2e-engine.mjs", "apps/desktop/scripts/stage-plugin-tools.mjs", ".github/workflows/pr-checks.yml",
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
      cwd: root, encoding: "utf8", timeout: 15_000,
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

test("a stalled command times out, stops its process, and retains its output", { timeout: 10_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dohc-command-timeout-"));
  const log = join(root, "timeout.log");
  let child;
  const timeoutMs = process.platform === "win32" ? 3000 : 1000;
  t.after(() => { if (child?.exitCode === null && child.signalCode === null) child.kill(); });
  try {
    await assert.rejects(run(process.execPath, ["-e", "console.log('waiting-for-service');setInterval(() => {}, 1000)"], {
      log, timeoutMs, onSpawn: (process) => { child = process; },
    }), new RegExp(`timed out after ${timeoutMs}ms`));
    assert.ok(child.exitCode !== null || child.signalCode !== null, "the timed-out process must have exited");
    assert.match(readFileSync(log, "utf8"), /waiting-for-service/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
