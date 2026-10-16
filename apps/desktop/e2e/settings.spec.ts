import { holdSystemClipboard } from "./helpers/systemClipboard";
import { desktopPins, activityPin, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeAbsolutePath } from "@dohc/workspace-core";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  type TempWorkspace,
} from "./helpers/workspace";

const FATAL_LOG_PATTERNS = [
  /MODULE_NOT_FOUND/,
  /Uncaught (Error|Exception)/i,
  /Cannot find module/,
  /Unable to load preload script/,
  /Renderer process crashed/i,
  /ERR_FILE_NOT_FOUND/,
  /blocked by CORS policy/,
];

function fatalLogs(desktop: LaunchedDesktopApp): string[] {
  return desktop.logs
    .map((entry) => entry.text)
    .filter((text) => FATAL_LOG_PATTERNS.some((pattern) => pattern.test(text)));
}

async function openWorkspace(temp: TempWorkspace): Promise<LaunchedDesktopApp> {
  const desktop = await launchDesktopApp({ workspace: temp });
  await openWorkspaceFromFirstRun(desktop.page, temp);
  return desktop;
}

async function openSettings(page: Page) {
  await page.getByTestId(activityPin("settings")).click();
  await expect(page.getByTestId(desktopPins.settingsDialog)).toBeVisible();
}

async function closeSettings(page: Page) {
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByTestId(desktopPins.settingsDialog)).toHaveCount(0);
}

