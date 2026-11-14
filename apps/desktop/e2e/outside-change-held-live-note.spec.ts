import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin, editorTabTestId, settingsNavPin } from "../src/testPins";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import {
  engineMomentsOrEmpty,
  ownerEnrollment,
  ownerOutboxDeclarations,
  ownerSettlementState,
} from "./helpers/engineDb";
import { DOCUMENT_END } from "./helpers/keys";
import {
  approveDesktop,
  createVerifiedAccount,
  openDesktopApproval,
  startSelfHostOnboardingStack,
  trustFixtureCa,
} from "./helpers/selfHostOnboarding";
import {
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test.skip(
  !process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1",
  "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.",
);

type Api = DohcDesktopBridge;
const PATH = "n.md";
const SEED = "# Owner's live note\n\nBase text.\n";
const OUTSIDE = "AGENT-1\n";
const editor = (page: Page) => page.getByTestId("markdown-editor");

// On the owner's computer a shared note is live through its owner binding.
// An outside write to its file is held: the note and History keep their own
// text, Notices names the change, and Keep a copy saves it beside the note.
// "relay-down" holds while the owner's typing waits for the server;
// "relay-up" is the ordinary day, where dohc's own writes are never held.
for (const variant of ["relay-down", "relay-up"] as const) {
  test(`holds an outside write to the owner's live note until Keep a copy: ${variant} @outside-write-live-note`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(600_000);
    const temp = await createTempWorkspace();
    let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
    let trust: ReturnType<typeof trustFixtureCa> | undefined;
    let context: BrowserContext | undefined;
    let desktop: LaunchedDesktopApp | undefined;
    let workspaceId = "";
    const records: Array<{ step: string; at: string; observation: unknown }> = [];
    const record = async (step: string, observation: unknown) => {
      records.push({ step, at: new Date().toISOString(), observation });
      await writeFile(
        testInfo.outputPath("observations.json"),
        JSON.stringify({ variant, records }, null, 2) + "\n",
      );
    };
    const status = () =>
      desktop!.page.evaluate(
        (workspaceId) =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.getSyncStatus({ workspaceId }),
        workspaceId,
      );
    const held = async () => (await status()).outsideChanges?.map((change) => change.path) ?? [];
    const disk = () => readFile(join(temp.rootPath, PATH), "utf8");
    const keptCopies = async (): Promise<string[]> =>
      (await readdir(temp.rootPath)).filter((name) => name.includes("(kept copy"));
    const openNotices = async (page: Page) => {
      if (!(await page.getByTestId("notice-center").count()))
        await page.getByTestId("notice-center-toggle").click();
    };
    const closeNotices = async (page: Page) => {
      if (await page.getByTestId("notice-center").count())
        await page.getByTestId("notice-center-toggle").click();
    };
    const heldRow = (page: Page) =>
      page.locator("[data-notice-row]").filter({ hasText: `Not in the live note: ${PATH}` });
    const pending = () => {
      const state = ownerOutboxDeclarations(temp.rootPath);
      return state && "pending" in state ? state.pending : -1;
    };
    const settledThroughAccepted = () => {
      const state = ownerSettlementState(temp.rootPath);
      return (
        state !== null &&
        state.acceptedCursor > 0 &&
        state.settlementRecords.some((row) => row.terminalCursor >= state.acceptedCursor) &&
        state.settlementRecords.every((row) => row.momentHere) &&
        state.parked === 0 &&
        state.deferred === 0
      );
    };
    try {
      stack = await startSelfHostOnboardingStack(temp.baseDir, {
        live: true,
        signal: AbortSignal.timeout(testInfo.timeout - 10_000),
      });
      trust = trustFixtureCa(stack.ca!.ca);
      context = await browser.newContext();
      await trust.route(context, stack.relayUrl);
      const accountPage = await context.newPage();
      const ownerAccount = {
        email: `owner-${randomUUID()}@example.test`,
        password: `Owner-${randomUUID()}`,
        name: "Owner",
      };
      const otherAccount = {
        email: `owner-note-${randomUUID()}@example.test`,
        password: `Owner-${randomUUID()}`,
        name: "Owner note",
      };
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
      const openNote = async () => {
        const explorer = page.getByTestId(activityPin("explorer"));
        if ((await explorer.getAttribute("aria-current")) !== "page") await explorer.click();
        await explorerRow(page, PATH).click();
        await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 30_000 });
        await expect(editor(page)).toBeVisible();
      };
      await openNote();
      await page.evaluate(
        ({ workspaceId, recipientEmail, path }) =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.createRelayShare({
            workspaceId,
            recipientEmail,
            paths: [path],
            access: "edit",
          }),
        { workspaceId, recipientEmail: otherAccount.email, path: PATH },
      );
      await expect
        .poll(
          async () => {
            const live = await page.evaluate(
              (workspaceId) =>
                (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({
                  workspaceId,
                }),
              workspaceId,
            );
            const expected = stack!.ownerLiveBinding(workspaceId, PATH);
            const actual = expected && ownerEnrollment(temp.rootPath, expected.binding);
            return (
              live.documents.find((document) => document.path === PATH)?.status === "ready" &&
              actual !== null &&
              actual !== undefined
            );
          },
          { timeout: 120_000, intervals: [1_000] },
        )
        .toBe(true);

      if (variant === "relay-down") stack.pause();
      await openNote();
      await editor(page).click();
      await page.keyboard.press(DOCUMENT_END);
      await page.keyboard.type(" OWNER-1");
      if (variant === "relay-down") {
        await expect(page.getByTestId("markdown-save-state")).toHaveAttribute(
          "data-state",
          "pending-share",
          { timeout: 60_000 },
        );
        await expect.poll(pending).toBeGreaterThan(0);
      } else {
        // dohc's own write: the server settles the typing and sync writes it to the file.
        await expect.poll(pending, { timeout: 120_000, intervals: [1_000] }).toBe(0);
        await expect
          .poll(settledThroughAccepted, { timeout: 120_000, intervals: [1_000] })
          .toBe(true);
        await expect.poll(disk, { timeout: 120_000 }).toContain("OWNER-1");
        await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", {
          timeout: 120_000,
        });
        const own = await status();
        expect(own.outsideChanges ?? []).toEqual([]);
        expect(own.historyCaptureFailed).not.toBe(true);
        await openNotices(page);
        await expect(heldRow(page)).toHaveCount(0);
        await closeNotices(page);
      }
      const tab = page.getByTestId(editorTabTestId(PATH));
      await tab.hover();
      await tab.getByRole("button", { name: /^Close / }).click();
      await expect(tab).toHaveCount(0);
      const recorded = await disk();
      await record("1-before-outside-write", { recorded, status: await status() });

      await writeFile(join(temp.rootPath, PATH), OUTSIDE);
      await expect.poll(held, { timeout: 60_000, intervals: [500] }).toEqual([PATH]);
      const holding = await status();
      expect(holding.historyCaptureFailed).not.toBe(true);
      expect(await disk()).toBe(OUTSIDE);
      expect(
        engineMomentsOrEmpty(temp.rootPath).some((moment) => moment.text.includes("AGENT-1")),
      ).toBe(false);
      await openNotices(page);
      const row = heldRow(page);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(
          (value) => document.documentElement.setAttribute("data-theme", value),
          theme,
        );
        await page.screenshot({
          animations: "disabled",
          path: testInfo.outputPath(`held-row-${theme}.png`),
        });
      }
      await record("2-held", { status: holding, notices: await row.allInnerTexts() });

      await row.getByRole("button", { name: "Keep a copy", exact: true }).click();
      await expect.poll(held, { timeout: 60_000, intervals: [500] }).toEqual([]);
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await closeNotices(page);
      await expect.poll(disk, { timeout: 60_000 }).toBe(recorded);
      expect(await keptCopies()).toHaveLength(1);
      const [copy] = await keptCopies();
      expect(await readFile(join(temp.rootPath, copy!), "utf8")).toBe(OUTSIDE);
      expect((await status()).historyCaptureFailed).not.toBe(true);
      await record("3-kept", { copy, status: await status() });

      if (variant === "relay-down") {
        stack.resume();
        await expect.poll(pending, { timeout: 120_000, intervals: [1_000] }).toBe(0);
        await expect
          .poll(settledThroughAccepted, { timeout: 120_000, intervals: [1_000] })
          .toBe(true);
        await expect.poll(disk, { timeout: 120_000 }).toContain("OWNER-1");
        await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", {
          timeout: 120_000,
        });
      }
      expect(await disk()).toContain("OWNER-1");
      expect(await disk()).not.toContain("AGENT-1");
      expect(await keptCopies()).toEqual([copy]);
      expect(await held()).toEqual([]);
      await record("4-final", { disk: await disk(), status: await status() });
    } catch (error) {
      await record("failure", {
        error: error instanceof Error ? error.stack : String(error),
        status: desktop && workspaceId ? await status().catch(String) : null,
      });
      throw error;
    } finally {
      await testInfo.attach("observations", {
        contentType: "application/json",
        body: JSON.stringify({ variant, records }, null, 2),
      });
      const cleanup = await Promise.allSettled([desktop?.close(), context?.close()]);
      trust?.restore();
      cleanup.push(...(await Promise.allSettled([stack?.close()])));
      cleanup.push(...(await Promise.allSettled([temp.cleanup()])));
      const failures = cleanup.filter((row) => row.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((row) => row.reason),
          "Held outside change cleanup failed.",
        );
    }
  });
}
