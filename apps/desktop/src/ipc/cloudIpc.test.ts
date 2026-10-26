import { installWorkspaceDataKey, SECRET_KEY_RELATIVE_PATH } from "../workspaces/workspaceDataKey";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicCreateFile } from "../atomicReplaceFile";
import { createTestScratch } from "../workspaces/testTemp";
import { ownActorPresentation } from "../workspaces/actorPresentation";
import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { RelayUnauthorizedError, RelayWorkspaceUnavailableError, RelayClaimRefusedError, RelayKeyEnvelopeMissingError } from "@dohc/workspace-contracts/relay";
import { CHANNELS } from "./channels";
import { workspaceSyncPauseStatus } from "@dohc/workspace-contracts/workspace-sync";
import { syncPauseFor } from "../workspaces/syncPauseFor";
import { createWorkspaceSyncStop } from "../workspaces/stopWorkspaceSync";
import { enrollWorkspaceKeyEnvelope } from "../workspaces/workspaceKeyEnvelopeEnrollment";
import { registerCloudIpcHandlers } from "./cloudIpc";
import { ipcWireError } from "./errorWords";
import { ipcErrorMessage } from "../renderer/ipcError";
import { workspaceSyncOperations, type SyncStatusResult } from "./bridgeContract";
import { createWorkspaceRootApproval } from "./workspaceRegistryIpc";
import { CredentialSessionCache } from "../workspaces/credentialSessionCache";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { CloudLogin } from "../workspaces/cloudLogin";
import type { EngineRelayWorkspaceClient } from "../workspaces/engineRelayClient";
import type { RegistryEntry } from "../workspaces/registryStore";
import { createJoinedWorkspaceRunner } from "../workspaces/createJoinedWorkspace";
import { createWorkspaceAuthorityOwner, type PhysicalWorkspace } from "../workspaces/workspaceAuthorityOwner";
import { createRendererWorkspaceOperationRunner, type ExactRendererWorkspaceOperation } from "../window/rendererWorkspaceOperation";
import { workspaceWriteRefusal } from "../workspaces/shareWriteGate";
import { chatShareSessionKey } from "../mainChatIpcHandlers";
import { buildSyncCode } from "../workspaces/syncCode";
import { deferred } from "../testing/deferred";

vi.mock("../atomicReplaceFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atomicReplaceFile")>();
  return { ...actual, atomicCreateFile: vi.fn(actual.atomicCreateFile) };
});

const credentials: CloudCredentials = {
  serverUrl: "https://account.example.test", relayUrl: "https://relay.example.test",
  token: "token", userId: "member", email: "member@example.test",
};
const status: SyncStatusResult = {
  state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null,
  historyRecordingUnavailable: false, historyShareView: false, liveSessionsGeneration: 0,
};

