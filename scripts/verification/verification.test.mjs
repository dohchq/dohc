import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvironment, directoryFingerprint, engineArtifactMatches, hashFile, repairOwnedEngineExecutable, sourceFingerprint } from "./build.mjs";
import { changedFiles, selectedGates } from "./verify.mjs";
import { repoRoot, run } from "./process.mjs";
import { requireE2eEngine } from "../../apps/desktop/scripts/require-e2e-engine.mjs";

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
  t.after(() => { if (child?.exitCode === null && child.signalCode === null) child.kill(); });
  try {
    await assert.rejects(run(process.execPath, ["-e", "console.log('waiting-for-service');setInterval(() => {}, 1000)"], {
      log, timeoutMs: 1000, onSpawn: (process) => { child = process; },
    }), /timed out after 1000ms/);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "the timed-out process must have exited");
    assert.match(readFileSync(log, "utf8"), /waiting-for-service/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
