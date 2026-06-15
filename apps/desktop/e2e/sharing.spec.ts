import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { launchApp, openInTree } from "./launch";

const SCREENSHOT_DIR = "test-results/screenshots/e5-sharing";
let activeApp: ElectronApplication | null = null;

test.afterEach(async () => {
  await activeApp?.close().catch(() => undefined);
  activeApp = null;
});

async function seedWorkspace(): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-sharing-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-sharing-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({
      version: 1,
      workspaceId: "sharing-e2e",
      kind: "personal",
      mode: "local-first",
    }),
  );
  await mkdir(dirname(join(root, "notes", "plan.md")), { recursive: true });
  await writeFile(join(root, "notes", "plan.md"), "# Plan\n\nShare surface.\n");
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

test("current-file share dialog opens from the inspector and fails closed for local-only workspaces", async () => {
  test.setTimeout(90_000);
  const { home, root } = await seedWorkspace();
  const { page } = await openSeeded(home, root);

  await openInTree(page, "notes/plan.md");
  await expect(page.getByTestId("view-markdown")).toBeVisible();
  await page.getByTestId("file-share").click();

  const dialog = page.getByTestId("share-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("notes/plan.md");
  await expect(page.getByTestId("share-load-error")).toContainText(
    "Sync this workspace before sharing.",
  );

  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await setTheme(page, "light");
    await shot(page, "share-dialog-local-only");
    await setTheme(page, "dark");
    await shot(page, "share-dialog-local-only");
  }
});
