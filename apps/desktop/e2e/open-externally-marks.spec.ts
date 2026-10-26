import { expect, test, type BrowserContext, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin, settingsNavPin } from "../src/testPins";
import { RelayFilePeer } from "../src/testing/relayFilePeer";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { withEngineDb } from "./helpers/engineDb";
import { claimRelayWorkspace, relayJson } from "./helpers/relayPeer";
import { approveDesktop, createVerifiedAccount, openDesktopApproval, startSelfHostOnboardingStack, trustFixtureCa } from "./helpers/selfHostOnboarding";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  activeWorkspace,
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedCloudCredentials,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "./helpers/workspace";

// Open externally on files someone shared with the person, through a real
// relay and the real app. The system's opener is replaced by a recorder, so
// no file ever reaches the OS. The first two cases run without a live host,
// so the note shows its saved file. The last runs the self-hosted stack, so
// the note is open in a live editing session.

const GRANTER_TOKEN = "test:e2e-granter";
const RECIPIENT_TOKEN = "test:e2e-recipient";
const RECIPIENT_EMAIL = "e2e-recipient@dohc.test";
const NOTE = "docs/notes.md";
const DATA = "docs/data.bin";
const NOTE_TEXT = "# Notes\n\nThe first draft.\n";
const DATA_TEXT = "data bytes\n";
// Linux has no download mark.
const MARKS = process.platform === "win32" || process.platform === "darwin";

type Bridge = Pick<DohcDesktopBridge,
  | "getWorkspaceRegistry" | "openFileExternally" | "refreshSharedView" | "submitShareChanges" | "onWorkspaceActivity"
  | "createRelayShare" | "listOwnerLiveDocuments" | "listShareProposals" | "listNotices" | "getSyncStatus">;
type Received = { temp: TempWorkspace; app: ElectronApplication; page: Page };

async function hasMark(path: string): Promise<boolean> {
  if (process.platform === "win32") {
    const stream = await readFile(`${path}:Zone.Identifier`, "utf8").catch(() => null);
    return stream !== null && /^ZoneId=3\r?$/m.test(stream);
  }
  if (process.platform === "darwin") {
    const read = await promisify(execFile)("/usr/bin/xattr", ["-p", "com.apple.quarantine", path]).catch(() => null);
    return read !== null && /^0081;/.test(read.stdout);
  }
  return false;
}

// Replaces the system's opener with a recorder, and proves it is in place.
async function recordSystemOpens(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    const recorder = async (path: string) => {
      opened.push(path);
      return "";
    };
    Reflect.set(globalThis, "systemOpens", { opened, recorder });
    shell.openPath = recorder;
  });
  const inPlace = await app.evaluate(({ shell }) =>
    shell.openPath === (Reflect.get(globalThis, "systemOpens") as { recorder: unknown }).recorder);
  expect(inPlace, "the system's opener is replaced before anything is opened").toBe(true);
}

function systemOpens(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => [...(Reflect.get(globalThis, "systemOpens") as { opened: string[] }).opened]);
}

// The same call every Open externally control makes.
function openExternally(page: Page, relativePath: string): Promise<void> {
  return page.evaluate(async (relativePath) => {
    const api = (window as unknown as { dohcDesktop: Bridge }).dohcDesktop;
    const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
    await api.openFileExternally({ workspaceId, relativePath });
  }, relativePath);
}

// Send changes captures the view's files before it sends. A refresh runs that
// same capture, then pulls, and sends nothing.
function refresh(page: Page) {
  return page.evaluate(async () => {
    const api = (window as unknown as { dohcDesktop: Bridge }).dohcDesktop;
    const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
    return api.refreshSharedView({ workspaceId, trigger: "manual" });
  });
}

// Send changes itself: the settle, then an offer of whatever it found. The
// live case's stack refuses every offer, so nothing can reach the owner.
function settle(page: Page) {
  return page.evaluate(async () => {
    const api = (window as unknown as { dohcDesktop: Bridge }).dohcDesktop;
    const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
    return api.submitShareChanges({ workspaceId });
  });
}

