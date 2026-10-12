#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireProfilingSlot } from "./admission.mjs";
import { freeDiskGb } from "../rust-engine-program/build-slot.mjs";
import { run } from "../../scripts/verification/process.mjs";

const usage = "Usage: node tools/perf-profiling/history-query-benchmark.mjs --exe <release-test-executable> --mode baseline|candidate";

export function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--exe", "--mode"].includes(args[i]) || !args[i + 1] || Object.hasOwn(values, args[i])) throw Error(usage);
    values[args[i]] = args[i + 1];
  }
  if (!values["--exe"] || !["baseline", "candidate"].includes(values["--mode"])) throw Error(usage);
  return { exe: resolve(values["--exe"]), mode: values["--mode"] };
}

export async function runHistoryBenchmark({ exe, mode, root = process.cwd() }, {
  admit = acquireProfilingSlot, execute = run, disk = freeDiskGb,
} = {}) {
  const free = disk(root);
  if (free === null || free < 40) throw Error(`40 GB disk floor not met: ${free}`);
  const sha256 = createHash("sha256").update(await readFile(exe)).digest("hex");
  const output = join(root, ".agent-artifacts/history-page", `measurement-${mode}-${randomUUID()}`);
  await mkdir(join(output, "scratch"), { recursive: true });
  await mkdir(join(output, "tmp"));
  const receipt = { ownerPid: process.pid, startedAt: new Date().toISOString(), exe, sha256, mode, entries: 100000, state: "admitting" };
  const saveReceipt = () => writeFileSync(join(output, "result.json"), JSON.stringify(receipt, null, 2) + "\n");
  let lane;
  try {
    await saveReceipt();
    lane = admit(process.env, { metadata: { purpose: "History query and write benchmark", checkout: root, mode } });
    lane.check();
    const result = await execute(exe, ["history_page_benchmark", "--exact", "--ignored", "--nocapture"], {
      cwd: root, signal: lane.signal, quietStdout: true, log: join(output, "benchmark.log"),
      env: { ...process.env, HISTORY_BENCH_ENTRIES: "100000", HISTORY_BENCH_MODE: mode,
        DOHC_TEST_SCRATCH_ROOT: join(output, "scratch"), TEMP: join(output, "tmp"), TMP: join(output, "tmp") },
      onSpawn: child => {
        receipt.pid = child.pid;
        receipt.state = "running";
        // run() waits for the owned process group or Windows job to exit.
        saveReceipt();
      },
    });
    receipt.childExitedAt = new Date().toISOString();
    lane.check();
    const match = result.stdout.match(/HISTORY_BENCH (\{[^\r\n]*\})/u);
    if (!match) throw Error("Benchmark produced no HISTORY_BENCH result.");
    const measurements = JSON.parse(match[1]);
    if (measurements.build !== "release" || measurements.mode !== mode || measurements.entries !== 100000)
      throw Error("Benchmark must use the requested mode, release profile, and 100,000 moments.");
    receipt.measurements = measurements;
    receipt.state = "passed";
    console.log("HISTORY_BENCH " + JSON.stringify(measurements));
    return { output, measurements };
  } catch (error) {
    receipt.state = "failed";
    receipt.error = String(lane?.signal.reason ?? error);
    receipt.hostContext = lane?.evidence ?? error.hostContext;
    throw lane?.signal.reason ?? error;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    receipt.hostContext ??= lane?.evidence;
    lane?.release();
    await saveReceipt();
    console.log(`Evidence: ${join(output, "result.json")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) console.log(usage);
  else await runHistoryBenchmark(parseArgs(process.argv.slice(2)));
}
