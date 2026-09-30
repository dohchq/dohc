import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeWorkspaceFile } from "../../../packages/mcp/src/tools";
import { launchDesktopApp } from "./helpers/desktopApp";
import { waitForCliEndpoint } from "./helpers/dohcCli";
import { cleanupDesktopWorkspace, createTempWorkspace, openHistoryView, openWorkspaceFromFirstRun, waitForWorkspaceFile } from "./helpers/workspace";

test("dashboard-03: four MCP file writes show the agent in History", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForCliEndpoint(temp.homeDir);
    const ctx = { root: temp.rootPath, home: temp.homeDir };
    const files = [
      { path: "dashboard/index.html", content: '<!doctype html><title>Project dashboard</title><h1>Project dashboard</h1><script src="script.js"></script>' },
      { path: "dashboard/styles.css", content: "body { font-family: sans-serif; }" },
      { path: "dashboard/script.js", content: 'document.body.dataset.ready = "true";' },
      { path: "dashboard/data.json", content: '{"tasks":[{"title":"Ship dashboard","done":true}]}' },
    ];
    for (const file of files) {
      expect(await writeWorkspaceFile(ctx, file, "Dashboard agent")).toMatchObject({ ok: true, path: file.path });
      expect(await readFile(join(temp.rootPath, file.path), "utf8")).toBe(file.content);
      await waitForWorkspaceFile(page, workspace.workspaceId, file.path);
    }
    await openHistoryView(page);
    const rows = page.locator('[data-testid="engine-moment-open"][data-moment-path^="dashboard/"]');
    await expect(rows).toHaveCount(4);
    await expect(rows.getByTestId("engine-moment-source")).toHaveText(Array(4).fill("Dashboard agent"));
    for (const label of ["Local file edit", "Reconciled offline edits", "dohc-mcp"]) {
      await expect(rows.filter({ hasText: label })).toHaveCount(0);
    }
    // A flush before a fifth request ensures watcher observations of the four
    // publications cannot add neutral duplicates after the first assertion.
    expect(await writeWorkspaceFile(ctx, { path: "capture-barrier.txt", content: "settled" }, "Dashboard agent")).toMatchObject({ ok: true });
    await waitForWorkspaceFile(page, workspace.workspaceId, "capture-barrier.txt");
    await expect(rows).toHaveCount(4);
    await rows.first().click();
    await expect(page.getByTestId("engine-diff-source")).toHaveText("Dashboard agent");
    await expect(page.getByTestId("engine-diff-restore-file")).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
