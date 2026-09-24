import { expect, test, type Locator } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const TITLE = "A deliberately long page title that keeps going well past the width of a narrow pane";

function caret(title: Locator) {
  return title.evaluate((element: HTMLTextAreaElement) => ({
    start: element.selectionStart,
    end: element.selectionEnd,
    focused: document.activeElement === element,
  }));
}

// A long title wraps in a narrow pane, and stays one line of text: ArrowDown
// moves through its lines before it moves to the body, and pasted line
// breaks become spaces.
test("a wrapped page title keeps ArrowDown, selection, and paste inside the title", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [
      { path: "long.md", contents: `---\ntitle: ${TITLE}\n---\n\nBody text.\n` },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 700));

    await explorerRow(page, "long.md").click();
    const title = page.getByTestId("page-title");
    await expect(title).toHaveValue(TITLE, { timeout: 20_000 });
    // It wraps: the field is taller than one line.
    await expect
      .poll(() =>
        title.evaluate((element) => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)),
      )
      .toBeGreaterThan(1.5);

    // The body editor settles its collaboration state after it opens. A
    // handoff before that can be dropped, for Enter as for ArrowDown.
    await expect(page.locator(".dohc-tiptap-editor")).toHaveAttribute("data-collab-state", "disabled");

    // From the first line, ArrowDown moves down the title.
    await title.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    const moved = await caret(title);
    expect(moved.focused).toBe(true);
    expect(moved.start).toBeGreaterThan(0);

    // Shift+ArrowDown selects instead of leaving.
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Shift+ArrowDown");
    const selected = await caret(title);
    expect(selected.focused).toBe(true);
    expect(selected.end).toBeGreaterThan(selected.start);

    // From the last line, ArrowDown moves to the body.
    await page.keyboard.press("Control+End");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("markdown-editor")).toBeFocused();

    // A pasted line break becomes a space, and the caret stays after the paste.
    await desktop.app.evaluate(({ clipboard }) => clipboard.writeText("short\nand "));
    await title.click();
    await title.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 2));
    await page.keyboard.press("Control+V");
    await expect(title).toHaveValue(`A short and ${TITLE.slice(2)}`);
    expect(await caret(title)).toMatchObject({ start: "A short and ".length, focused: true });
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
