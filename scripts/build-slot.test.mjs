// The build-slot budget, exercised against a private slot root.
//
// The contract under test is WINDOWS_DEV.md "Build economics": four slots,
// atomic directory acquisition, owner-safe reclamation (stale heartbeat AND
// dead pid, never either alone), and a denial that names the constraint. The
// gate holds a slot for its whole run, so a defect here either deadlocks
// every lane or lets five unbounded cargos share one machine — the crash this
// module exists to prevent.

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireBuildSlot,
  reclaimStaleSlots,
  resolveBuildBudget,
} from "../tools/rust-engine-program/build-slot.mjs";

const slotRoot = () => mkdtempSync(join(tmpdir(), "dohc-build-slot-"));

/** A pid that once existed and is dead now: a spawned-and-exited child's. */
function deadPid() {
  const res = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(res.status, 0);
  return res.pid;
}

function plantSlot(root, i, { pid, heartbeatAgeMs }) {
  const dir = join(root, `build-slot-${i}`);
  mkdirSync(dir, { recursive: true });
  const ownerPath = join(dir, "owner.json");
  writeFileSync(
    ownerPath,
    JSON.stringify({ pid, start: new Date().toISOString() }),
  );
  const then = new Date(Date.now() - heartbeatAgeMs);
  utimesSync(ownerPath, then, then);
  return dir;
}

test("the budget is an even share of the cores across four slots", () => {
  const budget = resolveBuildBudget(
    { DOHC_BUILD_SLOT_ROOT: "X:\\locks" },
    { cores: 32 },
  );
  assert.deepEqual(budget, {
    root: "X:\\locks",
    slots: 4,
    jobs: 8,
    diskFloorGb: 40,
  });

  // The share is cores/slots with no invented minimum: four cores, one job.
  assert.equal(
    resolveBuildBudget({ DOHC_BUILD_SLOT_ROOT: "X:" }, { cores: 4 }).jobs,
    1,
  );

  // No slot root, no budget: a single-tenant host runs uncapped. An empty
  // string is "no root", not a root.
  assert.equal(resolveBuildBudget({}, { platform: "linux", cores: 32 }), null);
  assert.equal(
    resolveBuildBudget(
      { DOHC_BUILD_SLOT_ROOT: "" },
      { platform: "linux", cores: 32 },
    ),
    null,
  );
});

