import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace } from "./helpers/workspace";

// The states page's notice-details part, drawn by a real browser: a toast and a
// Notices row with Details closed, open, and open with a report long enough to
// scroll. Opening one from the keyboard keeps focus on Details, and the next
// Tab reaches Copy details. With UI_AUDIT_SHOT_DIR set, it saves both themes at
// rest, scrolled, with focus on Details, and with focus on Copy details.

const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR;
const BLEED = 16;

async function shoot(page: Page, part: Locator, name: string) {
  if (!SHOT_DIR) return;
  const box = await part.boundingBox();
  if (!box) throw new Error("the notice-details part must be on the page");
  const x = box.x - BLEED;
  const y = box.y - BLEED;
  await page.screenshot({ scale: "css", clip: { x, y, width: box.width + 2 * BLEED, height: Math.ceil(box.height + 2 * BLEED) }, path: join(SHOT_DIR, `${name}.png`) });
}

const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

// Keyboard focus on Details, then Enter opens it in place and Tab reaches Copy details.
async function openFromKeyboard(page: Page, details: Locator, testId: string) {
  await details.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe(`${testId}-details`);
  await expect(details).toHaveAttribute("aria-expanded", "false");
  return async () => {
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("aria-expanded", "true");
    await expect(details).toHaveText("Hide details");
    expect(await focused(page), "focus stays on Details").toBe(`${testId}-details`);
    await page.keyboard.press("Tab");
    expect(await focused(page), "the next Tab reaches Copy details").toBe(`${testId}-details-copy`);
  };
}

test("a notice's Details opens its report in place, scrolls a long one, and keeps the keyboard on Details, then Copy details", async () => {
  test.setTimeout(120_000);
  if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp, env: { DOHC_DEV_TOOLS: "1" } });
    const page = desktop.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = "html { scrollbar-width: none; } *, ::before, ::after { animation: none !important; transition: none !important; }";
      document.head.append(style);
    });
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();
    await page.evaluate(() => { window.location.hash = "#/dev/states"; });
    await expect(page.getByTestId("states-page")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.setViewportSize({ width: 1440, height: await page.evaluate(() => document.documentElement.scrollHeight) });

    for (const theme of ["light", "dark"] as const) {
      const part = page.getByTestId(`states-${theme}`).locator('[data-part="notice-details"]');
      const toasts = part.getByTestId("workspace-shell-error");
      const closedRow = part.getByTestId("notice-details-false");
      await expect(toasts).toHaveCount(3);
      await page.mouse.move(2, 2);

      // Closed: Details and no Copy icon. Open: the report under the message.
      await expect(toasts.nth(0).getByTestId("workspace-shell-error-details")).toHaveText("Details");
      await expect(toasts.nth(0).getByTestId("workspace-shell-error-copy")).toHaveCount(0);
      await expect(toasts.nth(0).getByTestId("workspace-shell-error-details-text")).toHaveCount(0);
      await expect(toasts.nth(1).getByTestId("workspace-shell-error-details-text")).toBeVisible();
      await expect(closedRow.getByTestId("notice-details-false-details-text")).toHaveCount(0);
      await expect(part.getByTestId("notice-details-true-details-text")).toBeVisible();
      await shoot(page, part, `notice-details-${theme}-rest`);

      // A long report scrolls inside its block, which stops at 240px.
      for (const block of [toasts.nth(2).getByTestId("workspace-shell-error-details-text"), part.getByTestId("notice-details-long-details-text")]) {
        const report = block.locator("pre");
        const size = await report.evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight }));
        expect(size.client).toBeLessThanOrEqual(240);
        expect(size.scroll).toBeGreaterThan(size.client);
        await report.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      }
      await shoot(page, part, `notice-details-${theme}-scrolled`);

      const openToast = await openFromKeyboard(page, toasts.nth(0).getByTestId("workspace-shell-error-details"), "workspace-shell-error");
      const toastFocus = await page.evaluate(() => document.activeElement!.matches(":focus-visible"));
      expect(toastFocus, "Details shows its focus ring").toBe(true);
      await shoot(page, part, `notice-details-${theme}-toast-details-focus`);
      await openToast();
      await shoot(page, part, `notice-details-${theme}-toast-copy-focus`);

      const openRow = await openFromKeyboard(page, closedRow.getByTestId("notice-details-false-details"), "notice-details-false");
      await shoot(page, part, `notice-details-${theme}-row-details-focus`);
      await openRow();
      await shoot(page, part, `notice-details-${theme}-row-copy-focus`);
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
