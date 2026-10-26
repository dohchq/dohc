import { parseHostEpoch } from "@dohc/live-session-contract";
import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { once } from "node:events";
import { restoreDirectWrites } from "./stopAndRestore";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { mintLocalhostCa } from "../../../../services/share-web/src/testing/localhostCa";
import { HostedLogClientClosedError, startServerProxy, type HostedLogResponseBarrier } from "../../e2e/helpers/selfHostOnboarding";
import { DatabaseSync } from "node:sqlite";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
import { DaemonRefusalError, OwnerYDocOutbox, openEngineYdocProviderSession, YdocAdapterError, YdocOwnerDraftPendingError, VersionedLiveAdapter, WorkspaceDaemonRequester, YdocLiveAdapter, type AutomationClaim } from "@dohc/workspace-engine-client";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { collectionRecordWrites } from "@dohc/automation-executor/collection-record-edits";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder, readersTrustLocalState } from "../testing/preparedLocalState";
import { createAutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { runCollectionAutomation } from "@dohc/automation-executor/collection-automation-run";
import { undoCollectionAutomationRuns } from "../../../../packages/automation-executor/src/collectionAutomationUndo";
import { createAutomationTargets } from "../../../../packages/automation-executor/src/automationTargets";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import type { EngineRelayWorkspaceClient } from "./engineRelayClient";
import type { DesktopLinkedChatStore } from "./liveLinkedChatStore";
import { probeRelayWorkspace } from "./relayWorkspaceProbe";
import {
  createWorkspaceEngineCapture,
  createDefaultDiskWriter,
  type EngineDiskWriter,
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
import { readyOwnerDeliveryDocuments } from "./serverOwnerDelivery";
import { startServerOwnerDelivery } from "./serverOwnerDelivery";
import { relayShareOperations } from "../ipc/shareOperations";
import { registerOperations } from "../ipc/operationTable";
import {createRelaySharesIpcHandlers} from "../ipc/relaySharesIpc";
import {createPresencePollRegistry} from "../collab/presencePollRegistry";
import {reconcileOwnerLiveStops} from "./ownerLiveStop";

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
  capturedContents(path: string): Promise<Buffer | null>;
  close(): Promise<void>;
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
  diskWriter?: EngineDiskWriter;
}): Promise<LiveDaemonCapture> {
  const workspace = await openLiveDaemonWorkspace(input, { maxRestarts: 0,
    allowInsecureLoopbackForTests: new URL(input.relay.baseUrl).protocol === "http:" });
  const capture = createWorkspaceEngineCapture({
    ...workspace.workspace,
    rustEngineSessions: workspace.sessions,
    ...(input.diskWriter ? { diskWriter: input.diskWriter } : {}),
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
    capturedContents: path => readCapturedContents(workspace, input.workspaceId, path),
    queryCollectionRecords: query => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new VersionedLiveAdapter(client, handle, { workspaceId: input.workspaceId }).queryCollectionRecords(query)),
    refusalNotices: () => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {
        workspaceId: input.workspaceId,
      }, { workspace: handle }),
    ),
    close: async () => {
      try {
        await capture.stop();
      } finally {
        await workspace.close();
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
  diskWriter?: EngineDiskWriter;
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
    ...(input.diskWriter ? { diskWriter: input.diskWriter } : {}),
  });
  return {
    capture,
    chats: workspace.chats,
    relay,
    capturedContents: path => readCapturedContents(workspace, input.workspaceId, path),
    queryCollectionRecords: query => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new VersionedLiveAdapter(client, handle, { workspaceId: input.workspaceId }).queryCollectionRecords(query)),
    refusalNotices: () => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {
        workspaceId: input.workspaceId,
      }, { workspace: handle }),
    ),
    close: async () => {
      try {
        await capture.stop();
      } finally {
        await workspace.close();
      }
    },
  };
}

