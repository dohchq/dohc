import { expect, test } from "@playwright/test";
import { createLinkedChatStore } from "@dohc/workspace-engine";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  seedWorkspaceSettings,
} from "./helpers/workspace";

// WS-E — CHATS EXPANSION (plan PR 12/13): a flagged workspace gets a Chats
// view with channels. The default #general channel exists on first use, the
// composer starts a chat with ONE Enter and no title prompt (untitled chats
// display their first-message snippet), messages persist across relaunch,
// agent messages create unread badges that mark-read clears, and engine
// search (WS-D) finds channel messages. Unflagged workspaces have no Chats
// entry and every channel handler rejects.

test("flagged: general channel, composer-first chats, relaunch persistence, unread, search", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "chats-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    let page = desktop.page;

    // The Chats view exists on the activity rail; first use auto-creates
    // the default #general channel.
    await page.getByTestId("activity-chats").click();
    await expect(page.getByTestId("chats-view")).toBeVisible();
    await expect(page.getByTestId("chats-channel-name")).toHaveText("general");

    // Composer-first thread start: the channel view offers NO title input —
    // typing a message and pressing Enter IS creating the chat.
    await page.getByTestId("chats-channel").click();
    await expect(page.getByTestId("chats-channel-view")).toBeVisible();
    await expect(page.getByTestId("chats-channel-view").locator("input")).toHaveCount(0);
    const newThreadComposer = page.getByTestId("chats-new-thread-composer");
    await newThreadComposer.fill("Let's plan the launch this week.");
    await newThreadComposer.press("Enter");

    // Straight into the thread; the snippet is the display title; the
    // signed-out desktop's human author displays as "You".
    await expect(page.getByTestId("chats-thread-view")).toBeVisible();
    await expect(page.getByTestId("chats-thread-title")).toHaveText(
      "Let's plan the launch this week.",
    );
    await expect(page.getByTestId("chats-message-body")).toContainText(
      "Let's plan the launch this week.",
    );
    await expect(page.getByTestId("chats-message-author")).toHaveText("You");

    // Replies land through the thread composer.
    const composer = page.getByTestId("chats-composer");
    await composer.fill("Second message here.");
    await composer.press("Enter");
    await expect(page.getByTestId("chats-message-body")).toHaveCount(2);

    // Back in the channel: the post card shows the snippet title, no
    // unread badge for your own messages.
    await page.getByTestId("chats-thread-back").click();
    await expect(page.getByTestId("chats-post-title")).toHaveText(
      "Let's plan the launch this week.",
    );
    await expect(page.getByTestId("chats-thread-unread")).toHaveCount(0);

    // Park the workbench on Explorer so the post-relaunch Chats click is a
    // reveal (clicking the already-active view toggles the panel closed).
    await page.getByTestId("activity-explorer").click();
    await expect(page.getByTestId("chats-view")).toHaveCount(0);

    // Relaunch: channel chats are durable engine state.
    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    page = desktop.page;
    // The active-view choice is persisted asynchronously, so a slow close can
    // restore Chats as the active view; blind-clicking would then TOGGLE the
    // panel closed. Reveal it only when it is not already showing — what this
    // test pins is chat-data durability, not active-view persistence.
    if (!(await page.getByTestId("chats-view").isVisible())) {
      await page.getByTestId("activity-chats").click();
    }
    await expect(page.getByTestId("chats-channel-name")).toHaveText("general");
    await page.getByTestId("chats-channel").click();
    await page.getByTestId("chats-thread").click();
    await expect(page.getByTestId("chats-message-body")).toHaveCount(2);

    // An agent starts a second chat while the app runs (the MCP write path:
    // same engine.db over a separate WAL connection). It arrives UNREAD.
    const externalStore = createLinkedChatStore(temp.rootPath);
    const general = await externalStore.findChannelBySlug({
      workspaceId,
      slug: "general",
    });
    expect(general).not.toBeNull();
    if (!general) throw new Error("general channel missing");
    await externalStore.startChannelThread({
      workspaceId,
      channelId: general.id,
      author: { kind: "agent", displayName: "Ice" },
      body: "The zeppelin-cadence report is ready.",
    });
    await externalStore.close();

    // Back to the channel: the agent thread carries an unread badge.
    await page.getByTestId("chats-thread-back").click();
    const agentThreadRow = page
      .getByTestId("chats-thread")
      .filter({ hasText: "zeppelin-cadence" });
    await expect(agentThreadRow).toBeVisible();
    await expect(agentThreadRow.getByTestId("chats-thread-unread")).toHaveText("1");

    // The channel list rolls the unread up.
    await page.getByTestId("chats-channel-back").click();
    await expect(page.getByTestId("chats-channel-unread")).toHaveText("1");

    // Opening the thread marks it read; the badges clear at both levels.
    await page.getByTestId("chats-channel").click();
    await agentThreadRow.click();
    await expect(page.getByTestId("chats-message-author")).toHaveText("Ice's agent");
    await page.getByTestId("chats-thread-back").click();
    await expect(page.getByTestId("chats-thread-unread")).toHaveCount(0);
    await page.getByTestId("chats-channel-back").click();
    await expect(page.getByTestId("chats-channel-unread")).toHaveCount(0);

    // WS-D integration: engine search finds the channel message and renders
    // it as a Chat result with the snippet title.
    await page.getByTestId("activity-search").click();
    await page.getByTestId("search-input").fill("zeppelin-cadence");
    const chatGroup = page
      .locator('[data-testid="search-result-group"]')
      .filter({ hasText: "The zeppelin-cadence report is ready." });
    await expect(chatGroup).toBeVisible({ timeout: 20_000 });
    await expect(chatGroup.getByText("Chat", { exact: true })).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// WS-H1 flag flip: chats are engine-backed and the engine is now the
// default, so only an EXPLICIT opt-out disables the surface.
test("opted-out workspace: no Chats view, channel handlers reject", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: false },
    });
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;

    // No Chats entry on the rail; the other views are untouched.
    await expect(page.getByTestId("activity-explorer")).toBeVisible();
    await expect(page.getByTestId("activity-chats")).toHaveCount(0);

    // Every channel handler rejects for unflagged workspaces — the read
    // path, channel creation, thread start, AND read-cursor advancement. A
    // regression that dropped the enablement guard from any ONE of them
    // would fail here by name.
    const rejections = await page.evaluate(async ({ id }) => {
      const api = (window as unknown as {
        dohcDesktop: Record<string, (payload: unknown) => Promise<unknown>>;
      }).dohcDesktop;
      const calls: Array<[string, unknown]> = [
        ["listChatChannels", { workspaceId: id }],
        ["createChatChannel", { workspaceId: id, name: "ops" }],
        [
          "startChannelThread",
          { workspaceId: id, channelId: "channel-x", body: "hello" },
        ],
        [
          "markChatThreadRead",
          { workspaceId: id, threadId: "thread-x", upToSequence: 1 },
        ],
      ];
      const results: Record<string, string | null> = {};
      for (const [method, payload] of calls) {
        try {
          await api[method](payload);
          results[method] = null;
        } catch (error) {
          results[method] = error instanceof Error ? error.message : String(error);
        }
      }
      return results;
    }, { id: workspace.workspaceId });
    for (const method of [
      "listChatChannels",
      "createChatChannel",
      "startChannelThread",
      "markChatThreadRead",
    ]) {
      expect(rejections[method], `${method} must reject when unflagged`).toContain(
        "Chats are not enabled",
      );
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// PERFORMANCE (plan chat budgets, scaled to alpha): 50 channels / 500
// threads first-paint under 500ms; composer-send-to-rendered p50 under
// 100ms. Measured inside the page (real IPC round trips + real paints).
test("performance: channel-list first paint and composer send latency", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "chats-perf-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    // 50 channels x 10 threads = 500 threads (each with one message).
    const store = createLinkedChatStore(temp.rootPath);
    await store.ensureGeneralChannel({ workspaceId });
    for (let channelIndex = 1; channelIndex < 50; channelIndex += 1) {
      const channel = await store.createChannel({
        workspaceId,
        name: `channel-${String(channelIndex).padStart(2, "0")}`,
      });
      for (let threadIndex = 0; threadIndex < 10; threadIndex += 1) {
        await store.startChannelThread({
          workspaceId,
          channelId: channel.id,
          author: { kind: "human", displayName: "You" },
          body: `Seed thread ${threadIndex} in ${channel.name}: budget check.`,
        });
      }
    }
    const general = await store.findChannelBySlug({ workspaceId, slug: "general" });
    if (!general) throw new Error("general channel missing");
    for (let threadIndex = 0; threadIndex < 10; threadIndex += 1) {
      await store.startChannelThread({
        workspaceId,
        channelId: general.id,
        author: { kind: "human", displayName: "You" },
        body: `Seed thread ${threadIndex} in general: budget check.`,
      });
    }
    await store.close();

    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;

    // Channel-list first paint: click-to-50-painted-rows measured INSIDE the
    // page (rAF-polled), so harness polling/CDP overhead does not count
    // against the budget. Includes the lazy view chunk + the IPC round trip.
    const firstPaintMs = await page.evaluate(async () => {
      const rail = document.querySelector<HTMLButtonElement>(
        '[data-testid="activity-chats"]',
      );
      if (!rail) throw new Error("chats rail button missing");
      const start = performance.now();
      rail.click();
      await new Promise<void>((resolve) => {
        const check = () => {
          const rows = document.querySelectorAll('[data-testid="chats-channel"]');
          if (rows.length >= 50) return resolve();
          requestAnimationFrame(check);
        };
        check();
      });
      return performance.now() - start;
    });
    await expect(page.getByTestId("chats-channel")).toHaveCount(50);
    console.log(`[perf] chats channel list first paint: ${firstPaintMs.toFixed(1)}ms (50 channels / 500 threads)`);
    expect(firstPaintMs).toBeLessThan(500);

    // Composer send-to-rendered: open a thread, then measure repeated sends
    // from submit to the message's painted DOM node (rAF-polled).
    await page.getByTestId("chats-channel").first().click();
    await page.getByTestId("chats-thread").first().click();
    await expect(page.getByTestId("chats-message-body").first()).toBeVisible();

    const samples: number[] = [];
    for (let sendIndex = 0; sendIndex < 11; sendIndex += 1) {
      const body = `perf probe message ${sendIndex}`;
      const elapsed = await page.evaluate(async (text) => {
        const composer = document.querySelector<HTMLTextAreaElement>(
          '[data-testid="chats-composer"]',
        );
        if (!composer) throw new Error("composer missing");
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        setter?.call(composer, text);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const form = composer.closest("form");
        if (!form) throw new Error("composer form missing");
        const start = performance.now();
        form.requestSubmit();
        await new Promise<void>((resolve) => {
          const check = () => {
            const bodies = document.querySelectorAll(
              '[data-testid="chats-message-body"]',
            );
            for (const node of bodies) {
              if (node.textContent === text) return resolve();
            }
            requestAnimationFrame(check);
          };
          check();
        });
        return performance.now() - start;
      }, body);
      samples.push(elapsed);
    }
    // Drop the first send (cold path) and take the median of the rest.
    const steady = samples.slice(1).sort((a, b) => a - b);
    const p50 = steady[Math.floor(steady.length / 2)];
    console.log(
      `[perf] composer send-to-rendered: p50 ${p50.toFixed(1)}ms (samples: ${samples
        .map((sample) => sample.toFixed(1))
        .join(", ")})`,
    );
    expect(p50).toBeLessThan(100);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
