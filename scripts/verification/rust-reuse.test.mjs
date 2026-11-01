import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { mock } from "node:test";
import { sourceFingerprint } from "./build.mjs";
import { readGit } from "../../tools/rust-engine-program/git-read.mjs";
import { readTreeState } from "../../tools/rust-engine-program/tree-provenance.mjs";
import { finishRustEvidence, readRustReuse, refreshRustReuse, rustIdentity, sealRustEvidence } from "./rust-reuse.mjs";

const steps = ["tree provenance", "native target", "fixture drift", "fmt --check", "clippy -D warnings", "test --workspace",
  "reader tests", "doctests", "build daemon", "cargo-deny", "cargo-audit", "scratch leak"];
const tools = {rustc: "rustc fixture", cargo: "cargo fixture", deny: "cargo-deny 0.20.2", audit: "cargo-audit 0.22.2", nextest: "cargo-nextest 0.9.143"};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dohc-rust-reuse-"));
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), text); };
  const git = args => readGit(args, root);
  const commit = () => { git(["add", "."]); git(["commit", "-qm", "fixture"]); return git(["rev-parse", "HEAD"]).trim(); };
  git(["init", "-q"]); git(["config", "commit.gpgsign", "false"]); git(["config", "core.autocrlf", "false"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  put(".gitignore", ".agent-artifacts/\n.cargo/config.toml\n.config/nextest.toml\n");
  put("Cargo.toml", "fixture cargo manifest");
  put("crates/fixture/src/lib.rs", "fixture native source");
  put("scripts/verification/verify.mjs", "fixture verification driver");
  put("apps/desktop/src/renderer/History.tsx", "fixture renderer");
  const head = commit();
  const output = join(root, ".agent-artifacts/verification/original");
  const file = join(output, "result.json");
  const state = () => readTreeState(command => git(command.split(" ").slice(1)), () => true);
  const timestamp = new Date().toISOString();
  const report = {mode: "pr", root, output, commit: head, dirty: false, gates: {rust: true, js: true}, verdict: "FAIL",
    error: "JavaScript assertion failed.", startedAt: timestamp, finishedAt: timestamp,
    treeReadings: [{step: "start", state: state()}, {step: "rust-receipt:finish", state: state()}],
    provenance: {status: "PASS"}, doctor: {checks: [{name: "rustc", state: "PASS", detail: tools.rustc}, {name: "cargo", state: "PASS", detail: tools.cargo}]},
    steps: ["cargo-deny-version", "cargo-audit-version", "cargo-nextest-version", "rust", "rust-verdict"].map(name => ({name, verdict: "PASS",
      finishedAt: timestamp, seconds: 1, log: join(output, `${name}.log`)}))};
  const log = `== summary ==\n${steps.map(name => `  PASS ${name}`).join("\n")}\n- ${timestamp} | run-rust-checks | ${process.platform}/${process.arch} (rust cfg fixture, head ${head.slice(0, 8)} clean, 10 reads) | PASS | ${steps.map(name => `${name}=PASS`).join(" ")}\n`;
  put(".agent-artifacts/verification/original/rust.log", log);
  for (const tool of ["deny", "audit", "nextest"]) put(`.agent-artifacts/verification/original/cargo-${tool}-version.log`, tools[tool] + "\n");
  put(".agent-artifacts/verification/original/rust-verdict.log", "canonical CI verdict verified\n");
  const compiler = mock.method(childProcess, "execFileSync", (command, ...args) => {
    if (command === "rustc") return Buffer.from("fixture compiler identity");
    throw new Error(`Unexpected live tool in reuse fixture: ${command}`);
  });
  syncBuiltinESMExports();
  const identity = (env = process.env) => rustIdentity({root, engine: sourceFingerprint("engine", root), tools, env});
  report.rustEvidence = sealRustEvidence(report, identity());
  const save = () => writeFileSync(file, JSON.stringify(report));
  save();
  return {root, put, git, commit, report, file, log, save, identity,
    close() { compiler.mock.restore(); syncBuiltinESMExports(); rmSync(root, {recursive: true, force: true}); }};
}

test("a completed Rust pass survives a JavaScript failure, renderer fix, and same-tree rebase", () => {
  const f = fixture();
  try {
    const originalBytes = readFileSync(f.file);
    f.put("apps/desktop/src/renderer/History.tsx", "corrected renderer");
    const head = f.commit();
    const reused = readRustReuse(f.file, {root: f.root, identity: f.identity()});
    assert.equal(reused.kind, "reused");
    assert.equal(reused.commit, f.report.commit);
    assert.notEqual(reused.commit, head);
    assert.deepEqual(reused.changedFiles, ["apps/desktop/src/renderer/History.tsx"]);
    assert.deepEqual(readFileSync(f.file), originalBytes);
    f.git(["commit", "--allow-empty", "-qm", "same tree on advanced base"]);
    assert.equal(readRustReuse(f.file, {root: f.root, identity: f.identity()}).commit, f.report.commit);
    f.put("apps/desktop/src/renderer/History.tsx", "uncommitted renderer change");
    assert.throws(() => readRustReuse(f.file, {root: f.root, identity: f.identity()}), /clean current checkout/);
  } finally { f.close(); }
});

test("native sources, dependencies, drivers, fixtures, and configuration invalidate reuse", () => {
  for (const path of ["crates/fixture/src/lib.rs", "Cargo.lock", "package.json", "pnpm-lock.yaml", "scripts/verification/verify.mjs",
    "tools/rust-engine-program/check-fixture-drift.mjs", "deny.toml", ".github/workflows/pr-checks.yml",
    "packages/ydoc-projection/src/index.ts", "packages/app-backend-runtime/src/index.ts", "unknown-input.txt"]) {
    const f = fixture();
    try {
      f.put(path, "changed relevant input"); f.commit();
      assert.throws(() => readRustReuse(f.file, {root: f.root, identity: f.identity()}), /changed/, path);
    } finally { f.close(); }
  }
});

test("ignored Cargo configuration and gate environment changes invalidate reuse", () => {
  const f = fixture();
  try {
    f.put(".cargo/config.toml", "[build]\njobs = 2\n");
    assert.throws(() => readRustReuse(f.file, {root: f.root, identity: f.identity()}), /changed/);
    rmSync(join(f.root, ".cargo/config.toml"));
    f.put(".config/nextest.toml", "[profile.default]\ntest-threads = 1\n");
    assert.throws(() => readRustReuse(f.file, {root: f.root, identity: f.identity()}), /changed/);
    rmSync(join(f.root, ".config/nextest.toml"));
    for (const key of ["NEXTEST_TEST_THREADS", "DOHC_GATE_DISK_FLOOR_GB", "RUSTFLAGS", "CARGO_BUILD_JOBS", "NODE_OPTIONS"]) {
      assert.throws(() => readRustReuse(f.file, {root: f.root, identity: f.identity({...process.env, [key]: "changed"})}), /changed/, key);
    }
    const identity = f.identity(); identity.tools = {...identity.tools, cargo: "different cargo"};
    assert.throws(() => readRustReuse(f.file, {root: f.root, identity}), /changed/);
  } finally { f.close(); }
});

test("missing, mutated, incomplete, forged, dirty, interrupted, and chained receipts are refused", () => {
  const cases = [
    [r => { r.verdict = "RUNNING"; }, /completed/], [r => { delete r.finishedAt; }, /completed/],
    [r => { r.dirty = true; }, /completed/], [r => { r.gates.rust = false; }, /completed/],
    [r => { r.error = "Verification interrupted by SIGTERM"; }, /uninterrupted/],
    [r => { r.cleanupError = "cleanup failed"; }, /completed/],
    [r => { r.treeReadings.at(-1).state.dirty = [" M Cargo.toml"]; }, /provenance/],
    [r => { r.treeReadings.at(-1).state.head = "b".repeat(40); }, /provenance/],
    [r => { r.provenance.status = "FAIL"; }, /provenance/],
    [r => { delete r.rustEvidence; }, /no original Rust identity/],
    [r => { r.rustEvidence.kind = "reused"; }, /original Rust identity/],
    [r => { r.rustEvidence.identity.inputs = "forged"; }, /recorded Git commit/],
    [r => { r.rustEvidence.identity.tools.cargo = "forged cargo"; }, /tool identity/],
    [r => { r.steps.find(s => s.name === "rust").verdict = "FAIL"; }, /complete PASS/],
    [r => { delete r.steps.find(s => s.name === "rust-verdict").finishedAt; }, /complete PASS/],
    [r => { r.steps.push({...r.steps.find(s => s.name === "rust")}); }, /complete PASS/],
  ];
  for (const [change, expected] of cases) {
    const f = fixture();
    try { change(f.report); f.save(); assert.throws(() => readRustReuse(f.file, {root: f.root, identity: f.identity()}), expected); }
    finally { f.close(); }
  }
  for (const name of ["rust", "rust-verdict", "cargo-deny-version"]) for (const deleted of [false, true]) {
    const f = fixture();
    try {
      const path = join(f.report.output, `${name}.log`);
      if (deleted) rmSync(path); else writeFileSync(path, readFileSync(path, "utf8") + "modified\n");
      assert.throws(() => readRustReuse(f.file, {root: f.root, identity: f.identity()}));
    } finally { f.close(); }
  }
});

test("a step PASS cannot substitute for skipped or missing canonical gate checks", () => {
  for (const name of ["native target", "test --workspace", "reader tests", "cargo-deny", "cargo-audit", "scratch leak"]) {
    const f = fixture();
    try {
      const badLog = f.log.replace(`${name}=PASS`, `${name}=SKIP`);
      writeFileSync(join(f.report.output, "rust.log"), badLog);
      assert.throws(() => sealRustEvidence(f.report, f.identity()), /did not report PASS/);
      writeFileSync(join(f.report.output, "rust.log"), f.log.replace(`${name}=PASS`, ""));
      assert.throws(() => sealRustEvidence(f.report, f.identity()), /step|rows/);
    } finally { f.close(); }
  }
});

test("reuse refreshes both security tools and rejects either fresh failure", async () => {
  const f = fixture();
  try {
    for (const fail of [null, "cargo-deny-refresh", "cargo-audit-refresh"]) {
      const calls = [];
      const action = refreshRustReuse(f.file, {root: f.root, identity: f.identity(), step: async (name, command, args) => {
        calls.push([name, command, args]);
        if (name === fail) throw new Error(`fresh ${name} failed`);
      }});
      if (fail) await assert.rejects(action, /fresh.*failed/);
      else assert.equal((await action).kind, "reused");
      assert.deepEqual(calls, [["cargo-deny-refresh", "cargo", ["deny", "check"]],
        ...(fail === "cargo-deny-refresh" ? [] : [["cargo-audit-refresh", "cargo", ["audit"]]])]);
    }
  } finally { f.close(); }
});

test("finishing reused evidence rejects ignored configuration and environment drift after fresh audits", async () => {
  const f = fixture();
  try {
    const initial = f.identity();
    const evidence = await refreshRustReuse(f.file, {root: f.root, identity: initial, step: async () => {}});
    const report = {...f.report, rustEvidence: evidence};
    assert.equal(finishRustEvidence(report, initial, f.identity()).kind, "reused");
    for (const path of [".config/nextest.toml", ".cargo/audit.toml", "deny.toml"]) {
      f.put(path, "changed during the JavaScript job");
      assert.throws(() => finishRustEvidence(report, initial, f.identity()), /changed before the receipt finished/, path);
      rmSync(join(f.root, path));
    }
    assert.throws(() => finishRustEvidence(report, initial, f.identity({...process.env, NEXTEST_TEST_THREADS: "changed"})), /changed before the receipt finished/);
    const dirty = {...report, treeReadings: structuredClone(report.treeReadings)};
    dirty.treeReadings.at(-1).state.dirty = [" M Cargo.toml"];
    assert.throws(() => finishRustEvidence(dirty, initial, f.identity()), /final clean tree provenance/);
  } finally { f.close(); }
});
