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

/** Whether the middle of the element is inside the pane that scrolls the note. */
const shown = (target: Locator) =>
  target.evaluate((element) => {
    let pane = document.querySelector('[data-testid="markdown-editor"]');
    while (pane && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
    if (!pane) return false;
    const view = pane.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const middle = (box.top + box.bottom) / 2;
    return box.height > 0 && middle >= view.top && middle <= view.bottom;
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

    // Each of the four edits reaches the file, in the paragraph it was typed in.
    const pagedText = (await paged.textContent()) ?? "";
    await expect
      .poll(
        async () => {
          const saved = await readFile(join(temp.rootPath, "long.md"), "utf8");
          const lines = saved.split(/\r?\n/);
          return {
            top: lines[0] === "# Long note TOP",
            line: lines.includes(`${paragraph(40)}!`),
            page: lines.includes(pagedText),
            end: saved.trimEnd().endsWith(`${LAST} END`),
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({ top: true, line: true, page: true, end: true });
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

// What draws around a far match is taller than its estimate, and a diagram
// among it draws a few frames later. Each moved the match out of the pane.
test("find shows a match far down a note of code blocks, callouts and tables", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: "rich.md", contents: largeNote("rich") }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "rich.md");
    await explorerRow(page, "rich.md").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor.locator("h2")).toHaveCount(LARGE_NOTE_SECTIONS, { timeout: 120_000 });
    await editor.locator("p").first().click();
    const find = page.getByRole("search", { name: "find and replace" });
    // In a paragraph, in a code block, and in a table, each in another part of the note.
    for (const text of ["Section 377 keeps", "compute388", "next 201"]) {
      await page.keyboard.press("ControlOrMeta+f");
      await find.getByPlaceholder("Find").fill(text);
      const match = editor.locator(".dohc-find-match--active");
      await expect(match).toHaveText(text);
      await expect.poll(() => shown(match)).toBe(true);
      // A diagram above the match draws up to a second after the jump, and
      // moved the match out of the pane. It is still shown then.
      await page.waitForTimeout(1_000);
      expect(await shown(match)).toBe(true);
      await page.keyboard.press("Escape");
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// A diagram is drawn when it comes near what shows. Drawing all of a long
// note's diagrams as it opened kept the app busy for seconds.
test("a diagram far down a long note is drawn when the note is brought to it", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: "rich.md", contents: largeNote("rich") }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "rich.md");
    await explorerRow(page, "rich.md").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor.locator("h2")).toHaveCount(LARGE_NOTE_SECTIONS, { timeout: 120_000 });
    // Every fifth section has a diagram: the first is on screen as the note opens.
    const diagram = (section: number) =>
      editor
        .locator(".dohc-mermaid-preview")
        .nth(section / 5)
        .locator("svg");
    await expect(diagram(0)).toHaveCount(1);

    const outline = page.getByRole("navigation", { name: "Document outline" });
    await outline.locator(".dohc-outline-rail").hover();
    await outline.getByRole("button", { name: "Heading 300", exact: true }).click();
    await expect(diagram(300)).toHaveCount(1);
    await expect.poll(() => shown(diagram(300))).toBe(true);
    // One between the two was never near, and stays undrawn.
    await expect(diagram(150)).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

/**
 * The time from each of 25 keys going down to the second frame after its text
 * shows: the median of the last 20, and the first five, which also pay for
 * what the note draws around a caret placed in it for the first time.
 */
async function keyTime(page: Page, editor: Locator): Promise<{ median: number; first: number[] }> {
  const times: number[] = [];
  for (let key = 0; key < 25; key += 1) {
    await editor.evaluate((element) => {
      (window as Window & { keyShown?: Promise<number> }).keyShown = new Promise((resolve) => {
        // From when the key was pressed, which is before any handler ran.
        let down = 0;
        element.addEventListener("keydown", (event) => (down = event.timeStamp), {
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
    times.push(shown);
  }
  const later = times.slice(5).sort((a, b) => a - b);
  return { median: later[Math.floor(later.length / 2)]!, first: times.slice(0, 5) };
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
    // A program that reads the window through the accessibility tree, as some
    // on a developer's computer do, keeps the app busy for seconds after a
    // long note opens, and a key waits behind it. This times the editor alone.
    desktop = await launchDesktopApp({
      workspace: temp,
      switches: ["--disable-renderer-accessibility"],
    });
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
      body: JSON.stringify({ small, rich }),
      contentType: "application/json",
    });
    // With controls on every block and every block laid out, a key in this
    // note took ten times as long as in the short one: 138 ms against 13 ms.
    // It now takes 25 to 47 ms against 14 ms. The limit sits between the two, and
    // both notes are timed in one run, so a slower computer moves both.
    expect(rich.median).toBeLessThan(3 * small.median + 40);
  } finally {
    // The debug engine took up to 50 s to save this note. The close does not
    // wait for it: the quit reaches its time limit and reports a failed close.
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
