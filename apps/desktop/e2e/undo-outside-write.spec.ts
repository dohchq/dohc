import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test("Undo refuses an old path occupied by an outside write @undo-outside-write", async ({}, testInfo) => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: "old.md", contents: "Moved content.\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "old.md");
    await expect.poll(() => page.evaluate(async workspaceId => {
      const result = await window.dohcDesktop!.listEngineMoments({ workspaceId });
      return "moments" in result && result.moments.some(moment => moment.path === "old.md");
    }, workspace.workspaceId)).toBe(true);
    const moved = await page.evaluate(workspaceId => window.dohcDesktop!.moveWorkspacePath({
      workspaceId, fromPath: "old.md", toPath: "new.md",
    }), workspace.workspaceId);
    expect(moved.operationId).toBeTruthy();
    if (!moved.operationId) throw new Error("Rename did not return a History operation.");
    expect(moved.undo?.available).toBe(true);

    await writeFile(join(temp.rootPath, "old.md"), "Outside content KEEP.\n");
    const started = performance.now();
    const result = await page.evaluate(input => window.dohcDesktop!.undoHistoryOperation(input), {
      workspaceId: workspace.workspaceId, operationId: moved.operationId,
    });
    const observation = { elapsedMs: performance.now() - started, result };
    console.log("Undo after outside write", JSON.stringify(observation));
    await testInfo.attach("undo-after-outside-write", {
      body: JSON.stringify(observation, null, 2),
      contentType: "application/json",
    });
    expect(result).toEqual({
      ok: false,
      reason: "Cannot undo the rename. old.md now occupies the old path. Move it first.",
    });
    expect(await readFile(join(temp.rootPath, "old.md"), "utf8")).toBe("Outside content KEEP.\n");
    expect(await readFile(join(temp.rootPath, "new.md"), "utf8")).toBe("Moved content.\n");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
