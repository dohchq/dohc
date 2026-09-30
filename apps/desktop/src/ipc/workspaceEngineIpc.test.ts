import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { CollectionGetRecordResult } from "@dohc/workspace-contracts";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createWorkspaceEngineIpc } from "./workspaceEngineIpc";
import { CHANNELS } from "./channels";
import type { RebuildEngineStoreResult, SyncStatusResult } from "./bridgeContract";
import { createWorkspaceAuthorityOwner, type WorkspaceAuthorityLease } from "../workspaces/workspaceAuthorityOwner";
import { runInWorkspaceAuthorityLane } from "../workspaces/workspaceAuthorityLane";
import { RendererWorkspaceSessionOwner } from "../window/rendererWorkspaceSessionOwner";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import { createReceivedShareEngineAccess } from "../workspaces/receivedShareEngineAccess";
import { createEngineYDocSessionIpc, type EngineYDocIpcSender } from "../workspaces/engineYDocSessionIpc";
import type { WorkspaceEngineCapture, WorkspaceEngineYDocProviderSession, probeEngineStoreRefusal } from "../workspaces/workspaceEngineCapture";
import { EngineStoreRecoveryFailedError } from "../workspaces/engineStoreRebuild";
import type { RegistryEntry } from "../workspaces/registryStore";
import { deferred } from "../testing/deferred";
import { createServerRuns, type ServerAnswer, type ServerRequest } from "../automations/serverRuns";

type ServerReply = Omit<NonNullable<ServerAnswer>, "asker"> | null;

class Sender implements EngineYDocIpcSender {
  constructor(readonly id: number) {}
  isDestroyed() { return false; }
  send = vi.fn<(channel: string, payload: unknown) => void>();
  once(_event: "destroyed", _listener: () => void): this { return this; }
}

type State = {
  operationLanes: Map<string, Promise<void>>;
  lastEngineStoreRebuildResult: RebuildEngineStoreResult | null;
};
const healthy: SyncStatusResult = { state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null, historyRecordingUnavailable: false, historyShareView: false, liveSessionsGeneration: 0 };
const refused: SyncStatusResult = { ...healthy, historyCaptureFailed: true, engineStoreRefused: "foreign-database" };
const openPayload = { workspaceId: "workspace", sessionId: "renderer-session", path: "notes/a.md" };
const descriptor = { id: "image", mimeType: "image/png", created: 1, ref: "assets/image.png", sha256: "a".repeat(64) };