async function readCapturedContents(workspace: Awaited<ReturnType<typeof openLiveDaemonWorkspace>>, workspaceId: string, path: string) {
  return workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) => {
    const adapter = new VersionedLiveAdapter(client, handle, { workspaceId });
    if (classifyEngineFilePath(path).kind === "secret") {
      const secret = await adapter.materializeSecretFile({ workspaceId, versionId: "main", path });
      return secret.present ? Buffer.from(secret.text) : null;
    }
    const head = await adapter.readTextFile({ workspaceId, versionId: "main", path });
    if (!head) return null;
    if (head.contentKind === "binary") {
      const bytes = await adapter.readBinaryFile({ workspaceId, versionId: "main", path });
      return bytes === null ? null : Buffer.from(bytes);
    }
    return head.text === null ? null : Buffer.from(head.text);
  });
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
  await expect.poll(() => daemon.capturedContents(path), {
    message: `capture must record the expected contents of ${path}`,
    timeout: REAL_DAEMON_DEADLINE_MS,
  }).toEqual(Buffer.from(contents));
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
  const pull = await daemon.capture.runRelaySync((materializePage) =>
    daemon.relay.pull(materializePage),
  );
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
  const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
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
      await capture.runRelaySync(page => relay.pull(page));
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
          await capture!.runRelaySync(page => relay.pull(page));
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
          await recipient!.capture.runRelaySync(page => recipient!.relay.pull(page));
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

