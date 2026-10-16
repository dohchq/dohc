import { test, expect, type TestInfo } from "@playwright/test";
import { holdSystemClipboard as holdClipboard } from "../../apps/desktop/e2e/helpers/systemClipboard";
import { withSystemClipboardLock } from "../../apps/desktop/e2e/helpers/systemClipboardLock.mjs";
import assert from "node:assert/strict";

const lockPath = JSON.parse(process.env.DOHC_CLIPBOARD_TEST_ADDRESS!);
const holdSystemClipboard = <T>(info: TestInfo, use: () => Promise<T>) => holdClipboard(info, use, lockPath);

test.setTimeout(2_500);

test("intentional failure", async ({}, info) => {
  await holdSystemClipboard(info, async () => {
    await assert.rejects(withSystemClipboardLock({ lockPath, holder: "contender", timeoutMs: 100 }, async () => {}), /intentional failure/);
    throw new Error("intentional span failure");
  });
});

test("acquires after failure", async ({}, info) => {
  await holdSystemClipboard(info, async () => {});
});

test("intentional timeout", async ({}, info) => {
  await holdSystemClipboard(info, async () => {
    await new Promise(() => {});
  });
});

test("acquires after timeout", async ({}, info) => {
  await holdSystemClipboard(info, async () => {});
});

test("no lock outside spans", async ({}, info) => {
  await withSystemClipboardLock({ lockPath, holder: "before span", timeoutMs: 500 }, async () => {});
  expect(await holdSystemClipboard(info, async () => "value")).toBe("value");
  await withSystemClipboardLock({ lockPath, holder: "after span", timeoutMs: 500 }, async () => {});
});
