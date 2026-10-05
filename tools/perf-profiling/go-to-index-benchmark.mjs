// Run with node --expose-gc tools/perf-profiling/go-to-index-benchmark.mjs.
// This measures the pure module, not packaged keystroke-to-paint or renderer private bytes.
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { goToIndexFixture, goToLongPathFixture } from "./go-to-index-fixture.mjs";
const require = createRequire(resolve("apps/desktop/package.json"));
const { build } = require("esbuild");
if (typeof global.gc !== "function") throw new Error("run with --expose-gc");
const scratch = await mkdtemp(join(tmpdir(), "dohc-goto-index-"));
try {
  const entry = join(scratch, "index.mjs");
  await build({ entryPoints: [resolve("apps/desktop/src/renderer/workbench/quick-open-rank.ts")], bundle: true, platform: "node", format: "esm", outfile: entry });
  const { GoToIndex } = await import(pathToFileURL(entry));
  const receipt = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    node: process.version, scope: "pure module; includes source records and one full matching-index set; excludes packaged paint, renderer private bytes, and 10/60-minute retention",
    renameInputs: "fresh file records, visibility object and Set, and mount array and records, as supplied to the hook; metadata construction is timed",
    budgetsMs: { listingUpdateMedian: 8, firstKeystroke: 4, typingDuringRename: 16 }, measurements: [] };
  for (const count of [5000, 30000]) {
    global.gc();
    const before = process.memoryUsage();
    let sources = goToIndexFixture(count);
    global.gc();
    const sourcesMemory = process.memoryUsage();
    let index = new GoToIndex("benchmark");
    const started = performance.now();
    index.update(sources);
    const initialPreparationMs = performance.now() - started;
    global.gc();
    const preparedMemory = process.memoryUsage();
    let queryStart = performance.now();
    index.query("f");
    const firstKeystrokeMs = performance.now() - queryStart;
    global.gc();
    const matchingMemory = process.memoryUsage();
    const updates = [];
    for (let n = 0; n < 5; n++) {
      const files = sources.listing.files.map((file, i) => i === 4242 ? { ...file, path: "src/module-0/renamed-" + n + ".ts" } : { ...file });
      const updateStart = performance.now();
      sources = { ...sources, listing: { ...sources.listing, files,
        visibility: { ...sources.listing.visibility, hiddenHostPaths: new Set(sources.listing.visibility.hiddenHostPaths) },
        receivedRoots: sources.listing.receivedRoots.map(root => ({ ...root })),
      } };
      index.update({ listing: sources.listing });
      const preparedAt = performance.now();
      index.query("fi");
      updates.push({ preparationMs: preparedAt - updateStart, updateAndQueryMs: performance.now() - updateStart, preparedRows: index.lastPreparationCount });
    }
    const worstStart = performance.now();
    index.query("r");
    const nonPrefixScanMs = performance.now() - worstStart;
    receipt.measurements.push({ files: count, initialPreparationMs, firstKeystrokeMs, nonPrefixScanMs, updates,
      memoryBytes: { sourcesHeap: sourcesMemory.heapUsed - before.heapUsed, indexHeap: preparedMemory.heapUsed - sourcesMemory.heapUsed,
        sourcesAndIndexHeap: preparedMemory.heapUsed - before.heapUsed, matchingSetHeap: matchingMemory.heapUsed - preparedMemory.heapUsed,
        matchingSetArrayBuffers: matchingMemory.arrayBuffers - preparedMemory.arrayBuffers,
        processRss: matchingMemory.rss } });
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
    longIndex.update(longSources);
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
      visibility: { ...longSources.listing.visibility, hiddenHostPaths: new Set(longSources.listing.visibility.hiddenHostPaths) },
      receivedRoots: longSources.listing.receivedRoots.map(root => ({ ...root })),
    };
    longIndex.update({ listing });
    const preparedAt = performance.now();
    longIndex.query("z");
    renameSamples.push({ preparationMs: preparedAt - updateStart, updateAndQueryMs: performance.now() - updateStart, preparedRows: longIndex.lastPreparationCount });
  }
  receipt.worstFirstKeystroke = { files: 30000, query: "z", pathLength: { min: lengths[0], median: lengths[Math.floor(lengths.length / 2)], max: lengths.at(-1) },
    firstScans, renameSamples, scope: "pure module, realistic long paths, first single-letter query matches nothing; renderer paint remains separate" };
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  const withinTmp = relative(resolve(tmpdir()), resolve(scratch));
  if (withinTmp.startsWith("..") || isAbsolute(withinTmp) || !withinTmp.startsWith("dohc-goto-index-")) throw new Error("refusing cleanup outside the owned scratch directory");
  await rm(scratch, { recursive: true, force: true });
}
