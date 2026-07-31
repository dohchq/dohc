import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RelayConflictError,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import {
  createLinkedChatStore,
  createVersionedTextStore,
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
} from "@dohc/workspace-engine";
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

// 0P-C — the multi-machine sync product proof. One REAL Electron app is
// "this machine"; a second "machine" is a headless engine store in the test
// process driven through the same public sync API the desktop uses (the
// 0P-B integration pattern — the serial single-display harness cannot run
// two Electron instances). The relay is the real service, spawned as a
// child process with its SQLite on tmpfs.
//
// Spec 1: join flow — seed a synced workspace from the headless machine, drive
//         the app's "Join a synced workspace" UI, assert files, history, chats
//         and search all arrived.
// Spec 2: enabling sync claims the workspace on the relay, with no
//         workspace-api preclaim.
//
// A third spec (offline divergence -> conflict notice -> resolve) was removed;
// see the note below where it used to live.

const TOKEN = "test:e2e-user";

function relayConnection(baseUrl: string): SyncRelayConnection {
  return { baseUrl, token: TOKEN };
}

// R10b: once the app's daemon first pushes (or claims), the relay adopts the
// daemon's replication identity and identity-less /log calls 409 with
// identity_required. The TS harness client deliberately presents no identity
// of its own, so the headless machine learns the adopted coordinate from the
// relay's SQLite (relayAdoptedIdentity) and injects it at the connection's
// fetch seam: query params on pulls, body fields on pushes. Pre-adopting a
// spec-minted identity would instead 409 the APP's push — the relay refuses
// every identity but the first.
function identityConnection(
  baseUrl: string,
  identity: RelayWorkspaceIdentity | null,
): SyncRelayConnection {
  if (identity === null) return relayConnection(baseUrl);
  const withIdentity: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/log")) {
      if (typeof init?.body === "string") {
        init = {
          ...init,
          body: JSON.stringify({
            ...(JSON.parse(init.body) as Record<string, unknown>),
            ...identity,
          }),
        };
      } else {
        url.searchParams.set("replicationEpoch", identity.replicationEpoch);
        url.searchParams.set("streamIdentity", identity.streamIdentity);
      }
    }
    return fetch(url, init);
  };
  return { baseUrl, token: TOKEN, fetch: withIdentity };
}

async function pullAndCommit(
  rootDir: string,
  workspaceId: string,
  relay: SyncRelayConnection,
) {
  const result = await pullWorkspaceFromRelay({ rootDir, workspaceId, relay });
  await result.commitFetchCursor();
  return result;
}

async function engineText(
  rootDir: string,
  workspaceId: string,
  path: string,
): Promise<string | null> {
  const store = createVersionedTextStore(rootDir);
  try {
    const snapshot = await store
      .readTextFile({ workspaceId, versionId: "main", path })
      .catch(() => null);
    return snapshot?.text ?? null;
  } finally {
    await store.close();
  }
}


// The two-machine conflict-review scenario that lived here was deleted: it was
// `test.fixme`d because file content never reaches the relay (#356), and its
// acceptance criteria are recorded there.


