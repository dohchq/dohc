import { expect, test } from "@playwright/test";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";
import { createTestScratch, removeTestScratch } from "../src/workspaces/testTemp";

// Exercise the production renderer and real virtualizer in Chromium. The
// engine history spec separately covers IPC, capture, restore, and persistence.
test.describe("history virtualization", () => {
  let output: string;
  let server: PreviewServer;
  const buildEnvironmentKeys = ["NODE_ENV", "VITE_USER_NODE_ENV"] as const;
  let buildEnvironment: Record<(typeof buildEnvironmentKeys)[number], string | undefined>;

  test.beforeAll(async () => {
    output = await createTestScratch("history-browser-");
    const root = fileURLToPath(new URL("./fixtures/history-list", import.meta.url));
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

  for (const theme of ["light", "dark"]) {
    test(`keeps expansion, sticky days, and keyboard order in ${theme}`, async ({ page }) => {
      for (const key of buildEnvironmentKeys) {
        expect(process.env[key]).toBe(buildEnvironment[key]);
      }
      await page.setViewportSize({ width: 420, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(server.resolvedUrls!.local[0]);
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      const list = page.getByTestId("engine-history-list");
      const firstGroup = page.locator('[data-history-key="moment-0"]');
      const toggle = firstGroup.getByTestId("engine-moment-group-toggle");
      // 4,000 correlated groups, 36 day headings, notice, and load-more row.
      await expect(firstGroup).toHaveAttribute("aria-posinset", "3");
      await expect(firstGroup).toHaveAttribute("aria-setsize", "4038");
      await expect(list.getByRole("listitem").filter({ hasText: "Some protected activity" }))
        .toHaveAttribute("aria-posinset", "1");
      await expect(page.getByTestId("engine-history-day-heading").first().locator(".."))
        .toHaveAttribute("aria-posinset", "2");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await page.getByTestId("engine-history-search").focus();
      await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(firstGroup).toHaveCount(0);
      await page.getByTestId("engine-history-load-more").focus();
      await expect(page.getByTestId("engine-history-load-more").locator(".."))
        .toHaveAttribute("aria-posinset", "4038");
      await page.keyboard.press("Shift+Tab");
      await expect(page.locator('[data-moment-id="moment-4999"]')).toBeFocused();
      await page.getByTestId("engine-history-load-more").click();
      await expect(page.getByTestId("engine-history-load-more")).toHaveCount(0);
      await expect(page.locator('[data-moment-id="earlier-moment"]')).toBeVisible();
      await list.evaluate((element) => { element.scrollTop = 0; });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");

      await firstGroup.locator('[data-moment-id="moment-1"]').focus();
      await list.evaluate((element) => { element.scrollTop = 20_000; });
      await expect(page.locator('[data-moment-id="moment-399"]')).toBeVisible();
      await expect(firstGroup.locator('[data-moment-id="moment-1"]')).toBeFocused();
      await expect(firstGroup).toHaveAttribute("aria-posinset", "3");
      await expect(firstGroup).toHaveAttribute("aria-setsize", "4038");
      await expect.poll(() => list.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        return [...element.querySelectorAll('[data-testid="engine-history-day-heading"]')]
          .some((heading) => {
            const rect = heading.getBoundingClientRect();
            return rect.top >= top && rect.top < top + 30;
          });
      })).toBe(true);
      const mountedPositions = await list.getByRole("listitem").evaluateAll((items) =>
        items.map((item) => Number(item.getAttribute("aria-posinset"))),
      );
      expect(new Set(mountedPositions).size).toBe(mountedPositions.length);
      expect(mountedPositions.every((position) => position >= 1 && position <= 4038)).toBe(true);
      const dayHeadings = await list.getByTestId("engine-history-day-heading").evaluateAll((headings) =>
        headings.filter((heading) => !heading.closest('[aria-hidden="true"]'))
          .map((heading) => heading.getAttribute("datetime")),
      );
      expect(new Set(dayHeadings).size).toBe(dayHeadings.length);
      // The virtualizer can retain focus while its DOM pool is in scroll order.
      // Tab must still move to the next logical moment, not the current viewport.
      await page.keyboard.press("Tab");
      await expect(firstGroup.locator('[data-moment-id="moment-2"]')).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.locator('[data-moment-id="moment-3"]')).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Opened moment")).toHaveText("moment-3");
    });
  }
});
