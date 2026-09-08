import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
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
  const sender = new Sender(7);
  const events: string[] = [];
  const authority = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => id === workspace.workspaceId ? workspace : null,
    canonicalizeRoot: () => "C:/canonical",
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
    readArtifactAsset: vi.fn(async (value) => ({ descriptor: value, bytes: new Uint8Array([1, 2, 3]) })),
    close: vi.fn(async () => undefined),
  } satisfies WorkspaceEngineYDocProviderSession;
  const openYDocSession = vi.fn<WorkspaceEngineCapture["openYDocSession"]>(async () => provider);
  const ydoc = createEngineYDocSessionIpc({
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
    listCollections: vi.fn<VersionedLiveAdapter["listCollections"]>(async () => ({ collections: [] })),
    getCollection: vi.fn<VersionedLiveAdapter["getCollection"]>(async () => { throw new Error("get boundary"); }),
    queryCollectionRecords: vi.fn<VersionedLiveAdapter["queryCollectionRecords"]>(async () => ({
      collection: { path: "data", status: "valid", reasons: [] }, records: [], groups: null, nextCursor: null,
    })),
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
    if (id !== workspace.workspaceId) throw new Error("unknown workspace");
    return workspace;
  });
  const displayName = vi.fn(() => "You");
  const syncProjection = vi.fn(async (_workspace: RegistryEntry, status: SyncStatusResult) => status);
  const handlers = new Map<string, (event: { sender: Sender }, payload: unknown) => unknown>();
  let missingAdapter = false;
  const routed: unknown[] = [];
  const requireSessions = vi.fn(() => sessions);
  const registrations = createWorkspaceEngineIpc({
    registerHandler: (channel, handler) => { handlers.set(channel, handler); },
    assertTrustedSender: (event: { sender: Sender }) => { if (event.sender.id === -1) throw new Error("untrusted"); },
    withRendererWorkspaceOperation, receivedShareEngine,
    withEngineAdapter: async (_workspace, work) => {
      routed.push(_workspace);
      return missingAdapter ? null : work(adapter);
    },
    requireEngineCapture, localUserDisplayName: displayName, notifyRenderer: notify,
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
    events, handlers, invoke, routed, setMissingAdapter: () => { missingAdapter = true; },
  };
}

const channels = [
  CHANNELS.listCollections, CHANNELS.getCollection, CHANNELS.queryCollectionRecords,
  CHANNELS.listEngineMoments, CHANNELS.readEngineMoment, CHANNELS.restoreEngineMomentFile,
  CHANNELS.getSyncStatus, CHANNELS.rebuildEngineStore,
  CHANNELS.engineYDocOpen, CHANNELS.engineYDocReadArtifactAsset, CHANNELS.engineYDocApplyUpdate,
  CHANNELS.engineYDocAcknowledgeLineageReplacement, CHANNELS.engineYDocClose,
  CHANNELS.engineYDocPrepareOwnerHandoff,
];

describe("workspace engine IPC registrations", () => {
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
    for (const channel of [CHANNELS.getCollection, CHANNELS.queryCollectionRecords]) {
      await expect(h.invoke(channel, { workspaceId: "workspace", collectionPath: "data" })).rejects.toThrow("engine is not running");
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
    h.adapter.listCollections.mockResolvedValue({ collections: [{ path: "", status: "valid", reasons: [] }] });
    await expect(h.invoke(CHANNELS.listCollections)).rejects.toThrow();
    h.adapter.queryCollectionRecords.mockResolvedValue({
      collection: { path: "", status: "valid", reasons: [] }, records: [], groups: null, nextCursor: null,
    });
    await expect(h.invoke(CHANNELS.queryCollectionRecords, { workspaceId: "workspace", collectionPath: "data" })).rejects.toThrow();
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

  it("maps engine authors using the current local display name", async () => {
    const h = await harness();
    h.capture.listMoments.mockResolvedValue({
      moments: ["local", "Pat"].map((onBehalfOf, index) => ({
        id: `moment-${index}`, versionId: "main", path: "notes/a.md", recordedAtMs: 1,
        operation: "write", metadata: { origin: "local-file" }, protected: false, momentOrder: index,
        author: { kind: "agent", agentId: "agent", onBehalfOf },
      })),
      nextBeforeMomentOrder: null, latestMomentOrder: 1, activeVersionId: "main", protectedTruncated: false,
    });
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({
      moments: [{ agentAuthorName: "You" }, { agentAuthorName: "Pat" }],
    });
    h.displayName.mockReturnValue("ice@example.com");
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({
      moments: [{ agentAuthorName: "ice@example.com" }, { agentAuthorName: "Pat" }],
    });
    h.capture.readMoment.mockResolvedValue({
      protected: false,
      moment: {
        id: "detail", workspaceId: "workspace", versionId: "main", objectId: "object",
        path: "notes/a.md", recordedAtMs: 1, operation: "write", metadata: { origin: "local-file" },
        author: { kind: "agent", agentId: "agent", onBehalfOf: "local" },
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
    expect(h.provider.applyLocalUpdate).toHaveBeenCalledWith(update, expect.any(Function), { attribution: { actorKind: "human" } });
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
