import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SCRATCH_SENTINEL,
  inspectScratchRun,
} from "../tools/rust-engine-program/scratch-leak-report.mjs";

// The payload is a length, not content: `inspectScratchRun` reads `lstat().size`
// and never opens a file. `truncate` sets that length without writing the
// bytes, so the byte-limit case costs no disk I/O — 400 MiB of real writes in a
// unit test is slow wherever a virus scanner watches %TEMP%, and fails outright
// on a disk already low, which is the very condition this row exists to report.
async function plant(runRoot, count, bytesEach) {
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(runRoot, SCRATCH_SENTINEL), "run-id");
  for (let index = 0; index < count; index++) {
    const directory = join(runRoot, `leaked-workspace-${index}`);
    await mkdir(directory, { recursive: true });
    const payload = join(directory, "payload.bin");
    await writeFile(payload, "");
    await truncate(payload, bytesEach);
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
    assert.equal(report.descendants, 6, "3 directories each holding one file");
    assert.match(report.reason, /3 entries \(6 descendants\) and 51 bytes/);
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

// One directory holding a thousand empty files is 1 entry and 0 bytes, and both
// of the row's limits are blind to it. The row still passes — there is no
// measured healthy descendant count to reject against — but it must not report
// the shape it cannot see as nothing.
test("one directory full of empty files is counted, not reported as nothing", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dohc-scratch-report-test-"));
  const runRoot = join(parent, "run");
  try {
    await plant(runRoot, 0, 0);
    const runaway = join(runRoot, "runaway-workspace");
    await mkdir(runaway, { recursive: true });
    for (let index = 0; index < 1_000; index++) {
      await writeFile(join(runaway, `empty-${index}`), "");
    }

    const report = await inspectScratchRun(runRoot);

    assert.equal(report.entryCount, 1, "the entry limit sees one directory");
    assert.equal(report.bytes, 0, "the byte limit sees nothing at all");
    assert.equal(report.descendants, 1_001, "the directory and its 1,000 files");
    assert.match(report.reason, /1 entries \(1001 descendants\) and 0 bytes/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// Deny listing an EMPTY directory, and hand back the undo. Real permissions on
// both platforms — `icacls /deny` on Windows, `chmod` elsewhere — and neither
// needs privilege on a directory this process just made.
//
// The right denied is the narrow one: reading the directory's contents, not
// deleting it. `readdir` fails, `rmdir` still succeeds, and the removal below
// therefore runs at full speed. Denying more (`(RX)`, or a directory with a
// file in it) makes `rm` retry its whole Windows budget against a tree it can
// never enumerate: 26 seconds, measured, for one unit test.
async function denyListing(directory) {
  if (process.platform === "win32") {
    const account = userInfo().username;
    execFileSync("icacls", [directory, "/deny", `${account}:(RD)`], { stdio: "pipe" });
    return () => {
      // The removal under test may already have taken the directory with it.
      try {
        execFileSync("icacls", [directory, "/remove:d", account], { stdio: "pipe" });
      } catch {}
    };
  }
  await chmod(directory, 0o000);
  return async () => {
    await chmod(directory, 0o700).catch(() => {});
  };
}

// The reporter is the gate's last reclamation point. A measurement that throws
// is exactly when something is wrong, and it used to take the removal with it:
// the row failed and the whole run root stayed on disk.
test("a child that cannot be read still fails the row and still reclaims the root", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "dohc-scratch-report-test-"));
  const runRoot = join(parent, "run");
  const unreadable = join(runRoot, "unreadable-workspace");
  let restore;
  try {
    await plant(runRoot, 0, 0);
    await mkdir(unreadable, { recursive: true });
    restore = await denyListing(unreadable);

    // Prove the fixture before asserting on it. Running as root, or on a
    // filesystem that ignores the deny, would make this test pass for no
    // reason at all — the shape of green check this PR exists to remove.
    const listable = await readdir(unreadable).then(
      () => true,
      () => false,
    );
    if (listable) {
      t.skip("this user can list a directory it denied itself; there is no fixture to test");
      return;
    }

    const report = await inspectScratchRun(runRoot);

    assert.equal(report.status, "FAIL", "a child that cannot be read is a leak");
    assert.match(report.reason, /scratch measurement failed/);
    // Both facts, never one: what could not be measured, and whether the tree
    // is still on disk.
    assert.match(report.reason, /run root reclaimed/);
    assert.equal(
      existsSync(runRoot),
      false,
      "the row must reclaim the root even when it could not finish measuring it",
    );
  } finally {
    if (restore) await restore();
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
