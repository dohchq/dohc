import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {isDeepStrictEqual} from "node:util";
import {expect, test, type BrowserContext, type Page, type TestInfo} from "@playwright/test";
import type {DohcDesktopBridge} from "../src/ipc/bridgeContract";
import {activityPin, editorTabTestId, settingsNavPin} from "../src/testPins";
import {parseLiveRecoveryPackage} from "../src/workspaces/ownerLiveRecoveryCopy";
import {assertDesktopEngineHealthy, launchDesktopApp, type LaunchedDesktopApp} from "./helpers/desktopApp";
import {runDohcCli, waitForCliEndpoint} from "./helpers/dohcCli";
import {ownerEnrollment} from "./helpers/engineDb";
import {approveDesktop, createVerifiedAccount, openDesktopApproval, startSelfHostOnboardingStack, trustFixtureCa} from "./helpers/selfHostOnboarding";
import {activeWorkspace, createTempWorkspace, openHistoryView, openWorkspaceFromFirstRun, waitForWorkspaceFile, writeWorkspaceFiles, type TempWorkspace} from "./helpers/workspace";

test.skip(!process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1", "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");

const PATH = "notes/plan.md";
const ANCHOR = "The person writes here.";
const BASELINE = "The owner prepared this plan.";
const R1 = "Recipient continued.";
const HELD = "Owner typed during the hold.";
const COPY = "notes/plan (recovered).md";
const PACKAGE = "notes/plan (recovered).dohc-recovery.json";
const editor = (page: Page) => page.getByTestId("markdown-editor");
const saveState = (page: Page) => page.getByTestId("markdown-save-state");
const normalized = (text: string) => text.replaceAll("\r\n", "\n").trim();

// Go to avoids the Explorer race observed in the #2761 trial.
async function openNote(page: Page, path = PATH): Promise<void> {
  await page.getByTestId("titlebar-quick-open").click();
  const palette = page.getByTestId("quick-open");
  await palette.getByLabel("File").fill(path);
  await palette.getByRole("option", {name: path, exact: true}).click();
  await expect(editor(page)).toBeVisible();
}

async function typeAfter(page: Page, text: string): Promise<void> {
  await editor(page).getByText(ANCHOR).click();
  await page.keyboard.press("End");
  await page.keyboard.type(` ${text}`);
  await expect(editor(page)).toContainText(text);
  await expect(saveState(page)).toHaveAttribute("data-state", /^(saved|saved-to-host)$/, {timeout: 60_000});
}

async function screenshots(page: Page, info: TestInfo, stage: string): Promise<void> {
  const previous = await page.locator("html").getAttribute("data-theme");
  try {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const name = `restore-set-aside-${stage}-${theme}.png`;
      const path = info.outputPath(name);
      await page.screenshot({path, animations: "disabled"});
      await info.attach(name, {path, contentType: "image/png"});
    }
  } finally {
    await page.evaluate(value => {
      if (value === null) document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", value);
    }, previous);
  }
}