test("@settings-smoke opens settings and survives a basic appearance edit", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openWorkspace(temp);
    await openSettings(desktop.page);
    await expect(desktop.page.getByTestId(desktopPins.settingsSearch)).toBeVisible();
    await expect(desktop.page.getByTestId(settingsNavPin("appearance"))).toBeVisible();
    await desktop.page.getByTestId(settingsNavPin("appearance")).click();
    await expect(desktop.page.getByTestId(settingsSectionPin("appearance"))).toBeVisible();
    await desktop.page.getByRole("radio", { name: "Dark" }).click();
    await closeSettings(desktop.page);
    await openSettings(desktop.page);
    await expect(desktop.page.getByTestId(desktopPins.settingsDialog)).toBeVisible();
    expect(fatalLogs(desktop)).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("draws a switch's thumb inside its track, on and off", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openWorkspace(temp);
    const page = desktop.page;
    await openSettings(page);
    await page.getByTestId(settingsNavPin("privacy")).click();
    const toggle = page.getByRole("switch", { name: "Confirm external links" });
    // Where the thumb sits: inside the track, at the end for its state.
    const thumbPlace = () =>
      toggle.evaluate((element) => {
        const track = element.getBoundingClientRect();
        const thumb = element.querySelector("span")!.getBoundingClientRect();
        if (thumb.left < track.left || thumb.right > track.right) return "outside";
        return thumb.left + thumb.width / 2 > track.left + track.width / 2 ? "end" : "start";
      });

    for (const [checked, place] of [["true", "end"], ["false", "start"]] as const) {
      if ((await toggle.getAttribute("aria-checked")) !== checked) await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", checked);
      await expect.poll(thumbPlace).toBe(place);
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("settings search, theme persistence, MCP config, and corrupt settings recovery", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openWorkspace(temp);
    await openSettings(desktop.page);
    await desktop.page.getByTestId(desktopPins.settingsSearch).fill("theme");
    await expect(desktop.page.getByTestId(settingsSectionPin("appearance"))).toBeVisible();
    await desktop.page.getByTestId(desktopPins.settingsSearch).fill("mcp");
    await expect(desktop.page.getByTestId(settingsSectionPin("agents"))).toBeVisible();
    await desktop.page.getByTestId(desktopPins.settingsSearch).fill("definitely-no-setting");
    await expect(desktop.page.getByTestId(desktopPins.settingsEmptySearch)).toBeVisible();
    await desktop.page.getByTestId(desktopPins.settingsSearch).fill("");

    await desktop.page.getByTestId(settingsNavPin("appearance")).click();
    await desktop.page.getByRole("radio", { name: "Dark" }).click();
    await expect
      .poll(() => desktop!.page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");

    await desktop.page.getByTestId(settingsNavPin("agents")).click();
    // The snippet renders the app-canonical forward-slash workspace path.
    const canonicalRootPath = normalizeAbsolutePath(temp.rootPath);
    await expect(desktop.page.getByTestId("mcp-config-snippet")).toContainText(
      canonicalRootPath,
    );
    await holdSystemClipboard(test.info(), async (remainingMs) => {
      await desktop!.page.getByRole("button", { name: "Copy" }).click({ timeout: remainingMs() });
      await expect
        .poll(() => desktop!.app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: remainingMs() })
        .toContain(canonicalRootPath);
    });

    await desktop.close();
    desktop = await openWorkspace(temp);
    await expect
      .poll(() => desktop!.page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");

    await desktop.close();
    // Intentionally malformed JSON verifies tolerant recovery from a corrupt
    // user settings file.
    await writeFile(join(temp.homeDir, "dohc-settings.json"), "{not json");
    desktop = await openWorkspace(temp);
    await openSettings(desktop.page);
    await expect(desktop.page.getByTestId(desktopPins.settingsWarning).first()).toBeVisible();
    await expect(desktop.page.getByTestId(desktopPins.settingsDialog)).toBeVisible();
    expect(fatalLogs(desktop)).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("attachment location setting persists across reopen", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openWorkspace(temp);
    await openSettings(desktop.page);
    await desktop.page.getByTestId(settingsNavPin("files")).click();
    await expect(desktop.page.getByTestId(settingsSectionPin("files"))).toBeVisible();

    const select = desktop.page.getByTestId("attachment-location-select");
    // The folder-name row is present for the default (per-document) location.
    await expect(desktop.page.getByTestId("attachment-folder-input")).toBeVisible();
    await select.selectOption("same-folder");
    // same-folder hides the (meaningless) folder-name row.
    await expect(desktop.page.getByTestId("attachment-folder-input")).toHaveCount(0);

    await closeSettings(desktop.page);
    await openSettings(desktop.page);
    await desktop.page.getByTestId(settingsNavPin("files")).click();
    await expect(desktop.page.getByTestId("attachment-location-select")).toHaveValue(
      "same-folder",
    );
    expect(fatalLogs(desktop)).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("settings remains usable down to the minimum supported renderer viewport", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openWorkspace(temp);
    // Pin CSS viewport dimensions so native window frame and DPI rounding
    // do not decide which responsive layout this test covers.
    for (const [width, height] of [
      [1040, 760],
      [920, 700],
      [840, 620],
    ]) {
      await desktop.page.setViewportSize({ width, height });
      await expect
        .poll(() =>
          desktop!.page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
        )
        .toEqual({ width, height });
      await openSettings(desktop.page);
      const dialog = desktop.page.getByTestId(desktopPins.settingsDialog);
      await expect
        .poll(() =>
          dialog.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.left >= 0 &&
              rect.top >= 0 &&
              rect.right <= innerWidth &&
              rect.bottom <= innerHeight
            );
          }),
        )
        .toBe(true);
      const search = desktop.page.getByTestId(desktopPins.settingsSearch);
      await expect(search).toBeVisible();
      await expect(search).toBeInViewport({ ratio: 1 });
      await search.click();
      await search.fill("theme");
      await expect(desktop.page.getByTestId(settingsSectionPin("appearance"))).toBeVisible();
      await search.fill("");
      const closeButton = desktop.page.getByRole("button", { name: "Close settings" });
      await expect(closeButton).toBeVisible();
      await expect(closeButton).toBeInViewport({ ratio: 1 });
      await closeSettings(desktop.page);
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
