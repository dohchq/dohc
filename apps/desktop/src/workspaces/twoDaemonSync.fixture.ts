
import { randomUUID } from "node:crypto";

import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { mintLocalhostCa } from "../../../../services/share-web/src/testing/localhostCa";
import { startServerProxy, type HostedLogResponseBarrier } from "../../e2e/helpers/selfHostOnboarding";
import { DatabaseSync } from "node:sqlite";

import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { buildRelay } from "../../../../services/sync-relay/scripts/build.mjs";

import * as Y from "yjs";

import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";

import { OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";

import { DaemonRefusalError, VersionedLiveAdapter, WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";

import { openLiveDaemonWorkspace, type CloseStep } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";

import type { EngineRelayWorkspaceClient } from "./engineRelayClient";
import type { DesktopLinkedChatStore } from "./liveLinkedChatStore";
import { probeRelayWorkspace } from "./relayWorkspaceProbe";
import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { waitForCapturedContents, waitForPathMoments } from "./waitForPathMoments";

import { createTestScratch } from "./testTemp";

import { installWorkspaceDataKey, loadSecretDataKey, SECRET_FILE_STORE_RELATIVE_PATH } from "./workspaceDataKey";
import { enrollWorkspaceKeyEnvelope } from "./workspaceKeyEnvelopeEnrollment";
import { bootstrapJoinedWorkspace } from "./workspaceJoinEnrollment";

import { selfHostLiveProfile } from "../../../../services/sync-relay/src/selfHostLiveProfile";
import { runNativeOwnerDeliveryPass } from "./nativeOwnerDelivery";
import { readOwnerLiveQuarantines } from "./ownerLiveQuarantine";
import { readyOwnerDeliveryDocuments } from "./serverOwnerDelivery";

import { relayShareOperations } from "../ipc/shareOperations";
import type { OwnerLiveDocumentsResult } from "../ipc/bridgeContract";
import { registerOperations } from "../ipc/operationTable";
import { createRelaySharesIpcHandlers } from "../ipc/relaySharesIpc";
import { liveStopRelayError } from "../ipc/liveEditingStop";
import { createPresencePollRegistry } from "../collab/presencePollRegistry";
import { reconcileOwnerLiveStops } from "./ownerLiveStop";

import { deleteWorkspacePathByHand, moveWorkspacePathByHand } from "./workspaceFileMoves";
import { readLocalStateFrom, type LocalStateBindings } from "./workspaceLocalState";

export const engine = requireEngineBinaryOrSkip();

export async function waitForHostedLog<T>(barrier: HostedLogResponseBarrier, promise: Promise<T>, phase: string): Promise<T> {
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
export let compiledRelayMain: string;

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

export interface LiveDaemonCapture {
  capture: WorkspaceEngineCapture;
  chats: DesktopLinkedChatStore;
  relay: EngineRelayWorkspaceClient;
  refusalNotices(): Promise<unknown>;
  queryCollectionRecords: VersionedLiveAdapter["queryCollectionRecords"];
  // What the desktop does first at quit.
  beginShutdown(): void;
  close(step?: CloseStep): Promise<void>;
}

export function pullCaptured(relay: EngineRelayWorkspaceClient, capture: WorkspaceEngineCapture) {
  return relay.pull(apply => capture.runRelaySync(apply));
}

export async function pushUntilDrained(relay: EngineRelayWorkspaceClient) {
  let result = await relay.push();
  let pushed = result.pushed;
  while (result.hasMore) {
    result = await relay.push();
    pushed += result.pushed;
  }
  return { ...result, pushed };
}

export async function openLiveDaemonCapture(input: {
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

export async function openJoinedDaemonCapture(input: {
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

export async function writeAndCapture(
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
  await waitForCapturedContents(daemon.capture, path, contents, before + 1);
}

export async function openIndependentPlaintextLineage(
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

export async function pullAndExpect(
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

export async function expectTwoDaemonFileSync(input: {
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

// A stale ready copy at Resume is covered by the relay test "captures a retired
// activation's successor only after a hosted pull that started after Resume".
export const heldStopCase = "stale-binding quarantine, Stop refused while the host is held";

export interface OpenEditor {
  session: Awaited<ReturnType<WorkspaceEngineCapture["openYDocSession"]>>;
  // What the renderer holds: the opening state plus every remote update.
  doc: Y.Doc;
}

export async function openEditor(daemon: Pick<LiveDaemonCapture, "capture">, path: string): Promise<OpenEditor> {
  const doc = new Y.Doc();
  const session = await daemon.capture.openYDocSession({
    path,
    contentKind: "plaintext",
    onRemoteUpdate: (update) => Y.applyUpdate(doc, update),
  });
  Y.applyUpdate(doc, session.initialUpdate);
  return { session, doc };
}

export async function typeAtEnd(editor: OpenEditor, text: string): Promise<void> {
  const typed = editor.doc.getText("plainText");
  const before = Y.encodeStateVector(editor.doc);
  typed.insert(typed.length, text);
  void editor.session.applyLocalUpdate(Y.encodeStateAsUpdate(editor.doc, before));
  await editor.session.settleNow();
}

export function shown(editor: OpenEditor): string {
  return editor.doc.getText("plainText").toString();
}

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

export async function runRenameRepros(cases: RenameReproCase[]): Promise<void> {
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

// dohc refuses to delete a page that native owner delivery has bound, so its workspace keeps
// publishing. Each case removes A, then creates B and saves C; each observation prints as one `REPRO-OBS` line.
type DeleteReproCase = "bound" | "unbound" | "restore" | "stop-then-delete" | "deferred-stop" | "file-manager" | "file-manager-capture"
  | "file-manager-restore" | "file-manager-stop" | "file-manager-capture-stop-early" | "file-manager-capture-stop";
const ownedDeleteRefusal = (action: "delete" | "restore") => `LivePageOwnedError: dohc can't ${action} "${renameRepro.oldPath}" while it has live editing on
In Live documents, stop live editing for this page, then ${action} it again.`;

async function runDeleteRepro(kind: DeleteReproCase, ca: Awaited<ReturnType<typeof mintLocalhostCa>>,
  trustEnv: Record<string, string>, localStates: Map<string, LocalStateBindings>): Promise<void> {
  const { oldPath, newPage, existing } = renameRepro;
  const workspaceId = `repro-delete-${kind}-${randomUUID().slice(0, 8)}`;
  const bound = kind !== "unbound";
  // A starts as a file saved outside dohc, so capture writes its head.
  const captured = kind === "file-manager-capture" || kind === "file-manager-capture-stop-early" || kind === "file-manager-capture-stop";
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
    if (captured) {
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
      if (captured) {
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

    if (kind === "file-manager-stop" || kind === "file-manager-capture-stop-early" || kind === "file-manager-capture-stop") {
      // Step 2: A's file goes from disk outside dohc while live editing is on (#3129).
      // "file-manager-capture-stop-early" stops before capture can record the delete.
      step = "2-file-manager-delete";
      await unlink(join(rootA, oldPath));
      if (kind !== "file-manager-capture-stop-early") {
        pages.observeFileEvents([{ path: oldPath, operation: "delete" }]);
        if (captured) await expect.poll(deletesOfA, { timeout: 30_000, interval: 250 }).toBeGreaterThan(0);
        else await pages.flush();
      }
      const atStop = { head: headOfA(), deletesOfA: await deletesOfA(), ownerA: ownerRowsOfA(), liveRow: await liveRowOfA() };
      observe({ atStop, onDisk: await onDisk() });

      // Step 3: Stop live editing on A's row, as its Stop button does.
      step = "3-stop";
      const stopped = await stopViaApp({ path: oldPath, objectId: objectIdA })
        .then(result => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error: reproErrorText(error) }));
      const after = { ownerA: ownerRowsOfA(), serverA: await serverRowsOfA(), liveRow: await liveRowOfA(), owedStops: await owedStopsOfA() };
      observe({ stopped, ...after });
      // Live editing stops for A, and Stop says so.
      expect({ stopped, atStop: { head: atStop.head, deletesOfA: atStop.deletesOfA, bound: atStop.ownerA.ownerBindings.length > 0 }, after },
        `${kind}: Stop live editing says it stopped`).toMatchObject({ stopped: { ok: true } });
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

export async function runDeleteRepros(cases: DeleteReproCase[]): Promise<void> {
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
