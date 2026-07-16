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
// Steps: cargo fmt --check, cargo clippy -D warnings, cargo build --workspace,
// cargo test --workspace, then cargo-deny / cargo-audit IF installed
// (skip-with-warning when absent, never fail on a missing tool).
//
// Usage:
//   node tools/rust-engine-program/run-rust-checks.mjs
// Exit code is non-zero if any REQUIRED step fails (optional tool skips do not
// fail the run).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { arch, platform, release } from "node:os";

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
  { name: "fmt --check", cmd: "cargo fmt --all --check" },
  {
    name: "clippy -D warnings",
    cmd: "cargo clippy --workspace --all-targets --all-features -- -D warnings",
  },
  { name: "build --workspace", cmd: "cargo build --workspace" },
  { name: "test --workspace", cmd: "cargo test --workspace" },
];

// Optional supply-chain checks: run only when the tool is installed.
const optional = [
  { name: "cargo-deny", probe: "cargo deny --version", cmd: "cargo deny check" },
  { name: "cargo-audit", probe: "cargo audit --version", cmd: "cargo audit" },
];

const results = [];
let failed = false;

console.log(`\n== dohc Rust engine local checks ==`);
console.log(`host: ${platform()} ${arch()} (${release()})`);
console.log(`repo: ${repoRoot}\n`);

for (const step of required) {
  console.log(`\n--- ${step.name} ---`);
  const r = run(step.cmd);
  if (!r.ok) failed = true;
  results.push({
    name: step.name,
    status: r.ok ? "PASS" : "FAIL",
  });
  if (r.error) console.error(`  (spawn error: ${r.error.message})`);
}

for (const step of optional) {
  console.log(`\n--- ${step.name} ---`);
  if (!toolAvailable(step.probe)) {
    console.warn(
      `  ${step.name} not installed — SKIPPED (install with \`cargo install ${step.name} --locked\`).`,
    );
    results.push({ name: step.name, status: "SKIP" });
    continue;
  }
  const r = run(step.cmd);
  if (!r.ok) failed = true;
  results.push({ name: step.name, status: r.ok ? "PASS" : "FAIL" });
}

// Summary + pasteable evidence line.
const stamp = new Date().toISOString();
const summary = results.map((r) => `${r.name}=${r.status}`).join(" ");

console.log(`\n== summary ==`);
for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.name}`);

const verdict = failed ? "FAIL" : "PASS";
console.log(`\nEVIDENCE (paste into EXECUTION_LOG.md):`);
console.log(
  `- ${stamp} | run-rust-checks | ${platform()}/${arch()} | ${verdict} | ${summary}`,
);

process.exit(failed ? 1 : 0);
