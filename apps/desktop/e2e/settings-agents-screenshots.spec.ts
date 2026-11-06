import { activityPin, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { waitForVisibleAnimations } from "./helpers/animations";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  trustOpenWorkspace,
} from "./helpers/workspace";

// Screenshot harness (@ui-audit) for Settings › Agents: one agent on and one
// off, then keyboard focus on the on agent's switch. Light and dark, cropped
// to the Agents section. Not a regression test; it runs only when a shot
// directory is set.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture Settings › Agents screenshots");

const command = `node "${resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs").replaceAll('"', '\\"')}" report`;
const SETTINGS: DesktopUserSettings = {
  ...DEFAULT_USER_SETTINGS,
  profile: { preferredName: "Sam" },
  agents: {
    default: { name: "Nova", hue: "olive", launch: { command }, changesFiles: true, enabled: true, timeoutMinutes: 1 },
    vega: { name: "Vega", hue: "blue", launch: { command }, changesFiles: true, enabled: false, timeoutMinutes: 1 },
  },
};

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
  await waitForVisibleAnimations(page);
}

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

test("@ui-audit Settings › Agents with an agent on and one off, and focus on a switch", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, "settings-agents-shots");
    await writeFile(join(temp.homeDir, USER_SETTINGS_FILE), `${JSON.stringify(SETTINGS, null, 2)}\n`);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("agents")).click();
    const section = page.getByTestId(settingsSectionPin("agents"));
    const row = (id: string) => section.locator(`[data-testid="agent-row"][data-agent-id="${id}"]`);
    // Found by role alone, so the same scene also shoots the build before this change.
    const novaSwitch = row("default").getByRole("switch");
    await expect(novaSwitch).toHaveAttribute("aria-checked", "true");
    await expect(row("vega").getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await shoot(page, section, "settings-agents");

    // Tab from the agent's name to its switch, past Check when it takes focus.
    await row("default").getByRole("button", { name: "Rename Nova" }).focus();
    for (let presses = 0; presses < 3 && !await novaSwitch.evaluate((element) => element === document.activeElement); presses += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(novaSwitch).toBeFocused();
    await shoot(page, section, "settings-agents-switch-focus");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
