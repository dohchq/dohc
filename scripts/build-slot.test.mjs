// The build-slot budget, exercised against a private slot root.
//
// The contract under test is the machine's build budget: four slots,
// atomic directory acquisition, owner-safe reclamation (stale heartbeat AND
// an owner that is gone: a dead pid or a pid that now names another process,
// never either alone), and a denial that names the constraint. The
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
import { fileURLToPath } from "node:url";
import {
  acquireBuildSlot,
  admissionSlot,
  acquireExclusiveSlot,
  acquireVerificationSlot,
  buildQueueStatus,
  capBuildParallelism,
  reclaimStaleSlots,
  resolveBuildBudget,
  processCreation,
  verificationLanes,
} from "../tools/rust-engine-program/build-slot.mjs";
import { pauseQueue, resumeQueue } from "./verification/queue.mjs";

const buildSlotUrl = new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).href;

const slotRoot = () => mkdtempSync(join(tmpdir(), "dohc-build-slot-"));
// The lane guard admits only this checkout's PR verifier as the entry script.
const verifier = fileURLToPath(new URL("../scripts/verification/verify.mjs", import.meta.url));
const verifierLane = (env, options) => acquireVerificationSlot(env, { entry: verifier, ...options });

test("exclusive local ownership rejects live owners without creating a queue", t => {
  const root = slotRoot();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const options = {root, kind: "checkout", metadata: {purpose: "PR verification", checkout: "fixture-checkout", commit: "fixture-sha"}};
  const owner = acquireExclusiveSlot(options);
  t.after(() => owner.release());
  assert.throws(() => acquireExclusiveSlot(options), new RegExp(`pid ${process.pid}.*PR verification.*fixture-checkout.*fixture-sha`));
  assert.equal(existsSync(join(root, "checkout-queue")), false);
  owner.release();
  const next = acquireExclusiveSlot(options);
  next.release();
});

test("exclusive local ownership recovers a dead PID but protects incomplete claims", t => {
  const root = slotRoot();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const dir = join(root, "checkout-1");
  mkdirSync(dir);
  assert.throws(() => acquireExclusiveSlot({root, kind: "checkout"}), /Another run owns/);
  writeFileSync(join(dir, "owner.json"), JSON.stringify({pid: deadPid(), start: new Date().toISOString()}));
  const owner = acquireExclusiveSlot({root, kind: "checkout"});
  owner.release();
  assert.equal(existsSync(dir), false);
});

function queueProbe(root, script, timeout = 5000) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import timers from "node:timers/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    import { acquireBuildSlot } from ${JSON.stringify(new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).href)};
    const root = process.argv[1];
    ${script}
  `, root], { encoding: "utf8", timeout });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr);
}

test("transient sweep and ticket-read errors retry without ending the wait", () => {
  const root = slotRoot();
  try {
    // One process runs every case, since each new process started Node and a
    // PowerShell identity lookup. The 20 s waits and the 120 s process bound only
    // stop a hang: a busy host can spend over a second on the file work before a retry.
    queueProbe(root, `
      for (const code of ["EPERM", "EBUSY", "EACCES", "ENOENT"]) {
        for (const operation of ["lock", "queue", "ticket"]) {
          // Antivirus can fail a first claim for a moment, so the holder retries too.
          const holder = await acquireBuildSlot({ root, slots: 1, waitMs: 20_000, pollMs: 1 });
          const method = operation === "lock" ? "mkdirSync" : operation === "queue" ? "readdirSync" : "readFileSync";
          const original = fs[method];
          let failed = false;
          fs[method] = (path, ...args) => {
            const target = operation === "lock" ? path === join(root, "reclaim.lock")
              : operation === "queue" ? path === join(root, "build-slot-queue")
              : path.includes("build-slot-queue") && path.endsWith(".json");
            if (!failed && target) {
              failed = true;
              holder.release();
              throw Object.assign(new Error("busy file"), { code });
            }
            return original(path, ...args);
          };
          syncBuiltinESMExports();
          try {
            const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 20_000, pollMs: 1 });
            assert.equal(failed, true, code + " " + operation);
            slot.release();
          } finally {
            // A failed case must not leave its stand-in for the next one.
            fs[method] = original;
            syncBuiltinESMExports();
          }
        }
      }
    `, 120_000);
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
      import { readFileSync } from "node:fs";
      import { acquireBuildSlot, acquireVerificationSlot } from ${JSON.stringify(new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).href)};
      let slot;
      process.on("message", command => {
        if (command === "release") { slot.release(); process.exit(0); }
        else if (command === "exit") process.exit(0);
        else process.emit(command);
      });
      console.log = message => process.send({ type: "waiting", message });
      const { observe, pausedQueue, ...options } = JSON.parse(process.argv[2]);
      if (observe) options.observeTicket = ticket => { process.send({ type: "observed", ...ticket, text: readFileSync(ticket.path, "utf8") }); };
      if (pausedQueue) {
        // The hold an inline PR gate uses, reporting each look at the queue.
        const hold = (await import(${JSON.stringify(new URL("./verification/queue.mjs", import.meta.url).href)})).pauseHold(pausedQueue);
        options.hold = () => { const held = hold(); process.send({ type: "checked", held: Boolean(held) }); return held; };
      }
      try {
        slot = await (${JSON.stringify(kind)} !== "build-slot"
          ? acquireVerificationSlot({ DOHC_BUILD_SLOT_ROOT: process.argv[1] }, { entry: ${JSON.stringify(verifier)}, ...options })
          : acquireBuildSlot({ root: process.argv[1], slots: 1, waitMs: 20_000, pollMs: 60_000, ...options }));
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

function plantTicket(root, order, { pid, heartbeatAgeMs = 0, heartbeatMs, kind = "build-slot", slots }) {
  const dir = join(root, `${kind}-queue`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${String(order).padStart(24, "0")}-${pid}.json`);
  writeFileSync(path, JSON.stringify({ pid, start: new Date().toISOString(), heartbeatMs, slots }));
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

