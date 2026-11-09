import { parseHostEpoch } from "@dohc/live-session-contract";
import { createHash, randomUUID } from "node:crypto";
import { restoreDirectWrites } from "./stopAndRestore";
import { engineMomentDetailForIpc } from "../ipc/engineHistoryIpc";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { mintLocalhostCa } from "../../../../services/share-web/src/testing/localhostCa";
import { HostedLogClientClosedError, startServerProxy, type HostedLogResponseBarrier } from "../../e2e/helpers/selfHostOnboarding";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildRelay } from "../../../../services/sync-relay/scripts/build.mjs";
import { stableJsonStringify } from "../../../../services/sync-relay/src/canonicalJson";
import * as Y from "yjs";
import { parseFrontmatter } from "@dohc/ydoc-projection/frontmatter";
import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { createLocalChangeAuthor } from "@dohc/workspace-core";
import { OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import { EngineWorkspaceShuttingDownError } from "@dohc/workspace-engine-client/daemon";
import { DaemonRefusalError, OwnerYDocOutbox, openEngineYdocProviderSession, YdocAdapterError, YdocOwnerDraftPendingError, VersionedLiveAdapter, WorkspaceDaemonRequester, YdocLiveAdapter, type AutomationClaim } from "@dohc/workspace-engine-client";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { collectionRecordWrites } from "@dohc/automation-executor/collection-record-edits";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder, readersTrustLocalState } from "../testing/preparedLocalState";
import { createAutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { runCollectionAutomation } from "@dohc/automation-executor/collection-automation-run";
import { undoCollectionAutomationRuns } from "../../../../packages/automation-executor/src/collectionAutomationUndo";
import { createAutomationTargets } from "../../../../packages/automation-executor/src/automationTargets";
import { openLiveDaemonWorkspace, type CloseStep } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { WILL_QUIT_BUDGET_MS } from "../shutdownBudgets";
import type { EngineRelayWorkspaceClient } from "./engineRelayClient";
import type { DesktopLinkedChatStore } from "./liveLinkedChatStore";
import { probeRelayWorkspace } from "./relayWorkspaceProbe";
import {
  createWorkspaceEngineCapture,
  liveFolderBody,
  LiveFolderError,
  LivePageOwnedError,
  liveFolderTitle,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { waitForPathMoments } from "./waitForPathMoments";
import { createRecordByHand, desktopRecordEditContext } from "./desktopRecordEdits";
import { onWorkspaceCaptureSettled } from "./captureActivityBridge";
import { createSuiteTestScratchSync, createTestScratch } from "./testTemp";
import {deferred} from "../testing/deferred";
import {
  installWorkspaceDataKey,
  loadSecretDataKey,
  SECRET_FILE_STORE_RELATIVE_PATH,
} from "./workspaceDataKey";
import { enrollWorkspaceKeyEnvelope } from "./workspaceKeyEnvelopeEnrollment";
import { bootstrapJoinedWorkspace } from "./workspaceJoinEnrollment";
import { createRelaySyncEngine, type CloudSyncEngine } from "./relaySyncEngine";
import { createRelayLogWait } from "./relayLogWait";
import { selfHostLiveProfile } from "../../../../services/sync-relay/src/selfHostLiveProfile";
import { runNativeOwnerDeliveryPass } from "./nativeOwnerDelivery";
import { readOwnerLiveQuarantines } from "./ownerLiveQuarantine";
import { readyOwnerDeliveryDocuments } from "./serverOwnerDelivery";
import { startServerOwnerDelivery } from "./serverOwnerDelivery";
import { relayShareOperations } from "../ipc/shareOperations";
import type { OwnerLiveDocumentsResult } from "../ipc/bridgeContract";
import { registerOperations } from "../ipc/operationTable";
import {createRelaySharesIpcHandlers} from "../ipc/relaySharesIpc";
import {LIVE_STOP_EDITS_PENDING, liveStopRelayError, readLiveStopRefusal} from "../ipc/liveEditingStop";
import {createPresencePollRegistry} from "../collab/presencePollRegistry";
import {reconcileOwnerLiveStops} from "./ownerLiveStop";
import { MOVE_ACCEPTED_EDITS_WAIT_MS } from "./moveAcceptedEditsGuard";
import {openLiveFolderMoveFixture} from "../testing/liveFolderMoveFixture";
import { livePageBody, livePageTitle } from "../ipc/errorWords";
import { openLiveMoveFixture, recordGuardTimings, type GuardPull, type GuardTiming, type LiveMoveFixture, type MoveDevice } from "../testing/liveMoveFixture";
import {deleteWorkspacePathByHand, moveWorkspacePathByHand} from "./workspaceFileMoves";
import {readLocalStateFrom, type LocalStateBindings} from "./workspaceLocalState";

const engine = requireEngineBinaryOrSkip();

async function waitForHostedLog<T>(barrier: HostedLogResponseBarrier, promise: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Hosted-log ${phase} did not finish within 60 s.`));
        barrier.destroy();
      }, 60_000);
    })]);
  } finally { clearTimeout(timer); }
}

let relayBuildDirectory: string;
let compiledRelayMain: string;

beforeAll(async () => {
  if (engine.missing) return;
  const output = fileURLToPath(new URL("../../../../services/sync-relay/.output/", import.meta.url));
  await mkdir(output, { recursive: true });
  relayBuildDirectory = await mkdtemp(join(output, "two-daemon-sync-"));
  await buildRelay(relayBuildDirectory);
  compiledRelayMain = join(relayBuildDirectory, "main.js");
}, 30_000);

afterAll(async () => {
  if (relayBuildDirectory) {
    await rm(relayBuildDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
}, 30_000);

interface LiveDaemonCapture {
  capture: WorkspaceEngineCapture;
  chats: DesktopLinkedChatStore;
  relay: EngineRelayWorkspaceClient;
  refusalNotices(): Promise<unknown>;
  queryCollectionRecords: VersionedLiveAdapter["queryCollectionRecords"];
  // What the desktop does first at quit.
  beginShutdown(): void;
  close(step?: CloseStep): Promise<void>;
}

function pullCaptured(relay: EngineRelayWorkspaceClient, capture: WorkspaceEngineCapture) {
  return relay.pull(apply => capture.runRelaySync(apply));
}

async function pushUntilDrained(relay: EngineRelayWorkspaceClient) {
  let result = await relay.push();
  let pushed = result.pushed;
  while (result.hasMore) {
    result = await relay.push();
    pushed += result.pushed;
  }
  return { ...result, pushed };
}

async function openLiveDaemonCapture(input: {
  workspaceId: string;
  rootPath: string;
  relay: { baseUrl: string; token: string };
  settleDebounceMs?: number;
}): Promise<LiveDaemonCapture> {
  const workspace = await openLiveDaemonWorkspace(input, { maxRestarts: 0,
    allowInsecureLoopbackForTests: new URL(input.relay.baseUrl).protocol === "http:" });
  const capture = createWorkspaceEngineCapture({
    ...workspace.workspace,
    rustEngineSessions: workspace.sessions,
    ...(input.settleDebounceMs === undefined
      ? {}
      : { settleDebounceMs: input.settleDebounceMs }),
  });
  const relay = workspace.relay.bind({
    ...workspace.workspace,
    relay: input.relay,
  });
  return {
    capture,
    chats: workspace.chats,
    relay,
    queryCollectionRecords: query => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new VersionedLiveAdapter(client, handle, { workspaceId: input.workspaceId }).queryCollectionRecords(query)),
    refusalNotices: () => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {
        workspaceId: input.workspaceId,
      }, { workspace: handle }),
    ),
    beginShutdown: () => {
      capture.beginShutdown();
      workspace.sessions.beginShutdown();
    },
    close: async (step: CloseStep = (_name, work) => work) => {
      try {
        await step("capture.stop", capture.stop());
      } finally {
        await workspace.close(step);
      }
    },
  };
}

async function openJoinedDaemonCapture(input: {
  workspaceId: string;
  rootPath: string;
  relay: { baseUrl: string; token: string };
  passphrase?: string;
  holdEditorResync?: boolean;
}): Promise<LiveDaemonCapture> {
  const workspace = await openLiveDaemonWorkspace(input, { maxRestarts: 0,
    allowInsecureLoopbackForTests: new URL(input.relay.baseUrl).protocol === "http:" });
  if (input.holdEditorResync) {
    const client = workspace.nativeClient();
    const onEvent = client.onEvent.bind(client);
    // Hold the advisory resync so all updates drain together at lease close.
    client.onEvent = handler => onEvent(event => {
      if (event.name !== "ydoc.remoteUpdate") handler(event);
    });
  }
  const relay = workspace.relay.bind({
    ...workspace.workspace,
    relay: input.relay,
  });
  const probe = await probeRelayWorkspace({
    workspaceId: input.workspaceId,
    relay: input.relay,
  });
  try {
    await bootstrapJoinedWorkspace({
      workspaceId: input.workspaceId,
      identity: probe.identity,
      ...(input.passphrase === undefined
        ? {}
        : { passphrase: input.passphrase }),
      transport: relay,
      installDataKey: async (key) =>
        await installWorkspaceDataKey(input.rootPath, key),
    });
  } catch (error) {
    await workspace.close().catch(() => undefined);
    throw error;
  }
  const capture = createWorkspaceEngineCapture({
    ...workspace.workspace,
    rustEngineSessions: workspace.sessions,
  });
  return {
    capture,
    chats: workspace.chats,
    relay,
    queryCollectionRecords: query => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new VersionedLiveAdapter(client, handle, { workspaceId: input.workspaceId }).queryCollectionRecords(query)),
    refusalNotices: () => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {
        workspaceId: input.workspaceId,
      }, { workspace: handle }),
    ),
    beginShutdown: () => {
      capture.beginShutdown();
      workspace.sessions.beginShutdown();
    },
    close: async (step: CloseStep = (_name, work) => work) => {
      try {
        await step("capture.stop", capture.stop());
      } finally {
        await workspace.close(step);
      }
    },
  };
}

async function writeAndCapture(
  daemon: LiveDaemonCapture,
  rootPath: string,
  path: string,
  contents: string | Buffer,
): Promise<void> {
  const before = (await daemon.capture.listMoments({ limit: 1_000 })).moments.filter(
    (moment) => moment.path === path,
  ).length;
  const absolute = join(rootPath, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  daemon.capture.observeFileEvents([{ path, operation: "update" }]);
  await waitForPathMoments(daemon.capture, path, before + 1);
}

async function openIndependentPlaintextLineage(
  daemon: LiveDaemonCapture,
  rootPath: string,
  path: string,
  text: string,
) {
  const absolute = join(rootPath, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, "");
  const session = await daemon.capture.openYDocSession({
    path,
    contentKind: "plaintext",
    onRemoteUpdate: () => undefined,
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, session.initialUpdate);
  const before = Y.encodeStateVector(doc);
  doc.getText("plainText").insert(0, text);
  session.applyLocalUpdate(Y.encodeStateAsUpdate(doc, before));
  await session.settleNow();
  return session;
}

async function pullAndExpect(
  daemon: LiveDaemonCapture,
  rootPath: string,
  path: string,
  contents: string | Buffer,
  contentKind?: "text" | "binary",
): Promise<void> {
  const pull = await daemon.relay.pull(apply => daemon.capture.runRelaySync(apply));
  expect(pull.applied).toBeGreaterThan(0);
  if (contentKind !== undefined) {
    expect(pull.fastForwardedPaths).toContainEqual({
      versionId: "main",
      path,
      operation: "write",
      contentKind,
    });
  }
  expect(await readFile(join(rootPath, path))).toEqual(Buffer.from(contents));
}

async function expectTwoDaemonFileSync(input: {
  workspaceId: string;
  path: string;
  contents: string | Buffer;
  contentKind?: "text" | "binary";
  bootstrapRelayBeforeCapture?: boolean;
  passphrase?: string;
  reverse?: { path: string; contents: string | Buffer };
  restart?: { contents: string | Buffer };
  rejoin?: boolean;
}): Promise<void> {
  const token = `test:${input.workspaceId}`;
  // Both roots are opened through EngineWorkspaceSessions (via
  // openLiveDaemonWorkspace/openLiveDaemonCapture); the daemon binds each
  // root to its database on first open.
  const rootA = await createTestScratch("dohc-two-daemon-a-");
  const rootB = await createTestScratch("dohc-two-daemon-b-");
  const relayRoot = await createTestScratch("dohc-two-daemon-relay-");
  const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
  let daemonA: LiveDaemonCapture | null = null;
  let daemonB: LiveDaemonCapture | null = null;
  let daemonC: LiveDaemonCapture | null = null;
  try {
    daemonA = await openLiveDaemonCapture({
      workspaceId: input.workspaceId,
      rootPath: rootA,
      relay: { baseUrl: relay.baseUrl, token },
    });
    await daemonA.relay.claim();
    if (input.passphrase !== undefined) {
      const key = await loadSecretDataKey(rootA, { createIfMissing: true });
      await enrollWorkspaceKeyEnvelope({
        workspaceId: input.workspaceId,
        dataKey: key,
        passphrase: input.passphrase,
        transport: daemonA.relay,
        installDataKey: async () => {
          throw new Error("The source workspace must not reinstall its key.");
        },
      });
    }

    if (input.bootstrapRelayBeforeCapture !== false) {
      // A successful relay position makes later file moments relay-visible.
      // Chat creation always journals, so it can establish that position before
      // the first file initializes the versioned workspace.
      await daemonA.chats.ensureGeneralChannel({ workspaceId: input.workspaceId });
      const bootstrapPush = await pushUntilDrained(daemonA.relay);
      expect(bootstrapPush.pushed).toBeGreaterThan(0);
    }

    await writeAndCapture(daemonA, rootA, input.path, input.contents);

    const push = await pushUntilDrained(daemonA.relay);
    expect(push.pushed).toBeGreaterThan(0);

    daemonB = await openJoinedDaemonCapture({
      workspaceId: input.workspaceId,
      rootPath: rootB,
      relay: { baseUrl: relay.baseUrl, token },
      ...(input.passphrase === undefined
        ? {}
        : { passphrase: input.passphrase }),
    });
    await pullAndExpect(
      daemonB,
      rootB,
      input.path,
      input.contents,
      input.contentKind,
    );

    const moments = await daemonB.capture.listMoments({ limit: 100 });
    expect(moments.moments.some((moment) => moment.path === input.path)).toBe(true);

    if (input.reverse) {
      await writeAndCapture(
        daemonB,
        rootB,
        input.reverse.path,
        input.reverse.contents,
      );
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
      await pullAndExpect(
        daemonA,
        rootA,
        input.reverse.path,
        input.reverse.contents,
      );
    }

    if (input.restart) {
      await daemonB.close();
      daemonB = null;
      await writeAndCapture(daemonA, rootA, input.path, input.restart.contents);
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      daemonB = await openLiveDaemonCapture({
        workspaceId: input.workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await pullAndExpect(
        daemonB,
        rootB,
        input.path,
        input.restart.contents,
        input.contentKind,
      );
    }

    if (input.rejoin) {
      const rootC = await createTestScratch("dohc-two-daemon-c-");
      daemonC = await openJoinedDaemonCapture({
        workspaceId: input.workspaceId,
        rootPath: rootC,
        relay: { baseUrl: relay.baseUrl, token },
        ...(input.passphrase === undefined
          ? {}
          : { passphrase: input.passphrase }),
      });
      await pullAndExpect(
        daemonC,
        rootC,
        input.path,
        input.restart?.contents ?? input.contents,
        input.contentKind,
      );
    }
  } finally {
    await Promise.allSettled([daemonC?.close(), daemonB?.close(), daemonA?.close()]);
    await relay.stop();
  }
}

it.skipIf(engine.missing)(
  "delivers never-opened relation cleanup to a recipient and preserves it after restart",
  async () => {
    const workspaceId = "never-opened-relation-delivery";
    const rootA = await createTestScratch("dohc-relation-owner-");
    const rootB = await createTestScratch("dohc-relation-recipient-");
    const relayRoot = await createTestScratch("dohc-relation-relay-");
    const ca = await mintLocalhostCa(relayRoot);
    const previousRoots = getCACertificates("default");
    setDefaultCACertificates([...previousRoots, ca.ca]);
    const trustEnv = {
      NODE_EXTRA_CA_CERTS: ca.caPath,
      DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
      DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
      DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
    };
    for (const [name, value] of Object.entries(trustEnv)) vi.stubEnv(name, value);
    const proxy = await startServerProxy(ca);
    let relayServer: Awaited<ReturnType<typeof spawnSyncRelay>> | undefined;
    let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
    let capture: WorkspaceEngineCapture | undefined;
    let recipient: LiveDaemonCapture | undefined;
    const path = "tasks/source.md";
    const sourceId = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const targetId = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const original = `---\nid: ${sourceId}\nrelated: ${targetId}\ntitle: Keep\n---\n\n# Body stays intact`;
    const cleared = original.replace(`related: ${targetId}\n`, "");
    try {
      relayServer = await spawnSyncRelay({
        dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain,
        editLinks: { engineExecutable: engine.require(), publicOrigin: proxy.origin, trustEnv },
        linkBoundary: { linkKey: "relation-link-key-".repeat(3), relayExchangeKey: "relation-exchange-key-".repeat(3),
          publicViewerOrigin: proxy.origin },
      });
      proxy.routeRelayTo(relayServer.baseUrl);
      const connection = { baseUrl: proxy.origin, token: `test:${workspaceId}` };
      const profile = selfHostLiveProfile();
      const nativeConfigPath = join(rootA, "owner-ingress.json");
      await writeFile(nativeConfigPath, JSON.stringify(profile.nativeIngress));
      const openOwner = () => openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, {
        maxRestarts: 0, allowInsecureLoopbackForTests: false,
        privateOwnerHost: { configPath: nativeConfigPath, client: profile.nativeClient },
      });
      owner = await openOwner();
      await owner.chats.ensureGeneralChannel({ workspaceId });
      const adapterOf = (source: NonNullable<typeof owner>) => source.sessions.run(source.workspace,
        async ({ client, workspace }) => new VersionedLiveAdapter(client, workspace, { workspaceId }));
      let adapter = await adapterOf(owner);
      await adapter.ensureMainVersion({ workspaceId });
      for (const [filePath, text] of [
        ["tasks/collection.yaml", "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n  title:\n    type: text\n"],
        ["tasks/target.md", `---\nid: ${targetId}\n---\n\nTarget`],
        [path, original],
      ]) {
        await adapter.writeTextFile({ workspaceId, versionId: "main", path: filePath!, text: text!,
          publish: true, metadata: { origin: "api" } });
      }
      await expect.poll(async () => (await adapter.listPendingCollectionAdoptions()).adoptions.length,
        { timeout: REAL_DAEMON_DEADLINE_MS }).toBe(2);
      capture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions });
      await expect.poll(async () => {
        await capture!.flush();
        return (await adapter.listPendingCollectionAdoptions()).adoptions;
      }, { timeout: REAL_DAEMON_DEADLINE_MS }).toEqual([]);
      // Background adoption establishes the bindings without an editor open.
      // Close the covered local-only lineages through the engine's prune path.
      await owner.sessions.run(owner.workspace, async ({ workspace }) => {
        const ydocs = new YdocLiveAdapter(owner!.nativeClient());
        try {
          for (const filePath of [path, "tasks/target.md"]) {
            const session = await ydocs.openSession({ workspace, versionId: "main", path: filePath,
              contentKind: "richdoc", seedAbsentLineage: false });
            try { expect(session.lineage).toBe("existing"); } finally { await session.close(); }
          }
        } finally { ydocs.dispose(); }
      });
      await capture.stop();
      capture = undefined;
      await owner.close();
      owner = undefined;
      const db = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
      try {
        expect(db.prepare("SELECT record_id,file_path,adoption_state FROM collection_records WHERE workspace_id=? ORDER BY file_path")
          .all(workspaceId)).toEqual([
            { record_id: sourceId, file_path: path, adoption_state: "adopted" },
            { record_id: targetId, file_path: "tasks/target.md", adoption_state: "adopted" },
          ]);
        expect(db.prepare("SELECT COUNT(*) AS count FROM ydoc_updates").get()).toEqual({ count: 0 });
        expect(db.prepare("SELECT path,regime,head_update_seq,head_snapshot_seq FROM ydoc_docs WHERE workspace_id=? AND path IN (?,?) ORDER BY path")
          .all(workspaceId, path, "tasks/target.md")).toEqual([
            { path, regime: "local-only", head_update_seq: 0, head_snapshot_seq: 0 },
            { path: "tasks/target.md", regime: "local-only", head_update_seq: 0, head_snapshot_seq: 0 },
          ]);
      } finally { db.close(); }
      owner = await openOwner();
      const relay = owner.relay.bind({ ...owner.workspace, relay: connection });
      await relay.claim();
      await relay.push();
      adapter = await adapterOf(owner);
      await expect.poll(async () => {
        await adapter.reconcileCapture();
        const indexed = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
        try {
          return indexed.prepare("SELECT COUNT(*) AS count FROM collection_relation_edges WHERE source_record_id=? AND target_record_id=?")
            .get(sourceId, targetId);
        } finally { indexed.close(); }
      }, { timeout: REAL_DAEMON_DEADLINE_MS }).toEqual({ count: 1 });
      const share = await fetch(`${proxy.origin}/sync/${workspaceId}/shares`, {
        method: "POST", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
        body: JSON.stringify({ recipientEmail: "relation-recipient@dohc.test", paths: [path], access: "edit" }),
      });
      expect(share.status).toBe(200);
      const { shareId } = await share.json() as { shareId: string };
      const neverOpened = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
      try {
        expect(neverOpened.prepare("SELECT COUNT(*) AS count FROM ydoc_updates").get()).toEqual({ count: 0 });
      } finally { neverOpened.close(); }
      recipient = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      await pullAndExpect(recipient, rootB, path, original);

      const { holdId } = await adapter.holdCapture();
      try {
        await rm(join(rootA, "tasks/target.md"));
        await adapter.deleteTextFile({ workspaceId, versionId: "main", path: "tasks/target.md",
          metadata: { origin: "api" }, captureHoldId: holdId, onlyIfAbsentOnDisk: true });
      } finally { await adapter.releaseCapture(holdId); }
      await expect.poll(async () => {
        await adapter.reconcileCapture();
        return readFile(join(rootA, path), "utf8");
      }, { timeout: REAL_DAEMON_DEADLINE_MS }).toBe(cleared);
      expect((await relay.push()).sharingDeclined).toEqual([]);
      const enrollment = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, {
        method: "POST", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
        body: JSON.stringify({ shareId }),
      });
      expect([200, 202]).toContain(enrollment.status);
      let discoveryPayload: unknown;
      await expect.poll(async () => {
        const response = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, {
          headers: { authorization: `Bearer ${connection.token}` },
        });
        expect(response.status).toBe(200);
        discoveryPayload = await response.json();
        return readyOwnerDeliveryDocuments(discoveryPayload, workspaceId).map(document => document.binding.currentPath);
      }, { timeout: 120_000 }).toEqual([path]).catch(error => {
        throw new Error(JSON.stringify({ discoveryPayload, diagnostics: relayServer!.diagnostics() }), { cause: error });
      });
      expect(JSON.stringify(relayServer.diagnostics())).not.toContain("invalid-schema");
      capture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions });
      await pullCaptured(relay, capture);
      await relay.push();
      const assertRecipientState = async () => {
        const markdown = await readFile(join(rootB, path), "utf8");
        expect(markdown).toBe(cleared);
        expect(parseFrontmatter(markdown, false).meta).toEqual({ id: sourceId, title: "Keep" });
        await expect.poll(async () => {
          const query = await recipient!.queryCollectionRecords({ collectionPath: "tasks", resolveRelations: true });
          const record = query.records.find(record => record.id === sourceId);
          return record && {
            id: record.id, path: record.path, conflicted: record.conflicted,
            related: record.values.find(value => value.field === "related"),
            title: record.values.find(value => value.field === "title"),
          };
        }, { timeout: REAL_DAEMON_DEADLINE_MS }).toMatchObject({
          id: sourceId, path, conflicted: false, related: undefined, title: { value: "Keep" },
        });
        expect(await recipient!.refusalNotices()).toEqual({ notices: [] });
        expect(await recipient!.capture.countOpenConflicts()).toBe(0);
      };
      const assertRecipient = async () => {
        const headers = { authorization: "Bearer test:relation-recipient" };
        const digest = createHash("sha256").update(cleared).digest("hex");
        await expect.poll(async () => {
          await relay.pull(apply => capture!.runRelaySync(apply));
          await relay.push();
          const log = await fetch(`${proxy.origin}/sync/shares/${shareId}/log?since=0&limit=500`, { headers });
          expect(log.status).toBe(200);
          return log.json();
        }, { timeout: 120_000 }).toMatchObject({ ops: expect.arrayContaining([
          expect.objectContaining({ opKind: "moment.append", payload: expect.objectContaining({ payloadAfterBlobSha256: digest }) }),
        ]) });
        const blob = await fetch(`${proxy.origin}/sync/shares/${shareId}/blobs/${digest}`, { headers });
        expect(blob.status).toBe(200);
        expect(await blob.text()).toBe(cleared);
        await expect.poll(async () => {
          await recipient!.relay.pull(apply => recipient!.capture.runRelaySync(apply));
          const markdown = await readFile(join(rootB, path), "utf8");
          const query = await recipient!.queryCollectionRecords({ collectionPath: "tasks", resolveRelations: true });
          const record = query.records.find(record => record.id === sourceId);
          return { markdown, recordId: record?.id, related: record?.values.find(value => value.field === "related") };
        }, { timeout: 120_000 }).toEqual({ markdown: cleared, recordId: sourceId, related: undefined });
        await assertRecipientState();
      };
      await assertRecipient();
      await recipient.close();
      recipient = await openLiveDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      await assertRecipientState();
      await assertRecipient();
    } finally {
      await recipient?.close();
      try { await capture?.stop(); } finally {
        await owner?.close();
        await relayServer?.stop();
        await proxy.close();
        setDefaultCACertificates(previousRoots);
        vi.unstubAllEnvs();
      }
    }
  },
  240_000,
);

it.skipIf(engine.missing)(
  "kept text resolution without lineage: edit over peer deletion",
  async () => {
    const workspaceId = "text-keep-deletion";
    const path = "trip.txt";
    const initial = "Trip destination: undecided\n";
    const textB = "Trip destination: Tokyo\n";
    const later = `${textB}continued on B\n`;
    const rootA = await createTestScratch("dohc-text-keep-delete-a-");
    const rootB = await createTestScratch("dohc-text-keep-delete-b-");
    const relayRoot = await createTestScratch("dohc-text-keep-delete-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    const connection = { baseUrl: relay.baseUrl, token: `test:${workspaceId}` };
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    const pull = (daemon: LiveDaemonCapture) => daemon.relay.pull(apply => daemon.capture.runRelaySync(apply));
    const inspect = async (daemon: LiveDaemonCapture, root: string) => {
      const rows = (await daemon.capture.listOpenConflictsPage()).conflicts;
      const moments = (await daemon.capture.listMoments({ limit: 100 })).moments.filter(moment => moment.path === path);
      return { text: await readFile(join(root, path), "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }), rows, history: await Promise.all(moments.map(async moment => ({
        summary: moment, detail: await daemon.capture.readMoment(moment.id),
      }))) };
    };
    try {
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
      await daemonA.relay.claim();
      await writeAndCapture(daemonA, rootA, path, initial);
      await pushUntilDrained(daemonA.relay);
      daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      await pullAndExpect(daemonB, rootB, path, initial);
      const before = (await daemonA.capture.listMoments({ limit: 100 })).moments.length;
      await rm(join(rootA, path));
      daemonA.capture.observeFileEvents([{ path, operation: "delete" }]);
      await waitForPathMoments(daemonA.capture, path, before + 1);
      await writeAndCapture(daemonB, rootB, path, textB);
      await pushUntilDrained(daemonA.relay);
      await pushUntilDrained(daemonB.relay);
      await pull(daemonA);
      await pull(daemonB);
      const rowsA = (await daemonA.capture.listOpenConflictsPage()).conflicts;
      const rowsB = (await daemonB.capture.listOpenConflictsPage()).conflicts;
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA[0]!.id).toBe(rowsB[0]!.id);
      expect(rowsA[0]).toMatchObject({ current: { exists: false }, incoming: { text: textB } });
      expect(rowsB[0]).toMatchObject({ current: { text: textB }, incoming: { exists: false } });
      await daemonB.capture.resolveConflict(rowsB[0]!.id, { kind: "keep-current" });
      await pushUntilDrained(daemonB.relay);
      await pull(daemonA);
      await pull(daemonB);
      const keptA = await inspect(daemonA, rootA);
      const keptB = await inspect(daemonB, rootB);
      console.log("deletion after keep", JSON.stringify({ A: keptA, B: keptB }));
      expect(keptA.text).toBeNull();
      expect(keptA.rows).toHaveLength(2);
      expect(keptB.text).toBe(textB);
      expect(keptB.rows).toHaveLength(0);
      await writeAndCapture(daemonB, rootB, path, later);
      await pushUntilDrained(daemonB.relay);
      await pull(daemonA);
      await pull(daemonB);
      const laterA = await inspect(daemonA, rootA);
      const laterB = await inspect(daemonB, rootB);
      console.log("deletion after later edit", JSON.stringify({ A: laterA, B: laterB }));
      expect(laterA.text).toBeNull();
      expect(laterA.rows.length).toBeGreaterThanOrEqual(2);
      expect(laterA.rows.some(row => row.incoming.text === later)).toBe(true);
      expect(laterB.text).toBe(later);
      expect(laterB.rows).toHaveLength(0);
      expect(await daemonA.refusalNotices()).toMatchObject({ notices: [] });
      expect(await daemonB.refusalNotices()).toMatchObject({ notices: [] });
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);