it("binds workspace cloud status before reading workspace secrets", async () => {
  const h = await harness();
  h.registry.set("other", { ...h.workspace, workspaceId: "other", rootPath: `${h.workspace.rootPath}-other` });
  await expect(h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" })).resolves.toMatchObject({ connected: true });
  const services = [h.readSecrets];
  services.forEach(service => service.mockClear());
  await expect(h.invoke(CHANNELS.cloudStatus, { workspaceId: "other" })).rejects.toThrow("no longer active");
  services.forEach(service => expect(service).not.toHaveBeenCalled());
  await expect(h.invoke(CHANNELS.cloudStatus, {})).resolves.toMatchObject({ connected: true });
});

it.each(["login", "startup"] as const)("does not hold cloud status admission during device %s reads", async stage => {
  const h = await harness();
  const entered = deferred();
  const drain = deferred();
  if (stage === "login") h.login.status.mockImplementation(async () => {
    entered.resolve(); await drain.promise; return { connected: true, email: credentials.email };
  });
  else h.daemonStartup.mockImplementation(async () => { entered.resolve(); await drain.promise; });
  const result = h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" });
  const outcome = result.catch((error: unknown) => error);
  let retiring: Promise<void> | undefined;
  try {
    await entered.promise;
    retiring = h.authorities.invalidate("existing");
    await vi.waitFor(() => expect(h.disposed).toHaveBeenCalledOnce());
    await retiring;
    h.retireRenderer();
  } finally {
    drain.resolve();
    await Promise.allSettled([outcome, retiring]);
  }
  expect(h.readSecrets).not.toHaveBeenCalled();
  expect(await outcome).toMatchObject({ message: "This workspace is no longer active." });
});

async function harness() {
  const steps: string[] = [];
  const home = resolve("/cloud-ipc-home").replace(/\\/g, "/");
  const rootPath = `${home}/joined`;
  const roots = createWorkspaceRootApproval(() => home);
  roots.approveRoot(rootPath);
  const workspace: RegistryEntry = { workspaceId: "existing", rootPath: `${home}/existing`, kind: "personal", mode: "local-first" };
  const registry = new Map([[workspace.workspaceId, workspace]]);
  const disposed = vi.fn();
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id: string) => registry.get(id) ?? null,
    canonicalizeRoot: (root: string) => root, createState: () => ({}), disposeState: disposed,
  });
  const attachmentId = await authorities.withOperation("existing", (operation) => operation.workspace.attachmentId);
  let rendererCurrent = true;
  const session = { workspaceId: "existing", attachmentId, generation: 1, isCurrent: () => rendererCurrent };
  let rendererSession = session;
  type Event = { sender: string; trusted: boolean };
  type Workspace = PhysicalWorkspace<RegistryEntry>;
  type Operation = ExactRendererWorkspaceOperation<Workspace, object, typeof session>;
  type Dependencies = Parameters<typeof registerCloudIpcHandlers<string, Event, Operation>>[0];
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<string, Workspace, object, typeof session>({
    currentSession: () => rendererSession,
    withPhysicalOperation: (id, work) => authorities.withOperation(id, work),
  });
  const cache = new CredentialSessionCache<CloudCredentials>();
  cache.set(credentials);
  const login = {
    start: vi.fn<CloudLogin["start"]>(async () => ({ userCode: "ABCD", verificationUri: "https://account.example.test/verify" })),
    poll: vi.fn<CloudLogin["poll"]>(async () => ({ status: "pending" })),
    status: vi.fn<CloudLogin["status"]>(async () => ({ connected: true, email: credentials.email })),
    credentials: vi.fn<CloudLogin["credentials"]>(async () => credentials),
    logout: vi.fn(async () => { steps.push("logout"); }),
  };
  const stop = vi.fn(async () => { steps.push("stop"); });
  const closeRelay = vi.fn(async () => { steps.push("close-relay"); });
  const claim = vi.fn(async () => { steps.push("claim"); });
  // These opaque collaborators are used only by the injected I/O functions below.
  const sessions = {} as EngineWorkspaceSessions;
  const downloadKeyEnvelope = vi.fn(async () => ({ envelopeJson: "existing-envelope", etag: "a".repeat(64) }));
  const uploadKeyEnvelope = vi.fn(async () => ({ etag: "b".repeat(64) }));
  const relay = { claim, downloadKeyEnvelope, uploadKeyEnvelope } as unknown as EngineRelayWorkspaceClient;
  const daemonStartup = vi.fn<() => Promise<void>>(async () => undefined);
  const readSecrets = vi.fn<Dependencies["readWorkspaceSecretState"]>(async () => "none");
  const readDataKey = vi.fn<Dependencies["readWorkspaceDataKeyForEnrollment"]>(async () => null);
  const enroll = vi.fn<Dependencies["enrollWorkspaceKeyEnvelope"]>(async () => { steps.push("enroll"); });
  const installDataKey = vi.fn<Dependencies["installWorkspaceDataKey"]>(async () => undefined);
  const bootstrap = vi.fn<Dependencies["bootstrapJoinedWorkspace"]>(async () => { steps.push("bootstrap"); });
  const probe = vi.fn<Dependencies["probeRelayWorkspace"]>(async () => {
    steps.push("probe");
    return { hasContent: true, identity: { replicationEpoch: "epoch", streamIdentity: "stream" } };
  });
  const readdir = vi.fn(async (_root: string) => [] as string[]);
  const mkdir = vi.fn(async () => { steps.push("mkdir"); });
  const bindRelay = vi.fn<Dependencies["relayClientForWorkspace"]>(() => relay);
  const setRemote = vi.fn<Dependencies["setWorkspaceRemote"]>(async (id, remote) => {
    steps.push("remote");
    registry.get(id)!.remote = remote;
    delete registry.get(id)!.pausedRemote;
    delete registry.get(id)!.syncPause;
  });
  const enable = vi.fn<Dependencies["activity"]["enableCloud"]>(async () => { steps.push("enable"); });
  const notify = vi.fn(() => { steps.push("notify"); });
  const changing = vi.fn<Dependencies["notifyCloudSessionChangedWithKey"]>();
  const ready = vi.fn<Dependencies["notifyCloudSessionChanged"]>();
  const createFolder = vi.fn(async (input: { workspaceId?: string; rootPath: string }) => {
    steps.push("create");
    return { workspaceId: input.workspaceId!, rootPath: input.rootPath, kind: "personal" as const, mode: "local-first" as const };
  });
  const cleanup = vi.fn(async () => { steps.push("cleanup"); });
  const removeJoinedWorkspace = vi.fn<Parameters<typeof createJoinedWorkspaceRunner>[0]["remove"]>((binding, finalize) => authorities.retireBinding(binding, {
    finalize, removeBinding: () => { registry.delete(binding.workspaceId); },
  }));
  const createJoinedWorkspace = createJoinedWorkspaceRunner({
    canonicalizeRoot: (root) => root, reserve: (input) => authorities.reserveBinding(input), createFolder,
    register: (reservation, entry) => authorities.registerReservedBinding(reservation, entry, {
      persist: () => { steps.push("register"); registry.set(entry.workspaceId, entry); },
      rollback: () => { registry.delete(entry.workspaceId); },
    }),
    remove: removeJoinedWorkspace,
    release: (reservation, finalize) => authorities.releaseReservation(reservation, finalize),
    closeRelay: cleanup, rollbackComplete: notify, logError: vi.fn(),
  });
  const stopWorkspaceSync = vi.fn<Dependencies["stopWorkspaceSync"]>(async operation => ({
    workspaceId: operation.workspace.workspaceId, workspaceSynced: false,
    status,
  }));
  const preparePause = vi.fn(async () => () => {});
  const pauseStatus = (pause: import("@dohc/workspace-contracts/workspace-sync").WorkspaceSyncPause) => workspaceSyncPauseStatus(pause, "local");
  const stopOperation = createWorkspaceSyncStop({
    person: async () => ({ kind: "person", personId: "local" }),
    pauseStatus,
    withOwnerHostPaused: work => work(), prepare: preparePause, resume: enable,
    pauseRemote: (id, syncPause) => { const entry = registry.get(id)!; entry.pausedRemote = entry.remote; delete entry.remote; entry.syncPause = syncPause; },
    closeActivity: async () => {}, closeRelay: async () => {}, openActivity: async () => {}, collectionsWaiting: async () => false,
    status: id => ({ ...status, ...(registry.get(id)?.syncPause ? { syncPause: pauseStatus(registry.get(id)!.syncPause!) } : {}) }), notify: () => {}, cleanupFailed: vi.fn(),
    reopenFailed: vi.fn(),
  });
  stopWorkspaceSync.mockImplementation(stopOperation);
  const openActivity = vi.fn<Dependencies["openWorkspaceActivity"]>(async (_entry, options) => { steps.push("open"); await options.afterActivityOpen(); });
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  registerCloudIpcHandlers<string, Event, Operation>({
    registerHandler: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    assertTrustedSender: (event) => { if (!event.trusted) throw new Error("untrusted"); },
    cloudLogin: () => login,
    localInstallationId: () => "device",
    clearCachedCredentials: () => { steps.push("clear"); cache.clear(); },
    refreshCredentialCache: async () => { steps.push("refresh"); await cache.refresh(login.credentials); },
    warmCredentialCache: async () => { await cache.warm(login.credentials); },
    currentCredentials: () => cache.snapshot().credentials,
    loadAndCacheCurrentCredentials: async () => {
      const loaded = await cache.adoptCurrent(login.credentials);
      if (!loaded.current) throw new Error("Your server session changed. Try again.");
      return loaded.credentials;
    },
    closeAllRelayTransportWorkspaces: closeRelay,
    activity: { stopEngines: stop, enableCloud: enable, getStatus: () => status },
    currentWorkspaceId: () => rendererSession.isCurrent() ? rendererSession.workspaceId : null, stopWorkspaceSync,
    syncPauseFor: workspace => syncPauseFor(workspace, "local"),
    reconcileCloud: () => { steps.push("reconcile"); },
    notifyCloudSessionChanged: ready, notifyCloudSessionChangedWithKey: changing, notifyRenderer: notify,
    findWorkspace: (id) => registry.get(id) ?? null,
    engineDaemonStartup: daemonStartup, requireEngineSessions: () => sessions, currentEngineSessions: () => sessions,
    withRendererWorkspaceOperation,
    receivedShareEngine: { workspaceForRegistered: (entry) => entry },
    readWorkspaceSecretState: readSecrets, readWorkspaceDataKeyForEnrollment: readDataKey,
    assertWritableWorkspace: (entry) => {
      const refusal = workspaceWriteRefusal(entry.shareView);
      if (refusal) throw new Error(refusal);
    },
    relayClientForWorkspace: bindRelay, enrollWorkspaceKeyEnvelope: enroll,
    installWorkspaceDataKey: installDataKey, setWorkspaceRemote: setRemote,
    usableRoot: roots.usableRoot, readdir, mkdir, probeRelayWorkspace: probe,
    createJoinedWorkspace, bootstrapJoinedWorkspace: bootstrap,
    refreshNativeWorkspaceSurfaces: () => { steps.push("surfaces"); },
    openWorkspaceActivity: openActivity,
    completeWorkspaceJoinBootstrap: (id) => { steps.push("complete"); delete registry.get(id)!.joinBootstrapPending; },
    desktopMarks: { mark: () => { steps.push("mark"); }, measureSince: () => { steps.push("measure"); } },
  });
  const invoke = async (channel: string, payload?: unknown, trusted = true) => handlers.get(channel)!({ sender: "window", trusted }, payload);
  const joinPayload = { rootPath, syncCode: buildSyncCode({ workspaceId: "joined", relayUrl: credentials.relayUrl! }) };
  return {
    handlers, invoke, removeJoinedWorkspace, stopWorkspaceSync, stopOperation, preparePause, openActivity, downloadKeyEnvelope, uploadKeyEnvelope, joinPayload, roots, workspace, registry, authorities, cache, login,
    stop, closeRelay, claim, readSecrets, readDataKey, enroll, bootstrap, installDataKey, probe, readdir, mkdir,
    bindRelay, setRemote, enable, notify, changing, ready, createFolder, cleanup, steps, daemonStartup, disposed,
    retireRenderer: () => { rendererCurrent = false; },
    reopenRenderer: () => {
      rendererCurrent = false;
      rendererSession = { ...session, generation: 2, isCurrent: () => true };
    },
  };
}

