import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Struct from "effect/Struct";
import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";

export const CHATS_METHOD = {
  channelCreate: "chats.channels.create",
  channelEnsureAgent: "chats.channels.ensureAgent",
  channelEnsureGeneral: "chats.channels.ensureGeneral",
  channelFindBySlug: "chats.channels.findBySlug",
  channelsList: "chats.channels.list",
  channelGetWireId: "chats.channels.getWireId",
  threadStart: "chats.threads.start",
  threadCreate: "chats.threads.create",
  threadsList: "chats.threads.list",
  threadsListForFile: "chats.threads.listForFile",
  threadsListForChannel: "chats.threads.listForChannel",
  threadFindChannelId: "chats.threads.findChannelId",
  threadGetProjection: "chats.threads.getProjection",
  messageSend: "chats.messages.send",
  messagesList: "chats.messages.list",
  readStateGet: "chats.readState.get",
  readStateMarkThreadRead: "chats.readState.markThreadRead",
  readStateListUnreadFileThreads: "chats.readState.listUnreadFileThreads",
  decisionResolve: "chats.decisions.resolve",
  decisionsListForThread: "chats.decisions.listForThread",
  reactionSet: "chats.reactions.set",
  reactionsList: "chats.reactions.list",
  attachmentsListForThread: "chats.attachments.listForThread",
  attachmentsListFileMentions: "chats.attachments.listFileMentions",
  mentionsListForHandle: "chats.mentions.listForHandle",
  agentReadListUnreadThreads: "chats.agentReadState.listUnreadThreads",
  agentReadMarkThreadRead: "chats.agentReadState.markThreadRead",
  followsSet: "chats.follows.set",
  followsList: "chats.follows.list",
  followsEnsureDefaults: "chats.follows.ensureDefaults",
  feedMarkSeen: "chats.feed.markSeen",
  feedListPersonal: "chats.feed.listPersonal",
  bookmarkSave: "chats.bookmarks.save",
  bookmarksList: "chats.bookmarks.list",
  bookmarkFind: "chats.bookmarks.find",
  bookmarkListPending: "chats.bookmarks.listPending",
  bookmarkMarkReady: "chats.bookmarks.markReady",
  bookmarkArchive: "chats.bookmarks.archive",
  bookmarkMarkPending: "chats.bookmarks.markPending",
  bookmarkMarkFailed: "chats.bookmarks.markFailed",
  bookmarkMarkStale: "chats.bookmarks.markStale",
  dispatchEnqueue: "chats.dispatch.enqueue",
  dispatchRecordEligibleTriggers: "chats.dispatch.recordEligibleTriggers",
  dispatchClaimNextPending: "chats.dispatch.claimNextPending",
  dispatchListPending: "chats.dispatch.listPending",
  dispatchOpenRuns: "chats.dispatch.openRuns",
  dispatchListRunMessages: "chats.dispatch.listRunMessages",
  dispatchRunIdForMessage: "chats.dispatch.runIdForMessage",
  dispatchRunRecordsForThread: "chats.dispatch.runRecordsForThread",
  dispatchGetRunRecord: "chats.dispatch.getRunRecord",
  dispatchIsThreadPaused: "chats.dispatch.isThreadPaused",
  dispatchGetThreadPauseState: "chats.dispatch.getThreadPauseState",
  dispatchRecentCount: "chats.dispatch.recentCount",
  dispatchFailPendingForThread: "chats.dispatch.failPendingForThread",
  dispatchRecordRunMessage: "chats.dispatch.recordRunMessage",
  dispatchSetThreadPaused: "chats.dispatch.setThreadPaused",
  dispatchMarkFailureNotePosted: "chats.dispatch.markFailureNotePosted",
  dispatchRequeueFailedTrigger: "chats.dispatch.requeueFailedTrigger",
  dispatchListAppQuitRecoveries: "chats.dispatch.listAppQuitRecoveries",
  dispatchComplete: "chats.dispatch.complete",
  dispatchFail: "chats.dispatch.fail",
} as const;

export type ChatsMethod = (typeof CHATS_METHOD)[keyof typeof CHATS_METHOD];
export type ChatsJsonObject = { [key: string]: JsonValue | undefined };
export type ChatPageParams = ChatsJsonObject & {
  pageLimit?: number;
  cursor?: string;
};