// What the view says it holds to send.
function unconfirmedChanges(page: Page) {
  return page.evaluate(async () => {
    const api = (window as unknown as { dohcDesktop: Bridge }).dohcDesktop;
    return (await api.getWorkspaceRegistry()).workspaces[0]!.shareView?.unconfirmedChanges ?? null;
  });
}

// Every path the window hears changed from now on, from file observation or capture.
async function recordObservedPaths(page: Page): Promise<void> {
  await page.evaluate(() => {
    const observed: string[] = [];
    Reflect.set(window, "observedPaths", observed);
    (window as unknown as { dohcDesktop: Bridge }).dohcDesktop
      .onWorkspaceActivity((event) => observed.push(...(event.paths ?? [])));
  });
}

async function unobserved(page: Page, paths: string[]): Promise<string[]> {
  const observed = await page.evaluate(() => [...(Reflect.get(window, "observedPaths") as string[])]);
  return paths.filter((path) => !observed.includes(path));
}

// History moments for both files, and the changes this workspace's journal holds to send.
function engineCounts(rootPath: string) {
  return withEngineDb(rootPath, (db) => ({
    moments: db.prepare("SELECT moment_order, path, operation, metadata_origin FROM moments WHERE path IN (?, ?) ORDER BY moment_order")
      .all(NOTE, DATA),
    toSend: Number(db.prepare("SELECT COUNT(*) AS n FROM replication_log WHERE imported = 0").get()?.n ?? 0),
  }));
}

// Notices holds no row. It opens to look, and closes again. A row fails the
// test with the stored notices' details, and the checks after it still run.
async function expectNoNotices(page: Page): Promise<void> {
  const center = page.getByTestId("notice-center");
  const toggle = page.getByTestId("notice-center-toggle");
  if (await center.count() === 0) await toggle.click();
  await expect(center).toBeVisible();
  const rows = await center.locator("[data-notice-row]").allTextContents();
  const stored = rows.length === 0 ? "" : JSON.stringify(await page.evaluate(() =>
    (window as unknown as { dohcDesktop: Bridge }).dohcDesktop.listNotices({})));
  expect.soft(rows, `Notices holds no row. Stored: ${stored}`).toEqual([]);
  await toggle.click();
  await expect(center).toHaveCount(0);
}

function samePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function withReceivedShare(access: "edit" | "view", run: (received: Received) => Promise<void>): Promise<void> {
  const temp = await createTempWorkspace();
  const workspaceId = `open-externally-${access}-e2e`;
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    await new RelayFilePeer({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId }).writeTextFiles([
      { path: NOTE, text: NOTE_TEXT },
      { path: DATA, text: DATA_TEXT },
    ]);
    const create = await relayJson(relay.baseUrl, GRANTER_TOKEN, `/sync/${workspaceId}/shares`, {
      method: "POST",
      body: JSON.stringify({ recipientEmail: RECIPIENT_EMAIL, paths: ["docs"], access }),
    });
    expect(create.status).toBe(200);
    const shareId = (JSON.parse(create.body) as { shareId: string }).shareId;
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: RECIPIENT_EMAIL,
      userId: "e2e-recipient",
      token: RECIPIENT_TOKEN,
    });

    desktop = await launchDesktopApp({ workspace: temp });
    const { app, page } = desktop;
    await recordSystemOpens(app);
    await page.getByTestId("first-run-open-share").click();
    await page.getByTestId("open-share-code").fill(`dohc-share:${shareId}:${relay.baseUrl}`);
    await page.getByTestId("open-share-choose-folder").click();
    await expect(page.getByTestId("open-shared-view")).toContainText(temp.rootPath);
    await page.getByTestId("open-share-start").click();
    await expect(page.getByTestId("workspace-shell")).toBeVisible();
    await run({ temp, app, page });
  } finally {
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
}

