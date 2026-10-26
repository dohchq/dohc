import { holdSystemClipboard } from "./helpers/systemClipboard";
import { desktopPins, activityPin, editorTabTestId, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalWorkspaceRoot } from "../src/workspaces/createWorkspaceFolder";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { installFakeAgentTools } from "./helpers/agentTools";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
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

async function openWorkspace(temp: TempWorkspace, env?: NodeJS.ProcessEnv): Promise<LaunchedDesktopApp> {
  const desktop = await launchDesktopApp({ workspace: temp, env });
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

test("settings search finds matching sections and shows an empty result", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    // Searching for "mcp" opens the Agents section, which detects agent tools.
    desktop = await openWorkspace(temp, await installFakeAgentTools(temp));
    await openSettings(desktop.page);
    await desktop.page.getByTestId(desktopPins.settingsSearch).fill("theme");
    await expect(desktop.page.getByTestId(settingsSectionPin("appearance"))).toBeVisible();
    await desktop.page.getByTestId(desktopPins.settingsSearch).fill("mcp");
    await expect(desktop.page.getByTestId(settingsSectionPin("agents"))).toBeVisible();
    await desktop.page.getByTestId(desktopPins.settingsSearch).fill("definitely-no-setting");
    await expect(desktop.page.getByTestId(desktopPins.settingsEmptySearch)).toBeVisible();
    await desktop.page.getByTestId(desktopPins.settingsSearch).fill("");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("theme setting persists across a restart", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openWorkspace(temp);
    await openSettings(desktop.page);
    await desktop.page.getByTestId(settingsNavPin("appearance")).click();
    await desktop.page.getByRole("radio", { name: "Dark" }).click();
    await expect
      .poll(() => desktop!.page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");

    await desktop.close();
    desktop = await openWorkspace(temp);
    await expect
      .poll(() => desktop!.page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("MCP config shows and copies the canonical workspace path", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    desktop = await openWorkspace(temp, await installFakeAgentTools(temp));
    await openSettings(desktop.page);
    await desktop.page.getByTestId(settingsNavPin("agents")).click();
    // The snippet renders the workspace's real path in forward-slash form.
    const canonicalRootPath = canonicalWorkspaceRoot(temp.rootPath);
    await expect(desktop.page.getByTestId("mcp-config-snippet")).toContainText(
      canonicalRootPath,
    );
    await holdSystemClipboard(test.info(), async (remainingMs) => {
      await desktop!.page.getByRole("button", { name: "Copy" }).click({ timeout: remainingMs() });
      await expect
        .poll(() => desktop!.app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: remainingMs() })
        .toContain(canonicalRootPath);
    });
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("corrupt settings recover with a warning and a usable dialog", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
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

// The surfaces around open work that a theme change repaints.
const THEMED_SURFACES = {
  "active tab": '[data-testid="editor-tabs"] [role="tab"][aria-selected="true"]',
  "other tab": '[data-testid="editor-tabs"] [role="tab"][aria-selected="false"]',
  editor: ".cm-editor",
  gutter: ".cm-gutters",
};

interface ThemeWatch {
  colors(): Record<string, string>;
  firstFrame: Promise<Record<string, string>>;
}

// Records the surfaces' colors in the first frame drawn after the next theme
// change.
async function watchNextThemeChange(page: Page): Promise<void> {
  await page.evaluate((surfaces) => {
    const colors = () => Object.fromEntries(Object.entries(surfaces).flatMap(([name, selector]) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return [[`${name} fill`, style.backgroundColor], [`${name} text`, style.color]];
    }));
    const firstFrame = new Promise<Record<string, string>>((resolve) => {
      const observer = new MutationObserver(() => {
        observer.disconnect();
        requestAnimationFrame(() => resolve(colors()));
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    });
    (window as Window & { themeWatch?: ThemeWatch }).themeWatch = { colors, firstFrame };
  }, THEMED_SURFACES);
}

// The first frame after the change already has the colors the window keeps
// once every transition has ended.
async function expectThemeChangeInOneFrame(page: Page): Promise<void> {
  const first = await page.evaluate(() => (window as Window & { themeWatch?: ThemeWatch }).themeWatch!.firstFrame);
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().some((animation) => animation instanceof CSSTransition)))
    .toBe(false);
  const settled = await page.evaluate(() => (window as Window & { themeWatch?: ThemeWatch }).themeWatch!.colors());
  expect(first).toEqual(settled);
}

test("a theme change repaints open tabs and the editor in one frame", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    const lines = Array.from({ length: 120 }, (_, index) => `export const limit${index} = ${index};`);
    await writeWorkspaceFiles(temp, [
      { path: "notes.md", contents: "# Notes\n\nA paragraph.\n" },
      { path: "limits.js", contents: `${lines.join("\n")}\n` },
    ]);
    desktop = await openWorkspace(temp);
    const page = desktop.page;
    await explorerRow(page, "notes.md").click();
    await expect(page.getByTestId(editorTabTestId("notes.md"))).toBeVisible();
    await explorerRow(page, "limits.js").click();
    await expect(page.getByTestId(editorTabTestId("limits.js"))).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".cm-content")).toBeVisible();

    await openSettings(page);
    await page.getByTestId(settingsNavPin("appearance")).click();
    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await watchNextThemeChange(page);
    await page.getByRole("radio", { name: "Dark" }).click();
    await expectThemeChangeInOneFrame(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // Following the system, the change keeps the editor, its scroll and its
    // selection. Playwright's page starts with a light color scheme.
    await page.getByRole("radio", { name: "System" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await closeSettings(page);
    await page.locator(".cm-scroller").evaluate((scroller) => {
      scroller.scrollTop = 600;
    });
    await page.locator(".cm-line", { hasText: /^export const limit40 =/ }).click({ position: { x: 4, y: 6 } });
    await page.keyboard.press("Shift+End");
    await page.locator(".cm-editor").evaluate((editor) => {
      (window as Window & { themedEditor?: Element }).themedEditor = editor;
    });
    const editorState = () => page.evaluate(() => ({
      sameEditor: document.querySelector(".cm-editor") === (window as Window & { themedEditor?: Element }).themedEditor,
      scrollTop: document.querySelector(".cm-scroller")!.scrollTop,
      selection: getSelection()?.toString(),
    }));
    const before = await editorState();
    expect(before).toEqual({ sameEditor: true, scrollTop: 600, selection: "export const limit40 = 40;" });
    // A transition already on screen keeps running through the change.
    await page.evaluate(async () => {
      const element = document.body.appendChild(document.createElement("div"));
      element.id = "running-transition";
      element.style.transition = "opacity 60s linear";
      void getComputedStyle(element).opacity;
      element.style.opacity = "0";
      await element.getAnimations()[0]!.ready;
    });
    await watchNextThemeChange(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.locator("#running-transition").evaluate((element) => {
      const playState = element.getAnimations()[0]?.playState;
      element.remove();
      return playState;
    })).toBe("running");
    await expectThemeChangeInOneFrame(page);
    expect(await editorState()).toEqual(before);
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
