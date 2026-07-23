import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";

export const CHATS_METHOD = {
  channelGetWireId: "chats.channels.getWireId",
  threadStart: "chats.threads.start",
  threadCreate: "chats.threads.create",
  threadsListForFile: "chats.threads.listForFile",
  threadsListForChannel: "chats.threads.listForChannel",
  threadFindChannelId: "chats.threads.findChannelId",
  threadGetProjection: "chats.threads.getProjection",
  messageSend: "chats.messages.send",
  decisionResolve: "chats.decisions.resolve",
  decisionsListForThread: "chats.decisions.listForThread",
  reactionSet: "chats.reactions.set",
  reactionsList: "chats.reactions.list",
  attachmentsListForThread: "chats.attachments.listForThread",
  attachmentsListFileMentions: "chats.attachments.listFileMentions",
  mentionsListForHandle: "chats.mentions.listForHandle",
  agentReadListUnreadThreads: "chats.agentReadState.listUnreadThreads",
  agentReadMarkThreadRead: "chats.agentReadState.markThreadRead",
  followsEnsureDefaults: "chats.follows.ensureDefaults",
  feedListPersonal: "chats.feed.listPersonal",
  bookmarkFind: "chats.bookmarks.find",
  bookmarkListPending: "chats.bookmarks.listPending",
  bookmarkArchive: "chats.bookmarks.archive",
  bookmarkMarkPending: "chats.bookmarks.markPending",
  bookmarkMarkFailed: "chats.bookmarks.markFailed",
  bookmarkMarkStale: "chats.bookmarks.markStale",
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
export type ChatFeedListParams = ChatsJsonObject & {
  ownerUserId: string;
  limit?: number;
  cursor?: string;
};
export type ChatBookmarkFindParams = ChatsJsonObject & {
  ownerUserId: string;
  bookmarkId: string;
};
export type ChatBookmarkListPendingParams = ChatPageParams & {
  ownerUserId: string;
  limit?: number;
};
export type ChatBookmarkGenerationParams = ChatBookmarkFindParams & { generation: number };
export type ChatBookmarkMarkFailedParams = ChatBookmarkGenerationParams & {
  failureReason: string;
};
export type ChatBookmarkMarkStaleParams = ChatBookmarkGenerationParams & {
  failureReason?: string;
};
export type ChatDispatchRecordEligibleParams = ChatsJsonObject & { verifiedUserId?: string };
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

export type ChatThreadStartResult = ChatsJsonObject & {
  thread: ChatThread;
  message: ChatMessage;
};
export type ChatWireIdResult = ChatsJsonObject & { wireId: string | null };
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
  [CHATS_METHOD.channelGetWireId]: ChatChannelGetWireIdParams;
  [CHATS_METHOD.threadStart]: ChatThreadStartParams;
  [CHATS_METHOD.threadCreate]: ChatThreadCreateParams;
  [CHATS_METHOD.threadsListForFile]: ChatThreadsListForFileParams;
  [CHATS_METHOD.threadsListForChannel]: ChatThreadsListForChannelParams;
  [CHATS_METHOD.threadFindChannelId]: ChatThreadParams;
  [CHATS_METHOD.threadGetProjection]: ChatThreadProjectionParams;
  [CHATS_METHOD.messageSend]: ChatMessageSendParams;
  [CHATS_METHOD.decisionResolve]: ChatDecisionResolveParams;
  [CHATS_METHOD.decisionsListForThread]: ChatThreadPageParams;
  [CHATS_METHOD.reactionSet]: ChatReactionSetParams;
  [CHATS_METHOD.reactionsList]: ChatThreadPageParams;
  [CHATS_METHOD.attachmentsListForThread]: ChatThreadPageParams;
  [CHATS_METHOD.attachmentsListFileMentions]: ChatFileMentionsParams;
  [CHATS_METHOD.mentionsListForHandle]: ChatMentionsParams;
  [CHATS_METHOD.agentReadListUnreadThreads]: ChatPageParams;
  [CHATS_METHOD.agentReadMarkThreadRead]: ChatAgentReadMarkParams;
  [CHATS_METHOD.followsEnsureDefaults]: ChatOwnerParams;
  [CHATS_METHOD.feedListPersonal]: ChatFeedListParams;
  [CHATS_METHOD.bookmarkFind]: ChatBookmarkFindParams;
  [CHATS_METHOD.bookmarkListPending]: ChatBookmarkListPendingParams;
  [CHATS_METHOD.bookmarkArchive]: ChatBookmarkFindParams;
  [CHATS_METHOD.bookmarkMarkPending]: ChatBookmarkFindParams;
  [CHATS_METHOD.bookmarkMarkFailed]: ChatBookmarkMarkFailedParams;
  [CHATS_METHOD.bookmarkMarkStale]: ChatBookmarkMarkStaleParams;
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
};

