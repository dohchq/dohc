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
// no Try again, and had nothing to copy. A single failed pass files a row;
// it interrupts only when it persists or when a retry the person asked for
// fails.
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
      // A backoff no test waits out: only Try again can start a pass.
      env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "600000" },
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

    // One failed pass: the title bar names the server and Notices has the
    // row, with no toast yet.
    await expect(titlebar).toHaveText("Server unreachable", { timeout: 60_000 });
    const toast = page.getByTestId("workspace-shell-error");
    await expect(toast).toHaveCount(0);
    const notices = page.getByTestId("notice-center");
    await page.getByTestId("notice-center-toggle").click();
    await expect(notices).toContainText(
      "dohc could not reach the server.",
    );

    // Try again from the row, while the server is still down: the title bar
    // shows the pass, and its failure interrupts with Try again and copy.
    await notices.getByRole("button", { name: "Try again" }).click();
    await expect(toast).toContainText("dohc could not reach the server.", { timeout: 60_000 });
    await expect(page.getByTestId("workspace-shell-error-retry")).toBeVisible();
    await expect(page.getByTestId("workspace-shell-error-copy")).toBeVisible();
    await expect(titlebar).toHaveText("Server unreachable");

    // The server comes back. Nothing else would start a pass for ten
    // minutes, so recovery within seconds is Try again's doing.
    relay = await spawnSyncRelay({ dbPath: relayDb, port });
    await page.getByTestId("workspace-shell-error-retry").click();
    await expect(titlebar).toHaveAttribute("data-state", "synced", { timeout: 15_000 });
    await expect(toast).toHaveCount(0);

    const seen = await labels();
    expect(seen.filter((label) => label.includes("Saving"))).toEqual([]);
    expect(seen).toContain("Server unreachable");
    expect(seen).toContain("Syncing…");
  } finally {
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
