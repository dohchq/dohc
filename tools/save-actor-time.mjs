// #1953 measurement helper, not for main.
//   node tools/save-actor-time.mjs summary <stderr.txt>  per-size median, p95 and step shares
//   node tools/save-actor-time.mjs load <seconds>        CPU spinners on half the cores plus a disk writer
import { readFileSync, writeFileSync, rmSync, openSync, fsyncSync, closeSync, writeSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { Worker, isMainThread, workerData } from "node:worker_threads";

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
};

function summary(file) {
  let settles = [];
  const rows = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.startsWith("R16_CAPTURE_PHASE ")) {
      const phase = JSON.parse(line.slice("R16_CAPTURE_PHASE ".length));
      if (phase.phase === "settle") settles.push(phase);
    } else if (line.startsWith("SAVE_ACTOR_TIME ")) {
      const { bytes } = JSON.parse(line.slice("SAVE_ACTOR_TIME ".length));
      rows.push({ bytes, settles });
      settles = [];
    }
  }
  for (const { bytes, settles } of rows) {
    const held = settles.map((s) => s.elapsed_us);
    const total = held.reduce((a, b) => a + b, 0);
    console.log(`${bytes} bytes, ${settles.length} saves: actor held median ${quantile(held, 0.5)} us, p95 ${quantile(held, 0.95)} us`);
    const labels = [...new Set(settles.flatMap((s) => Object.keys(s.totals ?? {})))].filter((l) => l.startsWith("save_")).sort();
    for (const label of labels) {
      const times = settles.map((s) => s.totals?.[label]?.elapsed_us ?? 0);
      const share = total ? (100 * times.reduce((a, b) => a + b, 0)) / total : 0;
      console.log(`  ${label}: median ${quantile(times, 0.5)} us, p95 ${quantile(times, 0.95)} us, ${share.toFixed(1)}% of held time`);
    }
  }
}

function load(seconds) {
  const until = Date.now() + seconds * 1000;
  const spinners = Math.max(1, Math.floor(availableParallelism() / 2));
  for (let i = 0; i < spinners; i += 1) new Worker(new URL(import.meta.url), { workerData: { until } });
  const path = join(tmpdir(), `save-actor-load-${process.pid}.bin`);
  const block = Buffer.alloc(4 * 1024 * 1024, 7);
  while (Date.now() < until) {
    const fd = openSync(path, "w");
    for (let i = 0; i < 16; i += 1) writeSync(fd, block);
    fsyncSync(fd);
    closeSync(fd);
  }
  rmSync(path, { force: true });
  writeFileSync(1, `load ran ${spinners} spinners and one 64 MB writer for ${seconds} s\n`);
}

if (!isMainThread) {
  while (Date.now() < workerData.until) Math.sqrt(Math.random());
} else if (process.argv[2] === "summary") {
  summary(process.argv[3]);
} else if (process.argv[2] === "load") {
  load(Number(process.argv[3] ?? 600));
} else {
  console.error("usage: save-actor-time.mjs summary <stderr.txt> | load <seconds>");
  process.exit(2);
}
