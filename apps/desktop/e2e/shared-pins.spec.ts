import { expect, test } from "@playwright/test";
import { desktopPins, activityPin, editorTabTestId } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, writeWorkspaceFiles } from "./helpers/workspace";

test("shared pins find literal frame controls and generated file, chat, and Collection tabs", async () => {
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(workspace, [{ path: "pin fixture.md", contents: "# Pin fixture\n" }]);
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
    await expect(page.getByTestId(desktopPins.titlebar)).toBeVisible();
    await expect(page.getByTestId(desktopPins.activityBar)).toBeVisible();
    await explorerRow(page, "pin fixture.md").click();
    await expect(page.getByTestId(editorTabTestId("pin fixture.md"))).toBeVisible();
    await page.getByTestId(desktopPins.titlebarChatsSidebar).click();
    await expect(page.getByTestId(desktopPins.chatsPanel)).toBeVisible();
    await page.getByTestId("chats-feed-link").click();
    await expect(page.getByTestId(editorTabTestId("tab://chats"))).toBeVisible();
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:menu-command", "new-collection"));
    const dialog = page.getByTestId("new-collection-dialog");
    await dialog.getByLabel("Collection name").fill("Pin records");
    await dialog.getByLabel("Require Name").check();
    await dialog.getByTestId("new-collection-create").click();
    await expect(dialog).toBeHidden();
    const listed = await page.evaluate(async workspaceId => window.dohcDesktop!.dataset({ action: "list", workspaceId }), workspaceId);
    if (listed.kind !== "list" || !listed.datasets[0]?.tables[0]) throw Error("Expected generated Collection identity.");
    const dataset = listed.datasets[0], table = dataset.tables[0]!;
    const path = `tab://data-collection/${encodeURIComponent(dataset.datasetPath!)}/${table.tableId}`;
    const tab = page.getByTestId(editorTabTestId(path));
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute("data-testid", `tab-dohc://${path.slice("tab://".length)}`);
    await page.getByTestId(activityPin("settings")).click();
    await expect(page.getByTestId(desktopPins.settingsDialog)).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
