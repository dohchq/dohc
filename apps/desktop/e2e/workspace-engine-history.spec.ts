import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  activeWorkspace,
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openHistoryView,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  waitForWorkspaceReady,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// The history timeline shows engine moments (real summaries) and the diff
// page restores through the engine with a forward moment and an undo.

test("a workspace shows engine moments and restores a file end-to-end", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;

    // History lives in the left History view (the right panel is Chats now).
    // Open it before the first edit and wait for the workspace's startup
    // capture to surface: the first-run seed files render as engine moments —
    // grouped under "Reconciled offline edits" when the startup reconcile
    // recorded them, standalone when the live watcher won that race. Waiting
    // here pins the ordering: the daemon's baseline is done and its watcher
    // is live, so the write below is deterministically a live capture (calm
    // "Edited plan.md" copy, no reconcile group), and its row can only appear
    // through the daemon's capture.momentRecorded -> workspace-activity
    // refresh chain — the exact seam this spec exists to prove in daemon
    // mode.
    await page.getByTestId("activity-history").click();
    await expect(
      page
        .locator(
          '[data-testid="engine-moment-group"], [data-testid="engine-moment-open"]',
        )
        .first(),
    ).toBeVisible();

    await writeWorkspaceFiles(temp, [
      { path: "notes/plan.md", contents: "first draft\n" },
    ]);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/plan.md");
    const momentRow = page.locator(
      '[data-testid="engine-moment-open"][data-moment-path="notes/plan.md"]',
    );
    await expect(momentRow.first()).toBeVisible();
    await expect(momentRow.first()).toContainText("Edited plan.md");
    // Engine history replaces the legacy list entirely for this workspace.
    await expect(page.getByTestId("history-list")).toHaveCount(0);

    // Second edit -> newest moment carries the v1 -> v2 diff.
    await writeWorkspaceFiles(temp, [
      { path: "notes/plan.md", contents: "second draft\n" },
    ]);
    await expect(momentRow).toHaveCount(2);

    await momentRow.first().click();
    const diffPage = page.getByTestId("engine-moment-diff-page");
    await expect(diffPage).toBeVisible();
    await expect(page.getByTestId("engine-diff-lines")).toContainText("second draft");

    // Engine restore: back to the state before this change...
    await page.getByTestId("engine-diff-restore-file").click();
    await expect(page.getByTestId("engine-diff-restore-confirm")).toBeVisible();
    await page.getByTestId("engine-diff-confirm-restore").click();
    await expect(page.getByTestId("engine-diff-restore-status")).toContainText(
      "Restored the earlier state",
    );
    await expect
      .poll(() => readFile(join(temp.rootPath, "notes/plan.md"), "utf8"))
      .toBe("first draft\n");

    // ...recorded as a forward moment with the real restore summary.
    await expect(
      page
        .locator('[data-testid="engine-moment-open"]')
        .filter({ hasText: "Restored notes/plan.md" })
        .first(),
    ).toBeVisible();

    // Undo = restore to before the restore moment (forward again).
    await page.getByTestId("engine-diff-undo-restore").click();
    await expect(page.getByTestId("engine-diff-restore-status")).toContainText(
      "Undid the restore",
    );
    await expect
      .poll(() => readFile(join(temp.rootPath, "notes/plan.md"), "utf8"))
      .toBe("second draft\n");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// A person creates a workspace, makes its first document, types, and opens
// History. The document's editor still holds it when capture first sees the
// file, and capture used to count that as a failed ingest: History paused,
// and could not list the document until its tab closed.
test("History lists the first document of a new workspace while it is open", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    await page.getByRole("button", { name: "Change location" }).click();
    await page.getByRole("textbox", { name: "Folder name" }).fill("my-notes");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await waitForWorkspaceReady(page);
    const rootPath = join(temp.rootPath, "my-notes");
    const workspace = await activeWorkspace(page, rootPath);

    // Every capture health change notifies, and a pause stays reported until
    // the next health poll, so reading the status on each notice sees it.
    await page.evaluate((workspaceId) => {
      const api = window.dohcDesktop;
      if (!api) throw new Error("Desktop bridge is unavailable");
      const pauses: string[] = [];
      Object.assign(window, { historyPauses: pauses });
      api.onWorkspaceActivity((event) => {
        if (event.workspaceId !== workspaceId) return;
        void api.getSyncStatus({ workspaceId }).then((status) => {
          if (status.historyCaptureFailed) pauses.push(new Date().toISOString());
        });
      });
    }, workspace.workspaceId);

    await page.keyboard.press("Control+n");
    await page.getByRole("textbox", { name: "File name" }).fill("trip/plan");
    await page.keyboard.press("Enter");
    const editor = page.getByTestId("markdown-editor");
    await editor.click();
    await page.keyboard.type("Three nights, two of us, one budget.");
    await expect
      .poll(() => readFile(join(rootPath, "trip/plan.md"), "utf8").catch(() => ""))
      .toContain("one budget.");

    await openHistoryView(page);
    await expect(
      page.locator('[data-testid="engine-moment-open"][data-moment-path="trip/plan.md"]').first(),
    ).toContainText("Edited plan.md");
    await expect(editor).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { historyPauses: string[] }).historyPauses),
    ).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