export type ChatActor = ChatsJsonObject & {
  kind: "human" | "agent";
  displayName: string;
};
export type ChatLinkedFile = ChatsJsonObject & {
  objectId: string;
  pathHint?: string;
  linkedAtMs: number;
};
export type ChatThread = ChatsJsonObject & {
  id: string;
  workspaceId: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  linkedFile?: ChatLinkedFile;
  channelId?: string;
};
export type ChatAttachment = ChatsJsonObject & {
  attachmentId: string;
  threadId: string;
  messageId: string;
  targetKind: "file";
  objectId?: string;
  pathHint?: string;
  headingText?: string;
  headingAnchor?: string;
  headingOccurrence?: number;
  createdAtMs: number;
};
export type ChatLocalAttachmentParams = ChatsJsonObject & {
  objectId: string;
  pathHint?: string;
  headingText?: string;
  headingAnchor?: string;
  headingOccurrence?: number;
};
export type ChatMessage = ChatsJsonObject & {
  id: string;
  workspaceId: string;
  threadId: string;
  author: ChatActor;
  authorUserId?: string;
  parentMessageId?: string;
  origin?: "cli";
  body: string;
  createdAtMs: number;
  attachments: ChatAttachment[];
};
export type ChatDecision = ChatsJsonObject & {
  threadId: string;
  messageId: string;
  state: "open" | "resolved";
  resolvedByMessageId?: string;
  atMs: number;
};
export type ChatReactionAuthor = ChatsJsonObject & {
  authorId: string;
  kind: "human" | "agent";
  displayName: string;
};
export type ChatReaction = ChatsJsonObject & {
  reactionId: string;
  threadId: string;
  messageId: string;
  emoji: string;
  author: ChatReactionAuthor;
  state: "added" | "removed";
  atMs: number;
};
export type ChatBookmark = ChatsJsonObject & {
  bookmarkId: string;
  workspaceId: string;
  ownerUserId: string;
  targetKind: "message" | "thread";
  targetId: string;
  threadId: string;
  messageId?: string;
  mode: "live" | "snapshot";
  destinationPath: string;
  state: "active" | "archived";
  generation: number;
  projectedGeneration: number;
  projectionState: "pending" | "ready" | "failed" | "stale";
  projectionObjectId?: string;
  createdAtMs: number;
  updatedAtMs: number;
  lastProjectedAtMs?: number;
  failureReason?: string;
};
export type ChatBookmarkTransition = ChatsJsonObject & {
  bookmark: ChatBookmark;
  applied: boolean;
};
export type ChatDispatch = ChatsJsonObject & {
  workspaceId: string;
  triggerMessageId: string;
  threadId: string;
  state: "pending" | "running" | "done" | "failed";
  runId?: string;
  failureReason?: string;
  attemptCount: number;
  createdAtMs: number;
  updatedAtMs: number;
};
export type ChatRun = ChatsJsonObject & {
  workspaceId: string;
  runId: string;
  threadId: string;
  triggerMessageId: string;
  command: string;
  startedAtMs: number;
  endedAtMs?: number;
  exitCode?: number;
  failureReason?: string;
  logPath?: string;
  failureNotePosted: boolean;
};
export type ChatDispatchClaim = ChatsJsonObject & {
  dispatch: ChatDispatch;
  run: ChatRun;
};
export type ChatThreadPause = ChatsJsonObject & {
  workspaceId: string;
  threadId: string;
  paused: boolean;
  reason?: string;
  updatedAtMs: number;
};
export type ChatAgentReadState = ChatsJsonObject & {
  workspaceId: string;
  threadId: string;
  lastReadCreatedAtMs: number;
  lastReadMessageId: string;
  revision: number;
  updatedAtMs: number;
};
export type ChatMention = ChatsJsonObject & {
  threadId: string;
  messageId: string;
  handle: string;
  authorKind: "human" | "agent";
  createdAtMs: number;
};
export type ChatChannel = ChatsJsonObject & {
  workspaceId: string;
  channelId: string;
  name: string;
  slug: string;
  kind: "channel" | "dm" | "agent";
  createdAtMs: number;
  updatedAtMs: number;
};
export type ChatChannelSummary = ChatChannel & {
  threadCount: number;
  unreadCount: number;
};
export type ChatThreadWireRecord = ChatsJsonObject & {
  workspaceId: string;
  threadId: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  channelId: string | null;
  linkedObjectId: string | null;
};
export type ChatThreadReadState = ChatsJsonObject & {
  workspaceId: string;
  threadId: string;
  lastReadSequence: number;
  revision: number;
  updatedAtMs: number;
};
export type ChatUnreadFileThread = ChatsJsonObject & {
  threadId: string;
  messageCount: number;
  lastReadSequence: number;
};
export type ChatFollow = ChatsJsonObject & {
  workspaceId: string;
  ownerUserId: string;
  targetKind: "person" | "agent" | "channel" | "thread";
  targetId: string;
  state: "following" | "unfollowed";
  updatedAtMs: number;
};
export type ChatFileMention = ChatsJsonObject & {
  attachment: ChatAttachment;
  message: ChatMessage;
  thread: ChatThread;
  channel?: ChatChannel;
};
export type ChatChannelOpeningMessage = ChatsJsonObject & {
  id: string;
  author: ChatActor;
  createdAtMs: number;
  bodySnippet: string;
  reactions: ChatReaction[];
};
export type ChatChannelThreadSummary = ChatsJsonObject & {
  thread: ChatThread;
  messageCount: number;
  lastReadSequence: number;
  unreadCount: number;
  openDecisionCount: number;
  openingMessage?: ChatChannelOpeningMessage;
};
export type ChatProjection = ChatsJsonObject & {
  path: string;
  readOnly: true;
  threadId: string;
  text: string;
};
export type ChatProjectionFileAccess =
  | (ChatsJsonObject & { kind: "allowed"; path: string })
  | (ChatsJsonObject & { kind: "denied" | "unknown" });
export type ChatFeedReadState = ChatsJsonObject & {
  workspaceId: string;
  ownerUserId: string;
  lastSeenCreatedAtMs: number;
  lastSeenMessageId: string;
  updatedAtMs: number;
};
export type ChatFeedChannel = Omit<ChatChannel, "channelId"> & { id: string };
export type ChatFeedItem = ChatsJsonObject & {
  message: ChatMessage;
  thread: ChatThread;
  reactions: ChatReaction[];
  matchedBy: Array<"person" | "agent" | "channel" | "thread">;
  channel?: ChatFeedChannel;
  parentMessage?: ChatMessage;
  openingMessage?: ChatMessage;
};

