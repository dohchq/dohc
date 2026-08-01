import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RelayFilePeer } from "../src/testing/relayFilePeer";
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
// Spec 1: join flow — seed a synced workspace from the protocol peer, drive
//         the app's "Join a synced workspace" UI, assert files, history, chats
//         and search all arrived.
// Spec 2: enabling sync claims the workspace on the relay, with no
//         workspace-api preclaim.
//
// A third spec (offline divergence -> conflict notice -> resolve) was removed;
// see the note below where it used to live.

const TOKEN = "test:e2e-user";


// The two-machine conflict-review scenario that lived here was deleted: it was
// `test.fixme`d because file content never reaches the relay (#356), and its
// acceptance criteria are recorded there.


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
    const syncBeforeLocalChange = await page.evaluate(async (id) => {
      const api = (window as unknown as {
        dohcDesktop?: {
          getSyncStatus(payload: { workspaceId: string }): Promise<{
            lastSyncedAtMs: number | null;
          }>;
        };
      }).dohcDesktop;
      if (!api) throw new Error("desktop bridge is unavailable");
      return await api.getSyncStatus({ workspaceId: id });
    }, workspaceId);
    expect(syncBeforeLocalChange.lastSyncedAtMs).not.toBeNull();
    await writeWorkspaceFiles(temp, [
      { path: "notes/join-local-sync-probe.md", contents: "local sync probe\n" },
    ]);
    await page.waitForFunction(
      async ({ id, previousSyncAtMs }) => {
        const api = (window as unknown as {
          dohcDesktop?: {
            getSyncStatus(payload: { workspaceId: string }): Promise<{
              lastSyncedAtMs: number | null;
            }>;
          };
        }).dohcDesktop;
        if (!api) return false;
        const status = await api.getSyncStatus({ workspaceId: id });
        return (
          status.lastSyncedAtMs !== null &&
          previousSyncAtMs !== null &&
          status.lastSyncedAtMs > previousSyncAtMs
        );
      },
      {
        id: workspaceId,
        previousSyncAtMs: syncBeforeLocalChange.lastSyncedAtMs,
      },
      { timeout: 30_000 },
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

    // The workspace is now bound and pushing, and the proof is that the relay
    // owns a bucket for it: a claimed bucket answers its log with 200 even when
    // empty, an unclaimed one 404s. That is exactly what this test's title
    // claims, and all it should assert.
    //
    // It used to poll a second machine for `notes/plan.md` instead — asserting
    // something the daemon CANNOT do. Captured file writes go to
    // `replication_journal` and nothing drains that into the relay-visible
    // `replication_log`, so file content never reaches the relay (#356). The
    // assertion carried no `fixme`, so it has been failing silently since the
    // cutover, because e2e only runs on demand. Content arriving at a second
    // machine is #356's acceptance gate and is deliberately not asserted here.
    // WITH the adopted identity: `cloudEnableSync` claims through
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
