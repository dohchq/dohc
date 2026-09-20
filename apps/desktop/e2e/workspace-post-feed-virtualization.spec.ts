import { expect, test } from "@playwright/test";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, seedWorkspaceManifest } from "./helpers/workspace";

test("posts and Home keep a bounded list while preserving focus and older pages", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "post-feed-virtualization";
  try {
    await seedWorkspaceManifest(temp, workspaceId);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    const order = await page.evaluate(async (workspaceId) => {
      const bridge = (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop;
      const { channel } = await bridge.createChatChannel({ workspaceId, name: "List regression", type: "posts" });
      for (let index = 0; index < 120; index += 1) {
        await bridge.startChannelThread({ workspaceId, channelId: channel.id,
          body: `Post ${index}\n${"A varied card body. ".repeat(1 + index % 7)}` });
      }
      await bridge.setChatFollow({ workspaceId, target: { kind: "channel", channelId: channel.id }, state: "following" });
      return (await bridge.listChannelThreads({ workspaceId, channelId: channel.id })).threads.map((thread) => thread.id);
    }, workspaceId);
    await page.getByTestId("titlebar-chats-sidebar").click();
    await page.getByTestId("chats-channel").filter({ hasText: "List regression" }).click();
    await page.getByTestId("chats-panel-collapse").click();
    const view = page.locator("main");
    const list = view.getByTestId("chats-feed-column");
    const cards = view.getByTestId("chats-post-card");
    const first = view.locator(`[data-testid="chats-post-card"][data-thread-id="${order[0]}"]`);
    await expect(first).toBeVisible();
    await expect.poll(() => cards.count()).toBeLessThan(30);
    const like = first.getByTestId("chats-post-like");
    await like.focus();
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight / 2; });
    await expect(like).toBeFocused();
    // The next card must follow data order even while Legend's pooled DOM
    // containers still reflect a recently scrolled viewport.
    await first.getByTestId("chats-post-bookmark").focus();
    await page.keyboard.press("Tab");
    await expect(view.locator(`[data-testid="chats-post-card"][data-thread-id="${order[1]}"]`)).toBeFocused();
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(view.locator(`[data-testid="chats-post-card"][data-thread-id="${order.at(-1)}"]`)).toBeVisible();
    await page.getByTestId("titlebar-chats-sidebar").click();
    await page.getByTestId("chats-panel").getByTestId("chats-feed-link").click();
    await page.getByTestId("chats-panel-collapse").click();
    const home = view.getByTestId("chats-personal-feed");
    await expect(home.getByTestId("chats-feed-item").first()).toBeVisible();
    await expect(home.locator('[role="listitem"]').first()).toHaveAttribute("aria-setsize", "30");
    for (const total of [60, 90, 120]) {
      await home.getByTestId("chats-feed-more").click();
      await expect(home.locator('[role="listitem"]').first()).toHaveAttribute("aria-setsize", String(total));
    }
    await expect(home.getByTestId("chats-feed-more")).toHaveCount(0);
    await expect.poll(() => home.getByTestId("chats-feed-item").count()).toBeLessThan(30);
    await home.getByRole("list").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(home.locator('[role="listitem"][aria-posinset="120"]')).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