describe("registered cloud handlers", () => {
  it.each(["enable", "join"] as const)("preserves the unsupported-drive key refusal during %s", async action => {
    const h = await harness();
    const root = await createTestScratch("dohc-key-cloud-words-");
    await mkdir(dirname(join(root, SECRET_KEY_RELATIVE_PATH)), { recursive: true });
    vi.mocked(atomicCreateFile).mockRejectedValueOnce(
      Object.assign(new Error("link failed"), { code: "ENOTSUP", syscall: "link" }),
    );
    h.installDataKey.mockImplementation((_root, key) => installWorkspaceDataKey(root, key));
    h.enroll.mockImplementationOnce(input => input.installDataKey(Buffer.alloc(32, 7)));
    h.bootstrap.mockImplementationOnce(input => input.installDataKey(Buffer.alloc(32, 7)));
    const result = action === "enable"
      ? h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" })
      : h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload);
    const expected = action === "enable"
      ? "This drive can't store the workspace's secret key safely. Move the workspace to an NTFS, APFS or ext4 drive, then try again."
      : `This drive can't store the workspace's secret key safely. Files remain in ${h.joinPayload.rootPath}. Choose an empty folder on an NTFS, APFS or ext4 drive to try again.`;
    const failure = await result.catch(error => error);
    expect(failure).toMatchObject({ message: expected });
    const channel = action === "enable" ? CHANNELS.cloudEnableSync : CHANNELS.cloudJoinWorkspace;
    const received = new Error(`Error invoking remote method '${channel}': ${String(ipcWireError(failure))}`);
    expect(ipcErrorMessage(received, "Couldn't sync the workspace.")).toBe(expected);
    expect(h.installDataKey).toHaveBeenCalledOnce();
    expect(h.enable).not.toHaveBeenCalled();
    if (action === "join") {
      expect(h.cleanup).toHaveBeenCalledWith("joined");
      expect(h.registry.has("joined")).toBe(false);
    }
  });

  it.each(["https://account.example.test?query=1", "https://account.example.test#fragment"])("keeps cloud status available with malformed account URL %s", async (serverUrl) => {
    const h = await harness();
    h.cache.set({ ...credentials, serverUrl });
    h.login.status.mockResolvedValue({ connected: true, email: credentials.email, serverUrl });
    await expect(h.invoke(CHANNELS.cloudStatus)).resolves.toMatchObject({
      connected: true, email: credentials.email, serverUrl,
      ownPresentation: ownActorPresentation("device", null),
    });
  });
  it("registers the original sequence and rejects untrusted senders before any work", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([
      CHANNELS.cloudLoginStart, CHANNELS.cloudLoginPoll, CHANNELS.cloudStatus,
      CHANNELS.cloudLogout, CHANNELS.cloudEnableSync, workspaceSyncOperations.cloudStopSync.channel, CHANNELS.cloudJoinWorkspace,
    ]);
    for (const channel of h.handlers.keys()) await expect(h.invoke(channel, null, false)).rejects.toThrow("untrusted");
    for (const method of Object.values(h.login)) expect(method).not.toHaveBeenCalled();
    expect(h.steps).toEqual([]);
  });

  it("derives stop from the current window and refuses renderer-supplied identities", async () => {
    const h = await harness();
    await expect(h.invoke(workspaceSyncOperations.cloudStopSync.channel, { workspaceId: "joined" })).rejects.toThrow();
    expect(h.stopWorkspaceSync).not.toHaveBeenCalled();
    h.stopWorkspaceSync.mockImplementationOnce(async operation => {
      expect(operation.workspace).toMatchObject({ workspaceId: "existing", attachmentId: expect.any(Symbol) });
      return { workspaceId: operation.workspace.workspaceId, workspaceSynced: false, status };
    });
    await expect(h.invoke(workspaceSyncOperations.cloudStopSync.channel)).resolves.toMatchObject({
      workspaceId: "existing", workspaceSynced: false,
    });
    expect(h.stopWorkspaceSync).toHaveBeenCalledOnce();
  });

  it("rejects a late stop answer for a retired renderer workspace", async () => {
    const h = await harness();
    const entered = deferred(), held = deferred();
    h.stopWorkspaceSync.mockImplementationOnce(async operation => {
      entered.resolve(); await held.promise;
      return { workspaceId: operation.workspace.workspaceId, workspaceSynced: false, status };
    });
    const pending = h.invoke(workspaceSyncOperations.cloudStopSync.channel);
    await entered.promise;
    h.retireRenderer(); held.resolve();
    await expect(pending).rejects.toThrow();
  });

  it("queues stop behind an in-flight enable of the same workspace", async () => {
    const h = await harness();
    const entered = deferred(), held = deferred();
    h.claim.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
    const enabling = h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" });
    await entered.promise;
    const stopping = h.invoke(workspaceSyncOperations.cloudStopSync.channel);
    expect(h.preparePause).not.toHaveBeenCalled();
    held.resolve(); await enabling; await stopping;
    expect(h.enable).toHaveBeenCalledOnce();
    expect(h.preparePause).toHaveBeenCalledOnce();
    expect(h.workspace.remote).toBeUndefined();
  });

  it("refuses a queued stop from an earlier visit to the same workspace", async () => {
    const h = await harness();
    const entered = deferred(), held = deferred();
    h.claim.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
    const enabling = h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" });
    await entered.promise;
    const stopping = h.invoke(workspaceSyncOperations.cloudStopSync.channel);
    h.reopenRenderer();
    const refused = Promise.all([expect(enabling).rejects.toThrow(), expect(stopping).rejects.toThrow()]);
    held.resolve(); await refused;
    expect(h.preparePause).not.toHaveBeenCalled();
    await expect(h.invoke(workspaceSyncOperations.cloudStopSync.channel)).resolves.toMatchObject({ workspaceId: "existing" });
  });

  it("parses login inputs and returns only the public result", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.cloudLoginStart, { serverUrl: credentials.serverUrl });
    expect(h.login.start).toHaveBeenCalledWith(credentials.serverUrl);
    await expect(h.invoke(CHANNELS.cloudLoginStart, { serverUrl: "invalid" })).rejects.toThrow();
    expect(h.login.start).toHaveBeenCalledOnce();
    h.login.poll.mockResolvedValue({ status: "pending" });
    await expect(h.invoke(CHANNELS.cloudLoginPoll)).resolves.toEqual({ status: "pending" });
    expect(h.steps).toEqual([]);
  });

  it("announces the incoming account before held login cleanup and adopts its new token afterward", async () => {
    const h = await harness();
    const incoming = { ...credentials, token: "new-token" };
    h.login.poll.mockResolvedValue({ status: "complete", email: incoming.email });
    h.login.credentials.mockResolvedValue(incoming);
    const started = deferred();
    const held = deferred();
    h.stop.mockImplementation(() => { h.steps.push("stop"); started.resolve(); return held.promise; });
    const generation = h.cache.snapshot().generation;
    const result = h.invoke(CHANNELS.cloudLoginPoll);
    await started.promise;
    expect(h.cache.snapshot()).toEqual({ credentials: null, generation: generation + 1 });
    expect(h.changing).toHaveBeenCalledWith(chatShareSessionKey(incoming), "changing");
    expect(h.ready).not.toHaveBeenCalled();
    held.resolve();
    await expect(result).resolves.toEqual({ status: "complete", email: incoming.email });
    expect(h.cache.snapshot().credentials).toBe(incoming);
    expect(h.steps).toEqual(["clear", "stop", "close-relay", "refresh", "reconcile"]);
    expect(h.closeRelay).toHaveBeenCalledWith({ accountChanged: true });
    expect(h.ready).toHaveBeenCalledWith("ready");
  });

  it("invalidates logout before the credential store settles and still cleans up after failure", async () => {
    const h = await harness();
    const started = deferred();
    const held = deferred();
    h.login.logout.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.cloudLogout);
    await started.promise;
    expect(h.cache.snapshot().credentials).toBeNull();
    expect(h.ready).toHaveBeenCalledWith("ready");
    held.reject(new Error("store failed"));
    await expect(result).rejects.toThrow("store failed");
    expect(h.steps).toEqual(["clear", "stop", "close-relay", "notify"]);
    expect(h.closeRelay).toHaveBeenCalledWith({ accountChanged: true });
  });

  it("waits for daemon startup and rejects a secret-status result from a retired physical workspace", async () => {
    const h = await harness();
    const startup = deferred();
    const waiting = deferred();
    h.daemonStartup.mockImplementation(() => { waiting.resolve(); return startup.promise; });
    const reading = deferred();
    const secret = deferred<"none">();
    h.readSecrets.mockImplementation(() => { reading.resolve(); return secret.promise; });
    const result = h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" });
    await waiting.promise;
    expect(h.readSecrets).not.toHaveBeenCalled();
    startup.resolve();
    await reading.promise;
    const drained = h.authorities.invalidate("existing");
    secret.resolve("none");
    await expect(result).rejects.toThrow("This workspace was closed. Open it again.");
    await drained;
  });

  it("reports the named workspace's connection without exposing cached credentials", async () => {
    const h = await harness();
    h.workspace.remote = { serverUrl: credentials.serverUrl, ownerUserId: credentials.userId };
    h.login.status.mockResolvedValue({ ...credentials, connected: true });
    await expect(h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" })).resolves.toEqual({
      ownPresentation: ownActorPresentation("device", credentials),
      connected: true, email: credentials.email, serverUrl: credentials.serverUrl,
      relayUrl: credentials.relayUrl,
      workspaceSyncOwned: true, workspaceSynced: true, workspaceServerUrl: credentials.serverUrl,
      workspaceSyncConnected: true, workspaceSecretState: "none",
    });
    h.cache.set({ ...credentials, userId: "other" });
    await expect(h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" })).resolves.toMatchObject({ workspaceSyncConnected: false });
  });

  it.each(["renderer", "authority"] as const)("stops enrollment after a claim when its %s retires", async (reason) => {
    const h = await harness();
    const started = deferred();
    const held = deferred();
    h.claim.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" });
    await started.promise;
    let drained: Promise<void> | undefined;
    if (reason === "renderer") h.retireRenderer();
    else drained = h.authorities.invalidate("existing");
    held.resolve();
    await expect(result).rejects.toThrow();
    await drained;
    expect(h.readDataKey).not.toHaveBeenCalled();
    expect(h.setRemote).not.toHaveBeenCalled();
    expect(h.enable).not.toHaveBeenCalled();
  });

  it("rejects credentials retired during enrollment's load before claiming a relay workspace", async () => {
    const h = await harness();
    const started = deferred();
    const held = deferred<CloudCredentials>();
    h.login.credentials.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" });
    await started.promise;
    h.cache.clear();
    held.resolve(credentials);
    await expect(result).rejects.toThrow("session changed");
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("keeps enrollment bound to the attachment and installs its envelope before recording the remote", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing", passphrase: "phrase" })).resolves.toEqual(status);
    expect(h.bindRelay).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "existing", rootPath: h.workspace.rootPath, attachmentId: expect.any(Symbol),
      accountId: credentials.userId,
      relay: { baseUrl: credentials.relayUrl, token: credentials.token },
    }));
    expect(h.enroll).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "existing", dataKey: null, passphrase: "phrase" }));
    expect(h.steps).toEqual(["claim", "enroll", "remote", "enable"]);
  });

  it("starts sync only after the remote and its folder record are written, and not when that write fails", async () => {
    const h = await harness();
    const started = deferred();
    const held = deferred();
    h.setRemote.mockImplementationOnce(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" });
    await started.promise;
    expect(h.enable).not.toHaveBeenCalled();
    const failure = Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    held.reject(failure);
    await expect(result).rejects.toBe(failure);
    expect(h.enable).not.toHaveBeenCalled();
  });

  it("does not start sync for a window that switched workspaces while the remote was written", async () => {
    const h = await harness();
    const started = deferred();
    const held = deferred();
    h.setRemote.mockImplementationOnce(async (id, remote) => {
      started.resolve();
      await held.promise;
      h.steps.push("remote");
      h.registry.get(id)!.remote = remote;
    });
    const result = h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" });
    await started.promise;
    h.retireRenderer();
    held.resolve();
    await expect(result).rejects.toThrow();
    expect(h.steps).toEqual(["claim", "enroll", "remote"]);
    expect(h.enable).not.toHaveBeenCalled();
  });

  it.each([
    new RelayWorkspaceUnavailableError(),
    new RelayClaimRefusedError("Another account already claimed this workspace."),
  ])("preserves the enrollment claim failure: %s", async (error) => {
    const h = await harness();
    h.claim.mockRejectedValueOnce(error);
    await expect(h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" })).rejects.toBe(error);
    expect(h.enroll).not.toHaveBeenCalled();
    expect(h.enable).not.toHaveBeenCalled();
  });

  it("rejects received views and an existing remote owned by another account before claiming", async () => {
    const h = await harness();
    h.workspace.shareView = {
      shareId: "share", granterEmail: null, genericChatWritable: false,
      grantedSelector: { paths: ["shared.md"], versionId: null, access: "view" },
    };
    await expect(h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" })).rejects.toThrow();
    expect(h.login.credentials).not.toHaveBeenCalled();
    delete h.workspace.shareView;
    h.workspace.remote = { serverUrl: credentials.serverUrl, ownerUserId: "other" };
    await expect(h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" })).rejects.toThrow("account that synced");
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("refuses a foreign relay and an unapproved root before probing or creating a join", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.cloudJoinWorkspace, { ...h.joinPayload, syncCode: "broken" })).rejects.toThrow("workspace code");
    expect(h.login.credentials).not.toHaveBeenCalled();
    await expect(h.invoke(CHANNELS.cloudJoinWorkspace, {
      ...h.joinPayload, syncCode: buildSyncCode({ workspaceId: "joined", relayUrl: "https://foreign.example.test" }),
    })).rejects.toThrow("different server");
    await expect(h.invoke(CHANNELS.cloudJoinWorkspace, { ...h.joinPayload, rootPath: `${h.joinPayload.rootPath}-sibling` })).rejects.toThrow("chosen through dohc");
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.createFolder).not.toHaveBeenCalled();
  });

  it.each([
    [new RelayWorkspaceUnavailableError(), "No synced workspace matches"],
    [new RelayUnauthorizedError(), "session expired"],
  ])("maps a failed join probe before creating local state", async (error, message) => {
    const h = await harness();
    h.probe.mockRejectedValue(error);
    await expect(h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload)).rejects.toThrow(message as string);
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.createFolder).not.toHaveBeenCalled();
  });

  it("rejects a populated destination and an empty relay before creating local state", async () => {
    const h = await harness();
    h.readdir.mockResolvedValue(["keep.md"]);
    await expect(h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload)).rejects.toThrow("Choose an empty folder");
    expect(h.probe).not.toHaveBeenCalled();
    h.readdir.mockResolvedValue([]);
    h.probe.mockResolvedValue({ hasContent: false, identity: null });
    await expect(h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload)).rejects.toThrow("hasn't synced anything yet");
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.createFolder).not.toHaveBeenCalled();
  });

  it("holds local creation behind join preflight and bootstraps before registration and capture", async () => {
    const h = await harness();
    const started = deferred();
    const held = deferred<{ hasContent: boolean; identity: null }>();
    h.probe.mockImplementation(() => { h.steps.push("probe"); started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload);
    await started.promise;
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.createFolder).not.toHaveBeenCalled();
    expect(h.registry.has("joined")).toBe(false);
    h.cache.set({ ...credentials, userId: "account-b", token: "account-b-token" });
    held.resolve({ hasContent: true, identity: null });
    await expect(result).resolves.toEqual({ workspace: {
      workspaceId: "joined", rootPath: h.joinPayload.rootPath, kind: "personal", mode: "local-first",
    } });
    expect(h.steps).toEqual(["probe", "mkdir", "mark", "create", "bootstrap", "register", "surfaces", "open", "remote", "enable", "complete", "measure", "notify"]);
    expect(h.enable).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "joined" }), { joinBootstrap: true });
    expect(h.registry.get("joined")?.joinBootstrapPending).toBeUndefined();
    expect(h.bindRelay.mock.calls[0]?.[0]).not.toHaveProperty("attachmentId");
    expect(h.bindRelay).toHaveBeenCalledWith(expect.objectContaining({
      accountId: credentials.userId,
      relay: { baseUrl: credentials.relayUrl, token: credentials.token },
    }));
  });

  it("waits for daemon startup before creating a joined workspace", async () => {
    const h = await harness();
    const startup = deferred();
    const waiting = deferred();
    h.daemonStartup.mockImplementation(() => { waiting.resolve(); return startup.promise; });
    const result = h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload);
    await waiting.promise;
    expect(h.steps).toEqual(["probe"]);
    expect(h.bindRelay).not.toHaveBeenCalled();
    startup.resolve();
    await expect(result).resolves.toMatchObject({ workspace: { workspaceId: "joined" } });
    expect(h.steps.slice(0, 4)).toEqual(["probe", "mkdir", "mark", "create"]);
  });

  it("keeps a failed-cleanup registration and directs recovery through Forget before rejoining", async () => {
    const h = await harness();
    h.enable.mockRejectedValue(new Error("download interrupted"));
    h.cleanup.mockRejectedValue(new Error("relay still in use"));
    const result = h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload);
    await expect(result).rejects.toThrow(`Files remain in ${h.joinPayload.rootPath}.`);
    await expect(result).rejects.toThrow("choose Forget from its menu before joining again");
    expect(h.registry.has("joined")).toBe(true);
    await expect(h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload)).rejects.toThrow("already on this machine");
    expect(h.bootstrap).toHaveBeenCalledTimes(1);
  });

  it.each(["Passphrase required to unlock synced secrets.", "download interrupted"])("preserves the failed join folder and explains retry after %s", async (message) => {
    const h = await harness();
    h.bootstrap.mockRejectedValue(new Error(message));
    const result = h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload);
    await expect(result).rejects.toThrow(`Files remain in ${h.joinPayload.rootPath}.`);
    await expect(result).rejects.toThrow(/choose another empty folder/i);
    if (message.startsWith("Passphrase")) await expect(result).rejects.toThrow("Passphrase required");
    expect(h.cleanup).toHaveBeenCalledWith("joined");
    expect(h.registry.has("joined")).toBe(false);
    expect(h.enable).not.toHaveBeenCalled();
  });
});

