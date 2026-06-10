import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { _electron as electron } from "playwright";

const SCREENSHOT_DIR = "test-results/screenshots/phase-02";
const PERF_FILE = "test-results/performance/desktop-performance.json";

test("launches dohc desktop and renders the first-run shell", async () => {
  const launchArgs = ["apps/desktop/dist/main/main.js"];
  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") {
    launchArgs.push("--no-sandbox");
  }
  const app = await electron.launch({
    args: launchArgs,
    cwd: process.cwd(),
    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
  });

  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();

  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/first-run--1280x800--light.png`,
  });

  // Launch performance marks flow through the test-only bridge from day one;
  // Phase 16 ratchets these numbers into a hard gate.
  const marks = await page.evaluate(() =>
    (window as never as {
      dohcDesktopTest?: { getLaunchMarks(): Promise<Record<string, number>> };
    }).dohcDesktopTest?.getLaunchMarks(),
  );
  expect(marks).toBeTruthy();
  expect(marks?.appReadyMs).toBeGreaterThan(0);
  expect(marks?.firstWindowMs).toBeGreaterThan(0);
  expect(marks?.firstPaintMs).toBeGreaterThan(0);

  await mkdir("test-results/performance", { recursive: true });
  await writeFile(
    PERF_FILE,
    JSON.stringify({ phase: 2, launch: marks }, null, 2),
  );

  await app.close();
});