test("a file from another person opens in place, and the mark changes nothing in dohc @open-externally-marks", async () => {
  test.setTimeout(300_000);
  await withReceivedShare("edit", async ({ temp, app, page }) => {
    await expect(page.getByTestId("share-changes-send")).toBeVisible();
    await revealExplorerPath(page, NOTE);
    await explorerRow(page, NOTE).click();
    const note = page.getByTestId("file-inspector");
    await expect(note).toContainText("The first draft.");

    // Everything opening the view and the note did has settled.
    expect(await refresh(page)).toMatchObject({ ok: true });
    const before = engineCounts(temp.rootPath);
    expect(before?.moments.length, "History holds both files").toBeGreaterThan(0);
    await expectNoNotices(page);

    for (const path of [NOTE, DATA]) await openExternally(page, path);
    const originals = await Promise.all([NOTE, DATA].map((path) => realpath(join(temp.rootPath, path))));
    expect((await systemOpens(app)).map(samePath)).toEqual(originals.map(samePath));
    for (const original of originals) expect(await hasMark(original)).toBe(MARKS);
    expect(await readFile(originals[0]!, "utf8")).toBe(NOTE_TEXT);
    expect(await readFile(originals[1]!, "utf8")).toBe(DATA_TEXT);

    expect(await refresh(page)).toMatchObject({ ok: true, changedPaths: 0 });
    expect(engineCounts(temp.rootPath)).toEqual(before);
    await expect(page.getByTestId("changed-outside-notice")).toHaveCount(0);
    await expect(note).toContainText("The first draft.");
    await expectNoNotices(page);
  });
});

test("a file from another person that the person can only view opens as a marked, read-only copy @open-externally-marks", async () => {
  test.setTimeout(300_000);
  await withReceivedShare("view", async ({ temp, app, page }) => {
    await revealExplorerPath(page, DATA);
    await expectNoNotices(page);
    await openExternally(page, DATA);
    const opened = await systemOpens(app);
    expect(opened).toHaveLength(1);
    const copy = opened[0]!;
    const inCopies = relative(await realpath(join(temp.homeDir, "opened")), await realpath(copy));
    expect(inCopies.startsWith("..") || isAbsolute(inCopies), `${copy} is in the profile's opened folder`).toBe(false);
    expect(basename(copy)).toBe("data.bin");
    expect(await readFile(copy, "utf8")).toBe(DATA_TEXT);
    expect(await hasMark(copy)).toBe(MARKS);
    expect((await stat(copy)).mode & 0o222).toBe(0);
    expect(await hasMark(join(temp.rootPath, DATA))).toBe(false);
    await expectNoNotices(page);
  });
});

