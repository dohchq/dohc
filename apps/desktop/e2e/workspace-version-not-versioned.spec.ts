import { expect, test, type Page } from "@playwright/test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// A version does not copy a file over 5 MiB, so Main and every version share
// its one copy. In a version, the Explorer marks the file and asks before a
// rename, and the rename then shows in Main too.

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function chooseVersion(page: Page, name: string, create: boolean): Promise<void> {
  await expect(page.getByTestId("version-menu-button")).toBeEnabled();
  await page.getByTestId("version-menu-button").click();
  if (create) {
    await page.getByTestId("version-new").click();
    await page.getByTestId("version-new-input").fill(name);
    await page.getByTestId("version-new-input").press("Enter");
  } else {
    await page.locator(`[data-testid="version-item"][data-version-name="${name}"]`).click();
  }
  await expect(page.getByTestId("version-menu-active")).toHaveText(name, { timeout: 20_000 });
}

test("in a version, a file over the size limit is marked and its rename asks first", async ({}, testInfo) => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [
      { path: "plan.md", contents: "# Plan\n" },
      { path: "clip.bin", contents: Buffer.alloc(6 * 1024 * 1024, 7) },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "clip.bin");

    // On Main nothing is marked.
    await expect(page.getByTestId("version-menu-active")).toHaveText("Main", { timeout: 20_000 });
    await expect(page.locator("[data-testid=tree-row-not-versioned]")).toHaveCount(0);

    await chooseVersion(page, "Draft", true);
    const clip = explorerRow(page, "clip.bin");
    await expect(clip).toHaveAttribute("data-not-versioned", "true", { timeout: 20_000 });
    await expect(clip.getByTestId("tree-row-not-versioned")).toHaveText("Not versioned");
    await expect(explorerRow(page, "plan.md")).not.toHaveAttribute("data-not-versioned", "true");
    await page.screenshot({ path: testInfo.outputPath("not-versioned-row.png") });

    // Cancel leaves the file alone.
    await clip.click();
    await clip.press("F2");
    const rename = page.getByRole("textbox", { name: "New name" });
    await rename.fill("renamed.bin");
    await rename.press("Enter");
    const dialog = page.getByTestId("not-versioned-confirm");
    await expect(dialog).toContainText("Rename clip.bin in Main too?");
    await expect(dialog).toContainText("It isn't versioned, so Main and every version have the same copy.");
    await page.screenshot({ path: testInfo.outputPath("not-versioned-confirm.png") });
    await page.getByTestId("cancel-not-versioned").click();
    await expect(dialog).toHaveCount(0);
    expect(await pathExists(join(temp.rootPath, "clip.bin"))).toBe(true);

    // Rename anyway renames it.
    await clip.press("F2");
    await rename.fill("renamed.bin");
    await rename.press("Enter");
    await page.getByTestId("confirm-not-versioned").click();
    await expect(explorerRow(page, "renamed.bin")).toBeVisible();
    await expect.poll(() => pathExists(join(temp.rootPath, "renamed.bin"))).toBe(true);
    expect(await pathExists(join(temp.rootPath, "clip.bin"))).toBe(false);
    await expect(page.getByTestId("workspace-shell-error")).toHaveCount(0);

    // Main shows the rename too, and marks nothing.
    await chooseVersion(page, "Main", false);
    await expect(explorerRow(page, "renamed.bin")).toBeVisible();
    await expect(explorerRow(page, "clip.bin")).toHaveCount(0);
    expect(await pathExists(join(temp.rootPath, "renamed.bin"))).toBe(true);
    await expect(page.locator("[data-testid=tree-row-not-versioned]")).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
