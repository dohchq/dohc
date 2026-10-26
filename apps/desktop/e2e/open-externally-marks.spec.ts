import { expect, test, type BrowserContext, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
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
// relay and the real app. Each file opens as a marked, read-only copy in the
// profile's opened folder, whatever the share's access, and its original
// stays unmarked and unchanged. The system's opener is replaced by a
// recorder, so no file ever reaches the OS. The first two cases run without
// a live host, so the note shows its saved file. The last runs the
// self-hosted stack, so the note is open in a live editing session.

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
  | "getWorkspaceRegistry" | "openFileExternally" | "refreshSharedView" | "submitShareChanges"
  | "createRelayShare" | "listOwnerLiveDocuments" | "listShareProposals" | "listNotices" | "getSyncStatus" | "onWorkspaceActivity">;
type Received = { temp: TempWorkspace; app: ElectronApplication; page: Page };
type LiveDelivery = Awaited<ReturnType<Bridge["getSyncStatus"]>>["ownerLiveDelivery"];
// One read of the owner's live editing, and when it was asked for.
type LiveEditingRead = { requestedAt: number; state: LiveDelivery | null | "unread"; reason: string | null };

// Each stretch in which the owner's live editing was not active, from the
// read that saw it leave to the read that saw it back, in ms from `from`.
function departureWindows(reads: LiveEditingRead[], from: number) {
  const windows: { from: number; to: number | null; states: LiveEditingRead["state"][]; reasons: string[] }[] = [];
  for (const read of reads) {
    const last = windows.at(-1);
    const open = last?.to === null ? last : undefined;
    if (read.state === "active") {
      if (open) open.to = read.requestedAt - from;
      continue;
    }
    const stretch = open ?? { from: read.requestedAt - from, to: null, states: [], reasons: [] };
    if (!open) windows.push(stretch);
    if (!stretch.states.includes(read.state)) stretch.states.push(read.state);
    if (read.reason !== null && !stretch.reasons.includes(read.reason)) stretch.reasons.push(read.reason);
  }
  return windows;
}

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

// Each opened path is a marked, read-only copy of its original, in order, in
// the profile's opened folder. Each original is unmarked and unchanged.
async function expectCopies(opened: string[], homeDir: string, originals: { path: string; text: string }[]): Promise<void> {
  expect(opened).toHaveLength(originals.length);
  const folder = await realpath(join(homeDir, "opened"));
  for (const [index, original] of originals.entries()) {
    const copy = opened[index]!;
    const inCopies = relative(folder, await realpath(copy));
    expect(inCopies.startsWith("..") || isAbsolute(inCopies), `${copy} is in the profile's opened folder`).toBe(false);
    expect(basename(copy)).toBe(basename(original.path));
    expect(await readFile(copy, "utf8")).toBe(original.text);
    expect(await hasMark(copy)).toBe(MARKS);
    expect((await stat(copy)).mode & 0o222).toBe(0);
    expect(await hasMark(original.path)).toBe(false);
    expect(await readFile(original.path, "utf8")).toBe(original.text);
  }
}

// History moments for both files, and the changes this workspace's journal holds to send.
function engineCounts(rootPath: string) {
  return withEngineDb(rootPath, (db) => ({
    moments: db.prepare("SELECT moment_order, recorded_at_ms, path, operation, metadata_origin FROM moments WHERE path IN (?, ?) ORDER BY moment_order")
      .all(NOTE, DATA),
    toSend: Number(db.prepare("SELECT COUNT(*) AS n FROM replication_log WHERE imported = 0").get()?.n ?? 0),
  }));
}

type NoticesRow = { id: string; kind: string | null; title: string; body: string; detail: string | null };

// Every row Notices shows. A row's ID ends with its stored notice's, if it has
// one, which gives its kind and detail. Any other row has no kind, and its
// detail is what its Copy writes, caught before it reaches the clipboard.
// Notices opens to look, and closes again.
async function noticesRows(page: Page): Promise<NoticesRow[]> {
  const center = page.getByTestId("notice-center");
  const toggle = page.getByTestId("notice-center-toggle");
  if (await center.count() === 0) await toggle.click();
  await expect(center).toBeVisible();
  const rows = await page.evaluate(async () => {
    const stored = (await (window as unknown as { dohcDesktop: Bridge }).dohcDesktop.listNotices({})).notices;
    const clipboard = navigator.clipboard;
    const write = clipboard.writeText;
    const copied = { text: null as string | null };
    clipboard.writeText = async (text) => { copied.text = text; };
    try {
      return [...document.querySelectorAll<HTMLElement>('[data-testid="notice-center"] [data-notice-row]')].map((row) => {
        const id = row.dataset.testid ?? "";
        const notice = stored.find((notice) => id.endsWith(`-${notice.noticeId}`));
        copied.text = null;
        if (!notice) [...row.querySelectorAll<HTMLButtonElement>("button[data-testid]")].find((button) => button.dataset.testid === `${id}-copy`)?.click();
        return {
          id,
          kind: notice?.kind ?? null,
          title: row.querySelector('[id$="-title"]')?.textContent ?? "",
          body: row.querySelector('[id$="-body"]')?.textContent ?? "",
          detail: notice ? notice.detail ?? null : copied.text,
        };
      });
    } finally {
      clipboard.writeText = write;
    }
  });
  await toggle.click();
  await expect(center).toHaveCount(0);
  return rows;
}

// Notices holds no row the baseline did not hold as it is: a new ID, or a
// changed kind, title, body or detail. The rows on both sides are attached,
// and the checks after a new row still run.
async function expectNoNewNotices(page: Page, side: string, baseline: NoticesRow[]): Promise<void> {
  const now = await noticesRows(page);
  const held = new Set(baseline.map((row) => JSON.stringify(row)));
  const added = now.filter((row) => !held.has(JSON.stringify(row)));
  await test.info().attach(`${side} Notices`, { contentType: "application/json", body: JSON.stringify({ baseline, added }, null, 2) });
  expect.soft(added, `Notices on the ${side}'s side holds no new row`).toEqual([]);
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

test("a file from another person that the person can edit opens as a marked, read-only copy, and changes nothing in dohc @open-externally-marks", async () => {
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
    const notices = await noticesRows(page);

    await openExternally(page, NOTE);
    // The data file's view can't preview it, so it offers Open externally,
    // with a lock and "Read-only copy" after it on the same line.
    await explorerRow(page, DATA).click();
    const control = page.getByTestId("view-binary").getByRole("button", { name: "Open externally", exact: true });
    const words = page.getByTestId("view-binary").getByText("Read-only copy", { exact: true });
    const lock = words.locator("xpath=preceding-sibling::*[1]");
    await expect(words).toBeVisible();
    await expect(control).toHaveAccessibleDescription("Read-only copy");
    const [controlBox, lockBox, wordsBox] = [await control.boundingBox(), await lock.boundingBox(), await words.boundingBox()];
    expect(Math.abs(lockBox!.x - (controlBox!.x + controlBox!.width) - 8), "the lock follows the control, 8 px away").toBeLessThan(1);
    expect(Math.abs(wordsBox!.x - (lockBox!.x + lockBox!.width) - 4), "the words follow the lock, 4 px away").toBeLessThan(1);
    expect(Math.abs(wordsBox!.y + wordsBox!.height / 2 - (controlBox!.y + controlBox!.height / 2)), "on the same line").toBeLessThan(2);
    await control.click();
    await expect.poll(async () => (await systemOpens(app)).length).toBe(2);
    await expectCopies(await systemOpens(app), temp.homeDir, [
      { path: await realpath(join(temp.rootPath, NOTE)), text: NOTE_TEXT },
      { path: await realpath(join(temp.rootPath, DATA)), text: DATA_TEXT },
    ]);
    await explorerRow(page, NOTE).click();
    await expect(note).toContainText("The first draft.");

    expect(await refresh(page)).toMatchObject({ ok: true, changedPaths: 0 });
    expect(engineCounts(temp.rootPath)).toEqual(before);
    await expect(page.getByTestId("changed-outside-notice")).toHaveCount(0);
    await expect(note).toContainText("The first draft.");
    await expectNoNewNotices(page, "recipient", notices);
  });
});