// A stale ready copy at Resume is covered by the relay test "captures a retired
// activation's successor only after a hosted pull that started after Resume".
const heldStopCase = "stale-binding quarantine, Stop refused while the host is held";
it.skipIf(engine.missing).each([
  { name: "existing id", hasId: true, body: "# Keep this body\n", stopQuarantine: false },
  { name: "id-less canonical", hasId: false, body: "# Body\n", stopQuarantine: false },
  { name: "id-less non-canonical", hasId: false, body: "A setext heading\n================\n\n* first\n* second\n", stopQuarantine: false },
  { name: "quarantine", hasId: true, body: "# Keep this body\n", stopQuarantine: true },
  { name: heldStopCase, hasId: true, body: "# Keep this body\n", stopQuarantine: true },
  { name: "offline stop", hasId: true, body: "# Keep this body\n", stopQuarantine: true },
  { name: "deferred resume", hasId: true, body: "# Keep this body\n", stopQuarantine: true },
])("settles open Collection adoption with native owner delivery and recipient sync ($name)", async ({ name, hasId, body: originalBody, stopQuarantine }) => {
  const canonical = markdownToYDoc(originalBody);
  const body = name === "id-less canonical" ? yDocToMarkdown(canonical) : originalBody;
  canonical.destroy();
  const workspaceId = name === heldStopCase ? "native-stale-quarantine" : `native-open-adoption-${name.replaceAll(" ", "-")}`;
  const rootA = await createTestScratch("dohc-native-adoption-owner-");
  const rootB = await createTestScratch("dohc-native-adoption-peer-");
  const relayRoot = await createTestScratch("dohc-native-adoption-relay-");
  const ca = await mintLocalhostCa(relayRoot);
  const previousRoots = getCACertificates("default");
  setDefaultCACertificates([...previousRoots, ca.ca]);
  const trustEnv = { NODE_EXTRA_CA_CERTS: ca.caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
    DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath, DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0" };
  for (const [name, value] of Object.entries(trustEnv)) vi.stubEnv(name, value);
  const proxy = await startServerProxy(ca);
  let relayServer: Awaited<ReturnType<typeof spawnSyncRelay>> | undefined;
  let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
  let capture: WorkspaceEngineCapture | undefined;
  let delivery: ReturnType<typeof startServerOwnerDelivery> | undefined;
  let peer: LiveDaemonCapture | undefined;
  let preStopFeed: ReturnType<typeof proxy.holdNextHostedLogResponse> | undefined;
  const errors: string[] = [];
  let resyncSignals = 0;
  const recordError = (context: string, error: unknown) => {
    if (error instanceof YdocAdapterError && error.code === "resync-needed") {
      resyncSignals++;
      return;
    }
    errors.push(`${context}: ${String(error)}`);
  };
  const path = "tasks/pending.md", recordId = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  try {
    const relayOptions = { dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain,
      editLinks: { engineExecutable: engine.require(), publicOrigin: proxy.origin, trustEnv },
      linkBoundary: { linkKey: "native-adoption-link-key-".repeat(2), relayExchangeKey: "native-adoption-exchange-".repeat(2),
        publicViewerOrigin: proxy.origin } };
    relayServer = await spawnSyncRelay(relayOptions);
    proxy.routeRelayTo(relayServer.baseUrl);
    const relayConnection = { baseUrl: proxy.origin, token: `test:${workspaceId}` };
    const profile = selfHostLiveProfile();
    const nativeConfigPath = join(rootA, "owner-ingress.json");
    await writeFile(nativeConfigPath, JSON.stringify(profile.nativeIngress));
    owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0,
      allowInsecureLoopbackForTests: false, privateOwnerHost: { configPath: nativeConfigPath, client: profile.nativeClient } });
    const source = owner;
    const relay = source.relay.bind({ ...source.workspace, relay: relayConnection });
    await relay.claim();
    await source.chats.ensureGeneralChannel({ workspaceId });
    await pushUntilDrained(relay);
    const adapter = await source.sessions.run(source.workspace, async ({client, workspace}) => new VersionedLiveAdapter(client, workspace, {workspaceId}));
    await adapter.ensureMainVersion({workspaceId});
    await adapter.writeTextFile({workspaceId, versionId: "main", path, text: hasId ? `---\nid: ${recordId}\n---\n\n${body}` : body,
      publish: true, metadata: {origin: "api"}, author: {kind: "human", humanId: "local-person"}});
    capture = createWorkspaceEngineCapture({...source.workspace, rustEngineSessions: source.sessions, settleDebounceMs: 60_000,
      openRustYDocProviderSession: options => openEngineYdocProviderSession({...options,
        onResyncNeeded: error => { recordError("session resync", error); options.onResyncNeeded?.(error); }}),
      onError: recordError});
    const seeded = await capture.openYDocSession({path, contentKind: "richdoc", onRemoteUpdate: () => undefined});
    if (hasId) await seeded.applyDecidedLocalUpdate(doc => {
      const scratch = new Y.Doc();
      try {
        Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
        const before = Y.encodeStateVector(scratch);
        patchFrontmatter(scratch, new Map([["beforeActivation", "ordinary-owner"]]));
        return Y.encodeStateAsUpdate(scratch, before);
      } finally { scratch.destroy(); }
    }, undefined, { actorOriginId: "local-person", attribution: { actorKind: "human" }, idempotencyKey: "native-baseline" });
    await seeded.settleNow();
    await pushUntilDrained(relay);
    await seeded.close();
    const share = await fetch(`${proxy.origin}/sync/${workspaceId}/shares`, {method: "POST",
      headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"},
      body: JSON.stringify({recipientEmail: "native-recipient@dohc.test", paths: ["tasks"], access: "edit"})});
    expect(share.status).toBe(200);
    const shareResult = await share.json() as { shareId: string };
    const enrollment = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, {method: "POST",
      headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"},
      body: JSON.stringify({shareId: shareResult.shareId})});
    expect([200, 202]).toContain(enrollment.status);
    let discoveryPayload: unknown;
    const discovery = async () => {
      const response = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, {headers: {authorization: `Bearer ${relayConnection.token}`}});
      expect(response.status).toBe(200);
      discoveryPayload = await response.json();
      return readyOwnerDeliveryDocuments(discoveryPayload, workspaceId);
    };
    try { await expect.poll(async () => (await discovery()).length, {timeout: 120_000}).toBe(1); }
    catch (error) { throw new Error(JSON.stringify({ discoveryPayload, diagnostics: relayServer.diagnostics() }), { cause: error }); }
    const document = (await discovery())[0]!;
    const config = {...profile.owner, nativeConfigPath, nativeClient: profile.nativeClient, relayUrl: proxy.origin, documents: [document]};
    const refusals = new OwnerKnownRefusals();
    const pass = (signal: AbortSignal) => source.sessions.run(source.workspace, async ({client, workspace}) =>
      runNativeOwnerDeliveryPass({client: source.nativeClient(), workspaceHandle: workspace, document, config, refusals, signal, bearer: relayConnection.token, accountId: workspaceId, assertCurrent() {}}));
    expect(["empty", "acknowledged"]).toContain(await pass(AbortSignal.timeout(60_000)));
    let saveState: string | undefined;
    const session = await capture.openYDocSession({path, contentKind: "richdoc", onRemoteUpdate: () => undefined,
      onSaveState: state => { saveState = state; }});
    const beforeAdoption = await readFile(join(rootA, path), "utf8");
    if (!hasId) expect(session.doc.getMap("meta").has("dohcMarkdownSource")).toBe(name === "id-less non-canonical");
    await adapter.writeTextFile({workspaceId, versionId: "main", path: "tasks/collection.yaml", text: "fields:\n  Name:\n    type: text\n",
      publish: true, metadata: {origin: "api"}});
    await expect.poll(async () => (await adapter.listPendingCollectionAdoptions()).adoptions.length, {timeout: 60_000}).toBe(1);
    await pushUntilDrained(relay);
    const pending = (await adapter.listPendingCollectionAdoptions()).adoptions[0]!;
    const bindingDb = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
    try {
      expect(bindingDb.prepare("SELECT adoption_state FROM collection_records WHERE workspace_id=? AND file_path=?")
        .get(workspaceId, path)).toEqual({ adoption_state: hasId ? "pending" : "pending-lossless" });
    } finally { bindingDb.close(); }
    if (hasId) {
      await session.applyDecidedLocalUpdate(doc => {
        const scratch = new Y.Doc();
        try {Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc)); const before = Y.encodeStateVector(scratch);
          patchFrontmatter(scratch, new Map([["Name", "Manual"]])); return Y.encodeStateAsUpdate(scratch, before);
        } finally {scratch.destroy();}
      }, undefined, {actorOriginId: "local-person", attribution: {actorKind: "human"}, idempotencyKey: "native-name"});
    } else {
      await capture.flush();
      expect(session.doc.getMap("frontmatter").get("id")).toBe(pending.recordId);
      expect((await adapter.listPendingCollectionAdoptions()).adoptions).toEqual([pending]);
      await capture.flush();
      expect((await adapter.listPendingCollectionAdoptions()).adoptions).toEqual([pending]);
    }
    if (hasId) {
      const db = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
      const outboxId = String(db.prepare("SELECT outbox_id FROM owner_ydoc_outboxes WHERE workspace_id=? AND object_id=? AND pending_bytes>0").get(workspaceId, document.binding.objectId)!.outbox_id);
      db.close();
      const pending = await source.sessions.run(source.workspace, async ({client, workspace}) => new OwnerYDocOutbox(client, workspace).readPending(outboxId));
      expect(pending.entries.some(entry => entry.personEdit)).toBe(true);
    }
    await expect(session.settleNow()).rejects.toMatchObject({name: "YdocOwnerDraftPendingError"});
    expect((await adapter.listPendingCollectionAdoptions()).adoptions).toHaveLength(1);
    await capture.flush();
    expect(await adapter.flushCapture()).toMatchObject({settled: true});
    expect(saveState).toBe("pending-share");
    capture.start();
    const beforeDeliveryResyncSignals = resyncSignals;
    delivery = startServerOwnerDelivery({workspaceIds: () => [workspaceId], attemptTimeoutMs: 60_000, retryDelayMs: 250,
      async runPass(_workspaceId, _index, signal) {
        const result = await pass(signal);
        await relay.pull(apply => capture!.runRelaySync(apply));
        return {documentCount: 1, acknowledged: result === "acknowledged"};
      },
      onError: error => recordError("owner delivery", error)});
    // Keep the original session while the adapter resyncs it after delivery.
    // A recorded failure ends each poll; the assertion outside reports it.
    await expect.poll(async () => {
      if (errors.length) return true;
      const pending = (await adapter.listPendingCollectionAdoptions()).adoptions.length;
      const {settled} = await adapter.flushCapture();
      return pending === 0 && settled;
    }, {timeout: 120_000}).toBe(true);
    expect(errors).toEqual([]);
    await capture.flush();
    // Adoption can finish before the owner's field edit is accepted and materialized.
    if (hasId) await expect.poll(async () => {
      if (errors.length) return true;
      const pending = (await adapter.listPendingCollectionAdoptions()).adoptions.length;
      const {settled} = await adapter.flushCapture();
      return pending === 0 && settled && (await readFile(join(rootA, path), "utf8")).includes("Name: Manual");
    }, {timeout: 120_000}).toBe(true);
    expect(errors).toEqual([]);
    // Adoption can settle before the original session's final owner receipt arrives.
    await expect.poll(async () => {
      if (errors.length) return true;
      try { await session.settleNow(); }
      catch (error) {
        if (!(error instanceof YdocOwnerDraftPendingError)) {
          recordError("original session settle", error);
          throw error;
        }
      }
      return saveState === "saved-to-host";
    }, {timeout: 120_000}).toBe(true);
    expect(errors).toEqual([]);
    expect(resyncSignals, "delivery must resync the original pending-share session").toBeGreaterThan(beforeDeliveryResyncSignals);
    const markdown = await readFile(join(rootA, path), "utf8");
    if (hasId) expect(markdown).toContain("Name: Manual");
    if (hasId) expect(markdown).toContain("beforeActivation: ordinary-owner");
    expect(markdown).toContain(`id: ${pending.recordId}`);
    if (hasId) expect(markdown).toContain(body.trimEnd());
    else expect(markdown).toBe(`---\nid: ${pending.recordId}\n---\n\n${beforeAdoption}`);
    await capture.flush();
    expect((await adapter.listPendingCollectionAdoptions()).adoptions).toEqual([]);
    console.log(`native owner delivery ${name}: ${resyncSignals} resync signals recovered on the original session`);
    const ownerSettlement = (await capture.listMoments({limit: 100})).moments.find(moment => moment.path === path);
    expect(ownerSettlement).toBeDefined();
    // The test relay uses the account id as its name; the longest fixture exceeds the display-name limit.
    const ownerAuthors = hasId ? [{kind: "human", humanId: workspaceId, humanName: workspaceId}] : [{kind: "unattributed"}];
    const confirmedOwnerAuthors = hasId ? ownerAuthors.map(author => ({...author, relayConfirmed: true})) : ownerAuthors;
    expect.soft(ownerSettlement!.authors).toEqual(confirmedOwnerAuthors);
    const publicationDb = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
    try {
      expect.soft(publicationDb.prepare("SELECT admission_json,authors_json FROM live_settlement_publication_admissions WHERE workspace_id=? AND moment_id=?")
        .get(workspaceId, ownerSettlement!.id)).toMatchObject({
          admission_json: expect.stringContaining('"status":"accepted"'), authors_json: stableJsonStringify(ownerAuthors),
        });
    } finally {publicationDb.close();}
    // Publish owner operations before the peer imports settlement coverage.
    await pushUntilDrained(relay);
    // The unchanged seed has no journal interval, so it leaves no settlement to publish and nothing for the relay to refuse.
    const refusedDb = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
    try {
      expect(refusedDb.prepare("SELECT origin_id,origin_seq FROM live_settlement_publication_admissions WHERE workspace_id=? AND json_extract(admission_json,'$.status')='refused'").all(workspaceId)).toEqual([]);
    } finally {refusedDb.close();}
    expect(await source.sessions.run(source.workspace, async ({client, workspace}) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {workspaceId}, {workspace}))).toEqual({notices: []});
    peer = await openJoinedDaemonCapture({workspaceId, rootPath: rootB, relay: relayConnection});
    await pullAndExpect(peer, rootB, path, markdown);
    const imported = (await peer.capture.listMoments({limit: 100})).moments.find(moment => moment.id === ownerSettlement?.id);
    expect(imported).toBeDefined();
    expect.soft(imported!.authors).toEqual(confirmedOwnerAuthors);
    if (hasId) {
      await delivery.stop();
      delivery = undefined;
      const formula = createAutomationFormulaEvaluator();
      try {
        const parsed = parseAutomationsFile("version: 1\nautomations:\n  - id: finish\n    name: Finish\n    when: {button: Finish}\n    do: [{set: {Name: Automation}}]\n");
        if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error("Invalid test automation");
        const automation = parsed.entries[0].automation;
        const collectionId = (await adapter.listCollections()).collections.find(entry => entry.path === "tasks")!.objectId;
        const claim: AutomationClaim = {
          claimId: "atc_pending", automationId: `collection:${collectionId}#finish`, trigger: { key: "pending-button" },
          recordId, collectionPath: "tasks", depth: 0, state: "running", attempts: 1, run: 1,
          createdAtMs: Date.now(), updatedAtMs: Date.now(),
          change: { kind: "button", authorOriginId: null, actorKind: "human", onBehalfOf: "local-person", sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
        };
        // The run reads its progress as it would while the engine holds `.dohc/local`.
        readersTrustLocalState();
        const store = createAutomationRunStore(preparedAutomationStoreFolder(rootA));
        const signal = new AbortController().signal;
        const edits = (signal: AbortSignal) => collectionRecordWrites(desktopRecordEditContext({
          capture: capture!, workspaceRoot: rootA, person: {kind: "human", humanId: "local-person"},
          withAdapter: work => work(adapter), signal,
          onCaptureSettled: () => () => undefined,
        }));
        const dependencies = {
          isButtonField: async () => true,
          withReads: async <T,>(work: (engine: VersionedLiveAdapter) => Promise<T>) => work(adapter),
          withRecordWrites: async <T,>(signal: AbortSignal, work: (writes: ReturnType<typeof edits>) => Promise<T>) => work(edits(signal)),
          collectionIdOf: () => collectionId, collectionPathOf: () => "tasks",
          targets: createAutomationTargets({ isCollection: path => path === "tasks", readText: async () => null,
            readSchemaFields: async () => new Set(["Name"]), withHost: async () => null }),
          readCode: async () => null, personName: () => "Owner", evaluator: formula.forWorkspace(workspaceId), store, nowMs: Date.now,
          chat: { hasMessage: async () => false, directory: async () => null, write: async () => { throw new Error("No chat in this test"); } },
          makeDurable: async () => { await adapter.makeAutomationWritesDurable(); },
          postNotice: async () => { throw new Error("No notices in this test"); }, readMessageBody: async () => null, recipientVerdicts: async () => [],
        };
        await expect(runCollectionAutomation(dependencies, { claim, automation, collection: {path: "tasks", name: "Tasks"},
          roster: {kind: "owner", ownerUserId: "local-person", grants: []}, signal, stopped: signal })).resolves.toMatchObject({kind: "done"});
        const runs = (await store.runsOf(claim.automationId, claim.claimId)).runs;
        expect(runs[0]!.applied.flatMap(entry => entry.writes)).toMatchObject([
          {kind: "field", recordId, path, field: "Name", before: "Manual", after: "Automation", sharedFileUpdate: {appendKey: expect.any(String)}},
        ]);
        const write = runs[0]!.applied.flatMap(entry => entry.writes).find(write => write.kind === "field");
        if (write?.kind !== "field" || !write.sharedFileUpdate) throw new Error("Missing recorded draft");
        expect(await adapter.sharedFileUpdateStates([write.sharedFileUpdate])).toEqual(["pending"]);
        // Both run Undo and Stop and restore use this document reversal.
        // A journaled reversal is pending until its own receipt arrives.
        const undo = {...dependencies, trash: async () => { throw new Error("No added records"); }};
        const reversal = await undoCollectionAutomationRuns(undo, runs, signal);
        expect(reversal).toMatchObject({undone: {reverted: 0}, undoWrites: [{draft: {appendKey: expect.any(String)}}]});
        await expect(undoCollectionAutomationRuns(undo, runs, signal)).resolves.toMatchObject({undone: {reverted: 0}});
        expect(session.doc.getMap("frontmatter").get("Name")).toBe("Manual");
        expect(await adapter.sharedFileUpdateStates(reversal.undoWrites.map(write => write.draft))).toEqual(["pending"]);
        // Host acknowledgement alone leaves the accepted native lineage dirty.
        await expect.poll(() => pass(signal), {timeout: 120_000}).toBe("empty");
        await expect.poll(async () => {
          try { return await adapter.sharedFileUpdateStates(reversal.undoWrites.map(write => write.draft)); }
          catch (error) {
            if (error instanceof DaemonRefusalError && error.wireCode === "OVERLOADED" &&
                error.message === "live-settlement-capacity") return null;
            throw error;
          }
        }, {timeout: REAL_DAEMON_DEADLINE_MS}).toEqual(["settled"]);
        await expect.poll(async () => {
          await pass(signal);
          await relay.pull(apply => capture!.runRelaySync(apply));
          await capture!.flush();
          return readFile(join(rootA, path), "utf8");
        }, {timeout: 120_000}).toBe(markdown).catch(error => {
          const db = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
          try {
            throw new Error(JSON.stringify({
              markers: db.prepare("SELECT head_update_seq,settled_update_seq,last_settled_sha,settle_prior_update_seq,path FROM ydoc_docs").all(),
              snapshots: db.prepare("SELECT path,blob_sha256 FROM snapshots").all(),
              materializations: db.prepare("SELECT target_path,status,content_sha256 FROM materialization_jobs").all(),
            }), {cause: error});
          } finally {db.close();}
        });
      } finally { await formula.close(); }
    }
    await expect.poll(async () => {
      await capture!.flush();
      await pushUntilDrained(relay);
      await peer!.relay.pull(apply => peer!.capture.runRelaySync(apply));
      return readFile(join(rootB, path), "utf8");
    }, {timeout: 120_000}).toBe(markdown);
    expect(await source.sessions.run(source.workspace, async ({client, workspace}) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {workspaceId}, {workspace}))).toEqual({notices: []});
    expect(errors).toEqual([]);
    if (stopQuarantine) {
      await delivery?.stop(); delivery = undefined;
      const offlineStop = name === "offline stop";
      const deferredResume=name==="deferred resume";
      const quarantineReason = name === heldStopCase ? "stale-binding" : "delivery-conflict";
      await session.applyDecidedLocalUpdate(doc => {
        const scratch = new Y.Doc();
        try {Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc)); const before = Y.encodeStateVector(scratch);
          patchFrontmatter(scratch, new Map([["Name", "Quarantined edit"]])); return Y.encodeStateAsUpdate(scratch, before);
        } finally {scratch.destroy();}
      }, undefined, {actorOriginId: "local-person", attribution: {actorKind: "human"}, idempotencyKey: "quarantine-edit"});
      if (deferredResume) for (let index=0;index<32;index++) await session.applyDecidedLocalUpdate(doc => {
        const scratch=new Y.Doc();
        try {Y.applyUpdate(scratch,Y.encodeStateAsUpdate(doc));const before=Y.encodeStateVector(scratch);
          patchFrontmatter(scratch,new Map([["Name",`Deferred edit ${index}`]]));return Y.encodeStateAsUpdate(scratch,before);
        } finally {scratch.destroy();}
      },undefined,{actorOriginId:"local-person",attribution:{actorKind:"human"},idempotencyKey:`deferred-${index}`});
      const db = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
      const outboxId = String(db.prepare("SELECT outbox_id FROM owner_ydoc_outboxes WHERE workspace_id=? AND object_id=? AND pending_bytes>0").get(workspaceId, document.binding.objectId)!.outbox_id);
      db.close();
      const readPending = () => source.sessions.run(source.workspace, async ({client, workspace}) => {
        const outbox = new OwnerYDocOutbox(client, workspace);
        try {return await outbox.readPending(outboxId);} finally {outbox.dispose();}
      });
      expect((await readPending()).entries).not.toHaveLength(0);
      if (!offlineStop && !deferredResume) await source.sessions.run(source.workspace, async ({client, workspace}) => {
        const outbox = new OwnerYDocOutbox(client, workspace);
        try {await outbox.quarantine({outboxId, reason: quarantineReason});} finally {outbox.dispose();}
      });
      await session.close({settle: false});
      const handlers = new Map<string, (event: {sender: {id: number}}, payload: unknown) => unknown>();
      const credentials = {serverUrl: proxy.origin, relayUrl: proxy.origin, userId: workspaceId, email: "owner@dohc.test", token: relayConnection.token};
      const unexpected = (): never => {throw new Error("Unexpected Stop dependency");};
      let offline = offlineStop, stopRefusalStatus: number | undefined;
      const ownerHandlers = createRelaySharesIpcHandlers({
        remoteForWorkspace: async () => ({credentials, credentialGeneration: 1}), currentCredentialGeneration: () => 1,
        currentCredentials: () => credentials, warmCredentialCache: async () => {}, relayShareJson: unexpected,
        relayShareJsonWithCredentials: async <R,>(_credentials: unknown, endpoint: string, init?: RequestInit): Promise<R> => {
          if (offline) throw new Error("offline");
          const response = await fetch(`${proxy.origin}${endpoint}`, {...init, headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"}});
          if (!response.ok) {
            const text = await response.text();
            let data: unknown = null;
            try {data = JSON.parse(text);} catch {/* Not JSON: fail below with the relay's answer. */}
            // A Stop refusal reaches Stop as main's relayShareJsonWithCredentials throws it.
            const stopRefusal = liveStopRelayError(data);
            if (stopRefusal) {stopRefusalStatus = response.status; throw stopRefusal;}
            expect(response.ok, `${init?.method ?? "GET"} ${endpoint} answered ${response.status}: ${text}`).toBe(true);
          }
          return await response.json() as R;
        }, relayShareErrorCopy: unexpected, relayShareDiscussionActivityPolls: createPresencePollRegistry(),
        listOwnerLiveStops: () => source.sessions.run(source.workspace, async ({workspace}) => source.nativeClient().ownerYDocStopList({id:0,workspace,deadlineMs:REAL_DAEMON_DEADLINE_MS})),
        ownerLiveStop: (_workspace, action, stopPath, binding, acceptedCursor) => source.sessions.run(source.workspace, async ({workspace}) => {
          const client = source.nativeClient(), request = {id: 0, workspace, deadlineMs: REAL_DAEMON_DEADLINE_MS};
          if (action === "clear") {await client.ownerYDocStopClear(request, binding as {mainVersionId: string; objectId: string; currentPath: string});return;}
          if (action==="retired") {await client.ownerYDocStopRetired(request,binding!);return;}
          return action === "request" ? client.ownerYDocStopRequest(request, binding as {mainVersionId: string; objectId: string; currentPath: string})
            : client.ownerYDocRelease(request, binding as import("@dohc/live-session-contract").LiveObjectBinding, {acceptedCursor: acceptedCursor!});
        }), liveDocument: async (_workspace, target) => {
          const resolved = await source.sessions.run(source.workspace, async ({client, workspace}) =>
            new VersionedLiveAdapter(client, workspace, {workspaceId: source.workspace.workspaceId}).resolveFiles({workspaceId: source.workspace.workspaceId, targets: [target]}));
          const [file] = resolved.results;
          return file?.status === "found" ? {mainVersionId: resolved.versionId, objectId: file.objectId, currentPath: file.path} : null;
        }, pushRecorded: async () => {}, withoutEditors: (_workspace, _path, change) => change(), ownerLiveQuarantines: () => [], unwrittenOwnerLiveReleases: async () => [], retryOwnerLiveQuarantine: unexpected, retryOwnerLiveRelease: unexpected, saveOwnerLiveRecoveryCopy: unexpected,
        sendRendererActivity: () => {},
        sharesChanged: unexpected, reconcileReceivedShares: unexpected,
      });
      registerOperations({
        handle: (channel, handler) => {handlers.set(channel, handler);},
        assertTrustedSender() {},
        withActiveWorkspace: async (_event: {sender: {id: number}}, id, _message, work) => {
          expect(id).toBe(workspaceId);
          return work({workspace: source.workspace, assertCurrent() {}});
        },
      }, relayShareOperations, ownerHandlers);
      const stop = () => Promise.resolve(handlers.get(relayShareOperations.stopOwnerLiveDocument.channel)!({sender: {id: 1}}, {workspaceId, path}));
      const resume = () => Promise.resolve(handlers.get(relayShareOperations.resumeOwnerLiveDocument.channel)!({sender: {id: 1}}, {workspaceId, path}));
      // The session host's store, once it has one.
      const hostStore = async () => {
        const stores = join(relayRoot, "relay-deployment", "live-host");
        const store = (await readdir(stores)).find(entry => /^[0-9a-f]{64}$/u.test(entry));
        return store === undefined ? undefined : join(stores, store);
      };
      // The document's state in the session host's store.
      const hostDocumentState = async () => {
        const store = await hostStore();
        if (!store) return undefined;
        const db = new DatabaseSync(join(store, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
        try {return (db.prepare("SELECT state FROM hosted_documents WHERE object_id=?").get(document.binding.objectId) as {state: string} | undefined)?.state;}
        finally {db.close();}
      };
      // This computer's Stops that still owe the server a retirement.
      const owedStops = async () => (await source.sessions.run(source.workspace, async ({workspace}) =>
        source.nativeClient().ownerYDocStopList({id: 0, workspace, deadlineMs: REAL_DAEMON_DEADLINE_MS}))).filter(row => row.retirementOwed);
      if (name === heldStopCase) {
        // A hosted pull holds the session host's only request slot, so Stop can't
        // drain or prepare there, and the relay answers that edits are pending.
        preStopFeed = proxy.holdNextHostedLogResponse(workspaceId);
        const response = await waitForHostedLog(preStopFeed, preStopFeed.captured, "pre-Stop capture");
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ ok: true,
          scope: { documents: expect.arrayContaining([{ objectId: document.binding.objectId, path }]) } });
        expect(await hostDocumentState()).toBe("ready");
        const refused = await stop().then(() => {throw new Error("Stop succeeded while the session host was held.");}, (error: unknown) => error);
        expect(stopRefusalStatus).toBe(409);
        expect(readLiveStopRefusal(refused)).toEqual({code: "edits-pending"});
        expect((refused as Error).message).toBe(LIVE_STOP_EDITS_PENDING);
        // The refusal cleared this computer's Stop, so the next Stop starts afresh.
        expect(await owedStops()).toEqual([]);
        preStopFeed.release();
        try { await waitForHostedLog(preStopFeed, preStopFeed.delivered, "pre-Stop delivery"); }
        catch (error) {
          // A host that gave up on the held pull retries it, and the release lets that retry through.
          if (!(error instanceof HostedLogClientClosedError)) throw error;
        }
        // The session host holds the document again before Stop is sent again.
        await expect.poll(async () => (await discovery()).length, {timeout: 120_000}).toBe(1);
      }
      if (offlineStop) {
        await expect(stop()).rejects.toThrow("dohc is waiting for the server to stop live editing and will keep trying.");
        const requested = await source.sessions.run(source.workspace, async ({workspace}) =>
          source.nativeClient().ownerYDocStopList({id: 0, workspace, deadlineMs: REAL_DAEMON_DEADLINE_MS}));
        expect(requested).toMatchObject([{state: "requested", binding: document.binding}]);
        const stillBound = await capture.openYDocSession({path, contentKind: "richdoc", onRemoteUpdate: () => undefined});
        await stillBound.applyDecidedLocalUpdate(doc => {
          const scratch = new Y.Doc();
          try {Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc)); const before = Y.encodeStateVector(scratch);
            patchFrontmatter(scratch, new Map([["Name", "Offline while stopping"]])); return Y.encodeStateAsUpdate(scratch, before);
          } finally {scratch.destroy();}
        }, undefined, {actorOriginId: "local-person", attribution: {actorKind: "human"}, idempotencyKey: "offline-stop"});
        await stillBound.close({settle: false});
        expect((await discovery()).length).toBe(1);
        offline = false;
        await source.sessions.run(source.workspace, async ({workspace}) => reconcileOwnerLiveStops({
          client: source.nativeClient(), workspaceHandle: workspace, workspaceId, signal: AbortSignal.timeout(60_000), assertCurrent() {},
          async retire(binding, signal) {
            const response = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, {method: "DELETE", signal,
              headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"},
              body: JSON.stringify({path: binding.currentPath, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration})});
            const retired=await response.json() as {acceptedCursor:number};expect(retired).toMatchObject({status: "retired"}); return response.ok ? retired.acceptedCursor : null;
          },
        }));
      } else await stop();
      await expect.poll(async () => (await discovery()).length, {timeout: 60_000}).toBe(0);
      if (name === heldStopCase) expect(await owedStops()).toEqual([]);
      if (deferredResume) {
        expect((await readPending()).entries).toHaveLength(33);
        await resume();
        await expect.poll(async () => {
          await pass(AbortSignal.timeout(60_000));
          const db=new DatabaseSync(join(rootA,SECRET_FILE_STORE_RELATIVE_PATH),{readOnly:true});
          try {return Number(db.prepare("SELECT COALESCE(SUM(pending_entry_count),0) AS count FROM owner_ydoc_outboxes WHERE object_id=?").get(document.binding.objectId)!.count);}
          finally {db.close();}
        },{timeout:120_000}).toBe(0);
        await expect.poll(async () => {
          await capture!.flush();await pushUntilDrained(relay);await peer!.relay.pull(apply => peer!.capture.runRelaySync(apply));
          return readFile(join(rootB,path),"utf8");
        },{timeout:120_000}).toContain("Name: Deferred edit 31");
        return;
      }
      await expect(readPending()).rejects.toThrow("owner-outbox-not-found");
      expect(await readFile(join(rootA, path), "utf8")).toContain(offlineStop ? "Name: Offline while stopping" : "Name: Quarantined edit");
      const releasedMoment = (await capture.listMoments({limit: 100})).moments.find(moment => moment.path === path);
      expect(releasedMoment?.authors).toContainEqual({kind: "human", humanId: "local-person"});
      await expect.poll(hostDocumentState, {timeout: 120_000}).toBe("parked");
      // An ordinary owner edit that reaches the peer through ordinary sync.
      const editOrdinary = async (value: string, key: string) => {
        const ordinary = await capture!.openYDocSession({path, contentKind: "richdoc", onRemoteUpdate: () => undefined});
        await expect(ordinary.applyDecidedLocalUpdate(doc => {
          const scratch = new Y.Doc();
          try {Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc)); const before = Y.encodeStateVector(scratch);
            patchFrontmatter(scratch, new Map([["Name", value]])); return Y.encodeStateAsUpdate(scratch, before);
          } finally {scratch.destroy();}
        }, undefined, {actorOriginId: "local-person", attribution: {actorKind: "human"}, idempotencyKey: key})).resolves.toBeDefined();
        await ordinary.settleNow();await ordinary.close();
        expect(await readFile(join(rootA, path), "utf8")).toContain(`Name: ${value}`);
        await expect.poll(async () => {
          await pushUntilDrained(relay);
          await peer!.relay.pull(apply => peer!.capture.runRelaySync(apply));
          return readFile(join(rootB, path), "utf8");
        }, {timeout: 120_000}).toContain(`Name: ${value}`);
      };
      await editOrdinary("Local after stop", "after-stop");
      const liveRow = async () => {
        const ready = (await discovery()).some(row => row.binding.currentPath === path);
        const row = (discoveryPayload as {documents: Array<{path: string}>}).documents.find(row => row.path === path);
        return {ready, row};
      };
      const ready = {ready: true, row: expect.objectContaining({path, status: "ready"})};
      // The operator's reports that the session host holds the document.
      const reports = () => relayServer!.diagnostics().stderr.split(`Live editing of ${path} in workspace ${workspaceId} is held`).length - 1;
      // The relay's activations, the session host's copy and the relay's log, for a row that never became ready.
      const notReady = async (error: unknown): Promise<never> => {
        const db = new DatabaseSync(relayOptions.dbPath, {readOnly: true});
        let activations: unknown;
        try {
          activations = db.prepare(`SELECT activation_id,predecessor_activation_id,object_id,lineage_claim_id,completion_json IS NOT NULL AS completed,
            retire_requested_at_ms,retire_restore_generation,retired_at_ms FROM sync_relay_service_activations WHERE workspace_id=?`).all(workspaceId);
        } finally {db.close();}
        throw new Error(JSON.stringify({discoveryPayload, activations, hostDocument: await hostDocumentState(),
          diagnostics: relayServer!.diagnostics()}), {cause: error});
      };
      await resume();
      // A successor captures the stopped edit, and the session host's copy has it.
      await expect.poll(liveRow, {timeout: 120_000}).toEqual(ready).catch(notReady);
      expect(await hostDocumentState()).toBe("ready");
      expect(reports()).toBe(0);
      // The settlement commits before the engine writes the file.
      await expect.poll(async () => readFile(join((await hostStore())!, path), "utf8"), {timeout: 10_000}).toContain("Name: Local after stop");
      // The peer keeps the stopped edit.
      await expect.poll(async () => {
        await peer!.relay.pull(apply => peer!.capture.runRelaySync(apply));
        return readFile(join(rootB, path), "utf8");
      }, {timeout: 120_000}).toContain("Name: Local after stop");
      // A relay restart starts the session host from its store, and the document is ready again.
      await relayServer.stop();
      relayServer = await spawnSyncRelay(relayOptions);
      proxy.routeRelayTo(relayServer.baseUrl);
      await expect.poll(liveRow, {timeout: 120_000}).toEqual(ready).catch(notReady);
      expect(await hostDocumentState()).toBe("ready");
      expect(reports()).toBe(0);
      // Another document of the workspace also starts live editing.
      const other = "notes/other.md";
      await adapter.writeTextFile({workspaceId, versionId: "main", path: other, text: "# Other\n",
        publish: true, metadata: {origin: "api"}, author: {kind: "human", humanId: "local-person"}});
      const otherSession = await capture.openYDocSession({path: other, contentKind: "richdoc", onRemoteUpdate: () => undefined});
      await otherSession.settleNow(); await otherSession.close();
      await pushUntilDrained(relay);
      const otherShare = await fetch(`${proxy.origin}/sync/${workspaceId}/shares`, {method: "POST",
        headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"},
        body: JSON.stringify({recipientEmail: "native-recipient@dohc.test", paths: ["notes"], access: "edit"})});
      expect(otherShare.status).toBe(200);
      const otherEnrollment = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, {method: "POST",
        headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"},
        body: JSON.stringify({shareId: (await otherShare.json() as {shareId: string}).shareId})});
      expect([200, 202]).toContain(otherEnrollment.status);
      // Discovery lists documents by path.
      await expect.poll(async () => (await discovery()).map(row => row.binding.currentPath), {timeout: 120_000}).toEqual([other, path]);
      expect(await liveRow()).toEqual(ready);
    }
    await session.close({settle: false});
  } finally {
    preStopFeed?.destroy();
    await delivery?.stop(); await peer?.close();
    try {await capture?.stop().catch(() => undefined);} finally {await owner?.close(); await relayServer?.stop(); await proxy.close();
      setDefaultCACertificates(previousRoots); vi.unstubAllEnvs();}
  }
}, 420_000);

