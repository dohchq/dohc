import { randomUUID } from "node:crypto";
import {
  WorkspaceDaemonRequester,
  type MinimalDaemonClient,
} from "../live/daemonLiveAdapter";
import type { WorkspaceHandle } from "../ydoc/generated/WorkspaceHandle";
import {
  CHATS_METHOD,
  decodeChatsResult,
  type ChatActor,
  type ChatAgentReadState,
  type ChatAttachment,
  type ChatBookmark,
  type ChatBookmarkTransition,
  type ChatChannel,
  type ChatChannelSummary,
  type ChatChannelThreadSummary,
  type ChatDecision,
  type ChatDispatch,
  type ChatDispatchClaim,
  type ChatFeedPage,
  type ChatFeedReadState,
  type ChatFileMention,
  type ChatFollow,
  type ChatLocalAttachmentParams,
  type ChatMention,
  type ChatMessage,
  type ChatProjection,
  type ChatProjectionFileAccess,
  type ChatReaction,
  type ChatReactionAuthor,
  type ChatRun,
  type ChatsMethod,
  type ChatsMethodParamsMap,
  type ChatsMethodResultMap,
  type ChatThread,
  type ChatThreadPause,
  type ChatThreadReadState,
  type ChatThreadWireRecord,
} from "./chatsWireContract";
import {
  WORKSPACE_METHOD,
  decodeWorkspaceResult,
} from "../workspace/workspaceWireContract";

export class ChatsAdapterCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatsAdapterCapabilityError";
  }
}

export interface ChatsLiveAdapterOptions {
  workspaceId: string;
  createId?: (
    kind: "channel" | "message" | "run" | "thread",
  ) => string;
}

export class ChatsLiveAdapter {
  readonly workspace: WorkspaceHandle;
  readonly workspaceId: string;
  private readonly requester: WorkspaceDaemonRequester;
  private readonly createId: NonNullable<ChatsLiveAdapterOptions["createId"]>;

