import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { engineDaemonPids, hardKillPid, waitForFreshEngineDaemon } from "./helpers/daemonKill";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
} from "./helpers/workspace";

// Decision 11: a crash leaves a notice, and its report leaves this computer
// only when the person clicks Send report and confirms. The report server
// here is a local stand-in that records every request it gets.
test("an engine crash leaves a notice and sends its report only after the person confirms", async () => {
  test.setTimeout(120_000);
  const received: { method: string | undefined; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      received.push({ method: request.method, body });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({
      workspace: temp,
      env: { DOHC_CRASH_REPORT_URL: `http://127.0.0.1:${port}/crash-reports` },
    });
    const { page, app } = desktop;
    const appPid = app.process().pid;
    if (appPid === undefined) throw new Error("Electron app has no pid.");
    await openWorkspaceFromFirstRun(page, temp);

    // The engine ends the way a crash ends it: no graceful exit.
    const victims = await engineDaemonPids(appPid);
    expect(victims.length).toBeGreaterThan(0);
    for (const pid of victims) await hardKillPid(pid);
    await waitForFreshEngineDaemon(appPid, victims);

    const toast = page.getByTestId("crash-report-toast");
    await expect(toast).toContainText("The workspace engine failed");
    expect(received).toEqual([]);

    // Send report shows the whole report first. Reading it sends nothing.
    await page.getByTestId("crash-report-toast-send").click();
    const shown = await page.getByTestId("crash-report-send-text").textContent();
    expect(shown).toContain("Process: workspace engine");
    expect(received).toEqual([]);

    await page.getByTestId("crash-report-send-confirm").click();
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toEqual({ method: "POST", body: shown });
    await expect(toast).toHaveCount(0);
    await expect(page.getByTestId("workspace-shell-notice")).toContainText("Report sent");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
