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
