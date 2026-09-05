import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { openLiveDaemonWorkspace } from "./helpers/daemonSeed";
import { createWorkspaceEngineCapture } from "../src/workspaces/workspaceEngineCapture";
import { waitForPathMoments } from "../src/workspaces/waitForPathMoments";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay } from "./helpers/syncRelay";
import { cleanupDesktopWorkspace, createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, seedCloudCredentials, waitForWorkspaceFile, waitForWorkspaceReady, writeWorkspaceFiles } from "./helpers/workspace";

test("@two-client two desktops resolve conflicting offline edits and keep the chosen text after restart", async () => {
  test.setTimeout(240_000);
  const first = await createTempWorkspace();
  const second = await createTempWorkspace();
  const workspaceId = "two-desktop-proof";
  let left: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let right: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let relay: Awaited<ReturnType<typeof spawnSyncRelay>> | null = null;
  try {
    relay = await spawnSyncRelay({ dbPath: join(first.baseDir, "relay.sqlite") });
    const seedRoot = join(first.baseDir, "seed");
    await mkdir(seedRoot);
    const source = await openLiveDaemonWorkspace({ workspaceId, rootPath: seedRoot });
    const capture = createWorkspaceEngineCapture({ ...source.workspace, rustEngineSessions: source.sessions, daemonOwnsCapture: true });
    try {
      const remote = source.relay.bind({ ...source.workspace, relay: { baseUrl: relay.baseUrl, token: "test:e2e-user" } });
      await remote.claim();
      await writeFile(join(seedRoot, "shared.md"), "# Shared\n\nStarting together.\n");
      capture.captureBatch([{ path: "shared.md", operation: "update" }]);
      await waitForPathMoments(capture, "shared.md", 1);
      expect((await remote.push()).pushed).toBeGreaterThan(0);
    } finally {
      try { await capture.stop(); } finally { await source.close(); }
    }
    for (const workspace of [first, second]) await seedCloudCredentials(workspace, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, userId: "e2e-user" });
    async function joinWorkspace(workspace: typeof first) {
      const desktop = await launchDesktopApp({ workspace, env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" } });
      try {
        await desktop.page.getByTestId("first-run-join-synced").click();
        await desktop.page.getByTestId("join-sync-code").fill(`dohc-sync:${workspaceId}:${relay!.baseUrl}`);
        await desktop.page.getByTestId("join-choose-folder").click();
        await desktop.page.getByTestId("join-workspace-start").click();
        await waitForWorkspaceReady(desktop.page);
        await waitForWorkspaceFile(desktop.page, workspaceId, "shared.md");
        return desktop;
      } catch (error) { await desktop.close(); throw error; }
    }
    left = await joinWorkspace(first);
    right = await joinWorkspace(second);
    expect(left.app.process().pid).not.toBe(right.app.process().pid);
    const relayPort = relay.port;
    const relayDb = relay.dbPath;
    await relay.stop();
    relay = null;
    const leftText = "Chosen text from the first desktop.\n";
    const rightText = "Offline edit from the second desktop.\n";
    async function momentCount(desktop: NonNullable<typeof left>) {
      return desktop.page.evaluate(async (workspaceId) => {
        const result = await (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listEngineMoments({ workspaceId, limit: 100 });
        return "moments" in result ? result.moments.filter((entry) => entry.path === "shared.md").length : 0;
      }, workspaceId);
    }
    const beforeLeft = await momentCount(left);
    const beforeRight = await momentCount(right);
    await writeWorkspaceFiles(first, [{ path: "shared.md", contents: leftText }]);
    await writeWorkspaceFiles(second, [{ path: "shared.md", contents: rightText }]);
    await expect.poll(() => momentCount(left!)).toBeGreaterThan(beforeLeft);
    await expect.poll(() => momentCount(right!)).toBeGreaterThan(beforeRight);
    await right.close();
    right = null;
    const lastLeftSync = () => left!.page.evaluate(async (workspaceId) => {
      const status = await (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.getSyncStatus({ workspaceId });
      return status.lastSyncedAtMs ?? 0;
    }, workspaceId);
    const beforeReconnect = await lastLeftSync();
    relay = await spawnSyncRelay({ dbPath: relayDb, port: relayPort });
    await expect.poll(lastLeftSync, { timeout: 30_000 }).toBeGreaterThan(beforeReconnect);
    right = await launchDesktopApp({ workspace: second });
    await openWorkspaceFromFirstRun(right.page, second);
    await waitForWorkspaceFile(right.page, workspaceId, "shared.md");
    await expect(right.page.getByTestId("sync-status")).toHaveAttribute("data-state", "conflict", { timeout: 90_000 });
    await right.page.getByTestId("notice-center-toggle").click();
    await right.page.getByTestId("notice-sync-conflict").getByRole("button", { name: "Review", exact: true }).click();
    const card = right.page.locator('[data-testid="version-conflict"][data-conflict-path="shared.md"]');
    await expect(card).toContainText(leftText.trim());
    await expect(card).toContainText(rightText.trim());
    await card.getByTestId("version-conflict-keep-incoming").click();
    await expect(right.page.getByTestId("conflict-review-empty")).toBeVisible();
    await right.page.getByTestId("conflict-review-done").click();
    await expect.poll(() => readFile(join(second.rootPath, "shared.md"), "utf8")).toBe(leftText);
    await right.close();
    right = await launchDesktopApp({ workspace: second });
    await openWorkspaceFromFirstRun(right.page, second);
    await waitForWorkspaceFile(right.page, workspaceId, "shared.md");
    await explorerRow(right.page, "shared.md").click();
    await expect(right.page.getByTestId("markdown-editor")).toContainText(leftText.trim());
    expect(await readFile(join(second.rootPath, "shared.md"), "utf8")).toBe(leftText);
    const remaining = await right.page.evaluate(async (workspaceId) => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listWorkspaceVersionConflicts({ workspaceId }), workspaceId);
    expect(remaining.conflicts).toEqual([]);
  } finally {
    try {
    for (const [name, desktop] of [["left", left], ["right", right]] as const) {
      if (!desktop || desktop.page.isClosed()) continue;
      const status = await desktop.page.evaluate(async (workspaceId) => {
        const api = (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop;
        return { sync: await api.getSyncStatus({ workspaceId }), conflicts: await api.listWorkspaceVersionConflicts({ workspaceId }) };
      }, workspaceId).catch((error) => ({ error: String(error) }));
      await test.info().attach(`${name} sync status`, { body: JSON.stringify(status, null, 2), contentType: "application/json" });
      console.log(`[two-client] ${name}: ${JSON.stringify(status)}`);
    }
    } finally {
      await cleanupDesktopWorkspace(right, second);
      try { if (left) await left.close(); }
      finally { try { await relay?.stop(); } finally { await first.cleanup(); } }
    }
  }
});
