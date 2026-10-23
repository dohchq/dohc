#!/usr/bin/env node
// Focused timings retain build admission and provenance. They are not a gate verdict.
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withBuildBudget } from "../../scripts/verification/build.mjs";
import { cancellationScope } from "../../scripts/verification/cancellation.mjs";
import { git, repoRoot, run } from "../../scripts/verification/process.mjs";
import { classifyTreeProvenance, readTreeState } from "./tree-provenance.mjs";
import { verifyNativeTarget } from "./native-target.mjs";
import { SCRATCH_SENTINEL, inspectScratchRun, testScratchParent } from "./scratch-leak-report.mjs";
import { profilingHostContext } from "../perf-profiling/admission.mjs";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const label = args[0];
if (separator !== 1 || !/^[a-z0-9-]+$/.test(label ?? "") || args.length < 3) {
  throw new Error("Use run-rust-profile.mjs <label> -- <nextest selection arguments>.");
}
const selection = args.slice(separator + 1);
const valuedFlags = new Set(["-p", "--package", "--test", "--filter-expr"]);
for (let index = 0; index < selection.length; index += 1) {
  const flag = selection[index];
  if (flag === "--lib") continue;
  if (!valuedFlags.has(flag)) {
    throw new Error(`Unsupported profiling selection flag: ${flag}. Use -p, --package, --lib, --test, or --filter-expr.`);
  }
  const value = selection[++index];
  if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flag}.`);
}
const output = join(repoRoot, ".agent-artifacts/rust-profile", `${new Date().toISOString().replaceAll(":", "-")}-${label}`);
mkdirSync(output, { recursive: true });
const scratch = join(testScratchParent(), `profile-${process.pid}-${randomBytes(8).toString("hex")}`);
const report = { kind: "focused-rust-profile", gateEvidence: false, label, root: repoRoot, pid: process.pid, target: join(repoRoot, "target"), selection, output, steps: [], verdict: "RUNNING" };
report.hostContext = {scope: "Registered queue work at phase boundaries; does not certify an idle host.", observations: []};
function observeHost(phase, env = process.env) {
  let reading;
  try { reading = profilingHostContext(env); }
  catch (error) { reading = {at: new Date().toISOString(), error: String(error), lanes: null}; }
  report.hostContext.observations.push({phase, ...reading});
}
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
let scratchPrepared = false;
try {
  observeHost("before-admission");
  await withBuildBudget(async env => {
    await cancellation.checkpoint();
    env.CARGO_INCREMENTAL = "0";
    for (const key of ["CARGO_BUILD_JOBS", "RUST_TEST_THREADS", "NEXTEST_TEST_THREADS"]) {
      const cap = Number(env[key]);
      env[key] = String(Number.isInteger(cap) && cap > 0 ? Math.min(8, cap) : 8);
    }
    env.DOHC_TEST_SCRATCH_ROOT = scratch;
    env.DOHC_RUST_PROFILE = "1";
    report.environment = Object.fromEntries(Object.entries(env).filter(([key]) => /^(CARGO_(INCREMENTAL|BUILD_JOBS|TARGET_DIR|PROFILE_)|RUST_TEST_THREADS|NEXTEST_TEST_THREADS|DOHC_RUST_PROFILE)/.test(key)));
    observeHost("admitted", env);
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, SCRATCH_SENTINEL), label);
    scratchPrepared = true;
    const nativeStarted = Date.now();
    report.nativeProbe = { log: join(output, "native.log") };
    const probe = await run("cargo", ["rustc", "--locked", "-p", "dohc-engine-protocol", "--lib", "--profile", "check", "--", "--print", "cfg"], { env, log: report.nativeProbe.log, onSpawn: child => { report.nativeProbe.pid = child.pid; save(); } });
    report.nativeProbe.seconds = (Date.now() - nativeStarted) / 1000;
    report.native = verifyNativeTarget({ runProbe: () => ({ status: probe.code, stdout: probe.stdout, stderr: probe.stderr }) });
    if (!report.native.ok) throw new Error(report.native.reason);
    report.readings.push({ step: "native", state: tree() });
    save();
    observeHost("tests-start", env);
    const started = Date.now();
    const row = { command: "cargo", args: ["nextest", "run", "--locked", "--no-fail-fast", "--success-output", "immediate", ...selection], log: join(output, "tests.log") };
    report.steps.push(row); save();
    try {
      await run(row.command, row.args, { env, log: row.log, onSpawn: child => { row.pid = child.pid; save(); } });
      row.verdict = "PASS";
    } finally { row.seconds = (Date.now() - started) / 1000; observeHost("tests-finished", env); save(); }
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
  observeHost("finished");
  if (scratchPrepared || existsSync(scratch)) {
    report.scratch = await inspectScratchRun(scratch);
    if (report.scratch.status !== "PASS") { report.verdict = "FAIL"; process.exitCode = 1; }
  }
  const interrupted = await cancellation.dispose();
  if (interrupted) { report.verdict = "FAIL"; report.error ??= interrupted.message; }
  save();
  console.log(`Focused Rust profile ${report.verdict}; full gate evidence required separately: ${join(output, "result.json")}`);
}
