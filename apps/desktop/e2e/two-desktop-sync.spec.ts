import { expect, test, type Page } from "@playwright/test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { openLiveDaemonWorkspace } from "./helpers/daemonSeed";
import { createWorkspaceEngineCapture } from "../src/workspaces/workspaceEngineCapture";
import { waitForPathMoments } from "../src/workspaces/waitForPathMoments";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay } from "./helpers/syncRelay";
import { cleanupDesktopWorkspace, createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, seedCloudCredentials, waitForWorkspaceFile, waitForWorkspaceReady, writeWorkspaceFiles } from "./helpers/workspace";

type Desktop = Awaited<ReturnType<typeof launchDesktopApp>>;
type Workspace = Awaited<ReturnType<typeof createTempWorkspace>>;
type Relay = Awaited<ReturnType<typeof spawnSyncRelay>>;

// A relay workspace holding shared.md, claimed and pushed by a third machine,
// and sign-in credentials for both desktops.
async function seedSharedWorkspace(workspaceId: string, first: Workspace, second: Workspace): Promise<Relay> {
  const relay = await spawnSyncRelay({ dbPath: join(first.baseDir, "relay.sqlite") });
  try {
    const seedRoot = join(first.baseDir, "seed");
    await mkdir(seedRoot);
    const source = await openLiveDaemonWorkspace({ workspaceId, rootPath: seedRoot });
    const capture = createWorkspaceEngineCapture({ ...source.workspace, rustEngineSessions: source.sessions });
    try {
      const remote = source.relay.bind({ ...source.workspace, relay: { baseUrl: relay.baseUrl, token: "test:e2e-user" } });
      await remote.claim();
      await writeFile(join(seedRoot, "shared.md"), "# Shared\n\nStarting together.\n");
      capture.captureBatch([{ path: "shared.md", operation: "update" }]);
      await waitForPathMoments(capture, "shared.md", 1);
      expect((await remote.push()).pushed).toBeGreaterThan(0);
    } finally {
      try { await capture.stop(); } finally { await source.close(); }
    }
    for (const workspace of [first, second]) await seedCloudCredentials(workspace, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, userId: "e2e-user" });
    return relay;
  } catch (error) { await relay.stop(); throw error; }
}