async function harness() {
  const workspace: RegistryEntry = { workspaceId: "workspace", rootPath: "C:/alias", kind: "personal", mode: "local-first" };
  // Open and writable, but not the workspace this renderer shows.
  const other: RegistryEntry = { workspaceId: "other", rootPath: "C:/other", kind: "personal", mode: "local-first" };
  const sender = new Sender(7);
  const events: string[] = [];
  const authority = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => id === workspace.workspaceId ? workspace : id === other.workspaceId ? other : null,
    canonicalizeRoot: (root) => root === other.rootPath ? "C:/other-canonical" : "C:/canonical",
    createState: (): State => ({ operationLanes: new Map(), lastEngineStoreRebuildResult: null }),
  });
  const canonicalWorkspaceFor = vi.fn((lease: WorkspaceAuthorityLease<RegistryEntry, State>) => {
    lease.assertCurrent();
    return { ...workspace, rootPath: lease.binding.canonicalRootPath, attachmentId: lease.binding.attachmentId };
  });
  const held = authority.acquire(workspace.workspaceId);
  const physical = canonicalWorkspaceFor(held);
  held.release();
  canonicalWorkspaceFor.mockClear();
  const renderers = new RendererWorkspaceSessionOwner<Sender>({
    retirement: {
      retireSender: () => ({ requiredForAdmission: Promise.resolve(), detachedFromAdmission: Promise.resolve() }),
      retireWorkspace: async () => undefined,
    },
  });
  await renderers.open(sender, physical, "document-1");
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<
    Sender, RegistryEntry & { attachmentId: symbol }, State,
    NonNullable<ReturnType<typeof renderers.current>>
  >({
    currentSession: (value: Sender) => renderers.current(value),
    withPhysicalOperation: authority.withOperation.bind(authority),
  });
  const sessions = new EngineWorkspaceSessions({ currentClient: () => { throw new Error("daemon boundary"); } });
  const receivedShareEngine = createReceivedShareEngineAccess({
    sessions: () => sessions,
    relayClient: () => { throw new Error("unused relay"); },
    createStores: () => { throw new Error("unused stores"); },
  });
  const provider = {
    doc: new Y.Doc(), initialUpdate: new Uint8Array(), path: "notes/a.md", contentKind: "richdoc",
    artifactAssets: [descriptor],
    settleNow: vi.fn(async () => { throw new Error("unused settlement"); }),
    applyLocalUpdate: vi.fn((_update, onArmed) => onArmed?.()),
    applyDecidedLocalUpdate: vi.fn(async () => false),
    readArtifactAsset: vi.fn(async (value) => ({ descriptor: value, bytes: new Uint8Array([1, 2, 3]) })),
    close: vi.fn(async () => undefined),
  } satisfies WorkspaceEngineYDocProviderSession;
  const openYDocSession = vi.fn<WorkspaceEngineCapture["openYDocSession"]>(async () => provider);
  const ydoc = createEngineYDocSessionIpc({
    localPersonId: () => "person-local",
    sessionFor: (value) => value === sender ? renderers.current(sender) : undefined,
    acquireWorkspace: (id) => {
      const lease = authority.acquire(id);
      return { workspace: canonicalWorkspaceFor(lease), assertCurrent: lease.assertCurrent, release: lease.release };
    },
    captureFor: () => ({ openYDocSession }),
    ensureCaptureFor: async () => undefined,
    isSharedView: () => false,
    resolveDocumentPath: async (_workspace, path) => path,
    onError: vi.fn(),
  });
  const adapter = {
    reconcileCapture: vi.fn<VersionedLiveAdapter["reconcileCapture"]>(async () => ({ settled: true, running: true, degraded: false })),
    watcherStatus: vi.fn<VersionedLiveAdapter["watcherStatus"]>(async () => ({ running: true, degraded: false, terminal: false, phase: "ready", noAtomicPlacement: false, recoveryUnavailable: false, keptFiles: [] })),
    listCollections: vi.fn<VersionedLiveAdapter["listCollections"]>(async () => ({ collections: [] })),
    getCollection: vi.fn<VersionedLiveAdapter["getCollection"]>(async () => { throw new Error("get boundary"); }),
    queryCollectionRecords: vi.fn<VersionedLiveAdapter["queryCollectionRecords"]>(async () => ({
      collection: { path: "data", objectId: "object-data", status: "valid", reasons: [] }, records: [], groups: null, nextCursor: null,
    })),
    getCollectionRecord: vi.fn<VersionedLiveAdapter["getCollectionRecord"]>(async () => { throw new Error("record boundary"); }),
  };
  const capture = {
    listMoments: vi.fn<WorkspaceEngineCapture["listMoments"]>(async () => ({
      moments: [], nextBeforeMomentOrder: null, latestMomentOrder: 0, activeVersionId: "main", protectedTruncated: false,
    })),
    readMoment: vi.fn<WorkspaceEngineCapture["readMoment"]>(async () => null),
    restoreFileToBeforeMoment: vi.fn<WorkspaceEngineCapture["restoreFileToBeforeMoment"]>(async () => {
      events.push("restore");
      return { restored: "text", restoredMomentId: "restored", path: "notes/a.md" };
    }),
  };
  const requireEngineCapture = vi.fn(async (_id: string, _feature: "Engine history") => ({ capture }));
  const getStatus = vi.fn<(_id: string) => SyncStatusResult>(() => refused);
  const hasAgentRun = vi.fn((_id: string, _root: string) => false);
  const closeActivity = vi.fn<() => Promise<void>>(async () => { events.push("close"); });
  const probe = vi.fn<typeof probeEngineStoreRefusal>(async () => { events.push("probe"); return "foreign-database" as const; });
  const move = vi.fn(async (_root: string) => { events.push("move"); return "moved" as const; });
  const reopen = vi.fn(async (_workspace: RegistryEntry, options: { afterReopenRecoverySettled: () => void }) => {
    events.push("reopen");
    options.afterReopenRecoverySettled();
    events.push("recovery-settled");
    getStatus.mockReturnValue(healthy);
    return healthy;
  });
  const notify = vi.fn((_target: { workspaceId: string }) => { events.push("notify"); });
  const writable = vi.fn((_workspace: RegistryEntry) => undefined);
  const requireWorkspace = vi.fn((id: string) => {
    if (id === other.workspaceId) return other;
    if (id !== workspace.workspaceId) throw new Error("unknown workspace");
    return workspace;
  });
  const displayName = vi.fn(() => "You");
  const syncProjection = vi.fn(async (_workspace: RegistryEntry, status: SyncStatusResult) => status);
  const handlers = new Map<string, (event: { sender: Sender }, payload: unknown) => unknown>();
  let missingAdapter = false;
  const routed: unknown[] = [];
  const requireSessions = vi.fn(() => sessions);
  const retryOwnerLiveDelivery = vi.fn();
  const retryCloudSync = vi.fn(async (_workspaceId: string, _reason: "person" | "reconnect") => undefined);
  const automationRunOnThisComputer = vi.fn(async (_workspaceId: string, _automationId: string, claimId: string) => claimId === "claim-here");
  // The relay's owner-only routes. It answers 404 to anyone but the owner.
  const relay = vi.fn(async (_workspaceId: string, _request: ServerRequest): Promise<ServerReply> => ({ status: 404, body: { ok: false } }));
  // The sign-in: every sign-in, sign-out, or credential load starts a new generation.
  const session: { account: string | null; generation: number; loaded: Promise<void> } = { account: "person-local", generation: 1, loaded: Promise.resolve() };
  // As main asks: nothing when signed out, and each answer names the sign-in it asked as.
  const sent = vi.fn();
  const serverRuns = createServerRuns(async (workspaceId, request): Promise<ServerAnswer> => {
    sent();
    await session.loaded;
    const { account, generation } = session;
    if (account === null) return null;
    const reply = await relay(workspaceId, request);
    return reply && { ...reply, asker: { account, current: () => session.generation === generation } };
  });
  const registrations = createWorkspaceEngineIpc({
    localPersonId: () => "person-local",
    registerHandler: (channel, handler) => { handlers.set(channel, handler); },
    assertTrustedSender: (event: { sender: Sender }) => { if (event.sender.id === -1) throw new Error("untrusted"); },
    withRendererWorkspaceOperation, receivedShareEngine,
    withEngineAdapter: async (_workspace, work) => {
      routed.push(_workspace);
      return missingAdapter ? null : work(adapter);
    },
    requireEngineCapture, localAgentDisplayName: displayName,
    automationAuthor: (_workspaceId, automationId) => ({ name: automationId, collection: "Tasks" }),
    automationRunOnThisComputer, serverRuns, signedInAccount: () => session.account,
    notifyRenderer: notify,
    namedAuthorLabel: () => "Someone you shared with",
    retryOwnerLiveDelivery, retryCloudSync,
    requireWorkspace, assertWritableWorkspace: writable, syncStatusWithOwnedProjection: syncProjection,
    activity: { getStatus, hasAgentRun }, workspaceAuthorities: authority, canonicalWorkspaceFor,
    requireEngineSessions: requireSessions, closeDispatchRunActivity: closeActivity,
    probeEngineStoreRefusal: probe, moveEngineStoreAside: move,
    openWorkspaceActivityUnderEngineStoreLock: reopen, engineYDocSessionIpc: ydoc,
  });
  registrations.registerCollections();
  registrations.registerHistory();
  registrations.registerStatusAndRepair();
  registrations.registerYDoc();
  const invoke = (channel: string, payload: unknown = { workspaceId: "workspace" }, value = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`unregistered: ${channel}`);
    return handler({ sender: value }, payload);
  };
  return {
    workspace, sender, physical, authority, renderers, sessions, ydoc, provider, openYDocSession,
    adapter, capture, requireEngineCapture, getStatus, hasAgentRun, closeActivity, probe, move, reopen,
    notify, writable, requireWorkspace, displayName, syncProjection, canonicalWorkspaceFor, requireSessions,
    events, handlers, invoke, routed, retryOwnerLiveDelivery, retryCloudSync, automationRunOnThisComputer, relay, setMissingAdapter: () => { missingAdapter = true; },
    sent,
    signIn: (account: string | null) => { session.account = account; session.generation += 1; },
    /** A credential load begins: no account is known until it reads the store. Resolves the load with its account. */
    loading: () => {
      const load = deferred<void>();
      session.account = null;
      session.generation += 1;
      session.loaded = load.promise;
      return (account: string) => { session.account = account; load.resolve(); };
    },
  };
}

