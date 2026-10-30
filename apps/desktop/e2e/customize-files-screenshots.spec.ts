import { settingsNavPin } from "../src/testPins";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { waitForVisibleAnimations } from "./helpers/animations";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openExplorerView,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// Screenshot harness (@ui-audit) for the places a Collection's or dohc's
// setup files show: Customize… on each kind of Collection, the Explorer's Apps section, and
// Settings opened from Customize…. Light and dark. Not a regression test; it
// runs only when a shot directory is set.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture Customize screenshots");

const COLLECTION = (name: string) => `name: ${name}\nfields:\n  Name:\n    type: text\nviews:\n  - name: Table\n    kind: table\n`;
const AUTOMATIONS = "version: 1\nautomations:\n  - id: stamp\n    name: stamp\n    when: record-added\n    do:\n      - set:\n          Name: Packed\n";

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
  await waitForVisibleAnimations(page);
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

async function openCustomize(page: Page, folder: string, name: string): Promise<Locator> {
  await explorerRow(page, folder).click();
  await page.getByRole("button", { name: "Collection actions" }).click();
  await page.getByRole("menuitem", { name: "Customize…" }).click();
  const dialog = page.getByRole("dialog", { name: `Customize ${name}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("@ui-audit Customize files, the Explorer's Apps section, and Settings from Customize…", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, "customize-shots");
    await writeWorkspaceFiles(temp, [
      { path: "trips/collection.yaml", contents: COLLECTION("Trips") },
      { path: "trips/automations.yaml", contents: AUTOMATIONS },
      { path: "tasks/collection.yaml", contents: COLLECTION("Tasks") },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    // The seeded manifest names no computer for the Collections, so keep them here.
    const collections = page.getByRole("region", { name: "Collections", exact: true });
    await collections.getByRole("button", { name: "Use this computer", exact: true }).click();
    await expect(collections.getByTestId("collections-refusal")).toBeHidden();

    // A file-backed Collection with automations.yaml, then keyboard focus on
    // the first row's controls after Close.
    let dialog = await openCustomize(page, "trips", "Trips");
    await expect(dialog.getByText("trips/automations.yaml")).toBeVisible();
    await shoot(page, "customize-with-automations");
    await page.keyboard.press("Tab");
    await shoot(page, "customize-focus-1");
    await page.keyboard.press("Tab");
    await shoot(page, "customize-focus-2");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // A file-backed Collection before its first automation.
    dialog = await openCustomize(page, "tasks", "Tasks");
    await expect(dialog.getByText("tasks/automations.yaml")).toBeVisible();
    await shoot(page, "customize-without-automations");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // A database-backed Collection.
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:menu-command", "new-collection"));
    const create = page.getByTestId("new-collection-dialog");
    await create.getByLabel("Collection name").fill("Registrations");
    await create.getByTestId("new-collection-create").click();
    await expect(create).toBeHidden();
    const collection = page.getByRole("region", { name: "Registrations", exact: true });
    const manage = collection.getByLabel("Manage Collection", { exact: true });
    if (!await manage.evaluate((element) => element.closest("details")?.open)) await manage.click();
    await collection.getByRole("button", { name: "Customize…", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Customize Registrations" });
    await expect(dialog.getByText(/automations\.yaml$/)).toBeVisible();
    await shoot(page, "customize-database");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // The Explorer without apps, which has no Apps section, and then with an
    // app, which brings the section.
    await openExplorerView(page);
    await expect(page.getByTestId("explorer-files-section")).toBeVisible();
    await expect(page.getByTestId("explorer-apps-section")).toHaveCount(0);
    await shoot(page, "apps-empty");
    await writeWorkspaceFiles(temp, [{ path: "demo/index.html", contents: "<!doctype html><title>Demo</title><h1>Demo</h1>\n" }]);
    await expect(page.locator('[data-testid="sites-row"][data-root="demo"]')).toBeVisible();
    await shoot(page, "apps-with-apps");

    // Settings opened from the sidebar's Customize…, then the settings file row.
    await page.getByRole("button", { name: "Sidebar actions" }).click();
    await page.getByRole("menuitem", { name: "Customize…" }).click();
    await expect(page.getByTestId("settings-row-sidebar")).toHaveAttribute("data-highlighted", "true");
    await shoot(page, "settings-customize-row");
    await page.getByTestId(settingsNavPin("advanced")).click();
    await expect(page.getByTestId("settings-row-settings-file")).toBeVisible();
    await expect(page.getByTestId("settings-row-settings-file").locator("code")).toBeVisible();
    await shoot(page, "settings-file-row");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
