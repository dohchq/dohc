import { rename, rm } from "node:fs/promises";

/**
 * Helpers every plugin pipeline module used to carry its own copy of.
 * One body each — a fix that lands here lands everywhere, instead of
 * needing to be inherited file by file.
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
// rule does not cover this constant. Commands carry no duration contract,
// so any grace here can still interrupt a legitimately slow one; this is
// the grace a user-initiated stop grants in-flight work before it proceeds
// anyway. Set to PluginHost's own PLUGIN_ACTIVATION_TIMEOUT_MS — the same
// order this host already uses for "still working" vs. "never will".
export const COMMAND_CLAIMS_DRAIN_DEADLINE_MS = 30_000;

export const WINDOWS_RENAME_RETRY_DELAYS_MS = [100, 150, 200, 250, 300] as const;

function isWindowsRenameLock(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY";
}

/**
 * Retries rename() through Windows EPERM/EBUSY locks. When it still fails,
 * `wrapError` turns the cause into the caller's own error;
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
      return await rename(source, destination);
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