describe.skipIf(engine.missing)("ordinary relay scenarios", () => {
  let relayServer: Awaited<ReturnType<typeof spawnSyncRelay>>;
  let starting: Promise<typeof relayServer> | undefined;

  // Cover the helper's 120 s startup guard and its shutdown drain.
  beforeAll(async () => {
    // Per-test scratch is removed after each case; this store belongs to the suite.
    const relayRoot = createSuiteTestScratchSync("dohc-ordinary-relay-");
    starting = spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    relayServer = await starting;
  }, 150_000);

  afterAll(async () => {
    await (await starting?.catch(() => undefined))?.stop();
  }, 30_000);

  it.each([true, false])(
    "settles adoption of an already-open Collection record through the real relay (has id=%s)",
    async (hasId) => {
      const workspaceId = `two-daemon-open-adoption-${hasId}-${randomUUID()}`;
      const rootA = await createTestScratch("dohc-open-adoption-a-");
      const rootB = await createTestScratch("dohc-open-adoption-b-");
      const relayConnection = { baseUrl: relayServer.baseUrl, token: `test:${workspaceId}` };
      const person = { kind: "human", humanId: "local-person" } as const;
      const path = "tasks/pending.md";
      let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
      let capture: WorkspaceEngineCapture | undefined;
      let peer: LiveDaemonCapture | undefined;
      let sync: CloudSyncEngine | undefined;
      try {
        owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0 });
        const source = owner;
        const relay = source.relay.bind({ ...source.workspace, relay: relayConnection });
        await relay.claim();
        await source.chats.ensureGeneralChannel({ workspaceId });
        await pushUntilDrained(relay);
        const adapter = await source.sessions.run(source.workspace, async ({ client, workspace }) =>
          new VersionedLiveAdapter(client, workspace, { workspaceId }));
        await adapter.ensureMainVersion({ workspaceId });
        for (const [filePath, text] of [
          ["tasks/collection.yaml", "fields:\n  Name:\n    type: text\n"],
          [path, `${hasId ? "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n\n" : ""}# Keep this body\n`],
        ]) {
          await adapter.writeTextFile({ workspaceId, versionId: "main", path: filePath!, text: text!, publish: true,
            metadata: { origin: "api" }, author: person });
        }
        // Reconciliation inserts the binding but cannot adopt it until desktop
        // imports the rich-document lineage. Open the editor in that window.
        await expect.poll(async () => (await adapter.listPendingCollectionAdoptions()).adoptions.map(item => item.filePath),
          { timeout: REAL_DAEMON_DEADLINE_MS }).toEqual([path]);
        const errors: string[] = [];
        capture = createWorkspaceEngineCapture({ ...source.workspace, rustEngineSessions: source.sessions,
          settleDebounceMs: 60_000, onError: (context, error) => errors.push(`${context}: ${String(error)}`) });
        const session = await capture.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
        expect((await adapter.listPendingCollectionAdoptions()).adoptions.map(item => item.filePath)).toEqual([path]);
        if (!hasId) await capture.flush();
        await session.applyDecidedLocalUpdate(doc => {
          const scratch = new Y.Doc();
          try {
            Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
            const before = Y.encodeStateVector(scratch);
            patchFrontmatter(scratch, new Map([["Name", "Manual"]]));
            return Y.encodeStateAsUpdate(scratch, before);
          } finally { scratch.destroy(); }
        }, undefined, { actorOriginId: "local-person", attribution: { actorKind: "human" }, idempotencyKey: "owner-name" });
        if (!hasId) await session.settleNow();
        // The editor keeps its lease throughout adoption and capture settlement.
        await capture.flush();
        capture.start();
        await expect.poll(async () => ({ pending: (await adapter.listPendingCollectionAdoptions()).adoptions.length,
          settled: (await adapter.flushCapture()).settled, errors }), { timeout: REAL_DAEMON_DEADLINE_MS })
          .toEqual({ pending: 0, settled: true, errors: [] });
        expect(errors).toEqual([]);
        await expect.poll(() => adapter.watcherStatus(), { timeout: REAL_DAEMON_DEADLINE_MS })
          .toMatchObject({ running: true, degraded: false, phase: "ready" });
        const markdown = await readFile(join(rootA, path), "utf8");
        expect(markdown).toContain("Name: Manual");
        expect(markdown).toContain("# Keep this body");
        expect(session.doc.getMap("frontmatter").get("Name")).toBe("Manual");
        const recordId = session.doc.getMap("frontmatter").get("id");
        if (typeof recordId !== "string") throw new Error("Adoption did not install the record id.");
        const record = await adapter.getCollectionRecord({ collectionPath: "tasks", recordId, historyLimit: 100 });
        expect(record.history.find(change => change.field === "Name")).toMatchObject({ authorOriginId: "local-person" });
        const head = await adapter.readTextFile({ workspaceId, versionId: "main", path });
        const moments = (await capture.listMoments({ limit: 100 })).moments;
        expect(moments.find(moment => moment.id === head?.latestMomentId)?.authors).toContainEqual(person);
        expect((await adapter.listPendingCollectionAdoptions()).adoptions).toEqual([]);
        sync = createRelaySyncEngine({ rootDir: rootA, relay: relayConnection, operations: relay, capture,
          onChange: () => undefined });
        sync.queueSync();
        await sync.start();
        expect(sync.snapshot()).toMatchObject({ pendingChangeCount: 0, syncFailure: null });
        await sync.stop();
        peer = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: relayConnection });
        await pullAndExpect(peer, rootB, path, markdown);
        await session.close();
      } finally {
        await sync?.stop();
        await peer?.close();
        try { await capture?.stop().catch(() => undefined); } finally { await owner?.close(); }
      }
    },
    60_000,
  );

  it.each(["new", "legacy", "accepted"] as const)(
    "syncs a %s hand-made Collection record with local human History through the real relay",
    async (queueStyle) => {
      const workspaceId = `two-daemon-human-record-${queueStyle}-${randomUUID()}`;
      const rootA = await createTestScratch("dohc-human-record-a-");
      const rootB = await createTestScratch("dohc-human-record-b-");
      const relayConnection = { baseUrl: relayServer.baseUrl, token: "test:" + workspaceId };
      let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
      let capture: WorkspaceEngineCapture | undefined;
      let peer: LiveDaemonCapture | undefined;
      try {
        owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0 });
        const source = owner;
        capture = createWorkspaceEngineCapture({ ...source.workspace, rustEngineSessions: source.sessions });
        let relay = source.relay.bind({ ...source.workspace, relay: relayConnection });
        await relay.claim();
        await source.chats.ensureGeneralChannel({ workspaceId });
        await pushUntilDrained(relay);
        await capture.writeAuthoredFile(join(rootA, "tasks/collection.yaml"), "fields: {}\n", { kind: "human", humanId: "local-person" });
        const captureClient = await source.sessions.run(source.workspace, async ({ client }) => client);
        if (!captureClient.onEvent) throw new Error("The real daemon has no capture event source.");
        const onEvent = captureClient.onEvent.bind(captureClient);
        const person = { kind: "human", humanId: "local-person" } as const;
        const context = desktopRecordEditContext({
          capture, workspaceRoot: rootA, person, signal: new AbortController().signal,
          withAdapter: work => source.sessions.run(source.workspace, ({ client, workspace }) =>
            work(new VersionedLiveAdapter(client, workspace, { workspaceId }))),
          onCaptureSettled: listener => onWorkspaceCaptureSettled({ onEvent }, workspaceId, listener),
        });
        const record = await createRecordByHand({ collectionPath: "tasks", name: "hand-made" }, {
          author: createLocalChangeAuthor("Local person"),
          localPerson: async () => person,
          withWorkspaceOperation: work => work(undefined),
          editContext: async () => context,
        });
        if ("kind" in record) throw new Error(record.reason);
        const local = (await capture.listMoments({ limit: 100 })).moments.find(moment => moment.path === record.path);
        expect(local?.authors).toEqual([person]);
        if (queueStyle !== "new") {
          // Restore an older build's wire row with the daemon stopped.
          // Accepted agent rows also exist remotely, with a lost acknowledgement.
          if (queueStyle === "accepted") expect((await pushUntilDrained(relay)).pushed).toBeGreaterThan(0);
          await capture.stop();
          await owner.close();
          capture = undefined;
          owner = undefined;
          const legacyAuthors = [
            ...(queueStyle === "legacy" ? [person] : []),
            { kind: "agent", agentId: "signed-out-agent", onBehalfOf: "local:123" },
            { kind: "automation", automationId: "signed-out-rule", onBehalfOf: "local:456", depth: 1 },
          ];
          const db = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH));
          try {
            const restored = db.prepare(
              "UPDATE replication_log SET payload_json=json_set(payload_json, '$.authors', json(?)) WHERE workspace_id=? AND imported=0 AND op_kind='moment.append' AND json_extract(payload_json, '$.path')=?",
            ).run(JSON.stringify(legacyAuthors), workspaceId, record.path);
            expect(restored.changes).toBe(1);
            const row = db.prepare(
              "SELECT origin_id, origin_seq, payload_json FROM replication_log WHERE workspace_id=? AND op_kind='moment.append' AND json_extract(payload_json, '$.path')=?",
            ).get(workspaceId, record.path) as { origin_id: string; origin_seq: number; payload_json: string };
            expect(JSON.parse(row.payload_json).authors).toEqual(legacyAuthors);
            // Older Rust builds also serialized the entire row with sorted keys.
            row.payload_json = stableJsonStringify(JSON.parse(row.payload_json));
            expect(db.prepare(
              "UPDATE replication_log SET payload_json=? WHERE workspace_id=? AND origin_id=? AND origin_seq=?",
            ).run(row.payload_json, workspaceId, row.origin_id, row.origin_seq).changes).toBe(1);
            if (queueStyle === "accepted") {
              const relayDb = new DatabaseSync(relayServer.dbPath);
              try {
                expect(relayDb.prepare(
                  "UPDATE sync_relay_log SET payload_json=? WHERE workspace_id=? AND origin_id=? AND origin_seq=?",
                ).run(row.payload_json, workspaceId, row.origin_id, row.origin_seq).changes).toBe(1);
              } finally {
                relayDb.close();
              }
              expect(db.prepare(
                "UPDATE sync_relay_push_state SET pushed_seq=? WHERE workspace_id=? AND origin_id=?",
              ).run(row.origin_seq - 1, workspaceId, row.origin_id).changes).toBe(1);
            }
          } finally {
            db.close();
          }
          owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0 });
          capture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions });
          relay = owner.relay.bind({ ...owner.workspace, relay: relayConnection });
        }
        expect((await pushUntilDrained(relay)).pushed).toBeGreaterThan(0);
        const relayDb = new DatabaseSync(relayServer.dbPath, { readOnly: true });
        const engineDb = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
        try {
          const rows = relayDb.prepare(
            "SELECT origin_id, origin_seq, payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='moment.append'",
          ).all(workspaceId) as { origin_id: string; origin_seq: number; payload_json: string }[];
          expect(rows.length).toBeGreaterThan(0);
          for (const row of rows) {
            const payload = JSON.parse(row.payload_json);
            expect(payload.attributionUnavailable).toBeUndefined();
            expect(payload.authors).toEqual(queueStyle !== "new" && payload.path === record.path
              ? [{ kind: "agent", agentId: "signed-out-agent", onBehalfOf: "local:123" }, { kind: "automation", automationId: "signed-out-rule", onBehalfOf: "local:456", depth: 1 }]
              : undefined);
            if (queueStyle === "new") expect(row.payload_json).not.toContain("local:");
            expect(row.payload_json).not.toContain(person.humanId);
            const stored = engineDb.prepare(
              "SELECT payload_json FROM replication_log WHERE workspace_id=? AND origin_id=? AND origin_seq=?",
            ).get(workspaceId, row.origin_id, row.origin_seq) as { payload_json: string };
            expect(stored.payload_json).toBe(row.payload_json);
          }
        } finally {
          engineDb.close();
          relayDb.close();
        }
        peer = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: relayConnection });
        await pullAndExpect(peer, rootB, record.path, await readFile(join(rootA, record.path)), "text");
        expect((await peer.capture.listMoments({ limit: 100 })).moments.some(moment => moment.path === record.path)).toBe(true);
        const echo = await pullCaptured(relay, capture);
        expect(echo.sharingDeclined).toEqual([]);
        expect(await owner.sessions.run(owner.workspace, ({ client, workspace }) =>
          new WorkspaceDaemonRequester(client).request("sync.refusalNotices", { workspaceId }, { workspace }),
        )).toEqual({ notices: [] });
        const afterEcho = (await capture.listMoments({ limit: 100 })).moments.find(moment => moment.path === record.path);
        expect(afterEcho?.authors).toEqual([person]);
      } finally {
        await peer?.close();
        await capture?.stop();
        await owner?.close();
      }
    },
    3 * REAL_DAEMON_DEADLINE_MS,
  );

  it(
    "names the person on their restore in local History after a reopen, and never sends them to the relay",
    async () => {
      const workspaceId = `two-daemon-person-restore-${randomUUID()}`;
      const root = await createTestScratch("dohc-person-restore-");
      const relayConnection = { baseUrl: relayServer.baseUrl, token: "test:" + workspaceId };
      const person = { kind: "human", humanId: "local-person" } as const;
      let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
      let capture: WorkspaceEngineCapture | undefined;
      const restoreMoment = async (momentId: string) =>
        (await capture!.listMoments({ limit: 100 })).moments.find(moment => moment.id === momentId);
      try {
        owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: root }, { maxRestarts: 0 });
        capture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions });
        const relay = owner.relay.bind({ ...owner.workspace, relay: relayConnection });
        await relay.claim();
        await owner.chats.ensureGeneralChannel({ workspaceId });
        await capture.writeAuthoredFile(join(root, "plan.md"), "first\n", person, { createOnly: true });
        await capture.writeAuthoredFile(join(root, "plan.md"), "second\n", person);
        const [edit] = await waitForPathMoments(capture, "plan.md", 2);
        const { restoredMomentId } = await capture.restoreFileToBeforeMoment(edit!.id, person);
        expect(await readFile(join(root, "plan.md"), "utf8")).toBe("first\n");
        expect(await restoreMoment(restoredMomentId)).toMatchObject({ metadata: { origin: "restore" }, authors: [person] });

        expect((await pushUntilDrained(relay)).pushed).toBeGreaterThan(0);
        const relayDb = new DatabaseSync(relayServer.dbPath, { readOnly: true });
        try {
          const sent = relayDb.prepare(
            "SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='moment.append' AND json_extract(payload_json, '$.momentId')=?",
          ).get(workspaceId, restoredMomentId) as { payload_json: string } | undefined;
          expect(JSON.parse(sent!.payload_json)).toMatchObject({ metadata: { origin: "restore" } });
          expect(JSON.parse(sent!.payload_json).authors).toBeUndefined();
          expect(JSON.parse(sent!.payload_json).attributionUnavailable).toBeUndefined();
          expect(sent!.payload_json).not.toContain(person.humanId);
        } finally {
          relayDb.close();
        }

        await capture.stop();
        await owner.close();
        owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: root }, { maxRestarts: 0 });
        capture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions });
        expect(await restoreMoment(restoredMomentId)).toMatchObject({ metadata: { origin: "restore" }, authors: [person] });
      } finally {
        await capture?.stop();
        await owner?.close();
      }
    },
    3 * REAL_DAEMON_DEADLINE_MS,
  );

  // A pull page runs every delete before every write. A device that joins
  // after a rename receives the delete of the old name before the write that
  // would create its folder.
  it("joins after a page in a folder was renamed in dohc", async () => {
    const workspaceId = `two-daemon-join-after-rename-${randomUUID()}`;
    const rootA = await createTestScratch("dohc-join-after-rename-a-");
    const rootB = await createTestScratch("dohc-join-after-rename-b-");
    const connection = { baseUrl: relayServer.baseUrl, token: `test:${workspaceId}` };
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      await pushUntilDrained(daemonA.relay);
      await writeAndCapture(daemonA, rootA, "notes/before.md", "body\n");
      const finish = await daemonA.capture.beginFileRename("notes/before.md", "notes/after.md");
      await rename(join(rootA, "notes", "before.md"), join(rootA, "notes", "after.md"));
      await finish(true);
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);

      daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      const receiver = daemonB;
      const pull = await receiver.relay.pull(apply => receiver.capture.runRelaySync(apply));
      expect(pull.fastForwardedPaths.filter(({ path }) => path.startsWith("notes/"))
        .map(({ operation, path }) => [operation, path])).toEqual([["delete", "notes/before.md"], ["write", "notes/after.md"]]);
      expect(await readdir(join(rootB, "notes"))).toEqual(["after.md"]);
      expect(await readFile(join(rootB, "notes", "after.md"), "utf8")).toBe("body\n");
      const again = await receiver.relay.pull(apply => receiver.capture.runRelaySync(apply));
      expect(again).toMatchObject({ fetched: 0, applied: 0, fastForwardedPaths: [] });
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
    }
  }, 60_000);

});

it.skipIf(engine.missing)(
  "syncs a captured file between two real daemons through one real relay",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-sync",
      path: "notes/hello.md",
      contents: "hello from daemon A\n",
      contentKind: "text",
      reverse: {
        path: "notes/reply.md",
        contents: "hello from daemon B\n",
      },
      restart: { contents: "hello after daemon B restarted\n" },
      rejoin: true,
    }),
  60_000,
);

it.skipIf(engine.missing)(
  "backfills a captured file when the first relay position follows capture",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-enrolment-window",
      path: "notes/before-first-push.md",
      contents: "captured before the first relay position\n",
      contentKind: "text",
      bootstrapRelayBeforeCapture: false,
    }),
  60_000,
);

// Quit stops waiting for a relay push the server has not answered. The
// engine has not acknowledged the edit, so the next launch sends it.
it.skipIf(engine.missing)(
  "sends an edit whose push was unanswered at quit on the next launch",
  async () => {
    const workspaceId = "two-daemon-quit-push";
    const token = `test:${workspaceId}`;
    const rootA = await createTestScratch("dohc-quit-push-a-");
    const rootB = await createTestScratch("dohc-quit-push-b-");
    const relayRoot = await createTestScratch("dohc-quit-push-relay-");
    const dbPath = join(relayRoot, "relay", "relay.sqlite");
    let relay = await spawnSyncRelay({ dbPath, compiledMain: compiledRelayMain });
    const port = Number(new URL(relay.baseUrl).port);
    const connection = { baseUrl: relay.baseUrl, token };
    // A server that takes each connection and never answers. The engine resets
    // the connection when it stops.
    const held = new Set<Socket>();
    const silent = createServer((socket) => {
      held.add(socket);
      socket.on("error", () => undefined);
    });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      await pushUntilDrained(daemonA.relay);
      await writeAndCapture(daemonA, rootA, "notes.md", "body\n");

      await relay.stop();
      silent.listen(port, "127.0.0.1");
      await once(silent, "listening");
      const reached = once(silent, "connection") as Promise<[Socket]>;
      const push = daemonA.relay.push();
      const [socket] = await reached;
      await once(socket, "data");
      daemonA.beginShutdown();
      await expect(push).rejects.toBeInstanceOf(EngineWorkspaceShuttingDownError);
      await daemonA.close();
      daemonA = null;
      for (const socket of held) socket.destroy();
      silent.close();
      await once(silent, "close");

      relay = await spawnSyncRelay({ dbPath, compiledMain: compiledRelayMain, port });
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      await pullAndExpect(daemonB, rootB, "notes.md", "body\n");
    } finally {
      for (const socket of held) socket.destroy();
      if (silent.listening) silent.close();
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  120_000,
);

// The close follows the desktop quit (appLifecycle.ts and main.ts's shutdown):
// beginEngineShutdown, then the workspace's capture close, then closeRelay and
// stopEngine.
describe.skipIf(engine.missing)("Quit while a save is in progress", () => {
  // `running` names the close steps still awaited.
  function quitLikeTheDesktop(device: LiveDaemonCapture) {
    const running = new Set<string>();
    const step: CloseStep = (name, work) => {
      running.add(name);
      const done = () => { running.delete(name); };
      work.then(done, done);
      return work;
    };
    device.beginShutdown();
    const done = (async () => {
      await step("capture.settleAndCloseAllLiveSessions", device.capture.settleAndCloseAllLiveSessions()).catch(() => undefined);
      await device.close(step).catch(() => undefined);
    })();
    return { running, done };
  }

  // Resolves "closed", or names the steps still awaited at `limitMs`.
  async function closedWithin(quit: ReturnType<typeof quitLikeTheDesktop>, limitMs: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([quit.done.then(() => "closed"), new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(`still waiting on ${[...quit.running].join(", ") || "an unlabelled step"}`), limitMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  // The app exits when its quit budget ends, so accepted work has to land inside it.
  async function insideQuitBudget<T>(work: Promise<T>, quitStarted: number): Promise<T | string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("past the quit budget"), Math.max(0, WILL_QUIT_BUDGET_MS - (performance.now() - quitStarted)));
      })]);
    } finally { clearTimeout(timer); }
  }

  // Quitting faster must never drop accepted work: a write the capture admitted
  // before quit holds the close until it lands.
  it("holds quit for a local write admitted before it, and keeps the write", async () => {
    const workspaceId = "two-daemon-quit-held-write";
    const root = await createTestScratch("dohc-quit-held-write-");
    const relayRoot = await createTestScratch("dohc-quit-held-write-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    const connection = { baseUrl: relay.baseUrl, token: `test:${workspaceId}` };
    const person = { kind: "human", humanId: "local-person" } as const;
    const admitted = deferred();
    const release = deferred();
    let daemon: LiveDaemonCapture | null = null;
    let quit: ReturnType<typeof quitLikeTheDesktop> | undefined;
    try {
      daemon = await openLiveDaemonCapture({ workspaceId, rootPath: root, relay: connection });
      await daemon.relay.claim();
      await daemon.chats.ensureGeneralChannel({ workspaceId });
      const written = daemon.capture.writeAuthoredFile(join(root, "kept.md"), "kept\n", person, {
        beforeWrite: async () => {
          admitted.resolve();
          await release.promise;
        },
      }).then(() => "written", (error: unknown) => error);
      await admitted.promise;
      const quitStarted = performance.now();
      quit = quitLikeTheDesktop(daemon);
      daemon = null;
      expect(await closedWithin(quit, 1_000), "Quit waits for the admitted write").toMatch(/^still waiting on /);
      release.resolve();
      expect(await insideQuitBudget(written, quitStarted), "The admitted write lands inside the quit budget").toBe("written");
      expect(await closedWithin(quit, REAL_DAEMON_DEADLINE_MS)).toBe("closed");

      daemon = await openLiveDaemonCapture({ workspaceId, rootPath: root, relay: connection });
      await waitForPathMoments(daemon.capture, "kept.md", 1);
      expect(await readFile(join(root, "kept.md"), "utf8")).toBe("kept\n");
    } finally {
      release.resolve();
      await quit?.done;
      await daemon?.close();
      await relay.stop();
    }
  }, 120_000);
});

// Local work remains available while either kind of pull waits for the server.
describe.skipIf(engine.missing)("History while a pull waits on a server that does not answer (#2709)", () => {
  it.each(["bootstrap pull", "pull after a push"] as const)(
    "writes, opens a document, and lists History while the %s waits",
    async (pass) => {
      const workspaceId = `two-daemon-held-pull-${pass.replaceAll(" ", "-")}`;
      const token = `test:${workspaceId}`;
      const rootA = await createTestScratch("dohc-held-pull-a-");
      const relayRoot = await createTestScratch("dohc-held-pull-relay-");
      const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
      const connection = { baseUrl: relay.baseUrl, token };
      const held = new Set<Socket>();
      const silent = createServer((socket) => {
        held.add(socket);
        socket.on("error", () => undefined);
      });
      const reached = once(silent, "connection") as Promise<[Socket]>;
      // The silent server takes the relay's port, so the next request waits.
      let holding: Promise<void> | undefined;
      const holdRelay = () => holding ??= (async () => {
        await relay.stop();
        silent.listen(relay.port, "127.0.0.1");
        await once(silent, "listening");
      })();
      let daemonA: LiveDaemonCapture | null = null;
      let daemonB: LiveDaemonCapture | null = null;
      let sync: CloudSyncEngine | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pulling = false;
      const pushed: number[] = [];
      try {
        daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
        await daemonA.relay.claim();
        await daemonA.chats.ensureGeneralChannel({ workspaceId });
        await pushUntilDrained(daemonA.relay);
        await writeAndCapture(daemonA, rootA, "notes.md", "body\n");
        let device = daemonA, root = rootA;
        if (pass === "bootstrap pull") {
          expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
          root = await createTestScratch("dohc-held-pull-b-");
          device = daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: root, relay: connection });
          await holdRelay();
        }
        const operations = device.relay;
        sync = createRelaySyncEngine({
          rootDir: root, relay: connection, capture: device.capture, onChange: () => undefined,
          joinBootstrap: pass === "bootstrap pull",
          // The push reaches the working relay; only the pull meets the silent server.
          operations: { ...operations, push: async () => {
            const result = await operations.push();
            pushed.push(result.pushed);
            await holdRelay();
            return result;
          } },
          pullStarting: () => {
            pulling = true;
            return () => { pulling = false; };
          },
        });
        void sync.start().catch(() => undefined);
        const [socket] = await reached;
        await once(socket, "data");
        await vi.waitFor(() => expect(pulling).toBe(true), { timeout: REAL_DAEMON_DEADLINE_MS });
        if (pass === "bootstrap pull") expect(pushed).toEqual([]);
        else expect(pushed[0]).toBeGreaterThan(0);

        // The measured wait: how long History takes to list, up to 15 s.
        const started = performance.now();
        const history = device.capture.listMoments({ limit: 1 }).then(() => "listed", (error: unknown) => error);
        const outcome = await Promise.race([history, new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still waiting"), 15_000);
        })]);
        const waited = Math.round(performance.now() - started);
        console.log(`#2709 ${pass}: History ${String(outcome)} after ${waited} ms, pull ${pulling ? "still waiting" : "ended"}`);
        expect(pulling, "The pull ended before History was checked").toBe(true);
        expect(outcome, "History waited on the pending pull").toBe("listed");
        expect(waited, "History waited on the pending pull").toBeLessThan(2_000);
        clearTimeout(timer);
        const localWork = (async () => {
          await device.capture.writeAuthoredFile(join(root, "local.txt"), "local work\n",
            { kind: "human", humanId: "local-person" });
          const session = await device.capture.openYDocSession({
            path: "local.txt", contentKind: "plaintext", onRemoteUpdate: () => undefined,
          });
          await session.close();
          expect(await readFile(join(root, "local.txt"), "utf8")).toBe("local work\n");
          expect((await device.capture.listMoments({ limit: 20 })).moments.some(moment => moment.path === "local.txt")).toBe(true);
        })().then(() => "completed", (error: unknown) => error);
        const localOutcome = await Promise.race([localWork, new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still waiting"), 2_000);
        })]);
        expect(localOutcome, "Local work waited on the pending fetch").toBe("completed");
        expect(pulling).toBe(true);
      } finally {
        clearTimeout(timer);
        // Shutdown rejects the held pull, so the pass and the chain end.
        daemonB?.beginShutdown();
        daemonA?.beginShutdown();
        for (const socket of held) socket.destroy();
        if (silent.listening) silent.close();
        await sync?.stop();
        await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
        await relay.stop();
      }
    },
    120_000,
  );
});

