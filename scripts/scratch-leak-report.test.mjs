import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectScratchRun } from "../tools/rust-engine-program/scratch-leak-report.mjs";

async function plant(runRoot, count, bytesEach) {
  for (let index = 0; index < count; index++) {
    const directory = join(runRoot, `leaked-workspace-${index}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "payload.bin"), Buffer.alloc(bytesEach));
  }
}

test("a regression-scale leak fails the gate row", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dohc-scratch-report-test-"));
  const runRoot = join(parent, "run");
  try {
    await plant(runRoot, 33, 1);

    const report = await inspectScratchRun(runRoot);

    assert.equal(report.status, "FAIL", "33 entries is past the 32-entry limit");
    assert.equal(report.entryCount, 33);
    assert.equal(report.bytes, 33);
    assert.match(report.reason, /scratch entry limit 32 entries/);
    assert.equal(
      existsSync(runRoot),
      false,
      "the row must still reclaim the run root so the next run starts clean",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a handful of shutdown stragglers passes but is still reported and reclaimed", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dohc-scratch-report-test-"));
  const runRoot = join(parent, "run");
  try {
    await plant(runRoot, 3, 17);

    const report = await inspectScratchRun(runRoot);

    assert.equal(report.status, "PASS", "3 entries is inside the measured healthy range");
    assert.equal(report.entryCount, 3, "the count is still reported, never hidden");
    assert.equal(report.bytes, 51, "the bytes are still reported, never hidden");
    assert.match(report.reason, /3 entries and 51 bytes/);
    assert.equal(
      existsSync(runRoot),
      false,
      "a completed run must leave nothing behind, straggler or not",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a clean run reports zero", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dohc-scratch-report-test-"));
  const runRoot = join(parent, "run");
  try {
    await mkdir(runRoot, { recursive: true });

    const report = await inspectScratchRun(runRoot);

    assert.equal(report.status, "PASS");
    assert.equal(report.entryCount, 0);
    assert.equal(report.bytes, 0);
    assert.equal(existsSync(runRoot), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
