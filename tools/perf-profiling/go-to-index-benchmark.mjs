// node --expose-gc tools/perf-profiling/go-to-index-benchmark.mjs
// Pure module only. Packaged keystroke-to-paint belongs to the palette PR.
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { cpus, tmpdir, loadavg } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { goToLongPathFixture } from "./go-to-index-fixture.mjs";
const require = createRequire(resolve("apps/desktop/package.json"));
const { build } = require("esbuild");
if (typeof global.gc !== "function") throw new Error("run with --expose-gc");
const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
const samples = Number(option("--samples", 25));
const counts = String(option("--counts", "5000,30000")).split(",").map(Number);
if (!Number.isSafeInteger(samples) || samples < 2 || counts.some(count => !Number.isSafeInteger(count) || count < 50)) throw Error("invalid samples or counts");
const cpuSnapshot = () => cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
  total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
const cpuStart = cpuSnapshot();
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1], min: sorted[0], max: sorted.at(-1) };
};
const source = resolve("apps/desktop/src/renderer/workbench/quick-open-rank.ts");
const baseline = process.argv.indexOf("--baseline");
const scratch = await mkdtemp(join(tmpdir(), "dohc-goto-index-"));
try {
  const entry = join(scratch, "index.mjs");
  await build({ stdin: { contents: await readFile(baseline === -1 ? source : process.argv[baseline + 1], "utf8"), resolveDir: resolve("apps/desktop/src/renderer/workbench"), loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: entry });
  const { GoToIndex, isGoToPathQuery } = await import(pathToFileURL(entry));
  const prepare = async (index, sources, slices) => {
    const start = performance.now();
    const run = index.update(sources);
    if (run) {
      while (true) {
        const sliceStart = performance.now();
        const done = run.step();
        slices.push(performance.now() - sliceStart);
        if (done) break;
        await new Promise(resolve => setImmediate(resolve));
      }
    } else slices.push(performance.now() - start);
    return performance.now() - start;
  };
  const receipt = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), source: baseline === -1 ? "checkout" : process.argv[baseline + 1],
    node: process.version, host: { cpu: cpus()[0].model, logicalProcessors: cpus().length, loadAverage: loadavg(), note: "Windows loadavg is unavailable; capture Win32_Processor.LoadPercentage beside this receipt" },
    samples, scope: "pure module, long paths, first query after each complete revision; excludes packaged paint and renderer private bytes", measurements: [] };
  const shapes = [
    { name: "no-hit", first: "z", narrow: "zz", expected: 0, narrowExpected: 0, pathQuery: false },
    { name: "many-hit", first: "c", narrow: "cu", expected: 50, narrowExpected: 50, pathQuery: false },
    { name: "slash", first: "/", narrow: "/d", expected: 50, narrowExpected: 50, pathQuery: true },
    { name: "extension", first: ".ts", narrow: ".tsx", expected: 50, narrowExpected: 0, pathQuery: true },
  ];
  for (const shape of shapes) if (isGoToPathQuery(shape.first) !== shape.pathQuery) throw Error("wrong query classification");
  for (const count of counts) {
    global.gc();
    const before = process.memoryUsage();
    let sources = goToLongPathFixture(count);
    global.gc();
    const sourcesMemory = process.memoryUsage();
    let index = new GoToIndex("benchmark");
    const slices = [];
    const initialPreparationMs = await prepare(index, sources, slices);
    const initialPreparations = [initialPreparationMs];
    global.gc();
    const preparedMemory = process.memoryUsage();
    index.query("c");
    global.gc();
    const matchedMemory = process.memoryUsage();
    for (let n = 1; n < samples; n++) {
      global.gc();
      let fresh = new GoToIndex("initial-preparation");
      initialPreparations.push(await prepare(fresh, sources, slices));
      if (fresh.rows.length !== index.rows.length) throw Error("initial preparation lost rows");
      fresh = null;
    }
    global.gc();
    const queries = [];
    const preparations = [], renames = [], typingDuringPreparation = [];
    for (const shape of shapes) {
      const first = [], narrowing = [];
      for (let n = 0; n < samples; n++) {
        // A fresh snapshot invalidates the query cache. No query warmup hides the first scan.
        await prepare(index, { listing: { ...sources.listing } }, slices);
        const start = performance.now();
        const result = index.query(shape.first);
        first.push(performance.now() - start);
        if (result.length !== shape.expected || index.lastScanCount !== index.rows.length) throw Error("first scan shape did not execute: " + shape.name);
        const narrowStart = performance.now();
        const narrowed = index.query(shape.narrow);
        narrowing.push(performance.now() - narrowStart);
        if (narrowed.length !== shape.narrowExpected) throw Error("narrowing shape did not execute: " + shape.name);
      }
      queries.push({ ...shape, firstMs: summarize(first), narrowingMs: summarize(narrowing), firstSamplesMs: first, narrowingSamplesMs: narrowing });
    }
    for (let n = 0; n < samples; n++) {
      const start = performance.now();
      const files = sources.listing.files.map((file, i) => i === 4242 ? { ...file, path: file.path.replace("004242", "renamed-" + n) } : { ...file });
      const listing = { ...sources.listing, files, visibility: { ...sources.listing.visibility, hiddenHostPaths: new Set(sources.listing.visibility.hiddenHostPaths) }, receivedRoots: sources.listing.receivedRoots.map(root => ({ ...root })) };
      const prepStart = performance.now();
      const run = index.update({ listing });
      if (run) while (true) {
        const sliceStart = performance.now();
        const done = run.step();
        slices.push(performance.now() - sliceStart);
        if (done) break;
        const queryStart = performance.now();
        if (index.query("c").length) throw Error("partial preparation answered a query");
        typingDuringPreparation.push(performance.now() - queryStart);
        await new Promise(resolve => setImmediate(resolve));
      }
      preparations.push(performance.now() - prepStart);
      const queryStart = performance.now();
      index.query("c");
      if (index.lastPreparationCount !== (count > 4242 ? 1 : 0)) throw Error("rename did not prepare exactly its changed row");
      renames.push({ preparationMs: preparations.at(-1), updateAndQueryMs: performance.now() - start, queryMs: performance.now() - queryStart, preparedRows: index.lastPreparationCount });
    }
    const lengths = sources.listing.files.map(file => file.path.length);
    receipt.measurements.push({ files: count, rows: index.rows.length, pathLength: summarize(lengths), initialPreparationMs: summarize(initialPreparations), initialPreparationSamplesMs: initialPreparations,
      sliceMs: summarize(slices), longestPreparationSliceMs: Math.max(...slices), sliceCount: slices.length, queries,
      renamePreparationMs: summarize(preparations), renames, typingDuringPreparationMs: typingDuringPreparation.length ? summarize(typingDuringPreparation) : null,
      memoryBytes: { sourcesHeap: sourcesMemory.heapUsed - before.heapUsed, indexHeap: preparedMemory.heapUsed - sourcesMemory.heapUsed, indexArrayBuffers: preparedMemory.arrayBuffers - sourcesMemory.arrayBuffers,
        matchingSetHeap: matchedMemory.heapUsed - preparedMemory.heapUsed, matchingSetArrayBuffers: matchedMemory.arrayBuffers - preparedMemory.arrayBuffers,
        sourcesAndIndexHeap: preparedMemory.heapUsed - before.heapUsed, processRss: matchedMemory.rss } });
    index = null; sources = null;
    global.gc();
  }
  const cpuEnd = cpuSnapshot();
  receipt.host.busyPercent = 100 * (1 - (cpuEnd.idle - cpuStart.idle) / (cpuEnd.total - cpuStart.total));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  const withinTmp = relative(resolve(tmpdir()), resolve(scratch));
  if (withinTmp.startsWith("..") || isAbsolute(withinTmp) || !withinTmp.startsWith("dohc-goto-index-")) throw new Error("refusing cleanup outside owned scratch");
  await rm(scratch, { recursive: true, force: true });
}
