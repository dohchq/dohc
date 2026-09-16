import { ProtocolShapeError, mutableStruct } from "../wireSchema";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import type { JsonValue } from "../protocol";

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
  threadRevision: "chats.threads.revision",
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
type ChatPageParams = ChatsJsonObject & {
  pageLimit?: number;
  cursor?: string;
};

export type ChatActor = typeof ChatActorSchema.Type;

export type ChatThread = typeof ChatThreadSchema.Type;
export type ChatAttachment = typeof ChatAttachmentSchema.Type;
export type ChatLocalAttachmentParams = ChatsJsonObject & {
  objectId: string;
  pathHint?: string;
  headingText?: string;
  headingAnchor?: string;
  headingOccurrence?: number;
};
export type ChatMessage = typeof ChatMessageSchema.Type;
export type ChatDecision = typeof ChatDecisionSchema.Type;
export type ChatReactionAuthor = typeof ChatReactionAuthorSchema.Type;
export type ChatReaction = typeof ChatReactionSchema.Type;
export type ChatBookmark = typeof ChatBookmarkSchema.Type;
export type ChatBookmarkTransition = typeof BookmarkTransitionSchema.Type;
export type ChatDispatch = typeof ChatDispatchSchema.Type;
export type ChatRun = typeof ChatRunSchema.Type;
export type ChatDispatchClaim = typeof ChatDispatchClaimSchema.Type;
export type ChatThreadPause = typeof ChatThreadPauseSchema.Type;
export type ChatAgentReadState = typeof ChatAgentReadStateSchema.Type;
export type ChatMention = typeof ChatMentionSchema.Type;
export type ChatChannel = typeof ChatChannelSchema.Type;
export type ChatChannelSummary = typeof ChatChannelSummarySchema.Type;
export type ChatThreadWireRecord = typeof ChatThreadWireRecordSchema.Type;
export type ChatThreadReadState = typeof ChatThreadReadStateSchema.Type;
export type ChatUnreadFileThread = typeof ChatUnreadFileThreadSchema.Type;
export type ChatFollow = typeof ChatFollowSchema.Type;
export type ChatFileMention = typeof ChatFileMentionSchema.Type;

export type ChatChannelThreadSummary =
  typeof ChatChannelThreadSummarySchema.Type;
export type ChatProjection = typeof ChatProjectionSchema.Type;
export type ChatProjectionFileAccess =
  | (ChatsJsonObject & { kind: "allowed"; path: string })
  | (ChatsJsonObject & { kind: "denied" | "unknown" });
export type ChatFeedReadState = typeof ChatFeedReadStateSchema.Type;

export type ChatFeedItem = typeof ChatFeedItemSchema.Type;

type ChatChannelGetWireIdParams = ChatsJsonObject & { channelId: string };
type ChatChannelCreateParams = ChatsJsonObject & {
  channelId: string;
  name: string;
  kind: "channel" | "dm" | "agent";
  type?: "posts" | "chat" | "both";
  purpose?: string;
  folderPath?: string;
  nowMs?: number;
};
type ChatChannelEnsureParams = ChatsJsonObject & {
  channelId: string;
  nowMs?: number;
};
type ChatChannelFindBySlugParams = ChatsJsonObject & { slug: string };

