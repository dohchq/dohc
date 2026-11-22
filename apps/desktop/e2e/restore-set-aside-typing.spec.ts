import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin, settingsNavPin } from "../src/testPins";
import {
  assertDesktopEngineHealthy,
  launchDesktopApp,
  type LaunchedDesktopApp,
} from "./helpers/desktopApp";
import { waitForCliEndpoint } from "./helpers/dohcCli";
import { ownerEnrollment } from "./helpers/engineDb";
import {
  approveDesktop,
  createVerifiedAccount,
  openDesktopApproval,
  startSelfHostOnboardingStack,
  trustFixtureCa,
} from "./helpers/selfHostOnboarding";
import {
  activeWorkspace,
  createTempWorkspace,
  openHistoryView,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "./helpers/workspace";

test.skip(
  !process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1",
  "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.",
);

const PATH = "notes/plan.md";
const ANCHOR = "The person writes here.";
const BASELINE = "The owner prepared this plan.";
const R1 = "Recipient continued.";
const editor = (page: Page) => page.getByTestId("markdown-editor");
const saveState = (page: Page) => page.getByTestId("markdown-save-state");
const normalized = (text: string) => text.replaceAll("\r\n", "\n").trim();

// Go to avoids a race in the Explorer.
async function openNote(page: Page, path = PATH): Promise<void> {
  await page.getByTestId("titlebar-quick-open").click();
  const palette = page.getByTestId("quick-open");
  await palette.getByLabel("File").fill(path);
  await palette.getByRole("option", { name: path, exact: true }).click();
  await expect(editor(page)).toBeVisible();
}

async function typeAfter(page: Page, text: string): Promise<void> {
  await editor(page).getByText(ANCHOR).click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
  await page.keyboard.type(` ${text}`);
  await expect(editor(page)).toContainText(text);
  await expect(saveState(page)).toHaveAttribute("data-state", /^(saved|saved-to-host)$/, {
    timeout: 60_000,
  });
}

test("@restore-set-aside-typing History refuses to restore a live shared note, and its creation too", async ({
  browser,
}, info) => {
  test.setTimeout(900_000);
  const signal = AbortSignal.timeout(info.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  const recipientTemp = await createTempWorkspace();
  const apps: LaunchedDesktopApp[] = [];
  const contexts: BrowserContext[] = [];
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let bodyFailure: { error: unknown } | undefined;
  const ownerAccount = {
    email: `owner-${randomUUID()}@example.test`,
    password: `Owner-${randomUUID()}`,
    name: "Owner",
  };
  const recipientAccount = {
    email: `recipient-${randomUUID()}@example.test`,
    password: `Recipient-${randomUUID()}`,
    name: "Recipient",
  };
  const unopenedAccount = {
    email: `unopened-${randomUUID()}@example.test`,
    password: `Unopened-${randomUUID()}`,
  };
  const launch = async (temp: TempWorkspace) => {
    const app = await launchDesktopApp({ workspace: temp, env: stack!.trustEnv });
    apps.push(app);
    return app;
  };
  const accountPage = async () => {
    const context = await browser.newContext();
    contexts.push(context);
    await trust!.route(context, stack!.relayUrl);
    return context.newPage();
  };
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, { live: true, signal });
    trust = trustFixtureCa(stack.ca!.ca);
    const ownerApproval = await accountPage();
    const recipientApproval = await accountPage();
    // Sharing needs a known address. This account never opens its share or launches a desktop.
    await createVerifiedAccount(await accountPage(), stack.account, unopenedAccount);
    await createVerifiedAccount(recipientApproval, stack.account, recipientAccount);
    await writeWorkspaceFiles(ownerTemp, [{ path: PATH, contents: `# Trip plan\n\n${ANCHOR}\n` }]);
    const owner = await launch(ownerTemp);
    const page = owner.page;
    const workspace =
      await test.step("the owner connects the workspace to the server", async () => {
        const opened = await openWorkspaceFromFirstRun(page, ownerTemp);
        await page.getByTestId(activityPin("settings")).click();
        await page.getByTestId(settingsNavPin("cloud")).click();
        await page.getByTestId("settings-cloud-connect").click();
        const approval = await openDesktopApproval(owner, ownerApproval, stack!.relayUrl);
        await createVerifiedAccount(ownerApproval, stack!.account, ownerAccount, approval);
        await approveDesktop(ownerApproval, ownerAccount);
        await expect(page.getByTestId("settings-row-account")).toContainText(ownerAccount.email);
        await page.getByRole("switch", { name: "Sync this workspace" }).click();
        await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
        await page.keyboard.press("Escape");
        await waitForWorkspaceFile(page, opened.workspaceId, PATH);
        await waitForCliEndpoint(ownerTemp.homeDir);
        return opened;
      });
    const shareForEdit = (recipientEmail: string) =>
      page.evaluate(
        ({ workspaceId, recipientEmail, path }) =>
          (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.createRelayShare({
            workspaceId,
            recipientEmail,
            paths: [path],
            access: "edit",
          }),
        { workspaceId: workspace.workspaceId, recipientEmail, path: PATH },
      );
    // Opening the note first gives enrollment its owner lineage.
    await openNote(page);
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", {
      timeout: 60_000,
    });
    const share = await shareForEdit(recipientAccount.email);
    await expect
      .poll(
        async () => {
          const listed = await page.evaluate(
            (workspaceId) =>
              (
                window as unknown as { dohcDesktop: DohcDesktopBridge }
              ).dohcDesktop.listOwnerLiveDocuments({ workspaceId }),
            workspace.workspaceId,
          );
          const expected = stack!.ownerLiveBinding(workspace.workspaceId, PATH);
          const actual = expected && ownerEnrollment(ownerTemp.rootPath, expected.binding);
          return (
            listed.documents.some((row) => row.path === PATH && row.status === "ready") &&
            expected !== null &&
            actual !== null &&
            isDeepStrictEqual(actual.binding, expected.binding) &&
            actual.relayDatabaseNamespace === expected.relayDatabaseNamespace
          );
        },
        { timeout: 120_000, intervals: [1_000] },
      )
      .toBe(true);
    // This accepted owner change supplies the restore point immediately before R1.
    await typeAfter(page, BASELINE);

    const recipient = await launch(recipientTemp);
    await test.step("the recipient opens the Edit share and adds R1", async () => {
      const received = recipient.page;
      await received.getByTestId("first-run-open-share").click();
      await received.getByTestId("open-share-code").fill(share.shareCode);
      await received.getByTestId("open-share-choose-folder").click();
      await received.getByTestId("open-share-start").click();
      await openDesktopApproval(recipient, recipientApproval, stack!.relayUrl);
      await approveDesktop(recipientApproval, recipientAccount);
      await expect(received.locator("#open-share-sign-in-description")).toHaveCount(0, {
        timeout: 60_000,
      });
      const open = received.getByTestId("open-share-start");
      await expect(open).toHaveText("Open share");
      await expect(open).toBeEnabled();
      await open.click();
      await expect(received.getByTestId("shared-view-banner")).toBeVisible({ timeout: 60_000 });
      const shared = await activeWorkspace(received, recipientTemp.rootPath);
      await waitForWorkspaceFile(received, shared.workspaceId, PATH);
      await openNote(received);
      await expect(editor(received)).toContainText(BASELINE, { timeout: 60_000 });
      await typeAfter(received, R1);
      await expect(saveState(received)).toHaveAttribute("data-state", "saved-to-host", {
        timeout: 60_000,
      });
      await expect(editor(page)).toContainText(R1, { timeout: 60_000 });
      await expect
        .poll(() => readFile(join(ownerTemp.rootPath, PATH), "utf8"), { timeout: 60_000 })
        .toContain(R1);
    });

    await test.step("Restore earlier state on the shared note says to stop live editing first", async () => {
      const title = `dohc cannot restore "${PATH}" while it has live editing on`;
      const body = "In Live documents, stop live editing for this page, then restore it again.";
      const expectRefusal = async (shown: Locator) => {
        await expect(shown.locator("[id$='-title']")).toHaveText(title);
        await expect(shown.locator("[id$='-body']")).toHaveText(body);
        await expect(shown.locator("[data-testid$='-more']")).toHaveCount(0);
        await expect(shown.getByRole("button", { name: "Try again" })).toBeVisible();
        await expect(
          shown.getByRole("button", { name: "Open Live documents", exact: true }),
        ).toBeVisible();
      };
      await page.getByTestId("engine-diff-restore-file").click();
      const refusal = page.getByTestId("workspace-shell-error");
      await expect(refusal).toContainText(title, { timeout: 30_000 });
      await expectRefusal(refusal);
      await info.attach("Restore refusal toast", {
        contentType: "image/png",
        body: await page.screenshot(),
      });
      await page.getByTestId("notice-center-toggle").click();
      const row = page
        .getByTestId("notice-center")
        .locator("[data-notice-row]")
        .filter({ has: page.getByText(title, { exact: true }) });
      await expect(row).toHaveCount(1);
      await expectRefusal(row);
      await info.attach("Restore refusal in Notices", {
        contentType: "image/png",
        body: await page.screenshot(),
      });
      await page.getByTestId("notice-center-toggle").click();
      await expect
        .poll(async () => normalized(await readFile(join(ownerTemp.rootPath, PATH), "utf8")))
        .toContain(R1);
    });
    await test.step("Restore earlier state on the note's creation is refused too, and the note stays", async () => {
      // Restoring to before the creation would delete the shared note.
      const title = `dohc cannot restore "${PATH}" while it has live editing on`;
      const body = "In Live documents, stop live editing for this page, then restore it again.";
      // Clear the earlier refusal, so the toast below can only be this one.
      const toasts = page.getByTestId("notice-toasts").getByTestId("workspace-shell-error");
      for (const shown of await toasts.all())
        await shown.getByRole("button", { name: "Dismiss workspace error" }).click();
      await expect(toasts).toHaveCount(0);
      await openHistoryView(page);
      const creation = page
        .locator(`[data-testid="engine-moment-open"][data-moment-path="${PATH}"]`)
        .filter({ hasText: "Added existing files" });
      await expect(creation).toHaveCount(1, { timeout: 60_000 });
      await creation.click();
      await page.getByTestId("engine-diff-restore-file").click();
      const refusal = toasts.filter({ hasText: title });
      await expect(refusal).toHaveCount(1, { timeout: 30_000 });
      await expect(refusal.locator("[id$='-title']")).toHaveText(title);
      await expect(refusal.locator("[id$='-body']")).toHaveText(body);
      await expect(refusal.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(
        refusal.getByRole("button", { name: "Open Live documents", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Removed the file this change created.")).toHaveCount(0);
      await info.attach("Creation restore refusal toast", {
        contentType: "image/png",
        body: await page.screenshot(),
      });
      await expect
        .poll(async () => normalized(await readFile(join(ownerTemp.rootPath, PATH), "utf8")))
        .toContain(R1);
    });
    for (const app of apps) {
      expect(app.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
      assertDesktopEngineHealthy(app.logs);
    }
  } catch (error) {
    bodyFailure = { error };
    if (stack)
      await info
        .attach("relay-output", { body: stack.relayOutput(), contentType: "text/plain" })
        .catch(() => undefined);
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      ...apps.map((app) => app.close()),
      ...contexts.map((context) => context.close()),
    ]);
    trust?.restore();
    cleanup.push(...(await Promise.allSettled([stack?.close()])));
    cleanup.push(...(await Promise.allSettled([recipientTemp.cleanup(), ownerTemp.cleanup()])));
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        [...(bodyFailure ? [bodyFailure.error] : []), ...failures.map((result) => result.reason)],
        "Restore recovery cleanup failed.",
      );
  }
});
