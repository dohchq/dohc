import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deleteWorkspacePath, listChanges, readChange, moveWorkspacePath, undoOperation, writeWorkspaceFile } from "../../../packages/mcp/src/tools";
import { launchDesktopApp } from "./helpers/desktopApp";
import { waitForCliEndpoint } from "./helpers/dohcCli";
import { cleanupDesktopWorkspace, createTempWorkspace, openHistoryView, openWorkspaceFromFirstRun, waitForWorkspaceFile } from "./helpers/workspace";

test("an MCP move and delete each show one History row under the agent", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForCliEndpoint(temp.homeDir);
    const ctx = { root: temp.rootPath, home: temp.homeDir };
    for (const path of ["plans/notes.txt", "old.txt"]) {
      expect(await writeWorkspaceFile(ctx, { path, content: `${path} body` }, "Setup agent")).toMatchObject({ ok: true });
      await waitForWorkspaceFile(page, workspace.workspaceId, path);
    }

    const move = await moveWorkspacePath(ctx, { fromPath: "plans", toPath: "archive/plans" }, "Mover agent");
    expect(move).toEqual({ ok: true, operationId: expect.stringMatching(/^dohc-operation:/), fromPath: "plans", toPath: "archive/plans", undo: { available: false, reason: "Undo for a folder move isn't available yet. Move it back yourself.", paths: [] } });
    if (!move.ok) throw new Error(move.reason);
    expect(await readFile(join(temp.rootPath, "archive/plans/notes.txt"), "utf8")).toBe("plans/notes.txt body");
    await waitForWorkspaceFile(page, workspace.workspaceId, "archive/plans/notes.txt");
    const removed = await deleteWorkspacePath(ctx, { path: "old.txt" });
    expect(removed).toEqual({ ok: true, operationId: expect.stringMatching(/^dohc-operation:/), undo: { available: true }, path: "old.txt", trashed: true });
    if (!removed.ok) throw new Error(removed.reason);
    expect(existsSync(join(temp.rootPath, "old.txt"))).toBe(false);
    // A later write is recorded after capture has seen the move and the delete,
    // so any row the watcher would add is already in History.
    expect(await writeWorkspaceFile(ctx, { path: "capture-barrier.txt", content: "settled" }, "Setup agent")).toMatchObject({ ok: true });
    await waitForWorkspaceFile(page, workspace.workspaceId, "capture-barrier.txt");

    await openHistoryView(page);
    const moved = page.locator('[data-testid="engine-moment-open"][data-moment-path^="archive/plans/"]');
    await expect(moved).toHaveCount(1);
    await expect(moved.getByTestId("engine-moment-source")).toHaveText("Mover agent");
    const deleted = page.locator('[data-testid="engine-moment-open"][data-moment-path="old.txt"]');
    // The setup write and the agent's delete.
    await expect(deleted).toHaveCount(2);
    await expect(deleted.first().getByTestId("engine-moment-source")).toHaveText("Agent");
    // Every change here came through dohc, so no row is a neutral capture.
    const rows = page.locator('[data-testid="engine-moment-open"]');
    for (const label of ["Local file edit", "Changed while dohc was closed", "Added existing files", "dohc-mcp"]) {
      await expect(rows.filter({ hasText: label })).toHaveCount(0);
    }
    await expect(undoOperation(ctx, { operationId: removed.operationId })).resolves.toEqual({ ok: true, tracked: { state: expect.stringMatching(/^restor(?:ing|ed)$/u), momentCount: 1 }, restored: [], remaining: [] });
    await expect.poll(() => readFile(join(temp.rootPath, "old.txt"), "utf8")).toBe("old.txt body");
    const changes = await listChanges(ctx);
    expect(changes).toHaveProperty("changes");
    if (!("changes" in changes)) throw new Error("History list failed after Undo");
    for (const change of changes.changes) {
      expect(await readChange(ctx, { id: change.id })).toMatchObject({ ok: true, change: { id: change.id } });
    }
    await moved.click();
    await expect(page.getByTestId("engine-diff-source")).toHaveText("Mover agent");
    expect(await undoOperation(ctx, { operationId: move.operationId })).toEqual({ ok: false, reason: "Undo for a folder move isn't available yet. Move it back yourself." });
    const fileMove = await moveWorkspacePath(ctx, { fromPath: "archive/plans/notes.txt", toPath: "archive/plans/renamed.txt" }, "Mover agent");
    expect(fileMove).toMatchObject({ ok: true, undo: { available: true } });
    if (!fileMove.ok) throw new Error(fileMove.reason);
    expect(await undoOperation(ctx, { operationId: fileMove.operationId })).toMatchObject({ ok: true, tracked: { state: expect.stringMatching(/^restor(?:ing|ed)$/u), momentCount: 1 }, remaining: [] });
    await expect.poll(() => readFile(join(temp.rootPath, "archive/plans/notes.txt"), "utf8")).toBe("plans/notes.txt body");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
