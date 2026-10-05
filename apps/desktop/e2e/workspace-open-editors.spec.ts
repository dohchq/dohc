import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// The explorer's Open Editors section is a bounded, VS Code-style pane: it
// caps its height and scrolls internally instead of growing without limit,
// and it keeps the active row inside that capped viewport — without moving
// the sidebar's outer scroll position (the list and the file tree share one
// scroll container). This needs real layout, so it lives in e2e rather than
// the jsdom shell suite.

async function rowInView(list: Locator, path: string): Promise<boolean> {
  return list.evaluate((el, target) => {
    const row = el.querySelector<HTMLElement>(`[data-path="${target}"]`);
    if (!row) return false;
    const listRect = el.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return rowRect.top >= listRect.top - 1 && rowRect.bottom <= listRect.bottom + 1;
  }, path);
}

test("open editors list caps its height and keeps the active row in view", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    const names = Array.from(
      { length: 14 },
      (_, i) => `file-${String(i + 1).padStart(2, "0")}.md`,
    );
    await writeWorkspaceFiles(
      temp,
      names.map((name) => ({ path: name, contents: `# ${name}\n\nbody\n` })),
    );

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await expect(explorerRow(page, names[0])).toBeVisible();

    for (const name of names) {
      await explorerRow(page, name).click();
      await expect(page.getByTestId(`tab-${name}`)).toBeVisible();
    }

    const list = page.getByTestId("open-editors-list");
    await expect(list.getByTestId("open-editor-row")).toHaveCount(14);

    // Bounded and internally scrollable.
    const metrics = await list.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(metrics.clientHeight).toBeLessThanOrEqual(238);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.overflowY).toBe("auto");

    // The last opened editor is active and in view; the first scrolled out.
    expect(await rowInView(list, names[13])).toBe(true);
    expect(await rowInView(list, names[0])).toBe(false);

    // Activating the first file from the tab strip scrolls its open-editors
    // row back into view — without disturbing the sidebar's outer scroll.
    const nav = page.getByTestId("file-tree");
    const navScrollBefore = await nav.evaluate((el) => el.scrollTop);
    await page.getByTestId(`tab-${names[0]}`).click();
    await expect
      .poll(async () => rowInView(list, names[0]))
      .toBe(true);
    expect(await nav.evaluate((el) => el.scrollTop)).toBe(navScrollBefore);

    // Collapse/expand keeps the section intact and the active row in view.
    await page.getByTestId("open-editors-toggle").click();
    await expect(page.getByTestId("open-editors-list")).toHaveCount(0);
    await page.getByTestId("open-editors-toggle").click();
    await expect(list.getByTestId("open-editor-row")).toHaveCount(14);
    await expect.poll(async () => rowInView(list, names[0])).toBe(true);

    // With only a few editors the list shrinks below the cap — no reserved
    // empty space, nothing to scroll.
    for (const name of names.slice(4)) {
      const row = list.locator(`[data-path="${name}"]`);
      await row.hover();
      await row.getByTestId("open-editor-close").click();
    }
    await expect(list.getByTestId("open-editor-row")).toHaveCount(4);
    const small = await list.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    expect(small.scrollHeight).toBeLessThanOrEqual(small.clientHeight);
    expect(small.clientHeight).toBeLessThan(238);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// Scrolls `scroller` so `element`'s top or bottom edge meets the scroller's.
async function scrollFlush(scroller: Locator, element: Locator, edge: "top" | "bottom"): Promise<void> {
  const target = await element.elementHandle();
  await scroller.evaluate(
    (el, { node, side }) => {
      const box = el.getBoundingClientRect();
      const rect = (node as HTMLElement).getBoundingClientRect();
      el.scrollTop += side === "top" ? rect.top - box.top : rect.bottom - box.bottom;
    },
    { node: target, side: edge },
  );
}

