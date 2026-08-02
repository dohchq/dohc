import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  desktopRoot,
  launchDesktopApp,
} from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  seedWorkspaceSettings,
  type TempWorkspace,
} from "./helpers/workspace";

const repoRoot = resolve(desktopRoot, "../..");
const cliBin = join(repoRoot, "packages/cli/bin/dohc.js");
// Unix serves the CLI over a socket file. Windows serves the same protocol
// over a named pipe whose per-boot name lives in the endpoint descriptor.
const cliEndpointFile = process.platform === "win32"
  ? "dohc-cli-endpoint"
  : "dohc-cli.sock";
const cliTokenFile = "dohc-cli-token";

function runDohcCli(
  workspace: Pick<TempWorkspace, "homeDir" | "rootPath">,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [cliBin, ...args],
      {
        cwd: workspace.rootPath,
        env: {
          ...process.env,
          // The app's socket and token live directly in the hermetic test
          // state dir. DOHC_STATE_DIR is the explicit CLI override;
          // DOHC_TEST_HOME exercises the normal test discovery fallback too.
          DOHC_STATE_DIR: workspace.homeDir,
          DOHC_TEST_HOME: workspace.homeDir,
          // Playwright forces color while some developer shells export
          // NO_COLOR; Node warns about that inherited combination before the
          // CLI runs. Keep stderr reserved for actual CLI failures.
          NODE_NO_WARNINGS: "1",
        },
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectRun(
            new Error(
              `dohc ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolveRun({ stdout, stderr });
      },
    );
  });
}

async function waitForCliEndpoint(homeDir: string): Promise<void> {
  const socketPath = join(homeDir, cliEndpointFile);
  const tokenPath = join(homeDir, cliTokenFile);
  await expect
    .poll(
      async () => {
        try {
          await Promise.all([access(socketPath), access(tokenPath)]);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000, intervals: [50, 100, 250] },
    )
    .toBe(true);
}

// The Chats panel mirrors the editor tab's conversation, so an unscoped
// conversation locator matches both surfaces. Everything about the OPEN
// conversation is read from the editor area; the panel stays the navigator.
function editorArea(page: Page): Locator {
  return page.locator("main");
}

function postCard(root: Locator, title: string): Locator {
  return root.getByTestId("chats-post-card").filter({
    has: root.page().getByTestId("chats-post-title").filter({ hasText: title }),
  });
}

function commentWithBody(root: Locator, body: string): Locator {
  return root
    .locator(
      'li[data-testid="chats-message"] > [data-testid="chats-comment-bubble"] > [data-testid="chats-message-body"]',
    )
    .filter({ hasText: body })
    .locator("..")
    .locator("..");
}

// A comment's replies nest INSIDE its own list item, so an unscoped lookup
// matches the reply's controls as well. A message's own action row is a direct
// child element; its replies sit in a sibling list.
function ownActions(message: Locator): Locator {
  return message.locator("> div");
}

// Same reason: a message's own bubble is its direct child, and every author,
// badge, and decision control lives inside that bubble.
function ownBubble(message: Locator): Locator {
  return message.locator('> [data-testid="chats-comment-bubble"]');
}

async function addReaction(message: Locator, emoji: string): Promise<void> {
  await message.hover();
  const actions = ownActions(message);
  await actions.getByTestId("chats-add-reaction").click();
  await actions
    .locator(
      `[data-testid="chats-reaction-choice"][data-emoji=${JSON.stringify(emoji)}]`,
    )
    .click();
}

function reactionPill(message: Locator, emoji: string): Locator {
  return ownActions(message).locator(
    `[data-testid="chats-reaction-pill"][data-emoji=${JSON.stringify(emoji)}]`,
  );
}

test("feed comments, reactions, and CLI decisions persist across relaunch", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "chats-feed-e2e";
  const channelName = "regional-planning";
  const postTitle = "Regional rollout checklist";
  const postExcerpt = "Review the export gates before launch.";
  const postBody = `${postTitle}\n${postExcerpt}`;
  const firstCommentBody = "I'll audit the current assumptions.";
  const interveningCommentBody = "Adding a second checkpoint before we decide.";
  const nestedCommentBody = "The first audit should include tax handling.";
  const decisionBody = "pick region A or B";
  const resolutionBody = "go with A";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    let page = desktop.page;
    let view = editorArea(page);

    await page.getByTestId("titlebar-chats-sidebar").click();
    await expect(page.getByTestId("chats-panel")).toBeVisible();

    // Channels remain a human/UI action. Creating one opens its feed
    // immediately, where the post composer accepts a multiline body and the
    // first line becomes the serif card title.
    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill(channelName);
    await page.getByTestId("chats-new-channel-name").press("Enter");
    await expect(page.getByTestId("chats-channel-title")).toHaveText(channelName);

    // Creating a channel opens it inside the panel. Hand the conversation to
    // the editor and collapse the navigator, so this spec asserts on ONE
    // surface — panel/editor duplication is workspace-chats.spec.ts's subject.
    await page.getByTestId("chats-channel-back").click();
    await page.getByTestId("chats-channel").filter({ hasText: channelName }).click();
    await expect(view.getByTestId("chats-channel-view")).toBeVisible();
    await page.getByTestId("chats-panel-collapse").click();
    await expect(page.getByTestId("chats-panel")).toHaveCount(0);
    await expect(view.getByTestId("chats-channel-title")).toHaveText(channelName);

    await view.getByTestId("chats-new-thread-composer").fill(postBody);
    await view.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(view.getByTestId("chats-thread-view")).toBeVisible();
    await expect(view.getByTestId("chats-thread-post-title")).toHaveText(postTitle);
    await expect(view.getByTestId("chats-message-body").first()).toHaveText(postBody);

    await view.getByTestId("chats-thread-back").click();
    const card = postCard(view, postTitle);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("chats-post-title")).toHaveText(postTitle);
    await expect(card.getByTestId("chats-post-title")).toHaveClass(/font-serif/);
    await expect(card.getByTestId("chats-post-excerpt")).toHaveText(postExcerpt);
    const threadId = await card.getAttribute("data-thread-id");
    expect(threadId).toBeTruthy();
    if (!threadId) throw new Error("created post did not expose its thread id");

    await card.click();
    await expect(view.getByTestId("chats-thread-view")).toBeVisible();

    // Put an unrelated comment between the parent and its nested reply. The
    // flat v1 renderer then exposes the true parent with its reply-context
    // tag rather than relying on adjacency.
    const composer = view.getByTestId("chats-composer");
    await composer.fill(firstCommentBody);
    await composer.press("Enter");
    const firstComment = commentWithBody(view, firstCommentBody);
    await expect(firstComment).toBeVisible();
    const firstCommentId = await firstComment.getAttribute("data-message-id");
    expect(firstCommentId).toBeTruthy();
    if (!firstCommentId) throw new Error("first comment did not expose its message id");

    await composer.fill(interveningCommentBody);
    await composer.press("Enter");
    await expect(commentWithBody(view, interveningCommentBody)).toBeVisible();

    await ownActions(firstComment).getByTestId("chats-comment-reply").click();
    await expect(view.getByTestId("chats-replying-mode")).toContainText(
      "Replying to You",
    );
    await composer.fill(nestedCommentBody);
    await composer.press("Enter");
    const nestedComment = commentWithBody(view, nestedCommentBody);
    await expect(nestedComment).toBeVisible();
    await expect(nestedComment).toHaveAttribute("data-thread-depth", "1");
    await expect(nestedComment).toHaveAttribute(
      "data-parent-message-id",
      firstCommentId,
    );
    await expect(nestedComment.getByTestId("chats-reply-context")).toHaveText(
      "↳ replying to You",
    );

    // A post reaction is a reaction on the opening message. The same quiet
    // pills work on comments.
    const openingMessage = view.locator('article[data-testid="chats-message"]');
    await addReaction(openingMessage, "👍");
    await expect(reactionPill(openingMessage, "👍")).toHaveAttribute(
      "data-mine",
      "true",
    );
    await expect(reactionPill(openingMessage, "👍")).toContainText("1");

    await addReaction(firstComment, "🎉");
    await expect(reactionPill(firstComment, "🎉")).toHaveAttribute(
      "data-mine",
      "true",
    );
    await expect(reactionPill(firstComment, "🎉")).toContainText("1");

    // The real CLI discovers the socket/token in the running app's state dir
    // and resolves the workspace from cwd.
    await waitForCliEndpoint(temp.homeDir);
    const reply = await runDohcCli(temp, [
      "chat",
      "reply",
      threadId,
      "--as-agent",
      "--needs-decision",
      decisionBody,
    ]);
    expect(reply.stderr).toBe("");
    expect(reply.stdout).toContain("replied");
    // `replied <threadId> <messageId>`. Read the rendered field rather than a
    // prefix: the daemon's message ids carry no `message_`/`msg_` prefix.
    const cliMessageId = reply.stdout.match(/^replied\s+\S+\s+(\S+)/mu)?.[1];
    expect(cliMessageId).toBeTruthy();
    if (!cliMessageId) throw new Error("CLI reply did not return a message id");

    // The running thread consumes main's activity invalidation, so the CLI
    // report and typed decision appear without a navigation or polling wait.
    const agentComment = commentWithBody(view, decisionBody);
    await expect(agentComment).toHaveAttribute("data-author-kind", "agent");
    await expect(ownBubble(agentComment).getByTestId("chats-message-author")).toHaveText(
      "You's agent",
    );
    await expect(ownBubble(agentComment).getByTestId("chats-comment-agent-badge")).toHaveText(
      "agent",
    );
    const agentBubble = ownBubble(agentComment);
    await expect(agentBubble).toHaveClass(/border-l-2/);
    await expect(agentBubble).toHaveAttribute("style", /--dohc-agent/);
    await expect(ownBubble(agentComment).getByTestId("chats-comment-decision-open")).toHaveText(
      "needs decision",
    );

    // The feed summary reflects the same open decision, and reopening keeps
    // the full agent treatment and resolve gesture intact.
    await view.getByTestId("chats-thread-back").click();
    const decisionCard = postCard(view, postTitle);
    await expect(decisionCard.getByTestId("chats-post-decision-open")).toHaveText(
      "needs decision",
    );
    await decisionCard.click();
    await expect(agentComment).toBeVisible();

    await ownBubble(agentComment).getByTestId("chats-comment-decision-resolve").click();
    await expect(view.getByTestId("chats-resolving-mode")).toContainText(
      "Resolving decision — your reply records it",
    );
    await composer.fill(resolutionBody);
    await composer.press("Enter");
    await expect(
      ownBubble(agentComment).getByTestId("chats-comment-decision-resolved"),
    ).toHaveText("resolved");
    await expect(commentWithBody(view, resolutionBody)).toBeVisible();

    const show = await runDohcCli(temp, ["chat", "show", threadId, "--peek"]);
    expect(show.stderr).toBe("");
    expect(show.stdout).toContain(resolutionBody);
    expect(show.stdout).toContain("needs-decision(resolved)");
    expect(show.stdout).toContain("open decisions: none");

    const grep = await runDohcCli(temp, ["chat", "grep", "region"]);
    expect(grep.stderr).toBe("");
    const matchingLine = grep.stdout
      .split("\n")
      .find((line) => line.includes(decisionBody));
    expect(matchingLine).toBeTruthy();
    expect(matchingLine).toContain(cliMessageId);

    // Park outside Chats so the relaunch reveal is deterministic.
    await page.getByTestId("activity-explorer").click();
    await desktop.close();
    desktop = null;

    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    page = desktop.page;
    view = editorArea(page);
    if (!(await page.getByTestId("chats-view").isVisible())) {
      await page.getByTestId("titlebar-chats-sidebar").click();
    }

    const persistedChannel = page
      .getByTestId("chats-channel")
      .filter({ hasText: channelName });
    await expect(persistedChannel).toBeVisible();
    await persistedChannel.click();

    const persistedCard = postCard(view, postTitle);
    await expect(persistedCard).toBeVisible();
    await expect(persistedCard.getByTestId("chats-post-title")).toHaveText(postTitle);
    await expect(persistedCard.getByTestId("chats-post-title")).toHaveClass(/font-serif/);
    await expect(persistedCard.getByTestId("chats-post-excerpt")).toHaveText(postExcerpt);
    await expect(persistedCard.getByTestId("chats-post-comment-count")).toHaveText(
      "5 comments",
    );
    await expect(
      persistedCard.locator(
        '[data-testid="chats-post-reaction-pill"][data-emoji="👍"]',
      ),
    ).toContainText("1");
    await expect(persistedCard.getByTestId("chats-post-decision-open")).toHaveCount(0);

    await persistedCard.click();
    await expect(view.getByTestId("chats-thread-post-title")).toHaveText(postTitle);
    await expect(view.getByTestId("chats-message-body")).toHaveCount(6);
    await expect(commentWithBody(view, nestedCommentBody).getByTestId("chats-reply-context"))
      .toHaveText("↳ replying to You");

    const persistedOpening = view.locator('article[data-testid="chats-message"]');
    await expect(reactionPill(persistedOpening, "👍")).toHaveAttribute(
      "data-mine",
      "true",
    );
    const persistedFirstComment = commentWithBody(view, firstCommentBody);
    await expect(reactionPill(persistedFirstComment, "🎉")).toHaveAttribute(
      "data-mine",
      "true",
    );

    const persistedAgentComment = commentWithBody(view, decisionBody);
    await expect(ownBubble(persistedAgentComment).getByTestId("chats-comment-agent-badge"))
      .toHaveText("agent");
    await expect(ownBubble(persistedAgentComment))
      .toHaveClass(/border-l-2/);
    await expect(
      ownBubble(persistedAgentComment).getByTestId("chats-comment-decision-resolved"),
    ).toHaveText("resolved");
    await expect(view.getByTestId("chats-comment-decision-open")).toHaveCount(0);
    await expect(commentWithBody(view, resolutionBody)).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// #333: the live external-write invariant. A separate OS process writes an
// agent chat into the RUNNING app's daemon over the authenticated CLI
// endpoint, and the unread badge appears with NO relaunch and NO navigation.
// This is the only cross-process write path after the daemon cutover — a
// second daemon cannot attach to the app's store — so it is what proves the
// app invalidates its chat state on an outside write.
//
// The open channel view consumes main's activity invalidation. The channel
// LIST does not — it reloads on navigation — so the roll-up badge stays where
// workspace-chats.spec.ts already reads it, after a relaunch.
test("an agent chat written by the CLI while the app runs arrives unread live", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "chats-live-unread-e2e";
  const agentBody = "The zeppelin-cadence report is ready.";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;

    // Open #general in the editor and stay there. The panel stays a navigator,
    // so both surfaces render chats markup from here on; scope every locator
    // to the one being asserted.
    const panel = page.getByTestId("chats-panel");
    const channelView = page.locator(
      '[data-testid="chats-channel-view"][data-variant="page"]',
    );
    const threadView = page.locator(
      '[data-testid="chats-thread-view"][data-variant="page"]',
    );
    await page.getByTestId("titlebar-chats-sidebar").click();
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("chats-channel-name")).toHaveText("general");
    await panel.getByTestId("chats-channel").click();
    await expect(channelView).toBeVisible();
    await expect(channelView.getByTestId("chats-thread")).toHaveCount(0);

    await waitForCliEndpoint(temp.homeDir);
    const post = await runDohcCli(temp, [
      "chat",
      "post",
      "general",
      "--as-agent",
      agentBody,
    ]);
    expect(post.stderr).toBe("");
    expect(post.stdout).toContain("in #general");

    // Live: no relaunch, no click, no navigation. The open channel repaints
    // from main's invalidation, and the agent thread arrives UNREAD.
    const agentThreadRow = channelView
      .getByTestId("chats-thread")
      .filter({ hasText: "zeppelin-cadence" });
    await expect(agentThreadRow).toBeVisible();
    await expect(agentThreadRow.getByTestId("chats-thread-unread")).toHaveText("1");

    // Reading it clears the badge, so it tracked read state rather than
    // merely rendering an arrival.
    await agentThreadRow.click();
    await expect(threadView.getByTestId("chats-message-author")).toHaveText(
      "You's agent",
    );
    await expect(threadView.getByTestId("chats-message-body")).toContainText(
      agentBody,
    );
    await threadView.getByTestId("chats-thread-back").click();
    await expect(channelView.getByTestId("chats-thread-unread")).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