test("inherited compiler and test settings cannot exceed a lane's budget", () => {
  const source = {CARGO_BUILD_JOBS: "64", RUST_TEST_THREADS: "2", NEXTEST_TEST_THREADS: "num-cpus", OTHER: "keep"};
  assert.deepEqual(capBuildParallelism(source, 8), {CARGO_BUILD_JOBS: "8", RUST_TEST_THREADS: "2", NEXTEST_TEST_THREADS: "8", OTHER: "keep"});
  assert.equal(source.CARGO_BUILD_JOBS, "64");
  assert.equal(capBuildParallelism({RUST_TEST_THREADS: "2"}, 8).NEXTEST_TEST_THREADS, "2");
  const capped = capBuildParallelism({cargo_build_jobs: "2", CARGO_BUILD_JOBS: "99", RUST_TEST_THREADS: "-1"}, 4);
  assert.equal(capped.CARGO_BUILD_JOBS, "4");
  assert.equal(capped.cargo_build_jobs, undefined);
  assert.equal(capped.RUST_TEST_THREADS, "4");
  assert.throws(() => capBuildParallelism({}, 0), /positive integer/);
});

test("the lane count is one unless the slot root's setting says otherwise, up to four", async t => {
  const root = slotRoot();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const env = {DOHC_BUILD_SLOT_ROOT: root};
  assert.equal(verificationLanes(env), 1);
  for (const setting of ["0", "5", "12", "two"]) {
    writeFileSync(join(root, "verification-lanes"), setting);
    assert.throws(() => verificationLanes(env), /must contain a lane count from 1 to 4/);
  }
  writeFileSync(join(root, "verification-lanes"), "4");
  assert.equal(verificationLanes(env), 4);
  assert.throws(() => verificationLanes({...env, DOHC_VERIFICATION_SLOT_ROOT: root, DOHC_VERIFICATION_TRIAL: "1"}), /isolated/);
  writeFileSync(join(root, "verification-lanes"), "3\n");
  assert.equal(verificationLanes(env), 3);
  const lanes = [await verifierLane(env), await verifierLane(env), await verifierLane(env)];
  try {
    assert.equal(new Set(lanes.map(lane => lane.name)).size, 3);
    assert.equal(lanes[0].dir, join(root, lanes[0].name));
    await assert.rejects(verifierLane(env, {waitMs: 0}), /all 3 slots are held/);
  } finally { for (const lane of lanes) lane.release(); }
  // An isolated trial root has its own setting.
  const trial = join(root, "trial");
  mkdirSync(trial);
  const trialEnv = {...env, DOHC_VERIFICATION_SLOT_ROOT: trial, DOHC_VERIFICATION_TRIAL: "1"};
  assert.equal(verificationLanes(trialEnv), 1);
  const lease = await verifierLane(trialEnv);
  try { assert.equal(lease.dir, join(trial, lease.name)); } finally { lease.release(); }
});

