import type { createChatLinksReader } from "../workspaces/chatLinks";
import { agentColorsForPresentation } from "../settings/userSettingsStore";
import { chatOperations } from "./chatOperations";
import { isReceivedObject } from "@dohc/workspace-contracts/workspace-ref";
import { workspaceFileRefs } from "../workspaces/workspaceFileReferenceScopes";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { createActorPresentationRequest } from "../workspaces/actorPresentation";
import type { ActorPresentation, ChatDecisionRecord } from "./bridgeContract";
import { type EngineFileResolver } from "../workspaces/resolveEngineFiles";
import { nameSlug } from "@dohc/workspace-contracts/names";
import {
  CreateFileChatResult,
  ListChatMessagesResult,
  GetChatThreadRevisionResult,
  SendChatMessageResult,
  ListChatThreadDecisionsResult,
  ListChatThreadAttachmentsResult,
  ListChatChannelsResult,
  ListChatFollowsResult,
  SetChatFollowResult,
  ListPersonalChatFeedResult,
  CreateChatChannelResult,
  ListChannelThreadsResult,
  StartChannelThreadResult,
  MarkChatThreadReadResult,
  ListChatReactionsResult,
  SetChatReactionResult,
  ChatThreadRecord,
  ChatMessageRecord,
  ListChatBookmarksResult,
  SaveChatBookmarkResult,
  ArchiveChatBookmarkResult,
} from "./bridgeContract";
import { registerOperations, type OperationHandlers } from "./operationTable";
import { ipcWireError } from "./errorWords";
import { listFileChatsForIpc } from "./fileChatsIpc";
import type { RegistryEntry } from "../workspaces/registryStore";
import {
  resolveWorkspaceRelayAuthorId,
  type ChatRelayIdentityTarget,
  type ResolvedChatRelayIdentity,
} from "../workspaces/chatRelayIdentity";
import type { ChatWrites, PersonWriter } from "../workspaces/chatWrites";
import {
  chatViewerAuthorId,
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
import { createChatFileMentionsReader } from "../workspaces/chatFileMentions";
import { chatBookmarkDestination } from "../workspaces/desktopChatBookmarks";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { ChatScope, createChatScopeCapability } from "./chatScope";

// The renderer always writes as the local person, never as an agent.
const RENDERER: PersonWriter = { via: "renderer" };

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

/** Where the automation with this id keeps its Collection now, or null when this computer has none. */
export type AutomationCollectionOf = (automationId: string) => string | null;

function automationForIpc(automation: NonNullable<ChatMessage["automation"]>, collectionOf: AutomationCollectionOf) {
  return { automationId: automation.automationId, collectionPath: collectionOf(automation.automationId) };
}

export function chatMessageForIpc(message: ChatMessage, collectionOf: AutomationCollectionOf, presentation: ActorPresentation): ChatMessageRecord {
  return {
    presentation,
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
    ...(message.automation ? { automation: automationForIpc(message.automation, collectionOf) } : {}),
    attachments: message.attachments.map(chatAttachmentForIpc),
  };
}

type StoreDecision = Awaited<ReturnType<DesktopLinkedChatStore["listThreadDecisions"]>>[number];

function chatDecisionForIpc(decision: StoreDecision): ChatDecisionRecord {
  return {
    threadId: decision.threadId,
    messageId: decision.messageId,
    state: decision.state,
    ...(decision.resolvedByMessageId
      ? { resolvedByMessageId: decision.resolvedByMessageId }
      : {}),
    ...(decision.options && decision.options.length > 0 ? { options: [...decision.options] } : {}),
    ...(decision.chosenOption ? { chosenOption: decision.chosenOption } : {}),
    atMs: decision.atMs,
  };
}

// The question or poll a write asked, read back from the engine, which
// normalizes its choices, so the renderer adds it with the message. A failed
// read leaves it out instead of failing a send that already landed; the
// thread's next refresh shows it.
async function askedDecision(
  store: Pick<DesktopLinkedChatStore, "listThreadDecisions">,
  workspaceId: string,
  asked: { needsDecision?: boolean; options?: string[] },
  message: ChatMessage,
): Promise<{ decision?: ChatDecisionRecord }> {
  if (!asked.needsDecision && (asked.options?.length ?? 0) === 0) return {};
  const decision = await store.listThreadDecisions(workspaceId, message.threadId).then(
    (decisions) => decisions.find((entry) => entry.messageId === message.id),
    () => undefined,
  );
  return decision ? { decision: chatDecisionForIpc(decision) } : {};
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
  stateDir(): string;
  warmCredentialCache(): Promise<void>;
  localUserId(): string;
  localInstallationId(): string;
  readWorkspace(workspaceId: string): RegistryEntry | null;
  currentCredentials(): CloudCredentials | null;
  currentCredentialGeneration(): number;
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
  chatLinks: ReturnType<typeof createChatLinksReader>;
  resolveEngineFiles: EngineFileResolver<EngineWorkspace>;
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
  /** Where each automation that wrote a message in this workspace keeps its Collection now. */
  automationCollectionOf(workspaceId: string): AutomationCollectionOf;
  // A group is a folder. Main creates it when the group is created.
  ensureGroupFolder(workspace: RegistryEntry, folderPath: string): Promise<void>;
  // Whether the person's message asks an agent that Restricted Mode holds.
  agentWaitsForTrust(workspaceId: string, messageId: string): Promise<boolean>;
}) {
  const {
    registerHandler, assertTrustedSender, requireEngineCapture, linkedChatStoreFor, chatWrites,
    assertWritableWorkspace, warmCredentialCache, localUserId, localInstallationId,
    currentCredentials, chatRelayIdentityFor, syncWorkspaceSharedChannels,
    syncSharedChannelsForChatTarget, syncRendererWorkspaceSharedChannels,
    withRendererWorkspaceOperation, resolveEngineFiles, activity, desktopChatBookmarks,
    notifyRenderer, ensureGroupFolder, automationCollectionOf, agentWaitsForTrust,
  } = dependencies;
  const { requireChatScope, chatFileObjectId, resolveChatFileReferences } = dependencies.chatScope;
  const { materializeChatBookmark } = desktopChatBookmarks;
  const readFileMentions = createChatFileMentionsReader({
    requireChatScope, syncWorkspaceSharedChannels, readWorkspace: dependencies.readWorkspace,
    principalGeneration: dependencies.currentCredentialGeneration,
  });
  type ChatHandler<Name extends keyof typeof chatOperations> = OperationHandlers<typeof chatOperations, Event, Operation>[Name];

  async function presentationRequest(workspace: RegistryEntry, store: DesktopLinkedChatStore, assertCurrent: () => void) {
    await warmCredentialCache();
    assertCurrent();
    const agentColors = await agentColorsForPresentation(dependencies.stateDir());
    assertCurrent();
    return createActorPresentationRequest({ agentColors,
      readWorkspace: () => dependencies.readWorkspace(workspace.workspaceId), store, assertCurrent,
      installationId: localInstallationId(), credentials: currentCredentials(),
    });
  }
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

  const listFileChats: ChatHandler<"listFileChats"> = async (input) => {
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
  };

  const chatFileMentionsPage: ChatHandler<"chatFileMentionsPage"> = async ({ workspaceId, ...input }, { operation }) =>
    readFileMentions(workspaceId, input, operation.assertCurrent);
  const listChatBookmarks: ChatHandler<"listChatBookmarks"> = async (input) => {
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
  };

  const saveChatBookmark: ChatHandler<"saveChatBookmark"> = async (input) => {
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
  };

  const archiveChatBookmark: ChatHandler<"archiveChatBookmark"> = async (input) => {
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
  };

  const createFileChat: ChatHandler<"createFileChat"> = async (input) => {
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
  };

  const listChatMessages: ChatHandler<"listChatMessages"> = async (input, { event, operation }) => {
    // Reachable from a share view at every level, for a thread on
    // a file the share already served.
    const { workspace, store } = await requireChatScope(input.workspaceId);
    const messages = await store.listMessages({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
    });
    const presentation = await presentationRequest(workspace, store, operation.assertCurrent);
    return ListChatMessagesResult.parse({
      messages: await Promise.all(messages.map(async (message) => chatMessageForIpc(message, automationCollectionOf(workspace.workspaceId), await presentation(message, message.threadId)))),
    });
  };
  const getChatThreadRevision: ChatHandler<"getChatThreadRevision"> = async (input) => {
    const { workspace, store } = await requireChatScope(input.workspaceId);
    const revision = await store.getThreadRevision({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
    });
    return GetChatThreadRevisionResult.parse({ revision });
  };

  // The message is saved whatever this answers, so a failed answer is none.
  async function waitsForTrust(workspaceId: string, messageId: string): Promise<{ waitsForTrust?: true }> {
    try {
      return await agentWaitsForTrust(workspaceId, messageId) ? { waitsForTrust: true } : {};
    } catch (error) {
      console.warn("[desktop] could not read whether a message waits for workspace trust", error);
      return {};
    }
  }

  const sendChatMessage: ChatHandler<"sendChatMessage"> = async (input, { event, operation }) => {
    // A share view resolves a scope instead of a capture so reads still work.
    // chatWrites refuses every received share before persistence.
    const scope = await requireChatScope(input.workspaceId);
    const reply = {
      writer: RENDERER,
      threadId: input.threadId,
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
      body: input.body,
      ...(input.needsDecision !== undefined ? { needsDecision: input.needsDecision } : {}),
      ...(input.options !== undefined ? { options: input.options } : {}),
      resolveAttachments: () =>
        resolveChatFileReferences(
          scope.workspace,
          (path) => chatFileObjectId(scope, path),
          input.fileReferences,
        ),
    };
    const sent = input.resolves
      ? await chatWrites.answer(chatWritePlace(scope), { ...reply, resolves: input.resolves })
      : { message: await chatWrites.sendMessage(chatWritePlace(scope), reply) };
    const { message } = sent;
    const presentation = await presentationRequest(scope.workspace, scope.store, operation.assertCurrent);
    return SendChatMessageResult.parse({
      message: chatMessageForIpc(message, automationCollectionOf(scope.workspace.workspaceId), await presentation(message, message.threadId)),
      ...await askedDecision(scope.store, scope.workspace.workspaceId, input, message),
      ...("decision" in sent ? { resolved: chatDecisionForIpc(sent.decision) } : {}),
      ...("failure" in sent ? { resolveFailure: String(ipcWireError(sent.failure)) } : {}),
      ...await waitsForTrust(scope.workspace.workspaceId, message.id),
    });
  };
  const listChatThreadDecisions: ChatHandler<"listChatThreadDecisions"> = async (input) => {
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    const decisions = await linkedChatStoreFor(workspace).listThreadDecisions(
      workspace.workspaceId,
      input.threadId,
    );
    return ListChatThreadDecisionsResult.parse({ decisions: decisions.map(chatDecisionForIpc) });
  };

  const listChatThreadAttachments: ChatHandler<"listChatThreadAttachments"> = async (input) => {
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    const attachments = await linkedChatStoreFor(workspace).listThreadAttachments(
      workspace.workspaceId,
      input.threadId,
    );
    return ListChatThreadAttachmentsResult.parse({ attachments });
  };

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
      ...(channel.agentId !== undefined ? { agentId: channel.agentId } : {}),
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
    collectionOf: AutomationCollectionOf,
    reactionViewer: {
      viewerAuthorId: string;
      localFallbackAuthorId: string;
    } | undefined,
    presentation: ActorPresentation | null,
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
            presentation,
            id: summary.openingMessage.id,
            authorKind: summary.openingMessage.author.kind,
            authorDisplayName: summary.openingMessage.author.displayName,
            ...(summary.openingMessage.authorOwnerDisplayName ? { authorOwnerDisplayName: summary.openingMessage.authorOwnerDisplayName } : {}),
            ...(summary.openingMessage.authorUserId ? { authorUserId: summary.openingMessage.authorUserId } : {}),
            createdAtMs: summary.openingMessage.createdAtMs,
            bodySnippet: summary.openingMessage.bodySnippet,
            ...(summary.openingMessage.automation ? { automation: automationForIpc(summary.openingMessage.automation, collectionOf) } : {}),
            reactions: reactionViewer
              ? reactionsForViewer(openingReactions, reactionViewer)
              : openingReactions,
          }
        : null,
    };
  }

  const listChatChannels: ChatHandler<"listChatChannels"> = async (input, { operation }) => {
    const { workspace, store, kind } = await requireChatScope(operation.workspace.workspaceId);
    operation.assertCurrent();
    // MU-C4: refresh joined shared channels before reading, so opening
    // Chats shows other members' latest messages. Offline, local rows
    // still answer.
    const rowsUncovered =
      await syncRendererWorkspaceSharedChannels(operation);
    operation.assertCurrent();
    // First chat use auto-creates General.
    if (kind === "workspace") await store.ensureGeneralChannel({
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
        const ids = [...new Set(fileThreads.map(thread => thread.linkedFile!.objectId))];
        const resolved = await resolveEngineFiles(workspace, ids.flatMap(objectId => workspaceFileRefs(workspace, objectId)));
        pathByObjectId = new Map(resolved.flatMap(file => file.status === "found" ? [[file.objectId, file.path] as const] : []));
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
              (!shareViewIsPresent(workspace.shareView) && !isReceivedObject(thread.linkedFile.objectId) ? thread.linkedFile.pathHint : undefined))
            : undefined) ?? null,
      })),
    });
  };

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

  const listChatFollows: ChatHandler<"listChatFollows"> = async (input) => {
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
  };

  const setChatFollow: ChatHandler<"setChatFollow"> = async (input) => {
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
      if (!wireId) throw new Error("That group is not available to follow.");
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
      if (message.author.kind === "automation") {
        throw new Error("An automation cannot be followed. Follow its Group instead.");
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
  };

  const listPersonalChatFeed: ChatHandler<"listPersonalChatFeed"> = async (input, { event, operation }) => {
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    await warmCredentialCache();
    const rowsUncovered = await syncWorkspaceSharedChannels(workspace.workspaceId);
    const store = linkedChatStoreFor(workspace);
    const presentation = await presentationRequest(workspace, store, operation.assertCurrent);
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
    const localFallbackAuthorId = localInstallationId();
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
      items: await Promise.all(page.items.map(async (item) => ({
        message: chatMessageForIpc(item.message, automationCollectionOf(workspace.workspaceId), await presentation(item.message, item.message.threadId)),
        thread: chatThreadForIpc(item.thread),
        viewerAuthorId: viewerByThread.get(item.thread.id) ?? localFallbackAuthorId,
        // An automation is neither a person nor an agent to follow.
        ...(item.message.authorUserId && item.message.author.kind !== "automation"
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
          ? { parentMessage: chatMessageForIpc(item.parentMessage, automationCollectionOf(workspace.workspaceId), await presentation(item.parentMessage, item.parentMessage.threadId)) }
          : {}),
        ...(item.openingMessage
          ? { openingMessage: chatMessageForIpc(item.openingMessage, automationCollectionOf(workspace.workspaceId), await presentation(item.openingMessage, item.openingMessage.threadId)) }
          : {}),
        reactions: reactionsForViewer(item.reactions.map(chatReactionForIpc), {
          viewerAuthorId: viewerByThread.get(item.thread.id) ?? localFallbackAuthorId,
          localFallbackAuthorId,
        }),
        matchedBy: item.matchedBy,
      }))),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(page.headCursor ? { headCursor: page.headCursor } : {}),
    });
  };
  const markPersonalChatFeedSeen: ChatHandler<"markPersonalChatFeedSeen"> = async (input) => {
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
  };

  // The engine refuses a taken or malformed name by code. The person typed
  // the name, so the toast names the group and what to change.
  const GROUP_CREATE_REFUSALS = new Map<string, string>([
    ["channel-exists", "A group with that name already exists."],
    ["invalid-channel-name", "Use 1 to 80 characters, including at least one letter or number."],
  ]);
  function groupCreateRefusal(error: unknown): unknown {
    const copy = error instanceof Error ? GROUP_CREATE_REFUSALS.get(error.message) : undefined;
    return copy === undefined ? error : new Error(copy);
  }

  const createChatChannel: ChatHandler<"createChatChannel"> = async (input) => {
    const { workspace } = await requireEngineCapture(input.workspaceId, "Chats");
    assertWritableWorkspace(workspace);
    // A group is a folder: the folder is the group's slug unless the
    // creator named one. Main creates it so the group's files have a
    // home before the first post.
    const folderPath = input.folderPath ?? nameSlug(input.name);
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
    }).catch((error: unknown) => {
      throw groupCreateRefusal(error);
    });
    const result = CreateChatChannelResult.parse({
      // A locally created channel's wire identity is its own id.
      channel: {
        ...chatChannelForIpc({ ...channel, threadCount: 0, unreadCount: 0 }),
        wireId: channel.id,
      },
    });
    activity.queueCloudSync(workspace.workspaceId);
    return result;
  };

  const listChannelThreads: ChatHandler<"listChannelThreads"> = async (input, { event, operation }) => {
    const { workspace } = await requireEngineCapture(
      input.workspaceId,
      "Chats",
    );
    const localFallbackAuthorId = localInstallationId();
    const store = linkedChatStoreFor(workspace);
    const presentation = await presentationRequest(workspace, store, operation.assertCurrent);
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
      threads: await Promise.all(threads.map(async (thread) =>
        channelThreadForIpc(thread, automationCollectionOf(workspace.workspaceId), {
          viewerAuthorId,
          localFallbackAuthorId,
        }, thread.openingMessage ? await presentation(thread.openingMessage, thread.thread.id) : null),
      )),
      viewerAuthorId,
    });
  };
  const startChannelThread: ChatHandler<"startChannelThread"> = async (input, { event, operation }) => {
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
      ...(input.needsDecision !== undefined ? { needsDecision: input.needsDecision } : {}),
      ...(input.options !== undefined ? { options: input.options } : {}),
      resolveAttachments: () =>
        resolveChatFileReferences(workspace, capture.fileObjectIdForPath, input.fileReferences),
    });
    const presentation = await presentationRequest(workspace, linkedChatStoreFor(workspace), operation.assertCurrent);
    return StartChannelThreadResult.parse({
      thread: channelThreadForIpc({
        thread: started.thread,
        messageCount: 1,
        lastReadSequence: 1,
        unreadCount: 0,
        openDecisionCount: input.needsDecision || (input.options?.length ?? 0) > 0 ? 1 : 0,
      }, automationCollectionOf(workspace.workspaceId), undefined, null),
      message: chatMessageForIpc(started.message, automationCollectionOf(workspace.workspaceId), await presentation(started.message, started.message.threadId)),
      viewerAuthorId:
        started.message.authorUserId ?? localInstallationId(),
      ...await askedDecision(linkedChatStoreFor(workspace), workspace.workspaceId, input, started.message),
      ...await waitsForTrust(workspace.workspaceId, started.message.id),
    });
  };
  const markChatThreadRead: ChatHandler<"markChatThreadRead"> = async (input) => {
    // Read state belongs to this reader, including in a read-only share view.
    const { workspace, store } = await requireChatScope(input.workspaceId);
    const state = await store.markThreadRead({
      workspaceId: workspace.workspaceId,
      threadId: input.threadId,
      upToSequence: input.upToSequence,
    });
    return MarkChatThreadReadResult.parse({
      lastReadSequence: state.lastReadSequence,
      revision: state.revision,
    });
  };

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

  const listChatReactions: ChatHandler<"listChatReactions"> = async (input) => {
    // Reachable from a share view at every level. The panel loads
    // messages and reactions together, so a capture gate here refuses the
    // whole thread open, not just its reactions.
    const { workspace, store } = await requireChatScope(input.workspaceId);
    const viewerAuthorId = await chatViewerAuthorId({
      localFallbackAuthorId: localInstallationId(),
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
        localFallbackAuthorId: localInstallationId(),
      }),
      viewerAuthorId,
    });
  };

  const setChatReaction: ChatHandler<"setChatReaction"> = async (input) => {
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
  };

  registerOperations<typeof chatOperations, Event, Operation>({
    handle: registerHandler,
    assertTrustedSender,
    withActiveWorkspace: (event, workspaceId, inactiveMessage, work) =>
      withRendererWorkspaceOperation(event.sender, workspaceId, inactiveMessage, work),
  }, chatOperations, {
    listFileChats,
    listChatBookmarks,
    saveChatBookmark,
    archiveChatBookmark,
    createFileChat,
    getChatThreadRevision,
    listChatThreadDecisions,
    listChatThreadAttachments,
    listChatChannels,
    listChatFollows,
    setChatFollow,
    markPersonalChatFeedSeen,
    createChatChannel,
    markChatThreadRead,
    listChatReactions,
    setChatReaction,
    chatLinks: ({workspaceId,...input}, {operation}) => dependencies.chatLinks(workspaceId,input,operation.assertCurrent),
    chatFileMentionsPage,
    listChatMessages,
    sendChatMessage,
    listPersonalChatFeed,
    listChannelThreads,
    startChannelThread,
  });

}
