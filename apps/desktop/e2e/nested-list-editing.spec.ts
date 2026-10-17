import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace, createTempWorkspace, explorerRow,
  openWorkspaceFromFirstRun, waitForWorkspaceFile, writeWorkspaceFiles,
} from "./helpers/workspace";

test("@nested-list-editing typed nested lists survive reopen and restart", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const expected = /- parent\n {2,4}- child\n {4,8}- grandchild/;
  try {
    await writeWorkspaceFiles(workspace, [
      { path: "nested.md", contents: "" }, { path: "other.md", contents: "Other document.\n" },
    ]);
    desktop = await launchDesktopApp({ workspace });
    let page = desktop.page;
    const opened = await openWorkspaceFromFirstRun(page, workspace);
    await waitForWorkspaceFile(page, opened.workspaceId, "nested.md");
    await explorerRow(page, "nested.md").click();
    let editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type("- parent");
    await page.keyboard.press("Enter");
    await page.keyboard.type("child");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.keyboard.type("grandchild");
    await page.keyboard.press("Tab");
    await expect(editor.locator("li li li")).toHaveText("grandchild");
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
    await expect.poll(() => readFile(join(workspace.rootPath, "nested.md"), "utf8")).toMatch(expected);

    // Close the tab so reopen cannot reuse its mounted editor.
    const tab = page.getByRole("tab", { name: /nested/ });
    await tab.getByRole("button", { name: /close/i }).click();
    await explorerRow(page, "other.md").click();
    await expect(page.getByTestId("markdown-editor")).toContainText("Other document.");
    await explorerRow(page, "nested.md").click();
    editor = page.getByTestId("markdown-editor");
    await expect(editor.locator("li li li")).toHaveText("grandchild");
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      await expect(editor.locator("li li li")).toHaveText("grandchild");
      const indent = await editor.evaluate(root => {
        const rows = [...root.querySelectorAll("li > p")].map(node => node.getBoundingClientRect().left);
        return rows[1]! > rows[0]! && rows[2]! > rows[1]!;
      });
      expect(indent).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`nested-list-${theme}-reduced-motion.png`) });
    }
    await desktop.close(); desktop = null;
    desktop = await launchDesktopApp({ workspace }); page = desktop.page;
    await openWorkspaceFromFirstRun(page, workspace);
    await waitForWorkspaceFile(page, opened.workspaceId, "nested.md");
    await explorerRow(page, "nested.md").click();
    await expect(page.getByTestId("markdown-editor").locator("li li li")).toHaveText("grandchild");
    expect(await readFile(join(workspace.rootPath, "nested.md"), "utf8")).toMatch(expected);
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});
