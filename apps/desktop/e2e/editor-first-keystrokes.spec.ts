import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
} from "./helpers/workspace";

// Focus that arrives by Tab reaches the editor without a DOM selection. The
// editor has to place the caret itself, or the first line typed is lost: the
// placeholder stays, and the file starts with an empty paragraph.

async function tabIntoEditor(page: Page): Promise<void> {
  const editor = page.getByTestId("markdown-editor");
  for (let presses = 0; presses < 40; presses += 1) {
    await page.keyboard.press("Tab");
    if (await editor.evaluate((node) => node === document.activeElement)) return;
  }
  throw new Error("Tab did not reach the editor within 40 presses");
}

test("a new document keeps the first line typed after Tab reaches its editor", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, temp);

    await page.keyboard.press("Control+n");
    const fileName = page.getByRole("textbox", { name: "File name" });
    await expect(fileName).toBeFocused();
    await fileName.fill("trip.md");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tab-trip.md")).toHaveAttribute("data-active", "true", {
      timeout: 15_000,
    });
    // The engine session is bound once its source toggle is in the header.
    await expect(page.getByTestId("markdown-source-toggle")).toBeVisible({ timeout: 15_000 });
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toHaveAttribute("contenteditable", "true");

    await tabIntoEditor(page);
    await page.keyboard.type("Trip to Lisbon");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Pack the charger");

    await expect(editor.locator("p").first()).toHaveText("Trip to Lisbon");
    await expect(editor).toContainText("Pack the charger");
    await expect
      .poll(() => readFile(join(temp.rootPath, "trip.md"), "utf8").catch(() => ""), {
        timeout: 20_000,
      })
      .toMatch(/^Trip to Lisbon\r?\n\r?\nPack the charger\s*$/);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