test("older tickets claim first, and code with more slots takes the ones older code cannot use", () => {
  // One slot count for everyone: the ticket at position k takes the k-th free slot.
  assert.deepEqual([0, 1, 2].map(position => admissionSlot([2, 3], [4, 4, 4], position)), [2, 3, undefined]);
  // Older verifiers wait for slot 1 only, so a two-lane ticket behind them takes slot 2.
  assert.equal(admissionSlot([2], [1, 1, 2], 2), 2);
  assert.equal(admissionSlot([1, 2], [1, 1, 2], 1), undefined, "slot 1 is the first older ticket's");
  // A two-lane ticket ahead of an older one leaves it slot 1.
  assert.deepEqual([0, 1].map(position => admissionSlot([1, 2], [2, 1], position)), [2, 1]);
  assert.equal(admissionSlot([1, 2], [0, 2], 1), 1, "a ticket gone since the listing claims nothing");
});

test("an older verifier waiting for slot 1 does not hold back a free second lane", async t => {
  const root = slotRoot();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  writeFileSync(join(root, "verification-lanes"), "2");
  const env = {DOHC_BUILD_SLOT_ROOT: root};
  const first = await verifierLane(env);
  try {
    assert.equal(first.name, "verification-slot-1");
    // A waiting verifier from before the lane setting records no slot count.
    plantTicket(root, 1, {pid: process.pid, kind: "verification-slot"});
    const second = await verifierLane(env, {waitMs: 5000});
    try { assert.equal(second.name, "verification-slot-2"); } finally { second.release(); }
  } finally { first.release(); }
});

test("a lowered lane count admits nothing until the runs in flight fall under it, even for a run already waiting", async t => {
  const root = slotRoot();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const env = {DOHC_BUILD_SLOT_ROOT: root};
  const setting = count => writeFileSync(join(root, "verification-lanes"), String(count));
  setting(3);
  const [first, second, third] = [await verifierLane(env), await verifierLane(env), await verifierLane(env)];
  first.release();
  second.release();
  // Slot 3 still runs, so a count of 1 is already met even though slots 1 and 2 are free.
  setting(1);
  await assert.rejects(verifierLane(env, {waitMs: 0}), /no verification slot freed/);
  setting(2);
  const fourth = await verifierLane(env, {waitMs: 0});
  // A run that started waiting under 2 stops admitting once the count drops to 1.
  const waiting = verifierLane(env, {waitMs: 3000});
  setting(1);
  fourth.release();
  await assert.rejects(waiting, /no verification slot freed/);
  third.release();
  const last = await verifierLane(env, {waitMs: 3000});
  last.release();
});

test("a caller that tracks the lane count, such as the queue service, also stops admitting when it drops", async t => {
  const root = slotRoot();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const env = {DOHC_BUILD_SLOT_ROOT: root};
  let count = 2;
  const lanes = () => count;
  const [first, second] = [await verifierLane(env, {lanes}), await verifierLane(env, {lanes})];
  const waiting = verifierLane(env, {lanes, waitMs: 3000});
  count = 1;
  second.release();
  await assert.rejects(waiting, /no verification slot freed/);
  first.release();
  const next = await verifierLane(env, {lanes, waitMs: 3000});
  next.release();
});

test("queue status retains claim identity and estimates only from completed lane history", async t => {
  const root = slotRoot();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const metadata = {purpose: "full PR verification", checkout: "C:\\work\\candidate", commit: "abc123", phase: "prepare"};
  const slot = await verifierLane({DOHC_BUILD_SLOT_ROOT: root}, {metadata});
  try {
    const original = readFileSync(join(slot.dir, "owner.json"), "utf8");
    const ticket = plantTicket(root, 1, {pid: process.pid, kind: "verification-slot"});
    let status = buildQueueStatus({root, slots: 1, kind: "verification-slot", ticketName: ticket.split(/[\\/]/u).at(-1)});
    assert.equal(status.estimate.waitMs, null);
    assert.equal(status.owners[0].phase, "prepare");
    assert.equal(status.owners[0].checkout, metadata.checkout);
    assert.equal(status.waiters[0].purpose, "unknown");
    slot.update({phase: "typecheck"});
    assert.equal(readFileSync(join(slot.dir, "owner.json"), "utf8"), original);
    const owner = JSON.parse(original);
    writeFileSync(join(root, "admission-history.jsonl"), [1000, 2000, 3000].map(elapsedMs => JSON.stringify({event: "release", kind: "verification-slot", elapsedMs})).join("\n") + "\n");
    status = buildQueueStatus({root, slots: 1, kind: "verification-slot", ticketName: ticket.split(/[\\/]/u).at(-1), now: Date.parse(owner.start) + 500});
    assert.deepEqual(status.estimate, {waitMs: 1500, serviceMs: 2000, samples: 3});
    assert.equal(status.owners[0].phase, "typecheck");
  } finally { slot.release(); }
  assert.equal(existsSync(slot.dir), false);
  assert.match(readFileSync(join(root, "admission-history.jsonl"), "utf8"), /"event":"release"/u);
});

