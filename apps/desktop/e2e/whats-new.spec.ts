import { expect, test, type Page } from "@playwright/test";
import { editorTabTestId } from "../src/testPins";
import { WHATS_NEW_TAB_PATH } from "../src/renderer/workbench/workbenchState";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun } from "./helpers/workspace";

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    await page.screenshot({ path: test.info().outputPath(`${name}-${theme}.png`) });
  }
}

test("@whats-new What's new opens once after an update brings new notes", async () => {
  // Three launches of the app.
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const tab = (page: Page) => page.getByTestId(editorTabTestId(WHATS_NEW_TAB_PATH));
  const ready = async (page: Page) => {
    await openWorkspaceFromFirstRun(page, workspace);
    await expect(page.getByTestId("workspace-shell")).toHaveAttribute("data-ready", "true");
    await page.emulateMedia({ reducedMotion: "reduce" });
  };
  try {
    // A new install starts on the person's work.
    desktop = await launchDesktopApp({ workspace });
    await ready(desktop.page);
    await expect(desktop.page.getByTestId("whats-new-page")).toHaveCount(0);
    // As if the previous version had shown older notes.
    await desktop.page.evaluate(() => localStorage.setItem("dohc.whatsNew.seen", "an-older-release"));
    await desktop.close();

    desktop = await launchDesktopApp({ workspace });
    await ready(desktop.page);
    await expect(desktop.page.getByTestId("whats-new-page")).toBeVisible();
    await expect(tab(desktop.page)).toBeVisible();
    await shoot(desktop.page, "whats-new");
    await tab(desktop.page).getByRole("button", { name: "Close What's new" }).click();
    await expect(tab(desktop.page)).toHaveCount(0);
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    await desktop.close();

    // Seen: the next launch opens nothing, and the palette still reopens it.
    desktop = await launchDesktopApp({ workspace });
    await ready(desktop.page);
    await expect(desktop.page.getByTestId("whats-new-page")).toHaveCount(0);
    await desktop.page.keyboard.press("ControlOrMeta+k");
    const option = desktop.page.getByTestId("command-palette").getByRole("option", { name: "What's new", exact: true });
    await expect(option).toBeVisible();
    await shoot(desktop.page, "whats-new-palette");
    await option.click();
    await expect(desktop.page.getByTestId("whats-new-page")).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