export type ChatsMethodResultMap = {
  [CHATS_METHOD.channelGetWireId]: ChatWireIdResult;
  [CHATS_METHOD.threadStart]: ChatThreadStartResult;
  [CHATS_METHOD.threadCreate]: ChatThread;
  [CHATS_METHOD.threadsListForFile]: ChatThreadsPage;
  [CHATS_METHOD.threadsListForChannel]: ChatChannelThreadsPage;
  [CHATS_METHOD.threadFindChannelId]: string | null;
  [CHATS_METHOD.threadGetProjection]: ChatProjection;
  [CHATS_METHOD.messageSend]: ChatMessage;
  [CHATS_METHOD.decisionResolve]: ChatDecision;
  [CHATS_METHOD.decisionsListForThread]: ChatDecisionsPage;
  [CHATS_METHOD.reactionSet]: ChatReaction;
  [CHATS_METHOD.reactionsList]: ChatReactionsPage;
  [CHATS_METHOD.attachmentsListForThread]: ChatAttachmentsPage;
  [CHATS_METHOD.attachmentsListFileMentions]: ChatFileMentionsPage;
  [CHATS_METHOD.mentionsListForHandle]: ChatMentionsPage;
  [CHATS_METHOD.agentReadListUnreadThreads]: ChatThreadsPage;
  [CHATS_METHOD.agentReadMarkThreadRead]: ChatAgentReadState;
  [CHATS_METHOD.followsEnsureDefaults]: null;
  [CHATS_METHOD.feedListPersonal]: ChatFeedPage;
  [CHATS_METHOD.bookmarkFind]: ChatBookmark | null;
  [CHATS_METHOD.bookmarkListPending]: ChatBookmarksPage;
  [CHATS_METHOD.bookmarkArchive]: ChatBookmark;
  [CHATS_METHOD.bookmarkMarkPending]: ChatBookmark;
  [CHATS_METHOD.bookmarkMarkFailed]: ChatBookmarkTransition;
  [CHATS_METHOD.bookmarkMarkStale]: ChatBookmarkTransition;
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
};

export class ChatsProtocolShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatsProtocolShapeError";
  }
}

function objectValue(value: JsonValue, label: string, keys?: readonly string[]): ChatsJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ChatsProtocolShapeError(`${label} must be a JSON object.`);
  }
  if (keys) {
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) {
        throw new ChatsProtocolShapeError(`${label}.${key} is not allowed.`);
      }
    }
  }
  return value;
}

function stringValue(object: ChatsJsonObject, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new ChatsProtocolShapeError(`${label}.${key} must be a string.`);
  }
  return value;
}

function optionalString(object: ChatsJsonObject, key: string, label: string): string | undefined {
  if (object[key] === undefined) return undefined;
  return stringValue(object, key, label);
}

function nullableString(object: ChatsJsonObject, key: string, label: string): string | null {
  const value = object[key];
  if (value !== null && typeof value !== "string") {
    throw new ChatsProtocolShapeError(`${label}.${key} must be a string or null.`);
  }
  return value;
}

function safeInteger(
  object: ChatsJsonObject,
  key: string,
  label: string,
  nonnegative = true,
): number {
  const value = object[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (nonnegative && value < 0)
  ) {
    throw new ChatsProtocolShapeError(
      `${label}.${key} must be a ${nonnegative ? "nonnegative " : ""}safe integer.`,
    );
  }
  return value;
}

function optionalInteger(
  object: ChatsJsonObject,
  key: string,
  label: string,
  nonnegative = true,
): number | undefined {
  if (object[key] === undefined) return undefined;
  return safeInteger(object, key, label, nonnegative);
}

function booleanValue(object: ChatsJsonObject, key: string, label: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new ChatsProtocolShapeError(`${label}.${key} must be a boolean.`);
  }
  return value;
}

function arrayValue(object: ChatsJsonObject, key: string, label: string): JsonValue[] {
  const value = object[key];
  if (!Array.isArray(value)) {
    throw new ChatsProtocolShapeError(`${label}.${key} must be an array.`);
  }
  return value;
}

