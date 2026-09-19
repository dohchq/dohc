import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun } from "./helpers/workspace";

test("a named agent replies to a group mention with its owner on hover and focus", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;
    await page.getByTestId("titlebar-chats-sidebar").click();
    await page.getByTestId("chats-add-agent-open").click();
    await page.getByTestId("chats-add-agent-agent-name").fill("Nova");
    await page.getByTestId("chats-add-agent-name").fill("Ada");
    const command = `node "${resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs")}" report`;
    await page.getByTestId("chats-add-agent-command").fill(command);
    await page.getByTestId("chats-add-agent-submit").click();
    await expect(page.getByTestId("chats-add-agent")).toHaveCount(0);
    await expect(page.getByTestId("chats-my-agent-name")).toHaveText("Nova");
    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill("Agent name check");
    await page.getByTestId("chats-new-channel-name").press("Enter");
    const view = page.locator("main");
    await view.getByTestId("chats-new-thread-composer").fill("@agent check the exports");
    await view.getByTestId("chats-new-thread-composer").press("Enter");
    const reply = view.getByTestId("chats-comment-bubble").filter({ hasText: "done: checked the exports" });
    await expect(reply).toBeVisible();
    await expect(reply.getByTestId("chats-message-author")).toHaveText("Nova");
    const badge = reply.getByTestId("chats-comment-agent-badge");
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await badge.hover();
      const hover = reply.getByRole("tooltip");
      await expect(hover).toContainText("Owned by Ada");
      await expect(hover).toContainText(command);
      await page.screenshot({ path: testInfo.outputPath(`agent-owner-${theme}.png`) });
      await page.mouse.move(0, 0);
      await badge.focus();
      await expect(hover).toBeVisible();
      await badge.press("Escape");
      await expect(hover).toHaveCount(0);
      await badge.press("Tab");
    }
  } finally { await cleanupDesktopWorkspace(desktop, temp); }
});