async function joinWorkspace(workspace: Workspace, workspaceId: string, relayUrl: string): Promise<Desktop> {
  const desktop = await launchDesktopApp({ workspace, env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" } });
  try {
    await desktop.page.getByTestId("first-run-join-synced").click();
    await desktop.page.getByTestId("join-sync-code").fill(`dohc-sync:${workspaceId}:${relayUrl}`);
    await desktop.page.getByTestId("join-choose-folder").click();
    await desktop.page.getByTestId("join-workspace-start").click();
    await waitForWorkspaceReady(desktop.page);
    await waitForWorkspaceFile(desktop.page, workspaceId, "shared.md");
    return desktop;
  } catch (error) { await desktop.close(); throw error; }
}

async function syncState(page: Page, workspaceId: string) {
  return page.evaluate(async (workspaceId) => {
    const api = (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop;
    return { sync: await api.getSyncStatus({ workspaceId }), conflicts: await api.listWorkspaceVersionConflicts({ workspaceId }) };
  }, workspaceId);
}

async function logSyncStatus(workspaceId: string, desktops: ReadonlyArray<readonly [string, Desktop | null]>) {
  for (const [name, desktop] of desktops) {
    if (!desktop || desktop.page.isClosed()) continue;
    const status = await syncState(desktop.page, workspaceId).catch((error) => ({ error: String(error) }));
    await test.info().attach(`${name} sync status`, { body: JSON.stringify(status, null, 2), contentType: "application/json" });
    console.log(`[two-client] ${name}: ${JSON.stringify(status)}`);
  }
}

// Open shared.md and wait until the live editor is bound and accepts typing.
async function openLiveDocument(page: Page) {
  await explorerRow(page, "shared.md").click();
  await expect(page.getByTestId("markdown-source-toggle")).toBeVisible();
  await expect(page.getByTestId("markdown-open-state")).toHaveCount(0);
  await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
  await expect(page.getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true");
}

async function typeAtEnd(page: Page, text: string) {
  await page.getByTestId("markdown-editor").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
  await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
}

test("@two-client two desktops resolve conflicting offline edits and keep the chosen text after restart", async () => {
  test.setTimeout(240_000);
  const first = await createTempWorkspace();
  const second = await createTempWorkspace();
  const workspaceId = "two-desktop-proof";
  let left: Desktop | null = null;
  let right: Desktop | null = null;
  let relay: Relay | null = null;
  try {
    relay = await seedSharedWorkspace(workspaceId, first, second);
    left = await joinWorkspace(first, workspaceId, relay.baseUrl);
    right = await joinWorkspace(second, workspaceId, relay.baseUrl);
    expect(left.app.process().pid).not.toBe(right.app.process().pid);
    const relayPort = relay.port;
    const relayDb = relay.dbPath;
    await relay.stop();
    relay = null;
    const leftText = "Chosen text from the first desktop.\n";
    const rightText = "Offline edit from the second desktop.\n";
    async function momentCount(desktop: Desktop) {
      return desktop.page.evaluate(async (workspaceId) => {
        const result = await (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listEngineMoments({ workspaceId, limit: 100 });
        return "moments" in result ? result.moments.filter((entry) => entry.path === "shared.md").length : 0;
      }, workspaceId);
    }
    const beforeLeft = await momentCount(left);
    const beforeRight = await momentCount(right);
    await writeWorkspaceFiles(first, [{ path: "shared.md", contents: leftText }]);
    await writeWorkspaceFiles(second, [{ path: "shared.md", contents: rightText }]);
    await expect.poll(() => momentCount(left!)).toBeGreaterThan(beforeLeft);
    await expect.poll(() => momentCount(right!)).toBeGreaterThan(beforeRight);
    relay = await spawnSyncRelay({ dbPath: relayDb, port: relayPort });
    let receivingRight = true;
    await expect.poll(async () => {
      if (await right!.page.getByTestId("sync-status").getAttribute("data-state") === "conflict") return true;
      if (await left!.page.getByTestId("sync-status").getAttribute("data-state") === "conflict") {
        receivingRight = false;
        return true;
      }
      return false;
    }, { timeout: 90_000 }).toBe(true);
    let receiver = receivingRight ? right : left;
    const receivingWorkspace = receivingRight ? second : first;
    const incomingText = receivingRight ? leftText : rightText;
    await receiver.page.getByTestId("notice-center-toggle").click();
    await receiver.page.getByTestId("notice-sync-conflict").getByRole("button", { name: "Review", exact: true }).click();
    const card = receiver.page.locator('[data-testid="version-conflict"][data-conflict-path="shared.md"]');
    await expect(card).toContainText(leftText.trim());
    await expect(card).toContainText(rightText.trim());
    await card.getByTestId("version-conflict-keep-incoming").click();
    await expect(receiver.page.getByTestId("conflict-review-empty")).toBeVisible();
    await receiver.page.getByTestId("conflict-review-done").click();
    await expect.poll(() => readFile(join(receivingWorkspace.rootPath, "shared.md"), "utf8")).toBe(incomingText);
    await receiver.close();
    if (receivingRight) right = null; else left = null;
    receiver = await launchDesktopApp({ workspace: receivingWorkspace });
    if (receivingRight) right = receiver; else left = receiver;
    await openWorkspaceFromFirstRun(receiver.page, receivingWorkspace);
    await waitForWorkspaceFile(receiver.page, workspaceId, "shared.md");
    await explorerRow(receiver.page, "shared.md").click();
    await expect(receiver.page.getByTestId("markdown-editor")).toContainText(incomingText.trim());
    expect(await readFile(join(receivingWorkspace.rootPath, "shared.md"), "utf8")).toBe(incomingText);
    const remaining = await receiver.page.evaluate(async (workspaceId) => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listWorkspaceVersionConflicts({ workspaceId }), workspaceId);
    expect(remaining.conflicts).toEqual([]);
  } finally {
    try {
      await logSyncStatus(workspaceId, [["left", left], ["right", right]]);
    } finally {
      await cleanupDesktopWorkspace(right, second);
      try { if (left) await left.close(); }
      finally { try { await relay?.stop(); } finally { await first.cleanup(); } }
    }
  }
});

test("@two-client a document open on two desktops keeps both desktops' edits", async () => {
  test.setTimeout(300_000);
  const first = await createTempWorkspace();
  const second = await createTempWorkspace();
  const workspaceId = "two-desktop-live-document";
  let left: Desktop | null = null;
  let right: Desktop | null = null;
  let relay: Relay | null = null;
  const disk = (workspace: Workspace) => readFile(join(workspace.rootPath, "shared.md"), "utf8");
  try {
    relay = await seedSharedWorkspace(workspaceId, first, second);
    left = await joinWorkspace(first, workspaceId, relay.baseUrl);
    right = await joinWorkspace(second, workspaceId, relay.baseUrl);
    const relayPort = relay.port;
    const relayDb = relay.dbPath;

    // Both desktops open the document while neither can see the other's copy.
    await relay.stop();
    relay = null;
    await openLiveDocument(left.page);
    await openLiveDocument(right.page);
    relay = await spawnSyncRelay({ dbPath: relayDb, port: relayPort });

    // Online: the left types. The right holds the document open, then closes it.
    await typeAtEnd(left.page, " Typed on the left.");
    await expect.poll(() => disk(first)).toContain("Typed on the left.");
    await right.page.keyboard.press("ControlOrMeta+w");
    await expect.poll(() => disk(second), { timeout: 90_000 }).toContain("Typed on the left.");
    await openLiveDocument(right.page);
    await expect(right.page.getByTestId("markdown-editor")).toContainText("Typed on the left.");

    // Offline: each desktop types into the same document.
    await relay.stop();
    relay = null;
    await typeAtEnd(left.page, " Left offline.");
    await typeAtEnd(right.page, " Right offline.");
    await expect.poll(() => disk(first)).toContain("Left offline.");
    await expect.poll(() => disk(second)).toContain("Right offline.");
    relay = await spawnSyncRelay({ dbPath: relayDb, port: relayPort });
    for (const desktop of [left, right]) await desktop.page.keyboard.press("ControlOrMeta+w");

    const everyEdit = ["Starting together.", "Typed on the left.", "Left offline.", "Right offline."];
    await expect.poll(async () => {
      const [leftText, rightText] = [await disk(first), await disk(second)];
      return leftText === rightText && everyEdit.every((edit) => leftText.includes(edit));
    }, { timeout: 120_000 }).toBe(true);
    for (const [desktop, workspace] of [[left, first], [right, second]] as const) {
      const files = (await readdir(workspace.rootPath)).filter((name) => name !== ".dohc");
      expect(files, "no recovered copy or conflict file beside the document").toEqual(["shared.md"]);
      await expect.poll(async () => (await syncState(desktop.page, workspaceId)).sync.state).toBe("synced");
      expect((await syncState(desktop.page, workspaceId)).conflicts.conflicts).toEqual([]);
    }
  } finally {
    try {
      await logSyncStatus(workspaceId, [["left", left], ["right", right]]);
    } finally {
      await cleanupDesktopWorkspace(right, second);
      try { if (left) await left.close(); }
      finally { try { await relay?.stop(); } finally { await first.cleanup(); } }
    }
  }
});