export type ChatChannelGetWireIdParams = ChatsJsonObject & { channelId: string };
export type ChatChannelCreateParams = ChatsJsonObject & {
  channelId: string;
  name: string;
  kind: "channel" | "dm" | "agent";
  nowMs?: number;
};
export type ChatChannelEnsureParams = ChatsJsonObject & {
  channelId: string;
  nowMs?: number;
};
export type ChatChannelFindBySlugParams = ChatsJsonObject & { slug: string };
export type ChatEmptyParams = ChatsJsonObject;
export type ChatThreadStartParams = ChatsJsonObject & {
  channelId: string;
  threadId: string;
  messageId: string;
  title?: string;
  authorKind: "human" | "agent";
  authorDisplayName: string;
  authorUserId?: string;
  origin?: "cli";
  body: string;
  needsDecision?: boolean;
  attachments?: ChatLocalAttachmentParams[];
  nowMs?: number;
};
export type ChatThreadCreateParams = ChatsJsonObject & {
  threadId: string;
  title: string;
  linkedFile: ChatsJsonObject & { objectId: string; pathHint?: string };
  nowMs?: number;
};
export type ChatThreadsListForFileParams = ChatPageParams & { objectId: string };
export type ChatThreadsListForChannelParams = ChatPageParams & { channelId: string };
export type ChatThreadParams = ChatsJsonObject & { threadId: string };
export type ChatThreadProjectionParams = ChatThreadParams & {
  linkedFileAccess?: ChatProjectionFileAccess;
};
export type ChatMessageSendParams = ChatsJsonObject & {
  threadId: string;
  messageId: string;
  authorKind: "human" | "agent";
  authorDisplayName: string;
  authorUserId?: string;
  parentMessageId?: string;
  origin?: "cli";
  body: string;
  needsDecision?: boolean;
  attachments?: ChatLocalAttachmentParams[];
  nowMs?: number;
};
export type ChatMessagesListParams = ChatsJsonObject & {
  threadId: string;
  limit?: number;
  afterMessageOrder?: number;
};
export type ChatReadStateMarkParams = ChatsJsonObject & {
  threadId: string;
  upToSequence: number;
  expectedRevision?: number;
  nowMs?: number;
};
export type ChatUnreadFileThreadsParams = ChatsJsonObject & {
  pageLimit?: number;
  afterThreadId?: string;
};
export type ChatDecisionResolveParams = ChatsJsonObject & {
  threadId: string;
  messageId: string;
  resolvedByMessageId: string;
  nowMs?: number;
};
export type ChatReactionSetParams = ChatsJsonObject & {
  threadId: string;
  messageId: string;
  emoji: string;
  author: ChatReactionAuthor;
  replicationAuthorId?: string;
  state: "added" | "removed";
  nowMs?: number;
};
export type ChatThreadPageParams = ChatPageParams & { threadId: string };
export type ChatFileMentionsParams = ChatPageParams & {
  objectId?: string;
  pathHint?: string;
};
export type ChatMentionsParams = ChatPageParams & {
  handle: string;
  unreadByAgentOnly?: boolean;
};
export type ChatAgentReadMarkParams = ChatsJsonObject & {
  threadId: string;
  upTo: ChatsJsonObject & { createdAtMs: number; messageId: string };
  expectedRevision?: number;
};
export type ChatOwnerParams = ChatsJsonObject & { ownerUserId: string };
export type ChatFollowSetParams = ChatsJsonObject & {
  ownerUserId: string;
  replicationOwnerUserId?: string;
  targetKind: "person" | "agent" | "channel" | "thread";
  targetId: string;
  state: "following" | "unfollowed";
  nowMs?: number;
};
export type ChatFollowListParams = ChatOwnerParams & ChatPageParams & {
  state?: "following" | "unfollowed";
};
export type ChatFeedMarkSeenParams = ChatOwnerParams & {
  replicationOwnerUserId?: string;
  headCursor: string;
  nowMs?: number;
};
export type ChatFeedListParams = ChatsJsonObject & {
  ownerUserId: string;
  limit?: number;
  cursor?: string;
};
export type ChatBookmarkFindParams = ChatsJsonObject & {
  ownerUserId: string;
  bookmarkId: string;
};
export type ChatBookmarkSaveParams = ChatOwnerParams & {
  targetKind: "message" | "thread";
  targetId: string;
  mode: "live" | "snapshot";
  destinationPath: string;
  nowMs?: number;
};
export type ChatBookmarksListParams = ChatOwnerParams & ChatPageParams & {
  state?: "active" | "archived";
};
export type ChatBookmarkListPendingParams = ChatPageParams & {
  ownerUserId: string;
  limit?: number;
};
export type ChatBookmarkGenerationParams = ChatBookmarkFindParams & { generation: number };
export type ChatBookmarkMarkReadyParams = ChatBookmarkGenerationParams & {
  projectedAtMs?: number;
  projectionObjectId?: string;
  projectionPath?: string;
};
export type ChatBookmarkMarkFailedParams = ChatBookmarkGenerationParams & {
  failureReason: string;
};
export type ChatBookmarkMarkStaleParams = ChatBookmarkGenerationParams & {
  failureReason?: string;
};
export type ChatDispatchRecordEligibleParams = ChatsJsonObject & { verifiedUserId?: string };
export type ChatDispatchEnqueueParams = ChatsJsonObject & {
  triggerMessageId: string;
  threadId: string;
  nowMs?: number;
};
export type ChatDispatchClaimParams = ChatsJsonObject & {
  runId: string;
  command?: string;
  logPath?: string;
  nowMs?: number;
};
export type ChatDispatchRunPageParams = ChatPageParams & { runId: string };
export type ChatDispatchMessageParams = ChatsJsonObject & { messageId: string };
export type ChatDispatchThreadRunsParams = ChatPageParams & {
  threadId: string;
  limit?: number;
};
export type ChatDispatchRunParams = ChatsJsonObject & { runId: string };
export type ChatDispatchRecentCountParams = ChatsJsonObject & {
  threadId: string;
  sinceMs: number;
};
export type ChatDispatchFailPendingParams = ChatsJsonObject & {
  threadId: string;
  reason: string;
};
export type ChatDispatchRecordRunMessageParams = ChatsJsonObject & {
  messageId: string;
  runId: string;
};
export type ChatDispatchSetPausedParams = ChatsJsonObject & {
  threadId: string;
  paused: boolean;
  reason?: string;
};
export type ChatDispatchRequeueParams = ChatsJsonObject & {
  triggerMessageId: string;
  runId: string;
};
export type ChatDispatchCompleteParams = ChatsJsonObject & {
  runId: string;
  exitCode: number;
  nowMs?: number;
};
export type ChatDispatchFailParams = ChatsJsonObject & {
  runId: string;
  reason: string;
  exitCode?: number;
  nowMs?: number;
};

export type ChatThreadStartResult = ChatsJsonObject & {
  thread: ChatThread;
  message: ChatMessage;
};
export type ChatWireIdResult = ChatsJsonObject & { wireId: string | null };
export type ChatChannelsListResult = ChatsJsonObject & {
  channels: ChatChannelSummary[];
  nextCursor: string | null;
};
export type ChatThreadsListResult = ChatsJsonObject & {
  threads: ChatThreadWireRecord[];
  nextCursor: string | null;
};
export type ChatMessagesListResult = ChatsJsonObject & {
  messages: ChatMessage[];
  nextAfterMessageOrder: number | null;
};
export type ChatFollowsListResult = ChatsJsonObject & {
  follows: ChatFollow[];
  nextCursor: string | null;
};
export type ChatBookmarksListResult = ChatsJsonObject & {
  bookmarks: ChatBookmark[];
  nextCursor: string | null;
};
export type ChatEnqueueResult = ChatsJsonObject & { enqueued: boolean };
export type ChatCompleteResult = ChatsJsonObject & { completed: true };
export type ChatFailResult = ChatsJsonObject & { failed: true };
export type ChatThreadsPage = ChatsJsonObject & {
  threads: ChatThread[];
  nextCursor: string | null;
};
export type ChatChannelThreadsPage = ChatsJsonObject & {
  threads: ChatChannelThreadSummary[];
  nextCursor: string | null;
};
export type ChatDecisionsPage = ChatsJsonObject & {
  decisions: ChatDecision[];
  nextCursor: string | null;
};
export type ChatReactionsPage = ChatsJsonObject & {
  reactions: ChatReaction[];
  nextCursor: string | null;
};
export type ChatAttachmentsPage = ChatsJsonObject & {
  attachments: ChatAttachment[];
  nextCursor: string | null;
};
export type ChatFileMentionsPage = ChatsJsonObject & {
  mentions: ChatFileMention[];
  nextCursor: string | null;
};
export type ChatMentionsPage = ChatsJsonObject & {
  mentions: ChatMention[];
  nextCursor: string | null;
};
export type ChatBookmarksPage = ChatsJsonObject & {
  bookmarks: ChatBookmark[];
  nextCursor: string | null;
};
export type ChatDispatchesPage = ChatsJsonObject & {
  dispatches: ChatDispatch[];
  nextCursor: string | null;
};
export type ChatClaimsPage = ChatsJsonObject & {
  claims: ChatDispatchClaim[];
  nextCursor: string | null;
};
export type ChatRunMessagesPage = ChatsJsonObject & {
  messageIds: string[];
  nextCursor: string | null;
};
export type ChatThreadRunsPage = ChatsJsonObject & {
  runs: Record<string, ChatRun>;
  nextCursor: string | null;
};
export type ChatRecoveriesPage = ChatsJsonObject & {
  recoveries: Array<ChatsJsonObject & { run: ChatRun; attemptCount: number }>;
  nextCursor: string | null;
};
export type ChatFeedPage = ChatsJsonObject & {
  items: ChatFeedItem[];
  nextCursor: string | null;
  headCursor: string | null;
  readState: ChatFeedReadState | null;
};

