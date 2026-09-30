import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
} from "./helpers/workspace";

// Home Like over the real IPC path: the keyboard picker, add, remove, and
// pointer re-add, then the like still there when Home reopens, in both
// themes under reduced motion. The recorded times are settled round trips.
// The unit suite for usePersonalChatFeed proves the paint before the write
// answers; a local write settles too fast to observe that here.
test("Home Like works by keyboard and pointer and persists across reopen in both themes", async ({}, testInfo) => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const postBody = "Like this from Home";
  try {
    await seedWorkspaceManifest(temp, "home-like-e2e");
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await page.emulateMedia({ reducedMotion: "reduce" });

    await page.getByTestId("titlebar-chats-sidebar").click();
    await page.getByTestId("chats-channel").click();
    await page.getByTestId("chats-new-thread-composer").fill(postBody);
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    const view = page.locator("main");
    await expect(view.getByTestId("chats-thread-view")).toBeVisible();

    await page.getByTestId("chats-feed-link").click();
    const card = view.getByTestId("chats-feed-item").filter({ hasText: postBody });
    await expect(card).toBeVisible();
    const like = card.getByTestId("chats-feed-like");
    const pill = card.locator('[data-testid="chats-feed-reaction-pill"][data-emoji="👍"]');
    const search = page.getByRole("textbox", { name: "Search emoji or paste any emoji" });
    await expect(pill).toHaveCount(0);

    // Keyboard: Enter opens the picker with its search focused. A pasted
    // emoji is the first choice, and Enter picks it.
    await like.focus();
    await page.keyboard.press("Enter");
    await expect(search).toBeFocused();
    await search.fill("👍");
    const chosenAt = performance.now();
    await page.keyboard.press("Enter");
    await expect(pill).toHaveAttribute("aria-pressed", "true");
    await expect(pill).toContainText("1");
    await expect(page.getByTestId("chats-feed-reaction-picker")).toHaveCount(0);
    // The write settles: focus stays on the trigger and the controls accept
    // the next write. The time is taken once they do.
    await expect(like).toBeFocused();
    await expect(like).not.toHaveAttribute("aria-disabled", "true");
    await expect(pill).not.toHaveAttribute("aria-disabled", "true");
    testInfo.annotations.push({
      type: "home-like-settled-ms",
      description: String(Math.round(performance.now() - chosenAt)),
    });

    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.screenshot({ path: testInfo.outputPath(`home-like-${theme}.png`) });
    }

    // Remove from the pill, then add again from the pointer.
    const removedAt = performance.now();
    await pill.click();
    await expect(pill).toHaveCount(0);
    await expect(like).not.toHaveAttribute("aria-disabled", "true");
    testInfo.annotations.push({
      type: "home-unlike-settled-ms",
      description: String(Math.round(performance.now() - removedAt)),
    });
    await like.click();
    await search.fill("👍");
    await page.getByRole("button", { name: "👍", exact: true }).click();
    await expect(pill).toHaveAttribute("aria-pressed", "true");
    await expect(like).not.toHaveAttribute("aria-disabled", "true");

    // Keyboard on the pill itself: the viewer is its only reactor, so it
    // unmounts, and focus moves to Add reaction instead of the page body.
    // From there the keyboard adds it back.
    await pill.focus();
    await page.keyboard.press("Enter");
    await expect(pill).toHaveCount(0);
    await expect(like).toBeFocused();
    await expect(like).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Enter");
    await expect(search).toBeFocused();
    await search.fill("👍");
    await page.keyboard.press("Enter");
    await expect(pill).toHaveAttribute("aria-pressed", "true");
    await expect(like).toBeFocused();
    await expect(like).not.toHaveAttribute("aria-disabled", "true");

    // The like is the server's, not only the paint. Close the Home tab, so
    // the next open mounts a fresh Home and reads it again, then reopen it
    // from the Chats sidebar. The close button is scoped to the tab; the
    // Open editors list carries a second one.
    const homeTab = view.getByRole("tab", { name: "Home Close Home", exact: true });
    await homeTab.getByRole("button", { name: "Close Home" }).click();
    await expect(homeTab).toHaveCount(0);
    await expect(page.getByTestId("chats-personal-feed")).toHaveCount(0);
    await page.getByTestId("chats-feed-link").click();
    await expect(homeTab).toBeVisible();
    await expect(card).toBeVisible();
    await expect(pill).toHaveAttribute("aria-pressed", "true");
    await expect(pill).toContainText("1");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
