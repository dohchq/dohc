import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
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

// Archive and the row menus in the Chats sidebar, over the real IPC path:
// Archive from a group's menu with Undo in the toast, an agent's message that
// leaves the chat in Archived and marks Archived unread, Unarchive from the
// open chat, and an agent's menu opened from the keyboard.
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
    await page.getByTestId("chats-add-agent-command").fill(`node "${fakeRunner.replaceAll('"', '\\"')}" ask`);
    await page.getByTestId("chats-add-agent-submit").click();
    await expect(page.getByTestId("chats-add-agent")).toHaveCount(0);
    await expect(panel.getByTestId("chats-my-agent")).toHaveCount(1);

    const group = panel.getByTestId("chats-channel").filter({ hasText: "general" });
    const menu = page.getByTestId("chat-row-menu");
    await group.click({ button: "right" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Add people…", "Archive"]);
    await shoot(page, testInfo.outputPath("group-menu.png"));

    // Archive moves the group into Archived, and Undo in the toast brings it back.
    await menu.getByRole("menuitem", { name: "Archive" }).click();
    const toasts = page.getByTestId("notice-toasts");
    await expect(toasts).toContainText("Archived general");
    await expect(group).toHaveCount(0);
    await expect(panel.getByTestId("chats-archived-count")).toHaveText("1");
    await shoot(page, testInfo.outputPath("archive-toast.png"));
    await toasts.getByRole("button", { name: "Undo" }).click();
    await expect(group).toHaveCount(1);
    await expect(panel.getByTestId("chats-archived-toggle")).toHaveCount(0);

    // Archived again, an agent's message leaves it there and marks Archived unread.
    await group.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Archive" }).click();
    await expect(group).toHaveCount(0);
    await waitForCliEndpoint(temp.homeDir);
    await runDohcCli(temp, ["chat", "post", "general", "--as-agent", "The venue is booked for Friday."]);
    const toggle = panel.getByTestId("chats-archived-toggle");
    await expect(toggle.getByTestId("chats-archived-unread")).toBeVisible();
    await expect(group).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const archived = panel.getByTestId("chats-archived-list").getByTestId("chats-channel");
    await expect(archived).toHaveText(/general/u);
    await shoot(page, testInfo.outputPath("archived-unread.png"));

    // The open chat says it is archived and offers Unarchive.
    await archived.click();
    const line = page.getByTestId("chats-archived-line");
    await expect(line).toBeVisible();
    await shoot(page, testInfo.outputPath("archived-chat.png"));
    await line.getByTestId("chats-unarchive").click();
    await expect(line).toHaveCount(0);
    await expect(group).toHaveCount(1);
    await expect(panel.getByTestId("chats-archived-toggle")).toHaveCount(0);

    // Shift+F10 on an agent's row opens its menu once, with focus in it.
    const agent = panel.getByTestId("chats-my-agent");
    await agent.focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu).toHaveCount(1);
    await expect(menu.getByRole("menuitem")).toHaveText(["Agent settings", "Turn off", "Archive", "Remove agent"]);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await shoot(page, testInfo.outputPath("agent-menu-keyboard.png"));
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