// A rename that changes only case reaches a peer as a delete of the old
// spelling and a write of the new one. On a disk that ignores case, as macOS
// and Windows do by default, writing `Notes.md` rewrites the existing
// `notes.md`, so the page must delete first or the file is lost.
it.skipIf(engine.missing)(
  "keeps a file another daemon renamed only by case on a disk that ignores case",
  async (context) => {
    const workspaceId = "two-daemon-case-rename";
    const token = `test:${workspaceId}`;
    const rootA = await createTestScratch("dohc-case-rename-a-");
    const rootB = await createTestScratch("dohc-case-rename-b-");
    await writeFile(join(rootB, "probe.md"), "");
    const ignoresCase = await readFile(join(rootB, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootB, "probe.md"));
    if (!ignoresCase) context.skip("this disk keeps case apart");
    const relayRoot = await createTestScratch("dohc-case-rename-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: { baseUrl: relay.baseUrl, token } });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      await pushUntilDrained(daemonA.relay);
      await writeAndCapture(daemonA, rootA, "notes.md", "body\n");
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: { baseUrl: relay.baseUrl, token } });
      await pullAndExpect(daemonB, rootB, "notes.md", "body\n");

      const finish = await daemonA.capture.beginFileRename("notes.md", "Notes.md");
      await rename(join(rootA, "notes.md"), join(rootA, "Notes.md"));
      await finish(true);
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      const receiver = daemonB;
      const pull = await receiver.relay.pull(apply => receiver.capture.runRelaySync(apply));

      expect((await readdir(rootB)).filter((name) => !name.startsWith("."))).toEqual(["Notes.md"]);
      expect(await readFile(join(rootB, "Notes.md"), "utf8")).toBe("body\n");
      expect(pull.fastForwardedPaths.map(({ operation, path }) => [operation, path])).toEqual([
        ["delete", "notes.md"],
        ["write", "Notes.md"],
      ]);
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing).each(["keep-current", "apply-incoming"] as const)(
  "preserves independent Y.Doc bases in a version conflict and converges after %s",
  async (resolution) => {
    const workspaceId = `two-daemon-independent-bases-${resolution}`;
    const textA = "seed from A\n";
    const textB = "seed from B\n";
    const chosen = resolution === "keep-current" ? textB : textA;
    const token = `test:${workspaceId}`;
    const path = "notes/shared.txt";
    const rootA = await createTestScratch("dohc-independent-base-a-");
    const rootB = await createTestScratch("dohc-independent-base-b-");
    const rootC = await createTestScratch("dohc-independent-base-c-");
    const relayRoot = await createTestScratch("dohc-independent-base-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    let daemonC: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await daemonA.relay.claim();
      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });

      const sessionA = await openIndependentPlaintextLineage(
        daemonA,
        rootA,
        path,
        textA,
      );
      const sessionB = await openIndependentPlaintextLineage(
        daemonB,
        rootB,
        path,
        textB,
      );
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);

      // Both editors remain live. Each pull may persist the foreign base, but
      // it must not arbitrate behind the editor or change either projection.
      await pullCaptured(daemonA.relay, daemonA.capture);
      await pullCaptured(daemonB.relay, daemonB.capture);
      expect(await readFile(join(rootA, path), "utf8")).toBe(textA);
      expect(await readFile(join(rootB, path), "utf8")).toBe(textB);
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);

      // Closing releases the leases. A's earlier relay position wins the
      // lineage; B keeps its file and reviews both complete texts in a conflict.
      await sessionB.close({ settle: false });
      await sessionA.close({ settle: false });
      expect(await readFile(join(rootA, path), "utf8")).toBe(textA);
      expect(await readFile(join(rootB, path), "utf8")).toBe(textB);
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);
      expect(await daemonB.capture.countOpenConflicts()).toBe(1);
      const { conflicts } = await daemonB.capture.listOpenConflictsPage();
      expect(conflicts).toHaveLength(1);
      const conflict = conflicts[0]!;
      expect(conflict).toMatchObject({
        path,
        status: "open",
        current: { text: textB },
        incoming: { text: textA },
      });
      for (const root of [rootA, rootB]) {
        expect(await readdir(join(root, "notes"))).toEqual(["shared.txt"]);
      }

      await daemonB.capture.resolveConflict(conflict.id, { kind: resolution });
      expect(await readFile(join(rootB, path), "utf8")).toBe(chosen);
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
      await pullAndExpect(daemonA, rootA, path, chosen);
      // Advance B's cursor past its own resolution before reopening editors.
      await pullCaptured(daemonB.relay, daemonB.capture);

      // Reopen both editors to inspect the daemon's chosen CRDT lineage,
      // then prove it accepts edits from either machine without another conflict.
      const afterA = `${chosen}continued on A\n`;
      const finalText = `${afterA}continued on B\n`;
      const arrival = { timeout: REAL_DAEMON_DEADLINE_MS };
      const editorA = await openEditor(daemonA, path);
      const editorB = await openEditor(daemonB, path);
      try {
        expect(shown(editorA)).toBe(chosen);
        expect(shown(editorB)).toBe(chosen);
        expect(editorA.session.lineageClaimId).toMatch(/^[a-f0-9]{64}$/);
        expect(editorB.session.lineageClaimId).toBe(
          editorA.session.lineageClaimId,
        );
        await typeAtEnd(editorA, "continued on A\n");
        expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
        await pullCaptured(daemonB.relay, daemonB.capture);
        await vi.waitFor(() => expect(shown(editorB)).toBe(afterA), arrival);
        await typeAtEnd(editorB, "continued on B\n");
        expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
        await pullCaptured(daemonA.relay, daemonA.capture);
        await vi.waitFor(() => expect(shown(editorA)).toBe(finalText), arrival);
        expect(shown(editorB)).toBe(finalText);
      } finally {
        await editorB.session.close();
        await editorA.session.close();
      }
      for (const [daemon, root] of [
        [daemonA, rootA],
        [daemonB, rootB],
      ] as const) {
        expect(await readFile(join(root, path), "utf8")).toBe(finalText);
        expect(await daemon.capture.countOpenConflicts()).toBe(0);
        expect(await readdir(join(root, "notes"))).toEqual(["shared.txt"]);
      }

      daemonC = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootC,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await pullCaptured(daemonC.relay, daemonC.capture);
      expect(await readFile(join(rootC, path), "utf8")).toBe(finalText);
      expect(await daemonC.capture.countOpenConflicts()).toBe(0);
      expect(await readdir(join(rootC, "notes"))).toEqual(["shared.txt"]);
    } finally {
      await Promise.allSettled([daemonC?.close(), daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);

it.skipIf(engine.missing).each([
  "one device keeps",
  "both keep",
  "keep and incoming",
  "same merged text",
] as const)(
  "kept text resolution without lineage: %s",
  async (scenario) => {
    const workspaceId = `text-keep-${scenario.replaceAll(" ", "-")}`;
    const path = "notes/shared.txt";
    const initial = "Trip destination: undecided\n";
    const textA = "Trip destination: Manila\n";
    const textB = "Trip destination: Tokyo\n";
    const merged = "Trip destination: together\n";
    const rootA = await createTestScratch("dohc-text-keep-a-");
    const rootB = await createTestScratch("dohc-text-keep-b-");
    const relayRoot = await createTestScratch("dohc-text-keep-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    const connection = { baseUrl: relay.baseUrl, token: `test:${workspaceId}` };
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    const pull = (daemon: LiveDaemonCapture) => daemon.relay.pull(apply => daemon.capture.runRelaySync(apply));
    try {
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
      await daemonA.relay.claim();
      await writeAndCapture(daemonA, rootA, path, initial);
      await pushUntilDrained(daemonA.relay);
      daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      await pull(daemonB);
      expect(await readFile(join(rootB, path), "utf8")).toBe(initial);
      // No editor or sync runs between these independent file saves.
      await writeAndCapture(daemonA, rootA, path, textA);
      await writeAndCapture(daemonB, rootB, path, textB);
      await pushUntilDrained(daemonA.relay);
      await pushUntilDrained(daemonB.relay);
      await pull(daemonA);
      await pull(daemonB);
      const rowsA = (await daemonA.capture.listOpenConflictsPage()).conflicts;
      const rowsB = (await daemonB.capture.listOpenConflictsPage()).conflicts;
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA[0]!.id).toBe(rowsB[0]!.id);
      expect(rowsA[0]).toMatchObject({ current: { text: textA }, incoming: { text: textB } });
      expect(rowsB[0]).toMatchObject({ current: { text: textB }, incoming: { text: textA } });
      const id = rowsA[0]!.id;
      if (scenario === "one device keeps") {
        const modified = (await stat(join(rootB, path))).mtimeMs;
        await daemonB.capture.resolveConflict(id, { kind: "keep-current" });
        expect((await stat(join(rootB, path))).mtimeMs).toBe(modified);
      } else if (scenario === "same merged text") {
        await daemonA.capture.resolveConflict(id, { kind: "apply-merged", text: merged });
        await daemonB.capture.resolveConflict(id, { kind: "apply-merged", text: merged });
      } else {
        await daemonA.capture.resolveConflict(id, { kind: "keep-current" });
        await daemonB.capture.resolveConflict(id, { kind: scenario === "both keep" ? "keep-current" : "apply-incoming" });
      }
      await pushUntilDrained(daemonA.relay);
      await pushUntilDrained(daemonB.relay);
      await pull(daemonA);
      await pull(daemonB);
      if (scenario === "both keep") {
        for (const [daemon, root, current, incoming] of [
          [daemonA, rootA, textA, textB], [daemonB, rootB, textB, textA],
        ] as const) {
          expect(await readFile(join(root, path), "utf8")).toBe(current);
          const rows = (await daemon.capture.listOpenConflictsPage()).conflicts;
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ current: { text: current }, incoming: { text: incoming } });
        }
      } else {
        const chosen = scenario === "one device keeps" ? textB : scenario === "same merged text" ? merged : textA;
        for (const [daemon, root] of [[daemonA, rootA], [daemonB, rootB]] as const) {
          expect(await readFile(join(root, path), "utf8")).toBe(chosen);
          expect(await daemon.capture.countOpenConflicts()).toBe(0);
        }
        await writeAndCapture(daemonA, rootA, path, `${chosen}continued on A\n`);
        await pushUntilDrained(daemonA.relay);
        await pullAndExpect(daemonB, rootB, path, `${chosen}continued on A\n`);
        await writeAndCapture(daemonB, rootB, path, `${chosen}continued on B\n`);
        await pushUntilDrained(daemonB.relay);
        await pullAndExpect(daemonA, rootA, path, `${chosen}continued on B\n`);
        expect(await daemonA.capture.countOpenConflicts()).toBe(0);
        expect(await daemonB.capture.countOpenConflicts()).toBe(0);
      }
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);

it.skipIf(engine.missing)(
  "preserves edits made on A while B reviews a seed conflict and converges without retries",
  async () => {
    const workspaceId = "two-daemon-diverged-seed-review";
    const token = `test:${workspaceId}`;
    const path = "notes/shared.txt";
    const textA = "seed from A\n";
    const textB = "seed from B\n";
    const savedA = `${textA}saved on A during review\n`;
    const unsaved = "unsaved on A during review\n";
    const liveA = `${savedA}${unsaved}`;
    const rootA = await createTestScratch("dohc-diverged-seed-a-");
    const rootB = await createTestScratch("dohc-diverged-seed-b-");
    const relayRoot = await createTestScratch("dohc-diverged-seed-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    const editors: OpenEditor[] = [];
    const pull = (daemon: LiveDaemonCapture) =>
      daemon.relay.pull(apply => daemon.capture.runRelaySync(apply));
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: { baseUrl: relay.baseUrl, token },
        // Explicit settles control this test; the timer exceeds its deadline.
        settleDebounceMs: 120_000,
      });
      await daemonA.relay.claim();
      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      const seedA = await openIndependentPlaintextLineage(daemonA, rootA, path, textA);
      const seedB = await openIndependentPlaintextLineage(daemonB, rootB, path, textB);
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
      await pull(daemonA);
      await pull(daemonB);
      await seedB.close({ settle: false });
      await seedA.close({ settle: false });
      const { conflicts: seedConflicts } = await daemonB.capture.listOpenConflictsPage();
      expect(seedConflicts).toHaveLength(1);
      const seedConflict = seedConflicts[0]!;
      expect(seedConflict).toMatchObject({
        path,
        current: { text: textB },
        incoming: { text: textA },
      });
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);

      // B is still reviewing the old seed. A saves one edit and journals
      // another without settling it, so the disk cannot stand in for its Y.Doc.
      const editingA = await openEditor(daemonA, path);
      editors.push(editingA);
      await typeAtEnd(editingA, "saved on A during review\n");
      const before = Y.encodeStateVector(editingA.doc);
      editingA.doc.getText("plainText").insert(savedA.length, unsaved);
      await editingA.session.applyDecidedLocalUpdate(
        () => Y.encodeStateAsUpdate(editingA.doc, before),
      );
      expect(shown(editingA)).toBe(liveA);
      expect(await readFile(join(rootA, path), "utf8")).toBe(savedA);
      expect(await daemonB.capture.countOpenConflicts()).toBe(1);

      await daemonB.capture.resolveConflict(seedConflict.id, { kind: "keep-current" });
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
      const deferredPull = await pull(daemonA);
      expect(deferredPull.fetched).toBeGreaterThan(0);
      expect(deferredPull.sharingDeclined).toEqual([]);
      expect(deferredPull.conflictsOpened).toBe(0);
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);
      expect(shown(editingA)).toBe(liveA);
      expect(await readFile(join(rootA, path), "utf8")).toBe(savedA);
      // The live lease defers the resolution. Closing settles the draft and
      // releases the lease so the resolution can review the complete local text.
      await editingA.session.close();
      const resolutionPull = await pull(daemonA);
      const { conflicts: reviews } = await daemonA.capture.listOpenConflictsPage();
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        path,
        current: { text: liveA },
        incoming: { text: textB },
      });
      expect(await readFile(join(rootA, path), "utf8")).toBe(liveA);
      const idlePull = await pull(daemonA);
      expect(idlePull).toMatchObject({
        fetched: 0,
        applied: 0,
        conflictsOpened: 0,
        nextCursor: resolutionPull.nextCursor,
        sharingDeclined: [],
      });
      expect((await daemonA.capture.listOpenConflictsPage()).conflicts).toEqual(reviews);

      await daemonA.capture.resolveConflict(reviews[0]!.id, { kind: "keep-current" });
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await pull(daemonB);
      await pull(daemonA);
      expect(await daemonA.capture.countOpenConflicts(), "A after review resolution").toBe(0);
      const { conflicts: peerReviews } = await daemonB.capture.listOpenConflictsPage();
      expect(peerReviews).toHaveLength(1);
      expect(peerReviews[0]).toMatchObject({
        path,
        current: { text: textB },
        incoming: { text: liveA },
      });
      await daemonB.capture.resolveConflict(peerReviews[0]!.id, { kind: "apply-incoming" });
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
      await pull(daemonA);
      await pull(daemonB);
      expect(await daemonB.capture.countOpenConflicts(), "B after review resolution").toBe(0);
      const editorA = await openEditor(daemonA, path);
      editors.push(editorA);
      const editorB = await openEditor(daemonB, path);
      editors.push(editorB);
      expect(shown(editorA)).toBe(liveA);
      expect(shown(editorB)).toBe(liveA);
      expect(editorA.session.lineageClaimId).toMatch(/^[a-f0-9]{64}$/);
      expect(editorB.session.lineageClaimId).toBe(editorA.session.lineageClaimId);
      await typeAtEnd(editorA, "continued on A\n");
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await pull(daemonB);
      const arrival = { timeout: REAL_DAEMON_DEADLINE_MS };
      await vi.waitFor(() => expect(shown(editorB)).toBe(`${liveA}continued on A\n`), arrival);
      await typeAtEnd(editorB, "continued on B\n");
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
      await pull(daemonA);
      const finalText = `${liveA}continued on A\ncontinued on B\n`;
      await vi.waitFor(() => expect(shown(editorA)).toBe(finalText), arrival);
      await editorB.session.close();
      await editorA.session.close();

      // Drain both origins, then demand an empty, stable cursor on each peer.
      // Check durable refusal notices too: refused envelopes can advance cursors.
      for (const daemon of [daemonA, daemonB]) await pushUntilDrained(daemon.relay);
      for (const daemon of [daemonA, daemonB]) await pull(daemon);
      for (const [daemon, root] of [
        [daemonA, rootA],
        [daemonB, rootB],
      ] as const) {
        expect(await readFile(join(root, path), "utf8")).toBe(finalText);
        expect(await daemon.capture.countOpenConflicts()).toBe(0);
        expect(await daemon.refusalNotices()).toEqual({ notices: [] });
        expect(await pushUntilDrained(daemon.relay)).toMatchObject({
          pushed: 0,
          ownerAdmissionPending: [],
          sharingDeclined: [],
        });
        const idle = await pull(daemon);
        expect(idle).toMatchObject({
          fetched: 0, applied: 0, conflictsOpened: 0, sharingDeclined: [],
        });
        expect(await pull(daemon)).toMatchObject({
          fetched: 0, applied: 0, nextCursor: idle.nextCursor, sharingDeclined: [],
        });
      }
    } finally {
      await Promise.allSettled(editors.map((editor) => editor.session.close()));
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);

it.skipIf(engine.missing)(
  "reviews and settles concurrent offline edits between two real daemons",
  async () => {
    const workspaceId = "two-daemon-offline-conflict";
    const token = `test:${workspaceId}`;
    const path = "notes/offline.md";
    const rootA = await createTestScratch("dohc-offline-conflict-a-");
    const rootB = await createTestScratch("dohc-offline-conflict-b-");
    const relayRoot = await createTestScratch("dohc-offline-conflict-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await writeAndCapture(daemonA, rootA, path, "shared base\n");
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);

      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await pullAndExpect(daemonB, rootB, path, "shared base\n", "text");

      await writeAndCapture(daemonA, rootA, path, "edit from A\n");
      await writeAndCapture(daemonB, rootB, path, "edit from B\n");
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);

      await pullCaptured(daemonA.relay, daemonA.capture);
      const conflictPage = await daemonA.capture.listOpenConflictsPage();
      const conflict = conflictPage.conflicts.find((entry) => entry.path === path);
      expect(conflict).toBeDefined();
      expect(conflict?.current.text).toBe("edit from A\n");
      expect(conflict?.incoming.text).toBe("edit from B\n");
      expect(await readFile(join(rootA, path), "utf8")).toBe("edit from A\n");

      await daemonA.capture.resolveConflict(conflict!.id, {
        kind: "apply-incoming",
      });
      expect(await readFile(join(rootA, path), "utf8")).toBe("edit from B\n");
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);

      await pullCaptured(daemonB.relay, daemonB.capture);
      expect(await readFile(join(rootB, path), "utf8")).toBe("edit from B\n");
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);

      await daemonB.close();
      daemonB = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      expect(await readFile(join(rootB, path), "utf8")).toBe("edit from B\n");
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);

it.skipIf(engine.missing)(
  "syncs a captured secret file between two real daemons through one real relay",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-secret-sync",
      path: ".env",
      contents: "TOKEN=two-daemon-secret\n",
      passphrase: "two-daemon protected-files passphrase",
      restart: { contents: "TOKEN=after-restart\n" },
      rejoin: true,
    }),
  90_000,
);

it.skipIf(engine.missing)(
  "preserves binary bytes through a real product join",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-binary-sync",
      path: "assets/payload.bin",
      contents: Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x7f, 0x42]),
      contentKind: "binary",
    }),
  60_000,
);

it.skipIf(engine.missing)(
  "recovers a restored origin through the real relay without losing its local suffix",
  async () => {
    const workspaceId = "two-daemon-origin-recovery";
    const token = `test:${workspaceId}`;
    const rootA = await createTestScratch("dohc-origin-recovery-a-");
    const rootB = await createTestScratch("dohc-origin-recovery-b-");
    const relayRoot = await createTestScratch("dohc-origin-recovery-relay-");
    const backupRoot = await createTestScratch("dohc-origin-recovery-backup-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    const relayConnection = { baseUrl: relay.baseUrl, token };
    const engineDb = join(rootA, SECRET_FILE_STORE_RELATIVE_PATH);
    const backupDb = join(backupRoot, "engine.db");
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await writeAndCapture(daemonA, rootA, "notes/base.md", "base\n");
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await daemonA.close();
      daemonA = null;
      const retainedWal = await readFile(`${engineDb}-wal`);
      expect(retainedWal.byteLength).toBeGreaterThan(0);
      const snapshot = new DatabaseSync(engineDb, { readOnly: true });
      try {
        snapshot.prepare("VACUUM INTO ?").run(backupDb);
      } finally {
        snapshot.close();
      }
      expect(await readFile(`${engineDb}-wal`)).toEqual(retainedWal);

      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });
      await writeAndCapture(
        daemonA,
        rootA,
        "notes/relay-ahead.md",
        "relay is ahead of the backup\n",
      );
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await daemonA.close();
      daemonA = null;

      await copyFile(backupDb, engineDb);
      await rm(`${engineDb}-wal`, { force: true });
      await rm(`${engineDb}-shm`, { force: true });
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });
      await writeAndCapture(
        daemonA,
        rootA,
        "notes/local-after-restore.md",
        "local work after restore\n",
      );

      const sync = createRelaySyncEngine({
        rootDir: rootA,
        relay: relayConnection,
        operations: daemonA.relay,
        capture: daemonA.capture,
        onChange: () => undefined,
        debounceMs: 0,
      });
      await sync.start();
      expect(sync.snapshot().lastSyncedAtMs).not.toBeNull();
      await sync.stop();

      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: relayConnection,
      });
      await pullAndExpect(
        daemonB,
        rootB,
        "notes/local-after-restore.md",
        "local work after restore\n",
      );
      expect(await readFile(join(rootB, "notes/relay-ahead.md"), "utf8")).toBe(
        "relay is ahead of the backup\n",
      );
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);

interface OpenEditor {
  session: Awaited<ReturnType<WorkspaceEngineCapture["openYDocSession"]>>;
  // What the renderer holds: the opening state plus every remote update.
  doc: Y.Doc;
}

