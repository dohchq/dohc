import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, writeWorkspaceFiles } from "./helpers/workspace";

test("native window close saves text before destroying the renderer", async () => {
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(workspace, [{ path: "draft.txt", contents: "before" }]);
    desktop = await launchDesktopApp({ workspace });
    const { page, app } = desktop;
    await openWorkspaceFromFirstRun(page, workspace);
    await explorerRow(page, "draft.txt").click();
    const editor = page.getByTestId("view-text").locator(".cm-content");
    await expect(editor).toBeVisible();
    // Hold only the autosave debounce. IPC and the real native close path run
    // normally, so an ordinary timer cannot make this test pass by accident.
    await page.evaluate(() => {
      const schedule = window.setTimeout.bind(window);
      window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
        schedule(callback, delay === 800 ? 86_400_000 : delay, ...args)) as typeof window.setTimeout;
    });
    await editor.fill("last edit before close");
    expect(await readFile(join(workspace.rootPath, "draft.txt"), "utf8")).toBe("before");
    // Electron owns the beforeunload veto. Observing its notification prevents
    // Playwright from sending a dialog response after Electron has handled it.
    const nativeDialogs: string[] = [];
    page.on("dialog", dialog => nativeDialogs.push(dialog.type()));
    const closed = page.waitForEvent("close");
    const browserWindow = await app.browserWindow(page);
    await browserWindow.evaluate(win => { setImmediate(() => win.close()); });
    await closed;
    expect(nativeDialogs).toEqual(["beforeunload"]);
    expect(await readFile(join(workspace.rootPath, "draft.txt"), "utf8")).toBe("last edit before close");
    await desktop.close();
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    await explorerRow(desktop.page, "draft.txt").click();
    await expect(desktop.page.getByTestId("view-text").locator(".cm-content")).toHaveText("last edit before close");
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});
