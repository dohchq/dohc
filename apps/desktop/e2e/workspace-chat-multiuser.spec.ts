import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createLinkedChatStore,
  fetchSharedChannelInfo,
  pullSharedChannel,
  pushSharedChannel,
} from "@dohc/workspace-engine";
import { claimRelayWorkspace } from "./helpers/relayPeer";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  seedWorkspaceSettings,
} from "./helpers/workspace";

// MU-C6 — the multi-user chat + co-presence PRODUCT proof, driven through the
// REAL Electron app. One real desktop app is the channel OWNER (signed in as
// the granter over a real relay child process); a SECOND relay client is the
// participant the channel is shared to. The participant is exercised through
// the SAME public relay surface the desktop's own main process uses — the
// share presence route (a participant's ephemeral awareness path) and the
// workspace-engine shared-channel push/pull helpers (a participant's durable
// chat path) — because the serial single-display harness runs one Electron
// instance at a time (the 0P-C / MU integration pattern).
//
// What this proves in the real app that unit/integration tests cannot:
//   • the owner creates a channel and sends a message and it RENDERS;
//   • the owner shares the channel to the participant from the real Chats UI;
//   • when both view the shared channel, the owner's real app RENDERS the
//     participant's presence face (channel scope via the wireId topic) and,
//     inside a thread, the participant's TYPING indicator (thread scope) — the
//     participant-side co-presence this branch wired — and the participant's
//     own relay view converges on the owner (bidirectional);
//   • a participant's reply and reaction, pushed over the share, converge back
//     into the owner's real app after a refresh.

const GRANTER_TOKEN = "test:e2e-granter";
const GRANTER_USER = "e2e-granter";
const GRANTER_EMAIL = "e2e-granter@dohc.test";
const RECIPIENT_TOKEN = "test:e2e-recipient";
// The relay resolves the bearer `test:e2e-recipient` to this user id and
// VERIFIES chat authorship (authorUserId / reaction authorId) against it, so
// the participant's local ops must be authored as this id, not the raw token.
const RECIPIENT_USER = "e2e-recipient";
const RECIPIENT_EMAIL = "e2e-recipient@dohc.test";

interface PresencePeer {
  userId: string;
  clientId: string;
  state?: { displayName?: string; typing?: boolean } | null;
}

