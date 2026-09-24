import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./channels";
import { registerDirectMessagesIpcHandlers, peekReceivedGrantKindForShare } from "./directMessagesIpc";
import { registerSharedChannelsIpcHandlers } from "./sharedChannelsIpc";
import { createChatScopeCapability } from "./chatScope";
import { createWorkspaceAuthorityOwner, type PhysicalWorkspace } from "../workspaces/workspaceAuthorityOwner";
import { createRendererWorkspaceOperationRunner, type ExactRendererWorkspaceOperation } from "../window/rendererWorkspaceOperation";
import { createLastKnownDmRequestLanesCache } from "../workspaces/dmRequests";
import { workspaceWriteRefusal } from "../workspaces/shareWriteGate";
import { readDeclinedDms } from "../workspaces/dmRequestStore";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { SharedChannelPassOutcome } from "../workspaces/desktopSharedChannelSync";
import type { JoinedSharedChannel, RegistryEntry } from "../workspaces/registryStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import type { ChannelThreadSummary, ChatChannelSummary, ChatMessage } from "@dohc/workspace-contracts/engine";

afterEach(() => vi.unstubAllGlobals());

const credentials: CloudCredentials = {
  serverUrl: "https://account.test", relayUrl: "https://relay.test", token: "token",
  userId: "owner", email: "owner@example.test",
};
const startPayload = { workspaceId: "workspace", recipients: "peer@example.test", body: "Hello" };

