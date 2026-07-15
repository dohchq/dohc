import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const TABLE_DOC = `# Table interactions

The table controls need their own clear working space.

| A | B | C | D | E | F | G | H |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Row one | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| Row two | 8 | 9 | 10 | 11 | 12 | 13 | 14 |
| Row three | 15 | 16 | 17 | 18 | 19 | 20 | 21 |
`;

test("table width, scrolling, row resizing, and reorder previews stay stable", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: "notes/table-interactions.md", contents: TABLE_DOC },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { app, page } = desktop;
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1300, 850);
    });

    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(
      page,
      workspace.workspaceId,
      "notes/table-interactions.md",
    );
    await explorerRow(page, "notes").click();
    await explorerRow(page, "notes/table-interactions.md").click();
    await expect(page.getByTestId("markdown-editor")).toBeVisible({
      timeout: 20_000,
    });

    const wrapper = page.locator(".dohc-notion-editor .tableWrapper");
    const table = wrapper.locator("table");
    await expect(table).toBeVisible();

    const geometry = await page.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>(".tableWrapper");
      const table = wrapper?.querySelector<HTMLTableElement>("table");
      const intro = document.querySelector<HTMLElement>(
        ".dohc-notion-editor > p",
      );
      if (!wrapper || !table || !intro) throw new Error("table geometry missing");
      return {
        clientWidth: wrapper.clientWidth,
        scrollWidth: wrapper.scrollWidth,
        tableTop: table.getBoundingClientRect().top,
        introBottom: intro.getBoundingClientRect().bottom,
      };
    });
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
    expect(geometry.tableTop - geometry.introBottom).toBeGreaterThanOrEqual(24);

    const firstRowCells = table.locator("tr").first().locator("th, td");
    const widthsBefore = await firstRowCells.evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width),
    );
    await firstRowCells.nth(2).click();
    const widthsAfter = await firstRowCells.evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width),
    );
    expect(widthsAfter).toHaveLength(widthsBefore.length);
    widthsAfter.forEach((width, index) => {
      expect(Math.abs(width - (widthsBefore[index] ?? width))).toBeLessThanOrEqual(
        0.5,
      );
    });

    const firstBodyCell = table.locator("tr").nth(1).locator("td").first();
    await firstBodyCell.hover();
    const columnGrip = table.locator(
      '.dohc-table-grip--col[data-table-column="0"]',
    );
    await expect(columnGrip).toHaveClass(/is-visible/);
    const handleClearance = await page.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>(".tableWrapper");
      const grip = document.querySelector<HTMLElement>(
        '.dohc-table-grip--col[data-table-column="0"]',
      );
      if (!wrapper || !grip) throw new Error("column grip missing");
      return grip.getBoundingClientRect().top - wrapper.getBoundingClientRect().top;
    });
    expect(handleClearance).toBeGreaterThanOrEqual(0);

    const firstBodyRow = table.locator("tr").nth(1);
    const resizeHandle = table.locator(
      '.dohc-table-row-resize[data-table-row-resize="1"]',
    );
    await expect(resizeHandle).toHaveClass(/is-visible/);
    const rowHeightBefore = await firstBodyRow.evaluate(
      (row) => row.getBoundingClientRect().height,
    );
    const resizeBox = await resizeHandle.boundingBox();
    if (!resizeBox) throw new Error("row resize handle has no box");
    await page.mouse.move(
      resizeBox.x + Math.min(80, resizeBox.width / 2),
      resizeBox.y + resizeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeBox.x + Math.min(80, resizeBox.width / 2),
      resizeBox.y + resizeBox.height / 2 + 32,
      { steps: 5 },
    );
    await page.mouse.up();
    const rowHeightAfter = await firstBodyRow.evaluate(
      (row) => row.getBoundingClientRect().height,
    );
    expect(rowHeightAfter - rowHeightBefore).toBeGreaterThanOrEqual(28);
    await expect(firstBodyRow).toHaveAttribute("data-row-height", /\d+/);

    await firstBodyCell.hover();
    const sourceGrip = table.locator(
      '.dohc-table-grip--row[data-table-row="1"]',
    );
    const targetCell = table.locator("tr").nth(2).locator("td").first();
    const sourceBox = await sourceGrip.boundingBox();
    const targetBox = await targetCell.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("row reorder target missing");
    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2 + 8,
      sourceBox.y + sourceBox.height / 2 + 8,
    );
    await page.mouse.move(
      targetBox.x + targetBox.width / 2,
      targetBox.y + targetBox.height * 0.75,
      { steps: 6 },
    );
    const dropIndicator = page.locator(
      ".dohc-table-drop-indicator.is-visible",
    );
    await expect(dropIndicator).toBeVisible();
    await expect(dropIndicator).toHaveAttribute("data-label", /Drop to row/);
    await page.mouse.up();
    await expect(page.locator(".dohc-table-drop-indicator")).toHaveCount(0);

    const bodyLabels = await table
      .locator("tr")
      .evaluateAll((rows) =>
        rows.slice(1).map((row) => row.querySelector("td")?.textContent?.trim()),
      );
    expect(bodyLabels.slice(0, 2)).toEqual(["Row two", "Row one"]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
