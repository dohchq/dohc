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
// clippy -D warnings, cargo build --workspace, the workspace test run (cargo
// nextest), the doctest run (nextest runs no doctests by design), the collab
// crash tier (which only compiles under `--features fault-injection`, so the
// plain workspace run never sees it), then cargo-deny / cargo-audit IF
// installed (skip-with-warning when absent, never fail on a missing tool).
//
// A REQUIRED step that SKIPs fails the verdict: a gate that silently drops a
// row is how the fault-injection tests went unrun for a month. Optional tools
// may still skip.
//
// BUDGET: see the `budget` block below and WINDOWS_DEV.md "Build economics".
//
// PROVENANCE: the run reads the tree at every step boundary and stamps the
// commit into both the summary block and the evidence line. A verdict that
// cannot name the tree it examined is not evidence — two concurrent runs
// sharing one worktree produced PASS and FAIL for the same commit, and neither
// log could say which tree it had read. HEAD moving mid-run FAILS the verdict,
// and so does the worktree changing under it, and so does a HEAD that moved
// and returned inside one step — the reading carries the HEAD reflog, which
// records that even when both ends name the same commit. A tree already dirty
// when the run starts is recorded, not failed, because running the gate over
// uncommitted work is the normal local loop and a check that forbids it just
// gets removed. Recorded is the point: the reader learns the sha does not
// describe everything that ran.
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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { verifyNativeTarget } from "./native-target.mjs";
import {
  acquireBuildSlot,
  freeDiskGb,
  resolveBuildBudget,
} from "./build-slot.mjs";
import {
  classifyTreeProvenance,
  formatTreeState,
  readTreeState,
} from "./tree-provenance.mjs";
import { SCRATCH_SENTINEL, inspectScratchRun } from "./scratch-leak-report.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");

