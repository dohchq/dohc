import { expect, test, type Page } from "@playwright/test";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { activityPin, desktopPins, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun } from "./helpers/workspace";

const record = (page: Page) => page.getByTestId("usage-record");
const toggle = (page: Page) => record(page).getByRole("switch", { name: "Keep a usage record" });
const created = (page: Page) => page.getByTestId("usage-record-row-version.create");

async function openPrivacy(page: Page): Promise<void> {
  await page.getByTestId(activityPin("settings")).click();
  await expect(page.getByTestId(desktopPins.settingsDialog)).toBeVisible();
  await page.getByTestId(settingsNavPin("privacy")).click();
  await expect(page.getByTestId(settingsSectionPin("privacy"))).toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await record(page).screenshot({ path: test.info().outputPath(`privacy-usage-${name}-${colorScheme}.png`) });
  }
}

// One deliberate counted action, its count in Privacy, Off and On, then Clear.
test("@usage-record Privacy shows a counted action, keeps it while Off, and clears it after a confirm", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  const file = join(temp.homeDir, "dohc-usage.json");
  const saved = async () => JSON.parse(await readFile(file, "utf8")) as { enabled: boolean; counts: unknown[] };

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, temp);

    await page.getByTestId("version-menu-button").click();
    await page.getByTestId("version-new").click();
    await page.getByTestId("version-new-input").fill("Draft");
    await page.getByTestId("version-new-input").press("Enter");
    await expect(page.getByTestId("version-menu-active")).toHaveText("Draft", { timeout: 20_000 });

    await openPrivacy(page);
    await expect(record(page)).toHaveAttribute("data-state", "on");
    await expect(created(page).locator('[data-door="renderer"]')).toHaveText("1");
    await expect(created(page).locator('[data-door="automation"]')).toHaveText("Not counted by this version");
    await expect(record(page).getByTestId("usage-record-file")).toHaveText(file);
    await capture(page, "counts");

    // Keyboard: the switch takes focus and Space turns the record Off.
    await toggle(page).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(toggle(page)).toBeFocused();
    await capture(page, "focus");
    await page.keyboard.press("Space");
    await expect(record(page)).toHaveAttribute("data-state", "off");
    await expect(page.getByTestId("usage-record-off")).toBeVisible();
    await expect(created(page).locator('[data-door="renderer"]')).toHaveText("1");
    await expect.poll(async () => (await saved()).enabled).toBe(false);
    await capture(page, "off");

    await toggle(page).click();
    await expect(record(page)).toHaveAttribute("data-state", "on");
    await expect.poll(async () => (await saved()).enabled).toBe(true);

    await record(page).getByTestId("usage-record-clear").click();
    const confirm = page.getByTestId("usage-record-clear-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm.getByTestId("usage-record-clear-copy")).toBeVisible();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await confirm.screenshot({ path: test.info().outputPath(`privacy-usage-clear-confirm-${colorScheme}.png`) });
    }
    await confirm.getByTestId("usage-record-clear-copy").click();
    await expect.poll(() => desktop!.app.evaluate(({ clipboard }) => clipboard.readText())).toContain("version.create\t1\t");
    expect(await desktop.app.evaluate(({ clipboard }) => clipboard.readText())).not.toContain(temp.homeDir);
    await page.getByTestId("usage-record-clear-action").click();
    await expect(page.getByTestId("usage-record-empty")).toBeVisible();
    await expect.poll(async () => (await saved()).counts).toEqual([]);
    await capture(page, "empty");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// A folder where the file should be is a record dohc cannot read.
test("@usage-record Privacy says a record it cannot read stays as it is, and offers nothing that writes it", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  const file = join(temp.homeDir, "dohc-usage.json");

  try {
    await mkdir(file);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, temp);
    await openPrivacy(page);
    await expect(record(page)).toHaveAttribute("data-state", "unreadable");
    await expect(page.getByTestId("usage-record-unreadable")).toContainText("dohc could not read the usage record (EISDIR).");
    await expect(record(page).getByRole("switch")).toHaveCount(0);
    await expect(record(page).getByTestId("usage-record-clear")).toHaveCount(0);
    await expect(record(page).getByTestId("usage-record-copy")).toHaveCount(0);
    // The shell's failure hook carries it too, so it stays in Notices after Settings closes.
    await expect(page.getByTestId("notice-toasts")).toContainText("dohc could not read the usage record (EISDIR).");
    await capture(page, "unreadable");
    expect((await stat(file)).isDirectory()).toBe(true);
    expect(await readdir(file)).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
