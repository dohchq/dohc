import { expect, test } from "@playwright/test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendCliRequest } from "@dohc/cli/client";
import {
  CLI_PROTOCOL_VERSION,
  type CliRequestWithoutToken,
  type CliResultByVerb,
  type CliVerb,
} from "@dohc/cli/protocol";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type {
  AutomationFailureNotice,
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

// The Phase 4 automations gate (docs/plans/collections.md): a record change
// fires a subscribed automation on its ORIGIN device exactly once, the
// automation's own writes never re-trigger it, a chain of automations stops
// at the depth cap with an owner-visible failure, and record history on both
// devices attributes the automation's writes to the automation acting on
// behalf of its owner (ADR 0008).
//
// Topology, per the two prior collection gates: device B is the real
// Electron app running the fixture plugin (the only plugin host, so under
// origin-device execution it is the only device that can run automations);
// device A is a real daemon-backed workspace over the same relay — the
// serial single-display harness cannot run two Electron instances (the 0P-C
// pattern). That inverts the race per ADR 0008: the proof is not "two
// devices raced and one won" but "the origin executed, the other provably
// did not" — B-authored changes claim and run on B alone, A-authored
// changes claim on neither device, and exactly-once follows by construction
// from the durable claim table. History rows, derived on every device from
// the same replicated ops, are the one execution counter observable from
// both sides.

const TOKEN = "test:e2e-user";

// Valid record ids (rec_ + 26 chars of a-z2-7) seeded up front, so both
// engines adopt the same identity instead of each minting its own.
const APOLLO_ID = "rec_apolloe2e234567abcdefgh234";
const ZEPHYR_ID = "rec_zephyre2e234567abcdefgh234";
const WARMUP_ID = "rec_warmupe2e34567abcdefgh2345";
const CHAIN_A_ID = "rec_chainae2e34567abcdefgh2345";
const CHAIN_B_ID = "rec_chainbe2e34567abcdefgh2345";

// The engine id the fixture's automations subscribe and write under:
// "<plugin name>/<automation id>".
const TRIAGE = "hello-plugin/triage";
const PING = "hello-plugin/ping";

const TASKS_SCHEMA_YAML = [
  "name: tasks",
  "fields:",
  "  Name:",
  "    type: text",
  "  Status:",
  "    type: select",
  "    options:",
  "      - Todo",
  "      - Doing",
  "      - Reviewed",
  "",
].join("\n");

function chainSchemaYaml(name: string): string {
  return [
    `name: ${name}`,
    "fields:",
    "  Name:",
    "    type: text",
    "  Step:",
    "    type: text",
    "",
  ].join("\n");
}

function taskMd(id: string, name: string, status: string): string {
  return `---\nid: ${id}\nName: ${name}\nStatus: ${status}\n---\n`;
}

function counterMd(id: string, name: string): string {
  return `---\nid: ${id}\nName: ${name}\nStep: start\n---\n`;
}

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/hello-plugin/", import.meta.url),
);

// What the fixture's automation mode accumulates: the facts of every
// automation run its registered handlers received, reported through the one
// declared command.
interface AutomationRunReport {
  runs: Array<{
    claimId: string;
    manifestAutomationId: string;
    collectionPath: string;
    recordId: string;
    depth: number;
  }>;
}

type CliHistoryEntry = Extract<
  CliResultByVerb["collectionRecord"],
  { ok: true }
>["history"][number];

