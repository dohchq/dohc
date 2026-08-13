import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DohcDesktopBridge,
  SyncStatusResult,
} from "../src/ipc/bridgeContract";
import { RelayFilePeer } from "../src/testing/relayFilePeer";
import { createWorkspaceEngineCapture } from "../src/workspaces/workspaceEngineCapture";
import {
  loadSecretDataKey,
  SECRET_KEY_RELATIVE_PATH,
} from "../src/workspaces/workspaceDataKey";
import { enrollWorkspaceKeyEnvelope } from "../src/workspaces/workspaceKeyEnvelopeEnrollment";
import { waitForPathMoments } from "../src/workspaces/waitForPathMoments";
import { openLiveDaemonWorkspace } from "./helpers/daemonSeed";
import { claimRelayWorkspace, relayServesWorkspace } from "./helpers/relayPeer";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  relayAdoptedIdentity,
  spawnSyncRelay,
  type RelayWorkspaceIdentity,
  type SyncRelayHandle,
} from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openHistoryView,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  waitForWorkspaceReady,
  activeWorkspace,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// 0P-C — the multi-machine sync product proof. One real Electron app is
// "this machine". A test-only protocol peer seeds the remote machine's state
// because the serial harness cannot run two Electron instances. The relay is
// the real service, spawned as a child process with its SQLite on tmpfs.
//
// Spec 1: two real daemon-backed machines edit offline. The Electron app
//         reviews and resolves the conflict through the product UI.
// Spec 2: join flow — seed a synced workspace from the protocol peer, drive
//         the app's "Join a synced workspace" UI, assert files, history, chats
//         and search all arrived.
// Spec 3: enabling sync claims the workspace on the relay, with no
//         workspace-api preclaim.

const TOKEN = "test:e2e-user";
type SyncStatusBridge = Pick<DohcDesktopBridge, "getSyncStatus">;
type WorkspaceRegistryBridge = Pick<DohcDesktopBridge, "getWorkspaceRegistry">;
type EngineMomentsBridge = Pick<DohcDesktopBridge, "listEngineMoments">;

async function readSyncStatus(
  page: Page,
  workspaceId: string,
): Promise<Pick<SyncStatusResult, "lastSyncedAtMs">> {
  return await page.evaluate(async (id) => {
    const api = (window as unknown as { dohcDesktop?: SyncStatusBridge })
      .dohcDesktop;
    if (!api) throw new Error("desktop bridge is unavailable");
    return await api.getSyncStatus({ workspaceId: id });
  }, workspaceId);
}

async function waitForLaterSync(
  page: Page,
  workspaceId: string,
  previousSyncAtMs: number,
): Promise<void> {
  await page.waitForFunction(
    async ({ id, previousSyncAtMs }) => {
      const api = (window as unknown as { dohcDesktop?: SyncStatusBridge })
        .dohcDesktop;
      if (!api) return false;
      const status = await api.getSyncStatus({ workspaceId: id });
      return (
        status.lastSyncedAtMs !== null &&
        status.lastSyncedAtMs > previousSyncAtMs
      );
    },
    { id: workspaceId, previousSyncAtMs },
    { timeout: 30_000 },
  );
}

async function workspaceIsRegistered(
  page: Page,
  workspaceId: string,
): Promise<boolean> {
  return await page.evaluate(async (id) => {
    const api = (window as unknown as { dohcDesktop?: WorkspaceRegistryBridge })
      .dohcDesktop;
    if (!api) throw new Error("desktop bridge is unavailable");
    const registry = await api.getWorkspaceRegistry();
    return registry.workspaces.some((workspace) => workspace.workspaceId === id);
  }, workspaceId);
}

async function pathMomentCount(
  page: Page,
  workspaceId: string,
  path: string,
): Promise<number> {
  return await page.evaluate(async ({ workspaceId, path }) => {
    const api = (window as unknown as { dohcDesktop?: EngineMomentsBridge })
      .dohcDesktop;
    if (!api) throw new Error("desktop bridge is unavailable");
    const result = await api.listEngineMoments({ workspaceId, limit: 500 });
    return result.moments.filter((moment) => moment.path === path).length;
  }, { workspaceId, path });
}

