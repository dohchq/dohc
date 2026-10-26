import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin, editorTabTestId, settingsNavPin } from "../src/testPins";
import { engineDaemonPids, hardKillPid, waitForFreshEngineDaemon } from "./helpers/daemonKill";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { engineMomentsOrEmpty, outsideWriteRecoveryState, ownerEnrollment, ownerOutboxDeclarations, ownerSettlementState } from "./helpers/engineDb";
import { readHistoryMoments } from "./helpers/history";
import { DOCUMENT_END } from "./helpers/keys";
import { approveDesktop, createVerifiedAccount, openDesktopApproval, startSelfHostOnboardingStack, trustFixtureCa } from "./helpers/selfHostOnboarding";
import { createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, waitForWorkspaceFile, writeWorkspaceFiles } from "./helpers/workspace";

type Api = DohcDesktopBridge;
const PATH = "n.md";
const SEED = "# Owner's live note\n\nBase text.\n";
const editor = (page: Page) => page.getByTestId("markdown-editor");

async function nativeStaging(root: string, relative = ".dohc/engine"): Promise<unknown[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const result: unknown[] = [];
  for (const entry of entries) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await nativeStaging(root, path));
    else if (!/^engine\.db(?:-|$)/u.test(entry.name)) {
      const bytes = await readFile(join(root, path));
      result.push({ path, bytes: bytes.length, containsOutsideText: bytes.includes(Buffer.from("AGENT-1")),
        ...(bytes.length < 65_536 ? { text: bytes.toString("utf8") } : {}) });
    }
  }
  return result;
}

for (const variant of ["closed", "open-reload", "restart"] as const) {
  test(`an outside program writes to an owner's live note while the server is away: ${variant} @outside-write-live-note`, async ({ browser }, testInfo) => {
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
        staging: await nativeStaging(temp.rootPath), recovery: outsideWriteRecoveryState(temp.rootPath, workspaceId),
        keptCopies: await read(page.evaluate(workspaceId => (window as unknown as { dohcDesktop: Api }).dohcDesktop.listKeptCopies({ workspaceId }), workspaceId)),
        notices, noticeRows: await read(page.evaluate(() => (window as unknown as { dohcDesktop: Api }).dohcDesktop.listNotices({}))),
        toasts: await page.getByTestId("notice-toasts").allInnerTexts(),
        saveState: await page.getByTestId("markdown-save-state").evaluateAll(nodes => nodes.map(node => ({ state: node.getAttribute("data-state"), text: node.textContent }))),
        editor: await editor(page).allInnerTexts(), banner: await page.getByTestId("changed-outside-notice").allInnerTexts(),
        outbox: ownerOutboxDeclarations(temp.rootPath), settlement: ownerSettlementState(temp.rootPath),
        sync: await read(page.evaluate(workspaceId => (window as unknown as { dohcDesktop: Api }).dohcDesktop.getSyncStatus({ workspaceId }), workspaceId)),
        outage: stack!.outageState(),
        rawCaptureFlushSettled: { observed: false, reason: "The desktop wrapper polls and throws; the raw capture.flush response would be needed." },
        quarantine: { observed: false, reason: "No public per-path reader; native reconciliation diagnostics would be needed." },
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
        await record("4-before-reload", await snapshot());
        await page.getByTestId("changed-outside-notice").getByRole("button", { name: "Reload" }).click();
        try {
          await expect.poll(async () => (await page.getByTestId("notice-toasts").innerText()).includes("History has not recorded it yet"), { timeout: 75_000, intervals: [1_000] }).toBe(true);
          reload = { outsideWriteWaitingError: true };
        } catch (error) { reload = { outsideWriteWaitingError: false, waitResult: String(error) }; }
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
      const beforeSettlement = ownerSettlementState(temp.rootPath);
      stack.resume();
      await expect.poll(() => {
        const state = ownerOutboxDeclarations(temp.rootPath);
        return state && "pending" in state ? state.pending : -1;
      }, { timeout: 120_000, intervals: [1_000] }).toBe(0);
      await expect.poll(() => {
        const state = ownerSettlementState(temp.rootPath);
        const recovery = outsideWriteRecoveryState(temp.rootPath, workspaceId);
        return state !== null && state.settlementRecords.length > (beforeSettlement?.settlementRecords.length ?? 0)
          && state.settlementRecords.every(row => row.momentHere) && state.parked === 0 && state.deferred === 0
          && recovery !== null && JSON.stringify(recovery.pull) !== JSON.stringify(before?.pull);
      }, { timeout: 120_000, intervals: [1_000] }).toBe(true);
      await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", { timeout: 120_000 });
      await record("5", await snapshot());
      const final = await snapshot();
      const outsideHistory = JSON.stringify([final.historyDetails, final.engineMoments]).includes("AGENT-1");
      const copyFiles = final.siblings.filter(row => row.name !== PATH && "text" in row && row.text?.includes("AGENT-1"));
      const outsideNotices = JSON.stringify([final.notices, final.noticeRows, final.toasts]).includes("AGENT-1");
      await record("6", { ...final, worstPath: {
        historyAvailable: final.historyAvailable,
        ownerOnDiskWithoutOutsideText: final.disk.includes("OWNER-1") && !final.disk.includes("AGENT-1"),
        noConflictFile: !final.siblings.some(row => row.name.includes(".conflict")),
        noOutsideHistory: !outsideHistory, noOutsideSiblingCopy: copyFiles.length === 0,
        noOutsideKeptOrStagedCopy: final.recovery !== null && final.recovery.displacements.length === 0 && final.recovery.retained.length === 0 && !JSON.stringify(final.staging).includes('"containsOutsideText":true'),
        noOutsideNotice: !outsideNotices,
      } });
    } catch (error) {
      await record("failure", { error: error instanceof Error ? error.stack : String(error) });
      if (desktop && workspaceId) await read(snapshot().then(value => record("failure-state", value)));
      throw error;
    } finally {
      await testInfo.attach("observations", { contentType: "application/json", body: JSON.stringify({ variant, repeat: testInfo.repeatEachIndex, records }, null, 2) });
      const cleanup = await Promise.allSettled([desktop?.close(), context?.close()]);
      trust?.restore();
      cleanup.push(...await Promise.allSettled([stack?.close()]));
      cleanup.push(...await Promise.allSettled([temp.cleanup()]));
      const failures = cleanup.filter(row => row.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(row => row.reason), "Owner's live note proof cleanup failed.");
    }
  });
}
