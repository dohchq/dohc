import { editorTabTestId } from "../src/testPins";
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

const TASKS = [
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
];

test("a collection saves edits, follows its folder rename, and closes on deletion", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "collections-continuity-e2e");
    await writeWorkspaceFiles(temp, TASKS);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    const folder = explorerRow(page, "tasks");
    await expect(folder).toHaveAttribute("data-collection", "true");
    await folder.click();
    await expect(page.getByTestId(editorTabTestId("tab://collection/tasks"))).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open Launch plan" }),
    ).toBeVisible();
    await page.getByTestId("collection-page").getByRole("checkbox").click();
    // A person may open the record while the edit saves. The edit still saves.
    await page.getByRole("button", { name: "Open Launch plan" }).click();
    await expect
      .poll(() => readFile(join(temp.rootPath, "tasks/plan.md"), "utf8"))
      .toMatch(/^Completed: true$/m);
    await expect(page.getByTestId("collection-write-failures")).toHaveCount(0);
    await page.getByTestId(editorTabTestId("tab://collection/tasks")).click();
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await folder.press("F2");
    const rename = page.getByRole("textbox", { name: "New name" });
    await rename.fill("jobs");
    await rename.press("Enter");
    await expect(explorerRow(page, "jobs")).toBeVisible();
    const renamedTab = page.getByTestId(editorTabTestId("tab://collection/jobs"));
    await expect(renamedTab).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId(editorTabTestId("tab://collection/tasks"))).toHaveCount(0);
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

test("a cell edit saves while its record is open in another editor group", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "collections-open-record-e2e");
    await writeWorkspaceFiles(temp, TASKS);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    const group = (number: number) => page.getByRole("region", { name: `Editor group ${number}` });
    // The Collection in group 1, and its record live in group 2.
    await explorerRow(page, "tasks").click();
    await expect(page.getByTestId(editorTabTestId("tab://collection/tasks"))).toBeVisible();
    await page.getByRole("button", { name: "Open Launch plan" }).click();
    await expect(page.getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true");
    await page.getByTestId("create-editor-group-right").click();
    await expect(group(2).getByTestId(editorTabTestId("tasks/plan.md"))).toBeVisible();
    await group(1).getByTestId(editorTabTestId("tab://collection/tasks")).click();
    await expect(group(1).getByTestId("collection-page")).toBeVisible();
    await expect(group(2).getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true");

    await group(1).getByTestId("collection-page").getByRole("checkbox").click();
    await expect
      .poll(() => readFile(join(temp.rootPath, "tasks/plan.md"), "utf8"))
      .toMatch(/^Completed: true$/m);
    await expect(page.getByTestId("collection-write-failures")).toHaveCount(0);
    await expect(group(2).getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