async function fileMatches(path: string, expected: Buffer): Promise<boolean> {
  try {
    return (await readFile(path)).equals(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test("offline edits reach the Electron conflict review and its resolution survives restart", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "conflict-review-e2e";
  const path = "notes/plan.md";
  const base = "shared draft\n";
  const appEdit = "edit from this machine\n";
  const peerEdit = "edit from the other machine\n";
  const sourceRoot = join(temp.baseDir, "conflict-source");
  const relayDb = join(temp.baseDir, "conflict-relay.sqlite");
  let relay: SyncRelayHandle | null = null;
  let sourceWorkspace: Awaited<
    ReturnType<typeof openLiveDaemonWorkspace>
  > | null = null;
  let sourceCapture: ReturnType<typeof createWorkspaceEngineCapture> | null =
    null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await mkdir(join(sourceRoot, "notes"), { recursive: true });
    relay = await spawnSyncRelay({ dbPath: relayDb });
    const relayPort = relay.port;
    const relayConfig = { baseUrl: relay.baseUrl, token: TOKEN };

    const liveSource = await openLiveDaemonWorkspace(
      { workspaceId, rootPath: sourceRoot },
      { maxRestarts: 0 },
    );
    sourceWorkspace = liveSource;
    const capture = createWorkspaceEngineCapture({
      workspaceId,
      rootPath: sourceRoot,
      rustEngineSessions: liveSource.sessions,
      daemonOwnsCapture: true,
    });
    sourceCapture = capture;
    const sourceRelay = liveSource.relay.bind({
      workspaceId,
      rootPath: sourceRoot,
      relay: relayConfig,
    });

    await sourceRelay.claim();
    await liveSource.chats.ensureGeneralChannel({ workspaceId });
    expect((await sourceRelay.push()).pushed).toBeGreaterThan(0);
    await writeFile(join(sourceRoot, path), base);
    capture.captureBatch([{ path, operation: "update" }]);
    await waitForPathMoments(capture, path, 1);
    expect((await sourceRelay.push()).pushed).toBeGreaterThan(0);

    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      userId: "e2e-user",
    });
    desktop = await launchDesktopApp({
      workspace: temp,
      env: {
        DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
        DOHC_TEST_SYNC_BACKOFF_MS: "250",
      },
    });
    let page = desktop.page;
    await page.getByTestId("first-run-join-synced").click();
    await page
      .getByTestId("join-sync-code")
      .fill(`dohc-sync:${workspaceId}:${relay.baseUrl}`);
    await page.getByTestId("join-choose-folder").click();
    await page.getByTestId("join-workspace-start").click();
    await waitForWorkspaceReady(page);
    await waitForWorkspaceFile(page, workspaceId, path);
    expect(await readFile(join(temp.rootPath, path), "utf8")).toBe(base);

    const appMomentsBeforeEdit = await pathMomentCount(page, workspaceId, path);

    // Both machines edit from the same base while the relay is unavailable.
    await relay.stop();
    relay = null;
    await writeWorkspaceFiles(temp, [{ path, contents: appEdit }]);
    await expect
      .poll(() => pathMomentCount(page, workspaceId, path), {
        timeout: 30_000,
      })
      .toBeGreaterThan(appMomentsBeforeEdit);
    await writeFile(join(sourceRoot, path), peerEdit);
    capture.captureBatch([{ path, operation: "update" }]);
    await waitForPathMoments(capture, path, 2);

    // The same relay data returns on the same address. The source pushes its
    // edit, and the Electron app pushes its queued edit before it pulls.
    relay = await spawnSyncRelay({ dbPath: relayDb, port: relayPort });
    expect((await sourceRelay.push()).pushed).toBeGreaterThan(0);
    await writeWorkspaceFiles(temp, [
      { path: "notes/sync-nudge.md", contents: "sync now\n" },
    ]);

    await expect(page.getByTestId("sync-status")).toHaveAttribute(
      "data-state",
      "conflict",
      { timeout: 90_000 },
    );
    await page.getByTestId("notice-center-toggle").click();
    const notice = page.getByTestId("notice-sync-conflict");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("changed on two machines");
    await notice.getByRole("button", { name: "Review", exact: true }).click();

    const dialog = page.getByTestId("conflict-review-dialog");
    await expect(dialog).toBeVisible();
    const card = dialog.locator(
      `[data-testid="version-conflict"][data-conflict-path="${path}"]`,
    );
    await expect(card).toBeVisible();
    await expect(card.getByText("On this machine", { exact: true })).toBeVisible();
    await expect(
      card.getByText("On your other machine", { exact: true }),
    ).toBeVisible();
    await expect(card).toContainText(appEdit.trim());
    await expect(card).toContainText(peerEdit.trim());

    // Pull the app's edit into the source daemon before resolving. This proves
    // that the later zero count closes a real mirror conflict.
    await expect
      .poll(
        async () => {
          await capture.runRelaySync(() => sourceRelay.pull());
          return await capture.countOpenConflicts();
        },
        { timeout: 90_000, intervals: [500] },
      )
      .toBe(1);

    await card.getByTestId("version-conflict-keep-incoming").click();
    await expect(page.getByTestId("conflict-review-empty")).toBeVisible();
    await page.getByTestId("conflict-review-done").click();
    await expect
      .poll(() => readFile(join(temp.rootPath, path), "utf8"), {
        timeout: 30_000,
      })
      .toBe(peerEdit);

    await expect
      .poll(
        async () => {
          await capture.runRelaySync(() => sourceRelay.pull());
          return await capture.countOpenConflicts();
        },
        { timeout: 90_000, intervals: [500] },
      )
      .toBe(0);
    expect(await readFile(join(sourceRoot, path), "utf8")).toBe(peerEdit);

    // Relaunch the real app and daemon with the same profile and workspace.
    // The selected bytes and the closed conflict must remain durable.
    await desktop.close();
    desktop = null;
    desktop = await launchDesktopApp({
      workspace: temp,
      env: {
        DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
        DOHC_TEST_SYNC_BACKOFF_MS: "250",
      },
    });
    page = desktop.page;
    await waitForWorkspaceReady(page);
    expect((await activeWorkspace(page, temp.rootPath)).workspaceId).toBe(
      workspaceId,
    );
    expect(await readFile(join(temp.rootPath, path), "utf8")).toBe(peerEdit);
    const remaining = await page.evaluate(async (id) => {
      const api = (window as unknown as { dohcDesktop?: DohcDesktopBridge })
        .dohcDesktop;
      if (!api) throw new Error("desktop bridge is unavailable");
      return await api.listWorkspaceVersionConflicts({ workspaceId: id });
    }, workspaceId);
    expect(remaining.conflicts).toEqual([]);
    expect(remaining.nextAfterConflictId).toBeNull();
    await expect(page.getByTestId("sync-status")).not.toHaveAttribute(
      "data-state",
      "conflict",
    );
  } finally {
    await sourceCapture?.stop().catch(() => undefined);
    await sourceWorkspace?.close().catch(() => undefined);
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("join flow: paste the sync code, pick a folder, and the workspace arrives with history, chats, and search", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "join-e2e";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    const relayDb = join(temp.baseDir, "relay.sqlite");
    relay = await spawnSyncRelay({ dbPath: relayDb });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: TOKEN, workspaceId });
    const establishedIdentity: RelayWorkspaceIdentity = {
      replicationEpoch: "epoch-join-e2e",
      streamIdentity: "stream-join-e2e",
    };
    const remotePeer = new RelayFilePeer({
      baseUrl: relay.baseUrl,
      token: TOKEN,
      workspaceId,
      originId: "join-e2e-remote-peer",
      identity: establishedIdentity,
    });

    // The remote peer seeds file history and a linked chat. The app must bring
    // all of this state over during the join.
    const firstRoadmap = await remotePeer.writeText(
      "notes/roadmap.md",
      "# Roadmap\n\ndraft one\n",
    );
    await remotePeer.writeText(
      "notes/roadmap.md",
      "# Roadmap\n\nThe galaxy-brain milestone lands next.\n",
    );
    await remotePeer.writeText("docs/guide.md", "A quiet guide.\n");
    const extraFiles = Number(process.env.DOHC_E2E_JOIN_FILES ?? 0);
    await remotePeer.writeTextFiles(
      Array.from({ length: extraFiles }, (_, index) => ({
        path: `bulk/topic-${Math.floor(index / 50)}/file-${index}.md`,
        text: `# Bulk ${index}\n\n${"Body line for bootstrap benchmarking. ".repeat(12)}\n`,
      })),
    );
    await remotePeer.createLinkedChat({
      linkedObjectId: firstRoadmap.objectId,
      linkedPathHint: "notes/roadmap.md",
      title: "Roadmap sync",
      authorDisplayName: "Ice",
      authorUserId: "e2e-user",
      body: "Let's settle the quasar sync cadence this week.",
    });
    expect(relayAdoptedIdentity(relayDb, workspaceId)).toEqual(
      establishedIdentity,
    );

    // Machine 2 is the app: fresh home (no workspaces), already signed in.
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      userId: "e2e-user",
    });
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;

    await page.getByTestId("first-run-join-synced").click();
    await expect(page.getByTestId("join-synced-workspace")).toBeVisible();
    await page
      .getByTestId("join-sync-code")
      .fill(`dohc-sync:${workspaceId}:${relay.baseUrl}`);
    // The folder picker resolves to the spec's empty workspace dir
    // (DOHC_TEST_PICK_PATH).
    await page.getByTestId("join-choose-folder").click();
    await expect(page.getByTestId("join-synced-workspace")).toContainText(
      temp.rootPath,
    );
    const joinStartedAt = Date.now();
    await page.getByTestId("join-workspace-start").click();

    // The workspace opens with everything: identity, files on disk, history
    // moments, the linked chat, and a searchable index.
    await waitForWorkspaceReady(page);
    console.log(
      `[perf] join-to-interactive-shell: ${Date.now() - joinStartedAt}ms (${
        2 + Number(process.env.DOHC_E2E_JOIN_FILES ?? 0)
      } files + chat)`,
    );
    const workspace = await activeWorkspace(page, temp.rootPath);
    expect(workspace.workspaceId).toBe(workspaceId);
    await waitForWorkspaceFile(page, workspaceId, "notes/roadmap.md");
    await waitForWorkspaceFile(page, workspaceId, "docs/guide.md");
    expect(await readFile(join(temp.rootPath, "notes/roadmap.md"), "utf8")).toBe(
      "# Roadmap\n\nThe galaxy-brain milestone lands next.\n",
    );

    // Record the completed bootstrap pass, then queue a local change and wait
    // for a later sync timestamp. This proves a push-capable normal pass has
    // completed before the relay log is scanned.
    const syncBeforeLocalChange = await readSyncStatus(page, workspaceId);
    expect(syncBeforeLocalChange.lastSyncedAtMs).not.toBeNull();
    if (syncBeforeLocalChange.lastSyncedAtMs === null) {
      throw new Error("completed bootstrap sync has no timestamp");
    }
    await writeWorkspaceFiles(temp, [
      { path: "notes/join-local-sync-probe.md", contents: "local sync probe\n" },
    ]);
    await waitForLaterSync(
      page,
      workspaceId,
      syncBeforeLocalChange.lastSyncedAtMs,
    );

    // The join is pull-first and seeds no starter files. The relay log must
    // therefore carry no `.context/me.md` operation from the joining app.
    //
    // The joining app must adopt the coordinate that the remote peer
    // established before its first pull.
    let identity: RelayWorkspaceIdentity | null = establishedIdentity;
    const loggedPaths: string[] = [];
    await expect
      .poll(
        async () => {
          identity ??= relayAdoptedIdentity(relayDb, workspaceId);
          loggedPaths.length = 0;
          let since = 0;
          while (true) {
            const query = new URLSearchParams({ since: String(since), limit: "500" });
            if (identity) {
              query.set("replicationEpoch", identity.replicationEpoch);
              query.set("streamIdentity", identity.streamIdentity);
            }
            const response = await fetch(
              `${relay!.baseUrl}/sync/${encodeURIComponent(workspaceId)}/log?${query.toString()}`,
              { headers: { authorization: `Bearer ${TOKEN}` } },
            );
            if (response.status === 409) {
              // Identity was adopted between our read and this request (or
              // rotated); relearn on the next interval.
              identity = null;
              loggedPaths.length = 0;
              return null;
            }
            if (!response.ok) {
              throw new Error(`relay log read failed (${response.status})`);
            }
            const body = (await response.json()) as {
              ops: Array<{ payload?: { path?: string } }>;
              nextCursor: number;
              hasMore: boolean;
            };
            for (const op of body.ops) {
              if (typeof op.payload?.path === "string") {
                loggedPaths.push(op.payload.path);
              }
            }
            if (!body.hasMore) break;
            if (!Number.isSafeInteger(body.nextCursor) || body.nextCursor <= since) {
              throw new Error("relay log pagination did not advance");
            }
            since = body.nextCursor;
          }
          return true;
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBe(true);
    expect(loggedPaths).not.toContain(".context/me.md");

    // Full history came along (both roadmap moments, not just latest state).
    // In perf runs the first history page is bulk files, so assert on the
    // newest seeded path instead.
    const bulkCount = Number(process.env.DOHC_E2E_JOIN_FILES ?? 0);
    const historyPath =
      bulkCount > 0
        ? `bulk/topic-${Math.floor((bulkCount - 1) / 50)}/file-${bulkCount - 1}.md`
        : "notes/roadmap.md";
    const momentRow = page.locator(
      `[data-testid="engine-moment-open"][data-moment-path="${historyPath}"]`,
    );
    // History lives in the left History view (the right panel is Chats now).
    await openHistoryView(page);
    await expect(momentRow.first()).toBeVisible();
    if (bulkCount === 0) {
      expect(await momentRow.count()).toBeGreaterThanOrEqual(2);
    }

    // Pulled file content is searchable through the engine index.
    await page.getByTestId("activity-search").click();
    await expect(page.getByTestId("search-view")).toBeVisible();
    await page.getByTestId("search-input").fill("galaxy-brain");
    await expect(
      page.locator('[data-testid="search-result-group"][data-path="notes/roadmap.md"]'),
    ).toBeVisible();

    // Pulled CHAT content is searchable and opens in the Chats rail.
    await page.getByTestId("search-input").fill("quasar");
    const chatGroup = page
      .locator('[data-testid="search-result-group"]')
      .filter({ hasText: "Roadmap sync" });
    await expect(chatGroup).toBeVisible();
    await chatGroup.getByTestId("search-result-row").first().click();
    await expect(page.getByTestId("linked-chat-thread")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("linked-chat-message-body")).toContainText(
      "quasar sync cadence",
    );
  } finally {
    // Stop the relay child before removing the temp tree it holds open, or
    // Windows leaks the dir with EBUSY (POSIX tolerates the reverse order).
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("protected join rolls back for a missing passphrase, then restores exact secret and binary bytes across restart", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "protected-join-e2e";
  const passphrase = "correct horse battery staple";
  const secretPath = ".env";
  const binaryPath = "exact-bytes.bin";
  const secretBytes = Buffer.from(
    "ACCESS_TOKEN=galaxy-brain-secret\r\nEMPTY=\r\n",
    "utf8",
  );
  const binaryBytes = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x7f, 0x42]);
  const sourceRoot = join(temp.baseDir, "protected-source");
  let relay: SyncRelayHandle | null = null;
  let sourceWorkspace: Awaited<
    ReturnType<typeof openLiveDaemonWorkspace>
  > | null = null;
  let sourceCapture: ReturnType<typeof createWorkspaceEngineCapture> | null =
    null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await mkdir(sourceRoot, { recursive: true });
    relay = await spawnSyncRelay({
      dbPath: join(temp.baseDir, "protected-relay.sqlite"),
    });
    const relayConfig = { baseUrl: relay.baseUrl, token: TOKEN };

    // Seed through the same daemon capture, relay journal, and key-envelope
    // protocol that the product uses. Only the source machine is test-driven;
    // the joining machine below goes through the public renderer and IPC.
    sourceWorkspace = await openLiveDaemonWorkspace(
      { workspaceId, rootPath: sourceRoot },
      { maxRestarts: 0 },
    );
    sourceCapture = createWorkspaceEngineCapture({
      workspaceId,
      rootPath: sourceRoot,
      rustEngineSessions: sourceWorkspace.sessions,
      daemonOwnsCapture: true,
    });
    const sourceRelay = sourceWorkspace.relay.bind({
      workspaceId,
      rootPath: sourceRoot,
      relay: relayConfig,
    });
    await sourceRelay.claim();
    const dataKey = await loadSecretDataKey(sourceRoot, {
      createIfMissing: true,
    });
    await enrollWorkspaceKeyEnvelope({
      workspaceId,
      dataKey,
      passphrase,
      transport: sourceRelay,
      installDataKey: async () => {
        throw new Error("The source workspace must keep its existing key.");
      },
    });

    // Establish the relay position before file capture so the moments are
    // journaled on the claimed replication coordinate.
    await sourceWorkspace.chats.ensureGeneralChannel({ workspaceId });
    expect((await sourceRelay.push()).pushed).toBeGreaterThan(0);
    await writeFile(join(sourceRoot, secretPath), secretBytes);
    await writeFile(join(sourceRoot, binaryPath), binaryBytes);
    sourceCapture.captureBatch([
      { path: secretPath, operation: "update" },
      { path: binaryPath, operation: "update" },
    ]);
    await Promise.all([
      waitForPathMoments(sourceCapture, secretPath, 1),
      waitForPathMoments(sourceCapture, binaryPath, 1),
    ]);
    expect((await sourceRelay.push()).pushed).toBeGreaterThan(0);

    // Release the source daemon before Electron starts. The relay remains the
    // only shared boundary between the two machines.
    await sourceCapture.stop();
    sourceCapture = null;
    await sourceWorkspace.close();
    sourceWorkspace = null;

    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      userId: "e2e-user",
    });
    desktop = await launchDesktopApp({ workspace: temp });
    let page = desktop.page;

    await page.getByTestId("first-run-join-synced").click();
    await page
      .getByTestId("join-sync-code")
      .fill(`dohc-sync:${workspaceId}:${relay.baseUrl}`);
    await page.getByTestId("join-choose-folder").click();
    await page.getByTestId("join-workspace-start").click();

    // The missing passphrase is discovered at the public IPC boundary. The
    // attempt must leave neither local files nor a hidden registry entry.
    await expect(page.getByTestId("join-sync-passphrase")).toBeVisible();
    await expect(page.getByTestId("join-error")).toHaveText(
      "This workspace has protected files. Enter the protected-file passphrase to join.",
    );
    await expect
      .poll(async () => (await readdir(temp.rootPath)).sort())
      .toEqual([]);
    await expect.poll(() => workspaceIsRegistered(page, workspaceId)).toBe(false);

    // Retry through the same public button. Successful materialization proves
    // the envelope key was installed before the pull tried to decrypt .env.
    await page.getByTestId("join-sync-passphrase").fill(passphrase);
    await page.getByTestId("join-workspace-start").click();
    await waitForWorkspaceReady(page);
    expect((await activeWorkspace(page, temp.rootPath)).workspaceId).toBe(
      workspaceId,
    );
    await expect
      .poll(() => fileMatches(join(temp.rootPath, secretPath), secretBytes))
      .toBe(true);
    await expect
      .poll(() => fileMatches(join(temp.rootPath, binaryPath), binaryBytes))
      .toBe(true);
    expect(
      (await readFile(join(temp.rootPath, SECRET_KEY_RELATIVE_PATH))).length,
    ).toBeGreaterThan(0);

    // Relaunch with the same profile and registry. The joined key and both
    // exact payloads must remain usable without another enrollment prompt.
    await desktop.close();
    desktop = null;
    desktop = await launchDesktopApp({ workspace: temp });
    page = desktop.page;
    await waitForWorkspaceReady(page);
    expect((await activeWorkspace(page, temp.rootPath)).workspaceId).toBe(
      workspaceId,
    );
    expect(await fileMatches(join(temp.rootPath, secretPath), secretBytes)).toBe(
      true,
    );
    expect(await fileMatches(join(temp.rootPath, binaryPath), binaryBytes)).toBe(
      true,
    );
  } finally {
    await sourceCapture?.stop().catch(() => undefined);
    await sourceWorkspace?.close().catch(() => undefined);
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// Enable-sync product proof (G2-C-3 gate fix): turning sync ON for a
// LOCAL-ONLY workspace must claim the bucket on the RELAY alone. workspace-api
// is now auth-only and 404s every non-auth route, so the retired
// `POST ${serverUrl}/workspaces` preclaim would fail the whole flow with
// "Enabling sync failed (404)" before the relay claim ever ran. This drives
// the real cloudEnableSync IPC against a real relay (no workspace-api at all)
// and proves the workspace claims, binds, and pushes its content end to end.
test("enabling sync claims the workspace on the relay alone (no workspace-api preclaim)", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "enable-e2e";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceSettings(temp, { experimental: { workspaceEngineAlpha: true } });
    await writeWorkspaceFiles(temp, [{ path: "notes/plan.md", contents: "local draft\n" }]);

    // A real relay is the ONLY cloud service. The workspace is NOT pre-claimed:
    // cloudEnableSync must be the first and sole claimant.
    const relayDb = join(temp.baseDir, "relay.sqlite");
    relay = await spawnSyncRelay({ dbPath: relayDb });

    // Local-only registry entry (no `remote`): the workspace is not synced yet.
    await seedWorkspaceRegistry(temp, [{ workspaceId, rootPath: temp.rootPath }]);
    // serverUrl points at the relay too — exactly the shape that made the old
    // `${serverUrl}/workspaces` preclaim 404 (the relay 404s any non-/sync path).
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      userId: "e2e-user",
    });

    desktop = await launchDesktopApp({
      workspace: temp,
      env: {
        DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
        DOHC_TEST_SYNC_BACKOFF_MS: "250",
      },
    });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    // Drive the real enable-sync IPC. Before the fix this rejects with
    // "Enabling sync failed (404)"; after it, the relay claim is authoritative
    // and it resolves with a live sync status.
    const enableResult = await page.evaluate(async (id) => {
      const api = (
        window as unknown as {
          dohcDesktop: {
            cloudEnableSync(payload: { workspaceId: string }): Promise<unknown>;
          };
        }
      ).dohcDesktop;
      try {
        const status = await api.cloudEnableSync({ workspaceId: id });
        return { ok: true as const, status };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }, workspaceId);
    // The renderer already captured the failure message; assert on the whole
    // object so a refusal reports WHY instead of just `ok: false`.
    expect(enableResult, `cloudEnableSync refused: ${JSON.stringify(enableResult)}`).toMatchObject(
      { ok: true },
    );

    // The workspace is now bound and pushing. A claimed bucket answers its log
    // with 200, while an unclaimed bucket answers 404. WITH the adopted
    // identity: `cloudEnableSync` claims through
    // execute_relay_operation, which supplies both identity fields, so the relay
    // adopts them and an identity-free log read answers 409 rather than 200.
    //
    // A 409 is RELEARNED, not thrown, exactly as the poll above does. Playwright
    // evaluates the polled callback outside its own try/catch, so a throw fails
    // the test on the first interval instead of retrying — and 409 is precisely
    // what a read racing the adoption (or a rotated epoch, which `??=` would
    // never re-read) gets back.
    let identity: RelayWorkspaceIdentity | null = null;
    await expect
      .poll(
        async () => {
          identity ??= relayAdoptedIdentity(relayDb, workspaceId);
          try {
            return await relayServesWorkspace(relay!.baseUrl, TOKEN, workspaceId, identity);
          } catch (error) {
            if (!/failed: 409/.test(String(error))) throw error;
            identity = null;
            return null;
          }
        },
        { timeout: 90_000, intervals: [1000] },
      )
      .toBe(true);

    // And the identity was actually adopted. Without this the argument above is
    // decorative: a null identity sends an identity-free read, which a claimed
    // but un-adopted bucket answers with 200, so the poll would pass whether or
    // not cloudEnableSync supplied an identity at all.
    expect(identity, "cloudEnableSync must adopt a replication identity").not.toBeNull();
    if (identity === null) throw new Error("cloudEnableSync did not adopt an identity");
    const adoptedIdentity: RelayWorkspaceIdentity = identity;

    const syncedBeforeWrite = await readSyncStatus(page, workspaceId);
    expect(syncedBeforeWrite.lastSyncedAtMs).not.toBeNull();
    if (syncedBeforeWrite.lastSyncedAtMs === null) {
      throw new Error("enabled workspace sync has no timestamp");
    }

    const outboundPath = "notes/after-enable.md";
    const outboundContents = "captured after sync was enabled\n";
    await writeWorkspaceFiles(temp, [
      { path: outboundPath, contents: outboundContents },
    ]);
    await waitForLaterSync(page, workspaceId, syncedBeforeWrite.lastSyncedAtMs);

    let outboundBlobSha: string | null = null;
    const relayBaseUrl = relay.baseUrl;
    const identityQuery = {
      replicationEpoch: adoptedIdentity.replicationEpoch,
      streamIdentity: adoptedIdentity.streamIdentity,
    };
    await expect
      .poll(
        async () => {
          let since = 0;
          while (true) {
            const query = new URLSearchParams({
              since: String(since),
              limit: "500",
              ...identityQuery,
            });
            const response = await fetch(
              `${relayBaseUrl}/sync/${encodeURIComponent(workspaceId)}/log?${query.toString()}`,
              { headers: { authorization: `Bearer ${TOKEN}` } },
            );
            if (!response.ok) {
              throw new Error(`relay log read failed (${response.status})`);
            }
            const body = (await response.json()) as {
              ops: Array<{
                opKind: string;
                payload?: {
                  path?: unknown;
                  payloadAfterPath?: unknown;
                  payloadAfterBlobSha256?: unknown;
                };
              }>;
              nextCursor: number;
              hasMore: boolean;
            };
            for (const op of body.ops) {
              const payload = op.payload;
              if (
                op.opKind === "moment.append" &&
                payload?.path === outboundPath &&
                payload.payloadAfterPath === outboundPath &&
                typeof payload.payloadAfterBlobSha256 === "string"
              ) {
                outboundBlobSha = payload.payloadAfterBlobSha256;
                return true;
              }
            }
            if (!body.hasMore) return false;
            if (!Number.isSafeInteger(body.nextCursor) || body.nextCursor <= since) {
              throw new Error("relay log pagination did not advance");
            }
            since = body.nextCursor;
          }
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBe(true);
    if (outboundBlobSha === null) {
      throw new Error("relay log did not contain the captured file blob");
    }
    const blobQuery = new URLSearchParams(identityQuery);
    const blobResponse = await fetch(
      `${relayBaseUrl}/sync/${encodeURIComponent(workspaceId)}/blobs/${encodeURIComponent(outboundBlobSha)}?${blobQuery.toString()}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(blobResponse.status).toBe(200);
    expect(Buffer.from(await blobResponse.arrayBuffer()).toString("utf8")).toBe(
      outboundContents,
    );

    // The app reflects a synced workspace (the sync-status surface is present,
    // not the local-only absence).
    await expect(page.getByTestId("sync-status")).toBeVisible({ timeout: 30_000 });
  } finally {
    // Stop the relay child before removing the temp tree it holds open, or
    // Windows leaks the dir with EBUSY (POSIX tolerates the reverse order).
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
