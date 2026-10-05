// Run with node --expose-gc tools/perf-profiling/go-to-index-benchmark.mjs.
// This measures the pure module, not packaged keystroke-to-paint or renderer private bytes.
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { goToIndexFixture } from "./go-to-index-fixture.mjs";
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
      sources = { ...sources, listing: { ...sources.listing, files } };
      const updateStart = performance.now();
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
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  const withinTmp = relative(resolve(tmpdir()), resolve(scratch));
  if (withinTmp.startsWith("..") || isAbsolute(withinTmp) || !withinTmp.startsWith("dohc-goto-index-")) throw new Error("refusing cleanup outside the owned scratch directory");
  await rm(scratch, { recursive: true, force: true });
}
