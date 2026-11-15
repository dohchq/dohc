import { DOCUMENT_END, DOCUMENT_START, LINE_END } from "./helpers/keys";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { LARGE_NOTE_SECTIONS, largeNote } from "./helpers/largeNotes";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "./helpers/workspace";

// The editor skips the layout of blocks away from the viewport (styles.css).
// The browser cannot place a caret in a skipped block, or scroll exactly to
// one it has only an estimated size for. These flows move the caret and the
// view into blocks that have never been drawn.

const PARAGRAPHS = 600;
const paragraph = (index: number) => `Paragraph ${String(index).padStart(3, "0")}.`;
const LAST = "Last line of the note.";
const NOTE =
  [
    "# Long note",
    ...Array.from({ length: PARAGRAPHS }, (_, index) =>
      index % 50 === 0 ? `## Part ${index / 50}\n\n${paragraph(index)}` : paragraph(index),
    ),
    LAST,
  ].join("\n\n") + "\n";

async function withLongNote(
  body: (page: Page, editor: Locator, temp: TempWorkspace) => Promise<void>,
): Promise<void> {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: "long.md", contents: NOTE }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await desktop.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1500, 900),
    );
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "long.md");
    await explorerRow(page, "long.md").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
    await expect(editor.locator("p")).toHaveCount(PARAGRAPHS + 1, { timeout: 20_000 });
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
    await body(page, editor, temp);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
}

/** Whether the middle of the block is inside the window. */
const shown = (block: Locator) =>
  block.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const middle = (box.top + box.bottom) / 2;
    return box.height > 0 && middle >= 0 && middle <= window.innerHeight;
  });

const block = (editor: Locator, tag: string, text: string | RegExp) =>
  editor.locator(tag).filter({ hasText: text });

test("the caret keys reach and type in blocks of a long note that were never drawn", async () => {
  test.setTimeout(120_000);
  await withLongNote(async (page, editor, temp) => {
    await block(editor, "p", paragraph(0)).click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type(" END");
    const last = editor.locator("p").last();
    await expect(last).toHaveText(`${LAST} END`);
    await expect.poll(() => shown(last)).toBe(true);

    await page.keyboard.press(DOCUMENT_START);
    await page.keyboard.press(LINE_END);
    await page.keyboard.type(" TOP");
    await expect(editor.locator("h1")).toHaveText("Long note TOP");
    await expect.poll(() => shown(editor.locator("h1"))).toBe(true);

    // One line down at a time, through 40 one-line paragraphs.
    await block(editor, "p", paragraph(0)).click();
    await page.keyboard.press(LINE_END);
    for (let line = 0; line < 40; line += 1) await page.keyboard.press("ArrowDown");
    await page.keyboard.type("!");
    await expect(block(editor, "p", "!")).toHaveText(`${paragraph(40)}!`);

    // A page down at a time, well past what the open note first drew.
    for (let pages = 0; pages < 8; pages += 1) await page.keyboard.press("PageDown");
    await page.keyboard.type("#");
    // The key lands in one paragraph, in one piece, at the column the page keys kept.
    const paged = block(editor, "p", "#");
    await expect(paged).toHaveCount(1);
    const typedIn = ((await paged.textContent()) ?? "").replace("#", "");
    expect(typedIn).toMatch(/^Paragraph \d{3}\.$/);
    expect(Number(/\d{3}/.exec(typedIn)?.[0])).toBeGreaterThan(100);
    await expect.poll(() => shown(paged)).toBe(true);

    await expect
      .poll(() => readFile(join(temp.rootPath, "long.md"), "utf8"), { timeout: 30_000 })
      .toMatch(/^# Long note TOP\r?\n[\s\S]*Last line of the note\. END\s*$/);
  });
});

test("find and the outline show a block of a long note that was never drawn", async () => {
  test.setTimeout(120_000);
  await withLongNote(async (page, editor) => {
    await block(editor, "p", paragraph(0)).click();
    await page.keyboard.press("ControlOrMeta+f");
    const find = page.getByRole("search", { name: "find and replace" });
    await find.getByPlaceholder("Find").fill(paragraph(577));
    await page.keyboard.press("Enter");
    await expect.poll(() => shown(block(editor, "p", paragraph(577)))).toBe(true);
    await page.keyboard.press("Escape");

    // The outline's list opens while the pointer is over its rail.
    const outline = page.getByRole("navigation", { name: "Document outline" });
    for (const part of ["Part 9", "Part 2", "Part 11"]) {
      await outline.locator(".dohc-outline-rail").hover();
      await outline.getByRole("button", { name: part, exact: true }).click();
      await expect.poll(() => shown(block(editor, "h2", new RegExp(`^${part}$`)))).toBe(true);
    }
  });
});

/** The median time from a key going down to the second frame after its text shows, over 20 keys. */
async function keyTime(page: Page, editor: Locator): Promise<number> {
  const times: number[] = [];
  for (let key = 0; key < 25; key += 1) {
    await editor.evaluate((element) => {
      (window as Window & { keyShown?: Promise<number> }).keyShown = new Promise((resolve) => {
        let down = 0;
        element.addEventListener("keydown", () => (down = performance.now()), {
          once: true,
          capture: true,
        });
        element.addEventListener(
          "input",
          () =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(performance.now() - down)),
            ),
          { once: true },
        );
      });
    });
    await page.keyboard.press("x");
    const shown = await page.evaluate(
      () => (window as Window & { keyShown?: Promise<number> }).keyShown!,
    );
    // The first keys after a note opens pay for work the rest do not.
    if (key >= 5) times.push(shown);
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
}

test("a key in a note with 400 code blocks, callouts and tables costs little more than in a short note", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "small.md", contents: largeNote("small") },
      { path: "rich.md", contents: largeNote("rich") },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const editor = page.getByTestId("markdown-editor");
    const typeIn = async (path: string, headings: number) => {
      await waitForWorkspaceFile(page, workspace.workspaceId, path);
      await explorerRow(page, path).click({ timeout: 120_000 });
      await expect(editor.locator("h2")).toHaveCount(headings, { timeout: 120_000 });
      await expect(editor).toHaveAttribute("contenteditable", "true");
      await editor
        .locator("h2")
        .nth(Math.floor(headings / 2))
        .locator("xpath=following-sibling::p[1]")
        .click({ timeout: 120_000 });
      await page.keyboard.press(LINE_END);
      return keyTime(page, editor);
    };
    const small = await typeIn("small.md", 12);
    const rich = await typeIn("rich.md", LARGE_NOTE_SECTIONS);
    await test.info().attach("key-times.json", {
      body: JSON.stringify({ smallMs: small, richMs: rich }),
      contentType: "application/json",
    });
    // With controls on every block and every block laid out, a key in this
    // note took ten times as long as in the short one: 138 ms against 13 ms.
    // It now takes 25 to 47 ms against 14 ms. The limit sits between the two, and
    // both notes are timed in one run, so a slower computer moves both.
    expect(rich).toBeLessThan(3 * small + 40);
  } finally {
    // The debug engine took up to 50 s to save this note. The close does not
    // wait for it: the quit reaches its time limit and reports a failed close.
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