function enumValue<T extends string>(
  object: ChatsJsonObject,
  key: string,
  label: string,
  values: readonly T[],
): T {
  const value = object[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ChatsProtocolShapeError(`${label}.${key} is invalid.`);
  }
  return value as T;
}

function cursorValue(object: ChatsJsonObject, label: string): string | null {
  return nullableString(object, "nextCursor", label);
}

export function decodeChatActor(value: JsonValue, label = "chat actor"): ChatActor {
  const object = objectValue(value, label, ["kind", "displayName"]);
  return {
    kind: enumValue(object, "kind", label, ["human", "agent"]),
    displayName: stringValue(object, "displayName", label),
  };
}

export function decodeChatThread(value: JsonValue, label = "chat thread"): ChatThread {
  const object = objectValue(value, label, [
    "id", "workspaceId", "title", "createdAtMs", "updatedAtMs", "linkedFile", "channelId",
  ]);
  const result: ChatThread = {
    id: stringValue(object, "id", label),
    workspaceId: stringValue(object, "workspaceId", label),
    title: stringValue(object, "title", label),
    createdAtMs: safeInteger(object, "createdAtMs", label),
    updatedAtMs: safeInteger(object, "updatedAtMs", label),
  };
  if (object.channelId !== undefined) result.channelId = stringValue(object, "channelId", label);
  if (object.linkedFile !== undefined) {
    const linkedLabel = `${label}.linkedFile`;
    const linked = objectValue(object.linkedFile, linkedLabel, [
      "objectId", "pathHint", "linkedAtMs",
    ]);
    result.linkedFile = {
      objectId: stringValue(linked, "objectId", linkedLabel),
      linkedAtMs: safeInteger(linked, "linkedAtMs", linkedLabel),
    };
    const pathHint = optionalString(linked, "pathHint", linkedLabel);
    if (pathHint !== undefined) result.linkedFile.pathHint = pathHint;
  }
  return result;
}

export function decodeChatAttachment(
  value: JsonValue,
  label = "chat attachment",
): ChatAttachment {
  const object = objectValue(value, label, [
    "attachmentId", "threadId", "messageId", "targetKind", "objectId", "pathHint",
    "headingText", "headingAnchor", "headingOccurrence", "createdAtMs",
  ]);
  const result: ChatAttachment = {
    attachmentId: stringValue(object, "attachmentId", label),
    threadId: stringValue(object, "threadId", label),
    messageId: stringValue(object, "messageId", label),
    targetKind: enumValue(object, "targetKind", label, ["file"]),
    createdAtMs: safeInteger(object, "createdAtMs", label),
  };
  for (const key of ["objectId", "pathHint", "headingText", "headingAnchor"] as const) {
    const field = optionalString(object, key, label);
    if (field !== undefined) result[key] = field;
  }
  const occurrence = optionalInteger(object, "headingOccurrence", label);
  if (occurrence !== undefined) result.headingOccurrence = occurrence;
  return result;
}

export function decodeChatMessage(value: JsonValue, label = "chat message"): ChatMessage {
  const object = objectValue(value, label, [
    "id", "workspaceId", "threadId", "author", "authorUserId", "parentMessageId",
    "origin", "body", "createdAtMs", "attachments",
  ]);
  const result: ChatMessage = {
    id: stringValue(object, "id", label),
    workspaceId: stringValue(object, "workspaceId", label),
    threadId: stringValue(object, "threadId", label),
    author: decodeChatActor(object.author ?? null, `${label}.author`),
    body: stringValue(object, "body", label),
    createdAtMs: safeInteger(object, "createdAtMs", label),
    attachments: arrayValue(object, "attachments", label).map((entry, index) =>
      decodeChatAttachment(entry, `${label}.attachments[${index}]`)),
  };
  for (const key of ["authorUserId", "parentMessageId"] as const) {
    const field = optionalString(object, key, label);
    if (field !== undefined) result[key] = field;
  }
  if (object.origin !== undefined) {
    result.origin = enumValue(object, "origin", label, ["cli"] as const);
  }
  return result;
}

export function decodeChatDecision(value: JsonValue, label = "chat decision"): ChatDecision {
  const object = objectValue(value, label, [
    "threadId", "messageId", "state", "resolvedByMessageId", "atMs",
  ]);
  const result: ChatDecision = {
    threadId: stringValue(object, "threadId", label),
    messageId: stringValue(object, "messageId", label),
    state: enumValue(object, "state", label, ["open", "resolved"]),
    atMs: safeInteger(object, "atMs", label),
  };
  const resolved = optionalString(object, "resolvedByMessageId", label);
  if (resolved !== undefined) result.resolvedByMessageId = resolved;
  return result;
}

