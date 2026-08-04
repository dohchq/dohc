#!/usr/bin/env node
// LOCAL-RUNNER: Rust engine checks (shard R02).
//
// Replaces GitHub CI for the Rust workspace per the Gate 0 decision
// (DECISIONS.md: "GitHub CI SKIPPED ... evidence is local-first"). Runs the
// Rust policy gate and prints a timestamped evidence line the integrator
// pastes into docs/superpowers/plans/rust-engine/EXECUTION_LOG.md.
//
// Requirements: Node >= 22, zero npm dependencies. Windows-first — works from
// PowerShell and Git Bash (spawns through the platform shell).
//
// Steps: native target (see below), fixture drift, cargo fmt --check, cargo
// clippy -D warnings, cargo build --workspace, cargo test --workspace, the
// collab crash tier (which only compiles under `--features fault-injection`,
// so the plain workspace run never sees it), then cargo-deny / cargo-audit IF
// installed (skip-with-warning when absent, never fail on a missing tool).
//
// A REQUIRED step that SKIPs fails the verdict: a gate that silently drops a
// row is how the fault-injection tests went unrun for a month. Optional tools
// may still skip.
//
// PROVENANCE: the run resolves `git rev-parse HEAD` before the first step and
// again after the last, and stamps the commit into both the summary block and
// the evidence line. A verdict that cannot name the tree it examined is not
// evidence — two concurrent runs sharing one worktree produced PASS and FAIL
// for the same commit, and neither log could say which tree it had read. HEAD
// moving mid-run FAILS the verdict, and so does the worktree changing under
// it; a tree already dirty when the run starts is recorded, not failed,
// because running the gate over uncommitted work is the normal local loop and
// a check that forbids it just gets removed. Recorded is the point: the
// reader learns the sha does not describe everything that ran.
//
// Usage:
//   node tools/rust-engine-program/run-rust-checks.mjs
// Exit code is non-zero if any REQUIRED step fails (optional tool skips do not
// fail the run).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { arch, platform, release, tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { verifyNativeTarget } from "./native-target.mjs";
import {
  classifyTreeProvenance,
  formatTreeState,
  readTreeState,
} from "./tree-provenance.mjs";
import { SCRATCH_SENTINEL, inspectScratchRun } from "./scratch-leak-report.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
// Hand the tests the absolute root instead of a name they would re-derive.
// `os.tmpdir()` and Rust's `std::env::temp_dir()` read different variables and
// agree only by luck: under WSL the inherited TEMP/TMP point at /mnt/c, which
// Node returns, while Rust with TMPDIR unset returns /tmp. Deriving it twice
// let this row count an absent tree and call the run clean.
const scratchRunId = `rust-gate-${process.pid}-${randomBytes(8).toString("hex")}`;
const scratchRunRoot = join(tmpdir(), "dohc-test-scratch", scratchRunId);
process.env.DOHC_TEST_SCRATCH_ROOT = scratchRunRoot;
// The sentinel is how the row tells "nothing leaked" from "nothing looked".
// It is written before the tests and required afterwards; if it is missing the
// row never reached the tree the tests used, whatever the entry count says.
mkdirSync(scratchRunRoot, { recursive: true });
writeFileSync(join(scratchRunRoot, SCRATCH_SENTINEL), scratchRunId);

function run(cmd) {
  // shell:true so `cargo`/`cargo.exe` resolve identically under PowerShell,
  // Git Bash, and a Linux/WSL shell. stdio inherited so output streams live.
  const res = spawnSync(cmd, {
    cwd: repoRoot,
    shell: true,
    stdio: "inherit",
  });
  if (res.error) return { ok: false, code: null, error: res.error };
  return { ok: res.status === 0, code: res.status };
}

// The steps' own shell, so the provenance is read exactly where they ran.
function captureGit(cmd) {
  const res = spawnSync(cmd, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
  });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

function toolAvailable(probe) {
  const res = spawnSync(probe, { cwd: repoRoot, shell: true, stdio: "ignore" });
  return !res.error && res.status === 0;
}

const required = [
  {
    name: "fixture drift",
    cmd: "node tools/rust-engine-program/check-fixture-drift.mjs",
    skipCode: 2,
    skipReason: "yjs/tsx unavailable; fixture drift not checked",
  },
  { name: "fmt --check", cmd: "cargo fmt --all --check" },
  {
    name: "clippy -D warnings",
    cmd: "cargo clippy --workspace --all-targets --all-features -- -D warnings",
  },
  { name: "build --workspace", cmd: "cargo build --workspace" },
  { name: "test --workspace", cmd: "cargo test --workspace" },
  {
    // The crash-recovery / exactly-once tests in dohc-engine-collab are behind
    // its `fault-injection` feature, which nothing in the workspace graph
    // enables — `cargo test --workspace` compiles them out. The workspace root
    // is virtual, so the feature must be enabled through an explicit `-p` run.
    name: "test collab crash tier",
    cmd: "cargo test -p dohc-engine-collab --features fault-injection",
  },
];

// Cost of the native-target probe: a check-build of dohc-engine-protocol and
// its dependencies. It is not free and not fully shared — the probe compiles
// the crate's default features while the clippy step below passes
// `--all-features`, so tokio and its dependencies are checked once for each
// feature set. Measured, the guard's own cost is one extra tokio check-build,
// seconds on a warm target dir. It runs first and unconditionally: a guard
// behind a flag no call site passes is not a guard.

// Optional supply-chain checks: run only when the tool is installed.
const optional = [
  { name: "cargo-deny", probe: "cargo deny --version", cmd: "cargo deny check" },
  { name: "cargo-audit", probe: "cargo audit --version", cmd: "cargo audit" },
];

