import { test, expect, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { agentsListening, openAgentChat, openMyAgent, startAgentYouRun, stopAgentYouRun } from "./helpers/agentTools";
import { hardKillPid } from "./helpers/daemonKill";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  trustOpenWorkspace,
} from "./helpers/workspace";

// An agent you run connects with --agent-id and waits for its messages. While
// dohc runs another agent, it gets a message in its own chat and replies
// under its own name and color.
const fakeRunner = resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs");
const WORKSPACE_ID = "agents-you-run-e2e";
const REPLY = "Here. Looking at it now.";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The fake runner's pid, once the run is working.
async function runnerPid(path: string): Promise<number | null> {
  try {
    return (JSON.parse(await readFile(path, "utf8")) as { runner: number }).runner;
  } catch {
    return null;
  }
}

async function runActive(page: Page): Promise<boolean> {
  const state = await page.evaluate((workspaceId) => (window as unknown as {
    dohcDesktop: { readAgentRunState(payload: { workspaceId: string }): Promise<{ active: boolean }> };
  }).dohcDesktop.readAgentRunState({ workspaceId }), WORKSPACE_ID);
  return state.active;
}

test("an agent you run gets a message in its chat and replies as itself while a run works", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let agent: ChildProcess | null = null;
  let runner: number | null = null;
  try {
    await seedWorkspaceManifest(temp, WORKSPACE_ID);
    const pids = join(temp.baseDir, "run.json");
    const settings: DesktopUserSettings = {
      ...DEFAULT_USER_SETTINGS,
      profile: { preferredName: "Sam" },
      agents: {
        default: {
          name: "Nova", hue: "olive", launch: { command: `"${process.execPath}" "${fakeRunner}" hold "${pids}"` },
          changesFiles: true, enabled: true, timeoutMinutes: 5,
        },
        terminal: { name: "Terminal", hue: "rose", changesFiles: true, enabled: false, timeoutMinutes: 1 },
      },
    };
    await writeFile(join(temp.homeDir, USER_SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);

    // Nova's run starts and keeps working.
    await openMyAgent(page);
    await page.getByTestId("chats-lane-composer").fill("keep working");
    await page.getByTestId("chats-lane-composer").press("Enter");
    await expect.poll(() => runnerPid(pids), { timeout: 30_000 }).not.toBeNull();
    runner = await runnerPid(pids);
    await expect.poll(() => runActive(page)).toBe(true);

    // Terminal connects as itself and waits.
    agent = await startAgentYouRun(page, WORKSPACE_ID, "terminal", REPLY);
    await expect.poll(() => agentsListening(page), { timeout: 30_000 }).toEqual(["terminal"]);

    await openAgentChat(page, "terminal", "Terminal");
    // Its chat has no setup to finish: it answers while it's connected.
    await expect(page.getByTestId("chats-agent-problem")).toHaveCount(0);
    await page.getByTestId("chats-lane-composer").fill("are you there?");
    await page.getByTestId("chats-lane-composer").press("Enter");

    const reply = page.getByTestId("chats-lane-message").filter({ hasText: REPLY });
    await expect(reply).toHaveCount(1);
    const author = reply.getByTestId("chats-lane-message-author");
    await expect(author).toHaveAttribute("data-author-kind", "agent");
    await expect(author.locator(".text-hue-rose")).toHaveText("Terminal");

    // Its wait ended with the message, and it left after replying.
    await expect.poll(() => agent!.exitCode).toBe(0);
    // Listening holds for two seconds after the last wait, so a re-wait never flickers.
    await expect.poll(() => agentsListening(page), { timeout: 10_000 }).toEqual([]);
    // Nova's run worked on throughout.
    expect(await runActive(page)).toBe(true);
    expect(alive(runner!)).toBe(true);
  } finally {
    await stopAgentYouRun(agent);
    await cleanupDesktopWorkspace(desktop, temp);
    // Quitting dohc ends the run; this stops whatever a failed check left.
    if (runner !== null && alive(runner)) await hardKillPid(runner);
  }
});
