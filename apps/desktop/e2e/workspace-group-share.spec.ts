import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { claimRelayWorkspace } from "./helpers/relayPeer";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// A group is a channel with a folder, shared as one grant. Two real
// desktops over one relay: the owner creates the group, writes a file into
// its folder, posts, and shares it by email. The recipient joins from
// Shared with you and gets the channel and the folder in one action, posts
// back, and the owner sees the reply.
//
// Both desktops run at once. The harness is serial per spec, so the two
// instances share one display; nothing here depends on focus.

const OWNER_TOKEN = "test:e2e-granter";
const OWNER_USER = "e2e-granter";
const OWNER_EMAIL = "e2e-granter@dohc.test";
const MEMBER_TOKEN = "test:e2e-recipient";
const MEMBER_USER = "e2e-recipient";
const MEMBER_EMAIL = "e2e-recipient@dohc.test";

// The titlebar control toggles the Chats sidebar, and opening a file moves
// the sidebar to its "This file" tab. Bring the panel up if it is hidden,
// then select the Chats tab.
async function openChats(page: Page): Promise<void> {
  if (!(await page.getByTestId("chats-panel").isVisible())) {
    await page.getByTestId("titlebar-chats-sidebar").click();
    await expect(page.getByTestId("chats-panel")).toBeVisible();
  }
  const chatsTab = page.getByTestId("chats-panel-tab-all");
  if ((await chatsTab.getAttribute("aria-pressed")) !== "true") await chatsTab.click();
  await expect(chatsTab).toHaveAttribute("aria-pressed", "true");
}