it.skipIf(engine.missing).each([
  { name: "existing id", hasId: true, body: "# Keep this body\n", stopQuarantine: false },
  { name: "id-less canonical", hasId: false, body: "# Body\n", stopQuarantine: false },
  { name: "id-less non-canonical", hasId: false, body: "A setext heading\n================\n\n* first\n* second\n", stopQuarantine: false },
  { name: "quarantine", hasId: true, body: "# Keep this body\n", stopQuarantine: true },
  { name: "stale-binding quarantine", hasId: true, body: "# Keep this body\n", stopQuarantine: true },
  { name: "offline stop", hasId: true, body: "# Keep this body\n", stopQuarantine: true },
  { name: "deferred resume", hasId: true, body: "# Keep this body\n", stopQuarantine: true },
])("settles open Collection adoption with native owner delivery and recipient sync ($name)", async ({ name, hasId, body: originalBody, stopQuarantine }) => {
  const canonical = markdownToYDoc(originalBody);
  const body = name === "id-less canonical" ? yDocToMarkdown(canonical) : originalBody;
  canonical.destroy();
  const workspaceId = name === "stale-binding quarantine" ? "native-stale-quarantine" : `native-open-adoption-${name.replaceAll(" ", "-")}`;
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
  let resumedFeed: ReturnType<typeof proxy.holdNextHostedLogResponse> | undefined;
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
        await capture!.runRelaySync(materializePage => relay.pull(materializePage));
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
    const refusedDb = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
    const seedRefusals: Array<{originId: string; originSeq: number}> = [];
    try {
      const refused = refusedDb.prepare("SELECT p.origin_id,p.origin_seq,p.authors_json,r.payload_json FROM live_settlement_publication_admissions p JOIN replication_log r USING(workspace_id,origin_id,origin_seq) WHERE p.workspace_id=? AND json_extract(p.admission_json,'$.status')='refused'").all(workspaceId);
      expect(refused).toHaveLength(hasId ? 0 : 1);
      for (const row of refused) {
        const payload = JSON.parse(String(row.payload_json));
        // The unchanged seed has no journal interval. The later adoption does.
        expect(payload.settlementReference.record).toMatchObject({previousCursor: 0, terminalCursor: 0, applicationCount: 0});
        expect(payload.payloadBeforeBlobSha256).toBe(payload.payloadAfterBlobSha256);
        expect(payload.authors).toBeUndefined();
        expect(row.authors_json).toBeNull();
        seedRefusals.push({originId: String(row.origin_id), originSeq: Number(row.origin_seq)});
      }
    } finally {refusedDb.close();}
    expect(await source.sessions.run(source.workspace, async ({client, workspace}) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {workspaceId}, {workspace}))).toEqual({
        notices: seedRefusals.map(coordinate => expect.objectContaining({...coordinate,
          document: expect.objectContaining({path}), refusalCoordinates: [coordinate]})),
      });
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
          await capture!.runRelaySync(materializePage => relay.pull(materializePage));
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
      await peer!.capture.runRelaySync(materializePage => peer!.relay.pull(materializePage));
      return readFile(join(rootB, path), "utf8");
    }, {timeout: 120_000}).toBe(markdown);
    expect(await source.sessions.run(source.workspace, async ({client, workspace}) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {workspaceId}, {workspace}))).toEqual({
        notices: seedRefusals.map(coordinate => expect.objectContaining({...coordinate,
          document: expect.objectContaining({path}), refusalCoordinates: [coordinate]})),
      });
    expect(errors).toEqual([]);
    if (stopQuarantine) {
      await delivery?.stop(); delivery = undefined;
      const offlineStop = name === "offline stop";
      const deferredResume=name==="deferred resume";
      const quarantineReason = name === "stale-binding quarantine" ? "stale-binding" : "delivery-conflict";
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
      let offline = offlineStop;
      const ownerHandlers = createRelaySharesIpcHandlers({
        remoteForWorkspace: async () => ({credentials, credentialGeneration: 1}), currentCredentialGeneration: () => 1,
        currentCredentials: () => credentials, warmCredentialCache: async () => {}, relayShareJson: unexpected,
        relayShareJsonWithCredentials: async <R,>(_credentials: unknown, endpoint: string, init?: RequestInit): Promise<R> => {
          if (offline) throw new Error("offline");
          const response = await fetch(`${proxy.origin}${endpoint}`, {...init, headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"}});
          expect(response.ok).toBe(true); return await response.json() as R;
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
        }, withoutEditors: (_workspace, _path, change) => change(), ownerLiveQuarantines: () => [], unwrittenOwnerLiveReleases: async () => [], retryOwnerLiveQuarantine: unexpected, retryOwnerLiveRelease: unexpected, saveOwnerLiveRecoveryCopy: unexpected,
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
      // The document's state in the session host's store.
      const hostDocumentState = async () => {
        const stores = join(relayRoot, "relay-deployment", "live-host");
        const store = (await readdir(stores)).find(entry => /^[0-9a-f]{64}$/u.test(entry));
        if (!store) return undefined;
        const db = new DatabaseSync(join(stores, store, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
        try {return (db.prepare("SELECT state FROM hosted_documents WHERE object_id=?").get(document.binding.objectId) as {state: string} | undefined)?.state;}
        finally {db.close();}
      };
      // The session host either parks the stopped document before Resume, or
      // pulls nothing between Stop and Resume and still holds it ready.
      const hostReadyAtResume = name === "stale-binding quarantine";
      if (hostReadyAtResume) {
        preStopFeed = proxy.holdNextHostedLogResponse(workspaceId);
        const response = await waitForHostedLog(preStopFeed, preStopFeed.captured, "pre-Stop capture");
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ ok: true,
          scope: { documents: expect.arrayContaining([{ objectId: document.binding.objectId, path }]) } });
        expect(await hostDocumentState()).toBe("ready");
      }
      if (offlineStop) {
        await expect(stop()).rejects.toThrow("Stop live editing is waiting.");
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
          await capture!.flush();await pushUntilDrained(relay);await peer!.capture.runRelaySync(page=>peer!.relay.pull(page));
          return readFile(join(rootB,path),"utf8");
        },{timeout:120_000}).toContain("Name: Deferred edit 31");
        return;
      }
      await expect(readPending()).rejects.toThrow("owner-outbox-not-found");
      expect(await readFile(join(rootA, path), "utf8")).toContain(offlineStop ? "Name: Offline while stopping" : "Name: Quarantined edit");
      const releasedMoment = (await capture.listMoments({limit: 100})).moments.find(moment => moment.path === path);
      expect(releasedMoment?.authors).toContainEqual({kind: "human", humanId: "local-person"});
      if (!hostReadyAtResume) await expect.poll(hostDocumentState, {timeout: 120_000}).toBe("parked");
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
          await peer!.capture.runRelaySync(page => peer!.relay.pull(page));
          return readFile(join(rootB, path), "utf8");
        }, {timeout: 120_000}).toContain(`Name: ${value}`);
      };
      await editOrdinary("Local after stop", "after-stop");
      const liveRow = async () => {
        const ready = (await discovery()).some(row => row.binding.currentPath === path);
        const row = (discoveryPayload as {documents: Array<{path: string}>}).documents.find(row => row.path === path);
        return {ready, row};
      };
      const unadmitted = {ready: false, row: {path, objectId: document.binding.objectId, status: "unavailable", reason: "live-edit-unadmitted"}};
      // The operator's reports that the host's copy misses the owner's edit.
      const reports = () => relayServer!.diagnostics().stderr
        .split(`Live editing of ${path} in workspace ${workspaceId} cannot resume: the document changed while live editing was off`).length - 1;
      await resume();
      if (preStopFeed) {
        // Finish the pre-Stop pass, then hold the fresh feed before it can fence the stale copy.
        resumedFeed = proxy.holdNextHostedLogResponse(workspaceId);
        preStopFeed.release();
        try { await waitForHostedLog(preStopFeed, preStopFeed.delivered, "pre-Stop delivery"); }
        catch (error) {
          // A timed-out host retries through the queued pull and the fresh-response barrier.
          if (!(error instanceof HostedLogClientClosedError)) throw error;
        }
        expect((await waitForHostedLog(resumedFeed, resumedFeed.captured, "resumed capture")).status).toBe(200);
        expect(await hostDocumentState()).toBe("ready");
        resumedFeed.release();
        await waitForHostedLog(resumedFeed, resumedFeed.delivered, "resumed delivery");
      }
      await expect.poll(liveRow, {timeout: 120_000}).toEqual(unadmitted);
      expect(await hostDocumentState()).toBe("held");
      await expect.poll(reports, {timeout: 60_000}).toBe(1);
      // A Resume tries once more and blocks again. The copy is never ready.
      await resume();
      await expect.poll(async () => {
        expect((await liveRow()).ready).toBe(false);
        return reports();
      }, {timeout: 120_000}).toBe(2);
      expect(await liveRow()).toEqual(unadmitted);
      // The owner keeps editing the file, and the peer gets each edit through ordinary sync.
      await editOrdinary("Local while blocked", "while-blocked");
      // A relay restart starts the session host from its store, which still holds the document.
      await relayServer.stop();
      relayServer = await spawnSyncRelay(relayOptions);
      proxy.routeRelayTo(relayServer.baseUrl);
      await expect.poll(async () => {
        expect((await liveRow()).ready).toBe(false);
        return reports();
      }, {timeout: 120_000}).toBe(1);
      expect(await liveRow()).toEqual(unadmitted);
      expect(await hostDocumentState()).toBe("held");
      await resume();
      await expect.poll(async () => {
        expect((await liveRow()).ready).toBe(false);
        return reports();
      }, {timeout: 120_000}).toBe(2);
      expect(await liveRow()).toEqual(unadmitted);
      // Another document of the workspace still starts live editing.
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
      await expect.poll(async () => (await discovery()).map(row => row.binding.currentPath), {timeout: 120_000}).toEqual([other]);
      expect(await liveRow()).toEqual(unadmitted);
    }
    await session.close({settle: false});
  } finally {
    preStopFeed?.destroy(); resumedFeed?.destroy();
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
    starting = spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
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
        const echo = await capture.runRelaySync(materializePage => relay.pull(materializePage));
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
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
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
      const pull = await receiver.capture.runRelaySync((materializePage) =>
        receiver.relay.pull(materializePage),
      );

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
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
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
      await daemonA.capture.runRelaySync((materializePage) =>
        daemonA!.relay.pull(materializePage),
      );
      await daemonB.capture.runRelaySync((materializePage) =>
        daemonB!.relay.pull(materializePage),
      );
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
      await daemonB.capture.runRelaySync((materializePage) =>
        daemonB!.relay.pull(materializePage),
      );

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
        await daemonB.capture.runRelaySync((materializePage) =>
          daemonB!.relay.pull(materializePage),
        );
        await vi.waitFor(() => expect(shown(editorB)).toBe(afterA), arrival);
        await typeAtEnd(editorB, "continued on B\n");
        expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
        await daemonA.capture.runRelaySync((materializePage) =>
          daemonA!.relay.pull(materializePage),
        );
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
      await daemonC.capture.runRelaySync((materializePage) =>
        daemonC!.relay.pull(materializePage),
      );
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
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    const editors: OpenEditor[] = [];
    const pull = (daemon: LiveDaemonCapture) =>
      daemon.capture.runRelaySync((materializePage) =>
        daemon.relay.pull(materializePage),
      );
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
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
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

      await daemonA.capture.runRelaySync((materializePage) =>
        daemonA!.relay.pull(materializePage),
      );
      const conflictPage = await daemonA.capture.listOpenConflictsPage();
      const conflict = conflictPage.conflicts.find((entry) => entry.path === path);
      expect(conflict).toBeDefined();
      expect(conflict?.current.text).toBe("edit from A\n");
      expect(conflict?.incoming.text).toBe("edit from B\n");
      expect(await readFile(join(rootA, path), "utf8"), "A keeps its local edit before conflict resolution").toBe("edit from A\n");

      await daemonA.capture.resolveConflict(conflict!.id, {
        kind: "apply-incoming",
      });
      expect(await readFile(join(rootA, path), "utf8"), "A applies B's incoming edit").toBe("edit from B\n");
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);

      await daemonB.capture.runRelaySync((materializePage) =>
        daemonB!.relay.pull(materializePage),
      );
      expect(await readFile(join(rootB, path), "utf8"), "B keeps the resolved edit after pulling").toBe("edit from B\n");
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);

      await daemonB.close();
      daemonB = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      expect(await readFile(join(rootB, path), "utf8"), "B keeps the resolved edit after reopening").toBe("edit from B\n");
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);

