import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const RUST_TIME_THRESHOLD_SECONDS = 2;

export function rustTimingSamples(log) {
  return [
    ...log
      .replace(/\x1b\[[0-9;]*m/gu, "")
      .matchAll(/^\s*PASS\s+\[\s*([\d.]+)s\]\s+(?:\([^)]*\)\s+)?(.+?)\s*$/gmu),
  ].map((match) => ({ id: match[2], seconds: Number(match[1]) }));
}

export function recordedRustTimes(samples, thresholdSeconds = RUST_TIME_THRESHOLD_SECONDS) {
  const byTest = Map.groupBy(samples, (sample) => sample.id);
  if (!byTest.size) throw new Error("No passed Rust test timings were found.");
  const round = (seconds) => Math.max(0.001, Math.round(seconds * 1000) / 1000);
  const medians = [...byTest]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, rows]) => {
      const times = rows.map((row) => row.seconds).sort((a, b) => a - b);
      if (times.some((seconds) => !Number.isFinite(seconds) || seconds < 0))
        throw new Error(`Invalid Rust test timing: ${id}`);
      return {
        id,
        seconds:
          (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2,
      };
    });
  const short = medians.filter((test) => test.seconds < thresholdSeconds);
  // Average the per-test medians so defaults preserve each binary's remaining work.
  const average = (tests) =>
    round(tests.reduce((sum, test) => sum + test.seconds, 0) / tests.length);
  return {
    thresholdSeconds,
    defaultSeconds: average(short.length ? short : medians),
    binaries: Object.fromEntries(
      [...Map.groupBy(short, (test) => test.id.split(" ")[0])].map(([binary, tests]) => [
        binary,
        average(tests),
      ]),
    ),
    tests: Object.fromEntries(
      medians
        .filter((test) => test.seconds >= thresholdSeconds)
        .map((test) => [test.id, round(test.seconds)]),
    ),
  };
}

function logsWithin(path) {
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const file = join(path, entry.name);
      return entry.isDirectory()
        ? logsWithin(file)
        : entry.isFile() && entry.name === "test-workspace.log"
          ? [file]
          : [];
    });
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const inputs = process.argv.slice(2);
  if (!inputs.length) throw new Error("Use refresh-rust-times.mjs <log-or-directory> [...].");
  const logs = new Set(
    inputs.flatMap((path) => (path.endsWith(".log") ? [resolve(path)] : logsWithin(resolve(path)))),
  );
  const samples = [...logs].flatMap((path) => rustTimingSamples(readFileSync(path, "utf8")));
  const times = recordedRustTimes(samples);
  writeFileSync(
    new URL("./rust-test-times.json", import.meta.url),
    JSON.stringify(times, null, 2) + "\n",
  );
  console.log(
    `Recorded ${Object.keys(times.tests).length} tests and ${Object.keys(times.binaries).length} binary defaults from ${logs.size} logs.`,
  );
}
