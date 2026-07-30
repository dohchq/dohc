import {
  ChatsAdapterCapabilityError,
  ChatsLiveAdapter,
  type ChatChannel as LiveChatChannel,
  type ChatChannelSummary as LiveChatChannelSummary,
  type ChatFileMention as LiveChatFileMention,
} from "@dohc/workspace-engine-client";
import {
  type ChatChannel,
  type ChatChannelSummary,
  type ChatFeedPage,
  type ChatFileMention,
} from "@dohc/workspace-engine";
import type {
  EngineWorkspace,
  EngineWorkspaceRunOptions,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import type { AwaitableLinkedChatStore } from "./awaitableLinkedChatStore";

const PATH_HINT_ENRICHMENT_CONCURRENCY = 8;

export interface DesktopLinkedChatStore extends AwaitableLinkedChatStore {
  ensureOpen(): Promise<void>;
}

export interface DesktopLinkedChatStoreOptions {
  sessions: EngineWorkspaceSessions;
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

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= values.length) return;
          results[index] = await operation(values[index]!);
        }
      },
    ),
  );
  return results;
}

export function createLiveLinkedChatStore(
  workspace: EngineWorkspace,
  sessions: EngineWorkspaceSessions,
): DesktopLinkedChatStore {
  const invoke = async <T>(
    operation: (adapter: ChatsLiveAdapter) => Promise<T>,
    options?: EngineWorkspaceRunOptions,
  ): Promise<T> =>
    await sessions.run(
      workspace,
      async ({ client, workspace: handle }) => {
        const adapter = new ChatsLiveAdapter(client, handle, {
          workspaceId: workspace.workspaceId,
        });
        return await operation(adapter);
      },
      options,
    );
  const invokeRead = async <T>(
    operation: (adapter: ChatsLiveAdapter) => Promise<T>,
  ): Promise<T> =>
    await invoke(operation, {
      retryTransportErrors: true,
    });

  return {
    ensureOpen: async () => {
      await sessions.run(
        workspace,
        async () => undefined,
        { retryTransportErrors: true },
      );
    },
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
        await invokeRead(async (adapter) => await adapter.listChannels(input))
      ).map(toStoreChannelSummary),
    findChannelBySlug: async (input) => {
      const channel = await invokeRead(
        async (adapter) => await adapter.findChannelBySlug(input),
      );
      return channel ? toStoreChannel(channel) : null;
    },
    getChannelWireId: async (input) =>
      await invokeRead(
        async (adapter) => await adapter.getChannelWireId(input),
      ),
    findThreadChannelId: async (input) =>
      await invokeRead(
        async (adapter) => await adapter.findThreadChannelId(input),
      ),
    startChannelThread: async (input) =>
      await invoke(
        async (adapter) => await adapter.startChannelThread(input),
      ),
    listChannelThreads: async (input) =>
      await invokeRead(
        async (adapter) => await adapter.listChannelThreads(input),
      ),
    markThreadRead: async (input) =>
      await invoke(async (adapter) => await adapter.markThreadRead(input)),
    listThreads: async (input) =>
      await invokeRead(async (adapter) => {
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
          await mapWithConcurrency(
            linkedObjectIds,
            PATH_HINT_ENRICHMENT_CONCURRENCY,
            async (objectId) =>
              await adapter.listThreadsForFile({
                workspaceId: input.workspaceId,
                objectId,
              }),
          )
        ).flat();
        const richerById = new Map(
          richerThreads.map((thread) => [thread.id, thread]),
        );
        return threads.map((thread) => richerById.get(thread.id) ?? thread);
      }),
    listThreadsForFile: async (input) =>
      await invokeRead(
        async (adapter) => await adapter.listThreadsForFile(input),
      ),
    sendMessage: async (input) =>
      await invoke(async (adapter) => await adapter.sendMessage(input)),
    listMessages: async (input) =>
      await invokeRead(async (adapter) => await adapter.listMessages(input)),
    resolveChatDecision: async (input) =>
      await invoke(
        async (adapter) => await adapter.resolveChatDecision(input),
      ),
    listThreadDecisions: async (workspaceId, threadId) =>
      await invokeRead(
        async (adapter) =>
          await adapter.listThreadDecisions(workspaceId, threadId),
      ),
    listThreadAttachments: async (workspaceId, threadId) =>
      await invokeRead(
        async (adapter) =>
          await adapter.listThreadAttachments(workspaceId, threadId),
      ),
    listFileMentions: async (input) =>
      (
        await invokeRead(
          async (adapter) => await adapter.listFileMentions(input),
        )
      ).map(toStoreFileMention),
    markThreadReadByAgent: async (input) =>
      await invoke(
        async (adapter) => await adapter.markThreadReadByAgent(input),
      ),
    listAgentUnreadThreads: async (workspaceId) =>
      await invokeRead(
        async (adapter) =>
          await adapter.listAgentUnreadThreads(workspaceId),
      ),
    listMentionsForHandle: async (workspaceId, handle, options) =>
      await invokeRead(
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
      await invokeRead(async (adapter) => await adapter.listReactions(input)),
    setFollow: async (input) =>
      await invoke(async (adapter) => await adapter.setFollow(input)),
    listFollows: async (input) =>
      await invokeRead(async (adapter) => await adapter.listFollows(input)),
    ensureDefaultChannelFollows: async (input) =>
      await invoke(
        async (adapter) =>
          await adapter.ensureDefaultChannelFollows(input),
      ),
    listPersonalFeed: async (input) =>
      (await invokeRead(
        async (adapter) => await adapter.listPersonalFeed(input),
      )) as ChatFeedPage,
    markPersonalFeedSeen: async (input) =>
      await invoke(
        async (adapter) => await adapter.markPersonalFeedSeen(input),
      ),
    saveBookmark: async (input) =>
      await invoke(async (adapter) => await adapter.saveBookmark(input)),
    listBookmarks: async (input) =>
      await invokeRead(async (adapter) => await adapter.listBookmarks(input)),
    findBookmark: async (input) =>
      await invokeRead(async (adapter) => await adapter.findBookmark(input)),
    archiveBookmark: async (input) =>
      await invoke(async (adapter) => await adapter.archiveBookmark(input)),
    listPendingBookmarks: async (input) =>
      await invokeRead(
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
      await invokeRead(
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
): DesktopLinkedChatStore {
  return createLiveLinkedChatStore(workspace, options.sessions);
}
