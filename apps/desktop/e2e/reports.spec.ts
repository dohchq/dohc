import { holdSystemClipboard } from "./helpers/systemClipboard";
import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activityPin, desktopPins, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  type TempWorkspace,
} from "./helpers/workspace";

async function openPrivacy(temp: TempWorkspace): Promise<LaunchedDesktopApp> {
  const desktop = await launchDesktopApp({ workspace: temp });
  await openWorkspaceFromFirstRun(desktop.page, temp);
  await desktop.page.getByTestId(activityPin("settings")).click();
  await expect(desktop.page.getByTestId(desktopPins.settingsDialog)).toBeVisible();
  await desktop.page.getByTestId(settingsNavPin("privacy")).click();
  await expect(desktop.page.getByTestId(settingsSectionPin("privacy"))).toBeVisible();
  return desktop;
}

const usageSwitch = (page: Page) => page.getByRole("switch", { name: "Send usage reports" });
const errorSwitch = (page: Page) => page.getByRole("switch", { name: "Send error reports" });

// A development build names no report service, so it sends nothing and
// shows no notice. The switches, diagnostics, copy, and save still work.
test("@telemetry-smoke report switches persist, and diagnostics show, copy, and save", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openPrivacy(temp);
    const { page, app } = desktop;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(usageSwitch(page)).toHaveAttribute("aria-checked", "true");
    await expect(errorSwitch(page)).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("settings-row-usage-reports")).toContainText("Unavailable for this launch.");

    // Keyboard: the switch takes focus and Space changes only that switch.
    await usageSwitch(page).focus();
    await page.keyboard.press("Space");
    await expect(usageSwitch(page)).toHaveAttribute("aria-checked", "false");
    await expect(errorSwitch(page)).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () =>
      JSON.parse(await readFile(join(temp.homeDir, "dohc-settings.json"), "utf8")).privacy,
    ).toEqual({ usageReports: false, errorReports: true });

    await page.getByTestId("diagnostics-show").click();
    const text = page.getByTestId("diagnostics-text");
    await expect(text).toContainText("dohc diagnostics");
    await expect(text).toContainText("Usage reports: unavailable for this launch");
    await expect(text).not.toContainText(temp.rootPath);

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.getByTestId(settingsSectionPin("privacy")).screenshot({
        path: test.info().outputPath(`privacy-reports-${colorScheme}.png`),
      });
    }

    await holdSystemClipboard(test.info(), async (remainingMs) => {
      await page.getByTestId("diagnostics-copy").click({ timeout: remainingMs() });
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: remainingMs() }).toContain("dohc diagnostics");
    });

    const saved = join(temp.baseDir, "diagnostics.txt");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
    }, saved);
    await page.getByTestId("diagnostics-save").click();
    await expect.poll(() => existsSync(saved)).toBe(true);
    const savedText = await readFile(saved, "utf8");
    expect(savedText).toContain("dohc diagnostics");
    expect(savedText).not.toContain(temp.rootPath);

    // Nothing here reports, so no install ID was written.
    expect(existsSync(join(temp.homeDir, "reporting.json"))).toBe(false);

    await desktop.close();
    desktop = await openPrivacy(temp);
    await expect(usageSwitch(desktop.page)).toHaveAttribute("aria-checked", "false");
    await expect(errorSwitch(desktop.page)).toHaveAttribute("aria-checked", "true");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("@telemetry-smoke a switch turned off in the settings file before launch stays off", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    await writeFile(
      join(temp.homeDir, "dohc-settings.json"),
      JSON.stringify({ version: 1, privacy: { usageReports: true, errorReports: false } }),
    );
    desktop = await openPrivacy(temp);
    await expect(usageSwitch(desktop.page)).toHaveAttribute("aria-checked", "true");
    await expect(errorSwitch(desktop.page)).toHaveAttribute("aria-checked", "false");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