it.skipIf(engine.missing)("keeps a journaled sharing-declined lineage private and wakes again for a shareable edit", async () => {
  const workspaceId = "watched-withheld", token = `test:${workspaceId}`;
  const root = await createTestScratch("dohc-watched-withheld-");
  const relayRoot = await createTestScratch("dohc-watched-withheld-relay-");
  const dbPath = join(relayRoot, "relay", "relay.sqlite"), path = "withheld.txt";
  const relay = await spawnSyncRelay({dbPath, compiledMain: compiledRelayMain});
  const connection = {baseUrl: relay.baseUrl, token};
  const source = await openLiveDaemonWorkspace({workspaceId, rootPath: root}, {maxRestarts: 0});
  const capture = createWorkspaceEngineCapture({...source.workspace, rustEngineSessions: source.sessions});
  const operations = source.relay.bind({...source.workspace, relay: connection});
  let withheld: Awaited<ReturnType<typeof openEngineYdocProviderSession>> | undefined;
  let editor: OpenEditor | undefined, sync: CloudSyncEngine | undefined;
  const doc = new Y.Doc();
  try {
    // Configure the relay binding before opening document sessions.
    await operations.probe().catch(error => {
      // The test relay has no workspace until claim. The request still pins
      // the transport, avoiding a workspace rebind under the provider lease.
      expect(error).toMatchObject({wireCode: "RELAY_INVALID_RESPONSE"});
    });
    await writeFile(join(root, "public.txt"), "shared base\n");
    capture.observeFileEvents([{path: "public.txt", operation: "update"}]); await capture.flush();
    const versionId = (await capture.listVersions()).versions.find(version => version.kind === "main")!.id;
    withheld = await source.sessions.run(source.workspace, ({workspace}) => openEngineYdocProviderSession({
      transport: source.nativeClient(), workspace, versionId, path, contentKind: "plaintext", seedAbsentLineage: true,
      onRemoteUpdate: () => {}, scheduleSettle: () => () => {},
    }));
    Y.applyUpdate(doc, withheld.initialUpdate);
    let appendIndex = 0, claim = withheld.lineageClaimId ?? null;
    const append = async (text: string) => {
      const vector = Y.encodeStateVector(doc), body = doc.getText("plainText");
      body.insert(body.length, text);
      // The large-base fixture bypasses the client's size-sensitive base64
      // validator, while retaining the real daemon journal and push policy.
      const result = await source.sessions.run(source.workspace, ({workspace}) =>
        new WorkspaceDaemonRequester(source.nativeClient()).request("ydoc.recordUpdate", {
          sessionId: withheld!.nativeOwner!.sessionId,
          updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64"),
          expectedLineageClaimId: claim,
        }, {workspace, idempotencyKey: `withheld-${appendIndex++}`})) as {seq: number; lineageClaimId: string | null};
      expect(result).toHaveProperty("seq");
      claim = result.lineageClaimId;
    };
    // Three legal deltas make a base larger than MAX_YDOC_UPDATE_BYTES (20 MiB).
    // They are durable in the local Y.Doc journal before this workspace enrolls.
    for (let index = 0; index < 3; index++) await append(`WITHHELD-PRIVATE-${index}` + "x".repeat(7 * 1024 * 1024));
    // Enrollment defers live leases. Release this one without projecting its
    // oversized body so the real sync policy evaluates and declines the base.
    await withheld.evict();
    const local = new DatabaseSync(join(root, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
    const privateDigests = () => local.prepare("SELECT update_blob_sha256 AS sha FROM ydoc_updates WHERE workspace_id=? AND object_id=? AND is_seed=0").all(workspaceId, withheld!.objectId!) as Array<{sha: string}>;
    try {
      expect(privateDigests().length).toBeGreaterThanOrEqual(3);
      let report!: (value: {hasMore: boolean; watched: boolean}) => void;
      const pushes: Array<{pushed: number}> = [];
      const subscribe = vi.spyOn(capture, "onDurableLocalChange");
      sync = createRelaySyncEngine({rootDir: root, relay: connection, capture, onChange: () => {},
        operations: {...operations, push: async () => {const result = await operations.push(); pushes.push(result); return result;}},
        waitForChange: (_since, signal) => new Promise((resolve, reject) => {
          report = resolve; signal.addEventListener("abort", () => reject(signal.reason), {once: true});
        })});
      await sync.start();
      expect(sync.snapshot().syncFailure).toBeNull();
      const marker = local.prepare("SELECT file_export_lane,sharing_declined_json FROM ydoc_docs WHERE workspace_id=? AND object_id=?").get(workspaceId, withheld.objectId!) as {file_export_lane: number; sharing_declined_json: string};
      expect(marker.file_export_lane).toBe(1);
      expect(JSON.parse(marker.sharing_declined_json)).toMatchObject({constraint: "MAX_YDOC_UPDATE_BYTES"});
      await vi.waitFor(() => expect(report).toBeTypeOf("function")); report({hasMore: false, watched: true});
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
      const before = pushes.length;
      sync.queueWatchedUpload();
      await vi.waitFor(() => expect(pushes.length).toBeGreaterThan(before));
      expect(pushes.at(-1)!.pushed).toBe(0);
      const afterEmpty = pushes.length;
      // Use the real workspace durable hook for the next, shareable lineage.
      editor = await openEditor({capture}, "public.txt");
      const vector = Y.encodeStateVector(editor.doc); editor.doc.getText("plainText").insert(0, "public edit ");
      await editor.session.applyDecidedLocalUpdate(() => Y.encodeStateAsUpdate(editor!.doc, vector));
      await vi.waitFor(() => expect(pushes.slice(afterEmpty).some(result => result.pushed > 0)).toBe(true));
      const remote = new DatabaseSync(dbPath, {readOnly: true});
      try {
        const rows = remote.prepare("SELECT payload_json FROM sync_relay_log WHERE workspace_id=?").all(workspaceId);
        expect(JSON.stringify(rows)).not.toContain(path);
        expect(JSON.stringify(rows)).not.toContain("WITHHELD-PRIVATE");
      } finally {remote.close();}
      for (const {sha} of privateDigests()) {
        const response = await fetch(`${relay.baseUrl}/blobs/${sha}`, {headers: {Authorization: `Bearer ${token}`}});
        expect(response.status).toBe(404);
        await response.body?.cancel();
      }
    } finally {local.close();}
  } finally {
    try {
      await sync?.stop();
      await Promise.allSettled([withheld?.evict(), editor?.session.close({settle: false})]);
      editor?.doc.destroy(); doc.destroy();
      await capture.stop();
    } finally {await source.close(); await relay.stop();}
  }
}, 120_000);

it.skipIf(engine.missing)("watched scheduling preserves the exact relay op sequence and keeps private paths out", async () => {
  const workspaceId = "watched-op-sequence", token = `test:${workspaceId}`;
  const root = await createTestScratch("dohc-watched-ops-");
  const relayRoot = await createTestScratch("dohc-watched-relay-");
  const snapshot = await createTestScratch("dohc-watched-snapshot-");
  const dbPath = join(relayRoot, "relay", "relay.sqlite");
  let relay = await spawnSyncRelay({dbPath, compiledMain: compiledRelayMain});
  let owner: LiveDaemonCapture | null = null;
  let sync: CloudSyncEngine | undefined;
  let editor: OpenEditor | undefined;
  try {
    owner = await openLiveDaemonCapture({workspaceId, rootPath: root, relay: {baseUrl: relay.baseUrl, token}});
    await owner.relay.claim();
    await owner.chats.ensureGeneralChannel({workspaceId}); await pushUntilDrained(owner.relay);
    await writeAndCapture(owner, root, "note.txt", "saved base\n");
    const seededEditor = await openEditor(owner, "note.txt");
    await seededEditor.session.settleNow(); await seededEditor.session.close({settle: false}); seededEditor.doc.destroy();
    await mkdir(join(root, "node_modules"), {recursive: true});
    await writeFile(join(root, "node_modules/private.txt"), "excluded-private-content");
    await writeFile(join(root, "node_modules/private.env"), "TOKEN=never-visible-in-log\n");
    owner.capture.observeFileEvents([
      {path: "node_modules/private.txt", operation: "update"},
      {path: "node_modules/private.env", operation: "update"},
    ]);
    await owner.capture.flush(); await pushUntilDrained(owner.relay);
    await owner.close(); owner = null; await relay.stop();
    const initialLog = new DatabaseSync(dbPath, {readOnly: true});
    const initialUpdates = (initialLog.prepare("SELECT COUNT(*) AS count FROM sync_relay_log WHERE workspace_id = ? AND op_kind = 'ydoc.update'").get(workspaceId) as {count: number}).count;
    initialLog.close();
    await cp(root, join(snapshot, "owner"), {recursive: true});
    await cp(relayRoot, join(snapshot, "relay"), {recursive: true});
    const sequences: unknown[][] = [];
    for (const watched of [false, true]) {
      // Reuse the same durable journal, identity, lineage and initial Y.Doc bytes.
      await cp(join(snapshot, "owner"), root, {recursive: true, force: true});
      await cp(join(snapshot, "relay"), relayRoot, {recursive: true, force: true});
      relay = await spawnSyncRelay({dbPath, compiledMain: compiledRelayMain});
      const connection = {baseUrl: relay.baseUrl, token};
      owner = await openLiveDaemonCapture({workspaceId, rootPath: root, relay: connection, settleDebounceMs: 60_000});
      editor = await openEditor(owner, "note.txt"); editor.doc.clientID = 777;
      const accepted: number[] = [];
      const operations = owner.relay;
      let report!: (value: {hasMore: boolean; watched: boolean}) => void;
      sync = createRelaySyncEngine({rootDir: root, relay: connection, capture: owner.capture, onChange: () => {},
        operations: {...operations, push: async () => {const result = await operations.push(); accepted.push(result.pushed); return result;}},
        // The real registry/held-read transition is covered by the held-read suites.
        // Hold the injected watch steady here to compare only upload scheduling.
        waitForChange: (_since, signal) => new Promise((resolve, reject) => {
          report = resolve; signal.addEventListener("abort", () => reject(signal.reason), {once: true});
        })});
      await sync.start();
      await vi.waitFor(() => expect(report).toBeTypeOf("function"));
      report({hasMore: false, watched});
      const observing = deferred<void>();
      const detach = owner.capture.onDurableLocalChange(() => observing.resolve());
      const before = accepted.length;
      for (let index = 0; index < 30; index += 1) {
        const vector = Y.encodeStateVector(editor.doc);
        editor.doc.getText("plainText").insert(editor.doc.getText("plainText").length, String.fromCharCode(97 + index % 26));
        await editor.session.applyDecidedLocalUpdate(() => Y.encodeStateAsUpdate(editor!.doc, vector));
      }
      await observing.promise; detach();
      if (watched) await vi.waitFor(() => expect(accepted.slice(before).some(count => count > 0)).toBe(true));
      else expect(accepted.length).toBe(before);
      await sync.stop(); sync = undefined;
      await pushUntilDrained(owner.relay);
      const database = new DatabaseSync(dbPath, {readOnly: true});
      try {
        const rows = database.prepare("SELECT origin_seq, op_kind, payload_json FROM sync_relay_log WHERE workspace_id = ? ORDER BY origin_seq").all(workspaceId) as Array<{origin_seq: number; op_kind: string; payload_json: string}>;
        expect(rows.filter(row => row.op_kind === "ydoc.update")).toHaveLength(initialUpdates + 30);
        for (let index = 1; index < rows.length; index += 1) expect(rows[index]!.origin_seq).toBe(rows[index - 1]!.origin_seq + 1);
        for (const row of rows) {
          expect(row.payload_json).not.toContain("node_modules/private.txt");
          expect(row.payload_json).not.toContain("excluded-private-content");
          expect(row.payload_json).not.toContain("never-visible-in-log");
          expect(row.payload_json).not.toContain("node_modules/private.env");
        }
        sequences.push(rows.map(row => [row.origin_seq, row.op_kind, createHash("sha256").update(stableJsonStringify(JSON.parse(row.payload_json))).digest("hex")]));
      } finally {database.close();}
      await editor.session.close({settle: false}); editor.doc.destroy(); editor = undefined;
      await owner.close(); owner = null; await relay.stop();
    }
    expect(sequences[1]).toEqual(sequences[0]);
  } finally {
    await sync?.stop(); await editor?.session.close({settle: false}); editor?.doc.destroy();
    await owner?.close(); await relay.stop();
  }
}, 120_000);

it.skipIf(engine.missing).each([false, true])(
  "imports a covered artifact without blocking an open editor (peer typed first: %s)",
  async (peerTypedFirst) => {
    const workspaceId = `two-daemon-covered-artifact-${peerTypedFirst}`;
    const token = `test:${workspaceId}`;
    const path = "notes/shared.txt";
    const seed = "saved before artifact export\n";
    const rootA = await createTestScratch("dohc-covered-artifact-a-");
    const rootB = await createTestScratch("dohc-covered-artifact-b-");
    const relayRoot = await createTestScratch("dohc-covered-artifact-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      const connection = { baseUrl: relay.baseUrl, token };
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
      await daemonA.relay.claim();
      const sourceSession = await openIndependentPlaintextLineage(daemonA, rootA, path, seed);
      const sourceMoment = (await daemonA.capture.listMoments({ limit: 100 })).moments.find((moment) => moment.path === path)!;
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      await pullAndExpect(daemonB, rootB, path, seed);
      const peerEditor = await openEditor(daemonB, path);
      try {
        if (peerTypedFirst) await typeAtEnd(peerEditor, "peer before artifact\n");
        await sourceSession.close({ settle: false });
        await pullCaptured(daemonA.relay, daemonA.capture);
        const sourceEditor = await openEditor(daemonA, path);
        try {
          await typeAtEnd(sourceEditor, "origin after artifact\n");
          expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
          await pullCaptured(daemonB.relay, daemonB.capture);
          await vi.waitFor(() => expect(shown(peerEditor)).toContain("origin after artifact\n"), {
            timeout: REAL_DAEMON_DEADLINE_MS,
          });
          if (peerTypedFirst) expect(shown(peerEditor)).toContain("peer before artifact\n");
          expect((await daemonB.capture.listMoments({ limit: 100 })).moments.filter((moment) => moment.id === sourceMoment.id)).toHaveLength(1);
          await typeAtEnd(peerEditor, "peer after artifact\n");
          expect(await daemonB.capture.countOpenConflicts()).toBe(0);
        } finally {
          await sourceEditor.session.close();
        }
      } finally {
        await peerEditor.session.close();
      }
      await pullCaptured(daemonB.relay, daemonB.capture);
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);
      expect(await readFile(join(rootB, path), "utf8")).toContain("peer after artifact\n");
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);

async function openEditor(daemon: Pick<LiveDaemonCapture, "capture">, path: string): Promise<OpenEditor> {
  const doc = new Y.Doc();
  const session = await daemon.capture.openYDocSession({
    path,
    contentKind: "plaintext",
    onRemoteUpdate: (update) => Y.applyUpdate(doc, update),
  });
  Y.applyUpdate(doc, session.initialUpdate);
  return { session, doc };
}

// H2b: B keeps the deletion. H2c: B keeps its copy and types again, and A takes
// both up with no choice. H2d: B edits the file by hand, and A keeps B's copy
// while B's conflict is still open.
it.skipIf(engine.missing).each(["H2b", "H2c", "H2d"] as const)(
  "settles a synced deletion in fresh %s and keeps notes syncing both ways",
  async scenario => {
    const workspaceId = `deletion-revival-${scenario}`;
    const path = "trip.txt";
    const rootA = await createTestScratch("dohc-guard-a-");
    const rootB = await createTestScratch("dohc-guard-b-");
    const relayRoot = await createTestScratch("dohc-guard-relay-");
    const relay = await spawnSyncRelay({dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain});
    const connection = {baseUrl: relay.baseUrl, token: `test:${workspaceId}`};
    let a: LiveDaemonCapture | null = null;
    let b: LiveDaemonCapture | null = null;
    const pull = (device: LiveDaemonCapture) => device.relay.pull(apply => device.capture.runRelaySync(apply));
    const rounds = async () => {
      for (let i = 0; i < 3; i++) {
        await pushUntilDrained(a!.relay);
        await pushUntilDrained(b!.relay);
        await pull(a!);
        await pull(b!);
      }
    };
    const keepOtherCopyOnA = async () => {
      const reviewA = (await a!.capture.listOpenConflictsPage()).conflicts.find(row => row.path === path)!;
      expect(reviewA).toMatchObject({current: {exists: false}, incoming: {exists: true, text: "Paris\nTokyo\n"}});
      await a!.capture.resolveConflict(reviewA.id, {kind: "apply-incoming"});
      await rounds();
      expect(await readFile(join(rootA, path), "utf8")).toBe("Paris\nTokyo\n");
      for (const device of [a!, b!]) expect(await device.capture.countOpenConflicts()).toBe(0);
    };
    try {
      a = await openLiveDaemonCapture({workspaceId, rootPath: rootA, relay: connection});
      await a.relay.claim();
      await writeAndCapture(a, rootA, path, "Paris\n");
      await writeAndCapture(a, rootA, "packing.md", "Packing: initial\n");
      await writeAndCapture(a, rootA, "budget.md", "Budget: initial\n");
      await pushUntilDrained(a.relay);
      b = await openJoinedDaemonCapture({workspaceId, rootPath: rootB, relay: connection});
      await rounds();
      expect(await readFile(join(rootB, "packing.md"), "utf8")).toBe("Packing: initial\n");
      expect(await readFile(join(rootB, "budget.md"), "utf8")).toBe("Budget: initial\n");
      for (const device of [b, a]) {
        const editor = await openEditor(device, path);
        await editor.session.close();
        await rounds();
      }
      // Both devices have opened the same exact editor lineage before going offline.
      const lineages = new Set<string>();
      for (const device of [a, b]) {
        const editor = await openEditor(device, path);
        expect(shown(editor)).toBe("Paris\n");
        expect(editor.session.lineageClaimId).toMatch(/^[a-f0-9]{64}$/);
        lineages.add(editor.session.lineageClaimId!);
        await editor.session.close();
      }
      expect(lineages.size).toBe(1);
      const beforeDelete = (await a.capture.listMoments({limit: 100})).moments.filter(row => row.path === path).length;
      await rm(join(rootA, path));
      a.capture.observeFileEvents([{path, operation: "delete"}]);
      const deletionMoments = await waitForPathMoments(a.capture, path, beforeDelete + 1);
      expect(deletionMoments.some(row => row.operation === "delete")).toBe(true);
      if (scenario === "H2d") {
        // A conflict opens on A only for a file change. An editor change waits there.
        await writeAndCapture(b, rootB, path, "Paris\nTokyo\n");
      } else {
        const editor = await openEditor(b, path);
        try { await typeAtEnd(editor, "Tokyo\n"); }
        finally { await editor.session.close(); }
      }
      expect(await readFile(join(rootB, path), "utf8")).toBe("Paris\nTokyo\n");
      await rounds();
      const reviewB = (await b.capture.listOpenConflictsPage()).conflicts.find(row => row.path === path)!;
      expect(reviewB).toMatchObject({current: {exists: true, text: "Paris\nTokyo\n"}, incoming: {exists: false}});
      let kept = "Paris\nTokyo\n";
      if (scenario === "H2d") {
        await keepOtherCopyOnA();
      } else {
        await b.capture.resolveConflict(reviewB.id, {kind: scenario === "H2b" ? "apply-incoming" : "keep-current"});
        if (scenario === "H2c") {
          const editorB = await openEditor(b, path);
          try { await typeAtEnd(editorB, "Rome\n"); }
          finally { await editorB.session.close(); }
          kept += "Rome\n";
        }
        await rounds();
      }
      if (scenario === "H2b") {
        const deleted = (await b.capture.listMoments({limit: 100})).moments.find(row => row.path === path && row.operation === "delete")!;
        expect(deleted).toBeDefined();
        await expect(b.capture.restoreFileToBeforeMoment(deleted.id, {kind: "human", humanId: "guard-person"}))
          .rejects.toMatchObject({name: "SyncedDeletionRevivalError"});
        await expect(readFile(join(rootB, path))).rejects.toMatchObject({code: "ENOENT"});
        await expect(readFile(join(rootA, path))).rejects.toMatchObject({code: "ENOENT"});
      } else if (scenario === "H2c") {
        expect(await readFile(join(rootA, path), "utf8")).toBe(kept);
        for (const device of [a, b]) expect(await device.capture.countOpenConflicts()).toBe(0);
      }
      await writeAndCapture(b, rootB, "packing.md", "Packing: B later\n");
      await writeAndCapture(a, rootA, "budget.md", "Budget: A later\n");
      await rounds();
      expect(await readFile(join(rootA, "packing.md"), "utf8")).toBe("Packing: B later\n");
      expect(await readFile(join(rootB, "budget.md"), "utf8")).toBe("Budget: A later\n");
      if (scenario !== "H2b") {
        let expected = kept;
        for (const [writer, writerRoot, readerRoot, line] of [[a, rootA, rootB, "A by hand\n"], [b, rootB, rootA, "B by hand\n"]] as const) {
          expected += line;
          await writeAndCapture(writer, writerRoot, path, expected);
          await rounds();
          expect(await readFile(join(readerRoot, path), "utf8")).toBe(expected);
        }
        // Both editors stay open, so each machine must see the other's live edits.
        const editorA = await openEditor(a, path);
        const editorB = await openEditor(b, path);
        try {
          expect(shown(editorA)).toBe(expected);
          expect(shown(editorB)).toBe(expected);
          expect(editorA.session.lineageClaimId).toBe(editorB.session.lineageClaimId);
          await typeAtEnd(editorA, "A live\n");
          await rounds();
          await vi.waitFor(() => expect(shown(editorB)).toBe(`${expected}A live\n`), {timeout: REAL_DAEMON_DEADLINE_MS});
          await typeAtEnd(editorB, "B live\n");
          await rounds();
          await vi.waitFor(() => expect(shown(editorA)).toBe(`${expected}A live\nB live\n`), {timeout: REAL_DAEMON_DEADLINE_MS});
        } finally {
          await Promise.allSettled([editorA.session.close(), editorB.session.close()]);
        }
        await rounds();
        expected += "A live\nB live\n";
        expect(await readFile(join(rootA, path), "utf8")).toBe(expected);
        expect(await readFile(join(rootB, path), "utf8")).toBe(expected);
        for (const device of [a, b]) expect(await device.capture.countOpenConflicts()).toBe(0);
      }
      expect(await pull(a)).toMatchObject({fetched: 0});
      expect(await pull(b)).toMatchObject({fetched: 0});
    } finally {
      await Promise.allSettled([b?.close(), a?.close()]);
      await relay.stop();
    }
  }, 150_000,
);

it.skipIf(engine.missing)(
  "settles a synced deletion both machines keep with either choice on the both-removed review, then copies its text out of History",
  async () => {
    for (const choice of ["keep-current", "apply-incoming"] as const) {
      const workspaceId = `deletion-both-kept-${choice}`;
      const path = "trip.txt";
      const copyPath = "trip copy.txt";
      const aRemovedAgainstBEdit = {path, current: {exists: false}, incoming: {exists: true, text: "Paris\nTokyo\n"}};
      const bEditedAgainstARemoval = {path, current: {exists: true, text: "Paris\nTokyo\n"}, incoming: {exists: false}};
      const aBothDeletedReview = {path, current: {exists: false}, incoming: {exists: false}};
      const rootA = await createTestScratch("dohc-guard-a-");
      const rootB = await createTestScratch("dohc-guard-b-");
      const relayRoot = await createTestScratch("dohc-guard-relay-");
      const relay = await spawnSyncRelay({dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain});
      const connection = {baseUrl: relay.baseUrl, token: `test:${workspaceId}`};
      let a: LiveDaemonCapture | null = null;
      let b: LiveDaemonCapture | null = null;
      const pull = (device: LiveDaemonCapture) => device.relay.pull(apply => device.capture.runRelaySync(apply));
      type ExpectedRow = {path: string; current: {exists: boolean}; incoming: {exists: boolean}};
      const rounds = async (expectedA: ExpectedRow[] = [], expectedB: ExpectedRow[] = []) => {
        for (let i = 0; i < 3; i++) {
          await pushUntilDrained(a!.relay);
          await pushUntilDrained(b!.relay);
          await pull(a!);
          await pull(b!);
          expect(await a!.refusalNotices()).toEqual({notices: []});
          expect(await b!.refusalNotices()).toEqual({notices: []});
          for (const [machine, device, expected] of [["A", a!, expectedA], ["B", b!, expectedB]] as const) {
            const page = await device.capture.listOpenConflictsPage();
            expect(page.conflicts, `${machine}: only the expected conflict rows after round ${i + 1}`).toMatchObject(expected);
            expect(page.nextAfterConflictId).toBeNull();
          }
        }
      };
      try {
        a = await openLiveDaemonCapture({workspaceId, rootPath: rootA, relay: connection});
        await a.relay.claim();
        await writeAndCapture(a, rootA, path, "Paris\n");
        await writeAndCapture(a, rootA, "packing.md", "Packing: initial\n");
        await writeAndCapture(a, rootA, "budget.md", "Budget: initial\n");
        await pushUntilDrained(a.relay);
        b = await openJoinedDaemonCapture({workspaceId, rootPath: rootB, relay: connection});
        await rounds();
        expect(await readFile(join(rootB, "packing.md"), "utf8")).toBe("Packing: initial\n");
        expect(await readFile(join(rootB, "budget.md"), "utf8")).toBe("Budget: initial\n");
        for (const device of [b, a]) {
          const editor = await openEditor(device, path);
          await editor.session.close();
          await rounds();
        }
        // Both devices have opened the same exact editor lineage before going offline.
        const lineages = new Set<string>();
        for (const device of [a, b]) {
          const editor = await openEditor(device, path);
          expect(shown(editor)).toBe("Paris\n");
          expect(editor.session.lineageClaimId).toMatch(/^[a-f0-9]{64}$/);
          lineages.add(editor.session.lineageClaimId!);
          await editor.session.close();
        }
        expect(lineages.size).toBe(1);
        const beforeDelete = (await a.capture.listMoments({limit: 100})).moments.filter(row => row.path === path).length;
        await rm(join(rootA, path));
        a.capture.observeFileEvents([{path, operation: "delete"}]);
        const deletionMoments = await waitForPathMoments(a.capture, path, beforeDelete + 1);
        expect(deletionMoments.some(row => row.operation === "delete")).toBe(true);
        // B changes the file by hand, so both machines review. An editor change would wait on A and open none there.
        await writeAndCapture(b, rootB, path, "Paris\nTokyo\n");
        await rounds([aRemovedAgainstBEdit], [bEditedAgainstARemoval]);
        // Both keep the removal before either hears the other's choice.
        const reviewA = (await a.capture.listOpenConflictsPage()).conflicts.find(row => row.path === path)!;
        const reviewB = (await b.capture.listOpenConflictsPage()).conflicts.find(row => row.path === path)!;
        await a.capture.resolveConflict(reviewA.id, {kind: "keep-current"});
        await b.capture.resolveConflict(reviewB.id, {kind: "apply-incoming"});
        await rounds([aBothDeletedReview]);
        const absentA = (await a.capture.listOpenConflictsPage()).conflicts.find(row => row.path === path)!;
        await a.capture.resolveConflict(absentA.id, {kind: choice});
        await rounds();
        // History Restore stays refused, so B copies its text out of History into a new file.
        const removal = (await b.capture.listMoments({limit: 100})).moments.find(row => row.path === path && row.operation === "delete")!;
        await expect(b.capture.restoreFileToBeforeMoment(removal.id, {kind: "human", humanId: "guard-person"}))
          .rejects.toMatchObject({name: "SyncedDeletionRevivalError"});
        let copied: string | null = null;
        const history = (await b.capture.listMoments({limit: 100})).moments.filter(row => row.path === path);
        for (const row of history) {
          const detail = await b.capture.readMoment(row.id);
          if (!detail || detail.protected) continue;
          const ipcMoment = engineMomentDetailForIpc(detail, {
            agent: () => undefined, person: () => undefined, automation: () => null,
            named: author => author.userId, presentations: () => [],
          });
          if (ipcMoment.afterText === "Paris\nTokyo\n") {
            copied = ipcMoment.afterText;
            break;
          }
        }
        expect(copied, "B's History still exposes its text through readEngineMoment after the removal").toBe("Paris\nTokyo\n");
        if (copied === null) throw new Error("B's text is missing from its History after the removal");
        await writeAndCapture(b, rootB, copyPath, copied);
        await rounds();
        expect(await readFile(join(rootA, copyPath), "utf8")).toBe(copied);
        for (const [device, text] of [[b, "B later\n"], [a, "A later\n"]] as const) {
          const editor = await openEditor(device, copyPath);
          try { await typeAtEnd(editor, text); }
          finally { await editor.session.close(); }
          await rounds();
          for (const otherRoot of [rootA, rootB]) {
            expect(await readFile(join(otherRoot, copyPath), "utf8")).toContain(text);
          }
        }
        await writeAndCapture(b, rootB, "packing.md", "Packing: B later\n");
        await writeAndCapture(a, rootA, "budget.md", "Budget: A later\n");
        await rounds();
        expect(await readFile(join(rootA, "packing.md"), "utf8")).toBe("Packing: B later\n");
        expect(await readFile(join(rootB, "budget.md"), "utf8")).toBe("Budget: A later\n");
        for (const [device, root] of [[a, rootA], [b, rootB]] as const) {
          expect((await device.capture.listOpenConflictsPage()).conflicts).toEqual([]);
          expect(await device.capture.countOpenConflicts()).toBe(0);
          expect(await readFile(join(root, copyPath), "utf8")).toBe(`${copied}B later\nA later\n`);
          await expect(readFile(join(root, path))).rejects.toMatchObject({code: "ENOENT"});
        }
        expect(await pull(a)).toMatchObject({fetched: 0});
        expect(await pull(b)).toMatchObject({fetched: 0});
      } finally {
        await Promise.allSettled([b?.close(), a?.close()]);
        await relay.stop();
      }
    }
  }, 180_000,
);

async function typeAtEnd(editor: OpenEditor, text: string): Promise<void> {
  const typed = editor.doc.getText("plainText");
  const before = Y.encodeStateVector(editor.doc);
  typed.insert(typed.length, text);
  void editor.session.applyLocalUpdate(Y.encodeStateAsUpdate(editor.doc, before));
  await editor.session.settleNow();
}

function shown(editor: OpenEditor): string {
  return editor.doc.getText("plainText").toString();
}

it.skipIf(engine.missing)(
  "shows each device's edit in the other device's idle open editor",
  async () => {
    const workspaceId = "two-daemon-idle-editors";
    const token = `test:${workspaceId}`;
    const path = "notes/shared.txt";
    const rootA = await createTestScratch("dohc-idle-editor-a-");
    const rootB = await createTestScratch("dohc-idle-editor-b-");
    const relayRoot = await createTestScratch("dohc-idle-editor-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    const relayConnection = { baseUrl: relay.baseUrl, token };
    // Generous against one push, one held read's answer, one pull, and one
    // resync on a loaded machine.
    const arrival = { timeout: 60_000, interval: 100 };
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    const engines: CloudSyncEngine[] = [];
    const editors: OpenEditor[] = [];
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });

      // A opens the document before enrollment. Sync must claim it and send
      // those bytes on its own continuation timer, without another edit.
      await daemonA.relay.claim();
      await mkdir(join(rootA, "notes"), { recursive: true });
      await writeFile(join(rootA, path), "");
      const editorA = await openEditor(daemonA, path);
      editors.push(editorA);
      await typeAtEnd(editorA, "Starting together.\n");
      const pushes: { pushed: number; hasMore: boolean }[] = [];
      const ownerRelay = daemonA.relay;
      const syncA = createRelaySyncEngine({
        rootDir: rootA,
        relay: relayConnection,
        operations: {
          ...ownerRelay,
          async push() {
            const result = await ownerRelay.push();
            pushes.push(result);
            return result;
          },
        },
        capture: daemonA.capture,
        onChange: () => undefined,
        debounceMs: 0,
        waitForChange: createRelayLogWait({ workspaceId, relay: relayConnection }),
      });
      engines.push(syncA);
      await syncA.start();
      expect(pushes[0]).toMatchObject({ pushed: 0, hasMore: true });
      await vi.waitFor(() => {
        expect(pushes.some(push => push.pushed > 0)).toBe(true);
        expect(pushes.at(-1)?.hasMore).toBe(false);
      }, arrival);

      // B joins, receives the document, and opens it too.
      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: relayConnection,
      });
      await pullCaptured(daemonB.relay, daemonB.capture);
      const editorB = await openEditor(daemonB, path);
      editors.push(editorB);
      expect(shown(editorB)).toBe("Starting together.\n");

      // From here the typing device pushes as the desktop does after a local
      // write, and nothing asks the idle device to pull: it waits on the relay.
      const syncB = createRelaySyncEngine({
        rootDir: rootB,
        relay: relayConnection,
        operations: daemonB.relay,
        capture: daemonB.capture,
        onChange: () => undefined,
        debounceMs: 0,
        waitForChange: createRelayLogWait({ workspaceId, relay: relayConnection }),
      });
      engines.push(syncB);
      await syncB.start();

      // Each device types while the other's editor sits idle, and the idle
      // editor shows the edit without being touched.
      await typeAtEnd(editorA, "Typed on A.\n");
      syncA.queueSync();
      await vi.waitFor(() => expect(shown(editorB)).toContain("Typed on A."), arrival);
      await typeAtEnd(editorB, "Typed on B.\n");
      syncB.queueSync();
      await vi.waitFor(() => expect(shown(editorA)).toContain("Typed on B."), arrival);

      // Both editors and both files hold every line exactly once.
      const merged = shown(editorA);
      for (const line of ["Starting together.", "Typed on A.", "Typed on B."]) {
        expect(merged.split(line).length - 1, line).toBe(1);
      }
      expect(shown(editorB)).toBe(merged);
      await vi.waitFor(async () => {
        expect(await readFile(join(rootA, path), "utf8")).toBe(merged);
        expect(await readFile(join(rootB, path), "utf8")).toBe(merged);
      }, arrival);
    } finally {
      await Promise.allSettled(engines.map((sync) => sync.stop()));
      await Promise.allSettled(editors.map((editor) => editor.session.close()));
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  180_000,
);


it.skipIf(engine.missing)("keeps mixed accepted text for Stop and restore on a second owner with a lease", async () => {
  const workspaceId = "two-daemon-drain-coverage", path = "tasks/one.md";
  const rootA = await createTestScratch("dohc-drain-owner-");
  const rootB = await createTestScratch("dohc-drain-peer-");
  const relayRoot = await createTestScratch("dohc-drain-relay-");
  const relayServer = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
  const relayConnection = { baseUrl: relayServer.baseUrl, token: `test:${workspaceId}` };
  let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
  let capture: WorkspaceEngineCapture | undefined;
  let peer: LiveDaemonCapture | undefined;
  const doc = markdownToYDoc("---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nName: Recipient record\n---\n\nOriginal body.\n");
  const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
  try {
    const profile = selfHostLiveProfile();
    const configPath = join(rootA, "owner-ingress.json");
    await writeFile(configPath, JSON.stringify(profile.nativeIngress));
    owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0,
      privateOwnerHost: { configPath, client: profile.nativeClient }, allowInsecureLoopbackForTests: true });
    const source = owner;
    const relay = source.relay.bind({ ...source.workspace, relay: relayConnection });
    await relay.claim();
    await source.chats.ensureGeneralChannel({ workspaceId });
    await pushUntilDrained(relay);
    const baselineBytes = Y.encodeStateAsUpdate(doc), baseline = yDocToMarkdown(doc);
    const binding = { workspaceId, mainVersionId: "main", objectId: "record-one", currentPath: path,
      lineageClaimId: hash(baselineBytes), selectorPaths: ["tasks"], restoreFenceGeneration: 0 };
    const client = source.nativeClient();
    let id = 1000;
    const { handle, registrationId } = await source.sessions.run(source.workspace, async ({ workspace }) => {
      const request = (method: string, params: Record<string, unknown>) => client.sendRequest({ id: ++id, method,
        workspace, params: params as Parameters<typeof client.sendRequest>[0]["params"], deadlineMs: REAL_DAEMON_DEADLINE_MS });
      await request("versions.ensureMain", { workspaceId });
      const files = new VersionedLiveAdapter(client, workspace, { workspaceId });
      await files.writeTextFile({ workspaceId, versionId: "main", path: "tasks/collection.yaml",
        text: "fields:\n  Name: {type: text}\n  OwnerNote: {type: text}\n", publish: true, metadata: { origin: "api" } });
      await request("liveApplication.provisionOwner", { relayNamespace: "drain-relay", host: {
        hostId: "owner-A", hostEpoch: 1, instanceId: "instance", connectionId: "connection" } });
      const registered = await request("liveApplication.register", { binding });
      return { handle: workspace, registrationId: (registered.result as { registrationId: number }).registrationId };
    });
    const bootstrapped = await client.sendLiveBootstrap({ id: ++id, workspace: handle, registrationId, deadlineMs: REAL_DAEMON_DEADLINE_MS }, {
      bootstrapId: "recipient-baseline", bootstrapMomentId: "recipient-baseline-moment", baselineMomentRelaySequence: 1,
      baselineRegisteredAtMs: 100, baselineDigest: binding.lineageClaimId, projectedMarkdownDigest: hash(baseline),
      projectedMarkdownByteLength: Buffer.byteLength(baseline), baselineBytes,
    });
    expect(bootstrapped.result).toMatchObject({ status: "bootstrapped" });
    capture = createWorkspaceEngineCapture({ ...source.workspace, rustEngineSessions: source.sessions, settleDebounceMs: 60_000 });
    await writeFile(join(rootA, path), baseline);
    const hosted = await capture.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
    await hosted.settleNow();
    await pushUntilDrained(relay);
    peer = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: relayConnection, holdEditorResync: true });
    await pullCaptured(peer.relay, peer.capture);
    const lease = await peer.capture.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
    expect(lease.objectId).toBe(binding.objectId);
    expect(lease.lineageClaimId).toBe(binding.lineageClaimId);
    await lease.settleNow();
    try {
      for (const [cursor, field, value, recipient] of [[1, "OwnerNote", "Owner text", false], [2, "Name", "Recipient text", true]] as const) {
        const vector = Y.encodeStateVector(doc);
        patchFrontmatter(doc, new Map([[field, value]]));
        const updateBytes = Y.encodeStateAsUpdate(doc, vector);
        const receipt = { deliveryId: `delivery-${cursor}`, updateDigest: hash(updateBytes), journalCursor: cursor, acceptingHostEpoch: parseHostEpoch(1) };
        const applied = await client.sendLiveApplication({ id: ++id, workspace: handle, registrationId, deadlineMs: REAL_DAEMON_DEADLINE_MS }, {
          updateBytes, metadata: { accepted: { receipt, binding, authority: recipient
            ? { principalKind: "named", principalId: "recipient", grantId: "edit-grant", grantGeneration: 1 }
            : { principalKind: "owner", principalId: workspaceId, grantId: null, grantGeneration: null }, receivedAtMs: 200 + cursor }, firstSeen: [],
            ...(recipient ? { canonicalVersion: 2, authorSnapshot: [{ kind: "human", humanId: "recipient", humanName: "Recipient" }], firstSeenDeletes: [] } : {}) },
        });
        expect(applied.result).toMatchObject({ status: "applied" });
      }
      await pullCaptured(relay, capture);
      await pushUntilDrained(relay);
      await peer.relay.pull(async (apply) => apply(async () => undefined));
      const parked = new DatabaseSync(join(rootB, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
      try {
        expect((parked.prepare("SELECT count(*) AS n FROM ydoc_deferred_updates").get() as { n: number }).n,
          JSON.stringify({ operations: parked.prepare("SELECT op_kind,apply_disposition FROM replication_log").all(),
            documents: parked.prepare("SELECT object_id,lineage_claim_id FROM ydoc_docs").all() })).toBe(2);
      }
      finally { parked.close(); }
    } finally { await lease.close({ settle: false }); }
    const moments = (await peer.capture.listMoments({ limit: 100 })).moments.filter(moment => moment.path === path);
    const projected = moments.find(moment => moment.id.startsWith("moment-ydoc-apply-"));
    expect(projected?.authors).toContainEqual({ kind: "unattributed" });
    expect(projected?.authors).toContainEqual({ kind: "human", humanId: "recipient", humanName: "Recipient" });
    // The direct-write ledger's recipient identity is independent of native History.
    // The desktop creation e2e covers that ledger; here its seed anchors real peer moments.
    const created: VersionedTextMoment = { id: "direct-recipient-create", workspaceId, versionId: "main", objectId: binding.objectId,
      path, operation: "write", recordedAtMs: 99, metadata: { origin: "sync" },
      authors: [{ kind: "named", userId: "recipient", grantId: "edit-grant", grantGeneration: 1 }],
      payload: { before: null, after: { path, text: baseline } } };
    const restore = vi.fn(async () => { throw new Error("Mixed text must not be restored"); });
    const result = await restoreDirectWrites({ assertCurrent() {},
      moment: async momentId => {
        if (momentId === created.id) return created;
        const detail = await peer!.capture.readMoment(momentId);
        return detail === null ? null : detail.protected ? "protected" : detail.moment;
      },
      momentsAfter: async () => moments.map(moment => moment.id), restore,
      folderEntries: async () => ["one.md"], removeEmptyFolder: async () => undefined,
      undoRuns: async () => ({ undone: 0, left: 0, missing: 0, keptFields: [], otherKept: 0, errorMessage: null }),
    }, [{ path, objectId: binding.objectId, momentId: created.id, created: true }]);
    expect(result).toMatchObject({ restored: [], review: [{ path, reason: "changed-since", changedBy: "An unrecorded author" }] });
    expect(restore).not.toHaveBeenCalled();
    expect(await readFile(join(rootB, path), "utf8")).toContain("OwnerNote: Owner text");
    expect(await readFile(join(rootB, path), "utf8")).toContain("Name: Recipient text");
    await hosted.close({ settle: false });
  } finally {
    doc.destroy();
    await peer?.close();
    try { await capture?.stop().catch(() => undefined); } finally { await owner?.close(); await relayServer.stop(); }
  }
}, 120_000);

