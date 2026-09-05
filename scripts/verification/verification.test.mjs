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

test("standalone preparation installs frozen dependencies before building, sealing, or reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-prepare-install-"));
  try {
    const invoke = createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
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
      const before=sourceFingerprint('desktop',root);
      process.env[mixed]='1';
      const after=sourceFingerprint('desktop',root);
      if(process.platform==='win32') {
        assert.equal(process.env[upper],'1');
        assert.notEqual(before,after);
        delete process.env[mixed]; process.env[upper]='1';
        assert.equal(sourceFingerprint('desktop',root),after);
      } else {
        assert.equal(before,after);
        process.env[upper]='1';
        assert.notEqual(sourceFingerprint('desktop',root),after);
      }
    `, root], { encoding: "utf8", timeout: 10_000 });
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
    writeFileSync(join(root, ".env.local"), "VITE_FIXTURE=one");
    git(["check-ignore", ".env.local"]);
    const configured = sourceFingerprint("desktop", root);
    writeFileSync(join(root, ".env.local"), "VITE_FIXTURE=two");
    assert.notEqual(sourceFingerprint("desktop", root), configured);
    const previousDebug = process.env.CARGO_PROFILE_DEV_DEBUG;
    try {
      process.env.CARGO_PROFILE_DEV_DEBUG = "0";
      const withoutDebug = sourceFingerprint("desktop", root);
      process.env.CARGO_PROFILE_DEV_DEBUG = "2";
      assert.notEqual(sourceFingerprint("desktop", root), withoutDebug);
    } finally {
      if (previousDebug === undefined) delete process.env.CARGO_PROFILE_DEV_DEBUG;
      else process.env.CARGO_PROFILE_DEV_DEBUG = previousDebug;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [kind, configurations] of Object.entries({
  desktop: [
    [".npmrc", "shared-workspace-lockfile=true\n", "shared-workspace-lockfile=false\n"],
    [".pnpmfile.cjs", "module.exports = {};\n", "module.exports = { hooks: {} };\n"],
    [".pnpmfile.mjs", "export default {};\n", "export default { hooks: {} };\n"],
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
  for (const file of ["crates/example/src/lib.rs", "pnpm-lock.yaml", ".github/workflows/pr-checks.yml", ".gitignore", "tools/rust-engine-program/build-slot.mjs", ".cargo/config.toml", "package.json", "pnpm-workspace.yaml", ".npmrc", "packages/security-contract/src/effectivePolicy.ts", "packages/workspace-contracts/src/collections.ts", "apps/desktop/package.json", "tsconfig.base.json"]) {
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
