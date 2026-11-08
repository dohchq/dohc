import { expect, test, type Page } from "@playwright/test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { revealInFileManagerLabel } from "../src/workspaces/explorerMenu";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, seedWorkspaceManifest, seedWorkspaceRegistry } from "./helpers/workspace";

// With UI_AUDIT_SHOT_DIR set, the tests for a workspace dohc can't open save
// the window in both themes.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR;

async function shootBothThemes(page: Page, name: string) {
  if (!SHOT_DIR) return;
  await mkdir(SHOT_DIR, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (value) => {
      document.documentElement.setAttribute("data-theme", value);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, theme);
    await page.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
}

test("workspace manager creates another window and removes a workspace from the list without deleting its files", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace });
    await expect(desktop.page.getByRole("button", { name: "Create workspace", exact: true })).toBeVisible();
    await desktop.page.screenshot({ path: testInfo.outputPath("first-run.png") });
    const first = await openWorkspaceFromFirstRun(desktop.page, workspace);
    const switcher = desktop.page.getByTestId("workspace-switcher");
    await switcher.focus();
    await desktop.page.keyboard.press("Enter");
    await desktop.page.getByTestId("workspace-switcher-manage").focus();
    await desktop.page.keyboard.press("Escape");
    await expect(switcher).toBeFocused();
    await switcher.click();
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
    // A cut path puts "…" right after its first folder, at every width.
    const cutPath = () => manager.getByTestId("workspace-manager-row").evaluate((row) => {
      const dots = row.querySelector("[data-path-cut]");
      const first = dots?.previousElementSibling;
      const folders = dots?.nextElementSibling;
      const name = folders?.nextElementSibling;
      if (!dots || !first || !folders || !name) return null;
      return {
        afterFirst: dots.getBoundingClientRect().left - first.getBoundingClientRect().right,
        beforeFolders: folders.getBoundingClientRect().left - dots.getBoundingClientRect().right,
        nameCut: name.scrollWidth > name.clientWidth,
      };
    });
    await resize.focus();
    await manager.keyboard.press("Home");
    for (const width of ["220", "236", "252"]) {
      await expect(resize).toHaveAttribute("aria-valuenow", width);
      await expect.poll(cutPath).toEqual({
        afterFirst: expect.closeTo(0, 1),
        beforeFolders: expect.closeTo(0, 1),
        nameCut: false,
      });
      await manager.keyboard.press("ArrowRight");
    }
    await manager.getByRole("textbox", { name: "Workspace name" }).fill("second");
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
    await reopenedManager.getByRole("menuitem", { name: "Remove from list", exact: true }).click();
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
    const reveal = manager.getByRole("menuitem", { name: revealInFileManagerLabel(process.platform), exact: true });
    const remove = manager.getByRole("menuitem", { name: "Remove from list", exact: true });
    await expect(reveal).toBeFocused();
    await expect(remove).toBeInViewport();
    await remove.click({ trial: true });
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

// A folder that can never be a workspace: the startup screen offers Remove
// from list in place of Try again, and the next workspace opens. Open folder
// on the same folder leads with why and offers another folder.
test("a listed workspace inside dohc's state folder offers Remove from list, then the next workspace opens", async () => {
  test.setTimeout(120_000);
  const workspace = await createTempWorkspace();
  // Listed before dohc refused such folders: a workspace inside the test
  // home, which is dohc's state folder.
  const rootPath = join(workspace.homeDir, "notes");
  const refusal = "This folder is inside the folder that holds dohc's own settings, so it cannot be a workspace.";
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest({ rootPath }, "notes-in-state");
    await seedWorkspaceManifest(workspace, "notes-next");
    await seedWorkspaceRegistry(workspace, [
      { workspaceId: "notes-in-state", rootPath },
      { workspaceId: "notes-next", rootPath: workspace.rootPath },
    ]);
    const files = () => readdir(rootPath, { recursive: true });
    const before = await files();
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    // dohc reopens the first listed workspace at startup and refuses it there.
    const failed = page.getByTestId("workspace-open-failed");
    await expect(failed).toContainText(refusal);
    await expect(failed).not.toContainText("Manage workspaces");
    await expect(failed.getByRole("button", { name: "Try again" })).toHaveCount(0);
    const remove = failed.getByRole("button", { name: "Remove from list" });
    await expect(remove).toBeFocused();
    expect(await files()).toEqual(before);
    await shootBothThemes(page, "open-failed-not-a-workspace");

    // A plain row leaves the list at once, without asking first.
    await remove.click();
    await expect(page.getByTestId("workspace-shell")).toHaveAttribute("data-ready", "true");
    await expect(failed).toHaveCount(0);
    await expect.poll(async () => {
      const listed = JSON.parse(await readFile(join(workspace.homeDir, "dohc-workspaces.json"), "utf8")) as { workspaces: Array<{ workspaceId: string }> };
      return listed.workspaces.map((entry) => entry.workspaceId);
    }).toEqual(["notes-next"]);
    expect(await files()).toEqual(before);

    // Open folder picks DOHC_TEST_PICK_PATH, which the launch set to the other workspace.
    await desktop.app.evaluate((_electron, folder) => { process.env.DOHC_TEST_PICK_PATH = folder; }, rootPath);
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:menu-command", "open-workspace"));
    const toast = page.getByTestId("workspace-shell-error");
    await expect(toast).toContainText(refusal);
    await expect(toast).not.toContainText(rootPath);
    await expect(toast.getByRole("button", { name: "Choose another folder" })).toBeVisible();
    await expect(toast.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(toast.getByTestId("workspace-shell-error-copy")).toHaveCount(0);
    await toast.getByRole("button", { name: "Details" }).click();
    await expect(toast.getByTestId("workspace-shell-error-details-text")).toContainText(`Chosen folder: ${rootPath}`);
    await shootBothThemes(page, "open-folder-toast-details");
    expect(await files()).toEqual(before);
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});

// A folder that may come back, such as on a drive that is not connected,
// keeps Try again and Remove from list stays in Manage workspaces.
test("a listed workspace whose folder is missing keeps Try again", async () => {
  test.setTimeout(120_000);
  const workspace = await createTempWorkspace();
  const rootPath = join(workspace.baseDir, "unplugged", "notes");
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceRegistry(workspace, [{ workspaceId: "notes-unplugged", rootPath }]);
    desktop = await launchDesktopApp({ workspace });
    const failed = desktop.page.getByTestId("workspace-open-failed");
    await expect(failed.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(failed.getByRole("button", { name: "Remove from list" })).toHaveCount(0);
    await expect(failed).toContainText("Choose another workspace from the title bar.");
    await shootBothThemes(desktop.page, "open-failed-may-come-back");
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
