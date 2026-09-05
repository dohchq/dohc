import { expect, test } from "@playwright/test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
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
    const welcomeTab = page.getByTestId("tab-Welcome.md");
    await expect(welcomeTab).toBeVisible({ timeout: 15_000 });
    await expect(welcomeTab).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("markdown-editor")).toBeVisible({ timeout: 15_000 });

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

test("renaming a live Markdown file first lands the newest editor update", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const marker = "rename-keeps-this-edit";

  try {
    await seedWorkspaceSettings(temp);
    await writeWorkspaceFiles(temp, [
      { path: "notes.md", contents: "# Notes\n\nBase.\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes.md");

    const row = explorerRow(page, "notes.md");
    await row.click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(`\n${marker}`);
    await expect(editor).toContainText(marker);

    // Do not wait for the provider's batch timer or save indicator. Explorer's
    // mutation barrier must force this renderer-only edit to main before main
    // settles and closes the old-path live session.
    await row.press("F2");
    const rename = page.getByRole("textbox", { name: "New name" });
    await rename.fill("plan.md");
    await rename.press("Enter");

    await expect(explorerRow(page, "plan.md")).toBeVisible();
    await expect(explorerRow(page, "notes.md")).toHaveCount(0);
    await expect(page.getByTestId("editor-tabs")).toContainText("plan.md");
    await expect(page.getByTestId("workspace-shell-error")).toHaveCount(0);
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute(
      "data-state",
      "saved",
    );
    await expect
      .poll(async () =>
        await readFile(join(temp.rootPath, "plan.md"), "utf8").catch(() => ""),
      )
      .toContain(marker);
    await expect
      .poll(() => pathExists(join(temp.rootPath, "notes.md")))
      .toBe(false);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