export function decodeChatReaction(value: JsonValue, label = "chat reaction"): ChatReaction {
  const object = objectValue(value, label, [
    "reactionId", "threadId", "messageId", "emoji", "author", "state", "atMs",
  ]);
  const authorLabel = `${label}.author`;
  const author = objectValue(object.author ?? null, authorLabel, [
    "authorId", "kind", "displayName",
  ]);
  return {
    reactionId: stringValue(object, "reactionId", label),
    threadId: stringValue(object, "threadId", label),
    messageId: stringValue(object, "messageId", label),
    emoji: stringValue(object, "emoji", label),
    author: {
      authorId: stringValue(author, "authorId", authorLabel),
      kind: enumValue(author, "kind", authorLabel, ["human", "agent"]),
      displayName: stringValue(author, "displayName", authorLabel),
    },
    state: enumValue(object, "state", label, ["added", "removed"]),
    atMs: safeInteger(object, "atMs", label),
  };
}

export function decodeChatBookmark(value: JsonValue, label = "chat bookmark"): ChatBookmark {
  const object = objectValue(value, label, [
    "bookmarkId", "workspaceId", "ownerUserId", "targetKind", "targetId", "threadId",
    "messageId", "mode", "destinationPath", "state", "generation", "projectedGeneration",
    "projectionState", "projectionObjectId", "createdAtMs", "updatedAtMs",
    "lastProjectedAtMs", "failureReason",
  ]);
  const result: ChatBookmark = {
    bookmarkId: stringValue(object, "bookmarkId", label),
    workspaceId: stringValue(object, "workspaceId", label),
    ownerUserId: stringValue(object, "ownerUserId", label),
    targetKind: enumValue(object, "targetKind", label, ["message", "thread"]),
    targetId: stringValue(object, "targetId", label),
    threadId: stringValue(object, "threadId", label),
    mode: enumValue(object, "mode", label, ["live", "snapshot"]),
    destinationPath: stringValue(object, "destinationPath", label),
    state: enumValue(object, "state", label, ["active", "archived"]),
    generation: safeInteger(object, "generation", label),
    projectedGeneration: safeInteger(object, "projectedGeneration", label),
    projectionState: enumValue(object, "projectionState", label, [
      "pending", "ready", "failed", "stale",
    ]),
    createdAtMs: safeInteger(object, "createdAtMs", label),
    updatedAtMs: safeInteger(object, "updatedAtMs", label),
  };
  for (const key of ["messageId", "projectionObjectId", "failureReason"] as const) {
    const field = optionalString(object, key, label);
    if (field !== undefined) result[key] = field;
  }
  const projectedAt = optionalInteger(object, "lastProjectedAtMs", label);
  if (projectedAt !== undefined) result.lastProjectedAtMs = projectedAt;
  return result;
}

export function decodeChatDispatch(value: JsonValue, label = "chat dispatch"): ChatDispatch {
  const object = objectValue(value, label, [
    "workspaceId", "triggerMessageId", "threadId", "state", "runId", "failureReason",
    "attemptCount", "createdAtMs", "updatedAtMs",
  ]);
  const result: ChatDispatch = {
    workspaceId: stringValue(object, "workspaceId", label),
    triggerMessageId: stringValue(object, "triggerMessageId", label),
    threadId: stringValue(object, "threadId", label),
    state: enumValue(object, "state", label, ["pending", "running", "done", "failed"]),
    attemptCount: safeInteger(object, "attemptCount", label),
    createdAtMs: safeInteger(object, "createdAtMs", label),
    updatedAtMs: safeInteger(object, "updatedAtMs", label),
  };
  for (const key of ["runId", "failureReason"] as const) {
    const field = optionalString(object, key, label);
    if (field !== undefined) result[key] = field;
  }
  return result;
}

export function decodeChatRun(value: JsonValue, label = "chat run"): ChatRun {
  const object = objectValue(value, label, [
    "workspaceId", "runId", "threadId", "triggerMessageId", "command", "startedAtMs",
    "endedAtMs", "exitCode", "failureReason", "logPath", "failureNotePosted",
  ]);
  const result: ChatRun = {
    workspaceId: stringValue(object, "workspaceId", label),
    runId: stringValue(object, "runId", label),
    threadId: stringValue(object, "threadId", label),
    triggerMessageId: stringValue(object, "triggerMessageId", label),
    command: stringValue(object, "command", label),
    startedAtMs: safeInteger(object, "startedAtMs", label),
    failureNotePosted: booleanValue(object, "failureNotePosted", label),
  };
  const ended = optionalInteger(object, "endedAtMs", label);
  if (ended !== undefined) result.endedAtMs = ended;
  const exitCode = optionalInteger(object, "exitCode", label, false);
  if (exitCode !== undefined) result.exitCode = exitCode;
  for (const key of ["failureReason", "logPath"] as const) {
    const field = optionalString(object, key, label);
    if (field !== undefined) result[key] = field;
  }
  return result;
}

