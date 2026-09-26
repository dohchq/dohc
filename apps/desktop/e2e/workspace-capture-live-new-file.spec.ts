import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openHistoryView,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// A person creates a file from the explorer and types into it. The editor's
// live session holds the new document while capture first sees the file. The
// capture layer used to report itself degraded for as long as the document
// stayed open, so History, search, and a file's chats refused with "still
// updating". Each of them must answer while the document is open.

type FileChatsAnswer = { status?: string; fileObjectId?: string | null };

async function listFileChats(page: Page, workspaceId: string, path: string): Promise<FileChatsAnswer> {
  return await page.evaluate(async ({ id, filePath }) => {
    const api = (window as unknown as {
      dohcDesktop: { listFileChats(payload: { workspaceId: string; path: string }): Promise<unknown> };
    }).dohcDesktop;
    return (await api.listFileChats({ workspaceId: id, path: filePath })) as FileChatsAnswer;
  }, { id: workspaceId, filePath: path });
}

test("a new file open in the editor keeps History, search, and its chats working", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const sentinel = "fresh-file-sentinel-september";

  try {
    await writeWorkspaceFiles(temp, [{ path: "notes/readme.md", contents: "# Notes\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/readme.md");

    // The explorer's New file: an empty file, then the editor opens it.
    await page.evaluate(async (id) => {
      const api = (window as unknown as {
        dohcDesktop: { createWorkspaceFile(payload: unknown): Promise<unknown> };
      }).dohcDesktop;
      await api.createWorkspaceFile({ workspaceId: id, relativePath: "notes/fresh.md", initialText: "" });
    }, workspace.workspaceId);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/fresh.md");
    await revealExplorerPath(page, "notes/fresh.md");
    await explorerRow(page, "notes/fresh.md").click();
    await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 15_000 });
    const editor = page.getByTestId("markdown-editor");
    await editor.click();
    await page.keyboard.type(sentinel);
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved", {
      timeout: 20_000,
    });
    await expect
      .poll(async () => await readFile(join(temp.rootPath, "notes/fresh.md"), "utf8").catch(() => ""), {
        timeout: 20_000,
      })
      .toContain(sentinel);

    // The file's chats: the lookup flushes capture first.
    const chats = await listFileChats(page, workspace.workspaceId, "notes/fresh.md");
    expect(chats.status).not.toBe("refused");
    expect(chats.fileObjectId).toBeTruthy();

    // History: an edit to another file lands as a moment while the new
    // document stays open.
    await openHistoryView(page);
    await writeWorkspaceFiles(temp, [{ path: "notes/readme.md", contents: "# Notes\n\nEdited on disk.\n" }]);
    // The file's first capture and then the edit: the newest row is first.
    const moments = page.locator('[data-testid="engine-moment-open"][data-moment-path="notes/readme.md"]');
    await expect(moments).toHaveCount(2, { timeout: 30_000 });
    const moment = moments.first();

    // Reading that moment and restoring the file both flush capture first.
    await moment.click();
    await expect(page.getByTestId("engine-diff-lines")).toContainText("Edited on disk.");
    await page.getByTestId("engine-diff-restore-file").click();
    await page.getByTestId("engine-diff-confirm-restore").click();
    await expect(page.getByTestId("engine-diff-restore-status")).toContainText("Restored the earlier state");
    await expect
      .poll(async () => await readFile(join(temp.rootPath, "notes/readme.md"), "utf8"))
      .toBe("# Notes\n");

    // Search finds the new file's text.
    await page.getByTestId("activity-search").click();
    await expect(page.getByTestId("search-view")).toBeVisible();
    await page.getByTestId("search-input").fill(sentinel);
    await expect(
      page.locator('[data-testid="search-result-group"][data-path="notes/fresh.md"]'),
    ).toBeVisible({ timeout: 20_000 });

    // Still open, and the lookup still answers after all of that.
    const again = await listFileChats(page, workspace.workspaceId, "notes/fresh.md");
    expect(again.status).not.toBe("refused");
    expect(again.fileObjectId).toBe(chats.fileObjectId);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
