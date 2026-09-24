import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  writeWorkspaceFiles,
} from "./helpers/workspace";

type Bridge = Pick<DohcDesktopBridge, "cloudEnableSync">;

// Every label the title bar shows, in order, from the moment this is called.
async function recordTitlebar(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __titlebar: string[] }).__titlebar = seen;
    const read = () => {
      const label = document.querySelector('[data-testid="sync-status"]')?.textContent ?? "";
      if (seen.at(-1) !== label) seen.push(label);
    };
    read();
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
  return () => page.evaluate(() => (window as unknown as { __titlebar: string[] }).__titlebar);
}

// edges-05, edges-11, share-09. With the relay down, the title bar read
// "Saving…" for the whole outage beside files already on disk. Nothing said so
// for three failed passes, and the row that came then named no cause, offered
// no Try again, and had nothing to copy.
test("a sync the server cannot take names the server, offers Try again, and clears on recovery", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "sync-failure-e2e";
  const relayDb = join(temp.baseDir, "relay.sqlite");
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await writeWorkspaceFiles(temp, [{ path: "notes/plan.md", contents: "local draft\n" }]);
    relay = await spawnSyncRelay({ dbPath: relayDb });
    const port = relay.port;
    await seedWorkspaceRegistry(temp, [{ workspaceId, rootPath: temp.rootPath }]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      userId: "e2e-user",
    });
    desktop = await launchDesktopApp({
      workspace: temp,
      env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" },
    });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, temp);
    await page.evaluate(async (id) => {
      await (window as unknown as { dohcDesktop: Bridge }).dohcDesktop.cloudEnableSync({
        workspaceId: id,
      });
    }, workspaceId);
    const titlebar = page.getByTestId("sync-status");
    await expect(titlebar).toHaveAttribute("data-state", "synced", { timeout: 60_000 });
    const labels = await recordTitlebar(page);

    await relay.stop();
    relay = null;
    await writeFile(join(temp.rootPath, "notes/plan.md"), "local draft\n\nwritten while the server is down\n");

    // The first failed pass says so: a toast and a row, with the cause, Try
    // again and copy. The title bar names the server.
    const toast = page.getByTestId("workspace-shell-error");
    await expect(toast).toContainText(
      "dohc could not reach the server. Your changes are saved on this machine.",
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("workspace-shell-error-retry")).toBeVisible();
    await expect(page.getByTestId("workspace-shell-error-copy")).toBeVisible();
    await expect(titlebar).toHaveText("Server unreachable");
    await page.getByTestId("notice-center-toggle").click();
    await expect(page.getByTestId("notice-center")).toContainText("dohc could not reach the server.");
    await page.getByTestId("notice-center-toggle").click();

    // The server comes back. Try again syncs now, and the failure goes.
    relay = await spawnSyncRelay({ dbPath: relayDb, port });
    await page.getByTestId("workspace-shell-error-retry").click();
    await expect(titlebar).toHaveAttribute("data-state", "synced", { timeout: 60_000 });
    await expect(page.getByTestId("workspace-shell-error")).toHaveCount(0);

    const seen = await labels();
    expect(seen.filter((label) => label.includes("Saving"))).toEqual([]);
    expect(seen).toContain("Server unreachable");
  } finally {
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
