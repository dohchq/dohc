import { expect, test, type Page } from "@playwright/test";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";
import { createTestScratch, removeTestScratch } from "../src/workspaces/testTemp";
import { waitForVisibleAnimations } from "./helpers/animations";

// The production restore review and notice toast in Chromium, at window sizes
// people use. The toast sits above the review and takes clicks there, and an
// open toast must not block the review's action: the review scrolls clear of it.
const viewports = {
  minimum: { width: 840, height: 620 },
  default: { width: 1280, height: 800 },
  large: { width: 1920, height: 1080 },
} as const;
const cases = [
  { viewport: "minimum", theme: "light", motion: "no-preference" },
  { viewport: "minimum", theme: "dark", motion: "reduce" },
  { viewport: "default", theme: "light", motion: "reduce" },
  { viewport: "default", theme: "dark", motion: "no-preference" },
  { viewport: "large", theme: "light", motion: "no-preference" },
  { viewport: "large", theme: "dark", motion: "reduce" },
] as const;

test.describe("shared restore review with a notice toast", () => {
  let output: string;
  let server: PreviewServer;
  const buildEnvironmentKeys = ["NODE_ENV", "VITE_USER_NODE_ENV"] as const;
  let buildEnvironment: Record<(typeof buildEnvironmentKeys)[number], string | undefined>;

  test.beforeAll(async () => {
    output = await createTestScratch("shared-restore-browser-");
    const root = fileURLToPath(new URL("./fixtures/shared-restore-modal", import.meta.url));
    buildEnvironment = {
      NODE_ENV: process.env.NODE_ENV,
      VITE_USER_NODE_ENV: process.env.VITE_USER_NODE_ENV,
    };
    try {
      await build({
        configFile: false,
        root,
        plugins: [tailwind()],
        esbuild: { jsx: "automatic" },
        build: { outDir: output, emptyOutDir: true },
        logLevel: "error",
      });
      server = await preview({
        configFile: false,
        root,
        build: { outDir: output },
        preview: { host: "127.0.0.1", port: 0 },
      });
    } finally {
      // Vite changes NODE_ENV in this Playwright worker. Later Electron tests
      // must see the environment used to prepare their desktop artifacts.
      for (const key of buildEnvironmentKeys) {
        if (buildEnvironment[key] === undefined) delete process.env[key];
        else process.env[key] = buildEnvironment[key];
      }
    }
  });

  test.afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => error ? reject(error) : resolve());
    });
    if (output) await removeTestScratch(output);
  });

  // Open the review with the toast already showing, then expand the removed
  // changes, as a person does before choosing to restore. `beforeOpen` acts on
  // the loaded page before the review opens.
  async function openReview(page: Page, setup: (typeof cases)[number], expand = true, beforeOpen?: () => Promise<void>) {
    await page.setViewportSize(viewports[setup.viewport]);
    await page.emulateMedia({ reducedMotion: setup.motion, colorScheme: setup.theme });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), setup.theme);
    await expect(page.getByTestId("workspace-shell-error")).toBeVisible();
    await beforeOpen?.();
    await page.getByRole("button", { name: "Open restore review" }).press("Enter");
    const dialog = page.getByRole("dialog", { name: "Restore shared file" });
    await dialog.getByRole("button", { name: "Retry" }).press("Enter");
    const restore = dialog.getByRole("button", { name: "Restore file", exact: true });
    await expect(restore).toBeEnabled();
    if (expand) {
      await dialog.getByText("Removed by this restore").press("Enter");
      await expect(dialog.getByRole("listitem")).toHaveCount(20);
    }
    return { dialog, restore };
  }

  for (const setup of cases) {
    test(`a pointer reaches Restore file at the ${setup.viewport} size in ${setup.theme} with ${setup.motion} motion`, async ({ page }) => {
      for (const key of buildEnvironmentKeys) {
        expect(process.env[key]).toBe(buildEnvironment[key]);
      }
      const { restore } = await openReview(page, setup);
      // The action sits below the fold until the person scrolls the review.
      await expect(restore).not.toBeInViewport();
      const { width, height } = viewports[setup.viewport];
      await page.mouse.move(width / 2, height / 2);
      await page.mouse.wheel(0, 20_000);
      await expect(restore).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: test.info().outputPath(`restore-review-${setup.viewport}-${setup.theme}.png`) });
      // An ordinary click: Playwright refuses when another element receives it.
      await restore.click({ timeout: 2_000 });
      await expect(page.getByRole("dialog", { name: "File restored" })).toBeVisible();
      await expect(page.getByLabel("Restore result")).toHaveText("restored");
    });
  }

  // History's day headings stick above the list. The review must still own
  // every point it covers, including its title and path, once it has settled.
  for (const setup of cases) {
    for (const scrolled of [false, true]) {
      test(`the restore review covers History's ${scrolled ? "scrolled " : ""}day heading at the ${setup.viewport} size in ${setup.theme} with ${setup.motion} motion`, async ({ page }) => {
        const history = page.getByTestId("engine-history-list");
        const { dialog } = await openReview(page, setup, false, scrolled ? async () => {
          await history.hover();
          await page.mouse.wheel(0, 700);
          // A later day's heading is pinned to the top of the list.
          await expect.poll(() => history.evaluate((list) => {
            const top = list.getBoundingClientRect().top;
            return [...list.querySelectorAll("[data-testid='engine-history-day-heading']")]
              .find((heading) => Math.abs(heading.closest("li")!.getBoundingClientRect().top - top) < 1)
              ?.textContent;
          })).toMatch(/Sep 1[0-6]/i);
        } : undefined);
        await waitForVisibleAnimations(page);

        const { overlaps, misses } = await dialog.evaluate((review) => {
          const bounds = review.getBoundingClientRect();
          const points: Array<{ label: string; x: number; y: number }> = [];
          for (const part of [review.querySelector("h2")!, review.querySelector("p")!]) {
            const rect = part.getBoundingClientRect();
            points.push({ label: part.textContent ?? "", x: rect.left + 2, y: rect.top + rect.height / 2 });
          }
          let overlaps = 0;
          for (const heading of document.querySelectorAll("[data-testid='engine-history-day-heading']")) {
            const rect = heading.closest("li")!.getBoundingClientRect();
            const left = Math.max(rect.left, bounds.left);
            const right = Math.min(rect.right, bounds.right);
            const top = Math.max(rect.top, bounds.top);
            const bottom = Math.min(rect.bottom, bounds.bottom);
            if (left >= right || top >= bottom) continue;
            overlaps += 1;
            points.push({ label: heading.textContent ?? "", x: (left + right) / 2, y: (top + bottom) / 2 });
          }
          const misses = points
            .filter((point) => !review.contains(document.elementFromPoint(point.x, point.y)))
            .map((point) => `${point.label} at ${Math.round(point.x)},${Math.round(point.y)}`);
          return { overlaps, misses };
        });
        await page.screenshot({ path: test.info().outputPath(`restore-over-history-${setup.viewport}-${setup.theme}${scrolled ? "-scrolled" : ""}.png`) });
        // The large window leaves the review clear of the sidebar.
        expect(overlaps > 0).toBe(setup.viewport !== "large");
        expect(misses).toEqual([]);
      });
    }
  }

  for (const setup of cases.filter((candidate) => candidate.viewport === "minimum")) {
    test(`the toast is on top of the open review and takes a click in ${setup.theme}`, async ({ page }) => {
      const { dialog } = await openReview(page, setup, false);
      const toast = page.getByTestId("workspace-shell-error");
      // What a pointer at the toast's middle hits is the toast, not the review or its scrim.
      expect(await toast.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`toast-over-review-${setup.theme}.png`) });
      // An ordinary click: Playwright refuses when another element receives it.
      await toast.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByLabel("Toast retries")).toHaveText("1");
      await expect(dialog).toBeVisible();
      // Closing it leaves the trap whole: the next Tab lands in the review.
      await toast.getByRole("button", { name: "Dismiss workspace error" }).click();
      await expect(toast).toHaveCount(0);
      await page.keyboard.press("Tab");
      await expect(dialog.locator(":focus")).toHaveCount(1);
    });
  }

  // At the smallest window, with a toast showing and the review at rest, the
  // review's actions sit above the toast: a pointer at their centres and a
  // keyboard focus both reach them without scrolling.
  for (const setup of cases.filter((candidate) => candidate.viewport === "minimum")) {
    test(`the review's actions clear the toast at rest at the minimum size in ${setup.theme}`, async ({ page }) => {
      const { dialog, restore } = await openReview(page, setup, false);
      const close = dialog.getByRole("button", { name: "Close", exact: true });
      const atCentre = (button: typeof restore) => button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      });
      expect(await atCentre(restore)).toBe(true);
      expect(await atCentre(close)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`review-at-rest-minimum-${setup.theme}.png`) });

      // Keyboard focus lands on Restore file where it can be seen.
      await page.keyboard.press("Shift+Tab");
      await expect(restore).toBeFocused();
      expect(await atCentre(restore)).toBe(true);

      const centre = async (button: typeof restore) => {
        const box = await button.boundingBox();
        if (!box) throw new Error("the button has no box");
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      const closeAt = await centre(close);
      await page.mouse.click(closeAt.x, closeAt.y);
      await expect(dialog).toHaveCount(0);

      const reopened = await openReview(page, setup, false);
      const restoreAt = await centre(reopened.restore);
      await page.mouse.click(restoreAt.x, restoreAt.y);
      await expect(page.getByRole("dialog", { name: "File restored" })).toBeVisible();
    });
  }

  // A window without the shell keeps its notices in a fixed corner wrapper.
  // Its toasts still rise above a warning dialog, such as the one that asks
  // before dohc closes, and take clicks there.
  for (const theme of ["light", "dark"] as const) {
    test(`a corner toast is on top of a warning dialog and takes a click in ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewports.minimum);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`${server.resolvedUrls!.local[0]}?host=corner`);
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      const toast = page.getByTestId("workspace-shell-error");
      await expect(toast).toBeVisible();
      await page.getByRole("button", { name: "Open warning" }).press("Enter");
      await expect(page.getByRole("dialog", { name: "Close dohc?" })).toBeVisible();
      expect(await toast.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`corner-toast-over-warning-${theme}.png`) });
      await toast.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByLabel("Toast retries")).toHaveText("1");
      await expect(page.getByRole("dialog", { name: "Close dohc?" })).toBeVisible();
    });
  }

  test("F6 reaches the toast from the review and comes back, and Tab never leaves the two", async ({ page }) => {
    const { dialog, restore } = await openReview(page, cases[1], false);
    await page.keyboard.press("Shift+Tab");
    await expect(restore).toBeFocused();
    await page.keyboard.press("F6");
    const toasts = page.getByTestId("notice-toasts");
    const retry = toasts.getByRole("button", { name: "Try again" });
    await expect(retry).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("toast-keyboard-focus-dark.png") });
    // Tab cycles the toast's own controls; it does not reach the page behind.
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press("Tab");
      await expect(toasts.locator(":focus")).toHaveCount(1);
    }
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Toast retries")).toHaveText("1");
    // Escape from the toast goes back to where F6 left the review, and the
    // review stays open. F6 goes there and back again.
    await page.keyboard.press("Escape");
    await expect(restore).toBeFocused();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("F6");
    await expect(retry).toBeFocused();
    await page.keyboard.press("F6");
    await expect(restore).toBeFocused();
    // Closing the focused toast from the keyboard leaves the trap whole: the
    // next Tab lands in the review, not on the page behind it.
    await page.keyboard.press("F6");
    await toasts.getByRole("button", { name: "Dismiss workspace error" }).focus();
    await page.keyboard.press("Enter");
    await expect(toasts.getByTestId("workspace-shell-error")).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
  });

  test("the keyboard stays in the restore review while a toast is open", async ({ page }) => {
    // Retry leaves the review, so focus starts outside its controls.
    const { dialog, restore } = await openReview(page, cases[0], false);
    await page.keyboard.press("Shift+Tab");
    await expect(restore).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await expect(page.getByTestId("notice-toasts").locator(":focus")).toHaveCount(0);
    await page.keyboard.press("Shift+Tab");
    await expect(restore).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "File restored" })).toBeVisible();
  });
});
