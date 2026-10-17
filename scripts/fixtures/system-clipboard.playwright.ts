import { test, expect, type TestInfo } from "@playwright/test";
import { holdSystemClipboard as holdClipboard } from "../../apps/desktop/e2e/helpers/systemClipboard";
import { withSystemClipboardLock } from "../../apps/desktop/e2e/helpers/systemClipboardLock.mjs";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";

const lockPath = JSON.parse(process.env.DOHC_CLIPBOARD_TEST_ADDRESS!);
const holdSystemClipboard = <T>(info: TestInfo, use: (remainingMs: () => number) => Promise<T>) => holdClipboard(info, use, lockPath);

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

test("a hung span releases before another process exhausts its wait", async ({}, info) => {
  test.setTimeout(25_000);
  await mkdir(info.outputDir, { recursive: true });
  const started = performance.now();
  let child: ReturnType<typeof fork> | undefined;
  let acquired: Promise<unknown> | undefined;
  let exited: Promise<unknown> | undefined;
  try {
    await assert.rejects(holdSystemClipboard(info, async remainingMs => {
      child = fork(new URL("./system-clipboard-holder.mjs", import.meta.url), [
        JSON.stringify(lockPath), "other lane", info.outputPath("register"), "once",
      ], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      exited = once(child, "exit");
      acquired = new Promise((resolve, reject) => {
        child!.on("message", (message: { event: string; message?: string }) => {
          if (message.event === "acquired") resolve(message);
          if (message.event === "failed") reject(new Error(message.message));
        });
      });
      await expect.poll(() => false, { timeout: remainingMs() }).toBe(true);
    }), /expect/u);
    assert.ok(performance.now() - started < 15_000, "a failed span ends before the other lane's 20 s wait");
    await acquired;
    await exited;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});

test("acquisition leaves time to report the holder before the test expires", async ({}, info) => {
  await assert.rejects(expect.poll(() => false, { timeout: 500 }).toBe(true));
  await withSystemClipboardLock({ lockPath, holder: "current lane owner", timeoutMs: 500 }, async () => {
    await assert.rejects(holdSystemClipboard(info, async () => assert.fail("must not acquire")), /held by current lane owner.*acquired/u);
  });
});
