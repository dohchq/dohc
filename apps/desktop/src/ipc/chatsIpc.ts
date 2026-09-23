import { groupFolderForName } from "@dohc/security-contract";
import {
  ListFileChatsPayload,
  CreateFileChatPayload,
  CreateFileChatResult,
  ListChatMessagesPayload,
  ListChatMessagesResult,
  GetChatThreadRevisionPayload,
  GetChatThreadRevisionResult,
  SendChatMessagePayload,
  SendChatMessageResult,
  ListChatThreadDecisionsPayload,
  ListChatThreadDecisionsResult,
  ResolveChatDecisionPayload,
  ResolveChatDecisionResult,
  ListChatThreadAttachmentsPayload,
  ListChatThreadAttachmentsResult,
  ListChatChannelsPayload,
  ListChatChannelsResult,
  ListChatFollowsPayload,
  ListChatFollowsResult,
  SetChatFollowPayload,
  SetChatFollowResult,
  ListPersonalChatFeedPayload,
  ListPersonalChatFeedResult,
  MarkPersonalChatFeedSeenPayload,
  CreateChatChannelPayload,
  CreateChatChannelResult,
  ListChannelThreadsPayload,
  ListChannelThreadsResult,
  StartChannelThreadPayload,
  StartChannelThreadResult,
  MarkChatThreadReadPayload,
  MarkChatThreadReadResult,
  ListChatReactionsPayload,
  ListChatReactionsResult,
  SetChatReactionPayload,
  SetChatReactionResult,
  ChatThreadRecord,
  ChatMessageRecord,
  ListChatFileMentionsPayload,
  ListChatFileMentionsResult,
  ListChatBookmarksPayload,
  ListChatBookmarksResult,
  SaveChatBookmarkPayload,
  SaveChatBookmarkResult,
  ArchiveChatBookmarkPayload,
  ArchiveChatBookmarkResult,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { listFileChatsForIpc } from "./fileChatsIpc";
import type { RegistryEntry } from "../workspaces/registryStore";
import {
  resolveWorkspaceRelayAuthorId,
  type ChatRelayIdentityTarget,
  type ResolvedChatRelayIdentity,
} from "../workspaces/chatRelayIdentity";
import type { ChatWrites, ChatWriter } from "../workspaces/chatWrites";
import {
  chatViewerAuthorId,
  createChatChannelIpcHandler,
  createMarkChatThreadReadIpcHandler,
  reactionsForViewer,
} from "../mainChatIpcHandlers";
import type {
  ChannelThreadSummary,
  ChatChannelSummary,
  ChatMessage,
  ChatBookmark,
  ChatReaction,
  ChatThread,
} from "@dohc/workspace-contracts/engine";
import type { WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import { resolveChatFileMentionPath } from "../workspaces/chatFileReferenceResolution";
import { chatBookmarkDestination } from "../workspaces/desktopChatBookmarks";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { ChatScope, createChatScopeCapability } from "./chatScope";

// The renderer always writes as the local person, never as an agent.
const RENDERER: ChatWriter = { via: "renderer" };

function chatWritePlace(scope: ChatScope) {
  return { workspaceId: scope.workspace.workspaceId, store: scope.store };
}

function chatAttachmentForIpc(
  attachment: ChatMessage["attachments"][number],
) {
  return {
    attachmentId: attachment.attachmentId,
    threadId: attachment.threadId,
    messageId: attachment.messageId,
    targetKind: attachment.targetKind,
    ...(attachment.objectId ? { objectId: attachment.objectId } : {}),
    ...(attachment.pathHint ? { pathHint: attachment.pathHint } : {}),
    ...(attachment.headingText ? { headingText: attachment.headingText } : {}),
    ...(attachment.headingAnchor ? { headingAnchor: attachment.headingAnchor } : {}),
    ...(attachment.headingOccurrence !== undefined
      ? { headingOccurrence: attachment.headingOccurrence }
      : {}),
    createdAtMs: attachment.createdAtMs,
  };
}

export function chatMessageForIpc(message: ChatMessage): ChatMessageRecord {
  return {
    id: message.id,
    threadId: message.threadId,
    authorKind: message.author.kind,
    authorDisplayName: message.author.displayName,
    ...(message.authorOwnerDisplayName ? { authorOwnerDisplayName: message.authorOwnerDisplayName } : {}),
    ...(message.authorUserId ? { authorUserId: message.authorUserId } : {}),
    ...(message.parentMessageId
      ? { parentMessageId: message.parentMessageId }
      : {}),
    ...(message.origin ? { origin: message.origin } : {}),
    body: message.body,
    createdAtMs: message.createdAtMs,
    attachments: message.attachments.map(chatAttachmentForIpc),
  };
}

export function registerChatsIpcHandlers<
  Sender,
  Event extends { sender: Sender },
  Operation extends { workspace: RegistryEntry; assertCurrent(): void },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  chatScope: ReturnType<typeof createChatScopeCapability>;
  requireEngineCapture(
    workspace: string | RegistryEntry, feature: "Chats",
  ): Promise<{ workspace: RegistryEntry; capture: WorkspaceEngineCapture }>;
  linkedChatStoreFor(workspace: RegistryEntry): DesktopLinkedChatStore;
  chatWrites: ChatWrites;
  assertWritableWorkspace(workspace: RegistryEntry): void;
  warmCredentialCache(): Promise<void>;
  localUserId(): string;
  localReactorFallbackId(): string;
  currentCredentials(): CloudCredentials | null;
  chatRelayIdentityFor(
    workspaceId: string, target: ChatRelayIdentityTarget, store: DesktopLinkedChatStore,
  ): Promise<ResolvedChatRelayIdentity>;
  syncWorkspaceSharedChannels(workspaceId: string): Promise<number>;
  syncSharedChannelsForChatTarget(
    workspaceId: string, target: ChatRelayIdentityTarget,
  ): Promise<unknown>;
  syncRendererWorkspaceSharedChannels(operation: Operation): Promise<number>;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, message: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result>;
  activeEngineFileIndex(workspace: EngineWorkspace): Promise<{
    objectIdByPath: Map<string, string>; pathByObjectId: Map<string, string>;
  }>;
  activity: { queueCloudSync(workspaceId: string): void };
  desktopChatBookmarks: {
    materializeChatBookmark(
      workspace: RegistryEntry, capture: WorkspaceEngineCapture, bookmark: ChatBookmark,
    ): Promise<ChatBookmark>;
    archiveChatBookmark(
      workspace: RegistryEntry, capture: WorkspaceEngineCapture,
      ownerUserId: string, bookmarkId: string,
    ): Promise<ChatBookmark>;
  };
  notifyRenderer(input: { workspaceId: string }): void;
  // A group is a folder. Main creates it when the group is created.
  ensureGroupFolder(workspace: RegistryEntry, folderPath: string): Promise<void>;
}) {
  const {
    registerHandler, assertTrustedSender, requireEngineCapture, linkedChatStoreFor, chatWrites,
    assertWritableWorkspace, warmCredentialCache, localUserId, localReactorFallbackId,
    currentCredentials, chatRelayIdentityFor, syncWorkspaceSharedChannels,
    syncSharedChannelsForChatTarget, syncRendererWorkspaceSharedChannels,
    withRendererWorkspaceOperation, activeEngineFileIndex, activity, desktopChatBookmarks,
    notifyRenderer, ensureGroupFolder,
  } = dependencies;
  const { requireChatScope, chatFileObjectId, resolveChatFileReferences } = dependencies.chatScope;
  const { materializeChatBookmark } = desktopChatBookmarks;
  function chatThreadForIpc(thread: ChatThread): ChatThreadRecord {
    return {
      id: thread.id,
      title: thread.title,
      createdAtMs: thread.createdAtMs,
      updatedAtMs: thread.updatedAtMs,
    };
  }

  function chatBookmarkForIpc(bookmark: ChatBookmark) {
    return {
      bookmarkId: bookmark.bookmarkId,
      targetKind: bookmark.targetKind,
      targetId: bookmark.targetId,
      threadId: bookmark.threadId,
      ...(bookmark.messageId ? { messageId: bookmark.messageId } : {}),
      mode: bookmark.mode,
      destinationPath: bookmark.destinationPath,
      state: bookmark.state,
      projectionState: bookmark.projectionState,
      generation: bookmark.generation,
      createdAtMs: bookmark.createdAtMs,
      updatedAtMs: bookmark.updatedAtMs,
    };
  }

  registerHandler(CHANNELS.listFileChats, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListFileChatsPayload.parse(payload);
    // Reachable from a share view at every level. The file it names
    // is one the share already served, and an out-of-selector thread was
    // never served by the relay nor applied by the engine boundary — there is
    // no superset here to filter.
    return listFileChatsForIpc(async () => {
      const scope = await requireChatScope(input.workspaceId);
      const { workspace, store } = scope;
      const fileObjectId = await chatFileObjectId(scope, input.path);
      const threads = fileObjectId
        ? await store.listThreadsForFile({
            workspaceId: workspace.workspaceId,
            objectId: fileObjectId,
          })
        : [];
      return {
        fileObjectId,
        threads: threads.map(chatThreadForIpc),
      };
    });
  });

  registerHandler(CHANNELS.listChatFileMentions, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatFileMentionsPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    const rowsUncovered = await syncWorkspaceSharedChannels(
      workspace.workspaceId,
    );
    const objectId = await capture.fileObjectIdForPath(input.path);
    const store = linkedChatStoreFor(workspace);
    const mentions = await store.listFileMentions({
      workspaceId: workspace.workspaceId,
      ...(objectId ? { objectId } : { pathHint: input.path }),
    });
    const activeFiles = await activeEngineFileIndex(workspace);
    const mentionChannelWireIds = new Map(
      await Promise.all(
        [
          ...new Set(
            mentions.flatMap((mention) =>
              mention.channel ? [mention.channel.id] : [],
            ),
          ),
        ].map(
          async (channelId) =>
            [
              channelId,
              await store.getChannelWireId({
                workspaceId: workspace.workspaceId,
                channelId,
              }),
            ] as const,
        ),
      ),
    );
    return ListChatFileMentionsResult.parse({
      ...(rowsUncovered > 0
        ? { sharedChannelRowsUncovered: rowsUncovered }
        : {}),
      mentions: mentions.flatMap((mention) => {
        const currentPath = resolveChatFileMentionPath({
          requestedObjectId: objectId,
          ...(mention.attachment.objectId
            ? { attachmentObjectId: mention.attachment.objectId }
            : {}),
          ...(mention.attachment.pathHint
            ? { attachmentPathHint: mention.attachment.pathHint }
            : {}),
          pathByObjectId: activeFiles.pathByObjectId,
        });
        if (!currentPath) return [];
        return [
          {
            attachment: chatAttachmentForIpc({
              ...mention.attachment,
              pathHint: currentPath,
            }),
            message: chatMessageForIpc(mention.message),
            thread: chatThreadForIpc(mention.thread),
            ...(mention.channel
              ? {
                  channelId: mention.channel.id,
                  ...(mentionChannelWireIds.get(mention.channel.id)
                    ? {
                        channelWireId: mentionChannelWireIds.get(
                          mention.channel.id,
                        )!,
                      }
                    : {}),
                  channelName: mention.channel.name,
                  channelSlug: mention.channel.slug,
                  channelKind: mention.channel.kind,
                }
              : {}),
          },
        ];
      }),
    });
  });

  registerHandler(CHANNELS.listChatBookmarks, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatBookmarksPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    await warmCredentialCache();
    const bookmarks = await linkedChatStoreFor(workspace).listBookmarks({
      workspaceId: workspace.workspaceId,
      ownerUserId: localUserId(),
    });
    return ListChatBookmarksResult.parse({
      bookmarks: bookmarks.map(chatBookmarkForIpc),
    });
  });

  registerHandler(CHANNELS.saveChatBookmark, async (event, payload) => {
    assertTrustedSender(event);
    const input = SaveChatBookmarkPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    assertWritableWorkspace(workspace);
    await warmCredentialCache();
    const store = linkedChatStoreFor(workspace);
    const threads = await store.listThreads({
      workspaceId: workspace.workspaceId,
    });
    const thread = threads.find((entry) => entry.id === input.target.threadId);
    if (!thread) throw new Error("That chat is no longer available.");
    if (input.target.kind === "message") {
      const messageId = input.target.messageId;
      const messages = await store.listMessages({
        workspaceId: workspace.workspaceId,
        threadId: input.target.threadId,
      });
      if (!messages.some((message) => message.id === messageId)) {
        throw new Error("That message is no longer available.");
      }
    }
    const targetId =
      input.target.kind === "message"
        ? input.target.messageId
        : input.target.threadId;
    const saved = await store.saveBookmark({
      workspaceId: workspace.workspaceId,
      ownerUserId: localUserId(),
      targetKind: input.target.kind,
      targetId,
      mode: input.mode,
      destinationPath: chatBookmarkDestination(thread.title, targetId),
    });
    const bookmark = await materializeChatBookmark(workspace, capture, saved);
    notifyRenderer({ workspaceId: workspace.workspaceId });
    return SaveChatBookmarkResult.parse({
      bookmark: chatBookmarkForIpc(bookmark),
    });
  });

  registerHandler(CHANNELS.archiveChatBookmark, async (event, payload) => {
    assertTrustedSender(event);
    const input = ArchiveChatBookmarkPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    assertWritableWorkspace(workspace);
    await warmCredentialCache();
    const ownerUserId = localUserId();
    const projected = await desktopChatBookmarks.archiveChatBookmark(
      workspace, capture, ownerUserId, input.bookmarkId,
    );
    notifyRenderer({ workspaceId: workspace.workspaceId });
    return ArchiveChatBookmarkResult.parse({
      bookmark: chatBookmarkForIpc(projected),
    });
  });

  registerHandler(CHANNELS.createFileChat, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateFileChatPayload.parse(payload);
    // Reads are reachable from every received share. This mutation resolves
    // the same scope, then chatWrites refuses it before persistence.
    const scope = await requireChatScope(input.workspaceId);
    const thread = await chatWrites.createFileThread(chatWritePlace(scope), {
      title: input.title,
      linkedFile: async () => {
        const objectId = await chatFileObjectId(scope, input.path);
        if (!objectId) {
          throw new Error(
            "Chats aren't available for this file yet — only text files dohc tracks can have Chats.",
          );
        }
        return { objectId, pathHint: input.path };
      },
    });
    return CreateFileChatResult.parse({ thread: chatThreadForIpc(thread) });
  });

  registerHandler(CHANNELS.listChatMessages, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatMessagesPayload.parse(payload);
    // Reachable from a share view at every level, for a thread on
    // a file the share already served.
    const { workspace, store } = await requireChatScope(input.workspaceId);
    const messages = await store.listMessages({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
    });
    return ListChatMessagesResult.parse({
      messages: messages.map(chatMessageForIpc),
    });
  });

  registerHandler(CHANNELS.getChatThreadRevision, async (event, payload) => {
    assertTrustedSender(event);
    const input = GetChatThreadRevisionPayload.parse(payload);
    const { workspace, store } = await requireChatScope(input.workspaceId);
    const revision = await store.getThreadRevision({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
    });
    return GetChatThreadRevisionResult.parse({ revision });
  });

  registerHandler(CHANNELS.sendChatMessage, async (event, payload) => {
    assertTrustedSender(event);
    const input = SendChatMessagePayload.parse(payload);
    // A share view resolves a scope instead of a capture so reads still work.
    // chatWrites refuses every received share before persistence.
    const scope = await requireChatScope(input.workspaceId);
    const message = await chatWrites.sendMessage(chatWritePlace(scope), {
      writer: RENDERER,
      threadId: input.threadId,
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
      body: input.body,
      resolveAttachments: () =>
        resolveChatFileReferences(
          scope.workspace,
          (path) => chatFileObjectId(scope, path),
          input.fileReferences,
        ),
    });
    return SendChatMessageResult.parse({ message: chatMessageForIpc(message) });
  });

  registerHandler(CHANNELS.listChatThreadDecisions, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatThreadDecisionsPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    const decisions = await linkedChatStoreFor(workspace).listThreadDecisions(
      workspace.workspaceId,
      input.threadId,
    );
    return ListChatThreadDecisionsResult.parse({
      decisions: decisions.map((decision) => ({
        threadId: decision.threadId,
        messageId: decision.messageId,
        state: decision.state,
        ...(decision.resolvedByMessageId
          ? { resolvedByMessageId: decision.resolvedByMessageId }
          : {}),
        ...(decision.options && decision.options.length > 0 ? { options: [...decision.options] } : {}),
        ...(decision.chosenOption ? { chosenOption: decision.chosenOption } : {}),
        atMs: decision.atMs,
      })),
    });
  });

  registerHandler(CHANNELS.resolveChatDecision, async (event, payload) => {
    assertTrustedSender(event);
    const input = ResolveChatDecisionPayload.parse(payload);
    // Reads are reachable from a share view; this mutation is not.
    const scope = await requireChatScope(input.workspaceId);
    const decision = await chatWrites.resolveDecision(chatWritePlace(scope), {
      threadId: input.threadId,
      messageId: input.messageId,
      resolvedByMessageId: input.resolvedByMessageId,
      ...(input.chosenOption !== undefined ? { chosenOption: input.chosenOption } : {}),
    });
    return ResolveChatDecisionResult.parse({
      decision: {
        threadId: decision.threadId,
        messageId: decision.messageId,
        state: decision.state,
        ...(decision.resolvedByMessageId
          ? { resolvedByMessageId: decision.resolvedByMessageId }
          : {}),
        ...(decision.options && decision.options.length > 0 ? { options: [...decision.options] } : {}),
        ...(decision.chosenOption ? { chosenOption: decision.chosenOption } : {}),
        atMs: decision.atMs,
      },
    });
  });

  registerHandler(CHANNELS.listChatThreadAttachments, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatThreadAttachmentsPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    const attachments = await linkedChatStoreFor(workspace).listThreadAttachments(
      workspace.workspaceId,
      input.threadId,
    );
    return ListChatThreadAttachmentsResult.parse({ attachments });
  });

  // --- Chats channels (PR 12/13, WS-E) -------------------------------------
  // Workspace-wide Chats organized in channels, same gate as the file rail.
  // Unread counts and read cursors are store-derived; the renderer never
  // supplies identity or read-state revisions of its own.

  function chatChannelForIpc(channel: ChatChannelSummary) {
    return {
      id: channel.id,
      name: channel.name,
      slug: channel.slug,
      kind: channel.kind,
      type: channel.type,
      purpose: channel.purpose,
      ...(channel.folderPath !== undefined ? { folderPath: channel.folderPath } : {}),
      createdAtMs: channel.createdAtMs,
      updatedAtMs: channel.updatedAtMs,
      threadCount: channel.threadCount,
      unreadCount: channel.unreadCount,
    };
  }

  function channelThreadForIpc(
    summary: ChannelThreadSummary,
    reactionViewer?: {
      viewerAuthorId: string;
      localFallbackAuthorId: string;
    },
  ) {
    const openingReactions =
      summary.openingMessage?.reactions.map(chatReactionForIpc) ?? [];
    return {
      ...chatThreadForIpc(summary.thread),
      channelId: summary.thread.channelId ?? "",
      messageCount: summary.messageCount,
      lastReadSequence: summary.lastReadSequence,
      unreadCount: summary.unreadCount,
      openDecisionCount: summary.openDecisionCount,
      openingMessage: summary.openingMessage
        ? {
            id: summary.openingMessage.id,
            authorKind: summary.openingMessage.author.kind,
            authorDisplayName: summary.openingMessage.author.displayName,
            ...(summary.openingMessage.authorOwnerDisplayName ? { authorOwnerDisplayName: summary.openingMessage.authorOwnerDisplayName } : {}),
            ...(summary.openingMessage.authorUserId ? { authorUserId: summary.openingMessage.authorUserId } : {}),
            createdAtMs: summary.openingMessage.createdAtMs,
            bodySnippet: summary.openingMessage.bodySnippet,
            reactions: reactionViewer
              ? reactionsForViewer(openingReactions, reactionViewer)
              : openingReactions,
          }
        : null,
    };
  }

  registerHandler(CHANNELS.listChatChannels, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatChannelsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Chats stopped because this window changed workspaces.",
      async (operation) => {
        const { workspace } = await requireEngineCapture(
          operation.workspace,
          "Chats",
        );
        operation.assertCurrent();
        // MU-C4: refresh joined shared channels before reading, so opening
        // Chats shows other members' latest messages. Offline, local rows
        // still answer.
        const rowsUncovered =
          await syncRendererWorkspaceSharedChannels(operation);
        operation.assertCurrent();
        const store = linkedChatStoreFor(workspace);
        // First chat use auto-creates General.
        await store.ensureGeneralChannel({
          workspaceId: workspace.workspaceId,
        });
        operation.assertCurrent();
        const channels = await store.listChannels({
          workspaceId: workspace.workspaceId,
        });
        operation.assertCurrent();
        // Wire identities let the renderer match channels against share grants.
        const wireIdEntries = await Promise.all(
          channels.map(async (channel) => [
            channel.id,
            await store
              .getChannelWireId({
                workspaceId: workspace.workspaceId,
                channelId: channel.id,
              })
              .catch(() => null),
          ] as const),
        );
        operation.assertCurrent();
        const wireIds = new Map(wireIdEntries);
        // The "Files" grouping: file-linked Chats with their current path (the
        // stable object id resolved through the active version), falling back
        // to the captured hint when the engine no longer owns the file.
        const threads = await store.listThreads({
          workspaceId: workspace.workspaceId,
        });
        operation.assertCurrent();
        const fileThreads = threads.filter((thread) => thread.linkedFile);
        let pathByObjectId = new Map<string, string>();
        if (fileThreads.length > 0) {
          try {
            ({ pathByObjectId } = await activeEngineFileIndex(workspace));
          } catch {
            // Path resolution is display-only; the hint fallback keeps the
            // listing honest enough.
          }
          operation.assertCurrent();
        }
        return ListChatChannelsResult.parse({
          ...(rowsUncovered > 0
            ? { sharedChannelRowsUncovered: rowsUncovered }
            : {}),
          channels: channels.map((channel) => ({
            ...chatChannelForIpc(channel),
            wireId: wireIds.get(channel.id) ?? null,
          })),
          fileThreads: fileThreads.map((thread) => ({
            ...chatThreadForIpc(thread),
            path:
              (thread.linkedFile
                ? (pathByObjectId.get(thread.linkedFile.objectId) ??
                  thread.linkedFile.pathHint)
                : undefined) ?? null,
          })),
        });
      },
    );
  });

  function chatFollowForIpc(follow: {
    targetKind: "person" | "agent" | "channel" | "thread";
    targetId: string;
    state: "following" | "unfollowed";
    updatedAtMs: number;
  }) {
    return {
      targetKind: follow.targetKind,
      targetId: follow.targetId,
      state: follow.state,
      updatedAtMs: follow.updatedAtMs,
    };
  }

  registerHandler(CHANNELS.listChatFollows, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatFollowsPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    await warmCredentialCache();
    const store = linkedChatStoreFor(workspace);
    const ownerUserId = localUserId();
    await store.ensureDefaultChannelFollows({
      workspaceId: workspace.workspaceId,
      ownerUserId,
    });
    const follows = await store.listFollows({
      workspaceId: workspace.workspaceId,
      ownerUserId,
    });
    return ListChatFollowsResult.parse({ follows: follows.map(chatFollowForIpc) });
  });

  registerHandler(CHANNELS.setChatFollow, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetChatFollowPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    assertWritableWorkspace(workspace);
    await warmCredentialCache();
    const store = linkedChatStoreFor(workspace);
    let targetKind: "person" | "agent" | "channel" | "thread";
    let targetId: string;
    if (input.target.kind === "channel") {
      targetKind = "channel";
      const wireId = await store.getChannelWireId({
        workspaceId: workspace.workspaceId,
        channelId: input.target.channelId,
      });
      if (!wireId) throw new Error("That channel is not available to follow.");
      targetId = wireId;
    } else if (input.target.kind === "thread") {
      targetKind = "thread";
      targetId = input.target.threadId;
    } else {
      const authorTarget = input.target;
      const messages = await store.listMessages({
        workspaceId: workspace.workspaceId,
        threadId: authorTarget.threadId,
      });
      const message = messages.find((entry) => entry.id === authorTarget.messageId);
      if (!message?.authorUserId) {
        throw new Error("That author cannot be followed until their identity is verified.");
      }
      targetKind = message.author.kind === "agent" ? "agent" : "person";
      targetId = message.authorUserId;
    }
    const ownerUserId = localUserId();
    const replicationOwnerUserId = resolveWorkspaceRelayAuthorId(
      workspace,
      currentCredentials(),
    );
    const follow = await store.setFollow({
      workspaceId: workspace.workspaceId,
      ownerUserId,
      ...(replicationOwnerUserId ? { replicationOwnerUserId } : {}),
      targetKind,
      targetId,
      state: input.state,
    });
    if (replicationOwnerUserId) activity.queueCloudSync(workspace.workspaceId);
    notifyRenderer({ workspaceId: workspace.workspaceId });
    return SetChatFollowResult.parse({ follow: chatFollowForIpc(follow) });
  });

  registerHandler(CHANNELS.listPersonalChatFeed, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListPersonalChatFeedPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    await warmCredentialCache();
    const rowsUncovered = await syncWorkspaceSharedChannels(workspace.workspaceId);
    const store = linkedChatStoreFor(workspace);
    const ownerUserId = localUserId();
    await store.ensureDefaultChannelFollows({
      workspaceId: workspace.workspaceId,
      ownerUserId,
    });
    const page = await store.listPersonalFeed({
      workspaceId: workspace.workspaceId,
      ownerUserId,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });
    const feedChannelWireIds = new Map(
      await Promise.all(
        [...new Set(page.items.flatMap((item) => item.channel ? [item.channel.id] : []))]
          .map(async (channelId) => [
            channelId,
            await store.getChannelWireId({
              workspaceId: workspace.workspaceId,
              channelId,
            }),
          ] as const),
      ),
    );
    // The viewer, per thread: a joined shared channel writes under the
    // grant's account, the workspace's own threads under the owner. Each
    // item carries its thread's viewer and its reactions normalized to it,
    // as listChatReactions does, so a Like made before sign-in still reads
    // as the viewer's.
    const localFallbackAuthorId = localReactorFallbackId();
    const viewerByThread = new Map(
      await Promise.all(
        [...new Set(page.items.map((item) => item.thread.id))].map(async (threadId) => [
          threadId,
          await chatViewerAuthorId({
            localFallbackAuthorId,
            resolveReplicationAuthorId: async () =>
              (await chatRelayIdentityFor(workspace.workspaceId, { threadId }, store))
                .authorUserId,
          }).catch(() => localFallbackAuthorId),
        ] as const),
      ),
    );
    return ListPersonalChatFeedResult.parse({
      ...(rowsUncovered > 0 ? { sharedChannelRowsUncovered: rowsUncovered } : {}),
      items: page.items.map((item) => ({
        message: chatMessageForIpc(item.message),
        thread: chatThreadForIpc(item.thread),
        viewerAuthorId: viewerByThread.get(item.thread.id) ?? localFallbackAuthorId,
        ...(item.message.authorUserId
          ? {
              authorFollowTarget: {
                targetKind:
                  item.message.author.kind === "agent" ? ("agent" as const) : ("person" as const),
                targetId: item.message.authorUserId,
              },
            }
          : {}),
        ...(item.channel
          ? {
              channel: {
                id: item.channel.id,
                ...(feedChannelWireIds.get(item.channel.id)
                  ? { wireId: feedChannelWireIds.get(item.channel.id)! }
                  : {}),
                name: item.channel.name,
                slug: item.channel.slug,
                kind: item.channel.kind,
              },
            }
          : {}),
        ...(item.parentMessage
          ? { parentMessage: chatMessageForIpc(item.parentMessage) }
          : {}),
        ...(item.openingMessage
          ? { openingMessage: chatMessageForIpc(item.openingMessage) }
          : {}),
        reactions: reactionsForViewer(item.reactions.map(chatReactionForIpc), {
          viewerAuthorId: viewerByThread.get(item.thread.id) ?? localFallbackAuthorId,
          localFallbackAuthorId,
        }),
        matchedBy: item.matchedBy,
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(page.headCursor ? { headCursor: page.headCursor } : {}),
    });
  });

  registerHandler(CHANNELS.markPersonalChatFeedSeen, async (event, payload) => {
    assertTrustedSender(event);
    const input = MarkPersonalChatFeedSeenPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    await warmCredentialCache();
    const ownerUserId = localUserId();
    const replicationOwnerUserId = resolveWorkspaceRelayAuthorId(
      workspace,
      currentCredentials(),
    );
    await linkedChatStoreFor(workspace).markPersonalFeedSeen({
      workspaceId: workspace.workspaceId,
      ownerUserId,
      ...(replicationOwnerUserId ? { replicationOwnerUserId } : {}),
      headCursor: input.headCursor,
    });
    if (replicationOwnerUserId) activity.queueCloudSync(workspace.workspaceId);
  });

  registerHandler(
    CHANNELS.createChatChannel,
    createChatChannelIpcHandler({
      assertTrustedSender,
      parsePayload: (payload) => CreateChatChannelPayload.parse(payload),
      requireContext: (workspaceId) =>
        requireEngineCapture(workspaceId, "Chats"),
      assertWritable: ({ workspace }) => assertWritableWorkspace(workspace),
      run: async ({ workspace }, input) => {
        // A group is a folder: the folder is the group's slug unless the
        // creator named one. Main creates it so the group's files have a
        // home before the first post.
        const folderPath = input.folderPath ?? groupFolderForName(input.name);
        if (!folderPath) {
          throw new Error("Give the group a name with a letter or a number, or name its folder.");
        }
        await ensureGroupFolder(workspace, folderPath);
        const channel = await linkedChatStoreFor(workspace).createChannel({
          workspaceId: workspace.workspaceId,
          name: input.name,
          kind: "channel",
          ...(input.type ? { type: input.type } : {}),
          ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
          ...(folderPath ? { folderPath } : {}),
        });
        return CreateChatChannelResult.parse({
          // A locally created channel's wire identity is its own id.
          channel: {
            ...chatChannelForIpc({ ...channel, threadCount: 0, unreadCount: 0 }),
            wireId: channel.id,
          },
        });
      },
      queueCloudSync: (workspaceId) => activity.queueCloudSync(workspaceId),
    }),
  );

  registerHandler(CHANNELS.listChannelThreads, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChannelThreadsPayload.parse(payload);
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    const localFallbackAuthorId = localReactorFallbackId();
    const store = linkedChatStoreFor(workspace);
    const viewerAuthorId = await chatViewerAuthorId({
      localFallbackAuthorId,
      resolveReplicationAuthorId: async () =>
        (
          await chatRelayIdentityFor(workspace.workspaceId, {
            channelId: input.channelId,
          }, store)
        ).authorUserId,
    });
    // MU-C4: refresh before reading, the way listChatChannels does. A channel
    // view has no poll of its own, and the pass is bounded, so an untargeted
    // sync could leave the channel the user just opened waiting for the
    // rotation. Naming it puts it in this pass.
    await syncSharedChannelsForChatTarget(workspace.workspaceId, {
      channelId: input.channelId,
    });
    const threads = await store.listChannelThreads({
      workspaceId: workspace.workspaceId,
      channelId: input.channelId,
      ...(input.lane ? { lane: input.lane } : {}),
    });
    return ListChannelThreadsResult.parse({
      threads: threads.map((thread) =>
        channelThreadForIpc(thread, {
          viewerAuthorId,
          localFallbackAuthorId,
        }),
      ),
      viewerAuthorId,
    });
  });

  registerHandler(CHANNELS.startChannelThread, async (event, payload) => {
    assertTrustedSender(event);
    const input = StartChannelThreadPayload.parse(payload);
    const { workspace, capture } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    // No title, ever, on this path: the thread displays its first-message
    // snippet.
    const started = await chatWrites.startThread({
      workspaceId: workspace.workspaceId,
      store: linkedChatStoreFor(workspace),
    }, {
      writer: RENDERER,
      channelId: input.channelId,
      ...(input.lane ? { lane: input.lane } : {}),
      body: input.body,
      resolveAttachments: () =>
        resolveChatFileReferences(workspace, capture.fileObjectIdForPath, input.fileReferences),
    });
    return StartChannelThreadResult.parse({
      thread: channelThreadForIpc({
        thread: started.thread,
        messageCount: 1,
        lastReadSequence: 1,
        unreadCount: 0,
        openDecisionCount: 0,
      }),
      message: chatMessageForIpc(started.message),
      viewerAuthorId:
        started.message.authorUserId ?? localReactorFallbackId(),
    });
  });

  registerHandler(
    CHANNELS.markChatThreadRead,
    createMarkChatThreadReadIpcHandler({
      assertTrustedSender,
      parsePayload: (payload) => MarkChatThreadReadPayload.parse(payload),
      // Reachable from a share view at every level, view included.
      requireContext: requireChatScope,
      run: async ({ workspace, store }, input) => {
        const state = await store.markThreadRead({
          workspaceId: workspace.workspaceId,
          threadId: input.threadId,
          upToSequence: input.upToSequence,
        });
        return MarkChatThreadReadResult.parse({
          lastReadSequence: state.lastReadSequence,
          revision: state.revision,
        });
      },
    }),
  );

  // --- Reactions (WS-MU-C2) ------------------------------------------------
  // Durable, commutative emoji reactions. Identity is main-derived: the viewer
  // reacts as the local user (never renderer-supplied), so a reaction is an
  // authored act attributable and, once syncing, relay-verifiable.
  function chatReactionForIpc(reaction: ChatReaction) {
    return {
      reactionId: reaction.reactionId,
      messageId: reaction.messageId,
      threadId: reaction.threadId,
      emoji: reaction.emoji,
      authorId: reaction.author.authorId,
      authorKind: reaction.author.kind,
      authorDisplayName: reaction.author.displayName,
    };
  }

  registerHandler(CHANNELS.listChatReactions, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListChatReactionsPayload.parse(payload);
    // Reachable from a share view at every level. The panel loads
    // messages and reactions together, so a capture gate here refuses the
    // whole thread open, not just its reactions.
    const { workspace, store } = await requireChatScope(input.workspaceId);
    const viewerAuthorId = await chatViewerAuthorId({
      localFallbackAuthorId: localReactorFallbackId(),
      resolveReplicationAuthorId: async () =>
        (
          await chatRelayIdentityFor(workspace.workspaceId, {
            threadId: input.threadId,
          }, store)
        ).authorUserId,
    });
    const reactions = await store.listReactions({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
    });
    return ListChatReactionsResult.parse({
      reactions: reactionsForViewer(reactions.map(chatReactionForIpc), {
        viewerAuthorId,
        localFallbackAuthorId: localReactorFallbackId(),
      }),
      viewerAuthorId,
    });
  });

  registerHandler(CHANNELS.setChatReaction, async (event, payload) => {
    assertTrustedSender(event);
    const input = SetChatReactionPayload.parse(payload);
    // Reads are reachable from a share view; this mutation is not.
    const scope = await requireChatScope(input.workspaceId);
    const reaction = await chatWrites.setReaction(chatWritePlace(scope), {
      writer: RENDERER,
      threadId: input.threadId,
      messageId: input.messageId,
      emoji: input.emoji,
      state: input.state,
    });
    return SetChatReactionResult.parse({
      reaction: { ...chatReactionForIpc(reaction), state: reaction.state },
      viewerAuthorId: reaction.author.authorId,
    });
  });

}
