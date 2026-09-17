import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { seedThroughDaemon } from "./helpers/daemonSeed";
import { runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { launchDesktopApp } from "./helpers/desktopApp";
import { claimRelayWorkspace } from "./helpers/relayPeer";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openFileChatsPanel,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "./helpers/workspace";

const messageCount = 300;
const author = { kind: "human" as const, displayName: "Reader" };

async function openChats(page: Page): Promise<Locator> {
  const panel = page.getByTestId("chats-panel");
  if (!(await panel.isVisible())) await page.getByTestId("titlebar-chats-sidebar").click();
  await panel.getByTestId("chats-panel-tab-all").click();
  return panel;
}

function timeline(root: Locator): Locator {
  return root.locator('[role="list"][data-chat-virtualized="true"]');
}

async function distanceFromEnd(list: Locator): Promise<number> {
  return list.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
}

async function wheelToEnd(list: Locator): Promise<void> {
  await list.hover();
  await list.page().mouse.wheel(0, await list.evaluate((node) => node.scrollHeight));
  await expect.poll(() => distanceFromEnd(list)).toBeLessThanOrEqual(1);
}

async function wheelFromEnd(list: Locator, distance: number): Promise<number> {
  await wheelToEnd(list);
  await list.page().mouse.wheel(0, -distance);
  await expect.poll(() => distanceFromEnd(list)).toBeCloseTo(distance, 0);
  return list.evaluate((node) => node.scrollTop);
}

async function sendIncomingReply(workspace: TempWorkspace, threadId: string, body: string): Promise<void> {
  const result = await runDohcCli(workspace, ["chat", "reply", threadId, "--as-agent", body]);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("replied");
}

async function expectWindowed(root: Locator, prefix: string, lastBody: string): Promise<Locator> {
  const list = timeline(root);
  await expect(list).toBeVisible();
  await expect(root.getByTestId(`${prefix}-message-body`).filter({ hasText: lastBody })).toBeInViewport();
  await expect.poll(() => root.getByTestId(`${prefix}-message`).count()).toBeLessThan(messageCount / 2);
  return list;
}

test("chat lane keeps history, follows within 40px, and retains focused rows", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  const workspaceId = "chat-window-lane";
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, workspaceId);
    const seeded = await seedThroughDaemon({ workspaceId, rootPath: temp.rootPath }, async ({ chats }) => {
      await chats.createChannel({ workspaceId, name: "Empty chat", type: "chat" });
      const channel = await chats.createChannel({ workspaceId, name: "Long chat", type: "chat" });
      const { thread, message } = await chats.startChannelThread({
        workspaceId, channelId: channel.id, lane: "chat", author, body: "Lane message 0",
      });
      for (let index = 1; index < messageCount; index += 1) {
        await chats.sendMessage({ workspaceId, threadId: thread.id, author, body: `Lane message ${index}` });
      }
      return { threadId: thread.id, firstMessageId: message.id };
    });
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;
    await waitForCliEndpoint(temp.homeDir);
    const panel = await openChats(page);

    await panel.getByTestId("chats-channel").filter({ hasText: "Empty chat" }).click();
    const lane = panel.getByTestId("chats-lane");
    await lane.getByTestId("chats-lane-composer").fill("First message in the empty chat");
    await lane.getByTestId("chats-lane-composer").press("Enter");
    await expect(lane.getByTestId("chats-lane-message-body")).toHaveText("First message in the empty chat");
    await expect(timeline(lane)).toBeVisible();

    await panel.getByTestId("chats-channel-back").click();
    await panel.getByTestId("chats-channel").filter({ hasText: "Long chat" }).click();
    const list = await expectWindowed(lane, "chats-lane", `Lane message ${messageCount - 1}`);
    await expect(lane.locator(`[data-message-id="${seeded.firstMessageId}"]`)).toHaveCount(0);
    await expect(lane.getByText("First message in the empty chat", { exact: true })).toHaveCount(0);

    const historyTop = await wheelFromEnd(list, 60);
    const historyAnchor = lane.getByTestId("chats-lane-message").filter({ hasText: `Lane message ${messageCount - 2}` });
    await sendIncomingReply(temp, seeded.threadId, "Incoming while reading history");
    await expect(historyAnchor).toHaveAttribute("aria-setsize", String(messageCount + 1));
    await expect.poll(() => distanceFromEnd(list)).toBeGreaterThan(60);
    expect(await list.evaluate((node) => node.scrollTop)).toBeCloseTo(historyTop, 0);

    let followingBody = "";
    for (const distance of [20, 40]) {
      await wheelFromEnd(list, distance);
      followingBody = `Incoming while following from ${distance}px`;
      await sendIncomingReply(temp, seeded.threadId, followingBody);
      await expect(lane.getByTestId("chats-lane-message").filter({ hasText: followingBody })).toBeInViewport();
      await expect.poll(() => distanceFromEnd(list)).toBeLessThanOrEqual(1);
    }
    const lastRow = lane.getByTestId("chats-lane-message").filter({ hasText: followingBody });

    await lastRow.hover();
    const trigger = lastRow.getByTestId("chats-lane-add-reaction");
    await trigger.click();
    const picker = page.getByTestId("chats-lane-reaction-picker");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute("popover", "manual");
    await expect(lastRow.locator('[data-testid="chats-lane-reaction-picker"]:popover-open')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(lane).toBeVisible();
    await trigger.click();
    await page.getByTestId("chats-lane-reaction-choice").filter({ hasText: "🎉" }).click();
    await expect(lastRow.getByTestId("chats-lane-reaction-pill")).toHaveAttribute("data-mine", "true");
    await expect(trigger).toBeFocused();
    // Home scrolls history while the reaction trigger keeps keyboard focus.
    await page.keyboard.press("Home");
    const firstRow = lane.locator(`[data-message-id="${seeded.firstMessageId}"]`);
    await expect(firstRow).toBeInViewport({ ratio: 1 });
    const firstRowTop = await firstRow.evaluate((node) => node.getBoundingClientRect().top);
    await expect(trigger).toBeFocused();
    await expect(lastRow).toBeAttached();
    await expect(lastRow).not.toBeInViewport();
    await sendIncomingReply(temp, seeded.threadId, "Incoming after keyboard history navigation");
    await expect(firstRow).toHaveAttribute("aria-setsize", String(messageCount + 4));
    await expect(firstRow).toBeInViewport({ ratio: 1 });
    await expect.poll(() => firstRow.evaluate((node, top) =>
      Math.abs(node.getBoundingClientRect().top - top), firstRowTop)).toBeLessThan(2);
    await expect(trigger).toBeFocused();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("a file linked mention reveals an unmounted historical message", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  const workspaceId = "chat-window-linked";
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await writeWorkspaceFiles(temp, [{ path: "topic.md", contents: "# Topic\n" }]);
    const firstMessageId = await seedThroughDaemon({ workspaceId, rootPath: temp.rootPath }, async ({ chats, files }) => {
      await files.ensureMainVersion({ workspaceId });
      const file = await files.writeTextFile({ workspaceId, versionId: "main", path: "topic.md", text: "# Topic\n", metadata: { origin: "local-file" } });
      const thread = await chats.createThread({ workspaceId, title: "Long file conversation", linkedFile: { objectId: file.object.id, pathHint: "topic.md" } });
      const first = await chats.sendMessage({ workspaceId, threadId: thread.id, author, body: "heliotrope historical target @[topic.md]", attachments: [{ objectId: file.object.id, pathHint: "topic.md" }] });
      for (let index = 1; index < messageCount; index += 1) {
        await chats.sendMessage({ workspaceId, threadId: thread.id, author, body: `File message ${index}` });
      }
      return first.id;
    });
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;
    await waitForWorkspaceFile(page, workspaceId, "topic.md");
    await explorerRow(page, "topic.md").click();
    await openFileChatsPanel(page);
    await page.getByTestId("linked-chat-open").click();
    const rail = page.getByTestId("linked-chat-thread");
    await expectWindowed(rail, "linked-chat", `File message ${messageCount - 1}`);
    await expect(rail.locator(`[data-message-id="${firstMessageId}"]`)).toHaveCount(0);

    await page.getByTestId("chat-file-mention").filter({ hasText: "Long file conversation" }).click();
    await expect(rail.locator(`[data-message-id="${firstMessageId}"]`)).toBeInViewport();
    await expect(rail.getByTestId("linked-chat-message-body").filter({ hasText: "heliotrope historical target" })).toBeInViewport();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("a file linked mention opens the exact unmounted DM message", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  const workspaceId = "chat-window-dm";
  const userId = "chat-window-owner";
  const token = `test:${userId}`;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let relay: SyncRelayHandle | null = null;
  try {
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token, workspaceId });
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceRegistry(temp, [{ workspaceId, rootPath: temp.rootPath, remote: { serverUrl: relay.baseUrl, ownerUserId: userId } }]);
    await seedCloudCredentials(temp, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, email: "owner@dohc.test", userId, token });
    await writeWorkspaceFiles(temp, [{ path: "topic.md", contents: "# Topic\n" }]);
    const firstMessageId = await seedThroughDaemon({ workspaceId, rootPath: temp.rootPath }, async ({ chats, files }) => {
      await files.ensureMainVersion({ workspaceId });
      const file = await files.writeTextFile({ workspaceId, versionId: "main", path: "topic.md", text: "# Topic\n", metadata: { origin: "local-file" } });
      const channel = await chats.createChannel({ workspaceId, name: "reader@dohc.test", kind: "dm" });
      const { thread, message } = await chats.startChannelThread({ workspaceId, channelId: channel.id, author, body: "azimuth historical target @[topic.md]", attachments: [{ objectId: file.object.id, pathHint: "topic.md" }] });
      for (let index = 1; index < messageCount; index += 1) {
        await chats.sendMessage({ workspaceId, threadId: thread.id, author, body: `Direct message ${index}` });
      }
      return message.id;
    });
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;
    const panel = await openChats(page);
    await panel.getByTestId("chats-dm-item").filter({ hasText: "reader@dohc.test" }).click();
    const dm = page.getByTestId("chats-dm-view");
    await expectWindowed(dm, "chats-dm", `Direct message ${messageCount - 1}`);
    await expect(dm.locator(`[data-message-id="${firstMessageId}"]`)).toHaveCount(0);

    await waitForWorkspaceFile(page, workspaceId, "topic.md");
    await explorerRow(page, "topic.md").click();
    await page.getByTestId("chat-file-mention").filter({ hasText: "reader@dohc.test" }).click();
    await expect(page.getByTestId("chats-dm-view").locator(`[data-message-id="${firstMessageId}"]`)).toBeInViewport();
  } finally {
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