test("status CLI reads absent queues without creating or acquiring anything", t => {
  const root = slotRoot();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const absent = join(root, "absent");
  const result = spawnSync(process.execPath, [new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).pathname.replace(/^\/(\w:)/u, "$1"), "--status", "--root", absent], {encoding: "utf8", timeout: 5000});
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.deepEqual(status.lanes.map(lane => lane.kind), ["build-slot", "verification-slot"]);
  assert.ok(status.lanes.every(lane => !lane.owners.length && !lane.queued));
  assert.equal(existsSync(absent), false);
});

test("a hold that throws after its slot was created gives the slot back", async () => {
  const root = slotRoot();
  try {
    // The first look admits; the look after the claim throws, as a deadline that passes in between does.
    let looks = 0;
    const hold = () => { looks += 1; if (looks > 1) throw new Error("the deadline passed"); return null; };
    await assert.rejects(acquireBuildSlot({ root, slots: 1, waitMs: 5000, pollMs: 1, hold }), /the deadline passed/);
    assert.equal(looks, 2);
    assert.deepEqual(readdirSync(root).filter(name => /^build-slot-\d$/u.test(name)), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("status CLI reports the Linux slot only on a host that runs Linux jobs", t => {
  const root = slotRoot();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const status = () => {
    const result = spawnSync(process.execPath, [new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).pathname.replace(/^\/(\w:)/u, "$1"), "--status", "--root", root], {encoding: "utf8", timeout: 5000});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).lanes.map(lane => lane.kind);
  };
  assert.deepEqual(status(), ["build-slot", "verification-slot"]);
  writeFileSync(join(root, "verification-linux"), "Ubuntu");
  assert.deepEqual(status(), ["build-slot", "verification-slot", "linux-slot"]);
  assert.deepEqual(readdirSync(root), ["verification-linux"]);
});

test("status CLI reports invalid configuration and shows a lane held above the setting", t => {
  const root = slotRoot();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const second = join(root, "verification-slot-3");
  mkdirSync(second);
  const owner = JSON.stringify({pid: process.pid, start: new Date().toISOString()});
  writeFileSync(join(second, "owner.json"), owner);
  const result = spawnSync(process.execPath, [new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).pathname.replace(/^\/(\w:)/u, "$1"), "--status"],
    {encoding: "utf8", timeout: 5000, env: {...process.env, DOHC_BUILD_SLOT_ROOT: root,
      DOHC_VERIFICATION_SLOT_ROOT: root, DOHC_VERIFICATION_TRIAL: ""}});
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.verificationSlots, null);
  assert.match(status.verificationConfigurationError, /isolated/);
  assert.equal(status.lanes.find(lane => lane.kind === "verification-slot").owners[0].name, "verification-slot-3");
  assert.equal(readFileSync(join(second, "owner.json"), "utf8"), owner);
  assert.equal(existsSync(join(root, "verification-slot-1")), false);
  assert.equal(existsSync(join(root, "verification-slot-queue")), false);
});

test("status CLI reports configured empty trial capacity without acquiring a lane", t => {
  const root = slotRoot();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const trial = join(root, "trial");
  mkdirSync(trial);
  writeFileSync(join(trial, "verification-lanes"), "2");
  const result = spawnSync(process.execPath, [new URL("../tools/rust-engine-program/build-slot.mjs", import.meta.url).pathname.replace(/^\/(\w:)/u, "$1"), "--status"],
    {encoding: "utf8", timeout: 5000, env: {...process.env, DOHC_BUILD_SLOT_ROOT: root,
      DOHC_VERIFICATION_SLOT_ROOT: trial, DOHC_VERIFICATION_TRIAL: "1"}});
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.verificationSlots, 2);
  assert.equal(status.verificationConfigurationError, null);
  assert.equal(status.lanes.find(lane => lane.kind === "verification-slot").slots, 2);
  assert.deepEqual(readdirSync(trial), ["verification-lanes"]);
});

