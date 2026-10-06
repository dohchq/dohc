import { expect, test, type Page } from "@playwright/test";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";
import { createTestScratch, removeTestScratch } from "../src/workspaces/testTemp";

// The production restore review and notice toast in Chromium, at window sizes
// people use. A notice toast that is open must not block the review's action.
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
  // changes, as a person does before choosing to restore.
  async function openReview(page: Page, setup: (typeof cases)[number], expand = true) {
    await page.setViewportSize(viewports[setup.viewport]);
    await page.emulateMedia({ reducedMotion: setup.motion, colorScheme: setup.theme });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), setup.theme);
    await expect(page.getByTestId("workspace-shell-error")).toBeVisible();
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
        await page.setViewportSize(viewports[setup.viewport]);
        await page.emulateMedia({ reducedMotion: setup.motion, colorScheme: setup.theme });
        await page.goto(server.resolvedUrls!.local[0]);
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), setup.theme);
        const history = page.getByTestId("engine-history-list");
        if (scrolled) {
          await history.hover();
          await page.mouse.wheel(0, 700);
          // A later day's heading is pinned to the top of the list.
          await expect.poll(() => history.evaluate((list) => {
            const top = list.getBoundingClientRect().top;
            return [...list.querySelectorAll("[data-testid='engine-history-day-heading']")]
              .find((heading) => Math.abs(heading.closest("li")!.getBoundingClientRect().top - top) < 1)
              ?.textContent;
          })).toMatch(/Sep 1[0-6]/i);
        }
        await page.getByRole("button", { name: "Open restore review" }).press("Enter");
        const dialog = page.getByRole("dialog", { name: "Restore shared file" });
        await dialog.getByRole("button", { name: "Retry" }).press("Enter");
        await expect(dialog.getByRole("button", { name: "Restore file", exact: true })).toBeEnabled();
        await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));

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
