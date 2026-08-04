import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectScratchRun } from "../tools/rust-engine-program/scratch-leak-report.mjs";

test("the Rust gate reports a planted scratch leftover", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dohc-scratch-report-test-"));
  const runRoot = join(parent, "run");
  const leaked = join(runRoot, "leaked-workspace");
  try {
    await mkdir(leaked, { recursive: true });
    await writeFile(join(leaked, "payload.bin"), Buffer.alloc(17));

    const report = await inspectScratchRun(runRoot);

    assert.equal(
      report.status,
      "FAIL",
      "a planted scratch leftover must make the gate row FAIL",
    );
    assert.equal(report.entryCount, 1);
    assert.equal(report.bytes, 17);
    assert.deepEqual(report.leaked, ["leaked-workspace"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
