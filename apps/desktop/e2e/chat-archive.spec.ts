import { expect, test, type Page } from "@playwright/test";
import { activityPin, desktopPins, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { installFakeAgentTools } from "./helpers/agentTools";
import { waitForVisibleAnimations } from "./helpers/animations";
import { runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openChatsView,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  trustOpenWorkspace,
} from "./helpers/workspace";

const fakeRunner = resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs");

async function shoot(page: Page, path: string): Promise<void> {
  await waitForVisibleAnimations(page);
  await page.screenshot({ path });
}

test("archives a chat from its menu, keeps it archived when a message arrives, and unarchives it", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "chat-archive");
    desktop = await launchDesktopApp({ workspace: temp, env: await installFakeAgentTools(temp) });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const panel = await openChatsView(page);

    await panel.getByTestId("chats-add-agent-open").click();
    await page.getByTestId("chats-add-agent-agent-name").fill("Nova");
    await page.getByText("Advanced", { exact: true }).click();
    await page
      .getByTestId("chats-add-agent-command")
      .fill(`node "${fakeRunner.replaceAll('"', '\\"')}" ask`);
    await page.getByTestId("chats-add-agent-submit").click();
    await expect(page.getByTestId("chats-add-agent")).toHaveCount(0);
    await expect(panel.getByTestId("chats-my-agent")).toHaveCount(1);

    const group = panel.getByTestId("chats-channel").filter({ hasText: "general" });
    const menu = page.getByTestId("chat-row-menu");
    await group.click({ button: "right" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Add people…", "Archive"]);
    await shoot(page, testInfo.outputPath("group-menu.png"));

    await menu.getByRole("menuitem", { name: "Archive" }).click();
    const toasts = page.getByTestId("notice-toasts");
    await expect(toasts).toContainText("Archived general");
    await expect(group).toHaveCount(0);
    await expect(panel.getByTestId("chats-archived-count")).toHaveText("1");
    await shoot(page, testInfo.outputPath("archive-toast.png"));
    await toasts.getByRole("button", { name: "Undo" }).click();
    await expect(group).toHaveCount(1);
    await expect(panel.getByTestId("chats-archived-toggle")).toHaveCount(0);

    await group.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Archive" }).click();
    await expect(group).toHaveCount(0);
    await waitForCliEndpoint(temp.homeDir);
    await runDohcCli(temp, [
      "chat",
      "post",
      "general",
      "--as-agent",
      "The venue is booked for Friday.",
    ]);
    const toggle = panel.getByTestId("chats-archived-toggle");
    await expect(toggle.getByTestId("chats-archived-unread")).toBeVisible();
    await expect(group).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const archived = panel.getByTestId("chats-archived-list").getByTestId("chats-channel");
    await expect(archived).toHaveText(/general/u);
    await shoot(page, testInfo.outputPath("archived-unread.png"));

    await archived.click();
    const line = page.getByTestId("chats-archived-line");
    await expect(line).toBeVisible();
    await shoot(page, testInfo.outputPath("archived-chat.png"));
    await line.getByTestId("chats-unarchive").click();
    await expect(line).toHaveCount(0);
    await expect(group).toHaveCount(1);
    await expect(panel.getByTestId("chats-archived-toggle")).toHaveCount(0);

    const agent = panel.getByTestId("chats-my-agent");
    await agent.focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu).toHaveCount(1);
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Agent settings",
      "Turn off",
      "Archive",
      "Remove agent…",
    ]);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await shoot(page, testInfo.outputPath("agent-menu-keyboard.png"));
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("asks before removing an agent, and manages archived agents in Settings", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "agent-archive");
    const launch = { command: `node "${fakeRunner.replaceAll('"', '\\"')}" ask` };
    const settings: DesktopUserSettings = {
      ...DEFAULT_USER_SETTINGS,
      agents: {
        nova: {
          name: "Nova",
          hue: "olive",
          launch,
          changesFiles: true,
          enabled: true,
          timeoutMinutes: 1,
        },
        scout: {
          name: "Scout",
          hue: "teal",
          launch,
          changesFiles: true,
          enabled: true,
          timeoutMinutes: 1,
        },
      },
    };
    await writeFile(
      join(temp.homeDir, USER_SETTINGS_FILE),
      `${JSON.stringify(settings, null, 2)}\n`,
    );
    desktop = await launchDesktopApp({ workspace: temp, env: await installFakeAgentTools(temp) });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const api = (
              window as unknown as {
                dohcDesktop: {
                  getWorkspaceRegistry(): Promise<{ workspaces: { workspaceId: string }[] }>;
                  listChatChannels(payload: {
                    workspaceId: string;
                  }): Promise<{ channels: { kind: string; agentId?: string }[] }>;
                };
              }
            ).dohcDesktop;
            const workspace = (await api.getWorkspaceRegistry()).workspaces[0];
            if (!workspace) return [];
            const { channels } = await api.listChatChannels({ workspaceId: workspace.workspaceId });
            return channels
              .flatMap((channel) =>
                channel.kind === "agent" && channel.agentId ? [channel.agentId] : [],
              )
              .sort();
          }),
        { timeout: 30_000 },
      )
      .toEqual(["nova", "scout"]);
    const panel = await openChatsView(page);
    const agents = panel.getByTestId("chats-my-agent");
    await expect(agents).toHaveCount(2);
    const menu = page.getByTestId("chat-row-menu");
    const nova = agents.filter({ hasText: "Nova" });
    const scout = agents.filter({ hasText: "Scout" });

    await nova.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Remove agent…" }).click();
    const confirm = page.getByTestId("remove-agent-dialog");
    await expect(confirm).toContainText("Remove Nova?");
    await expect(confirm).toContainText("Its chat stays in Archived.");
    await shoot(page, testInfo.outputPath("remove-agent-dialog.png"));
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(nova).toHaveCount(1);

    await scout.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Archive" }).click();
    await expect(scout).toHaveCount(0);
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("agents")).click();
    const section = page.getByTestId(settingsSectionPin("agents"));
    const archived = section.getByTestId("agents-archived");
    await expect(archived.getByTestId("agent-row-archived")).toHaveText(/Scout/u);
    await expect(section.getByTestId("agents").getByTestId("agent-row")).toHaveText([/Nova/u]);
    await shoot(page, testInfo.outputPath("settings-archived-agent.png"));

    await archived.getByRole("button", { name: "Remove Scout…" }).click();
    await page
      .getByTestId("remove-agent-dialog")
      .getByRole("button", { name: "Remove agent" })
      .click();
    await expect(page.getByTestId("notice-toasts")).toContainText("Removed Scout.");
    const removed = archived.getByTestId("agent-row-removed");
    await expect(removed).toHaveText(/Scout/u);
    await expect(archived.getByTestId("agent-row-archived")).toHaveCount(0);
    await shoot(page, testInfo.outputPath("settings-removed-agent.png"));

    await removed.getByRole("button", { name: "Remove Scout's chat from the list…" }).click();
    const hide = page.getByTestId("hide-agent-chat-dialog");
    await expect(hide).toContainText("Its messages stay in this workspace.");
    await shoot(page, testInfo.outputPath("hide-agent-chat-dialog.png"));
    await hide.getByRole("button", { name: "Remove from list" }).click();
    await expect(archived).toHaveCount(0);
    await page
      .getByTestId(desktopPins.settingsDialog)
      .getByRole("button", { name: "Close settings" })
      .click();
    await expect(panel.getByTestId("chats-archived-toggle")).toHaveCount(0);
    await expect(agents).toHaveCount(1);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
