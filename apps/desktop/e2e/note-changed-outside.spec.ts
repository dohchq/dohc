import { expect, test, type Page } from "@playwright/test";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editorTabTestId } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
import { DOCUMENT_END } from "./helpers/keys";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const NOTICE = "This file changed outside dohc.";
const RECOVERED_COPY = /^(.+) \(recovered [0-9a-f]{8} [0-9a-f]{64}\)\.md$/;

async function openNote(page: Page, path: string): Promise<void> {
  await explorerRow(page, path).click();
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("markdown-editor")).toBeVisible();
}

// An agent replaces the note's file outside dohc, by rename.
async function replaceOutside(rootPath: string, path: string, text: string): Promise<void> {
  await writeFile(join(rootPath, `${path}.tmp`), text);
  await rename(join(rootPath, `${path}.tmp`), join(rootPath, path));
}

async function recoveredCopy(rootPath: string, path: string): Promise<string | null> {
  const stem = path.replace(/\.md$/, "");
  const name = (await readdir(rootPath)).find((entry) => RECOVERED_COPY.exec(entry)?.[1] === stem);
  return name ? readFile(join(rootPath, name), "utf8") : null;
}

test("an open note that changed outside dohc reloads, or keeps the person's typing in a copy @note-changed-outside", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const notes = ["untouched-light.md", "untouched-dark.md", "typed-reload.md", "typed-close.md"];
  try {
    await writeWorkspaceFiles(temp, notes.map((path) => ({ path, contents: "# Plan\n\nBase text.\n" })));
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    for (const path of notes) await waitForWorkspaceFile(page, workspace.workspaceId, path);
    await page.emulateMedia({ reducedMotion: "reduce" });

    // Nothing unsaved: the editor takes in the new text and says so for a moment.
    for (const theme of ["light", "dark"] as const) {
      const path = `untouched-${theme}.md`;
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await openNote(page, path);
      await replaceOutside(temp.rootPath, path, "# Plan\n\nWritten by an agent.\n");
      await expect(page.getByTestId("markdown-editor")).toContainText("Written by an agent.", { timeout: 30_000 });
      const chip = page.getByTestId("markdown-save-state");
      await expect(chip).toHaveAttribute("data-state", "reloaded");
      await expect(chip).toHaveText("Reloaded");
      await expect(page.getByTestId("changed-outside-notice")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`reloaded-${theme}.png`) });
      await expect(chip).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
      expect(await recoveredCopy(temp.rootPath, path)).toBeNull();
    }

    // Unsaved typing: the editor keeps it, and Reload keeps it in a copy.
    await openNote(page, "typed-reload.md");
    await page.getByTestId("markdown-editor").click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type(" Typed by me.");
    await replaceOutside(temp.rootPath, "typed-reload.md", "# Plan\n\nWritten by an agent.\n");
    const notice = page.getByTestId("changed-outside-notice");
    await expect(notice).toContainText(NOTICE, { timeout: 30_000 });
    await expect(page.getByTestId("markdown-editor")).toContainText("Typed by me.");
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.screenshot({ path: test.info().outputPath(`changed-outside-${theme}.png`) });
    }
    // Reach Reload by keyboard and activate it without a pointer.
    const reload = notice.getByRole("button", { name: "Reload" });
    for (let i = 0; i < 200 && !await reload.evaluate((node) => node === document.activeElement); i++) await page.keyboard.press("Tab");
    await expect(reload).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("markdown-editor")).toContainText("Written by an agent.", { timeout: 30_000 });
    await expect(page.getByTestId("markdown-editor")).not.toContainText("Typed by me.");
    await expect(notice).toHaveCount(0);
    await expect.poll(() => recoveredCopy(temp.rootPath, "typed-reload.md"), { timeout: 30_000 }).toContain("Typed by me.");
    expect(await readFile(join(temp.rootPath, "typed-reload.md"), "utf8")).toContain("Written by an agent.");
    await expect(page.getByTestId("workspace-shell-notice").filter({ hasText: "Text kept in History" }).first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: test.info().outputPath("reloaded-with-copy-dark.png") });

    // Unsaved typing, then the person closes the note instead.
    await openNote(page, "typed-close.md");
    await page.getByTestId("markdown-editor").click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type(" Closed by me.");
    await replaceOutside(temp.rootPath, "typed-close.md", "# Plan\n\nWritten by an agent.\n");
    await expect(page.getByTestId("changed-outside-notice")).toBeVisible({ timeout: 30_000 });
    const tab = page.getByTestId(editorTabTestId("typed-close.md"));
    await tab.hover();
    await tab.getByRole("button", { name: /^Close / }).click();
    await expect(tab).toHaveCount(0);
    await expect.poll(() => recoveredCopy(temp.rootPath, "typed-close.md"), { timeout: 30_000 }).toContain("Closed by me.");
    expect(await readFile(join(temp.rootPath, "typed-close.md"), "utf8")).toContain("Written by an agent.");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
