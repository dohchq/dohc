import { describe, expect, it, vi } from "vitest";
import type { ChatBookmark, ChatMessage, ChatThread } from "@dohc/workspace-contracts/engine";
import { CHANNELS } from "./channels";
import { createChatScopeCapability } from "./chatScope";
import { registerChatsIpcHandlers } from "./chatsIpc";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { deferred } from "../testing/deferred";

type ScopeKind = "local" | "view" | "comment" | "edit" | "ended" | "damaged";
type Event = { sender: { trusted: boolean } };
type Operation = { workspace: RegistryEntry; assertCurrent(): void };

function fixture(kind: ScopeKind = "local") {
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
    author: { kind: "human", displayName: "Ice" }, body: "A reply", createdAtMs: 3, attachments: [],
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
    sendMessage: vi.fn<DesktopLinkedChatStore["sendMessage"]>(async input => ({ ...message, ...input, attachments: storedAttachments(input.attachments) })),
    resolveChatDecision: vi.fn<DesktopLinkedChatStore["resolveChatDecision"]>(async input => ({ ...input, state: "resolved", atMs: 4 })),
    setReaction: vi.fn<DesktopLinkedChatStore["setReaction"]>(async input => ({ ...input, reactionId: "reaction", atMs: 4 })),
    listReactions: vi.fn<DesktopLinkedChatStore["listReactions"]>(async () => []),
    markThreadRead: vi.fn<DesktopLinkedChatStore["markThreadRead"]>(async input => ({ ...input, lastReadSequence: input.upToSequence, revision: 7, updatedAtMs: 5 })),
    listMessages: vi.fn<DesktopLinkedChatStore["listMessages"]>(async () => [message]),
    listThreads: vi.fn<DesktopLinkedChatStore["listThreads"]>(async () => [thread]),
    listThreadsForFile: vi.fn<DesktopLinkedChatStore["listThreadsForFile"]>(async () => [thread]),
    getThreadRevision: vi.fn<DesktopLinkedChatStore["getThreadRevision"]>(async () => 7),
    listChannels: vi.fn<DesktopLinkedChatStore["listChannels"]>(async () => []),
    findThreadChannelId: vi.fn<DesktopLinkedChatStore["findThreadChannelId"]>(async () => "channel"),
    getChannelWireId: vi.fn<DesktopLinkedChatStore["getChannelWireId"]>(async () => "wire"),
    createChannel: vi.fn<DesktopLinkedChatStore["createChannel"]>(async input => ({ ...input, id: "channel", kind: "channel", slug: "general", createdAtMs: 1, updatedAtMs: 1 })),
    startChannelThread: vi.fn<DesktopLinkedChatStore["startChannelThread"]>(async input => ({
      thread: { id: thread.id, workspaceId: thread.workspaceId, title: thread.title, createdAtMs: 1, updatedAtMs: 2, channelId: input.channelId },
      message: { ...message, ...input, attachments: storedAttachments(input.attachments) },
    })),
    listBookmarks: vi.fn<DesktopLinkedChatStore["listBookmarks"]>(async () => [bookmark]),
    saveBookmark: vi.fn<DesktopLinkedChatStore["saveBookmark"]>(async input => ({ ...bookmark, ...input })),
    setFollow: vi.fn<DesktopLinkedChatStore["setFollow"]>(async input => ({ ...input, updatedAtMs: 5 })),
    markPersonalFeedSeen: vi.fn<DesktopLinkedChatStore["markPersonalFeedSeen"]>(async input => ({ ...input, lastSeenCreatedAtMs: 3, lastSeenMessageId: "message", updatedAtMs: 5 })),
  };
  // Unused ports fail if a handler unexpectedly reaches them. Each configured method keeps the production signature.
  const store = new Proxy(storeMethods, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      throw new Error(`Unexpected chat store method: ${String(key)}`);
    },
  }) as unknown as DesktopLinkedChatStore;
  const captureMethods = { fileObjectIdForPath: vi.fn(async () => "object" as string | null) };
  const capture = captureMethods as unknown as WorkspaceEngineCapture;
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: id => id === workspace.workspaceId ? workspace : null,
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
  const activeEngineFileIndex = vi.fn(async () => ({
    objectIdByPath: new Map([["notes/a.md", "object"]]), pathByObjectId: new Map([["object", "notes/a.md"]]),
  }));
  const readOwnedWorkspaceText = vi.fn(async () => ({ text: "# Section\n" }));
  const chatScope = createChatScopeCapability({
    workspaceAuthorities: authorities, canonicalWorkspaceFor, requireEngineCapture,
    linkedChatStoreFor, openWorkspaceActivity,
    receivedShareEngine: { workspaceFor: input => ({ workspaceId: input.engineWorkspaceId, rootPath: input.rootPath, attachmentId: input.attachmentId }) },
    syncSharedChannelsForChatTarget, activity, activeEngineFileIndex, readOwnedWorkspaceText,
  });
  const warmCredentialCache = vi.fn(async (): Promise<void> => undefined);
  const verifiedChatAuthorUserIdFor = vi.fn(async (): Promise<string | undefined> => "verified-owner");
  const revalidateChatWrite = vi.fn(async () => undefined);
  const chatDispatchService = { scanWorkspace: vi.fn(async () => undefined) };
  const desktopChatBookmarks = {
    materializeChatBookmark: vi.fn(async (_workspace: RegistryEntry, _capture: WorkspaceEngineCapture, saved: ChatBookmark) => ({ ...saved, projectionState: "ready" as const })),
    materializePendingChatBookmarks: vi.fn(async () => undefined),
    archiveChatBookmark: vi.fn(async () => ({ ...bookmark, state: "archived" as const, generation: 2, projectionState: "ready" as const })),
  };
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const sender = { trusted: true };
  const assertTrustedSender = vi.fn((event: Event) => {
    if (!event.sender.trusted) throw new Error("Untrusted sender");
  });
  registerChatsIpcHandlers<Event["sender"], Event, Operation>({
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender, chatScope, requireEngineCapture, linkedChatStoreFor,
    findWorkspace: () => workspace,
    assertWritableWorkspace: value => { if (shareViewIsPresent(value.shareView)) throw new Error("Read-only workspace"); },
    warmCredentialCache, localUserId: () => "owner", localUserDisplayName: () => "Ice",
    localReactorFallbackId: () => "local-owner", currentCredentials: () => null,
    verifiedChatAuthorUserIdFor, revalidateChatWrite,
    chatRelayIdentityFor: async () => ({ joinedChannel: null, authorUserId: "verified-owner" }),
    syncWorkspaceSharedChannels: async () => 0, syncSharedChannelsForChatTarget,
    syncRendererWorkspaceSharedChannels: async () => 0,
    withRendererWorkspaceOperation: async (_sender, _id, _message, run) => run({ workspace, assertCurrent() {} }),
    activeEngineFileIndex, activity, chatDispatchService, desktopChatBookmarks, notifyRenderer: () => undefined,
  });
  async function invoke(channel: string, payload: unknown, event: Event = { sender }) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing chat handler: ${channel}`);
    return await handler(event, payload);
  }
  return { invoke, workspace, thread, message, bookmark, storeMethods, captureMethods, capture,
    authorities, chatScope, requireEngineCapture, linkedChatStoreFor, openWorkspaceActivity,
    activity, syncSharedChannelsForChatTarget, activeEngineFileIndex, readOwnedWorkspaceText,
    warmCredentialCache, verifiedChatAuthorUserIdFor, revalidateChatWrite, chatDispatchService, desktopChatBookmarks };
}

const mutations = [
  { name: "create", channel: CHANNELS.createFileChat, payload: { workspaceId: "workspace", path: "notes/a.md", title: "Notes" }, method: "createThread" },
  { name: "send", channel: CHANNELS.sendChatMessage, payload: { workspaceId: "workspace", threadId: "thread", body: "Hello" }, method: "sendMessage" },
  { name: "decision", channel: CHANNELS.resolveChatDecision, payload: { workspaceId: "workspace", threadId: "thread", messageId: "message", resolvedByMessageId: "reply" }, method: "resolveChatDecision" },
  { name: "reaction", channel: CHANNELS.setChatReaction, payload: { workspaceId: "workspace", threadId: "thread", messageId: "message", emoji: "👍", state: "added" }, method: "setReaction" },
] as const;

describe("registered chat write gates", () => {
  for (const kind of ["view", "comment", "edit", "ended", "damaged"] as const) {
    it.each(mutations)(`${kind} scope refuses $name before any chat store operation`, async mutation => {
      const test = fixture(kind);
      await expect(test.invoke(mutation.channel, mutation.payload)).rejects.toThrow("Chats are read-only in this shared view.");
      for (const method of Object.values(test.storeMethods)) expect(method).not.toHaveBeenCalled();
      expect(test.captureMethods.fileObjectIdForPath).not.toHaveBeenCalled();
      expect(test.verifiedChatAuthorUserIdFor).not.toHaveBeenCalled();
      expect(test.desktopChatBookmarks.materializePendingChatBookmarks).not.toHaveBeenCalled();
      expect(test.chatDispatchService.scanWorkspace).not.toHaveBeenCalled();
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

  for (const grant of ["read-only", "ended"] as const) {
    it.each([
      ...mutations.slice(1),
      { name: "channel composer", channel: CHANNELS.startChannelThread, payload: { workspaceId: "workspace", channelId: "channel", body: "First" }, method: "startChannelThread" as const },
    ])(`${grant} joined channel refuses $name before a durable write`, async mutation => {
      const test = fixture();
      test.workspace.sharedChannels = [{
        shareId: "share", channelWireId: "wire", granterEmail: "owner@example.test",
        relayUrl: "https://relay.example.test", recipientUserId: "owner",
        access: grant === "read-only" ? "read-only" : "read-write",
        ...(grant === "ended" ? { ended: true } : {}),
      }];
      await expect(test.invoke(mutation.channel, mutation.payload)).rejects.toThrow("This shared channel is read-only for you.");
      expect(test.storeMethods.getChannelWireId).toHaveBeenCalledWith({ workspaceId: "workspace", channelId: "channel" });
      for (const method of ["createThread", "sendMessage", "resolveChatDecision", "setReaction", "startChannelThread"] as const) {
        expect(test.storeMethods[method]).not.toHaveBeenCalled();
      }
      expect(test.captureMethods.fileObjectIdForPath).not.toHaveBeenCalled();
      expect(test.verifiedChatAuthorUserIdFor).not.toHaveBeenCalled();
      expect(test.activity.queueCloudSync).not.toHaveBeenCalled();
    });
  }

  it("retains main-derived message identity and resolves attachments before revalidating", async () => {
    const test = fixture();
    const entered = deferred();
    const file = deferred<string | null>();
    test.captureMethods.fileObjectIdForPath.mockImplementationOnce(() => { entered.resolve(); return file.promise; });
    const sent = test.invoke(CHANNELS.sendChatMessage, {
      workspaceId: "workspace", threadId: "thread", body: "Hello", authorUserId: "forged",
      author: { kind: "agent", displayName: "Forged" }, fileReferences: [{ path: "notes/a.md" }],
    });
    await entered.promise;
    expect(test.verifiedChatAuthorUserIdFor).toHaveBeenCalledOnce();
    expect(test.revalidateChatWrite).not.toHaveBeenCalled();
    expect(test.storeMethods.sendMessage).not.toHaveBeenCalled();
    file.resolve("object");
    await sent;
    expect(test.revalidateChatWrite).toHaveBeenCalledWith(test.workspace, { threadId: "thread" }, "verified-owner", expect.anything());
    expect(test.storeMethods.sendMessage).toHaveBeenCalledWith({
      workspaceId: "workspace", threadId: "thread", body: "Hello",
      author: { kind: "human", displayName: "Ice" }, authorUserId: "verified-owner",
      attachments: [{ objectId: "object", pathHint: "notes/a.md" }],
    });
    expect(test.desktopChatBookmarks.materializePendingChatBookmarks).toHaveBeenCalledWith(test.workspace, test.capture);
    expect(test.chatDispatchService.scanWorkspace).toHaveBeenCalledWith("workspace");
  });

  it("does not persist a message when identity revalidation rejects", async () => {
    const test = fixture();
    test.revalidateChatWrite.mockRejectedValueOnce(new Error("Changed identity"));
    await expect(test.invoke(CHANNELS.sendChatMessage, mutations[1].payload)).rejects.toThrow("Changed identity");
    expect(test.storeMethods.sendMessage).not.toHaveBeenCalled();
    expect(test.desktopChatBookmarks.materializePendingChatBookmarks).not.toHaveBeenCalled();
    expect(test.activity.queueCloudSync).not.toHaveBeenCalled();
  });

  it("keeps the fallback reaction author local when signed out", async () => {
    const test = fixture();
    test.verifiedChatAuthorUserIdFor.mockResolvedValueOnce(undefined);
    expect(await test.invoke(CHANNELS.setChatReaction, mutations[3].payload)).toMatchObject({ viewerAuthorId: "local-owner" });
    expect(test.storeMethods.setReaction).toHaveBeenCalledWith({
      workspaceId: "workspace", threadId: "thread", messageId: "message", emoji: "👍", state: "added",
      author: { authorId: "local-owner", kind: "human", displayName: "Ice" },
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

  it("reads served file chats through the share engine index without acquiring capture", async () => {
    const test = fixture("ended");
    expect(await test.invoke(CHANNELS.listFileChats, { workspaceId: "workspace", path: "notes/a.md" })).toEqual({
      fileObjectId: "object", threads: [{ id: "thread", title: "Notes", createdAtMs: 1, updatedAtMs: 2 }],
    });
    expect(test.storeMethods.listThreadsForFile).toHaveBeenCalledWith({ workspaceId: "workspace", objectId: "object" });
    expect(test.activeEngineFileIndex).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace", attachmentId: expect.any(Symbol) }));
    expect(test.requireEngineCapture).not.toHaveBeenCalled();
  });

  it("does not acquire a store after a held share open retires", async () => {
    const test = fixture("comment");
    const opened = deferred();
    const entered = deferred();
    test.openWorkspaceActivity.mockImplementationOnce(() => { entered.resolve(); return opened.promise; });
    const read = test.invoke(CHANNELS.listChatMessages, { workspaceId: "workspace", threadId: "thread" });
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
    expect(test.activeEngineFileIndex).not.toHaveBeenCalled();
  });
});

describe("registered channels and personal chat projections", () => {
  it("creates local channels and their first message through the existing writers", async () => {
    const test = fixture();
    expect(await test.invoke(CHANNELS.createChatChannel, { workspaceId: "workspace", name: "General" })).toMatchObject({ channel: { id: "channel", wireId: "channel", threadCount: 0, unreadCount: 0 } });
    expect(test.storeMethods.createChannel).toHaveBeenCalledWith({ workspaceId: "workspace", name: "General", kind: "channel" });
    await test.invoke(CHANNELS.startChannelThread, { workspaceId: "workspace", channelId: "channel", body: "First message" });
    expect(test.storeMethods.startChannelThread).toHaveBeenCalledWith({ workspaceId: "workspace", channelId: "channel", body: "First message", author: { kind: "human", displayName: "Ice" }, authorUserId: "verified-owner" });
    expect(test.desktopChatBookmarks.materializePendingChatBookmarks).toHaveBeenCalledWith(test.workspace, test.capture);
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

  it("keeps personal follows and feed cursors owned by the warmed local identity", async () => {
    const test = fixture();
    await test.invoke(CHANNELS.setChatFollow, { workspaceId: "workspace", target: { kind: "thread", threadId: "thread" }, state: "following", ownerUserId: "forged" });
    expect(test.storeMethods.setFollow).toHaveBeenCalledWith({ workspaceId: "workspace", ownerUserId: "owner", targetKind: "thread", targetId: "thread", state: "following" });
    await test.invoke(CHANNELS.markPersonalChatFeedSeen, { workspaceId: "workspace", headCursor: "cursor", ownerUserId: "forged" });
    expect(test.storeMethods.markPersonalFeedSeen).toHaveBeenCalledWith({ workspaceId: "workspace", ownerUserId: "owner", headCursor: "cursor" });
    expect(test.warmCredentialCache).toHaveBeenCalledTimes(2);
    expect(test.activity.queueCloudSync).not.toHaveBeenCalled();
  });

  it.each([CHANNELS.createChatChannel, CHANNELS.startChannelThread, CHANNELS.saveChatBookmark, CHANNELS.archiveChatBookmark, CHANNELS.setChatFollow] as const)("keeps workspace-only operation %s behind capture", async channel => {
    const test = fixture("edit");
    const payloads = {
      [CHANNELS.createChatChannel]: { workspaceId: "workspace", name: "General" },
      [CHANNELS.startChannelThread]: { workspaceId: "workspace", channelId: "channel", body: "First" },
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
