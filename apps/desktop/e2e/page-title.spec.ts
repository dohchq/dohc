import { holdSystemClipboard } from "./helpers/systemClipboard";
import { DOCUMENT_START, DOCUMENT_END } from "./helpers/keys";
import { test, expect, type Locator } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const TITLE =
  "A deliberately long page title that keeps going well past the width of a narrow pane";

function caret(title: Locator, timeout?: number) {
  return title.evaluate(
    (element: HTMLTextAreaElement) => ({
      start: element.selectionStart,
      end: element.selectionEnd,
      focused: document.activeElement === element,
    }),
    undefined,
    { timeout },
  );
}

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
    await desktop.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(900, 700),
    );

    await explorerRow(page, "long.md").click();
    const title = page.getByTestId("page-title");
    await expect(title).toHaveValue(TITLE, { timeout: 20_000 });
    await expect
      .poll(() =>
        title.evaluate(
          (element) =>
            element.getBoundingClientRect().height /
            parseFloat(getComputedStyle(element).lineHeight),
        ),
      )
      .toBeGreaterThan(1.5);

    // The body editor settles its collaboration state after it opens. A
    // handoff before that can be dropped, for Enter as for ArrowDown.
    await expect(page.locator(".dohc-tiptap-editor")).toHaveAttribute(
      "data-collab-state",
      "disabled",
    );

    await title.click();
    await page.keyboard.press(DOCUMENT_START);
    await page.keyboard.press("ArrowDown");
    const moved = await caret(title);
    expect(moved.focused).toBe(true);
    expect(moved.start).toBeGreaterThan(0);

    await page.keyboard.press(DOCUMENT_START);
    await page.keyboard.press("Shift+ArrowDown");
    const selected = await caret(title);
    expect(selected.focused).toBe(true);
    expect(selected.end).toBeGreaterThan(selected.start);

    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("markdown-editor")).toBeFocused();

    await holdSystemClipboard(test.info(), async (remainingMs) => {
      await desktop!.app.evaluate(({ clipboard }) => clipboard.writeText("short\nand "));
      await title.click({ timeout: remainingMs() });
      await title.evaluate(
        (element: HTMLTextAreaElement) => element.setSelectionRange(2, 2),
        undefined,
        { timeout: remainingMs() },
      );
      await page.keyboard.press("ControlOrMeta+V");
      await expect(title).toHaveValue(`A short and ${TITLE.slice(2)}`, { timeout: remainingMs() });
      expect(await caret(title, remainingMs())).toMatchObject({
        start: "A short and ".length,
        focused: true,
      });
    });
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("a click on + while the empty folded title has focus adds a property", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [{ path: "plan.md", contents: "# Plan\n\nBody text.\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await explorerRow(page, "plan.md").click();
    const title = page.getByTestId("page-title");
    await expect(title).toHaveAttribute("placeholder", "Add title", { timeout: 20_000 });
    await expect(page.locator(".dohc-tiptap-editor")).toHaveAttribute(
      "data-collab-state",
      "disabled",
    );
    const add = page.getByTestId("property-add");
    const before = await add.boundingBox();

    await title.click();
    await expect(title).toBeFocused();
    await expect(title).toHaveAttribute("placeholder", "Add title");
    expect(await add.boundingBox()).toEqual(before);

    await add.click();
    await expect(page.getByTestId("property-row")).toHaveCount(1);
    await expect(page.getByTestId("property-key")).toBeFocused();
    await expect(title).toHaveAttribute("placeholder", "Add title");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// Mixed-direction text lays one line out as several boxes. The last line is
// still the last line.
test("ArrowDown leaves a mixed-direction title from its last line, and only there", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const short = "Hello שלום world";
  const long =
    "Hello שלום world, a much longer title with עברית in the middle that wraps in a narrow pane";

  try {
    await writeWorkspaceFiles(temp, [
      { path: "short.md", contents: `---\ntitle: ${short}\n---\n\nBody text.\n` },
      { path: "long.md", contents: `---\ntitle: ${long}\n---\n\nBody text.\n` },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await desktop.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(900, 700),
    );
    const title = page.getByTestId("page-title");

    await explorerRow(page, "long.md").click();
    await expect(title).toHaveValue(long, { timeout: 20_000 });
    await expect(page.locator(".dohc-tiptap-editor")).toHaveAttribute(
      "data-collab-state",
      "disabled",
    );
    await title.click();
    await page.keyboard.press(DOCUMENT_START);
    await page.keyboard.press("ArrowDown");
    expect(await caret(title)).toMatchObject({ focused: true });

    await explorerRow(page, "short.md").click();
    await expect(title).toHaveValue(short, { timeout: 20_000 });
    await expect(page.locator(".dohc-tiptap-editor")).toHaveAttribute(
      "data-collab-state",
      "disabled",
    );
    await title.click();
    await page.keyboard.press(DOCUMENT_START);
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("markdown-editor")).toBeFocused();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