it("resumes through cloudEnableSync without replacing an intact protected-file envelope", async () => {
  const h = await harness();
  h.workspace.remote = { serverUrl: credentials.serverUrl, ownerUserId: credentials.userId };
  await h.invoke(workspaceSyncOperations.cloudStopSync.channel);
  const pause = h.workspace.syncPause!;
  expect(await h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" })).toMatchObject({ workspaceSynced: false, syncPause: workspaceSyncPauseStatus(pause, "local") });
  const key = Buffer.alloc(32, 42);
  h.readDataKey.mockResolvedValueOnce(key);
  h.enroll.mockImplementation(enrollWorkspaceKeyEnvelope);
  await h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" });
  expect(h.downloadKeyEnvelope).toHaveBeenCalledOnce();
  expect(h.uploadKeyEnvelope).not.toHaveBeenCalled();
  expect(h.setRemote).toHaveBeenCalledWith("existing", { serverUrl: credentials.serverUrl, ownerUserId: credentials.userId });
  expect(h.enable).toHaveBeenCalledOnce();
  expect(h.workspace.pausedRemote).toBeUndefined();
  expect(h.workspace.syncPause).toBeUndefined();
  expect(key.equals(Buffer.alloc(32))).toBe(true);
});

it("requires enrollment when protected files were added while paused and no envelope exists", async () => {
  const h = await harness();
  h.workspace.pausedRemote = { serverUrl: credentials.serverUrl, ownerUserId: credentials.userId };
  h.downloadKeyEnvelope.mockRejectedValue(new RelayKeyEnvelopeMissingError());
  h.enroll.mockImplementation(enrollWorkspaceKeyEnvelope);
  h.readDataKey.mockResolvedValue(Buffer.alloc(32, 7));
  await expect(h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" })).rejects.toThrow("Passphrase required");
  expect(h.enable).not.toHaveBeenCalled();
  expect(h.workspace.pausedRemote).toBeDefined();
  h.readDataKey.mockResolvedValue(Buffer.alloc(32, 7));
  await h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing", passphrase: "original new passphrase" });
  expect(h.uploadKeyEnvelope).toHaveBeenCalledOnce();
});

it("keeps resume pinned to the original paused owner", async () => {
  const h = await harness();
  h.workspace.pausedRemote = { serverUrl: credentials.serverUrl, ownerUserId: "someone-else" };
  await expect(h.invoke(CHANNELS.cloudEnableSync, { workspaceId: "existing" })).rejects.toThrow("account that synced");
  expect(h.claim).not.toHaveBeenCalled();
});

it("refuses a stop before join activation instead of reporting a pause", async () => {
  const h = await harness();
  const entered = deferred(), held = deferred();
  h.openActivity.mockImplementationOnce(async (_entry, options) => {
    entered.resolve(); await held.promise; await options.afterActivityOpen();
  });
  const joining = h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload);
  await entered.promise;
  expect(h.registry.get("joined")).toMatchObject({ joinBootstrapPending: true });
  expect(h.registry.get("joined")?.remote).toBeUndefined();
  await expect(h.authorities.withOperation("joined", h.stopOperation)).rejects.toThrow(
    "This workspace is still joining. Wait for it to finish, then stop sync.",
  );
  expect(h.preparePause).not.toHaveBeenCalled();
  expect(h.registry.get("joined")?.syncPause).toBeUndefined();
  held.resolve(); await joining;
  expect(h.registry.get("joined")?.remote).toBeDefined();
  expect(h.registry.get("joined")?.joinBootstrapPending).toBeUndefined();
});

it("queues a stop during join until the joined workspace is enabled", async () => {
  const h = await harness();
  const entered = deferred(), held = deferred();
  h.enable.mockImplementationOnce(async () => { entered.resolve(); await held.promise; });
  const joining = h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload);
  await entered.promise;
  const stopping = h.authorities.withOperation("joined", operation => createWorkspaceSyncStop({
    person: async () => ({ kind: "person", personId: "local" }),
    pauseStatus: pause => workspaceSyncPauseStatus(pause, "local"),
    withOwnerHostPaused: work => work(), prepare: h.preparePause, resume: h.enable,
    pauseRemote: id => { const entry = h.registry.get(id)!; entry.pausedRemote = entry.remote; delete entry.remote; },
    closeActivity: async () => {}, closeRelay: async () => {}, openActivity: async () => {}, collectionsWaiting: async () => false,
    status: () => status, notify: () => {}, cleanupFailed: vi.fn(), reopenFailed: vi.fn(),
  })(operation));
  expect(h.preparePause).not.toHaveBeenCalled();
  held.resolve(); await joining;
  await expect(stopping).resolves.toMatchObject({ workspaceSynced: false });
  expect(h.registry.get("joined")?.remote).toBeUndefined();
  expect(h.registry.get("joined")?.pausedRemote).toBeDefined();
});