test("a verification ticket observer reads the published ticket before any lane exists", async () => {
  const root = slotRoot();
  const observed = [];
  try {
    const slot = await verifierLane({DOHC_BUILD_SLOT_ROOT: root}, {metadata: {purpose: "full PR verification"}, observeTicket: ticket => {
      observed.push({...ticket, text: readFileSync(ticket.path, "utf8"), laneExists: existsSync(join(root, "verification-slot-1"))});
    }});
    slot.release();
    assert.equal(slot.name, "verification-slot-1");
    assert.equal(observed.length, 1);
    const [ticket] = observed;
    assert.deepEqual({root: ticket.root, kind: ticket.kind, path: ticket.path, laneExists: ticket.laneExists},
      {root, kind: "verification-slot", path: join(root, "verification-slot-queue", ticket.name), laneExists: false});
    assert.deepEqual([JSON.parse(ticket.text).pid, JSON.parse(ticket.text).purpose], [process.pid, "full PR verification"]);
    assert.equal(existsSync(ticket.path), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("ticket observer failures reject before admission without retry and stop the ticket's heartbeat", () => {
  for (const fault of ["missing", "promise", "removal", "then-call", "then-getter"]) {
    const root = slotRoot();
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        import { join } from "node:path";
        const [root, fault] = process.argv.slice(1);
        const intervals = new Set();
        const setInterval = globalThis.setInterval;
        const clearInterval = globalThis.clearInterval;
        globalThis.setInterval = (...args) => { const handle = setInterval(...args); intervals.add(handle); return handle; };
        globalThis.clearInterval = handle => { intervals.delete(handle); return clearInterval(handle); };
        const remove = fs.rmSync;
        fs.rmSync = (path, options) => {
          if (fault === "removal" && path.includes("verification-slot-queue") && path.endsWith(".json")) {
            throw Object.assign(new Error("fixture deletion failure"), { code: "EACCES" });
          }
          return remove(path, options);
        };
        syncBuiltinESMExports();
        const { acquireVerificationSlot, TicketEvidenceError } = await import(${JSON.stringify(buildSlotUrl)});
        const events = ["exit", "SIGINT", "SIGTERM"];
        const before = events.map(event => process.listeners(event));
        let calls = 0;
        let published;
        const error = await acquireVerificationSlot({ DOHC_BUILD_SLOT_ROOT: root }, { entry: ${JSON.stringify(verifier)}, observeTicket: ({ path }) => {
          calls += 1;
          published = path;
          if (fault === "promise") return Promise.reject(new Error("fixture deferred capture"));
          const busy = () => { throw Object.assign(new Error("fixture completion check failed"), { code: "EBUSY" }); };
          if (fault === "then-call") return { then: busy };
          if (fault === "then-getter") return Object.defineProperty({}, "then", { get: busy });
          throw Object.assign(new Error("fixture ticket read failed"), { code: "ENOENT" });
        } }).then(() => null, error => error);
        const thenable = fault.startsWith("then-");
        assert.ok(error instanceof TicketEvidenceError, String(error));
        assert.match(error.message, fault === "promise" ? /must finish synchronously/ : thenable ? /fixture completion check failed/ : /fixture ticket read failed/);
        if (fault !== "promise") assert.equal(error.cause.code, thenable ? "EBUSY" : "ENOENT");
        assert.equal(calls, 1);
        assert.equal(fs.existsSync(join(root, "verification-slot-1")), false);
        assert.equal(intervals.size, 0);
        assert.deepEqual(events.map(event => process.listeners(event)), before);
        assert.equal(fs.existsSync(published), fault === "removal");
        if (fault === "removal") assert.match(fs.readFileSync(join(root, "events.log"), "utf8"), /ticket cleanup failed/);
      `, root, fault], { encoding: "utf8", timeout: 20_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `${fault}: ${result.stderr}`);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

test("each replacement verification ticket is observed separately", async () => {
  const root = slotRoot();
  const holder = await verifierLane({DOHC_BUILD_SLOT_ROOT: root});
  const observed = [];
  const pending = verifierLane({DOHC_BUILD_SLOT_ROOT: root}, {waitMs: 20_000,
    observeTicket: ticket => observed.push({...ticket, text: readFileSync(ticket.path, "utf8")})});
  try {
    await waitFor(() => observed.length === 1, "the first ticket must be observed");
    rmSync(observed[0].path);
    await waitFor(() => observed.length === 2, "the replacement ticket must be observed");
    assert.notEqual(observed[1].name, observed[0].name);
    assert.deepEqual(tickets(root, "verification-slot"), [observed[1].name]);
    assert.ok(observed.every(ticket => JSON.parse(ticket.text).pid === process.pid));
  } finally {
    holder.release();
    (await pending).release();
    rmSync(root, {recursive: true, force: true});
  }
  assert.equal(observed.length, 2);
});

test("observed verification waiters keep FIFO order, lane counts, and cancellation", async t => {
  const {root, start, message, acquired} = queueHarness(t);
  const holder = await verifierLane({DOHC_BUILD_SLOT_ROOT: root});
  t.after(() => holder.release());
  const waiters = [];
  for (let id = 1; id <= 2; id += 1) {
    const child = start(id, {kind: "verification-slot", observe: true});
    waiters.push(child);
    await message(child, "waiting");
    const observed = child.messages.findIndex(item => item.type === "observed");
    assert.ok(observed >= 0 && observed < child.messages.findIndex(item => item.type === "waiting"), "observation must precede admission");
    assert.equal(child.messages[observed].kind, "verification-slot");
    assert.equal(JSON.parse(child.messages[observed].text).pid, child.pid);
    assert.equal(tickets(root, "verification-slot").at(-1), child.messages[observed].name);
  }
  const cancelled = start("cancelled", {kind: "verification-slot", observe: true});
  await message(cancelled, "waiting");
  cancelled.send("SIGINT");
  await waitFor(() => cancelled.closed, "cancelled observed waiter must exit");
  assert.equal(cancelled.exitCode, 130);
  assert.equal(tickets(root, "verification-slot").length, 2);
  holder.release();
  for (let id = 1; id <= 2; id += 1) {
    await waitFor(() => acquired.length >= id, "released slot must hand off in FIFO order", 5000);
    assert.deepEqual(acquired, Array.from({length: id}, (_, index) => index + 1));
    waiters[id - 1].send("release");
    await waitFor(() => waiters[id - 1].closed, "released waiter must exit");
  }
});

test("an inline gate takes no lane while the queue is paused, says so once, and continues after resume", async t => {
  const { root, start, message, acquired } = queueHarness(t);
  const queue = mkdtempSync(join(tmpdir(), "dohc-queue-pause-"));
  t.after(() => rmSync(queue, { recursive: true, force: true }));
  await pauseQueue(queue, { reason: "the computer restarted" });
  const looks = child => child.messages.filter(item => item.type === "checked" && item.held).length;
  const cancelled = start("cancelled", { kind: "verification-slot", pausedQueue: queue });
  const waiting = start("waiting", { kind: "verification-slot", pausedQueue: queue });
  // A waiter that looked three times waited between its looks.
  await waitFor(() => looks(waiting) >= 3 && looks(cancelled) >= 1, "held waiters must keep looking");
  assert.equal(existsSync(join(root, "verification-slot-1")), false, "a held waiter takes no lane");
  assert.deepEqual(tickets(root, "verification-slot"), [], "nor a ticket, so it reserves none");
  const said = waiting.messages.filter(item => item.type === "waiting");
  assert.equal(said.length, 1, "the pause is said once");
  assert.match(said[0].message, /the verification queue is paused since \S+ \(the computer restarted\); this gate starts after pnpm verify:queue resume$/u);
  // Ctrl+C stops a held wait like any other.
  cancelled.send("SIGINT");
  await waitFor(() => cancelled.closed, "a cancelled held waiter must exit");
  assert.equal(cancelled.exitCode, 130, cancelled.stderrText);
  assert.ok(cancelled.messages.some(item => item.type === "rejected"));
  await resumeQueue(queue);
  await message(waiting, "acquired");
  assert.deepEqual(acquired, ["waiting"]);
  waiting.send("release");
  await waitFor(() => waiting.closed, "released waiter must exit");
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

test("only this checkout's PR verifier can take a verification lane", async t => {
  const root = slotRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { DOHC_BUILD_SLOT_ROOT: root };
  assert.throws(() => acquireVerificationSlot(env), /Only the PR verifier/);
  for (const entry of ["", join(root, "run-admitted-host.mjs"), join(root, "scripts/verification/verify.mjs")]) {
    assert.throws(() => acquireVerificationSlot(env, { entry }), /Only the PR verifier/);
  }
  assert.deepEqual(readdirSync(root), []);
  const lane = await verifierLane(env);
  assert.equal(lane.name, "verification-slot-1");
  lane.release();
});

test("three verification waiters acquire in FIFO order with prompt handoff", async (t) => {
  const { root, start, message, acquired } = queueHarness(t);
  const holder = await verifierLane({ DOHC_BUILD_SLOT_ROOT: root });
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

test("a waiter's own sweep keeps its ticket when a busy host delays the heartbeat", () => {
  const root = slotRoot();
  try {
    queueProbe(root, `
      // Block the event loop past three 20 ms ticket heartbeats before the sweep.
      const mkdir = fs.mkdirSync;
      fs.mkdirSync = (path, ...args) => {
        if (path === join(root, "reclaim.lock")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        return mkdir(path, ...args);
      };
      syncBuiltinESMExports();
      const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 0, heartbeatMs: 20 });
      slot.release();
    `);
  } finally {
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
    assert.equal(verifierLane({ CI: "1" }), null);
    const gate = await verifierLane({ DOHC_BUILD_SLOT_ROOT: root });
    assert.equal(gate.name, "verification-slot-1");
    const lane = await acquireBuildSlot({ root, slots: 1, waitMs: 0 });
    assert.equal(lane.name, "build-slot-1");
    lane.release();
    gate.release();
    assert.equal(existsSync(join(root, "verification-slot-1")), false);

    plantSlot(root, 1, { pid: deadPid(), heartbeatAgeMs: 45 * 60_000, kind: "verification-slot" });
    const next = await verifierLane({ DOHC_BUILD_SLOT_ROOT: root });
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

function plantOwner(root, i, owner, heartbeatAgeMs, kind = "build-slot") {
  const dir = join(root, `${kind}-${i}`);
  mkdirSync(dir, { recursive: true });
  const ownerPath = join(dir, "owner.json");
  writeFileSync(ownerPath, JSON.stringify({ start: new Date().toISOString(), ...owner }));
  const then = new Date(Date.now() - heartbeatAgeMs);
  utimesSync(ownerPath, then, then);
  return dir;
}

test("a dead owner frees its slot after two missed heartbeats, not the whole stale window", () => {
  const root = slotRoot();
  try {
    plantOwner(root, 1, { pid: deadPid() }, 60_000);
    plantOwner(root, 2, { pid: deadPid() }, 3 * 60_000);
    assert.equal(reclaimStaleSlots({ root, slots: 2, staleMs: 30 * 60_000 }), 1);
    assert.equal(existsSync(join(root, "build-slot-1")), true, "one missed heartbeat is not enough");
    assert.equal(existsSync(join(root, "build-slot-2")), false);
    assert.match(readFileSync(join(root, "events.log"), "utf8"), /reclaimed build-slot-2: pid \d+ dead, heartbeat 3 min stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pid now owned by another process frees the slot; the claimer's own identity keeps it", () => {
  const root = slotRoot();
  try {
    const owner = { pid: process.pid, created: "reuse-test-claimer" };
    plantOwner(root, 1, owner, 3 * 60_000);
    assert.equal(reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000, identify: () => null }), 0,
      "an unknown identity proves nothing");
    assert.equal(reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000, identify: () => "later process" }), 1);
    assert.equal(existsSync(join(root, "build-slot-1")), false);
    assert.match(readFileSync(join(root, "events.log"), "utf8"), /reclaimed build-slot-1: pid \d+ reused \(claimed by process created reuse-test-claimer, now later process\)/);
    plantOwner(root, 1, owner, 3 * 60_000);
    assert.equal(reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000, identify: () => owner.created }), 0,
      "a silent owner that is still the claiming process keeps its slot");
    // A confirmed match is remembered for five minutes. It can delay a reclaim, never cause one.
    assert.equal(reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000, identify: () => "later process" }), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh heartbeat outweighs any identity answer, even for exclusive slots", () => {
  const root = slotRoot();
  try {
    plantOwner(root, 1, { pid: process.pid, created: "fresh-test-claimer" }, 0, "checkout");
    plantOwner(root, 1, { pid: process.pid, created: "fresh-test-claimer" }, 90_000);
    let probes = 0;
    const identify = () => { probes += 1; return "other"; };
    assert.equal(reclaimStaleSlots({ root, slots: 1, kind: "checkout", staleMs: -1, identify }), 0);
    assert.equal(reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000, identify }), 0);
    assert.equal(probes, 0, "no lookup runs before two heartbeats are missed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cargo lane keeps its long grace for a dead holder; the verification lane frees in minutes", async () => {
  const root = slotRoot();
  try {
    plantSlot(root, 1, { pid: deadPid(), heartbeatAgeMs: 3 * 60_000 });
    await assert.rejects(acquireBuildSlot({ root, slots: 1, waitMs: 0 }), /all 1 slots are held/);
    plantSlot(root, 1, { pid: deadPid(), heartbeatAgeMs: 3 * 60_000, kind: "verification-slot" });
    // Only the PR verifier may hold the lane once that guard is on main; naming it as the entry works either way.
    const lane = await acquireVerificationSlot({ DOHC_BUILD_SLOT_ROOT: root }, { entry: new URL("./verification/verify.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1") });
    assert.equal(lane.name, "verification-slot-1");
    lane.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an owner record without an identity is never judged reused", () => {
  const root = slotRoot();
  try {
    plantOwner(root, 1, { pid: process.pid }, 45 * 60_000);
    plantOwner(root, 2, { pid: process.pid, created: null }, 45 * 60_000);
    let probes = 0;
    assert.equal(reclaimStaleSlots({ root, slots: 2, staleMs: 30 * 60_000, identify: () => { probes += 1; return "other"; } }), 0);
    assert.equal(probes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a heartbeat during the identity probe cancels the reclaim", () => {
  const root = slotRoot();
  try {
    const dir = plantOwner(root, 1, { pid: process.pid, created: "probe-heartbeat-claimer" }, 3 * 60_000);
    const identify = () => {
      const now = new Date();
      utimesSync(join(dir, "owner.json"), now, now);
      return "later process";
    };
    assert.equal(reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000, identify }), 0);
    assert.equal(existsSync(join(dir, "owner.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [when, successorOwner] of [["after it wrote its owner", "successor"], ["before it wrote its owner", null]]) {
  test(`a sweep that lost its lock stops and leaves a successor's lock taken ${when}`, () => {
    const root = slotRoot();
    try {
      plantOwner(root, 1, { pid: process.pid, created: "lost-lock-claimer" }, 3 * 60_000);
      const lock = join(root, "reclaim.lock");
      const identify = () => {
        // A successor takes the lock over while this sweep is suspended in its probe.
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        if (successorOwner) writeFileSync(join(lock, "owner"), successorOwner);
        return "later process";
      };
      assert.equal(reclaimStaleSlots({ root, slots: 1, staleMs: 30 * 60_000, identify }), 0);
      assert.equal(existsSync(join(root, "build-slot-1")), true);
      assert.deepEqual(readdirSync(lock), successorOwner ? ["owner"] : []);
      if (successorOwner) assert.equal(readFileSync(join(lock, "owner"), "utf8"), successorOwner);
      assert.deepEqual(readdirSync(root).filter(name => name.startsWith("reclaim.lock.")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a sweeper that resumes after a takeover finds the lock owned and backs off", () => {
  const root = slotRoot();
  try {
    plantSlot(root, 1, { pid: deadPid(), heartbeatAgeMs: 3 * 60_000, kind: "verification-slot" });
    // The sweeper creates the lock, then a successor takes it over before the sweeper writes its owner file.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      import { join } from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      import { reclaimStaleSlots } from ${JSON.stringify(buildSlotUrl)};
      const root = process.argv[1];
      const lock = join(root, "reclaim.lock");
      const mkdir = fs.mkdirSync;
      fs.mkdirSync = (path, ...args) => {
        const made = mkdir(path, ...args);
        if (path === lock) {
          fs.rmSync(lock, { recursive: true, force: true });
          mkdir(lock);
          fs.writeFileSync(join(lock, "owner"), "successor");
        }
        return made;
      };
      syncBuiltinESMExports();
      console.log(reclaimStaleSlots({ root, slots: 1, kind: "verification-slot", staleMs: 30 * 60_000 }));
    `, root], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "0");
    assert.equal(readFileSync(join(root, "reclaim.lock", "owner"), "utf8"), "successor");
    assert.equal(existsSync(join(root, "verification-slot-1")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("process creation identity is stable for a live process and absent for a dead one", t => {
  const own = processCreation(process.pid);
  if (own === null) return t.skip(`no creation identity on ${process.platform}`);
  assert.equal(processCreation(process.pid), own);
  assert.equal(processCreation(deadPid()), null);
  assert.equal(processCreation(0), null);
});

test("a held slot adopts its process identity and still releases by identity", async t => {
  if (processCreation(process.pid) === null) return t.skip(`no creation identity on ${process.platform}`);
  const root = slotRoot();
  try {
    const slot = await acquireBuildSlot({ root, slots: 1, waitMs: 0, identityDelayMs: 0 });
    const ownerPath = join(slot.dir, "owner.json");
    await waitFor(() => typeof JSON.parse(readFileSync(ownerPath, "utf8")).created === "string",
      "the claim must record its process identity", 60_000);
    const owner = readFileSync(ownerPath, "utf8");
    assert.equal(JSON.parse(owner).created, processCreation(process.pid));
    assert.equal(JSON.parse(readFileSync(join(slot.dir, "status.json"), "utf8")).owner, owner);
    slot.release();
    assert.equal(existsSync(slot.dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
