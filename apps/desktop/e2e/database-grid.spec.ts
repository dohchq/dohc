import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { editorTabTestId } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

type SqliteFile = {
  prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined };
  close(): void;
};
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteFile;
};

// A row's value as the database file on disk holds it.
function storedStage(path: string, rowid: number): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT stage FROM funnel WHERE rowid = ?").get(rowid)?.stage;
  } finally {
    db.close();
  }
}

test("a CSV imported from its tab row opens as a database whose cells edit from the keyboard alone", async () => {
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(workspace, [
      { path: "funnel.csv", contents: "stage,count\nVisited,4820\nSigned up,1290\n" },
    ]);
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, workspace);
    await explorerRow(page, "funnel.csv").click();
    await expect(page.getByTestId("view-csv")).toBeVisible();

    // Import to SQLite, in the CSV's tab row, opens the database it makes
    // beside the CSV.
    await page.getByTestId("csv-import-sqlite").click();
    await expect(page.getByTestId(editorTabTestId("funnel.sqlite"))).toBeVisible();
    const grid = page.getByRole("grid", { name: "funnel" });
    await expect(grid).toBeVisible();
    const signedUp = grid.getByTestId("db-cell-stage-row_2");
    await expect(signedUp).toHaveText("Signed up");

    // From the search field, Tab enters the grid at its first cell, the first
    // row's id. The arrow keys move to the second row's stage, Enter opens
    // its editor, and Enter commits.
    await page.getByTestId("db-filter-input").focus();
    await page.keyboard.press("Tab");
    await expect(grid.getByTestId("db-cell-id-row_1")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(grid.getByTestId("db-cell-stage-row_1")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(signedUp).toBeFocused();
    await page.keyboard.press("Enter");
    const editor = grid.getByTestId("db-cell-input");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Signed up");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Signed up for a trial");
    await page.keyboard.press("Enter");

    await expect(editor).toHaveCount(0);
    await expect(signedUp).toHaveText("Signed up for a trial");
    await expect(signedUp).toBeFocused();
    await expect
      .poll(() => storedStage(join(workspace.rootPath, "funnel.sqlite"), 2))
      .toBe("Signed up for a trial");

    // Escape leaves a cell as it was, and Tab leaves the grid.
    await page.keyboard.press("ArrowUp");
    await expect(grid.getByTestId("db-cell-stage-row_1")).toBeFocused();
    await page.keyboard.press("F2");
    await page.keyboard.type(" discarded");
    await page.keyboard.press("Escape");
    await expect(grid.getByTestId("db-cell-stage-row_1")).toHaveText("Visited");
    await expect(grid.getByTestId("db-cell-stage-row_1")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(grid.locator(":focus")).toHaveCount(0);
    expect(storedStage(join(workspace.rootPath, "funnel.sqlite"), 1)).toBe("Visited");
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
