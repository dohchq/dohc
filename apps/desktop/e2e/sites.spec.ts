import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test("@sites opens a static workspace site in the sandboxed preview", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const sentinel = "Static site preview crossed the Electron boundary.";

  try {
    await writeWorkspaceFiles(temp, [
      {
        path: "demo/index.html",
        contents: `<!doctype html><title>Launch site</title><main>${sentinel}</main>`,
      },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await page.getByTestId("activity-sites").click();
    await expect(page.getByTestId("sites-view")).toBeVisible();
    const site = page.locator('[data-testid="sites-row"][data-root="demo"]');
    await expect(site).toBeVisible({ timeout: 20_000 });
    await site.click();

    await expect(page.getByTestId("site-preview-page")).toBeVisible();
    await expect(page.getByTestId("site-preview-frame")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .frameLocator('[data-testid="site-preview-frame"]')
        .locator("main"),
    ).toHaveText(sentinel);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