  constructor(
    client: MinimalDaemonClient,
    workspace: WorkspaceHandle,
    options: ChatsLiveAdapterOptions,
  ) {
    if (typeof options?.workspaceId !== "string") {
      throw new ChatsAdapterCapabilityError(
        "ChatsLiveAdapter requires a workspaceId binding.",
      );
    }
    this.requester = new WorkspaceDaemonRequester(client);
    this.workspace = workspace;
    this.workspaceId = options.workspaceId;
    this.createId =
      options.createId ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  async request<M extends ChatsMethod>(
    method: M,
    params: ChatsMethodParamsMap[M],
    options?: { idempotencyKey?: string; deadlineMs?: number },
  ): Promise<ChatsMethodResultMap[M]> {
    const raw = await this.requester.request(method, params, {
      workspace: this.workspace,
      ...options,
    });
    return decodeChatsResult(method, raw);
  }

  async createThread(input: {
    workspaceId: string;
    title: string;
    linkedFile: { objectId: string; pathHint?: string };
  }): Promise<ChatThread> {
    this.assertWorkspace(input.workspaceId);
    const threadId = this.createId("thread");
    return this.request(
      CHATS_METHOD.threadCreate,
      { threadId, title: input.title, linkedFile: input.linkedFile },
      { idempotencyKey: threadId },
    );
  }

  async createChannel(input: {
    workspaceId: string;
    name: string;
    kind?: "channel" | "dm" | "agent";
  }): Promise<ChatChannel> {
    this.assertWorkspace(input.workspaceId);
    const channelId = this.createId("channel");
    return this.request(CHATS_METHOD.channelCreate, {
      channelId,
      name: input.name,
      kind: input.kind ?? "channel",
    });
  }

  async ensureGeneralChannel(input: {
    workspaceId: string;
  }): Promise<ChatChannel> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.channelEnsureGeneral, {
      channelId: this.createId("channel"),
    });
  }

  async ensureAgentChannel(input: {
    workspaceId: string;
  }): Promise<ChatChannel> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.channelEnsureAgent, {
      channelId: this.createId("channel"),
    });
  }

  async listChannels(input: {
    workspaceId: string;
  }): Promise<ChatChannelSummary[]> {
    this.assertWorkspace(input.workspaceId);
    return this.collectCursorPages(
      async (cursor) =>
        await this.request(CHATS_METHOD.channelsList, {
          pageLimit: 500,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      (page) => page.channels,
    );
  }

  async findChannelBySlug(input: {
    workspaceId: string;
    slug: string;
  }): Promise<ChatChannel | null> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.channelFindBySlug, { slug: input.slug });
  }

  async getChannelWireId(input: {
    workspaceId: string;
    channelId: string;
  }): Promise<string | null> {
    this.assertWorkspace(input.workspaceId);
    return (
      await this.request(CHATS_METHOD.channelGetWireId, {
        channelId: input.channelId,
      })
    ).wireId;
  }

  async findThreadChannelId(input: {
    workspaceId: string;
    threadId: string;
  }): Promise<string | null> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.threadFindChannelId, {
      threadId: input.threadId,
    });
  }

  async startChannelThread(input: {
    workspaceId: string;
    channelId: string;
    title?: string;
    author: ChatActor;
    authorUserId?: string;
    origin?: "cli";
    body: string;
    needsDecision?: boolean;
    attachments?: ChatLocalAttachmentParams[];
  }): Promise<{ thread: ChatThread; message: ChatMessage }> {
    this.assertWorkspace(input.workspaceId);
    const threadId = this.createId("thread");
    const messageId = this.createId("message");
    return this.request(
      CHATS_METHOD.threadStart,
      {
        channelId: input.channelId,
        threadId,
        messageId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        authorKind: input.author.kind,
        authorDisplayName: input.author.displayName,
        ...(input.authorUserId !== undefined
          ? { authorUserId: input.authorUserId }
          : {}),
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
        body: input.body,
        ...(input.needsDecision !== undefined
          ? { needsDecision: input.needsDecision }
          : {}),
        ...(input.attachments !== undefined
          ? { attachments: input.attachments }
          : {}),
      },
      { idempotencyKey: `${threadId}:${messageId}` },
    );
  }

  async listChannelThreads(input: {
    workspaceId: string;
    channelId: string;
  }): Promise<ChatChannelThreadSummary[]> {
    this.assertWorkspace(input.workspaceId);
    const rows: ChatChannelThreadSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request(CHATS_METHOD.threadsListForChannel, {
        channelId: input.channelId,
        pageLimit: 500,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      rows.push(...page.threads);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
  }

  async markThreadRead(input: {
    workspaceId: string;
    threadId: string;
    upToSequence: number;
    expectedRevision?: number;
  }): Promise<ChatThreadReadState> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.readStateMarkThreadRead, {
      threadId: input.threadId,
      upToSequence: input.upToSequence,
      ...(input.expectedRevision !== undefined
        ? { expectedRevision: input.expectedRevision }
        : {}),
    });
  }

  async getThreadReadState(input: {
    workspaceId: string;
    threadId: string;
  }): Promise<ChatThreadReadState> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.readStateGet, {
      threadId: input.threadId,
    });
  }

  async listThreads(input: { workspaceId: string }): Promise<ChatThread[]> {
    this.assertWorkspace(input.workspaceId);
    const threads = await this.collectCursorPages(
      async (cursor) =>
        await this.request(CHATS_METHOD.threadsList, {
          pageLimit: 500,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      (page) => page.threads,
    );
    return threads.map((thread) => this.storeThread(thread));
  }

  async listThreadsForFile(input: {
    workspaceId: string;
    objectId: string;
  }): Promise<ChatThread[]> {
    this.assertWorkspace(input.workspaceId);
    const rows: ChatThread[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request(CHATS_METHOD.threadsListForFile, {
        objectId: input.objectId,
        pageLimit: 500,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      rows.push(...page.threads);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
  }

  async sendMessage(input: {
    workspaceId: string;
    threadId: string;
    author: ChatActor;
    authorUserId?: string;
    parentMessageId?: string;
    origin?: "cli";
    body: string;
    needsDecision?: boolean;
    attachments?: ChatLocalAttachmentParams[];
  }): Promise<ChatMessage> {
    this.assertWorkspace(input.workspaceId);
    const messageId = this.createId("message");
    return this.request(
      CHATS_METHOD.messageSend,
      {
        threadId: input.threadId,
        messageId,
        authorKind: input.author.kind,
        authorDisplayName: input.author.displayName,
        ...(input.authorUserId !== undefined
          ? { authorUserId: input.authorUserId }
          : {}),
        ...(input.parentMessageId !== undefined
          ? { parentMessageId: input.parentMessageId }
          : {}),
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
        body: input.body,
        ...(input.needsDecision !== undefined
          ? { needsDecision: input.needsDecision }
          : {}),
        ...(input.attachments !== undefined
          ? { attachments: input.attachments }
          : {}),
      },
      { idempotencyKey: messageId },
    );
  }

  async listMessages(input: {
    workspaceId: string;
    threadId: string;
  }): Promise<ChatMessage[]> {
    this.assertWorkspace(input.workspaceId);
    const rows: ChatMessage[] = [];
    let afterMessageOrder: number | undefined;
    do {
      const page = await this.request(CHATS_METHOD.messagesList, {
        threadId: input.threadId,
        limit: 500,
        ...(afterMessageOrder !== undefined ? { afterMessageOrder } : {}),
      });
      rows.push(...page.messages);
      afterMessageOrder = page.nextAfterMessageOrder ?? undefined;
    } while (afterMessageOrder !== undefined);
    return rows;
  }

  async resolveChatDecision(input: {
    workspaceId: string;
    threadId: string;
    messageId: string;
    resolvedByMessageId: string;
  }): Promise<ChatDecision & { workspaceId: string }> {
    this.assertWorkspace(input.workspaceId);
    const decision = await this.request(
      CHATS_METHOD.decisionResolve,
      {
        threadId: input.threadId,
        messageId: input.messageId,
        resolvedByMessageId: input.resolvedByMessageId,
      },
      {
        idempotencyKey: `${input.messageId}:${input.resolvedByMessageId}`,
      },
    );
    return { ...decision, workspaceId: input.workspaceId };
  }

  async listThreadDecisions(
    workspaceId: string,
    threadId: string,
  ): Promise<Array<ChatDecision & { workspaceId: string }>> {
    this.assertWorkspace(workspaceId);
    const rows: Array<ChatDecision & { workspaceId: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await this.request(CHATS_METHOD.decisionsListForThread, {
        threadId,
        pageLimit: 500,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      rows.push(
        ...page.decisions.map((decision) => ({ ...decision, workspaceId })),
      );
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
  }

  async listThreadAttachments(
    workspaceId: string,
    threadId: string,
  ): Promise<ChatAttachment[]> {
    this.assertWorkspace(workspaceId);
    const rows: ChatAttachment[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request(CHATS_METHOD.attachmentsListForThread, {
        threadId,
        pageLimit: 500,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      rows.push(...page.attachments);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
  }

  async listFileMentions(input: {
    workspaceId: string;
    objectId?: string;
    pathHint?: string;
  }): Promise<ChatFileMention[]> {
    this.assertWorkspace(input.workspaceId);
    const rows: ChatFileMention[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request(
        CHATS_METHOD.attachmentsListFileMentions,
        {
          ...(input.objectId !== undefined ? { objectId: input.objectId } : {}),
          ...(input.pathHint !== undefined ? { pathHint: input.pathHint } : {}),
          pageLimit: 500,
          ...(cursor !== undefined ? { cursor } : {}),
        },
      );
      rows.push(...page.mentions);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
  }

  async markThreadReadByAgent(input: {
    workspaceId: string;
    threadId: string;
    upTo: { createdAtMs: number; messageId: string };
    expectedRevision?: number;
  }): Promise<ChatAgentReadState> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.agentReadMarkThreadRead, {
      threadId: input.threadId,
      upTo: input.upTo,
      ...(input.expectedRevision !== undefined
        ? { expectedRevision: input.expectedRevision }
        : {}),
    });
  }

  async listAgentUnreadThreads(workspaceId: string): Promise<ChatThread[]> {
    this.assertWorkspace(workspaceId);
    const rows: ChatThread[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request(
        CHATS_METHOD.agentReadListUnreadThreads,
        {
          pageLimit: 500,
          ...(cursor !== undefined ? { cursor } : {}),
        },
      );
      rows.push(...page.threads);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
  }

  async listMentionsForHandle(
    workspaceId: string,
    handle: string,
    options?: { unreadByAgentOnly?: boolean },
  ): Promise<ChatMention[]> {
    this.assertWorkspace(workspaceId);
    const rows: ChatMention[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request(CHATS_METHOD.mentionsListForHandle, {
        handle,
        ...(options?.unreadByAgentOnly !== undefined
          ? { unreadByAgentOnly: options.unreadByAgentOnly }
          : {}),
        pageLimit: 500,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      rows.push(...page.mentions);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
  }

  async setReaction(input: {
    workspaceId: string;
    threadId: string;
    messageId: string;
    emoji: string;
    author: ChatReactionAuthor;
    replicationAuthorId?: string;
    state: "added" | "removed";
  }): Promise<ChatReaction> {
    this.assertWorkspace(input.workspaceId);
    return this.request(
      CHATS_METHOD.reactionSet,
      {
        threadId: input.threadId,
        messageId: input.messageId,
        emoji: input.emoji,
        author: input.author,
        ...(input.replicationAuthorId !== undefined
          ? { replicationAuthorId: input.replicationAuthorId }
          : {}),
        state: input.state,
      },
      {
        idempotencyKey: `reaction-${randomUUID()}`,
      },
    );
  }

  async listReactions(input: {
    workspaceId: string;
    threadId: string;
  }): Promise<ChatReaction[]> {
    this.assertWorkspace(input.workspaceId);
    const rows: ChatReaction[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request(CHATS_METHOD.reactionsList, {
        threadId: input.threadId,
        pageLimit: 500,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      rows.push(...page.reactions);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
  }

  async setFollow(input: {
    workspaceId: string;
    ownerUserId: string;
    replicationOwnerUserId?: string;
    targetKind: "person" | "agent" | "channel" | "thread";
    targetId: string;
    state: "following" | "unfollowed";
  }): Promise<ChatFollow> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.followsSet, {
      ownerUserId: input.ownerUserId,
      ...(input.replicationOwnerUserId !== undefined
        ? { replicationOwnerUserId: input.replicationOwnerUserId }
        : {}),
      targetKind: input.targetKind,
      targetId: input.targetId,
      state: input.state,
    });
  }

  async listFollows(input: {
    workspaceId: string;
    ownerUserId: string;
    state?: "following" | "unfollowed";
  }): Promise<ChatFollow[]> {
    this.assertWorkspace(input.workspaceId);
    return this.collectCursorPages(
      async (cursor) =>
        await this.request(CHATS_METHOD.followsList, {
          ownerUserId: input.ownerUserId,
          ...(input.state !== undefined ? { state: input.state } : {}),
          pageLimit: 500,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      (page) => page.follows,
    );
  }

  async ensureDefaultChannelFollows(input: {
    workspaceId: string;
    ownerUserId: string;
  }): Promise<void> {
    this.assertWorkspace(input.workspaceId);
    await this.request(CHATS_METHOD.followsEnsureDefaults, {
      ownerUserId: input.ownerUserId,
    });
  }

  async listPersonalFeed(input: {
    workspaceId: string;
    ownerUserId: string;
    cursor?: string;
    limit?: number;
  }): Promise<ChatFeedPage> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.feedListPersonal, {
      ownerUserId: input.ownerUserId,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }

  async markPersonalFeedSeen(input: {
    workspaceId: string;
    ownerUserId: string;
    replicationOwnerUserId?: string;
    headCursor: string;
  }): Promise<ChatFeedReadState> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.feedMarkSeen, {
      ownerUserId: input.ownerUserId,
      ...(input.replicationOwnerUserId !== undefined
        ? { replicationOwnerUserId: input.replicationOwnerUserId }
        : {}),
      headCursor: input.headCursor,
    });
  }

  async saveBookmark(input: {
    workspaceId: string;
    ownerUserId: string;
    targetKind: "message" | "thread";
    targetId: string;
    mode: "live" | "snapshot";
    destinationPath: string;
  }): Promise<ChatBookmark> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.bookmarkSave, {
      ownerUserId: input.ownerUserId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      mode: input.mode,
      destinationPath: input.destinationPath,
    });
  }

  async listBookmarks(input: {
    workspaceId: string;
    ownerUserId: string;
    state?: "active" | "archived";
  }): Promise<ChatBookmark[]> {
    this.assertWorkspace(input.workspaceId);
    return this.collectCursorPages(
      async (cursor) =>
        await this.request(CHATS_METHOD.bookmarksList, {
          ownerUserId: input.ownerUserId,
          ...(input.state !== undefined ? { state: input.state } : {}),
          pageLimit: 500,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      (page) => page.bookmarks,
    );
  }

  async findBookmark(input: {
    workspaceId: string;
    ownerUserId: string;
    bookmarkId: string;
  }): Promise<ChatBookmark | null> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.bookmarkFind, {
      ownerUserId: input.ownerUserId,
      bookmarkId: input.bookmarkId,
    });
  }

  async archiveBookmark(input: {
    workspaceId: string;
    ownerUserId: string;
    bookmarkId: string;
  }): Promise<ChatBookmark> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.bookmarkArchive, {
      ownerUserId: input.ownerUserId,
      bookmarkId: input.bookmarkId,
    });
  }

  async listPendingBookmarks(input: {
    workspaceId: string;
    ownerUserId: string;
    limit?: number;
  }): Promise<ChatBookmark[]> {
    this.assertWorkspace(input.workspaceId);
    const rows: ChatBookmark[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request(CHATS_METHOD.bookmarkListPending, {
        ownerUserId: input.ownerUserId,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        pageLimit: 200,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      rows.push(...page.bookmarks);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
  }

  async markBookmarkPending(input: {
    workspaceId: string;
    ownerUserId: string;
    bookmarkId: string;
  }): Promise<ChatBookmark> {
    this.assertWorkspace(input.workspaceId);
    return this.request(
      CHATS_METHOD.bookmarkMarkPending,
      {
        ownerUserId: input.ownerUserId,
        bookmarkId: input.bookmarkId,
      },
      {
        idempotencyKey: `${input.bookmarkId}:pending:${randomUUID()}`,
      },
    );
  }

  async markBookmarkReady(input: {
    workspaceId: string;
    ownerUserId: string;
    bookmarkId: string;
    generation: number;
    projectedAtMs?: number;
    projectionObjectId?: string;
    projectionPath?: string;
  }): Promise<ChatBookmarkTransition> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.bookmarkMarkReady, {
      ownerUserId: input.ownerUserId,
      bookmarkId: input.bookmarkId,
      generation: input.generation,
      ...(input.projectedAtMs !== undefined
        ? { projectedAtMs: input.projectedAtMs }
        : {}),
      ...(input.projectionObjectId !== undefined
        ? { projectionObjectId: input.projectionObjectId }
        : {}),
      ...(input.projectionPath !== undefined
        ? { projectionPath: input.projectionPath }
        : {}),
    });
  }

  async markBookmarkFailed(input: {
    workspaceId: string;
    ownerUserId: string;
    bookmarkId: string;
    generation: number;
    failureReason: string;
  }): Promise<ChatBookmarkTransition> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.bookmarkMarkFailed, {
      ownerUserId: input.ownerUserId,
      bookmarkId: input.bookmarkId,
      generation: input.generation,
      failureReason: input.failureReason,
    });
  }

  async markBookmarkStale(input: {
    workspaceId: string;
    ownerUserId: string;
    bookmarkId: string;
    generation: number;
    failureReason?: string;
  }): Promise<ChatBookmarkTransition> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.bookmarkMarkStale, {
      ownerUserId: input.ownerUserId,
      bookmarkId: input.bookmarkId,
      generation: input.generation,
      ...(input.failureReason !== undefined
        ? { failureReason: input.failureReason }
        : {}),
    });
  }

  async getThreadProjection(input: {
    workspaceId: string;
    threadId: string;
    linkedFileAccess?: ChatProjectionFileAccess;
  }): Promise<ChatProjection> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.threadGetProjection, {
      threadId: input.threadId,
      ...(input.linkedFileAccess !== undefined
        ? { linkedFileAccess: input.linkedFileAccess }
        : {}),
    });
  }

  async recordEligibleTriggers(input: {
    workspaceId: string;
    verifiedUserId?: string;
  }): Promise<number> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.dispatchRecordEligibleTriggers, {
      ...(input.verifiedUserId !== undefined
        ? { verifiedUserId: input.verifiedUserId }
        : {}),
    });
  }

  async recordTrigger(input: {
    workspaceId: string;
    triggerMessageId: string;
    threadId: string;
  }): Promise<boolean> {
    this.assertWorkspace(input.workspaceId);
    return (
      await this.request(CHATS_METHOD.dispatchEnqueue, {
        triggerMessageId: input.triggerMessageId,
        threadId: input.threadId,
      })
    ).enqueued;
  }

  async claimNextPending(
    workspaceId: string,
    options?: { command?: string; logPath?: string },
  ): Promise<ChatDispatchClaim | null> {
    this.assertWorkspace(workspaceId);
    return this.request(CHATS_METHOD.dispatchClaimNextPending, {
      runId: this.createId("run"),
      ...(options?.command !== undefined ? { command: options.command } : {}),
      ...(options?.logPath !== undefined ? { logPath: options.logPath } : {}),
    });
  }

  async failPendingForThread(input: {
    workspaceId: string;
    threadId: string;
    reason: string;
  }): Promise<number> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.dispatchFailPendingForThread, {
      threadId: input.threadId,
      reason: input.reason,
    });
  }

  async completeRun(input: {
    runId: string;
    exitCode: number;
  }): Promise<ChatRun> {
    await this.request(CHATS_METHOD.dispatchComplete, input);
    const run = await this.getRunRecord(input.runId);
    if (run === null) {
      throw new ChatsAdapterCapabilityError(
        "The daemon acknowledged completion but did not return the run record.",
      );
    }
    return run;
  }

  async failRun(input: {
    runId: string;
    exitCode?: number;
    reason: string;
  }): Promise<ChatRun> {
    await this.request(CHATS_METHOD.dispatchFail, input);
    const run = await this.getRunRecord(input.runId);
    if (run === null) {
      throw new ChatsAdapterCapabilityError(
        "The daemon acknowledged failure but did not return the run record.",
      );
    }
    return run;
  }

  async listPending(workspaceId: string): Promise<ChatDispatch[]> {
    this.assertWorkspace(workspaceId);
    return this.collectCursorPages(
      (cursor) =>
        this.request(CHATS_METHOD.dispatchListPending, {
          pageLimit: 500,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      (page) => page.dispatches,
    );
  }

  async openRuns(workspaceId: string): Promise<ChatDispatchClaim[]> {
    this.assertWorkspace(workspaceId);
    return this.collectCursorPages(
      (cursor) =>
        this.request(CHATS_METHOD.dispatchOpenRuns, {
          pageLimit: 500,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      (page) => page.claims,
    );
  }

  async markFailureNotePosted(runId: string): Promise<ChatRun> {
    return this.request(CHATS_METHOD.dispatchMarkFailureNotePosted, { runId });
  }

  async recentDispatchCount(input: {
    workspaceId: string;
    threadId: string;
    sinceMs: number;
  }): Promise<number> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.dispatchRecentCount, {
      threadId: input.threadId,
      sinceMs: input.sinceMs,
    });
  }

  async recordRunMessage(input: {
    workspaceId: string;
    messageId: string;
    runId: string;
  }): Promise<boolean> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.dispatchRecordRunMessage, {
      messageId: input.messageId,
      runId: input.runId,
    });
  }

  async listRunMessages(
    workspaceId: string,
    runId: string,
  ): Promise<string[]> {
    this.assertWorkspace(workspaceId);
    return this.collectCursorPages(
      (cursor) =>
        this.request(CHATS_METHOD.dispatchListRunMessages, {
          runId,
          pageLimit: 500,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      (page) => page.messageIds,
    );
  }

  async runIdForMessage(
    workspaceId: string,
    messageId: string,
  ): Promise<string | null> {
    this.assertWorkspace(workspaceId);
    return this.request(CHATS_METHOD.dispatchRunIdForMessage, { messageId });
  }

  async runRecordsForThread(
    workspaceId: string,
    threadId: string,
    options?: { limit?: number },
  ): Promise<Record<string, ChatRun>> {
    this.assertWorkspace(workspaceId);
    const result: Record<string, ChatRun> = Object.create(null);
    let cursor: string | undefined;
    do {
      const page = await this.request(CHATS_METHOD.dispatchRunRecordsForThread, {
        threadId,
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        pageLimit: 500,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      Object.assign(result, page.runs);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return result;
  }

  async getRunRecord(runId: string): Promise<ChatRun | null> {
    return this.request(CHATS_METHOD.dispatchGetRunRecord, { runId });
  }

  async setThreadDispatchPaused(input: {
    workspaceId: string;
    threadId: string;
    paused: boolean;
    reason?: string;
  }): Promise<ChatThreadPause> {
    this.assertWorkspace(input.workspaceId);
    return this.request(CHATS_METHOD.dispatchSetThreadPaused, {
      threadId: input.threadId,
      paused: input.paused,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  async threadDispatchPaused(
    workspaceId: string,
    threadId: string,
  ): Promise<boolean> {
    this.assertWorkspace(workspaceId);
    return this.request(CHATS_METHOD.dispatchIsThreadPaused, { threadId });
  }

  async getThreadDispatchPauseState(
    workspaceId: string,
    threadId: string,
  ): Promise<ChatThreadPause | null> {
    this.assertWorkspace(workspaceId);
    return this.request(CHATS_METHOD.dispatchGetThreadPauseState, { threadId });
  }

  async close(): Promise<void> {
    const raw = await this.requester.request(
      WORKSPACE_METHOD.close,
      {},
      { workspace: this.workspace },
    );
    decodeWorkspaceResult(WORKSPACE_METHOD.close, raw);
  }

  disposeTransport(): void {
    this.requester.closeTransport();
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) {
      throw new ChatsAdapterCapabilityError(
        `Workspace ${workspaceId} does not match this adapter's workspace.`,
      );
    }
  }

  private storeThread(thread: ChatThreadWireRecord): ChatThread {
    return {
      id: thread.threadId,
      workspaceId: thread.workspaceId,
      title: thread.title,
      createdAtMs: thread.createdAtMs,
      updatedAtMs: thread.updatedAtMs,
      ...(thread.channelId !== null ? { channelId: thread.channelId } : {}),
      ...(thread.linkedObjectId !== null
        ? {
            linkedFile: {
              objectId: thread.linkedObjectId,
              linkedAtMs: thread.createdAtMs,
            },
          }
        : {}),
    };
  }

  private async collectCursorPages<TPage extends { nextCursor: string | null }, T>(
    fetchPage: (cursor: string | undefined) => Promise<TPage>,
    rows: (page: TPage) => T[],
  ): Promise<T[]> {
    const result: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await fetchPage(cursor);
      result.push(...rows(page));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return result;
  }
}
