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
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as poll } from "node:timers/promises";
import {
  acquireBuildSlot,
  acquireVerificationSlot,
  reclaimStaleSlots,
  resolveBuildBudget,
} from "../tools/rust-engine-program/build-slot.mjs";

const slotRoot = () => mkdtempSync(join(tmpdir(), "dohc-build-slot-"));

function queueProbe(root, script) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import timers from "node:timers/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    import { acquireBuildSlot } from ${JSON.stringify(new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).href)};
    const root = process.argv[1];
    ${script}
  `, root], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr);
}

test("transient sweep and ticket-read errors retry without ending the wait", () => {
  const root = slotRoot();
  try {
    for (const code of ["EPERM", "EBUSY", "EACCES", "ENOENT"]) {
      for (const operation of ["lock", "queue", "ticket"]) {
        queueProbe(root, `
          const holder = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
          const method = ${JSON.stringify(operation)} === "lock" ? "mkdirSync"
            : ${JSON.stringify(operation)} === "queue" ? "readdirSync" : "readFileSync";
          const original = fs[method];
          let failed = false;
          fs[method] = (path, ...args) => {
            const target = ${JSON.stringify(operation)} === "lock" ? path === join(root, "reclaim.lock")
              : ${JSON.stringify(operation)} === "queue" ? path === join(root, "build-slot-queue")
              : path.includes("build-slot-queue") && path.endsWith(".json");
            if (!failed && target) {
              failed = true;
              holder.release();
              throw Object.assign(new Error("busy file"), { code: ${JSON.stringify(code)} });
            }
            return original(path, ...args);
          };
          syncBuiltinESMExports();
          const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 1000, pollMs: 1 });
          assert.equal(failed, true);
          slot.release();
        `);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root access failures and real sweep faults still reject acquisition", () => {
  const root = slotRoot();
  try {
    for (const code of ["EPERM", "EACCES", "EIO"]) {
      queueProbe(root, `
        const mkdir = fs.mkdirSync;
        const read = fs.readdirSync;
        fs.mkdirSync = (path, ...args) => {
          if (path === join(root, "reclaim.lock")) {
            throw Object.assign(new Error("sweep fault"), { code: ${JSON.stringify(code)} });
          }
          return mkdir(path, ...args);
        };
        fs.readdirSync = (path, ...args) => {
          if (path === root) throw Object.assign(new Error("root inaccessible"), { code: ${JSON.stringify(code)} });
          return read(path, ...args);
        };
        syncBuiltinESMExports();
        await assert.rejects(acquireBuildSlot({ root, slots: 1, waitMs: 1000, pollMs: 1 }), { code: ${JSON.stringify(code)} });
      `);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readable but unwritable roots and queues fail before polling", () => {
  const root = slotRoot();
  try {
    for (const code of ["EPERM", "EACCES"]) {
      for (const directory of [root, join(root, "build-slot-queue")]) {
        queueProbe(root, `
          fs.mkdirSync(join(root, "build-slot-queue"), { recursive: true });
          const mkdir = fs.mkdirSync;
          const write = fs.writeFileSync;
          const directory = ${JSON.stringify(directory)};
          fs.mkdirSync = (path, ...args) => {
            if ((directory === root && path.startsWith(join(root, ".access-probe-"))) || path === join(root, "reclaim.lock")) {
              throw Object.assign(new Error("directory unwritable"), { code: ${JSON.stringify(code)} });
            }
            return mkdir(path, ...args);
          };
          fs.writeFileSync = (path, ...args) => {
            if (directory !== root && (path.endsWith(".json.tmp") || path.startsWith(join(directory, ".access-probe-")))) {
              throw Object.assign(new Error("queue unwritable"), { code: ${JSON.stringify(code)} });
            }
            return write(path, ...args);
          };
          timers.setTimeout = async () => { assert.fail("root faults must not poll"); };
          syncBuiltinESMExports();
          await assert.rejects(acquireBuildSlot({ root, slots: 1, waitMs: 6 * 60 * 60_000 }), { code: ${JSON.stringify(code)} });
        `);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transient access probe cleanup errors do not reject acquisition", () => {
  const root = slotRoot();
  try {
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      queueProbe(root, `
        const mkdir = fs.mkdirSync;
        const remove = fs.rmSync;
        let failedLock = false;
        let failedCleanup = false;
        fs.mkdirSync = (path, ...args) => {
          if (!failedLock && path === join(root, "reclaim.lock")) {
            failedLock = true;
            throw Object.assign(new Error("transient lock fault"), { code: "EPERM" });
          }
          return mkdir(path, ...args);
        };
        fs.rmSync = (path, ...args) => {
          if (!failedCleanup && path.includes(".access-probe-")) {
            failedCleanup = true;
            throw Object.assign(new Error("busy probe"), { code: ${JSON.stringify(code)} });
          }
          return remove(path, ...args);
        };
        syncBuiltinESMExports();
        const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
        assert.equal(failedLock, true);
        assert.equal(failedCleanup, true);
        slot.release();
      `);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ticket publication exposes only a complete JSON record", () => {
  const root = slotRoot();
  try {
    queueProbe(root, `
      const write = fs.writeFileSync;
      const rename = fs.renameSync;
      let published = false;
      fs.writeFileSync = (path, data, options) => {
        if (path.includes("build-slot-queue")) {
          assert.equal(path.endsWith(".json"), false);
          assert.deepEqual(fs.readdirSync(join(root, "build-slot-queue")), []);
        }
        return write(path, data, options);
      };
      fs.renameSync = (from, to) => {
        if (to.includes("build-slot-queue") && to.endsWith(".json")) {
          assert.equal(JSON.parse(fs.readFileSync(from, "utf8")).pid, process.pid);
          assert.equal(JSON.parse(fs.readFileSync(from, "utf8")).heartbeatMs, 1000);
          published = true;
        }
        return rename(from, to);
      };
      syncBuiltinESMExports();
      const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 0, heartbeatMs: 1000 });
      assert.equal(published, true);
      slot.release();
      assert.deepEqual(fs.readdirSync(join(root, "build-slot-queue")), []);
    `);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreadable tickets expire after two heartbeats and reused live pids after three", () => {
  const root = slotRoot();
  try {
    const torn = plantTicket(root, 1, { pid: process.pid });
    writeFileSync(torn, "{");
    const reused = plantTicket(root, 2, { pid: process.pid });
    const sweep = () => reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000 });
    sweep();
    assert.equal(existsSync(torn), true);
    assert.equal(existsSync(reused), true);
    const then = new Date(Date.now() - 150_000);
    utimesSync(torn, then, then);
    utimesSync(reused, then, then);
    sweep();
    assert.equal(existsSync(torn), false);
    assert.equal(existsSync(reused), true);
    const older = new Date(Date.now() - 210_000);
    utimesSync(reused, older, older);
    sweep();
    assert.equal(existsSync(reused), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweeps expire temporary tickets after grace and use each owner's heartbeat", () => {
  const root = slotRoot();
  try {
    const fast = plantTicket(root, 1, { pid: process.pid, heartbeatMs: 1000, heartbeatAgeMs: 3500 });
    const slow = plantTicket(root, 2, { pid: process.pid, heartbeatMs: 10_000, heartbeatAgeMs: 3500 });
    const legacy = plantTicket(root, 3, { pid: process.pid, heartbeatAgeMs: 3500 });
    const dir = join(root, "build-slot-queue");
    const fresh = join(dir, "fresh.json.tmp");
    const stale = join(dir, "stale.json.tmp");
    const torn = join(dir, "torn.json.tmp");
    writeFileSync(fresh, JSON.stringify({ pid: deadPid(), heartbeatMs: 60_000 }));
    writeFileSync(stale, JSON.stringify({ pid: process.pid, heartbeatMs: 1000 }));
    writeFileSync(torn, "{");
    const then = new Date(Date.now() - 2500);
    utimesSync(stale, then, then);
    const older = new Date(Date.now() - 150_000);
    utimesSync(torn, older, older);
    reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000 });
    for (const path of [fast, stale, torn]) assert.equal(existsSync(path), false, path);
    for (const path of [slow, legacy, fresh]) assert.equal(existsSync(path), true, path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repeatedly missing ticket yields and honors the acquisition deadline", () => {
  const root = slotRoot();
  try {
    queueProbe(root, `
      const read = fs.readdirSync;
      let now = Date.now();
      Date.now = () => now;
      let reads = 0;
      let yielded = false;
      setImmediate(() => { yielded = true; });
      timers.setTimeout = async () => { await new Promise(setImmediate); };
      fs.readdirSync = (path, ...args) => {
        const names = read(path, ...args);
        if (path === join(root, "build-slot-queue")) {
          reads += 1;
          now += 20;
          for (const name of names) fs.rmSync(join(path, name), { force: true });
          return [];
        }
        return names;
      };
      syncBuiltinESMExports();
      await assert.rejects(acquireBuildSlot({ root, slots: 1, waitMs: 100, pollMs: 1 }), /no build slot freed/);
      assert.ok(reads < 10, "missing tickets must not bypass the deadline");
      assert.equal(yielded, true, "missing tickets must yield between retries");
    `);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweeps use pollMs with held slots and accelerate for older tickets reserving capacity", () => {
  const root = slotRoot();
  try {
    for (const reserved of [false, true]) {
      queueProbe(root, `
        let now = Date.now();
        Date.now = () => now;
        const holder = ${reserved} ? undefined : await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
        const older = join(root, "build-slot-queue", "000000000000000000000001.json");
        if (${reserved}) {
          fs.mkdirSync(join(root, "build-slot-queue"), { recursive: true });
          fs.writeFileSync(older, JSON.stringify({ pid: process.pid }));
        }
        let sweeps = 0;
        const mkdir = fs.mkdirSync;
        fs.mkdirSync = (path, ...args) => {
          if (path === join(root, "reclaim.lock")) sweeps += 1;
          return mkdir(path, ...args);
        };
        let polls = 0;
        timers.setTimeout = async () => {
          now += 1000;
          polls += 1;
          if (polls === 2) {
            holder?.release();
            fs.rmSync(older, { force: true });
          }
        };
        syncBuiltinESMExports();
        const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 5000, pollMs: 3000 });
        assert.equal(polls, 2);
        assert.equal(sweeps, ${reserved ? 2 : 1});
        slot.release();
      `);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(condition, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, typeof message === "function" ? message() : message);
    await poll(10);
  }
}

function tickets(root, kind = "build-slot") {
  const dir = join(root, `${kind}-queue`);
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")).sort() : [];
}

function queueHarness(t) {
  const root = slotRoot();
  const children = [];
  const acquired = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await waitFor(() => children.every(child => child.closed), "waiters must exit before removing their root");
    rmSync(root, { recursive: true, force: true });
  });
  function start(id, { kind = "build-slot", ...options } = {}) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { acquireBuildSlot, acquireVerificationSlot } from ${JSON.stringify(new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).href)};
      let slot;
      process.on("message", command => {
        if (command === "release") { slot.release(); process.exit(0); }
        else if (command === "exit") process.exit(0);
        else process.emit(command);
      });
      console.log = message => process.send({ type: "waiting", message });
      try {
        slot = await (${JSON.stringify(kind)} === "verification-slot"
          ? acquireVerificationSlot({ DOHC_BUILD_SLOT_ROOT: process.argv[1] })
          : acquireBuildSlot({ root: process.argv[1], slots: 1, waitMs: 20_000, pollMs: 60_000, ...JSON.parse(process.argv[2]) }));
        process.send({ type: "acquired", name: slot.name });
      } catch (error) {
        process.send({ type: "rejected", message: error.message }, () => process.disconnect());
      }
    `, root, JSON.stringify(options)], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    child.messages = [];
    child.stderrText = "";
    child.stderr.on("data", chunk => { child.stderrText += String(chunk); });
    child.on("message", message => {
      child.messages.push(message);
      if (message.type === "acquired") acquired.push(id);
    });
    child.on("close", () => { child.closed = true; });
    children.push(child);
    return child;
  }
  const message = async (child, type) => {
    await waitFor(() => child.messages.some(item => item.type === type), () => `expected ${type} from pid ${child.pid}: ${child.stderrText}`);
    return child.messages.find(item => item.type === type);
  };
  return { root, start, message, acquired };
}