test("join flow: paste the sync code, pick a folder, and the workspace arrives with history, chats, and search", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "join-e2e";
  const machine1 = join(temp.baseDir, "machine1");
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    // Machine 1 (headless): a workspace with file history and a linked chat,
    // pushed to the relay — the state the join must bring over.
    const store1 = createVersionedTextStore(machine1);
    let roadmapObjectId = "";
    try {
      await store1.ensureMainVersion({ workspaceId });
      const first = await store1.writeTextFile({
        workspaceId,
        versionId: "main",
        path: "notes/roadmap.md",
        text: "# Roadmap\n\ndraft one\n",
        metadata: { origin: "local-file" },
      });
      roadmapObjectId = first.object.id;
      await store1.writeTextFile({
        workspaceId,
        versionId: "main",
        path: "notes/roadmap.md",
        text: "# Roadmap\n\nThe galaxy-brain milestone lands next.\n",
        metadata: { origin: "local-file" },
      });
      await store1.writeTextFile({
        workspaceId,
        versionId: "main",
        path: "docs/guide.md",
        text: "A quiet guide.\n",
        metadata: { origin: "local-file" },
      });
      // Perf knob (0P-C evidence runs): DOHC_E2E_JOIN_FILES=1000 seeds a
      // large workspace so the join-to-interactive-shell number reflects a
      // real bootstrap, not a toy one. Default stays small for CI.
      const extraFiles = Number(process.env.DOHC_E2E_JOIN_FILES ?? 0);
      for (let index = 0; index < extraFiles; index += 1) {
        await store1.writeTextFile({
          workspaceId,
          versionId: "main",
          path: `bulk/topic-${Math.floor(index / 50)}/file-${index}.md`,
          text: `# Bulk ${index}\n\n${"Body line for bootstrap benchmarking. ".repeat(12)}\n`,
          metadata: { origin: "local-file" },
        });
      }
    } finally {
      await store1.close();
    }
    const chats1 = createLinkedChatStore(machine1);
    try {
      const thread = await chats1.createThread({
        workspaceId,
        title: "Roadmap sync",
        linkedFile: { objectId: roadmapObjectId, pathHint: "notes/roadmap.md" },
      });
      await chats1.sendMessage({
        workspaceId,
        threadId: thread.id,
        author: { kind: "human", displayName: "Ice" },
        body: "Let's settle the quasar sync cadence this week.",
      });
    } finally {
      await chats1.close();
    }

    const relayDb = join(temp.baseDir, "relay.sqlite");
    relay = await spawnSyncRelay({ dbPath: relayDb });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: TOKEN, workspaceId });
    await pushWorkspaceToRelay({
      rootDir: machine1,
      workspaceId,
      relay: relayConnection(relay.baseUrl),
    });

    // Machine 2 is the app: fresh home (no workspaces), already signed in.
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
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

    // 0P-C gate fix: the join is PULL-FIRST and seeds no starter files, so
    // it can never push boilerplate INTO the shared workspace. The relay log
    // carries no `.context/me.md` op, and the ORIGINAL machine's next pull
    // converges without conflicts or a boilerplate me.md.
    //
    // The joining app adopts the relay's replication identity at a timing the
    // spec does not control (its first claim/push), so both reads below learn
    // the current identity and retry across an adoption racing them — the
    // same pattern as spec 1's polls.
    let identity: RelayWorkspaceIdentity | null = null;
    const loggedPaths: string[] = [];
    await expect
      .poll(
        async () => {
          identity ??= relayAdoptedIdentity(relayDb, workspaceId);
          const connection = identityConnection(relay!.baseUrl, identity);
          const response = await (connection.fetch ?? fetch)(
            `${relay!.baseUrl}/sync/${encodeURIComponent(workspaceId)}/log?since=0&limit=500`,
            { headers: { authorization: `Bearer ${TOKEN}` } },
          );
          if (response.status === 409) {
            // Identity was adopted between our read and this request (or
            // rotated); relearn on the next interval.
            identity = null;
            return null;
          }
          if (!response.ok) throw new Error(`relay log read failed (${response.status})`);
          const body = (await response.json()) as {
            ops: Array<{ payload?: { path?: string } }>;
          };
          loggedPaths.length = 0;
          for (const op of body.ops) {
            if (typeof op.payload?.path === "string") loggedPaths.push(op.payload.path);
          }
          return true;
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBe(true);
    expect(loggedPaths).not.toContain(".context/me.md");
    // Machine 1's pull-back must present the adopted identity too.
    const pullBack = await (async () => {
      for (let attempt = 0; ; attempt += 1) {
        identity ??= relayAdoptedIdentity(relayDb, workspaceId);
        try {
          return await pullAndCommit(
            machine1,
            workspaceId,
            identityConnection(relay!.baseUrl, identity),
          );
        } catch (error) {
          if (!(error instanceof RelayConflictError) || attempt >= 20) throw error;
          identity = null;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    })();
    expect(pullBack.conflictsOpened).toBe(0);
    expect(await engineText(machine1, workspaceId, ".context/me.md")).toBeNull();

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
