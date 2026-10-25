import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { RelayFilePeer } from "../src/testing/relayFilePeer";
import { launchDesktopApp } from "./helpers/desktopApp";
import { withEngineDb } from "./helpers/engineDb";
import { claimRelayWorkspace, relayJson } from "./helpers/relayPeer";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  revealExplorerPath,
  seedCloudCredentials,
  type TempWorkspace,
} from "./helpers/workspace";

// Open externally on files someone shared with the person, through a real
// relay and the real app. The system's opener is replaced by a recorder, so
// no file ever reaches the OS. No live host runs, so the note shows its saved
// file rather than a live session.

const GRANTER_TOKEN = "test:e2e-granter";
const RECIPIENT_TOKEN = "test:e2e-recipient";
const RECIPIENT_EMAIL = "e2e-recipient@dohc.test";
const NOTE = "docs/notes.md";
const DATA = "docs/data.bin";
const NOTE_TEXT = "# Notes\n\nThe first draft.\n";
const DATA_TEXT = "data bytes\n";
// Linux has no download mark.
const MARKS = process.platform === "win32" || process.platform === "darwin";

type Bridge = Pick<DohcDesktopBridge, "getWorkspaceRegistry" | "openFileExternally" | "refreshSharedView">;
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

// History moments for both files, and the changes this view's journal holds to send.
function engineCounts(rootPath: string) {
  return withEngineDb(rootPath, (db) => ({
    moments: Number(db.prepare("SELECT COUNT(*) AS n FROM moments WHERE path IN (?, ?)").get(NOTE, DATA)?.n ?? 0),
    toSend: Number(db.prepare("SELECT COUNT(*) AS n FROM replication_log WHERE imported = 0").get()?.n ?? 0),
  }));
}

// The text of every row in Notices, which opens if it is closed.
async function noticeRows(page: Page): Promise<string[]> {
  if (await page.getByTestId("notice-center").count() === 0) await page.getByTestId("notice-center-toggle").click();
  await expect(page.getByTestId("notice-center")).toBeVisible();
  return page.getByTestId("notice-center").locator("[data-notice-row]").allTextContents();
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
    expect(before?.moments, "History holds both files").toBeGreaterThan(0);
    const noticesBefore = await noticeRows(page);

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
    const noticesAfter = await noticeRows(page);
    expect(noticesAfter.length, `Notices before: ${noticesBefore.join(" | ")}\nafter: ${noticesAfter.join(" | ")}`)
      .toBe(noticesBefore.length);
  });
});

test("a file from another person that the person can only view opens as a marked, read-only copy @open-externally-marks", async () => {
  test.setTimeout(300_000);
  await withReceivedShare("view", async ({ temp, app, page }) => {
    await revealExplorerPath(page, DATA);
    await openExternally(page, DATA);
    const opened = await systemOpens(app);
    expect(opened).toHaveLength(1);
    const copy = opened[0]!;
    const inCopies = relative(await realpath(join(temp.homeDir, "opened")), copy);
    expect(inCopies.startsWith("..") || isAbsolute(inCopies), `${copy} is in the profile's opened folder`).toBe(false);
    expect(basename(copy)).toBe("data.bin");
    expect(await readFile(copy, "utf8")).toBe(DATA_TEXT);
    expect(await hasMark(copy)).toBe(MARKS);
    expect((await stat(copy)).mode & 0o222).toBe(0);
    expect(await hasMark(join(temp.rootPath, DATA))).toBe(false);
  });
});