function decodeClaim(value: JsonValue, label: string): ChatDispatchClaim {
  const object = objectValue(value, label, ["dispatch", "run"]);
  return {
    dispatch: decodeChatDispatch(object.dispatch ?? null, `${label}.dispatch`),
    run: decodeChatRun(object.run ?? null, `${label}.run`),
  };
}

function decodePause(value: JsonValue, label: string): ChatThreadPause {
  const object = objectValue(value, label, [
    "workspaceId", "threadId", "paused", "reason", "updatedAtMs",
  ]);
  const result: ChatThreadPause = {
    workspaceId: stringValue(object, "workspaceId", label),
    threadId: stringValue(object, "threadId", label),
    paused: booleanValue(object, "paused", label),
    updatedAtMs: safeInteger(object, "updatedAtMs", label),
  };
  const reason = optionalString(object, "reason", label);
  if (reason !== undefined) result.reason = reason;
  return result;
}

function decodeAgentRead(value: JsonValue, label: string): ChatAgentReadState {
  const object = objectValue(value, label, [
    "workspaceId", "threadId", "lastReadCreatedAtMs", "lastReadMessageId", "revision",
    "updatedAtMs",
  ]);
  return {
    workspaceId: stringValue(object, "workspaceId", label),
    threadId: stringValue(object, "threadId", label),
    lastReadCreatedAtMs: safeInteger(object, "lastReadCreatedAtMs", label),
    lastReadMessageId: stringValue(object, "lastReadMessageId", label),
    revision: safeInteger(object, "revision", label),
    updatedAtMs: safeInteger(object, "updatedAtMs", label),
  };
}

function decodeChannel(value: JsonValue, label: string): ChatChannel {
  const object = objectValue(value, label, [
    "workspaceId", "channelId", "name", "slug", "kind", "createdAtMs", "updatedAtMs",
  ]);
  return {
    workspaceId: stringValue(object, "workspaceId", label),
    channelId: stringValue(object, "channelId", label),
    name: stringValue(object, "name", label),
    slug: stringValue(object, "slug", label),
    kind: enumValue(object, "kind", label, ["channel", "dm", "agent"]),
    createdAtMs: safeInteger(object, "createdAtMs", label),
    updatedAtMs: safeInteger(object, "updatedAtMs", label),
  };
}

function decodeFileMention(value: JsonValue, label: string): ChatFileMention {
  const object = objectValue(value, label, ["attachment", "message", "thread", "channel"]);
  const result: ChatFileMention = {
    attachment: decodeChatAttachment(object.attachment ?? null, `${label}.attachment`),
    message: decodeChatMessage(object.message ?? null, `${label}.message`),
    thread: decodeChatThread(object.thread ?? null, `${label}.thread`),
  };
  if (object.channel !== undefined) {
    result.channel = decodeChannel(object.channel, `${label}.channel`);
  }
  return result;
}

function decodeMention(value: JsonValue, label: string): ChatMention {
  const object = objectValue(value, label, [
    "threadId", "messageId", "handle", "authorKind", "createdAtMs",
  ]);
  return {
    threadId: stringValue(object, "threadId", label),
    messageId: stringValue(object, "messageId", label),
    handle: stringValue(object, "handle", label),
    authorKind: enumValue(object, "authorKind", label, ["human", "agent"]),
    createdAtMs: safeInteger(object, "createdAtMs", label),
  };
}

