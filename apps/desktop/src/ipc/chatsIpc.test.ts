import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createDesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import { createTestScratch } from "../workspaces/testTemp";
import { StartChannelThreadResult, SendChatMessageResult, ListChatMessagesResult, ListChatThreadDecisionsResult } from "./bridgeContract";
import { chatOperations } from "./bridgeContract";
import { workspaceFileRef } from "../workspaces/resolveEngineFiles";
import { describe, expect, it, vi } from "vitest";
import type { ChatBookmark, ChatMessage, ChatThread } from "@dohc/workspace-contracts/engine";
import { CHANNELS } from "./channels";
import { createChatScopeCapability } from "./chatScope";
const neutralPresentation = { group: "neutral", hue: null, self: false };
import { chatMessageForIpc, registerChatsIpcHandlers } from "./chatsIpc";
import { ChatMessageRecord } from "./bridgeContract";
import { createChatWrites } from "../workspaces/chatWrites";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { deferred } from "../testing/deferred";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";

type ScopeKind = "local" | "view" | "comment" | "edit" | "ended" | "damaged";
type Event = { sender: { trusted: boolean } };
type Operation = { workspace: RegistryEntry; assertCurrent(): void };

function fixture(kind: ScopeKind = "local", persistedStore?: DesktopLinkedChatStore) {
  const workspace: RegistryEntry = {
    workspaceId: "workspace", rootPath: "/workspace", kind: "personal", mode: "local-first",
  };
  if (kind === "damaged") Object.assign(workspace, { shareView: null });
  else if (kind !== "local") workspace.shareView = {
    shareId: "share", granterEmail: "owner@example.test", genericChatWritable: true,
    grantedSelector: { paths: ["notes"], versionId: null, access: kind === "ended" ? "edit" : kind },
    ...(kind === "ended" ? { ended: true } : {}),
  };
  const thread: ChatThread = {
    id: "thread", workspaceId: workspace.workspaceId, title: "Notes", createdAtMs: 1, updatedAtMs: 2,
    linkedFile: { objectId: "object", pathHint: "notes/a.md", linkedAtMs: 1 },
  };
  const message: ChatMessage = {
    id: "message", workspaceId: workspace.workspaceId, threadId: thread.id,
    author: { kind: "human", displayName: "Sam" }, body: "A reply", createdAtMs: 3, attachments: [],
  };
  const bookmark: ChatBookmark = {
    bookmarkId: "bookmark", workspaceId: workspace.workspaceId, ownerUserId: "owner", targetKind: "thread",
    targetId: thread.id, threadId: thread.id, mode: "live", destinationPath: "Bookmarks/Chats/Notes--thread.md",
    state: "active", generation: 1, projectedGeneration: 0, projectionState: "pending", createdAtMs: 1, updatedAtMs: 2,
  };
  function storedAttachments(
    attachments: Parameters<DesktopLinkedChatStore["sendMessage"]>[0]["attachments"],
  ): ChatMessage["attachments"] {
    return (attachments ?? []).map((attachment, index) => ({
      ...attachment, attachmentId: `attachment-${index}`, threadId: thread.id,
      messageId: message.id, targetKind: "file", createdAtMs: message.createdAtMs,
    }));
  }
  const storeMethods = {
    createThread: vi.fn<DesktopLinkedChatStore["createThread"]>(async () => thread),
    sendMessage: vi.fn<DesktopLinkedChatStore["sendMessage"]>(async ({ automation: _automation, authorActorKey, ...input }) => ({ ...message, ...input, ...(authorActorKey !== null ? { authorActorKey } : {}), attachments: storedAttachments(input.attachments) })),
    resolveChatDecision: vi.fn<DesktopLinkedChatStore["resolveChatDecision"]>(async input => ({ ...input, state: "resolved", atMs: 4 })),
    setReaction: vi.fn<DesktopLinkedChatStore["setReaction"]>(async input => ({ ...input, reactionId: "reaction", atMs: 4 })),
    listReactions: vi.fn<DesktopLinkedChatStore["listReactions"]>(async () => []),
    listThreadDecisions: vi.fn<DesktopLinkedChatStore["listThreadDecisions"]>(async () => []),
    listThreadAttachments: vi.fn<DesktopLinkedChatStore["listThreadAttachments"]>(async () => []),
    listFollows: vi.fn<DesktopLinkedChatStore["listFollows"]>(async () => []),
    listChannelThreads: vi.fn<DesktopLinkedChatStore["listChannelThreads"]>(async () => []),
    markThreadRead: vi.fn<DesktopLinkedChatStore["markThreadRead"]>(async input => ({ ...input, lastReadSequence: input.upToSequence, revision: 7, updatedAtMs: 5 })),
    listMessages: vi.fn<DesktopLinkedChatStore["listMessages"]>(async () => [message]),
    listThreads: vi.fn<DesktopLinkedChatStore["listThreads"]>(async () => [thread]),
    listThreadsForFile: vi.fn<DesktopLinkedChatStore["listThreadsForFile"]>(async () => [thread]),
    listFileMentions: vi.fn<DesktopLinkedChatStore["listFileMentions"]>(async () => []),
    getThreadRevision: vi.fn<DesktopLinkedChatStore["getThreadRevision"]>(async () => 7),
    listChannels: vi.fn<DesktopLinkedChatStore["listChannels"]>(async () => []),
    ensureGeneralChannel: vi.fn<DesktopLinkedChatStore["ensureGeneralChannel"]>(async () => ({ id: "general", workspaceId: "workspace", name: "General", slug: "general", kind: "channel", type: "posts", purpose: "", createdAtMs: 1, updatedAtMs: 1 })),
    findThreadChannelId: vi.fn<DesktopLinkedChatStore["findThreadChannelId"]>(async () => "channel"),
    getChannelWireId: vi.fn<DesktopLinkedChatStore["getChannelWireId"]>(async () => "wire"),
    createChannel: vi.fn<DesktopLinkedChatStore["createChannel"]>(async input => ({ ...input, id: "channel", kind: "channel", slug: "general", type: input.type ?? "posts", purpose: input.purpose ?? "", ...(input.folderPath ? { folderPath: input.folderPath } : {}), createdAtMs: 1, updatedAtMs: 1 })),
    startChannelThread: vi.fn<DesktopLinkedChatStore["startChannelThread"]>(async ({ automation: _automation, authorActorKey, ...input }) => ({
      thread: { id: thread.id, workspaceId: thread.workspaceId, title: thread.title, createdAtMs: 1, updatedAtMs: 2, channelId: input.channelId },
      message: { ...message, ...input, ...(authorActorKey !== null ? { authorActorKey } : {}), attachments: storedAttachments(input.attachments) },
    })),
    listBookmarks: vi.fn<DesktopLinkedChatStore["listBookmarks"]>(async () => [bookmark]),
    ensureDefaultChannelFollows: vi.fn<DesktopLinkedChatStore["ensureDefaultChannelFollows"]>(async () => undefined),
    listPersonalFeed: vi.fn<DesktopLinkedChatStore["listPersonalFeed"]>(async () => ({ items: [] })),
    saveBookmark: vi.fn<DesktopLinkedChatStore["saveBookmark"]>(async input => ({ ...bookmark, ...input })),
    setFollow: vi.fn<DesktopLinkedChatStore["setFollow"]>(async input => ({ ...input, updatedAtMs: 5 })),
    markPersonalFeedSeen: vi.fn<DesktopLinkedChatStore["markPersonalFeedSeen"]>(async input => ({ ...input, lastSeenCreatedAtMs: 3, lastSeenMessageId: "message", updatedAtMs: 5 })),
  };
  // Unused ports fail if a handler unexpectedly reaches them. Each configured method keeps the production signature.
  const store = persistedStore ?? new Proxy(storeMethods, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      throw new Error(`Unexpected chat store method: ${String(key)}`);
    },
  }) as unknown as DesktopLinkedChatStore;
  const captureMethods = {
    fileObjectIdForPath: vi.fn(async () => "object" as string | null),
    resolveFileForPath: vi.fn<WorkspaceEngineCapture["resolveFileForPath"]>(async () => ({ objectId: "object", path: "notes/a.md" })),
  };
  const capture = captureMethods as unknown as WorkspaceEngineCapture;
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: id => id === workspace.workspaceId ? workspace : id === "other" ? { ...workspace, workspaceId: "other", rootPath: "/other" } : null,
    canonicalizeRoot: root => root,
    createState: () => ({}),
  });
  const canonicalWorkspaceFor = (lease: ReturnType<typeof authorities.acquire>) => {
    lease.assertCurrent();
    return { ...workspace, rootPath: lease.binding.canonicalRootPath, attachmentId: lease.binding.attachmentId };
  };
  const requireEngineCapture = vi.fn(async (_workspace: string | RegistryEntry, _feature: "Chats") => {
    if (shareViewIsPresent(workspace.shareView)) throw new Error("A shared view has no capture.");
    return { workspace, capture };
  });
  const linkedChatStoreFor = vi.fn(() => store);
  const openWorkspaceActivity = vi.fn(async (): Promise<void> => undefined);
  const activity = { queueCloudSync: vi.fn() };
  const syncSharedChannelsForChatTarget = vi.fn(async () => 0);
  const resolveEngineFiles = vi.fn<import("../workspaces/resolveEngineFiles").EngineFileResolver<import("@dohc/workspace-engine-client/daemon").EngineWorkspace>>(async (_workspace, targets) => targets.map(target =>
    ("path" in target ? target.path === "notes/a.md" : target.target.objectId === "object")
      ? { status: "found", objectId: "object", path: "notes/a.md" } : { status: "absent" }));
  const readOwnedWorkspaceText = vi.fn(async () => ({ text: "# Section\n" }));
  const chatScope = createChatScopeCapability({
    workspaceAuthorities: authorities, canonicalWorkspaceFor, requireEngineCapture,
    linkedChatStoreFor, openWorkspaceActivity,
    receivedShareEngine: { workspaceFor: input => ({ workspaceId: input.engineWorkspaceId, rootPath: input.rootPath, attachmentId: input.attachmentId }) },
    resolveEngineFiles, readOwnedWorkspaceText,
  });
  const warmCredentialCache = vi.fn(async (): Promise<void> => undefined);
  const scanChatDispatch = vi.fn(async () => undefined);
  const projectChatBookmarks = vi.fn();
  const ensureGroupFolder = vi.fn(async (_workspace: RegistryEntry, _folderPath: string): Promise<void> => undefined);
  const desktopChatBookmarks = {
    materializeChatBookmark: vi.fn(async (_workspace: RegistryEntry, _capture: WorkspaceEngineCapture, saved: ChatBookmark) => ({ ...saved, projectionState: "ready" as const })),
    archiveChatBookmark: vi.fn(async () => ({ ...bookmark, state: "archived" as const, generation: 2, projectionState: "ready" as const })),
  };
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const chatRelayIdentityFor = vi.fn<Parameters<typeof registerChatsIpcHandlers>[0]["chatRelayIdentityFor"]>(
    async (_workspaceId, target) =>
      "threadId" in target && target.threadId === "thread-joined"
        ? { joinedChannel: null, authorUserId: "recipient" }
        : { joinedChannel: null, authorUserId: "verified-owner" },
  );
  // The real module: these tests cover what each adapter hands it and how the
  // adapter maps the result. chatWrites.test.ts covers the checks themselves.
  let chatCredentials: CloudCredentials | null = {
    serverUrl: "https://cloud.test", userId: "verified-owner", email: "sam@test.invalid", token: "token",
  };
  const chatWrites = createChatWrites({
    findWorkspace: () => ({ ...workspace, remote: { serverUrl: "https://cloud.test", ownerUserId: "verified-owner" } }),
    warmCredentials: async () => undefined, currentCredentials: () => chatCredentials,
    currentCredentialGeneration: () => 0,
    localUserDisplayName: () => "Sam", agentDisplayName: async () => "Nova",
    localInstallationId: () => "local-owner", projectChatBookmarks,
    queueCloudSync: activity.queueCloudSync, syncSharedChannelsForChatTarget, scanChatDispatch,
    notifyRenderer: () => undefined,
  });
  const sender = { trusted: true };
  const held = authorities.acquire(workspace.workspaceId);
  const session = { workspaceId: workspace.workspaceId, attachmentId: held.binding.attachmentId, generation: 1, isCurrent: () => true };
  held.release();
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner({
    currentSession: (value: Event["sender"]) => value === sender ? session : undefined,
    withPhysicalOperation: authorities.withOperation.bind(authorities),
  });
  const syncWorkspaceSharedChannels = vi.fn(async (_workspaceId: string) => 0);
  const assertTrustedSender = vi.fn((event: Event) => {
    if (!event.sender.trusted) throw new Error("Untrusted sender");
  });
  registerChatsIpcHandlers<Event["sender"], Event, Operation>({
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender, chatScope, requireEngineCapture, linkedChatStoreFor, chatWrites,
    assertWritableWorkspace: value => { if (shareViewIsPresent(value.shareView)) throw new Error("Read-only workspace"); },
    readWorkspace: () => workspace,
    warmCredentialCache, localUserId: () => "owner",
    localInstallationId: () => "local-owner", currentCredentials: () => null,
    chatRelayIdentityFor,
    syncWorkspaceSharedChannels, syncSharedChannelsForChatTarget,
    syncRendererWorkspaceSharedChannels: async operation => {
      const rows = await syncWorkspaceSharedChannels(operation.workspace.workspaceId);
      operation.assertCurrent();
      return rows;
    },
    withRendererWorkspaceOperation,
    resolveEngineFiles, activity, desktopChatBookmarks, notifyRenderer: () => undefined, automationCollectionOf: () => () => null,
    ensureGroupFolder,
  });
  async function invoke(channel: string, payload: unknown, event: Event = { sender }) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing chat handler: ${channel}`);
    return await handler(event, payload);
  }
  return { invoke, workspace, thread, message, bookmark, storeMethods, captureMethods, capture, ensureGroupFolder,
    authorities, chatScope, requireEngineCapture, linkedChatStoreFor, openWorkspaceActivity,
    activity, syncSharedChannelsForChatTarget, resolveEngineFiles, readOwnedWorkspaceText,
    warmCredentialCache, chatRelayIdentityFor, scanChatDispatch, projectChatBookmarks, desktopChatBookmarks,
    signOutChatWrites: () => { chatCredentials = null; } };
}

const mutations = [
  { name: "create", channel: CHANNELS.createFileChat, payload: { workspaceId: "workspace", path: "notes/a.md", title: "Notes" }, method: "createThread" },
  { name: "send", channel: chatOperations.sendChatMessage.channel, payload: { workspaceId: "workspace", threadId: "thread", body: "Hello" }, method: "sendMessage" },
  { name: "decision", channel: CHANNELS.resolveChatDecision, payload: { workspaceId: "workspace", threadId: "thread", messageId: "message", resolvedByMessageId: "reply" }, method: "resolveChatDecision" },
  { name: "reaction", channel: CHANNELS.setChatReaction, payload: { workspaceId: "workspace", threadId: "thread", messageId: "message", emoji: "👍", state: "added" }, method: "setReaction" },
] as const;

describe("chat sender binding", () => {
  const cases = [
    ...mutations.map(({ channel, payload }) => ({ channel, payload })),
    { channel: CHANNELS.listFileChats, payload: { path: "notes/a.md" } },
    { channel: chatOperations.listChatFileMentions.channel, payload: { path: "notes/a.md" } },
    { channel: CHANNELS.listChatBookmarks, payload: {} },
    { channel: CHANNELS.saveChatBookmark, payload: { target: { kind: "thread", threadId: "thread" }, mode: "live" } },
    { channel: CHANNELS.archiveChatBookmark, payload: { bookmarkId: "bookmark" } },
    { channel: chatOperations.listChatMessages.channel, payload: { threadId: "thread" } },
    { channel: CHANNELS.getChatThreadRevision, payload: { threadId: "thread" } },
    { channel: CHANNELS.listChatThreadDecisions, payload: { threadId: "thread" } },
    { channel: CHANNELS.listChatThreadAttachments, payload: { threadId: "thread" } },
    { channel: CHANNELS.listChatFollows, payload: {} },
    { channel: CHANNELS.setChatFollow, payload: { target: { kind: "thread", threadId: "thread" }, state: "following" } },
    { channel: chatOperations.listPersonalChatFeed.channel, payload: {} },
    { channel: CHANNELS.markPersonalChatFeedSeen, payload: { headCursor: "cursor" } },
    { channel: CHANNELS.createChatChannel, payload: { name: "General" } },
    { channel: chatOperations.listChannelThreads.channel, payload: { channelId: "channel" } },
    { channel: chatOperations.startChannelThread.channel, payload: { channelId: "channel", body: "First message" } },
    { channel: CHANNELS.markChatThreadRead, payload: { threadId: "thread", upToSequence: 3 } },
    { channel: CHANNELS.listChatReactions, payload: { threadId: "thread" } },
  ];
  it.each(cases)("binds $channel before calling chat services", async ({ channel, payload }) => {
    const h = fixture();
    await h.invoke(channel, { ...payload, workspaceId: "workspace" });
    const services = [h.requireEngineCapture, h.linkedChatStoreFor, h.openWorkspaceActivity,
      h.warmCredentialCache, h.resolveEngineFiles, h.readOwnedWorkspaceText,
      h.chatRelayIdentityFor, h.ensureGroupFolder, ...Object.values(h.storeMethods),
      ...Object.values(h.captureMethods), ...Object.values(h.desktopChatBookmarks)];
    services.forEach(service => service.mockClear());
    const row = Object.values(chatOperations).find(operation => operation.channel === channel);
    await expect(h.invoke(channel, { ...payload, workspaceId: "other" })).rejects.toThrow(row?.inactiveMessage ?? "no longer active");
    services.forEach(service => expect(service).not.toHaveBeenCalled());
  });
});

describe("the personal feed names each item's viewer", () => {
  it("falls back only for the thread whose identity lookup rejects", async () => {
    const test = fixture();
    test.chatRelayIdentityFor.mockRejectedValueOnce(new Error("Identity unavailable"));
    test.storeMethods.listPersonalFeed.mockResolvedValueOnce({
      items: ["thread", "thread-joined"].map((threadId) => ({
        message: { ...test.message, id: `message-${threadId}`, threadId },
        thread: { ...test.thread, id: threadId },
        reactions: [],
        matchedBy: ["thread" as const],
      })),
    });
    const result = await test.invoke(chatOperations.listPersonalChatFeed.channel, { workspaceId: "workspace" }) as {
      items: Array<{ viewerAuthorId?: string }>;
    };
    expect(result.items.map((row) => row.viewerAuthorId)).toEqual(["local-owner", "recipient"]);
  });

  it("normalizes each item's reactions to its thread's viewer", async () => {
    const test = fixture();
    const reaction = (threadId: string, messageId: string, authorId: string) => ({
      reactionId: `reaction-${messageId}-${authorId}`, threadId, messageId,
      emoji: "👍", author: { authorId, kind: "human" as const, displayName: "Sam" },
      state: "added" as const, atMs: 4,
    });
    const item = (threadId: string, messageId: string, authorId: string) => ({
      message: { ...test.message, id: messageId, threadId },
      thread: { ...test.thread, id: threadId },
      reactions: [reaction(threadId, messageId, authorId)],
      matchedBy: ["thread" as const],
    });
    test.storeMethods.listPersonalFeed.mockResolvedValueOnce({
      items: [item("thread", "message-own", "local-owner"), item("thread-joined", "message-joined", "local-owner")],
    });
    const result = await test.invoke(chatOperations.listPersonalChatFeed.channel, { workspaceId: "workspace" }) as {
      items: Array<{ viewerAuthorId?: string; reactions: Array<{ authorId: string }> }>;
    };
    expect(result.items.map((row) => row.viewerAuthorId)).toEqual(["verified-owner", "recipient"]);
    expect(result.items.map((row) => row.reactions[0]?.authorId)).toEqual(["verified-owner", "recipient"]);
  });
});

describe("chat message IPC identity", () => {
  it("preserves an optional author identity through the bridge contract", () => {
    const { message } = fixture();
    expect(ChatMessageRecord.parse(chatMessageForIpc({ ...message, authorUserId: "person-1" }, () => null, neutralPresentation)))
      .toMatchObject({ authorUserId: "person-1" });
    expect(ChatMessageRecord.parse(chatMessageForIpc(message, () => null, neutralPresentation))).not.toHaveProperty("authorUserId");
  });

  it("carries an automation author, the automation that wrote the message, and where its Collection is now", () => {
    const { message } = fixture();
    const automated = {
      ...message,
      author: { kind: "automation" as const, displayName: "Stamp the finish date" },
      authorOwnerDisplayName: "Ice",
      automation: { automationId: "collection:object-tasks#stamp" },
    };
    const movedTo = (automationId: string) => (automationId === "collection:object-tasks#stamp" ? "Voyage/Tasks" : null);
    expect(ChatMessageRecord.parse(chatMessageForIpc(automated, movedTo, neutralPresentation))).toMatchObject({
      authorKind: "automation",
      authorDisplayName: "Stamp the finish date",
      authorOwnerDisplayName: "Ice",
      automation: { automationId: "collection:object-tasks#stamp", collectionPath: "Voyage/Tasks" },
    });
    // A Collection this computer no longer has still names its automation.
    expect(ChatMessageRecord.parse(chatMessageForIpc(automated, () => null, neutralPresentation))).toMatchObject({
      automation: { automationId: "collection:object-tasks#stamp", collectionPath: null },
    });
    // Another computer's automation arrives without the automation.
    const { automation: _automation, ...remote } = automated;
    expect(ChatMessageRecord.parse(chatMessageForIpc(remote, movedTo, neutralPresentation))).not.toHaveProperty("automation");
  });
});

describe("registered chat writes", () => {
  // Each handler must hand its write to chatWrites rather than the store: a
  // share scope reaching a store method would mean one bypassed it.
  for (const kind of ["view", "comment", "edit", "ended", "damaged"] as const) {
    it.each(mutations)(`${kind} scope refuses $name before any chat store operation`, async mutation => {
      const test = fixture(kind);
      await expect(test.invoke(mutation.channel, mutation.payload)).rejects.toThrow("Chats are read-only in this shared view.");
      for (const method of Object.values(test.storeMethods)) expect(method).not.toHaveBeenCalled();
      expect(test.captureMethods.fileObjectIdForPath).not.toHaveBeenCalled();
      expect(test.resolveEngineFiles).not.toHaveBeenCalled();
      expect(test.chatRelayIdentityFor).not.toHaveBeenCalled();
      expect(test.activity.queueCloudSync).not.toHaveBeenCalled();
      expect(test.requireEngineCapture).not.toHaveBeenCalled();
    });
  }

  it.each(mutations)("permits a local $name through the registered handler", async mutation => {
    const test = fixture();
    await test.invoke(mutation.channel, mutation.payload);
    expect(test.storeMethods[mutation.method]).toHaveBeenCalledOnce();
    expect(test.requireEngineCapture).toHaveBeenCalledWith("workspace", "Chats");
    expect(test.activity.queueCloudSync).toHaveBeenCalledWith("workspace");
  });

  it.each(mutations)("refuses an untrusted $name before resolving authority", async mutation => {
    const test = fixture();
    await expect(test.invoke(mutation.channel, mutation.payload, { sender: { trusted: false } })).rejects.toThrow("Untrusted sender");
    expect(test.requireEngineCapture).not.toHaveBeenCalled();
    expect(test.linkedChatStoreFor).not.toHaveBeenCalled();
    expect(test.storeMethods[mutation.method]).not.toHaveBeenCalled();
  });

  it.each(mutations)("rejects a malformed $name payload before resolving authority", async mutation => {
    const test = fixture();
    await expect(test.invoke(mutation.channel, { ...mutation.payload, workspaceId: "../outside" })).rejects.toThrow();
    expect(test.requireEngineCapture).not.toHaveBeenCalled();
    expect(test.linkedChatStoreFor).not.toHaveBeenCalled();
  });

  it("sends as the local person whatever identity the payload claims", async () => {
    const test = fixture();
    await test.invoke(chatOperations.sendChatMessage.channel, {
      workspaceId: "workspace", threadId: "thread", body: "Hello", authorUserId: "forged",
      authorActorKey: '{"kind":"installation","installationId":"forged"}',
      author: { kind: "agent", displayName: "Forged" }, fileReferences: [{ path: "notes/a.md" }],
    });
    expect(test.storeMethods.sendMessage).toHaveBeenCalledWith({
      workspaceId: "workspace", threadId: "thread", body: "Hello",
      author: { kind: "human", displayName: "Sam" }, authorUserId: "verified-owner",
      authorActorKey: '{"kind":"account","issuer":"https://cloud.test","userId":"verified-owner"}',
      attachments: [{ objectId: "object", pathHint: "notes/a.md" }],
    });
    expect(test.projectChatBookmarks).toHaveBeenCalledWith("workspace");
    expect(test.scanChatDispatch).toHaveBeenCalledWith("workspace");
  });

  it("names the reaction's author as the viewer, locally when signed out", async () => {
    const test = fixture();
    test.signOutChatWrites();
    expect(await test.invoke(CHANNELS.setChatReaction, mutations[3].payload)).toMatchObject({ viewerAuthorId: "local-owner" });
    expect(test.storeMethods.setReaction).toHaveBeenCalledWith({
      workspaceId: "workspace", threadId: "thread", messageId: "message", emoji: "👍", state: "added",
      author: { authorId: "local-owner", kind: "human", displayName: "Sam" },
    });
  });
});

describe("registered chat reads and reader-local state", () => {
  it.each(["local", "view", "comment", "edit", "ended", "damaged"] as const)("marks a thread read in %s scope without replication", async kind => {
    const test = fixture(kind);
    expect(await test.invoke(CHANNELS.markChatThreadRead, { workspaceId: "workspace", threadId: "thread", upToSequence: 3 })).toEqual({ lastReadSequence: 3, revision: 7 });
    expect(test.storeMethods.markThreadRead).toHaveBeenCalledWith({ workspaceId: "workspace", threadId: "thread", upToSequence: 3 });
    expect(test.activity.queueCloudSync).not.toHaveBeenCalled();
    expect(test.syncSharedChannelsForChatTarget).not.toHaveBeenCalled();
  });

  it("resolves served file chats through the share engine without acquiring capture", async () => {
    const test = fixture("ended");
    expect(await test.invoke(CHANNELS.listFileChats, { workspaceId: "workspace", path: "notes/a.md" })).toEqual({
      fileObjectId: "object", threads: [{ id: "thread", title: "Notes", createdAtMs: 1, updatedAtMs: 2 }],
    });
    expect(test.storeMethods.listThreadsForFile).toHaveBeenCalledWith({ workspaceId: "workspace", objectId: "object" });
    expect(test.resolveEngineFiles).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace", attachmentId: expect.any(Symbol) }), [{ path: "notes/a.md" }]);
    expect(test.requireEngineCapture).not.toHaveBeenCalled();
  });

  it("does not acquire a store after a held share open retires", async () => {
    const test = fixture("comment");
    const opened = deferred();
    const entered = deferred();
    test.openWorkspaceActivity.mockImplementationOnce(() => { entered.resolve(); return opened.promise; });
    const read = test.invoke(chatOperations.listChatMessages.channel, { workspaceId: "workspace", threadId: "thread" });
    const rejected = expect(read).rejects.toThrow("retired workspace authority");
    await entered.promise;
    const retired = test.authorities.invalidate("workspace");
    opened.resolve();
    await Promise.all([rejected, retired]);
    expect(test.linkedChatStoreFor).not.toHaveBeenCalled();
    expect(test.storeMethods.listMessages).not.toHaveBeenCalled();
  });

  it("does not promote a retired share scope to its successor for file reads", async () => {
    const test = fixture("view");
    const scope = await test.chatScope.requireChatScope("workspace");
    await test.authorities.invalidate("workspace");
    const successor = test.authorities.acquire("workspace");
    successor.release();
    await expect(test.chatScope.chatFileObjectId(scope, "notes/a.md")).rejects.toThrow("retired workspace authority");
    expect(test.resolveEngineFiles).not.toHaveBeenCalled();
  });
});

describe("registered channels and personal chat projections", () => {
  it("creates local channels and their first message through the existing writers", async () => {
    const test = fixture();
    expect(await test.invoke(CHANNELS.createChatChannel, { workspaceId: "workspace", name: "General" })).toMatchObject({ channel: { id: "channel", wireId: "channel", threadCount: 0, unreadCount: 0 } });
    // A group is a folder: the default folder is the slug, and main creates it.
    expect(test.storeMethods.createChannel).toHaveBeenCalledWith({ workspaceId: "workspace", name: "General", kind: "channel", folderPath: "general" });
    expect(test.ensureGroupFolder).toHaveBeenCalledWith(test.workspace, "general");
    expect(test.ensureGroupFolder.mock.invocationCallOrder[0]).toBeLessThan(test.storeMethods.createChannel.mock.invocationCallOrder[0]!);
    await test.invoke(chatOperations.startChannelThread.channel, { workspaceId: "workspace", channelId: "channel", body: "First message" });
    expect(test.storeMethods.startChannelThread).toHaveBeenCalledWith({
      workspaceId: "workspace", channelId: "channel", body: "First message",
      author: { kind: "human", displayName: "Sam" }, authorUserId: "verified-owner",
      authorActorKey: '{"kind":"account","issuer":"https://cloud.test","userId":"verified-owner"}',
    });
    expect(test.projectChatBookmarks).toHaveBeenCalledWith("workspace");
  });

  it("names the group when the engine refuses a taken or malformed name", async () => {
    const test = fixture();
    test.storeMethods.createChannel.mockRejectedValueOnce(new Error("channel-exists"));
    await expect(test.invoke(CHANNELS.createChatChannel, { workspaceId: "workspace", name: "Team" }))
      .rejects.toThrow("A group with that name already exists.");
    test.storeMethods.createChannel.mockRejectedValueOnce(new Error("invalid-channel-name"));
    await expect(test.invoke(CHANNELS.createChatChannel, { workspaceId: "workspace", name: "Team" }))
      .rejects.toThrow("Use 1 to 80 characters, including at least one letter or number.");
    // Any other engine refusal keeps its own reason.
    test.storeMethods.createChannel.mockRejectedValueOnce(new Error("disk full"));
    await expect(test.invoke(CHANNELS.createChatChannel, { workspaceId: "workspace", name: "Team" }))
      .rejects.toThrow("disk full");
  });

  it("requires a usable default folder and creates no channel if the folder fails", async () => {
    const test = fixture();
    await expect(test.invoke(CHANNELS.createChatChannel, { workspaceId: "workspace", name: "💥" }))
      .rejects.toThrow("Give the group a name with a letter or a number, or name its folder.");
    expect(test.ensureGroupFolder).not.toHaveBeenCalled();
    expect(test.storeMethods.createChannel).not.toHaveBeenCalled();
    test.ensureGroupFolder.mockRejectedValueOnce(new Error("disk full"));
    await expect(test.invoke(CHANNELS.createChatChannel, { workspaceId: "workspace", name: "Team" })).rejects.toThrow("disk full");
    expect(test.storeMethods.createChannel).not.toHaveBeenCalled();
    await test.invoke(CHANNELS.createChatChannel, { workspaceId: "workspace", name: "💥", folderPath: "team" });
    expect(test.storeMethods.createChannel).toHaveBeenCalledWith(expect.objectContaining({ folderPath: "team" }));
    // A name in another script is a name; its folder is spelled the same way.
    await test.invoke(CHANNELS.createChatChannel, { workspaceId: "workspace", name: "会议" });
    expect(test.ensureGroupFolder).toHaveBeenLastCalledWith(test.workspace, "会议");
    expect(test.storeMethods.createChannel).toHaveBeenLastCalledWith(expect.objectContaining({ folderPath: "会议" }));
  });

  it("saves and archives with the existing bookmark owner after identity warming", async () => {
    const test = fixture();
    const warmed = deferred();
    const entered = deferred();
    test.warmCredentialCache.mockImplementationOnce(() => { entered.resolve(); return warmed.promise; });
    const save = test.invoke(CHANNELS.saveChatBookmark, { workspaceId: "workspace", target: { kind: "thread", threadId: "thread" }, mode: "live" });
    await entered.promise;
    expect(test.storeMethods.saveBookmark).not.toHaveBeenCalled();
    warmed.resolve();
    expect(await save).toMatchObject({ bookmark: { bookmarkId: "bookmark", projectionState: "ready" } });
    expect(test.storeMethods.saveBookmark).toHaveBeenCalledWith({ workspaceId: "workspace", ownerUserId: "owner", targetKind: "thread", targetId: "thread", mode: "live", destinationPath: "Bookmarks/Chats/Notes--thread.md" });
    expect(test.desktopChatBookmarks.materializeChatBookmark).toHaveBeenCalledWith(test.workspace, test.capture, expect.objectContaining({ bookmarkId: "bookmark" }));
    expect(await test.invoke(CHANNELS.archiveChatBookmark, { workspaceId: "workspace", bookmarkId: "bookmark" })).toMatchObject({ bookmark: { state: "archived", generation: 2 } });
    expect(test.desktopChatBookmarks.archiveChatBookmark).toHaveBeenCalledWith(test.workspace, test.capture, "owner", "bookmark");
  });

  it("refuses to follow an automation as an author", async () => {
    const test = fixture();
    test.storeMethods.listMessages.mockResolvedValueOnce([{
      ...test.message, author: { kind: "automation", displayName: "Stamp the finish date" }, authorUserId: "person-1",
    }]);
    await expect(test.invoke(CHANNELS.setChatFollow, {
      workspaceId: "workspace", target: { kind: "author", threadId: test.message.threadId, messageId: test.message.id }, state: "following",
    })).rejects.toThrow("An automation cannot be followed. Follow its Group instead.");
    expect(test.storeMethods.setFollow).not.toHaveBeenCalled();
  });

  it("keeps personal follows and feed cursors owned by the warmed local identity", async () => {
    const test = fixture();
    await test.invoke(CHANNELS.setChatFollow, { workspaceId: "workspace", target: { kind: "thread", threadId: "thread" }, state: "following", ownerUserId: "forged" });
    expect(test.storeMethods.setFollow).toHaveBeenCalledWith({ workspaceId: "workspace", ownerUserId: "owner", targetKind: "thread", targetId: "thread", state: "following" });
    await test.invoke(CHANNELS.markPersonalChatFeedSeen, { workspaceId: "workspace", headCursor: "cursor", ownerUserId: "forged" });
    expect(test.storeMethods.markPersonalFeedSeen).toHaveBeenCalledWith({ workspaceId: "workspace", ownerUserId: "owner", headCursor: "cursor" });
    expect(test.warmCredentialCache).toHaveBeenCalledTimes(2);
    expect(test.activity.queueCloudSync).not.toHaveBeenCalled();
  });

  it.each([CHANNELS.createChatChannel, chatOperations.startChannelThread.channel, CHANNELS.saveChatBookmark, CHANNELS.archiveChatBookmark, CHANNELS.setChatFollow] as const)("keeps workspace-only operation %s behind capture", async channel => {
    const test = fixture("edit");
    const payloads = {
      [CHANNELS.createChatChannel]: { workspaceId: "workspace", name: "General" },
      [chatOperations.startChannelThread.channel]: { workspaceId: "workspace", channelId: "channel", body: "First" },
      [CHANNELS.saveChatBookmark]: { workspaceId: "workspace", target: { kind: "thread", threadId: "thread" }, mode: "live" },
      [CHANNELS.archiveChatBookmark]: { workspaceId: "workspace", bookmarkId: "bookmark" },
      [CHANNELS.setChatFollow]: { workspaceId: "workspace", target: { kind: "thread", threadId: "thread" }, state: "following" },
    };
    await expect(test.invoke(channel, payloads[channel])).rejects.toThrow("A shared view has no capture.");
    expect(test.linkedChatStoreFor).not.toHaveBeenCalled();
    for (const method of Object.values(test.storeMethods)) expect(method).not.toHaveBeenCalled();
    expect(test.desktopChatBookmarks.archiveChatBookmark).not.toHaveBeenCalled();
  });
});


describe("targeted file resolution", () => {
  it.each(["resolution failure", "deleted file"])("retains the file-chat hint after %s", async outcome => {
    const test = fixture();
    if (outcome === "resolution failure") test.resolveEngineFiles.mockRejectedValue(new Error("Engine unavailable"));
    else test.resolveEngineFiles.mockResolvedValue([{ status: "absent" }]);
    expect(await test.invoke(CHANNELS.listChatChannels, { workspaceId: "workspace" })).toMatchObject({
      fileThreads: [{ id: "thread", path: "notes/a.md" }],
    });
  });

  it("keeps mention attachment identity when a path is reused", async () => {
    const test = fixture();
    test.captureMethods.resolveFileForPath.mockResolvedValue({ objectId: "replacement", path: "notes/a.md" });
    const attachment = { attachmentId: "attachment", threadId: test.thread.id, messageId: test.message.id, targetKind: "file" as const, objectId: "object", pathHint: "notes/a.md", createdAtMs: 1 };
    test.storeMethods.listFileMentions.mockResolvedValue([
      { attachment, thread: test.thread, message: test.message },
      { attachment: { ...attachment, attachmentId: "replacement-attachment", objectId: "replacement" }, thread: test.thread, message: test.message },
    ]);
    expect(await test.invoke(chatOperations.listChatFileMentions.channel, { workspaceId: "workspace", path: "./notes//a.md" })).toMatchObject({ mentions: [
      { attachment: { objectId: "replacement", pathHint: "notes/a.md" } },
    ] });
    expect(test.captureMethods.resolveFileForPath).toHaveBeenCalledExactlyOnceWith("./notes//a.md");
    expect(test.storeMethods.listFileMentions).toHaveBeenCalledWith({ workspaceId: "workspace", objectId: "replacement" });
    expect(test.captureMethods.fileObjectIdForPath).not.toHaveBeenCalled();
    expect(test.resolveEngineFiles).not.toHaveBeenCalled();
  });
  it("resolves distinct linked file ids and retains display hints for absent objects", async () => {
    const test = fixture();
    test.storeMethods.listThreads.mockResolvedValue([test.thread, { ...test.thread, id: "duplicate" }, {
      ...test.thread, id: "gone", linkedFile: { objectId: "gone", pathHint: "../legacy display hint", linkedAtMs: 1 },
    }]);
    test.resolveEngineFiles.mockResolvedValue([{ status: "found", objectId: "object", path: "moved.md" }, { status: "absent" }]);
    expect(await test.invoke(CHANNELS.listChatChannels, { workspaceId: "workspace" })).toMatchObject({ fileThreads: [
      { id: "thread", path: "moved.md" }, { id: "duplicate", path: "moved.md" }, { id: "gone", path: "../legacy display hint" },
    ] });
    expect(test.resolveEngineFiles).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace" }), [workspaceFileRef("workspace", "object"), workspaceFileRef("workspace", "gone")]);
  });
});

 it("gives the feed opening the same token as its thread without bridging a stored key", async () => {
   const h = fixture();
   const row = { ...h.message, authorActorKey: '{"kind":"installation","installationId":"local-owner"}', origin: "cli" as const };
   h.storeMethods.listMessages.mockResolvedValueOnce([row]);
   h.storeMethods.listChannelThreads.mockResolvedValueOnce([{
     thread: { ...h.thread, channelId: "channel" }, messageCount: 1, lastReadSequence: 0, unreadCount: 1, openDecisionCount: 0,
     openingMessage: { ...row, bodySnippet: row.body, reactions: [] },
   }]);
   const listed = await h.invoke(chatOperations.listChatMessages.channel, { workspaceId: "workspace", threadId: "thread" }) as { messages: ChatMessageRecord[] };
   const feed = await h.invoke(chatOperations.listChannelThreads.channel, { workspaceId: "workspace", channelId: "channel" }) as { threads: { openingMessage: { presentation: ChatMessageRecord["presentation"] } }[] };
   expect(feed.threads[0]!.openingMessage.presentation).toEqual(listed.messages[0]!.presentation);
   expect(listed.messages[0]!.presentation.self).toBe(true);
   expect(JSON.stringify(listed)).not.toContain("authorActorKey");
   expect(JSON.stringify(feed)).not.toContain("authorActorKey");
 });

it("keeps two unknown authors distinct in a received share view", async () => {
  const h = fixture("view");
  const alice = { ...h.message, author: { kind: "human" as const, displayName: "Alice" }, authorUserId: "alice" };
  const bob = { ...alice, id: "bob", author: { kind: "human" as const, displayName: "Bob" }, authorUserId: "bob" };
  h.storeMethods.listMessages.mockResolvedValueOnce([alice, bob, { ...alice, id: "alice-again" }]);
  const result = await h.invoke(chatOperations.listChatMessages.channel, { workspaceId: "workspace", threadId: "thread" }) as { messages: ChatMessageRecord[] };
  const tokens = result.messages.map(row => row.presentation);
  expect(tokens[0]).toMatchObject({ hue: null, self: false });
  expect(tokens[1]!.group).not.toBe(tokens[0]!.group);
  expect(tokens[2]!.group).toBe(tokens[0]!.group);
});

describe("poll IPC writes", () => {
  const doors = [
    { name: "send", channel: chatOperations.sendChatMessage.channel, target: { threadId: "thread" }, method: "sendMessage" },
    { name: "start", channel: chatOperations.startChannelThread.channel, target: { channelId: "channel" }, method: "startChannelThread" },
  ] as const;
  it.each(doors)("passes a poll through chatWrites on $name", async ({ channel, target, method }) => {
    const test = fixture();
    const poll = { needsDecision: true, options: [" Monday ", "Tuesday"] };
    await test.invoke(channel, { workspaceId: "workspace", ...target, body: "When?", ...poll });
    expect(test.storeMethods[method]).toHaveBeenCalledWith(expect.objectContaining(poll));
  });
  it.each(doors)("passes choices without a decision flag on $name", async ({ channel, target, method }) => {
    const test = fixture();
    await test.invoke(channel, { workspaceId: "workspace", ...target, body: "When?", options: ["Monday", "Tuesday"] });
    const input = test.storeMethods[method].mock.calls[0]![0];
    expect(input).toMatchObject({ options: ["Monday", "Tuesday"] });
    expect(input).not.toHaveProperty("needsDecision");
  });
  it.each([
    { name: "a decision flag", poll: { needsDecision: true }, count: 1 },
    { name: "choices alone", poll: { options: ["Monday", "Tuesday"] }, count: 1 },
    { name: "choices with a false decision flag", poll: { needsDecision: false, options: ["Monday", "Tuesday"] }, count: 1 },
    { name: "a decision flag with no choices", poll: { needsDecision: true, options: [] }, count: 1 },
    { name: "a plain message", poll: {}, count: 0 },
    { name: "no decision and no choices", poll: { needsDecision: false, options: [] }, count: 0 },
  ])("returns the opening decision count for $name", async ({ poll, count }) => {
    const test = fixture();
    const result = StartChannelThreadResult.parse(await test.invoke(chatOperations.startChannelThread.channel, {
      workspaceId: "workspace", channelId: "channel", body: "When?", ...poll,
    }));
    expect(result.thread.openDecisionCount).toBe(count);
  });
  it.each(doors)("refuses a poll in a share view on $name before persistence", async ({ channel, target, name }) => {
    const test = fixture("view");
    await expect(test.invoke(channel, { workspaceId: "workspace", ...target, body: "When?", needsDecision: true, options: ["Monday", "Tuesday"] }))
      .rejects.toThrow(name === "send" ? "Chats are read-only in this shared view." : "A shared view has no capture.");
    for (const method of Object.values(test.storeMethods)) expect(method).not.toHaveBeenCalled();
    expect(test.activity.queueCloudSync).not.toHaveBeenCalled();
  });
});


it("reads both IPC polls back with their decisions from the live chat store", async () => {
  const workspace = { workspaceId: "workspace", rootPath: await createTestScratch("dohc-ipc-poll-") };
  const engine = new ChatsLoopbackEngine();
  const client = { close() {}, async sendRequest(request: import("@dohc/workspace-engine-client").Request): Promise<import("@dohc/workspace-engine-client").Response> {
    if (request.method === "workspace.open") return { id: request.id, result: { workspace: workspace.workspaceId } };
    if (request.method === "workspace.close") return { id: request.id, result: { closed: true } };
    return engine.sendRequest(request);
  } };
  const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
  const store = createDesktopLinkedChatStore(workspace, { sessions });
  try {
    const channel = await store.ensureGeneralChannel({ workspaceId: workspace.workspaceId });
    const test = fixture("local", store);
    const first = StartChannelThreadResult.parse(await test.invoke(chatOperations.startChannelThread.channel, {
      workspaceId: workspace.workspaceId, channelId: channel.id, body: "Which day?", needsDecision: true, options: [" Monday ", "Tuesday"],
    }));
    const second = SendChatMessageResult.parse(await test.invoke(chatOperations.sendChatMessage.channel, {
      workspaceId: workspace.workspaceId, threadId: first.thread.id, body: "Which time?", options: ["Morning", "Afternoon"],
    }));
    const messages = ListChatMessagesResult.parse(await test.invoke(chatOperations.listChatMessages.channel, {
      workspaceId: workspace.workspaceId, threadId: first.thread.id,
    }));
    expect(messages.messages.map(message => message.id)).toEqual([first.message.id, second.message.id]);
    const decisions = ListChatThreadDecisionsResult.parse(await test.invoke(CHANNELS.listChatThreadDecisions, {
      workspaceId: workspace.workspaceId, threadId: first.thread.id,
    }));
    expect(decisions.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: first.message.id, state: "open", options: ["Monday", "Tuesday"] }),
      expect.objectContaining({ messageId: second.message.id, state: "open", options: ["Morning", "Afternoon"] }),
    ]));
    expect(decisions.decisions).toHaveLength(2);
  } finally { await sessions.closeWorkspace(workspace); }
});
