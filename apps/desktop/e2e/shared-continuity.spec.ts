import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { assertDesktopEngineHealthy, launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { ownerSettlementState, ydocUpdateAuthors } from "./helpers/engineDb";
import { approveDesktop, createVerifiedAccount, openDesktopApproval, startSelfHostOnboardingStack, trustFixtureCa } from "./helpers/selfHostOnboarding";
import {
  activeWorkspace, createTempWorkspace, explorerRow, openHistoryView, openWorkspaceFromFirstRun,
  revealExplorerPath, waitForWorkspaceFile, writeWorkspaceFiles, type TempWorkspace,
} from "./helpers/workspace";

// One live document, start to finish, on a self-hosted server: real accounts,
// HTTPS from a test CA that every process verifies, and the native live host.
// The owner types, an agent edits through the dohc CLI, and the owner
// restarts. A second account opens the shared document on its own desktop and
// types. The owner and the agent see that edit. The owner stops that access and
// restores the document to before it, and the result survives a restart.
//
// The recipient's Markdown file is a snapshot. The owner's live document is the
// authority, so the recipient's disk is not asserted.

test.skip(!process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1", "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");

type Api = DohcDesktopBridge;

const PATH = "notes/plan.md";
const HIDDEN = "private/hidden.md";
const SEED = "# Trip plan\n\nThe agent drafts this line.\n\nThe person writes here.\n";
const H1 = "Human first edit.";
const A1 = "Agent revised this line.";
const R1 = "Recipient continued.";
const AGENT = "trip-agent";

const editor = (page: Page) => page.getByTestId("markdown-editor");
const saveState = (page: Page) => page.getByTestId("markdown-save-state");

async function cliRead(temp: TempWorkspace): Promise<string> {
  return (await runDohcCli(temp, ["document", "read", PATH])).stdout;
}

// The last views ownerSettled compared, attached when the test fails so a
// failure says whether the agent's read or the settled file missed an edit.
// They hold only the fixture document and the fixed sentences.
let lastOwnerViews: unknown;

function describeView(view: PromiseSettledResult<string>, sentences: string[]) {
  return view.status === "fulfilled"
    ? { text: view.value, contains: Object.fromEntries(sentences.map(sentence => [sentence, view.value.includes(sentence)])) }
    : { error: view.reason instanceof Error ? view.reason.message : String(view.reason) };
}

/** The agent's read equals the settled file, which holds `present` and none of `absent`. */
async function ownerSettled(temp: TempWorkspace, present: string[], absent: string[] = []): Promise<boolean> {
  const [cli, disk] = await Promise.allSettled([cliRead(temp), readFile(join(temp.rootPath, PATH), "utf8")]);
  const sentences = [...present, ...absent];
  const settled = cli.status === "fulfilled" && disk.status === "fulfilled" && cli.value === disk.value &&
    present.every(text => disk.value.includes(text)) && absent.every(text => !disk.value.includes(text));
  lastOwnerViews = {
    checkedAt: new Date().toISOString(), present, absent,
    cli: describeView(cli, sentences), disk: describeView(disk, sentences),
    equal: cli.status === "fulfilled" && disk.status === "fulfilled" && cli.value === disk.value,
    // Whether the host's settlement never arrived, waits for the accepted
    // cursor, or waits for a retry. Counts only.
    ...(settled ? {} : { ownerSettlements: settlementState(temp) }),
  };
  if (cli.status === "rejected") throw cli.reason;
  if (disk.status === "rejected") throw disk.reason;
  return settled;
}

function settlementState(temp: TempWorkspace) {
  try { return ownerSettlementState(temp.rootPath); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

async function openDocument(page: Page): Promise<void> {
  const explorer = page.getByTestId("activity-explorer");
  if ((await explorer.getAttribute("aria-current")) !== "page") await explorer.click();
  await revealExplorerPath(page, PATH);
  await explorerRow(page, PATH).click();
  // The engine session is live once the local editor's Edit toggle is gone.
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 30_000 });
  await expect(editor(page)).toBeVisible();
}

async function typeAfter(page: Page, anchor: string, text: string): Promise<void> {
  await editor(page).getByText(anchor).click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

async function openSharedRestore(page: Page) {
  await openHistoryView(page);
  const moment = page.locator(`[data-testid="engine-moment-open"][data-moment-path="${PATH}"]`).first();
  await expect(moment).toBeVisible({ timeout: 60_000 });
  await moment.click();
  await expect(page.getByTestId("engine-moment-diff-page")).toBeVisible();
  await page.getByTestId("engine-diff-shared-restore").click();
  const dialog = page.getByTestId("owner-restore-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectNoActiveAccess(page: Page): Promise<void> {
  const dialog = await openSharedRestore(page);
  await expect(dialog.getByText("No active edit access is available for this file.")).toBeVisible({ timeout: 60_000 });
  await dialog.getByRole("button", { name: "Close" }).click();
}

test("@shared-continuity a live document keeps its person's and agent's work through restart, a recipient continues it, and the owner restores it", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const ownerTemp = await createTempWorkspace();
  const recipientTemp = await createTempWorkspace();
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let owner: LaunchedDesktopApp | undefined;
  let recipient: LaunchedDesktopApp | undefined;
  let ownerBrowser: BrowserContext | undefined;
  let recipientBrowser: BrowserContext | undefined;
  let bodyFailure: { error: unknown } | undefined;
  const launches: LaunchedDesktopApp[] = [];
  const launch = async (temp: TempWorkspace) => {
    const app = await launchDesktopApp({ workspace: temp, env: stack!.trustEnv });
    launches.push(app);
    return app;
  };
  const ownerAccount = { email: `owner-${randomUUID()}@example.test`, password: `Owner-proof-${randomUUID()}`, name: "Owner proof" };
  const recipientAccount = { email: `recipient-${randomUUID()}@example.test`, password: `Recipient-proof-${randomUUID()}`, name: "Recipient proof" };
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, { live: true });
    const origin = stack.relayUrl;
    expect(new URL(origin).protocol).toBe("https:");
    trust = trustFixtureCa(stack.ca!.ca);
    ownerBrowser = await browser.newContext();
    await trust.route(ownerBrowser, origin);
    recipientBrowser = await browser.newContext();
    await trust.route(recipientBrowser, origin);
    const recipientPage = await recipientBrowser.newPage();
    // The owner can share only with an account the server knows.
    await createVerifiedAccount(recipientPage, stack.account, recipientAccount);

    const workspace = await test.step("the owner connects a workspace to the server", async () => {
      await writeWorkspaceFiles(ownerTemp, [{ path: PATH, contents: SEED }, { path: HIDDEN, contents: "Only the owner reads this.\n" }]);
      owner = await launch(ownerTemp);
      const opened = await openWorkspaceFromFirstRun(owner.page, ownerTemp);
      await owner.page.getByTestId("activity-cloud").click();
      await expect(owner.page.getByTestId("cloud-sync-panel")).toBeVisible();
      const ownerPage = await ownerBrowser!.newPage();
      const approval = await openDesktopApproval(owner, ownerPage, origin);
      await createVerifiedAccount(ownerPage, stack!.account, ownerAccount, approval);
      await approveDesktop(ownerPage, ownerAccount);
      await expect(owner.page.getByTestId("cloud-connected-email")).toHaveText(ownerAccount.email);
      await owner.page.getByTestId("cloud-enable-sync").click();
      await expect(owner.page.getByTestId("cloud-workspace-synced")).toBeVisible();
      await owner.page.keyboard.press("Escape");
      await waitForWorkspaceFile(owner.page, opened.workspaceId, PATH);
      return opened;
    });

    await test.step("the owner types and the agent edits through the CLI", async () => {
      const page = owner!.page;
      await openDocument(page);
      await typeAfter(page, "The person writes here.", ` ${H1}`);
      await expect(saveState(page)).toHaveAttribute("data-state", "saved");
      await waitForCliEndpoint(ownerTemp.homeDir);
      await expect.poll(() => cliRead(ownerTemp), { timeout: 30_000 }).toContain(H1);
      const edited = await runDohcCli(ownerTemp, ["--json", "document", "edit", PATH, "--find", "The agent drafts this line.", "--text", A1, "--agent", AGENT]);
      expect(JSON.parse(edited.stdout)).toMatchObject({ ok: true, path: PATH, changed: true });
      await expect(editor(page)).toContainText(A1);
      await expect(saveState(page)).toHaveAttribute("data-state", "saved");
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1]), { timeout: 30_000 }).toBe(true);
      const authors = ydocUpdateAuthors(ownerTemp.rootPath);
      expect(authors).toContainEqual({ actorOriginId: AGENT, actorKind: "agent" });
      expect(authors.some(author => author.actorKind === "human")).toBe(true);
    });

    await test.step("both edits survive the owner's restart", async () => {
      await owner!.close();
      owner = undefined;
      owner = await launch(ownerTemp);
      expect((await openWorkspaceFromFirstRun(owner.page, ownerTemp)).workspaceId).toBe(workspace.workspaceId);
      await waitForWorkspaceFile(owner.page, workspace.workspaceId, PATH);
      await waitForCliEndpoint(ownerTemp.homeDir);
      await openDocument(owner.page);
      await expect(editor(owner.page)).toContainText(H1);
      await expect(editor(owner.page)).toContainText(A1);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1]), { timeout: 30_000 }).toBe(true);
      const status = await owner.page.evaluate(workspaceId =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.cloudStatus({ workspaceId }), workspace.workspaceId);
      expect(status).toMatchObject({ connected: true, email: ownerAccount.email, relayUrl: origin, workspaceSynced: true });
    });

    const share = await test.step("the owner shares the document with Edit and the server hosts it live", async () => {
      const created = await owner!.page.evaluate(({ workspaceId, recipientEmail, path }) =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.createRelayShare({ workspaceId, recipientEmail, paths: [path], access: "edit" }),
      { workspaceId: workspace.workspaceId, recipientEmail: recipientAccount.email, path: PATH });
      await expect.poll(async () => {
        const live = await owner!.page.evaluate(workspaceId =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({ workspaceId }), workspace.workspaceId);
        return live.documents.find(document => document.path === PATH)?.status;
      }, { timeout: 120_000, intervals: [1_000] }).toBe("ready");
      return created;
    });

    await test.step("the recipient opens the share on their own desktop and continues the document", async () => {
      recipient = await launch(recipientTemp);
      const page = recipient.page;
      await page.getByTestId("first-run-open-share").click();
      await page.getByTestId("open-share-code").fill(share.shareCode);
      await page.getByTestId("open-share-choose-folder").click();
      // Opening without an account asks the person to connect one first.
      await page.getByTestId("open-share-start").click();
      await openDesktopApproval(recipient, recipientPage, origin);
      await approveDesktop(recipientPage, recipientAccount);
      // The sign-in panel leaves only once the desktop holds the session.
      // Before that, the button reads Open share too, and pressing it only
      // reopens the panel.
      await expect(page.locator("#open-share-sign-in-description")).toHaveCount(0, { timeout: 60_000 });
      const open = page.getByTestId("open-share-start");
      await expect(open).toHaveText("Open share");
      await expect(open).toBeEnabled();
      await open.click();
      await expect(page.getByTestId("shared-view-banner")).toBeVisible({ timeout: 60_000 });
      const shared = await activeWorkspace(page, recipientTemp.rootPath);
      await waitForWorkspaceFile(page, shared.workspaceId, PATH);
      const listed = await page.evaluate(workspaceId =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.listWorkspaceFiles({ workspaceId }), shared.workspaceId);
      expect(listed.files.map(file => file.path).filter(path => path.startsWith("private/"))).toEqual([]);
      expect(existsSync(join(recipientTemp.rootPath, HIDDEN))).toBe(false);
      await openDocument(page);
      await expect(explorerRow(page, "private")).toHaveCount(0);
      await expect(editor(page)).toContainText(H1);
      await expect(editor(page)).toContainText(A1);
      await typeAfter(page, H1, ` ${R1}`);
      // A shared session reports saved once the server's host accepted the edit.
      await expect(saveState(page)).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
    });

    await test.step("the idle owner's editor and the agent see the recipient's edit", async () => {
      await expect(editor(owner!.page)).toContainText(R1, { timeout: 60_000 });
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1, R1]), { timeout: 60_000 }).toBe(true);
    });

    await test.step("the owner stops the recipient's access and restores the document to before their edit", async () => {
      const page = owner!.page;
      const { rows } = await stack!.account.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [recipientAccount.email]);
      const recipientUserId = rows[0]!.id;
      const dialog = await openSharedRestore(page);
      // Restore lists an account recipient by account ID, not email.
      const recipientLabel = `Account ${recipientUserId}`;
      const access = dialog.getByLabel("Access to stop");
      await expect(access.locator("option", { hasText: recipientLabel })).toHaveCount(1, { timeout: 60_000 });
      await access.selectOption({ label: recipientLabel });
      // Restore to the accepted change just before the recipient's first edit,
      // which keeps the owner's and agent's work.
      const point = stack!.acceptedCursorBefore(workspace.workspaceId, PATH, recipientUserId);
      const pointSelect = dialog.getByLabel("Shared restore point");
      await expect(pointSelect.locator(`option[value="${point}"]`)).toHaveText(new RegExp(` · Change ${point}$`));
      await pointSelect.selectOption({ value: String(point) });
      await dialog.getByRole("button", { name: "Review affected access" }).click();
      await expect(dialog.getByRole("heading", { name: "Stop access before restoring?" })).toBeVisible();
      await expect(dialog.getByRole("listitem").filter({ hasText: recipientLabel })).toHaveCount(1);
      // The recipient can still edit, so read-only afterwards proves the stop.
      await expect(saveState(recipient!.page)).toHaveAttribute("data-state", "saved");
      await expect(editor(recipient!.page)).toHaveAttribute("contenteditable", "true");
      await dialog.getByRole("button", { name: "Stop access" }).click();
      const current = dialog.getByLabel("Current file before restore");
      await expect(current).toBeVisible({ timeout: 60_000 });
      expect(await current.inputValue()).toContain(R1);
      const restored = await dialog.getByLabel("File after restore").inputValue();
      expect(restored).toContain(H1);
      expect(restored).toContain(A1);
      expect(restored).not.toContain(R1);
      // The review names the recipient by account ID, not by name or email.
      const removed = dialog.locator("details", { has: page.locator("summary", { hasText: /^Removed by this restore/ }) });
      await removed.locator("summary").first().click();
      await expect(removed).toContainText(`Account ${recipientUserId}`);
      await testInfo.attach("attribution", {
        contentType: "application/json",
        body: JSON.stringify({
          recipientUserId,
          ydocUpdateAuthors: ydocUpdateAuthors(ownerTemp.rootPath),
          sharedRestoreRemoved: await removed.innerText(),
          ownerHistory: await page.evaluate(async ({ workspaceId, path }) => {
            const history = await (window as unknown as { dohcDesktop: Api }).dohcDesktop.listEngineMoments({ workspaceId, limit: 100 });
            return "moments" in history ? history.moments.filter(moment => moment.path === path) : history;
          }, { workspaceId: workspace.workspaceId, path: PATH }),
        }, null, 2),
      });
      await dialog.getByRole("button", { name: "Restore file" }).click();
      await expect(dialog.getByRole("heading", { name: "File restored" })).toBeVisible({ timeout: 60_000 });
      await dialog.getByRole("button", { name: "Close" }).click();
    });

    await test.step("the restore reaches the owner and the agent, and the recipient can no longer edit", async () => {
      await openDocument(owner!.page);
      await expect(editor(owner!.page)).not.toContainText(R1, { timeout: 60_000 });
      await expect(editor(owner!.page)).toContainText(H1);
      await expect(editor(owner!.page)).toContainText(A1);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1], [R1]), { timeout: 60_000 }).toBe(true);
      const page = recipient!.page;
      await expect(saveState(page)).toHaveAttribute("data-state", "read-only", { timeout: 60_000 });
      await expect(editor(page)).toHaveAttribute("contenteditable", "false");
      await editor(page).getByText(H1).click();
      await page.keyboard.type(" Typed after access stopped.");
      await expect(editor(page)).not.toContainText("Typed after access stopped.");
      await expectNoActiveAccess(owner!.page);
    });

    await test.step("the restored document and the stopped access survive the owner's restart", async () => {
      await owner!.close();
      owner = undefined;
      owner = await launch(ownerTemp);
      await openWorkspaceFromFirstRun(owner.page, ownerTemp);
      await waitForCliEndpoint(ownerTemp.homeDir);
      await openDocument(owner.page);
      await expect(editor(owner.page)).toContainText(A1);
      await expect(editor(owner.page)).not.toContainText(R1);
      await expect.poll(() => ownerSettled(ownerTemp, [H1, A1], [R1]), { timeout: 30_000 }).toBe(true);
      await expectNoActiveAccess(owner.page);
    });

    for (const app of launches) {
      expect(app.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
      assertDesktopEngineHealthy(app.logs);
    }
  } catch (error) {
    bodyFailure = { error };
    // Attached before cleanup removes the workspace; the report keeps a copy.
    if (lastOwnerViews) {
      await testInfo.attach("last owner CLI and disk views", {
        contentType: "application/json", body: JSON.stringify(lastOwnerViews, null, 2),
      }).catch(() => undefined);
    }
    if (stack) {
      const relay = stack;
      const settlements = (() => {
        try { return relay.settlementEvidence(); }
        catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) }; }
      })();
      await testInfo.attach("server settlements", { contentType: "application/json", body: JSON.stringify(settlements, null, 2) })
        .catch(() => undefined);
      await testInfo.attach("relay output", { contentType: "text/plain", body: relay.relayOutput() })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      recipientBrowser?.close(), ownerBrowser?.close(), recipient?.close(), owner?.close(),
    ]);
    trust?.restore();
    cleanup.push(...await Promise.allSettled([stack?.close()]));
    cleanup.push(...await Promise.allSettled([recipientTemp.cleanup(), ownerTemp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      const errors = [...new Set([...(bodyFailure ? [bodyFailure.error] : []), ...failures.map(result => result.reason)])];
      if (bodyFailure && errors.length === 1) throw bodyFailure.error;
      throw new AggregateError(errors, "Shared continuity cleanup failed.");
    }
  }
});
