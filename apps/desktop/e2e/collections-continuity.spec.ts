import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test("a collection saves edits, follows its folder rename, and closes on deletion", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "collections-continuity-e2e");
    await writeWorkspaceFiles(temp, [
      {
        path: "tasks/collection.yaml",
        contents: `name: Tasks
fields:
  Name:
    type: text
  Status:
    type: select
    options: [Todo, Done]
  Completed:
    type: checkbox
views:
  - name: Table
    kind: table
  - name: Board
    kind: board
    groupBy: Status
`,
      },
      {
        path: "tasks/plan.md",
        contents: "---\nName: Launch plan\nStatus: Todo\nCompleted: false\n---\n# Launch plan\n",
      },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    const folder = explorerRow(page, "tasks");
    await expect(folder).toHaveAttribute("data-collection", "true");
    await folder.click();
    await expect(page.getByTestId("tab-dohc://collection/tasks")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open Launch plan" }),
    ).toBeVisible();
    await page.getByTestId("collection-page").getByRole("checkbox").click();
    await page.getByRole("button", { name: "Open Launch plan" }).click();
    await expect
      .poll(() => readFile(join(temp.rootPath, "tasks/plan.md"), "utf8"))
      .toMatch(/^Completed: true$/m);
    await page.getByTestId("tab-dohc://collection/tasks").click();
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await folder.press("F2");
    const rename = page.getByRole("textbox", { name: "New name" });
    await rename.fill("jobs");
    await rename.press("Enter");
    await expect(explorerRow(page, "jobs")).toBeVisible();
    const renamedTab = page.getByTestId("tab-dohc://collection/jobs");
    await expect(renamedTab).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("tab-dohc://collection/tasks")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Todo", exact: true })).toBeVisible();
    await explorerRow(page, "jobs").click();
    await expect(renamedTab).toHaveCount(1);
    await explorerRow(page, "jobs").press("Delete");
    await page.getByTestId("confirm-delete").click();
    await expect(explorerRow(page, "jobs")).toHaveCount(0);
    await expect(renamedTab).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
