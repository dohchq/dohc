import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import * as Y from "yjs";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { editorTabTestId } from "../src/testPins";
import { createWorkspaceEngineCapture } from "../src/workspaces/workspaceEngineCapture";
import { waitForPathMoments } from "../src/workspaces/waitForPathMoments";
import { openLiveDaemonWorkspace } from "./helpers/daemonSeed";
import { ydocLineageClaimStatus } from "./helpers/engineDb";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  seedCloudCredentials,
  showExplorerFiles,
  waitForWorkspaceFile,
  waitForWorkspaceReady,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// The Phase 2 two-instance gate: a board drag on one device updates the
// other device's open board. Device B is the real Electron app with the
// collection's board on screen. Device A is a real daemon-backed workspace
// over the same relay. The serial single-display harness cannot run two
// Electron instances (the 0P-C pattern), so device A makes the write its
// board drag makes: the grouped field set in the record's live document
// session, settled to the file, and pushed. The proof is B's board moving
// the card without any UI refresh. The view re-renders from the index when
// the pulled write applies. (Sync-nudge writes only wake B's pull-based
// sync engine, the same idiom the other sync specs use. They touch nothing
// in the collection.)

const TOKEN = "test:e2e-user";

// Valid record ids (rec_ + 26 chars of a-z2-7) seeded up front, so both
// engines adopt the same identity instead of each minting its own.
const APOLLO_ID = "rec_apolloe2e234567abcdefgh234";
const ZEPHYR_ID = "rec_zephyre2e234567abcdefgh234";

const SCHEMA_YAML = [
  "name: tasks",
  "fields:",
  "  Name:",
  "    type: text",
  "  Status:",
  "    type: select",
  "    options:",
  "      - Todo",
  "      - Doing",
  "views:",
  "  - name: Board",
  "    kind: board",
  "    groupBy: Status",
  "",
].join("\n");

function recordMd(id: string, name: string, status: string): string {
  return `---\nid: ${id}\nName: ${name}\nStatus: ${status}\n---\n`;
}

// The update that sets one frontmatter field, as a record field write makes
// it: decided against the session's doc without changing that doc.
function frontmatterUpdate(doc: Y.Doc, field: string, value: string): Uint8Array {
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
    const captured: { update?: Uint8Array } = {};
    scratch.on("update", (encoded: Uint8Array) => {
      captured.update = encoded;
    });
    patchFrontmatter(scratch, new Map([[field, value]]));
    if (captured.update === undefined) throw new Error(`Setting "${field}" produced no update.`);
    return captured.update;
  } finally {
    scratch.destroy();
  }
}

