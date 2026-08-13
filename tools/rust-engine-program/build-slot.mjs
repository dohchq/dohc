// One lane's share of a shared build machine (WINDOWS_DEV.md, "Build
// economics").
//
// Several agent lanes run cargo on one host. Unbounded, every cargo asks for
// every logical core — the resource that matters is concurrent rustc
// processes ACROSS lanes, not the lane count, and the machine has been
// OOM-crashed by five lanes at default jobs. So a lane takes one of a fixed
// set of slots before any cargo runs and caps its compiler and test
// parallelism to an even share of the cores while it holds it.
//
// A slot is a directory because directory creation is atomic. The owner
// heartbeats by touching its `owner.json`; reclamation is owner-safe, not
// age-guessed: a slot is reclaimable only when its heartbeat is stale AND its
// owner pid is dead, and the reclaim renames the directory to a tombstone
// first so a racing owner's next heartbeat fails loudly instead of silently
// sharing the slot. Denials and reclaims are appended to `events.log` beside
// the slots — not to a tracked file, which a mid-run gate write would turn
// into a provenance failure.

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  utimesSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { availableParallelism, platform } from "node:os";
import { randomBytes } from "node:crypto";

const HEARTBEAT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The budget this host imposes, or null on a single-tenant host (CI runners
 * have no slot root and run uncapped). The root comes from
 * `DOHC_BUILD_SLOT_ROOT`, defaulting to `C:\w\_locks` on Windows — the shared
 * dev machine the budget exists for. Tests point the root at a private
 * directory so a suite run never holds a real lane's slot.
 */
export function resolveBuildBudget(env = process.env, host = {}) {
  const os = host.platform ?? platform();
  const root =
    env.DOHC_BUILD_SLOT_ROOT ?? (os === "win32" ? "C:\\w\\_locks" : null);
  if (root === null) return null;
  const slots = 4;
  const cores = host.cores ?? availableParallelism();
  const floor = Number(env.DOHC_GATE_DISK_FLOOR_GB ?? 40);
  return {
    root,
    slots,
    jobs: Math.max(2, Math.floor(cores / slots)),
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
  if (!Number.isInteger(pid) || pid <= 0) return false;
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

function slotDir(root, i) {
  return join(root, `build-slot-${i}`);
}

function holders(root, slots) {
  const held = [];
  for (let i = 1; i <= slots; i += 1) {
    try {
      const owner = JSON.parse(
        readFileSync(join(slotDir(root, i), "owner.json"), "utf8"),
      );
      held.push(`build-slot-${i}: pid ${owner.pid} since ${owner.start}`);
    } catch {
      held.push(`build-slot-${i}: owner unreadable`);
    }
  }
  return held.join("; ");
}

/**
 * Reclaim slots whose heartbeat is more than `staleMs` old AND whose owner
 * pid is dead. Both conditions, because either alone reclaims a live lane: a
 * long single cargo step does not touch the heartbeat file mid-step if the
 * owner process is wedged-but-alive, and a dead pid with a fresh heartbeat is
 * a pid the OS already reused. Returns how many slots were freed.
 */
export function reclaimStaleSlots({ root, slots, staleMs }) {
  let reclaimed = 0;
  for (let i = 1; i <= slots; i += 1) {
    const dir = slotDir(root, i);
    const ownerPath = join(dir, "owner.json");
    let heartbeatAt;
    try {
      heartbeatAt = statSync(ownerPath).mtimeMs;
    } catch {
      // No owner.json: a half-created slot. Its directory's own age decides.
      try {
        heartbeatAt = statSync(dir).mtimeMs;
      } catch {
        continue; // Slot is free.
      }
    }
    if (Date.now() - heartbeatAt <= staleMs) continue;
    let pid = null;
    try {
      pid = JSON.parse(readFileSync(ownerPath, "utf8")).pid;
    } catch {
      // Unreadable owner + stale heartbeat: nothing left to be safe for.
    }
    if (pid !== null && pidAlive(pid)) continue;
    const tomb = `${dir}.tomb-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(dir, tomb);
    } catch {
      continue; // A racing owner touched it first; its slot, not ours.
    }
    try {
      rmSync(tomb, { recursive: true, force: true });
    } catch {
      // The rename already freed the slot name; the tombstone is debris.
    }
    logEvent(
      root,
      `reclaimed build-slot-${i}: pid ${pid ?? "unknown"} dead, heartbeat ` +
        `${Math.round((Date.now() - heartbeatAt) / 60_000)} min stale`,
    );
    reclaimed += 1;
  }
  return reclaimed;
}

function claimSlot(dir, heartbeatMs) {
  const ownerPath = join(dir, "owner.json");
  writeFileSync(
    ownerPath,
    JSON.stringify({ pid: process.pid, start: new Date().toISOString() }),
  );
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
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A slot that cannot be removed is reclaimed by the next waiter once
      // this process is dead and the heartbeat goes stale.
    }
  };
  process.once("exit", release);
  return { name: basename(dir), dir, release };
}

/**
 * Take a build slot, waiting (and reclaiming dead owners) until one frees.
 * Resolves to `{ name, dir, release }`; `release` is idempotent and also runs
 * on process exit. Throws when `waitMs` elapses with every slot held.
 */
export async function acquireBuildSlot({
  root,
  slots = 4,
  waitMs = 90 * 60_000,
  pollMs = 15_000,
  staleMs = 30 * 60_000,
  heartbeatMs = HEARTBEAT_MS,
  log = console,
}) {
  mkdirSync(root, { recursive: true });
  const deadline = Date.now() + waitMs;
  let denied = false;
  for (;;) {
    for (let i = 1; i <= slots; i += 1) {
      const dir = slotDir(root, i);
      try {
        mkdirSync(dir);
      } catch {
        continue; // Held.
      }
      return claimSlot(dir, heartbeatMs);
    }
    if (reclaimStaleSlots({ root, slots, staleMs }) > 0) continue;
    if (!denied) {
      denied = true;
      logEvent(root, `denied: pid ${process.pid} found all ${slots} slots held`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `no build slot freed within ${Math.round(waitMs / 60_000)} minutes: ` +
          `the concurrency budget is ${slots} concurrent cargo lanes ` +
          `(WINDOWS_DEV.md build economics) and all ${slots} slots at ${root} ` +
          `are held — ${holders(root, slots)}. Wait for a lane to finish, or ` +
          `delete a dead lane's slot directory and rerun.`,
      );
    }
    log.log?.(`  waiting for a build slot: all ${slots} held — ${holders(root, slots)}`);
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}