it("releases the join transition lane before rollback drains a queued stop", async () => {
  const h = await harness();
  const entered = deferred(), held = deferred(), stopQueued = deferred(), rollbackEntered = deferred(), allowRetirement = deferred();
  const remove = h.removeJoinedWorkspace.getMockImplementation()!;
  h.removeJoinedWorkspace.mockImplementationOnce(async (binding, finalize) => {
    rollbackEntered.resolve(); await allowRetirement.promise; await remove(binding, finalize);
  });
  h.enable.mockImplementationOnce(async () => { entered.resolve(); await held.promise; throw new Error("first pull failed"); });
  const joining = h.invoke(CHANNELS.cloudJoinWorkspace, h.joinPayload);
  const joinRefused = expect(joining).rejects.toThrow("could not download");
  await entered.promise;
  const stopping = h.authorities.withOperation("joined", operation => {
    const pending = h.stopOperation(operation);
    stopQueued.resolve();
    return pending;
  });
  const stopRefused = expect(stopping).rejects.toThrow("This workspace is still joining. Wait for it to finish, then stop sync.");
  await stopQueued.promise;
  expect(h.preparePause).not.toHaveBeenCalled();
  held.resolve();
  await rollbackEntered.promise;
  await stopRefused;
  expect(h.registry.get("joined")?.joinBootstrapPending).toBe(true);
  expect(h.preparePause).not.toHaveBeenCalled();
  allowRetirement.resolve();
  await joinRefused;
  expect(h.cleanup).toHaveBeenCalledWith("joined");
  expect(h.registry.has("joined")).toBe(false);
  expect(() => h.authorities.withOperation("joined", () => {})).toThrow("This workspace is not open. Open it again.");
});

