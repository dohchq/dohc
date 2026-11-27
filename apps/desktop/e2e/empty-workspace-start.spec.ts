import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { planNewApp } from "@dohc/workspace-core/app-source";
import { settingsNavPin } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openExplorerHome,
  openWorkspaceFromFirstRun,
} from "./helpers/workspace";

// An empty workspace offers an app and an agent first: Connect an agent opens
// agent settings, and New app from the start surface or the Explorer writes
// the same starter app an agent's dohc_create_app writes.
test("an empty workspace makes apps and points to agent settings", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const shot = (name: string) => test.info().outputPath(`${name}.png`);
  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await openExplorerHome(page);

    const start = page.getByTestId("start-surface");
    await expect(start.getByRole("button", { name: "Connect an agent" })).toBeVisible();
    await expect(page.getByTestId("explorer-apps-new")).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: shot("empty-workspace") });

    await start.getByRole("button", { name: "Connect an agent" }).click();
    await expect(page.getByTestId(settingsNavPin("agents"))).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.getByRole("button", { name: "Close settings" }).click();

    await start.getByRole("button", { name: "App", exact: true }).click();
    const firstApp = page.locator('[data-testid="sites-row"][data-root="New app"]');
    await expect(firstApp).toBeVisible({ timeout: 20_000 });
    const plan = planNewApp({ appRoot: "New app", folder: "missing" });
    if (!plan.ok) throw new Error(plan.reason);
    for (const file of plan.files) {
      expect(await readFile(join(temp.rootPath, file.path), "utf8")).toBe(file.content);
    }

    await page.getByTestId("explorer-apps-add").click();
    await expect(page.locator('[data-testid="sites-row"][data-root="New app 2"]')).toBeVisible({
      timeout: 20_000,
    });
    await page.screenshot({ path: shot("apps-created") });
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
