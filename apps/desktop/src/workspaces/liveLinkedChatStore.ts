import {
  ChatsAdapterCapabilityError,
  ChatsLiveAdapter,
  type ChatChannel as LiveChatChannel,
  type ChatChannelSummary as LiveChatChannelSummary,
  type ChatFileMention as LiveChatFileMention,
} from "@dohc/workspace-engine-client";
import {
  createLinkedChatStore,
  type ChatChannel,
  type ChatChannelSummary,
  type ChatFeedPage,
  type ChatFileMention,
  type LinkedChatStore,
} from "@dohc/workspace-engine";
import type {
  EngineWorkspace,
  EngineWorkspaceSessions,
} from "./engineWorkspaceSessions";
import type { AwaitableLinkedChatStore } from "./awaitableLinkedChatStore";

export interface DesktopLinkedChatStoreOptions {
  rustEngineEnabled: boolean;
  sessions: EngineWorkspaceSessions | null;
  createLegacyStore?: (rootPath: string) => LinkedChatStore;
}

function toStoreChannel(channel: LiveChatChannel): ChatChannel {
  const { channelId, ...rest } = channel;
  return { ...rest, id: channelId } as ChatChannel;
}

function toStoreChannelSummary(
  channel: LiveChatChannelSummary,
): ChatChannelSummary {
  const { channelId, ...rest } = channel;
  return { ...rest, id: channelId } as ChatChannelSummary;
}

function toStoreFileMention(mention: LiveChatFileMention): ChatFileMention {
  return {
    ...mention,
    ...(mention.channel
      ? { channel: toStoreChannel(mention.channel) }
      : {}),
  } as ChatFileMention;
}

