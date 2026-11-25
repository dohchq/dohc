import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test("Redo with nothing left to redo keeps a deleted paragraph deleted, in the editor and on disk", async () => {
  const path = "notes/redo.md";
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path, contents: "# Title\n\nStart line.\n\nDoomed block.\n\nEnd line.\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, temp);
    await explorerRow(page, "notes").click();
    await explorerRow(page, path).click();
    await expect(page.getByTestId("markdown-source-toggle")).toBeVisible({ timeout: 15_000 });
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    const paragraphs = editor.locator("p");
    const edited = ["Start line.", "End line."];

    await editor.getByText("Doomed block.").click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Backspace");
    await expect(paragraphs).toHaveText(edited);

    await page.keyboard.press("ControlOrMeta+z");
    await expect(paragraphs).toHaveText(["Start line.", "Doomed block.", "End line."]);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(paragraphs).toHaveText(edited);

    for (const key of [
      "ControlOrMeta+Shift+z",
      "ControlOrMeta+Shift+z",
      "ControlOrMeta+Shift+Z",
      "ControlOrMeta+y",
    ]) {
      await page.keyboard.press(key);
      expect(await paragraphs.allTextContents()).toEqual(edited);
    }

    await expect
      .poll(() => readFile(join(temp.rootPath, path), "utf8"), { timeout: 20_000 })
      .toMatch(/^# Title\r?\n\r?\nStart line\.\r?\n\r?\nEnd line\.\s*$/);
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
