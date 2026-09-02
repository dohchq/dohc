import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DohcDesktopBridge,
  InvokePluginCommandResult,
} from "../src/ipc/bridgeContract";
import { createWorkspaceEngineCapture } from "../src/workspaces/workspaceEngineCapture";
import { waitForPathMoments } from "../src/workspaces/waitForPathMoments";
import { openLiveDaemonWorkspace } from "./helpers/daemonSeed";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  seedCloudCredentials,
  seedPluginSource,
  waitForWorkspaceFile,
  waitForWorkspaceReady,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// The Phase 3 record-events gate (docs/plans/collections.md): a plugin
// subscribed through collections.watch on device B receives the field-change
// event for an edit made on device A, through sync. Device B is the real
// Electron app running the fixture plugin in its watch-collection mode.
// Device A is a real daemon-backed workspace over the same relay — the
// serial single-display harness cannot run two Electron instances (the 0P-C
// pattern), so device A applies exactly what its own edit applies: the field
// written through the record's file, captured and pushed.
//
// B joins first, then seeds and installs the fixture plugin, and only THEN
// does device A edit — so the subscription is provably live before the event
// it must receive exists.

const TOKEN = "test:e2e-user";

// Valid record ids (rec_ + 26 chars of a-z2-7) seeded up front, so BOTH
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

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/hello-plugin/", import.meta.url),
);

interface ReceivedRecordEvent {
  event: string;
  data: Record<string, unknown>;
}

// What the fixture's one declared command reports: whether collections.watch
// resolved at activation, and every subscription event received so far.
interface CollectionWatchReport {
  started: { ok: boolean; message: string | null } | null;
  received: ReceivedRecordEvent[];
}

// Triggers the fixture's report command over the real command surface. A
// non-ok status comes back as data, so the caller's poll output names the
// refusal instead of timing out on a silent false.
async function invokeReportCommand(
  page: Awaited<ReturnType<typeof launchDesktopApp>>["page"],
  workspaceId: string,
  commandId: string,
): Promise<InvokePluginCommandResult | { status: "invoke-threw"; message: string }> {
  return await page.evaluate(
    async ({ id, command }) => {
      const api = (
        window as unknown as {
          dohcDesktop: Pick<DohcDesktopBridge, "invokePluginCommand">;
        }
      ).dohcDesktop;
      try {
        return await api.invokePluginCommand({
          workspaceId: id,
          pluginId: "hello-plugin",
          commandId: command,
        });
      } catch (error) {
        return { status: "invoke-threw" as const, message: String(error) };
      }
    },
    { id: workspaceId, command: commandId },
  );
}