async function harness() {
  let stateDirectory = await createTestScratch("direct-messages-ipc-");
  const workspace: RegistryEntry = {
    workspaceId: "workspace", rootPath: "/workspace", kind: "personal", mode: "local-first",
    remote: { serverUrl: credentials.serverUrl, ownerUserId: credentials.userId }, sharedChannels: [],
  };
  const state = {
    operationLanes: new Map<string, Promise<void>>(),
    lastKnownDmRequestLanes: createLastKnownDmRequestLanesCache(),
  };
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: id => id === workspace.workspaceId ? workspace : null,
    canonicalizeRoot: root => root, createState: () => state,
  });
  const attachmentId = await authorities.withOperation("workspace", op => op.workspace.attachmentId);
  let rendererCurrent = true;
  let generation = 1;
  let current: CloudCredentials | null = credentials;
  const session = { workspaceId: "workspace", attachmentId, generation: 1, isCurrent: () => rendererCurrent };
  type Workspace = PhysicalWorkspace<RegistryEntry>;
  type Operation = ExactRendererWorkspaceOperation<Workspace, typeof state, typeof session>;
  type Event = { sender: string; trusted: boolean };
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<string, Workspace, typeof state, typeof session>({
    currentSession: () => session,
    withPhysicalOperation: (id, run) => authorities.withOperation(id, run),
  });
  const events: string[] = [];
  const channel: ChatChannelSummary = {
    id: "channel", workspaceId: "workspace", name: "peer@example.test", slug: "peer", kind: "dm",
    type: "posts", purpose: "", createdAtMs: 1, updatedAtMs: 2, threadCount: 1, unreadCount: 0,
  };
  const thread: ChannelThreadSummary = {
    thread: { id: "thread", workspaceId: "workspace", channelId: "channel", title: "", createdAtMs: 1, updatedAtMs: 2 },
    messageCount: 1, lastReadSequence: 1, unreadCount: 0, openDecisionCount: 0,
  };
  const message: ChatMessage = {
    id: "message", workspaceId: "workspace", threadId: "thread", body: "Hello",
    author: { kind: "human", displayName: "Sam" }, authorUserId: "owner", createdAtMs: 2, attachments: [],
  };
  let channels: ChatChannelSummary[] = [];
  let threads: ChannelThreadSummary[] = [];
  const storeMethods = {
    listChannels: vi.fn<DesktopLinkedChatStore["listChannels"]>(async () => channels),
    getChannelWireId: vi.fn<DesktopLinkedChatStore["getChannelWireId"]>(async () => "channel"),
    listChannelThreads: vi.fn<DesktopLinkedChatStore["listChannelThreads"]>(async () => threads),
    createChannel: vi.fn<DesktopLinkedChatStore["createChannel"]>(async () => { events.push("create"); channels = [channel]; return channel; }),
    sendMessage: vi.fn<DesktopLinkedChatStore["sendMessage"]>(async () => { events.push("send"); return message; }),
    startChannelThread: vi.fn<DesktopLinkedChatStore["startChannelThread"]>(async () => {
      events.push("start-thread"); threads = [thread]; return { thread: thread.thread, message };
    }),
  };
  const store = new Proxy(storeMethods, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      throw new Error(`Unexpected store method: ${String(key)}`);
    },
  }) as unknown as DesktopLinkedChatStore;
  const fileObjectIdForPath = vi.fn<WorkspaceEngineCapture["fileObjectIdForPath"]>(async () => "object");
  const capture = { fileObjectIdForPath } as unknown as WorkspaceEngineCapture;
  const requireEngineCapture = vi.fn(async (value: RegistryEntry, _feature: "Chats") => ({ workspace: value, capture }));
  const linkedChatStoreFor = vi.fn(() => store);
  const warm = vi.fn<() => Promise<void>>(async () => undefined);
  const remote = vi.fn(async () => ({ credentials: current!, credentialGeneration: generation }));
  const relayJson = vi.fn(async (_credentials: CloudCredentials, path: string, init?: RequestInit): Promise<unknown> => {
    if (path === "/sync/shares") { events.push("list-grants"); return { granted: [], received: [] }; }
    if (path.endsWith("/revoke")) { events.push("revoke"); return {}; }
    if (init?.method === "POST") { events.push("grant"); return { shareId: "created-grant" }; }
    throw new Error(`Unexpected relay path: ${path}`);
  });
  const info = vi.fn(async () => Response.json({
    shareId: "request", granterUserId: "peer", granterEmail: "peer@example.test",
    selector: { kind: "chat-channel", channelWireId: "channel" }, access: "read-write", createdAtMs: 1,
  }));
  vi.stubGlobal("fetch", info);
  const writeChannels = vi.fn((_id: string, next: JoinedSharedChannel[]) => {
    events.push("reserve"); workspace.sharedChannels = next;
  });
  const pull = vi.fn(async () => {
    events.push("pull"); channels = [channel]; threads = [thread];
    return { fetched: 1, applied: 1, skipped: 0, nextCursor: 1 };
  });
  const project = vi.fn(async () => { events.push("project"); });
  const sync = vi.fn(async (): Promise<SharedChannelPassOutcome> => {
    events.push("sync"); return { unrefreshed: 0, pushed: false, changed: false };
  });
  const activity = { queueCloudSync: vi.fn(() => { events.push("cloud"); }) };
  const dispatch = { scanWorkspace: vi.fn(async () => { events.push("dispatch"); }) };
  const kinds = new Map<string, "dm" | "not-dm">([["request", "dm"]]);
  const assertTrustedSender = (event: Event) => { if (!event.trusted) throw new Error("untrusted"); };
  const assertWritableWorkspace = (value: RegistryEntry) => {
    const refusal = workspaceWriteRefusal(value.shareView);
    if (refusal) throw new Error(refusal);
  };
  const sharedCommands = registerSharedChannelsIpcHandlers<string, Event, Workspace, Operation>({
    registerHandler: () => undefined, assertTrustedSender, withRendererWorkspaceOperation,
    requireEngineCapture, assertWritableWorkspace, linkedChatStoreFor,
    remoteForWorkspace: remote, currentCredentialGeneration: () => generation, currentCredentials: () => current,
    warmCredentialCache: warm, mountShareFolder: async () => undefined, unmountShareFolder: async () => ({}),
    relayShareJsonWithCredentials: async <Result>(auth: CloudCredentials, path: string, init?: RequestInit) => await relayJson(auth, path, init) as Result,
    listWorkspaces: () => [workspace], setWorkspaceSharedChannels: writeChannels,
    relayClientForWorkspace: () => ({ pullSharedChannel: pull, push: async () => undefined }), projectPendingChatBookmarksAfterPull: project,
    normalizeServerUrl: url => url, peekedReceivedGrantKinds: kinds, peekReceivedGrantKindForShare,
    acknowledgeWorkspaceShareSkips: () => undefined, notifyRenderer: () => undefined,
  });
  const chatScope = createChatScopeCapability({
    workspaceAuthorities: authorities,
    canonicalWorkspaceFor: lease => { lease.assertCurrent(); return { ...workspace, attachmentId: lease.binding.attachmentId }; },
    requireEngineCapture: async () => ({ workspace, capture }), linkedChatStoreFor,
    openWorkspaceActivity: async () => undefined,
    receivedShareEngine: { workspaceFor: input => ({ workspaceId: input.engineWorkspaceId, rootPath: input.rootPath, attachmentId: input.attachmentId }) },
    activeEngineFileIndex: async () => ({ objectIdByPath: new Map() }),
    readOwnedWorkspaceText: async () => ({ text: "# Current heading\n" }),
  });
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  registerDirectMessagesIpcHandlers<string, Event, Operation>({
    registerHandler: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    assertTrustedSender, withRendererWorkspaceOperation, requireEngineCapture, assertWritableWorkspace,
    linkedChatStoreFor, warmCredentialCache: warm, currentCredentials: () => current,
    currentCredentialGeneration: () => generation, remoteForWorkspace: remote,
    relayShareJsonWithCredentials: async <Result>(auth: CloudCredentials, path: string, init?: RequestInit) => await relayJson(auth, path, init) as Result,
    normalizeServerUrl: url => url, listWorkspaces: () => [workspace], stateDir: () => stateDirectory,
    peekedReceivedGrantKinds: kinds, syncRendererSharedChannelsForChatTarget: sync,
    ...sharedCommands, chatScope, localUserDisplayName: () => "Sam", activity, chatDispatchService: dispatch,
  });
  const invoke = async (channel: string, payload: unknown, trusted = true) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return await handler({ sender: "window", trusted }, payload);
  };
  return {
    handlers, invoke, workspace, state, authorities, events, storeMethods, fileObjectIdForPath,
    requireEngineCapture, linkedChatStoreFor, warm, relayJson, info, writeChannels, pull, project, sync, activity, dispatch,
    requestFile: () => join(stateDirectory, "dohc-dm-requests.json"),
    setStateDirectory: (value: string) => { stateDirectory = value; },
    rotateCredentials: () => { generation += 1; }, retireRenderer: () => { rendererCurrent = false; },
    signOut: () => { current = null; generation += 1; },
    seedConversation: () => { channels = [channel]; threads = [thread]; },
  };
}