test("a record change runs its automation on the origin device exactly once, loop-guarded, chain-capped, and attributed", async () => {
  // The record-events gate's 300s plus the chain and the pull-back to A.
  test.setTimeout(480_000);
  const temp = await createTempWorkspace();
  const workspaceId = "collections-automation-e2e";
  const sourceRoot = join(temp.baseDir, "device-a");
  let relay: SyncRelayHandle | null = null;
  let deviceA: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | null = null;
  let capture: ReturnType<typeof createWorkspaceEngineCapture> | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  const launchEnv = {
    DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
    DOHC_TEST_SYNC_BACKOFF_MS: "250",
    DOHC_PLUGIN_FIXTURE_MODE: "automation",
  };

  // One agent-side collection call over the desktop CLI socket, exactly the
  // agent-walkthrough's helper: the CLI hop derives the agent author
  // main-side, so a trigger written this way is a B-origin agent change.
  async function agentCli<Verb extends CliVerb>(
    verb: Verb,
    args: Omit<
      Extract<CliRequestWithoutToken, { verb: Verb }>["args"],
      "cwd" | "actor"
    >,
  ): Promise<CliResultByVerb[Verb]> {
    const request = {
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb,
      args: { cwd: temp.rootPath, actor: "agent" as const, ...args },
    } as unknown as Extract<CliRequestWithoutToken, { verb: Verb }>;
    return await sendCliRequest<Verb>(request, { stateDir: temp.homeDir });
  }

  async function waitForCliEndpoint(): Promise<void> {
    const endpointFile =
      process.platform === "win32" ? "dohc-cli-endpoint" : "dohc-cli.sock";
    await expect
      .poll(
        async () => {
          try {
            await Promise.all([
              access(join(temp.homeDir, endpointFile)),
              access(join(temp.homeDir, "dohc-cli-token")),
            ]);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 10_000, intervals: [50, 100, 250] },
      )
      .toBe(true);
  }

  // Triggers the fixture's report command over the real command surface and
  // reads what it wrote. A refusal comes back in-band so a poll names it.
  async function readRunReport(): Promise<AutomationRunReport | string> {
    const page = desktop!.page;
    const invoked: InvokePluginCommandResult | { status: string; message: string } =
      await page.evaluate(
        async ({ id }) => {
          const api = (
            window as unknown as {
              dohcDesktop: Pick<DohcDesktopBridge, "invokePluginCommand">;
            }
          ).dohcDesktop;
          try {
            return await api.invokePluginCommand({
              workspaceId: id,
              pluginId: "hello-plugin",
              commandId: "hello.write",
            });
          } catch (error) {
            return { status: "invoke-threw" as const, message: String(error) };
          }
        },
        { id: workspaceId },
      );
    if (invoked.status !== "ok") return JSON.stringify(invoked);
    try {
      return JSON.parse(
        await readFile(join(temp.rootPath, "automation-run-report.json"), "utf8"),
      ) as AutomationRunReport;
    } catch {
      return "automation run report not on disk yet";
    }
  }

  function runsFor(
    report: AutomationRunReport | string,
    recordId: string,
  ): AutomationRunReport["runs"] {
    if (typeof report === "string") return [];
    return report.runs.filter((run) => run.recordId === recordId);
  }

  // A zero-run assertion must fail loud on an unreadable report, or it
  // passes vacuously while the plugin is mid-write or refusing.
  function runsForOrThrow(
    report: AutomationRunReport | string,
    recordId: string,
  ): AutomationRunReport["runs"] {
    if (typeof report === "string") throw new Error(`run report unreadable: ${report}`);
    return runsFor(report, recordId);
  }

  // The owner-visible failure surface, read through the real renderer
  // bridge — the exact rows the notice center renders.
  async function listFailures(): Promise<AutomationFailureNotice[]> {
    const page = desktop!.page;
    const result = await page.evaluate(
      async ({ id }) => {
        const api = (
          window as unknown as {
            dohcDesktop: Pick<DohcDesktopBridge, "listAutomationFailures">;
          }
        ).dohcDesktop;
        return await api.listAutomationFailures({ workspaceId: id });
      },
      { id: workspaceId },
    );
    return result.failures;
  }

  // One record read on B over the CLI: the same surface an agent uses, and
  // the carrier of the attribution columns this gate asserts.
  async function recordOnB(
    collectionPath: string,
    recordId: string,
  ): Promise<CliHistoryEntry[]> {
    const detail = await agentCli("collectionRecord", {
      collectionPath,
      recordId,
      historyLimit: 100,
    });
    if (!detail.ok) throw new Error(`collectionRecord failed: ${detail.reason}`);
    return detail.history;
  }

  // The automation-attributed rows of one record's history, oldest first
  // (the RPC pages newest-first). Generic: B reads through the CLI, A
  // through daemon RPC, and both carry the same attribution columns.
  function automationRows<
    Entry extends { actorKind: string | null; historyId: number },
  >(history: Entry[]): Entry[] {
    return history
      .filter((entry) => entry.actorKind === "automation")
      .sort((left, right) => left.historyId - right.historyId);
  }

  // The same read on A, straight over daemon RPC — the daemon serves
  // collections.getRecord itself, so the bare-daemon device reads the same
  // derived history rows through the sessions handle the harness holds.
  async function historyOnA(collectionPath: string, recordId: string) {
    return await deviceA!.sessions.run(deviceA!.workspace, async (binding) => {
      const adapter = new VersionedLiveAdapter(binding.client, binding.workspace, {
        workspaceId,
      });
      const result = await adapter.getCollectionRecord({
        collectionPath,
        recordId,
        historyLimit: 100,
      });
      return result.history;
    });
  }

  // A's claim table, read through the one claim-consuming RPC: null means
  // no pending claim exists on A for any key. Safe on A — nothing ever
  // subscribes automations on A's engine, so this cannot steal work.
  async function claimPendingOnA(): Promise<unknown> {
    return await deviceA!.sessions.run(deviceA!.workspace, async (binding) => {
      const adapter = new VersionedLiveAdapter(binding.client, binding.workspace, {
        workspaceId,
      });
      return await adapter.claimNextAutomation();
    });
  }

  try {
    await mkdir(join(sourceRoot, "tasks"), { recursive: true });
    await mkdir(join(sourceRoot, "chain-a"), { recursive: true });
    await mkdir(join(sourceRoot, "chain-b"), { recursive: true });
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    const relayConfig = { baseUrl: relay.baseUrl, token: TOKEN };

    // Device A: a real daemon workspace seeds the collections the way an
    // agent does — by writing schema and record files.
    deviceA = await openLiveDaemonWorkspace(
      { workspaceId, rootPath: sourceRoot },
      { maxRestarts: 0 },
    );
    capture = createWorkspaceEngineCapture({
      ...deviceA.workspace,
      rustEngineSessions: deviceA.sessions,
    });
    const deviceARelay = deviceA.relay.bind({
      ...deviceA.workspace,
      relay: relayConfig,
    });
    await deviceARelay.claim();
    await deviceA.chats.ensureGeneralChannel({ workspaceId });
    expect((await deviceARelay.push()).pushed).toBeGreaterThan(0);

    const seedPaths = [
      ["tasks/collection.yaml", TASKS_SCHEMA_YAML],
      ["tasks/apollo.md", taskMd(APOLLO_ID, "Apollo", "Todo")],
      ["tasks/zephyr.md", taskMd(ZEPHYR_ID, "Zephyr", "Doing")],
      ["tasks/warmup.md", taskMd(WARMUP_ID, "Warmup", "Todo")],
      ["chain-a/collection.yaml", chainSchemaYaml("chain-a")],
      ["chain-a/counter.md", counterMd(CHAIN_A_ID, "Counter A")],
      ["chain-b/collection.yaml", chainSchemaYaml("chain-b")],
      ["chain-b/counter.md", counterMd(CHAIN_B_ID, "Counter B")],
    ] as const;
    for (const [path, contents] of seedPaths) {
      await writeFile(join(sourceRoot, path), contents);
    }
    capture.captureBatch(
      seedPaths.map(([path]) => ({ path, operation: "update" as const })),
    );
    await Promise.all(
      seedPaths.map(([path]) => waitForPathMoments(capture!, path, 1)),
    );
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
    await waitForWorkspaceFile(page, workspaceId, "tasks/collection.yaml");
    await waitForWorkspaceFile(page, workspaceId, "tasks/apollo.md");
    await waitForWorkspaceFile(page, workspaceId, "chain-a/counter.md");
    await waitForWorkspaceFile(page, workspaceId, "chain-b/counter.md");

    // Seed and install the fixture plugin from the real Plugins view. Its
    // manifest declares ping and pong before triage, so once a triage run is
    // observed, the chain pair's engine subscriptions provably landed first
    // (one reconcile registers the manifest's automations in order).
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
    await waitForCliEndpoint();

    // The subscription barrier: the engine subscribes the automations only
    // after the installed plugin reaches a runnable status, so an edit
    // racing that reconcile is a permanent miss for that change (never a
    // late double). Poke a throwaway record until the first triage run
    // reports back; every measured trigger below happens after this proof.
    let warmupStatus = "Todo";
    async function pokeWarmup(): Promise<CliResultByVerb["collectionSetFields"]> {
      warmupStatus = warmupStatus === "Todo" ? "Doing" : "Todo";
      return await agentCli("collectionSetFields", {
        recordPath: "tasks/warmup.md",
        fields: { Status: warmupStatus },
      });
    }
    await expect
      .poll(
        async () => {
          try {
            const poked = await pokeWarmup();
            if (!poked.ok) return `setFields refused: ${poked.reason}`;
          } catch (error) {
            return `setFields threw: ${String(error)}`;
          }
          const report = await readRunReport();
          if (typeof report === "string") return report;
          return runsFor(report, WARMUP_ID).length > 0
            ? "warmed up"
            : "no warmup run yet";
        },
        { timeout: 180_000, intervals: [2000] },
      )
      .toBe("warmed up");

    // --- (a) Exactly once on the origin. One agent edit on B moves Apollo
    // to Doing; the triage automation claims and runs on B exactly once and
    // writes Status back to Reviewed.
    const apolloTrigger = await agentCli("collectionSetFields", {
      recordPath: "tasks/apollo.md",
      fields: { Status: "Doing" },
    });
    if (!apolloTrigger.ok) {
      throw new Error(`apollo trigger failed: ${apolloTrigger.reason}`);
    }
    await expect
      .poll(
        async () => runsFor(await readRunReport(), APOLLO_ID).length,
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(1);
    // The run's write lands in history as the automation's own actor.
    await expect
      .poll(
        async () => automationRows(await recordOnB("tasks", APOLLO_ID)).length,
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(1);
    const apolloHistory = await recordOnB("tasks", APOLLO_ID);
    // The trigger row: the CLI hop's derived agent author at depth 0.
    const trigger = apolloHistory.find(
      (entry) => entry.field === "Status" && entry.next.value === "Doing",
    );
    expect(trigger).toMatchObject({
      actorKind: "agent",
      authorOriginId: "dohc-mcp",
      onBehalfOf: "local",
      depth: 0,
    });
    // The automation's row: its own actor, on behalf of the owner, one
    // deeper than its trigger.
    expect(automationRows(apolloHistory)).toMatchObject([
      {
        field: "Status",
        next: { value: "Reviewed" },
        actorKind: "automation",
        authorOriginId: TRIAGE,
        onBehalfOf: "local",
        depth: 1,
      },
    ]);
    expect(await listFailures()).toEqual([]);

    // --- Loop guard. Apollo now says Reviewed, and triage sets Reviewed
    // again on every run — a naive loop would re-trigger forever. A second
    // trigger proves the guard: claims drain oldest first, so if triage's
    // own write had claimed, that extra run would surface before or with
    // this one. The count lands on exactly 2.
    const apolloAgain = await agentCli("collectionSetFields", {
      recordPath: "tasks/apollo.md",
      fields: { Status: "Todo" },
    });
    if (!apolloAgain.ok) {
      throw new Error(`second apollo trigger failed: ${apolloAgain.reason}`);
    }
    await expect
      .poll(
        async () => runsFor(await readRunReport(), APOLLO_ID).length,
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(2);
    expect(runsFor(await readRunReport(), APOLLO_ID)).toMatchObject([
      { manifestAutomationId: "triage", depth: 0 },
      { manifestAutomationId: "triage", depth: 0 },
    ]);
    expect(await listFailures()).toEqual([]);

    // --- (b) A change authored on A claims on neither device: A has no
    // subscriptions (nothing registered any), and B's apply of the pulled
    // update is not the origin's. Edit Zephyr through A's own capture path.
    const zephyrOnA = await readFile(join(sourceRoot, "tasks/zephyr.md"), "utf8");
    const editedOnA = zephyrOnA.replace("Status: Doing", "Status: Todo");
    expect(editedOnA).not.toBe(zephyrOnA);
    await writeFile(join(sourceRoot, "tasks/zephyr.md"), editedOnA);
    capture.captureBatch([{ path: "tasks/zephyr.md", operation: "update" }]);
    await waitForPathMoments(capture, "tasks/zephyr.md", 2);
    expect((await deviceARelay.push()).pushed).toBeGreaterThan(0);

    // Nudge B's pull-based sync until A's edit is applied on B's disk. The
    // nudges live outside every collection, so they cannot claim anything.
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
              await readFile(join(temp.rootPath, "tasks/zephyr.md"), "utf8")
            ).includes("Status: Todo");
          } catch {
            return false;
          }
        },
        { timeout: 90_000, intervals: [2000] },
      )
      .toBe(true);

    // A younger B-origin claim draining proves the older zephyr apply left
    // no claim behind it — the drain serves oldest first.
    const warmupRunsBefore = runsFor(await readRunReport(), WARMUP_ID).length;
    await expect
      .poll(
        async () => {
          const report = await readRunReport();
          if (runsFor(report, WARMUP_ID).length > warmupRunsBefore) {
            return "drained";
          }
          const poked = await pokeWarmup();
          return poked.ok ? "waiting" : `setFields refused: ${poked.reason}`;
        },
        { timeout: 60_000, intervals: [2000] },
      )
      .toBe("drained");
    expect(runsForOrThrow(await readRunReport(), ZEPHYR_ID)).toEqual([]);
    expect(automationRows(await recordOnB("tasks", ZEPHYR_ID))).toEqual([]);
    expect(await listFailures()).toEqual([]);

    // --- The race gate's other half, on A: pull B's writes back and read
    // the same history through A's daemon. Exactly the automation rows B
    // derived — one per trigger — and A's claim table holds nothing.
    await expect
      .poll(
        async () => {
          await capture!.runRelaySync((materializePage) =>
            deviceARelay.pull(materializePage),
          );
          return automationRows(await historyOnA("tasks", APOLLO_ID)).length;
        },
        { timeout: 90_000, intervals: [2000] },
      )
      .toBe(2);
    const apolloOnA = automationRows(await historyOnA("tasks", APOLLO_ID));
    for (const row of apolloOnA) {
      expect(row).toMatchObject({
        field: "Status",
        actorKind: "automation",
        authorOriginId: TRIAGE,
        onBehalfOf: "local",
        depth: 1,
      });
    }
    expect(automationRows(await historyOnA("tasks", ZEPHYR_ID))).toEqual([]);
    expect(await claimPendingOnA()).toBeNull();

    // --- The chain stops at the depth cap. One agent edit on chain-a runs
    // ping (depth 0), whose write to chain-b runs pong (1), whose write to
    // chain-a runs ping (2), then pong (3); pong's depth-4 write would
    // trigger ping again, and dohc instead records one failed claim —
    // "chain-stopped" — where the owner sees it.
    const chainTrigger = await agentCli("collectionSetFields", {
      recordPath: "chain-a/counter.md",
      fields: { Step: "go" },
    });
    if (!chainTrigger.ok) {
      throw new Error(`chain trigger failed: ${chainTrigger.reason}`);
    }
    await expect
      .poll(async () => (await listFailures()).length, {
        timeout: 90_000,
        intervals: [1000],
      })
      .toBe(1);
    expect(await listFailures()).toMatchObject([
      { automationId: PING, error: "chain-stopped", generation: 1 },
    ]);
    // The stop is a notice in the notice center, not only an RPC row.
    await page.getByTestId("notice-center-toggle").click();
    await expect(
      page.getByTestId(`notice-automation-failure-${PING}`),
    ).toContainText("An automation chain stopped");
    await page.getByTestId("notice-center-toggle").click();

    // Two runs each, at the depths the chain dictates, and no fifth run.
    const chainReport = await readRunReport();
    expect(runsFor(chainReport, CHAIN_A_ID)).toMatchObject([
      { manifestAutomationId: "ping", depth: 0 },
      { manifestAutomationId: "ping", depth: 2 },
    ]);
    expect(runsFor(chainReport, CHAIN_B_ID)).toMatchObject([
      { manifestAutomationId: "pong", depth: 1 },
      { manifestAutomationId: "pong", depth: 3 },
    ]);
    // Each hop's write, attributed at its own depth, on both records.
    expect(automationRows(await recordOnB("chain-b", CHAIN_B_ID))).toMatchObject([
      { field: "Step", next: { value: "step-1" }, authorOriginId: PING, depth: 1 },
      { field: "Step", next: { value: "step-3" }, authorOriginId: PING, depth: 3 },
    ]);
    expect(automationRows(await recordOnB("chain-a", CHAIN_A_ID))).toMatchObject([
      {
        field: "Step",
        next: { value: "step-2" },
        authorOriginId: "hello-plugin/pong",
        depth: 2,
      },
      {
        field: "Step",
        next: { value: "step-4" },
        authorOriginId: "hello-plugin/pong",
        depth: 4,
      },
    ]);

    // The chain's writes converge on A identically, and still no claim
    // ever lands on A.
    await expect
      .poll(
        async () => {
          await capture!.runRelaySync((materializePage) =>
            deviceARelay.pull(materializePage),
          );
          const [chainA, chainB] = await Promise.all([
            historyOnA("chain-a", CHAIN_A_ID),
            historyOnA("chain-b", CHAIN_B_ID),
          ]);
          return (
            automationRows(chainA).length + automationRows(chainB).length
          );
        },
        { timeout: 90_000, intervals: [2000] },
      )
      .toBe(4);
    expect(await claimPendingOnA()).toBeNull();

    // A final sweep long after the loop-guarded runs: still exactly two
    // apollo runs, none for zephyr — no slow loop crept in behind the
    // earlier asserts.
    const finalReport = await readRunReport();
    expect(runsFor(finalReport, APOLLO_ID)).toHaveLength(2);
    expect(runsFor(finalReport, ZEPHYR_ID)).toEqual([]);
  } catch (error) {
    // A plugin activation failure only says "disabled" through the command
    // surface; the crash itself lands in the desktop logs. Print them so a
    // failure names the cause, exactly as the record-events gate does.
    for (const entry of desktop?.logs ?? []) {
      if (/plugin|crash|record|automation|claim/i.test(entry.text)) {
        console.log(`[${entry.source}:${entry.level}] ${entry.text}`);
      }
    }
    throw error;
  } finally {
    // Stop the daemon and relay children before removing the temp tree they
    // hold open — Windows refuses to unlink open files (EBUSY).
    await capture?.stop().catch(() => undefined);
    await deviceA?.close().catch(() => undefined);
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
