// The build-slot budget, exercised against a private slot root.
//
// The contract under test is the machine's build budget: four slots,
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

test("Windows CI is uncapped unless an explicit slot root requests the workstation budget", () => {
  const host = { platform: "win32", cores: 32 };
  for (const CI of ["true", "1"]) {
    assert.equal(resolveBuildBudget({ CI }, host), null);
    assert.equal(resolveBuildBudget({ CI, DOHC_BUILD_SLOT_ROOT: "" }, host), null);
    assert.deepEqual(resolveBuildBudget({ CI, DOHC_BUILD_SLOT_ROOT: "D:\\ci-locks" }, host), {
      root: "D:\\ci-locks", slots: 4, jobs: 8, diskFloorGb: 40,
    });
  }
  for (const env of [{}, { CI: "false" }, { CI: "0" }]) {
    assert.deepEqual(resolveBuildBudget(env, host), {
      root: "C:\\w\\_locks", slots: 4, jobs: 8, diskFloorGb: 40,
    });
  }
});

test("released slots remove only their listeners and allow later interrupt cleanup", () => {
  const root = slotRoot();
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { acquireBuildSlot } from ${JSON.stringify(new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).href)};
      const unrelated = () => {};
      const events = ["exit", "SIGINT", "SIGTERM"];
      for (const event of events) process.on(event, unrelated);
      const before = events.map(event => process.listeners(event));
      const slot = await acquireBuildSlot({ root: process.argv[1], slots: 1, waitMs: 0 });
      slot.release();
      slot.release();
      assert.deepEqual(events.map(event => process.listeners(event)), before);
      let cleaned = false;
      process.once("SIGINT", () => { cleaned = true; });
      process.emit("SIGINT");
      assert.equal(cleaned, true);
      console.log("later-phase cleanup completed");
    `, root], { encoding: "utf8", timeout: 20_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /later-phase cleanup completed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cooperative budget cancellation stops its child before releasing the slot and running caller finally", () => {
  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const root = slotRoot();
    const childRecord = join(root, "child.json");
    let childStopped = false;
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { existsSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { withBuildBudget } from ${JSON.stringify(new URL("verification/build.mjs", import.meta.url).href)};
        import { run } from ${JSON.stringify(new URL("verification/process.mjs", import.meta.url).href)};
        const root = process.argv[1];
        const signal = process.argv[2];
        const slot = join(root, "build-slot-1");
        let child;
        let heldAfterSignal = false;
        let rejected = false;
        try {
          await withBuildBudget(env => run(process.execPath, ["-e", "setInterval(() => {}, 1000); console.log('child-ready');"], {
            env,
            onSpawn: spawned => {
              child = spawned;
              writeFileSync(join(root, "child.json"), JSON.stringify({ pid: child.pid }));
              let output = "";
              child.stdout.on("data", function ready(chunk) {
                output += String(chunk);
                if (!output.includes("child-ready")) return;
                child.stdout.off("data", ready);
                assert.equal(existsSync(slot), true);
                process.emit(signal);
                heldAfterSignal = existsSync(slot);
              });
            },
          }));
        } catch (error) {
          assert.match(error.message, /interrupted/);
          rejected = true;
        } finally {
          writeFileSync(join(root, "finally.json"), JSON.stringify({
            rejected, heldAfterSignal, slotExists: existsSync(slot),
            childStopped: Boolean(child && (child.exitCode !== null || child.signalCode !== null)),
          }));
        }
      `, root, signal], {
        encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL",
        env: { ...process.env, DOHC_BUILD_SLOT_ROOT: root, DOHC_GATE_DISK_FLOOR_GB: "0" },
      });
      const finallyPath = join(root, "finally.json");
      const cleanup = existsSync(finallyPath) ? JSON.parse(readFileSync(finallyPath, "utf8")) : null;
      childStopped = cleanup?.childStopped === true;
      assert.equal(result.error, undefined);
      assert.equal(result.status, status, result.stderr);
      assert.deepEqual(cleanup, { rejected: true, heldAfterSignal: true, slotExists: false, childStopped: true });
      assert.equal(existsSync(join(root, "build-slot-1")), false);
    } finally {
      if (!childStopped && existsSync(childRecord)) {
        const { pid } = JSON.parse(readFileSync(childRecord, "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          if (process.platform === "win32") {
            const stopped = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
            if (stopped.status !== 0) {
              try { process.kill(pid, "SIGKILL"); }
              catch (error) { if (error.code !== "ESRCH") throw error; }
            }
          } else {
            try { process.kill(-pid, "SIGKILL"); }
            catch (error) { if (error.code !== "ESRCH") throw error; }
          }
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
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

test("release removes nothing when the slot no longer holds this claim", async () => {
  const root = slotRoot();
  const events = ["exit", "SIGINT", "SIGTERM"];
  const listenersBefore = events.map((event) => process.listeners(event));
  try {
    const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
    // The slot was reclaimed out from under a suspended holder and
    // re-granted: the path now carries another lane's owner record.
    writeFileSync(
      join(slot.dir, "owner.json"),
      JSON.stringify({ pid: 99999, start: "someone else" }),
    );
    slot.release();
    assert.deepEqual(events.map((event) => process.listeners(event)), listenersBefore);
    assert.equal(
      existsSync(slot.dir),
      true,
      "release must not delete a slot it no longer owns",
    );
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
    // a second time. Both the current and next time bucket are planted so
    // the test cannot flake across a bucket boundary.
    const mtime = Math.round(statSync(lock).mtimeMs);
    const bucket = Math.floor(Date.now() / (5 * 60_000));
    writeFileSync(`${lock}.claim-${mtime}-${bucket}`, "");
    writeFileSync(`${lock}.claim-${mtime}-${bucket + 1}`, "");
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
