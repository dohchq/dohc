// One lane's share of a shared build machine.
//
// Several agent lanes run cargo on one host. Unbounded, every cargo asks for
// every logical core — the resource that matters is concurrent rustc
// processes ACROSS lanes, not the lane count, and the machine has been
// OOM-crashed by five lanes at default jobs. So a lane takes one of a fixed
// set of slots before any cargo runs and caps its compiler and test
// parallelism to an even share of the cores while it holds it.
// Waiters publish heartbeat tickets in a queue per kind. Queue position
// reserves free capacity for older waiters, with handoff checks each second.
//
// A slot is a directory because directory creation is atomic. The owner
// heartbeats by touching its `owner.json`; reclamation requires a stale
// heartbeat and, when the owner is readable, a provably dead pid (see
// reclaimStaleSlots for the full rule), renames to a tombstone so the slot
// name is freed atomically, and is serialized through a sweep lock so two
// reclaimers cannot judge one slot together. Denials and reclaims are
// appended to `events.log` beside the slots — not to a tracked file, which a
// mid-run gate write would turn into a provenance failure.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { availableParallelism, platform } from "node:os";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The budget this host imposes, or null on a single-tenant host (CI runners
 * have no slot root and run uncapped). The root comes from
 * `DOHC_BUILD_SLOT_ROOT`, defaulting to `C:\w\_locks` on Windows outside CI —
 * the shared dev machine the budget exists for. Tests point the root at a private
 * directory so a suite run never holds a real lane's slot.
 */
export function resolveBuildBudget(env = process.env, host = {}) {
  const os = host.platform ?? platform();
  const ci = env.CI && !["false", "0"].includes(env.CI.toLowerCase());
  const root =
    env.DOHC_BUILD_SLOT_ROOT || (os === "win32" && !ci ? "C:\\w\\_locks" : null);
  if (!root) return null;
  const slots = 4;
  const cores = host.cores ?? availableParallelism();
  const floor = Number(env.DOHC_GATE_DISK_FLOOR_GB);
  return {
    root,
    slots,
    jobs: Math.max(1, Math.floor(cores / slots)),
    diskFloorGb: Number.isFinite(floor) ? floor : 40,
  };
}

/** Free space on `path`'s volume in GB, or null where it cannot be read. */
export function freeDiskGb(path) {
  try {
    const s = statfsSync(path);
    return (s.bsize * s.bavail) / 1024 ** 3;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM answers "exists, not yours" — alive.
    return error.code === "EPERM";
  }
}