const channels = [
  CHANNELS.listCollections, CHANNELS.getCollection, CHANNELS.queryCollectionRecords, CHANNELS.getCollectionRecordHistory,
  CHANNELS.locateRecordHistoryRun, CHANNELS.listEngineMoments, CHANNELS.readEngineMoment, CHANNELS.restoreEngineMomentFile,
  CHANNELS.getSyncStatus, CHANNELS.retryFileRecovery, CHANNELS.retryOwnerLiveDelivery, CHANNELS.retryCloudSync,
  CHANNELS.rebuildEngineStore,
  CHANNELS.engineYDocOpen, CHANNELS.engineYDocReadArtifactAsset, CHANNELS.engineYDocApplyUpdate,
  CHANNELS.engineYDocAcknowledgeLineageReplacement, CHANNELS.engineYDocClose,
  CHANNELS.engineYDocPrepareOwnerHandoff,
];

describe("workspace engine IPC registrations", () => {
  it("retries recovery only for the writable workspace this renderer shows", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.retryFileRecovery);
    expect(h.adapter.reconcileCapture).toHaveBeenCalledOnce();
    expect(h.adapter.watcherStatus).toHaveBeenCalledOnce();
    await expect(h.invoke(CHANNELS.retryFileRecovery, { workspaceId: "other" })).rejects.toThrow();
    h.writable.mockImplementation(() => { throw new Error("readonly"); });
    await expect(h.invoke(CHANNELS.retryFileRecovery)).rejects.toThrow("readonly");
    expect(h.adapter.reconcileCapture).toHaveBeenCalledOnce();
  });
  it("keeps recovery unavailable when reconciliation or the recovery scan still fails", async () => {
    const h = await harness();
    h.adapter.watcherStatus.mockResolvedValue({ running: true, degraded: false, terminal: false, phase: "ready", noAtomicPlacement: false, recoveryUnavailable: true, keptFiles: [] });
    await expect(h.invoke(CHANNELS.retryFileRecovery)).rejects.toThrow("still cannot read");
    h.adapter.reconcileCapture.mockRejectedValue(new Error("denied"));
    await expect(h.invoke(CHANNELS.retryFileRecovery)).rejects.toThrow("denied");
  });
  it("admits live delivery retries only through the current writable renderer workspace", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.retryOwnerLiveDelivery);
    expect(h.retryOwnerLiveDelivery).toHaveBeenCalledWith("workspace");
    await expect(h.invoke(CHANNELS.retryOwnerLiveDelivery, {workspaceId: "foreign"})).rejects.toThrow();
    expect(h.retryOwnerLiveDelivery).toHaveBeenCalledTimes(1);
    h.writable.mockImplementation(() => {throw new Error("readonly");});
    await expect(h.invoke(CHANNELS.retryOwnerLiveDelivery)).rejects.toThrow("readonly");
    expect(h.retryOwnerLiveDelivery).toHaveBeenCalledTimes(1);
  });
  it("runs a sync pass for a writable workspace and answers with the status after it", async () => {
    const h = await harness();
    const order: string[] = [];
    h.retryCloudSync.mockImplementation(async () => { order.push("pass"); });
    h.getStatus.mockImplementation(() => { order.push("status"); return healthy; });
    const asked = { workspaceId: "workspace", reason: "person" };
    await expect(h.invoke(CHANNELS.retryCloudSync, asked)).resolves.toMatchObject({ state: "synced" });
    expect(h.retryCloudSync).toHaveBeenCalledWith("workspace", "person");
    await expect(h.invoke(CHANNELS.retryCloudSync)).rejects.toThrow();
    expect(order).toEqual(["pass", "status"]);
    h.writable.mockImplementation(() => {throw new Error("readonly");});
    await expect(h.invoke(CHANNELS.retryCloudSync, asked)).rejects.toThrow("readonly");
    expect(h.retryCloudSync).toHaveBeenCalledTimes(1);
  });
  // Codex on #1233: a renderer showing one workspace could start another
  // open workspace's push and pull.
  it("refuses a sync retry for an open workspace this renderer does not show", async () => {
    const h = await harness();
    const foreign = { workspaceId: "other", reason: "person" };
    await expect(h.invoke(CHANNELS.retryCloudSync, foreign)).rejects.toThrow("This workspace is no longer active.");
    expect(h.retryCloudSync).not.toHaveBeenCalled();
  });
  it("registers the four groups in order and rejects untrusted callers before parsing", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual(channels);
    for (const channel of channels) {
      await expect(Promise.resolve().then(() => h.invoke(channel, null, new Sender(-1)))).rejects.toThrow("untrusted");
    }
    expect(h.routed).toEqual([]);
    expect(h.requireEngineCapture).not.toHaveBeenCalled();
    expect(h.requireWorkspace).not.toHaveBeenCalled();
    expect(h.openYDocSession).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads before engine work", async () => {
    const h = await harness();
    for (const channel of channels) {
      await expect(Promise.resolve().then(() => h.invoke(channel, null))).rejects.toThrow();
    }
    expect(h.routed).toEqual([]);
    expect(h.requireEngineCapture).not.toHaveBeenCalled();
    expect(h.requireWorkspace).not.toHaveBeenCalled();
    expect(h.openYDocSession).not.toHaveBeenCalled();
  });

  it("returns an empty list without an adapter but rejects get and query", async () => {
    const h = await harness();
    h.setMissingAdapter();
    await expect(h.invoke(CHANNELS.listCollections)).resolves.toEqual({ collections: [] });
    for (const channel of [CHANNELS.getCollection, CHANNELS.queryCollectionRecords, CHANNELS.getCollectionRecordHistory]) {
      await expect(h.invoke(channel, { workspaceId: "workspace", collectionPath: "data", recordId: "rec_a" })).rejects.toThrow("engine is not running");
    }
  });

  it("routes shared views through the received-share owner and strips only workspaceId from queries", async () => {
    const h = await harness();
    h.workspace.shareView = {
      shareId: "share", granterEmail: null, genericChatWritable: false,
      grantedSelector: { paths: [], versionId: null, access: "view" },
    };
    const params = {
      collectionPath: "data", filter: { field: "name", operator: "equals", value: "Ada" },
      sort: [], groupBy: "name", resolveRelations: false, limit: 3,
      cursor: { sortValues: [], recordPath: "data/a.md", recordId: "a" },
    };
    await expect(h.invoke(CHANNELS.queryCollectionRecords, { workspaceId: "workspace", ...params })).resolves.toMatchObject({ records: [] });
    expect(h.adapter.queryCollectionRecords).toHaveBeenCalledWith(params);
    expect(h.routed).toEqual([{
      workspaceId: "workspace", rootPath: "C:/canonical", attachmentId: h.physical.attachmentId, shareMount: true,
    }]);
  });

  it("parses collection results and preserves get arguments", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.getCollection, { workspaceId: "workspace", collectionPath: "data" })).rejects.toThrow("get boundary");
    expect(h.adapter.getCollection).toHaveBeenCalledWith({ collectionPath: "data" });
    h.adapter.listCollections.mockResolvedValue({ collections: [{ path: "", objectId: "object-data", status: "valid", reasons: [] }] });
    await expect(h.invoke(CHANNELS.listCollections)).rejects.toThrow();
    h.adapter.queryCollectionRecords.mockResolvedValue({
      collection: { path: "", objectId: "object-data", status: "valid", reasons: [] }, records: [], groups: null, nextCursor: null,
    });
    await expect(h.invoke(CHANNELS.queryCollectionRecords, { workspaceId: "workspace", collectionPath: "data" })).rejects.toThrow();
  });

  it("reads a record's history page, naming each author and looking up each run once", async () => {
    const h = await harness();
    const stamp = "collection:tasks-id#stamp";
    const side = (value: string | null) => ({ present: value !== null, value });
    const entry = (historyId: number, overrides: Partial<CollectionGetRecordResult["history"][number]>) => ({
      historyId, field: "Status", previous: side("Open"), next: side("Done"), authorOriginId: null, actorKind: null,
      onBehalfOf: null, depth: null, recordedAtMs: 1_000 - historyId, automationRun: null, ...overrides,
    });
    const automation = { authorOriginId: stamp, actorKind: "automation" as const, onBehalfOf: "person-local", depth: 1 };
    h.adapter.getCollectionRecord.mockResolvedValue({
      collection: { path: "tasks", objectId: "tasks-id", status: "valid", reasons: [] },
      record: { id: "rec_a", path: "tasks/a.md", conflicted: false, values: [] },
      history: [
        entry(9, { ...automation, field: "Finished", automationRun: { claimId: "claim-here", automationName: "Stamp the finish date" } }),
        entry(8, { ...automation, automationRun: { claimId: "claim-here", automationName: "Stamp the finish date" } }),
        entry(7, { ...automation, automationRun: { claimId: "claim-gone", automationName: "Old name" } }),
        entry(6, automation),
        entry(5, { authorOriginId: "codex", actorKind: "agent", onBehalfOf: "person-local", depth: 0 }),
        entry(4, { authorOriginId: "codex", actorKind: "agent", onBehalfOf: "user-ana", depth: 0 }),
        entry(3, { actorKind: "human" }),
      ],
      nextBeforeHistoryId: 3,
    });
    const page = await h.invoke(CHANNELS.getCollectionRecordHistory, { workspaceId: "workspace", collectionPath: "tasks", recordId: "rec_a", beforeHistoryId: 10 });
    expect(h.adapter.getCollectionRecord).toHaveBeenCalledWith({ collectionPath: "tasks", recordId: "rec_a", historyLimit: 50, beforeHistoryId: 10 });
    expect(page).toMatchObject({
      nextBeforeHistoryId: 3,
      entries: [
        { historyId: 9, field: "Finished", author: { kind: "automation", automationId: stamp, name: "Stamp the finish date", run: { claimId: "claim-here", location: "available" } } },
        { historyId: 8, author: { kind: "automation", name: "Stamp the finish date", run: { claimId: "claim-here", location: "available" } } },
        // The name it had when it ran, and a run History must still place.
        { historyId: 7, author: { kind: "automation", name: "Old name", run: { claimId: "claim-gone", location: "unchecked" } } },
        // Written before runs were recorded: its name now, and no run to open.
        { historyId: 6, author: { kind: "automation", name: stamp, run: null } },
        { historyId: 5, author: { kind: "agent", name: "You" } },
        // Another person's agent, as the file timeline names it.
        { historyId: 4, author: { kind: "agent", name: "Agent" } },
        { historyId: 3, author: null },
      ],
    });
    expect(h.automationRunOnThisComputer.mock.calls).toEqual([
      ["workspace", stamp, "claim-here"],
      ["workspace", stamp, "claim-gone"],
    ]);
    // The page never waits on the server.
    expect(h.relay).not.toHaveBeenCalled();
  });

  it("places a run the owner's server keeps, remembers it for that account, and never waits the page on the server", async () => {
    const h = await harness();
    const stamp = "collection:tasks-id#stamp";
    const serverRun = {
      claimId: "claim-server", state: "done", error: null, createdAtMs: 1, updatedAtMs: 2,
      trigger: { sharedAuthor: null, kind: "changed", recordId: "rec_a", by: "human", depth: 0 },
      writes: [], definitionChanged: false, chainStopped: false, neverStarted: false, undone: false,
    };
    h.relay.mockImplementation(async (_workspaceId, request) => {
      const claimId = request.method === "GET" ? request.query?.claimId : undefined;
      if (claimId === "claim-server") return { status: 200, body: { ok: true, run: serverRun } };
      if (claimId === "claim-expired") return { status: 200, body: { ok: true, run: null } };
      if (claimId === "claim-offline") throw new TypeError("fetch failed");
      // The relay answers anyone but the owner as if there were no run.
      return { status: 404, body: { ok: false } };
    });
    const locate = (claimId: string) => h.invoke(CHANNELS.locateRecordHistoryRun, { workspaceId: "workspace", automationId: stamp, claimId });
    await expect(locate("claim-here")).resolves.toEqual({ location: "available" });
    expect(h.relay).not.toHaveBeenCalled();
    await expect(locate("claim-server")).resolves.toEqual({ location: "available" });
    await expect(locate("claim-expired")).resolves.toEqual({ location: "unavailable" });
    await expect(locate("claim-not-owner")).resolves.toEqual({ location: "unavailable" });
    // A failed lookup proves nothing about the run.
    await expect(locate("claim-offline")).rejects.toThrow("fetch failed");
    expect(h.relay.mock.calls.map(([, request]) => request)).toEqual(
      ["claim-server", "claim-expired", "claim-not-owner", "claim-offline"].map((claimId) => ({ method: "GET", action: "runs", query: { automationId: stamp, claimId } })),
    );

    // Runs do not move: the server's answer stands for the session.
    h.relay.mockClear();
    await expect(locate("claim-server")).resolves.toEqual({ location: "available" });
    const change = (historyId: number, claimId: string) => ({
      historyId, field: "Status", previous: { present: true, value: "Open" }, next: { present: true, value: "Done" },
      authorOriginId: stamp, actorKind: "automation" as const, onBehalfOf: "person-local", depth: 1,
      recordedAtMs: 1_000 - historyId, automationRun: { claimId, automationName: "Stamp" },
    });
    h.adapter.getCollectionRecord.mockResolvedValue({
      collection: { path: "tasks", objectId: "tasks-id", status: "valid", reasons: [] },
      record: { id: "rec_a", path: "tasks/a.md", conflicted: false, values: [] },
      history: [change(2, "claim-server"), change(1, "claim-expired")],
      nextBeforeHistoryId: null,
    });
    await expect(h.invoke(CHANNELS.getCollectionRecordHistory, { workspaceId: "workspace", collectionPath: "tasks", recordId: "rec_a" })).resolves.toMatchObject({
      entries: [
        { historyId: 2, author: { run: { claimId: "claim-server", location: "available" } } },
        { historyId: 1, author: { run: { claimId: "claim-expired", location: "unchecked" } } },
      ],
    });
    expect(h.relay).not.toHaveBeenCalled();

    // Another account asks the relay again, and is refused.
    h.signIn("person-other");
    h.relay.mockResolvedValue({ status: 404, body: { ok: false } });
    await expect(locate("claim-server")).resolves.toEqual({ location: "unavailable" });
    expect(h.relay).toHaveBeenCalledOnce();
  });

  it("keeps a server's answer only for the sign-in it asked as", async () => {
    const h = await harness();
    const stamp = "collection:tasks-id#stamp";
    const serverRun = {
      claimId: "claim-server", state: "done", error: null, createdAtMs: 1, updatedAtMs: 2,
      trigger: { sharedAuthor: null, kind: "changed", recordId: "rec_a", by: "human", depth: 0 },
      writes: [], definitionChanged: false, chainStopped: false, neverStarted: false, undone: false,
    };
    const shown = { status: 200, body: { ok: true, run: serverRun } };
    const locate = () => h.invoke(CHANNELS.locateRecordHistoryRun, { workspaceId: "workspace", automationId: stamp, claimId: "claim-server" });

    // The person signs out while the owner's answer is on its way: it is no answer.
    const late = deferred<ServerReply>();
    h.relay.mockImplementationOnce(() => late.promise);
    const asking = locate();
    await vi.waitFor(() => expect(h.relay).toHaveBeenCalledOnce());
    h.signIn(null);
    late.resolve(shown);
    await expect(asking).rejects.toThrow("Your sign-in changed");
    // A refusal for an older sign-in proves nothing either, a 404 or no run alike.
    for (const refusal of [{ status: 404, body: { ok: false } }, { status: 200, body: { ok: true, run: null } }]) {
      h.signIn("person-local");
      h.relay.mockClear();
      const refused = deferred<ServerReply>();
      h.relay.mockImplementationOnce(() => refused.promise);
      const refusing = locate();
      await vi.waitFor(() => expect(h.relay).toHaveBeenCalledOnce());
      h.signIn("person-other");
      refused.resolve(refusal);
      await expect(refusing).rejects.toThrow("Your sign-in changed");
    }
    h.signIn(null);
    h.relay.mockClear();
    // Signed out, the run is not offered, and nothing asks the relay.
    await expect(locate()).resolves.toEqual({ location: "unavailable" });
    expect(h.relay).not.toHaveBeenCalled();

    // While a credential load reads the store, the answer is kept under the account it asked as.
    h.relay.mockResolvedValue(shown);
    h.sent.mockClear();
    const loaded = h.loading();
    const whileLoading = locate();
    await vi.waitFor(() => expect(h.sent).toHaveBeenCalled());
    loaded("person-local");
    await expect(whileLoading).resolves.toEqual({ location: "available" });
    h.relay.mockClear();
    await expect(locate()).resolves.toEqual({ location: "available" });
    expect(h.relay).not.toHaveBeenCalled();
    // After a sign-out, that answer is not offered to the person signed out.
    h.signIn(null);
    await expect(locate()).resolves.toEqual({ location: "unavailable" });
  });

  it("places no run for a workspace this renderer does not show", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.locateRecordHistoryRun, { workspaceId: "other", automationId: "collection:tasks-id#stamp", claimId: "claim-server" }))
      .rejects.toThrow("window changed workspaces");
    expect(h.automationRunOnThisComputer).not.toHaveBeenCalled();
    expect(h.relay).not.toHaveBeenCalled();
  });

  it("reads no record history for a workspace this renderer does not show", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.getCollectionRecordHistory, { workspaceId: "other", collectionPath: "tasks", recordId: "rec_a" }))
      .rejects.toThrow("window changed workspaces");
    expect(h.adapter.getCollectionRecord).not.toHaveBeenCalled();
    expect(h.automationRunOnThisComputer).not.toHaveBeenCalled();
    expect(h.relay).not.toHaveBeenCalled();
  });

  it("rejects a collection result after the renderer changes attachment", async () => {
    const h = await harness();
    const reached = deferred<void>();
    const release = deferred<{ collections: [] }>();
    h.adapter.listCollections.mockImplementation(async () => { reached.resolve(); return release.promise; });
    const result = h.invoke(CHANNELS.listCollections);
    try {
      await reached.promise;
      await h.renderers.open(h.sender, { workspaceId: "other", attachmentId: Symbol("other") }, "document-1");
    } finally {
      release.resolve({ collections: [] });
    }
    await expect(result).rejects.toThrow("window changed workspaces");
  });

  it("keeps history admission independent of renderer admission and omits absent paging fields", async () => {
    const h = await harness();
    await h.renderers.open(h.sender, { workspaceId: "other", attachmentId: Symbol("other") }, "document-1");
    await h.invoke(CHANNELS.listEngineMoments);
    expect(h.requireEngineCapture).toHaveBeenCalledWith("workspace", "Engine history");
    expect(h.capture.listMoments).toHaveBeenLastCalledWith({});
    await h.invoke(CHANNELS.listEngineMoments, { workspaceId: "workspace", limit: 7, beforeMomentOrder: 19 });
    expect(h.capture.listMoments).toHaveBeenLastCalledWith({ limit: 7, beforeMomentOrder: 19 });
    await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "moment" })).resolves.toEqual({ moment: null });
  });

  it("propagates missing capture admission before all history work", async () => {
    const h = await harness();
    h.requireEngineCapture.mockRejectedValue(new Error("capture unavailable"));
    for (const channel of [CHANNELS.listEngineMoments, CHANNELS.readEngineMoment, CHANNELS.restoreEngineMomentFile]) {
      await expect(h.invoke(channel, { workspaceId: "workspace", momentId: "moment" })).rejects.toThrow("capture unavailable");
    }
    expect(h.capture.listMoments).not.toHaveBeenCalled();
    expect(h.capture.readMoment).not.toHaveBeenCalled();
    expect(h.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("names this computer's dohc run by its display name, and another person's run as Agent", async () => {
    const h = await harness();
    h.capture.listMoments.mockResolvedValue({
      moments: ["person-local", "user-pat"].map((onBehalfOf, index) => ({
        id: `moment-${index}`, versionId: "main", path: "notes/a.md", recordedAtMs: 1,
        operation: "write", metadata: { origin: "local-file" }, protected: false, momentOrder: index,
        authors: [{ kind: "agent", agentId: "agent", agentRunId: "run-1", onBehalfOf }],
      })),
      nextBeforeMomentOrder: null, latestMomentOrder: 1, activeVersionId: "main", protectedTruncated: false,
    });
    const names = async () => ((await h.invoke(CHANNELS.listEngineMoments)) as { moments: Array<{ agentAuthorName?: string }> })
      .moments.map((moment) => moment.agentAuthorName);
    await expect(names()).resolves.toEqual(["You", "Agent"]);
    h.displayName.mockReturnValue("ice@example.com");
    await expect(names()).resolves.toEqual(["ice@example.com", "Agent"]);
    h.capture.readMoment.mockResolvedValue({
      protected: false,
      moment: {
        id: "detail", workspaceId: "workspace", versionId: "main", objectId: "object",
        path: "notes/a.md", recordedAtMs: 1, operation: "write", metadata: { origin: "local-file" },
        authors: [{ kind: "agent", agentId: "agent", agentRunId: "run-1", onBehalfOf: "person-local" }],
        payload: { before: null, after: { path: "notes/a.md", contentKind: "text", sha256: "a".repeat(64), byteLength: 4, text: "body" } },
      },
    });
    await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "detail" })).resolves.toMatchObject({
      moment: { agentAuthorName: "ice@example.com", beforeText: null, afterText: "body" },
    });
  });

  it("uses Settings only for dohc runs and handshake names for other agents", async () => {
    const h = await harness();
    h.capture.listMoments.mockResolvedValue({
      moments: [{ agentId: "agent", agentRunId: "run-1" }, { agentId: "Pat" }, { agentId: "dohc-mcp" }].map((identity, index) => ({
        id: `moment-${index}`, versionId: "main", path: "notes/a.md", recordedAtMs: 1,
        operation: "write", metadata: { origin: "local-file" }, protected: false, momentOrder: index,
        authors: [{ kind: "agent", onBehalfOf: "person-local", ...identity }],
      })),
      nextBeforeMomentOrder: null, latestMomentOrder: 1, activeVersionId: "main", protectedTruncated: false,
    });
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({
      moments: [{ agentAuthorName: "You" }, { agentAuthorName: "Pat" }, { agentAuthorName: "Agent" }],
    });
    h.displayName.mockReturnValue("ice@example.com");
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({
      moments: [{ agentAuthorName: "ice@example.com" }, { agentAuthorName: "Pat" }, { agentAuthorName: "Agent" }],
    });
    h.capture.readMoment.mockResolvedValue({
      protected: false,
      moment: {
        id: "detail", workspaceId: "workspace", versionId: "main", objectId: "object",
        path: "notes/a.md", recordedAtMs: 1, operation: "write", metadata: { origin: "local-file" },
        authors: [{ kind: "agent", agentId: "agent", onBehalfOf: "person-local", agentRunId: "run-1" }],
        payload: { before: null, after: { path: "notes/a.md", contentKind: "text", sha256: "a".repeat(64), byteLength: 4, text: "body" } },
      },
    });
    await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "detail" })).resolves.toMatchObject({
      moment: { agentAuthorName: "ice@example.com", beforeText: null, afterText: "body" },
    });
  });

  it("notifies after a restore and before parsing its result", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.restoreEngineMomentFile, { workspaceId: "workspace", momentId: "moment" })).resolves.toEqual({ restored: "text", restoredMomentId: "restored", path: "notes/a.md" });
    expect(h.events).toEqual(["restore", "notify"]);
    h.capture.restoreFileToBeforeMoment.mockResolvedValue({ restored: "text", restoredMomentId: "", path: "notes/a.md" });
    await expect(h.invoke(CHANNELS.restoreEngineMomentFile, { workspaceId: "workspace", momentId: "moment" })).rejects.toThrow();
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("refreshes status from the registered workspace and parses the projection", async () => {
    const h = await harness();
    h.syncProjection.mockResolvedValue(healthy);
    await expect(h.invoke(CHANNELS.getSyncStatus)).resolves.toEqual(healthy);
    expect(h.syncProjection).toHaveBeenCalledWith(h.workspace, refused);
    expect(h.canonicalWorkspaceFor).not.toHaveBeenCalled();
    h.syncProjection.mockResolvedValue({ ...healthy, pendingChangeCount: -1 });
    await expect(h.invoke(CHANNELS.getSyncStatus)).rejects.toThrow();
  });
});

