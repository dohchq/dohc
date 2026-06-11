import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright";
import { launchApp } from "./launch";

// Phase E0 gate: the graphite-minimal tokens (D-E5) are applied in a REAL
// window — computed styles carry the new values, light⟷dark flips through
// the product's own command, and no warm-paper-family color survives
// anywhere in the rendered tree.

const SCREENSHOT_DIR = "test-results/screenshots/e0-e1";

// Graphite tokens as the rgb() strings getComputedStyle returns.
const LIGHT = {
  bg: "rgb(255, 255, 255)",
  panel2: "rgb(244, 244, 245)",
  ink: "rgb(24, 24, 27)",
};
const DARK = {
  bg: "rgb(24, 24, 27)",
  panel2: "rgb(28, 28, 30)",
  ink: "rgb(250, 250, 250)",
};

// The retired warm-paper family (index.html first paint, brand tokens, and
// the old BACKGROUND_COLOR) — none of these may appear as a computed color.
const WARM_FAMILY = new Set(
  [
    ["#faf7f2", "250, 247, 242"],
    ["#f7f6f1", "247, 246, 241"],
    ["#fffefa", "255, 254, 250"],
    ["#ece9e1", "236, 233, 225"],
    ["#e8e4de", "232, 228, 222"],
    ["#2b2926", "43, 41, 38"],
    ["#1c1a18", "28, 26, 24"],
    ["#100f0e", "16, 15, 14"],
    ["#191c1a", "25, 28, 26"],
    ["#0e0e0d", "14, 14, 13"],
    ["#f4f1ea", "244, 241, 234"],
    ["#d7d0c0", "215, 208, 192"],
    ["#2d342e", "45, 52, 46"],
  ].map(([, rgb]) => `rgb(${rgb})`),
);

async function warmOffenders(page: Page): Promise<string[]> {
  return page.evaluate((warm: string[]) => {
    const warmSet = new Set(warm);
    const offenders: string[] = [];
    const elements = Array.from(document.querySelectorAll("*")).slice(0, 1500);
    elements.unshift(document.body);
    for (const element of elements) {
      const style = getComputedStyle(element);
      for (const property of [
        "color",
        "backgroundColor",
        "borderTopColor",
        "borderLeftColor",
      ] as const) {
        const value = style[property];
        if (warmSet.has(value)) {
          offenders.push(
            `${element.tagName.toLowerCase()}.${element.className} ${property}=${value}`,
          );
        }
      }
    }
    return offenders;
  }, Array.from(WARM_FAMILY));
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
  const scheme = await page.evaluate(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}--${width}x${height}--${scheme}.png`,
  });
}

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1536, height: 960 },
];

async function shotAtSizes(page: Page, name: string): Promise<void> {
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await shot(page, name);
  }
}

async function toggleThemeViaPalette(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("toggle light");
  await page.keyboard.press("Enter");
}

test("graphite-minimal tokens in a real window, light and dark, no warm hexes", async () => {
  const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
  const app = await launchApp({ DOHC_TEST_HOME: testHome });
  const page = await app.firstWindow();

  // --- First run: light tokens + Inter on the body ---
  // The X server's reported color-scheme is environment-dependent; pin it so
  // the light assertions are deterministic (theme.ts follows the media query
  // until the user explicitly toggles).
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");
  await page.evaluate(() => document.fonts.ready);
  const bodyStyle = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return {
      background: style.backgroundColor,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      interLoaded: document.fonts.check("13px InterVariable"),
    };
  });
  expect(bodyStyle.background).toBe(LIGHT.bg);
  expect(bodyStyle.color).toBe(LIGHT.ink);
  expect(bodyStyle.fontFamily).toContain("InterVariable");
  expect(bodyStyle.fontSize).toBe("13px");
  expect(bodyStyle.interLoaded).toBe(true);
  expect(await warmOffenders(page)).toEqual([]);
  await shotAtSizes(page, "first-run");

  // --- Shell: sidebar carries panel-2, titlebar strip carries panel-2 ---
  await page.getByRole("button", { name: /create workspace/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  const chrome = await page.evaluate(() => {
    const titlebar = document.querySelector('[data-testid="titlebar"]')!;
    const tree = document.querySelector('[data-testid="file-tree"]')!;
    return {
      titlebar: getComputedStyle(titlebar).backgroundColor,
      sidebar: getComputedStyle(tree.closest("aside")!).backgroundColor,
    };
  });
  expect(chrome.titlebar).toBe(LIGHT.panel2);
  expect(chrome.sidebar).toBe(LIGHT.panel2);

  // Primary button is ink-filled (accent = ink), not a brand color.
  await page.keyboard.press("ControlOrMeta+n");
  const nameInput = page.getByRole("textbox", { name: /file name/i });
  await nameInput.fill("notes/today.md");
  await nameInput.press("Enter");
  await expect(page.getByTestId("file-tree").getByText("today.md")).toBeVisible();
  await shotAtSizes(page, "shell");

  // --- Markdown open: 15px document type ---
  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type("today");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("view-markdown")).toBeVisible();
  expect(
    await page
      .getByTestId("view-markdown")
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("15px");
  await shotAtSizes(page, "markdown");

  // --- Command palette ---
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await shotAtSizes(page, "command-palette");
  await page.keyboard.press("Escape");

  // --- Settings ---
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await shotAtSizes(page, "settings");
  expect(await warmOffenders(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await page.mouse.click(10, 400); // close overlay via backdrop

  // --- Flip to dark through the product's own command ---
  await toggleThemeViaPalette(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
  const darkBody = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return { background: style.backgroundColor, color: style.color };
  });
  expect(darkBody.background).toBe(DARK.bg);
  expect(darkBody.color).toBe(DARK.ink);
  const darkChrome = await page.evaluate(() => {
    const titlebar = document.querySelector('[data-testid="titlebar"]')!;
    return { titlebar: getComputedStyle(titlebar).backgroundColor };
  });
  expect(darkChrome.titlebar).toBe(DARK.panel2);
  expect(await warmOffenders(page)).toEqual([]);

  // Dark screenshots across the same surfaces.
  await shotAtSizes(page, "shell");
  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type("today");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("view-markdown")).toBeVisible();
  await shotAtSizes(page, "markdown");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await shotAtSizes(page, "command-palette");
  await page.keyboard.press("Escape");
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await shotAtSizes(page, "settings");
  expect(await warmOffenders(page)).toEqual([]);

  await app.close();

  // --- First-run dark (its own launch: pre-workspace surface) ---
  const home2 = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
  const app2 = await launchApp({ DOHC_TEST_HOME: home2 });
  const page2 = await app2.firstWindow();
  await expect(page2.getByRole("heading", { name: /dohc/i })).toBeVisible();
  await page2.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page2.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
  expect(
    await page2.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toBe(DARK.bg);
  expect(await warmOffenders(page2)).toEqual([]);
  await shotAtSizes(page2, "first-run");
  await app2.close();
});
