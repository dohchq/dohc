import { test as base } from "@playwright/test";
import { withSystemClipboardLock } from "./systemClipboardLock.mjs";

export const test = base.extend<{ systemClipboard: void }>({
  systemClipboard: [async ({}, use, testInfo) => {
    const remaining = testInfo.timeout === 0
      ? Infinity
      : Math.max(0, testInfo.timeout - 250);
    await withSystemClipboardLock({
      timeoutMs: remaining,
      holder: testInfo.titlePath.join(" > "),
    }, use);
  }, { auto: true }],
});
