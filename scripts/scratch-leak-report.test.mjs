import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SCRATCH_SENTINEL,
  inspectScratchRun,
} from "../tools/rust-engine-program/scratch-leak-report.mjs";

async function plant(runRoot, count, bytesEach) {
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(runRoot, SCRATCH_SENTINEL), "run-id");
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
    await plant(runRoot, 0, 0);

    const report = await inspectScratchRun(runRoot);

    assert.equal(report.status, "PASS");
    assert.equal(report.entryCount, 0);
    assert.equal(report.bytes, 0);
    assert.equal(existsSync(runRoot), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// The failure this guards is the row inspecting a tree the tests never wrote
// to — under WSL, Node's tmpdir() and Rust's temp_dir() resolve differently —
// and reporting the resulting emptiness as a clean run.
test("a run root that was never written to fails instead of reporting clean", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dohc-scratch-report-test-"));
  const missing = join(parent, "a-root-the-tests-never-used");
  try {
    const report = await inspectScratchRun(missing);

    assert.equal(report.status, "FAIL", "an absent root is not a clean run");
    assert.equal(report.entryCount, 0);
    assert.match(report.reason, /does not exist/);
    assert.match(report.reason, /never looked at|nothing was inspected/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a run root without the sentinel fails instead of reporting clean", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dohc-scratch-report-test-"));
  const runRoot = join(parent, "run");
  try {
    // A directory that exists and is empty, but is not the tree the run used.
    await mkdir(runRoot, { recursive: true });

    const report = await inspectScratchRun(runRoot);

    assert.equal(report.status, "FAIL", "no sentinel means nothing was looked at");
    assert.match(report.reason, new RegExp(SCRATCH_SENTINEL.replace(".", "\\.")));
    assert.equal(
      existsSync(runRoot),
      true,
      "a root this row does not own must not be deleted by it",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// #605 was 196 GB, not 191,851 directories. A row bounding only the count would
// pass one workspace that grew without limit — the same outage, different shape.
test("a few huge directories fail on bytes even though the count is small", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dohc-scratch-report-test-"));
  const runRoot = join(parent, "run");
  try {
    await plant(runRoot, 2, 200 * 1024 * 1024);

    const report = await inspectScratchRun(runRoot);

    assert.equal(report.status, "FAIL", "400 MiB in 2 directories is a leak");
    assert.equal(report.entryCount, 2, "the count alone would have passed");
    assert.match(report.reason, /byte limit 268435456 bytes/);
    assert.equal(existsSync(runRoot), false, "the row still reclaims the root");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