test("@restore-set-aside-typing a shared restore keeps the owner's later typing available as a recovery copy", async ({browser}, info) => {
  test.setTimeout(900_000);
  const signal = AbortSignal.timeout(info.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  const recipientTemp = await createTempWorkspace();
  const apps: LaunchedDesktopApp[] = [];
  const contexts: BrowserContext[] = [];
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let bodyFailure: {error: unknown} | undefined;
  const ownerAccount = {email: `owner-${randomUUID()}@example.test`, password: `Owner-${randomUUID()}`, name: "Owner"};
  const recipientAccount = {email: `recipient-${randomUUID()}@example.test`, password: `Recipient-${randomUUID()}`, name: "Recipient"};
  const unopenedAccount = {email: `unopened-${randomUUID()}@example.test`, password: `Unopened-${randomUUID()}`};
  const launch = async (temp: TempWorkspace) => {
    const app = await launchDesktopApp({workspace: temp, env: stack!.trustEnv});
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
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, {live: true, signal});
    trust = trustFixtureCa(stack.ca!.ca);
    const ownerApproval = await accountPage();
    const recipientApproval = await accountPage();
    // Sharing needs a known address. This account never opens its share or launches a desktop.
    await createVerifiedAccount(await accountPage(), stack.account, unopenedAccount);
    await createVerifiedAccount(recipientApproval, stack.account, recipientAccount);
    await writeWorkspaceFiles(ownerTemp, [{path: PATH, contents: `# Trip plan\n\n${ANCHOR}\n`}]);
    const owner = await launch(ownerTemp);
    const page = owner.page;
    const workspace = await test.step("the owner connects the workspace to the server", async () => {
      const opened = await openWorkspaceFromFirstRun(page, ownerTemp);
      await page.getByTestId(activityPin("settings")).click();
      await page.getByTestId(settingsNavPin("cloud")).click();
      await page.getByTestId("settings-cloud-connect").click();
      const approval = await openDesktopApproval(owner, ownerApproval, stack!.relayUrl);
      await createVerifiedAccount(ownerApproval, stack!.account, ownerAccount, approval);
      await approveDesktop(ownerApproval, ownerAccount);
      await expect(page.getByTestId("settings-row-account")).toContainText(ownerAccount.email);
      await page.getByRole("switch", {name: "Sync this workspace"}).click();
      await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
      await page.keyboard.press("Escape");
      await waitForWorkspaceFile(page, opened.workspaceId, PATH);
      await waitForCliEndpoint(ownerTemp.homeDir);
      return opened;
    });
    const shareForEdit = (recipientEmail: string) => page.evaluate(({workspaceId, recipientEmail, path}) =>
      (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.createRelayShare({workspaceId, recipientEmail, paths: [path], access: "edit"}),
    {workspaceId: workspace.workspaceId, recipientEmail, path: PATH});
    // Opening the note first gives enrollment its owner lineage.
    await openNote(page);
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", {timeout: 60_000});
    const share = await shareForEdit(recipientAccount.email);
    await expect.poll(async () => {
      const listed = await page.evaluate(workspaceId =>
        (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.listOwnerLiveDocuments({workspaceId}), workspace.workspaceId);
      const expected = stack!.ownerLiveBinding(workspace.workspaceId, PATH);
      const actual = expected && ownerEnrollment(ownerTemp.rootPath, expected.binding);
      return listed.documents.some(row => row.path === PATH && row.status === "ready") && expected !== null && actual !== null &&
        isDeepStrictEqual(actual.binding, expected.binding) && actual.relayDatabaseNamespace === expected.relayDatabaseNamespace;
    }, {timeout: 120_000, intervals: [1_000]}).toBe(true);
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
      await expect(received.locator("#open-share-sign-in-description")).toHaveCount(0, {timeout: 60_000});
      const open = received.getByTestId("open-share-start");
      await expect(open).toHaveText("Open share");
      await expect(open).toBeEnabled();
      await open.click();
      await expect(received.getByTestId("shared-view-banner")).toBeVisible({timeout: 60_000});
      const shared = await activeWorkspace(received, recipientTemp.rootPath);
      await waitForWorkspaceFile(received, shared.workspaceId, PATH);
      await openNote(received);
      await expect(editor(received)).toContainText(BASELINE, {timeout: 60_000});
      await typeAfter(received, R1);
      await expect(saveState(received)).toHaveAttribute("data-state", "saved-to-host", {timeout: 60_000});
      await expect(editor(page)).toContainText(R1, {timeout: 60_000});
      await expect.poll(() => readFile(join(ownerTemp.rootPath, PATH), "utf8"), {timeout: 60_000}).toContain(R1);
    });

    const restored = await test.step("the owner stops the recipient's access and restores to before R1", async () => {
      await openHistoryView(page);
      const moment = page.locator(`[data-testid="engine-moment-open"][data-moment-path="${PATH}"]`).first();
      await expect(moment).toBeVisible({timeout: 60_000});
      await moment.click();
      await page.getByTestId("engine-diff-shared-restore").click();
      const dialog = page.getByTestId("owner-restore-dialog");
      await expect(dialog).toBeVisible();
      const access = dialog.getByLabel("Access to stop");
      await expect(access.locator("option", {hasText: recipientAccount.email})).toHaveCount(1, {timeout: 60_000});
      await access.selectOption({label: recipientAccount.email});
      const recipientId = (await stack!.account.pool.query<{id: string}>('SELECT id FROM "user" WHERE email = $1', [recipientAccount.email])).rows[0]!.id;
      const point = stack!.acceptedCursorBefore(workspace.workspaceId, PATH, recipientId);
      await dialog.getByLabel("Shared restore point").selectOption(String(point));
      await dialog.getByRole("button", {name: "Review affected access"}).click();
      await expect(dialog.getByRole("heading", {name: "Stop access before restoring?"})).toBeVisible();
      await dialog.getByRole("button", {name: "Stop access", exact: true}).click();
      const after = dialog.getByLabel("File after restore");
      await expect(after).toBeVisible({timeout: 60_000});
      const text = await after.inputValue();
      expect(text).toContain(BASELINE);
      expect(text).not.toContain(R1);
      await dialog.getByRole("button", {name: "Restore file", exact: true}).click();
      await expect(dialog.getByRole("heading", {name: "File restored"})).toBeVisible({timeout: 60_000});
      await dialog.getByRole("button", {name: "Close", exact: true}).click();
      return normalized(text);
    });

    await test.step("the owner types HELD, closes the note, and makes a new Edit share nobody opens", async () => {
      await openNote(page);
      await typeAfter(page, HELD);
      const tab = page.getByTestId(editorTabTestId(PATH));
      await tab.hover();
      await tab.getByRole("button", {name: /^Close /}).click();
      await expect(tab).toHaveCount(0);
      await shareForEdit(unopenedAccount.email);
      await expect.poll(async () => normalized(await readFile(join(ownerTemp.rootPath, PATH), "utf8")),
        {timeout: 120_000, intervals: [1_000]}).toBe(restored);
      await openNote(page);
      await expect(editor(page)).toContainText(BASELINE);
      await expect(editor(page)).not.toContainText(R1);
      await expect(editor(page)).not.toContainText(HELD);
    });

    const notices = page.getByTestId("notice-center");
    const notice = notices.locator("[data-notice-row]").filter({has: page.getByText(`Edits not written to ${PATH}`, {exact: true})});
    await test.step("Notices lists the set-aside typing with Save recovery copy and Open Live documents", async () => {
      await page.getByTestId("notice-center-toggle").click();
      // This is the regression assertion: main has no row for the old restore-fenced queue.
      await expect(notice).toBeVisible({timeout: 60_000});
      await expect(notice.getByRole("button", {name: "Save recovery copy", exact: true})).toBeEnabled();
      await expect(notice.getByRole("button", {name: "Open Live documents", exact: true})).toBeVisible();
      await expect(notice.getByRole("button", {name: "Dismiss notice", exact: true})).toBeVisible();
      await expect(notice.getByRole("button", {name: "Try again", exact: true})).toHaveCount(0);
      await screenshots(page, info, "notices");
    });

    await notice.getByRole("button", {name: "Open Live documents", exact: true}).click();
    const live = page.getByTestId("live-documents-dialog");
    const kept = live.locator("li").filter({has: page.getByRole("button", {name: `Save recovery copy of ${PATH}`, exact: true})});
    await test.step("Live documents gives the kept queue a separate Save-only row", async () => {
      await expect(live).toBeVisible();
      await expect(kept).toHaveCount(1);
      await expect(kept.getByRole("button")).toHaveText(["Save recovery copy"]);
      const current = live.getByTestId(`live-document-row-${PATH}`);
      await expect(current).toContainText("Live");
      await expect(current.getByRole("button", {name: `Stop live editing for ${PATH}`, exact: true})).toBeVisible();
      await screenshots(page, info, "live-documents");
    });
    const listed = await page.evaluate(workspaceId =>
      (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.listOwnerLiveDocuments({workspaceId}), workspace.workspaceId);
    const incident = listed.documents.find(row => row.path === PATH && row.saveOnly)?.incident;
    expect(incident).toBeTruthy();
    const expectCliKeptEdits = async () => {
      const result: unknown = JSON.parse((await runDohcCli(ownerTemp, ["--json", "document", "kept-edits"])).stdout);
      expect(result).toMatchObject({ok: true, keptEdits: [expect.objectContaining({path: PATH, incident, reason: "restore-fenced", saveOnly: true})]});
    };
    await expectCliKeptEdits();

    await test.step("Save recovery copy writes HELD and its package without changing the restored note or ending the kept edit", async () => {
      await kept.getByRole("button", {name: `Save recovery copy of ${PATH}`, exact: true}).click();
      const savedMessage = `Saved a recovery copy of ${PATH} in notes. Your kept edits stay on this computer.`;
      const saved = page.getByTestId("workspace-shell-notice").filter({has: page.getByText(savedMessage, {exact: true})});
      await expect(saved.getByText(savedMessage, {exact: true})).toBeVisible();
      await expect(saved.getByRole("button", {name: "Open", exact: true})).toBeVisible();
      // Hover keeps the existing success toast visible through both theme shots.
      await saved.hover();
      await expect(kept.getByRole("button", {name: `Save recovery copy of ${PATH}`, exact: true})).toBeEnabled();
      await screenshots(page, info, "after-save");
      await expect.poll(async () => readFile(join(ownerTemp.rootPath, COPY), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      }), {timeout: 60_000}).toContain(HELD);
      const copy = await readFile(join(ownerTemp.rootPath, COPY), "utf8");
      const packaged = await readFile(join(ownerTemp.rootPath, PACKAGE), "utf8");
      expect(parseLiveRecoveryPackage(packaged)).toMatchObject({path: PATH, reason: "restore-fenced", storedOn: "this-computer"});
      await info.attach("recovered-plan.md", {body: copy, contentType: "text/markdown"});
      await info.attach("recovered-plan.dohc-recovery.json", {body: packaged, contentType: "application/json"});
      expect(normalized(await readFile(join(ownerTemp.rootPath, PATH), "utf8"))).toBe(restored);
      await expect(kept).toBeVisible();
      await live.getByRole("button", {name: "Reload", exact: true}).click();
      await expect(live.getByTestId("live-documents-reload")).toBeEnabled();
      await expect(kept.getByRole("button", {name: `Save recovery copy of ${PATH}`, exact: true})).toBeEnabled();
      await expectCliKeptEdits();
      await live.getByRole("button", {name: "Close", exact: true}).click();
      await expect(live).toHaveCount(0);
      if (!await notices.isVisible()) await page.getByTestId("notice-center-toggle").click();
      await expect(notice).toBeVisible();
      await screenshots(page, info, "after-save-notices");
    });

    await test.step("dismissing the notice hides only its row and leaves the edits available in Live documents and the CLI", async () => {
      await notice.getByRole("button", {name: "Dismiss notice", exact: true}).click();
      await expect(notice).toHaveCount(0);
      await page.getByTestId("notice-center-toggle").click();
      await page.getByTestId(activityPin("settings")).click();
      await page.getByTestId(settingsNavPin("cloud")).click();
      await page.getByRole("button", {name: "Open live documents", exact: true}).click();
      await expect(live).toBeVisible();
      await live.getByRole("button", {name: "Reload", exact: true}).click();
      await expect(live.getByTestId("live-documents-reload")).toBeEnabled();
      await expect(kept.getByRole("button")).toHaveText(["Save recovery copy"]);
      await expect(kept.getByRole("button", {name: `Save recovery copy of ${PATH}`, exact: true})).toBeEnabled();
      await expectCliKeptEdits();
      await live.getByRole("button", {name: "Close", exact: true}).click();
      await expect(live).toHaveCount(0);
      await page.getByTestId("notice-center-toggle").click();
      await expect(notice).toHaveCount(0);
      await page.getByTestId("notice-center-toggle").click();
    });

    await test.step("the restored note stays unchanged and the readable copy opens with HELD", async () => {
      await openNote(page);
      await expect(editor(page)).toContainText(BASELINE);
      await expect(editor(page)).not.toContainText(R1);
      await expect(editor(page)).not.toContainText(HELD);
      await waitForWorkspaceFile(page, workspace.workspaceId, COPY);
      await openNote(page, COPY);
      await expect(editor(page)).toContainText(HELD);
    });
    for (const app of apps) {
      expect(app.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
      assertDesktopEngineHealthy(app.logs);
    }
  } catch (error) {
    bodyFailure = {error};
    if (stack) await info.attach("relay-output", {body: stack.relayOutput(), contentType: "text/plain"}).catch(() => undefined);
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([...apps.map(app => app.close()), ...contexts.map(context => context.close())]);
    trust?.restore();
    cleanup.push(...await Promise.allSettled([stack?.close()]));
    cleanup.push(...await Promise.allSettled([recipientTemp.cleanup(), ownerTemp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError([...(bodyFailure ? [bodyFailure.error] : []), ...failures.map(result => result.reason)], "Restore recovery cleanup failed.");
  }
});
