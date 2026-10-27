import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin, editorTabTestId, settingsNavPin } from "../src/testPins";
import { engineDaemonPids, hardKillPid, waitForFreshEngineDaemon } from "./helpers/daemonKill";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { engineMomentsOrEmpty, replicationOpKindsMentioning, outsideCopyPushed, outsideWriteRecoveryState, ownerEnrollment, ownerOutboxDeclarations, ownerSettlementState } from "./helpers/engineDb";
import { readHistoryMoments } from "./helpers/history";
import { DOCUMENT_END } from "./helpers/keys";
import { approveDesktop, createVerifiedAccount, openDesktopApproval, startSelfHostOnboardingStack, trustFixtureCa } from "./helpers/selfHostOnboarding";
import { createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, waitForWorkspaceFile, writeWorkspaceFiles } from "./helpers/workspace";

type Api = DohcDesktopBridge;
const SEED = "# Owner's live note\n\nBase text.\n";
const editor = (page: Page) => page.getByTestId("markdown-editor");

for (const variant of ["closed", "open-reload", "restart"] as const) {
  const PATH = variant === "open-reload" ? "Research notes for the autumn workspace continuity review and outside editing follow-up.md" : "n.md";
  test(`keeps an outside write before restoring the owner's live note: ${variant} @outside-write-live-note`, async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    const temp = await createTempWorkspace();
    let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
    let trust: ReturnType<typeof trustFixtureCa> | undefined;
    let context: BrowserContext | undefined;
    let desktop: LaunchedDesktopApp | undefined;
    let workspaceId = "";
    const records: Array<{ step: string; at: string; observation: unknown }> = [];
    const record = async (step: string, observation: unknown) => {
      const row = { step, at: new Date().toISOString(), observation };
      records.push(row);
      await testInfo.attach(`step ${step}`, { contentType: "application/json", body: JSON.stringify(row, null, 2) });
      await writeFile(testInfo.outputPath("observations.json"), JSON.stringify({ variant, repeat: testInfo.repeatEachIndex, records }, null, 2) + "\n");
    };
    const read = async <T>(promise: Promise<T>) => promise.catch((cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) }));
    const snapshot = async () => {
      const page = desktop!.page;
      const history = await readHistoryMoments(page, workspaceId);
      // Unavailable history is a step's observation. engineMoments reads the store either way.
      const details = history === null ? [] : await page.evaluate(async ({ workspaceId, ids }) => {
        const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
        return Promise.all(ids.map(momentId => api.readEngineMoment({ workspaceId, momentId })));
      }, { workspaceId, ids: (history ?? []).map(row => row.id) });
      const siblings = await Promise.all((await readdir(temp.rootPath)).filter(name => name !== ".dohc").map(async name => {
        const path = join(temp.rootPath, name);
        return { name, ...((await stat(path)).isFile() ? { text: await readFile(path, "utf8") } : { directory: true }) };
      }));
      const toggle = page.getByTestId("notice-center-toggle");
      if (await toggle.count() && !await page.getByTestId("notice-center").count()) await toggle.click();
      const notices = await page.getByTestId("notice-center").allInnerTexts();
      if (await page.getByTestId("notice-center").count()) await toggle.click();
      return {
        disk: await readFile(join(temp.rootPath, PATH), "utf8"), siblings,
        historyAvailable: history !== null, historyRows: history ?? [], historyDetails: details, engineMoments: engineMomentsOrEmpty(temp.rootPath),
        recovery: outsideWriteRecoveryState(temp.rootPath, workspaceId),
        keptCopies: await read(page.evaluate(workspaceId => (window as unknown as { dohcDesktop: Api }).dohcDesktop.listKeptCopies({ workspaceId }), workspaceId)),
        notices, noticeRows: await read(page.evaluate(() => (window as unknown as { dohcDesktop: Api }).dohcDesktop.listNotices({}))),
        toasts: await page.getByTestId("notice-toasts").allInnerTexts(),
        saveState: await page.getByTestId("markdown-save-state").evaluateAll(nodes => nodes.map(node => ({ state: node.getAttribute("data-state"), text: node.textContent }))),
        editor: await editor(page).allInnerTexts(), banner: await page.getByTestId("changed-outside-notice").allInnerTexts(),
        outbox: ownerOutboxDeclarations(temp.rootPath), settlement: ownerSettlementState(temp.rootPath),
        sync: await read(page.evaluate(workspaceId => (window as unknown as { dohcDesktop: Api }).dohcDesktop.getSyncStatus({ workspaceId }), workspaceId)),
        outage: stack!.outageState(),
      };
    };
    try {
      stack = await startSelfHostOnboardingStack(temp.baseDir, { live: true, signal: AbortSignal.timeout(testInfo.timeout - 10_000) });
      trust = trustFixtureCa(stack.ca!.ca);
      context = await browser.newContext();
      await trust.route(context, stack.relayUrl);
      const accountPage = await context.newPage();
      const ownerAccount = { email: `owner-${randomUUID()}@example.test`, password: `Owner-${randomUUID()}`, name: "Owner" };
      const otherAccount = { email: `owner-note-${randomUUID()}@example.test`, password: `Owner-${randomUUID()}`, name: "Owner note" };
      // The share recipient signs up in its own browser, so the owner's approval page starts signed out.
      const otherBrowser = await browser.newContext();
      try {
        await trust.route(otherBrowser, stack.relayUrl);
        await createVerifiedAccount(await otherBrowser.newPage(), stack.account, otherAccount);
      } finally {
        await otherBrowser.close();
      }
      await writeWorkspaceFiles(temp, [{ path: PATH, contents: SEED }]);
      desktop = await launchDesktopApp({ workspace: temp, env: stack.trustEnv });
      const page = desktop.page;
      workspaceId = (await openWorkspaceFromFirstRun(page, temp)).workspaceId;
      await page.getByTestId(activityPin("settings")).click();
      await page.getByTestId(settingsNavPin("cloud")).click();
      await page.getByTestId("settings-cloud-connect").click();
      await expect(page.getByTestId("cloud-sync-panel")).toBeVisible();
      const approval = await openDesktopApproval(desktop, accountPage, stack.relayUrl);
      await createVerifiedAccount(accountPage, stack.account, ownerAccount, approval);
      await approveDesktop(accountPage, ownerAccount);
      await expect(page.getByTestId("settings-row-account")).toContainText(ownerAccount.email);
      await page.getByRole("switch", { name: "Sync this workspace" }).click();
      await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
      await page.keyboard.press("Escape");
      await waitForWorkspaceFile(page, workspaceId, PATH);
      // The server hosts a note live only after its owner has opened it once in dohc.
      const openNote = async () => {
        const explorer = page.getByTestId(activityPin("explorer"));
        if ((await explorer.getAttribute("aria-current")) !== "page") await explorer.click();
        await explorerRow(page, PATH).click();
        await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 30_000 });
        await expect(editor(page)).toBeVisible();
      };
      await openNote();
      await page.evaluate(({ workspaceId, recipientEmail, path }) => (window as unknown as { dohcDesktop: Api }).dohcDesktop.createRelayShare({ workspaceId, recipientEmail, paths: [path], access: "edit" }), { workspaceId, recipientEmail: otherAccount.email, path: PATH });
      await expect.poll(async () => {
        const live = await page.evaluate(workspaceId => (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({ workspaceId }), workspaceId);
        const expected = stack!.ownerLiveBinding(workspaceId, PATH);
        const actual = expected && ownerEnrollment(temp.rootPath, expected.binding);
        return live.documents.find(document => document.path === PATH)?.status === "ready" && actual !== null && actual !== undefined;
      }, { timeout: 120_000, intervals: [1_000] }).toBe(true);
      await record("1", { enrollment: ownerEnrollment(temp.rootPath, stack.ownerLiveBinding(workspaceId, PATH)!.binding), ...await snapshot() });

      stack.pause();
      await openNote();
      await editor(page).click();
      await page.keyboard.press(DOCUMENT_END);
      await page.keyboard.type(" OWNER-1");
      await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "pending-share", { timeout: 60_000 });
      await expect.poll(() => {
        const state = ownerOutboxDeclarations(temp.rootPath);
        return state && "pending" in state ? state.pending : 0;
      }).toBeGreaterThan(0);
      await record("2-typed", await snapshot());
      if (variant !== "open-reload") {
        const tab = page.getByTestId(editorTabTestId(PATH));
        await tab.hover();
        await tab.getByRole("button", { name: /^Close / }).click();
        await expect(tab).toHaveCount(0);
      }
      await record("2", await snapshot());
      await writeFile(join(temp.rootPath, PATH), "AGENT-1\n");
      expect(await readFile(join(temp.rootPath, PATH), "utf8")).toBe("AGENT-1\n");
      await record("3", await snapshot());

      let reload: unknown = null;
      if (variant === "open-reload") {
        await expect(page.getByTestId("changed-outside-notice")).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId("changed-outside-notice")).toContainText("This file changed outside dohc.");
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
          await page.screenshot({ path: testInfo.outputPath(`banner-${theme}.png`) });
        }
        await record("4-before-reload", await snapshot());
        await page.getByTestId("changed-outside-notice").getByRole("button", { name: "Reload" }).click();
        await expect.poll(async () => {
          const opened = (await editor(page).allInnerTexts()).some(text => text.includes("AGENT-1"));
          const waiting = (await page.getByTestId("notice-toasts").innerText()).includes("History has not recorded it yet");
          return opened || waiting;
        }, { timeout: 75_000, intervals: [1_000] }).toBe(true);
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
          await page.screenshot({ path: testInfo.outputPath(`reload-wait-${theme}.png`) });
        }
        reload = { attempted: true };
      } else {
        try {
          await expect.poll(async () => {
            await page.getByTestId("notice-center-toggle").click();
            const seen = await page.getByTestId("notice-history-capture-failed").count();
            await page.getByTestId("notice-center-toggle").click();
            return seen;
          }, { timeout: 45_000, intervals: [1_000] }).toBe(1);
        } catch (error) { await record("4-history-wait", { result: String(error) }); }
      }
      await record("4", { reload, ...await snapshot() });
      if (variant === "restart") {
        const appPid = await desktop.app.evaluate(() => process.pid);
        const oldPids = await engineDaemonPids(appPid);
        expect(oldPids.length).toBeGreaterThan(0);
        for (const pid of oldPids) await hardKillPid(pid);
        // A workspace request drives reconnection; a new PID alone is not readiness.
        await expect(async () => {
          const status = await page.evaluate(workspaceId => (window as unknown as { dohcDesktop: Api }).dohcDesktop.listWorkspaceFiles({ workspaceId }), workspaceId);
          expect(status).toBeTruthy();
        }).toPass({ timeout: 60_000 });
        const freshPid = await waitForFreshEngineDaemon(appPid, oldPids, 60_000);
        try {
          await expect.poll(() => readHistoryMoments(page, workspaceId), { timeout: 60_000 }).not.toBeNull();
        } catch (error) { await record("4-restart-history-wait", { result: String(error) }); }
        await record("4-restart", { appPid, oldPids, freshPid, capturePath: "Not observed: public watcher status does not expose Added versus Changed.", ...await snapshot() });
      }
      const before = outsideWriteRecoveryState(temp.rootPath, workspaceId);
      const recordsPath = join(temp.rootPath, ".dohc/local/outside-write-copies");
      if (variant === "open-reload") {
        await mkdir(recordsPath, { recursive: true });
        expect(await readdir(recordsPath)).toEqual([]);
        await rmdir(recordsPath);
        await writeFile(recordsPath, "copy records blocked for recovery test");
      }
      stack.resume();
      if (variant === "open-reload") {
        if (!await page.getByTestId("notice-center").count()) await page.getByTestId("notice-center-toggle").click();
        const failureRow = page.locator("[data-notice-row]").filter({ hasText: `dohc could not keep a copy of ${PATH}` });
        await expect(failureRow).toBeVisible({ timeout: 120_000 });
        const failureBody = `dohc could not keep a copy of ${PATH}, because .dohc/local/outside-write-copies is in the way, so it left ${PATH} as it was. Move .dohc/local/outside-write-copies somewhere else, then choose Try again. Sync waits until then.`;
        await expect(failureRow).toContainText(failureBody);
        await expect(failureRow).not.toContainText("Check that dohc can write to the workspace folder");
        const listFailureRow = page.locator("[data-notice-row]").filter({ hasText: "dohc could not list every kept copy" });
        await expect(listFailureRow).toBeVisible();
        await expect(listFailureRow).toContainText("To find a copy that isn't listed, look beside its file for (kept copy) in the name.");
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
          await page.screenshot({ path: testInfo.outputPath(`copy-failure-${theme}.png`) });
        }
        await record("4-copy-failed", { recordsPath, ...await snapshot() });
        await unlink(recordsPath);
        if (!await page.getByTestId("notice-center").count()) await page.getByTestId("notice-center-toggle").click();
        await failureRow.getByRole("button", { name: "Try again", exact: true }).click();
        // Try again closes Notices, which would hide a row that stays.
        await expect(page.getByTestId("notice-center")).toHaveCount(0);
        await page.getByTestId("notice-center-toggle").click();
        await expect(failureRow).toHaveCount(0, { timeout: 120_000 });
        await expect(listFailureRow).toHaveCount(0, { timeout: 120_000 });
        if (await page.getByTestId("notice-center").count()) await page.getByTestId("notice-center-toggle").click();
      }
      await expect.poll(() => {
        const state = ownerOutboxDeclarations(temp.rootPath);
        return state && "pending" in state ? state.pending : -1;
      }, { timeout: 120_000, intervals: [1_000] }).toBe(0);
      await expect.poll(() => {
        const state = ownerSettlementState(temp.rootPath);
        const recovery = outsideWriteRecoveryState(temp.rootPath, workspaceId);
        // A settlement must cover the accepted OWNER-1 edit; an earlier one doesn't.
        return state !== null && state.acceptedCursor > 0 && state.settlementRecords.some(row => row.terminalCursor >= state.acceptedCursor)
          && state.settlementRecords.every(row => row.momentHere) && state.parked === 0 && state.deferred === 0
          && recovery !== null && JSON.stringify(recovery.pull) !== JSON.stringify(before?.pull);
      }, { timeout: 120_000, intervals: [1_000] }).toBe(true);
      await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", { timeout: 120_000 });
      await record("5", await snapshot());
      const copies = async () => {
        const status = await page.evaluate(workspaceId => (window as unknown as { dohcDesktop: Api }).dohcDesktop.getSyncStatus({ workspaceId }), workspaceId);
        return status.outsideWriteCopies?.filter(([path]) => path === PATH) ?? [];
      };
      await expect.poll(async () => (await copies()).length, { timeout: 60_000 }).toBe(1);
      const copyPath = (await copies())[0]![1];
      const keptFiles = async (directory: string): Promise<string[]> => {
        const entries = await readdir(directory, { withFileTypes: true });
        return (await Promise.all(entries.map(async entry => {
          const path = join(directory, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) return keptFiles(path);
          return entry.name.includes("(kept copy") ? [path] : [];
        }))).flat();
      };
      expect(await keptFiles(temp.rootPath)).toEqual([join(temp.rootPath, copyPath)]);
      await expect.poll(() => engineMomentsOrEmpty(temp.rootPath).some(moment => moment.path === copyPath && moment.text === "AGENT-1\n"), { timeout: 60_000 }).toBe(true);
      expect(engineMomentsOrEmpty(temp.rootPath).filter(moment => moment.path === PATH).some(moment => moment.text.includes("AGENT-1"))).toBe(false);
      await expect.poll(() => replicationOpKindsMentioning(temp.rootPath, copyPath), { timeout: 60_000 }).toContain("moment.append");
      await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", { timeout: 120_000 });
      await expect.poll(() => outsideCopyPushed(temp.rootPath, workspaceId, copyPath), { timeout: 120_000 }).toBe(true);
      expect(await readFile(join(temp.rootPath, copyPath), "utf8")).toBe("AGENT-1\n");
      await expect.poll(() => readFile(join(temp.rootPath, PATH), "utf8"), { timeout: 60_000 }).toContain("OWNER-1");
      expect(await readFile(join(temp.rootPath, PATH), "utf8")).not.toContain("AGENT-1");
      const toast = page.getByTestId("workspace-shell-notice").filter({ hasText: `Kept a copy of ${PATH}` }).filter({ hasText: copyPath });
      await expect(toast).toBeVisible();
      await expect(toast.getByRole("button", { name: "Open copy", exact: true })).toBeVisible();
      await expect(toast).not.toContainText("History");
      if (variant === "open-reload") {
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
          await page.screenshot({ path: testInfo.outputPath(`reload-kept-copy-${theme}.png`) });
        }
      }
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
        await page.screenshot({ path: testInfo.outputPath(`toast-${theme}.png`) });
      }
      await page.getByTestId("notice-center-toggle").click();
      const row = page.locator("[data-notice-row]").filter({ hasText: `Kept a copy of ${PATH}` }).filter({ hasText: copyPath });
      await expect(row).toBeVisible();
      expect(await page.getByTestId("notice-center").evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(480);
      await expect(row.getByRole("button", { name: "Open copy", exact: true })).toBeVisible();
      await expect(row).not.toContainText("History");
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
        await page.screenshot({ path: testInfo.outputPath(`notices-${theme}.png`) });
      }
      await row.getByRole("button", { name: "Open copy", exact: true }).click();
      await expect(editor(page)).toContainText("AGENT-1");
      await expect(row).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("dohc keeps your text in History");
      if (await page.getByTestId("notice-center").count()) await page.getByTestId("notice-center-toggle").click();
      const final = await snapshot();
      expect(final.disk).toContain("OWNER-1");
      expect(final.disk).not.toContain("AGENT-1");
      expect(await readFile(join(temp.rootPath, copyPath), "utf8")).toBe("AGENT-1\n");
      await record("6", { ...final, copyPath, copyReplicationKinds: replicationOpKindsMentioning(temp.rootPath, copyPath), copyPushed: outsideCopyPushed(temp.rootPath, workspaceId, copyPath), outsideTextKept: true, ownerOnDisk: true });
    } catch (error) {
      await record("failure", { error: error instanceof Error ? error.stack : String(error),
        settlementEvidence: await read(Promise.resolve().then(() => stack?.settlementEvidence())),
        relayOutput: await read(Promise.resolve().then(() => stack?.relayOutput())) });
      if (desktop && workspaceId) await read(snapshot().then(value => record("failure-state", value)));
      throw error;
    } finally {
      await testInfo.attach("observations", { contentType: "application/json", body: JSON.stringify({ variant, repeat: testInfo.repeatEachIndex, records }, null, 2) });
      const cleanup = await Promise.allSettled([desktop?.close(), context?.close()]);
      trust?.restore();
      cleanup.push(...await Promise.allSettled([stack?.close()]));
      cleanup.push(...await Promise.allSettled([temp.cleanup()]));
      const failures = cleanup.filter(row => row.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(row => row.reason), "Owner's live note regression cleanup failed.");
    }
  });
}
