import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  engineDaemonPids,
  hardKillPid,
  waitForFreshEngineDaemon,
} from "./helpers/daemonKill";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// AUDIT-KILLREC. The dogfood journey hard-killed the engine daemon
// (`taskkill /F`) three times while the user was typing. Two things broke:
//
//  (a) the FIRST kill surfaced an Electron "A JavaScript error occurred in the
//      main process" dialog (uncaught EPIPE from the capture's console.error
//      failure logger) and the editor went dead afterwards, and
//  (b) text typed just BEFORE a kill was ultimately lost from BOTH the app and
//      the .md on disk.
//
// The daemon dying is an EXPECTED, recoverable event — EngineDaemonLifecycle
// exists precisely to restart it. These specs drive the real app against a real
// daemon and hard-kill the real process, because that is the layer that broke;
// a mocked lifecycle cannot observe a torn transport mid-write.

async function openEngineDoc(page: Page, path: string): Promise<void> {
  // revealExplorerPath is expansion-idempotent: a relaunch restores the tree
  // already expanded, and a blind folder click would collapse it instead.
  await revealExplorerPath(page, path);
  await explorerRow(page, path).click();
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("markdown-editor")).toBeVisible();
}

function mainProcessCrashText(
  logs: ReadonlyArray<{ source: string; level: string; text: string }>,
): string[] {
  return logs
    .filter((entry) => entry.source === "main")
    .map((entry) => entry.text)
    .filter(
      (text) =>
        /Uncaught Exception/i.test(text) ||
        /A JavaScript error occurred in the main process/i.test(text) ||
        /EPIPE/.test(text),
    );
}

test("a hard daemon kill mid-typing keeps the pre-kill text and leaves the editor writable", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const preKill = "KILLREC_PRE_a1b2c3";
  const postKill = "KILLREC_POST_d4e5f6";
  const docPath = "abuse/kill.md";

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: docPath, contents: "# Kill\n\nAnchor paragraph.\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { page, app } = desktop;
    const appPid = app.process().pid;
    if (appPid === undefined) throw new Error("Electron app has no pid.");

    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, docPath);
    await openEngineDoc(page, docPath);

    const editor = page.getByTestId("markdown-editor");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");

    // A first settled edit proves the session is genuinely live before the kill,
    // so a later missing sentinel cannot be blamed on a doc that never worked.
    await page.keyboard.type(" WARMUP_KILLREC");
    await expect
      .poll(
        async () =>
          await readFile(join(temp.rootPath, docPath), "utf8").catch(() => ""),
        { timeout: 20_000 },
      )
      .toContain("WARMUP_KILLREC");

    const victims = await engineDaemonPids(appPid);
    expect(victims.length).toBeGreaterThan(0);

    // Type the must-survive sentinel and kill the daemon immediately — before
    // the debounced settle can project it to disk. This is the only window in
    // which the renderer is the sole holder of the text.
    await page.keyboard.type(` ${preKill}`);
    for (const pid of victims) await hardKillPid(pid);

    // Keep typing through the outage, exactly like the journey's user did.
    await page.keyboard.type(` ${postKill}`);

    const replacement = await waitForFreshEngineDaemon(appPid, victims);
    expect(victims).not.toContain(replacement);

    // (a) The daemon dying must never become a user-facing main-process crash.
    expect(mainProcessCrashText(desktop.logs)).toEqual([]);

    // (a) The editor must still be writable after the restart.
    await page.keyboard.type(" KILLREC_AFTER_RESTART");
    await expect(editor).toContainText("KILLREC_AFTER_RESTART");

    // (b) The pre-kill sentinel must reach disk through the replacement daemon.
    await expect
      .poll(
        async () =>
          await readFile(join(temp.rootPath, docPath), "utf8").catch(() => ""),
        { timeout: 30_000 },
      )
      .toContain(preKill);
    const onDisk = await readFile(join(temp.rootPath, docPath), "utf8");
    expect(onDisk).toContain(postKill);

    // (b) And it must still be there for the NEXT launch — the journey lost the
    // pre-kill token only once the whole app went away.
    await expect(editor).toContainText(preKill);
    await desktop.close();
    desktop = null;

    desktop = await launchDesktopApp({ workspace: temp });
    const relaunched = desktop.page;
    const reopened = await openWorkspaceFromFirstRun(relaunched, temp);
    await waitForWorkspaceFile(relaunched, reopened.workspaceId, docPath);
    await openEngineDoc(relaunched, docPath);
    await expect(relaunched.getByTestId("markdown-editor")).toContainText(
      preKill,
    );
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