it("exposes owned sync and pause state while signed out", async () => {
  const h = await harness();
  h.workspace.remote = { serverUrl: credentials.serverUrl, ownerUserId: credentials.userId };
  h.login.status.mockResolvedValue({ connected: false });
  h.login.credentials.mockResolvedValue(null); h.cache.clear();
  expect(await h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" })).toMatchObject({
    connected: false, workspaceSyncOwned: true, workspaceSynced: true, workspaceServerUrl: credentials.serverUrl,
    workspaceSyncConnected: false,
  });
  const stopped = await h.invoke(workspaceSyncOperations.cloudStopSync.channel);
  expect(stopped).toMatchObject({ syncPause: { author: { kind: "person", personId: "local", self: true } } });
  expect(h.workspace.syncPause?.author).toEqual({ kind: "person", personId: "local" });
  expect(await h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" })).toMatchObject({
    connected: false, workspaceSyncOwned: true, workspaceSynced: false,
    syncPause: { author: { kind: "person", personId: "local", self: true } },
  });
  h.workspace.shareView = { shareId: "received", granterEmail: null, genericChatWritable: false,
    grantedSelector: { paths: ["note.md"], versionId: null, access: "edit" } };
  const received = await h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" });
  expect(received).toMatchObject({ workspaceSyncOwned: false });
  expect(received).not.toHaveProperty("syncPause");
  h.workspace.shareView = null as never;
  const damaged = await h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" });
  expect(damaged).toMatchObject({ workspaceSyncOwned: false });
  expect(damaged).not.toHaveProperty("syncPause");
  await expect(h.invoke(workspaceSyncOperations.cloudStopSync.channel)).rejects.toThrow("received share");
  expect(h.preparePause).toHaveBeenCalledOnce();
});

it("omits invalid persisted pause metadata from the Settings status handler", async () => {
  const h = await harness();
  h.workspace.pausedRemote = { serverUrl: credentials.serverUrl, ownerUserId: credentials.userId };
  Object.assign(h.workspace, { syncPause: { atMs: 42, author: { kind: "human", humanId: "local", displayName: "You" } } });
  const result = await h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" });
  expect(result).toMatchObject({ workspaceSyncOwned: true, workspaceSynced: false });
  expect(result).toHaveProperty("syncPause", undefined);
  expect(h.workspace.pausedRemote).toBeDefined();
});