describe("registered engine-store repair", () => {
  it("resolves the canonical workspace and sessions only after the engine-store lane opens", async () => {
    const h = await harness();
    const entered = deferred();
    const release = deferred();
    const occupied = h.authority.withAuthority("workspace", (lease) =>
      runInWorkspaceAuthorityLane(lease, "engine-store", async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    const repair = h.invoke(CHANNELS.rebuildEngineStore);
    expect(h.writable).toHaveBeenCalledWith(h.workspace);
    expect(h.canonicalWorkspaceFor).not.toHaveBeenCalled();
    expect(h.requireSessions).not.toHaveBeenCalled();
    release.resolve();
    await occupied;
    await expect(repair).resolves.toEqual({ outcome: "moved" });
    expect(h.closeActivity).toHaveBeenCalledWith(h.physical, { notifyRenderer: false });
    expect(h.probe).toHaveBeenCalledWith(h.physical, h.sessions);
    expect(h.move).toHaveBeenCalledWith("C:/canonical");
    expect(h.hasAgentRun).toHaveBeenCalledWith("workspace", "C:/canonical");
    expect(h.events).toEqual(["close", "probe", "move", "reopen", "recovery-settled", "notify"]);
  });

  it("serializes repeat repairs and returns the result retained by the same authority", async () => {
    const h = await harness();
    const entered = deferred();
    const release = deferred();
    h.move.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return "moved";
    });
    const first = h.invoke(CHANNELS.rebuildEngineStore);
    await entered.promise;
    const second = h.invoke(CHANNELS.rebuildEngineStore);
    expect(h.canonicalWorkspaceFor).toHaveBeenCalledOnce();
    await expect(h.sessions.run(h.physical, async () => true)).rejects.toThrow("rebuild");
    release.resolve();
    await expect(first).resolves.toEqual({ outcome: "moved" });
    await expect(second).resolves.toEqual({ outcome: "moved" });
    expect(h.closeActivity).toHaveBeenCalledOnce();
    const lease = h.authority.acquire("workspace");
    expect(lease.state.lastEngineStoreRebuildResult).toEqual({ outcome: "moved" });
    lease.release();
  });

  it("ends the session rebuild gate at recovery settlement before reopening capture", async () => {
    const h = await harness();
    h.reopen.mockImplementation(async (_workspace, options) => {
      await expect(h.sessions.run(h.physical, async () => true)).rejects.toThrow("rebuild");
      options.afterReopenRecoverySettled();
      await expect(h.sessions.run(h.physical, async () => true)).rejects.toThrow("daemon boundary");
      return healthy;
    });
    await expect(h.invoke(CHANNELS.rebuildEngineStore)).resolves.toEqual({ outcome: "moved" });
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "workspace" });
  });

  it("rejects read-only, healthy, and active-agent requests before closing activity", async () => {
    const h = await harness();
    h.writable.mockImplementationOnce(() => { throw new Error("read-only"); });
    await expect(h.invoke(CHANNELS.rebuildEngineStore)).rejects.toThrow("read-only");
    expect(h.canonicalWorkspaceFor).not.toHaveBeenCalled();
    h.getStatus.mockReturnValueOnce(healthy);
    await expect(h.invoke(CHANNELS.rebuildEngineStore)).rejects.toMatchObject({ reason: "not-refused" });
    // A store this build could not migrate is intact and never moved.
    h.getStatus.mockReturnValueOnce({ ...refused, engineStoreRefused: "migration-failed" });
    await expect(h.invoke(CHANNELS.rebuildEngineStore)).rejects.toMatchObject({ reason: "not-refused" });
    h.hasAgentRun.mockReturnValue(true);
    await expect(h.invoke(CHANNELS.rebuildEngineStore)).rejects.toMatchObject({ reason: "agent-run-active" });
    expect(h.closeActivity).not.toHaveBeenCalled();
    expect(h.move).not.toHaveBeenCalled();
  });

  it("notifies a failed close before returning the request error and does not reopen", async () => {
    const h = await harness();
    const failure = new Error("close failure");
    h.closeActivity.mockImplementation(async () => { h.events.push("close-failed"); throw failure; });
    await expect(h.invoke(CHANNELS.rebuildEngineStore)).rejects.toMatchObject({ reason: "close-failed", cause: failure });
    expect(h.events).toEqual(["close-failed", "notify"]);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.reopen).not.toHaveBeenCalled();
  });

  it("reopens without moving when the closed store no longer refuses", async () => {
    const h = await harness();
    h.probe.mockResolvedValue(null);
    await expect(h.invoke(CHANNELS.rebuildEngineStore)).rejects.toMatchObject({ reason: "not-refused" });
    expect(h.move).not.toHaveBeenCalled();
    expect(h.events).toEqual(["close", "reopen", "recovery-settled", "notify"]);
  });

  it("reopens and notifies after a refused-store probe fails", async () => {
    const h = await harness();
    const failure = new Error("probe failed");
    h.probe.mockRejectedValue(failure);
    await expect(h.invoke(CHANNELS.rebuildEngineStore)).rejects.toBe(failure);
    expect(h.events).toEqual(["close", "reopen", "recovery-settled", "notify"]);
    expect(h.move).not.toHaveBeenCalled();
  });

  it("notifies failed recovery in finally and retains the session rebuild gate", async () => {
    const h = await harness();
    const failure = new EngineStoreRecoveryFailedError(new Error("recovery failed"));
    h.reopen.mockImplementation(async () => { h.events.push("reopen-failed"); throw failure; });
    await expect(h.invoke(CHANNELS.rebuildEngineStore)).resolves.toEqual({ outcome: "moved", reopenFailed: failure.message });
    expect(h.events).toEqual(["close", "probe", "move", "reopen-failed", "notify"]);
    await expect(h.sessions.run(h.physical, async () => true)).rejects.toThrow("rebuild");
    h.sessions.endRebuild(h.physical);
  });
});

