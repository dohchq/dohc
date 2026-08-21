import { rename, rm } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

/**
 * Helpers every plugin pipeline module used to carry its own copy of.
 * One body each — a fix that lands here lands everywhere (#779 round 13 C1;
 * round 10 B5 had to be inherited file by file).
 */

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref?.();
  });
}

/** Rejects with `message` when `promise` outlives `timeoutMs`. */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// A budget, not a work-rejection limit — new commands are already refused
// once the barrier is up, so AGENTS.md's "measure limits that reject work"
// rule does not cover this constant. Measured evidence all the same: the
// hello fixture's command round-trips in 0.1-0.5 ms over a real subprocess
// host (20 runs); PluginHost's own PLUGIN_ACTIVATION_TIMEOUT_MS already
// treats 30 s as this same host's line between "still working" and "never
// will" — reused here so a legitimately slower handler keeps that same
// headroom before its host is stopped out from under it.
export const COMMAND_CLAIMS_DRAIN_DEADLINE_MS = 30_000;

/**
 * Wraps a command-claims drain with COMMAND_CLAIMS_DRAIN_DEADLINE_MS: if
 * `drained` is still outstanding past the deadline, logs which plugin
 * overran and resolves with a no-op lower so the caller proceeds to stop
 * the host — the real lower is never discarded, so the barrier still
 * clears once the hung command's handler eventually settles.
 */
export function awaitCommandClaimsDrainedWithDeadline(
  pluginId: string,
  drained: Promise<() => void>,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<() => void> {
  return raceWithTimeout(
    drained,
    COMMAND_CLAIMS_DRAIN_DEADLINE_MS,
    `Plugin "${pluginId}" still has command claims outstanding after ${COMMAND_CLAIMS_DRAIN_DEADLINE_MS} ms`,
  ).catch((error: unknown) => {
    warn(`[desktop] ${errorMessage(error)}. Stopping its host anyway.`);
    // The claim will still lower once its command eventually settles —
    // never discard the real lower, or the barrier leaks.
    void drained.then((lower) => lower());
    return () => {};
  });
}

export function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const pathFromParent = relative(parent, child);
  // The ".." has to be a whole segment. Testing the prefix alone rejected
  // real contained names — a child under "..cache/" is inside the root
  // (#779 round 10 B5).
  return (
    pathFromParent.length > 0 &&
    !isAbsolute(pathFromParent) &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`)
  );
}

export const WINDOWS_RENAME_RETRY_DELAYS_MS = [100, 150, 200, 250, 300] as const;

function isWindowsRenameLock(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY";
}

/**
 * rename() that retries through Windows EPERM/EBUSY locks. When the rename
 * still fails, `wrapError` turns the cause into the caller's own error —
 * `lockedAfterRetries` is true when the target stayed locked through every
 * retry in WINDOWS_RENAME_RETRY_DELAYS_MS.
 */
export async function renameWithWindowsRetry(
  source: string,
  destination: string,
  wrapError: (error: unknown, lockedAfterRetries: boolean) => unknown,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (!isWindowsRenameLock(error) || retryDelay === undefined) {
        throw wrapError(error, isWindowsRenameLock(error));
      }
      await delay(retryDelay);
    }
  }
}

export function removeStaging(stagingRoot: string): Promise<void> {
  return rm(stagingRoot, {
    recursive: true,
    force: true,
    maxRetries: WINDOWS_RENAME_RETRY_DELAYS_MS.length,
    retryDelay: 200,
  });
}
