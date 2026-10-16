import type { TestInfo } from "@playwright/test";
import { systemClipboardLockPath, withSystemClipboardLock } from "./systemClipboardLock.mjs";

/**
 * Hold only the copy/read or write/paste span, including its assertions.
 * Every action and assertion inside the span must pass remainingMs() as its timeout.
 * Do not release on a timer: a click still running could write during another lane's span.
 */
export async function holdSystemClipboard<T>(
  testInfo: TestInfo,
  use: (remainingMs: () => number) => Promise<T>,
  lockPath = systemClipboardLockPath(),
): Promise<T> {
  // Playwright 1.62.1 keeps the running test's start time on its runtime TestInfo.
  const startedAt = (testInfo as TestInfo & { _startWallTime: number })._startWallTime;
  return withSystemClipboardLock({
    lockPath,
    timeoutMs: testInfo.timeout === 0 ? 20_000 : Math.max(0, Math.min(
      20_000, testInfo.timeout - (Date.now() - startedAt) - 1_000,
    )),
    holder: testInfo.titlePath.join(" > "),
  }, () => {
    const deadline = performance.now() + 10_000;
    return use(() => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("System clipboard span exceeded its 10 s budget.");
      return remaining;
    });
  });
}
