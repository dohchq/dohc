import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  await page.getByTestId("open-settings").click();
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
    await desktop.page.getByRole("button", { name: "Dark" }).click();
    await closeSettings(desktop.page);
    await openSettings(desktop.page);
    await expect(desktop.page.getByTestId("settings-dialog")).toBeVisible();
    expect(fatalLogs(desktop)).toEqual([]);
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
    await desktop.page.getByRole("button", { name: "Dark" }).click();
    await expect
      .poll(() => desktop!.page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");

    await desktop.page.getByTestId("settings-nav-agents").click();
    await expect(desktop.page.getByTestId("mcp-config-snippet")).toContainText(
      temp.rootPath,
    );
    await desktop.page.getByRole("button", { name: "Copy" }).click();
    await expect
      .poll(() => desktop!.app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain(temp.rootPath);

    await desktop.close();
    desktop = await openWorkspace(temp);
    await expect
      .poll(() => desktop!.page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");

    await desktop.close();
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

test("settings remains usable at desktop minimum size", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openWorkspace(temp);
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
      await openSettings(desktop.page);
      await expect(desktop.page.getByTestId("settings-search")).toBeVisible();
      await expect(desktop.page.getByRole("button", { name: "Close settings" })).toBeVisible();
      await closeSettings(desktop.page);
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
