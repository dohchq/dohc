import { expect, test, type Locator } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// The block menu is taller than its height cap, so it scrolls. The row
// Enter acts on must be in view however the keys move it. This needs real
// layout, so it lives in e2e.

async function inView(row: Locator, list: Locator): Promise<boolean> {
  const [rowBox, listBox] = await Promise.all([row.boundingBox(), list.boundingBox()]);
  if (!rowBox || !listBox) return false;
  return rowBox.y >= listBox.y - 0.5 && rowBox.y + rowBox.height <= listBox.y + listBox.height + 0.5;
}

test("the block menu keeps the row Enter acts on in view as the keys move it", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: "plan.md", contents: "# Plan\n\nA paragraph to act on.\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1300, 850));
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "plan.md");
    await explorerRow(page, "plan.md").click();
    await expect(page.getByTestId("markdown-editor")).toBeVisible({ timeout: 20_000 });

    await page.locator(".dohc-notion-editor > p").first().hover();
    // The heading is block 0; hovering the paragraph shows block 1's gutter.
    const gutter = page.locator(".dohc-block-affordance").nth(1);
    await expect(gutter).toHaveClass(/\bis-visible\b/);
    const handle = gutter.locator(".dohc-block-handle");
    await handle.click();
    const menu = page.getByRole("menu", { name: "block actions" });
    await expect(menu).toBeFocused();
    const text = menu.getByRole("menuitem", { name: "Text" });
    const remove = menu.getByRole("menuitem", { name: "Delete" });
    // The list scrolls: the last row starts out of view.
    expect(await menu.evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);
    expect(await inView(remove, menu)).toBe(false);

    await page.keyboard.press("End");
    await expect(menu).toHaveAttribute("aria-activedescendant", (await remove.getAttribute("id")) ?? "");
    expect(await inView(remove, menu)).toBe(true);

    await page.keyboard.press("Home");
    expect(await inView(text, menu)).toBe(true);
    // The first row brings its section label along.
    expect(await inView(menu.getByText("Turn into", { exact: true }), menu)).toBe(true);

    await page.keyboard.press("ArrowUp");
    expect(await inView(remove, menu)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(handle).toBeFocused();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
