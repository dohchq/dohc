import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { engineDaemonPids } from "./helpers/daemonKill";
import { launchDesktopApp, within, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { momentTextsForPath } from "./helpers/engineDb";
import { DOCUMENT_END } from "./helpers/keys";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const EDIT = "Saved before the signal.";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The launched app leads its own process group, and on Linux the engine leads
// another. A stop signal, such as Ctrl+C in a terminal, reaches dohc only. dohc
// ends, records no crash, and the engine stops with the edit in its store. The
// next start opens the workspace with the edit and shows no notice.
async function stopsCleanlyOn(
  send: (pids: { group: number; main: number }) => void,
  { finishesQuit }: { finishesQuit: boolean },
): Promise<void> {
  const temp = await createTempWorkspace();
  let stopped: LaunchedDesktopApp | null = null;
  let reopened: LaunchedDesktopApp | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: "stop.md", contents: "# Stop\n\nBefore the signal.\n" }]);
    stopped = await launchDesktopApp({ workspace: temp });
    const { page, app, logs } = stopped;
    const child = app.process();
    const pid = child.pid;
    if (pid === undefined) throw new Error("Electron app has no pid.");
    const opened = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, opened.workspaceId, "stop.md");
    await explorerRow(page, "stop.md").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toContainText("Before the signal.");
    await editor.click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type(` ${EDIT}`);
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
    await expect.poll(() => readFile(join(temp.rootPath, "stop.md"), "utf8")).toContain(EDIT);
    const engines = await engineDaemonPids(pid);
    expect(engines).not.toHaveLength(0);

    // The launched process leads dohc's group. Electron's main process is named by its own pid.
    const main = await app.evaluate(() => process.pid);
    const outputEnded = new Promise<true>((resolve) => child.once("close", () => resolve(true)));
    send({ group: pid, main });
    expect(await within(outputEnded, 60_000), "dohc ends on the signal").toBe(true);
    const report = await readFile(join(temp.homeDir, "crash-report.json"), "utf8").catch(() => null);
    expect(report, "The stop records no crash").toBeNull();
    if (finishesQuit) {
      const quitLine = logs.find((entry) => entry.source === "main" && entry.text.includes("[desktop] quit: shutdown"));
      expect(quitLine?.text.trim() ?? "no quit line", "The quit finishes within its budget")
        .toMatch(/^\[desktop\] quit: shutdown finished in \d+ ms$/u);
      expect(engines.filter(isRunning), "The quit stops the engine").toEqual([]);
    } else {
      // Electron ends dohc before its quit finishes (#3411). The engine then
      // stops on its own once its input closes.
      await expect.poll(() => engines.filter(isRunning), { message: "The engine stops", timeout: 30_000 })
        .toEqual([]);
    }
    // The file alone would pass the editor check below: dohc imports a file that
    // differs from its store as an outside edit.
    const stored = momentTextsForPath(temp.rootPath, "stop.md");
    expect(stored.some((text) => text.includes(EDIT)), "The store keeps the saved edit").toBe(true);

    reopened = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(reopened.page, temp);
    await waitForWorkspaceFile(reopened.page, opened.workspaceId, "stop.md");
    await explorerRow(reopened.page, "stop.md").click();
    await expect(reopened.page.getByTestId("markdown-editor"), "The next start shows the saved edit")
      .toContainText(EDIT);
    // At start, dohc raises a notice for a crash report or for typing kept in
    // History. Both reads here must find nothing for those notices to show.
    const startup = await reopened.page.evaluate(async (workspaceId) => {
      const api = window.dohcDesktop!;
      const [crash, kept] = await Promise.all([api.readCrashReport({}), api.getCaptureRecoveryStatus({ workspaceId })]);
      return { crash: crash.report, kept: kept.captureRecoveries };
    }, opened.workspaceId);
    expect(startup, "The next start finds no crash and no kept typing").toEqual({ crash: null, kept: [] });
    await expect(reopened.page.locator('[data-testid="notice-toasts"] > *'), "The next start shows no notice")
      .toHaveCount(0);
    await expect(reopened.page.getByTestId("notice-center-toggle"), "Notices has no unread row")
      .toHaveAttribute("aria-label", "Notices");
  } finally {
    // Closing the first app attaches its logs, and stops it if the test failed
    // before the signal.
    await stopped?.close().catch((error: unknown) => console.error("[stop-signal] closing the stopped app:", error));
    await cleanupDesktopWorkspace(reopened, temp);
  }
}

test.describe("stop signals", () => {
  test.skip(process.platform !== "linux", "The engine leads its own process group on Linux only.");

  // A SIGTERM or SIGHUP sent to the group also reaches Electron's GPU process,
  // and Electron then ends dohc before its quit finishes (#3411).
  const groupStops = [
    { signal: "SIGTERM", verb: "ends", finishesQuit: false },
    { signal: "SIGINT", verb: "quits", finishesQuit: true },
    { signal: "SIGHUP", verb: "ends", finishesQuit: false },
  ] as const;
  for (const { signal, verb, finishesQuit } of groupStops) {
    test(`${signal} sent to dohc's process group ${verb} dohc and keeps the saved work`, async () => {
      test.setTimeout(180_000);
      await stopsCleanlyOn(({ group }) => process.kill(-group, signal), { finishesQuit });
    });
  }

  test("SIGTERM sent to dohc alone quits dohc, stops the engine and keeps the saved work", async () => {
    test.setTimeout(180_000);
    await stopsCleanlyOn(({ main }) => process.kill(main, "SIGTERM"), { finishesQuit: true });
  });
});
