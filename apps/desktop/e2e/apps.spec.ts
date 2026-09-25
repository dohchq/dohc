import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test("@apps opens a static workspace app in the sandboxed preview", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const sentinel = "Static app preview crossed the Electron boundary.";

  try {
    await writeWorkspaceFiles(temp, [
      {
        path: "demo/index.html",
        contents: `<!doctype html><title>Launch app</title><main>${sentinel}</main>`,
      },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await page.getByTestId("activity-sites").click();
    await expect(page.getByTestId("sites-view")).toBeVisible();
    const app = page.locator('[data-testid="sites-row"][data-root="demo"]');
    await expect(app).toBeVisible({ timeout: 20_000 });
    await app.click();

    await expect(page.getByTestId("site-preview-page")).toBeVisible();
    await expect(page.getByTestId("site-preview-frame")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .frameLocator('[data-testid="site-preview-frame"]')
        .locator("main"),
    ).toHaveText(sentinel);

    const frame = page.getByTestId("site-preview-frame");
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((nextTheme) => {
        document.documentElement.dataset.theme = nextTheme;
      }, theme);
      await expect
        .poll(() =>
          frame.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              backgroundColor: style.backgroundColor,
              colorScheme: style.colorScheme,
            };
          }),
        )
        .toEqual({
          backgroundColor: "rgb(255, 255, 255)",
          colorScheme: "light",
        });
    }

    await page.getByRole("button", { name: "Show in Explorer" }).click();
    const tree = page.getByTestId("file-tree");
    await expect(tree.locator('[data-testid="tree-row"][data-path="demo"]')).toBeFocused();
    await expect(
      tree.locator('[data-testid="tree-row"][data-path="demo/index.html"]'),
    ).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("@apps creates and opens the first app inside an existing app folder", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [
      { path: "app/notes.txt", contents: "Keep this file.\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await page.getByTestId("activity-sites").click();
    await expect(page.getByTestId("sites-count")).toContainText("0 apps");
    await page.screenshot({ path: test.info().outputPath("apps-empty.png") });
    await page.getByRole("button", { name: "Create app" }).click();

    await expect(page.getByTestId("site-preview-page")).toBeVisible();
    await expect(page.getByTestId("site-preview-frame")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .frameLocator('[data-testid="site-preview-frame"]')
        .getByRole("heading", { name: "My app" }),
    ).toBeVisible();
    await expect
      .poll(() => readFile(path.join(temp.rootPath, "app", "index.html"), "utf8"))
      .toContain("<h1>My app</h1>");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