export type ChatsMethodParamsMap = {
  [CHATS_METHOD.channelCreate]: ChatChannelCreateParams;
  [CHATS_METHOD.channelEnsureAgent]: ChatChannelEnsureParams;
  [CHATS_METHOD.channelEnsureGeneral]: ChatChannelEnsureParams;
  [CHATS_METHOD.channelFindBySlug]: ChatChannelFindBySlugParams;
  [CHATS_METHOD.channelsList]: ChatPageParams;
  [CHATS_METHOD.channelGetWireId]: ChatChannelGetWireIdParams;
  [CHATS_METHOD.threadStart]: ChatThreadStartParams;
  [CHATS_METHOD.threadCreate]: ChatThreadCreateParams;
  [CHATS_METHOD.threadsList]: ChatPageParams;
  [CHATS_METHOD.threadsListForFile]: ChatThreadsListForFileParams;
  [CHATS_METHOD.threadsListForChannel]: ChatThreadsListForChannelParams;
  [CHATS_METHOD.threadFindChannelId]: ChatThreadParams;
  [CHATS_METHOD.threadGetProjection]: ChatThreadProjectionParams;
  [CHATS_METHOD.messageSend]: ChatMessageSendParams;
  [CHATS_METHOD.messagesList]: ChatMessagesListParams;
  [CHATS_METHOD.readStateGet]: ChatThreadParams;
  [CHATS_METHOD.readStateMarkThreadRead]: ChatReadStateMarkParams;
  [CHATS_METHOD.readStateListUnreadFileThreads]: ChatUnreadFileThreadsParams;
  [CHATS_METHOD.decisionResolve]: ChatDecisionResolveParams;
  [CHATS_METHOD.decisionsListForThread]: ChatThreadPageParams;
  [CHATS_METHOD.reactionSet]: ChatReactionSetParams;
  [CHATS_METHOD.reactionsList]: ChatThreadPageParams;
  [CHATS_METHOD.attachmentsListForThread]: ChatThreadPageParams;
  [CHATS_METHOD.attachmentsListFileMentions]: ChatFileMentionsParams;
  [CHATS_METHOD.mentionsListForHandle]: ChatMentionsParams;
  [CHATS_METHOD.agentReadListUnreadThreads]: ChatPageParams;
  [CHATS_METHOD.agentReadMarkThreadRead]: ChatAgentReadMarkParams;
  [CHATS_METHOD.followsSet]: ChatFollowSetParams;
  [CHATS_METHOD.followsList]: ChatFollowListParams;
  [CHATS_METHOD.followsEnsureDefaults]: ChatOwnerParams;
  [CHATS_METHOD.feedMarkSeen]: ChatFeedMarkSeenParams;
  [CHATS_METHOD.feedListPersonal]: ChatFeedListParams;
  [CHATS_METHOD.bookmarkSave]: ChatBookmarkSaveParams;
  [CHATS_METHOD.bookmarksList]: ChatBookmarksListParams;
  [CHATS_METHOD.bookmarkFind]: ChatBookmarkFindParams;
  [CHATS_METHOD.bookmarkListPending]: ChatBookmarkListPendingParams;
  [CHATS_METHOD.bookmarkMarkReady]: ChatBookmarkMarkReadyParams;
  [CHATS_METHOD.bookmarkArchive]: ChatBookmarkFindParams;
  [CHATS_METHOD.bookmarkMarkPending]: ChatBookmarkFindParams;
  [CHATS_METHOD.bookmarkMarkFailed]: ChatBookmarkMarkFailedParams;
  [CHATS_METHOD.bookmarkMarkStale]: ChatBookmarkMarkStaleParams;
  [CHATS_METHOD.dispatchEnqueue]: ChatDispatchEnqueueParams;
  [CHATS_METHOD.dispatchRecordEligibleTriggers]: ChatDispatchRecordEligibleParams;
  [CHATS_METHOD.dispatchClaimNextPending]: ChatDispatchClaimParams;
  [CHATS_METHOD.dispatchListPending]: ChatPageParams;
  [CHATS_METHOD.dispatchOpenRuns]: ChatPageParams;
  [CHATS_METHOD.dispatchListRunMessages]: ChatDispatchRunPageParams;
  [CHATS_METHOD.dispatchRunIdForMessage]: ChatDispatchMessageParams;
  [CHATS_METHOD.dispatchRunRecordsForThread]: ChatDispatchThreadRunsParams;
  [CHATS_METHOD.dispatchGetRunRecord]: ChatDispatchRunParams;
  [CHATS_METHOD.dispatchIsThreadPaused]: ChatThreadParams;
  [CHATS_METHOD.dispatchGetThreadPauseState]: ChatThreadParams;
  [CHATS_METHOD.dispatchRecentCount]: ChatDispatchRecentCountParams;
  [CHATS_METHOD.dispatchFailPendingForThread]: ChatDispatchFailPendingParams;
  [CHATS_METHOD.dispatchRecordRunMessage]: ChatDispatchRecordRunMessageParams;
  [CHATS_METHOD.dispatchSetThreadPaused]: ChatDispatchSetPausedParams;
  [CHATS_METHOD.dispatchMarkFailureNotePosted]: ChatDispatchRunParams;
  [CHATS_METHOD.dispatchRequeueFailedTrigger]: ChatDispatchRequeueParams;
  [CHATS_METHOD.dispatchListAppQuitRecoveries]: ChatPageParams;
  [CHATS_METHOD.dispatchComplete]: ChatDispatchCompleteParams;
  [CHATS_METHOD.dispatchFail]: ChatDispatchFailParams;
};

