import { expect, test } from "@playwright/test";
import { seedThroughDaemon } from "./helpers/daemonSeed";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  seedWorkspaceSettings,
  writeWorkspaceFiles,
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
    await page.getByTestId("titlebar-chats-sidebar").click();
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

    // Park the Chats panel closed so the post-relaunch Chats click is a
    // reveal (the panel's visibility persists in ui-state, and collapsing
    // fully unmounts the view — no right-edge stub).
    await page.getByTestId("chats-panel-collapse").click();
    await expect(page.getByTestId("chats-panel")).toHaveCount(0);
    await expect(page.getByTestId("chats-view")).toHaveCount(0);

    // Relaunch: channel chats are durable engine state. Between sessions an
    // AGENT starts a second chat through the engine daemon over RPC — the
    // external write path post-cutover (the retired TS in-process store is
    // refused by daemon-owned workspaces). It must arrive UNREAD.
    //
    // What this pins is durability across a relaunch. The live case — an
    // external write reaching the RUNNING app — needs the CLI endpoint into
    // the app's own daemon, and is covered by "an agent chat written by the
    // CLI while the app runs arrives unread live" in
    // workspace-chats-feed.spec.ts (#333).
    await desktop.close();
    await seedThroughDaemon(
      { workspaceId, rootPath: temp.rootPath },
      async ({ chats }) => {
        const general = await chats.findChannelBySlug({
          workspaceId,
          slug: "general",
        });
        expect(general).not.toBeNull();
        if (!general) throw new Error("general channel missing");
        await chats.startChannelThread({
          workspaceId,
          channelId: general.id,
          author: { kind: "agent", displayName: "Ice" },
          body: "The zeppelin-cadence report is ready.",
        });
      },
    );
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    page = desktop.page;
    // Panel visibility is persisted asynchronously, so a slow close can
    // still restore the Chats panel open; blind-clicking would then TOGGLE
    // it closed. Reveal it only when it is not already showing — what this
    // test pins is chat-data durability, not panel-visibility persistence.
    const panel = page.getByTestId("chats-panel");
    // The workbench restores an open Chats tab too, so the editor can render a
    // second chats surface with its own channel list. Read the navigator from
    // the panel and the conversation from the editor.
    const view = page.locator("main");
    if (!(await panel.isVisible())) {
      await page.getByTestId("titlebar-chats-sidebar").click();
    }
    await expect(panel.getByTestId("chats-channel-name")).toHaveText("general");
    await panel.getByTestId("chats-channel").click();
    // Two threads exist now (the agent seeded one between sessions), so pick
    // the composer-created one by its snippet title.
    await view
      .getByTestId("chats-thread")
      .filter({ hasText: "Let's plan the launch this week." })
      .click();
    await expect(view.getByTestId("chats-message-body")).toHaveCount(2);

    // Back to the channel: the agent thread carries an unread badge.
    await view.getByTestId("chats-thread-back").click();
    const agentThreadRow = view
      .getByTestId("chats-thread")
      .filter({ hasText: "zeppelin-cadence" });
    await expect(agentThreadRow).toBeVisible();
    await expect(agentThreadRow.getByTestId("chats-thread-unread")).toHaveText("1");

    // The channel list rolls the unread up.
    await view.getByTestId("chats-channel-back").click();
    await expect(view.getByTestId("chats-channel-unread")).toHaveText("1");

    // Opening the thread marks it read; the badges clear at both levels.
    await view.getByTestId("chats-channel").click();
    await agentThreadRow.click();
    await expect(view.getByTestId("chats-message-author")).toHaveText("Ice's agent");
    await view.getByTestId("chats-thread-back").click();
    await expect(view.getByTestId("chats-thread-unread")).toHaveCount(0);
    await view.getByTestId("chats-channel-back").click();
    await expect(view.getByTestId("chats-channel-unread")).toHaveCount(0);

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

