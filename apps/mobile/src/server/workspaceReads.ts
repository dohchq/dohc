import { workspaceWords } from "@dohc/interface-words/workspace";
import { LIVE_MARKDOWN_MAX_BYTES } from "@dohc/live-session-contract/limits";
import { AGENT_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { each, isFields, okAnswer, segment, text, type Fields } from "./api";
import { REQUEST_TIMEOUT_MS, ServerError, type ServerClient } from "./client";

/** A read's value, and the feed's cursor for what the server's copy had synced when it answered. */
export interface Read<T> {
  readonly value: T;
  readonly cursor: string;
}

/**
 * A cursor as the server writes one: the log floor, the log and the live-edit journal, and in a workspace the account
 * joined, a mark of what it reaches, which the server answers `replace` for once that changes.
 */
const CURSOR = /^(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})(\.[0-9a-f]{16})?$/;
export const isCursor = (value: unknown): value is string =>
  typeof value === "string" && CURSOR.test(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const string = (value: unknown, max = 1_048_576): value is string =>
  typeof value === "string" && value.length <= max;

function operation<T>(
  client: ServerClient,
  workspaceId: string,
  name: string,
  args: object,
  read: (result: unknown) => T | null,
  signal: AbortSignal,
): Promise<Read<T>> {
  return client.send(
    "POST",
    `/sync/${segment(workspaceId)}/ops/${name}`,
    (body) => {
      const answer = okAnswer(body);
      if (!answer || !isCursor(answer.cursor)) return null;
      const value = read(answer.result);
      // The server's copy couldn't do the read, as when its engine failed: the answer is fine, the read isn't.
      if (value === null && isFields(answer.result) && answer.result.ok === false)
        throw new ServerError("refused", 200);
      return value === null ? null : { value, cursor: answer.cursor };
    },
    args,
    { signal },
  );
}

export interface WorkspaceFile {
  readonly path: string;
  readonly objectId: string;
  /** A Markdown page, by the desktop's rule, which the phone opens to read. */
  readonly page: boolean;
}

/** Every file in the workspace, in lexical order, as the desktop lists them. */
export function readFiles(
  client: ServerClient,
  workspaceId: string,
  signal: AbortSignal,
): Promise<Read<readonly WorkspaceFile[]>> {
  return operation(
    client,
    workspaceId,
    "listFiles",
    {},
    (result) => {
      const answer = okAnswer(result);
      return each(answer?.files, (file) =>
        isFields(file) && text(file.path) && text(file.objectId, 256)
          ? {
              path: file.path,
              objectId: file.objectId,
              page: fileKindForPath(file.path).displayKind === "markdown",
            }
          : null,
      );
    },
    signal,
  );
}

export type ChatGroupKind = "group" | "dm" | "agent";
const isGroupKind = (value: unknown): value is ChatGroupKind =>
  value === "group" || value === "dm" || value === "agent";

export type ChatGroupType = "posts" | "chat" | "both";
const isGroupType = (value: unknown): value is ChatGroupType =>
  value === "posts" || value === "chat" || value === "both";

export interface ChatGroup {
  readonly id: string;
  readonly channelWireId?: string;
  readonly name: string;
  readonly kind: ChatGroupKind;
  readonly type?: ChatGroupType;
  readonly access?: "read-write" | "read-only";
  /** The threads in it, so a change to one can find the chat it's in. */
  readonly threadIds: readonly string[];
  /** The threads in its posts lane, each a post's own, whose answers go at its top. Absent when it has none. */
  readonly postThreadIds?: readonly string[];
  /** The account's unread messages across its threads. */
  readonly unreadCount: number;
  readonly unreadThreadIds: readonly string[];
  /** An agent's chat whose agent none of the account's computers has now. Absent otherwise. */
  readonly archived?: true;
}

/** The workspace's groups, direct messages and agent chats, with the account's unread counts. A phone's read never creates General. */
export function readChats(
  client: ServerClient,
  workspaceId: string,
  signal: AbortSignal,
): Promise<Read<readonly ChatGroup[]>> {
  return operation(
    client,
    workspaceId,
    "groupsFull",
    {},
    (result) =>
      each(okAnswer(result)?.groups, (group) => {
        if (
          !isFields(group) ||
          !text(group.id, 256) ||
          !text(group.name, 500) ||
          !isGroupKind(group.kind)
        )
          return null;
        // A thread names its lane, or none, as an older server's does.
        const threads = each(group.threads, (thread) =>
          isFields(thread) &&
          text(thread.id, 256) &&
          count(thread.unreadCount) &&
          (thread.lane === undefined || isLane(thread.lane))
            ? { id: thread.id, unreadCount: thread.unreadCount, post: thread.lane === "posts" }
            : null,
        );
        if (threads === null) return null;
        const unreadCount = threads.reduce((sum, thread) => sum + thread.unreadCount, 0);
        const postThreadIds = threads.filter((thread) => thread.post).map((thread) => thread.id);
        const archived = group.kind === "agent" && group.archived === true;
        const channelWireId = text(group.channelWireId, 256) ? group.channelWireId : undefined;
        const type = isGroupType(group.type) ? group.type : undefined;
        const access =
          group.access === "read-write" || group.access === "read-only" ? group.access : undefined;
        return Number.isSafeInteger(unreadCount)
          ? {
              id: group.id,
              ...(channelWireId ? { channelWireId } : {}),
              // The default agent's chat is always stored as "My agent"; the desktop says whose it was.
              name:
                archived && group.channelWireId === AGENT_CHANNEL_WIRE_ID
                  ? workspaceWords.yourAgent
                  : group.name,
              ...(archived ? { archived: true as const } : {}),
              kind: group.kind,
              ...(type ? { type } : {}),
              ...(access ? { access } : {}),
              threadIds: threads.map((thread) => thread.id),
              ...(postThreadIds.length > 0 ? { postThreadIds } : {}),
              unreadCount,
              unreadThreadIds: threads
                .filter((thread) => thread.unreadCount > 0)
                .map((thread) => thread.id),
            }
          : null;
      }),
    signal,
  );
}

/** A file a message names, by its object, its path when sent, or both. */
export interface ChatAttachment {
  readonly objectId: string | null;
  readonly pathHint: string | null;
}

/** One person's or agent's reaction to a message. */
export interface ChatReaction {
  readonly emoji: string;
  readonly authorId: string;
  readonly authorKind: "human" | "agent";
  readonly authorName: string;
  readonly atMs: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly threadId: string;
  readonly authorKind: "human" | "agent" | "automation" | "link";
  readonly authorName: string;
  readonly body: string;
  readonly createdAtMs: number;
  /** The message it replies to, or null for one at the top of its thread. */
  readonly parentMessageId: string | null;
  readonly attachments: readonly ChatAttachment[];
  /** Whether it asks a question or a poll. The rest describe that decision, and are empty or null when it asks none. */
  readonly needsDecision: boolean;
  readonly decisionState: "open" | "resolved" | null;
  /** A poll's choices. A question has none. */
  readonly options: readonly string[];
  /** One explanation per choice, or null for a choice without one. Empty when the poll has none. */
  readonly optionDetails: readonly (string | null)[];
  readonly chosenOption: string | null;
  readonly resolvedByMessageId: string | null;
  readonly reactions: readonly ChatReaction[];
}

const isAuthorKind = (value: unknown): value is ChatMessage["authorKind"] =>
  value === "human" || value === "agent" || value === "automation" || value === "link";
/** An optional field: null when absent, undefined when it fails `check`. */
const optional = <T>(value: unknown, check: (value: unknown) => value is T): T | null | undefined =>
  value === undefined ? null : check(value) ? value : undefined;
const id = (value: unknown): value is string => text(value, 256);
const nonEmpty = (value: unknown): value is string => text(value);
const isDecisionState = (value: unknown): value is "open" | "resolved" =>
  value === "open" || value === "resolved";

const readAttachment = (item: unknown): ChatAttachment | null => {
  if (!isFields(item)) return null;
  const objectId = optional(item.objectId, id),
    pathHint = optional(item.pathHint, nonEmpty);
  return objectId === undefined || pathHint === undefined ? null : { objectId, pathHint };
};

const readReaction = (item: unknown): ChatReaction | null =>
  isFields(item) &&
  text(item.emoji, 256) &&
  id(item.authorId) &&
  (item.authorKind === "human" || item.authorKind === "agent") &&
  string(item.authorDisplayName, 256) &&
  count(item.atMs)
    ? {
        emoji: item.emoji,
        authorId: item.authorId,
        authorKind: item.authorKind,
        authorName: item.authorDisplayName,
        atMs: item.atMs,
      }
    : null;

function readMessage(item: unknown): ChatMessage | null {
  if (
    !isFields(item) ||
    !id(item.id) ||
    !id(item.threadId) ||
    !isAuthorKind(item.authorKind) ||
    !text(item.authorDisplayName, 256) ||
    !string(item.body) ||
    !count(item.createdAtMs) ||
    typeof item.needsDecision !== "boolean"
  )
    return null;
  const parentMessageId = optional(item.parentMessageId, id);
  const decisionState = optional(item.decisionState, isDecisionState);
  const chosenOption = optional(item.chosenOption, nonEmpty);
  const resolvedByMessageId = optional(item.resolvedByMessageId, id);
  const attachments = each(item.attachments, readAttachment);
  const options =
    item.options === undefined
      ? []
      : each(item.options, (value) => (nonEmpty(value) ? value : null));
  const optionDetails =
    item.optionDetails === undefined
      ? []
      : Array.isArray(item.optionDetails) &&
          item.optionDetails.length === options?.length &&
          item.optionDetails.every((detail) => detail === null || nonEmpty(detail))
        ? (item.optionDetails as (string | null)[])
        : null;
  const reactions = item.reactions === undefined ? [] : each(item.reactions, readReaction);
  if (
    parentMessageId === undefined ||
    decisionState === undefined ||
    chosenOption === undefined ||
    resolvedByMessageId === undefined ||
    attachments === null ||
    options === null ||
    optionDetails === null ||
    reactions === null
  )
    return null;
  // A message asks a decision exactly when it has a decision's state.
  if (item.needsDecision !== (decisionState !== null)) return null;
  return {
    id: item.id,
    threadId: item.threadId,
    authorKind: item.authorKind,
    authorName: item.authorDisplayName,
    body: item.body,
    createdAtMs: item.createdAtMs,
    parentMessageId,
    attachments,
    needsDecision: item.needsDecision,
    decisionState,
    options,
    optionDetails,
    chosenOption,
    resolvedByMessageId,
    reactions,
  };
}

export interface StreamItem {
  /** A post, which opens its thread, or a message in the chat's conversation. */
  readonly lane: "posts" | "chat";
  readonly message: ChatMessage;
  /** The replies under a post, which open its thread. */
  readonly replyCount: number;
  readonly lastReplyAtMs: number | null;
}

/** A chat or thread the server no longer has, or this account can't reach, as the server's `missing` refusal says. */
export interface MissingChat {
  readonly kind: "missing";
}

const missingChat = (result: unknown): MissingChat | null =>
  isFields(result) && result.ok === false && result.refusal === "missing"
    ? { kind: "missing" }
    : null;

interface StreamPosition {
  readonly createdAtMs: number;
  readonly lane: "posts" | "chat";
  readonly id: string;
}

export interface GroupStream {
  readonly kind: "stream";
  readonly name: string;
  readonly groupKind: ChatGroupKind;
  /** Oldest first. */
  readonly items: readonly StreamItem[];
  /** The newest item the account has read, or null when it has read none. */
  readonly readPosition: StreamPosition | null;
}

const isLane = (value: unknown): value is "posts" | "chat" => value === "posts" || value === "chat";
const readPosition = (value: unknown): StreamPosition | null =>
  isFields(value) && count(value.createdAtMs) && isLane(value.lane) && id(value.id)
    ? { createdAtMs: value.createdAtMs, lane: value.lane, id: value.id }
    : null;

/** The most a stream read asks for: the server's own cap. */
export const STREAM_PAGE = 100;

/** A chat's latest posts and messages, oldest first. */
export function readStream(
  client: ServerClient,
  workspaceId: string,
  groupId: string,
  signal: AbortSignal,
): Promise<Read<GroupStream | MissingChat>> {
  return operation<GroupStream | MissingChat>(
    client,
    workspaceId,
    "chat",
    { group: groupId, limit: STREAM_PAGE },
    (result) => {
      const missing = missingChat(result);
      if (missing) return missing;
      const stream = okAnswer(result)?.stream;
      if (
        !isFields(stream) ||
        !isFields(stream.group) ||
        !text(stream.group.name, 500) ||
        !isGroupKind(stream.group.kind)
      )
        return null;
      const items = each(stream.items, (item) => {
        const message = isFields(item) ? readMessage(item.message) : null;
        const position = isFields(item) ? readPosition(item.position) : null;
        if (!isFields(item) || message === null || position === null) return null;
        const post: Fields | null = isFields(item.post) ? item.post : null;
        const replyCount = post && count(post.replyCount) ? post.replyCount : 0;
        return {
          lane: position.lane,
          message,
          replyCount,
          lastReplyAtMs: post && count(post.lastReplyAtMs) ? post.lastReplyAtMs : null,
        };
      });
      const read = stream.readPosition === null ? null : readPosition(stream.readPosition);
      if (items === null || (stream.readPosition !== null && read === null)) return null;
      return {
        kind: "stream",
        name: stream.group.name,
        groupKind: stream.group.kind,
        items,
        readPosition: read,
      };
    },
    signal,
  );
}

/** Which writes a chat's stream takes, as the server says for the account. */
export interface StreamLanes {
  readonly kind: "lanes";
  readonly groupKind: ChatGroupKind;
  readonly canPost: boolean;
  readonly canSend: boolean;
}

/**
 * The lanes of a chat's stream, from the server's context for the phone (`chatContext`, its stream form). The same
 * answer names who can be mentioned and the latest wakes of its messages; the phone doesn't read those yet.
 */
export function readStreamLanes(
  client: ServerClient,
  workspaceId: string,
  groupId: string,
  signal: AbortSignal,
): Promise<Read<StreamLanes | MissingChat>> {
  return operation<StreamLanes | MissingChat>(
    client,
    workspaceId,
    "chatContext",
    { group: groupId },
    (result) => {
      const missing = missingChat(result);
      if (missing) return missing;
      if (!isFields(result) || result.ok !== true || !isFields(result.conversation)) return null;
      const stream = result.conversation;
      return stream.kind === "stream" &&
        stream.groupId === groupId &&
        isGroupKind(stream.groupKind) &&
        typeof stream.canPost === "boolean" &&
        typeof stream.canSend === "boolean"
        ? {
            kind: "lanes",
            groupKind: stream.groupKind,
            canPost: stream.canPost,
            canSend: stream.canSend,
          }
        : null;
    },
    signal,
  );
}

const memberAccess = (value: unknown): "read-write" | "read-only" | undefined =>
  value === "read-write" || value === "read-only" ? value : undefined;

export interface ChatThread {
  readonly kind: "thread";
  readonly id: string;
  readonly title: string;
  readonly access?: "read-write" | "read-only";
  /** Oldest first. */
  readonly messages: readonly ChatMessage[];
}

export function readThread(
  client: ServerClient,
  workspaceId: string,
  threadId: string,
  signal: AbortSignal,
): Promise<Read<ChatThread | MissingChat>> {
  return operation<ChatThread | MissingChat>(
    client,
    workspaceId,
    "chat",
    { threadId },
    (result) => {
      const missing = missingChat(result);
      if (missing) return missing;
      const answer = okAnswer(result);
      const thread = answer?.thread;
      if (!isFields(thread) || !text(thread.id, 256) || !string(thread.title, 4096)) return null;
      const messages = each(answer?.messages, readMessage);
      const access = memberAccess(thread.access);
      return (
        messages && {
          kind: "thread",
          id: thread.id,
          title: thread.title,
          ...(access ? { access } : {}),
          messages,
        }
      );
    },
    signal,
  );
}

export interface FileCommentThread {
  readonly id: string;
  readonly title: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface FileChatsRead {
  readonly fileObjectId: string | null;
  readonly access?: "read-write" | "read-only";
  readonly threads: readonly FileCommentThread[];
}

export function readFileChats(
  client: ServerClient,
  workspaceId: string,
  path: string,
  signal: AbortSignal,
): Promise<Read<FileChatsRead>> {
  return operation<FileChatsRead>(
    client,
    workspaceId,
    "fileChats",
    { path },
    (result) => {
      const answer = okAnswer(result);
      if (!answer) return null;
      const id = answer.fileObjectId;
      const fileObjectId = id === null ? null : text(id, 256) ? id : undefined;
      const threads = each(answer.threads, (item) =>
        isFields(item) &&
        text(item.id, 256) &&
        string(item.title, 4096) &&
        count(item.createdAtMs) &&
        count(item.updatedAtMs)
          ? {
              id: item.id,
              title: item.title,
              createdAtMs: item.createdAtMs,
              updatedAtMs: item.updatedAtMs,
            }
          : null,
      );
      if (fileObjectId === undefined || threads === null) return null;
      const access = memberAccess(answer.access);
      return { fileObjectId, ...(access ? { access } : {}), threads };
    },
    signal,
  );
}

/**
 * Marks the account's place in a thread at a message the phone showed. The server moves the mark only forward, so a
 * repeat, or an older one, changes nothing. Resolves once the server took it, or a missing thread or message, which it
 * answers as reads do; rejects on any other answer.
 */
export function markThreadRead(
  client: ServerClient,
  workspaceId: string,
  threadId: string,
  messageId: string,
  signal: AbortSignal,
): Promise<void> {
  return client.send(
    "POST",
    `/sync/${segment(workspaceId)}/ops/markRead`,
    (body) => {
      const answer = okAnswer(body);
      if (!answer || !isFields(answer.result)) return null;
      return answer.result.ok === true || missingChat(answer.result) ? undefined : null;
    },
    { threadId, messageId },
    { signal },
  );
}

/**
 * A page as the server's copy holds it: its Markdown, or why there is none, by the refusal the server names. `missing`
 * is a page not at its path, and the server answers a secret file's page the same way. Its `last` is the text this
 * workspace's store read before the page went, which it keeps showing. `too-large` is a file over the desktop's
 * editor limit, which the server refuses before reading it.
 */
export type PageRead =
  | { readonly kind: "page"; readonly markdown: string; readonly objectId?: string }
  | { readonly kind: "missing"; readonly last?: string }
  | { readonly kind: "too-large" };

export function readPage(
  client: ServerClient,
  workspaceId: string,
  path: string,
  signal: AbortSignal,
): Promise<Read<PageRead>> {
  return operation<PageRead>(
    client,
    workspaceId,
    "documentRead",
    { path },
    (result) => {
      if (!isFields(result)) return null;
      // A page is at most the editor's limit in UTF-8 bytes, so in UTF-16 units too.
      if (result.ok === true) {
        if (!string(result.markdown, LIVE_MARKDOWN_MAX_BYTES)) return null;
        if (result.objectId !== undefined && !text(result.objectId, 256)) return null;
        return {
          kind: "page",
          markdown: result.markdown,
          ...(result.objectId !== undefined ? { objectId: result.objectId } : {}),
        };
      }
      if (result.refusal === "too-large") return { kind: "too-large" };
      return result.refusal === "missing" ? { kind: "missing" } : null;
    },
    signal,
  );
}

/** What changed by kind, with the objects or threads the server knows changed. An empty list means some, unnamed. */
export interface FeedChanges {
  readonly files?: readonly string[];
  readonly pages?: readonly string[];
  readonly chats?: readonly string[];
}

/** `replace` when the server can't continue from the cursor: everything read before must be read again. */
export type FeedAnswer =
  | { readonly cursor: string; readonly replace: true }
  | { readonly cursor: string; readonly replace: false; readonly changed: FeedChanges };

/** The longest the server holds a feed request open: its own cap is 30 s. */
export const FEED_HOLD_MS = 25_000;

const ids = (value: unknown): readonly string[] | null | undefined =>
  value === undefined ? undefined : each(value, (id) => (text(id, 256) ? id : null));

/** Waits up to `holdMs` for a change after `since`, and answers what changed and the next cursor. */
export function readChanges(
  client: ServerClient,
  workspaceId: string,
  since: string,
  options: {
    readonly holdMs: number;
    readonly signal: AbortSignal;
  },
): Promise<FeedAnswer> {
  const query = `since=${encodeURIComponent(since)}&hold=${options.holdMs}`;
  return client.send(
    "GET",
    `/sync/${segment(workspaceId)}/ops/changes?${query}`,
    (body) => {
      const answer = okAnswer(body);
      if (!answer || !isCursor(answer.cursor)) return null;
      if (answer.replace === true) return { cursor: answer.cursor, replace: true };
      const changed = answer.changed;
      if (!isFields(changed)) return null;
      const files = ids(changed.files),
        pages = ids(changed.pages),
        chats = ids(changed.chats);
      if (files === null || pages === null || chats === null) return null;
      return {
        cursor: answer.cursor,
        replace: false,
        changed: {
          ...(files ? { files } : {}),
          ...(pages ? { pages } : {}),
          ...(chats ? { chats } : {}),
        },
      };
    },
    undefined,
    { signal: options.signal, timeoutMs: options.holdMs + REQUEST_TIMEOUT_MS },
  );
}

const parts = (cursor: string) => {
  const [floor, log, journal, reach] = cursor.split(".");
  return [
    Number(floor),
    Number(log),
    Number(journal),
    reach === undefined ? "" : `.${reach}`,
  ] as const;
};

/**
 * The cursor that misses neither's changes. Two cursors past one restore take each position's lower value; across a
 * restore, the one from before it, which the server answers with `replace`. Two cursors from different reaches combine
 * to one with no mark, which the server also answers with `replace`.
 */
export function earlierCursor(a: string, b: string): string {
  return pick(a, b, Math.min);
}

/** The cursor past both. */
export function laterCursor(a: string, b: string): string {
  return pick(a, b, Math.max);
}

/** The mark of what the account reached when the server wrote the cursor, or "" for the owner's. */
export const reachOf = (cursor: string) => parts(cursor)[3];

function pick(a: string, b: string, choose: (x: number, y: number) => number): string {
  const [floorA, logA, journalA, reachA] = parts(a);
  const [floorB, logB, journalB, reachB] = parts(b);
  if (floorA !== floorB) return choose(floorA, floorB) === floorA ? a : b;
  const reach = reachA === reachB ? reachA : "";
  return `${floorA}.${choose(logA, logB)}.${choose(journalA, journalB)}${reach}`;
}