test("a drag's field write on one device moves the card on the other device's open board", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "collections-board-sync-e2e";
  const sourceRoot = join(temp.baseDir, "device-a");
  let relay: SyncRelayHandle | null = null;
  let deviceA: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | null = null;
  let capture: ReturnType<typeof createWorkspaceEngineCapture> | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await mkdir(join(sourceRoot, "tasks"), { recursive: true });
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay", "relay.sqlite") });
    const relayConfig = { baseUrl: relay.baseUrl, token: TOKEN };

    // Device A: a real daemon workspace seeds the collection the way an
    // agent does — by writing collection.yaml and record files.
    deviceA = await openLiveDaemonWorkspace(
      { workspaceId, rootPath: sourceRoot },
      { maxRestarts: 0 },
    );
    capture = createWorkspaceEngineCapture({
      ...deviceA.workspace,
      rustEngineSessions: deviceA.sessions,
    });
    // As the desktop does when it opens a workspace.
    capture.start();
    const deviceARelay = deviceA.relay.bind({
      ...deviceA.workspace,
      relay: relayConfig,
    });
    await deviceARelay.claim();
    await deviceA.chats.ensureGeneralChannel({ workspaceId });
    expect((await deviceARelay.push()).pushed).toBeGreaterThan(0);

    const schemaPath = "tasks/collection.yaml";
    const apolloPath = "tasks/apollo.md";
    const zephyrPath = "tasks/zephyr.md";
    await writeFile(join(sourceRoot, schemaPath), SCHEMA_YAML);
    await writeFile(
      join(sourceRoot, apolloPath),
      recordMd(APOLLO_ID, "Apollo", "Todo"),
    );
    await writeFile(
      join(sourceRoot, zephyrPath),
      recordMd(ZEPHYR_ID, "Zephyr", "Doing"),
    );
    await Promise.all([
      waitForPathMoments(capture, schemaPath, 1),
      waitForPathMoments(capture, apolloPath, 1),
      waitForPathMoments(capture, zephyrPath, 1),
    ]);
    expect((await deviceARelay.push()).pushed).toBeGreaterThan(0);

    // Device B: the real app joins the synced workspace through the
    // first-run join flow.
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
    await page.getByTestId("first-run-join-synced").click();
    await page
      .getByTestId("join-sync-code")
      .fill(`dohc-sync:${workspaceId}:${relay.baseUrl}`);
    await page.getByTestId("join-choose-folder").click();
    await page.getByTestId("join-workspace-start").click();
    await waitForWorkspaceReady(page);
    await showExplorerFiles(page);
    await waitForWorkspaceFile(page, workspaceId, schemaPath);
    await waitForWorkspaceFile(page, workspaceId, apolloPath);
    expect(await readFile(join(temp.rootPath, apolloPath), "utf8")).toContain(
      "Status: Todo",
    );

    // Open the collection in three separately-named layers: the tree row
    // exposes data-collection once the engine lists the folder as a
    // collection (the state arrives on the same activity cadence as the
    // files), then one click routes to the views. A failure names whether
    // the collection state, the click, or the routing broke.
    const tasksRow = page.locator('[data-testid="tree-row"][data-path="tasks"]');
    await expect(tasksRow).toHaveAttribute("data-collection", "true", {
      timeout: 60_000,
    });
    await tasksRow.click();
    await expect(page.getByTestId("collection-page")).toBeVisible({
      timeout: 30_000,
    });

    // The schema's only view is the board, so the open collection IS the
    // open board: Apollo under Todo, Zephyr under Doing.
    const todoApollo = page.locator(
      'section[aria-label="Todo"] [role="listitem"][aria-label="Apollo"]',
    );
    const doingApollo = page.locator(
      'section[aria-label="Doing"] [role="listitem"][aria-label="Apollo"]',
    );
    await expect(todoApollo).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('section[aria-label="Doing"] [role="listitem"][aria-label="Zephyr"]'),
    ).toBeVisible();

    // Device A drags Apollo to Doing. Its board sets the grouped field in the
    // record's live document session and settles it to the file. The same
    // session write runs here, then the push.
    const apolloSession = await capture.openRecordSession(apolloPath);
    try {
      const journaled = await apolloSession.applyDecidedLocalUpdate(
        (doc) => frontmatterUpdate(doc, "Status", "Doing"),
        () => undefined,
        {},
      );
      expect(journaled).toBe(true);
      await apolloSession.settleNow({ summary: "Updated apollo" });
    } finally {
      await apolloSession.close();
    }
    // The settle is confirmed: its moment is recorded and A's file holds it.
    await waitForPathMoments(capture, apolloPath, 2);
    await expect
      .poll(async () => await readFile(join(sourceRoot, apolloPath), "utf8"))
      .toContain("Status: Doing");
    expect((await deviceARelay.push()).pushed).toBeGreaterThan(0);

    // The write reaches B's DISK first (the sync layer's proof, separated
    // from the view's so a failure names its layer). The nudge writes only
    // wake B's pull-based sync engine — they live outside the collection
    // folder, so they cannot refresh the board themselves.
    let nudge = 0;
    await expect
      .poll(
        async () => {
          nudge += 1;
          await writeWorkspaceFiles(temp, [
            { path: `nudges/sync-nudge-${nudge}.md`, contents: `nudge ${nudge}\n` },
          ]);
          try {
            return (
              await readFile(join(temp.rootPath, apolloPath), "utf8")
            ).includes("Status: Doing");
          } catch {
            return false;
          }
        },
        { timeout: 90_000, intervals: [2000] },
      )
      .toBe(true);

    // The pulled apply must land in B's INDEX — the views read the index,
    // not the file, so this separates an engine indexing gap from a view
    // refresh gap.
    await expect
      .poll(
        async () =>
          await page.evaluate(async (id) => {
            const api = (
              window as unknown as {
                dohcDesktop: Pick<DohcDesktopBridge, "queryCollectionRecords">;
              }
            ).dohcDesktop;
            try {
              const result = await api.queryCollectionRecords({
                workspaceId: id,
                collectionPath: "tasks",
              });
              const apollo = result.records.find(
                (record) => record.path === "tasks/apollo.md",
              );
              return (
                apollo?.values.find((entry) => entry.field === "Status")
                  ?.value ?? null
              );
            } catch (error) {
              // Surface the query failure in the poll's report instead of
              // timing out on a silent null.
              return `queryCollectionRecords failed: ${String(error)}`;
            }
          }, workspaceId),
        { timeout: 30_000, intervals: [1000] },
      )
      .toBe("Doing");

    // Device B's open board moves the card with no manual refresh: the
    // pulled apply fires the collection's activity refresh and the board
    // re-renders from the index.
    await expect(doingApollo).toBeVisible({ timeout: 30_000 });
    await expect(todoApollo).toHaveCount(0);
  } finally {
    // Stop the daemon and relay children before removing the temp tree they
    // hold open — Windows refuses to unlink open files (EBUSY).
    await capture?.stop().catch(() => undefined);
    await deviceA?.close().catch(() => undefined);
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// An agent on device A saves the record as a plain file, with no live
// document session. Device B opened the record once, so its copy holds a
// claimed Y.Doc lineage, but B made no edits. A holds no claim, because it
// never pulls B's lineage, so B cannot take the file as a Y.Doc update. B
// opens a conflict instead, and its board keeps the old value until the
// person resolves the conflict.
test("an agent's file save on one device opens a conflict against the other device's claimed record", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "collections-board-file-save-e2e";
  const sourceRoot = join(temp.baseDir, "device-a");
  let relay: SyncRelayHandle | null = null;
  let deviceA: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | null = null;
  let capture: ReturnType<typeof createWorkspaceEngineCapture> | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await mkdir(join(sourceRoot, "tasks"), { recursive: true });
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay", "relay.sqlite") });
    deviceA = await openLiveDaemonWorkspace(
      { workspaceId, rootPath: sourceRoot },
      { maxRestarts: 0 },
    );
    capture = createWorkspaceEngineCapture({
      ...deviceA.workspace,
      rustEngineSessions: deviceA.sessions,
    });
    // Keep A file-only: the desktop capture poll adopts collection records into Y.Docs.
    const deviceARelay = deviceA.relay.bind({
      ...deviceA.workspace,
      relay: { baseUrl: relay.baseUrl, token: TOKEN },
    });
    await deviceARelay.claim();
    await deviceA.chats.ensureGeneralChannel({ workspaceId });
    expect((await deviceARelay.push()).pushed).toBeGreaterThan(0);

    const schemaPath = "tasks/collection.yaml";
    const apolloPath = "tasks/apollo.md";
    await writeFile(join(sourceRoot, schemaPath), SCHEMA_YAML);
    await writeFile(join(sourceRoot, apolloPath), recordMd(APOLLO_ID, "Apollo", "Todo"));
    await Promise.all([
      waitForPathMoments(capture, schemaPath, 1),
      waitForPathMoments(capture, apolloPath, 1),
    ]);
    expect((await deviceARelay.push()).pushed).toBeGreaterThan(0);

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
    await page.getByTestId("first-run-join-synced").click();
    await page
      .getByTestId("join-sync-code")
      .fill(`dohc-sync:${workspaceId}:${relay.baseUrl}`);
    await page.getByTestId("join-choose-folder").click();
    await page.getByTestId("join-workspace-start").click();
    await waitForWorkspaceReady(page);
    await showExplorerFiles(page);
    await waitForWorkspaceFile(page, workspaceId, apolloPath);

    const tasksRow = page.locator('[data-testid="tree-row"][data-path="tasks"]');
    await expect(tasksRow).toHaveAttribute("data-collection", "true", {
      timeout: 60_000,
    });
    await tasksRow.click();
    await expect(page.getByTestId("collection-page")).toBeVisible({
      timeout: 30_000,
    });
    const todoApollo = page.locator(
      'section[aria-label="Todo"] [role="listitem"][aria-label="Apollo"]',
    );
    const doingApollo = page.locator(
      'section[aria-label="Doing"] [role="listitem"][aria-label="Apollo"]',
    );
    await expect(todoApollo).toBeVisible({ timeout: 30_000 });

    // B claims its copy: the card opens the record's live document, and
    // closing it originates the lineage's base. B types nothing.
    await todoApollo.click();
    const apolloTab = page.getByTestId(editorTabTestId(apolloPath));
    await expect(apolloTab).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("markdown-editor")).toHaveAttribute(
      "contenteditable",
      "true",
    );
    await apolloTab.hover();
    await apolloTab.getByRole("button", { name: /^Close / }).click();
    await expect(apolloTab).toHaveCount(0);
    await expect
      .poll(() => ydocLineageClaimStatus(temp.rootPath, apolloPath), {
        timeout: 30_000,
      })
      .toBe("exact");
    await page.getByTestId(editorTabTestId("tab://collection/tasks")).click();
    await expect(todoApollo).toBeVisible();

    expect(ydocLineageClaimStatus(sourceRoot, apolloPath)).toBeNull();

    // A saves the file the way an agent does, with no session, and never
    // pulls, so it holds no claim on B's lineage.
    await writeFile(join(sourceRoot, apolloPath), recordMd(APOLLO_ID, "Apollo", "Doing"));
    await waitForPathMoments(capture, apolloPath, 2);
    expect((await deviceARelay.push()).pushed).toBeGreaterThan(0);

    const conflictsOnB = async () =>
      await page.evaluate(async (id) => {
        const api = (
          window as unknown as {
            dohcDesktop: Pick<DohcDesktopBridge, "listWorkspaceVersionConflicts">;
          }
        ).dohcDesktop;
        return (await api.listWorkspaceVersionConflicts({ workspaceId: id })).conflicts;
      }, workspaceId);
    const statusOnB = async () =>
      await page.evaluate(async (id) => {
        const api = (
          window as unknown as {
            dohcDesktop: Pick<DohcDesktopBridge, "queryCollectionRecords">;
          }
        ).dohcDesktop;
        const result = await api.queryCollectionRecords({
          workspaceId: id,
          collectionPath: "tasks",
        });
        const apollo = result.records.find((record) => record.path === "tasks/apollo.md");
        return apollo?.values.find((entry) => entry.field === "Status")?.value ?? null;
      }, workspaceId);

    // The conflict opens on B. Nudge writes outside the collection only wake
    // B's pull.
    let nudge = 0;
    await expect
      .poll(
        async () => {
          nudge += 1;
          await writeWorkspaceFiles(temp, [
            { path: `nudges/sync-nudge-${nudge}.md`, contents: `nudge ${nudge}\n` },
          ]);
          return (await conflictsOnB()).map((conflict) => conflict.path);
        },
        { timeout: 90_000, intervals: [2000] },
      )
      .toEqual([apolloPath]);
    const [conflict] = await conflictsOnB();
    if (!conflict) throw new Error("The conflict closed before the test read it.");
    expect(conflict.origin).toBe("sync");
    expect(conflict.currentText).toContain("Status: Todo");
    expect(conflict.incomingText).toContain("Status: Doing");
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "conflict");

    // Until the person resolves it, B's file, index, and board keep Todo.
    expect(await readFile(join(temp.rootPath, apolloPath), "utf8")).toContain("Status: Todo");
    expect(await statusOnB()).toBe("Todo");
    await expect(todoApollo).toBeVisible();
    await expect(doingApollo).toHaveCount(0);

    // Applying the incoming side moves the card.
    await page.evaluate(
      async ({ id, conflictId }) => {
        const api = (
          window as unknown as {
            dohcDesktop: Pick<DohcDesktopBridge, "resolveWorkspaceVersionConflict">;
          }
        ).dohcDesktop;
        await api.resolveWorkspaceVersionConflict({
          workspaceId: id,
          conflictId,
          resolution: { kind: "keep-incoming" },
        });
      },
      { id: workspaceId, conflictId: conflict.conflictId },
    );
    expect(await conflictsOnB()).toEqual([]);
    await expect
      .poll(statusOnB, { timeout: 30_000, intervals: [1000] })
      .toBe("Doing");
    await expect(doingApollo).toBeVisible({ timeout: 30_000 });
    await expect(todoApollo).toHaveCount(0);
    expect(await readFile(join(temp.rootPath, apolloPath), "utf8")).toContain("Status: Doing");
  } finally {
    await capture?.stop().catch(() => undefined);
    await deviceA?.close().catch(() => undefined);
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
