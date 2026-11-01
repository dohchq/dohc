import { activityPin } from "../src/testPins";
import { expect, test } from "@playwright/test";
import { waitForVisibleAnimations } from "./helpers/animations";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, seedWorkspaceManifest } from "./helpers/workspace";

test("emoji reactions and floating mentions stay visible without moving the composer", async ({}, testInfo) => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "reaction-polish");
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await page.getByTestId(activityPin("chats")).click();
    await page.getByTestId("chats-channel").click();
    // An empty Posts page has nothing to scroll.
    await expect(page.getByTestId("chats-channel-empty")).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      await waitForVisibleAnimations(page);
      await page.screenshot({ path: testInfo.outputPath(`posts-empty-${theme}.png`) });
    }
    expect(await page.getByTestId("chats-feed-column").evaluate((node) => ({
      overflowY: getComputedStyle(node).overflowY,
      overflow: node.scrollHeight - node.clientHeight,
    }))).toEqual({ overflowY: "auto", overflow: 0 });
    await page.getByTestId("chats-new-thread-composer").fill("Polished reactions");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    const view = page.locator("main");
    const composer = view.getByTestId("chats-composer");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await composer.fill("@");
      const menu = view.getByTestId("chats-mention-menu");
      await expect(menu).toBeVisible();
      const openBox = await composer.boundingBox();
      const menuBox = await menu.boundingBox();
      expect(menuBox!.y).toBeGreaterThanOrEqual(openBox!.y + openBox!.height);
      await page.screenshot({ path: testInfo.outputPath(`mentions-${theme}.png`) });
      await composer.press("Escape");
      const closedBox = await composer.boundingBox();
      expect(closedBox!.y).toBe(openBox!.y);
      await composer.fill("");
      // The opening post's actions show, and take the pointer, on hover.
      const trigger = view.getByTestId("chats-add-reaction").first();
      await view.locator('article[data-testid="chats-message"]').hover();
      await expect(trigger).toBeVisible();
      await trigger.click();
      const search = page.getByRole("textbox", { name: "Search emoji or paste any emoji" });
      await search.fill("🧑🏽‍🚀");
      await expect(page.getByRole("button", { name: "🧑🏽‍🚀", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`reactions-${theme}.png`) });
      await page.getByRole("button", { name: "🧑🏽‍🚀", exact: true }).click();
    }
    // The menu opens above only when the composer has no room for it below.
    // A short thread leaves its composer high, so the window ends just
    // under the composer, with less room than one row of the menu.
    await page.setViewportSize({ width: 1280, height: 480 });
    const placed = await composer.boundingBox();
    await page.setViewportSize({ width: 1280, height: Math.ceil(placed!.y + placed!.height + 30) });
    await composer.fill("@");
    const upperMenu = view.getByTestId("chats-mention-menu");
    await expect(upperMenu).toBeVisible();
    const lowComposerBox = await composer.boundingBox();
    const upperMenuBox = await upperMenu.boundingBox();
    expect(upperMenuBox!.y + upperMenuBox!.height).toBeLessThanOrEqual(lowComposerBox!.y);
    await composer.press("Escape");
    expect((await composer.boundingBox())!.y).toBe(lowComposerBox!.y);
    await composer.fill("");
    await page.setViewportSize({ width: 1280, height: 800 });
    await view.getByTestId("chats-thread-back").click();
    const card = view.getByTestId("chats-post-card").first();
    await card.hover();
    await card.getByTestId("chats-post-like").click();
    await page.getByRole("textbox", { name: "Search emoji or paste any emoji" }).fill("otter");
    await page.getByRole("button", { name: "🦦", exact: true }).click();
    await expect(card.locator('[data-testid="chats-post-reaction-pill"][data-emoji="🦦"]')).toBeVisible();
    await page.getByTestId("chats-feed-link").click();
    const homeTrigger = view.getByTestId("chats-feed-like").first();
    // Home's actions sit in each row's toolbar, shown on hover and on focus.
    const homeToolbar = view.getByTestId("chats-feed-message-toolbar").first();
    await page.mouse.move(0, 0);
    await expect(homeToolbar).toHaveCSS("opacity", "0");
    await view.getByTestId("chats-feed-item").first().hover();
    await expect(homeToolbar).toHaveCSS("opacity", "1");
    await expect(homeTrigger).toBeVisible();
    await homeTrigger.click();
    await page.getByRole("textbox", { name: "Search emoji or paste any emoji" }).fill("🦋");
    await page.getByRole("button", { name: "🦋", exact: true }).click();
    await expect(view.locator('[data-testid="chats-feed-reaction-pill"][data-emoji="🦋"]')).toBeVisible();
    for (const emoji of ["1️⃣", "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"]) {
      await view.getByTestId("chats-feed-item").first().hover();
      await homeTrigger.click();
      await page.getByRole("textbox", { name: "Search emoji or paste any emoji" }).fill(emoji);
      await page.getByRole("button", { name: emoji, exact: true }).click();
      await expect(view.getByTestId("chats-feed-reaction-pill").filter({ hasText: emoji })).toBeVisible();
    }
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      const homeCard = view.getByTestId("chats-feed-item").first();
      // Compared at rest: a hovered row takes a fill and rounded corners.
      await page.mouse.move(0, 0);
      await expect(homeCard).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      const surface = await homeCard.evaluate(node => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, radius: style.borderRadius, padding: style.paddingLeft };
      });
      await page.screenshot({ path: testInfo.outputPath(`home-card-${theme}.png`) });
      await homeCard.getByRole("button").first().click();
      const opened = view.locator('article[data-testid="chats-message"]');
      await expect(opened).toBeVisible();
      await expect(opened).toHaveCSS("background-color", surface.background);
      await expect(opened).toHaveCSS("border-radius", surface.radius);
      await expect(opened).toHaveCSS("padding-left", surface.padding);
      await page.screenshot({ path: testInfo.outputPath(`opened-card-${theme}.png`) });
      await page.getByTestId("chats-feed-link").click();
    }
  } finally { await cleanupDesktopWorkspace(desktop, temp); }
});
