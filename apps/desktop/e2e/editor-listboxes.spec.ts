import { expect, test, type Locator, type Page } from "@playwright/test";
import { activityPin } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// The editor's listboxes and the chat mention list are taller than their
// caps, so they scroll. The editor or the composer keeps focus while the
// arrows move the active option, and that option must stay in view. This
// needs real layout, so it lives in e2e. Each list is also captured in both
// themes, into the test's output folder.

const PAGES = Array.from({ length: 14 }, (_, index) => `page-${String(index + 1).padStart(2, "0")}.md`);

async function inView(row: Locator, list: Locator): Promise<boolean> {
  const [rowBox, listBox] = await Promise.all([row.boundingBox(), list.boundingBox()]);
  if (!rowBox || !listBox) return false;
  return rowBox.y >= listBox.y - 0.5 && rowBox.y + rowBox.height <= listBox.y + listBox.height + 0.5;
}

async function scrolls(list: Locator): Promise<boolean> {
  return list.evaluate((element) => element.scrollHeight > element.clientHeight);
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
}

async function capture(page: Page, list: Locator, name: string): Promise<void> {
  const box = await list.boundingBox();
  if (!box) throw new Error(`${name} has no box`);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.screenshot({
      path: test.info().outputPath(`${name}-${theme}.png`),
      clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: box.width + 48, height: box.height + 48 },
    });
  }
  await setTheme(page, "light");
}

// The arrows wrap from the first option to the last, which starts out of view.
async function expectLastRevealed(page: Page, list: Locator): Promise<void> {
  const last = list.getByRole("option").last();
  expect(await scrolls(list)).toBe(true);
  expect(await inView(last, list)).toBe(false);
  await page.keyboard.press("ArrowUp");
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => inView(last, list)).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => inView(list.getByRole("option").first(), list)).toBe(true);
}

test("the editor's listboxes keep the option Enter acts on in view as the arrows move it", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "plan.md", contents: "# Plan\n\nA paragraph to act on.\n\n" },
      ...PAGES.map((path) => ({ path, contents: `# ${path}\n` })),
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1300, 850));
    await page.emulateMedia({ reducedMotion: "reduce" });
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, PAGES.at(-1)!);
    await explorerRow(page, "plan.md").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.locator("p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");

    const slash = page.getByRole("listbox", { name: "slash commands" });
    await page.keyboard.type("/");
    await expect(slash).toBeVisible();
    await capture(page, slash, "slash-menu");
    await expectLastRevealed(page, slash);
    // Each list closes with its trigger text, as editor-slash-menu leaves it.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    await expect(slash).toBeHidden();

    const pages = page.getByRole("listbox", { name: "page links" });
    await page.keyboard.type("@");
    await expect(pages.getByRole("option")).toHaveCount(12);
    await capture(page, pages, "page-links");
    await expectLastRevealed(page, pages);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    await expect(pages).toBeHidden();

    const emoji = page.getByRole("listbox", { name: "emoji" });
    await page.keyboard.type(" :he");
    await expect(emoji).toBeVisible();
    await capture(page, emoji, "emoji-picker");
    await expectLastRevealed(page, emoji);
    await page.keyboard.press("Escape");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
    await expect(emoji).toBeHidden();

    // The selection toolbar's turn-into list fits under its cap here; it is
    // captured for its recipe, and the toolbar and its link form for the
    // frame they share. Escape keeps the selection, so the link form opens
    // on it.
    await editor.getByText("A paragraph to act on.").click({ clickCount: 3 });
    const toolbar = page.locator(".dohc-bubble-menu");
    await expect(toolbar).toBeVisible();
    await capture(page, toolbar, "selection-toolbar");
    await toolbar.getByTitle("Turn into").click();
    const turnInto = page.getByRole("listbox", { name: "turn into" });
    await expect(turnInto).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(turnInto.getByRole("option").nth(2)).toHaveAttribute("aria-selected", "true");
    await capture(page, turnInto, "turn-into");
    await page.keyboard.press("Escape");
    await expect(turnInto).toBeHidden();
    // Escape hands focus back to the editor on the next frame.
    await expect(editor).toBeFocused();
    await page.keyboard.press("ControlOrMeta+k");
    const linkForm = page.locator(".dohc-link-menu");
    await expect(linkForm).toBeVisible();
    await capture(page, linkForm, "link-form");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// An IME takes Enter, Tab, Escape and the arrows for its candidate list while