it.skipIf(engine.missing)("capture ignores a crashed sibling and records only whole replacements", async () => {
  const root = await createTestScratch("dohc-whole-capture-");
  const path = "note.txt";
  const target = join(root, path);
  const previous = "previous\n";
  const next = "next\n".repeat(100_000);
  const daemon = await openLiveDaemonCapture({ workspaceId: "whole-replace", rootPath: root, relay: { baseUrl: "http://127.0.0.1:1", token: "test:whole-replace" } });
  let daemonClosed = false;
  let child: ReturnType<typeof fork> | undefined;
  try {
    await writeAndCapture(daemon, root, path, previous);
    const temporary = join(root, ".dohc-write-crashed");
    const childPath = join(root, ".dohc-write-child.mjs");
    await writeFile(childPath, `
      import { open } from 'node:fs/promises';
      import { atomicReplaceFile } from ${JSON.stringify(new URL("../atomicReplaceFile.ts", import.meta.url).href)};
      await atomicReplaceFile(${JSON.stringify(target)}, async temporary => {
        const handle = await open(temporary, 'wx');
        await handle.writeFile(${JSON.stringify(next)}); await handle.sync(); await handle.close();
        process.send('staged'); await new Promise(() => {});
      }, { temporary: ${JSON.stringify(temporary)} });
    `);
    child = fork(childPath, [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    await once(child, "message");
    child.kill("SIGKILL");
    await once(child, "exit");
    expect(await readFile(target, "utf8")).toBe(previous);
    expect(await readFile(temporary, "utf8")).toBe(next);
    await daemon.capture.resyncFileObservation();
    await daemon.capture.flush();
    expect((await daemon.capture.listMoments({ limit: 100 })).moments.map(moment => moment.path)).toEqual([path]);
    const staged = deferred<void>();
    const release = deferred<void>();
    const writer = createDefaultDiskWriter(root, { rename: async (from, to) => {
      staged.resolve();
      await release.promise;
      await rename(from, to);
    } });
    const writing = writer.writeTextFile(target, next);
    try {
      await staged.promise;
      await daemon.capture.resyncFileObservation();
      await daemon.capture.flush();
      expect(await daemon.capturedContents(path)).toEqual(Buffer.from(previous));
      expect(await readFile(target, "utf8")).toBe(previous);
    } finally { release.resolve(); await writing; }
    await waitForPathMoments(daemon.capture, path, 2);
    expect((await daemon.capturedContents(path))?.equals(Buffer.from(next))).toBe(true);
    const moments = (await daemon.capture.listMoments({ limit: 100 })).moments;
    expect(moments.every(moment => moment.path === path)).toBe(true);
    for (const summary of moments) {
      const detail = await daemon.capture.readMoment(summary.id);
      expect(detail && !detail.protected && [previous, next].includes(detail.moment.payload.after.text), `whole contents for ${summary.id}`).toBe(true);
    }
    expect(await readFile(target, "utf8")).toBe(next);
    expect(await readFile(temporary, "utf8")).toBe(next);
    await daemon.close();
    daemonClosed = true;
    const reopened = await openLiveDaemonCapture({ workspaceId: "whole-replace", rootPath: root, relay: { baseUrl: "http://127.0.0.1:1", token: "test:whole-replace" } });
    try {
      await reopened.capture.flush();
      expect(await readFile(temporary, "utf8")).toBe(next);
      expect((await reopened.capture.listMoments({ limit: 100 })).moments.every(moment => moment.path === path)).toBe(true);
    } finally { await reopened.close(); }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    if (!daemonClosed) await daemon.close();
  }
}, 90_000);

it.skipIf(engine.missing).each(["before-rename", "after-rename"] as const)(
  "replays an interrupted protected restore on reopen (%s)", async interruption => {
    const workspaceId = `atomic-secret-${interruption}`;
    const root = await createTestScratch("dohc-secret-replay-");
    const path = ".env";
    const relay = { baseUrl: "http://127.0.0.1:1", token: `test:${workspaceId}` };
    let interrupt = false;
    let daemon: LiveDaemonCapture | undefined;
    const writer = createDefaultDiskWriter(root, { rename: async (from, to) => {
      if (interrupt && interruption === "before-rename") throw new Error("interrupted before rename");
      await rename(from, to);
      if (interrupt) throw new Error("interrupted after rename");
    } });
    try {
      daemon = await openLiveDaemonCapture({ workspaceId, rootPath: root, relay, diskWriter: writer });
      await writeAndCapture(daemon, root, path, "VALUE=previous\n");
      await writeAndCapture(daemon, root, path, "VALUE=current\n");
      const changed = (await daemon.capture.listMoments({ limit: 100 })).moments.find(moment => moment.path === path)!;
      interrupt = true;
      await expect(daemon.capture.restoreFileToBeforeMoment(changed.id, { kind: "human", humanId: "synthetic-person" })).rejects.toThrow(`interrupted ${interruption.replace("-", " ")}`);
      expect(await readFile(join(root, path), "utf8")).toBe(interruption === "before-rename" ? "VALUE=current\n" : "VALUE=previous\n");
      await daemon.close(); daemon = undefined;
      daemon = await openLiveDaemonCapture({ workspaceId, rootPath: root, relay });
      await daemon.capture.flush();
      expect(await readFile(join(root, path), "utf8")).toBe("VALUE=previous\n");
      expect((await daemon.capture.listKeptCopies()).keptCopies).toEqual([]);
      expect((await readdir(root)).filter(name => name !== ".dohc")).toEqual([path]);
    } finally { await daemon?.close(); }
  }, 90_000,
);

it.skipIf(engine.missing).each(["before-rename", "after-rename"] as const)(
  "replays an interrupted conflict choice on reopen (%s)", async interruption => {
    const workspaceId = `atomic-conflict-${interruption}`;
    const token = `test:${workspaceId}`;
    const path = "note.txt";
    const rootA = await createTestScratch("dohc-conflict-replay-a-");
    const rootB = await createTestScratch("dohc-conflict-replay-b-");
    const relayRoot = await createTestScratch("dohc-conflict-replay-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
    let a: LiveDaemonCapture | undefined;
    let b: LiveDaemonCapture | undefined;
    let interrupt = false;
    const writer = createDefaultDiskWriter(rootA, { rename: async (from, to) => {
      if (interrupt && interruption === "before-rename") throw new Error("interrupted before rename");
      await rename(from, to);
      if (interrupt) throw new Error("interrupted after rename");
    } });
    try {
      a = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: { baseUrl: relay.baseUrl, token }, diskWriter: writer });
      await a.relay.claim();
      await writeAndCapture(a, rootA, path, "base\n");
      await pushUntilDrained(a.relay);
      b = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: { baseUrl: relay.baseUrl, token } });
      await pullAndExpect(b, rootB, path, "base\n");
      await writeAndCapture(a, rootA, path, "local\n");
      await writeAndCapture(b, rootB, path, "incoming\n");
      await pushUntilDrained(a.relay); await pushUntilDrained(b.relay);
      await a.capture.runRelaySync(page => a!.relay.pull(page));
      const conflict = (await a.capture.listOpenConflictsPage()).conflicts.find(entry => entry.path === path)!;
      expect(conflict).toBeDefined();
      interrupt = true;
      await expect(a.capture.resolveConflict(conflict.id, { kind: "apply-incoming" })).rejects.toThrow(`interrupted ${interruption.replace("-", " ")}`);
      expect(await readFile(join(rootA, path), "utf8")).toBe(interruption === "before-rename" ? "local\n" : "incoming\n");
      await a.close(); a = undefined;
      a = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: { baseUrl: relay.baseUrl, token } });
      await a.capture.flush();
      expect(await readFile(join(rootA, path), "utf8")).toBe("incoming\n");
      expect(await a.capture.countOpenConflicts()).toBe(0);
      expect((await a.capture.listKeptCopies()).keptCopies).toEqual([]);
      expect((await readdir(rootA)).filter(name => name !== ".dohc")).toEqual([path]);
    } finally {
      await Promise.allSettled([a?.close(), b?.close()]);
      await relay.stop();
    }
  }, 90_000,
);

