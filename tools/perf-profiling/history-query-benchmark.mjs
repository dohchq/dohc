import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { acquireProfilingSlot } from "./admission.mjs";
import { freeDiskGb } from "../rust-engine-program/build-slot.mjs";

const { values } = parseArgs({ options: {
  mode: { type: "string", default: "baseline" }, entries: { type: "string", default: "100000" },
  "wait-ms": { type: "string", default: "1200000" },
} });
if (!["baseline", "candidate"].includes(values.mode)) throw new Error("mode must be baseline or candidate");
const waitMs = Number(values["wait-ms"]);
if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 1200000) throw new Error("wait-ms must be between 0 and 1200000");
const root = resolve(".agent-artifacts/history-page");
mkdirSync(join(root, "tmp"), { recursive: true });
const binaryDir = join(root, values.mode === "baseline" ? "baseline-bin" : "candidate-bin");
const binaries = readdirSync(binaryDir).filter(name => /^history_page_benchmark-.*\.exe$/.test(name));
if (binaries.length !== 1) throw new Error("Preserve the baseline and candidate benchmark binaries after compiling through the rust-gate build budget.");
const receipt = join(root, values.mode + "-admission.json");
const deadline = Date.now() + waitMs;
const refusals = [];
let slot;
while (!slot) {
  if ((freeDiskGb(resolve(".")) ?? 0) < 40) throw new Error("40 GB disk floor not met");
  try { slot = acquireProfilingSlot(undefined, { metadata: { purpose: "History page benchmark", mode: values.mode, checkout: resolve(".") } }); }
  catch (error) {
    if (!error.hostContext && !error.message.startsWith("Another run owns ")) throw error;
    refusals.push({ at: new Date().toISOString(), message: error.message, context: error.hostContext });
    writeFileSync(receipt, JSON.stringify({ status: "waiting", refusals }, null, 2));
    console.log(error.message);
    if (Date.now() >= deadline) {
      writeFileSync(receipt, JSON.stringify({ status: "deferred", refusals }, null, 2));
      process.exitCode = 2;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(20000, deadline - Date.now())));
  }
}
if (slot) {
  let child;
  try {
    child = spawn(join(binaryDir, binaries[0]), ["--ignored", "--nocapture"], { stdio: "inherit", env: {
      ...process.env, TEMP: join(root, "tmp"), TMP: join(root, "tmp"), DOHC_TEST_SCRATCH_ROOT: join(root, "scratch"),
      HISTORY_BENCH_MODE: values.mode, HISTORY_BENCH_ENTRIES: values.entries,
    }, signal: slot.signal });
    appendFileSync(join(root, "processes.jsonl"), JSON.stringify({ runner: process.pid, pid: child.pid, mode: values.mode, started: new Date().toISOString() }) + "\n");
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    slot.check();
    process.exitCode = code;
    writeFileSync(receipt, JSON.stringify({ status: code === 0 ? "completed" : "failed", refusals, evidence: slot.evidence }, null, 2));
  } catch (error) {
    writeFileSync(receipt, JSON.stringify({ status: "interrupted", message: error.message, refusals, evidence: slot.evidence }, null, 2));
    throw error;
  } finally {
    // Abort waits for the owned benchmark to exit before releasing admission.
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve));
    appendFileSync(join(root, "processes.jsonl"), JSON.stringify({ pid: child?.pid, exit: child?.exitCode, signal: child?.signalCode, stopped: new Date().toISOString() }) + "\n");
    slot.release();
  }
}
