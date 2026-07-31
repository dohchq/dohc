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
// Steps: fixture drift, cargo fmt --check, cargo clippy -D warnings, cargo
// build --workspace, cargo test --workspace, the collab crash tier (which only
// compiles under `--features fault-injection`, so the plain workspace run
// never sees it), then cargo-deny / cargo-audit IF installed
// (skip-with-warning when absent, never fail on a missing tool).
//
// A REQUIRED step that SKIPs fails the verdict: a gate that silently drops a
// row is how the fault-injection tests went unrun for a month. Optional tools
// may still skip.
//
// Usage:
//   node tools/rust-engine-program/run-rust-checks.mjs
// Exit code is non-zero if any REQUIRED step fails (optional tool skips do not
// fail the run).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { arch, platform, release } from "node:os";
import { buildRustCheckReport } from "./rust-check-report.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");

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

// Optional supply-chain checks: run only when the tool is installed.
const optional = [
  { name: "cargo-deny", probe: "cargo deny --version", cmd: "cargo deny check" },
  { name: "cargo-audit", probe: "cargo audit --version", cmd: "cargo audit" },
];

const results = [];

console.log(`\n== dohc Rust engine local checks ==`);
console.log(`host: ${platform()} ${arch()} (${release()})`);
console.log(`repo: ${repoRoot}\n`);

for (const step of required) {
  console.log(`\n--- ${step.name} ---`);
  const r = run(step.cmd);
  if (r.code === step.skipCode) {
    // A skipped required step is a FAIL: stamping PASS with a row missing is
    // exactly the blind spot this gate exists to prevent.
    console.error(
      `  ${step.name} — SKIPPED (${step.skipReason}) — required steps may not skip; install the missing dependency (\`pnpm install --frozen-lockfile\`) and rerun.`,
    );
    results.push({
      name: step.name,
      status: "SKIP",
      required: true,
      reason: `${step.skipReason}; required step skipped → verdict FAIL`,
    });
    continue;
  }
  results.push({
    name: step.name,
    status: r.ok ? "PASS" : "FAIL",
    required: true,
  });
  if (r.error) console.error(`  (spawn error: ${r.error.message})`);
}

for (const step of optional) {
  console.log(`\n--- ${step.name} ---`);
  if (!toolAvailable(step.probe)) {
    console.warn(
      `  ${step.name} not installed — SKIPPED (install with \`cargo install ${step.name} --locked\`).`,
    );
    results.push({ name: step.name, status: "SKIP", required: false });
    continue;
  }
  const r = run(step.cmd);
  results.push({
    name: step.name,
    status: r.ok ? "PASS" : "FAIL",
    required: false,
  });
}

// Summary + pasteable evidence line.
const report = buildRustCheckReport(results, {
  stamp: new Date().toISOString(),
  platform: platform(),
  arch: arch(),
});

console.log(`\n== summary ==`);
console.log(report.summary);

console.log(`\nEVIDENCE (paste into EXECUTION_LOG.md):`);
console.log(report.evidence);

process.exit(report.exitCode);
