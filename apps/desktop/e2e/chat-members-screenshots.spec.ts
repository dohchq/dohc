import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { waitForVisibleAnimations } from "./helpers/animations";
import { claimRelayWorkspace } from "./helpers/relayPeer";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  createTempWorkspace,
  openChatsView,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
} from "./helpers/workspace";

// Screenshot harness (@ui-audit) for a group's Members dialog: Add people
// empty, the member list, suggestions, picked people, and the header button
// it leaves behind. Light and dark. Not a regression test; it runs only when a
// shot directory is set, the way chat-agent-screenshots.spec.ts does.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture members screenshots");

const OWNER_TOKEN = "test:e2e-granter";
const OWNER_USER = "e2e-granter";
const OWNER_EMAIL = "e2e-granter@dohc.test";

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
  await waitForVisibleAnimations(page);
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

test("@ui-audit a group's Members dialog", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  const workspaceId = "members-shots";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay", "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: OWNER_TOKEN, workspaceId });
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceRegistry(temp, [
      { workspaceId, rootPath: temp.rootPath, remote: { serverUrl: relay.baseUrl, ownerUserId: OWNER_USER } },
    ]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: OWNER_EMAIL,
      userId: OWNER_USER,
      token: OWNER_TOKEN,
    });

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await openChatsView(page);
    // Another group's member, so Add people has someone new to suggest.
    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill("Design");
    await page.getByTestId("chats-new-channel-submit").click();
    await expect(page.getByTestId("chats-channel-title")).toHaveText("Design");
    await page.getByTestId("chats-share-channel").click();
    await page.getByTestId("chats-share-email").fill("dee@dohc.test");
    await page.getByTestId("chats-share-submit").click();
    await expect(page.getByTestId("chats-share-member")).toHaveCount(1);
    await page.getByTestId("chats-share-close").click();

    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill("Launch team");
    await page.getByTestId("chats-new-channel-submit").click();
    await expect(page.getByTestId("chats-channel-title")).toHaveText("Launch team");

    // No members yet: the dialog opens on Add people, its field focused.
    await page.getByTestId("chats-share-channel").click();
    await expect(page.getByTestId("chats-share-panel")).toBeVisible();
    await expect(page.getByTestId("chats-share-email")).toBeFocused();
    await shoot(page, "members-a-empty");

    // Two people picked as chips, one typed and one pasted.
    await page.getByTestId("chats-share-email").pressSequentially("ana@dohc.test,");
    await page.getByTestId("chats-share-email").pressSequentially("ben@dohc.test ");
    await expect(page.getByTestId("chats-share-chip")).toHaveCount(2);
    await page.getByTestId("chats-share-submit").click();
    await expect(page.getByTestId("chats-share-member")).toHaveCount(2);
    await expect(page.getByTestId("chats-share-panel")).toHaveAttribute("data-view", "members");
    await page.mouse.move(0, 0);
    await shoot(page, "members-b-list");

    // Pointing at a row shows its Remove.
    await page.getByTestId("chats-share-member").nth(1).hover();
    await shoot(page, "members-c-hover");

    // Add people suggests the people this account already shares with:
    // Dee from Design, and Ana and Ben marked as members already.
    await page.getByTestId("chats-share-add-people").click();
    await page.getByTestId("chats-share-email").pressSequentially("dohc");
    await expect(page.getByTestId("chats-share-suggestion")).toHaveCount(3);
    await page.mouse.move(0, 0);
    await shoot(page, "members-d-suggestions");

    // A new address, view only, picked and waiting for Add.
    await page.getByTestId("chats-share-email").fill("");
    await page.getByTestId("chats-share-email").pressSequentially("cy@dohc.test");
    await page.getByTestId("chats-share-email").press("Enter");
    await page.getByTestId("chats-share-readonly").click();
    await expect(page.getByTestId("chats-share-chip")).toHaveCount(1);
    await shoot(page, "members-e-picked");
    await page.getByTestId("chats-share-submit").click();
    await expect(page.getByTestId("chats-share-member")).toHaveCount(3);

    // Closed, the header keeps the member faces and the count.
    await page.getByTestId("chats-share-close").click();
    await expect(page.getByTestId("chats-share-panel")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await shoot(page, "members-f-header");
  } finally {
    try { await desktop?.close(); } catch (error) { console.error("Desktop cleanup failed:", error); }
    try { await relay?.stop(); } catch (error) { console.error("Relay cleanup failed:", error); }
    try { await temp.cleanup(); } catch (error) { console.error("Workspace cleanup failed:", error); }
  }
});
