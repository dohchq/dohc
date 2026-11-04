import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { openMyAgent } from "./helpers/agentTools";
import { engineDaemonPids, hardKillAppTree, hardKillPid } from "./helpers/daemonKill";
import { desktopRoot, launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  trustOpenWorkspace,
  type TempWorkspace,
} from "./helpers/workspace";

// Everything an agent run starts ends with the run: when the agent exits, and
// when dohc is killed outright, as a crash or `taskkill /F` without /T kills it.
test.skip(process.platform !== "win32", "Windows only for now");

const fakeRunner = resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The runner's parent, the runner, and the process it started.
async function runTree(path: string): Promise<number[] | null> {
  try {
    const { parent, runner, child } = JSON.parse(await readFile(path, "utf8")) as Record<string, number>;
    return [parent!, runner!, child!];
  } catch {
    return null;
  }
}

// The npm -g layout starts the agent from a .cmd shim through cmd.exe. A direct
// launch starts the agent's own program.
async function seedAgent(temp: TempWorkspace, mode: "hold-tree" | "leave-tree", launch: "npm shim" | "direct"): Promise<string> {
  const pids = join(temp.baseDir, "run-tree.json");
  const direct = `"${process.execPath}" "${fakeRunner}" ${mode} "${pids}"`;
  let command = direct;
  if (launch === "npm shim") {
    const shim = join(temp.baseDir, "agent.cmd");
    await writeFile(shim, `@echo off\r\n${direct}\r\n`);
    command = `"${shim}"`;
  }
  const settings: DesktopUserSettings = {
    ...DEFAULT_USER_SETTINGS,
    profile: { preferredName: "Sam" },
    agents: {
      default: { name: "Nova", hue: "olive", launch: { command }, changesFiles: true, enabled: true, timeoutMinutes: 5 },
    },
  };
  await writeFile(join(temp.homeDir, USER_SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
  return pids;
}

async function startRun(temp: TempWorkspace, pids: string): Promise<{ desktop: LaunchedDesktopApp; tree: number[] }> {
  const desktop = await launchDesktopApp({ workspace: temp });
  await openWorkspaceFromFirstRun(desktop.page, temp);
  await trustOpenWorkspace(desktop);
  await openMyAgent(desktop.page);
  await desktop.page.getByTestId("chats-lane-composer").fill("keep working");
  await desktop.page.getByTestId("chats-lane-composer").press("Enter");
  await expect.poll(() => runTree(pids), { timeout: 30_000 }).not.toBeNull();
  return { desktop, tree: (await runTree(pids))! };
}

for (const launch of ["npm shim", "direct"] as const) {
  test(`killing dohc outright ends the whole run (${launch})`, async () => {
    const temp = await createTempWorkspace();
    let desktop: LaunchedDesktopApp | null = null;
    let tree: number[] = [];
    let engines: number[] = [];
    try {
      await seedWorkspaceManifest(temp, `agent-run-tree-${launch === "direct" ? "direct" : "shim"}`);
      const pids = await seedAgent(temp, "hold-tree", launch);
      ({ desktop, tree } = await startRun(temp, pids));
      expect(tree.filter(alive)).toEqual(tree);

      // dohc's main process, not Playwright's launcher, and without /T.
      const launcher = desktop.app.process().pid!;
      engines = await engineDaemonPids(launcher);
      const mainPid = await desktop.app.evaluate(() => process.pid);
      await hardKillPid(mainPid);
      await expect.poll(() => tree.filter(alive), { timeout: 15_000 }).toEqual([]);
    } finally {
      // The kill leaves these outside the launcher's tree, and a failed check
      // leaves the run's processes too.
      for (const pid of [...tree, ...engines].filter(alive)) await hardKillPid(pid);
      if (desktop) {
        await hardKillAppTree(desktop.app.process().pid!);
        await desktop.close().catch(() => undefined);
      }
      await cleanupDesktopWorkspace(null, temp);
    }
  });
}

test("an agent that exits ends what it left running", async () => {
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  let tree: number[] = [];
  try {
    await seedWorkspaceManifest(temp, "agent-run-tree-exit");
    const pids = await seedAgent(temp, "leave-tree", "npm shim");
    ({ desktop, tree } = await startRun(temp, pids));
    await expect.poll(() => tree.filter(alive), { timeout: 15_000 }).toEqual([]);
  } finally {
    for (const pid of tree.filter(alive)) await hardKillPid(pid);
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
