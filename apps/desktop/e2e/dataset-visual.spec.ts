import { expect, test, type Locator } from "@playwright/test";
import { launchDesktopApp, assertDesktopEngineHealthy } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun } from "./helpers/workspace";

async function expectInsideViewport(locator: Locator) {
  const box = await locator.boundingBox();
  const viewport = await locator.page().evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

for (const theme of ["light", "dark"] as const) {
  test(`@dataset-visual ${theme} creation previews follow fields and remain usable in a narrow window`, async () => {
    test.setTimeout(180_000);
    const workspace = await createTempWorkspace();
    let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
    try {
      desktop = await launchDesktopApp({ workspace });
      const { page, app } = desktop;
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900));
      await openWorkspaceFromFirstRun(page, workspace);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByTestId("activity-settings").click();
      await page.getByTestId("settings-nav-appearance").click();
      await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: theme === "light" ? "Light" : "Dark", exact: true }).click();
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:menu-command", "new-collection"));
      const create = page.getByTestId("new-collection-dialog");
      await expect(create.getByLabel("Collection name")).toBeFocused();
      await create.getByLabel("Collection name").fill("Tournament");
      await create.getByLabel("Require Name").check();
      for (const [index, name, type] of [[1, "Status", "select"], [2, "Date", "date"], [3, "Paid", "checkbox"]] as const) {
        await create.getByRole("button", { name: "Add field", exact: true }).click();
        await create.getByLabel("Field name", { exact: true }).nth(index).fill(name);
        await create.getByLabel("Field type", { exact: true }).nth(index).selectOption(type);
      }
      await create.getByLabel("Options", { exact: true }).fill("Registered, Confirmed");
      const preview = create.getByRole("region", { name: "Collection preview" });
      await expect(preview.getByRole("columnheader", { name: "Status", exact: true })).toBeVisible();
      await expect(preview.getByText("0 records", { exact: true })).toBeVisible();
      const previewScroller = preview.getByRole("table").locator("..");
      expect(await previewScroller.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`create-collection-${theme}.png`) });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(760, 640));
      await expectInsideViewport(create.getByTestId("new-collection-create"));
      await page.screenshot({ path: test.info().outputPath(`create-collection-narrow-${theme}.png`) });
      await create.getByTestId("new-collection-create").click();
      await expect(create).toBeHidden();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900));
      const collection = page.getByRole("region", { name: "Tournament", exact: true });
      await expect(collection.getByRole("button", { name: "Create form", exact: true })).toBeEnabled();
      await collection.getByRole("button", { name: "Create form", exact: true }).focus();
      await expect(collection.getByRole("button", { name: "Create form", exact: true })).toBeFocused();
      const start = performance.now();
      await page.keyboard.press("Enter");
      const form = page.getByTestId("create-dataset-form-dialog");
      await expect(form.getByLabel("Form title")).toBeFocused();
      test.info().annotations.push({ type: "form-open-ms", description: String(Math.round(performance.now() - start)) });
      await form.getByLabel("Form title").fill("Pickleball registration");
      await expect(form.getByRole("region", { name: "Form preview" }).getByRole("heading", { name: "Pickleball registration" })).toBeVisible();
      await form.getByRole("checkbox", { name: "Paid", exact: true }).uncheck();
      await expect(form.getByRole("region", { name: "Form preview" }).getByText("Paid", { exact: true })).toHaveCount(0);
      await form.getByRole("checkbox", { name: "Paid", exact: true }).check();
      await page.screenshot({ path: test.info().outputPath(`create-form-${theme}.png`) });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(760, 640));
      await expectInsideViewport(form.getByRole("button", { name: "Create form", exact: true }));
      await page.screenshot({ path: test.info().outputPath(`create-form-narrow-${theme}.png`) });
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(form).toBeHidden();
      await expect(collection.getByRole("button", { name: "Create form", exact: true })).toBeFocused();
      await collection.getByLabel("Manage Collection", { exact: true }).click();
      await expectInsideViewport(collection.getByLabel("Manage Collection", { exact: true }).locator(".. > div"));
      await page.screenshot({ path: test.info().outputPath(`collection-toolbar-narrow-${theme}.png`) });
      await page.keyboard.press("Escape");
      assertDesktopEngineHealthy(desktop.logs);
      expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
    } finally { await cleanupDesktopWorkspace(desktop, workspace); }
  });
}