describe("registered engine Y.Doc ownership", () => {
  it("uses the same document owner for IPC, file mutation, artifact reads, lineage and close", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.engineYDocOpen, openPayload)).resolves.toMatchObject({ available: true, lineageGeneration: 1 });
    await expect(h.ydoc.fileMutationPort().withDocumentUnowned(h.physical.attachmentId, openPayload.path, async () => true)).rejects.toThrow("engine owns this live document");
    const update = new Uint8Array([1]);
    expect(h.invoke(CHANNELS.engineYDocApplyUpdate, { sessionId: openPayload.sessionId, update, lineageGeneration: 1, seq: 1 })).toEqual({ accepted: true });
    expect(h.provider.applyLocalUpdate).toHaveBeenCalledWith(update, expect.any(Function), { attribution: { actorKind: "human", onBehalfOf: "person-local" } });
    await expect(h.invoke(CHANNELS.engineYDocReadArtifactAsset, { sessionId: openPayload.sessionId, descriptor })).resolves.toEqual({ descriptor, bytes: new Uint8Array([1, 2, 3]) });
    h.openYDocSession.mock.calls[0]![0].onLineageReplaced?.(new Uint8Array([9]), []);
    expect(h.invoke(CHANNELS.engineYDocAcknowledgeLineageReplacement, { sessionId: openPayload.sessionId, lineageGeneration: 2 })).toEqual({ accepted: true, updates: [] });
    await expect(h.invoke(CHANNELS.engineYDocClose, { sessionId: openPayload.sessionId })).resolves.toBeUndefined();
    expect(h.provider.close).toHaveBeenCalledOnce();
    await expect(h.ydoc.fileMutationPort().withDocumentUnowned(h.physical.attachmentId, openPayload.path, async () => true)).resolves.toBe(true);
    h.provider.doc.destroy();
  });

  it("rejects artifact access from another sender object with the same numeric id", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.engineYDocOpen, openPayload);
    await expect(h.invoke(CHANNELS.engineYDocReadArtifactAsset, { sessionId: openPayload.sessionId, descriptor }, new Sender(h.sender.id))).rejects.toThrow("no longer available");
    expect(h.provider.readArtifactAsset).not.toHaveBeenCalled();
    await h.invoke(CHANNELS.engineYDocClose, { sessionId: openPayload.sessionId });
    h.provider.doc.destroy();
  });
});