// Slack-style navigation: the panel remains an overview while selections open
// and switch a first-class Chats editor tab.
test("flagged: the persistent chats navigator opens conversations in the editor", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, "chats-expand-e2e");
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: "notes.md", contents: "# Notes\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;

    // A document tab first, so tab switching can be exercised later.
    await explorerRow(page, "notes.md").click();
    await expect(page.getByTestId("tab-notes.md")).toBeVisible();

    // The panel remains the navigator; selecting a channel opens the editor.
    await page.getByTestId("titlebar-chats-sidebar").click();
    const panel = page.getByTestId("chats-panel");
    await expect(panel).toBeVisible();
    const channelButton = panel.getByTestId("chats-channel");
    await channelButton.click();
    const chatsTab = page.getByTestId("tab-dohc://chats");
    await expect(chatsTab).toBeVisible();
    await expect(chatsTab).toHaveAttribute("data-active", "true");
    await expect(panel).toBeVisible();
    await expect(channelButton).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("chats-panel-deferred")).toHaveCount(0);

    const newThreadComposer = page.getByTestId("chats-new-thread-composer");
    await newThreadComposer.fill("Expand me into a tab.");
    await newThreadComposer.press("Enter");
    const pageThreadView = page.locator(
      '[data-testid="chats-thread-view"][data-variant="page"]',
    );
    await expect(pageThreadView).toBeVisible();

    // The editor owns the composer and draft. The navigator has no duplicate
    // conversation/composer surface.
    await page.getByTestId("chats-composer").fill("draft in flight");
    await expect(
      pageThreadView.getByTestId("chats-thread-post-title"),
    ).toHaveText("Expand me into a tab.");
    await expect(page.getByTestId("chats-open-tab")).toHaveCount(0);
    await expect(page.getByTestId("chats-composer")).toHaveCount(1);

    // Switching editor tabs never changes the panel back into a conversation.
    // Reopening Chats restores the editor's conversation and draft.
    await page.getByTestId("tab-notes.md").click();
    await expect(
      panel.locator('[data-testid="chats-view"][data-variant="panel"]'),
    ).toBeVisible();
    await expect(page.getByTestId("chats-open-tab")).toBeVisible();
    await expect(page.getByTestId("chats-composer")).toHaveCount(0);
    await chatsTab.click();
    await expect(pageThreadView).toBeVisible();
    await expect(page.getByTestId("chats-composer")).toHaveValue("draft in flight");
    await expect(panel).toBeVisible();

    // Closing the editor leaves the persistent navigator intact. Selecting
    // the channel again recreates the Chats tab at that channel.
    await chatsTab.getByRole("button", { name: "Close Chats" }).click();
    await expect(page.getByTestId("tab-dohc://chats")).toHaveCount(0);
    await expect(panel).toBeVisible();
    await channelButton.click();
    await expect(
      page.locator('[data-testid="chats-channel-view"][data-variant="page"]'),
    ).toBeVisible();
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

    // No Chats layout control; the activity views are untouched.
    await expect(page.getByTestId("activity-explorer")).toBeVisible();
    await expect(page.getByTestId("titlebar-chats-sidebar")).toHaveCount(0);

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
    // 50 channels x 10 threads = 500 threads (each with one message), seeded
    // through the engine daemon over RPC (post-cutover the retired TS
    // in-process store cannot create a daemon-acceptable store).
    await seedThroughDaemon(
      { workspaceId, rootPath: temp.rootPath },
      async ({ chats }) => {
        await chats.ensureGeneralChannel({ workspaceId });
        for (let channelIndex = 1; channelIndex < 50; channelIndex += 1) {
          const channel = await chats.createChannel({
            workspaceId,
            name: `channel-${String(channelIndex).padStart(2, "0")}`,
          });
          for (let threadIndex = 0; threadIndex < 10; threadIndex += 1) {
            await chats.startChannelThread({
              workspaceId,
              channelId: channel.id,
              author: { kind: "human", displayName: "You" },
              body: `Seed thread ${threadIndex} in ${channel.name}: budget check.`,
            });
          }
        }
        const general = await chats.findChannelBySlug({
          workspaceId,
          slug: "general",
        });
        if (!general) throw new Error("general channel missing");
        for (let threadIndex = 0; threadIndex < 10; threadIndex += 1) {
          await chats.startChannelThread({
            workspaceId,
            channelId: general.id,
            author: { kind: "human", displayName: "You" },
            body: `Seed thread ${threadIndex} in general: budget check.`,
          });
        }
      },
    );

    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;

    // Channel-list first paint: click-to-50-painted-rows measured INSIDE the
    // page (rAF-polled), so harness polling/CDP overhead does not count
    // against the budget. Includes the lazy view chunk + the IPC round trip.
    const firstPaintMs = await page.evaluate(async () => {
      const layoutToggle = document.querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-chats-sidebar"]',
      );
      if (!layoutToggle) throw new Error("chats layout toggle missing");
      const start = performance.now();
      layoutToggle.click();
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