it.skipIf(engine.missing)("pulls a relay page again after a blocked replacement is released", async () => {
  const workspaceId = "atomic-relay-replay";
  const token = `test:${workspaceId}`;
  const path = "note.txt";
  const rootA = await createTestScratch("dohc-relay-replay-a-");
  const rootB = await createTestScratch("dohc-relay-replay-b-");
  const relayRoot = await createTestScratch("dohc-relay-replay-relay-");
  const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
  let a: LiveDaemonCapture | undefined;
  let b: LiveDaemonCapture | undefined;
  let blocked = false;
  const replace = vi.fn(async (from: string, to: string) => {
    if (blocked) throw Object.assign(new Error("held open"), { code: "EPERM" });
    await rename(from, to);
  });
  try {
    a = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: { baseUrl: relay.baseUrl, token } });
    await a.relay.claim();
    await writeAndCapture(a, rootA, path, "previous\n");
    await pushUntilDrained(a.relay);
    b = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: { baseUrl: relay.baseUrl, token },
      diskWriter: createDefaultDiskWriter(rootB, { rename: replace, platform: "win32", wait: async () => {} }) });
    await pullAndExpect(b, rootB, path, "previous\n");
    await writeAndCapture(a, rootA, path, "next\n");
    await pushUntilDrained(a.relay);
    blocked = true; replace.mockClear();
    await expect(b.capture.runRelaySync(page => b!.relay.pull(page))).rejects.toThrow("Could not update note.txt on disk: held open");
    expect(replace).toHaveBeenCalledTimes(6);
    expect(await readFile(join(rootB, path), "utf8")).toBe("previous\n");
    expect((await readdir(rootB)).filter(name => name.startsWith(".dohc-write-"))).toEqual([]);
    blocked = false;
    const retry = await b.capture.runRelaySync(page => b!.relay.pull(page));
    expect(retry.fastForwardedPaths.some(change => change.path === path)).toBe(true);
    expect(await readFile(join(rootB, path), "utf8")).toBe("next\n");
  } finally {
    await Promise.allSettled([a?.close(), b?.close()]); await relay.stop();
  }
}, 90_000);

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
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
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
  const dbPath = join(relayRoot, "relay.sqlite"), path = "withheld.txt";
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
  const dbPath = join(relayRoot, "relay.sqlite");
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
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
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
        await daemonA.capture.runRelaySync((page) => daemonA!.relay.pull(page));
        const sourceEditor = await openEditor(daemonA, path);
        try {
          await typeAtEnd(sourceEditor, "origin after artifact\n");
          expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
          await daemonB.capture.runRelaySync((page) => daemonB!.relay.pull(page));
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
      await daemonB.capture.runRelaySync((page) => daemonB!.relay.pull(page));
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
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
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
      await daemonB.capture.runRelaySync((materializePage) =>
        daemonB!.relay.pull(materializePage),
      );
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
  const relayServer = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite"), compiledMain: compiledRelayMain });
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
    await peer.capture.runRelaySync(materialize => peer!.relay.pull(materialize));
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
      await capture.runRelaySync(materialize => relay.pull(materialize));
      await pushUntilDrained(relay);
      await peer.relay.pull(async () => undefined);
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
