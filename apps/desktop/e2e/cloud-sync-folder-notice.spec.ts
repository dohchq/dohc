import { activityPin, settingsNavPin } from "../src/testPins";
import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
} from "./helpers/workspace";

const TITLE = "This workspace is inside OneDrive";

test("@cloud-sync-folder-notice a workspace inside a cloud-synced folder warns once on this computer", async () => {
  test.setTimeout(120_000);
  const workspace = await createTempWorkspace();
  const env = { DOHC_TEST_CLOUD_SYNC_FOLDER: "OneDrive" };
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace, env });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, workspace);
    await expect(page.getByTestId("workspace-shell")).toHaveAttribute("data-ready", "true");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const toast = page.getByTestId("workspace-shell-notice").filter({ hasText: TITLE });
    await expect(toast).toBeVisible();

    for (const theme of ["Light", "Dark"] as const) {
      await page.getByTestId(activityPin("settings")).click();
      await page.getByTestId(settingsNavPin("appearance")).click();
      await page.getByRole("radio", { name: theme, exact: true }).click();
      await page.getByRole("button", { name: "Close settings" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());
      await expect(toast).toBeVisible();
      await toast.screenshot({
        path: test.info().outputPath(`cloud-sync-folder-toast-${theme.toLowerCase()}.png`),
      });
    }

    const details = toast.getByRole("button", { name: "Details" });
    await details.focus();
    await expect(details).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(toast.getByRole("button", { name: "Dismiss workspace notice" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toast).toHaveCount(0);

    await page.getByTestId("notice-center-toggle").click();
    const notices = page.getByRole("dialog", { name: "Notices", exact: true });
    await expect(notices.getByText(TITLE)).toHaveCount(1);
    await notices.screenshot({
      path: test.info().outputPath("cloud-sync-folder-notices-dark.png"),
    });
    await page.keyboard.press("Escape");
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    await desktop.close();

    desktop = await launchDesktopApp({ workspace, env });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    await expect(desktop.page.getByTestId("workspace-shell")).toHaveAttribute("data-ready", "true");
    // Wait until the asynchronous cloud-sync check has populated sync status so
    // the absence assertions below prove suppression rather than a fast race.
    await expect
      .poll(async () =>
        desktop!.page.evaluate(async () => {
          const desktopApi = (
            window as unknown as {
              dohcDesktop?: {
                getWorkspaceRegistry?: () => Promise<{
                  workspaces: Array<{ workspaceId: string }>;
                }>;
                getSyncStatus?: (input: {
                  workspaceId: string;
                }) => Promise<{ cloudSyncFolder?: { service: string | null } }>;
              };
            }
          ).dohcDesktop;
          const registry = await desktopApi?.getWorkspaceRegistry?.();
          const workspaceId = registry?.workspaces[0]?.workspaceId;
          if (!workspaceId) return null;
          const status = await desktopApi?.getSyncStatus?.({ workspaceId });
          return status?.cloudSyncFolder?.service ?? null;
        }),
      )
      .toBe("OneDrive");
    await expect(desktop.page.getByTestId("workspace-shell-notice")).toHaveCount(0);
    await desktop.page.getByTestId("notice-center-toggle").click();
    await expect(
      desktop.page.getByRole("dialog", { name: "Notices", exact: true }).getByText(TITLE),
    ).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
