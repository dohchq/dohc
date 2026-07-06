import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  claimRelayWorkspace,
  createLinkedChatStore,
  createVersionedTextStore,
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
} from "@dohc/workspace-engine";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
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
// Spec 1: offline divergence -> rejoin -> conflict notice -> resolve in the
//         app's review dialog -> the other machine's mirror closes.
// Spec 2: join flow — seed a synced workspace from the headless machine,
//         drive the app's "Join a synced workspace" UI, assert files,
//         history, chats, and search all arrived.

const TOKEN = "test:e2e-user";

function relayConnection(baseUrl: string) {
  return { baseUrl, token: TOKEN };
}

async function pullAndCommit(rootDir: string, workspaceId: string, baseUrl: string) {
  const result = await pullWorkspaceFromRelay({
    rootDir,
    workspaceId,
    relay: relayConnection(baseUrl),
  });
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

async function openConflictCount(rootDir: string, workspaceId: string): Promise<number> {
  const store = createVersionedTextStore(rootDir);
  try {
    return (await store.listTextConflicts({ workspaceId, status: "open" })).length;
  } finally {
    await store.close();
  }
}

test("offline edits on two machines surface as a reviewable conflict and the resolution settles both", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "rejoin-e2e";
  const machine2 = join(temp.baseDir, "machine2");
  const relayDb = join(temp.baseDir, "relay.sqlite");
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceSettings(temp, { experimental: { workspaceEngineAlpha: true } });
    await writeWorkspaceFiles(temp, [
      { path: "notes/plan.md", contents: "shared draft\n" },
    ]);

    relay = await spawnSyncRelay({ dbPath: relayDb });
    await claimRelayWorkspace({ workspaceId, relay: relayConnection(relay.baseUrl) });
    await seedWorkspaceRegistry(temp, [
      {
        workspaceId,
        rootPath: temp.rootPath,
        remote: { serverUrl: relay.baseUrl, remoteWorkspaceId: workspaceId },
      },
    ]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
    });

    desktop = await launchDesktopApp({
      workspace: temp,
      env: {
        // Hermetic timing: production debounce/backoff would stretch this
        // spec past the harness budget without changing what is proven.
        DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
        DOHC_TEST_SYNC_BACKOFF_MS: "250",
      },
    });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    // Machine 2 (headless) bootstraps the workspace from the relay once the
    // app's first sync has pushed the captured file.
    await expect
      .poll(
        async () => {
          await pullAndCommit(machine2, workspaceId, relay!.baseUrl);
          return engineText(machine2, workspaceId, "notes/plan.md");
        },
        { timeout: 90_000, intervals: [1000] },
      )
      .toBe("shared draft\n");

    // --- Offline: the relay goes away; both machines edit the same file.
    await relay.stop();
    await writeWorkspaceFiles(temp, [
      { path: "notes/plan.md", contents: "this machine, offline\n" },
    ]);
    const store2 = createVersionedTextStore(machine2);
    try {
      await store2.writeTextFile({
        workspaceId,
        versionId: "main",
        path: "notes/plan.md",
        text: "other machine, offline\n",
        metadata: { origin: "api" },
      });
    } finally {
      await store2.close();
    }

    // --- Rejoin: same relay data, same port (the app keeps retrying).
    relay = await spawnSyncRelay({ dbPath: relayDb, port: relay.port });
    await pushWorkspaceToRelay({
      rootDir: machine2,
      workspaceId,
      relay: relayConnection(relay.baseUrl),
    });
    // A separate-file edit nudges the app's debounced sync promptly (its
    // backoff retry would also get there).
    await writeWorkspaceFiles(temp, [{ path: "notes/nudge.md", contents: "nudge\n" }]);

    // The conflict surfaces: status bar flips and the notice center carries
    // the two-machines notice linking to the review dialog.
    await expect(page.getByTestId("sync-status")).toHaveAttribute(
      "data-state",
      "conflict",
      { timeout: 90_000 },
    );
    await page.getByTestId("notice-center-toggle").click();
    const notice = page.getByTestId("notice-sync-conflict");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("changed on two machines");
    await notice.getByRole("button", { name: "Review" }).click();

    const dialog = page.getByTestId("conflict-review-dialog");
    await expect(dialog).toBeVisible();
    const card = dialog.locator(
      '[data-testid="version-conflict"][data-conflict-path="notes/plan.md"]',
    );
    await expect(card).toBeVisible();
    // Sync conflicts speak in machines, not versions.
    await expect(card).toContainText("On this machine");
    await expect(card).toContainText("On your other machine");
    await expect(card).toContainText("this machine, offline");
    await expect(card).toContainText("other machine, offline");

    // Keep the other machine's copy.
    await card.getByTestId("version-conflict-keep-incoming").click();
    await expect(page.getByTestId("conflict-review-empty")).toBeVisible();
    await page.getByTestId("conflict-review-done").click();

    // The choice materialized to THIS machine's disk.
    await expect
      .poll(() => readFile(join(temp.rootPath, "notes/plan.md"), "utf8"), {
        timeout: 30_000,
      })
      .toBe("other machine, offline\n");

    // The resolution replicates: machine 2's mirrored conflict closes and
    // its content stays the chosen copy — the round trip settles.
    await expect
      .poll(
        async () => {
          await pullAndCommit(machine2, workspaceId, relay!.baseUrl);
          return openConflictCount(machine2, workspaceId);
        },
        { timeout: 90_000, intervals: [1000] },
      )
      .toBe(0);
    expect(await engineText(machine2, workspaceId, "notes/plan.md")).toBe(
      "other machine, offline\n",
    );

    // And the app's own status leaves the conflict state (open-conflict
    // truth, not a sticky accumulator).
    await expect(page.getByTestId("sync-status")).not.toHaveAttribute(
      "data-state",
      "conflict",
      { timeout: 60_000 },
    );
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
    await relay?.stop();
  }
});

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

    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({ workspaceId, relay: relayConnection(relay.baseUrl) });
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
    await cleanupDesktopWorkspace(desktop, temp);
    await relay?.stop();
  }
});