function decodeChannelThread(value: JsonValue, label: string): ChatChannelThreadSummary {
  const object = objectValue(value, label, [
    "thread", "messageCount", "lastReadSequence", "unreadCount", "openDecisionCount",
    "openingMessage",
  ]);
  const result: ChatChannelThreadSummary = {
    thread: decodeChatThread(object.thread ?? null, `${label}.thread`),
    messageCount: safeInteger(object, "messageCount", label),
    lastReadSequence: safeInteger(object, "lastReadSequence", label),
    unreadCount: safeInteger(object, "unreadCount", label),
    openDecisionCount: safeInteger(object, "openDecisionCount", label),
  };
  if (object.openingMessage !== undefined) {
    const openingLabel = `${label}.openingMessage`;
    const opening = objectValue(object.openingMessage, openingLabel, [
      "id", "author", "createdAtMs", "bodySnippet", "reactions",
    ]);
    result.openingMessage = {
      id: stringValue(opening, "id", openingLabel),
      author: decodeChatActor(opening.author ?? null, `${openingLabel}.author`),
      createdAtMs: safeInteger(opening, "createdAtMs", openingLabel),
      bodySnippet: stringValue(opening, "bodySnippet", openingLabel),
      reactions: arrayValue(opening, "reactions", openingLabel).map((entry, index) =>
        decodeChatReaction(entry, `${openingLabel}.reactions[${index}]`)),
    };
  }
  return result;
}

function decodePage<T>(
  value: JsonValue,
  label: string,
  field: string,
  decode: (entry: JsonValue, label: string) => T,
): { rows: T[]; cursor: string | null } {
  const object = objectValue(value, label, [field, "nextCursor"]);
  return {
    rows: arrayValue(object, field, label).map((entry, index) =>
      decode(entry, `${label}.${field}[${index}]`)),
    cursor: cursorValue(object, label),
  };
}

function decodeFeed(value: JsonValue, label: string): ChatFeedPage {
  const object = objectValue(value, label, [
    "items", "nextCursor", "headCursor", "readState",
  ]);
  const items = arrayValue(object, "items", label).map((entry, index): ChatFeedItem => {
    const itemLabel = `${label}.items[${index}]`;
    const item = objectValue(entry, itemLabel, [
      "message", "thread", "reactions", "matchedBy", "channel", "parentMessage", "openingMessage",
    ]);
    const result: ChatFeedItem = {
      message: decodeChatMessage(item.message ?? null, `${itemLabel}.message`),
      thread: decodeChatThread(item.thread ?? null, `${itemLabel}.thread`),
      reactions: arrayValue(item, "reactions", itemLabel).map((reaction, reactionIndex) =>
        decodeChatReaction(reaction, `${itemLabel}.reactions[${reactionIndex}]`)),
      matchedBy: arrayValue(item, "matchedBy", itemLabel).map((kind, kindIndex) => {
        if (!["person", "agent", "channel", "thread"].includes(String(kind))) {
          throw new ChatsProtocolShapeError(`${itemLabel}.matchedBy[${kindIndex}] is invalid.`);
        }
        return kind as "person" | "agent" | "channel" | "thread";
      }),
    };
    for (const key of ["parentMessage", "openingMessage"] as const) {
      if (item[key] !== undefined) {
        result[key] = decodeChatMessage(item[key], `${itemLabel}.${key}`);
      }
    }
    if (item.channel !== undefined) {
      const channelLabel = `${itemLabel}.channel`;
      const channel = objectValue(item.channel, channelLabel, [
        "id", "workspaceId", "name", "slug", "kind", "createdAtMs", "updatedAtMs",
      ]);
      result.channel = {
        id: stringValue(channel, "id", channelLabel),
        workspaceId: stringValue(channel, "workspaceId", channelLabel),
        name: stringValue(channel, "name", channelLabel),
        slug: stringValue(channel, "slug", channelLabel),
        kind: enumValue(channel, "kind", channelLabel, ["channel", "dm", "agent"]),
        createdAtMs: safeInteger(channel, "createdAtMs", channelLabel),
        updatedAtMs: safeInteger(channel, "updatedAtMs", channelLabel),
      };
    }
    return result;
  });
  let readState: ChatFeedReadState | null = null;
  if (object.readState !== null) {
    const stateLabel = `${label}.readState`;
    const state = objectValue(object.readState ?? null, stateLabel, [
      "workspaceId", "ownerUserId", "lastSeenCreatedAtMs", "lastSeenMessageId", "updatedAtMs",
    ]);
    readState = {
      workspaceId: stringValue(state, "workspaceId", stateLabel),
      ownerUserId: stringValue(state, "ownerUserId", stateLabel),
      lastSeenCreatedAtMs: safeInteger(state, "lastSeenCreatedAtMs", stateLabel),
      lastSeenMessageId: stringValue(state, "lastSeenMessageId", stateLabel),
      updatedAtMs: safeInteger(state, "updatedAtMs", stateLabel),
    };
  }
  return {
    items,
    nextCursor: nullableString(object, "nextCursor", label),
    headCursor: nullableString(object, "headCursor", label),
    readState,
  };
}

