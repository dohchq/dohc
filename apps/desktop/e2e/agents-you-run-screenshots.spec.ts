import { activityPin, desktopPins, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { agentsListening, openAgentChat, startAgentYouRun, stopAgentYouRun } from "./helpers/agentTools";
import { waitForVisibleAnimations } from "./helpers/animations";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  trustOpenWorkspace,
} from "./helpers/workspace";

// Screenshot harness (@ui-audit) for agents you run, light and dark: Settings ›
// Agents with one agent dohc starts and two you run, one of them Listening;
// Add agent with Another agent chosen; an agent you run's page and its menu;
// the Undo just after Remove; and the reply in the agent's chat under its name
// and color. Not a regression test; it runs only when a shot directory is set.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture agents you run screenshots");

const WORKSPACE_ID = "agents-you-run-shots";
const REPLY = "Here. I'm reading the trip notes now.";
const command = `node "${resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs").replaceAll('"', '\\"')}" report`;
const SETTINGS: DesktopUserSettings = {
  ...DEFAULT_USER_SETTINGS,
  profile: { preferredName: "Sam" },
  agents: {
    default: { name: "Nova", hue: "olive", launch: { command }, changesFiles: true, enabled: true, timeoutMinutes: 1 },
    terminal: { name: "Terminal", hue: "rose", changesFiles: true, enabled: false, timeoutMinutes: 1 },
    scout: { name: "Scout", hue: "teal", changesFiles: true, enabled: false, timeoutMinutes: 1 },
  },
};

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
  await waitForVisibleAnimations(page);
}

async function shoot(page: Page, target: { screenshot(options: { path: string }): Promise<Buffer> }, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

test("@ui-audit agents you run in Settings › Agents and in their chat", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let agent: ChildProcess | null = null;

  try {
    await seedWorkspaceManifest(temp, WORKSPACE_ID);
    await writeFile(join(temp.homeDir, USER_SETTINGS_FILE), `${JSON.stringify(SETTINGS, null, 2)}\n`);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);

    // Terminal connects as itself and waits; Scout isn't connected.
    agent = await startAgentYouRun(page, WORKSPACE_ID, "terminal", REPLY);
    await expect.poll(() => agentsListening(page), { timeout: 30_000 }).toEqual(["terminal"]);

    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("agents")).click();
    const dialog = page.getByTestId(desktopPins.settingsDialog);
    const section = page.getByTestId(settingsSectionPin("agents"));
    const row = (id: string) => section.locator(`[data-testid="agent-row"][data-agent-id="${id}"]`);
    await expect(section.getByTestId("agent-row")).toHaveCount(3);
    await expect(row("terminal").getByTestId("agent-state")).toHaveText("Listening");
    await expect(row("scout").getByTestId("agent-state")).toHaveText("Through MCP");
    await page.mouse.move(0, 0);
    await shoot(page, section, "agents-you-run-a-settings");

    // Add agent with Another agent chosen shows the MCP config it will use.
    await section.getByTestId("agent-add").click();
    const sheet = page.getByTestId("agent-add-sheet");
    // Both themes show the same settled sheet: it has looked for each tool,
    // and its Copy MCP config is ready.
    await expect(sheet.getByLabel(/^Looking for /)).toHaveCount(0);
    await sheet.getByTestId("agent-runs-with-mcp").click();
    await expect(sheet.locator('[data-testid="agent-add-config-copy"]:enabled')).toHaveCount(1);
    await page.mouse.move(0, 0);
    await shoot(page, page, "agents-you-run-b-add");
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);

    // Scout's page: how to connect it, the run that marks its changes, and its menu.
    await row("scout").click();
    const agentPage = section.getByTestId("agent-page");
    await expect(agentPage).toHaveAttribute("data-agent-id", "scout");
    await expect(agentPage.locator('[data-testid="mcp-config-copy"]:enabled')).toHaveCount(1);
    await expect(agentPage.getByTestId("mcp-status")).toHaveAttribute("data-state", "stopped");
    await page.mouse.move(0, 0);
    await shoot(page, dialog, "agents-you-run-c-page");
    await agentPage.getByRole("button", { name: "Scout actions" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Rename"]);
    await shoot(page, dialog, "agents-you-run-c-menu");
    await page.keyboard.press("Escape");

    // Remove asks first. Just after it, the list is back and its toast offers Undo.
    await agentPage.getByRole("button", { name: "Remove Scout…" }).click();
    const confirm = page.getByTestId("remove-agent-dialog");
    await expect(confirm).toContainText("Remove Scout?");
    await page.mouse.move(0, 0);
    await shoot(page, page, "agents-you-run-c-remove");
    await confirm.getByRole("button", { name: "Remove agent" }).click();
    await expect(agentPage).toHaveCount(0);
    await expect(row("scout")).toHaveCount(0);
    const toasts = page.getByTestId("notice-toasts");
    await expect(toasts).toContainText("Removed Scout.");
    const undo = toasts.getByRole("button", { name: "Undo", exact: true });
    await expect(undo).toBeVisible();
    await page.mouse.move(0, 0);
    await shoot(page, page, "agents-you-run-d-removed");
    // The toast fades on its own; still here means the frames caught it.
    await expect(undo).toBeVisible();
    await undo.click();
    await expect(row("scout")).toHaveCount(1);

    // Terminal's reply in its chat, under its name and color.
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(dialog).toHaveCount(0);
    await openAgentChat(page, "terminal", "Terminal");
    await page.getByTestId("chats-lane-composer").fill("Are you there? Can you check the trip notes?");
    await page.getByTestId("chats-lane-composer").press("Enter");
    const reply = page.getByTestId("chats-lane-message").filter({ hasText: REPLY });
    await expect(reply.getByTestId("chats-lane-message-author").locator(".text-hue-rose")).toHaveText("Terminal");
    await expect.poll(() => agent!.exitCode).toBe(0);
    await page.mouse.move(0, 0);
    await shoot(page, page, "agents-you-run-e-reply");
  } finally {
    await stopAgentYouRun(agent);
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
