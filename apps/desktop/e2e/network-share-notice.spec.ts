import { activityPin, settingsNavPin } from "../src/testPins";
import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun } from "./helpers/workspace";

const TITLE = "This workspace is on a network share";

test("@network-share-notice a workspace on a network share warns once on this computer", async () => {
  // Two launches of the app.
  test.setTimeout(120_000);
  const workspace = await createTempWorkspace();
  const env = { DOHC_TEST_NETWORK_SHARE: "1" };
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
      await toast.screenshot({ path: test.info().outputPath(`network-share-toast-${theme.toLowerCase()}.png`) });
    }

    // The toast's controls take the keyboard: copy, then dismiss.
    const copy = toast.getByRole("button", { name: "Copy notice details" });
    await copy.focus();
    await expect(copy).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(toast.getByRole("button", { name: "Dismiss workspace notice" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toast).toHaveCount(0);

    // Closing the toast keeps the row.
    await page.getByTestId("notice-center-toggle").click();
    const notices = page.getByRole("dialog", { name: "Notices", exact: true });
    await expect(notices.getByText(TITLE)).toHaveCount(1);
    await notices.screenshot({ path: test.info().outputPath("network-share-notices-dark.png") });
    await page.keyboard.press("Escape");
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    await desktop.close();

    // This computer was told: the next launch says nothing. The seam
    // answers before the open returns, so a ready shell has the answer.
    desktop = await launchDesktopApp({ workspace, env });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    await expect(desktop.page.getByTestId("workspace-shell")).toHaveAttribute("data-ready", "true");
    await expect(desktop.page.getByTestId("workspace-shell-notice")).toHaveCount(0);
    await desktop.page.getByTestId("notice-center-toggle").click();
    await expect(desktop.page.getByRole("dialog", { name: "Notices", exact: true }).getByText(TITLE)).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