export function createLiveLinkedChatStore(
  workspace: EngineWorkspace,
  sessions: EngineWorkspaceSessions,
): AwaitableLinkedChatStore {
  const invoke = async <T>(
    operation: (adapter: ChatsLiveAdapter) => Promise<T>,
  ): Promise<T> =>
    await sessions.run(workspace, async ({ client, workspace: handle }) => {
      const adapter = new ChatsLiveAdapter(client, handle, {
        workspaceId: workspace.workspaceId,
      });
      return await operation(adapter);
    });

  return {
    createThread: async (input) =>
      await invoke(async (adapter) => await adapter.createThread(input)),
    createChannel: async (input) =>
      toStoreChannel(
        await invoke(async (adapter) => await adapter.createChannel(input)),
      ),
    ensureGeneralChannel: async (input) =>
      toStoreChannel(
        await invoke(
          async (adapter) => await adapter.ensureGeneralChannel(input),
        ),
      ),
    ensureAgentChannel: async (input) =>
      toStoreChannel(
        await invoke(async (adapter) => await adapter.ensureAgentChannel(input)),
      ),
    listChannels: async (input) =>
      (
        await invoke(async (adapter) => await adapter.listChannels(input))
      ).map(toStoreChannelSummary),
    findChannelBySlug: async (input) => {
      const channel = await invoke(
        async (adapter) => await adapter.findChannelBySlug(input),
      );
      return channel ? toStoreChannel(channel) : null;
    },
    getChannelWireId: async (input) =>
      await invoke(async (adapter) => await adapter.getChannelWireId(input)),
    findThreadChannelId: async (input) =>
      await invoke(
        async (adapter) => await adapter.findThreadChannelId(input),
      ),
    startChannelThread: async (input) =>
      await invoke(
        async (adapter) => await adapter.startChannelThread(input),
      ),
    listChannelThreads: async (input) =>
      await invoke(
        async (adapter) => await adapter.listChannelThreads(input),
      ),
    markThreadRead: async (input) =>
      await invoke(async (adapter) => await adapter.markThreadRead(input)),
    listThreads: async (input) =>
      await invoke(async (adapter) => {
        const threads = await adapter.listThreads(input);
        const linkedObjectIds = [
          ...new Set(
            threads.flatMap((thread) =>
              thread.linkedFile ? [thread.linkedFile.objectId] : [],
            ),
          ),
        ];
        if (linkedObjectIds.length === 0) return threads;
        const richerThreads = (
          await Promise.all(
            linkedObjectIds.map(
              async (objectId) =>
                await adapter.listThreadsForFile({
                  workspaceId: input.workspaceId,
                  objectId,
                }),
            ),
          )
        ).flat();
        const richerById = new Map(
          richerThreads.map((thread) => [thread.id, thread]),
        );
        return threads.map((thread) => richerById.get(thread.id) ?? thread);
      }),
    listThreadsForFile: async (input) =>
      await invoke(
        async (adapter) => await adapter.listThreadsForFile(input),
      ),
    sendMessage: async (input) =>
      await invoke(async (adapter) => await adapter.sendMessage(input)),
    listMessages: async (input) =>
      await invoke(async (adapter) => await adapter.listMessages(input)),
    resolveChatDecision: async (input) =>
      await invoke(
        async (adapter) => await adapter.resolveChatDecision(input),
      ),
    listThreadDecisions: async (workspaceId, threadId) =>
      await invoke(
        async (adapter) =>
          await adapter.listThreadDecisions(workspaceId, threadId),
      ),
    listThreadAttachments: async (workspaceId, threadId) =>
      await invoke(
        async (adapter) =>
          await adapter.listThreadAttachments(workspaceId, threadId),
      ),
    listFileMentions: async (input) =>
      (
        await invoke(async (adapter) => await adapter.listFileMentions(input))
      ).map(toStoreFileMention),
    markThreadReadByAgent: async (input) =>
      await invoke(
        async (adapter) => await adapter.markThreadReadByAgent(input),
      ),
    listAgentUnreadThreads: async (workspaceId) =>
      await invoke(
        async (adapter) =>
          await adapter.listAgentUnreadThreads(workspaceId),
      ),
    listMentionsForHandle: async (workspaceId, handle, options) =>
      await invoke(
        async (adapter) =>
          await adapter.listMentionsForHandle(workspaceId, handle, options),
      ),
    setReaction: async (input) =>
      await invoke(
        async (adapter) =>
          await adapter.setReaction({
            ...input,
            author: {
              authorId: input.author.authorId,
              kind: input.author.kind,
              displayName: input.author.displayName,
            },
          }),
      ),
    listReactions: async (input) =>
      await invoke(async (adapter) => await adapter.listReactions(input)),
    setFollow: async (input) =>
      await invoke(async (adapter) => await adapter.setFollow(input)),
    listFollows: async (input) =>
      await invoke(async (adapter) => await adapter.listFollows(input)),
    ensureDefaultChannelFollows: async (input) =>
      await invoke(
        async (adapter) =>
          await adapter.ensureDefaultChannelFollows(input),
      ),
    listPersonalFeed: async (input) =>
      (await invoke(
        async (adapter) => await adapter.listPersonalFeed(input),
      )) as ChatFeedPage,
    markPersonalFeedSeen: async (input) =>
      await invoke(
        async (adapter) => await adapter.markPersonalFeedSeen(input),
      ),
    saveBookmark: async (input) =>
      await invoke(async (adapter) => await adapter.saveBookmark(input)),
    listBookmarks: async (input) =>
      await invoke(async (adapter) => await adapter.listBookmarks(input)),
    findBookmark: async (input) =>
      await invoke(async (adapter) => await adapter.findBookmark(input)),
    archiveBookmark: async (input) =>
      await invoke(async (adapter) => await adapter.archiveBookmark(input)),
    listPendingBookmarks: async (input) =>
      await invoke(
        async (adapter) => await adapter.listPendingBookmarks(input),
      ),
    markBookmarkPending: async (input) =>
      await invoke(
        async (adapter) => await adapter.markBookmarkPending(input),
      ),
    markBookmarkReady: async (input) =>
      await invoke(async (adapter) => await adapter.markBookmarkReady(input)),
    markBookmarkFailed: async (input) =>
      await invoke(
        async (adapter) => await adapter.markBookmarkFailed(input),
      ),
    markBookmarkStale: async (input) =>
      await invoke(async (adapter) => await adapter.markBookmarkStale(input)),
    applyReplicationOp: async () => {
      throw new ChatsAdapterCapabilityError(
        "Chat replication is owned outside the desktop live chat store.",
      );
    },
    getThreadProjection: async (input) =>
      await invoke(
        async (adapter) => await adapter.getThreadProjection(input),
      ),
    close: async () => {
      await sessions.closeWorkspace(workspace.workspaceId);
    },
  };
}

export function createDesktopLinkedChatStore(
  workspace: EngineWorkspace,
  options: DesktopLinkedChatStoreOptions,
): AwaitableLinkedChatStore {
  if (options.rustEngineEnabled && options.sessions) {
    return createLiveLinkedChatStore(workspace, options.sessions);
  }
  return (options.createLegacyStore ?? createLinkedChatStore)(
    workspace.rootPath,
  );
}
