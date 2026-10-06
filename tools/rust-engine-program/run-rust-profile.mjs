#!/usr/bin/env node
// Focused timings retain build admission and provenance. They are not a gate verdict.
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { withBuildBudget } from "../../scripts/verification/build.mjs";
import { cancellationScope } from "../../scripts/verification/cancellation.mjs";
import { git, repoRoot, run } from "../../scripts/verification/process.mjs";
import { classifyTreeProvenance, readTreeState } from "./tree-provenance.mjs";
import { verifyNativeTarget } from "./native-target.mjs";
import { SCRATCH_SENTINEL, inspectScratchRun } from "./scratch-leak-report.mjs";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const label = args[0];
if (separator !== 1 || !/^[a-z0-9-]+$/.test(label ?? "") || args.length < 3) {
  throw new Error("Use run-rust-profile.mjs <label> -- <nextest selection arguments>.");
}
const selection = args.slice(separator + 1);
if (selection.some(arg => /^(--target(?:-dir)?|--manifest-path|--profile|--cargo-profile|--test-threads|--no-capture|--config)(=|$)/.test(arg))) {
  throw new Error("Keep the checkout target, profile, capture, and parallelism under the profiling runner's control.");
}
const output = join(repoRoot, ".agent-artifacts/rust-profile", `${new Date().toISOString().replaceAll(":", "-")}-${label}`);
mkdirSync(output, { recursive: true });
const scratch = join(tmpdir(), "dohc-test-scratch", `rust-profile-${process.pid}-${randomBytes(8).toString("hex")}`);
const report = { kind: "focused-rust-profile", gateEvidence: false, label, root: repoRoot, pid: process.pid, target: join(repoRoot, "target"), selection, output, steps: [], verdict: "RUNNING" };
const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
function tree() {
  return readTreeState(command => {
    try { return git(command.split(" ").slice(1)); } catch { return null; }
  }, () => existsSync(resolve(repoRoot, git(["rev-parse", "--git-path", "logs/HEAD"]))));
}
const patch = () => createHash("sha256").update(git(["diff", "HEAD", "--"])).digest("hex");
report.readings = [{ step: "start", state: tree() }];
report.patch = patch();
save();
const cancellation = cancellationScope("Rust profiling");
try {
  await withBuildBudget(async env => {
    await cancellation.checkpoint();
    env.CARGO_INCREMENTAL = "0";
    env.CARGO_BUILD_JOBS = String(Math.min(8, Number(env.CARGO_BUILD_JOBS) || 8));
    env.RUST_TEST_THREADS = "8";
    env.NEXTEST_TEST_THREADS = "8";
    env.DOHC_TEST_SCRATCH_ROOT = scratch;
    env.DOHC_RUST_PROFILE = "1";
    report.environment = Object.fromEntries(Object.entries(env).filter(([key]) => /^(CARGO_(INCREMENTAL|BUILD_JOBS|TARGET_DIR|PROFILE_)|RUST_TEST_THREADS|NEXTEST_TEST_THREADS|DOHC_RUST_PROFILE)/.test(key)));
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, SCRATCH_SENTINEL), label);
    const probe = await run("cargo", ["rustc", "--locked", "-p", "dohc-engine-protocol", "--lib", "--profile", "check", "--", "--print", "cfg"], { env, log: join(output, "native.log") });
    report.native = verifyNativeTarget({ runProbe: () => ({ status: probe.code, stdout: probe.stdout, stderr: probe.stderr }) });
    if (!report.native.ok) throw new Error(report.native.reason);
    report.readings.push({ step: "native", state: tree() });
    save();
    const started = Date.now();
    const row = { command: "cargo", args: ["nextest", "run", "--locked", "--no-fail-fast", "--success-output", "immediate", ...selection], log: join(output, "tests.log") };
    report.steps.push(row); save();
    try {
      await run(row.command, row.args, { env, log: row.log, onSpawn: child => { row.pid = child.pid; save(); } });
      row.verdict = "PASS";
    } finally { row.seconds = (Date.now() - started) / 1000; save(); }
    report.readings.push({ step: "tests", state: tree() });
    report.provenance = classifyTreeProvenance(report.readings);
    if (report.provenance.status !== "PASS" || patch() !== report.patch) throw new Error("Sources changed during profiling.");
  });
  report.verdict = "PASS";
} catch (error) {
  report.verdict = "FAIL";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (existsSync(scratch)) {
    report.scratch = await inspectScratchRun(scratch);
    if (report.scratch.status !== "PASS") { report.verdict = "FAIL"; process.exitCode = 1; }
  }
  const interrupted = await cancellation.dispose();
  if (interrupted) { report.verdict = "FAIL"; report.error ??= interrupted.message; }
  save();
  console.log(`Focused Rust profile ${report.verdict}; full gate evidence required separately: ${join(output, "result.json")}`);
}