/** A pid that once existed and is dead now: a spawned-and-exited child's. */
function deadPid() {
  const res = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(res.status, 0);
  return res.pid;
}

function plantSlot(root, i, { pid, heartbeatAgeMs, kind = "build-slot" }) {
  const dir = join(root, `${kind}-${i}`);
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

function plantTicket(root, order, { pid, heartbeatAgeMs = 0, heartbeatMs, kind = "build-slot" }) {
  const dir = join(root, `${kind}-queue`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${String(order).padStart(24, "0")}-${pid}.json`);
  writeFileSync(path, JSON.stringify({ pid, start: new Date().toISOString(), heartbeatMs }));
  const then = new Date(Date.now() - heartbeatAgeMs);
  utimesSync(path, then, then);
  return path;
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

test("three verification waiters acquire in FIFO order with prompt handoff", async (t) => {
  const { root, start, message, acquired } = queueHarness(t);
  const holder = await acquireVerificationSlot({ DOHC_BUILD_SLOT_ROOT: root });
  t.after(() => holder.release());
  const waiters = [];
  for (let id = 1; id <= 3; id += 1) {
    const child = start(id, { kind: "verification-slot" });
    waiters.push(child);
    const waiting = await message(child, "waiting");
    assert.match(waiting.message, new RegExp(`pid ${process.pid}`));
    assert.match(waiting.message, new RegExp(`queue position ${id}$`));
    assert.equal(tickets(root, "verification-slot").length, id);
  }
  holder.release();
  for (let id = 1; id <= 3; id += 1) {
    // The child uses the public verification API's 60-second poll setting.
    // A condition deadline proves handoff happens before that whole interval.
    await waitFor(() => acquired.length >= id, "released slot must hand off promptly", 5000);
    assert.deepEqual(acquired, Array.from({ length: id }, (_, index) => index + 1));
    assert.equal(tickets(root, "verification-slot").length, 3 - id);
    waiters[id - 1].send("release");
    await waitFor(() => waiters[id - 1].closed, "released waiter must exit");
  }
});

test("faster-polling newcomers cannot overtake older build waiters", async (t) => {
  const { root, start, message, acquired } = queueHarness(t);
  const holder = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
  t.after(() => holder.release());
  const waiters = [];
  for (const [id, pollMs] of [[1, 1000], [2, 200], [3, 50]]) {
    const child = start(id, { pollMs });
    waiters.push(child);
    await message(child, "waiting");
  }
  holder.release();
  for (let id = 1; id <= 3; id += 1) {
    await waitFor(() => acquired.length >= id, "oldest ticket must acquire despite slower polling");
    assert.deepEqual(acquired, Array.from({ length: id }, (_, index) => index + 1));
    waiters[id - 1].send("release");
    await waitFor(() => waiters[id - 1].closed, "released waiter must exit");
  }
});

test("a waiter reserves free capacity for older tickets in multi-slot kinds", async () => {
  const root = slotRoot();
  try {
    const older = plantTicket(root, 1, { pid: process.pid });
    const slot = await acquireBuildSlot({ root, slots: 2, waitMs: 0 });
    assert.equal(slot.name, "build-slot-2");
    assert.equal(existsSync(join(root, "build-slot-1")), false);
    assert.equal(existsSync(older), true);
    assert.equal(tickets(root).length, 1);
    slot.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held sweep lock does not delay admission to free slots", async () => {
  const root = slotRoot();
  try {
    mkdirSync(join(root, "reclaim.lock"));
    const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
    assert.equal(slot.name, "build-slot-1");
    assert.equal(existsSync(join(root, "reclaim.lock")), true);
    slot.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ticket reclamation uses the sweep lock and expires stale live or unreadable owners", () => {
  const root = slotRoot();
  try {
    const dead = plantTicket(root, 1, { pid: deadPid() });
    const stale = plantTicket(root, 2, { pid: process.pid, heartbeatAgeMs: 45 * 60_000 });
    const live = plantTicket(root, 3, { pid: process.pid });
    const torn = plantTicket(root, 4, { pid: process.pid });
    writeFileSync(torn, "not json");
    const staleTorn = plantTicket(root, 5, { pid: process.pid });
    writeFileSync(staleTorn, "not json");
    const then = new Date(Date.now() - 45 * 60_000);
    utimesSync(staleTorn, then, then);
    mkdirSync(join(root, "reclaim.lock"));
    assert.equal(reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000 }), 0);
    assert.equal(tickets(root).length, 5);
    rmSync(join(root, "reclaim.lock"), { recursive: true });
    assert.equal(reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000 }), 0);
    for (const path of [dead, stale, staleTorn]) assert.equal(existsSync(path), false);
    for (const path of [live, torn]) assert.equal(existsSync(path), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a waiter rejoins the queue after its ticket is removed", async (t) => {
  const { root, start, message } = queueHarness(t);
  const holder = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
  t.after(() => holder.release());
  const child = start("rejoin");
  await message(child, "waiting");
  const [old] = tickets(root);
  rmSync(join(root, "build-slot-queue", old));
  await waitFor(() => tickets(root).length === 1 && tickets(root)[0] !== old, "waiter must replace a missing ticket");
  holder.release();
  await message(child, "acquired");
  assert.deepEqual(tickets(root), []);
  child.send("release");
});

test("a waiting ticket's heartbeat restores its freshness", async () => {
  const root = slotRoot();
  const holder = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
  const pending = acquireBuildSlot({ root, slots: 1, waitMs: 20_000, pollMs: 1000, heartbeatMs: 20 });
  try {
    const [name] = tickets(root);
    const path = join(root, "build-slot-queue", name);
    const then = new Date(Date.now() - 45 * 60_000);
    utimesSync(path, then, then);
    await waitFor(() => Date.now() - statSync(path).mtimeMs < 60_000, "heartbeat must refresh a waiting ticket");
    assert.deepEqual(tickets(root), [name]);
  } finally {
    holder.release();
    const slot = await pending;
    slot.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead waiter's fresh ticket is removed before the next waiter acquires", async (t) => {
  const { root, start, message } = queueHarness(t);
  const holder = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
  t.after(() => holder.release());
  const dead = start("dead");
  await message(dead, "waiting");
  const [ticket] = tickets(root);
  dead.kill("SIGKILL");
  await waitFor(() => dead.closed, "dead waiter must exit");
  assert.equal(existsSync(join(root, "build-slot-queue", ticket)), true);
  const next = start("next");
  await message(next, "waiting");
  assert.equal(existsSync(join(root, "build-slot-queue", ticket)), false);
  holder.release();
  await message(next, "acquired");
  assert.deepEqual(tickets(root), []);
  assert.match(readFileSync(join(root, "events.log"), "utf8"), /reclaimed build-slot ticket/);
  next.send("release");
});

test("waiting cancellation and exit remove tickets and preserve cooperative status", async (t) => {
  const { root, start, message } = queueHarness(t);
  const holder = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
  t.after(() => holder.release());
  for (const cooperativeCancellation of [false, true]) {
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
      const child = start(signal, { cooperativeCancellation });
      await message(child, "waiting");
      child.send(signal);
      await waitFor(() => child.closed, "cancelled waiter must exit");
      assert.equal(child.exitCode, code, child.stderrText);
      assert.deepEqual(tickets(root), []);
      assert.equal(existsSync(holder.dir), true);
      if (cooperativeCancellation) assert.ok(child.messages.some(item => item.type === "rejected"));
    }
  }
  const child = start("exit");
  await message(child, "waiting");
  child.send("exit");
  await waitFor(() => child.closed, "exiting waiter must close");
  assert.deepEqual(tickets(root), []);
});

test("queued build waiters fill every free slot without waiting for earlier holders", async (t) => {
  const { root, start, message, acquired } = queueHarness(t);
  const holders = [];
  for (let i = 0; i < 4; i += 1) holders.push(await acquireBuildSlot({ root, slots: 4, waitMs: 0 }));
  t.after(() => holders.forEach(holder => holder.release()));
  const waiters = [];
  for (let id = 1; id <= 4; id += 1) {
    const child = start(id, { slots: 4 });
    waiters.push(child);
    await message(child, "waiting");
  }
  for (const holder of holders) holder.release();
  await waitFor(() => acquired.length === 4, "all four queued waiters must acquire together", 5000);
  assert.equal(new Set(waiters.map(child => child.messages.find(item => item.type === "acquired").name)).size, 4);
  assert.deepEqual(tickets(root), []);
  for (const child of waiters) child.send("release");
});

test("timing out removes the ticket", async () => {
  const root = slotRoot();
  const holder = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
  try {
    await assert.rejects(acquireBuildSlot({ root, slots: 1, waitMs: 0 }), /no build slot freed/);
    assert.deepEqual(tickets(root), []);
  } finally {
    holder.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a timeout names older waiters when free capacity is reserved", async () => {
  const root = slotRoot();
  try {
    plantTicket(root, 1, { pid: process.pid });
    await assert.rejects(acquireBuildSlot({ root, slots: 1, waitMs: 0 }), /queue position 2 behind older waiters; no current holder/);
    assert.equal(tickets(root).length, 1);
    assert.match(readFileSync(join(root, "events.log"), "utf8"), /denied:.*queue position 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release retries a ticket cleanup that failed during acquisition", () => {
  const root = slotRoot();
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";
      import { acquireBuildSlot } from ${JSON.stringify(new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).href)};
      const root = process.argv[1];
      const remove = fs.rmSync;
      let failed = false;
      fs.rmSync = (path, options) => {
        if (!failed && path.includes("build-slot-queue") && path.endsWith(".json")) {
          failed = true;
          throw Object.assign(new Error("transient deletion failure"), { code: "EACCES" });
        }
        return remove(path, options);
      };
      syncBuiltinESMExports();
      const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
      assert.equal(failed, true);
      assert.equal(fs.readdirSync(join(root, "build-slot-queue")).length, 1);
      slot.release();
      assert.deepEqual(fs.readdirSync(join(root, "build-slot-queue")), []);
      assert.equal(fs.existsSync(slot.dir), false);
    `, root], { encoding: "utf8", timeout: 20_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transient ticket reclaim failure does not reject another waiter's acquisition", () => {
  const root = slotRoot();
  try {
    const path = plantTicket(root, 1, { pid: deadPid() });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";
      import { acquireBuildSlot } from ${JSON.stringify(new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).href)};
      const root = process.argv[1];
      const oldTicket = process.argv[2];
      const remove = fs.rmSync;
      let failed = false;
      fs.rmSync = (path, options) => {
        if (!failed && path === oldTicket) {
          failed = true;
          throw Object.assign(new Error("transient deletion failure"), { code: "EBUSY" });
        }
        return remove(path, options);
      };
      syncBuiltinESMExports();
      const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 20_000, pollMs: 20 });
      assert.equal(failed, true);
      assert.equal(fs.existsSync(oldTicket), false);
      assert.match(fs.readFileSync(join(root, "events.log"), "utf8"), /ticket reclaim failed:.*EBUSY/);
      slot.release();
    `, root, path], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a PR gate holds the one verification slot beside the cargo lanes", async () => {
  const root = slotRoot();
  try {
    assert.equal(acquireVerificationSlot({ CI: "1" }), null);
    const gate = await acquireVerificationSlot({ DOHC_BUILD_SLOT_ROOT: root });
    assert.equal(gate.name, "verification-slot-1");
    const lane = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
    assert.equal(lane.name, "build-slot-1");
    lane.release();
    gate.release();
    assert.equal(existsSync(join(root, "verification-slot-1")), false);

    plantSlot(root, 1, { pid: deadPid(), heartbeatAgeMs: 45 * 60_000, kind: "verification-slot" });
    const next = await acquireVerificationSlot({ DOHC_BUILD_SLOT_ROOT: root });
    assert.equal(next.name, "verification-slot-1");
    next.release();
    assert.match(readFileSync(join(root, "events.log"), "utf8"), /reclaimed verification-slot-1/);
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
    await waitFor(() => Date.now() - statSync(ownerPath).mtimeMs < 60_000, "heartbeat must refresh the owner file");
    assert.ok(
      Date.now() - statSync(ownerPath).mtimeMs < 60_000,
      "an interval tick must restore the heartbeat",
    );
    slot.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
