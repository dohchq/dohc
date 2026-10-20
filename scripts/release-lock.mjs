// The lock that keeps release commands on this Mac from running at once: the
// scheduled nightly job, and every run of release-desktop-macos.mjs. The
// operating system holds it for the process and every child it starts, and
// releases it when the last of them exits, so a crash leaves no stale lock.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Set for a command that runs under the lock, and inherited by its children.
const HELD = "DOHC_RELEASE_LOCK_HELD";
export const LOCK_BUSY = 75;
// Node cannot take an flock, so perl takes it without waiting, keeps the file
// open across exec ($^F), and becomes the command. 6 is LOCK_EX | LOCK_NB.
const TAKE = '$^F = 255; open(my $lock, ">>", shift) or die "$!\\n"; flock($lock, 6) or exit 75; exec @ARGV or die "$!\\n"';

/**
 * Runs this command again under the release lock, unless it already holds it.
 * Returns null in the process that holds it. Otherwise it returns the exit
 * code of the run under the lock, or LOCK_BUSY when another command holds it.
 */
export function underReleaseLock(lock, { env = process.env, argv = process.argv } = {}) {
  if (env[HELD] === lock) return null;
  mkdirSync(dirname(lock), { recursive: true });
  const result = spawnSync("/usr/bin/perl", ["-e", TAKE, lock, process.execPath, ...argv.slice(1)], { stdio: "inherit", env: { ...env, [HELD]: lock } });
  if (result.error) throw result.error;
  if (result.status === LOCK_BUSY) console.error(`Another release command on this Mac holds ${lock}. Run this one after it finishes.`);
  return result.status ?? 1;
}

/** Whether a release command holds the lock now. */
export function releaseLockHeld(lock) {
  mkdirSync(dirname(lock), { recursive: true });
  return spawnSync("/usr/bin/perl", ["-e", TAKE, lock, "/usr/bin/true"]).status === LOCK_BUSY;
}
