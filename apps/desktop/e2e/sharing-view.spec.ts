import { holdSystemClipboard } from "./helpers/systemClipboard";
import { activityPin, settingsNavPin } from "../src/testPins";
import { test, expect } from "@playwright/test";
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
// under Shared by me from Settings search and from the rail, copies its code,
// and ends it there.

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
      },
    });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await revealExplorerPath(page, "docs/plan.md");
    await explorerRow(page, "docs/plan.md").click({ button: "right" });
    await page.getByTestId("explorer-menu-item-share").click();
    const dialog = page.getByTestId("share-dialog");
    await dialog.getByTestId("share-email").fill(RECIPIENT_EMAIL);
    await dialog.getByTestId("share-create").click();
    const shareCode = (await dialog.getByTestId("share-code").textContent()) ?? "";
    const shareId = shareCode.split(":")[1]!;
    await dialog.getByTestId("share-done").click();

    // Settings keeps values only; its search still finds the share and opens
    // the Sharing view on its row.
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("cloud")).click();
    await expect(page.getByTestId("settings-section-cloud")).not.toContainText("Shared by me");
    await page.getByTestId("settings-search").fill("plan.md");
    await page.getByTestId("settings-sharing-result").filter({ hasText: "plan.md" }).click();
    const view = page.getByTestId("sharing-view");
    await expect(view).toBeVisible();
    await expect(page.getByTestId(activityPin("sharing"))).toHaveAttribute("aria-current", "page");

    // Shared by me lists the grant with what it covers and who has it, focused.
    const row = view.getByTestId("sharing-granted-row").filter({ hasText: "plan.md" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("docs/");
    await expect(row).toHaveAttribute("data-status", "active");
    await expect(row.locator("[data-sharing-row-focus]")).toBeFocused();

    // The row hands out the share's code from its actions, by keyboard.
    await page.keyboard.press("Tab");
    await expect(row.getByTestId("sharing-granted-actions").locator(":focus")).toHaveCount(1);
    await holdSystemClipboard(test.info(), async (remainingMs) => {
      await row.getByRole("button", { name: "Copy code" }).focus({ timeout: remainingMs() });
      await page.keyboard.press("Enter");
      await expect.poll(() => desktop!.app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: remainingMs() }).toBe(shareCode);
    });

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

// A share still on this computer that the relay no longer lists: it reads as
// removed and keeps Remove. Its skipped changes take Dismiss, and the row's
// menu shows them again.
test("sharing view: a removed share on this computer, its skipped changes, and Remove", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "sharing-view-mounts-e2e";
  const shareId = "share-gone";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await writeWorkspaceFiles(temp, [
      { path: "docs/plan.md", contents: "# Plan\n" },
      { path: "shared-with-me/notes/notes.md", contents: "# Notes\n" },
    ]);
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    await seedWorkspaceRegistry(temp, [{
      workspaceId, rootPath: temp.rootPath, remote: { serverUrl: relay.baseUrl, ownerUserId: "e2e-granter" },
      shareMounts: [{
        shareId, label: "notes", granterEmail: "sam@dohc.test", relayUrl: relay.baseUrl, recipientEmail: "e2e-granter@dohc.test",
        grantedSelector: { paths: ["notes.md"], versionId: null, access: "view" },
        skippedOps: {
          ops: [{ originId: "origin-sam", originSeq: 4, opKind: "write", code: "share-boundary-violation", detail: "notes/draft.md", atMs: 1 }],
          more: 0, generation: 2,
        },
      }],
    }]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: "e2e-granter@dohc.test",
      userId: "e2e-granter",
      token: GRANTER_TOKEN,
    });

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await page.getByTestId(activityPin("sharing")).click();
    const row = page.locator(`[data-testid="sharing-received-row"][data-share-id="${shareId}"]`);
    await expect(row).toHaveAttribute("data-status", "removed");
    await expect(row).toContainText("notes");
    await expect(row.getByTestId("sharing-row-status")).toHaveText("removed");

    // Dismiss hides the skipped changes; the record stays, so the menu shows them again.
    const skipped = page.getByTestId("sharing-skipped");
    await expect(skipped).toHaveCount(1);
    await page.getByTestId("sharing-skipped-dismiss").click();
    await expect(skipped).toHaveCount(0);
    await row.hover();
    await row.getByRole("button", { name: "Share actions" }).click();
    await page.getByRole("menuitem", { name: "Show skipped changes" }).click();
    await expect(skipped).toHaveCount(1);

    // Remove takes the share off this computer.
    await row.hover();
    await row.getByRole("button", { name: "Share actions" }).click();
    await page.getByRole("menuitem", { name: "Remove from workspace" }).click();
    await expect(row).toHaveCount(0);
  } finally {
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});