export type ChatsMethodResultMap = {
  [CHATS_METHOD.channelCreate]: ChatChannel;
  [CHATS_METHOD.channelEnsureAgent]: ChatChannel;
  [CHATS_METHOD.channelEnsureGeneral]: ChatChannel;
  [CHATS_METHOD.channelFindBySlug]: ChatChannel | null;
  [CHATS_METHOD.channelsList]: ChatChannelsListResult;
  [CHATS_METHOD.channelGetWireId]: ChatWireIdResult;
  [CHATS_METHOD.threadStart]: ChatThreadStartResult;
  [CHATS_METHOD.threadCreate]: ChatThread;
  [CHATS_METHOD.threadsList]: ChatThreadsListResult;
  [CHATS_METHOD.threadsListForFile]: ChatThreadsPage;
  [CHATS_METHOD.threadsListForChannel]: ChatChannelThreadsPage;
  [CHATS_METHOD.threadFindChannelId]: string | null;
  [CHATS_METHOD.threadGetProjection]: ChatProjection;
  [CHATS_METHOD.messageSend]: ChatMessage;
  [CHATS_METHOD.messagesList]: ChatMessagesListResult;
  [CHATS_METHOD.readStateGet]: ChatThreadReadState;
  [CHATS_METHOD.readStateMarkThreadRead]: ChatThreadReadState;
  [CHATS_METHOD.readStateListUnreadFileThreads]: ChatUnreadFileThread[];
  [CHATS_METHOD.decisionResolve]: ChatDecision;
  [CHATS_METHOD.decisionsListForThread]: ChatDecisionsPage;
  [CHATS_METHOD.reactionSet]: ChatReaction;
  [CHATS_METHOD.reactionsList]: ChatReactionsPage;
  [CHATS_METHOD.attachmentsListForThread]: ChatAttachmentsPage;
  [CHATS_METHOD.attachmentsListFileMentions]: ChatFileMentionsPage;
  [CHATS_METHOD.mentionsListForHandle]: ChatMentionsPage;
  [CHATS_METHOD.agentReadListUnreadThreads]: ChatThreadsPage;
  [CHATS_METHOD.agentReadMarkThreadRead]: ChatAgentReadState;
  [CHATS_METHOD.followsSet]: ChatFollow;
  [CHATS_METHOD.followsList]: ChatFollowsListResult;
  [CHATS_METHOD.followsEnsureDefaults]: null;
  [CHATS_METHOD.feedMarkSeen]: ChatFeedReadState;
  [CHATS_METHOD.feedListPersonal]: ChatFeedPage;
  [CHATS_METHOD.bookmarkSave]: ChatBookmark;
  [CHATS_METHOD.bookmarksList]: ChatBookmarksListResult;
  [CHATS_METHOD.bookmarkFind]: ChatBookmark | null;
  [CHATS_METHOD.bookmarkListPending]: ChatBookmarksPage;
  [CHATS_METHOD.bookmarkMarkReady]: ChatBookmarkTransition;
  [CHATS_METHOD.bookmarkArchive]: ChatBookmark;
  [CHATS_METHOD.bookmarkMarkPending]: ChatBookmark;
  [CHATS_METHOD.bookmarkMarkFailed]: ChatBookmarkTransition;
  [CHATS_METHOD.bookmarkMarkStale]: ChatBookmarkTransition;
  [CHATS_METHOD.dispatchEnqueue]: ChatEnqueueResult;
  [CHATS_METHOD.dispatchRecordEligibleTriggers]: number;
  [CHATS_METHOD.dispatchClaimNextPending]: ChatDispatchClaim | null;
  [CHATS_METHOD.dispatchListPending]: ChatDispatchesPage;
  [CHATS_METHOD.dispatchOpenRuns]: ChatClaimsPage;
  [CHATS_METHOD.dispatchListRunMessages]: ChatRunMessagesPage;
  [CHATS_METHOD.dispatchRunIdForMessage]: string | null;
  [CHATS_METHOD.dispatchRunRecordsForThread]: ChatThreadRunsPage;
  [CHATS_METHOD.dispatchGetRunRecord]: ChatRun | null;
  [CHATS_METHOD.dispatchIsThreadPaused]: boolean;
  [CHATS_METHOD.dispatchGetThreadPauseState]: ChatThreadPause | null;
  [CHATS_METHOD.dispatchRecentCount]: number;
  [CHATS_METHOD.dispatchFailPendingForThread]: number;
  [CHATS_METHOD.dispatchRecordRunMessage]: boolean;
  [CHATS_METHOD.dispatchSetThreadPaused]: ChatThreadPause;
  [CHATS_METHOD.dispatchMarkFailureNotePosted]: ChatRun;
  [CHATS_METHOD.dispatchRequeueFailedTrigger]: boolean;
  [CHATS_METHOD.dispatchListAppQuitRecoveries]: ChatRecoveriesPage;
  [CHATS_METHOD.dispatchComplete]: ChatCompleteResult;
  [CHATS_METHOD.dispatchFail]: ChatFailResult;
};

export class ChatsProtocolShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatsProtocolShapeError";
  }
}

function mutableStruct<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  return Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));
}

function decodeChatsSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: JsonValue,
  label: string,
): S["Type"] {
  const decoded = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
  })(value);
  if (Result.isFailure(decoded)) {
    const issue = SchemaIssue.makeFormatterStandardSchemaV1()(
      decoded.failure.issue,
    ).issues[0];
    const path = issue?.path?.map((part) =>
      typeof part === "number" ? `[${part}]` : `.${String(part)}`,
    ).join("") ?? "";
    throw new ChatsProtocolShapeError(
      `${label}${path}: ${issue?.message ?? decoded.failure.message}`,
    );
  }
  return decoded.success;
}

const NonnegativeInt = Schema.Natural;
const AnyInt = Schema.Int;
const NullableString = Schema.NullOr(Schema.String);
const NullableNonnegativeInt = Schema.NullOr(NonnegativeInt);
const ActorKindSchema = Schema.Literals(["human", "agent"]);
const ChannelKindSchema = Schema.Literals(["channel", "dm", "agent"]);
const FollowTargetKindSchema = Schema.Literals([
  "person",
  "agent",
  "channel",
  "thread",
]);
const NextCursorFields = { nextCursor: NullableString } as const;

