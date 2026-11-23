import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { hardKillAppTree } from "./helpers/daemonKill";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const PATH = "notes.txt";
const TYPED = "typed-before-the-crash";

type SetAsideDraftWindow = { dohcDesktop: Pick<DohcDesktopBridge, "listSetAsideDrafts"> };

const setAsideText = (page: Page) =>
  page.evaluate(async () =>
    (await (window as unknown as SetAsideDraftWindow).dohcDesktop.listSetAsideDrafts({}))
      .map((draft) => draft.raw)
      .join("\n"),
  );

test("an edit set aside just before a crash is offered again after relaunch", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: PATH, contents: "first line\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const appPid = desktop.app.process().pid;
    if (appPid === undefined) throw new Error("Electron app has no pid.");
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, PATH);
    await page.getByTestId("titlebar-quick-open").click();
    const palette = page.getByTestId("quick-open");
    await palette.getByLabel("File").fill(PATH);
    await palette.getByRole("option", { name: PATH, exact: true }).click();
    const editor = page.getByTestId("view-text-editor");
    await expect(editor).toContainText("first line");

    // Another program changes the file before dohc saves, so dohc sets the typing aside.
    await editor.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText(` ${TYPED}`);
    await writeFile(join(temp.rootPath, PATH), "changed outside dohc\n");
    await expect(page.getByTestId("orphaned-draft-notice")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => setAsideText(page), { timeout: 30_000 }).toContain(TYPED);

    await hardKillAppTree(appPid);
    await expect(desktop.close()).rejects.toThrow(/Electron exited with (status|signal)/);
    desktop = null;

    desktop = await launchDesktopApp({ workspace: temp });
    const restarted = desktop.page;
    await openWorkspaceFromFirstRun(restarted, temp);
    expect(await setAsideText(restarted)).toContain(TYPED);
    await restarted.getByTestId("notice-center-toggle").click();
    await expect(restarted.getByTestId("notice-set-aside-edits")).toContainText(
      "1 set-aside edit is waiting",
    );
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
