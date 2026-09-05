import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvironment, directoryFingerprint, sourceFingerprint } from "./build.mjs";
import { selectedGates } from "./verify.mjs";
import { repoRoot, run } from "./process.mjs";

test("source identity changes for dirty, untracked, deleted, and ignored build configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-provenance-"));
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git(["init"]);
    mkdirSync(join(root, "apps/desktop"), { recursive: true });
    const source = join(root, "apps/desktop/main.ts");
    writeFileSync(source, "original"); git(["add", "."]);
    const original = sourceFingerprint("desktop", root);
    writeFileSync(source, "changed"); assert.notEqual(sourceFingerprint("desktop", root), original);
    writeFileSync(source, "original"); assert.equal(sourceFingerprint("desktop", root), original);
    const added = join(root, "apps/desktop/extra.ts");
    writeFileSync(added, "new import"); assert.notEqual(sourceFingerprint("desktop", root), original);
    rmSync(added); rmSync(source); assert.notEqual(sourceFingerprint("desktop", root), original);
    writeFileSync(source, "original");
    writeFileSync(join(root, ".env.local"), "VITE_FIXTURE=one");
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
