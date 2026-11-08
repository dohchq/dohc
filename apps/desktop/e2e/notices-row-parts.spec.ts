import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace } from "./helpers/workspace";

// The states page's toasts and Notices rows, drawn by a real browser. A
// row's worded action is the toast's bordered button and starts where the
// row's text starts; a row with nowhere to go draws no pointer and no hover.
// With UI_AUDIT_SHOT_DIR set, it also saves both themes at rest, with a row's
// button hovered, and with a row that goes nowhere hovered.

const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR;
const BLEED = 16;
const BUTTON_STYLE = ["height", "borderTopWidth", "borderTopColor", "borderRadius", "fontSize", "paddingLeft", "color"] as const;

async function buttonStyle(button: Locator) {
  return button.evaluate((node, keys) => {
    const style = getComputedStyle(node);
    return Object.fromEntries(keys.map((key) => [key, style[key]]));
  }, [...BUTTON_STYLE]);
}

// Both parts, toasts above rows, with room for their shadows.
async function shoot(page: Page, pane: Locator, name: string) {
  if (!SHOT_DIR) return;
  const boxes = await Promise.all(["toasts", "notices"].map((part) => pane.locator(`[data-part="${part}"]`).boundingBox()));
  const [toasts, notices] = boxes;
  if (!toasts || !notices) throw new Error("the toasts and notices parts must both be on the page");
  const x = Math.min(toasts.x, notices.x) - BLEED;
  const y = Math.min(toasts.y, notices.y) - BLEED;
  const right = Math.max(toasts.x + toasts.width, notices.x + notices.width) + BLEED;
  const bottom = Math.max(toasts.y + toasts.height, notices.y + notices.height) + BLEED;
  await page.screenshot({ scale: "css", clip: { x, y, width: right - x, height: Math.ceil(bottom - y) }, path: join(SHOT_DIR, `${name}.png`) });
}

test("a Notices row's actions are the toast's buttons, in line with its text, and a row with nowhere to go draws no hover", async () => {
  test.setTimeout(120_000);
  if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp, env: { DOHC_DEV_TOOLS: "1" } });
    const page = desktop.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    // No animation or transition, so a hover reads its end state at once.
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = "html { scrollbar-width: none; } *, ::before, ::after { animation: none !important; transition: none !important; }";
      document.head.append(style);
    });
    await expect(page.getByTestId("first-run-open-share")).toBeVisible();
    await page.evaluate(() => { window.location.hash = "#/dev/states"; });
    await expect(page.getByTestId("states-page")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // The viewport takes the whole page, so nothing scrolls under a capture.
    await page.setViewportSize({ width: 1440, height: await page.evaluate(() => document.documentElement.scrollHeight) });

    for (const theme of ["light", "dark"] as const) {
      const pane = page.getByTestId(`states-${theme}`);
      const rows = pane.locator('[data-part="notices"]');
      const failed = rows.getByTestId("notice-sync");
      const rowAction = failed.getByRole("button", { name: "Try again" });
      const toastAction = pane.locator('[data-part="toasts"]').getByTestId("workspace-shell-error-retry").first();

      await page.mouse.move(2, 2);
      expect(await buttonStyle(rowAction), `a row's Try again draws as the toast's (${theme})`).toEqual(await buttonStyle(toastAction));
      // The button's edge, not its words, starts where the title's words start.
      const edges = await failed.evaluate((row) => {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && node.textContent?.trim() !== "Sync stopped") node = walker.nextNode();
        if (!node) throw new Error("the row has no title text");
        const range = document.createRange();
        range.selectNodeContents(node);
        const button = [...row.querySelectorAll("button")].find((each) => each.textContent === "Try again");
        return { title: range.getBoundingClientRect().left, button: button!.getBoundingClientRect().left };
      });
      expect(Math.abs(edges.button - edges.title), `a row's Try again starts at its text (${theme})`).toBeLessThanOrEqual(0.5);
      await shoot(page, pane, `notices-row-parts-${theme}-rest`);

      await rowAction.hover();
      await shoot(page, pane, `notices-row-parts-${theme}-button-hover`);

      // The moved row has nowhere to go: hovering it changes nothing.
      const moved = rows.getByTestId("notice-moved");
      const look = () => moved.evaluate((row) => ({ background: getComputedStyle(row).backgroundColor, cursor: getComputedStyle(row).cursor }));
      await page.mouse.move(2, 2);
      const before = await look();
      await moved.hover();
      expect(await look(), `a row with nowhere to go draws no hover (${theme})`).toEqual(before);
      expect(before.cursor, `a row with nowhere to go has no pointer (${theme})`).not.toBe("pointer");
      await shoot(page, pane, `notices-row-parts-${theme}-nowhere-hover`);
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