describe.skipIf(engine.missing)("a folder move over a page the owner has live", () => {
  const page = "box/inner/page";
  const refused = async (fixture: Awaited<ReturnType<typeof openLiveFolderMoveFixture>>) => {
    const before = fixture.outbound(page);
    const moving = fixture.moveByHand("notes/box", "notes/moved");
    await expect(moving).rejects.toBeInstanceOf(LiveFolderError);
    await expect(moving).rejects.toThrow(liveFolderBody("move"));
    expect(await fixture.read(`notes/${page}.md`)).toContain(`Page ${page} body.`);
    await expect(stat(join(fixture.rootPath, "notes", "moved"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.outbound(page)).toBe(before);
  };

  it("refuses the move while the page has no edit", async () => {
    const fixture = await openLiveFolderMoveFixture({ workspaceId: `folder-owned-${randomUUID()}`, compiledRelayMain,
      engineExecutable: engine.require(), pages: [page] });
    try { await refused(fixture); } finally { await fixture.close(); }
  }, 240_000);

  it("refuses the move while an accepted edit has not reached the owner", async () => {
    const fixture = await openLiveFolderMoveFixture({ workspaceId: `folder-in-flight-${randomUUID()}`, compiledRelayMain,
      engineExecutable: engine.require(), pages: [page] });
    try {
      const owned = fixture.ownerAccepted(page);
      fixture.refuseLogPulls(true);
      await fixture.edit(page, " in flight");
      expect(fixture.ownerAccepted(page)).toBe(owned);
      await refused(fixture);
    } finally { await fixture.close(); }
  }, 240_000);
});

// #3089: before a live page moves, the guard tries to catch this device up
// with the server, so the move carries the edit the live host already accepted.
describe("the move guard over a real relay and live host", () => {
  const PROXY_DELAY_MS = 50;
  const timings: GuardTiming[] = [];
  const marker = (name: string) => ` ${name}-${randomUUID().slice(0, 8)}`;
  const RETRY_LATER = { wireCode: "OVERLOADED", message: "markdown-witness-check-pending", retry: "afterBackoff" };
  const describePull = (pull: GuardPull) => pull.result === "succeeded" ? "succeeded"
    : `refused ${pull.wireCode ?? "without a wire code"} ${pull.message} (retry ${pull.retry ?? "unknown"})`;
  const answeredRetryLater = (pull: GuardPull | undefined) => pull?.result === "failed"
    && pull.wireCode === RETRY_LATER.wireCode && pull.message === RETRY_LATER.message && pull.retry === RETRY_LATER.retry;

  // Pulls outside the relay engine until one finds nothing new, so the next
  // pull has no backlog. A pull that answers retry later is pulled again.
  async function drain(device: MoveDevice) {
    await expect.poll(async () => (await device.pull()).fetched, { timeout: 120_000 }).toBe(0);
    expect(device.syncFailed()).toBe(false);
    expect(device.backgroundPulls(), "the relay engine pulled outside a guard's catch-up").toEqual([]);
  }

  // The link holder's edit is accepted, saved and published; nothing on the
  // device has pulled it. Times only the move, and checks the guard's own wait
  // apart from the move's other work. This computer owns no page it
  // moves here: a bound move is refused (editThenRefusedMove).
  // `unbound` decides what a guarded move must show:
  // - backlog: its pull either carries the edit, or answers retry later and
  //   the move goes ahead without it, as the guard allows.
  // - drained: the device had nothing else to pull, so the pull must succeed
  //   inside the wait and carry the edit.
  async function editThenMove(fixture: LiveMoveFixture, device: MoveDevice, input: { name: string;
    guarded: boolean; proxyDelayMs: number; unbound?: "backlog" | "drained"; beforeEdit?: () => Promise<void> }) {
    const { path } = fixture.page(input.name);
    const text = marker(input.name);
    await input.beforeEdit?.();
    const cursor = await fixture.edit(input.name, text);
    await fixture.waitPublished(input.name, cursor);
    const unchanged = await fixture.read(device, path);
    expect(unchanged).not.toContain(text);
    const destination = `notes/${input.name}-moved.md`;
    const requested = device.targetedPasses();
    fixture.proxy.setDelayMs(input.proxyDelayMs);
    let elapsedMs: number;
    try { elapsedMs = await device.move(path, destination, { guarded: input.guarded }); }
    finally { fixture.proxy.setDelayMs(0); }
    // A move past the wait goes ahead while its catch-up still runs, so read once the catch-up ends.
    const guardPulls = input.guarded ? await device.guardPulls() : undefined;
    const moved = await fixture.read(device, destination).catch(() => undefined);
    const pull: GuardPull | undefined = guardPulls?.pulls[0];
    const outcome: GuardTiming["outcome"] = !input.unbound ? "moved" : moved?.includes(text) ? "carried"
      : answeredRetryLater(pull) && moved === unchanged ? "stale-retry-later" : "moved";
    // Recorded before any check, so a failed check still leaves the timing.
    timings.push({ name: input.name, route: "unbound", guard: input.guarded ? "on" : "off", proxyDelayMs: input.proxyDelayMs, elapsedMs,
      outcome, ...(guardPulls ? { guardPulls } : {}) });
    expect(existsSync(join(device.rootPath, path))).toBe(false);
    if (!guardPulls) {
      expect(device.targetedPasses()).toBe(requested);
      expect(moved).toBe(unchanged);
      return false;
    }
    expect(device.targetedPasses()).toBe(requested + 1);
    // The guard's wait, not the whole move: the rename and its capture come after it.
    const carriedInTime = guardPulls.endedInWait && moved !== undefined && moved.includes(text);
    if (!input.unbound) throw new Error("A guarded move here says what its pull must show.");
    if (input.unbound === "drained" && !guardPulls.endedInWait) {
      throw new Error(`The guard's wait ran out before its catch-up ended, ${Math.round(elapsedMs)} ms into the move. The guard's pulls: ${guardPulls.pulls.map(describePull).join(", ") || "none"}.`);
    }
    expect(guardPulls.shared, "another pass was running when the guard's catch-up began").toBe(false);
    if (pull === undefined) throw new Error(`The guard's catch-up ran no pull, ${Math.round(elapsedMs)} ms into the move.`);
    expect(guardPulls.pulls.map(describePull), "the guard's catch-up ran one pull").toHaveLength(1);
    expect(fixture.ownerBound(device, input.name)).toBe(false);
    if (input.unbound === "drained") {
      if (pull.result === "failed") throw new Error(`The guard's pull was refused: ${describePull(pull)}.`);
      expect(moved).toContain(text);
      return carriedInTime;
    }
    // The guard doesn't promise the edit. A pull that answers retry later lets
    // the move go ahead without it, and the edit stays published under the page's binding.
    if (pull.result === "succeeded") expect(moved, "the guard's pull succeeded").toContain(text);
    else {
      expect({ wireCode: pull.wireCode, message: pull.message, retry: pull.retry }, "the guard's pull failed").toEqual(RETRY_LATER);
      expect(moved).toBe(unchanged);
      await fixture.waitPublished(input.name, cursor);
    }
    return carriedInTime;
  }

  // This computer owns the page live, so its move is refused with the move
  // words. A guarded move is refused before the guard catches anything up,
  // inside the wait. The page stays where it was, and the refusal leaves the
  // owner's accepted state as it was. Once an owner pass installs the edit, a
  // later pull saves it into the page there. `pullsRefused` fails the pulls
  // that would save the edit until the move is refused.
  async function editThenRefusedMove(fixture: LiveMoveFixture, device: MoveDevice, input: { name: string; guarded: boolean;
    proxyDelayMs: number; pullsRefused?: boolean; before?: () => Promise<void> }) {
    const { path } = fixture.page(input.name);
    const text = marker(input.name);
    const destination = `notes/${input.name}-moved.md`;
    if (input.pullsRefused) fixture.refuseLogPulls(true);
    let cursor: number;
    try {
      cursor = await fixture.edit(input.name, text);
      await fixture.waitPublished(input.name, cursor);
      await input.before?.();
      // The pending case's pull can record #2789's refusal, so compare from here.
      const notices = await device.refusalNotices();
      const accepted = fixture.ownerAccepted(input.name);
      const requested = device.targetedPasses();
      fixture.proxy.setDelayMs(input.proxyDelayMs);
      const started = performance.now();
      let failure: unknown;
      try { failure = await device.move(path, destination, { guarded: input.guarded }).then(() => undefined, (error: unknown) => error); }
      finally { fixture.proxy.setDelayMs(0); }
      const elapsedMs = performance.now() - started;
      // Recorded before any check, so a failed check still leaves the timing.
      timings.push({ name: input.name, route: "bound", guard: input.guarded ? "on" : "off", proxyDelayMs: input.proxyDelayMs, elapsedMs,
        outcome: "refused", ...(input.guarded ? { guardPulls: await device.guardPulls() } : {}) });
      expect(failure).toBeInstanceOf(LivePageOwnedError);
      expect((failure as Error).message).toBe(`${livePageTitle(path, "move")}\n${livePageBody("move")}`);
      expect(device.targetedPasses(), "the refusal came before any catch-up").toBe(requested);
      if (input.guarded) expect(elapsedMs, "the refusal didn't wait for the guard").toBeLessThan(MOVE_ACCEPTED_EDITS_WAIT_MS);
      expect(existsSync(join(device.rootPath, path)), "the page stays where it was").toBe(true);
      expect(existsSync(join(device.rootPath, destination))).toBe(false);
      expect(fixture.ownerBound(device, input.name)).toBe(true);
      expect(fixture.ownerAccepted(input.name), "the refusal leaves the owner's accepted state as it was").toEqual(accepted);
      expect(await device.refusalNotices()).toEqual(notices);
    } finally { if (input.pullsRefused) fixture.refuseLogPulls(false); }
    await fixture.waitPublished(input.name, cursor);
    // Only the guard syncs the owner here, and the refusal came before it, so
    // an owner pass installs the accepted edit. A pull then saves it into the page at its old path.
    await fixture.ownerSync(input.name);
    expect(fixture.ownerAccepted(input.name).cursor, "the owner installed the accepted edit").toBeGreaterThanOrEqual(cursor);
    await expect.poll(async () => { await device.pull(); return fixture.read(device, path); }, { timeout: 120_000 }).toContain(text);
  }

  afterAll(async () => {
    if (timings.length) await recordGuardTimings("two-daemon-sync", timings);
  });

  // This computer owns each bound page live, so each bound move is refused
  // with the move words before the guard catches anything up, and keeps the
  // accepted edit. The unbound peer's guarded move can still carry it.
  it.skipIf(engine.missing)("refuses a bound move before catching up and keeps the accepted edit, and carries it on an unbound device", async () => {
    const fixture = await openLiveMoveFixture({ workspaceId: "guard-carries-accepted", compiledRelayMain, engineExecutable: engine.require(),
      pages: ["pending", "unpulled", "slow", "refused", "peer"], peer: true });
    try {
      const { owner, peer } = fixture;
      const recorded = timings.length;
      // Bound, S already pending: an earlier pull parked the save, and the file holds the page as it was.
      await editThenRefusedMove(fixture, owner, { name: "pending", guarded: true, proxyDelayMs: 0, before: async () => {
        await owner.pull();
        expect(fixture.ownerPendingSettlements("pending")).toBeGreaterThan(0);
      } });
      // Bound, S not yet pulled.
      await editThenRefusedMove(fixture, owner, { name: "unpulled", guarded: true, proxyDelayMs: 0 });
      await editThenRefusedMove(fixture, owner, { name: "slow", guarded: true, proxyDelayMs: PROXY_DELAY_MS });
      // The owner feed installs a newer edit, and the pull that would save it
      // into the page fails. The move is refused the same way.
      await editThenRefusedMove(fixture, owner, { name: "refused", guarded: true, proxyDelayMs: 0, pullsRefused: true,
        before: async () => { await fixture.ownerSync("refused"); } });

      // Unbound, behind the owner's cases: the peer never enrolls, so the pull
      // alone can carry the save, and its first pull meets everything those
      // cases published. That pull may answer retry later, so the drained
      // test below holds the carried-in-time check.
      await editThenMove(fixture, peer, { name: "peer", guarded: true, proxyDelayMs: 0, unbound: "backlog" });
      const peerOutcome = timings.at(-1)?.outcome;
      expect(["carried", "stale-retry-later"]).toContain(peerOutcome);
      // Every guarded move here reaches the timing record, the refusals included.
      expect(timings.slice(recorded).map(({ name, guard, outcome }) => `${name} ${guard} ${outcome}`)).toEqual([
        "pending on refused", "unpulled on refused", "slow on refused", "refused on refused", `peer on ${peerOutcome}`,
      ]);
      // The peer's guard ran owner syncs, and none of them made the peer an owner.
      expect(fixture.ownerBound(owner, "slow")).toBe(true);
      expect(fixture.ownerBound(peer, "peer")).toBe(false);
    } finally {
      await fixture.close();
    }
  }, 600_000);

  // Unbound, with nothing else to pull: the peer pulls until no backlog is
  // left before each edit, and pulls nothing between the edit and the move.
  it.skipIf(engine.missing)("carries the accepted edit on an unbound device whose pull has nothing else to do", async () => {
    const fixture = await openLiveMoveFixture({ workspaceId: "guard-carries-unbound", compiledRelayMain, engineExecutable: engine.require(),
      pages: ["peer-alone", "peer-slow", "warm-up"], peer: true });
    try {
      const { peer } = fixture;
      // Starts the peer's Markdown reader before the first move: its cold start is a separate, known slowness (#3356), not the guard's wait.
      const warmUp = async () => {
        await drain(peer);
        await fixture.waitPublished("warm-up", await fixture.edit("warm-up", marker("warm-up")));
        await drain(peer);
      };
      const recorded = timings.length;
      const carriedInTime = [
        await editThenMove(fixture, peer, { name: "peer-alone", guarded: true, proxyDelayMs: 0, unbound: "drained", beforeEdit: warmUp }),
        await editThenMove(fixture, peer, { name: "peer-slow", guarded: true, proxyDelayMs: PROXY_DELAY_MS, unbound: "drained",
          beforeEdit: () => drain(peer) }),
      ];
      expect(timings.slice(recorded).map(({ name, guard, outcome }) => `${name} ${guard} ${outcome}`)).toEqual([
        "peer-alone on carried", "peer-slow on carried",
      ]);
      expect(carriedInTime).toEqual([true, true]);
    } finally {
      await fixture.close();
    }
  }, 600_000);

  // A folder that holds a page this computer owns, whose newer edit is
  // installed but not yet saved into the file. The live-folder refusal comes
  // before the guard catches anything up, and the next pull saves the edit
  // into the page where it is. The live-folder suite covers an edit that
  // hasn't reached the owner; this one covers an installed one, with the
  // guard wired.
  it.skipIf(engine.missing)("refuses a folder move over an installed, unsaved edit before catching up, and keeps the edit", async () => {
    const fixture = await openLiveMoveFixture({ workspaceId: "guard-folder-refused", compiledRelayMain, engineExecutable: engine.require(),
      pages: ["box/refused"] });
    try {
      const { owner } = fixture;
      const page = fixture.page("box/refused");
      const text = marker("box-refused");
      const recorded = timings.length;
      const files = async () => (await readdir(join(owner.rootPath, "notes"), { recursive: true })).map(String).sort();
      fixture.refuseLogPulls(true);
      let failure: unknown;
      let accepted: ReturnType<LiveMoveFixture["ownerAccepted"]>;
      try {
        const cursor = await fixture.edit("box/refused", text);
        await fixture.ownerSync("box/refused");
        accepted = fixture.ownerAccepted("box/refused");
        expect(accepted.cursor).toBeGreaterThanOrEqual(cursor);
        await fixture.waitPublished("box/refused", cursor);
        expect(await fixture.read(owner, page.path)).not.toContain(text);
        const before = { files: await files(), outbound: fixture.outbound("box/refused"), notices: await owner.refusalNotices(),
          requested: owner.targetedPasses() };
        const started = performance.now();
        failure = await owner.move("notes/box", "notes/box-moved", { guarded: true }).then(() => undefined, (error: unknown) => error);
        const elapsedMs = performance.now() - started;
        timings.push({ name: "folder-refused", route: "bound", guard: "on", proxyDelayMs: 0, elapsedMs, outcome: "refused", guardPulls: await owner.guardPulls() });
        expect(failure).toBeInstanceOf(LiveFolderError);
        expect((failure as Error).message).toBe(`${liveFolderTitle("notes/box", "move")}\n${liveFolderBody("move")}`);
        // The guard caught nothing up, and the refused move changed nothing.
        expect(owner.targetedPasses()).toBe(before.requested);
        expect(await files()).toEqual(before.files);
        expect(existsSync(join(owner.rootPath, "notes/box-moved"))).toBe(false);
        expect(fixture.outbound("box/refused")).toBe(before.outbound);
        expect(await owner.refusalNotices()).toEqual(before.notices);
        expect(fixture.ownerAccepted("box/refused")).toEqual(accepted);
        expect(await fixture.read(owner, page.path)).not.toContain(text);
      } finally { fixture.refuseLogPulls(false); }
      expect(timings.slice(recorded).map(({ name, guard, outcome }) => `${name} ${guard} ${outcome}`)).toEqual(["folder-refused on refused"]);
      // The next pull saves the kept edit into the page at its old path.
      await owner.pull();
      expect(await fixture.read(owner, page.path)).toContain(text);
    } finally {
      await fixture.close();
    }
  }, 600_000);

  // A fresh fixture, so no guard's pull has run on either device. Without the
  // guard, a bound move is still refused, and an unbound one leaves the edit out.
  it.skipIf(engine.missing)("without the guard, a bound move is still refused and an unbound move leaves the accepted edit out", async () => {
    const fixture = await openLiveMoveFixture({ workspaceId: "guard-off-control", compiledRelayMain, engineExecutable: engine.require(),
      pages: ["off", "off-slow", "peer-off", "peer-off-slow"], peer: true });
    try {
      const { owner, peer } = fixture;
      await editThenRefusedMove(fixture, owner, { name: "off", guarded: false, proxyDelayMs: 0,
        before: async () => { expect(fixture.ownerPendingSettlements("off")).toBe(0); } });
      await editThenRefusedMove(fixture, owner, { name: "off-slow", guarded: false, proxyDelayMs: PROXY_DELAY_MS });
      await editThenMove(fixture, peer, { name: "peer-off", guarded: false, proxyDelayMs: 0 });
      await editThenMove(fixture, peer, { name: "peer-off-slow", guarded: false, proxyDelayMs: PROXY_DELAY_MS });
    } finally {
      await fixture.close();
    }
  }, 600_000);
});

// A rename of an owner-bound page is refused, so B and C still publish, and
// after Stop it renames. "unbound" never binds A.
// In "capture-rename" and "capture-delete", a page whose owner native owner
// delivery has bound, and whose head capture owns, is renamed or deleted with
// the file manager while dohc runs: a plain rename or unlink on disk that
// capture notices, with no dohc move or delete. A has an edit its delivery
// hasn't sent. Capture retires A's lineage, which closes A's owner binding, so
// the workspace keeps publishing: A's old path leaves the owner's second
// device, B and C reach it byte for byte, and the unsent edit waits in a
// save-only recovery copy.
// Every observation prints as one `REPRO-OBS` JSON line.
type RenameReproCase = "bound" | "unbound" | "capture-rename" | "capture-delete";
type RenameReproDocument = ReturnType<typeof readyOwnerDeliveryDocuments>[number];
type RenameReproPush = Awaited<ReturnType<EngineRelayWorkspaceClient["push"]>>;
const renameRepro = { oldPath: "docs/a.md", newPath: "docs/a-renamed.md", newPage: "notes/b.md", existing: "notes/c.md" } as const;
const reproErrorText = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const ownedRenameRefusal = `dohc can't move "${renameRepro.oldPath}" while it has live editing on
In Live documents, stop live editing for this page, then move it again.`;

async function runRenameRepro(kind: RenameReproCase, ca: Awaited<ReturnType<typeof mintLocalhostCa>>,
  trustEnv: Record<string, string>, localStates: Map<string, LocalStateBindings>): Promise<void> {
  const { oldPath, newPath, newPage, existing } = renameRepro;
  const workspaceId = `repro-rename-${kind}-${randomUUID().slice(0, 8)}`;
  const bound = kind !== "unbound";
  const rootA = await createTestScratch("dohc-repro-rename-owner-");
  const rootB = await createTestScratch("dohc-repro-rename-peer-");
  const relayRoot = await createTestScratch("dohc-repro-rename-relay-");
  const ownerDb = join(rootA, SECRET_FILE_STORE_RELATIVE_PATH);
  const proxy = await startServerProxy(ca);
  const token = `test:${workspaceId}`, connection = { baseUrl: proxy.origin, token };
  const profile = selfHostLiveProfile(), nativeConfigPath = join(rootA, "owner-ingress.json");
  let step = "setup";
  // Vitest hides a passing test's log; DOHC_REPRO_OBS_FILE keeps the evidence.
  const observe = (entry: Record<string, unknown>) => {
    const line = `REPRO-OBS ${JSON.stringify({ case: kind, workspaceId, step, ...entry })}`;
    console.log(line);
    if (process.env.DOHC_REPRO_OBS_FILE) appendFileSync(process.env.DOHC_REPRO_OBS_FILE, `${line}\n`);
  };
  let relayServer: Awaited<ReturnType<typeof spawnSyncRelay>> | undefined;
  let peer: LiveDaemonCapture | undefined;
  async function openOwner() {
    const opened = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0,
      allowInsecureLoopbackForTests: false, privateOwnerHost: { configPath: nativeConfigPath, client: profile.nativeClient } });
    localStates.set(rootA, opened.sessions);
    try {
      const relay = opened.relay.bind({ ...opened.workspace, relay: connection });
      // A fresh adapter per use: setup replaces the workspace handle after the open.
      const adapter = () => opened.sessions.run(opened.workspace, async ({ client, workspace }) => new VersionedLiveAdapter(client, workspace, { workspaceId }));
      const pages = createWorkspaceEngineCapture({ ...opened.workspace, rustEngineSessions: opened.sessions, settleDebounceMs: 60_000 });
      return { opened, relay, adapter, pages, refusals: new OwnerKnownRefusals() };
    } catch (error) { await opened.close(); throw error; }
  }
  let current: Awaited<ReturnType<typeof openOwner>> | undefined;
  const closeOwner = async () => {
    const closing = current;
    current = undefined;
    if (!closing) return;
    try { await closing.pages.stop().catch(() => undefined); } finally { await closing.opened.close(); }
  };
  const owner = () => {
    if (!current) throw new Error("The owner's engine is closed.");
    return current;
  };
  const call = (endpoint: string, body?: unknown) => fetch(`${proxy.origin}${endpoint}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let discoveryPayload: unknown;
  const ready = async (): Promise<RenameReproDocument[]> => {
    if (!bound) return [];
    const response = await call(`/sync/${workspaceId}/live-host`);
    if (response.status !== 200) throw new Error(`Live-host discovery answered ${response.status}: ${await response.text()}`);
    discoveryPayload = await response.json();
    return readyOwnerDeliveryDocuments(discoveryPayload, workspaceId);
  };
  const diagnostics = () => JSON.stringify({ discoveryPayload, diagnostics: relayServer?.diagnostics() });
  const hostStore = async () => {
    const stores = join(relayRoot, "relay-deployment", "live-host");
    const store = (await readdir(stores).catch(() => [])).find(entry => /^[0-9a-f]{64}$/u.test(entry));
    return store === undefined ? undefined : join(stores, store);
  };
  const readOwnerDb = <T,>(query: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(ownerDb, { readOnly: true });
    try { return query(db); } finally { db.close(); }
  };
  // The rows the engine's publication proof reads to decide whether A is bound,
  // and A's owner activations, which the app's rename check reads.
  const bindingOf = (objectId: string) => readOwnerDb(db => ({
    ownerBindings: db.prepare(`SELECT json_extract(binding_json,'$.currentPath') AS currentPath, binding_revision AS revision,
      accepted_cursor AS acceptedCursor FROM ydoc_owner_bindings WHERE workspace_id=? AND object_id=?`).all(workspaceId, objectId),
    deviceBindings: db.prepare("SELECT current_path AS currentPath, available FROM live_device_application_bindings WHERE workspace_id=? AND object_id=?")
      .all(workspaceId, objectId),
    activations: db.prepare(`SELECT json_extract(binding_json,'$.currentPath') AS currentPath, released_at_ms AS releasedAtMs
      FROM live_owner_activations WHERE workspace_id=? AND object_id=?`).all(workspaceId, objectId),
  }));
  const deliveryPass = async (document: RenameReproDocument, documents: RenameReproDocument[]) => {
    const o = owner();
    return o.opened.sessions.run(o.opened.workspace, async ({ workspace }) => runNativeOwnerDeliveryPass({
      client: o.opened.nativeClient(), workspaceHandle: workspace, document,
      config: { ...profile.owner, nativeConfigPath, nativeClient: profile.nativeClient, relayUrl: proxy.origin, documents },
      refusals: o.refusals, signal: AbortSignal.timeout(60_000), bearer: token, accountId: workspaceId, assertCurrent() {} }));
  };
  const retire = async (binding: { currentPath: string; restoreFenceGeneration?: number }, signal: AbortSignal) => {
    const response = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, { method: "DELETE", signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: binding.currentPath, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration }) });
    const retired = await response.json() as { acceptedCursor?: number };
    return response.ok && typeof retired.acceptedCursor === "number" ? retired.acceptedCursor : null;
  };
  // One pass of what the desktop runs: its owner delivery pass (Stop
  // reconciliation, then a delivery of each ready page), then its relay sync
  // pass (push until the engine has no more, then pull).
  const syncPass = async () => {
    const o = owner();
    const stops = await o.opened.sessions.run(o.opened.workspace, async ({ workspace }) => reconcileOwnerLiveStops({
      client: o.opened.nativeClient(), workspaceHandle: workspace, workspaceId, signal: AbortSignal.timeout(60_000),
      assertCurrent() {}, retire })).then(() => "ok", reproErrorText);
    const delivery: Array<{ path: string; result: string }> = [];
    const documents = await ready().catch((error: unknown) => { delivery.push({ path: "*", result: reproErrorText(error) }); return []; });
    for (const document of documents) {
      delivery.push({ path: document.binding.currentPath, result: await deliveryPass(document, documents).then(String, reproErrorText) });
    }
    const pushes: Array<Pick<RenameReproPush, "pushed" | "hasMore" | "ownerAdmissionPending" | "sharingDeclined"> | { error: string }> = [];
    let pending: RenameReproPush["ownerAdmissionPending"] | undefined;
    for (let index = 0; index < 20; index++) {
      try {
        const result = await o.relay.push();
        pushes.push({ pushed: result.pushed, hasMore: result.hasMore,
          ownerAdmissionPending: result.ownerAdmissionPending, sharingDeclined: result.sharingDeclined });
        pending = result.ownerAdmissionPending;
        if (!result.hasMore) break;
      } catch (error) { pushes.push({ error: reproErrorText(error) }); pending = undefined; break; }
    }
    const pull = await o.relay.pull(apply => o.pages.runRelaySync(apply))
      .then(result => ({ fetched: result.fetched, applied: result.applied }), (error: unknown) => ({ error: reproErrorText(error) }));
    // The desktop sync engine keeps the last push's list as its ownerAdmissionPending, which Notices shows.
    return { stops, delivery, pushes, noticesPending: pending, firstPending: pending?.[0] ?? null, pull };
  };
  // What reached the relay, as the owner's second device pulls it.
  const relayHas = async () => {
    const device = peer;
    if (!device) throw new Error("The second device is not open.");
    const pulled = await device.relay.pull(apply => device.capture.runRelaySync(apply))
      .then(result => ({ fetched: result.fetched, applied: result.applied }), (error: unknown) => ({ error: reproErrorText(error) }));
    const text = (path: string) => readFile(join(rootB, path), "utf8").catch(() => null);
    const [aOld, aNew, b, c] = await Promise.all([text(oldPath), text(newPath), text(newPage), text(existing)]);
    return { pulled, aOld: aOld?.includes("# A") === true, aNew: aNew?.includes("# A") === true, b: b?.includes("# B") === true,
      cChanged: c?.includes("C changed.") === true, aNewText: aNew, bText: b, cText: c };
  };
  // B and C as they are on the owner's device.
  const ownerFiles = async () => {
    const text = (path: string) => readFile(join(rootA, path), "utf8").catch(() => null);
    const [b, c] = await Promise.all([text(newPage), text(existing)]);
    return { b, c };
  };
  type Relay = Awaited<ReturnType<typeof relayHas>>;
  type Observed = { relay: Relay; pending: RenameReproPush["ownerAdmissionPending"] | undefined; owner: Awaited<ReturnType<typeof ownerFiles>> };
  let objectIdA = "";
  // Passes until `done` holds with nothing pending, or `maxPasses` ran. Each pass is one line.
  const settle = async (maxPasses: number, done: (relay: Relay) => boolean): Promise<Observed> => {
    let last: Observed | undefined;
    for (let pass = 1; pass <= maxPasses; pass++) {
      const sync = await syncPass();
      const relay = await relayHas();
      const files = await ownerFiles();
      observe({ pass, ...sync, relay, ownerFiles: files, ownerA: objectIdA ? bindingOf(objectIdA) : null });
      last = { relay, pending: sync.noticesPending, owner: files };
      if (done(relay) && sync.noticesPending?.length === 0) break;
    }
    return last!;
  };
  // A is where the owner last renamed it: its new path, or after a rename back its old one.
  const reachedAll = (at: "aNew" | "aOld") => (relay: Relay) => relay[at] && relay.b && relay.cChanged;
  const savedC = "# C\n\nC changed.\n";
  // B and C stay intact on the owner's device, whatever publication does.
  const expectOwnerIntact = (label: string, observed: Observed) => {
    expect.soft(observed.owner.b ?? "", `${kind} ${label}: B is intact on the owner's device`).toContain("# B");
    expect.soft(observed.owner.c, `${kind} ${label}: C is intact on the owner's device`).toBe(savedC);
  };
  const expectPublished = (label: string, observed: Observed, at: "aNew" | "aOld" = "aNew") => {
    expect.soft(observed.relay, `${kind} ${label}: the relay has A at ${at === "aNew" ? "its new" : "its old"} path, B and C's change`)
      .toMatchObject({ [at]: true, b: true, cChanged: true });
    expect.soft(observed.pending, `${kind} ${label}: no owner admission is left pending`).toEqual([]);
    expect.soft({ b: observed.relay.bText, c: observed.relay.cText }, `${kind} ${label}: the relay's B and C match the owner's bytes`)
      .toEqual(observed.owner);
  };
  // Explorer's Rename, through the same move the desktop's rename operation runs.
  const appRename = async (fromPath: string, toPath: string) => {
    const o = owner();
    const operation = { workspace: { ...o.opened.workspace, readOnly: false, shareView: undefined }, assertCurrent() {} };
    return moveWorkspacePathByHand(operation, { fromPath, toPath }, { kind: "human", humanId: "local-person" }, {
      capture: o.pages, requestId: randomUUID(),
      trashItem: async () => { throw new Error("This test trashes nothing."); }, markDeleted: () => undefined })
      .then(result => ({ ok: true as const, path: result.path }), (error: unknown) => ({ ok: false as const, error: reproErrorText(error),
        code: error instanceof Error && error.cause instanceof DaemonRefusalError ? error.cause.message : null }));
  };
  // An ordinary save of a file, as an editor outside dohc saves it, which capture records.
  const saveFile = async (path: string, text: string) => {
    const pages = owner().pages;
    const before = (await pages.listMoments({ limit: 1_000 })).moments.filter(moment => moment.path === path).length;
    await writeFile(join(rootA, path), text);
    pages.observeFileEvents([{ path, operation: "update" }]);
    await waitForPathMoments(pages, path, before + 1);
  };
  // An edit in the page's editor. A live page leaves it unsettled for delivery.
  const editPage = async (path: string, note: string, settleIt: boolean) => {
    const session = await owner().pages.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
    try {
      await session.applyDecidedLocalUpdate(doc => {
        const scratch = new Y.Doc();
        try {
          Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
          const before = Y.encodeStateVector(scratch);
          patchFrontmatter(scratch, new Map([["note", note]]));
          return Y.encodeStateAsUpdate(scratch, before);
        } finally { scratch.destroy(); }
      }, undefined, { actorOriginId: "local-person", attribution: { actorKind: "human" }, idempotencyKey: `repro-${note}` });
      if (settleIt) await session.settleNow();
    } finally { await session.close(settleIt ? undefined : { settle: false }); }
  };
  const writePage = async (path: string, text: string) => {
    const o = owner();
    await (await o.adapter()).writeTextFile({ workspaceId, versionId: "main", path, text, publish: true, metadata: { origin: "api" },
      author: { kind: "human", humanId: "local-person" } });
    const session = await o.pages.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
    try { await session.settleNow(); } finally { await session.close(); }
  };
  // Stop live editing as the page's Stop does: the desktop's Stop operation,
  // reached through its operation table and relay share handlers.
  const stopViaApp = async (input: { path: string; objectId?: string }) => {
    const source = owner().opened;
    const handlers = new Map<string, (event: {sender: {id: number}}, payload: unknown) => unknown>();
    const credentials = {serverUrl: proxy.origin, relayUrl: proxy.origin, userId: workspaceId, email: "owner@dohc.test", token};
    const unexpected = (): never => {throw new Error("Unexpected Stop dependency");};
    const ownerHandlers = createRelaySharesIpcHandlers({
      remoteForWorkspace: async () => ({credentials, credentialGeneration: 1}), currentCredentialGeneration: () => 1,
      currentCredentials: () => credentials, warmCredentialCache: async () => {}, relayShareJson: unexpected,
      relayShareJsonWithCredentials: async <R,>(_credentials: unknown, endpoint: string, init?: RequestInit): Promise<R> => {
        const response = await fetch(`${proxy.origin}${endpoint}`, {...init, headers: {authorization: `Bearer ${token}`, "content-type": "application/json"}});
        if (!response.ok) {
          const text = await response.text();
          let data: unknown = null;
          try {data = JSON.parse(text);} catch {/* Not JSON: fail below with the relay's answer. */}
          throw liveStopRelayError(data) ?? new Error(`${init?.method ?? "GET"} ${endpoint} answered ${response.status}: ${text}`);
        }
        return await response.json() as R;
      }, relayShareErrorCopy: unexpected, relayShareDiscussionActivityPolls: createPresencePollRegistry(),
      listOwnerLiveStops: () => source.sessions.run(source.workspace, async ({workspace}) => source.nativeClient().ownerYDocStopList({id:0,workspace,deadlineMs:REAL_DAEMON_DEADLINE_MS})),
      ownerLiveStop: (_workspace, action, _stopPath, binding, acceptedCursor) => source.sessions.run(source.workspace, async ({workspace}) => {
        const client = source.nativeClient(), request = {id: 0, workspace, deadlineMs: REAL_DAEMON_DEADLINE_MS};
        if (action === "clear") {await client.ownerYDocStopClear(request, binding as {mainVersionId: string; objectId: string; currentPath: string});return;}
        if (action==="retired") {await client.ownerYDocStopRetired(request,binding!);return;}
        return action === "request" ? client.ownerYDocStopRequest(request, binding as {mainVersionId: string; objectId: string; currentPath: string})
          : client.ownerYDocRelease(request, binding as import("@dohc/live-session-contract").LiveObjectBinding, {acceptedCursor: acceptedCursor!});
      }), liveDocument: async (_workspace, target) => {
        const resolved = await source.sessions.run(source.workspace, async ({client, workspace}) =>
          new VersionedLiveAdapter(client, workspace, {workspaceId}).resolveFiles({workspaceId, targets: [target]}));
        const [file] = resolved.results;
        return file?.status === "found" ? {mainVersionId: resolved.versionId, objectId: file.objectId, currentPath: file.path} : null;
      }, pushRecorded: async () => {}, withoutEditors: (_workspace, _path, change) => change(), ownerLiveQuarantines: () => [], unwrittenOwnerLiveReleases: async () => [], retryOwnerLiveQuarantine: unexpected, retryOwnerLiveRelease: unexpected, saveOwnerLiveRecoveryCopy: unexpected,
      sendRendererActivity: () => {},
      sharesChanged: unexpected, reconcileReceivedShares: unexpected,
    });
    registerOperations({
      handle: (channel, handler) => {handlers.set(channel, handler);},
      assertTrustedSender() {},
      withActiveWorkspace: async (_event: {sender: {id: number}}, _id, _message, work) => work({workspace: source.workspace, assertCurrent() {}}),
    }, relayShareOperations, ownerHandlers);
    return Promise.resolve(handlers.get(relayShareOperations.stopOwnerLiveDocument.channel)!({sender: {id: 1}}, {workspaceId, ...input}));
  };
  // The server's Live documents row for A, from the current list and then the
  // stopped one, as the desktop's list reads both (relaySharesIpc.ts:398-401).
  // The dialog labels a retired row Stopped.
  const serverRowOfA = async () => {
    for (const query of ["", "?retired=1"]) {
      const response = await call(`/sync/${workspaceId}/live-host${query}`);
      if (response.status !== 200) return { error: `${response.status}` };
      const payload = await response.json() as { documents?: Array<{ objectId?: string; path?: string; status?: string; reason?: string }> };
      const row = payload.documents?.find(row => row.objectId === objectIdA);
      if (row) return row;
    }
    return null;
  };
  // This computer's Stops for A that still owe the server a retirement.
  const owedStopsOfA = async () => {
    const source = owner().opened;
    const rows = await source.sessions.run(source.workspace, async ({ workspace }) =>
      source.nativeClient().ownerYDocStopList({ id: 0, workspace, deadlineMs: REAL_DAEMON_DEADLINE_MS }));
    return rows.filter(row => row.document.objectId === objectIdA && row.retirementOwed).length;
  };
  // The save-only rows the desktop's Notices and Live documents list for A.
  const recoveryCopiesOfA = async () => {
    const source = owner().opened;
    return source.sessions.run(source.workspace, async ({ workspace }) => readOwnerLiveQuarantines(source.nativeClient(), workspace))
      .then(rows => rows.filter(row => row.objectId === objectIdA).map(row => ({ path: row.path, reason: row.reason, recovery: row.recovery, saveOnly: row.saveOnly === true })),
        (error: unknown) => ({ error: reproErrorText(error) }));
  };
  // The relay's session host control: the self-host live service runs in "service" mode.
  const hostControl = () => {
    const db = new DatabaseSync(join(relayRoot, "relay", "relay.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT configured_mode AS mode, admission_state AS admission FROM sync_relay_session_host_control").all(); }
    finally { db.close(); }
  };
  // Stop, then whether the session host still lists a ready page.
  const tryStop = async (input: { path: string; objectId?: string }) => {
    const stopped = await stopViaApp(input)
      .then(result => ({ ok: true, result }), (error: unknown) => ({ ok: false, error: reproErrorText(error) }));
    const stillLive = !stopped.ok ? "not waited: Stop refused" : await expect.poll(async () => (await ready()).map(document => document.binding.currentPath),
      { timeout: 60_000 }).toEqual([]).then(() => null, () => discoveryPayload);
    observe({ stopInput: input, stopped, stillLiveAfterStop: stillLive, ownerA: bindingOf(objectIdA) });
    return stopped;
  };
  try {
    relayServer = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain,
      editLinks: { engineExecutable: engine.require(), publicOrigin: proxy.origin, trustEnv },
      linkBoundary: { linkKey: "repro-rename-link-key-".repeat(2), relayExchangeKey: "repro-rename-exchange-".repeat(2),
        publicViewerOrigin: proxy.origin } });
    proxy.routeRelayTo(relayServer.baseUrl);
    await writeFile(nativeConfigPath, JSON.stringify(profile.nativeIngress));
    current = await openOwner();
    await current.relay.claim();
    await current.opened.chats.ensureGeneralChannel({ workspaceId });
    await pushUntilDrained(current.relay);
    await (await current.adapter()).ensureMainVersion({ workspaceId });

    if (kind === "capture-rename" || kind === "capture-delete") {
      const route = kind === "capture-rename" ? "os-rename" : "os-delete";
      // Step 1: A is saved on disk outside dohc, and capture writes its head.
      // Opening it once in dohc, with no edit, gives it the live-editing history
      // a server needs to host it. A and C reach the owner's second device.
      step = "1-synced";
      await mkdir(join(rootA, dirname(oldPath)), { recursive: true });
      await writeFile(join(rootA, oldPath), "# A\n");
      await expect.poll(async () => {
        await (await current!.adapter()).reconcileCapture();
        return (await (await current!.adapter()).resolveFiles({ workspaceId, versionId: "main", targets: [{ path: oldPath }] })).results[0]?.status;
      }, { timeout: 30_000 }).toBe("found");
      const session = await current.pages.openYDocSession({ path: oldPath, contentKind: "richdoc", onRemoteUpdate: () => undefined });
      await session.close({ settle: false });
      await writePage(existing, "# C\n");
      await pushUntilDrained(current.relay);
      peer = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      const fileA = (await (await current.adapter()).resolveFiles({ workspaceId, versionId: "main", targets: [{ path: oldPath }] })).results[0];
      if (fileA?.status !== "found") throw new Error(`${oldPath} has no object.`);
      objectIdA = fileA.objectId;
      await settle(3, relay => relay.aOld);

      // The owner shares A's folder with a session host, and a delivery pass
      // with no edit binds A's owner and keeps capture's head.
      step = "1-live";
      const share = await call(`/sync/${workspaceId}/shares`, { recipientEmail: "repro-recipient@dohc.test", paths: ["docs"], access: "edit" });
      expect(share.status).toBe(200);
      const enrollment = await call(`/sync/${workspaceId}/live-host`, { shareId: (await share.json() as { shareId: string }).shareId });
      expect([200, 202]).toContain(enrollment.status);
      await expect.poll(async () => (await ready()).map(document => document.binding.currentPath), { timeout: 120_000 })
        .toEqual([oldPath]).catch(error => { throw new Error(diagnostics(), { cause: error }); });
      const document = (await ready())[0]!;
      expect(document.binding.objectId).toBe(objectIdA);
      await expect.poll(async () => {
        observe({ bindingPass: await deliveryPass(document, [document]).then(String, reproErrorText) });
        return bindingOf(objectIdA).ownerBindings.length;
      }, { timeout: 120_000 }).toBe(1);
      owner().pages.start();
      const binding = bindingOf(objectIdA);
      observe({ binding });
      expect({ ownerBoundAtOldPath: binding.ownerBindings.some(row => row.currentPath === oldPath),
        currentActivation: binding.activations.some(row => row.releasedAtMs === null) }, `${kind}: before the change, A's owner binding`)
        .toEqual({ ownerBoundAtOldPath: true, currentActivation: false });
      await settle(3, relay => relay.aOld);
      const origin = readOwnerDb(db => (db.prepare("SELECT metadata_origin AS origin FROM snapshots WHERE workspace_id=? AND object_id=?")
        .get(workspaceId, objectIdA) as { origin: string } | undefined)?.origin ?? null);
      expect(origin, `${kind}: capture owns A's head, so a file-manager change retires its lineage`).toBe("capture");

      // An edit in A's editor that delivery hasn't sent when the file goes.
      step = "2-unsent-edit";
      await editPage(oldPath, "a-unsent", false);
      const unsent = () => readOwnerDb(db => (db.prepare("SELECT COUNT(*) AS n FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE o.object_id=? AND e.pending=1")
        .get(objectIdA) as { n: number }).n);
      const unsentBefore = unsent();
      observe({ unsentEntries: unsentBefore });
      expect(unsentBefore, `${kind}: A has an unsent edit`).toBeGreaterThan(0);

      // Step 2: with A's tab closed, the file manager renames or deletes A. The
      // watcher captures the change when it runs; otherwise the reconcile pass
      // the app runs does.
      step = `2-${route}`;
      const startedAt = new Date().toISOString();
      if (route === "os-rename") await rename(join(rootA, oldPath), join(rootA, newPath));
      else await unlink(join(rootA, oldPath));
      const watcher = await (await owner().adapter()).watcherStatus();
      const target = route === "os-rename" ? newPath : oldPath;
      const captured = async () => {
        const [file] = (await (await owner().adapter()).resolveFiles({ workspaceId, versionId: "main", targets: [{ path: target }] })).results;
        if (route === "os-delete") return file?.status === "found" ? "present" : "absent";
        return file?.status !== "found" ? "absent" : file.objectId === objectIdA ? "same-object" : "new-object";
      };
      const done = (state: string) => route === "os-rename" ? state !== "absent" : state === "absent";
      let capturedBy = "none", state = await captured();
      if (watcher.running) {
        await expect.poll(async () => done(state = await captured()), { timeout: 30_000 }).toBe(true).catch(() => undefined);
        if (done(state)) capturedBy = "watcher";
      }
      if (!done(state)) {
        await (await owner().adapter()).reconcileCapture();
        if (done(state = await captured())) capturedBy = "reconcile";
      }
      observe({ startedAt, watcher: { running: watcher.running, phase: watcher.phase, degraded: watcher.degraded }, capturedBy, state,
        ownerA: bindingOf(objectIdA), serverRow: await serverRowOfA() });
      expect(capturedBy, `${route}: capture notices the file manager's change without a dohc move or delete`).not.toBe("none");

      // Step 3: a new page B, and an ordinary saved change to the file C, which
      // synced before step 1 and is not enrolled for live delivery.
      step = "3-new-and-changed";
      await writePage(newPage, "# B\n");
      await saveFile(existing, savedC);
      const arrived = (relay: Relay) => !relay.aOld && relay.b && relay.cChanged && (route === "os-delete" || relay.aNew);
      const published = await settle(6, arrived);
      const ownerANew = route === "os-rename" ? await readFile(join(rootA, newPath), "utf8").catch(() => null) : null;
      const copies = await recoveryCopiesOfA();
      observe({ endedAt: new Date().toISOString(), serverRow: await serverRowOfA(), ownerA: bindingOf(objectIdA),
        unsentEntriesAfter: unsent(), recoveryCopies: copies });
      expect(published.owner.b ?? "", `${route}: B is intact on the owner's device`).toContain("# B");
      expect(published.owner.c, `${route}: C is intact on the owner's device`).toBe(savedC);
      expect(published.relay.aOld, `${route}: A's old path is gone from the owner's second device`).toBe(false);
      expect({ b: published.relay.b, cChanged: published.relay.cChanged }, `${route}: B and C reach the owner's second device`)
        .toEqual({ b: true, cChanged: true });
      expect(published.pending, `${route}: no owner admission is left pending`).toEqual([]);
      expect({ b: published.relay.bText, c: published.relay.cText }, `${route}: B and C match the owner's bytes`).toEqual(published.owner);
      if (route === "os-rename") expect(published.relay.aNewText, `${route}: A reaches the second device under its new name`).toBe(ownerANew);
      expect(copies, `${kind}: A's unsent edit waits in a save-only recovery copy`)
        .toEqual([{ path: oldPath, reason: "retired", recovery: "paused", saveOnly: true }]);
      return;
    }

    // Step 1: A and C exist and reach the owner's second device. The owner
    // then edits A live; with a session host, native owner delivery binds it.
    step = "1-synced";
    await writePage(oldPath, "# A\n");
    await writePage(existing, "# C\n");
    await pushUntilDrained(current.relay);
    peer = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
    const fileA = (await (await current.adapter()).resolveFiles({ workspaceId, versionId: "main", targets: [{ path: oldPath }] })).results[0];
    if (fileA?.status !== "found") throw new Error(`${oldPath} has no object.`);
    objectIdA = fileA.objectId;
    await settle(3, relay => relay.aOld);
    step = "1-live";
    if (bound) {
      const share = await call(`/sync/${workspaceId}/shares`, { recipientEmail: "repro-recipient@dohc.test", paths: ["docs"], access: "edit" });
      expect(share.status).toBe(200);
      const enrollment = await call(`/sync/${workspaceId}/live-host`, { shareId: (await share.json() as { shareId: string }).shareId });
      expect([200, 202]).toContain(enrollment.status);
      await expect.poll(async () => (await ready()).map(document => document.binding.currentPath), { timeout: 120_000 })
        .toEqual([oldPath]).catch(error => { throw new Error(diagnostics(), { cause: error }); });
      const document = (await ready())[0]!;
      expect(document.binding.objectId).toBe(objectIdA);
      const control = hostControl();
      observe({ hostControl: control });
      expect.soft(control, `${kind}: the relay's session host runs in the self-host default mode`).toMatchObject([{ mode: "service" }]);
      // The owner edits A in its editor, and delivery carries the edit to the session host.
      await editPage(oldPath, "a-live", false);
      await expect.poll(async () => {
        await deliveryPass(document, [document]);
        await owner().relay.pull(apply => owner().pages.runRelaySync(apply));
        const store = await hostStore();
        return store === undefined ? "" : readFile(join(store, oldPath), "utf8").catch(() => "");
      }, { timeout: 120_000 }).toContain("note: a-live");
      // The owner's file holds the accepted edit before the rename.
      const fileMatches = await expect.poll(async () => {
        await owner().pages.flush();
        await owner().relay.pull(apply => owner().pages.runRelaySync(apply));
        return readFile(join(rootA, oldPath), "utf8");
      }, { timeout: 60_000 }).toContain("note: a-live").then(() => true, () => false);
      observe({ ownerFileHasAcceptedEdit: fileMatches, ownerFile: await readFile(join(rootA, oldPath), "utf8") });
    } else {
      // The same live edit with no session host: nothing binds A's owner.
      await editPage(oldPath, "a-live", true);
    }
    owner().pages.start();
    // Native owner delivery enrolled A's owner: its observed binding, at A's
    // old path, with no current adopted activation (which refuses a rename).
    const binding = bindingOf(objectIdA);
    const preconditions = {
      ownerBoundAtOldPath: binding.ownerBindings.some(row => row.currentPath === oldPath),
      anyBinding: binding.ownerBindings.length + binding.deviceBindings.length > 0,
      currentActivation: binding.activations.some(row => row.releasedAtMs === null),
    };
    observe({ binding, preconditions });
    expect(preconditions, `${kind}: before the rename, A's owner binding`)
      .toEqual({ ownerBoundAtOldPath: bound, anyBinding: bound, currentActivation: false });
    await settle(3, relay => relay.aOld);

    // Step 2: with A's tab closed, the owner renames A in Explorer. dohc
    // refuses a bound A, which stays where it was.
    step = "2-rename";
    const onDisk = async () => ({ old: await stat(join(rootA, oldPath)).then(() => true, () => false),
      new: await stat(join(rootA, newPath)).then(() => true, () => false) });
    const renamed = await appRename(oldPath, newPath);
    observe({ renamed, onDisk: await onDisk() });
    if (bound) {
      expect(renamed, "the rename is refused with the move words").toEqual({ ok: false, code: "live-page-owned",
        error: `LivePageOwnedError: ${ownedRenameRefusal}` });
      expect(await onDisk(), "A stays at its old path").toEqual({ old: true, new: false });
    } else {
      expect(renamed).toEqual({ ok: true, path: newPath });
    }
    const at = bound ? "aOld" : "aNew";

    // Step 3: a new page B, and an ordinary saved change to the file C, which
    // synced before step 1 and is not enrolled for live delivery.
    step = "3-new-and-changed";
    await writePage(newPage, "# B\n");
    await saveFile(existing, savedC);
    const published = await settle(6, reachedAll(at));
    expectOwnerIntact("after B and C", published);
    expectPublished("after B and C", published, at);
    if (!bound) return;

    // Step 4: Stop live editing on A's row, which names the server's path
    // for A and A's object, with no rename back. The row then reads Stopped.
    step = "4-stop";
    expect((await tryStop({ path: oldPath, objectId: objectIdA })).ok, "Stop live editing is accepted").toBe(true);
    let row: Awaited<ReturnType<typeof serverRowOfA>> = null;
    await expect.poll(async () => {
      // A delivery pass sends a retirement the Stop still owes.
      if (await owedStopsOfA() > 0) await syncPass();
      row = await serverRowOfA();
      return row !== null && "status" in row && row.status === "retired" && await owedStopsOfA() === 0;
    }, { timeout: 120_000, interval: 500 }).toBe(true).catch(error => { throw new Error(JSON.stringify({ row, diagnostics: diagnostics() }), { cause: error }); });
    observe({ serverRow: row, ownerA: bindingOf(objectIdA) });

    // Step 5: A renames now, and the rename publishes with B and C.
    step = "5-renamed";
    expect(await appRename(oldPath, newPath)).toEqual({ ok: true, path: newPath });
    expect(await onDisk()).toEqual({ old: false, new: true });
    const recovered = await settle(6, reachedAll("aNew"));
    expectOwnerIntact("after Stop and rename", recovered);
    expectPublished("after Stop and rename", recovered);
  } catch (error) {
    observe({ failed: reproErrorText(error), stack: error instanceof Error ? error.stack : undefined, diagnostics: diagnostics() });
    throw error;
  } finally {
    await peer?.close().catch(() => undefined);
    try { await closeOwner(); } finally {
      localStates.delete(rootA);
      try { await relayServer?.stop(); } finally { await proxy.close(); }
    }
  }
}