const ChatActorSchema = mutableStruct({
  kind: ActorKindSchema,
  displayName: Schema.String,
});
const ChatLinkedFileSchema = mutableStruct({
  objectId: Schema.String,
  pathHint: Schema.optionalKey(Schema.String),
  linkedAtMs: AnyInt,
});
const ChatThreadSchema = mutableStruct({
  id: Schema.String,
  workspaceId: Schema.String,
  title: Schema.String,
  createdAtMs: AnyInt,
  updatedAtMs: AnyInt,
  linkedFile: Schema.optionalKey(ChatLinkedFileSchema),
  channelId: Schema.optionalKey(Schema.String),
});
const ChatAttachmentSchema = mutableStruct({
  attachmentId: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String,
  targetKind: Schema.Literal("file"),
  objectId: Schema.optionalKey(Schema.String),
  pathHint: Schema.optionalKey(Schema.String),
  headingText: Schema.optionalKey(Schema.String),
  headingAnchor: Schema.optionalKey(Schema.String),
  headingOccurrence: Schema.optionalKey(NonnegativeInt),
  createdAtMs: AnyInt,
});
const ChatMessageSchema = mutableStruct({
  id: Schema.String,
  workspaceId: Schema.String,
  threadId: Schema.String,
  author: ChatActorSchema,
  authorUserId: Schema.optionalKey(Schema.String),
  parentMessageId: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(Schema.Literal("cli")),
  body: Schema.String,
  createdAtMs: AnyInt,
  attachments: Schema.mutable(Schema.Array(ChatAttachmentSchema)),
});
const ChatDecisionSchema = mutableStruct({
  threadId: Schema.String,
  messageId: Schema.String,
  state: Schema.Literals(["open", "resolved"]),
  resolvedByMessageId: Schema.optionalKey(Schema.String),
  atMs: AnyInt,
});
const ChatReactionAuthorSchema = mutableStruct({
  authorId: Schema.String,
  kind: ActorKindSchema,
  displayName: Schema.String,
});
const ChatReactionSchema = mutableStruct({
  reactionId: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String,
  emoji: Schema.String,
  author: ChatReactionAuthorSchema,
  state: Schema.Literals(["added", "removed"]),
  atMs: AnyInt,
});
const ChatBookmarkSchema = mutableStruct({
  bookmarkId: Schema.String,
  workspaceId: Schema.String,
  ownerUserId: Schema.String,
  targetKind: Schema.Literals(["message", "thread"]),
  targetId: Schema.String,
  threadId: Schema.String,
  messageId: Schema.optionalKey(Schema.String),
  mode: Schema.Literals(["live", "snapshot"]),
  destinationPath: Schema.String,
  state: Schema.Literals(["active", "archived"]),
  generation: NonnegativeInt,
  projectedGeneration: NonnegativeInt,
  projectionState: Schema.Literals(["pending", "ready", "failed", "stale"]),
  projectionObjectId: Schema.optionalKey(Schema.String),
  createdAtMs: NonnegativeInt,
  updatedAtMs: NonnegativeInt,
  lastProjectedAtMs: Schema.optionalKey(NonnegativeInt),
  failureReason: Schema.optionalKey(Schema.String),
});
const ChatDispatchSchema = mutableStruct({
  workspaceId: Schema.String,
  triggerMessageId: Schema.String,
  threadId: Schema.String,
  state: Schema.Literals(["pending", "running", "done", "failed"]),
  runId: Schema.optionalKey(Schema.String),
  failureReason: Schema.optionalKey(Schema.String),
  attemptCount: NonnegativeInt,
  createdAtMs: NonnegativeInt,
  updatedAtMs: NonnegativeInt,
});
const ChatRunSchema = mutableStruct({
  workspaceId: Schema.String,
  runId: Schema.String,
  threadId: Schema.String,
  triggerMessageId: Schema.String,
  command: Schema.String,
  startedAtMs: NonnegativeInt,
  endedAtMs: Schema.optionalKey(NonnegativeInt),
  exitCode: Schema.optionalKey(AnyInt),
  failureReason: Schema.optionalKey(Schema.String),
  logPath: Schema.optionalKey(Schema.String),
  failureNotePosted: Schema.Boolean,
});
const ChatDispatchClaimSchema = mutableStruct({
  dispatch: ChatDispatchSchema,
  run: ChatRunSchema,
});
const ChatThreadPauseSchema = mutableStruct({
  workspaceId: Schema.String,
  threadId: Schema.String,
  paused: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  updatedAtMs: NonnegativeInt,
});
const ChatAgentReadStateSchema = mutableStruct({
  workspaceId: Schema.String,
  threadId: Schema.String,
  lastReadCreatedAtMs: AnyInt,
  lastReadMessageId: Schema.String,
  revision: NonnegativeInt,
  updatedAtMs: NonnegativeInt,
});
const ChatChannelSchema = mutableStruct({
  workspaceId: Schema.String,
  channelId: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  kind: ChannelKindSchema,
  createdAtMs: AnyInt,
  updatedAtMs: AnyInt,
});
const ChatChannelSummarySchema = mutableStruct({
  workspaceId: Schema.String,
  channelId: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  kind: ChannelKindSchema,
  createdAtMs: AnyInt,
  updatedAtMs: AnyInt,
  threadCount: NonnegativeInt,
  unreadCount: NonnegativeInt,
});
const ChatThreadWireRecordSchema = mutableStruct({
  workspaceId: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  createdAtMs: AnyInt,
  updatedAtMs: AnyInt,
  channelId: NullableString,
  linkedObjectId: NullableString,
});
const ChatThreadReadStateSchema = mutableStruct({
  workspaceId: Schema.String,
  threadId: Schema.String,
  lastReadSequence: NonnegativeInt,
  revision: NonnegativeInt,
  updatedAtMs: AnyInt,
});
const ChatUnreadFileThreadSchema = mutableStruct({
  threadId: Schema.NonEmptyString,
  messageCount: NonnegativeInt,
  lastReadSequence: NonnegativeInt,
});
const ChatFollowSchema = mutableStruct({
  workspaceId: Schema.String,
  ownerUserId: Schema.String,
  targetKind: FollowTargetKindSchema,
  targetId: Schema.String,
  state: Schema.Literals(["following", "unfollowed"]),
  updatedAtMs: AnyInt,
});
const ChatFeedReadStateSchema = mutableStruct({
  workspaceId: Schema.String,
  ownerUserId: Schema.String,
  lastSeenCreatedAtMs: AnyInt,
  lastSeenMessageId: Schema.String,
  updatedAtMs: AnyInt,
});
const ChatFileMentionSchema = mutableStruct({
  attachment: ChatAttachmentSchema,
  message: ChatMessageSchema,
  thread: ChatThreadSchema,
  channel: Schema.optionalKey(ChatChannelSchema),
});
const ChatMentionSchema = mutableStruct({
  threadId: Schema.String,
  messageId: Schema.String,
  handle: Schema.String,
  authorKind: ActorKindSchema,
  createdAtMs: AnyInt,
});
const ChatChannelOpeningMessageSchema = mutableStruct({
  id: Schema.String,
  author: ChatActorSchema,
  createdAtMs: AnyInt,
  bodySnippet: Schema.String,
  reactions: Schema.mutable(Schema.Array(ChatReactionSchema)),
});
const ChatChannelThreadSummarySchema = mutableStruct({
  thread: ChatThreadSchema,
  messageCount: NonnegativeInt,
  lastReadSequence: NonnegativeInt,
  unreadCount: NonnegativeInt,
  openDecisionCount: NonnegativeInt,
  openingMessage: Schema.optionalKey(ChatChannelOpeningMessageSchema),
});
const ChatFeedChannelSchema = mutableStruct({
  id: Schema.String,
  workspaceId: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  kind: ChannelKindSchema,
  createdAtMs: AnyInt,
  updatedAtMs: AnyInt,
});
const ChatFeedItemSchema = mutableStruct({
  message: ChatMessageSchema,
  thread: ChatThreadSchema,
  reactions: Schema.mutable(Schema.Array(ChatReactionSchema)),
  matchedBy: Schema.mutable(Schema.Array(FollowTargetKindSchema)),
  channel: Schema.optionalKey(ChatFeedChannelSchema),
  parentMessage: Schema.optionalKey(ChatMessageSchema),
  openingMessage: Schema.optionalKey(ChatMessageSchema),
});
const ChatProjectionSchema = mutableStruct({
  path: Schema.String,
  readOnly: Schema.Literal(true),
  threadId: Schema.String,
  text: Schema.String,
});
const BookmarkTransitionSchema = mutableStruct({
  bookmark: ChatBookmarkSchema,
  applied: Schema.Boolean,
});

function pageSchema(key: string, item: Schema.Constraint) {
  return mutableStruct({
    [key]: Schema.mutable(Schema.Array(item)),
    ...NextCursorFields,
  });
}

