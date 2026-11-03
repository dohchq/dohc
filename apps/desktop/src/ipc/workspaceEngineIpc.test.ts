import { CollectionsRefusalError } from "../workspaces/collectionsHolder";
import { createTestScratch } from "../workspaces/testTemp";
import type { TimelineReads } from "../workspaces/historyTimeline";
import { historyCursor, historyPageFields } from "../testing/historyPageFixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceEnginePolicy, type WorkspaceEnginePolicySnapshot } from "../workspaces/workspaceEnginePolicyFile";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { CollectionGetRecordResult } from "@dohc/workspace-contracts";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createWorkspaceEngineIpc } from "./workspaceEngineIpc";
import { CHANNELS } from "./channels";
import type { EngineMomentRecord, RebuildEngineStoreResult, SyncStatusResult } from "./bridgeContract";
import type { EngineMomentAuthorNames } from "./engineHistoryIpc";
import { GetCollectionRecordHistoryResult, historyOperations, captureRecoveryOperations, fileObservationOperations, engineYDocAdmissionOperations, engineYDocSaveOperations } from "./bridgeContract";
import { operationBridge } from "./operationTable";
import { engineMomentSourceLabel } from "../renderer/workbench/EngineHistory";
import { createWorkspaceAuthorityOwner, type WorkspaceAuthorityLease } from "../workspaces/workspaceAuthorityOwner";
import { runInWorkspaceAuthorityLane } from "../workspaces/workspaceAuthorityLane";
import { RendererWorkspaceSessionOwner } from "../window/rendererWorkspaceSessionOwner";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import { createReceivedShareEngineAccess } from "../workspaces/receivedShareEngineAccess";
import { createEngineYDocSessionIpc, type EngineYDocIpcSender } from "../workspaces/engineYDocSessionIpc";
import type { WorkspaceEngineCapture, WorkspaceEngineYDocProviderSession, probeEngineStoreRefusal } from "../workspaces/workspaceEngineCapture";
import { EngineStoreRecoveryFailedError } from "../workspaces/engineStoreRebuild";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { SyncHistory } from "../workspaces/syncHistory";
import { ownActorPresentation } from "../workspaces/actorPresentation";
import { ACTOR_HUES, actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";
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

describe("workspace engine sender binding", () => {
  it.each([
    CHANNELS.getSyncStatus, CHANNELS.rebuildEngineStore, CHANNELS.listEngineMoments,
    CHANNELS.readEngineMoment, CHANNELS.restoreEngineMomentFile,
  ])("binds %s before reading or changing another open workspace", async channel => {
    const h = await harness();
    const input = { workspaceId: "workspace",
      ...(channel === CHANNELS.readEngineMoment || channel === CHANNELS.restoreEngineMomentFile ? { momentId: "moment" } : {}) };
    await expect(h.invoke(channel, input)).resolves.toBeDefined();
    const services = [h.requireEngineCapture, h.requireWorkspace, h.getStatus,
      h.syncProjection, h.writable, h.canonicalWorkspaceFor, h.requireSessions,
      h.closeActivity, h.probe, h.move, h.reopen, h.notify,
      h.capture.listMoments, h.capture.readMoment, h.capture.restoreFileToBeforeMoment];
    services.forEach(service => service.mockClear());
    await expect(h.invoke(channel, { ...input, workspaceId: "other" })).rejects.toThrow("no longer active");
    services.forEach(service => expect(service).not.toHaveBeenCalled());
  });
});

type SharedHistoryStore = Pick<ReturnType<ReturnType<typeof createReceivedShareEngineAccess>["storeFor"]>, "listHistoryPage" | "getMoment">;

/** `sharedStore` makes the renderer's workspace a received share view backed by that store. */
async function harness(sharedStore?: SharedHistoryStore, policyRoot?: string, retry?: {
  afterOperation(): Promise<void>;
  read(): Promise<void>;
}) {
  const workspace: RegistryEntry = { workspaceId: "workspace", rootPath: policyRoot ?? "C:/alias", kind: "personal", mode: "local-first",
    ...(sharedStore ? { shareView: {} as NonNullable<RegistryEntry["shareView"]> } : {}) };
  // Open and writable, but not the workspace this renderer shows.
  const other: RegistryEntry = { workspaceId: "other", rootPath: "C:/other", kind: "personal", mode: "local-first" };
  const sender = new Sender(7);
  const events: string[] = [];
  const registry: { entry: RegistryEntry | null } = { entry: workspace };
  const authority = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => id === workspace.workspaceId ? registry.entry : id === other.workspaceId ? other : null,
    canonicalizeRoot: (root) => root === other.rootPath ? "C:/other-canonical" : policyRoot ?? "C:/canonical",
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
  const gatedWorkspaceOperation: typeof withRendererWorkspaceOperation = async (sender, workspaceId, message, work) => {
    const result = await withRendererWorkspaceOperation(sender, workspaceId, message, work);
    if (retry) await retry.afterOperation();
    return result;
  };
  const sessions = new EngineWorkspaceSessions({ currentClient: () => { throw new Error("daemon boundary"); } });
  const storeWorkspaces: unknown[] = [];
  const receivedShareEngine = createReceivedShareEngineAccess({
    sessions: () => sessions,
    relayClient: () => { throw new Error("unused relay"); },
    createStores: (engineWorkspace) => {
      if (!sharedStore) throw new Error("unused stores");
      storeWorkspaces.push(engineWorkspace);
      return { store: sharedStore } as never;
    },
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
    reconcileCapture: vi.fn<VersionedLiveAdapter["reconcileCapture"]>(async () => ({ deferredWrites: [], settled: true, running: true, degraded: false, heldFiles: [] })),
    retryHeldCapture: vi.fn<VersionedLiveAdapter["retryHeldCapture"]>(async () => ({ deferredWrites: [], settled: true, running: true, degraded: false, retried: true, heldFiles: [] })),
    watcherStatus: vi.fn<VersionedLiveAdapter["watcherStatus"]>(async () => ({ running: true, degraded: false, terminal: false, phase: "ready", noAtomicPlacement: false, recoveryUnavailable: false, deferredWrites: [], keptFiles: [], captureRecoveries: [], heldFiles: [], retainedCopies: { count: 0, bytes: 0 } })),
    clearCaptureRecovery: vi.fn<VersionedLiveAdapter["clearCaptureRecovery"]>(async () => undefined),
    listCollections: vi.fn<VersionedLiveAdapter["listCollections"]>(async () => ({ collections: [] })),
    getCollection: vi.fn<VersionedLiveAdapter["getCollection"]>(async () => { throw new Error("get boundary"); }),
    queryCollectionRecords: vi.fn<VersionedLiveAdapter["queryCollectionRecords"]>(async () => ({
      collection: { path: "data", objectId: "object-data", status: "valid", reasons: [] }, records: [], groups: null, nextCursor: null,
    })),
    getCollectionRecord: vi.fn<VersionedLiveAdapter["getCollectionRecord"]>(async () => { throw new Error("record boundary"); }),
  };
  const capture = {
    filePathForObjectId: vi.fn<WorkspaceEngineCapture["filePathForObjectId"]>(async () => null),
    listMoments: vi.fn<WorkspaceEngineCapture["listMoments"]>(async () => ({
      moments: [], nextCursor: null, latestMomentOrder: 0, activeVersionId: "main", ...historyPageFields,
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
  // Settings lists one agent, "agent", named "You".
  const displayName = vi.fn((agentId: string): string | undefined => agentId === "agent" ? "You" : undefined);
  const syncProjection = vi.fn(async (_workspace: RegistryEntry, status: SyncStatusResult) => status);
  const handlers = new Map<string, (event: { sender: Sender }, payload: unknown) => unknown>();
  let missingAdapter = false;
  const routed: unknown[] = [];
  const requireSessions = vi.fn(() => sessions);
  const retryOwnerLiveDelivery = vi.fn();
  const retryFileObservation = vi.fn(async (_workspaceId: string) => undefined);
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
  const readPolicy = vi.fn<(rootPath: string) => Promise<WorkspaceEnginePolicySnapshot>>(async () => ({ filesPolicy: null, visibilityPolicy: null, errors: [], unreadable: [] }));
  if (policyRoot) readPolicy.mockImplementation(readWorkspaceEnginePolicy);
  const recordHistoryPersonName = vi.fn((_workspaceId: string, userId: string, _sender: Sender): string | null => userId === "person-local" ? null : userId);
  const recordHeldFiles = vi.fn();
  const prepareRecordHistoryPeople = vi.fn<(_workspaceId: string, userIds: readonly string[], _sender: Sender) => void>();
  const prepareNamed = vi.fn<NonNullable<EngineMomentAuthorNames["prepare"]>>();
  const identity: { credentials: CloudCredentials | null } = { credentials: null };
  const warmCredentialCache = vi.fn(async () => undefined);
  const readSyncHistory = vi.fn(async (_rootPath: string): Promise<SyncHistory> => "never-synced");
  const historyCollections = vi.fn<() => Promise<Pick<TimelineReads, "scope" | "local" | "remote">>>(async () => ({ scope: "test", local: () => ({ pages: [], transferred: [], sourceIds: [], sourceCount: 0 }), remote: async () => { throw new Error("unexpected remote history"); } }));
  const stateDirectory = await createTestScratch("engine-ipc-settings-");
  const registrations = createWorkspaceEngineIpc({
    historyCollections,
    readWorkspaceEnginePolicy: readPolicy, readSyncHistory,
    localPersonId: () => "person-local",
    localPersonName: () => "Ice",
    localInstallationId: () => "install-local",
    stateDir: () => stateDirectory,
    warmCredentialCache, currentCredentials: () => identity.credentials,
    // Read from main's own account, as the sign-in stands when the request arrives.
    localPerson: async () => ({ kind: "human", humanId: session.account ?? "install-local" }),
    registerHandler: (channel, handler) => { handlers.set(channel, handler); },
    assertTrustedSender: (event: { sender: Sender }) => { if (event.sender.id === -1) throw new Error("untrusted"); },
    withRendererWorkspaceOperation: gatedWorkspaceOperation, receivedShareEngine,
    withEngineAdapter: async (_workspace, work) => {
      routed.push(_workspace);
      return missingAdapter ? null : work(adapter);
    },
    requireEngineCapture, agentName: displayName,
    automationAuthor: (_workspaceId, automationId) => ({ name: automationId, collection: "Tasks" }),
    automationRunOnThisComputer, serverRuns, signedInAccount: () => session.account,
    notifyRenderer: notify,
    recordHeldFiles,
    namedAuthorLabels: () => ({ prepare: prepareNamed, named: () => "Someone you shared with" }),
    recordHistoryPersonName,
    prepareRecordHistoryPeople,
    retryOwnerLiveDelivery, retryCloudSync,
    retryFileObservation: retry ? id => { void retryFileObservation(id); return retry.read(); } : retryFileObservation,
    assertWritableWorkspace: writable, syncStatusWithOwnedProjection: syncProjection,
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
    workspace, sender, physical, authority, renderers, sessions, ydoc, provider, openYDocSession, prepareNamed,
    adapter, capture, requireEngineCapture, getStatus, hasAgentRun, closeActivity, probe, move, reopen,
    notify, writable, requireWorkspace, displayName, syncProjection, canonicalWorkspaceFor, requireSessions,
    events, handlers, invoke, routed, retryOwnerLiveDelivery, retryCloudSync, retryFileObservation, automationRunOnThisComputer, relay, setMissingAdapter: () => { missingAdapter = true; },
    storeWorkspaces, readPolicy, identity, warmCredentialCache, readSyncHistory, historyCollections,
    /** The registry writes a new entry for this workspace, as every registry change does; null forgets it. */
    replaceEntry: (next: RegistryEntry | null) => { registry.entry = next; },
    sent, recordHistoryPersonName, prepareRecordHistoryPeople, recordHeldFiles,
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
  CHANNELS.locateRecordHistoryRun, historyOperations.listHistory.channel, CHANNELS.listEngineMoments, CHANNELS.readEngineMoment, CHANNELS.restoreEngineMomentFile,
  CHANNELS.getSyncStatus, captureRecoveryOperations.retryHeldCapture.channel, captureRecoveryOperations.getCaptureRecoveryStatus.channel, captureRecoveryOperations.clearCaptureRecovery.channel,
  fileObservationOperations.retryFileObservation.channel, CHANNELS.retryFileRecovery, CHANNELS.retryOwnerLiveDelivery, CHANNELS.retryCloudSync,
  CHANNELS.rebuildEngineStore,
  engineYDocAdmissionOperations.waitForEngineYDocAdmission.channel, engineYDocSaveOperations.retryEngineYDocSave.channel, CHANNELS.engineYDocOpen, CHANNELS.engineYDocReadArtifactAsset, CHANNELS.engineYDocApplyUpdate,
  CHANNELS.engineYDocAcknowledgeLineageReplacement, CHANNELS.engineYDocClose,
  CHANNELS.engineYDocPrepareOwnerHandoff,
];

describe("workspace engine IPC registrations", () => {
  it("handles a read rejection before workspace operation completion", async () => {
    const completed = deferred<void>();
    const read = deferred<void>();
    const attached = vi.spyOn(read.promise, "then");
    const h = await harness(undefined, undefined, { afterOperation: () => completed.promise, read: () => read.promise });
    const result = expect(h.invoke("desktop:retry-file-observation")).rejects.toThrow("read failed");
    try {
      await vi.waitFor(() => expect(h.retryFileObservation).toHaveBeenCalledOnce());
      expect(attached).toHaveBeenCalled();
      expect(attached.mock.calls.some(([, rejected]) => typeof rejected === "function")).toBe(true);
    } finally {
      // Keep the failing baseline test from leaking an unhandled rejection.
      void read.promise.catch(() => {});
      read.reject(new Error("read failed"));
      completed.resolve();
      await result;
    }
  });
  it("retries file observation only for this renderer's active workspace and propagates failure", async () => {
    const h = await harness();
    await h.invoke("desktop:retry-file-observation");
    expect(h.retryFileObservation).toHaveBeenCalledExactlyOnceWith("workspace");
    await expect(h.invoke("desktop:retry-file-observation", { workspaceId: "other" })).rejects.toThrow("no longer active");
    await expect(h.invoke("desktop:retry-file-observation", null, new Sender(-1))).rejects.toThrow("untrusted");
    expect(h.retryFileObservation).toHaveBeenCalledOnce();
    h.retryFileObservation.mockRejectedValueOnce(new Error("read failed"));
    await expect(h.invoke("desktop:retry-file-observation")).rejects.toThrow("read failed");
  });
  it("releases the record History lease before background account lookup finishes", async () => {
    const { createHistoryLabels } = await import("../automations/shareRoster");
    const h = await harness();
    const held = deferred<null>();
    const lookupAccounts = vi.fn(() => held.promise);
    const labels = createHistoryLabels({ snapshot: () => ({ roster: { grants: [], links: [], endedGrants: [], formerGrants: [] }, owner: true, context: 1, inventory: 1 }), lookupAccounts });
    h.recordHistoryPersonName.mockImplementation((workspaceId, userId) => {
      return labels.person(workspaceId, userId);
    });
    h.prepareRecordHistoryPeople.mockImplementation((workspaceId, userIds) => labels.prepare(workspaceId, userIds.map(userId => ({ userId }))));
    h.adapter.getCollectionRecord.mockResolvedValue({
      collection: { path: "tasks", objectId: "tasks", status: "valid", reasons: [] },
      record: { id: "a", path: "tasks/a.md", conflicted: false, values: [] }, nextBeforeHistoryId: null,
      history: [{ historyId: 1, field: "Status", previous: { present: false, value: null }, next: { present: true, value: "Done" },
        authorOriginId: "automation", actorKind: "automation", onBehalfOf: "ben", depth: 1, recordedAtMs: 1, automationRun: null, linkAuthor: null }],
    });
    await h.invoke(CHANNELS.getCollectionRecordHistory, { workspaceId: "workspace", collectionPath: "tasks", recordId: "a" });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(lookupAccounts).toHaveBeenCalledTimes(1);
    const removed = vi.fn();
    await h.authority.retireBinding(h.authority.currentBinding("workspace")!, { removeBinding: removed });
    expect(removed).toHaveBeenCalledTimes(1);
    held.resolve(null);
  });
  it.each(["human", "agent"] as const)("keeps a %s row's local person out of relay account lookup", async actorKind => {
    const { createHistoryLabels } = await import("../automations/shareRoster");
    const h = await harness();
    const lookupAccounts = vi.fn(async () => null);
    const labels = createHistoryLabels({ snapshot: () => ({ roster: { grants: [], links: [], endedGrants: [], formerGrants: [] }, owner: true, context: 1, inventory: 1 }), lookupAccounts });
    h.recordHistoryPersonName.mockImplementation((workspaceId, userId) => labels.person(workspaceId, userId));
    h.prepareRecordHistoryPeople.mockImplementation((workspaceId, userIds) => labels.prepare(workspaceId, userIds.map(userId => ({ userId }))));
    h.adapter.getCollectionRecord.mockResolvedValue({
      collection: { path: "tasks", objectId: "tasks", status: "valid", reasons: [] },
      record: { id: "a", path: "tasks/a.md", conflicted: false, values: [] }, nextBeforeHistoryId: null,
      history: [{ historyId: 1, field: "Status", previous: { present: false, value: null }, next: { present: true, value: "Done" },
        authorOriginId: actorKind === "human" ? "local:installation-1" : "helper", actorKind, onBehalfOf: "local:installation-1", depth: 0, recordedAtMs: 1, automationRun: null, linkAuthor: null }],
    });
    const page = await h.invoke(CHANNELS.getCollectionRecordHistory, { workspaceId: "workspace", collectionPath: "tasks", recordId: "a" });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect.soft(page).toMatchObject({ entries: [{ author: actorKind === "human" ? null : { kind: "agent", name: "Agent" } }] });
    if (actorKind === "agent") expect.soft(GetCollectionRecordHistoryResult.parse(page).entries[0]?.author).not.toHaveProperty("person");
    expect.soft(h.prepareRecordHistoryPeople).toHaveBeenCalledExactlyOnceWith("workspace", [], expect.any(Sender));
    expect.soft(h.recordHistoryPersonName).not.toHaveBeenCalled();
    expect(lookupAccounts).not.toHaveBeenCalled();
  });
  it("reads and persistently dismisses capture recovery only for this renderer's workspace", async () => {
    const h = await harness();
    const bridge = operationBridge(captureRecoveryOperations, async (channel, payload) => h.invoke(channel, payload));
    const recovery = { momentId: "recovery", versionId: "main", objectId: "object", path: "notes/a.md", captureMomentId: "capture", deleted: false };
    h.adapter.watcherStatus.mockResolvedValue({ running: true, degraded: false, terminal: false, phase: "ready", noAtomicPlacement: false, recoveryUnavailable: false, deferredWrites: [], keptFiles: [], captureRecoveries: [recovery], heldFiles: [], retainedCopies: { count: 0, bytes: 0 } });
    expect(await bridge.getCaptureRecoveryStatus({workspaceId: "workspace"})).toEqual({ captureRecoveries: [recovery] });
    expect(await bridge.clearCaptureRecovery({workspaceId: "workspace", momentId: "recovery"})).toBeUndefined();
    expect(h.adapter.clearCaptureRecovery).toHaveBeenCalledWith("recovery");
    await expect(h.invoke(captureRecoveryOperations.clearCaptureRecovery.channel, {workspaceId: "other", momentId: "recovery"})).rejects.toThrow();
    expect(h.adapter.clearCaptureRecovery).toHaveBeenCalledTimes(1);
    h.setMissingAdapter();
    await expect(h.invoke(captureRecoveryOperations.getCaptureRecoveryStatus.channel)).rejects.toThrow("not running");
  });
  it("retries and records held files only in the sender's workspace", async () => {
    const h = await harness();
    const bridge = operationBridge(captureRecoveryOperations, async (channel, payload) => h.invoke(channel, payload));
    await bridge.retryHeldCapture({ workspaceId: "workspace", path: "notes/a.md" });
    expect(h.adapter.retryHeldCapture).toHaveBeenCalledExactlyOnceWith("notes/a.md");
    expect(h.recordHeldFiles).toHaveBeenCalledExactlyOnceWith(h.physical, []);
    await expect(bridge.retryHeldCapture({ workspaceId: "other", path: "notes/a.md" })).rejects.toThrow("This workspace is no longer active.");
    expect(h.adapter.retryHeldCapture).toHaveBeenCalledOnce();
    expect(h.recordHeldFiles).toHaveBeenCalledOnce();
  });
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
    h.adapter.watcherStatus.mockResolvedValue({ running: true, degraded: false, terminal: false, phase: "ready", noAtomicPlacement: false, recoveryUnavailable: true, deferredWrites: [], keptFiles: [], captureRecoveries: [], heldFiles: [], retainedCopies: { count: 0, bytes: 0 } });
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

  it("keeps the host and healthy mount Collections when another mount cannot open", async () => {
    const h = await harness();
    h.workspace.shareMounts = ["broken", "healthy", "other"].map(label => ({
      shareId: label, label, granterEmail: null, relayUrl: "http://127.0.0.1:1234",
      grantedSelector: { paths: ["tasks"], versionId: null, access: "view" as const },
    }));
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    h.adapter.listCollections.mockImplementation(async () => {
      const call = calls++;
      if (call === 1) throw new Error("mount store refused");
      if (call === 2) await release.promise;
      if (call === 3) entered.resolve();
      return { collections: [{ path: "tasks", objectId: "schema", status: "valid", reasons: [] }] };
    });
    const listed = h.invoke(CHANNELS.listCollections);
    await entered.promise;
    release.resolve();
    await expect(listed).resolves.toEqual({ collections: [
      { path: "tasks", objectId: "schema", status: "valid", reasons: [] },
      { path: "shared-with-me/healthy/tasks", objectId: "schema", status: "valid", reasons: [] },
      { path: "shared-with-me/other/tasks", objectId: "schema", status: "valid", reasons: [] },
    ] });
    h.adapter.listCollections.mockRejectedValue(new Error("host store refused"));
    await expect(h.invoke(CHANNELS.listCollections)).rejects.toThrow("host store refused");
  });

  it("routes shared views through the received-share owner and strips only workspaceId from queries", async () => {
    const h = await harness();
    h.workspace.shareView = {
      shareId: "share", granterEmail: null, genericChatWritable: false,
      grantedSelector: { paths: ["data"], versionId: null, access: "view" },
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

  it("lists and reads an ended Edit share's retained schema and records within its saved selector", async () => {
    const h = await harness();
    h.workspace.shareView = {
      shareId: "share", granterEmail: null, genericChatWritable: false, ended: true,
      grantedSelector: { paths: ["data"], versionId: null, access: "edit" },
    };
    const collection = { path: "data", objectId: "schema", status: "valid" as const, reasons: [] };
    h.adapter.listCollections.mockResolvedValue({ collections: [collection,
      { ...collection, path: "private" }] });
    h.adapter.getCollection.mockResolvedValue({ ...collection,
      schema: { name: "Retained", description: null, fields: [], views: [] }, recordCount: 1 });
    const record = { id: "retained", path: "data/a.md", conflicted: false, values: [] };
    h.adapter.queryCollectionRecords.mockResolvedValue({ collection,
      records: [record, { ...record, id: "outside", path: "private/a.md" }], groups: null, nextCursor: null });
    await expect(h.invoke(CHANNELS.listCollections)).resolves.toEqual({ collections: [collection] });
    await expect(h.invoke(CHANNELS.getCollection, { workspaceId: "workspace", collectionPath: "data" }))
      .resolves.toMatchObject({ schema: { name: "Retained" }, recordCount: 1 });
    await expect(h.invoke(CHANNELS.queryCollectionRecords, { workspaceId: "workspace", collectionPath: "data" }))
      .resolves.toMatchObject({ records: [record] });
    for (const channel of [CHANNELS.getCollection, CHANNELS.queryCollectionRecords]) {
      await expect(h.invoke(channel, { workspaceId: "workspace", collectionPath: "private" })).rejects.toThrow("outside");
    }
    expect(h.routed).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ shareMount: true })));
    expect(h.requireEngineCapture).not.toHaveBeenCalled();
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
      onBehalfOf: null, depth: null, recordedAtMs: 1_000 - historyId, automationRun: null, linkAuthor: null, ...overrides,
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
        entry(5, { authorOriginId: "agent", actorKind: "agent", onBehalfOf: "person-local", depth: 0 }),
        entry(4, { authorOriginId: "codex", actorKind: "agent", onBehalfOf: "user-ana", depth: 0 }),
        entry(3, { actorKind: "human", authorOriginId: "user-ana", onBehalfOf: "user-ana" }),
        entry(2, { ...automation, onBehalfOf: "user-ana" }),
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
        { historyId: 4, author: { kind: "agent", name: "Agent", person: "user-ana" } },
        { historyId: 3, author: { kind: "human", name: "user-ana" } },
        { historyId: 2, author: { kind: "automation", name: stamp, person: "user-ana", run: null } },
      ],
    });
    expect(GetCollectionRecordHistoryResult.parse(page).entries[0]?.author).not.toHaveProperty("person");
    expect(h.prepareRecordHistoryPeople).toHaveBeenCalledExactlyOnceWith("workspace", ["person-local", "user-ana"], expect.any(Sender));
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
      writes: [], definitionChanged: false, chainStopped: false, neverStarted: false, undone: false, undoUnfinished: false,
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
      recordedAtMs: 1_000 - historyId, automationRun: { claimId, automationName: "Stamp" }, linkAuthor: null,
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
      writes: [], definitionChanged: false, chainStopped: false, neverStarted: false, undone: false, undoUnfinished: false,
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

  it("reads the sender's history and omits absent paging fields", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.listEngineMoments);
    expect(h.requireEngineCapture).toHaveBeenCalledWith("workspace", "Engine history");
    expect(h.capture.listMoments).toHaveBeenLastCalledWith({});
    await h.invoke(CHANNELS.listEngineMoments, { workspaceId: "workspace", objectId: "object-1", limit: 7, cursor: historyCursor(19) });
    expect(h.capture.listMoments).toHaveBeenLastCalledWith({ objectId: "object-1", limit: 7, cursor: historyCursor(19) });
    await expect(h.invoke(CHANNELS.listEngineMoments, { workspaceId: "workspace", objectId: "" })).rejects.toThrow();
    await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "moment" })).resolves.toEqual({ moment: null });
  });

  it("prepares every author of a History detail several people wrote", async () => {
    const h = await harness();
    const authors = [
      { kind: "named", userId: "u-ana", grantId: "g-1", grantGeneration: 1 },
      { kind: "named", userId: "u-ben", grantId: "g-dep", grantGeneration: 1 },
    ] as const;
    h.capture.readMoment.mockResolvedValueOnce({ protected: false, moment: {
      id: "m-both", workspaceId: "workspace", versionId: "main", objectId: "o-1", path: "notes/a.md", recordedAtMs: 1,
      operation: "write", metadata: { origin: "sync" }, authors: [...authors],
      payload: { before: null, after: { path: "notes/a.md", contentKind: "text", sha256: "a".repeat(64), byteLength: 3, text: "new" } },
    } });
    const result = await h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "m-both" });
    expect(h.prepareNamed).toHaveBeenCalledWith([...authors]);
    expect(result).toMatchObject({ moment: { authorLabels: ["Someone you shared with", "Someone you shared with"] } });
  });

  it("reads a shared view's imported history from its registered share mount without a capture", async () => {
    const summary = { id: "shared", versionId: "main", path: "notes/a.md", recordedAtMs: 1, operation: "write" as const,
      metadata: { origin: "local-file" }, momentOrder: 1, authors: [{ kind: "agent" as const, agentId: "trip-agent-hosted", onBehalfOf: "owner-person" }] };
    const listHistoryPage = vi.fn(async () => ({ activeVersion: { id: "main" }, ...historyPageFields,
       moments: [summary], nextCursor: null, latestMomentOrder: 1, protectedMoments: [],  }));
    const getMoment = vi.fn(async ({ momentId }: { workspaceId: string; momentId: string }) => momentId !== "shared" ? null : {
      ...summary, workspaceId: "workspace", objectId: "object",
      payload: { before: null, after: { path: "notes/a.md", contentKind: "text", sha256: "a".repeat(64), byteLength: 4, text: "body" } },
    });
    const h = await harness({ listHistoryPage, getMoment } as unknown as SharedHistoryStore);
    h.readPolicy.mockRejectedValue(new Error("Receiver policy must not gate imported history."));
    h.requireEngineCapture.mockRejectedValue(new Error("dohc could not start Engine history for this workspace."));
    await expect(h.invoke(CHANNELS.listEngineMoments, { workspaceId: "workspace", objectId: "object", limit: 5 })).resolves.toMatchObject({
      moments: [{ id: "shared", agentAuthorName: "trip-agent-hosted" }],
    });
    expect(listHistoryPage).toHaveBeenCalledWith({ workspaceId: "workspace", objectId: "object", limit: 5 });
    // The store opens the renderer's own attachment as a share mount; the payload names only the workspace.
    expect(h.storeWorkspaces).toEqual([expect.objectContaining({ workspaceId: "workspace", shareMount: true, attachmentId: h.physical.attachmentId })]);
    await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "shared" })).resolves.toMatchObject({
      moment: { id: "shared", agentAuthorName: "trip-agent-hosted", afterText: "body" },
    });
    // A guessed ID outside the imported share has no row in its store.
    await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "hidden-moment" })).resolves.toEqual({ moment: null });
    expect(h.readPolicy).not.toHaveBeenCalled();
    // Restore still needs a capture, which a shared view never has.
    await expect(h.invoke(CHANNELS.restoreEngineMomentFile, { workspaceId: "workspace", momentId: "shared" })).rejects.toThrow("Engine history");
    expect(h.requireEngineCapture).toHaveBeenCalledOnce();
    expect(h.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
    // A renderer showing another workspace cannot read this share's history.
    await h.renderers.open(h.sender, { workspaceId: "other", attachmentId: Symbol("other") }, "document-1");
    await expect(h.invoke(CHANNELS.listEngineMoments)).rejects.toThrow();
    expect(listHistoryPage).toHaveBeenCalledOnce();
  });

  it("propagates missing capture admission before all history work", async () => {
    const h = await harness();
    h.requireEngineCapture.mockRejectedValue(new Error("capture unavailable"));
    for (const channel of [CHANNELS.listEngineMoments, CHANNELS.readEngineMoment, CHANNELS.restoreEngineMomentFile]) {
      await expect(h.invoke(channel, { workspaceId: "workspace", ...(channel === CHANNELS.listEngineMoments ? {} : { momentId: "moment" }) })).rejects.toThrow("capture unavailable");
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
      nextCursor: null, latestMomentOrder: 1, activeVersionId: "main", ...historyPageFields,
    });
    const names = async () => ((await h.invoke(CHANNELS.listEngineMoments)) as { moments: Array<{ agentAuthorName?: string }> })
      .moments.map((moment) => moment.agentAuthorName);
    await expect(names()).resolves.toEqual(["You", "Agent"]);
    h.displayName.mockImplementation((agentId) => agentId === "agent" ? "ice@example.com" : undefined);
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

  it("uses Settings names for your agents and handshake names for other agents", async () => {
    const h = await harness();
    h.capture.listMoments.mockResolvedValue({
      moments: [{ agentId: "agent", agentRunId: "run-1" }, { agentId: "Pat" }, { agentId: "dohc-mcp" }].map((identity, index) => ({
        id: `moment-${index}`, versionId: "main", path: "notes/a.md", recordedAtMs: 1,
        operation: "write", metadata: { origin: "local-file" }, protected: false, momentOrder: index,
        authors: [{ kind: "agent", onBehalfOf: "person-local", ...identity }],
      })),
      nextCursor: null, latestMomentOrder: 1, activeVersionId: "main", ...historyPageFields,
    });
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({
      moments: [{ agentAuthorName: "You" }, { agentAuthorName: "Pat" }, { agentAuthorName: "Agent" }],
    });
    h.displayName.mockImplementation((agentId) => agentId === "agent" ? "ice@example.com" : undefined);
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

  it("names each agent's changes by that agent, with the name Settings gives it now", async () => {
    const h = await harness();
    const settingsNames = new Map([["nova", "Nova"], ["codex", "Codex"]]);
    h.displayName.mockImplementation((agentId) => settingsNames.get(agentId));
    h.capture.listMoments.mockResolvedValue({
      // Codex's last change came through dohc's command line, which records no run id.
      moments: [{ agentId: "nova", agentRunId: "run-1" }, { agentId: "codex", agentRunId: "run-2" }, { agentId: "codex" }].map((run, index) => ({
        id: `moment-${index}`, versionId: "main", path: "notes/a.md", recordedAtMs: 1,
        operation: "write", metadata: { origin: "local-file" }, protected: false, momentOrder: index,
        authors: [{ kind: "agent", onBehalfOf: "person-local", ...run }],
      })),
      nextCursor: null, latestMomentOrder: 2, activeVersionId: "main", ...historyPageFields,
    });
    const recordChange = (historyId: number, authorOriginId: string): CollectionGetRecordResult["history"][number] => ({
      historyId, field: "Status", previous: { present: false, value: null }, next: { present: true, value: "Done" },
      authorOriginId, actorKind: "agent", onBehalfOf: "person-local", depth: 0, recordedAtMs: 1, automationRun: null, linkAuthor: null,
    });
    h.adapter.getCollectionRecord.mockResolvedValue({
      collection: { path: "tasks", objectId: "tasks", status: "valid", reasons: [] },
      record: { id: "a", path: "tasks/a.md", conflicted: false, values: [] }, nextBeforeHistoryId: null,
      history: [recordChange(1, "nova"), recordChange(2, "codex")],
    });
    const names = async () => {
      const moments = (await h.invoke(CHANNELS.listEngineMoments)) as { moments: Array<{ agentAuthorName?: string }> };
      const record = GetCollectionRecordHistoryResult.parse(await h.invoke(CHANNELS.getCollectionRecordHistory, { workspaceId: "workspace", collectionPath: "tasks", recordId: "a" }));
      return [...moments.moments.map((moment) => moment.agentAuthorName), ...record.entries.map(({ author }) => author?.kind === "agent" ? author.name : null)];
    };
    await expect(names()).resolves.toEqual(["Nova", "Codex", "Codex", "Nova", "Codex"]);
    // A rename shows at once, and an agent removed from Settings keeps its id.
    settingsNames.set("codex", "Kit");
    settingsNames.delete("nova");
    await expect(names()).resolves.toEqual(["nova", "Kit", "Kit", "nova", "Kit"]);
  });

  it("restores as the person signed in here, never one the renderer names, and History names them", async () => {
    const h = await harness();
    h.capture.readMoment.mockResolvedValue(historyDetail());
    await h.invoke(CHANNELS.restoreEngineMomentFile, { workspaceId: "workspace", momentId: "moment",
      author: { kind: "human", humanId: "mallory" } });
    expect(h.capture.restoreFileToBeforeMoment).toHaveBeenCalledWith("moment", { kind: "human", humanId: "person-local" });

    const restore = (id: string, humanId: string) => ({
      id, versionId: "main", path: "notes/a.md", recordedAtMs: 1, operation: "write" as const,
      metadata: { origin: "restore" as const }, protected: false as const, momentOrder: 0, authors: [{ kind: "human" as const, humanId }],
    });
    h.capture.listMoments.mockResolvedValue({
      moments: [restore("mine", "person-local"), restore("earlier-account", "person-before")],
      nextCursor: null, latestMomentOrder: 1, activeVersionId: "main", ...historyPageFields,
    });
    const listed = (await h.invoke(CHANNELS.listEngineMoments)) as { moments: EngineMomentRecord[] };
    expect(listed.moments.map((moment) => moment.personAuthorName)).toEqual(["Ice", undefined]);
    expect(listed.moments.map(engineMomentSourceLabel)).toEqual(["Ice", "Restore"]);
  });

  it("names a hosted agent's live edit by the account holder and agent its author snapshot admitted", async () => {
    const h = await harness();
    const settled = (id: string, authors: NonNullable<Awaited<ReturnType<WorkspaceEngineCapture["listMoments"]>>["moments"][number]["authors"]>) => ({
      id, versionId: "main", path: "notes/a.md", recordedAtMs: 1, operation: "write" as const,
      metadata: { origin: "local-file" as const }, protected: false as const, momentOrder: 0, authors,
    });
    const owner = { kind: "human" as const, humanId: "person-local", humanName: "Owner Account" };
    h.capture.listMoments.mockResolvedValue({
      moments: [
        settled("hosted", [owner, { kind: "agent", agentId: "writer", onBehalfOf: "person-local" }]),
        settled("named", [owner, { kind: "agent", agentId: "writer", agentName: "Trip helper", onBehalfOf: "person-local" }]),
        settled("account", [owner]),
        settled("link", [{ kind: "link", publicPrincipalId: "public_1", label: "Anonymous" }]),
      ],
      nextCursor: null, latestMomentOrder: 1, activeVersionId: "main", ...historyPageFields,
    });
    const listed = (await h.invoke(CHANNELS.listEngineMoments)) as { moments: EngineMomentRecord[] };
    expect(listed.moments.map(engineMomentSourceLabel)).toEqual([
      "Owner Account, writer", "Owner Account, Trip helper", "Owner Account", "Link holder Anonymous",
    ]);
    expect(listed.moments.map((moment) => moment.authors?.length)).toEqual([2, 2, 1, 1]);
  });

  describe("History author presentation", () => {
    type Authors = NonNullable<Awaited<ReturnType<WorkspaceEngineCapture["listMoments"]>>["moments"][number]["authors"]>;
    const account: CloudCredentials = { serverUrl: "https://account.test", email: "ice@example.test", userId: "person-local", token: "token", relayUrl: "https://relay.test" };
    const sam = { kind: "named" as const, userId: "sam", grantId: "grant-sam", grantGeneration: 1 };
    const page = (...authors: Authors[]) => ({
      moments: authors.map((each, index) => ({ ...historyDetail().moment, id: `m-${index}`, protected: false as const, momentOrder: index, authors: each })),
      nextCursor: null, latestMomentOrder: 1, activeVersionId: "main", ...historyPageFields,
    });
    const tokens = async (h: Awaited<ReturnType<typeof harness>>) =>
      ((await h.invoke(CHANNELS.listEngineMoments)) as { moments: EngineMomentRecord[] }).moments.map(moment => moment.authorPresentations);

    it("draws own-store authors as chats do, for list and detail", async () => {
      const h = await harness();
      h.workspace.remote = { serverUrl: "https://account.test/", ownerUserId: "person-local" };
      h.identity.credentials = account;
      h.capture.listMoments.mockResolvedValue(page(
        [{ kind: "human", humanId: "person-local" }], [{ kind: "human", humanId: "install-local" }], [sam],
        [sam, { kind: "agent", agentId: "writer", onBehalfOf: "person-local" }],
      ));
      const [mine, signedOut, named, both] = await tokens(h);
      expect(h.warmCredentialCache).toHaveBeenCalledOnce();
      expect(mine).toEqual([{ ...ownActorPresentation("install-local", account), group: expect.any(String) }]);
      expect(signedOut).toEqual([{ ...ownActorPresentation("install-local", null), group: expect.any(String) }]);
      expect(mine![0]!.group).not.toBe(signedOut![0]!.group);
      expect(named).toEqual([{ group: expect.any(String), hue: ACTOR_HUES[actorHueSlot("sam")], self: false }]);
      expect(both).toEqual([named![0], { group: expect.any(String), hue: null, self: true }]);
      h.capture.readMoment.mockResolvedValue({ ...historyDetail(), moment: { ...historyDetail().moment, authors: [sam] } });
      await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "moment" })).resolves.toMatchObject({
        moment: { namedAuthor: { userId: "sam" }, authorPresentations: named },
      });
    });

    it("loads with named authors neutral when the workspace server is invalid", async () => {
      const h = await harness();
      h.workspace.remote = { serverUrl: "not a server", ownerUserId: "person-local" };
      h.identity.credentials = account;
      h.capture.listMoments.mockResolvedValue(page([sam], [{ kind: "human", humanId: "person-local" }]));
      const [named, mine] = await tokens(h);
      expect(named).toEqual([{ group: expect.stringMatching(/^unknown:/), hue: null, self: false }]);
      // A server History can't read can't confirm the account is yours.
      expect(mine![0]!.self).toBe(false);
    });

    it("keeps an account on another server from being you in a store synced to this one", async () => {
      const h = await harness();
      h.workspace.remote = { serverUrl: "https://other.test", ownerUserId: "owner-other" };
      h.identity.credentials = account;
      h.capture.listMoments.mockResolvedValue(page([{ kind: "human", humanId: "person-local" }], [{ kind: "human", humanId: "install-local" }]));
      const [sameId, installation] = await tokens(h);
      expect(sameId).toEqual([{ group: expect.any(String), hue: ownActorPresentation("install-local", account).hue, self: false }]);
      expect(installation![0]!.self).toBe(true);
    });

    it("keeps received authors issuerless and never self, whatever this computer is signed in as", async () => {
      const listHistoryPage = vi.fn(async () => ({ activeVersion: { id: "main" }, protectedMoments: [],
        ...page([sam], [{ kind: "human", humanId: "person-local" }], [{ kind: "human", humanId: "install-local" }]) }));
      const h = await harness({ listHistoryPage, getMoment: vi.fn(async () => null) } as unknown as SharedHistoryStore);
      h.workspace.remote = { serverUrl: "https://account.test", ownerUserId: "person-local" };
      h.identity.credentials = account;
      const [named, person, installation] = await tokens(h);
      expect(named).toEqual([{ group: expect.stringMatching(/^unknown:/), hue: null, self: false }]);
      expect(person![0]!.self).toBe(false);
      expect(installation![0]!.self).toBe(false);
    });

    it("refuses to draw tokens for a workspace that closed during the read", async () => {
      const h = await harness();
      h.capture.listMoments.mockImplementation(async () => {
        h.replaceEntry(null);
        return page([sam]);
      });
      await expect(h.invoke(CHANNELS.listEngineMoments)).rejects.toThrow();
    });

    const toOtherServer = (h: Awaited<ReturnType<typeof harness>>) =>
      h.replaceEntry({ ...h.workspace, remote: { serverUrl: "https://other.test", ownerUserId: "owner-other" } });

    it("stops a read whose registry entry was replaced, after each wait", async () => {
      const replace = toOtherServer;
      const during = await harness();
      during.capture.listMoments.mockImplementation(async () => { replace(during); return page([sam]); });
      await expect(during.invoke(CHANNELS.listEngineMoments)).rejects.toThrow("the workspace changed");
      const warming = await harness();
      warming.warmCredentialCache.mockImplementation(async () => { replace(warming); });
      await expect(warming.invoke(CHANNELS.listEngineMoments)).rejects.toThrow("the workspace changed");
      expect(warming.capture.listMoments).not.toHaveBeenCalled();
      const capturing = await harness();
      capturing.requireEngineCapture.mockImplementation(async () => { replace(capturing); return { capture: capturing.capture }; });
      await expect(capturing.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "moment" })).rejects.toThrow("the workspace changed");
      expect(capturing.warmCredentialCache).not.toHaveBeenCalled();
    });

    // None of these reaches a token, so only the read's own checks can stop it.
    it.each([
      ["the policy read, before a policy error", CHANNELS.listEngineMoments, (h: Awaited<ReturnType<typeof harness>>, replace: () => void) =>
        h.readPolicy.mockImplementation(async () => { replace(); return { filesPolicy: null, visibilityPolicy: null, errors: ["line 1"], unreadable: [".dohc/files.toml"] }; })],
      ["a detail's policy read, before a policy error", CHANNELS.readEngineMoment, (h: Awaited<ReturnType<typeof harness>>, replace: () => void) =>
        h.readPolicy.mockImplementation(async () => { replace(); return { filesPolicy: null, visibilityPolicy: null, errors: ["line 1"], unreadable: [".dohc/files.toml"] }; })],
      ["an empty page", CHANNELS.listEngineMoments, (h: Awaited<ReturnType<typeof harness>>, replace: () => void) =>
        h.capture.listMoments.mockImplementation(async () => { replace(); return page(); })],
      ["an authorless detail", CHANNELS.readEngineMoment, (h: Awaited<ReturnType<typeof harness>>, replace: () => void) =>
        h.capture.readMoment.mockImplementation(async () => { replace(); return historyDetail(); })],
      ["the object's path lookup", CHANNELS.listEngineMoments, (h: Awaited<ReturnType<typeof harness>>, replace: () => void) => {
        h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
        h.capture.listMoments.mockResolvedValue(historyPage("private/a.md"));
        h.capture.filePathForObjectId.mockImplementation(async () => { replace(); return "private/a.md"; });
      }],
    ] as const)("stops a read whose server changed during %s", async (_await, channel, arrange) => {
      const h = await harness();
      arrange(h, () => toOtherServer(h));
      const payload = channel === CHANNELS.listEngineMoments ? { objectId: "object-1", limit: 5 } : { momentId: "moment" };
      await expect(h.invoke(channel, { workspaceId: "workspace", ...payload })).rejects.toThrow("the workspace changed");
    });

    it.each([
      // The workspace authority retires an operation whose folder changed.
      ["its folder moves", { rootPath: "C:/moved" }, "This workspace changed while this ran. Try again."],
      ["it becomes a shared view", { shareView: {} as NonNullable<RegistryEntry["shareView"]> }, "the workspace changed"],
    ])("stops a read when %s", async (_change, fields, message) => {
      const h = await harness();
      h.capture.listMoments.mockImplementation(async () => {
        h.replaceEntry({ ...h.workspace, ...fields });
        return page([sam]);
      });
      await expect(h.invoke(CHANNELS.listEngineMoments)).rejects.toThrow(message);
    });

    it("keeps reading through a registry write that leaves its folder, server, and shared view alone", async () => {
      const h = await harness();
      h.capture.listMoments.mockImplementation(async () => {
        h.replaceEntry({ ...h.workspace, lastOpenedAt: 99 });
        return page([sam]);
      });
      await expect(tokens(h)).resolves.toEqual([[{ group: expect.any(String), hue: null, self: false }]]);
    });

    it("draws the timeline's file authors as the moment list does, and stops it on a server change", async () => {
      const h = await harness();
      h.workspace.remote = { serverUrl: "https://account.test/", ownerUserId: "person-local" };
      h.identity.credentials = account;
      h.capture.listMoments.mockResolvedValue(page([{ kind: "human", humanId: "person-local" }], [sam]));
      const byId = (moments: EngineMomentRecord[]) => Object.fromEntries(moments.map(moment => [moment.id, moment.authorPresentations]));
      const listed = byId(((await h.invoke(CHANNELS.listEngineMoments)) as { moments: EngineMomentRecord[] }).moments);
      const timeline = await h.invoke(historyOperations.listHistory.channel, { workspaceId: "workspace", object: { kind: "file", objectId: "object" } }) as
        { entries: Array<{ moment: EngineMomentRecord }> };
      expect(byId(timeline.entries.map(entry => entry.moment))).toEqual(listed);
      expect(listed["m-0"]![0]!.self).toBe(true);
      h.capture.listMoments.mockImplementation(async () => { toOtherServer(h); return page([sam]); });
      await expect(h.invoke(historyOperations.listHistory.channel, { workspaceId: "workspace", object: { kind: "file", objectId: "object" } }))
        .rejects.toThrow("the workspace changed");
    });

    it("keeps an account from being you in a folder that synced and has no remote now", async () => {
      const h = await harness();
      h.identity.credentials = account;
      h.capture.listMoments.mockResolvedValue(page([{ kind: "human", humanId: "person-local" }], [{ kind: "human", humanId: "install-local" }]));
      const [unsynced] = await tokens(h);
      expect(unsynced![0]!.self).toBe(true);
      h.readSyncHistory.mockResolvedValue("synced");
      const [synced, installation] = await tokens(h);
      expect(synced).toEqual([{ group: expect.any(String), hue: ownActorPresentation("install-local", account).hue, self: false }]);
      expect(installation![0]!.self).toBe(true);
      // History reads the attached folder by its canonical path.
      expect(h.readSyncHistory).toHaveBeenCalledWith("C:/canonical");
      // A record dohc can't read may say the folder synced.
      h.readSyncHistory.mockResolvedValue("unknown");
      const [unreadable] = await tokens(h);
      expect(unreadable![0]!.self).toBe(false);
    });
  });

  it("notifies after a restore and before parsing its result", async () => {
    const h = await harness();
    h.capture.readMoment.mockResolvedValue(historyDetail());
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
    expect(h.syncProjection).toHaveBeenCalledWith(h.physical, refused);
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
    expect(h.writable).toHaveBeenCalledWith(h.physical);
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
    expect(h.invoke(CHANNELS.engineYDocApplyUpdate, { sessionId: openPayload.sessionId, update, lineageGeneration: 1, requestId: "11111111-1111-4111-8111-111111111111", seq: 1 })).toEqual({ accepted: true });
    expect(h.provider.applyLocalUpdate).toHaveBeenCalledWith(update, expect.any(Function), { idempotencyKey: "11111111-1111-4111-8111-111111111111",
      actorOriginId: "person-local", attribution: { actorKind: "human", onBehalfOf: "person-local", depth: 0 } });
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

const policyRoots: string[] = [];
afterEach(async () => {
  await Promise.all(policyRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function policyWorkspace() {
  const path = await mkdtemp(join(tmpdir(), "dohc-history-policy-"));
  policyRoots.push(path);
  await mkdir(join(path, ".dohc"));
  return path;
}
function historyDetail(path = "notes/a.md", beforePath: string | null = null, afterPath = path) {
  return { protected: false as const, moment: {
    id: "moment", workspaceId: "workspace", versionId: "main", objectId: "object",
    path, recordedAtMs: 1, operation: beforePath && beforePath !== path ? "rename" as const : "write" as const,
    metadata: { origin: "local-file" as const, summary: "Saved latest edits" },
    payload: { before: beforePath ? { path: beforePath, contentKind: "text" as const, sha256: "b".repeat(64), byteLength: 3, text: "old" } : null,
      after: { path: afterPath, contentKind: "text" as const, sha256: "a".repeat(64), byteLength: 4, text: "body" } },
  } };
}
function historyPage(path = "notes/a.md") {
  return { moments: [{ ...historyDetail(path).moment, protected: false, momentOrder: 10 }],
    nextCursor: historyCursor(8), latestMomentOrder: 10, activeVersionId: "main", ...historyPageFields,  };
}

describe("owner History path policy", () => {
  it.each([false, true])("preserves the request start cursor after skipping with policy=%s", async policy => {
    const h = await harness();
    if (policy) h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
    const start = historyCursor(100);
    const marker = { id: "draft", workspaceId: "workspace", kind: "named" as const, name: "Draft", createdAtMs: 90 };
    h.capture.listMoments
      .mockResolvedValueOnce({ ...historyPage("private/a.md"), moments: policy ? historyPage("private/a.md").moments : [], startCursor: start, nextCursor: historyCursor(80), versionMarkers: [marker] })
      .mockResolvedValueOnce({ ...historyPage(), startCursor: historyCursor(80), nextCursor: null });
    await expect(h.invoke(CHANNELS.listEngineMoments, { workspaceId: "workspace", cursor: start })).resolves.toMatchObject({
      startCursor: start, moments: [{ path: "notes/a.md" }], versionMarkers: [marker], nextCursor: null,
    });
    expect(h.capture.listMoments).toHaveBeenCalledTimes(2);
  });

  it("skips marker-only pages without policy filtering", async () => {
    const h = await harness();
    const marker = { id: "draft", workspaceId: "workspace", kind: "named" as const, name: "Draft", createdAtMs: 90 };
    h.capture.listMoments
      .mockResolvedValueOnce({ ...historyPage(), moments: [], versionMarkers: [marker], nextCursor: historyCursor(8) })
      .mockResolvedValueOnce({ ...historyPage("notes/old.md"), startCursor: historyCursor(8), nextCursor: null });
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({ moments: [{ path: "notes/old.md" }], startCursor: historyPageFields.startCursor, versionMarkers: [marker] });
    expect(h.capture.listMoments).toHaveBeenCalledTimes(2);
  });

  it("reaches admitted moments after more than 500 excluded moments", async () => {
    const h = await harness();
    h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
    for (let i = 0; i < 12; i += 1) h.capture.listMoments.mockResolvedValueOnce({ ...historyPage("private/a.md"), moments: Array(50).fill(historyPage("private/a.md").moments[0]), nextCursor: historyCursor(2_000 - (i + 1) * 50) });
    h.capture.listMoments.mockResolvedValueOnce({ ...historyPage(), nextCursor: null });
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({ moments: [{ path: "notes/a.md" }] });
    expect(h.capture.listMoments).toHaveBeenCalledTimes(13);
  });
  it("keeps version markers when a page's file moments are excluded", async () => {
    const h = await harness();
    h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
    const marker = { id: "draft", workspaceId: "workspace", kind: "named" as const, name: "Draft", createdAtMs: 10 };
    h.capture.listMoments
      .mockResolvedValueOnce({ ...historyPage("private/a.md"), versionMarkers: [marker] })
      .mockResolvedValueOnce({ ...historyPage("notes/old.md"), nextCursor: null });
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({
      moments: [{ path: "notes/old.md" }], versionMarkers: [marker], nextCursor: null,
    });
    expect(h.capture.listMoments).toHaveBeenCalledTimes(2);
  });

  it("skips excluded pages to reach older admitted History", async () => {
    const h = await harness();
    h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
    h.capture.listMoments
      .mockResolvedValueOnce({ ...historyPage("private/a.md"), nextCursor: historyCursor(800), latestMomentOrder: 1000,  })
      .mockResolvedValueOnce({ ...historyPage("private/b.md"), nextCursor: historyCursor(600), latestMomentOrder: 1000 })
      .mockResolvedValueOnce({ ...historyPage("notes/old.md"), nextCursor: historyCursor(400), latestMomentOrder: 1000 });
    await expect(h.invoke(CHANNELS.listEngineMoments, { workspaceId: "workspace", limit: 50 })).resolves.toMatchObject({
      moments: [{ path: "notes/old.md" }], nextCursor: historyCursor(400), latestMomentOrder: 1000,
    });
    expect(h.capture.listMoments.mock.calls).toEqual([[{ limit: 50 }], [{ limit: 50, cursor: historyCursor(800) }], [{ limit: 50, cursor: historyCursor(600) }]]);
  });

  it("bounds excluded-page reads and leaves a cursor to continue", async () => {
    const h = await harness();
    h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
    h.capture.listMoments.mockImplementation(async ({ cursor } = {}) => ({
      ...historyPage("private/a.md"), nextCursor: historyCursor((cursor?.text?.momentOrder ?? 2000) - 50),
    }));
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({ moments: [], nextCursor: historyCursor(0) });
    expect(h.capture.listMoments).toHaveBeenCalledTimes(40);
  });

  it("caps five-row requests at 40 pages instead of making 400 capture reads", async () => {
    const h = await harness();
    h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
    h.capture.listMoments.mockImplementation(async ({ cursor } = {}) => ({
      ...historyPage("private/a.md"), nextCursor: historyCursor((cursor?.text?.momentOrder ?? 2000) - 5),
    }));
    await expect(h.invoke(CHANNELS.listEngineMoments, { workspaceId: "workspace", limit: 5 })).resolves.toMatchObject({
      moments: [], nextCursor: historyCursor(1800),
    });
    expect(h.capture.listMoments).toHaveBeenCalledTimes(40);
  });

  it.each([undefined, { ...historyCursor(8), objectId: "object-1" }])("loads ordinary object History without a path lookup with cursor=%s", async cursor => {
    const h = await harness();
    h.capture.listMoments.mockResolvedValue(historyPage());
    await expect(h.invoke(CHANNELS.listEngineMoments, {
      workspaceId: "workspace", objectId: "object-1", limit: 5, ...(cursor ? { cursor } : {}),
    })).resolves.toMatchObject({ moments: [{ path: "notes/a.md" }] });
    expect(h.capture.filePathForObjectId).not.toHaveBeenCalled();
    expect(h.capture.listMoments).toHaveBeenCalledExactlyOnceWith({
      objectId: "object-1", limit: 5, ...(cursor ? { cursor } : {}),
    });
  });

  it("does not skip through an object's old pages when its current path is excluded", async () => {
    const h = await harness();
    h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
    h.capture.filePathForObjectId.mockResolvedValue("private/a.md");
    h.capture.listMoments.mockResolvedValue(historyPage("private/a.md"));
    await expect(h.invoke(CHANNELS.listEngineMoments, { workspaceId: "workspace", objectId: "object-1", limit: 5 })).resolves.toMatchObject({
      moments: [], nextCursor: null,
    });
    expect(h.capture.filePathForObjectId).toHaveBeenCalledExactlyOnceWith("object-1");
    expect(h.capture.listMoments).toHaveBeenCalledExactlyOnceWith({ objectId: "object-1", limit: 5 });
  });

  it("stops skipping at the end of History", async () => {
    const h = await harness();
    h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
    h.capture.listMoments.mockResolvedValue({ ...historyPage("private/a.md"), nextCursor: null });
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({ moments: [], nextCursor: null });
    expect(h.capture.listMoments).toHaveBeenCalledTimes(1);
  });
  it("retires captured list and detail after exclusion, including a reopened window", async () => {
    const path = await policyWorkspace();
    for (let pass = 0; pass < 2; pass += 1) {
      const h = await harness(undefined, path);
      h.capture.listMoments.mockResolvedValue(historyPage());
      h.capture.readMoment.mockResolvedValue(historyDetail());
      if (pass === 0) {
        await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({ moments: [{ path: "notes/a.md" }] });
        await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "moment" })).resolves.toMatchObject({ moment: { afterText: "body" } });
        await writeFile(join(path, ".dohc", "files.toml"), '[[rule]]\npath = "notes/**"\ntracked = false\n');
      }
      h.readPolicy.mockClear();
      await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toEqual({ ...historyPage(), moments: [] });
      expect(h.readPolicy).toHaveBeenCalledExactlyOnceWith(path);
      await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "moment" })).resolves.toEqual({ status: "untracked", moment: null });
    }
  });

  // A change History never had is not one the rules hide.
  it("answers a missing change without calling it untracked", async () => {
    const h = await harness();
    h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
    h.capture.readMoment.mockResolvedValue(null);
    await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "gone" })).resolves.toEqual({ moment: null });
  });

  it.each(["moment", "before", "after"])("admits the %s path before returning a guessed detail", async side => {
    const h = await harness();
    h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
    h.capture.readMoment.mockResolvedValue(historyDetail(side === "moment" ? "private/a.md" : "notes/a.md",
      side === "before" ? "private/a.md" : "notes/a.md", side === "after" ? "private/a.md" : "notes/a.md"));
    await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "guessed" })).resolves.toEqual({ status: "untracked", moment: null });
  });

  it.each([".env", ".dohc/internal.md", "notes//a.md"])("keeps ordinary %s rows behind CLI path admission", async path => {
    const h = await harness();
    h.capture.listMoments.mockResolvedValue(historyPage(path));
    h.capture.readMoment.mockResolvedValue(historyDetail(path));
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({ moments: [], nextCursor: historyCursor(8), latestMomentOrder: 10 });
    await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "moment" })).resolves.toEqual({ status: "untracked", moment: null });
  });

  it("keeps protected activity, its metadata-only detail and its reverse path", async () => {
    const h = await harness();
    const protectedMoment = { id: "secret", workspaceId: "workspace", versionId: "main", path: ".env", recordedAtMs: 1,
      momentOrder: 10, protected: true as const, operation: "write" as const, metadata: { origin: "local-file" as const } };
    h.capture.listMoments.mockResolvedValue({ ...historyPage(), moments: [{ ...protectedMoment, protected: true, momentOrder: 10 }] });
    h.capture.readMoment.mockResolvedValue({ protected: true, moment: protectedMoment });
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toMatchObject({ moments: [{ id: "secret", protected: true }] });
    await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "secret" })).resolves.toMatchObject({ moment: { protected: true, beforeText: null, afterText: null } });
    await h.invoke(CHANNELS.restoreEngineMomentFile, { workspaceId: "workspace", momentId: "secret" });
    expect(h.capture.restoreFileToBeforeMoment).toHaveBeenCalledWith("secret", { kind: "human", humanId: "person-local" });
  });

  it("fails closed with typed policy state for malformed files.toml, including protected activity", async () => {
    const path = await policyWorkspace();
    await writeFile(join(path, ".dohc", "files.toml"), "[[rules] invalid");
    const h = await harness(undefined, path);
    const protectedMoment = { id: "secret", workspaceId: "workspace", versionId: "main", path: ".env", recordedAtMs: 1,
      momentOrder: 10, protected: true as const, operation: "write" as const, metadata: { origin: "local-file" as const } };
    h.capture.listMoments.mockResolvedValue({ ...historyPage(), moments: [...historyPage().moments, protectedMoment] });
    h.capture.readMoment.mockResolvedValue({ protected: true, moment: protectedMoment });
    const blocked = { status: "policy-unreadable", unreadable: [".dohc/files.toml"], policyErrors: expect.arrayContaining([expect.stringContaining("files.toml")]) };
    await expect(h.invoke(CHANNELS.listEngineMoments)).resolves.toEqual(blocked);
    await expect(h.invoke(CHANNELS.readEngineMoment, { workspaceId: "workspace", momentId: "moment" })).resolves.toEqual({ ...blocked, moment: null });
    expect(h.capture.listMoments).not.toHaveBeenCalled();
    expect(h.capture.readMoment).not.toHaveBeenCalled();
    expect(h.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
  });

  it("refuses unknown restore ids without writing or notifying", async () => {
    const h = await harness();
    h.capture.restoreFileToBeforeMoment.mockRejectedValue(new Error("This history moment is no longer available."));
    await expect(h.invoke(CHANNELS.restoreEngineMomentFile, { workspaceId: "workspace", momentId: "unknown" })).rejects.toThrow("This history moment is no longer available.");
    expect(h.capture.restoreFileToBeforeMoment).toHaveBeenCalledWith("unknown", { kind: "human", humanId: "person-local" });
    expect(h.capture.readMoment).not.toHaveBeenCalled();
    expect(h.readPolicy).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe("merged History IPC", () => {
  it("rejects a reply after this renderer changes workspace", async () => {
    const h = await harness(), reached = deferred<void>(), reply = deferred<Awaited<ReturnType<WorkspaceEngineCapture["listMoments"]>>>();
    h.capture.listMoments.mockImplementation(async () => { reached.resolve(); return reply.promise; });
    const result = Promise.resolve(h.invoke(historyOperations.listHistory.channel));
    const rejected = expect(result).rejects.toThrow("window changed workspaces");
    await reached.promise;
    await h.renderers.open(h.sender, { workspaceId: "other", attachmentId: Symbol("other") }, "document-1");
    reply.resolve({ ...historyPage(), nextCursor: null });
    await rejected;
  });

  it("fails closed before reading either source when policy is unreadable", async () => {
    const h = await harness();
    h.readPolicy.mockResolvedValue({ filesPolicy: null, visibilityPolicy: null, errors: ["Invalid policy"], unreadable: [".dohc/files.toml"] });
    await expect(h.invoke(historyOperations.listHistory.channel)).resolves.toMatchObject({ status: "policy-unreadable" });
    expect(h.capture.listMoments).not.toHaveBeenCalled();
    expect(h.historyCollections).not.toHaveBeenCalled();
  });

  it("discards policy-hidden positions and retains protected activity", async () => {
    const h = await harness();
    h.readPolicy.mockResolvedValue({ filesPolicy: [{ path: "private/**", tracked: false }], visibilityPolicy: null, errors: [], unreadable: [] });
    const hidden = historyPage("private/a.md").moments[0]!;
    h.capture.listMoments.mockResolvedValue({ ...historyPage(), moments: [hidden, { ...hidden, id: "protected", protected: true, momentOrder: 9 }], nextCursor: null });
    await expect(h.invoke(historyOperations.listHistory.channel)).resolves.toMatchObject({ status: "ready", entries: [{ kind: "file", moment: { id: "protected" } }], nextCursor: null });
  });

  it("reads imported share scope without owner capture, policy, or Collection access", async () => {
    const listHistoryPage = vi.fn(async () => ({ activeVersion: { id: "main" }, ...historyPageFields,
      moments: historyPage().moments, nextCursor: null, latestMomentOrder: 10, protectedMoments: [] }));
    const h = await harness({ listHistoryPage, getMoment: vi.fn(async () => null) } as unknown as SharedHistoryStore);
    await expect(h.invoke(historyOperations.listHistory.channel, { workspaceId: "workspace", object: { kind: "file", objectId: "object" } })).resolves.toMatchObject({ status: "ready", entries: [{ kind: "file" }] });
    expect(listHistoryPage).toHaveBeenCalledWith({ workspaceId: "workspace", objectId: "object", limit: 50 });
    expect(h.requireEngineCapture).not.toHaveBeenCalled();
    expect(h.readPolicy).not.toHaveBeenCalled();
    expect(h.historyCollections).not.toHaveBeenCalled();
  });

  it("keeps Collections out of named versions and routes per-file object identity", async () => {
    const h = await harness();
    h.capture.listMoments.mockResolvedValue({ ...historyPage(), startCursor: { ...historyPageFields.startCursor, versionId: "branch" }, moments: [], nextCursor: null });
    const local = vi.fn(() => ({ pages: [], transferred: [], sourceIds: [], sourceCount: 0 }));
    h.historyCollections.mockResolvedValue({ scope: "test", local, remote: async () => { throw Error("unexpected remote"); } });
    await expect(h.invoke(historyOperations.listHistory.channel, { workspaceId: "workspace", versionId: "branch" })).resolves.toMatchObject({ versionId: "branch", entries: [] });
    expect(local).not.toHaveBeenCalled();
    expect(h.historyCollections).not.toHaveBeenCalled();
    await h.invoke(historyOperations.listHistory.channel, { workspaceId: "workspace", versionId: "branch", object: { kind: "file", objectId: "object" } });
    expect(h.capture.listMoments).toHaveBeenLastCalledWith({ limit: 50, versionId: "branch", objectId: "object" });
    expect(h.historyCollections).not.toHaveBeenCalled();
  });
});

it("shows file History without Collections when another computer keeps them, and still fails on any other Collection error", async () => {
  const h = await harness();
  h.capture.listMoments.mockResolvedValue({ ...historyPage(), nextCursor: null });
  h.historyCollections.mockRejectedValue(new CollectionsRefusalError({ kind: "elsewhere", computer: { installId: "install-laptop", label: "Laptop" }, sameName: false }));
  await expect(h.invoke(historyOperations.listHistory.channel)).resolves.toMatchObject({ status: "ready", entries: [{ kind: "file" }] });
  expect(h.historyCollections).toHaveBeenCalledOnce();
  h.historyCollections.mockRejectedValue(new Error("Collection storage is full."));
  await expect(h.invoke(historyOperations.listHistory.channel)).rejects.toThrow("Collection storage is full.");
});

it("does not start the Collection host for main per-file History", async () => {
  const h = await harness();
  await h.invoke(historyOperations.listHistory.channel, { workspaceId: "workspace", object: { kind: "file", objectId: "object" } });
  expect(h.historyCollections).not.toHaveBeenCalled();
});

it("keys timeline prefetches by the lazily resolved workspace attachment scope", async () => {
  const h = await harness(), datasetId = "00000000-0000-4000-8000-000000000008";
  let scope = "attachment-one", calls = 0;
  const remote = vi.fn(async () => {
    calls++;
    return { datasetId, name: "Collection", lineage: "a".repeat(64), headRevision: 2,
      entries: [{ revision: 2, recordedAtMs: 2000 }, { revision: 1, recordedAtMs: 1000 }].map(row => ({
        ...row, operation: "Add record", callerReference: null, approvedRevisionHash: "b".repeat(64), changesetBytes: 0, attachmentCount: 0
      })), nextBeforeRevision: null };
  });
  h.historyCollections.mockImplementation(async () => ({ scope, local: () => ({ pages: [], transferred: [datasetId], sourceIds: [datasetId], sourceCount: 1 }), remote }));
  const input = { workspaceId: "workspace", object: { kind: "dataset", datasetId }, limit: 1 };
  await h.invoke(historyOperations.listHistory.channel, input);
  await vi.waitFor(() => expect(calls).toBe(2));
  scope = "attachment-two";
  // Refresh and consume the same revision. The old attachment's cache must not match.
  await h.invoke(historyOperations.listHistory.channel, input);
  await vi.waitFor(() => expect(calls).toBe(4));
});
