import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun } from "./helpers/workspace";

test("@notices-layout workspace fills the window and Notices opens beside the rail", async () => {
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    const startedAt = performance.now();
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, workspace);
    await expect(page.getByTestId("workspace-shell")).toHaveAttribute("data-ready", "true");
    const readyMs = performance.now() - startedAt;
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 650));
    await page.emulateMedia({ reducedMotion: "reduce" });

    for (const theme of ["Light", "Dark"] as const) {
      await page.getByTestId("activity-settings").click();
      await page.getByTestId("settings-nav-appearance").click();
      await page.getByRole("radio", { name: theme, exact: true }).click();
      await page.getByRole("button", { name: "Close settings" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());

      const geometry = await page.evaluate(() => {
        const bounds = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().toJSON();
        return { workbench: bounds("workspace-workbench"), bell: bounds("notice-center-toggle"), settings: bounds("activity-settings"), rail: bounds("activity-bar"), height: innerHeight };
      });
      expect(geometry.workbench.bottom).toBe(geometry.height);
      expect(geometry.bell.bottom).toBeLessThanOrEqual(geometry.settings.top);
      expect(geometry.bell.left).toBeGreaterThanOrEqual(geometry.rail.left);
      expect(geometry.bell.right).toBeLessThanOrEqual(geometry.rail.right);

      const bell = page.getByTestId("notice-center-toggle");
      await bell.focus();
      await expect(bell).toBeFocused();
      const openedAt = performance.now();
      await page.keyboard.press("Enter");
      const notices = page.getByRole("dialog", { name: "Notices", exact: true });
      await expect(notices).toBeVisible();
      const openMs = performance.now() - openedAt;
      const panel = await notices.boundingBox();
      expect(panel).not.toBeNull();
      expect(panel!.x).toBeGreaterThanOrEqual(geometry.rail.right);
      expect(panel!.y).toBeGreaterThanOrEqual(40);
      expect(panel!.y + panel!.height).toBeLessThanOrEqual(geometry.height);
      await page.screenshot({ path: test.info().outputPath(`notices-${theme.toLowerCase()}.png`) });
      await page.keyboard.press("Escape");
      await expect(notices).toHaveCount(0);
      await expect(bell).toBeFocused();
      await test.info().attach(`timing-${theme}`, { body: JSON.stringify({ readyMs, openMs }), contentType: "application/json" });
    }
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