const ChatsResultSchemas = {
  channel: ChatChannelSchema,
  channelMaybe: Schema.NullOr(ChatChannelSchema),
  channelsList: mutableStruct({
    channels: Schema.mutable(Schema.Array(ChatChannelSummarySchema)),
    ...NextCursorFields,
  }),
  wireId: mutableStruct({ wireId: NullableString }),
  threadStart: mutableStruct({
    thread: ChatThreadSchema,
    message: ChatMessageSchema,
  }),
  thread: ChatThreadSchema,
  threadsList: mutableStruct({
    threads: Schema.mutable(Schema.Array(ChatThreadWireRecordSchema)),
    ...NextCursorFields,
  }),
  threadsPage: pageSchema("threads", ChatThreadSchema),
  channelThreadsPage: pageSchema("threads", ChatChannelThreadSummarySchema),
  maybeString: Schema.NullOr(Schema.String),
  projection: ChatProjectionSchema,
  message: ChatMessageSchema,
  messagesList: mutableStruct({
    messages: Schema.mutable(Schema.Array(ChatMessageSchema)),
    nextAfterMessageOrder: NullableNonnegativeInt,
  }),
  readState: ChatThreadReadStateSchema,
  unreadThreads: Schema.mutable(Schema.Array(ChatUnreadFileThreadSchema)),
  decision: ChatDecisionSchema,
  decisionsPage: pageSchema("decisions", ChatDecisionSchema),
  reaction: ChatReactionSchema,
  reactionsPage: pageSchema("reactions", ChatReactionSchema),
  attachmentsPage: pageSchema("attachments", ChatAttachmentSchema),
  fileMentionsPage: pageSchema("mentions", ChatFileMentionSchema),
  mentionsPage: pageSchema("mentions", ChatMentionSchema),
  agentRead: ChatAgentReadStateSchema,
  follow: ChatFollowSchema,
  followsList: mutableStruct({
    follows: Schema.mutable(Schema.Array(ChatFollowSchema)),
    ...NextCursorFields,
  }),
  nullResult: Schema.Null,
  feedReadState: ChatFeedReadStateSchema,
  feedPage: mutableStruct({
    items: Schema.mutable(Schema.Array(ChatFeedItemSchema)),
    ...NextCursorFields,
    headCursor: NullableString,
    readState: Schema.NullOr(ChatFeedReadStateSchema),
  }),
  bookmark: ChatBookmarkSchema,
  bookmarkMaybe: Schema.NullOr(ChatBookmarkSchema),
  bookmarksList: mutableStruct({
    bookmarks: Schema.mutable(Schema.Array(ChatBookmarkSchema)),
    ...NextCursorFields,
  }),
  bookmarksPage: pageSchema("bookmarks", ChatBookmarkSchema),
  bookmarkTransition: BookmarkTransitionSchema,
  enqueue: mutableStruct({ enqueued: Schema.Boolean }),
  count: NonnegativeInt,
  claimMaybe: Schema.NullOr(ChatDispatchClaimSchema),
  dispatchesPage: pageSchema("dispatches", ChatDispatchSchema),
  claimsPage: pageSchema("claims", ChatDispatchClaimSchema),
  runMessagesPage: mutableStruct({
    messageIds: Schema.mutable(Schema.Array(Schema.String)),
    ...NextCursorFields,
  }),
  runMaybe: Schema.NullOr(ChatRunSchema),
  boolean: Schema.Boolean,
  pauseMaybe: Schema.NullOr(ChatThreadPauseSchema),
  pause: ChatThreadPauseSchema,
  run: ChatRunSchema,
  recoveriesPage: pageSchema(
    "recoveries",
    mutableStruct({ run: ChatRunSchema, attemptCount: NonnegativeInt }),
  ),
  complete: mutableStruct({ completed: Schema.Literal(true) }),
  fail: mutableStruct({ failed: Schema.Literal(true) }),
} as const;

const RunRecordsPageSchema = mutableStruct({
  runs: Schema.Record(Schema.String, ChatRunSchema),
  ...NextCursorFields,
});

export function decodeChatActor(value: JsonValue, label = "chat actor"): ChatActor {
  return decodeChatsSchema(ChatActorSchema, value, label) as ChatActor;
}

export function decodeChatThread(value: JsonValue, label = "chat thread"): ChatThread {
  return decodeChatsSchema(ChatThreadSchema, value, label) as ChatThread;
}

export function decodeChatAttachment(
  value: JsonValue,
  label = "chat attachment",
): ChatAttachment {
  return decodeChatsSchema(ChatAttachmentSchema, value, label) as ChatAttachment;
}

export function decodeChatMessage(value: JsonValue, label = "chat message"): ChatMessage {
  return decodeChatsSchema(ChatMessageSchema, value, label) as ChatMessage;
}

export function decodeChatDecision(value: JsonValue, label = "chat decision"): ChatDecision {
  return decodeChatsSchema(ChatDecisionSchema, value, label) as ChatDecision;
}

export function decodeChatReaction(value: JsonValue, label = "chat reaction"): ChatReaction {
  return decodeChatsSchema(ChatReactionSchema, value, label) as ChatReaction;
}

export function decodeChatBookmark(value: JsonValue, label = "chat bookmark"): ChatBookmark {
  return decodeChatsSchema(ChatBookmarkSchema, value, label) as ChatBookmark;
}

export function decodeChatDispatch(value: JsonValue, label = "chat dispatch"): ChatDispatch {
  return decodeChatsSchema(ChatDispatchSchema, value, label) as ChatDispatch;
}

export function decodeChatRun(value: JsonValue, label = "chat run"): ChatRun {
  return decodeChatsSchema(ChatRunSchema, value, label) as ChatRun;
}

export function decodeUnreadFileThreads(
  value: JsonValue,
  label = `${CHATS_METHOD.readStateListUnreadFileThreads} result`,
): ChatUnreadFileThread[] {
  return decodeChatsSchema(
    Schema.mutable(Schema.Array(ChatUnreadFileThreadSchema)),
    value,
    label,
  ) as ChatUnreadFileThread[];
}

function decodeRunRecordsForThread(value: JsonValue, label: string): ChatThreadRunsPage {
  const decoded = decodeChatsSchema(RunRecordsPageSchema, value, label);
  const runs: Record<string, ChatRun> = Object.create(null);
  Object.assign(runs, decoded.runs);
  return { runs, nextCursor: decoded.nextCursor };
}