// Where the focused element's outline reaches: its own box grown by the
// outline's offset plus its width, or not at all when the outline is inset.
async function outlineInside(element: Locator, scroller: Locator): Promise<string> {
  const box = await scroller.elementHandle();
  return element.evaluate((node, scrollerNode) => {
    const style = getComputedStyle(node);
    if (!node.matches(":focus-visible") || style.outlineStyle === "none") return "no focus outline";
    const reach = Math.max(0, Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth));
    const rect = node.getBoundingClientRect();
    const frame = (scrollerNode as HTMLElement).getBoundingClientRect();
    const inside =
      rect.top - reach >= frame.top - 0.5 &&
      rect.bottom + reach <= frame.bottom + 0.5 &&
      rect.left - reach >= frame.left - 0.5 &&
      rect.right + reach <= frame.right + 0.5;
    return inside ? "inside" : `outside: reach ${reach}, element ${rect.top}-${rect.bottom}, scroller ${frame.top}-${frame.bottom}`;
  }, box);
}

async function flushAt(scroller: Locator, element: Locator, edge: "top" | "bottom"): Promise<number> {
  const target = await element.elementHandle();
  return scroller.evaluate(
    (el, { node, side }) => {
      const box = el.getBoundingClientRect();
      const rect = (node as HTMLElement).getBoundingClientRect();
      return Math.abs(side === "top" ? rect.top - box.top : rect.bottom - box.bottom);
    },
    { node: target, side: edge },
  );
}

test("a focused row scrolled flush to its list's edge keeps its whole focus outline", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    // Enough files that the sidebar scrolls, and enough open that the Open
    // editors list scrolls inside it.
    const names = Array.from({ length: 80 }, (_, i) => `file-${String(i + 1).padStart(2, "0")}.md`);
    await writeWorkspaceFiles(temp, names.map((name) => ({ path: name, contents: `# ${name}\n` })));
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    const opened = names.slice(0, 12);
    for (const name of opened) {
      await explorerRow(page, name).click();
      await expect(page.getByTestId(`tab-${name}`)).toBeVisible();
    }

    // An Open editors row, reached from the keyboard, at each edge of its list.
    const list = page.getByTestId("open-editors-list");
    const row = list.locator(`[data-path="${opened[5]}"]`);
    const open = row.locator("button").first();
    await open.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(open).toBeFocused();
    for (const edge of ["top", "bottom"] as const) {
      await scrollFlush(list, row, edge);
      expect(await flushAt(list, row, edge), `the row meets the list's ${edge} edge`).toBeLessThan(1);
      expect(await outlineInside(open, list), `open editor row flush at the ${edge}`).toBe("inside");
    }
    // The outline covers the whole rounded row, under the close button too.
    const [rowBox, openBox] = await Promise.all([row.boundingBox(), open.boundingBox()]);
    expect(openBox?.width).toBeCloseTo(rowBox?.width ?? 0, 0);

    // A file tree row, reached from the keyboard, at each edge of the sidebar.
    const tree = page.getByTestId("file-tree");
    await explorerRow(page, names[39]).focus();
    await page.keyboard.press("ArrowDown");
    const treeRow = explorerRow(page, names[40]);
    await expect(treeRow).toBeFocused();
    for (const edge of ["top", "bottom"] as const) {
      await scrollFlush(tree, treeRow, edge);
      expect(await flushAt(tree, treeRow, edge), `the tree row meets the sidebar's ${edge} edge`).toBeLessThan(1);
      expect(await outlineInside(treeRow, tree), `tree row flush at the ${edge}`).toBe("inside");
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("the Open editors list at its smallest shows two whole rows", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    const names = Array.from({ length: 6 }, (_, i) => `file-${i + 1}.md`);
    await writeWorkspaceFiles(temp, names.map((name) => ({ path: name, contents: `# ${name}\n` })));
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    for (const name of names) {
      await explorerRow(page, name).click();
      await expect(page.getByTestId(`tab-${name}`)).toBeVisible();
    }

    // Dragged far past the minimum, the list stops at it.
    const handle = page.getByTestId("open-editors-resize");
    const box = await handle.boundingBox();
    if (!box) throw new Error("no Open editors resize handle");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 1000, { steps: 8 });
    await page.mouse.up();

    const list = page.getByTestId("open-editors-list");
    await expect.poll(() => list.evaluate((el) => el.clientHeight)).toBe(56);
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    const whole = await list.evaluate((el) => {
      const frame = el.getBoundingClientRect();
      return [...el.querySelectorAll<HTMLElement>('[data-testid="open-editor-row"]')].filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top >= frame.top - 0.5 && rect.bottom <= frame.bottom + 0.5;
      }).length;
    });
    expect(whole).toBe(2);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
