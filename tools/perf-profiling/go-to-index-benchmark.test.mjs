import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

test("the pure benchmark exercises first scans, narrowings, slices, and memory", async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--expose-gc", resolve("tools/perf-profiling/go-to-index-benchmark.mjs"), "--samples", "2", "--counts", "100,500"],
    { cwd: resolve("."), windowsHide: true, maxBuffer: 1024 * 1024 });
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.samples, 2);
  assert.ok(receipt.host.busyPercent >= 0 && receipt.host.busyPercent <= 100);
  for (const measurement of receipt.measurements) {
    assert.equal(measurement.initialPreparationSamplesMs.length, 2);
    assert.equal(measurement.timeToFirstResultsSamplesMs.length, 2);
    assert.ok(measurement.timeToFirstResultsMs.median > 0);
    assert.equal(measurement.supersededRenameWithholdingMs.max, 0);
    assert.equal(measurement.supersededRenameWorkSamplesMs.length, 2);
    assert.ok(measurement.initialPreparationMs.p95 >= measurement.initialPreparationMs.median);
    assert.ok(measurement.longestPreparationSliceMs > 0);
    assert.equal(measurement.renameWithholdingMs.max, 0);
    assert.equal(measurement.recentWithholdingMs.max, 0);
    assert.equal(measurement.initialPreparationWorkSamplesMs.length, 2);
    assert.equal(measurement.renamePreparationWorkSamplesMs.length, 2);
    assert.equal(measurement.recentPreparationWorkSamplesMs.length, 2);
    assert.ok(measurement.memoryBytes.indexArrayBuffers > 0);
    assert.equal(measurement.queries.length, 4);
    for (const query of measurement.queries) {
      assert.equal(query.firstSamplesMs.length, 2);
      assert.equal(query.narrowingSamplesMs.length, 2);
      assert.ok(query.firstMs.p95 >= query.firstMs.median);
      assert.ok(query.narrowingMs.p95 >= query.narrowingMs.median);
    }
  }
});