export function decodeChatsResult<M extends ChatsMethod>(
  method: M,
  value: JsonValue,
): ChatsMethodResultMap[M] {
  const label = `${method} result`;
  let result: unknown;
  switch (method) {
    case CHATS_METHOD.channelCreate:
    case CHATS_METHOD.channelEnsureAgent:
    case CHATS_METHOD.channelEnsureGeneral:
      result = decodeChatsSchema(ChatsResultSchemas.channel, value, label); break;
    case CHATS_METHOD.channelFindBySlug:
      result = decodeChatsSchema(ChatsResultSchemas.channelMaybe, value, label); break;
    case CHATS_METHOD.channelsList:
      result = decodeChatsSchema(ChatsResultSchemas.channelsList, value, label); break;
    case CHATS_METHOD.channelGetWireId:
      result = decodeChatsSchema(ChatsResultSchemas.wireId, value, label); break;
    case CHATS_METHOD.threadStart:
      result = decodeChatsSchema(ChatsResultSchemas.threadStart, value, label); break;
    case CHATS_METHOD.threadCreate:
      result = decodeChatsSchema(ChatsResultSchemas.thread, value, label); break;
    case CHATS_METHOD.threadsList:
      result = decodeChatsSchema(ChatsResultSchemas.threadsList, value, label); break;
    case CHATS_METHOD.threadsListForFile:
    case CHATS_METHOD.agentReadListUnreadThreads:
      result = decodeChatsSchema(ChatsResultSchemas.threadsPage, value, label); break;
    case CHATS_METHOD.threadsListForChannel:
      result = decodeChatsSchema(ChatsResultSchemas.channelThreadsPage, value, label); break;
    case CHATS_METHOD.threadFindChannelId:
    case CHATS_METHOD.dispatchRunIdForMessage:
      result = decodeChatsSchema(ChatsResultSchemas.maybeString, value, label); break;
    case CHATS_METHOD.threadGetProjection:
      result = decodeChatsSchema(ChatsResultSchemas.projection, value, label); break;
    case CHATS_METHOD.messageSend:
      result = decodeChatsSchema(ChatsResultSchemas.message, value, label); break;
    case CHATS_METHOD.messagesList:
      result = decodeChatsSchema(ChatsResultSchemas.messagesList, value, label); break;
    case CHATS_METHOD.readStateGet:
    case CHATS_METHOD.readStateMarkThreadRead:
      result = decodeChatsSchema(ChatsResultSchemas.readState, value, label); break;
    case CHATS_METHOD.readStateListUnreadFileThreads:
      result = decodeChatsSchema(ChatsResultSchemas.unreadThreads, value, label); break;
    case CHATS_METHOD.decisionResolve:
      result = decodeChatsSchema(ChatsResultSchemas.decision, value, label); break;
    case CHATS_METHOD.decisionsListForThread:
      result = decodeChatsSchema(ChatsResultSchemas.decisionsPage, value, label); break;
    case CHATS_METHOD.reactionSet:
      result = decodeChatsSchema(ChatsResultSchemas.reaction, value, label); break;
    case CHATS_METHOD.reactionsList:
      result = decodeChatsSchema(ChatsResultSchemas.reactionsPage, value, label); break;
    case CHATS_METHOD.attachmentsListForThread:
      result = decodeChatsSchema(ChatsResultSchemas.attachmentsPage, value, label); break;
    case CHATS_METHOD.attachmentsListFileMentions:
      result = decodeChatsSchema(ChatsResultSchemas.fileMentionsPage, value, label); break;
    case CHATS_METHOD.mentionsListForHandle:
      result = decodeChatsSchema(ChatsResultSchemas.mentionsPage, value, label); break;
    case CHATS_METHOD.agentReadMarkThreadRead:
      result = decodeChatsSchema(ChatsResultSchemas.agentRead, value, label); break;
    case CHATS_METHOD.followsSet:
      result = decodeChatsSchema(ChatsResultSchemas.follow, value, label); break;
    case CHATS_METHOD.followsList:
      result = decodeChatsSchema(ChatsResultSchemas.followsList, value, label); break;
    case CHATS_METHOD.followsEnsureDefaults:
      result = decodeChatsSchema(ChatsResultSchemas.nullResult, value, label); break;
    case CHATS_METHOD.feedMarkSeen:
      result = decodeChatsSchema(ChatsResultSchemas.feedReadState, value, label); break;
    case CHATS_METHOD.feedListPersonal:
      result = decodeChatsSchema(ChatsResultSchemas.feedPage, value, label); break;
    case CHATS_METHOD.bookmarkSave:
      result = decodeChatsSchema(ChatsResultSchemas.bookmark, value, label); break;
    case CHATS_METHOD.bookmarksList:
      result = decodeChatsSchema(ChatsResultSchemas.bookmarksList, value, label); break;
    case CHATS_METHOD.bookmarkFind:
      result = decodeChatsSchema(ChatsResultSchemas.bookmarkMaybe, value, label); break;
    case CHATS_METHOD.bookmarkListPending:
      result = decodeChatsSchema(ChatsResultSchemas.bookmarksPage, value, label); break;
    case CHATS_METHOD.bookmarkArchive:
    case CHATS_METHOD.bookmarkMarkPending:
      result = decodeChatsSchema(ChatsResultSchemas.bookmark, value, label); break;
    case CHATS_METHOD.bookmarkMarkFailed:
    case CHATS_METHOD.bookmarkMarkStale:
    case CHATS_METHOD.bookmarkMarkReady:
      result = decodeChatsSchema(ChatsResultSchemas.bookmarkTransition, value, label); break;
    case CHATS_METHOD.dispatchEnqueue:
      result = decodeChatsSchema(ChatsResultSchemas.enqueue, value, label); break;
    case CHATS_METHOD.dispatchRecordEligibleTriggers:
    case CHATS_METHOD.dispatchRecentCount:
    case CHATS_METHOD.dispatchFailPendingForThread:
      result = decodeChatsSchema(ChatsResultSchemas.count, value, label); break;
    case CHATS_METHOD.dispatchClaimNextPending:
      result = decodeChatsSchema(ChatsResultSchemas.claimMaybe, value, label); break;
    case CHATS_METHOD.dispatchListPending:
      result = decodeChatsSchema(ChatsResultSchemas.dispatchesPage, value, label); break;
    case CHATS_METHOD.dispatchOpenRuns:
      result = decodeChatsSchema(ChatsResultSchemas.claimsPage, value, label); break;
    case CHATS_METHOD.dispatchListRunMessages:
      result = decodeChatsSchema(ChatsResultSchemas.runMessagesPage, value, label); break;
    case CHATS_METHOD.dispatchRunRecordsForThread:
      result = decodeRunRecordsForThread(value, label); break;
    case CHATS_METHOD.dispatchGetRunRecord:
      result = decodeChatsSchema(ChatsResultSchemas.runMaybe, value, label); break;
    case CHATS_METHOD.dispatchIsThreadPaused:
    case CHATS_METHOD.dispatchRecordRunMessage:
    case CHATS_METHOD.dispatchRequeueFailedTrigger:
      result = decodeChatsSchema(ChatsResultSchemas.boolean, value, label); break;
    case CHATS_METHOD.dispatchGetThreadPauseState:
      result = decodeChatsSchema(ChatsResultSchemas.pauseMaybe, value, label); break;
    case CHATS_METHOD.dispatchSetThreadPaused:
      result = decodeChatsSchema(ChatsResultSchemas.pause, value, label); break;
    case CHATS_METHOD.dispatchMarkFailureNotePosted:
      result = decodeChatsSchema(ChatsResultSchemas.run, value, label); break;
    case CHATS_METHOD.dispatchListAppQuitRecoveries:
      result = decodeChatsSchema(ChatsResultSchemas.recoveriesPage, value, label); break;
    case CHATS_METHOD.dispatchComplete:
      result = decodeChatsSchema(ChatsResultSchemas.complete, value, label); break;
    case CHATS_METHOD.dispatchFail:
      result = decodeChatsSchema(ChatsResultSchemas.fail, value, label); break;
    default: {
      const exhaustive: never = method;
      throw new ChatsProtocolShapeError(`Unsupported chats method: ${exhaustive}`);
    }
  }
  return result as ChatsMethodResultMap[M];
}
