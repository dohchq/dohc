import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { launchApp } from "./launch";

const SCREENSHOT_DIR = "test-results/screenshots/e5-notices";
let activeApp: ElectronApplication | null = null;

test.afterEach(async () => {
  await activeApp?.close().catch(() => undefined);
  activeApp = null;
});

async function seedWorkspace(): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-notices-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-notices-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({
      version: 1,
      workspaceId: "notices-e2e",
      kind: "personal",
      mode: "local-first",
    }),
  );
  await writeFile(join(root, "today.md"), "# Today\n");
  return { home, root };
}

async function openSeeded(home: string, root: string) {
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  activeApp = app;
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  return { app, page };
}

async function sendUpdateState(app: ElectronApplication, state: unknown) {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Expected a desktop window for update event");
    window.webContents.send("desktop:update-state", payload);
  }, state);
}

async function setTheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe(scheme);
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
  const scheme = await page.evaluate(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}--${width}x${height}--${scheme}.png`,
  });
}

test("notice center collects update-ready notices and preserves validated event boundaries", async () => {
  const { home, root } = await seedWorkspace();
  const { app, page } = await openSeeded(home, root);

  await page.getByTestId("notice-center-toggle").click();
  await expect(page.getByTestId("notice-center")).toContainText("All clear");
  await page.getByTestId("notice-center-toggle").click();

  await sendUpdateState(app, { status: "ready", message: "x".repeat(600) });
  await expect(page.getByTestId("update-toast")).toHaveCount(0);
  await expect(page.getByTestId("notice-center-toggle")).toHaveAttribute(
    "aria-label",
    "Notices",
  );

  await sendUpdateState(app, {
    status: "ready",
    message: "Update 1.2.3 is ready — restart dohc to apply it.",
  });
  await expect(page.getByTestId("update-toast")).toContainText(
    "Update 1.2.3 is ready",
  );
  await expect(page.getByTestId("notice-center-toggle")).toHaveAttribute(
    "aria-label",
    "Notices (1)",
  );

  await page.getByTestId("notice-center-toggle").click();
  await expect(page.getByTestId("notice-update-ready")).toContainText(
    "Update 1.2.3 is ready",
  );
  await page.getByTestId("notice-center").click();
  await expect(page.getByTestId("notice-center")).toBeVisible();
  // Click outside the upper-right notice center to exercise backdrop close.
  await page.mouse.click(120, 120);
  await expect(page.getByTestId("notice-center")).toHaveCount(0);
  await page.getByTestId("notice-center-toggle").click();
  await expect(page.getByTestId("notice-update-ready")).toContainText(
    "Update 1.2.3 is ready",
  );
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await setTheme(page, "light");
    await shot(page, "notice-center");
    await setTheme(page, "dark");
    await shot(page, "notice-center");
  }
  await page.getByRole("button", { name: /dismiss update/i }).click();
  await expect(page.getByTestId("update-toast")).toHaveCount(0);
  await expect(page.getByTestId("notice-center")).toContainText("All clear");
});