test("acquire takes a free slot, writes its owner, and release frees it", async () => {
  const root = slotRoot();
  try {
    const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
    assert.equal(slot.name, "build-slot-1");
    const owner = JSON.parse(readFileSync(join(slot.dir, "owner.json"), "utf8"));
    assert.equal(owner.pid, process.pid);
    slot.release();
    assert.equal(existsSync(slot.dir), false);
    // Idempotent: a second release is a no-op, not a crash.
    slot.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two lanes get two different slots", async () => {
  const root = slotRoot();
  try {
    const first = await acquireBuildSlot({ root, slots: 2, waitMs: 0 });
    const second = await acquireBuildSlot({ root, slots: 2, waitMs: 0 });
    assert.notEqual(first.name, second.name);
    first.release();
    second.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a full house is refused with the constraint, the limit, and the holders", async () => {
  const root = slotRoot();
  try {
    plantSlot(root, 1, { pid: process.pid, heartbeatAgeMs: 0 });
    await assert.rejects(
      acquireBuildSlot({ root, slots: 1, waitMs: 0 }),
      (error) => {
        assert.match(error.message, /concurrency budget is 1 concurrent cargo lane/);
        assert.match(error.message, new RegExp(`pid ${process.pid}`));
        return true;
      },
    );
    // The denial is on the record beside the slots.
    assert.match(readFileSync(join(root, "events.log"), "utf8"), /denied: pid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale slot with a dead owner is reclaimed; acquisition proceeds", async () => {
  const root = slotRoot();
  try {
    plantSlot(root, 1, { pid: deadPid(), heartbeatAgeMs: 45 * 60_000 });
    const slot = await acquireBuildSlot({
      root,
      slots: 1,
      waitMs: 0,
      staleMs: 30 * 60_000,
    });
    assert.equal(slot.name, "build-slot-1");
    slot.release();
    assert.match(readFileSync(join(root, "events.log"), "utf8"), /reclaimed build-slot-1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live owner is never reclaimed: fresh heartbeat or alive pid protects it", () => {
  const root = slotRoot();
  try {
    // Dead owner, fresh heartbeat: the OS may have reused the pid.
    plantSlot(root, 1, { pid: deadPid(), heartbeatAgeMs: 0 });
    // Live owner, stale heartbeat: a wedged-but-alive lane still owns it.
    plantSlot(root, 2, { pid: process.pid, heartbeatAgeMs: 45 * 60_000 });
    assert.equal(
      reclaimStaleSlots({ root, slots: 2, staleMs: 30 * 60_000 }),
      0,
    );
    assert.equal(existsSync(join(root, "build-slot-1")), true);
    assert.equal(existsSync(join(root, "build-slot-2")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a slot with no working heartbeat for the stale window is reclaimed", () => {
  const root = slotRoot();
  try {
    // Torn owner write: unreadable content, stale mtime. A live owner would
    // have refreshed the mtime every minute whatever the content says.
    const corrupt = plantSlot(root, 1, {
      pid: process.pid,
      heartbeatAgeMs: 45 * 60_000,
    });
    writeFileSync(join(corrupt, "owner.json"), "not json");
    const then = new Date(Date.now() - 45 * 60_000);
    utimesSync(join(corrupt, "owner.json"), then, then);
    // Crash between mkdir and the owner write: a bare directory, old.
    const bare = join(root, "build-slot-2");
    mkdirSync(bare, { recursive: true });
    utimesSync(bare, then, then);
    assert.equal(
      reclaimStaleSlots({ root, slots: 2, staleMs: 30 * 60_000 }),
      2,
    );
    assert.equal(existsSync(corrupt), false);
    assert.equal(existsSync(bare), false);
    // But the same states with fresh timestamps stay held.
    const fresh = plantSlot(root, 3, { pid: process.pid, heartbeatAgeMs: 0 });
    writeFileSync(join(fresh, "owner.json"), "not json");
    assert.equal(
      reclaimStaleSlots({ root, slots: 3, staleMs: 30 * 60_000 }),
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live sweep lock defers reclamation to the sweeper that holds it", () => {
  const root = slotRoot();
  try {
    plantSlot(root, 1, { pid: deadPid(), heartbeatAgeMs: 45 * 60_000 });
    mkdirSync(join(root, "reclaim.lock"), { recursive: true });
    assert.equal(
      reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000 }),
      0,
    );
    // A dead sweeper's lock is taken over after its own stale window.
    const then = new Date(Date.now() - 6 * 60_000);
    utimesSync(join(root, "reclaim.lock"), then, then);
    assert.equal(
      reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000 }),
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a takeover already claimed by a racer is lost, not repeated", () => {
  const root = slotRoot();
  try {
    plantSlot(root, 1, { pid: deadPid(), heartbeatAgeMs: 45 * 60_000 });
    const lock = join(root, "reclaim.lock");
    mkdirSync(lock, { recursive: true });
    const then = new Date(Date.now() - 6 * 60_000);
    utimesSync(lock, then, then);
    // The racing winner's claim for this exact observed identity: our
    // exclusive create must collide with it and defer instead of sweeping
    // a second time.
    writeFileSync(`${lock}.claim-${Math.round(statSync(lock).mtimeMs)}`, "");
    assert.equal(
      reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000 }),
      0,
    );
    assert.equal(existsSync(join(root, "build-slot-1")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the heartbeat keeps restoring the owner file's freshness", async () => {
  const root = slotRoot();
  try {
    const slot = await acquireBuildSlot({
      root,
      slots: 1,
      waitMs: 0,
      heartbeatMs: 20,
    });
    const ownerPath = join(slot.dir, "owner.json");
    // Back-date the heartbeat to reclaimable age; a live owner's next tick
    // must bring it back, which is what keeps a long build's slot its own.
    const then = new Date(Date.now() - 45 * 60_000);
    utimesSync(ownerPath, then, then);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(
      Date.now() - statSync(ownerPath).mtimeMs < 60_000,
      "an interval tick must restore the heartbeat",
    );
    slot.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
