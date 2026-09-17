import { expect, test, type Locator } from "@playwright/test";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";
import { createTestScratch, removeTestScratch } from "../src/workspaces/testTemp";
import type {} from "./fixtures/chat-list/api";

function gap(list: Locator): Promise<number> {
  return list.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
}

// These tests use the production ChatMessageList and real browser layout.
// workspace-chat-virtualization.spec.ts covers the Electron hosts and IPC.
test.describe("chat list virtualization", () => {
  let output: string;
  let server: PreviewServer;
  const environmentKeys = ["NODE_ENV", "VITE_USER_NODE_ENV"] as const;
  let environment: Record<(typeof environmentKeys)[number], string | undefined>;

  test.beforeAll(async () => {
    output = await createTestScratch("chat-list-browser-");
    const root = fileURLToPath(new URL("./fixtures/chat-list", import.meta.url));
    environment = { NODE_ENV: process.env.NODE_ENV, VITE_USER_NODE_ENV: process.env.VITE_USER_NODE_ENV };
    try {
      await build({
        configFile: false,
        root,
        plugins: [tailwind()],
        esbuild: { jsx: "automatic" },
        build: { outDir: output, emptyOutDir: true },
        logLevel: "error",
      });
      server = await preview({ configFile: false, root, build: { outDir: output }, preview: { host: "127.0.0.1", port: 0 } });
    } finally {
      // Keep Vite's build environment out of later Electron preflight checks.
      for (const key of environmentKeys) {
        if (environment[key] === undefined) delete process.env[key];
        else process.env[key] = environment[key];
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
    test(`dismisses the reaction picker when its message scrolls away in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 420, height: 400 });
      await page.goto(server.resolvedUrls!.local[0]);
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.evaluate(() => window.chatListFixture.jump("m-200"));
      const trigger = page.locator('[data-message-id="m-200"]').getByRole("button", { name: "Add reaction" });
      await trigger.click();
      const picker = page.getByTestId("fixture-chat-reaction-picker");
      await expect(picker).toBeVisible();
      await page.getByRole("list").hover();
      await page.mouse.wheel(0, -100_000);
      await expect(page.locator('[data-message-id="m-0"]')).toBeInViewport();
      await expect(picker).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(trigger).not.toBeInViewport();
      await page.keyboard.press("Enter");
      await expect(picker).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(trigger).not.toBeInViewport();
    });

    test(`follows resize and growth but preserves Home history in ${theme}`, async ({ page }) => {
      for (const key of environmentKeys) expect(process.env[key]).toBe(environment[key]);
      await page.setViewportSize({ width: 650, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(server.resolvedUrls!.local[0]);
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      const list = page.getByRole("list");
      const row = (id: string) => page.locator(`[data-message-id="${id}"]`);
      await expect(row("m-499")).toBeInViewport();
      await expect.poll(() => gap(list)).toBeLessThan(2);
      await expect(row("m-0")).toHaveCount(0);

      await page.setViewportSize({ width: 320, height: 360 });
      await expect.poll(() => gap(list)).toBeLessThan(2);
      const originalHeight = await row("m-499").evaluate((node) => node.getBoundingClientRect().height);
      await page.evaluate(() => window.chatListFixture.grow("m-499"));
      await expect.poll(() => row("m-499").evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(originalHeight);
      await expect.poll(() => gap(list)).toBeLessThan(2);

      await row("m-499").getByRole("button", { name: "Add reaction" }).focus();
      await page.keyboard.press("Home");
      await expect(row("m-0")).toBeInViewport({ ratio: 1 });
      const firstRowTop = await row("m-0").evaluate((node) => node.getBoundingClientRect().top);
      await page.evaluate(() => window.chatListFixture.append());
      await expect(row("m-0")).toHaveAttribute("aria-setsize", "501");
      await expect.poll(() => row("m-0").evaluate((node, top) =>
        Math.abs(node.getBoundingClientRect().top - top), firstRowTop)).toBeLessThan(2);
      await page.setViewportSize({ width: 500, height: 600 });
      await expect(row("m-0")).toBeInViewport({ ratio: 1 });
      await expect.poll(() => row("m-0").evaluate((node, top) =>
        Math.abs(node.getBoundingClientRect().top - top), firstRowTop)).toBeLessThan(2);

      // A jump to the last item resumes following even after reading history.
      await page.evaluate(() => window.chatListFixture.jump("m-500"));
      await expect(row("m-500")).toBeInViewport();
      await expect.poll(() => gap(list)).toBeLessThan(2);
      await page.evaluate(() => window.chatListFixture.append());
      await expect(row("m-501")).toBeInViewport();
      await expect.poll(() => gap(list)).toBeLessThan(2);
    });

    test(`retains focus, logical Tab order, and selected text in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 650, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(server.resolvedUrls!.local[0]);
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      const list = page.getByRole("list");
      const row = (id: string) => page.locator(`[data-message-id="${id}"]`);
      await expect(row("m-499")).toBeInViewport();
      await page.evaluate(() => window.chatListFixture.jump("m-200"));
      const trigger = row("m-200").getByRole("button", { name: "Add reaction" });
      await expect(trigger).toBeInViewport();
      await trigger.focus();
      await list.hover();
      await page.mouse.wheel(0, -100_000);
      await expect(row("m-0")).toBeInViewport();
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(row("m-201").getByRole("button", { name: "Add reaction" })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(trigger).toBeFocused();

      await page.evaluate(() => window.chatListFixture.jump("m-300"));
      const body = row("m-300").getByTestId("fixture-chat-message-body");
      await expect(body).toBeInViewport();
      const bounds = await body.boundingBox();
      if (!bounds) throw new Error("Message body is missing its layout box");
      await page.mouse.move(bounds.x + 5, bounds.y + 10);
      await page.mouse.down();
      await page.mouse.move(bounds.x + Math.min(220, bounds.width - 5), bounds.y + 10, { steps: 5 });
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => document.getSelection()?.toString().length ?? 0)).toBeGreaterThan(5);
      const selected = await page.evaluate(() => document.getSelection()?.toString());
      await list.hover();
      await page.mouse.wheel(0, -100_000);
      await expect(row("m-0")).toBeInViewport();
      await expect(row("m-300")).toBeAttached();
      await expect(row("m-300")).not.toBeInViewport();
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selected);
    });
  }

  test("Tab crosses unmounted plain rows between read-only file links", async ({ page }) => {
    await page.setViewportSize({ width: 650, height: 800 });
    await page.goto(`${server.resolvedUrls!.local[0]}?sparse`);
    const list = page.getByRole("list");
    const link = (index: number) => page.locator(`[data-message-id="m-${index}"]`).getByTestId("fixture-chat-message-body-file-mention");
    await expect(page.locator('[data-message-id="m-499"]')).toBeInViewport();
    await page.evaluate(() => window.chatListFixture.jump("m-200"));
    await expect(link(200)).toBeInViewport();
    await link(200).focus();
    await list.hover();
    await page.mouse.wheel(0, -100_000);
    await expect(link(0)).toBeInViewport();
    await expect(link(200)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(link(300)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Opened file")).toHaveText("notes/plan-300.md");
    await page.keyboard.press("Shift+Tab");
    await expect(link(200)).toBeFocused();
  });

  test("keeps the reading anchor when older messages arrive or change order", async ({ page }) => {
    await page.setViewportSize({ width: 650, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(server.resolvedUrls!.local[0]);
    await expect(page.locator('[data-message-id="m-499"]')).toBeInViewport();
    await page.evaluate(() => window.chatListFixture.jump("m-200"));
    const anchor = page.locator('[data-message-id="m-200"]');
    await expect(anchor).toBeInViewport({ ratio: 1 });
    const top = await anchor.evaluate((node) => node.getBoundingClientRect().top);
    await page.evaluate(() => window.chatListFixture.prepend());
    await expect(anchor).toHaveAttribute("aria-setsize", "520");
    await expect(anchor).toHaveAttribute("aria-posinset", "221");
    await expect.poll(() => anchor.evaluate((node, previousTop) =>
      Math.abs(node.getBoundingClientRect().top - previousTop), top)).toBeLessThan(2);

    // Moving an existing row from below the viewport into older history must
    // preserve the reading position too, without dropping data preservation.
    await page.evaluate(() => window.chatListFixture.reorder());
    await expect(anchor).toHaveAttribute("aria-posinset", "222");
    await expect.poll(() => anchor.evaluate((node, previousTop) =>
      Math.abs(node.getBoundingClientRect().top - previousTop), top)).toBeLessThan(2);
    await expect(anchor).toBeInViewport({ ratio: 1 });
  });
});
