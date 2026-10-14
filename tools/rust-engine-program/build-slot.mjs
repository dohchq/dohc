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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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

/** Clamp inherited compiler and test settings to this lane's host budget. */
export function capBuildParallelism(source, maxJobs) {
  if (!Number.isInteger(maxJobs) || maxJobs < 1) throw new Error("Build parallelism must be a positive integer.");
  const env = { ...source };
  for (const name of ["CARGO_BUILD_JOBS", "RUST_TEST_THREADS", "NEXTEST_TEST_THREADS"]) {
    const matching = Object.keys(env).filter(key => key.toUpperCase() === name);
    const value = env[name] ?? env[matching[0]] ?? (name === "NEXTEST_TEST_THREADS" ? env.RUST_TEST_THREADS : undefined);
    for (const key of matching) delete env[key];
    const requested = Number(value);
    env[name] = String(Number.isInteger(requested) && requested > 0 ? Math.min(requested, maxJobs) : maxJobs);
  }
  return env;
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

// Creation identity of the process that now has `pid`, or null when the OS
// will not say. Two reads of one process return the same string; a reused pid
// returns a different one. The value is the OS's own record, so a clock change
// after the process started cannot alter it.
// A lookup can outlive a process killed while it waits, and Windows cannot delete a running process's
// working directory, so lookups run from the Windows directory instead of inheriting the caller's.
const lookupDirectory = process.env.SystemRoot;

function creationQuery(pid, os) {
  if (os === "win32") {
    return ["pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`]];
  }
  return null;
}

function linuxCreation(pid) {
  // starttime is field 22; the command name in field 2 may contain spaces.
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return /^\d+$/u.test(start) && boot ? `${boot}/${start}` : null;
}

const creationOutput = output => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(output.trim()) ? output.trim() : null;

export function processCreation(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform() === "linux") return linuxCreation(pid);
    const query = creationQuery(pid, platform());
    if (!query) return null;
    return creationOutput(execFileSync(query[0], query[1], {
      encoding: "utf8", windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "ignore"], cwd: lookupDirectory,
    }));
  } catch {
    return null;
  }
}

// This process's identity, looked up once in the background. Windows needs a
// PowerShell start (about two seconds), so claims never wait for it: a claim
// made first gains the identity when it arrives, and the lookup never keeps a
// finished process alive.
let ownCreation;
let ownCreationValue = null;
function linuxOwnCreation() {
  if (platform() !== "linux") return null;
  try { return ownCreationValue ??= linuxCreation(process.pid); } catch { return null; }
}
function resolveOwnCreation() {
  if (ownCreation) return ownCreation;
  const query = creationQuery(process.pid, platform());
  if (!query) return ownCreation = Promise.resolve(linuxOwnCreation());
  return ownCreation = new Promise(done => {
    const finish = value => { ownCreationValue = value; done(value); };
    try {
      const child = spawn(query[0], query[1], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"], cwd: lookupDirectory });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => { output += chunk; });
      const timer = setTimeout(() => child.kill(), 30_000);
      timer.unref();
      child.once("error", () => { clearTimeout(timer); finish(null); });
      child.once("close", code => { clearTimeout(timer); finish(code === 0 ? creationOutput(output) : null); });
      child.unref();
      child.stdout.unref();
    } catch {
      finish(null);
    }
  });
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
const defaultIdentityDelayMs = 10_000;

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
      const status = readStatus(dir, owner);
      const detail = [status.purpose, status.checkout, status.commit?.slice(0, 12), status.phase].filter(Boolean).join(", ");
      const elapsed = Math.max(0, Date.now() - Date.parse(owner.start));
      const heartbeat = Math.max(0, Date.now() - statSync(join(dir, "owner.json")).mtimeMs);
      // Without an identity, a reused pid keeps the slot until that other process exits.
      held.push(`${kind}-${i}: pid ${owner.pid}${owner.created ? "" : " (no process identity)"} since ${owner.start}, ` +
        `elapsed ${Math.round(elapsed / 1000)}s, last heartbeat ${Math.round(heartbeat / 1000)}s ago${detail ? ` (${detail})` : ""}`);
    } catch {
      if (existsSync(dir)) held.push(`${kind}-${i}: owner unreadable`);
    }
  }
  return held.join("; ");
}

function metadataFields(metadata = {}) {
  return Object.fromEntries(["purpose", "checkout", "commit", "phase"].flatMap(name =>
    typeof metadata[name] === "string" ? [[name, metadata[name].replace(/[\r\n]/gu, " ").slice(0, 300)]] : []));
}

