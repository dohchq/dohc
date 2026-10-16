import { holdSystemClipboard } from "./helpers/systemClipboard";
import { test, expect } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// Offers show up after a person acts, in space already there. Each one is
// driven here the way a person reaches it.

// A folder becomes an app when its entry file appears, written by anything:
// an agent, a script, another editor. The folder's row says so, and the
// entry file's tab row offers Run, which opens the local preview.
test("@offers an outside write makes a folder an app, and Run opens it", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: "site/notes.md", contents: "# Notes\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    // Expanding the folder asks main about it.
    const folder = explorerRow(page, "site");
    await folder.click();
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    await expect(explorerRow(page, "site/notes.md")).toBeVisible();
    await expect(folder).not.toHaveAttribute("data-app");

    const sentinel = "Written from outside dohc.";
    await writeWorkspaceFiles(temp, [
      { path: "site/index.html", contents: `<!doctype html><title>Site</title><main>${sentinel}</main>` },
    ]);
    await expect(folder).toHaveAttribute("data-app", "true");
    // Still a tree row: it keeps its name and its expansion.
    await expect(page.getByRole("treeitem", { name: "site" })).toHaveAttribute("aria-expanded", "true");

    // Only the entry file offers Run.
    await explorerRow(page, "site/notes.md").click();
    await expect(page.getByTestId("markdown-editor")).toBeVisible();
    await expect(page.getByTestId("file-run-app")).toHaveCount(0);
    await explorerRow(page, "site/index.html").click();
    const run = page.getByRole("button", { name: "Run app" });
    await run.click();
    await expect(
      page.frameLocator('[data-testid="site-preview-frame"]').locator("main"),
    ).toHaveText(sentinel);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// A URL pasted on its own line raises one row under it. A pasted URL is
// already a link, so Link is the current form: choosing it closes the row and
// changes nothing. Plain text is one edit, which the row's Undo takes back.
// All of it is the keyboard: Mod+K reaches the row, and focus returns to the
// editor each time the row closes.
test("@offers a pasted URL offers Link and Plain text, and Undo, from the keyboard", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const url = "https://example.com/trip/itinerary";
  try {
    await writeWorkspaceFiles(temp, [{ path: "plan.md", contents: "# Plan\n\nThe itinerary:\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await explorerRow(page, "plan.md").click();
    // The engine session is bound once its source toggle is in the header.
    await expect(page.getByTestId("markdown-source-toggle")).toBeVisible();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toHaveAttribute("contenteditable", "true");

    const link = editor.locator(`a[href="${url}"]`);
    const row = page.getByTestId("url-paste-offer");
    const pasteOnNewLine = async () => {
      await holdSystemClipboard(test.info(), async (remainingMs) => {
        await desktop!.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), url);
        await editor.click({ timeout: remainingMs() });
        await page.keyboard.press("Control+End");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Control+V");
        await expect(row).toBeVisible({ timeout: remainingMs() });
      });
    };

    // Plain text, then Undo.
    await pasteOnNewLine();
    await expect(link).toHaveCount(1);
    await expect(page.getByTestId("url-paste-link")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Control+K");
    await expect(page.getByTestId("url-paste-link")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("url-paste-plain")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(link).toHaveCount(0);
    await expect(editor).toContainText(url);
    await expect(page.getByTestId("url-paste-undo")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(link).toHaveCount(1);
    await expect(row).toHaveCount(0);
    await expect(editor).toBeFocused();

    // Link, the current form: the row closes and nothing changes.
    await pasteOnNewLine();
    await expect(link).toHaveCount(2);
    await page.keyboard.press("Control+K");
    await expect(page.getByTestId("url-paste-link")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(row).toHaveCount(0);
    await expect(link).toHaveCount(2);
    await expect(editor).toBeFocused();

    // Typing dismisses it, and the keys land in the document.
    await pasteOnNewLine();
    await page.keyboard.type(" ok");
    await expect(row).toHaveCount(0);
    await expect(editor).toContainText(`${url} ok`);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