type ChatThreadStartParams = ChatsJsonObject & {
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
type ChatThreadCreateParams = ChatsJsonObject & {
  threadId: string;
  title: string;
  linkedFile: ChatsJsonObject & { objectId: string; pathHint?: string };
  nowMs?: number;
};
type ChatThreadsListForFileParams = ChatPageParams & { objectId: string };
type ChatThreadsListForChannelParams = ChatPageParams & { channelId: string };
type ChatThreadParams = ChatsJsonObject & { threadId: string };
type ChatThreadProjectionParams = ChatThreadParams & {
  linkedFileAccess?: ChatProjectionFileAccess;
};
type ChatMessageSendParams = ChatsJsonObject & {
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
type ChatMessagesListParams = ChatsJsonObject & {
  threadId: string;
  limit?: number;
  afterMessageOrder?: number;
};
type ChatReadStateMarkParams = ChatsJsonObject & {
  threadId: string;
  upToSequence: number;
  expectedRevision?: number;
  nowMs?: number;
};
type ChatUnreadFileThreadsParams = ChatsJsonObject & {
  pageLimit?: number;
  afterThreadId?: string;
};
type ChatDecisionResolveParams = ChatsJsonObject & {
  threadId: string;
  messageId: string;
  resolvedByMessageId: string;
  nowMs?: number;
};
type ChatReactionSetParams = ChatsJsonObject & {
  threadId: string;
  messageId: string;
  emoji: string;
  author: ChatReactionAuthor;
  replicationAuthorId?: string;
  state: "added" | "removed";
  nowMs?: number;
};
type ChatThreadPageParams = ChatPageParams & { threadId: string };
type ChatFileMentionsParams = ChatPageParams & {
  objectId?: string;
  pathHint?: string;
};
type ChatMentionsParams = ChatPageParams & {
  handle: string;
  unreadByAgentOnly?: boolean;
};
type ChatAgentReadMarkParams = ChatsJsonObject & {
  threadId: string;
  upTo: ChatsJsonObject & { createdAtMs: number; messageId: string };
  expectedRevision?: number;
};
type ChatOwnerParams = ChatsJsonObject & { ownerUserId: string };
type ChatFollowSetParams = ChatsJsonObject & {
  ownerUserId: string;
  replicationOwnerUserId?: string;
  targetKind: "person" | "agent" | "channel" | "thread";
  targetId: string;
  state: "following" | "unfollowed";
  nowMs?: number;
};
type ChatFollowListParams = ChatOwnerParams &
  ChatPageParams & {
    state?: "following" | "unfollowed";
  };
type ChatFeedMarkSeenParams = ChatOwnerParams & {
  replicationOwnerUserId?: string;
  headCursor: string;
  nowMs?: number;
};
type ChatFeedListParams = ChatsJsonObject & {
  ownerUserId: string;
  limit?: number;
  cursor?: string;
};
type ChatBookmarkFindParams = ChatsJsonObject & {
  ownerUserId: string;
  bookmarkId: string;
};
type ChatBookmarkSaveParams = ChatOwnerParams & {
  targetKind: "message" | "thread";
  targetId: string;
  mode: "live" | "snapshot";
  destinationPath: string;
  nowMs?: number;
};
type ChatBookmarksListParams = ChatOwnerParams &
  ChatPageParams & {
    state?: "active" | "archived";
  };
type ChatBookmarkListPendingParams = ChatPageParams & {
  ownerUserId: string;
  limit?: number;
};
type ChatBookmarkGenerationParams = ChatBookmarkFindParams & {
  generation: number;
};
type ChatBookmarkMarkReadyParams = ChatBookmarkGenerationParams & {
  projectedAtMs?: number;
  projectionObjectId?: string;
  projectionPath?: string;
};
type ChatBookmarkMarkFailedParams = ChatBookmarkGenerationParams & {
  failureReason: string;
};
type ChatBookmarkMarkStaleParams = ChatBookmarkGenerationParams & {
  failureReason?: string;
};
type ChatDispatchRecordEligibleParams = ChatsJsonObject & {
  verifiedUserId?: string;
};
type ChatDispatchEnqueueParams = ChatsJsonObject & {
  triggerMessageId: string;
  threadId: string;
  nowMs?: number;
};
type ChatDispatchClaimParams = ChatsJsonObject & {
  runId: string;
  command?: string;
  logPath?: string;
  nowMs?: number;
};
type ChatDispatchRunPageParams = ChatPageParams & { runId: string };
type ChatDispatchMessageParams = ChatsJsonObject & { messageId: string };
type ChatDispatchThreadRunsParams = ChatPageParams & {
  threadId: string;
  limit?: number;
};
type ChatDispatchRunParams = ChatsJsonObject & { runId: string };
type ChatDispatchRecentCountParams = ChatsJsonObject & {
  threadId: string;
  sinceMs: number;
};
type ChatDispatchFailPendingParams = ChatsJsonObject & {
  threadId: string;
  reason: string;
};
type ChatDispatchRecordRunMessageParams = ChatsJsonObject & {
  messageId: string;
  runId: string;
};
type ChatDispatchSetPausedParams = ChatsJsonObject & {
  threadId: string;
  paused: boolean;
  reason?: string;
};
type ChatDispatchRequeueParams = ChatsJsonObject & {
  triggerMessageId: string;
  runId: string;
};
type ChatDispatchCompleteParams = ChatsJsonObject & {
  runId: string;
  exitCode: number;
  nowMs?: number;
};
type ChatDispatchFailParams = ChatsJsonObject & {
  runId: string;
  reason: string;
  exitCode?: number;
  nowMs?: number;
};

export type ChatRunMessagesPage =
  ChatsMethodResultMap[typeof CHATS_METHOD.dispatchListRunMessages];
type ChatThreadRunsPage = typeof RunRecordsPageSchema.Type;
export type ChatRecoveriesPage =
  ChatsMethodResultMap[typeof CHATS_METHOD.dispatchListAppQuitRecoveries];
export type ChatFeedPage =
  ChatsMethodResultMap[typeof CHATS_METHOD.feedListPersonal];

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
  [CHATS_METHOD.threadRevision]: ChatThreadParams;
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
  [M in ChatsMethod]: (typeof ChatsResultSchemas)[M]["Type"];
};

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
    const path =
      issue?.path
        ?.map((part) =>
          typeof part === "number" ? `[${part}]` : `.${String(part)}`,
        )
        .join("") ?? "";
    throw new ProtocolShapeError(
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
const ChannelTypeSchema = Schema.Literals(["posts", "chat", "both"]);
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
  type: ChannelTypeSchema,
  purpose: Schema.String,
  folderPath: Schema.optional(Schema.String),
  createdAtMs: AnyInt,
  updatedAtMs: AnyInt,
});
const ChatChannelSummarySchema = mutableStruct({
  workspaceId: Schema.String,
  channelId: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  kind: ChannelKindSchema,
  type: ChannelTypeSchema,
  purpose: Schema.String,
  folderPath: Schema.optional(Schema.String),
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

function pageSchema<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  return mutableStruct({
    ...fields,
    ...NextCursorFields,
  });
}

const RunRecordsPageSchema = pageSchema({
  runs: Schema.Record(Schema.String, Schema.mutableKey(ChatRunSchema)),
});

const ThreadsPageSchema = pageSchema({
  threads: Schema.mutable(Schema.Array(ChatThreadSchema)),
});

const ChatsResultSchemas = {
  [CHATS_METHOD.channelCreate]: ChatChannelSchema,
  [CHATS_METHOD.channelEnsureAgent]: ChatChannelSchema,
  [CHATS_METHOD.channelEnsureGeneral]: ChatChannelSchema,
  [CHATS_METHOD.channelFindBySlug]: Schema.NullOr(ChatChannelSchema),
  [CHATS_METHOD.channelsList]: pageSchema({
    channels: Schema.mutable(Schema.Array(ChatChannelSummarySchema)),
  }),
  [CHATS_METHOD.channelGetWireId]: mutableStruct({ wireId: NullableString }),
  [CHATS_METHOD.threadStart]: mutableStruct({
    thread: ChatThreadSchema,
    message: ChatMessageSchema,
  }),
  [CHATS_METHOD.threadCreate]: ChatThreadSchema,
  [CHATS_METHOD.threadsList]: pageSchema({
    threads: Schema.mutable(Schema.Array(ChatThreadWireRecordSchema)),
  }),
  [CHATS_METHOD.threadsListForFile]: ThreadsPageSchema,
  [CHATS_METHOD.threadsListForChannel]: pageSchema({
    threads: Schema.mutable(Schema.Array(ChatChannelThreadSummarySchema)),
  }),
  [CHATS_METHOD.threadFindChannelId]: Schema.NullOr(Schema.String),
  [CHATS_METHOD.threadGetProjection]: ChatProjectionSchema,
  [CHATS_METHOD.threadRevision]: mutableStruct({ revision: NonnegativeInt }),
  [CHATS_METHOD.messageSend]: ChatMessageSchema,
  [CHATS_METHOD.messagesList]: mutableStruct({
    messages: Schema.mutable(Schema.Array(ChatMessageSchema)),
    nextAfterMessageOrder: NullableNonnegativeInt,
  }),
  [CHATS_METHOD.readStateGet]: ChatThreadReadStateSchema,
  [CHATS_METHOD.readStateMarkThreadRead]: ChatThreadReadStateSchema,
  [CHATS_METHOD.readStateListUnreadFileThreads]: Schema.mutable(
    Schema.Array(ChatUnreadFileThreadSchema),
  ),
  [CHATS_METHOD.decisionResolve]: ChatDecisionSchema,
  [CHATS_METHOD.decisionsListForThread]: pageSchema({
    decisions: Schema.mutable(Schema.Array(ChatDecisionSchema)),
  }),
  [CHATS_METHOD.reactionSet]: ChatReactionSchema,
  [CHATS_METHOD.reactionsList]: pageSchema({
    reactions: Schema.mutable(Schema.Array(ChatReactionSchema)),
  }),
  [CHATS_METHOD.attachmentsListForThread]: pageSchema({
    attachments: Schema.mutable(Schema.Array(ChatAttachmentSchema)),
  }),
  [CHATS_METHOD.attachmentsListFileMentions]: pageSchema({
    mentions: Schema.mutable(Schema.Array(ChatFileMentionSchema)),
  }),
  [CHATS_METHOD.mentionsListForHandle]: pageSchema({
    mentions: Schema.mutable(Schema.Array(ChatMentionSchema)),
  }),
  [CHATS_METHOD.agentReadListUnreadThreads]: ThreadsPageSchema,
  [CHATS_METHOD.agentReadMarkThreadRead]: ChatAgentReadStateSchema,
  [CHATS_METHOD.followsSet]: ChatFollowSchema,
  [CHATS_METHOD.followsList]: pageSchema({
    follows: Schema.mutable(Schema.Array(ChatFollowSchema)),
  }),
  [CHATS_METHOD.followsEnsureDefaults]: Schema.Null,
  [CHATS_METHOD.feedMarkSeen]: ChatFeedReadStateSchema,
  [CHATS_METHOD.feedListPersonal]: mutableStruct({
    items: Schema.mutable(Schema.Array(ChatFeedItemSchema)),
    ...NextCursorFields,
    headCursor: NullableString,
    readState: Schema.NullOr(ChatFeedReadStateSchema),
  }),
  [CHATS_METHOD.bookmarkSave]: ChatBookmarkSchema,
  [CHATS_METHOD.bookmarksList]: pageSchema({
    bookmarks: Schema.mutable(Schema.Array(ChatBookmarkSchema)),
  }),
  [CHATS_METHOD.bookmarkFind]: Schema.NullOr(ChatBookmarkSchema),
  [CHATS_METHOD.bookmarkListPending]: pageSchema({
    bookmarks: Schema.mutable(Schema.Array(ChatBookmarkSchema)),
  }),
  [CHATS_METHOD.bookmarkMarkReady]: BookmarkTransitionSchema,
  [CHATS_METHOD.bookmarkArchive]: ChatBookmarkSchema,
  [CHATS_METHOD.bookmarkMarkPending]: ChatBookmarkSchema,
  [CHATS_METHOD.bookmarkMarkFailed]: BookmarkTransitionSchema,
  [CHATS_METHOD.bookmarkMarkStale]: BookmarkTransitionSchema,
  [CHATS_METHOD.dispatchEnqueue]: mutableStruct({ enqueued: Schema.Boolean }),
  [CHATS_METHOD.dispatchRecordEligibleTriggers]: NonnegativeInt,
  [CHATS_METHOD.dispatchClaimNextPending]: Schema.NullOr(
    ChatDispatchClaimSchema,
  ),
  [CHATS_METHOD.dispatchListPending]: pageSchema({
    dispatches: Schema.mutable(Schema.Array(ChatDispatchSchema)),
  }),
  [CHATS_METHOD.dispatchOpenRuns]: pageSchema({
    claims: Schema.mutable(Schema.Array(ChatDispatchClaimSchema)),
  }),
  [CHATS_METHOD.dispatchListRunMessages]: pageSchema({
    messageIds: Schema.mutable(Schema.Array(Schema.String)),
  }),
  [CHATS_METHOD.dispatchRunIdForMessage]: Schema.NullOr(Schema.String),
  [CHATS_METHOD.dispatchRunRecordsForThread]: RunRecordsPageSchema,
  [CHATS_METHOD.dispatchGetRunRecord]: Schema.NullOr(ChatRunSchema),
  [CHATS_METHOD.dispatchIsThreadPaused]: Schema.Boolean,
  [CHATS_METHOD.dispatchGetThreadPauseState]: Schema.NullOr(
    ChatThreadPauseSchema,
  ),
  [CHATS_METHOD.dispatchRecentCount]: NonnegativeInt,
  [CHATS_METHOD.dispatchFailPendingForThread]: NonnegativeInt,
  [CHATS_METHOD.dispatchRecordRunMessage]: Schema.Boolean,
  [CHATS_METHOD.dispatchSetThreadPaused]: ChatThreadPauseSchema,
  [CHATS_METHOD.dispatchMarkFailureNotePosted]: ChatRunSchema,
  [CHATS_METHOD.dispatchRequeueFailedTrigger]: Schema.Boolean,
  [CHATS_METHOD.dispatchListAppQuitRecoveries]: pageSchema({
    recoveries: Schema.mutable(
      Schema.Array(
        mutableStruct({ run: ChatRunSchema, attemptCount: NonnegativeInt }),
      ),
    ),
  }),
  [CHATS_METHOD.dispatchComplete]: mutableStruct({
    completed: Schema.Literal(true),
  }),
  [CHATS_METHOD.dispatchFail]: mutableStruct({ failed: Schema.Literal(true) }),
} as const;

export function decodeChatThread(
  value: JsonValue,
  label = "chat thread",
): ChatThread {
  return decodeChatsSchema(ChatThreadSchema, value, label);
}

export function decodeChatAttachment(
  value: JsonValue,
  label = "chat attachment",
): ChatAttachment {
  return decodeChatsSchema(ChatAttachmentSchema, value, label);
}

export function decodeChatMessage(
  value: JsonValue,
  label = "chat message",
): ChatMessage {
  return decodeChatsSchema(ChatMessageSchema, value, label);
}

export function decodeChatDecision(
  value: JsonValue,
  label = "chat decision",
): ChatDecision {
  return decodeChatsSchema(ChatDecisionSchema, value, label);
}

export function decodeChatReaction(
  value: JsonValue,
  label = "chat reaction",
): ChatReaction {
  return decodeChatsSchema(ChatReactionSchema, value, label);
}

function decodeRunRecordsForThread(
  value: JsonValue,
  label: string,
): ChatThreadRunsPage {
  const decoded = decodeChatsSchema(RunRecordsPageSchema, value, label);
  const runs: Record<string, ChatRun> = Object.create(null);
  Object.assign(runs, decoded.runs);
  return { runs, nextCursor: decoded.nextCursor };
}

export function decodeChatsResult<M extends ChatsMethod>(
  method: M,
  value: JsonValue,
): ChatsMethodResultMap[M] {
  if (!Object.hasOwn(ChatsResultSchemas, method)) {
    throw new ProtocolShapeError(`Unsupported chats method: ${method}`);
  }
  const schema = ChatsResultSchemas[method];
  const label = `${method} result`;
  if (method === CHATS_METHOD.dispatchRunRecordsForThread) {
    return decodeRunRecordsForThread(value, label) as ChatsMethodResultMap[M];
  }
  return decodeChatsSchema(schema, value, label) as ChatsMethodResultMap[M];
}
