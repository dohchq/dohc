import { expect, test, type Page } from "@playwright/test";
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
  await page.getByTestId("activity-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
}

async function closeSettings(page: Page) {
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
}

test("@settings-smoke opens settings and survives a basic appearance edit", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openWorkspace(temp);
    await openSettings(desktop.page);
    await expect(desktop.page.getByTestId("settings-search")).toBeVisible();
    await expect(desktop.page.getByTestId("settings-nav-appearance")).toBeVisible();
    await desktop.page.getByTestId("settings-nav-appearance").click();
    await expect(desktop.page.getByTestId("settings-section-appearance")).toBeVisible();
    await desktop.page.getByRole("radio", { name: "Dark" }).click();
    await closeSettings(desktop.page);
    await openSettings(desktop.page);
    await expect(desktop.page.getByTestId("settings-dialog")).toBeVisible();
    expect(fatalLogs(desktop)).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("@settings-smoke draws a switch's thumb inside its track, on and off", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openWorkspace(temp);
    const page = desktop.page;
    await openSettings(page);
    await page.getByTestId("settings-nav-privacy").click();
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
    await desktop.page.getByTestId("settings-search").fill("theme");
    await expect(desktop.page.getByTestId("settings-section-appearance")).toBeVisible();
    await desktop.page.getByTestId("settings-search").fill("mcp");
    await expect(desktop.page.getByTestId("settings-section-agents")).toBeVisible();
    await desktop.page.getByTestId("settings-search").fill("definitely-no-setting");
    await expect(desktop.page.getByTestId("settings-empty-search")).toBeVisible();
    await desktop.page.getByTestId("settings-search").fill("");

    await desktop.page.getByTestId("settings-nav-appearance").click();
    await desktop.page.getByRole("radio", { name: "Dark" }).click();
    await expect
      .poll(() => desktop!.page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");

    await desktop.page.getByTestId("settings-nav-agents").click();
    // The snippet renders the app-canonical forward-slash workspace path.
    const canonicalRootPath = normalizeAbsolutePath(temp.rootPath);
    await expect(desktop.page.getByTestId("mcp-config-snippet")).toContainText(
      canonicalRootPath,
    );
    await desktop.page.getByRole("button", { name: "Copy" }).click();
    await expect
      .poll(() => desktop!.app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain(canonicalRootPath);

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
    await expect(desktop.page.getByTestId("settings-warning").first()).toBeVisible();
    await expect(desktop.page.getByTestId("settings-dialog")).toBeVisible();
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
    await desktop.page.getByTestId("settings-nav-files").click();
    await expect(desktop.page.getByTestId("settings-section-files")).toBeVisible();

    const select = desktop.page.getByTestId("attachment-location-select");
    // The folder-name row is present for the default (per-document) location.
    await expect(desktop.page.getByTestId("attachment-folder-input")).toBeVisible();
    await select.selectOption("same-folder");
    // same-folder hides the (meaningless) folder-name row.
    await expect(desktop.page.getByTestId("attachment-folder-input")).toHaveCount(0);

    await closeSettings(desktop.page);
    await openSettings(desktop.page);
    await desktop.page.getByTestId("settings-nav-files").click();
    await expect(desktop.page.getByTestId("attachment-location-select")).toHaveValue(
      "same-folder",
    );
    expect(fatalLogs(desktop)).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("settings remains usable at desktop minimum size", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openWorkspace(temp);
    // Cover comfortable desktop sizes down to the minimum supported shell
    // dimensions so the modal stays usable at responsive breakpoints.
    for (const [width, height] of [
      [1040, 760],
      [920, 700],
      [840, 620],
    ]) {
      await desktop.app.evaluate(
        async ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
        },
        { width, height },
      );
      // Windows DPI scaling can round the applied size by a pixel; the
      // responsive breakpoint under test is unaffected by that rounding.
      // Other platforms keep the exact round-trip pin.
      const sizeTolerance = process.platform === "win32" ? 1 : 0;
      await expect
        .poll(async () => {
          const size = await desktop!.app.evaluate(({ BrowserWindow }) => {
            const [currentWidth, currentHeight] =
              BrowserWindow.getAllWindows()[0]?.getSize() ?? [0, 0];
            return { height: currentHeight, width: currentWidth };
          });
          return (
            Math.abs(size.width - width) <= sizeTolerance &&
            Math.abs(size.height - height) <= sizeTolerance
          );
        })
        .toBe(true);
      await openSettings(desktop.page);
      await expect(desktop.page.getByTestId("settings-search")).toBeVisible();
      await expect(desktop.page.getByRole("button", { name: "Close settings" })).toBeVisible();
      await closeSettings(desktop.page);
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
