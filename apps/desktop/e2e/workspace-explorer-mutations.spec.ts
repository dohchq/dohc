import { expect, test } from "@playwright/test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
} from "./helpers/workspace";

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

test("Explorer creates, renames, cancels, and confirms recoverable deletion", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    const filesHeader = page.getByTestId("explorer-files-header");
    await page.keyboard.press("Control+n");
    await page.getByRole("textbox", { name: "File name" }).fill("Welcome.md");
    await page.getByRole("button", { name: "Create file" }).click();
    await expect(explorerRow(page, "Welcome.md")).toBeVisible();
    await expect.poll(() => pathExists(join(temp.rootPath, "Welcome.md"))).toBe(true);

    await filesHeader.getByRole("button", { name: "New folder" }).click();
    await page.getByRole("textbox", { name: "New folder name" }).fill("Research");
    await page.getByRole("textbox", { name: "New folder name" }).press("Enter");
    await expect(explorerRow(page, "Research")).toBeVisible();
    await expect.poll(() => pathExists(join(temp.rootPath, "Research"))).toBe(true);

    await explorerRow(page, "Research").click();
    await filesHeader.getByRole("button", { name: "New file" }).click();
    await page.getByRole("textbox", { name: "New file name" }).fill("notes.txt");
    await page.getByRole("textbox", { name: "New file name" }).press("Enter");
    await expect(explorerRow(page, "Research/notes.txt")).toBeVisible();
    await expect
      .poll(() => pathExists(join(temp.rootPath, "Research", "notes.txt")))
      .toBe(true);

    const created = explorerRow(page, "Research/notes.txt");
    await created.click();
    await created.press("F2");
    const rename = page.getByRole("textbox", { name: "New name" });
    await rename.fill("plan.txt");
    await rename.press("Enter");
    const renamed = explorerRow(page, "Research/plan.txt");
    await expect(renamed).toBeVisible();
    await expect
      .poll(() => pathExists(join(temp.rootPath, "Research", "notes.txt")))
      .toBe(false);
    await expect
      .poll(() => pathExists(join(temp.rootPath, "Research", "plan.txt")))
      .toBe(true);

    await renamed.click();
    await renamed.press("Delete");
    const confirmation = page.getByTestId("delete-confirm");
    await expect(confirmation).toContainText(
      "It moves to the system trash, or to this workspace's .dohc/trash folder",
    );
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(renamed).toBeVisible();

    await renamed.click();
    await renamed.press("Delete");
    await page.getByTestId("confirm-delete").click();
    await expect(renamed).toHaveCount(0);
    await expect
      .poll(() => pathExists(join(temp.rootPath, "Research", "plan.txt")))
      .toBe(false);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