// it composes. Chromium hands those keys to the page with keyCode 229, and the
// composition comes through the same input path an IME uses.
test("the page-link and emoji pickers leave keys to the IME while it composes", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "plan.md", contents: "# Plan\n\nA paragraph to act on.\n\n" },
      { path: "roadmap.md", contents: "# Roadmap\n" },
      { path: "roads.md", contents: "# Roads\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await page.emulateMedia({ reducedMotion: "reduce" });
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "roads.md");
    await explorerRow(page, "plan.md").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.locator("p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    const line = editor.locator("p").nth(1);

    const cdp = await page.context().newCDPSession(page);
    const compose = (text: string) =>
      cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    const commit = (text: string) => cdp.send("Input.insertText", { text });
    // The editor records each key that reaches it while composing, and
    // whether anything consumed it on the way.
    type Recording = HTMLElement & { composingKeys: string[] };
    await editor.evaluate((element) => {
      const keys: string[] = [];
      (element as Recording).composingKeys = keys;
      (element as Recording).addEventListener("keydown", (event) => {
        if (event.isComposing) keys.push(`${event.key} ${event.keyCode} ${event.defaultPrevented}`);
      });
    });
    async function pressComposing(keys: string[]): Promise<void> {
      await editor.evaluate((element) => (element as Recording).composingKeys.splice(0));
      for (const key of keys) {
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: 229 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: 229 });
      }
      expect(await editor.evaluate((element) => (element as Recording).composingKeys)).toEqual(
        keys.map((key) => `${key} 229 false`),
      );
    }

    const pages = page.getByRole("listbox", { name: "page links" });
    await page.keyboard.type("@");
    await expect(pages).toBeVisible();
    await compose("ro");
    await expect(pages.getByRole("option")).toHaveCount(2);
    await pressComposing(["Enter", "ArrowDown", "Escape"]);
    await expect(pages.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await expect(line).toHaveText("@ro");
    await expect(editor.locator(".dohc-wikilink-pill")).toHaveCount(0);
    await commit("ro");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(pages).toBeHidden();
    const pill = line.locator(".dohc-wikilink-pill");
    await expect(pill).toHaveAttribute("data-dohc-wikilink", "roads");
    const label = await pill.textContent();

    const emoji = page.getByRole("listbox", { name: "emoji" });
    await page.keyboard.type(" :");
    await compose("smi");
    await expect(emoji).toBeVisible();
    const picked = await emoji.getByRole("option").nth(1).locator("span").first().textContent();
    await pressComposing(["Enter", "Tab", "ArrowDown", "Escape"]);
    await expect(emoji.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await expect(line).toHaveText(`${label} :smi`);
    await commit("smi");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(emoji).toBeHidden();
    await expect(line).toHaveText(`${label} ${picked}`);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("the chat mention list keeps the option Enter acts on in view as the arrows move it", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, PAGES.map((path) => ({ path, contents: `# ${path}\n` })));
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await page.emulateMedia({ reducedMotion: "reduce" });
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, PAGES.at(-1)!);
    await page.getByTestId(activityPin("chats")).click();
    await page.getByTestId("chats-channel").click();
    await page.getByTestId("chats-new-thread-composer").fill("Mentions");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    const composer = page.locator("main").getByTestId("chats-composer");
    await composer.fill("@");
    const menu = page.locator("main").getByTestId("chats-mention-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("chats-file-mention-option")).toHaveCount(6);
    await capture(page, menu, "chat-mentions");
    const options = menu.locator('[role="option"]');
    const last = options.last();
    expect(await scrolls(menu)).toBe(true);
    expect(await inView(last, menu)).toBe(false);
    await page.keyboard.press("ArrowUp");
    await expect(last).toHaveAttribute("aria-selected", "true");
    expect(await inView(last, menu)).toBe(true);
    await page.keyboard.press("ArrowDown");
    expect(await inView(options.first(), menu)).toBe(true);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
