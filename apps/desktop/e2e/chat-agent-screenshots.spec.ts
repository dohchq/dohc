import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { installFakeAgentTools } from "./helpers/agentTools";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
} from "./helpers/workspace";

// Screenshot harness (@ui-audit) for the agent moments of the chat overhaul:
// adding an agent, the agent's screen, and an agent's question answered as a
// poll. Light and dark. Not a regression test; it runs only when a shot
// directory is set, the way ui-audit-screenshots.spec.ts does.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture agent screenshots");

const fakeRunner = resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs");

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await Promise.allSettled(document.getAnimations()
      .filter((animation) => animation.playState === "running" && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
      .map((animation) => animation.finished));
  }, theme);

}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

// The dispatch scan provisions the owner-only agent channel after the
// workspace opens. Wait on that real result before mounting Chats.
async function waitForAgentChannel(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const api = (window as unknown as {
          dohcDesktop: {
            getWorkspaceRegistry(): Promise<{ workspaces: Array<{ workspaceId: string }> }>;
            listChatChannels(payload: { workspaceId: string }): Promise<{ channels: Array<{ kind: string }> }>;
          };
        }).dohcDesktop;
        const registry = await api.getWorkspaceRegistry();
        const workspace = registry.workspaces[0];
        if (!workspace) return false;
        const result = await api.listChatChannels({ workspaceId: workspace.workspaceId });
        return result.channels.some((channel) => channel.kind === "agent");
      }),
    )
    .toBe(true);
}

test("@ui-audit adding an agent, its screen, and an answered question", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, "agent-screens");
    const env = await installFakeAgentTools(temp);
    desktop = await launchDesktopApp({ workspace: temp, env });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;
    await waitForAgentChannel(page);

    await page.getByTestId("titlebar-chats-sidebar").click();
    await expect(page.getByTestId("chats-view")).toBeVisible();

    // No runner yet: Agents says so and offers Add an agent.
    await expect(page.getByTestId("chats-my-agent-state")).toContainText("not set up");
    await shoot(page, "agents-not-set-up");

    await page.getByTestId("chats-add-agent-open").click();
    await expect(page.getByTestId("chats-add-agent")).toBeVisible();
    await page.getByTestId("chats-add-agent-agent-name").fill("Nova");
    await page.getByTestId("chats-add-agent-name").fill("Ice");
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await shoot(page, "agent-tool-cards");
    for (const tool of ["Claude Code", "Codex"]) {
      const card = page.getByRole("button", { name: tool, exact: true });
      await expect(card).toBeEnabled();
      await card.click();
      await expect(page.getByText("Conversation through stdin")).toBeVisible();
      await shoot(page, `agent-profile-${tool.toLowerCase().replaceAll(" ", "-")}`);
    }
    await page.getByText("Advanced", { exact: true }).click();
    await page
      .getByTestId("chats-add-agent-command")
      .fill(`node "${fakeRunner.replaceAll('"', '\\"')}" ask`);
    await expect(page.getByTestId("chats-add-agent-preview")).toContainText("Nova");
    await shoot(page, "add-agent-form");

    await page.getByTestId("chats-add-agent-submit").click();
    await expect(page.getByTestId("chats-add-agent")).toHaveCount(0);
    await expect(page.getByTestId("chats-manage-agent")).toBeVisible();

    // The agent's screen states what runs it.
    await page.getByTestId("chats-my-agent").click();
    await expect(page.getByTestId("chats-channel-title")).toHaveText("My agent");
    await expect(page.getByTestId("chats-agent-screen")).toBeVisible();
    await shoot(page, "agent-screen");

    // A question with choices is a poll; picking one answers it.
    await page.getByTestId("chats-new-thread-composer").fill("plan the release");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-thread-view")).toBeVisible();
    const question = page.getByTestId("chats-message").filter({ hasText: "Which day do we ship?" });
    await expect(question).toHaveCount(1);
    await expect(question.getByTestId("chats-comment-decision-open")).toHaveText("Poll open");
    await shoot(page, "agent-question-open");

    const options = question.getByTestId("chats-comment-poll-option");
    await options.nth(1).click();
    await expect(page.getByTestId("chats-resolving-mode")).toContainText("Monday");
    await shoot(page, "agent-question-choosing");
    await page.getByTestId("chats-composer").press("Enter");
    await expect(question.getByTestId("chats-comment-decision-resolved")).toHaveText("Answered");
    await expect(
      page.getByTestId("chats-message").filter({ hasText: "going with Monday" }),
    ).toHaveCount(1);
    await shoot(page, "agent-question-answered");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
