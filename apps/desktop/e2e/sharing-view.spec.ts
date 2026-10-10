import { activityPin, settingsNavPin } from "../src/testPins";
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { claimRelayWorkspace, relayJson } from "./helpers/relayPeer";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// The Sharing view on a real relay: the owner shares a file, finds the share
// under Shared by me from the rail and from Settings, and ends it there.

const GRANTER_TOKEN = "test:e2e-granter";
const RECIPIENT_TOKEN = "test:e2e-recipient";
const RECIPIENT_EMAIL = "e2e-recipient@dohc.test";

test("sharing view: lists a share this workspace granted and ends it", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "sharing-view-e2e";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await writeWorkspaceFiles(temp, [{ path: "docs/plan.md", contents: "# Plan\n\nShare me.\n" }]);
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    await seedWorkspaceRegistry(temp, [
      { workspaceId, rootPath: temp.rootPath, remote: { serverUrl: relay.baseUrl, ownerUserId: "e2e-granter" } },
    ]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: "e2e-granter@dohc.test",
      userId: "e2e-granter",
      token: GRANTER_TOKEN,
    });

    desktop = await launchDesktopApp({
      workspace: temp,
      env: {
        DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
        DOHC_TEST_SYNC_BACKOFF_MS: "250",
        DOHC_TEST_EXPLORER_MENU_CHOICE: "share",
      },
    });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await revealExplorerPath(page, "docs/plan.md");
    await explorerRow(page, "docs/plan.md").click({ button: "right" });
    const dialog = page.getByTestId("share-dialog");
    await dialog.getByTestId("share-email").fill(RECIPIENT_EMAIL);
    await dialog.getByTestId("share-create").click();
    const shareCode = (await dialog.getByTestId("share-code").textContent()) ?? "";
    const shareId = shareCode.split(":")[1]!;
    await dialog.getByTestId("share-done").click();

    // Settings points its list at the Sharing view.
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("cloud")).click();
    await page.getByTestId("settings-manage-sharing-granted").click();
    const view = page.getByTestId("sharing-view");
    await expect(view).toBeVisible();
    await expect(page.getByTestId(activityPin("sharing"))).toHaveAttribute("aria-current", "page");

    // Shared by me lists the grant with what it covers and who has it.
    const row = view.getByTestId("sharing-granted-row").filter({ hasText: "plan.md" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("docs/");
    await expect(row).toHaveAttribute("data-status", "active");

    // The rail button closes and reopens the same view.
    await page.getByTestId(activityPin("sharing")).click();
    await expect(view).toBeHidden();
    await page.getByTestId(activityPin("sharing")).click();
    await expect(row).toBeVisible();

    // End share moved here with its question: ask, then end.
    await row.hover();
    await row.getByRole("button", { name: "Share actions" }).click();
    await page.getByRole("menuitem", { name: "End share…" }).click();
    const confirm = page.getByTestId("sharing-end-confirm");
    await expect(confirm).toContainText(`End this share? ${RECIPIENT_EMAIL} keeps a read-only copy`);
    await confirm.getByTestId("sharing-end").click();
    await expect(confirm).toBeHidden();

    // The relay ended it: the recipient's next fetch is refused.
    await expect
      .poll(async () => (await relayJson(relay!.baseUrl, RECIPIENT_TOKEN, `/sync/shares/${shareId}/log?since=0`)).status, {
        timeout: 30_000,
      })
      .toBe(404);
  } finally {
    // Stop the relay before removing the temp tree it holds open (Windows EBUSY).
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});