test("a file from another person opens in place during a live editing session, and the mark changes nothing in dohc @open-externally-marks", async ({ browser }, testInfo) => {
  test.skip(!process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1", "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");
  test.setTimeout(600_000);
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  const recipientTemp = await createTempWorkspace();
  const ownerAccount = { email: `owner-${randomUUID()}@example.test`, password: `Owner-proof-${randomUUID()}` };
  const recipientAccount = { email: `recipient-${randomUUID()}@example.test`, password: `Recipient-proof-${randomUUID()}` };
  // Every request that would offer the recipient's changes to the owner.
  const offered: string[] = [];
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let ownerBrowser: BrowserContext | undefined;
  let recipientBrowser: BrowserContext | undefined;
  let owner: LaunchedDesktopApp | undefined;
  let recipient: LaunchedDesktopApp | undefined;
  let bodyFailure: { error: unknown } | undefined;
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, {
      live: true, signal,
      refuse: (method, path) => {
        const offer = method !== "GET" && /^\/sync\/shares\/[^/]+\/(proposals|blobs\/)/u.test(path);
        if (offer) offered.push(`${method} ${path}`);
        return offer;
      },
    });
    const origin = stack.relayUrl;
    trust = trustFixtureCa(stack.ca!.ca);
    ownerBrowser = await browser.newContext();
    await trust.route(ownerBrowser, origin);
    recipientBrowser = await browser.newContext();
    await trust.route(recipientBrowser, origin);
    const recipientApproval = await recipientBrowser.newPage();
    // The owner can share only with an account the server knows.
    await createVerifiedAccount(recipientApproval, stack.account, recipientAccount);

    // The owner connects a workspace, opens the note, and shares the folder with Edit.
    await writeWorkspaceFiles(ownerTemp, [{ path: NOTE, contents: NOTE_TEXT }, { path: DATA, contents: DATA_TEXT }]);
    owner = await launchDesktopApp({ workspace: ownerTemp, env: stack.trustEnv });
    await recordSystemOpens(owner.app);
    const ownerPage = owner.page;
    const ownerWorkspaceId = (await openWorkspaceFromFirstRun(ownerPage, ownerTemp)).workspaceId;
    await ownerPage.getByTestId(activityPin("settings")).click();
    await ownerPage.getByTestId(settingsNavPin("cloud")).click();
    await ownerPage.getByTestId("settings-cloud-connect").click();
    await expect(ownerPage.getByTestId("cloud-sync-panel")).toBeVisible();
    const ownerApproval = await ownerBrowser.newPage();
    const approval = await openDesktopApproval(owner, ownerApproval, origin);
    await createVerifiedAccount(ownerApproval, stack.account, ownerAccount, approval);
    await approveDesktop(ownerApproval, ownerAccount);
    await expect(ownerPage.getByTestId("settings-row-account")).toContainText(ownerAccount.email);
    const syncSwitch = ownerPage.getByRole("switch", { name: "Sync this workspace" });
    await syncSwitch.click();
    await expect(ownerPage.getByTestId("cloud-sync-code")).toBeVisible();
    await expect(syncSwitch).toHaveAttribute("aria-checked", "true");
    await ownerPage.keyboard.press("Escape");
    for (const path of [NOTE, DATA]) await waitForWorkspaceFile(ownerPage, ownerWorkspaceId, path);
    await revealExplorerPath(ownerPage, NOTE);
    await explorerRow(ownerPage, NOTE).click();
    await expect(ownerPage.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 30_000 });
    await expect(ownerPage.getByTestId("markdown-editor")).toContainText("The first draft.");
    const share = await ownerPage.evaluate(({ workspaceId, recipientEmail }) =>
      (window as unknown as { dohcDesktop: Bridge }).dohcDesktop.createRelayShare({ workspaceId, recipientEmail, paths: ["docs"], access: "edit" }),
    { workspaceId: ownerWorkspaceId, recipientEmail: recipientAccount.email });
    const liveStatus = () => ownerPage.evaluate(async ({ workspaceId, path }) =>
      (await (window as unknown as { dohcDesktop: Bridge }).dohcDesktop.listOwnerLiveDocuments({ workspaceId }))
        .documents.find((document) => document.path === path)?.status, { workspaceId: ownerWorkspaceId, path: NOTE });
    await expect.poll(liveStatus, { message: "The server hosts the note live.", timeout: 120_000, intervals: [1_000] }).toBe("ready");
    const proposals = () => ownerPage.evaluate(async (workspaceId) =>
      (await (window as unknown as { dohcDesktop: Bridge }).dohcDesktop.listShareProposals({ workspaceId })).proposals, ownerWorkspaceId);

    // The recipient opens the share on their own desktop, and the note in a live session.
    recipient = await launchDesktopApp({ workspace: recipientTemp, env: stack.trustEnv });
    await recordSystemOpens(recipient.app);
    const page = recipient.page;
    await page.getByTestId("first-run-open-share").click();
    await page.getByTestId("open-share-code").fill(share.shareCode);
    await page.getByTestId("open-share-choose-folder").click();
    // Opening without an account asks the person to connect one first.
    await page.getByTestId("open-share-start").click();
    await openDesktopApproval(recipient, recipientApproval, origin);
    await approveDesktop(recipientApproval, recipientAccount);
    await expect(page.locator("#open-share-sign-in-description")).toHaveCount(0, { timeout: 60_000 });
    const open = page.getByTestId("open-share-start");
    await expect(open).toHaveText("Open share");
    await expect(open).toBeEnabled();
    await open.click();
    await expect(page.getByTestId("shared-view-banner")).toBeVisible({ timeout: 60_000 });
    const view = await activeWorkspace(page, recipientTemp.rootPath);
    for (const path of [NOTE, DATA]) await waitForWorkspaceFile(page, view.workspaceId, path);
    await expect(page.getByTestId("share-changes-send")).toBeVisible();
    await revealExplorerPath(page, NOTE);
    await explorerRow(page, NOTE).click();
    // The session is live: the saved file's Edit toggle is gone, and the live editor takes edits.
    await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true");
    await expect(page.getByTestId("markdown-editor")).toContainText("The first draft.");
    expect(await liveStatus()).toBe("ready");

    // Everything opening the view and the note did has settled on both sides.
    await expect.poll(() => ownerPage.evaluate(async (workspaceId) =>
      (await (window as unknown as { dohcDesktop: Bridge }).dohcDesktop.getSyncStatus({ workspaceId })).ownerLiveDelivery, ownerWorkspaceId),
    { message: "The owner's live editing is active.", timeout: 120_000, intervals: [1_000] }).toBe("active");
    expect(await refresh(page)).toMatchObject({ ok: true });
    expect(await settle(page)).toMatchObject({ ok: true, capturedLocalChanges: 0, submitted: 0 });
    const before = {
      recipient: engineCounts(recipientTemp.rootPath),
      unconfirmed: await unconfirmedChanges(page),
      owner: engineCounts(ownerTemp.rootPath)?.moments,
    };
    expect(before.recipient?.moments.length, "the recipient's History holds both files").toBeGreaterThan(0);
    expect(before.owner?.length, "the owner's History holds both files").toBeGreaterThan(0);
    expect(await proposals()).toEqual([]);
    await expectNoNotices(page);
    await expectNoNotices(ownerPage);

    await recordObservedPaths(page);
    for (const path of [NOTE, DATA]) await openExternally(page, path);
    const originals = await Promise.all([NOTE, DATA].map((path) => realpath(join(recipientTemp.rootPath, path))));
    expect((await systemOpens(recipient.app)).map(samePath)).toEqual(originals.map(samePath));
    expect(await systemOpens(owner.app)).toEqual([]);
    for (const original of originals) expect(await hasMark(original)).toBe(MARKS);
    expect(await readFile(originals[0]!, "utf8")).toBe(NOTE_TEXT);
    expect(await readFile(originals[1]!, "utf8")).toBe(DATA_TEXT);

    // dohc has observed both marked files. Then everything Send changes runs, short of sending.
    if (MARKS) {
      await expect.poll(() => unobserved(page, [NOTE, DATA]), { message: "dohc observed both marked files.", timeout: 60_000 }).toEqual([]);
    }
    expect(await refresh(page)).toMatchObject({ ok: true, changedPaths: 0 });
    expect(await settle(page)).toMatchObject({ ok: true, capturedLocalChanges: 0, submitted: 0 });

    expect(engineCounts(recipientTemp.rootPath)).toEqual(before.recipient);
    expect(await unconfirmedChanges(page)).toEqual(before.unconfirmed);
    expect(offered).toEqual([]);
    expect(engineCounts(ownerTemp.rootPath)?.moments).toEqual(before.owner);
    expect(await proposals()).toEqual([]);
    expect(await readFile(join(ownerTemp.rootPath, NOTE), "utf8")).toBe(NOTE_TEXT);
    expect(await readFile(join(ownerTemp.rootPath, DATA), "utf8")).toBe(DATA_TEXT);
    for (const side of [page, ownerPage]) {
      await expect(side.getByTestId("changed-outside-notice")).toHaveCount(0);
      // A calm live session may draw no save state at all.
      await expect(side.locator('[data-testid="markdown-save-state"][data-state="changed-on-disk"]')).toHaveCount(0);
      await expect(side.getByTestId("markdown-editor")).toContainText("The first draft.");
      await expect(side.getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true");
      await expectNoNotices(side);
    }
  } catch (error) {
    bodyFailure = { error };
    if (stack) {
      await testInfo.attach("relay output", { contentType: "text/plain", body: stack.relayOutput() }).catch(() => undefined);
    }
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([recipientBrowser?.close(), ownerBrowser?.close(), recipient?.close(), owner?.close()]);
    trust?.restore();
    cleanup.push(...await Promise.allSettled([stack?.close()]));
    cleanup.push(...await Promise.allSettled([recipientTemp.cleanup(), ownerTemp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      const errors = [...new Set([...(bodyFailure ? [bodyFailure.error] : []), ...failures.map((result) => result.reason)])];
      if (bodyFailure && errors.length === 1) throw bodyFailure.error;
      throw new AggregateError(errors, "Open externally cleanup failed.");
    }
  }
});