export function decodeChatsResult<M extends ChatsMethod>(
  method: M,
  value: JsonValue,
): ChatsMethodResultMap[M] {
  const label = `${method} result`;
  let result: unknown;
  switch (method) {
    case CHATS_METHOD.channelGetWireId: {
      const object = objectValue(value, label, ["wireId"]);
      result = { wireId: nullableString(object, "wireId", label) };
      break;
    }
    case CHATS_METHOD.threadStart: {
      const object = objectValue(value, label, ["thread", "message"]);
      result = {
        thread: decodeChatThread(object.thread ?? null, `${label}.thread`),
        message: decodeChatMessage(object.message ?? null, `${label}.message`),
      };
      break;
    }
    case CHATS_METHOD.threadCreate:
      result = decodeChatThread(value, label);
      break;
    case CHATS_METHOD.threadsListForFile:
    case CHATS_METHOD.agentReadListUnreadThreads: {
      const page = decodePage(value, label, "threads", decodeChatThread);
      result = { threads: page.rows, nextCursor: page.cursor };
      break;
    }
    case CHATS_METHOD.threadsListForChannel: {
      const page = decodePage(value, label, "threads", decodeChannelThread);
      result = { threads: page.rows, nextCursor: page.cursor };
      break;
    }
    case CHATS_METHOD.threadFindChannelId:
    case CHATS_METHOD.dispatchRunIdForMessage:
      if (value !== null && typeof value !== "string") {
        throw new ChatsProtocolShapeError(`${label} must be a string or null.`);
      }
      result = value;
      break;
    case CHATS_METHOD.threadGetProjection: {
      const object = objectValue(value, label, ["path", "readOnly", "threadId", "text"]);
      if (object.readOnly !== true) {
        throw new ChatsProtocolShapeError(`${label}.readOnly must be true.`);
      }
      result = {
        path: stringValue(object, "path", label),
        readOnly: true,
        threadId: stringValue(object, "threadId", label),
        text: stringValue(object, "text", label),
      };
      break;
    }
    case CHATS_METHOD.messageSend:
      result = decodeChatMessage(value, label);
      break;
    case CHATS_METHOD.decisionResolve:
      result = decodeChatDecision(value, label);
      break;
    case CHATS_METHOD.decisionsListForThread: {
      const page = decodePage(value, label, "decisions", decodeChatDecision);
      result = { decisions: page.rows, nextCursor: page.cursor };
      break;
    }
    case CHATS_METHOD.reactionSet:
      result = decodeChatReaction(value, label);
      break;
    case CHATS_METHOD.reactionsList: {
      const page = decodePage(value, label, "reactions", decodeChatReaction);
      result = { reactions: page.rows, nextCursor: page.cursor };
      break;
    }
    case CHATS_METHOD.attachmentsListForThread: {
      const page = decodePage(value, label, "attachments", decodeChatAttachment);
      result = { attachments: page.rows, nextCursor: page.cursor };
      break;
    }
    case CHATS_METHOD.attachmentsListFileMentions: {
      const page = decodePage(value, label, "mentions", decodeFileMention);
      result = { mentions: page.rows, nextCursor: page.cursor };
      break;
    }
    case CHATS_METHOD.mentionsListForHandle: {
      const page = decodePage(value, label, "mentions", decodeMention);
      result = { mentions: page.rows, nextCursor: page.cursor };
      break;
    }
    case CHATS_METHOD.agentReadMarkThreadRead:
      result = decodeAgentRead(value, label);
      break;
    case CHATS_METHOD.followsEnsureDefaults:
      if (value !== null) throw new ChatsProtocolShapeError(`${label} must be null.`);
      result = null;
      break;
    case CHATS_METHOD.feedListPersonal:
      result = decodeFeed(value, label);
      break;
    case CHATS_METHOD.bookmarkFind:
      result = value === null ? null : decodeChatBookmark(value, label);
      break;
    case CHATS_METHOD.bookmarkListPending: {
      const page = decodePage(value, label, "bookmarks", decodeChatBookmark);
      result = { bookmarks: page.rows, nextCursor: page.cursor };
      break;
    }
    case CHATS_METHOD.bookmarkArchive:
    case CHATS_METHOD.bookmarkMarkPending:
      result = decodeChatBookmark(value, label);
      break;
    case CHATS_METHOD.bookmarkMarkFailed:
    case CHATS_METHOD.bookmarkMarkStale: {
      const object = objectValue(value, label, ["bookmark", "applied"]);
      result = {
        bookmark: decodeChatBookmark(object.bookmark ?? null, `${label}.bookmark`),
        applied: booleanValue(object, "applied", label),
      };
      break;
    }
    case CHATS_METHOD.dispatchRecordEligibleTriggers:
    case CHATS_METHOD.dispatchRecentCount:
    case CHATS_METHOD.dispatchFailPendingForThread: {
      const object = { count: value } as ChatsJsonObject;
      result = safeInteger(object, "count", label);
      break;
    }
    case CHATS_METHOD.dispatchClaimNextPending:
      result = value === null ? null : decodeClaim(value, label);
      break;
    case CHATS_METHOD.dispatchListPending: {
      const page = decodePage(value, label, "dispatches", decodeChatDispatch);
      result = { dispatches: page.rows, nextCursor: page.cursor };
      break;
    }
    case CHATS_METHOD.dispatchOpenRuns: {
      const page = decodePage(value, label, "claims", decodeClaim);
      result = { claims: page.rows, nextCursor: page.cursor };
      break;
    }
    case CHATS_METHOD.dispatchListRunMessages: {
      const object = objectValue(value, label, ["messageIds", "nextCursor"]);
      result = {
        messageIds: arrayValue(object, "messageIds", label).map((entry, index) => {
          if (typeof entry !== "string") {
            throw new ChatsProtocolShapeError(`${label}.messageIds[${index}] must be a string.`);
          }
          return entry;
        }),
        nextCursor: cursorValue(object, label),
      };
      break;
    }
    case CHATS_METHOD.dispatchRunRecordsForThread: {
      const object = objectValue(value, label, ["runs", "nextCursor"]);
      const runsObject = objectValue(object.runs ?? null, `${label}.runs`);
      const runs: Record<string, ChatRun> = {};
      for (const [messageId, run] of Object.entries(runsObject)) {
        runs[messageId] = decodeChatRun(run ?? null, `${label}.runs.${messageId}`);
      }
      result = { runs, nextCursor: cursorValue(object, label) };
      break;
    }
    case CHATS_METHOD.dispatchGetRunRecord:
      result = value === null ? null : decodeChatRun(value, label);
      break;
    case CHATS_METHOD.dispatchIsThreadPaused:
    case CHATS_METHOD.dispatchRecordRunMessage:
    case CHATS_METHOD.dispatchRequeueFailedTrigger:
      if (typeof value !== "boolean") {
        throw new ChatsProtocolShapeError(`${label} must be a boolean.`);
      }
      result = value;
      break;
    case CHATS_METHOD.dispatchGetThreadPauseState:
      result = value === null ? null : decodePause(value, label);
      break;
    case CHATS_METHOD.dispatchSetThreadPaused:
      result = decodePause(value, label);
      break;
    case CHATS_METHOD.dispatchMarkFailureNotePosted:
      result = decodeChatRun(value, label);
      break;
    case CHATS_METHOD.dispatchListAppQuitRecoveries: {
      const page = decodePage(value, label, "recoveries", (entry, entryLabel) => {
        const object = objectValue(entry, entryLabel, ["run", "attemptCount"]);
        return {
          run: decodeChatRun(object.run ?? null, `${entryLabel}.run`),
          attemptCount: safeInteger(object, "attemptCount", entryLabel),
        };
      });
      result = { recoveries: page.rows, nextCursor: page.cursor };
      break;
    }
    default: {
      const exhaustive: never = method;
      throw new ChatsProtocolShapeError(`Unsupported chats method: ${exhaustive}`);
    }
  }
  return result as ChatsMethodResultMap[M];
}

export const decodeChatChannelGetWireIdResult = (value: JsonValue): ChatWireIdResult =>
  decodeChatsResult(CHATS_METHOD.channelGetWireId, value);
export const decodeChatThreadStartResult = (value: JsonValue): ChatThreadStartResult =>
  decodeChatsResult(CHATS_METHOD.threadStart, value);
export const decodeChatProjectionResult = (value: JsonValue): ChatProjection =>
  decodeChatsResult(CHATS_METHOD.threadGetProjection, value);
export const decodeChatFeedPage = (value: JsonValue): ChatFeedPage =>
  decodeChatsResult(CHATS_METHOD.feedListPersonal, value);
export const decodeChatBookmarkTransition = (value: JsonValue): ChatBookmarkTransition =>
  decodeChatsResult(CHATS_METHOD.bookmarkMarkFailed, value);
