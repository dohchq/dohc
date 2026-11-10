import { activityPin, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { waitForVisibleAnimations } from "./helpers/animations";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { startServerProxy } from "./helpers/selfHostOnboarding";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  trustOpenWorkspace,
} from "./helpers/workspace";

// Screenshot harness (@ui-audit) for Settings › Agents: the list with one
// agent on, one off, one you run and two personal agents, the on agent's page,
// keyboard focus on its switch, Add agent with Agent link chosen, a signed-in
// personal agent's page and its reach sheet, and a signed-out one's page.
// Light and dark, cropped to the section or the sheet. Not a regression test;
// it runs only when a shot directory is set.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture Settings › Agents screenshots");

const command = `node "${resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs").replaceAll('"', '\\"')}" report`;
const SETTINGS: DesktopUserSettings = {
  ...DEFAULT_USER_SETTINGS,
  profile: { preferredName: "Sam" },
  agents: {
    default: { name: "Nova", hue: "olive", launch: { command }, changesFiles: true, enabled: true, timeoutMinutes: 1 },
    vega: { name: "Vega", hue: "blue", launch: { command }, changesFiles: true, enabled: false, timeoutMinutes: 1 },
    terminal: { name: "Terminal", hue: "rose", changesFiles: true, enabled: false, timeoutMinutes: 1 },
  },
};

const WORKSPACE_ID = "settings-agents-shots";
const OWNER = "settings-agents-owner";
const GROK = `p-${"a".repeat(26)}`;
const MIRA = `p-${"b".repeat(26)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// The account's personal agents, answered by the proxy in place of the relay.
// Signing an agent in for real needs an account server this harness doesn't run.
function personalRoster(now: number) {
  return {
    ok: true,
    // The relay's own revision for an account with no agents, so its notice
    // pages don't ask for another read.
    revision: 0,
    agents: [
      {
        agentId: GROK, name: "Grok Bot", hue: "teal", reportedProduct: "Grok", reportedVersion: "4.1", status: "active",
        createdAtMs: now - 7 * DAY, signedInAtMs: now - 3 * DAY, lastActionAtMs: now - 2 * HOUR,
        reach: [{ workspaceId: WORKSPACE_ID, level: "comment" }, { workspaceId: "budget", level: "view" }],
      },
      {
        agentId: MIRA, name: "Mira", hue: "amber", reportedProduct: null, reportedVersion: null, status: "signed_out",
        createdAtMs: now - 20 * DAY, signedInAtMs: now - 20 * DAY, lastActionAtMs: now - 9 * DAY, reach: [],
      },
    ],
    workspaces: [{ workspaceId: WORKSPACE_ID, name: "Trip" }, { workspaceId: "budget", name: "Budget" }],
  };
}

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

test("@ui-audit Settings › Agents with local and personal agents, their pages, and Add agent", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let relay: SyncRelayHandle | undefined;
  let proxy: Awaited<ReturnType<typeof startServerProxy>> | undefined;

  try {
    const roster = personalRoster(Date.now());
    proxy = await startServerProxy(undefined, {
      answer: (method, path) => method === "GET" && path === "/sync/personal-agents" ? { status: 200, body: roster } : undefined,
    });
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay", "relay.sqlite") });
    proxy.routeRelayTo(relay.baseUrl);
    await seedWorkspaceManifest(temp, WORKSPACE_ID);
    await seedCloudCredentials(temp, { serverUrl: proxy.origin, relayUrl: proxy.origin, userId: OWNER, token: `test:${OWNER}` });
    await writeFile(join(temp.homeDir, USER_SETTINGS_FILE), `${JSON.stringify(SETTINGS, null, 2)}\n`);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("agents")).click();
    const section = page.getByTestId(settingsSectionPin("agents"));
    const row = (id: string) => section.locator(`[data-testid="agent-row"][data-agent-id="${id}"]`);
    await expect(row("default").getByTestId("agent-state")).toContainText("On");
    await expect(row("vega").getByTestId("agent-state")).toContainText("Off");
    await expect(row("terminal").getByTestId("agent-state")).toHaveText("Through MCP");
    await expect(row(GROK).getByTestId("agent-state")).toContainText("Active 2h ago");
    await expect(row(MIRA).getByTestId("agent-state")).toContainText("Signed out");
    await page.mouse.move(0, 0);
    await shoot(page, section, "settings-agents");

    // Nova's page: its switch, its test, what it can do and how dohc starts it.
    await row("default").click();
    const agentPage = section.getByTestId("agent-page");
    await expect(agentPage).toHaveAttribute("data-agent-id", "default");
    const novaSwitch = agentPage.getByRole("switch", { name: "Run Nova on this computer" });
    await expect(novaSwitch).toHaveAttribute("aria-checked", "true");
    await page.mouse.move(0, 0);
    await shoot(page, section, "settings-agents-page");

    // Tab from the back button to the switch.
    await agentPage.getByTestId("agent-back").focus();
    for (let presses = 0; presses < 6 && !await novaSwitch.evaluate((element) => element === document.activeElement); presses += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(novaSwitch).toBeFocused();
    await shoot(page, section, "settings-agents-switch-focus");
    await agentPage.getByTestId("agent-back").click();

    // Add agent with Agent link chosen: the link this workspace's agents sign in with.
    await section.getByTestId("agent-add").click();
    const addSheet = page.getByTestId("agent-add-sheet");
    await addSheet.getByTestId("agent-runs-with-link").click();
    await expect(addSheet.getByTestId("agent-add-link")).toContainText(new URL(proxy.origin).host);
    await expect(addSheet.getByTestId("agent-add-link-copy")).toBeEnabled();
    await page.mouse.move(0, 0);
    await shoot(page, addSheet, "settings-agents-add-link");
    await addSheet.getByRole("button", { name: "Cancel" }).click();
    await expect(addSheet).toBeHidden();

    // Grok Bot's page: its color, what it can reach, its activity and Sign out.
    await row(GROK).click();
    await expect(agentPage).toHaveAttribute("data-agent-id", GROK);
    await expect(agentPage).toHaveAttribute("data-status", "active");
    await expect(agentPage.getByTestId("personal-agent-activity")).toContainText("Grok 4.1");
    await page.mouse.move(0, 0);
    await shoot(page, section, "settings-agents-personal-page");

    // Its reach sheet, with this workspace at Comment and Budget at View.
    await agentPage.getByTestId("personal-agent-reach").click();
    const reachSheet = page.getByTestId("personal-agent-reach-sheet");
    await expect(reachSheet.getByTestId("personal-agent-reach-row")).toHaveCount(2);
    await page.mouse.move(0, 0);
    await shoot(page, reachSheet, "settings-agents-personal-reach");
    await reachSheet.getByTestId("personal-agent-reach-cancel").click();
    await expect(reachSheet).toBeHidden();
    await agentPage.getByTestId("agent-back").click();

    // Mira signed out: dimmed, no reach, and a way to sign in again.
    await row(MIRA).click();
    await expect(agentPage).toHaveAttribute("data-agent-id", MIRA);
    await expect(agentPage).toHaveAttribute("data-status", "signed_out");
    await expect(agentPage.getByTestId("personal-agent-link-copy")).toBeEnabled();
    await page.mouse.move(0, 0);
    await shoot(page, section, "settings-agents-personal-signed-out");
  } finally {
    await Promise.allSettled([relay?.stop(), proxy?.close()]);
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