// The participant's presence path: publish/poll over the SHARE route (the relay
// maps the share to the granter's workspace, so this lands in the owner's
// scope). Mirrors the sync-relay presence.integration helper.
async function sharePresence(
  baseUrl: string,
  token: string,
  shareId: string,
  topic: string,
  body: Record<string, unknown>,
): Promise<{ status: number; peers: PresencePeer[]; raw: string }> {
  const response = await fetch(
    `${baseUrl}/sync/shares/${encodeURIComponent(shareId)}/presence?topic=${encodeURIComponent(topic)}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const raw = await response.text();
  let peers: PresencePeer[] = [];
  if (response.ok) {
    try {
      peers = (JSON.parse(raw) as { peers?: PresencePeer[] }).peers ?? [];
    } catch {
      peers = [];
    }
  }
  return { status: response.status, peers, raw };
}

// Discover the live chat-channel grant the owner just created, from the real
// app's own IPC surface (granted rows carry the shareId + cross-machine
// channelWireId both sides key on).
async function grantedShare(
  page: Page,
  workspaceId: string,
): Promise<{ shareId: string; channelWireId: string }> {
  return await page.waitForFunction(async (id) => {
    const api = (
      window as unknown as {
        dohcDesktop: {
          listChatChannelShares(payload: { workspaceId: string }): Promise<{
            granted: Array<{ shareId: string; channelWireId: string; revokedAtMs: number | null }>;
          }>;
        };
      }
    ).dohcDesktop;
    const shares = await api.listChatChannelShares({ workspaceId: id }).catch(() => null);
    const live = shares?.granted.find((row) => row.revokedAtMs === null) ?? null;
    return live ? { shareId: live.shareId, channelWireId: live.channelWireId } : null;
  }, workspaceId).then(
    // waitForFunction only resolves on a truthy result, so the polled `null`
    // branch is excluded at runtime — narrow the jsonValue union accordingly.
    (handle) => handle.jsonValue() as Promise<{ shareId: string; channelWireId: string }>,
  );
}

test("owner + participant chat and co-presence converge in the real app", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "chat-mu-e2e";
  const memberDir = join(temp.baseDir, "member-machine");
  const memberWs = "chat-mu-member";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  const recipientRelay = (baseUrl: string) => ({ baseUrl, token: RECIPIENT_TOKEN });

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceSettings(temp, { experimental: { workspaceEngineAlpha: true } });

    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    // A synced workspace: presence WORKSPACE scope only resolves for a
    // relay-claimed workspace on the signed-in server, and the sync engine
    // attaches at open so the owner's chat.thread.create replicates to the
    // relay (the thread-topic presence gate reads that binding).
    await seedWorkspaceRegistry(temp, [
      {
        workspaceId,
        rootPath: temp.rootPath,
        remote: { serverUrl: relay.baseUrl, remoteWorkspaceId: workspaceId },
      },
    ]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: GRANTER_EMAIL,
      userId: GRANTER_USER,
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
    const baseUrl = relay.baseUrl;

    // --- (a) OWNER creates a channel, starts a thread, sends a message ------
    await page.getByTestId("titlebar-chats-sidebar").click();
    await expect(page.getByTestId("chats-view")).toBeVisible();

    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill("launch");
    await page.getByTestId("chats-new-channel-name").press("Enter");
    // createChannel opens the new channel directly.
    await expect(page.getByTestId("chats-channel-view")).toBeVisible();
    await expect(page.getByTestId("chats-channel-title")).toHaveText("launch");

    await page.getByTestId("chats-new-thread-composer").fill("Kickoff the launch plan.");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-thread-view")).toBeVisible();
    await expect(page.getByTestId("chats-message-body")).toContainText(
      "Kickoff the launch plan.",
    );
    // Capture the thread id (its own cross-machine id → the thread presence topic).
    await page.getByTestId("chats-thread-back").click();
    await expect(page.getByTestId("chats-channel-view")).toBeVisible();
    const threadId = await page
      .getByTestId("chats-thread")
      .first()
      .getAttribute("data-thread-id");
    expect(threadId).toBeTruthy();

    // --- (b) OWNER shares the channel to the participant from the Chats UI --
    await page.getByTestId("chats-share-channel").click();
    await expect(page.getByTestId("chats-share-panel")).toBeVisible();
    await page.getByTestId("chats-share-email").fill(RECIPIENT_EMAIL);
    await page.getByTestId("chats-share-submit").click();
    // The grant lands (a member row appears in the panel).
    await expect(page.getByTestId("chats-share-member")).toContainText(RECIPIENT_EMAIL);

    const { shareId, channelWireId } = await grantedShare(page, workspaceId);
    expect(channelWireId.length).toBeGreaterThan(0);

    // --- (e1) CHANNEL-level co-presence: the participant appears in the owner's
    // real app, and the participant's own relay view converges on the owner. The
    // owner publishes channel presence while viewing the channel, so poll the
    // participant's publish until it sees the owner (bidirectional convergence).
    let sawOwner = false;
    await expect
      .poll(
        async () => {
          const result = await sharePresence(baseUrl, RECIPIENT_TOKEN, shareId, channelWireId, {
            clientId: "member-channel",
            state: { displayName: "Morgan", typing: false },
          });
          if (result.status !== 200) return `status:${result.status}`;
          sawOwner = result.peers.some((peer) => peer.userId === GRANTER_USER);
          return sawOwner ? "owner-present" : "owner-absent";
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBe("owner-present");
    expect(sawOwner).toBe(true);

    // The owner's REAL app renders the participant's presence face.
    await expect(page.locator('[aria-label="Morgan is here"]')).toBeVisible({ timeout: 30_000 });

    // --- (e2) THREAD-level typing: the participant typing in the shared thread
    // renders as a typing indicator in the owner's real thread view. The thread
    // topic is only admitted once the owner's chat.thread.create has replicated
    // to the relay (the participant's publish 404s until then), so re-publish on
    // an interval while the owner sits in the thread.
    await page.getByTestId("chats-thread").first().click();
    await expect(page.getByTestId("chats-thread-view")).toBeVisible();
    const threadTopic = `chat:thread:${threadId}`;
    const stopTyping = { done: false };
    const typingPump = (async () => {
      while (!stopTyping.done) {
        await sharePresence(baseUrl, RECIPIENT_TOKEN, shareId, threadTopic, {
          clientId: "member-thread",
          state: { displayName: "Morgan", typing: true },
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    })();
    try {
      await expect(page.getByTestId("presence-typing")).toContainText("Morgan is typing", {
        timeout: 45_000,
      });
      await expect(page.locator('[aria-label="Morgan is here"]')).toBeVisible();
    } finally {
      stopTyping.done = true;
      await typingPump;
    }

    // --- (c) + (d) DURABLE convergence: the participant pulls the shared
    // channel, replies, and reacts to the owner's message; the owner's real app
    // shows both after re-opening the thread.
    const relayConn = recipientRelay(baseUrl);
    const info = await fetchSharedChannelInfo({ relay: relayConn, shareId });
    expect(info.channelWireId).toBe(channelWireId);
    await pullSharedChannel({
      rootDir: memberDir,
      workspaceId: memberWs,
      relay: relayConn,
      shareId,
      channelWireId,
    });

    const memberStore = createLinkedChatStore(memberDir);
    let ownerMessageId = "";
    try {
      const messages = await memberStore.listMessages({ workspaceId: memberWs, threadId: threadId! });
      expect(messages.length).toBeGreaterThan(0);
      ownerMessageId = messages[0]!.id;
      // The participant's reply.
      await memberStore.sendMessage({
        workspaceId: memberWs,
        threadId: threadId!,
        author: { kind: "human", displayName: "Morgan" },
        authorUserId: RECIPIENT_USER,
        body: "Joining from the other side — count me in.",
      });
      // The participant reacts to the owner's first message.
      await memberStore.setReaction({
        workspaceId: memberWs,
        threadId: threadId!,
        messageId: ownerMessageId,
        emoji: "🚀",
        author: { authorId: RECIPIENT_USER, kind: "human", displayName: "Morgan" },
        replicationAuthorId: RECIPIENT_USER,
        state: "added",
      });
    } finally {
      await memberStore.close();
    }
    const pushed = await pushSharedChannel({
      rootDir: memberDir,
      workspaceId: memberWs,
      relay: relayConn,
      shareId,
      channelWireId,
    });
    expect(pushed.pushed).toBeGreaterThan(0);

    // The member's ops are in the OWNER's workspace bucket (share-namespaced
    // origin); the owner ingests them through its NORMAL workspace pull, which
    // applies chat ops via syncApply. An idle owner won't poll the relay on its
    // own (the relay is pull-based, no server push), so nudge the owner's sync
    // engine each iteration with a throwaway file write — the same wake pattern
    // the offline-rejoin spec uses — then re-open the thread to refetch.
    let nudge = 0;
    await expect
      .poll(
        async () => {
          nudge += 1;
          await writeFile(join(temp.rootPath, `sync-nudge-${nudge}.md`), `nudge ${nudge}\n`);
          await page.getByTestId("chats-thread-back").click().catch(() => undefined);
          await page.getByTestId("chats-thread").first().click().catch(() => undefined);
          return await page
            .getByTestId("chats-message-body")
            .filter({ hasText: "count me in" })
            .count();
        },
        { timeout: 90_000, intervals: [2000] },
      )
      .toBeGreaterThan(0);
    await expect(
      page.getByTestId("chats-message-body").filter({ hasText: "count me in" }),
    ).toBeVisible();
    // The participant's reaction on the owner's message rendered too.
    await expect(page.getByText("🚀").first()).toBeVisible({ timeout: 15_000 });
  } finally {
    // Stop the relay child BEFORE removing the temp tree: its sqlite db lives
    // under temp.baseDir, and Windows refuses to unlink files a live process
    // still holds open (EBUSY). POSIX tolerates the old order; Windows does not.
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});
