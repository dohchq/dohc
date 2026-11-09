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

    // Main asks in its own dialog. Answer it from main: Cancel first, which
    // sends nothing, then Send report.
    const answerDialog = async (response: number) => await app.evaluate(({ dialog }, answer) => {
      const asked = globalThis as { crashDialogMessages?: string[] };
      asked.crashDialogMessages ??= [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { message: string };
        asked.crashDialogMessages!.push(options.message);
        return { response: answer, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    }, response);
    const report = await page.evaluate(async () => (await window.dohcDesktop!.readCrashReport({})).report);
    expect(report?.text).toContain("Process: workspace engine");

    await answerDialog(2);
    await page.getByTestId("crash-report-toast-send").click();
    const asked = async () =>
      (await app.evaluate(() => (globalThis as { crashDialogMessages?: string[] }).crashDialogMessages))?.length ?? 0;
    await expect.poll(asked).toBe(1);
    await expect(page.getByTestId("crash-report-toast-send")).toBeVisible();
    expect(received).toEqual([]);

    await answerDialog(0);
    await page.getByTestId("crash-report-toast-send").click();
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toEqual({ method: "POST", body: report!.text });
    expect(await app.evaluate(() => (globalThis as { crashDialogMessages?: string[] }).crashDialogMessages))
      .toEqual(Array(2).fill(`Send this crash report to 127.0.0.1:${port}?`));
    await expect(toast).toHaveCount(0);
    await expect(page.getByTestId("workspace-shell-notice")).toContainText("Report sent");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// A crash toasts once. Closing the toast is kept with the report, so the next
// launch shows only its row in Notices, still with Dismiss, Copy and Send.
test("a closed crash toast stays closed after a restart, and its row stays in Notices", async () => {
  test.setTimeout(150_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const { page, app } = desktop;
    const appPid = app.process().pid;
    if (appPid === undefined) throw new Error("Electron app has no pid.");
    await openWorkspaceFromFirstRun(page, temp);

    const victims = await engineDaemonPids(appPid);
    expect(victims.length).toBeGreaterThan(0);
    for (const pid of victims) await hardKillPid(pid);
    await waitForFreshEngineDaemon(appPid, victims);

    const toast = page.getByTestId("crash-report-toast");
    await expect(toast).toContainText("The workspace engine failed");
    await page.getByRole("button", { name: "Close crash report notice" }).click();
    await expect(toast).toHaveCount(0);
    await expect.poll(async () =>
      await page.evaluate(async () => (await window.dohcDesktop!.readCrashReport({})).report?.read)).toBe(true);

    await desktop.close();
    desktop = null;
    desktop = await launchDesktopApp({ workspace: temp });
    const next = desktop.page;
    await openWorkspaceFromFirstRun(next, temp);

    // Once the row shows, this window has the report. Opening Notices focuses
    // the panel, not the row, so an unread report would still show its mark
    // here and its toast after Notices closes.
    await next.getByTestId("notice-center-toggle").click();
    const row = next.getByTestId("notice-crash-report");
    await expect(row).toContainText("The workspace engine failed");
    await expect(next.getByTestId("notice-crash-report-unread")).toHaveCount(0);
    await expect(next.getByTestId("notice-crash-report-dismiss")).toBeVisible();
    await next.getByTestId("notice-center-toggle").click();
    await expect(next.getByTestId("notice-center")).toHaveCount(0);
    await expect(next.getByTestId("crash-report-toast")).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
