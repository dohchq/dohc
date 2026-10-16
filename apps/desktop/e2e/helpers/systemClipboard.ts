import type { TestInfo } from "@playwright/test";
import { systemClipboardLockPath, withSystemClipboardLock } from "./systemClipboardLock.mjs";

/** Hold only the copy/read or write/paste span, including its assertions. */
export async function holdSystemClipboard<T>(
  testInfo: TestInfo,
  use: () => Promise<T>,
  lockPath = systemClipboardLockPath(),
): Promise<T> {
  return withSystemClipboardLock({
    lockPath,
    timeoutMs: 20_000,
    holder: testInfo.titlePath.join(" > "),
  }, use);
}
