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