async function runRenameRepros(cases: RenameReproCase[]): Promise<void> {
  const ca = await mintLocalhostCa(await createTestScratch("dohc-repro-rename-ca-"));
  const previousRoots = getCACertificates("default");
  setDefaultCACertificates([...previousRoots, ca.ca]);
  const trustEnv = { NODE_EXTRA_CA_CERTS: ca.caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
    DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath, DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0" };
  for (const [name, value] of Object.entries(trustEnv)) vi.stubEnv(name, value);
  const localStates = new Map<string, LocalStateBindings>();
  readLocalStateFrom({
    currentBinding: workspace => localStates.get(workspace.rootPath)?.currentBinding(workspace) ?? null,
    openInProgress: workspace => localStates.get(workspace.rootPath)?.openInProgress?.(workspace) ?? null,
    localStateOpenAt: rootPath => localStates.get(rootPath)?.localStateOpenAt(rootPath) ?? Promise.resolve(null),
  });
  try {
    // The workspaces run side by side so the case fits its time.
    const outcomes = await Promise.allSettled(cases.map(kind => runRenameRepro(kind, ca, trustEnv, localStates)));
    const failed = outcomes.flatMap((outcome, index) => outcome.status === "rejected" ? [`${cases[index]}: ${reproErrorText(outcome.reason)}`] : []);
    expect(failed, "every workspace reached the end of its steps").toEqual([]);
  } finally {
    readLocalStateFrom(null);
    setDefaultCACertificates(previousRoots);
    vi.unstubAllEnvs();
  }
}

it.skipIf(engine.missing)("refuses renaming an owner-bound live page, keeps its workspace publishing, and renames it after Stop (bound, unbound)",
  () => runRenameRepros(["bound", "unbound"]), 300_000);

it.skipIf(engine.missing)("renaming or deleting a captured owner-bound live page in the file manager keeps its workspace publishing",
  () => runRenameRepros(["capture-rename", "capture-delete"]), 300_000);

// dohc refuses to delete a page that native owner delivery has bound, so its workspace keeps
// publishing. Each case removes A, then creates B and saves C; each observation prints as one `REPRO-OBS` line.
type DeleteReproCase = "bound" | "unbound" | "restore" | "stop-then-delete" | "deferred-stop" | "file-manager" | "file-manager-capture"
  | "file-manager-restore";
const ownedDeleteRefusal = (action: "delete" | "restore") => `LivePageOwnedError: dohc can't ${action} "${renameRepro.oldPath}" while it has live editing on
In Live documents, stop live editing for this page, then ${action} it again.`;

async function runDeleteRepro(kind: DeleteReproCase, ca: Awaited<ReturnType<typeof mintLocalhostCa>>,
  trustEnv: Record<string, string>, localStates: Map<string, LocalStateBindings>): Promise<void> {
  const { oldPath, newPage, existing } = renameRepro;
  const workspaceId = `repro-delete-${kind}-${randomUUID().slice(0, 8)}`;
  const bound = kind !== "unbound";
  const rootA = await createTestScratch("dohc-repro-delete-owner-");
  const rootB = await createTestScratch("dohc-repro-delete-peer-");
  const relayRoot = await createTestScratch("dohc-repro-delete-relay-");
  const trashRoot = await createTestScratch("dohc-repro-delete-trash-");
  const ownerDb = join(rootA, SECRET_FILE_STORE_RELATIVE_PATH);
  const proxy = await startServerProxy(ca);
  const token = `test:${workspaceId}`, connection = { baseUrl: proxy.origin, token };
  const profile = selfHostLiveProfile(), nativeConfigPath = join(rootA, "owner-ingress.json");
  let step = "setup";
  const observe = (entry: Record<string, unknown>) =>
    console.log(`REPRO-OBS ${JSON.stringify({ case: `delete-${kind}`, workspaceId, step, ...entry })}`);
  // The engine's refusals as its sidecar and capture print them. Each file-manager case runs alone, so each line is its own.
  const refusalLines: string[] = [];
  const spies = !kind.startsWith("file-manager") ? [] : (["error", "warn"] as const).map(level => {
    const print = console[level].bind(console);
    return vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      const line = args.map(arg => arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)).join(" ");
      if (/live-page-owned|owns the page live|LivePageOwned/u.test(line)) refusalLines.push(line.slice(0, 400));
      print(...args);
    });
  });
  let peer: LiveDaemonCapture | undefined;
  // The owner's engine reads its live host configuration at startup, so the relay and the file come first.
  const relayServer = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain,
    editLinks: { engineExecutable: engine.require(), publicOrigin: proxy.origin, trustEnv },
    linkBoundary: { linkKey: "repro-delete-link-key-".repeat(2), relayExchangeKey: "repro-delete-exchange-".repeat(2),
      publicViewerOrigin: proxy.origin } });
  proxy.routeRelayTo(relayServer.baseUrl);
  await writeFile(nativeConfigPath, JSON.stringify(profile.nativeIngress));
  const opened = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0,
    allowInsecureLoopbackForTests: false, privateOwnerHost: { configPath: nativeConfigPath, client: profile.nativeClient } })
    .catch(async (error: unknown) => { try { await relayServer.stop(); } finally { await proxy.close(); } throw error; });
  localStates.set(rootA, opened.sessions);
  const relay = opened.relay.bind({ ...opened.workspace, relay: connection });
  // A fresh adapter per use: setup replaces the workspace handle after the open.
  const adapter = () => opened.sessions.run(opened.workspace, async ({ client, workspace }) => new VersionedLiveAdapter(client, workspace, { workspaceId }));
  const pages = createWorkspaceEngineCapture({ ...opened.workspace, rustEngineSessions: opened.sessions, settleDebounceMs: 60_000 });
  const refusals = new OwnerKnownRefusals();
  const call = (endpoint: string, body?: unknown) => fetch(`${proxy.origin}${endpoint}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let discoveryPayload: unknown;
  const ready = async (): Promise<RenameReproDocument[]> => {
    if (!bound) return [];
    const response = await call(`/sync/${workspaceId}/live-host`);
    if (response.status !== 200) throw new Error(`Live-host discovery answered ${response.status}: ${await response.text()}`);
    discoveryPayload = await response.json();
    return readyOwnerDeliveryDocuments(discoveryPayload, workspaceId);
  };
  const diagnostics = () => JSON.stringify({ discoveryPayload, diagnostics: relayServer.diagnostics() });
  const hostStore = async () => {
    const stores = join(relayRoot, "relay-deployment", "live-host");
    const store = (await readdir(stores).catch(() => [])).find(entry => /^[0-9a-f]{64}$/u.test(entry));
    return store === undefined ? undefined : join(stores, store);
  };
  let objectIdA = "";
  // A's owner binding and its Stop row, whose state reads requested or released.
  const ownerRowsOfA = () => {
    const db = new DatabaseSync(ownerDb, { readOnly: true });
    try {
      return {
        ownerBindings: db.prepare(`SELECT json_extract(binding_json,'$.currentPath') AS currentPath, binding_revision AS revision,
          accepted_cursor AS acceptedCursor FROM ydoc_owner_bindings WHERE workspace_id=? AND object_id=?`).all(workspaceId, objectIdA),
        stops: db.prepare("SELECT state, json_extract(binding_json,'$.currentPath') AS currentPath FROM owner_live_stops WHERE workspace_id=? AND object_id=?")
          .all(workspaceId, objectIdA),
        activations: db.prepare(`SELECT json_extract(binding_json,'$.currentPath') AS currentPath, released_at_ms AS releasedAtMs
          FROM live_owner_activations WHERE workspace_id=? AND object_id=?`).all(workspaceId, objectIdA),
      };
    } finally { db.close(); }
  };
  // The server's Live documents rows for A, from the current and the stopped list.
  const serverRowsOfA = async () => {
    const rows: Record<string, unknown> = {};
    for (const [list, query] of [["active", ""], ["retired", "?retired=1"]] as const) {
      const response = await call(`/sync/${workspaceId}/live-host${query}`);
      if (response.status !== 200) { rows[list] = { error: response.status }; continue; }
      const payload = await response.json() as { documents?: Array<{ objectId?: string }> };
      rows[list] = payload.documents?.find(row => row.objectId === objectIdA) ?? null;
    }
    return rows;
  };
  const deliveryPass = async (document: RenameReproDocument, documents: RenameReproDocument[]) =>
    opened.sessions.run(opened.workspace, async ({ workspace }) => runNativeOwnerDeliveryPass({
      client: opened.nativeClient(), workspaceHandle: workspace, document,
      config: { ...profile.owner, nativeConfigPath, nativeClient: profile.nativeClient, relayUrl: proxy.origin, documents },
      refusals, signal: AbortSignal.timeout(60_000), bearer: token, accountId: workspaceId, assertCurrent() {} }));
  const retire = async (binding: { currentPath: string; restoreFenceGeneration?: number }, signal: AbortSignal) => {
    const response = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, { method: "DELETE", signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: binding.currentPath, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration }) });
    const retired = await response.json() as { acceptedCursor?: number };
    return response.ok && typeof retired.acceptedCursor === "number" ? retired.acceptedCursor : null;
  };
  // One pass of what the desktop runs: Stop reconciliation, a delivery of each
  // ready page, then its relay sync pass (push until drained, then pull).
  const syncPass = async () => {
    const stops = await opened.sessions.run(opened.workspace, async ({ workspace }) => reconcileOwnerLiveStops({
      client: opened.nativeClient(), workspaceHandle: workspace, workspaceId, signal: AbortSignal.timeout(60_000),
      assertCurrent() {}, retire })).then(() => "ok", reproErrorText);
    const delivery: Array<{ path: string; result: string }> = [];
    const documents = await ready().catch((error: unknown) => { delivery.push({ path: "*", result: reproErrorText(error) }); return []; });
    for (const document of documents) {
      delivery.push({ path: document.binding.currentPath, result: await deliveryPass(document, documents).then(String, reproErrorText) });
    }
    const pushes: Array<Pick<RenameReproPush, "pushed" | "hasMore" | "ownerAdmissionPending" | "sharingDeclined"> | { error: string }> = [];
    let pending: RenameReproPush["ownerAdmissionPending"] | undefined;
    for (let index = 0; index < 20; index++) {
      try {
        const result = await relay.push();
        pushes.push({ pushed: result.pushed, hasMore: result.hasMore,
          ownerAdmissionPending: result.ownerAdmissionPending, sharingDeclined: result.sharingDeclined });
        pending = result.ownerAdmissionPending;
        if (!result.hasMore) break;
      } catch (error) { pushes.push({ error: reproErrorText(error) }); pending = undefined; break; }
    }
    const pull = await relay.pull(apply => pages.runRelaySync(apply))
      .then(result => ({ fetched: result.fetched, applied: result.applied }), (error: unknown) => ({ error: reproErrorText(error) }));
    // The desktop keeps the last push's list, and Notices shows one row per entry (NoticeCenter.tsx).
    const notices = (pending ?? []).map(entry => ({ id: `owner-admission-pending-${entry.originId}-${entry.originSeq}`,
      title: "Saved locally · Pending share", body: `Your edits to "${entry.path}" are saved on this device. The shared file update is pending.` }));
    return { stops, delivery, pushes, pending, notices, pull };
  };
  // What reached the owner's second device.
  const relayHas = async () => {
    const device = peer;
    if (!device) throw new Error("The second device is not open.");
    const pulled = await device.relay.pull(apply => device.capture.runRelaySync(apply))
      .then(result => ({ fetched: result.fetched, applied: result.applied }), (error: unknown) => ({ error: reproErrorText(error) }));
    const text = (path: string) => readFile(join(rootB, path), "utf8").catch(() => null);
    const [a, b, c] = await Promise.all([text(oldPath), text(newPage), text(existing)]);
    return { pulled, a: a?.includes("# A") === true, b: b?.includes("# B") === true, cChanged: c?.includes("C changed.") === true, bText: b, cText: c };
  };
  const ownerFiles = async () => {
    const text = (path: string) => readFile(join(rootA, path), "utf8").catch(() => null);
    const [b, c] = await Promise.all([text(newPage), text(existing)]);
    return { b, c };
  };
  type Relay = Awaited<ReturnType<typeof relayHas>>;
  type Observed = { relay: Relay; pending: RenameReproPush["ownerAdmissionPending"] | undefined; owner: Awaited<ReturnType<typeof ownerFiles>> };
  // Passes until `done` holds with nothing pending, or `maxPasses` ran. Each pass is one line.
  const settle = async (maxPasses: number, done: (relay: Relay) => boolean): Promise<Observed> => {
    let last: Observed | undefined;
    for (let pass = 1; pass <= maxPasses; pass++) {
      const sync = await syncPass();
      const has = await relayHas();
      const files = await ownerFiles();
      observe({ pass, ...sync, relay: has, ownerFiles: files, ownerA: objectIdA ? ownerRowsOfA() : null,
        serverA: objectIdA && bound ? await serverRowsOfA() : null });
      last = { relay: has, pending: sync.pending, owner: files };
      if (done(has) && sync.pending?.length === 0) break;
    }
    return last!;
  };
  const savedC = "# C\n\nC changed.\n";
  const arrived = (relay: Relay) => !relay.a && relay.b && relay.cChanged;
  const editPage = async (path: string, note: string, settleIt: boolean) => {
    const session = await pages.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
    try {
      await session.applyDecidedLocalUpdate(doc => {
        const scratch = new Y.Doc();
        try {
          Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
          const before = Y.encodeStateVector(scratch);
          patchFrontmatter(scratch, new Map([["note", note]]));
          return Y.encodeStateAsUpdate(scratch, before);
        } finally { scratch.destroy(); }
      }, undefined, { actorOriginId: "local-person", attribution: { actorKind: "human" }, idempotencyKey: `repro-${note}` });
      if (settleIt) await session.settleNow();
    } finally { await session.close(settleIt ? undefined : { settle: false }); }
  };
  const writePage = async (path: string, text: string) => {
    await (await adapter()).writeTextFile({ workspaceId, versionId: "main", path, text, publish: true, metadata: { origin: "api" },
      author: { kind: "human", humanId: "local-person" } });
    const session = await pages.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
    try { await session.settleNow(); } finally { await session.close(); }
  };
  const saveFile = async (path: string, text: string) => {
    const before = (await pages.listMoments({ limit: 1_000 })).moments.filter(moment => moment.path === path).length;
    await writeFile(join(rootA, path), text);
    pages.observeFileEvents([{ path, operation: "update" }]);
    await waitForPathMoments(pages, path, before + 1);
  };
  // Explorer's Delete, through the same route the desktop's delete operation runs.
  const appDelete = (path: string) => deleteWorkspacePathByHand({ workspace: { ...opened.workspace, readOnly: false, shareView: undefined }, assertCurrent() {} },
    path, { kind: "human", humanId: "local-person" }, { capture: pages, requestId: randomUUID(), markDeleted: () => undefined,
      trashItem: target => rename(target, join(trashRoot, randomUUID())) })
    .then(result => ({ ok: true as const, trashed: result.trashed }), (error: unknown) => ({ ok: false as const, error: reproErrorText(error),
      code: error instanceof Error && error.cause instanceof DaemonRefusalError ? error.cause.message : null }));
  // History's Restore earlier state on A's creation moment, as restoreEngineMomentFile runs it.
  const historyRestoreBeforeCreation = async () => {
    const moments = (await pages.listMoments({ limit: 1_000 })).moments
      .filter(moment => moment.objectId === objectIdA).sort((left, right) => left.recordedAtMs - right.recordedAtMs);
    const creation = moments[0];
    if (!creation) throw new Error(`${oldPath} has no moments.`);
    return pages.restoreFileToBeforeMoment(creation.id, { kind: "human", humanId: "local-person" })
      .then(result => ({ ok: true as const, result, creation: { id: creation.id, operation: creation.operation }, moments: moments.length }),
        (error: unknown) => ({ ok: false as const, error: reproErrorText(error),
          code: error instanceof Error && error.cause instanceof DaemonRefusalError ? error.cause.message : null }));
  };
  // The desktop's Live documents operations, through its operation table and relay share handlers.
  const appHandlers = () => {
    const handlers = new Map<string, (event: {sender: {id: number}}, payload: unknown) => unknown>();
    const credentials = {serverUrl: proxy.origin, relayUrl: proxy.origin, userId: workspaceId, email: "owner@dohc.test", token};
    const unexpected = (): never => {throw new Error("Unexpected Stop dependency");};
    const ownerHandlers = createRelaySharesIpcHandlers({
      remoteForWorkspace: async () => ({credentials, credentialGeneration: 1}), currentCredentialGeneration: () => 1,
      currentCredentials: () => credentials, warmCredentialCache: async () => {}, relayShareJson: unexpected,
      relayShareJsonWithCredentials: async <R,>(_credentials: unknown, endpoint: string, init?: RequestInit): Promise<R> => {
        const response = await fetch(`${proxy.origin}${endpoint}`, {...init, headers: {authorization: `Bearer ${token}`, "content-type": "application/json"}});
        if (!response.ok) {
          const text = await response.text();
          let data: unknown = null;
          try {data = JSON.parse(text);} catch {/* Not JSON: fail below with the relay's answer. */}
          throw liveStopRelayError(data) ?? new Error(`${init?.method ?? "GET"} ${endpoint} answered ${response.status}: ${text}`);
        }
        return await response.json() as R;
      }, relayShareErrorCopy: unexpected, relayShareDiscussionActivityPolls: createPresencePollRegistry(),
      listOwnerLiveStops: () => opened.sessions.run(opened.workspace, async ({workspace}) => opened.nativeClient().ownerYDocStopList({id:0,workspace,deadlineMs:REAL_DAEMON_DEADLINE_MS})),
      ownerLiveStop: (_workspace, action, _stopPath, binding, acceptedCursor) => opened.sessions.run(opened.workspace, async ({workspace}) => {
        const client = opened.nativeClient(), request = {id: 0, workspace, deadlineMs: REAL_DAEMON_DEADLINE_MS};
        if (action === "clear") {await client.ownerYDocStopClear(request, binding as {mainVersionId: string; objectId: string; currentPath: string});return;}
        if (action==="retired") {await client.ownerYDocStopRetired(request,binding!);return;}
        return action === "request" ? client.ownerYDocStopRequest(request, binding as {mainVersionId: string; objectId: string; currentPath: string})
          : client.ownerYDocRelease(request, binding as import("@dohc/live-session-contract").LiveObjectBinding, {acceptedCursor: acceptedCursor!});
      }), liveDocument: async (_workspace, target) => {
        const resolved = await opened.sessions.run(opened.workspace, async ({client, workspace}) =>
          new VersionedLiveAdapter(client, workspace, {workspaceId}).resolveFiles({workspaceId, targets: [target]}));
        const [file] = resolved.results;
        return file?.status === "found" ? {mainVersionId: resolved.versionId, objectId: file.objectId, currentPath: file.path} : null;
      }, pushRecorded: async () => {}, withoutEditors: (_workspace, _path, change) => change(), ownerLiveQuarantines: () => [], unwrittenOwnerLiveReleases: async () => [], retryOwnerLiveQuarantine: unexpected, retryOwnerLiveRelease: unexpected, saveOwnerLiveRecoveryCopy: unexpected,
      sendRendererActivity: () => {},
      sharesChanged: unexpected, reconcileReceivedShares: unexpected,
    });
    registerOperations({
      handle: (channel, handler) => {handlers.set(channel, handler);},
      assertTrustedSender() {},
      withActiveWorkspace: async (_event: {sender: {id: number}}, _id, _message, work) => work({workspace: opened.workspace, assertCurrent() {}}),
    }, relayShareOperations, ownerHandlers);
    return handlers;
  };
  // Stop live editing on A's row, as its Stop button does.
  const stopViaApp = (input: { path: string; objectId?: string }) =>
    Promise.resolve(appHandlers().get(relayShareOperations.stopOwnerLiveDocument.channel)!({sender: {id: 1}}, {workspaceId, ...input}));
  // A's row in Live documents, exactly as the dialog's list returns it.
  const liveRowOfA = async () => {
    const listed = await Promise.resolve(appHandlers().get(relayShareOperations.listOwnerLiveDocuments.channel)!({sender: {id: 1}}, {workspaceId})) as OwnerLiveDocumentsResult;
    return listed.documents.find(row => row.objectId === objectIdA) ?? null;
  };
  // This computer's Stops for A that still owe the server a retirement.
  const owedStopsOfA = async () => {
    const rows = await opened.sessions.run(opened.workspace, async ({ workspace }) =>
      opened.nativeClient().ownerYDocStopList({ id: 0, workspace, deadlineMs: REAL_DAEMON_DEADLINE_MS }));
    return rows.filter(row => row.document.objectId === objectIdA && row.retirementOwed).length;
  };
  try {
    await relay.claim();
    await opened.chats.ensureGeneralChannel({ workspaceId });
    await pushUntilDrained(relay);
    await (await adapter()).ensureMainVersion({ workspaceId });

    // Step 1: A and C exist and reach the owner's second device. The owner
    // shares docs with Edit access and edits A once; native owner delivery binds it.
    step = "1-synced";
    if (kind === "file-manager-capture") {
      // A starts as a file saved outside dohc, so capture writes its head.
      await mkdir(join(rootA, dirname(oldPath)), { recursive: true });
      await writeFile(join(rootA, oldPath), "# A\n");
      pages.observeFileEvents([{ path: oldPath, operation: "update" }]);
      await waitForPathMoments(pages, oldPath, 1);
      // Live editing starts once the owner opens A in dohc; opening, with no edit, gives A its history.
      const session = await pages.openYDocSession({ path: oldPath, contentKind: "richdoc", onRemoteUpdate: () => undefined });
      await session.close({ settle: false });
    } else {
      await writePage(oldPath, "# A\n");
    }
    await writePage(existing, "# C\n");
    await pushUntilDrained(relay);
    peer = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
    const fileA = (await (await adapter()).resolveFiles({ workspaceId, versionId: "main", targets: [{ path: oldPath }] })).results[0];
    if (fileA?.status !== "found") throw new Error(`${oldPath} has no object.`);
    objectIdA = fileA.objectId;
    await settle(3, has => has.a);
    step = "1-live";
    if (bound) {
      const share = await call(`/sync/${workspaceId}/shares`, { recipientEmail: "repro-recipient@dohc.test", paths: ["docs"], access: "edit" });
      expect(share.status).toBe(200);
      const enrollment = await call(`/sync/${workspaceId}/live-host`, { shareId: (await share.json() as { shareId: string }).shareId });
      expect([200, 202]).toContain(enrollment.status);
      await expect.poll(async () => (await ready()).map(document => document.binding.currentPath), { timeout: 120_000 })
        .toEqual([oldPath]).catch(error => { throw new Error(diagnostics(), { cause: error }); });
      const document = (await ready())[0]!;
      expect(document.binding.objectId).toBe(objectIdA);
      if (kind === "file-manager-capture") {
        // Delivery binds A with no live edit, so capture still owns A's head.
        await expect.poll(async () => {
          await deliveryPass(document, [document]);
          return ownerRowsOfA().ownerBindings.length;
        }, { timeout: 60_000, interval: 500 }).toBeGreaterThan(0).catch(error => { throw new Error(JSON.stringify(ownerRowsOfA()), { cause: error }); });
        observe({ boundWithoutEdit: true });
      } else {
        await editPage(oldPath, "a-live", false);
        await expect.poll(async () => {
          await deliveryPass(document, [document]);
          await relay.pull(apply => pages.runRelaySync(apply));
          const store = await hostStore();
          return store === undefined ? "" : readFile(join(store, oldPath), "utf8").catch(() => "");
        }, { timeout: 120_000 }).toContain("note: a-live");
        const fileMatches = await expect.poll(async () => {
          await pages.flush();
          await relay.pull(apply => pages.runRelaySync(apply));
          return readFile(join(rootA, oldPath), "utf8");
        }, { timeout: 60_000 }).toContain("note: a-live").then(() => true, () => false);
        observe({ ownerFileHasAcceptedEdit: fileMatches });
      }
    } else {
      // The same live edit with no session host: nothing binds A's owner.
      await editPage(oldPath, "a-live", true);
    }
    pages.start();
    const before = ownerRowsOfA();
    observe({ ownerA: before });
    expect({ bound: before.ownerBindings.length > 0, currentActivation: before.activations.some(row => row.releasedAtMs === null) },
      `${kind}: before the delete, A's owner binding`).toEqual({ bound, currentActivation: false });
    await settle(3, has => has.a);

    const onDisk = () => stat(join(rootA, oldPath)).then(() => true, () => false);
    const deletesOfA = async () => (await pages.listMoments({ limit: 1_000 })).moments
      .filter(moment => moment.objectId === objectIdA && moment.operation === "delete").length;
    // B and C reach the second device as the owner has them, with nothing pending.
    const expectPublished = (label: string, published: Observed, aOnPeer: boolean) => {
      expect.soft(published.owner.b ?? "", `${kind} ${label}: B is intact on the owner's device`).toContain("# B");
      expect.soft(published.owner.c, `${kind} ${label}: C is intact on the owner's device`).toBe(savedC);
      expect.soft({ a: published.relay.a, b: published.relay.b, cChanged: published.relay.cChanged }, `${kind} ${label}: what reaches the owner's second device`)
        .toEqual({ a: aOnPeer, b: true, cChanged: true });
      expect.soft(published.pending, `${kind} ${label}: no owner admission is left pending`).toEqual([]);
      expect.soft({ b: published.relay.bText, c: published.relay.cText }, `${kind} ${label}: B and C match the owner's bytes`).toEqual(published.owner);
    };
    const newAndChanged = async () => {
      step = "3-new-and-changed";
      await writePage(newPage, "# B\n");
      await saveFile(existing, savedC);
    };
    // A's head and the origin that wrote it, or null once nothing heads A.
    const headOfA = () => {
      const db = new DatabaseSync(ownerDb, { readOnly: true });
      try {
        const row = db.prepare("SELECT path, metadata_origin AS origin FROM snapshots WHERE workspace_id=? AND object_id=?").get(workspaceId, objectIdA);
        return row === undefined ? null : { path: String(row.path), origin: String(row.origin) };
      } finally { db.close(); }
    };

    if (kind === "stop-then-delete" || kind === "deferred-stop") {
      // Step 2: Stop live editing on A's row. "deferred-stop" first leaves more
      // unsent edits than Stop sends (release.rs:332-339): 40 notes, over
      // MAX_RELEASE_ENTRIES, with no delivery pass after them.
      step = "2-stop";
      if (kind === "deferred-stop") for (let edit = 0; edit < 40; edit++) await editPage(oldPath, `unsent-${edit}`, false);
      const stopped = await stopViaApp({ path: oldPath, objectId: objectIdA })
        .then(result => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error: reproErrorText(error) }));
      observe({ stopped, ownerA: ownerRowsOfA(), liveRow: await liveRowOfA() });
      expect(stopped.ok, `${kind}: Stop live editing is accepted`).toBe(true);
      let row: Awaited<ReturnType<typeof liveRowOfA>> = null;
      if (kind === "stop-then-delete") {
        // The row reads Stopped once the server retired A and no retirement is owed.
        await expect.poll(async () => {
          if (await owedStopsOfA() > 0) await syncPass();
          row = await liveRowOfA();
          return row?.status === "retired" && await owedStopsOfA() === 0;
        }, { timeout: 120_000, interval: 500 }).toBe(true).catch(error => { throw new Error(JSON.stringify({ row, diagnostics: diagnostics() }), { cause: error }); });
      } else {
        row = await liveRowOfA();
      }
      const afterStop = ownerRowsOfA();
      // The dialog files a Notices row for a Stop only when it kept edits (LiveDocumentsDialog.tsx:395).
      const keptEdits = stopped.ok ? (stopped.result as { keptEdits?: string } | undefined)?.keptEdits : undefined;
      const stopNotice = keptEdits !== undefined && keptEdits !== "none" ? { onStopped: oldPath, keptEdits } : null;
      observe({ liveRow: row, ownerBindingGone: afterStop.ownerBindings.length === 0, ownerA: afterStop, stopNotice });

      // Step 3: delete A in Explorer, then B and C.
      step = "3-delete";
      const deleted = await appDelete(oldPath);
      observe({ deleted, onDisk: await onDisk(), ownerA: ownerRowsOfA() });
      if (kind === "stop-then-delete") {
        expect(afterStop.ownerBindings, "Stop released A's owner binding").toEqual([]);
        expect({ ok: deleted.ok, onDisk: await onDisk() }, "the delete goes through").toEqual({ ok: true, onDisk: false });
        await newAndChanged();
        expectPublished("after Stop and delete", await settle(6, arrived), false);
      } else {
        // The deferred Stop keeps A's owner binding, so the delete is refused.
        expect(deleted, "the delete is refused with the delete words").toEqual({ ok: false, code: "live-page-owned", error: ownedDeleteRefusal("delete") });
        // A refused delete leaves A's file in place.
        expect(await onDisk(), "A stays on the owner's disk").toBe(true);
        await newAndChanged();
        expectPublished("after a deferred Stop and a refused delete", await settle(6, relay => relay.a && relay.b && relay.cChanged), true);
      }
      return;
    }

    if (kind === "file-manager-restore") {
      // Step 2: A's file goes from disk outside dohc, and capture leaves the delivered head.
      step = "2-file-manager-delete";
      const headBefore = headOfA();
      await unlink(join(rootA, oldPath));
      pages.observeFileEvents([{ path: oldPath, operation: "delete" }]);
      await pages.flush();
      observe({ headBefore, deletesOfA: await deletesOfA(), headAfter: headOfA(), onDisk: await onDisk(), ownerA: ownerRowsOfA() });
      expect({ headBefore: headBefore?.origin, deletesOfA: await deletesOfA() }, "capture leaves a head it did not write")
        .toEqual({ headBefore: "sync", deletesOfA: 0 });

      // Step 3: History's Restore of A's earlier version. Its file is gone, so the restore first records that delete.
      step = "3-restore";
      const moments = (await pages.listMoments({ limit: 1_000 })).moments
        .filter(moment => moment.objectId === objectIdA).sort((left, right) => left.recordedAtMs - right.recordedAtMs);
      const latest = moments.at(-1);
      if (!latest || moments.length < 2) throw new Error(`${oldPath} has no earlier version: ${JSON.stringify(moments)}`);
      const restore = () => pages.restoreFileToBeforeMoment(latest.id, { kind: "human", humanId: "local-person" })
        .then(result => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error: reproErrorText(error),
          code: error instanceof Error && error.cause instanceof DaemonRefusalError ? error.cause.message : null }));
      const restored = await restore();
      observe({ restored, latest: { id: latest.id, operation: latest.operation }, moments: moments.length, head: headOfA(),
        deletesOfA: await deletesOfA(), onDisk: await onDisk(), refusalLines, ownerA: ownerRowsOfA() });
      expect(restored, "the restore is refused with the restore words").toEqual({ ok: false, code: "live-page-owned", error: ownedDeleteRefusal("restore") });
      expect({ head: headOfA(), bound: ownerRowsOfA().ownerBindings.length > 0, deletesOfA: await deletesOfA() },
        "A keeps its head and its owner binding, with no delete").toEqual({ head: headBefore, bound: true, deletesOfA: 0 });
      await newAndChanged();
      expectPublished("after a refused restore", await settle(6, relay => relay.a && relay.b && relay.cChanged), true);
      return;
    }

    if (kind === "file-manager" || kind === "file-manager-capture") {
      // Step 2: A's file goes from disk outside dohc. The engine's own watcher
      // captures it; the desktop's watcher feeds the same event to capture
      // (workspaceActivity.ts:508). No dohc delete, move or restore runs.
      step = "2-file-manager-delete";
      const headBefore = headOfA();
      const startedAt = new Date().toISOString();
      await unlink(join(rootA, oldPath));
      pages.observeFileEvents([{ path: oldPath, operation: "delete" }]);
      const retired = await expect.poll(deletesOfA, { timeout: 30_000, interval: 250 }).toBeGreaterThan(0).then(() => true, () => false);
      observe({ startedAt, headBefore, retired, deletesOfA: await deletesOfA(), headAfter: headOfA(), onDisk: await onDisk(), ownerA: ownerRowsOfA() });
      await newAndChanged();
      const perPass: Array<{ pass: number; deletesOfA: number; head: ReturnType<typeof headOfA>; onDisk: boolean; refusalLines: number }> = [];
      // Every Notices row the passes produced, as the desktop titles them (NoticeCenter.tsx).
      const noticeRows = new Map<string, { title: string; body: string }>();
      let published: Observed | undefined;
      for (let pass = 1; pass <= 6; pass++) {
        published = await settle(1, arrived);
        for (const entry of published.pending ?? []) {
          noticeRows.set(`owner-admission-pending-${entry.originId}-${entry.originSeq}`, { title: "Saved locally · Pending share",
            body: `Your edits to "${entry.path}" are saved on this device. The shared file update is pending.` });
        }
        perPass.push({ pass, deletesOfA: await deletesOfA(), head: headOfA(), onDisk: await onDisk(), refusalLines: refusalLines.length });
        if (arrived(published.relay) && published.pending?.length === 0) break;
      }
      observe({ startedAt, endedAt: new Date().toISOString(), headBefore, perPass, refusalLines, noticeRows: [...noticeRows.values()],
        firstPending: published?.pending?.[0] ?? null, ownerA: ownerRowsOfA(),
        bAndCPublished: published!.relay.b && published!.relay.cChanged && published!.pending?.length === 0 });
      // No refusal reaches capture, and A's file stays gone.
      expect({ refusalLines: refusalLines.length, onDisk: await onDisk() }, `${kind}: no refusal, and A stays gone`)
        .toEqual({ refusalLines: 0, onDisk: false });
      if (kind === "file-manager") {
        // Capture retires only a head it or a Y.Doc wrote (capture_write.rs:827-846); A's head is the delivered edit's, pulled as sync.
        expect({ headBefore: headBefore?.origin, deletesOfA: await deletesOfA() }, "capture leaves a head it did not write")
          .toEqual({ headBefore: "sync", deletesOfA: 0 });
      } else {
        // Capture retires the head it wrote once, and no pass repeats a refusal.
        expect(headBefore?.origin, "capture wrote A's head").toBe("capture");
        expect({ deletesOfA: await deletesOfA(), refusalsPerPass: perPass.map(entry => entry.refusalLines) }, "capture retires A once, with no refusal")
          .toEqual({ deletesOfA: 1, refusalsPerPass: perPass.map(() => 0) });
      }
      return;
    }

    // Step 2: with A's tab closed, the owner deletes A in Explorer, or restores it to before its creation.
    step = kind === "restore" ? "2-restore" : "2-delete";
    const deleted = kind === "restore" ? await historyRestoreBeforeCreation() : await appDelete(oldPath);
    observe({ deleted, onDisk: await onDisk(), ownerA: ownerRowsOfA(), serverA: bound ? await serverRowsOfA() : null });
    if (bound) {
      expect(deleted, `${kind}: refused with the ${kind === "restore" ? "restore" : "delete"} words`)
        .toEqual({ ok: false, code: "live-page-owned", error: ownedDeleteRefusal(kind === "restore" ? "restore" : "delete") });
      expect(await onDisk(), `${kind}: A stays on the owner's disk`).toBe(true);
    } else {
      expect({ ok: deleted.ok, onDisk: await onDisk() }, `${kind}: the delete runs and A leaves the owner's disk`).toEqual({ ok: true, onDisk: false });
    }

    // Step 3: a new page B, and an ordinary saved change to the file C.
    await newAndChanged();
    expectPublished("after B and C", await settle(6, relay => relay.a === bound && relay.b && relay.cChanged), bound);
  } catch (error) {
    observe({ failed: reproErrorText(error), stack: error instanceof Error ? error.stack : undefined, diagnostics: diagnostics() });
    throw error;
  } finally {
    for (const spy of spies) spy.mockRestore();
    await peer?.close().catch(() => undefined);
    try { await pages.stop().catch(() => undefined); } finally {
      await opened.close();
      localStates.delete(rootA);
      try { await relayServer.stop(); } finally { await proxy.close(); }
    }
  }
}