const results = [];
let failed = false;

// One reading per step boundary, not one before and one after the run. A tree
// that changes and changes back reads identical at the two ends, so endpoints
// alone certify an interval nothing observed.
//
// Each reading is a `git rev-parse` and a `git status --untracked-files=all`
// through a shell. Measured on this repo on Windows, the slowest of the
// platforms the gate runs on: ~0.9s per reading, ~9s for the ten a full run
// takes — under a percent of a gate that spends twenty minutes in cargo.
const readings = [{ step: "start", state: readTreeState(captureGit) }];
const readTreeAfter = (step) =>
  readings.push({ step, state: readTreeState(captureGit) });

console.log(`\n== dohc Rust engine local checks ==`);
console.log(`host: ${platform()} ${arch()} (${release()})`);
console.log(`repo: ${repoRoot}`);
console.log(`tree at start: ${formatTreeState(readings[0].state)}\n`);

console.log(`\n--- native target ---`);
const native = verifyNativeTarget();
if (native.ok) {
  console.log(`  rust cfg ${native.cfg} — matches the host.`);
} else {
  // cargo's full output first: its primary error sits above the tail.
  if (native.output) console.error(native.output);
  console.error(`  native target — FAILED: ${native.reason}`);
  failed = true;
}
results.push({
  name: "native target",
  status: native.ok ? "PASS" : "FAIL",
  reason: native.ok ? undefined : native.reason,
});
readTreeAfter("native target");

// An unverified host makes every later result unattributable, so nothing else
// runs — and the expensive steps are the ones worth skipping.
for (const step of native.ok ? required : []) {
  console.log(`\n--- ${step.name} ---`);
  const r = run(step.cmd);
  // Read as soon as the command returns, before anything else can touch the
  // tree, so the interval this reading closes is the step's own.
  readTreeAfter(step.name);
  if (r.code === step.skipCode) {
    // A skipped required step is a FAIL: stamping PASS with a row missing is
    // exactly the blind spot this gate exists to prevent.
    console.error(
      `  ${step.name} — SKIPPED (${step.skipReason}) — required steps may not skip; install the missing dependency (\`pnpm install --frozen-lockfile\`) and rerun.`,
    );
    failed = true;
    results.push({
      name: step.name,
      status: "SKIP",
      reason: `${step.skipReason}; required step skipped → verdict FAIL`,
    });
    continue;
  }
  if (!r.ok) failed = true;
  results.push({
    name: step.name,
    status: r.ok ? "PASS" : "FAIL",
  });
  if (r.error) console.error(`  (spawn error: ${r.error.message})`);
}

for (const step of native.ok ? optional : []) {
  console.log(`\n--- ${step.name} ---`);
  if (!toolAvailable(step.probe)) {
    console.warn(
      `  ${step.name} not installed — SKIPPED (install with \`cargo install ${step.name} --locked\`).`,
    );
    // Nothing ran, so there is no interval to attribute to this step and no
    // reading to take: a boundary names the step that consumed the time
    // before it.
    results.push({ name: step.name, status: "SKIP" });
    continue;
  }
  const r = run(step.cmd);
  readTreeAfter(step.name);
  if (!r.ok) failed = true;
  results.push({ name: step.name, status: r.ok ? "PASS" : "FAIL" });
}

console.log(`\n--- scratch leak ---`);
try {
  const scratch = await inspectScratchRun(scratchRunRoot);
  if (scratch.status === "FAIL") failed = true;
  results.push({
    name: "scratch leak",
    status: scratch.status,
    reason: scratch.reason,
  });
} catch (error) {
  failed = true;
  results.push({
    name: "scratch leak",
    status: "FAIL",
    reason: `scratch leak measurement failed: ${error instanceof Error ? error.message : String(error)}`,
  });
}

// Provenance closes the run: the series of readings is judged, and a step
// that straddled a change makes its own row and the rows after it
// unattributable — those checks read two trees, so the verdict describes
// neither.
const provenance = classifyTreeProvenance(readings);
if (provenance.status === "FAIL") failed = true;
// First row: it frames every row under it.
results.unshift({
  name: "tree provenance",
  status: provenance.status,
  reason: provenance.reason,
});

// The stamp comes from the judgement, not from the opening reading: a run the
// classifier refused must not print a commit it cannot stand behind.
//
// The commit rides the platform field rather than a sixth `|` column: the
// evidence line's five fields are a parsed contract
// (`require-ci-pass-verdict.mjs`), and a FAIL row's free-form reason can
// already carry a `|`, so a trailing field could not be read back reliably.
const treeStamp = provenance.stamp;

// Summary + pasteable evidence line.
const stamp = new Date().toISOString();
const summary = results
  .map((r) => `${r.name}=${r.status}${r.reason ? `[${r.reason}]` : ""}`)
  .join(" ");

console.log(`\n== summary ==`);
console.log(`  tree ${treeStamp}`);
for (const r of results) {
  console.log(
    `  ${r.status.padEnd(4)} ${r.name}${r.reason ? ` — ${r.reason}` : ""}`,
  );
}

const verdict = failed ? "FAIL" : "PASS";
console.log(`\nEVIDENCE (paste into EXECUTION_LOG.md):`);
console.log(
  `- ${stamp} | run-rust-checks | ${platform()}/${arch()} (rust cfg ${native.ok ? native.cfg : "UNVERIFIED"}, head ${treeStamp}) | ${verdict} | ${summary}`,
);

process.exit(failed ? 1 : 0);