test("a file from another person that the person can only view opens as a marked, read-only copy @open-externally-marks", async () => {
  test.setTimeout(300_000);
  await withReceivedShare("view", async ({ temp, app, page }) => {
    await revealExplorerPath(page, DATA);
    const notices = await noticesRows(page);
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
    await expectNoNewNotices(page, "recipient", notices);
  });
});

test("a file from another person opens as a marked, read-only copy during a live editing session, and changes nothing in dohc @open-externally-marks", async ({ browser }, testInfo) => {
  test.skip(!process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1", "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");
  test.setTimeout(600_000);
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  const recipientTemp = await createTempWorkspace();
  const ownerAccount = { email: `owner-${randomUUID()}@example.test`, password: `Owner-proof-${randomUUID()}` };
  const recipientAccount = { email: `recipient-${randomUUID()}@example.test`, password: `Recipient-proof-${randomUUID()}` };
  // Every request that would offer the recipient's changes to the owner.
  const offered: string[] = [];
  // The owner's live editing at the baseline, and at the end, when the first
  // open began, and how often the baseline was taken again.
  const delivery: { baseline?: LiveDelivery; end?: LiveDelivery; firstOpenAt?: number; baselineRetakes: number } = { baselineRetakes: 0 };
  let liveEditingReads: (() => Promise<LiveEditingRead[]>) | undefined;
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

    // A quiet live session can go retrying by itself (#2685), so the baseline
    // waits for active, and each time it leaves active is recorded.
    await ownerPage.evaluate((workspaceId) => {
      const api = (window as unknown as { dohcDesktop: Bridge }).dohcDesktop;
      const reads: LiveEditingRead[] = [];
      const pending = new Set<Promise<void>>();
      const read = () => {
        const requestedAt = Date.now();
        const done: Promise<void> = api.getSyncStatus({ workspaceId }).then(
          (status) => { reads.push({ requestedAt, state: status.ownerLiveDelivery ?? null, reason: status.ownerLiveDeliveryReason ?? null }); },
          () => { reads.push({ requestedAt, state: "unread", reason: null }); },
        ).finally(() => pending.delete(done));
        pending.add(done);
      };
      api.onWorkspaceActivity((event) => {
        if (event.workspaceId === undefined || event.workspaceId === workspaceId) read();
      });
      read();
      Reflect.set(window, "ownerLiveEditing", { reads, pending });
    }, ownerWorkspaceId);
    // Every read asked for so far, once each has answered, in the order asked.
    liveEditingReads = () => ownerPage.evaluate(async () => {
      const { reads, pending } = Reflect.get(window, "ownerLiveEditing") as { reads: LiveEditingRead[]; pending: Set<Promise<void>> };
      while (pending.size) await Promise.all(pending);
      return [...reads].sort((a, b) => a.requestedAt - b.requestedAt);
    });
    const liveDelivery = () => ownerPage.evaluate(async (workspaceId) =>
      (await (window as unknown as { dohcDesktop: Bridge }).dohcDesktop.getSyncStatus({ workspaceId })).ownerLiveDelivery, ownerWorkspaceId);
    // What the opens must leave as it was: both sides' History, what the view
    // holds to send, and the owner's proposals.
    const unchanged = async () => ({
      recipient: engineCounts(recipientTemp.rootPath),
      unconfirmed: await unconfirmedChanges(page),
      owner: engineCounts(ownerTemp.rootPath)?.moments,
      proposals: await proposals(),
    });

    // Everything opening the view and the note did has settled on both sides.
    expect(await refresh(page)).toMatchObject({ ok: true });
    expect(await settle(page)).toMatchObject({ ok: true, capturedLocalChanges: 0, submitted: 0 });
    // The baseline counts only if the owner's live editing stayed active while
    // it was taken, and nothing in it changed before the first open.
    let before: Awaited<ReturnType<typeof unchanged>>;
    let notices: Record<"recipient" | "owner", NoticesRow[]>;
    for (;;) {
      signal.throwIfAborted();
      await expect.poll(liveDelivery, { message: "The owner's live editing is active before the baseline.", timeout: 120_000, intervals: [1_000] }).toBe("active");
      const baselineAt = Date.now();
      before = await unchanged();
      notices = { recipient: await noticesRows(page), owner: await noticesRows(ownerPage) };
      delivery.baseline = await liveDelivery();
      const left = (await liveEditingReads()).some((read) => read.requestedAt >= baselineAt && read.state !== "active");
      if (delivery.baseline === "active" && !left && isDeepStrictEqual(await unchanged(), before)) break;
      delivery.baselineRetakes += 1;
    }
    expect(before.recipient?.moments.length, "the recipient's History holds both files").toBeGreaterThan(0);
    expect(before.owner?.length, "the owner's History holds both files").toBeGreaterThan(0);
    expect(before.proposals).toEqual([]);

    delivery.firstOpenAt = Date.now();
    for (const path of [NOTE, DATA]) await openExternally(page, path);
    await expectCopies(await systemOpens(recipient.app), recipientTemp.homeDir, [
      { path: await realpath(join(recipientTemp.rootPath, NOTE)), text: NOTE_TEXT },
      { path: await realpath(join(recipientTemp.rootPath, DATA)), text: DATA_TEXT },
    ]);
    expect(await systemOpens(owner.app)).toEqual([]);

    // Everything Send changes runs, short of sending.
    expect(await refresh(page)).toMatchObject({ ok: true, changedPaths: 0 });
    expect(await settle(page)).toMatchObject({ ok: true, capturedLocalChanges: 0, submitted: 0 });

    expect(offered).toEqual([]);
    expect(await unchanged()).toEqual(before);
    expect(await readFile(join(ownerTemp.rootPath, NOTE), "utf8")).toBe(NOTE_TEXT);
    expect(await readFile(join(ownerTemp.rootPath, DATA), "utf8")).toBe(DATA_TEXT);
    const sides = [["recipient", page], ["owner", ownerPage]] as const;
    for (const [, side] of sides) {
      await expect(side.getByTestId("changed-outside-notice")).toHaveCount(0);
      // A calm live session may draw no save state at all.
      await expect(side.locator('[data-testid="markdown-save-state"][data-state="changed-on-disk"]')).toHaveCount(0);
      await expect(side.getByTestId("markdown-editor")).toContainText("The first draft.");
      await expect(side.getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true");
    }
    await expect.poll(liveDelivery, { message: "The owner's live editing is active again before Notices is read.", timeout: 120_000, intervals: [1_000] }).toBe("active");
    for (const [name, side] of sides) await expectNoNewNotices(side, name, notices[name]);
    delivery.end = await liveDelivery();
    expect(delivery.end, "The owner's live editing is active at the end.").toBe("active");
  } catch (error) {
    bodyFailure = { error };
    throw error;
  } finally {
    await testInfo.attach("owner live editing", { contentType: "application/json", body: JSON.stringify(delivery) }).catch(() => undefined);
    const reads = await liveEditingReads?.().catch(() => undefined);
    await testInfo.attach("owner live editing reads", { contentType: "application/json", body: JSON.stringify(reads ?? null, null, 2) }).catch(() => undefined);
    const windows = reads && delivery.firstOpenAt !== undefined ? departureWindows(reads, delivery.firstOpenAt) : null;
    await testInfo.attach("owner live editing departures, ms from the first open", { contentType: "application/json", body: JSON.stringify(windows, null, 2) }).catch(() => undefined);
    if (stack) {
      await testInfo.attach("relay output", { contentType: "text/plain", body: stack.relayOutput() }).catch(() => undefined);
    }
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
