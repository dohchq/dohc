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
const taskChannel = new MessageChannel();
let finishTask;
taskChannel.port1.onmessage = () => { const finish = finishTask; finishTask = undefined; finish?.(); };
const yieldTask = () => new Promise(resolve => { finishTask = resolve; taskChannel.port2.postMessage(null); });
const scratch = await mkdtemp(join(tmpdir(), "dohc-goto-index-"));
try {
  const entry = join(scratch, "index.mjs");
  await build({ stdin: { contents: await readFile(baseline === -1 ? source : process.argv[baseline + 1], "utf8"), resolveDir: resolve("apps/desktop/src/renderer/workbench"), loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: entry });
  const { GoToIndex, isGoToPathQuery } = await import(pathToFileURL(entry));
  const prepare = async (index, sources, slices, context, probe) => {
    const start = performance.now();
    const run = index.update(sources, context);
    let workMs = performance.now() - start;
    let withheldStart = -1, withheldMs = 0, firstResultsMs;
    const check = () => {
      if (!probe) return;
      if (index.query(probe).length === 0) {
        if (withheldStart === -1) withheldStart = performance.now();
      } else {
        firstResultsMs ??= performance.now() - start;
        if (withheldStart !== -1) {
          withheldMs += performance.now() - withheldStart;
          withheldStart = -1;
        }
      }
    };
    check();
    if (run) while (true) {
      const sliceStart = performance.now();
      const done = run.step();
      const duration = performance.now() - sliceStart;
      slices.push(duration);
      workMs += duration;
      check();
      if (done) break;
      await yieldTask();
    }
    if (withheldStart !== -1) throw Error("completed revision still withholds " + probe);
    return { elapsedMs: performance.now() - start, workMs, withheldMs, firstResultsMs };
  };
  const receipt = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), source: baseline === -1 ? "checkout" : process.argv[baseline + 1],
    node: process.version, host: { cpu: cpus()[0].model, logicalProcessors: cpus().length, loadAverage: loadavg(), note: "Windows loadavg is unavailable; capture Win32_Processor.LoadPercentage beside this receipt" },
    samples, scope: "pure module, long paths, first query on a fresh complete index; MessageChannel task yields; excludes packaged paint, Chromium postTask scheduling and renderer private bytes",
    renameInputs: "fresh file records, visibility object and rules, and mount array and records, as supplied to the hook; metadata construction is timed",
    budgetsMs: { listingUpdateMedian: 8, firstKeystroke: 4, typingDuringRename: 16 }, measurements: [] };
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
    const initial = await prepare(index, sources, slices);
    const initialPreparations = [initial.elapsedMs], initialWork = [initial.workMs], firstResults = [];
    global.gc();
    const preparedMemory = process.memoryUsage();
    const firstQueryStart = performance.now();
    index.query("c");
    firstResults.push(initial.elapsedMs + performance.now() - firstQueryStart);
    global.gc();
    const matchedMemory = process.memoryUsage();
    for (let n = 1; n < samples; n++) {
      global.gc();
      let fresh = new GoToIndex("initial-preparation");
      const measurement = await prepare(fresh, sources, slices, undefined, "c");
      initialPreparations.push(measurement.elapsedMs); initialWork.push(measurement.workMs); firstResults.push(measurement.firstResultsMs);
      if (fresh.rows.length !== index.rows.length) throw Error("initial preparation lost rows");
      fresh = null;
    }
    global.gc();
    const queries = [];
    const preparations = [], preparationWork = [], renames = [], renameWithholding = [], recentPreparations = [], recentWork = [], recentWithholding = [];
    for (const shape of shapes) {
      const first = [], narrowing = [];
      for (let n = 0; n < samples; n++) {
        // No-op updates preserve their cache. A fresh index guarantees a full first scan.
        global.gc();
        let queryIndex = new GoToIndex("first-query");
        await prepare(queryIndex, sources, slices);
        const start = performance.now();
        const result = queryIndex.query(shape.first);
        first.push(performance.now() - start);
        if (result.length !== shape.expected || queryIndex.lastScanCount !== queryIndex.rows.length) throw Error("first scan shape did not execute: " + shape.name);
        const narrowStart = performance.now();
        const narrowed = queryIndex.query(shape.narrow);
        narrowing.push(performance.now() - narrowStart);
        if (narrowed.length !== shape.narrowExpected) throw Error("narrowing shape did not execute: " + shape.name);
        queryIndex = null;
      }
      queries.push({ ...shape, firstMs: summarize(first), narrowingMs: summarize(narrowing), firstSamplesMs: first, narrowingSamplesMs: narrowing });
    }
    for (let n = 0; n < samples; n++) {
      const start = performance.now();
      const files = sources.listing.files.map((file, i) => i === 4242 ? { ...file, path: file.path.replace("004242", "renamed-" + n) } : { ...file });
      const listing = { ...sources.listing, files, visibility: { ...sources.listing.visibility, rules: sources.listing.visibility.rules.map(rule => ({ ...rule })) }, receivedRoots: sources.listing.receivedRoots.map(root => ({ ...root })) };
      const measurement = await prepare(index, { listing }, slices, undefined, "c");
      preparations.push(measurement.elapsedMs); preparationWork.push(measurement.workMs);
      renameWithholding.push(measurement.withheldMs);
      const queryStart = performance.now();
      index.query("c");
      if (index.lastPreparationCount !== (count > 4242 ? 1 : 0)) throw Error("rename did not prepare exactly its changed row");
      renames.push({ preparationMs: preparations.at(-1), updateAndQueryMs: performance.now() - start, queryMs: performance.now() - queryStart, preparedRows: index.lastPreparationCount });
    }
    for (let n = 0; n < samples; n++) {
      const measurement = await prepare(index, {}, slices, { pinned: [], recent: [sources.listing.files[n % count].path] }, "c");
      recentPreparations.push(measurement.elapsedMs); recentWork.push(measurement.workMs); recentWithholding.push(measurement.withheldMs);
    }
    const supersededWork = [], supersededWithholding = [], supersededFirstResults = [], supersededReordered = [];
    for (let n = 0; n < samples; n++) {
      const firstAt = Math.min(4242, count - 2), secondAt = Math.min(500, count - 1);
      const first = { ...sources.listing, files: sources.listing.files.map((file, i) => i === firstAt ? { ...file, path: file.path + ".first-" + n } : file) };
      const second = { ...first, files: first.files.map((file, i) => i === secondAt ? { ...file, path: file.path + ".second-" + n } : file) };
      const start = performance.now();
      const obsolete = index.update({ listing: first });
      let workMs = performance.now() - start;
      let ticks = 0;
      const sliceStart = performance.now();
      if (!obsolete || obsolete.step(() => ++ticks)) throw Error("supersession did not interrupt preparation");
      const duration = performance.now() - sliceStart;
      slices.push(duration); workMs += duration;
      await yieldTask();
      const measurement = await prepare(index, { listing: second }, slices, undefined, "c");
      supersededWork.push(workMs + measurement.workMs);
      supersededWithholding.push(measurement.withheldMs);
      supersededFirstResults.push(measurement.firstResultsMs);
      if (index.lastReorderedCount !== undefined) supersededReordered.push(index.lastReorderedCount);
      if (!index.query(first.files[firstAt].path).some(row => row.path === first.files[firstAt].path) || !index.query(second.files[secondAt].path).some(row => row.path === second.files[secondAt].path)) throw Error("superseded rename lost a changed path");
    }
    const createWork = [], deleteWork = [], createWithholding = [], deleteWithholding = [];
    for (let n = 0; n < samples; n++) {
      const path = sources.listing.files[0].path + ".created-" + n;
      const created = { ...sources.listing, files: [{ path, kind: "file" }, ...sources.listing.files] };
      const creation = await prepare(index, { listing: created }, slices, undefined, "c");
      createWork.push(creation.workMs); createWithholding.push(creation.withheldMs);
      if (!index.query(path).some(row => row.path === path)) throw Error("creation lost the inserted path");
      const deletion = await prepare(index, { listing: sources.listing }, slices, undefined, "c");
      deleteWork.push(deletion.workMs); deleteWithholding.push(deletion.withheldMs);
      if (index.query(path).some(row => row.path === path)) throw Error("deletion retained the removed path");
    }
    const lengths = sources.listing.files.map(file => file.path.length);
    receipt.measurements.push({ files: count, rows: index.rows.length, pathLength: summarize(lengths), initialPreparationMs: summarize(initialPreparations), initialPreparationSamplesMs: initialPreparations, initialPreparationWorkMs: summarize(initialWork), initialPreparationWorkSamplesMs: initialWork,
      timeToFirstResultsMs: summarize(firstResults), timeToFirstResultsSamplesMs: firstResults,
      supersededRenameWorkMs: summarize(supersededWork), supersededRenameWorkSamplesMs: supersededWork, supersededRenameWithholdingMs: summarize(supersededWithholding), supersededRenameWithholdingSamplesMs: supersededWithholding, supersededRenameFirstResultsMs: summarize(supersededFirstResults),
      createPreparationWorkMs: summarize(createWork), createPreparationWorkSamplesMs: createWork, createWithholdingMs: summarize(createWithholding),
      deletePreparationWorkMs: summarize(deleteWork), deletePreparationWorkSamplesMs: deleteWork, deleteWithholdingMs: summarize(deleteWithholding),
      supersededRenameReorderedRows: supersededReordered.length ? summarize(supersededReordered) : undefined,
      sliceMs: summarize(slices), longestPreparationSliceMs: slices.reduce((longest, slice) => Math.max(longest, slice), 0), sliceCount: slices.length, queries,
      renamePreparationMs: summarize(preparations), renamePreparationWorkMs: summarize(preparationWork), renamePreparationWorkSamplesMs: preparationWork, renames,
      renameWithholdingMs: summarize(renameWithholding), recentPreparationMs: summarize(recentPreparations), recentPreparationWorkMs: summarize(recentWork), recentPreparationWorkSamplesMs: recentWork, recentWithholdingMs: summarize(recentWithholding),
      memoryBytes: { sourcesHeap: sourcesMemory.heapUsed - before.heapUsed, indexHeap: preparedMemory.heapUsed - sourcesMemory.heapUsed, indexArrayBuffers: preparedMemory.arrayBuffers - sourcesMemory.arrayBuffers,
        matchingSetHeap: matchedMemory.heapUsed - preparedMemory.heapUsed, matchingSetArrayBuffers: matchedMemory.arrayBuffers - preparedMemory.arrayBuffers,
        sourcesAndIndexHeap: preparedMemory.heapUsed - before.heapUsed, processRss: matchedMemory.rss } });
    index = null; sources = null;
    global.gc();
  }
  // Every sample is the first query on a newly prepared index, never a narrowed no-hit query.
  const longSources = goToLongPathFixture(30000);
  const lengths = longSources.listing.files.map(file => file.path.length).sort((a, b) => a - b);
  const firstScans = [];
  let longIndex;
  for (let n = 0; n < 5; n++) {
    longIndex = new GoToIndex("long-paths");
    await prepare(longIndex, longSources, [], undefined);
    const queryStart = performance.now();
    const result = longIndex.query("z");
    const milliseconds = performance.now() - queryStart;
    if (result.length !== 0 || longIndex.lastScanCount !== longIndex.rows.length) throw Error("worst scan must visit every row and match nothing");
    firstScans.push({ milliseconds, scannedRows: longIndex.lastScanCount, matches: result.length });
  }
  const renameSamples = [];
  for (let n = 0; n < 5; n++) {
    const files = longSources.listing.files.map((file, i) => i === 4242 ? { ...file, path: file.path.replace("004242", "renamed-" + n) } : { ...file });
    const updateStart = performance.now();
    const listing = { ...longSources.listing, files,
      visibility: { ...longSources.listing.visibility, rules: longSources.listing.visibility.rules.map(rule => ({ ...rule })) },
      receivedRoots: longSources.listing.receivedRoots.map(root => ({ ...root })),
    };
    await prepare(longIndex, { listing }, [], undefined);
    const preparedAt = performance.now();
    longIndex.query("z");
    renameSamples.push({ preparationMs: preparedAt - updateStart, updateAndQueryMs: performance.now() - updateStart, preparedRows: longIndex.lastPreparationCount });
  }
  receipt.worstFirstKeystroke = { files: 30000, query: "z", pathLength: { min: lengths[0], median: lengths[Math.floor(lengths.length / 2)], max: lengths.at(-1) },
    firstScans, renameSamples, scope: "pure module, realistic long paths, first single-letter query matches nothing; renderer paint remains separate" };
  const cpuEnd = cpuSnapshot();
  receipt.host.busyPercent = 100 * (1 - (cpuEnd.idle - cpuStart.idle) / (cpuEnd.total - cpuStart.total));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  taskChannel.port1.close(); taskChannel.port2.close();
  const withinTmp = relative(resolve(tmpdir()), resolve(scratch));
  if (withinTmp.startsWith("..") || isAbsolute(withinTmp) || !withinTmp.startsWith("dohc-goto-index-")) throw new Error("refusing cleanup outside owned scratch");
  await rm(scratch, { recursive: true, force: true });
}
