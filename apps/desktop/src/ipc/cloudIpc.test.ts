import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { RelayUnauthorizedError, RelayWorkspaceUnavailableError, RelayClaimRefusedError } from "@dohc/workspace-contracts/relay";
import { CHANNELS } from "./channels";
import { registerCloudIpcHandlers } from "./cloudIpc";
import { type SyncStatusResult } from "./bridgeContract";
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

const credentials: CloudCredentials = {
  serverUrl: "https://account.example.test", relayUrl: "https://relay.example.test",
  token: "token", userId: "member", email: "member@example.test",
};
const status: SyncStatusResult = {
  state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null,
  historyRecordingUnavailable: false, historyShareView: false, liveSessionsGeneration: 0,
};

async function harness() {
  const steps: string[] = [];
  const home = resolve("/cloud-ipc-home").replace(/\\/g, "/");
  const rootPath = `${home}/joined`;
  const roots = createWorkspaceRootApproval(() => home);
  roots.approveRoot(rootPath);
  const workspace: RegistryEntry = { workspaceId: "existing", rootPath: `${home}/existing`, kind: "personal", mode: "local-first" };
  const registry = new Map([[workspace.workspaceId, workspace]]);
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id: string) => registry.get(id) ?? null,
    canonicalizeRoot: (root: string) => root, createState: () => ({}),
  });
  const attachmentId = await authorities.withOperation("existing", (operation) => operation.workspace.attachmentId);
  let rendererCurrent = true;
  const session = { workspaceId: "existing", attachmentId, generation: 1, isCurrent: () => rendererCurrent };
  type Event = { sender: string; trusted: boolean };
  type Workspace = PhysicalWorkspace<RegistryEntry>;
  type Operation = ExactRendererWorkspaceOperation<Workspace, object, typeof session>;
  type Dependencies = Parameters<typeof registerCloudIpcHandlers<string, Event, Operation>>[0];
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<string, Workspace, object, typeof session>({
    currentSession: () => session,
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
  const relay = { claim } as unknown as EngineRelayWorkspaceClient;
  const daemonStartup = vi.fn<() => Promise<void>>(async () => undefined);
  const readSecrets = vi.fn<Dependencies["readWorkspaceSecretState"]>(async () => "none");
  const readDataKey = vi.fn<Dependencies["readWorkspaceDataKeyForEnrollment"]>(async () => null);
  const enroll = vi.fn<Dependencies["enrollWorkspaceKeyEnvelope"]>(async () => { steps.push("enroll"); });
  const bootstrap = vi.fn<Dependencies["bootstrapJoinedWorkspace"]>(async () => { steps.push("bootstrap"); });
  const probe = vi.fn<Dependencies["probeRelayWorkspace"]>(async () => {
    steps.push("probe");
    return { hasContent: true, identity: { replicationEpoch: "epoch", streamIdentity: "stream" } };
  });
  const readdir = vi.fn(async (_root: string) => [] as string[]);
  const mkdir = vi.fn(async () => { steps.push("mkdir"); });
  const bindRelay = vi.fn<Dependencies["relayClientForWorkspace"]>(() => relay);
  const setRemote = vi.fn<Dependencies["setWorkspaceRemote"]>((id, remote) => {
    steps.push("remote");
    registry.get(id)!.remote = remote;
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
  const createJoinedWorkspace = createJoinedWorkspaceRunner({
    reserve: (input) => authorities.reserveBinding(input), createFolder,
    register: (reservation, entry) => authorities.registerReservedBinding(reservation, entry, {
      persist: () => { steps.push("register"); registry.set(entry.workspaceId, entry); },
      rollback: () => { registry.delete(entry.workspaceId); },
    }),
    remove: (binding, finalize) => authorities.retireBinding(binding, {
      finalize, removeBinding: () => { registry.delete(binding.workspaceId); },
    }),
    release: (reservation, finalize) => authorities.releaseReservation(reservation, finalize),
    closeRelay: cleanup, rollbackComplete: notify, logError: vi.fn(),
  });
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  registerCloudIpcHandlers<string, Event, Operation>({
    registerHandler: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    assertTrustedSender: (event) => { if (!event.trusted) throw new Error("untrusted"); },
    cloudLogin: () => login,
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
    reconcileCloud: () => { steps.push("reconcile"); },
    notifyCloudSessionChanged: ready, notifyCloudSessionChangedWithKey: changing, notifyRenderer: notify,
    findWorkspace: (id) => registry.get(id) ?? null,
    engineDaemonStartup: daemonStartup, requireEngineSessions: () => sessions, currentEngineSessions: () => sessions,
    withPhysicalWorkspaceOperation: (id, work) => authorities.withOperation(id, work), withRendererWorkspaceOperation,
    receivedShareEngine: { workspaceForRegistered: (entry) => entry },
    readWorkspaceSecretState: readSecrets, readWorkspaceDataKeyForEnrollment: readDataKey,
    assertWritableWorkspace: (entry) => {
      const refusal = workspaceWriteRefusal(entry.shareView);
      if (refusal) throw new Error(refusal);
    },
    relayClientForWorkspace: bindRelay, enrollWorkspaceKeyEnvelope: enroll,
    installWorkspaceDataKey: vi.fn(async () => undefined), setWorkspaceRemote: setRemote,
    usableRoot: roots.usableRoot, readdir, mkdir, probeRelayWorkspace: probe,
    createJoinedWorkspace, bootstrapJoinedWorkspace: bootstrap,
    refreshNativeWorkspaceSurfaces: () => { steps.push("surfaces"); },
    openWorkspaceActivity: async (_entry, options) => { steps.push("open"); await options.afterActivityOpen(); },
    completeWorkspaceJoinBootstrap: (id) => { steps.push("complete"); delete registry.get(id)!.joinBootstrapPending; },
    desktopMarks: { mark: () => { steps.push("mark"); }, measureSince: () => { steps.push("measure"); } },
  });
  const invoke = async (channel: string, payload?: unknown, trusted = true) => handlers.get(channel)!({ sender: "window", trusted }, payload);
  const joinPayload = { rootPath, syncCode: buildSyncCode({ workspaceId: "joined", relayUrl: credentials.relayUrl! }) };
  return {
    handlers, invoke, joinPayload, roots, workspace, registry, authorities, cache, login,
    stop, closeRelay, claim, readSecrets, readDataKey, enroll, bootstrap, probe, readdir, mkdir,
    bindRelay, setRemote, enable, notify, changing, ready, createFolder, cleanup, steps, daemonStartup,
    retireRenderer: () => { rendererCurrent = false; },
  };
}

describe("registered cloud handlers", () => {
  it("registers the original sequence and rejects untrusted senders before any work", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([
      CHANNELS.cloudLoginStart, CHANNELS.cloudLoginPoll, CHANNELS.cloudStatus,
      CHANNELS.cloudLogout, CHANNELS.cloudEnableSync, CHANNELS.cloudJoinWorkspace,
    ]);
    for (const channel of h.handlers.keys()) await expect(h.invoke(channel, null, false)).rejects.toThrow("untrusted");
    for (const method of Object.values(h.login)) expect(method).not.toHaveBeenCalled();
    expect(h.steps).toEqual([]);
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
    await expect(result).rejects.toThrow("retired");
    await drained;
  });

  it("reports the named workspace's connection without exposing cached credentials", async () => {
    const h = await harness();
    h.workspace.remote = { serverUrl: credentials.serverUrl, ownerUserId: credentials.userId };
    h.login.status.mockResolvedValue({ ...credentials, connected: true });
    await expect(h.invoke(CHANNELS.cloudStatus, { workspaceId: "existing" })).resolves.toEqual({
      connected: true, email: credentials.email, serverUrl: credentials.serverUrl,
      relayUrl: credentials.relayUrl,
      workspaceSynced: true, workspaceSyncConnected: true, workspaceSecretState: "none",
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
