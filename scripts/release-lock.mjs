// The lock that keeps release commands on this Mac from running at once: the
// scheduled nightly job, and every run of release-desktop-macos.mjs. The
// operating system holds it for every process that has its descriptor open,
// and releases it when the last of them exits, so a crash leaves no stale lock.

import { spawn, spawnSync } from "node:child_process";
import { fstatSync, mkdirSync, statSync } from "node:fs";
import { constants } from "node:os";
import { dirname } from "node:path";

// Set for a command that holds the lock: the lock's path, and the descriptor that holds it.
const HELD = "DOHC_RELEASE_LOCK_HELD";
const HELD_FD = "DOHC_RELEASE_LOCK_FD";
export const LOCK_BUSY = 75;
// Node cannot take an flock, so perl takes it without waiting, records the
// descriptor, keeps it open across exec ($^F), and becomes the command.
// 6 is LOCK_EX | LOCK_NB.
const TAKE = '$^F = 255; open(my $lock, ">>", shift) or die "$!\\n"; flock($lock, 6) or exit 75; $ENV{DOHC_RELEASE_LOCK_FD} = fileno($lock); exec @ARGV or die "$!\\n"';
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The descriptor through which this process holds the lock, or null. */
function heldDescriptor(lock, env) {
  const fd = Number(env[HELD_FD]);
  if (env[HELD] !== lock || !Number.isInteger(fd) || fd < 3) return null;
  try {
    const held = fstatSync(fd);
    const file = statSync(lock);
    return held.dev === file.dev && held.ino === file.ino ? fd : null;
  } catch {
    return null;
  }
}

/**
 * Runs this command again under the release lock, unless this process holds
 * it. Returns null in the process that holds it. Otherwise it waits for the
 * run under the lock and returns its exit code, or LOCK_BUSY when another
 * command holds the lock. It passes termination signals on, so the run can
 * lock the release keychain and clean up before this process exits.
 */
export async function underReleaseLock(lock, { env = process.env, argv = process.argv } = {}) {
  if (heldDescriptor(lock, env) !== null) return null;
  mkdirSync(dirname(lock), { recursive: true });
  const child = spawn("/usr/bin/perl", ["-e", TAKE, lock, process.execPath, ...argv.slice(1)], { stdio: "inherit", env: { ...env, [HELD]: lock } });
  const forward = signal => child.kill(signal);
  for (const signal of SIGNALS) process.on(signal, forward);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 0)));
    });
    if (status === LOCK_BUSY) console.error(`Another release command on this Mac holds ${lock}. Run this one after it finishes.`);
    return status;
  } finally {
    for (const signal of SIGNALS) process.off(signal, forward);
  }
}

/**
 * Spawn options that hand this process's hold on the lock to a child release
 * command as descriptor 3. Node closes other descriptors in its children, so
 * the hold passes only this way.
 */
export function heldLockOptions(lock, env = process.env) {
  const fd = heldDescriptor(lock, env);
  if (fd === null) throw new Error(`This process does not hold ${lock}.`);
  return { stdio: ["inherit", "inherit", "inherit", fd], env: { ...env, [HELD]: lock, [HELD_FD]: "3" } };
}

/** Whether a release command holds the lock now. */
export function releaseLockHeld(lock) {
  mkdirSync(dirname(lock), { recursive: true });
  return spawnSync("/usr/bin/perl", ["-e", TAKE, lock, "/usr/bin/true"]).status === LOCK_BUSY;
}
