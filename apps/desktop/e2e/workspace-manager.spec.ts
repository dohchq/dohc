import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun } from "./helpers/workspace";

test("workspace manager creates another window and forgets a workspace without deleting its files", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace });
    await expect(desktop.page.getByRole("button", { name: "Create workspace", exact: true })).toBeVisible();
    await desktop.page.screenshot({ path: testInfo.outputPath("first-run.png") });
    const first = await openWorkspaceFromFirstRun(desktop.page, workspace);
    await desktop.page.getByTestId("workspace-switcher").click();
    const managerOpened = desktop.app.waitForEvent("window");
    await desktop.page.getByTestId("workspace-switcher-manage").click();
    const manager = await managerOpened;
    await expect(manager.getByTestId("workspace-manager-row")).toHaveCount(1);
    const resize = manager.getByRole("separator", { name: "Resize workspace list" });
    await resize.focus();
    await manager.keyboard.press("ArrowLeft");
    await expect(resize).toHaveAttribute("aria-valuenow", "304");
    await manager.keyboard.press("ArrowRight");
    await expect(resize).toHaveAttribute("aria-valuenow", "320");
    for (const theme of ["light", "dark"] as const) {
      await manager.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await manager.emulateMedia({ reducedMotion: "reduce" });
      await manager.screenshot({ path: testInfo.outputPath(`manager-${theme}.png`) });
    }
    await manager.getByRole("textbox", { name: "Folder name" }).fill("second");
    const secondOpened = desktop.app.waitForEvent("window");
    await manager.getByRole("button", { name: "Create workspace", exact: true }).click();
    const second = await secondOpened;
    await expect.poll(() => manager.isClosed()).toBe(true);
    await expect(second.getByTestId("workspace-switcher")).toContainText("second");
    await expect(desktop.page.getByTestId("workspace-switcher")).not.toContainText("second");
    const secondWorkspace = await second.evaluate(async () => {
      if (!window.dohcDesktop) throw new Error("Desktop bridge is unavailable");
      const registry = await window.dohcDesktop.getWorkspaceRegistry();
      return registry.workspaces.find((entry) => /[/\\]second$/.test(entry.rootPath));
    });
    expect(secondWorkspace).toBeDefined();
    const retainedFile = join(secondWorkspace!.rootPath, "keep.md");
    await writeFile(retainedFile, "Keep this file.\n");

    await second.getByTestId("workspace-switcher").click();
    const reopened = desktop.app.waitForEvent("window");
    await second.getByTestId("workspace-switcher-manage").click();
    const reopenedManager = await reopened;
    await expect(reopenedManager.getByTestId("workspace-manager-row")).toHaveCount(2);
    await reopenedManager.getByRole("button", { name: "More for second", exact: true }).click();
    await reopenedManager.getByRole("menuitem", { name: "Forget", exact: true }).click();
    await expect(reopenedManager.getByTestId("workspace-manager-row")).toHaveCount(1);
    await expect.poll(async () => second.evaluate(async () => {
      if (!window.dohcDesktop) throw new Error("Desktop bridge is unavailable");
      return (await window.dohcDesktop.getWorkspaceRegistry()).workspaces.map((entry) => entry.workspaceId);
    })).toEqual([first.workspaceId]);
    expect(await readFile(retainedFile, "utf8")).toBe("Keep this file.\n");
    await expect(second.getByTestId("workspace-switcher")).not.toContainText("second");
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
