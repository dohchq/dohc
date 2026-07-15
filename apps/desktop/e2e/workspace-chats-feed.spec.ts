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
const cliSocketFile = "dohc-cli.sock";
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
  const socketPath = join(homeDir, cliSocketFile);
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

function postCard(page: Page, title: string): Locator {
  return page.getByTestId("chats-post-card").filter({
    has: page.getByTestId("chats-post-title").filter({ hasText: title }),
  });
}

function commentWithBody(page: Page, body: string): Locator {
  return page
    .locator(
      'li[data-testid="chats-message"] > [data-testid="chats-comment-bubble"] > [data-testid="chats-message-body"]',
    )
    .filter({ hasText: body })
    .locator("..")
    .locator("..");
}

async function addReaction(message: Locator, emoji: string): Promise<void> {
  await message.hover();
  await message.getByTestId("chats-add-reaction").click();
  await message
    .locator(
      `[data-testid="chats-reaction-choice"][data-emoji=${JSON.stringify(emoji)}]`,
    )
    .click();
}

function reactionPill(message: Locator, emoji: string): Locator {
  return message.locator(
    `[data-testid="chats-reaction-pill"][data-emoji=${JSON.stringify(emoji)}]`,
  );
}

test("feed comments, reactions, and CLI decisions persist across relaunch", async () => {
  test.skip(process.platform === "win32", "The authenticated dohc CLI socket is Unix-only.");

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

    await page.getByTestId("titlebar-chats-sidebar").click();
    await expect(page.getByTestId("chats-view")).toBeVisible();

    // Channels remain a human/UI action. Creating one opens its feed
    // immediately, where the post composer accepts a multiline body and the
    // first line becomes the serif card title.
    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill(channelName);
    await page.getByTestId("chats-new-channel-name").press("Enter");
    await expect(page.getByTestId("chats-channel-view")).toBeVisible();
    await expect(page.getByTestId("chats-channel-title")).toHaveText(channelName);

    await page.getByTestId("chats-new-thread-composer").fill(postBody);
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-thread-view")).toBeVisible();
    await expect(page.getByTestId("chats-thread-post-title")).toHaveText(postTitle);
    await expect(page.getByTestId("chats-message-body").first()).toHaveText(postBody);

    await page.getByTestId("chats-thread-back").click();
    const card = postCard(page, postTitle);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("chats-post-title")).toHaveText(postTitle);
    await expect(card.getByTestId("chats-post-title")).toHaveClass(/font-serif/);
    await expect(card.getByTestId("chats-post-excerpt")).toHaveText(postExcerpt);
    const threadId = await card.getAttribute("data-thread-id");
    expect(threadId).toBeTruthy();
    if (!threadId) throw new Error("created post did not expose its thread id");

    await card.click();
    await expect(page.getByTestId("chats-thread-view")).toBeVisible();

    // Put an unrelated comment between the parent and its nested reply. The
    // flat v1 renderer then exposes the true parent with its reply-context
    // tag rather than relying on adjacency.
    const composer = page.getByTestId("chats-composer");
    await composer.fill(firstCommentBody);
    await composer.press("Enter");
    const firstComment = commentWithBody(page, firstCommentBody);
    await expect(firstComment).toBeVisible();

    await composer.fill(interveningCommentBody);
    await composer.press("Enter");
    await expect(commentWithBody(page, interveningCommentBody)).toBeVisible();

    await firstComment.getByTestId("chats-comment-reply").click();
    await expect(page.getByTestId("chats-replying-mode")).toContainText(
      "Replying to You",
    );
    await composer.fill(nestedCommentBody);
    await composer.press("Enter");
    const nestedComment = commentWithBody(page, nestedCommentBody);
    await expect(nestedComment).toBeVisible();
    await expect(nestedComment).toHaveAttribute("data-thread-depth", "1");
    await expect(
      nestedComment.locator("xpath=ancestor::ol[@data-testid='chats-replies']"),
    ).toHaveCount(1);
    await expect(nestedComment.getByTestId("chats-reply-context")).toHaveText(
      "↳ replying to You",
    );

    // A post reaction is a reaction on the opening message. The same quiet
    // pills work on comments.
    const openingMessage = page.locator('article[data-testid="chats-message"]');
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
    const cliMessageId = reply.stdout.match(/\bmsg_[^\s·]+/u)?.[0];
    expect(cliMessageId).toBeTruthy();
    if (!cliMessageId) throw new Error("CLI reply did not return a message id");

    // The running thread consumes main's activity invalidation, so the CLI
    // report and typed decision appear without a navigation or polling wait.
    const agentComment = commentWithBody(page, decisionBody);
    await expect(agentComment).toHaveAttribute("data-author-kind", "agent");
    await expect(agentComment.getByTestId("chats-message-author")).toHaveText(
      "You's agent",
    );
    await expect(agentComment.getByTestId("chats-comment-agent-badge")).toHaveText(
      "agent",
    );
    const agentBubble = agentComment.getByTestId("chats-comment-bubble");
    await expect(agentBubble).toHaveClass(/border-l-2/);
    await expect(agentBubble).toHaveAttribute("style", /--dohc-agent/);
    await expect(agentComment.getByTestId("chats-comment-decision-open")).toHaveText(
      "needs decision",
    );

    // The feed summary reflects the same open decision, and reopening keeps
    // the full agent treatment and resolve gesture intact.
    await page.getByTestId("chats-thread-back").click();
    const decisionCard = postCard(page, postTitle);
    await expect(decisionCard.getByTestId("chats-post-decision-open")).toHaveText(
      "needs decision",
    );
    await decisionCard.click();
    await expect(agentComment).toBeVisible();

    await agentComment.getByTestId("chats-comment-decision-resolve").click();
    await expect(page.getByTestId("chats-resolving-mode")).toContainText(
      "Resolving decision — your reply records it",
    );
    await composer.fill(resolutionBody);
    await composer.press("Enter");
    await expect(
      agentComment.getByTestId("chats-comment-decision-resolved"),
    ).toHaveText("resolved");
    await expect(commentWithBody(page, resolutionBody)).toBeVisible();

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
    if (!(await page.getByTestId("chats-view").isVisible())) {
      await page.getByTestId("titlebar-chats-sidebar").click();
    }

    const persistedChannel = page
      .getByTestId("chats-channel")
      .filter({ hasText: channelName });
    await expect(persistedChannel).toBeVisible();
    await persistedChannel.click();

    const persistedCard = postCard(page, postTitle);
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
    await expect(page.getByTestId("chats-thread-post-title")).toHaveText(postTitle);
    await expect(page.getByTestId("chats-message-body")).toHaveCount(6);
    await expect(commentWithBody(page, nestedCommentBody).getByTestId("chats-reply-context"))
      .toHaveText("↳ replying to You");

    const persistedOpening = page.locator('article[data-testid="chats-message"]');
    await expect(reactionPill(persistedOpening, "👍")).toHaveAttribute(
      "data-mine",
      "true",
    );
    const persistedFirstComment = commentWithBody(page, firstCommentBody);
    await expect(reactionPill(persistedFirstComment, "🎉")).toHaveAttribute(
      "data-mine",
      "true",
    );

    const persistedAgentComment = commentWithBody(page, decisionBody);
    await expect(persistedAgentComment.getByTestId("chats-comment-agent-badge"))
      .toHaveText("agent");
    await expect(persistedAgentComment.getByTestId("chats-comment-bubble"))
      .toHaveClass(/border-l-2/);
    await expect(
      persistedAgentComment.getByTestId("chats-comment-decision-resolved"),
    ).toHaveText("resolved");
    await expect(page.getByTestId("chats-comment-decision-open")).toHaveCount(0);
    await expect(commentWithBody(page, resolutionBody)).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