async function runDeleteRepros(cases: DeleteReproCase[]): Promise<void> {
  const ca = await mintLocalhostCa(await createTestScratch("dohc-repro-delete-ca-"));
  const previousRoots = getCACertificates("default");
  setDefaultCACertificates([...previousRoots, ca.ca]);
  const trustEnv = { NODE_EXTRA_CA_CERTS: ca.caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
    DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath, DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0" };
  for (const [name, value] of Object.entries(trustEnv)) vi.stubEnv(name, value);
  const localStates = new Map<string, LocalStateBindings>();
  readLocalStateFrom({
    currentBinding: workspace => localStates.get(workspace.rootPath)?.currentBinding(workspace) ?? null,
    openInProgress: workspace => localStates.get(workspace.rootPath)?.openInProgress?.(workspace) ?? null,
    localStateOpenAt: rootPath => localStates.get(rootPath)?.localStateOpenAt(rootPath) ?? Promise.resolve(null),
  });
  try {
    const outcomes = await Promise.allSettled(cases.map(kind => runDeleteRepro(kind, ca, trustEnv, localStates)));
    const failed = outcomes.flatMap((outcome, index) => outcome.status === "rejected" ? [`${cases[index]}: ${reproErrorText(outcome.reason)}`] : []);
    expect(failed, "every workspace reached the end of its steps").toEqual([]);
  } finally {
    readLocalStateFrom(null);
    setDefaultCACertificates(previousRoots);
    vi.unstubAllEnvs();
  }
}

it.skipIf(engine.missing)("refuses deleting an owner-bound live page and keeps its workspace publishing (bound, unbound)",
  () => runDeleteRepros(["bound", "unbound"]), 300_000);

it.skipIf(engine.missing)("refuses restoring an owner-bound live page to before its creation and keeps its workspace publishing",
  () => runDeleteRepros(["restore"]), 300_000);

it.skipIf(engine.missing)("deletes a live page after Stop, and refuses it after a deferred Stop (stop-then-delete, deferred-stop)",
  () => runDeleteRepros(["stop-then-delete", "deferred-stop"]), 300_000);

it.skipIf(engine.missing)("leaves an owner-bound live page deleted outside dohc to its delivered head, with no refusal (file-manager)",
  () => runDeleteRepros(["file-manager"]), 300_000);
it.skipIf(engine.missing)("records an owner-bound live page that capture wrote and that is deleted outside dohc, with no refusal (file-manager-capture)",
  () => runDeleteRepros(["file-manager-capture"]), 300_000);
it.skipIf(engine.missing)("refuses restoring an owner-bound live page deleted outside dohc (file-manager-restore)",
  () => runDeleteRepros(["file-manager-restore"]), 300_000);