// The machine's build budget (WINDOWS_DEV.md, "Build economics"). On the
// shared dev box the gate refuses to start under the free-space floor, takes
// one of the four build slots before any cargo runs, and caps its compiler
// and test parallelism to its share of the cores. A single-tenant host (CI)
// has no slot root and runs uncapped. Incremental compilation is off on both:
// a full-workspace gate never reuses incremental caches, it only pays their
// disk — the dev loop keeps its own setting.
const budget = resolveBuildBudget();
if (budget) {
  const free = freeDiskGb(repoRoot);
  if (free === null) {
    // Not fail-closed on purpose: the floor guards a failure cargo reports
    // loudly itself (ENOSPC fails the gate), so an unreadable measurement
    // is worth a warning, not an outage of the canonical gate.
    console.warn(
      `disk preflight skipped: free space on ${repoRoot}'s volume could not be read; the ${budget.diskFloorGb} GB floor is unverified for this run`,
    );
  }
  if (free !== null && free < budget.diskFloorGb) {
    console.error(
      `refusing to run the gate: ${free.toFixed(1)} GB free on the worktree ` +
        `volume is below the ${budget.diskFloorGb} GB floor (WINDOWS_DEV.md ` +
        `build economics; a cold workspace build needs ~20 GB). Prune stale ` +
        `target dirs (C:\\w\\_targets, worktree target/) and rerun, or ` +
        `override the floor with DOHC_GATE_DISK_FLOOR_GB.`,
    );
    process.exit(1);
  }
}
const slot = budget ? await acquireBuildSlot(budget) : null;
// The caps ride process.env so every child sees them — including the
// native-target probe, which spawns its own cargo. A snapshot handed to
// spawnSync would REPLACE the child environment and silently drop whatever
// this file exports after the snapshot; that defect shipped once and made
// the scratch-leak row vacuous. Jobs and test threads honor an explicitly
// set value; incremental is always off in the gate — a full-workspace run
// never reuses incremental caches, it only pays their disk.
process.env.CARGO_INCREMENTAL = "0";
if (budget) {
  process.env.CARGO_BUILD_JOBS ??= String(budget.jobs);
  // Both runners: nextest reads its own variable, libtest (the doctest
  // step) reads RUST_TEST_THREADS.
  process.env.RUST_TEST_THREADS ??= String(budget.jobs);
  process.env.NEXTEST_TEST_THREADS ??= String(budget.jobs);
}
// A caller's libtest cap carries to nextest unless the caller split them
// deliberately: the evidence line must never claim a cap the child does
// not actually have.
if (process.env.RUST_TEST_THREADS !== undefined) {
  process.env.NEXTEST_TEST_THREADS ??= process.env.RUST_TEST_THREADS;
}
// One value covers both runners unless the caller split them. A divergent
// nextest cap governs the heavy test steps, so the evidence names both
// values rather than reporting a share nextest is not using.
const libtestThreads = process.env.RUST_TEST_THREADS ?? "default";
const nextestThreads = process.env.NEXTEST_TEST_THREADS ?? libtestThreads;
const capsField =
  `jobs ${process.env.CARGO_BUILD_JOBS ?? "default"}, test-threads ${
    nextestThreads === libtestThreads
      ? libtestThreads
      : `${nextestThreads} (doctests ${libtestThreads})`
  }`;
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
  const startedAt = Date.now();
  const res = spawnSync(cmd, {
    cwd: repoRoot,
    shell: true,
    stdio: "inherit",
  });
  const durationMs = Date.now() - startedAt;
  if (res.error) return { ok: false, code: null, error: res.error, durationMs };
  return { ok: res.status === 0, code: res.status, durationMs };
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
  // `--locked` on every step that resolves dependencies: a CI substitute must
  // not rewrite Cargo.lock mid-run. Without it, `cargo build` over a stale
  // lock rewrites the file and the tree-provenance row fails — correctly, but
  // the reader gets a provenance refusal where a lockfile error was the fact.
  {
    name: "clippy -D warnings",
    cmd: "cargo clippy --locked --workspace --all-targets --all-features -- -D warnings",
  },
  { name: "build --workspace", cmd: "cargo build --locked --workspace" },
  // nextest schedules the workspace's ~73 test binaries in parallel where
  // `cargo test` runs them one at a time — measured, that was ~90% of the
  // gate's wall clock. It runs no doctests by design; the `doctests` row
  // below keeps them.
  { name: "test --workspace", cmd: "cargo nextest run --locked --workspace" },
  { name: "doctests", cmd: "cargo test --locked --workspace --doc" },
  {
    // The crash-recovery / exactly-once tests in dohc-engine-collab are behind
    // its `fault-injection` feature, which nothing in the workspace graph
    // enables — `cargo test --workspace` compiles them out. The workspace root
    // is virtual, so the feature must be enabled through an explicit `-p` run.
    name: "test collab crash tier",
    cmd: "cargo nextest run --locked -p dohc-engine-collab --features fault-injection",
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
// Each reading is a `git rev-parse`, a `git status --untracked-files=all`, and
// two bounded reads of this checkout's HEAD reflog, all through a shell.
// Measured on this repo on Windows, the slowest of the platforms the gate runs
// on: ~1s per reading, ~11s for the eleven a full run takes — around a percent
// of a gate that spends ten minutes in cargo.

// Where this checkout keeps its HEAD log. `--git-path` names the log of the
// worktree the run is in, not the main one, and answers relatively there and
// absolutely in a linked worktree — so it is resolved against the root the
// commands ran in. The path cannot move under a run, so it is asked once; its
// EXISTENCE is read at every reading, because a log removed mid-run is a run
// that stopped being able to see a HEAD that moved and came back.
const headLogPath = captureGit("git rev-parse --git-path logs/HEAD");
const hasHeadLog = () =>
  headLogPath === null ? null : existsSync(resolve(repoRoot, headLogPath.trim()));
const readTree = () => readTreeState(captureGit, hasHeadLog);

const readings = [{ step: "start", state: readTree() }];
const readTreeAfter = (step) => readings.push({ step, state: readTree() });

console.log(`\n== dohc Rust engine local checks ==`);
console.log(`host: ${platform()} ${arch()} (${release()})`);
console.log(`repo: ${repoRoot}`);
console.log(
  `budget: ${slot ? `${slot.name} of ${budget.slots}` : "uncapped (no slot root; single-tenant host)"}, ` +
    `${capsField}, incremental off`,
);
console.log(`tree at start: ${formatTreeState(readings[0].state)}\n`);

console.log(`\n--- native target ---`);
const nativeStartedAt = Date.now();
const native = verifyNativeTarget();
const nativeMs = Date.now() - nativeStartedAt;
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
  durationMs: nativeMs,
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
      durationMs: r.durationMs,
    });
    continue;
  }
  if (!r.ok) failed = true;
  results.push({
    name: step.name,
    status: r.ok ? "PASS" : "FAIL",
    durationMs: r.durationMs,
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
  results.push({
    name: step.name,
    status: r.ok ? "PASS" : "FAIL",
    durationMs: r.durationMs,
  });
}

console.log(`\n--- scratch leak ---`);
try {
  const scratch = await inspectScratchRun(scratchRunRoot);
  if (scratch.status === "FAIL") failed = true;
  // Printed on every run, so the count and the bytes stay visible long before
  // they trip a limit. It rides the row only on FAIL, because a passing
  // verdict's evidence line is `name=STATUS` rows and nothing else — a
  // free-form reason has no end a reader can find (require-ci-pass-verdict.mjs).
  console.log(`  ${scratch.status} — ${scratch.reason}`);
  results.push({
    name: "scratch leak",
    status: scratch.status,
    reason: scratch.status === "FAIL" ? scratch.reason : undefined,
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

// Per-step wall clock, in the human summary only: the evidence line's step
// rows are a parsed contract (`require-ci-pass-verdict.mjs`) that a PASS row
// may not decorate. The judgement rows (tree provenance, scratch leak) carry
// no duration because nothing timed ran for them.
const stepSeconds = (ms) =>
  ms === undefined ? "" : ` (${(ms / 1000).toFixed(1)}s)`;

console.log(`\n== summary ==`);
console.log(`  tree ${treeStamp}`);
for (const r of results) {
  console.log(
    `  ${r.status.padEnd(4)} ${r.name}${stepSeconds(r.durationMs)}${r.reason ? ` — ${r.reason}` : ""}`,
  );
}

const verdict = failed ? "FAIL" : "PASS";
console.log(`\nEVIDENCE (paste into EXECUTION_LOG.md):`);
console.log(
  `- ${stamp} | run-rust-checks | ${platform()}/${arch()} (rust cfg ${native.ok ? native.cfg : "UNVERIFIED"}, ${capsField}, head ${treeStamp}) | ${verdict} | ${summary}`,
);

process.exit(failed ? 1 : 0);