describe("registered direct message boundaries", () => {
  it("registers the six commands and rejects untrusted callers before work", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([CHANNELS.syncDms, CHANNELS.acceptDm, CHANNELS.declineDm, CHANNELS.requestDmAgain, CHANNELS.leaveDm, CHANNELS.startDm]);
    for (const channel of h.handlers.keys()) await expect(h.invoke(channel, null, false)).rejects.toThrow("untrusted");
    expect(h.requireEngineCapture).not.toHaveBeenCalled();
    expect(h.warm).not.toHaveBeenCalled();
    expect(h.writeChannels).not.toHaveBeenCalled();
  });

  it("keeps decline choices in the current account file and reports write failure", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.declineDm, { shareId: "request" });
    const previous = h.requestFile();
    expect(readDeclinedDms(previous)).toEqual(new Set(["request"]));
    h.setStateDirectory(await createTestScratch("direct-messages-next-state-"));
    await h.invoke(CHANNELS.declineDm, { shareId: "next" });
    expect(readDeclinedDms(h.requestFile())).toEqual(new Set(["next"]));
    expect(readDeclinedDms(previous)).toEqual(new Set(["request"]));
    await h.invoke(CHANNELS.requestDmAgain, { shareId: "next" });
    expect(readDeclinedDms(h.requestFile())).toEqual(new Set());
    writeFileSync(h.requestFile(), "invalid");
    await expect(h.invoke(CHANNELS.declineDm, { shareId: "next" })).rejects.toThrow("could not save this choice");
    expect(h.requireEngineCapture).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads and a different renderer workspace before store access", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.startDm, { ...startPayload, workspaceId: "../outside" })).rejects.toThrow();
    await expect(h.invoke(CHANNELS.acceptDm, { workspaceId: "other", shareId: "request" })).rejects.toThrow();
    expect(h.requireEngineCapture).not.toHaveBeenCalled();
    expect(h.linkedChatStoreFor).not.toHaveBeenCalled();
    expect(h.relayJson).not.toHaveBeenCalled();
  });

  it("refuses received shares and self recipients before creating or granting a conversation", async () => {
    const h = await harness();
    Object.assign(h.workspace, { shareView: null });
    await expect(h.invoke(CHANNELS.startDm, startPayload)).rejects.toThrow("shared view");
    await expect(h.invoke(CHANNELS.acceptDm, { workspaceId: "workspace", shareId: "request" })).rejects.toThrow("Shared views are read-only");
    delete h.workspace.shareView;
    await expect(h.invoke(CHANNELS.startDm, { ...startPayload, recipients: credentials.email })).rejects.toThrow("other than yourself");
    expect(h.linkedChatStoreFor).not.toHaveBeenCalled();
    expect(h.relayJson).not.toHaveBeenCalled();
    expect(h.storeMethods.createChannel).not.toHaveBeenCalled();
  });

  it.each(["renderer", "authority", "credentials"] as const)("refuses stale %s sync before caches, store reads, or background work", async reason => {
    const h = await harness();
    const entered = deferred();
    const response = deferred<unknown>();
    h.relayJson.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    const result = h.invoke(CHANNELS.syncDms, { workspaceId: "workspace" });
    const rejected = expect(result).rejects.toThrow();
    await entered.promise;
    let retired: Promise<void> | undefined;
    if (reason === "renderer") h.retireRenderer();
    else if (reason === "authority") retired = h.authorities.invalidate("workspace");
    else h.rotateCredentials();
    response.resolve({ received: [{ shareId: "request", selector: { kind: "chat-channel", channelWireId: "channel" } }] });
    await rejected;
    await retired;
    expect(h.state.lastKnownDmRequestLanes.get("workspace")).toBeUndefined();
    expect(h.storeMethods.listChannels).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.activity.queueCloudSync).not.toHaveBeenCalled();
  });

  it("rejects a renderer retired during credential warming before requesting grants", async () => {
    const h = await harness();
    const entered = deferred();
    const warmed = deferred();
    h.warm.mockImplementationOnce(() => { entered.resolve(); return warmed.promise; });
    const result = h.invoke(CHANNELS.syncDms, { workspaceId: "workspace" });
    const rejected = expect(result).rejects.toThrow("changed workspaces");
    await entered.promise;
    h.retireRenderer();
    warmed.resolve();
    await rejected;
    expect(h.relayJson).not.toHaveBeenCalled();
    expect(h.linkedChatStoreFor).not.toHaveBeenCalled();
  });

  it("does not queue a cloud sync after a pass that moved nothing", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.syncDms, { workspaceId: "workspace" })).resolves.toMatchObject({ available: true, dms: [], pending: [], declined: [] });
    expect(h.events).toEqual(["list-grants", "sync"]);
    expect(h.activity.queueCloudSync).not.toHaveBeenCalled();
  });

  it.each<[string, SharedChannelPassOutcome]>([
    ["pushed", { unrefreshed: 0, pushed: true, changed: false }],
    ["applied pulled", { unrefreshed: 0, pushed: false, changed: true }],
  ])("queues one cloud sync after a pass that %s ops and none after the idle passes that follow", async (_moved, outcome) => {
    const h = await harness();
    h.sync.mockImplementationOnce(async () => { h.events.push("sync"); return outcome; });
    await h.invoke(CHANNELS.syncDms, { workspaceId: "workspace" });
    expect(h.events).toEqual(["list-grants", "sync", "cloud"]);
    // The cloud engine's change event refreshes Chats. Those passes move
    // nothing, so they must not queue again.
    await h.invoke(CHANNELS.syncDms, { workspaceId: "workspace" });
    await h.invoke(CHANNELS.syncDms, { workspaceId: "workspace" });
    expect(h.sync).toHaveBeenCalledTimes(3);
    expect(h.activity.queueCloudSync).toHaveBeenCalledExactlyOnceWith("workspace");
  });

  it("serves local conversations while signed out without syncing", async () => {
    const h = await harness();
    h.seedConversation();
    h.signOut();
    await expect(h.invoke(CHANNELS.syncDms, { workspaceId: "workspace" })).resolves.toMatchObject({ available: false, dms: [{ channelId: "channel", role: "owner" }], pending: [], declined: [] });
    expect(h.relayJson).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("reserves acceptance before pulling and clears decline only after success", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.declineDm, { shareId: "request" });
    const entered = deferred();
    const released = deferred();
    const pull = h.pull.getMockImplementation()!;
    h.pull.mockImplementationOnce(async () => { entered.resolve(); await released.promise; return pull(); });
    const accepted = h.invoke(CHANNELS.acceptDm, { workspaceId: "workspace", shareId: "request" });
    await entered.promise;
    expect(h.workspace.sharedChannels).toEqual([expect.objectContaining({ shareId: "request", access: "read-write", recipientUserId: "owner" })]);
    expect(readDeclinedDms(h.requestFile())).toEqual(new Set(["request"]));
    expect(h.storeMethods.listChannels).not.toHaveBeenCalled();
    released.resolve();
    await expect(accepted).resolves.toMatchObject({ dm: { shareId: "request", role: "participant", threadId: "thread" } });
    expect(h.events).toEqual(["reserve", "pull", "project"]);
    expect(readDeclinedDms(h.requestFile())).toEqual(new Set());
  });

  it.each(["revoked", "stale"] as const)("does not reserve or clear a %s request", async reason => {
    const h = await harness();
    await h.invoke(CHANNELS.declineDm, { shareId: "request" });
    const entered = deferred();
    const response = deferred<Response>();
    h.info.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    const accepted = h.invoke(CHANNELS.acceptDm, { workspaceId: "workspace", shareId: "request" });
    const rejected = expect(accepted).rejects.toThrow();
    await entered.promise;
    if (reason === "stale") h.rotateCredentials();
    response.resolve(reason === "revoked" ? new Response(null, { status: 404 }) : Response.json({ selector: { kind: "chat-channel", channelWireId: "channel" }, access: "read-write" }));
    await rejected;
    expect(h.writeChannels).not.toHaveBeenCalled();
    expect(h.pull).not.toHaveBeenCalled();
    expect(readDeclinedDms(h.requestFile())).toEqual(new Set(["request"]));
  });

  it("leaves a tombstone and adds the request to the physical fallback lanes", async () => {
    const h = await harness();
    h.workspace.sharedChannels = [{ shareId: "request", channelWireId: "channel", access: "read-write", granterEmail: "peer@example.test", relayUrl: credentials.relayUrl!, recipientUserId: credentials.userId }];
    await h.invoke(CHANNELS.leaveDm, { workspaceId: "workspace", shareId: "request" });
    expect(h.workspace.sharedChannels[0]).toMatchObject({ shareId: "request", ended: true });
    expect(h.state.lastKnownDmRequestLanes.get("workspace")).toEqual({ pending: [{ shareId: "request", granterEmail: "peer@example.test" }], declined: [] });
    expect(h.relayJson).not.toHaveBeenCalled();
  });

  it("resolves mentions before grants and rejects retirement during resolution", async () => {
    const h = await harness();
    const entered = deferred();
    const file = deferred<string | null>();
    h.fileObjectIdForPath.mockImplementationOnce(() => { entered.resolve(); return file.promise; });
    const result = h.invoke(CHANNELS.startDm, { ...startPayload, fileReferences: [{ path: "note.md" }] });
    const rejected = expect(result).rejects.toThrow("session changed");
    await entered.promise;
    expect(h.relayJson).not.toHaveBeenCalled();
    expect(h.linkedChatStoreFor).not.toHaveBeenCalled();
    h.rotateCredentials();
    file.resolve("object");
    await rejected;
    expect(h.storeMethods.createChannel).not.toHaveBeenCalled();
  });

  it("grants before writing, ignores renderer identity, then queues sync and dispatch", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.startDm, { ...startPayload, authorUserId: "forged", author: { kind: "agent" } })).resolves.toMatchObject({ dm: { role: "owner" }, message: { authorKind: "human", authorDisplayName: "Sam" } });
    expect(h.storeMethods.startChannelThread).toHaveBeenCalledWith({ workspaceId: "workspace", channelId: "channel", author: { kind: "human", displayName: "Sam" }, authorUserId: "owner", body: "Hello" });
    expect(h.events).toEqual(["list-grants", "create", "grant", "start-thread", "cloud", "dispatch"]);
  });

  it("continues the existing recipient set without minting another channel or grant", async () => {
    const h = await harness();
    h.seedConversation();
    h.relayJson.mockResolvedValueOnce({ granted: [{
      recipientEmail: "PEER@example.test", revokedAtMs: null,
      selector: { kind: "chat-channel", channelWireId: "channel" },
    }] });
    await expect(h.invoke(CHANNELS.startDm, startPayload)).resolves.toMatchObject({ dm: { channelId: "channel", threadId: "thread" } });
    expect(h.relayJson).toHaveBeenCalledOnce();
    expect(h.storeMethods.createChannel).not.toHaveBeenCalled();
    expect(h.storeMethods.startChannelThread).not.toHaveBeenCalled();
    expect(h.storeMethods.sendMessage).toHaveBeenCalledWith({
      workspaceId: "workspace", threadId: "thread", author: { kind: "human", displayName: "Sam" },
      authorUserId: "owner", body: "Hello",
    });
  });

  it("revokes a just-created grant when credentials retire during its response", async () => {
    const h = await harness();
    const entered = deferred();
    const grant = deferred<unknown>();
    h.relayJson.mockImplementationOnce(async () => ({ granted: [] }));
    h.relayJson.mockImplementationOnce(() => { entered.resolve(); return grant.promise; });
    const result = h.invoke(CHANNELS.startDm, startPayload);
    const rejected = expect(result).rejects.toThrow("session changed");
    await entered.promise;
    h.rotateCredentials();
    grant.resolve({ shareId: "created-grant" });
    await rejected;
    expect(h.relayJson).toHaveBeenLastCalledWith(credentials, "/sync/shares/created-grant/revoke", { method: "POST" });
    expect(h.storeMethods.startChannelThread).not.toHaveBeenCalled();
    expect(h.storeMethods.sendMessage).not.toHaveBeenCalled();
    expect(h.activity.queueCloudSync).not.toHaveBeenCalled();
    expect(h.dispatch.scanWorkspace).not.toHaveBeenCalled();
  });
});