test("@two-client a group shares its channel and folder together, and both sides post", async () => {
  test.setTimeout(300_000);
  const ownerTemp = await createTempWorkspace();
  const memberTemp = await createTempWorkspace();
  const ownerWorkspaceId = "group-share-owner";
  const memberWorkspaceId = "group-share-member";
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let member: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const syncEnv = { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };

  try {
    relay = await spawnSyncRelay({ dbPath: join(ownerTemp.baseDir, "relay.sqlite") });

    // The owner's synced workspace, signed in as the granter. The relay
    // only issues shares for a workspace the owner has claimed.
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: OWNER_TOKEN, workspaceId: ownerWorkspaceId });
    await seedWorkspaceManifest(ownerTemp, ownerWorkspaceId);
    await seedWorkspaceRegistry(ownerTemp, [
      {
        workspaceId: ownerWorkspaceId,
        rootPath: ownerTemp.rootPath,
        remote: { serverUrl: relay.baseUrl, ownerUserId: OWNER_USER },
      },
    ]);
    await seedCloudCredentials(ownerTemp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: OWNER_EMAIL,
      userId: OWNER_USER,
      token: OWNER_TOKEN,
    });
    // The member's own local workspace, signed in as the recipient.
    await seedWorkspaceManifest(memberTemp, memberWorkspaceId);
    await writeWorkspaceFiles(memberTemp, [
      { path: "notes/mine.md", contents: "# Mine\n\nThe member's own file.\n" },
    ]);
    await seedWorkspaceRegistry(memberTemp, [
      { workspaceId: memberWorkspaceId, rootPath: memberTemp.rootPath },
    ]);
    await seedCloudCredentials(memberTemp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: MEMBER_EMAIL,
      userId: MEMBER_USER,
      token: MEMBER_TOKEN,
    });

    owner = await launchDesktopApp({ workspace: ownerTemp, env: syncEnv });
    await openWorkspaceFromFirstRun(owner.page, ownerTemp);

    // --- The owner creates a group that holds posts and chat -------------
    await openChats(owner.page);
    await owner.page.getByTestId("chats-new-channel").click();
    await owner.page.getByTestId("chats-new-channel-name").fill("Launch team");
    await owner.page.getByTestId("chats-new-channel-purpose").fill("Ship the launch.");
    await owner.page.getByTestId("chats-new-channel-type-both").click();
    await owner.page.getByTestId("chats-new-channel-submit").click();
    await expect(owner.page.getByTestId("chats-channel-view")).toBeVisible();
    await expect(owner.page.getByTestId("chats-channel-title")).toHaveText("Launch team");
    // The group's folder exists the moment the group does.
    await waitForWorkspaceFile(owner.page, ownerWorkspaceId, "launch-team");

    // A file in the group's folder and one outside it, then a post.
    await writeWorkspaceFiles(ownerTemp, [
      { path: "launch-team/plan.md", contents: "# Plan\n\nThe lighthouse memo.\n" },
      { path: "private/ledger.md", contents: "The kraken ledger stays private.\n" },
    ]);
    await waitForWorkspaceFile(owner.page, ownerWorkspaceId, "launch-team/plan.md");
    await owner.page.getByTestId("chats-new-thread-composer").fill("Kickoff: read the plan.");
    await owner.page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(owner.page.getByTestId("chats-thread-view")).toBeVisible();
    await expect(owner.page.getByTestId("chats-message-body")).toContainText("Kickoff: read the plan.");
    await owner.page.getByTestId("chats-thread-back").click();
    await expect(owner.page.getByTestId("chats-channel-view")).toBeVisible();

    // --- The owner shares the group by email ----------------------------
    await owner.page.getByTestId("chats-share-channel").click();
    await expect(owner.page.getByTestId("chats-share-panel")).toBeVisible();
    await owner.page.getByTestId("chats-share-email").fill(MEMBER_EMAIL);
    await owner.page.getByTestId("chats-share-submit").click();
    await expect(owner.page.getByTestId("chats-share-member")).toContainText(MEMBER_EMAIL);

    // The relay holds one grant, a group naming the channel and its folder.
    const listing = await fetch(`${relay.baseUrl}/sync/shares`, {
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(listing.status).toBe(200);
    const granted = ((await listing.json()) as {
      granted: Array<{ shareId: string; selector: { kind?: string; paths?: string[] }; revokedAtMs: number | null }>;
    }).granted.filter((row) => row.revokedAtMs === null);
    expect(granted).toHaveLength(1);
    expect(granted[0]!.selector).toMatchObject({ kind: "group", paths: ["launch-team"] });
    const shareId = granted[0]!.shareId;

    // The owner's sync pushes on its own cadence. Wait until the relay serves
    // the folder's file through the grant, so the member's mount has it to
    // pull. This is the folder half: the page names no channel.
    await expect
      .poll(
        async () => {
          const page = await fetch(
            `${relay!.baseUrl}/sync/shares/${encodeURIComponent(shareId)}/log?since=0&limit=200`,
            { headers: { authorization: `Bearer ${MEMBER_TOKEN}` } },
          );
          if (page.status !== 200) return `status:${page.status}`;
          const ops = ((await page.json()) as {
            ops: Array<{ opKind: string; payload: Record<string, unknown> }>;
          }).ops;
          const kinds = ops.map((op) => `${op.opKind}:${String(op.payload.payloadAfterPath ?? op.payload.path ?? "")}`);
          return kinds.some((kind) => kind === "moment.append:launch-team/plan.md") ? "served" : kinds.join(",");
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe("served");

    // --- The member joins from Shared with you ---------------------------
    member = await launchDesktopApp({ workspace: memberTemp, env: syncEnv });
    expect(member.app.process().pid).not.toBe(owner.app.process().pid);
    await openWorkspaceFromFirstRun(member.page, memberTemp);
    await openChats(member.page);
    await expect(member.page.getByTestId("chats-shared-with-you")).toBeVisible({ timeout: 60_000 });
    await member.page.getByTestId("chats-join-shared").click();

    // The channel arrives with the owner's post.
    const joinedChannel = member.page.getByTestId("chats-channel").filter({ hasText: "Launch team" });
    await expect(joinedChannel).toBeVisible({ timeout: 60_000 });
    await joinedChannel.click();
    await expect(member.page.getByTestId("chats-channel-view")).toBeVisible();
    await expect(member.page.getByTestId("chats-thread").first()).toContainText("Kickoff: read the plan.", {
      timeout: 60_000,
    });

    // The folder arrives beside the member's own files, labeled by the
    // group's name; the owner's private file never crosses.
    await revealExplorerPath(member.page, "shared-with-me/launch-team/launch-team/plan.md");
    await expect(explorerRow(member.page, "shared-with-me/launch-team/private")).toHaveCount(0);
    await revealExplorerPath(member.page, "notes/mine.md");
    await explorerRow(member.page, "shared-with-me/launch-team/launch-team/plan.md").click();
    await expect(member.page.getByText("The lighthouse memo.")).toBeVisible();

    // --- The member posts back in the group's chat lane ------------------
    // The panel comes back where it was left: inside the group.
    await openChats(member.page);
    if (!(await member.page.getByTestId("chats-channel-view").isVisible())) {
      await joinedChannel.click();
    }
    await expect(member.page.getByTestId("chats-channel-title")).toHaveText("Launch team");
    // The group's type crossed with the channel: both lanes are here.
    await expect(member.page.getByTestId("chats-channel-view")).toHaveAttribute("data-group-type", "both");
    await member.page.getByTestId("chats-group-lane-chat").click();
    await expect(member.page.getByTestId("chats-lane")).toBeVisible();
    await member.page.getByTestId("chats-lane-composer").fill("Read it. Count me in.");
    await member.page.getByTestId("chats-lane-composer").press("Enter");
    await expect(member.page.getByTestId("chats-lane-message-body")).toContainText("Read it. Count me in.");

    // --- The owner sees the reply -----------------------------------------
    // An idle owner pulls on its own sync cadence; a throwaway write wakes
    // it, the same way the multiuser spec does.
    let nudge = 0;
    await expect
      .poll(
        async () => {
          nudge += 1;
          await writeFile(join(ownerTemp.rootPath, `sync-nudge-${nudge}.md`), `nudge ${nudge}\n`);
          await owner!.page.getByTestId("chats-group-lane-posts").click().catch(() => undefined);
          await owner!.page.getByTestId("chats-group-lane-chat").click().catch(() => undefined);
          return await owner!.page
            .getByTestId("chats-lane-message-body")
            .filter({ hasText: "Count me in" })
            .count();
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .toBeGreaterThan(0);
  } finally {
    try { await member?.close(); } catch (error) { console.error("Member cleanup failed:", error); }
    try { await owner?.close(); } catch (error) { console.error("Owner cleanup failed:", error); }
    try { await relay?.stop(); } catch (error) { console.error("Relay cleanup failed:", error); }
    try { await memberTemp.cleanup(); } catch (error) { console.error("Member workspace cleanup failed:", error); }
    try { await ownerTemp.cleanup(); } catch (error) { console.error("Owner workspace cleanup failed:", error); }
  }
});
