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
    const quit = desktop.app.waitForEvent("close");
    await desktop.app.evaluate(({ app }) => { app.quit(); });
    await quit;
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});

test("workspace manager keeps bottom-row menus reachable by keyboard and follows zoom", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    await desktop.page.evaluate(async () => {
      if (!window.dohcDesktop) throw new Error("Desktop bridge is unavailable");
      await window.dohcDesktop.stepWindowZoom({ step: "in" });
      const root = await window.dohcDesktop.getDefaultWorkspaceRoot();
      for (let index = 0; index < 12; index += 1) {
        await window.dohcDesktop.createLocalWorkspace({
          rootPath: `${root}/menu-${index}`,
          kind: "personal",
        });
      }
    });
    await desktop.page.getByTestId("workspace-switcher").click();
    const managerOpened = desktop.app.waitForEvent("window");
    await desktop.page.getByTestId("workspace-switcher-manage").click();
    const manager = await managerOpened;
    await expect(manager.getByTestId("workspace-manager-row")).toHaveCount(13);
    const zoomLevels = () => desktop!.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
        .map((window) => window.webContents.getZoomLevel()),
    );
    await expect.poll(zoomLevels).toEqual([1, 1]);
    await manager.evaluate(async () => {
      if (!window.dohcDesktop) throw new Error("Desktop bridge is unavailable");
      await window.dohcDesktop.stepWindowZoom({ step: "out" });
    });
    await expect.poll(zoomLevels).toEqual([0, 0]);
    const trigger = manager.getByTestId("workspace-manager-row").last().getByRole("button", { name: /^More for / });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    await manager.keyboard.press("Enter");
    const reveal = manager.getByRole("menuitem", { name: "Reveal in folder", exact: true });
    const forget = manager.getByRole("menuitem", { name: "Forget", exact: true });
    await expect(reveal).toBeFocused();
    await expect(forget).toBeInViewport();
    await forget.click({ trial: true });
    await manager.screenshot({ path: testInfo.outputPath("bottom-row-menu.png") });
    await manager.keyboard.press("Escape");
    await expect(reveal).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await manager.keyboard.press("Enter");
    await manager.keyboard.press("Tab");
    await manager.keyboard.press("Tab");
    await expect(reveal).not.toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
