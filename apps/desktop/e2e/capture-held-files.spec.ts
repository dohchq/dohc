import { randomUUID } from "node:crypto";
import { VersionedLiveAdapter, openEngineYdocProviderSession, type EngineTransport } from "@dohc/workspace-engine-client";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions } from "../src/testing/realDaemonWorkspaceSessions";
import { resolveEngineBinary } from "../src/testing/engineBinary";
import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, seedWorkspaceManifest, writeWorkspaceFiles } from "./helpers/workspace";

test("a real daemon holds a deep quote, shows its notice, and clears it after an outside repair @capture-holds", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: "held.md", contents: "Readable first.\n" }]);
    const workspaceId = randomUUID();
    await seedWorkspaceManifest(temp, workspaceId);
    const lifecycle = createRealDaemonLifecycle({ command: resolveEngineBinary(), maxRestarts: 0 });
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const seeded = { workspaceId, rootPath: temp.rootPath, attachmentId: Symbol("seed") };
    await lifecycle.start();
    try {
      await sessions.run(seeded, async ({client, workspace: handle}) => {
        const adapter = new VersionedLiveAdapter(client, handle, {workspaceId});
        await adapter.flushCapture();
        const document = await openEngineYdocProviderSession({transport: client as EngineTransport, workspace: handle,
          versionId: "main", path: "held.md", contentKind: "richdoc", onRemoteUpdate: () => {}});
        await document.evict();
      });
    } finally { await sessions.closeWorkspace(seeded); await lifecycle.stop(); }
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;
    const deep = `${"> ".repeat(121)}Outside edit.\n`;
    await writeFile(join(temp.rootPath, "held.md"), deep);
    const toast = page.getByTestId("workspace-shell-notice").filter({ hasText: "Outside edit not recorded" });
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText('dohc did not record the outside edit to "held.md".');
    await expect(toast).toContainText("dohc cannot take in this file's Markdown.");
    expect(await readFile(join(temp.rootPath, "held.md"), "utf8")).toBe(deep);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.screenshot({ path: test.info().outputPath(`held-toast-${theme}.png`) });
    }
    // Reach the toast's retry by keyboard, then activate it without a pointer.
    const retry = toast.getByRole("button", { name: "Try again" });
    for (let i = 0; i < 100 && !await retry.evaluate(node => node === document.activeElement); i++) await page.keyboard.press("Tab");
    await expect(retry).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toast).toHaveCount(1);
    const file = explorerRow(page, "held.md");
    for (let i = 0; i < 100 && !await file.evaluate(node => node === document.activeElement); i++) await page.keyboard.press("Tab");
    await expect(file).toBeFocused();
    await page.keyboard.press("Enter");
    // The held note shows the hold right away, read-only, with no Edit anyway.
    const held = page.getByTestId("engine-may-hold-document-notice");
    await expect(held).toContainText('dohc cannot open "held.md" for live editing');
    await expect(held).toContainText("Restore the file's exact contents from before that edit.");
    await expect(held.getByRole("button", { name: "Open externally" })).toBeVisible();
    await expect(page.getByTestId("lossy-note-notice")).toHaveCount(0);
    await expect(page.getByTestId("lossy-note-edit-anyway")).toHaveCount(0);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: test.info().outputPath(`held-note-${theme}.png`) });
    }
    await expect(page.locator('[data-testid="markdown-editor"][contenteditable="true"]')).toHaveCount(0);
    const notices = page.getByTestId("notice-center-toggle");
    for (let i = 0; i < 100 && !await notices.evaluate(node => node === document.activeElement); i++) await page.keyboard.press("Tab");
    await expect(notices).toBeFocused();
    await page.keyboard.press("Enter");
    const row = page.locator("[data-notice-row]").filter({ hasText: "Outside edit not recorded" });
    await expect(row).toHaveCount(1);
    await expect(page.locator("[data-notice-row]")).toHaveCount(1);
    await expect(row.getByRole("button", { name: /Copy/ })).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: test.info().outputPath(`held-notices-${theme}.png`) });
    }
    await writeFile(join(temp.rootPath, "held.md"), "Repaired outside dohc.\n");
    await expect(row).toHaveCount(0);
    await expect(toast).toHaveCount(0);
    expect(await readFile(join(temp.rootPath, "held.md"), "utf8")).toBe("Repaired outside dohc.\n");
    const status = await page.evaluate(async workspaceId => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.getSyncStatus({ workspaceId }), workspace.workspaceId);
    expect(status.historyCaptureFailed).not.toBe(true);
    expect(status.heldFiles).toEqual([]);
  } finally { await cleanupDesktopWorkspace(desktop, temp); }
});