function logEvent(root, line) {
  try {
    appendFileSync(join(root, "events.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The log is a record, not a gate: losing a line must not fail a build.
  }
}

function slotDir(root, i, kind) {
  return join(root, `${kind}-${i}`);
}

const defaultHeartbeatMs = 60_000;

function checkQueueAccess(root, kind) {
  for (const directory of [root, join(root, `${kind}-queue`)]) {
    try {
      readdirSync(directory);
    } catch (error) {
      if (directory !== root && error.code === "ENOENT") continue;
      throw error;
    }
    const probe = join(directory, `.access-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    if (directory === root) mkdirSync(probe);
    else writeFileSync(probe, "", { flag: "wx" });
    try {
      rmSync(probe, { recursive: true });
    } catch {
      logEvent(root, `access probe cleanup failed: ${probe}`);
    }
  }
}

function transientFilesystemError(error, root, kind) {
  if (!["EPERM", "EBUSY", "EACCES", "ENOENT"].includes(error.code)) return false;
  // Retry a busy child; unreadable or unwritable queue directories are faults.
  if (["EPERM", "EACCES"].includes(error.code)) checkQueueAccess(root, kind);
  return true;
}

/** The held slots, as `<kind>-N: pid P since T` lines. */
function holders(root, slots, kind) {
  const held = [];
  for (let i = 1; i <= slots; i += 1) {
    const dir = slotDir(root, i, kind);
    try {
      const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
      held.push(`${kind}-${i}: pid ${owner.pid} since ${owner.start}`);
    } catch {
      if (existsSync(dir)) held.push(`${kind}-${i}: owner unreadable`);
    }
  }
  return held.join("; ");
}

function withSweepLock(root, sweep) {
  const sweepLock = join(root, "reclaim.lock");
  try {
    mkdirSync(sweepLock);
  } catch (lockError) {
    if (lockError.code !== "EEXIST") throw lockError; // A fault, not contention.
    // A live sweeper's lock defers to it. A dead sweeper's is taken over by
    // whichever waiter wins the exclusive create of a claim file named for
    // the OBSERVED heartbeat and the current five-minute bucket — that
    // single O_EXCL create is the takeover's atomicity, on every platform.
    // Concurrent waiters derive the same claim name, so one create must
    // throw; the bucket makes a claim orphaned by a winner that died
    // mid-takeover expire instead of wedging reclamation forever; and the
    // winner re-checks the lock is still the object it statted before
    // removing it. Residual, accepted: a takeover suspended for minutes
    // between stat and claim can straddle buckets and still remove a
    // replacement lock — the cost is one transient extra sweeper over
    // already-tombstoned slots, not corruption, and closing it entirely
    // needs a lock manager this gate does not. Claim files accumulate one
    // empty file per dead sweeper per bucket — rare debris, never a hazard.
    let observedMtime;
    try {
      observedMtime = statSync(sweepLock).mtimeMs;
    } catch {
      return null; // The lock vanished: its sweeper just finished.
    }
    if (Date.now() - observedMtime < 5 * 60_000) return null;
    const bucket = Math.floor(Date.now() / (5 * 60_000));
    try {
      writeFileSync(
        `${sweepLock}.claim-${Math.round(observedMtime)}-${bucket}`,
        "",
        { flag: "wx" },
      );
    } catch (claimError) {
      if (claimError.code === "EEXIST") return null; // Lost the takeover.
      throw claimError;
    }
    try {
      if (statSync(sweepLock).mtimeMs !== observedMtime) return null;
    } catch {
      return null; // Vanished after the claim: nothing left to take over.
    }
    rmSync(sweepLock, { recursive: true, force: true });
    try {
      mkdirSync(sweepLock);
    } catch (retakeError) {
      if (retakeError.code === "EEXIST") return null; // Another sweeper owns it.
      throw retakeError;
    }
  }
  try {
    return sweep();
  } finally {
    rmSync(sweepLock, { recursive: true, force: true });
  }
}

/**
 * Reclaim dead slots. The owner file's mtime IS the heartbeat: a live owner
 * refreshes it every minute whatever its content, so a slot is a candidate
 * only when that heartbeat is more than `staleMs` old. A readable owner must
 * ALSO be provably dead — a wedged-but-alive lane stops heartbeating and
 * still owns its slot. A slot whose owner file is missing or unreadable for
 * that long has no working heartbeat by construction (a crash between mkdir
 * and the owner write, or a torn write) and is reclaimed too — refusing
 * those permanently eats a lane on every interrupted acquisition.
 *
 * Sweeps are serialized through a `reclaim.lock` directory: two concurrent
 * sweepers could otherwise both judge one slot dead, and the slower rename
 * would steal the directory the faster sweeper's waiter had already
 * re-claimed. The lock is held for milliseconds; one left by a dead sweeper
 * is removed after 5 minutes. Returns how many slots were freed.
 */
export function reclaimStaleSlots({ root, slots, staleMs, kind = "build-slot" }) {
  try {
    return withSweepLock(root, () => {
      reclaimStaleTickets({ root, kind });
      return reclaimSlots({ root, slots, kind, staleMs });
    }) ?? 0;
  } catch (error) {
    if (!transientFilesystemError(error, root, kind)) throw error;
    return 0;
  }
}

function reclaimSlots({ root, slots, staleMs, kind }) {
  let reclaimed = 0;
  for (let i = 1; i <= slots; i += 1) {
    const dir = slotDir(root, i, kind);
    const ownerPath = join(dir, "owner.json");
    let heartbeatAt;
    let why;
    try {
      heartbeatAt = statSync(ownerPath).mtimeMs;
    } catch {
      try {
        heartbeatAt = statSync(dir).mtimeMs;
        why = "no owner file";
      } catch {
        continue; // Slot is free.
      }
    }
    if (Date.now() - heartbeatAt <= staleMs) continue;
    let inspectedOwner = null;
    try {
      inspectedOwner = readFileSync(ownerPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT" && transientFilesystemError(error, root, kind)) continue;
      // A missing owner file is judged by `why` below.
    }
    if (why === undefined) {
      let pid;
      try {
        pid = JSON.parse(inspectedOwner).pid;
      } catch {
        pid = null;
      }
      if (pid === null) {
        why = "owner unreadable";
      } else if (!Number.isInteger(pid) || pid <= 0) {
        why = `owner pid invalid (${pid})`;
      } else if (pidAlive(pid)) {
        continue;
      } else {
        why = `pid ${pid} dead`;
      }
    }
    const tomb = `${dir}.tomb-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(dir, tomb);
    } catch {
      continue; // A racing owner touched it first; its slot, not ours.
    }
    // This sweep may have been suspended between its checks and that
    // rename while the slot was reclaimed and RE-CLAIMED by a live lane —
    // the rename moves whatever is at the path now. The tombstone still
    // holds the owner it actually moved; if that is not the owner this
    // sweep inspected, put it back.
    let movedOwner = null;
    try {
      movedOwner = readFileSync(join(tomb, "owner.json"), "utf8");
    } catch {
      // Both null when neither had an owner file: identical claims.
    }
    if (movedOwner !== inspectedOwner) {
      try {
        renameSync(tomb, dir);
      } catch {
        logEvent(
          root,
          `RECLAIM FAULT: ${kind}-${i} was renamed away from a new ` +
            `owner and could not be restored; its lane runs unaccounted ` +
            `(${tomb})`,
        );
      }
      continue;
    }
    try {
      rmSync(tomb, { recursive: true, force: true });
    } catch {
      // The rename already freed the slot name; the tombstone is debris.
    }
    logEvent(
      root,
      `reclaimed ${kind}-${i}: ${why}, heartbeat ` +
        `${Math.round((Date.now() - heartbeatAt) / 60_000)} min stale`,
    );
    reclaimed += 1;
  }
  return reclaimed;
}

function queueEntries(root, kind) {
  try {
    return readdirSync(join(root, `${kind}-queue`));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function queueTickets(root, kind) {
  return queueEntries(root, kind).filter((name) => name.endsWith(".json")).sort();
}

// Waiters have no running build to protect. A dead pid or stale heartbeat
// frees their place. Unreadable records get two heartbeats of grace; readable
// tickets expire after three, even if the OS reused their dead waiter's pid.
// Each record supplies its heartbeat interval. Temporary records get two
// heartbeats of grace, with the default interval for missing or torn records.
// The caller holds reclaim.lock.
function reclaimStaleTickets({ root, kind }) {
  for (const name of queueEntries(root, kind)) {
    const temporary = name.endsWith(".json.tmp");
    if (!temporary && !name.endsWith(".json")) continue;
    const path = join(root, `${kind}-queue`, name);
    try {
      const age = Date.now() - statSync(path).mtimeMs;
      let pid;
      let heartbeatMs = defaultHeartbeatMs;
      try {
        const record = JSON.parse(readFileSync(path, "utf8"));
        pid = record?.pid;
        if (Number.isFinite(record?.heartbeatMs) && record.heartbeatMs > 0) heartbeatMs = record.heartbeatMs;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // A torn ticket has no readable owner.
      }
      const readable = Number.isInteger(pid) && pid > 0;
      const stale = age > (readable && !temporary ? 3 : 2) * heartbeatMs;
      const dead = !temporary && readable && !pidAlive(pid);
      if (!dead && !stale) continue;
      rmSync(path, { force: true });
      logEvent(root, `reclaimed ${kind} ticket ${name}: ${dead ? `pid ${pid} dead` : "heartbeat stale"}`);
    } catch (error) {
      if (!transientFilesystemError(error, root, kind)) throw error;
      if (error.code !== "ENOENT") logEvent(root, `ticket reclaim failed: ${name}: ${error.code}`);
    }
  }
}

function createTicket(root, kind, heartbeatMs) {
  const queueDir = join(root, `${kind}-queue`);
  mkdirSync(queueDir, { recursive: true });
  // hrtime uses the host's monotonic clock, shared across its processes.
  const order = process.hrtime.bigint();
  const name = `${String(order).padStart(24, "0")}-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  const path = join(queueDir, name);
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, start: new Date().toISOString(), heartbeatMs }), { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      logEvent(root, `temporary ticket cleanup failed: ${name}`);
    }
  }
  const beat = setInterval(() => {
    try {
      const time = new Date();
      utimesSync(path, time, time);
    } catch {
      // Exit cleanup may have removed the ticket.
    }
  }, heartbeatMs);
  beat.unref();
  const remove = () => {
    clearInterval(beat);
    try {
      rmSync(path, { force: true });
    } catch {
      // A failed cleanup must not lose a newly acquired slot's release handle.
      // With its heartbeat stopped, this ticket expires on the next stale sweep.
      logEvent(root, `ticket cleanup failed: ${name}`);
    }
  };
  return { name, path, remove };
}

function claimSlot(dir, name, heartbeatMs, cooperativeCancellation, removeTicket) {
  const ownerPath = join(dir, "owner.json");
  const ownerRecord = JSON.stringify({
    pid: process.pid,
    start: new Date().toISOString(),
  });
  try {
    writeFileSync(ownerPath, ownerRecord);
  } catch (error) {
    // A slot without its owner file only frees after the 30-minute reclaim
    // window; give the name back now instead.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(ownerPath, now, now);
    } catch {
      // A missing owner.json here means the slot was tombstoned under us;
      // the next release() is a no-op either way.
    }
  }, heartbeatMs);
  beat.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    process.off("exit", release);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    removeTicket();
    try {
      // Release by identity, never by path: if this claim's own record is
      // no longer at the path — the slot was reclaimed out from under a
      // suspended holder and re-granted — deleting would take a live
      // lane's slot and re-free its name.
      if (readFileSync(ownerPath, "utf8") !== ownerRecord) return;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Unreadable means nothing of ours is left at the path. A slot that
      // cannot be removed is reclaimed by the next waiter once this
      // process is dead and the heartbeat goes stale.
    }
  };
  function interrupt(code) {
    if (cooperativeCancellation) {
      process.exitCode = code;
      return;
    }
    release();
    process.exit(code);
  }
  function onSigint() {
    interrupt(130);
  }
  function onSigterm() {
    interrupt(143);
  }
  process.once("exit", release);
  // Standalone gates release before exiting. Cooperative callers retain the
  // slot until their child cleanup finishes and finally releases it.
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return { name, dir, release };
}

/**
 * Take one of the host's four cargo lanes for a build or test run.
 */
export function acquireBuildSlot(options) {
  return acquireSlot({ ...options, kind: "build-slot", lanes: "cargo lanes" });
}

/**
 * Hold the host's single verification lane for a whole PR gate, so two gates
 * never compete for the same cores and disk. Null on a single-tenant host.
 * A gate can wait behind several others, so this waits up to six hours.
 */
export function acquireVerificationSlot(env = process.env) {
  const budget = resolveBuildBudget(env);
  if (!budget) return null;
  return acquireSlot({ root: budget.root, slots: 1, kind: "verification-slot", lanes: "verification runs",
    waitMs: 6 * 60 * 60_000, pollMs: 60_000, cooperativeCancellation: true });
}

/**
 * Take a slot of `kind`, waiting (and reclaiming dead owners) until one frees.
 * Resolves to `{ name, dir, release }`; `release` is idempotent and also runs
 * on process exit. Throws when `waitMs` elapses with every slot held.
 * With cooperativeCancellation, the caller handles child termination and
 * releases the slot in finally; signals set a nonzero exit code without exiting.
 * Signals received while waiting reject acquisition so caller cleanup can run.
 */
async function acquireSlot({
  root,
  slots,
  kind,
  lanes,
  waitMs = 90 * 60_000,
  pollMs = 15_000,
  staleMs = 30 * 60_000,
  heartbeatMs = defaultHeartbeatMs,
  cooperativeCancellation = false,
}) {
  mkdirSync(root, { recursive: true });
  const label = kind.replace("-", " ");
  const deadline = Date.now() + waitMs;
  let denied = false;
  let nextMessageAt = 0;
  let lastSweepAt = -Infinity;
  let ticket;
  const removeTicket = () => ticket?.remove();
  const cancellation = new AbortController();
  const cancel = (signal, code) => {
    process.exitCode = code;
    cancellation.abort(new Error(`${label[0].toUpperCase()}${label.slice(1)} acquisition cancelled by ${signal}.`));
    removeTicket();
    if (!cooperativeCancellation) process.exit(code);
  };
  const onSigint = () => cancel("SIGINT", 130);
  const onSigterm = () => cancel("SIGTERM", 143);
  process.on("exit", removeTicket);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try { for (;;) {
    cancellation.signal.throwIfAborted();
    let ahead = -1;
    let free = [];
    const refreshQueue = () => {
      ahead = queueTickets(root, kind).indexOf(ticket.name);
      free = [];
      for (let i = 1; i <= slots; i += 1) {
        if (!existsSync(slotDir(root, i, kind))) free.push(i);
      }
    };
    try {
      if (ticket && !existsSync(ticket.path)) {
        ticket.remove();
        ticket = undefined;
      }
      ticket ??= createTicket(root, kind, heartbeatMs);
      refreshQueue();
      const reserved = ahead > 0 && free.length > 0 && ahead >= free.length;
      const sweepMs = reserved ? Math.min(pollMs, 1000) : pollMs;
      if (Date.now() - lastSweepAt >= sweepMs) {
        lastSweepAt = Date.now();
        reclaimStaleSlots({ root, slots, staleMs, kind });
        refreshQueue();
      }
      if (ahead < 0) {
        ticket.remove();
        ticket = undefined;
      }
      if (ahead >= 0 && ahead < free.length) {
        // Reserve one free slot for each ticket ahead. Atomic mkdir arbitrates
        // changing snapshots and old-code holders without blocking on a sweep.
        const i = free[ahead];
        const dir = slotDir(root, i, kind);
        let created = false;
        try {
          mkdirSync(dir);
          created = true;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        if (created) return claimSlot(dir, `${kind}-${i}`, heartbeatMs, cooperativeCancellation, removeTicket);
      }
    } catch (error) {
      if (!transientFilesystemError(error, root, kind)) throw error;
      ahead = -1; // This snapshot cannot grant admission; retry after the sleep.
    }
    if (!denied) {
      denied = true;
      logEvent(root, free.length === 0
        ? `denied: pid ${process.pid} found all ${slots} slots held`
        : `denied: pid ${process.pid} waiting at queue position ${ahead + 1}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `no ${label} freed within ${Math.round(waitMs / 60_000)} minutes: ` +
          `the concurrency budget is ${slots} concurrent ${lanes} ` +
          `at ${root} ${free.length === 0
            ? `and all ${slots} slots are held — ${holders(root, slots, kind)}`
            : `with ${ahead < 0 ? "queue position unavailable" : `queue position ${ahead + 1} behind older waiters`}; ${holders(root, slots, kind) || "no current holder"}`}. Wait for a lane to finish and ` +
          `rerun; a dead lane's slot is reclaimed automatically once its ` +
          `heartbeat is 30 minutes stale.`,
      );
    }
    if (Date.now() >= nextMessageAt) {
      const position = ahead < 0 ? "unavailable" : ahead + 1;
      console.log(`  waiting for a ${label}: ${holders(root, slots, kind) || "no current holder"}; queue position ${position}`);
      nextMessageAt = Date.now() + pollMs;
    }
    await sleep(Math.min(pollMs, 1000, Math.max(1, deadline - Date.now())), undefined, { signal: cancellation.signal });
  } } finally {
    removeTicket();
    process.off("exit", removeTicket);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
