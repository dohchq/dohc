import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { engineDaemonPids } from "./helpers/daemonKill";
import { launchDesktopApp, within } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
} from "./helpers/workspace";

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
// quits, stops the engine at the end of its quit, and records no crash.
async function quitsCleanlyOn(send: (pids: { group: number; main: number }) => void): Promise<void> {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const { page, app, logs } = desktop;
    const child = app.process();
    const pid = child.pid;
    if (pid === undefined) throw new Error("Electron app has no pid.");
    await openWorkspaceFromFirstRun(page, temp);
    const engines = await engineDaemonPids(pid);
    expect(engines).not.toHaveLength(0);

    // The launched process leads dohc's group. Electron's main process is named by its own pid.
    const main = await app.evaluate(() => process.pid);
    const outputEnded = new Promise<true>((resolve) => child.once("close", () => resolve(true)));
    send({ group: pid, main });
    expect(await within(outputEnded, 60_000), "dohc quits on the signal").toBe(true);
    const report = await readFile(join(temp.homeDir, "crash-report.json"), "utf8").catch(() => null);
    expect(report, "The stop records no crash").toBeNull();
    const quitLine = logs.find((entry) => entry.source === "main" && entry.text.includes("[desktop] quit: shutdown"));
    expect(quitLine?.text.trim() ?? "no quit line", "The quit finishes within its budget")
      .toMatch(/^\[desktop\] quit: shutdown finished in \d+ ms$/u);
    expect(engines.filter(isRunning), "The quit stops the engine").toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
}

test.describe("stop signals", () => {
  test.skip(process.platform !== "linux", "The engine leads its own process group on Linux only.");

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    test(`${signal} sent to dohc's process group quits dohc and records no engine crash`, async () => {
      test.setTimeout(120_000);
      await quitsCleanlyOn(({ group }) => process.kill(-group, signal));
    });
  }

  test("SIGTERM sent to dohc alone quits dohc, stops the engine and records no crash", async () => {
    test.setTimeout(120_000);
    await quitsCleanlyOn(({ main }) => process.kill(main, "SIGTERM"));
  });
});