test("a synced field edit reaches a plugin's collections.watch subscription on the other device", async () => {
  // The two-instance spec's 240s plus the plugin install phase (the platform
  // spec allows 180s for an install alone).
  test.setTimeout(300_000);
  const temp = await createTempWorkspace();
  const workspaceId = "collections-record-events-e2e";
  const sourceRoot = join(temp.baseDir, "device-a");
  let relay: SyncRelayHandle | null = null;
  let deviceA: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | null = null;
  let capture: ReturnType<typeof createWorkspaceEngineCapture> | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  const launchEnv = {
    DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
    DOHC_TEST_SYNC_BACKOFF_MS: "250",
    DOHC_PLUGIN_FIXTURE_MODE: "watch-collection",
    DOHC_PLUGIN_WATCH_COLLECTION: "tasks",
  };

  try {
    await mkdir(join(sourceRoot, "tasks"), { recursive: true });
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
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
      daemonOwnsCapture: true,
    });
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
    capture.captureBatch([
      { path: schemaPath, operation: "update" },
      { path: apolloPath, operation: "update" },
      { path: zephyrPath, operation: "update" },
    ]);
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
    desktop = await launchDesktopApp({ workspace: temp, env: launchEnv });
    const page = desktop.page;
    await page.getByTestId("first-run-join-synced").click();
    await page
      .getByTestId("join-sync-code")
      .fill(`dohc-sync:${workspaceId}:${relay.baseUrl}`);
    await page.getByTestId("join-choose-folder").click();
    await page.getByTestId("join-workspace-start").click();
    await waitForWorkspaceReady(page);
    await waitForWorkspaceFile(page, workspaceId, schemaPath);
    await waitForWorkspaceFile(page, workspaceId, apolloPath);
    expect(await readFile(join(temp.rootPath, apolloPath), "utf8")).toContain(
      "Status: Todo",
    );

    // Seed the fixture plugin into the joined workspace (live seeding is what
    // seedPluginSource's staged rename exists for) and install it from the
    // real Plugins view, exactly as the platform spec does. The joined
    // workspace runs the engine by default, so Plugins are available without
    // any settings seed or relaunch.
    await seedPluginSource(temp, { fixtureRoot, pluginId: "hello-plugin" });
    await page.getByTestId("activity-plugins").click();
    const pluginRow = page.locator('[data-testid="plugin-row"]', {
      has: page.getByText("Hello Plugin", { exact: true }),
    });
    await expect(pluginRow).toBeVisible({ timeout: 60_000 });
    await pluginRow.getByTestId("plugin-install").click();
    await expect(pluginRow.getByTestId("plugin-action-error")).toHaveCount(0, {
      timeout: 180_000,
    });

    // The subscription barrier: the fixture subscribes during activation and
    // its report command says whether collections.watch resolved. Device A
    // must not edit before this holds, or the event could fire before any
    // subscriber exists.
    const reportPath = join(temp.rootPath, "collection-watch-report.json");
    await expect
      .poll(
        async () => {
          const invoked = await invokeReportCommand(page, workspaceId, "hello.write");
          if (invoked.status !== "ok") return JSON.stringify(invoked);
          try {
            return await readFile(reportPath, "utf8");
          } catch {
            return "watch report not on disk yet";
          }
        },
        { timeout: 180_000, intervals: [2000] },
      )
      .toContain('"started":{"ok":true');

    // Device A edits Apollo's grouped field: the identical effect of its own
    // UI edit — the field written through the record's file — captured and
    // pushed.
    const apolloOnA = await readFile(join(sourceRoot, apolloPath), "utf8");
    const editedOnA = apolloOnA.replace("Status: Todo", "Status: Doing");
    expect(editedOnA).not.toBe(apolloOnA);
    await writeFile(join(sourceRoot, apolloPath), editedOnA);
    capture.captureBatch([{ path: apolloPath, operation: "update" }]);
    await waitForPathMoments(capture, apolloPath, 2);
    expect((await deviceARelay.push()).pushed).toBeGreaterThan(0);

    // The write reaches B's DISK first (the sync layer's proof, separated
    // from the plugin's so a failure names its layer). The nudge writes only
    // wake B's pull-based sync engine — they live outside the collection
    // folder, so they cannot produce a record event themselves.
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

    // The plugin's subscription must have received the pulled apply as record
    // events. The report command writes what arrived so far; poll it until
    // the field change shows up, reporting refusals and the events that DID
    // arrive instead of timing out silently.
    let received: ReceivedRecordEvent[] = [];
    await expect
      .poll(
        async () => {
          const invoked = await invokeReportCommand(page, workspaceId, "hello.write");
          if (invoked.status !== "ok") return JSON.stringify(invoked);
          try {
            const report = JSON.parse(
              await readFile(reportPath, "utf8"),
            ) as CollectionWatchReport;
            received = report.received;
          } catch {
            return "watch report not on disk yet";
          }
          return received.map((entry) => entry.event).join(",") || "no events";
        },
        { timeout: 60_000, intervals: [2000] },
      )
      .toContain("record.field.changed");

    // The field-change event carries the edit itself.
    const fieldChanged = received.find(
      (entry) => entry.event === "record.field.changed",
    );
    expect(fieldChanged?.data).toMatchObject({
      collectionPath: "tasks",
      recordId: APOLLO_ID,
      field: "Status",
      previous: "Todo",
      next: "Doing",
    });

    // And the same apply announced the record itself as updated.
    const updatedRecordIds = received
      .filter((entry) => entry.event === "record.updated")
      .map((entry) => entry.data.recordId);
    expect(updatedRecordIds).toContain(APOLLO_ID);
  } catch (error) {
    // A plugin activation failure only says "disabled" through the command
    // surface; the crash itself lands in the desktop logs. Print them so a
    // failure names the cause, exactly as the platform spec does.
    for (const entry of desktop?.logs ?? []) {
      if (/plugin|crash|record|watch/i.test(entry.text)) {
        console.log(`[${entry.source}:${entry.level}] ${entry.text}`);
      }
    }
    throw error;
  } finally {
    // Stop the daemon and relay children BEFORE removing the temp tree they
    // hold open — Windows refuses to unlink open files (EBUSY).
    await capture?.stop().catch(() => undefined);
    await deviceA?.close().catch(() => undefined);
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