function readStatus(dir, owner) {
  try {
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    return status.owner === JSON.stringify(owner) ? metadataFields(status) : {};
  } catch { return metadataFields(owner); }
}

function historyEvent(root, event) {
  try { appendFileSync(join(root, "admission-history.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"); }
  catch { /* History informs estimates; it never controls admission. */ }
}

function serviceHistory(root, kind) {
  let fd;
  try {
    const path = join(root, "admission-history.jsonl");
    const bytes = statSync(path).size;
    fd = openSync(path, "r");
    const start = Math.max(0, bytes - 64 * 1024);
    const buffer = Buffer.alloc(bytes - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start) lines.shift();
    return lines.flatMap(line => {
      try {
        const event = JSON.parse(line);
        return event.kind === kind && event.event === "release" && Number.isFinite(event.elapsedMs) && event.elapsedMs > 0 ? [event.elapsedMs] : [];
      } catch { return []; }
    }).slice(-20);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Read-only status. An estimate is based on completed runs, never an admission rule. */
export function buildQueueStatus({ root, slots, kind = "build-slot", ticketName, now = Date.now() }) {
  const queue = queueTickets(root, kind);
  const position = ticketName ? queue.indexOf(ticketName) + 1 : null;
  const owners = [];
  for (let i = 1; i <= slots; i += 1) {
    const dir = slotDir(root, i, kind);
    if (!existsSync(dir)) continue;
    try {
      const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
      owners.push({ name: `${kind}-${i}`, purpose: "unknown", ...owner, ...readStatus(dir, owner), elapsedMs: Math.max(0, now - Date.parse(owner.start)) });
    } catch { owners.push({ name: `${kind}-${i}`, phase: "owner unreadable" }); }
  }
  const samples = serviceHistory(root, kind).sort((a, b) => a - b);
  const serviceMs = samples.length ? samples[Math.floor(samples.length / 2)] : null;
  const estimateWait = position => {
    if (serviceMs === null || position < 1 || !owners.every(owner => Number.isFinite(owner.elapsedMs))) return null;
    const remaining = owners.map(owner => Math.max(0, serviceMs - owner.elapsedMs));
    while (remaining.length < slots) remaining.push(0);
    for (let i = 1; i < position; i += 1) {
      remaining.sort((a, b) => a - b);
      remaining[0] += serviceMs;
    }
    return Math.min(...remaining);
  };
  const estimatedWaitMs = position ? estimateWait(position) : null;
  const waiters = queue.map((name, index) => {
    try {
      const record = JSON.parse(readFileSync(join(root, `${kind}-queue`, name), "utf8"));
      return { ticket: name, position: index + 1, pid: record.pid, purpose: "unknown", ...metadataFields(record), elapsedMs: Math.max(0, now - Date.parse(record.start)), estimatedWaitMs: estimateWait(index + 1) };
    } catch { return { ticket: name, position: index + 1, purpose: "unknown", phase: "ticket unreadable" }; }
  });
  return { root, kind, slots, owners, waiters, queued: queue.length, position, estimate: { waitMs: estimatedWaitMs, serviceMs, samples: samples.length } };
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
  // A sweep suspended past the takeover window loses its lock to a successor.
  // One owner file, created exclusively, names the lock's holder: a late
  // writer finds it taken and backs off, and `owns` lets a running sweep stop
  // mutating once its lock is gone.
  const token = randomBytes(8).toString("hex");
  const ownerPath = join(sweepLock, "owner");
  const owns = () => {
    try { return readFileSync(ownerPath, "utf8") === token; }
    catch { return false; }
  };
  try {
    writeFileSync(ownerPath, token, { flag: "wx" });
  } catch (error) {
    // EEXIST: a successor owns it now. ENOENT: a takeover removed it. Neither is ours to clean.
    if (error.code === "EEXIST" || error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return sweep(owns);
  } finally {
    // A lock this sweeper lost stays where it is. Its own lock is moved aside
    // and deleted only if the owner inside is still this token; a successor
    // that took the name between the check and the move gets it back.
    // Residual, accepted: if a third sweeper takes the name in that instant,
    // the moved lock's holder sees `owns` turn false and stops. Slot safety
    // never rests on this lock: every reclaim validates its tombstone.
    if (owns()) {
      const moved = `${sweepLock}.release-${randomBytes(4).toString("hex")}`;
      let renamed = false;
      for (let attempt = 0; attempt < 5 && !renamed; attempt += 1) {
        try { renameSync(sweepLock, moved); renamed = true; }
        catch (error) {
          // A scanner briefly holding the owner file open blocks a directory rename on Windows.
          if (!["EPERM", "EBUSY", "EACCES"].includes(error.code)) break;
          Atomics.wait(releaseWait, 0, 0, 50 * (attempt + 1));
        }
      }
      if (!renamed) logEvent(root, "sweep lock release failed; the next sweeper takes it over after 5 minutes");
      else if (readOwner(moved) === token) rmSync(moved, { recursive: true, force: true });
      else {
        try { renameSync(moved, sweepLock); }
        catch { logEvent(root, `a successor's sweep lock could not be restored (${moved}); its sweep stops`); }
      }
    }
  }
}

const releaseWait = new Int32Array(new SharedArrayBuffer(4));
function readOwner(lock) {
  try { return readFileSync(join(lock, "owner"), "utf8"); }
  catch { return null; }
}

/**
 * Reclaim slots whose owner is gone. The owner file's mtime IS the heartbeat:
 * a live owner refreshes it every minute whatever its content.
 *
 * A readable owner is reclaimed once its heartbeat is `goneMs` old (at most
 * `staleMs`) and its pid is dead, or once the pid belongs to a different
 * process than the one that claimed. Owners record the OS creation identity
 * of their process; a different identity behind the same pid proves reuse,
 * and is trusted only after two missed heartbeats, because a fresh heartbeat
 * proves the claimer lives. A live owner with its own or an unknown identity
 * keeps its slot even when its heartbeat stops; stopping it safely needs
 * process ownership this sweep does not have. A slot whose owner file is
 * missing or unreadable for `staleMs` has no working heartbeat by
 * construction (a crash between mkdir and the owner write, or a torn write)
 * and is reclaimed too.
 *
 * Sweeps are serialized through a `reclaim.lock` directory: two concurrent
 * sweepers could otherwise both judge one slot dead, and the slower rename
 * would steal the directory the faster sweeper's waiter had already
 * re-claimed. The lock is held for milliseconds; one left by a dead sweeper
 * is removed after 5 minutes. Returns how many slots were freed.
 */
export function reclaimStaleSlots({ root, slots, staleMs, kind = "build-slot", goneMs = 2 * defaultHeartbeatMs, identify = processCreation }) {
  try {
    return withSweepLock(root, owns => {
      reclaimStaleTickets({ root, kind, owns });
      return reclaimSlots({ root, slots, kind, staleMs, goneMs, identify, owns });
    }) ?? 0;
  } catch (error) {
    if (!transientFilesystemError(error, root, kind)) throw error;
    return 0;
  }
}

// A matching identity only keeps a slot, so it is cached to spare repeated
// sweeps a PowerShell start. A mismatch frees a slot, so it is never cached.
const sameCreation = new Map();
function confirmsOwner(pid, created, identify) {
  const cached = sameCreation.get(pid);
  if (cached?.created === created && Date.now() - cached.at < 5 * 60_000) return { same: true };
  const current = identify(pid);
  if (current === created) sameCreation.set(pid, { created, at: Date.now() });
  return { same: current === null || current === created, current };
}

function heartbeatOf(dir) {
  return statSync(join(dir, "owner.json"), { throwIfNoEntry: false })?.mtimeMs
    ?? statSync(dir, { throwIfNoEntry: false })?.mtimeMs;
}

function reclaimSlots({ root, slots, staleMs, goneMs = 2 * defaultHeartbeatMs, kind, identify = processCreation, owns = () => true }) {
  const deadAfter = Math.min(staleMs, goneMs);
  const reusedAfter = Math.max(deadAfter, 2 * defaultHeartbeatMs);
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
    const age = Date.now() - heartbeatAt;
    if (age <= deadAfter) continue;
    let inspectedOwner = null;
    try {
      inspectedOwner = readFileSync(ownerPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT" && transientFilesystemError(error, root, kind)) continue;
      // A missing owner file is judged by `why` below.
    }
    // Without a readable pid, only the heartbeat speaks for the owner.
    let ownerGone = false;
    if (why === undefined) {
      let owner;
      try {
        owner = JSON.parse(inspectedOwner);
      } catch {
        owner = null;
      }
      const pid = owner === null ? null : owner.pid;
      if (pid === null) {
        why = "owner unreadable";
      } else if (!Number.isInteger(pid) || pid <= 0) {
        why = `owner pid invalid (${pid})`;
      } else if (!pidAlive(pid)) {
        why = `pid ${pid} dead`;
        ownerGone = true;
      } else if (typeof owner.created === "string" && age > reusedAfter) {
        const { same, current } = confirmsOwner(pid, owner.created, identify);
        if (same) continue;
        why = `pid ${pid} reused (claimed by process created ${owner.created}, now ${current})`;
        ownerGone = true;
      } else {
        continue; // Live, and nothing proves the pid changed hands.
      }
    }
    if (!ownerGone && age <= staleMs) continue;
    // The identity probe can take seconds. A heartbeat during it, or a sweep
    // takeover while this one was suspended, cancels the decision.
    if (heartbeatOf(dir) !== heartbeatAt || !owns()) continue;
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
    // sweep inspected, or that owner heartbeated after the check, put it back.
    let movedOwner = null;
    try {
      movedOwner = readFileSync(join(tomb, "owner.json"), "utf8");
    } catch {
      // Both null when neither had an owner file; the heartbeat still tells them apart.
    }
    if (movedOwner !== inspectedOwner || heartbeatOf(tomb) !== heartbeatAt) {
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
// The caller holds reclaim.lock, and stops when it no longer `owns` it.
function reclaimStaleTickets({ root, kind, owns = () => true }) {
  for (const name of queueEntries(root, kind)) {
    if (!owns()) return;
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

function createTicket(root, kind, heartbeatMs, metadata) {
  const queueDir = join(root, `${kind}-queue`);
  mkdirSync(queueDir, { recursive: true });
  // hrtime uses the host's monotonic clock, shared across its processes.
  const order = process.hrtime.bigint();
  const name = `${String(order).padStart(24, "0")}-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  const path = join(queueDir, name);
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, start: new Date().toISOString(), heartbeatMs, ...metadataFields(metadata) }), { flag: "wx" });
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

function claimSlot(dir, name, heartbeatMs, cooperativeCancellation, removeTicket, root, kind, metadata, identityDelayMs = defaultIdentityDelayMs) {
  const ownerPath = join(dir, "owner.json");
  let ownerRecord = JSON.stringify({
    pid: process.pid,
    // Lets a sweep tell this process from a later one that reuses its pid.
    created: ownCreationValue ?? linuxOwnCreation(),
    start: new Date().toISOString(),
    ...metadataFields(metadata),
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
  const startedAt = Date.now();
  const update = fields => {
    if (released) return;
    try {
      if (readFileSync(ownerPath, "utf8") !== ownerRecord) return;
      metadata = { ...metadataFields(metadata), ...metadataFields(fields) };
      writeFileSync(join(dir, "status.json"), JSON.stringify({ owner: ownerRecord, ...metadata, updatedAt: new Date().toISOString() }));
    } catch { /* Status writes must not lose an acquired slot or its release handle. */ }
  };
  update(metadata);
  // Only a held slot needs an identity; claims released within seconds never
  // pay the lookup. A sweep that read the identity-less record sees new bytes
  // and backs off.
  const identify = identityDelayMs !== null && JSON.parse(ownerRecord).created === null ? setTimeout(() => resolveOwnCreation().then(created => {
    if (released || created === null) return;
    try {
      if (readFileSync(ownerPath, "utf8") !== ownerRecord) return;
      const record = JSON.stringify({ ...JSON.parse(ownerRecord), created });
      // Rename, so a failed write leaves the old record and release still matches it.
      const temporary = `${ownerPath}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(temporary, record);
      renameSync(temporary, ownerPath);
      ownerRecord = record;
      update({});
    } catch { /* The slot keeps its pid-only record. */ }
  }), identityDelayMs) : null;
  identify?.unref();
  historyEvent(root, { event: "admit", kind, name, pid: process.pid, ...metadataFields(metadata) });
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    clearTimeout(identify);
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
      historyEvent(root, { event: "release", kind, name, pid: process.pid, elapsedMs: Date.now() - startedAt, ...metadataFields(metadata) });
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
  return { name, dir, release, update };
}

/**
 * Take one of the host's four cargo lanes for a build or test run.
 */
export function acquireBuildSlot(options) {
  // A dead holder's compilers can outlive it, so a cargo lane keeps the long grace.
  return acquireSlot({ goneMs: 30 * 60_000, ...options, kind: "build-slot", lanes: "cargo lanes" });
}

/** Fail-fast ownership for mutable local resources; this creates no waiter queue. */
export function acquireExclusiveSlot({ root, kind, metadata, cooperativeCancellation = true, identityDelayMs = defaultIdentityDelayMs }) {
  mkdirSync(root, { recursive: true });
  const dir = slotDir(root, 1, kind);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { mkdirSync(dir); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt) throw new Error(`Another run owns ${dir}: ${holders(root, 1, kind) || "owner unavailable"}.`);
      let staleMs = 30 * 60_000;
      try {
        const { pid } = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
        // Live PIDs remain protected by the existing reclaimer. Incomplete
        // claims keep its grace period across the mkdir/write window.
        if (Number.isInteger(pid) && pid > 0) staleMs = -1;
      } catch { /* Preserve a recent incomplete claim. */ }
      reclaimStaleSlots({ root, slots: 1, kind, staleMs });
      continue;
    }
    return claimSlot(dir, `${kind}-1`, defaultHeartbeatMs, cooperativeCancellation, () => {}, root, kind, metadata, identityDelayMs);
  }
}

const canonical = path => {
  try { return realpathSync(path).toLowerCase(); }
  catch { return resolve(path).toLowerCase(); }
};
const verifierEntry = fileURLToPath(new URL("../../scripts/verification/verify.mjs", import.meta.url));

/**
 * Hold the host's single verification lane for a whole PR gate, so two gates
 * never compete for the same cores and disk. Null on a single-tenant host.
 * A gate can wait behind several others, so this waits up to six hours.
 * Only this checkout's PR verifier may hold it; `entry` is the caller's script.
 */
export function verificationLanes(env = process.env) {
  const requested = env.DOHC_VERIFICATION_LANES ?? "1";
  if (!["1", "2"].includes(requested)) throw new Error("DOHC_VERIFICATION_LANES must be 1 or 2.");
  const trialRoot = env.DOHC_VERIFICATION_SLOT_ROOT;
  const cargoRoot = resolveBuildBudget(env)?.root;
  if (trialRoot && (env.DOHC_VERIFICATION_TRIAL !== "1" || cargoRoot && canonical(trialRoot) === canonical(cargoRoot))) {
    throw new Error("A verification trial requires DOHC_VERIFICATION_TRIAL=1 and an isolated DOHC_VERIFICATION_SLOT_ROOT; keep Cargo on its shared root.");
  }
  if (requested === "2" && !trialRoot) {
    throw new Error("Two verification lanes require DOHC_VERIFICATION_TRIAL=1 and an isolated DOHC_VERIFICATION_SLOT_ROOT.");
  }
  return Number(requested);
}

export function acquireVerificationSlot(env = process.env, { metadata, waitMs = 6 * 60 * 60_000, observeTicket, entry = process.argv[1], signal } = {}) {
  if (!entry || canonical(entry) !== canonical(verifierEntry)) {
    throw new Error(`Only the PR verifier (${verifierEntry}) may hold a verification lane. Run pnpm verify:pr, or take a build slot for other Cargo work.`);
  }
  const slots = verificationLanes(env);
  const budget = resolveBuildBudget(env);
  if (!budget) return null;
  return acquireSlot({ root: env.DOHC_VERIFICATION_SLOT_ROOT ?? budget.root, slots,
    kind: "verification-slot", lanes: "verification runs", metadata,
    waitMs, pollMs: 60_000, cooperativeCancellation: true, observeTicket, signal });
}

/** A ticket observer failed, so acquisition stopped before admission instead of retrying. */
export class TicketEvidenceError extends Error {}

/**
 * Take a slot of `kind`, waiting (and reclaiming dead owners) until one frees.
 * Resolves to `{ name, dir, release }`; `release` is idempotent and also runs
 * on process exit. Throws when `waitMs` elapses with every slot held.
 * With cooperativeCancellation, the caller handles child termination and
 * releases the slot in finally; signals set a nonzero exit code without exiting.
 * Signals received while waiting reject acquisition so caller cleanup can run.
 * `observeTicket({ root, kind, name, path })` runs synchronously for each
 * newly published ticket before that ticket attempts admission. An uncontended
 * admission removes its ticket within milliseconds, so no later reader can
 * rely on seeing it. A throwing or Promise-returning observer rejects
 * acquisition with TicketEvidenceError.
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
  metadata,
  observeTicket,
  identityDelayMs,
  goneMs,
  signal,
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
  // A caller's signal stops the wait without touching the process's exit code.
  const onAbort = () => { cancellation.abort(signal.reason ?? new Error(`${label} acquisition stopped.`)); removeTicket(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const observe = ({ name, path }) => {
    // Inspecting a returned thenable runs observer code too, so its failures must not reach the transient retry.
    try {
      const result = observeTicket({ root, kind, name, path });
      if (typeof result?.then !== "function") return;
      result.then(undefined, () => {});
    } catch (error) { throw new TicketEvidenceError(`Ticket evidence capture failed for ${name}: ${error?.message}`, { cause: error }); }
    throw new TicketEvidenceError(`Ticket evidence capture for ${name} must finish synchronously.`);
  };
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
      if (!ticket) {
        ticket = createTicket(root, kind, heartbeatMs, metadata);
        if (observeTicket) observe(ticket);
      }
      refreshQueue();
      const reserved = ahead > 0 && free.length > 0 && ahead >= free.length;
      const sweepMs = reserved ? Math.min(pollMs, 1000) : pollMs;
      if (Date.now() - lastSweepAt >= sweepMs) {
        lastSweepAt = Date.now();
        reclaimStaleSlots({ root, slots, staleMs, goneMs, kind });
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
        if (created) return claimSlot(dir, `${kind}-${i}`, heartbeatMs, cooperativeCancellation, removeTicket, root, kind, metadata, identityDelayMs);
      }
    } catch (error) {
      if (error instanceof TicketEvidenceError || !transientFilesystemError(error, root, kind)) throw error;
      ahead = -1; // This snapshot cannot grant admission; retry after the sleep.
    }
    if (!denied) {
      // A waiter has time to learn its identity before it claims.
      resolveOwnCreation();
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
          `rerun; a slot is reclaimed automatically ` +
          `${Math.round(Math.min(staleMs, goneMs ?? 2 * defaultHeartbeatMs) / 60_000)} minutes after its holder's last ` +
          `heartbeat once its process exits, or once its pid passes to another process and the holder recorded its identity.`,
      );
    }
    if (Date.now() >= nextMessageAt) {
      const position = ahead < 0 ? "unavailable" : ahead + 1;
      let status;
      try { status = buildQueueStatus({ root, slots, kind, ticketName: ticket?.name }); }
      catch { status = {estimate: {waitMs: null}}; }
      const estimate = status.estimate.waitMs === null ? "wait estimate unavailable (no comparable completed runs)"
        : `estimated wait ${Math.round(status.estimate.waitMs / 1000)}s from ${status.estimate.samples} completed runs`;
      console.log(`  waiting for a ${label}: ${holders(root, slots, kind) || "no current holder"}; ${estimate}; queue position ${position}`);
      nextMessageAt = Date.now() + pollMs;
    }
    await sleep(Math.min(pollMs, 1000, Math.max(1, deadline - Date.now())), undefined, { signal: cancellation.signal });
  } } finally {
    removeTicket();
    signal?.removeEventListener("abort", onAbort);
    process.off("exit", removeTicket);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({ options: {status: {type: "boolean"}, root: {type: "string"}} });
  if (!values.status) throw new Error("Use --status [--root <directory>] to inspect queues without acquiring a slot.");
  const budget = resolveBuildBudget();
  const cargoRoot = values.root ?? budget?.root;
  const verificationRoot = values.root ?? process.env.DOHC_VERIFICATION_SLOT_ROOT ?? budget?.root;
  let verificationSlots = 1;
  let verificationConfigurationError = null;
  try { verificationSlots = verificationLanes(); }
  catch (error) { verificationConfigurationError = error.message; }
  // Inspect any existing second lane even when this shell cannot admit one.
  const inspectedVerificationSlots = verificationRoot && existsSync(join(verificationRoot, "verification-slot-2"))
    ? Math.max(2, verificationSlots) : verificationSlots;
  const lanes = [
    ...(cargoRoot ? [buildQueueStatus({root: cargoRoot, slots: budget?.slots ?? 4})] : []),
    ...(verificationRoot ? [
      buildQueueStatus({root: verificationRoot, kind: "verification-slot", slots: inspectedVerificationSlots}),
    ] : []),
  ];
  console.log(JSON.stringify({cargoRoot: cargoRoot ?? null, verificationRoot: verificationRoot ?? null,
    verificationSlots: verificationConfigurationError ? null : verificationSlots, verificationConfigurationError, lanes}, null, 2));
}
