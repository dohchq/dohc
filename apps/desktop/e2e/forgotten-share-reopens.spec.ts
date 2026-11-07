import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RelayFilePeer } from "../src/testing/relayFilePeer";
import { claimRelayWorkspace, relayJson } from "./helpers/relayPeer";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import { cleanupDesktopWorkspace, createTempWorkspace, explorerRow, revealExplorerPath, seedCloudCredentials } from "./helpers/workspace";

const GRANTER_TOKEN = "test:e2e-granter";
const RECIPIENT_TOKEN = "test:e2e-recipient";
const RECIPIENT_EMAIL = "e2e-recipient@dohc.test";

// A person opens a share into a folder, removes it from the list, and later
// chooses that folder in Open folder. It opens as the same share, read-only,
// and the server still decides what it shows.
test("a forgotten share's folder opens again as that share", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  const workspaceId = "forgotten-share-e2e";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay", "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    const granter = new RelayFilePeer({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    await granter.writeTextFiles([
      { path: "docs/shared.md", text: "# Shared\n\nThe comet-tail draft.\n" },
      { path: "private/hidden.md", text: "The kraken ledger stays private.\n" },
    ]);
    const create = await relayJson(relay.baseUrl, GRANTER_TOKEN, `/sync/${workspaceId}/shares`, {
      method: "POST",
      body: JSON.stringify({ recipientEmail: RECIPIENT_EMAIL, paths: ["docs"], access: "view" }),
    });
    expect(create.status).toBe(200);
    const shareId = (JSON.parse(create.body) as { shareId: string }).shareId;

    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, email: RECIPIENT_EMAIL, userId: "e2e-recipient", token: RECIPIENT_TOKEN,
    });
    desktop = await launchDesktopApp({ workspace: temp });
    const app = desktop.app;
    const page = desktop.page;
    await page.getByTestId("first-run-open-share").click();
    await page.getByTestId("open-share-code").fill(`dohc-share:${shareId}:${relay.baseUrl}`);
    await page.getByTestId("open-share-choose-folder").click();
    await expect(page.getByTestId("open-shared-view")).toContainText(temp.rootPath);
    await page.getByTestId("open-share-start").click();
    await expect(page.getByTestId("shared-view-banner")).toContainText("read-only");

    // Remove it from the workspace manager's list. The folder stays.
    await page.getByTestId("workspace-switcher").click();
    const managerOpened = app.waitForEvent("window");
    await page.getByTestId("workspace-switcher-manage").click();
    const manager = await managerOpened;
    await manager.getByRole("button", { name: "More for workspace", exact: true }).click();
    await manager.getByRole("menuitem", { name: "Remove from list", exact: true }).click();
    // A shared view asks first.
    await manager.getByTestId("workspace-remove-confirm-button").click();
    await expect(manager.getByTestId("workspace-manager-row")).toHaveCount(0);

    // The workspace windows that show the share's banner, whichever window
    // dohc uses for it.
    const shareWindows = async (): Promise<Page[]> => {
      const showing: Page[] = [];
      for (const candidate of app.windows()) {
        if (candidate === manager || candidate.isClosed()) continue;
        if (await candidate.getByTestId("shared-view-banner").count().catch(() => 0) > 0) showing.push(candidate);
      }
      return showing;
    };
    await expect.poll(async () => (await shareWindows()).length, { message: "No window shows the forgotten share." }).toBe(0);

    // Open folder on the same folder, which DOHC_TEST_PICK_PATH chooses. dohc
    // can reuse a window or open a new one.
    await manager.getByTestId("workspace-manager").getByRole("button", { name: "Open folder", exact: true }).click();
    await expect.poll(async () => (await shareWindows()).length, { timeout: 60_000 }).toBe(1);
    const [share] = await shareWindows();
    if (!share) throw new Error("The reopened share has no window.");
    await expect(share.getByTestId("workspace-shell")).toBeVisible();
    const banner = share.getByTestId("shared-view-banner");
    await expect(banner).toContainText("Shared view from");
    await expect(banner).toContainText("read-only");
    const registered = await share.evaluate(async () => {
      if (!window.dohcDesktop) throw new Error("Desktop bridge is unavailable");
      return (await window.dohcDesktop.getWorkspaceRegistry()).workspaces.map((entry) => entry.shareView?.shareId ?? null);
    });
    expect(registered).toEqual([shareId]);
    await revealExplorerPath(share, "docs/shared.md");
    await expect(explorerRow(share, "private")).toHaveCount(0);

    // A file the sharer adds later arrives from the server.
    await granter.writeTextFiles([{ path: "docs/later.md", text: "# Later\n\nThe harbor schedule.\n" }]);
    await share.getByTestId("shared-view-refresh").click();
    const later = join(temp.rootPath, "docs", "later.md");
    await expect.poll(() => readFile(later, "utf8").catch(() => null), { timeout: 60_000 }).toBe("# Later\n\nThe harbor schedule.\n");
    await revealExplorerPath(share, "docs/later.md");
    expect(existsSync(join(temp.rootPath, "private"))).toBe(false);
  } finally {
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
